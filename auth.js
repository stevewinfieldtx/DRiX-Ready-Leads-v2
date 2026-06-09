// auth.js â€” DRiX Ready Leads authentication, metering, discount codes, Stripe
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Self-contained. No new npm dependencies (uses Node crypto + global fetch).
//
// What this does:
//   1. AUTH WALL  — every /api/* route (except /api/auth/*) requires a logged-in
//      user with a BUSINESS email. Login = email + password (instant, no email
//      round-trip). New users sign up and are in immediately. Password reset is
//      the ONLY flow that emails (via Resend). Session = HMAC-signed cookie.
//   2. METERING   — each "run" (an expensive API endpoint) consumes 1 credit.
//      Every user gets 10 FREE runs. After that they must buy more or redeem a code.
//   3. DISCOUNT   â€” code "steveisawesome" (exact, lowercase) grants 10 runs at no
//      cost, redeemable ONCE per user.
//   4. STRIPE     â€” Checkout for a 10-run pack at $10. Activates automatically once
//      STRIPE_SECRET_KEY is set in Railway env. Webhook credits the runs on payment.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const crypto = require('crypto');

// â”€â”€â”€ CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FREE_RUNS         = 10;                // free trial runs every user gets
const RUNS_PER_PURCHASE = 10;                // 10 runs per $10 pack
const PURCHASE_PRICE_CENTS = 1000;           // $10.00
const DISCOUNT_CODE     = 'steveisawesome';  // exact, lowercase
const DISCOUNT_RUNS     = 10;                 // runs the code grants
const RESET_TTL_MS      = 30 * 60 * 1000;    // password-reset link valid 30 minutes
const SESSION_TTL_MS    = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD_LEN  = 8;

const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('drix-session::' + (process.env.OPENROUTER_API_KEY || 'fallback')).digest('hex');

const RESEND_API_KEY   = process.env.RESEND_API_KEY || '';
const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'steve.winfield@wintechpartners.com';
const APP_URL          = (process.env.APP_URL || '').replace(/\/+$/, '');

// â”€â”€ Cross-site login (auth lives on the DRiX marketing site) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// COOKIE_DOMAIN   â€” scope the session cookie to the parent domain so it's valid
//                   on BOTH getthedrix.com and readyleads.getthedrix.com.
//                   e.g. ".getthedrix.com"  (leave blank for old host-only behavior)
// LOGIN_URL       â€” where to bounce un-authed visitors. e.g. "https://www.getthedrix.com"
// AUTH_ALLOWED_ORIGINS â€” origins allowed to call /api/auth/* with credentials
//                   (the marketing site). Comma-separated, no trailing slash.
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim();
const LOGIN_URL     = (process.env.LOGIN_URL || '').replace(/\/+$/, '');
const AUTH_ALLOWED_ORIGINS = new Set(
  (process.env.AUTH_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
);
// Always-allow list (additive). Emails listed here can ALWAYS sign in, bypassing
// the business-domain rule. Normal business-email self-serve still works for
// everyone else. Comma-separated. Leave blank to use only the business-domain rule.
const ALLOWLIST_EMAILS = new Set(
  (process.env.ALLOWLIST_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// ── Owner bypass ──────────────────────────────────────────────────────────────
// Set BOTH to enable. The bypass email signs in with BYPASS_SECRET as the
// password (no account/password setup needed). Keep BYPASS_SECRET long + private.
const BYPASS_EMAIL  = (process.env.BYPASS_EMAIL || '').trim().toLowerCase();
const BYPASS_SECRET = process.env.BYPASS_SECRET || '';
function bypassEnabled() { return !!BYPASS_EMAIL && BYPASS_SECRET.length >= 8; }
// Constant-time string compare (avoids leaking the secret via timing).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// â”€â”€ License-key payments (Gumroad / Lemon Squeezy) â€” NO WEBHOOK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Buyer purchases on Gumroad/LS â†’ receives a license key â†’ pastes it in the app's
// redeem box â†’ server verifies the key with one API call and grants 10 runs.
// Each key is one-time across all users (enforced in app_redemptions).
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || '';
const LS_PRODUCT_ID      = process.env.LEMONSQUEEZY_PRODUCT_ID || ''; // optional product lock
const BUY_URL            = process.env.BUY_URL || '';                 // your Gumroad/LS product page
const LICENSE_PROVIDER   = (process.env.LICENSE_PROVIDER
  || (GUMROAD_PRODUCT_ID ? 'gumroad' : (process.env.LEMONSQUEEZY ? 'lemonsqueezy' : ''))).toLowerCase();

// â”€â”€ Prepaid codes (processor-proof: PayPal/Venmo/etc. just collect money) â”€â”€â”€â”€
// Admin mints one-time "10-run" codes and hands them to buyers after payment.
// ADMIN_EMAIL can always sign in (bypasses the business-email rule) and gets the
// "generate codes" power. ADMIN_TOKEN is an optional no-login backup for the API.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// â”€â”€ PayPal (fully automated: create order â†’ buyer pays â†’ return â†’ auto-credit) â”€
// No webhook: we capture on return and read the buyer's email from the order's
// custom_id, so the right account is credited even if the session is lost.
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET || '';
const PAYPAL_ENV       = (process.env.PAYPAL_ENV || 'live').toLowerCase();
const PAYPAL_BASE      = PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

// Free / consumer email providers are NOT business emails â€” block them.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','ymail.com','rocketmail.com','hotmail.com',
  'hotmail.co.uk','outlook.com','live.com','msn.com','aol.com','icloud.com','me.com',
  'mac.com','protonmail.com','proton.me','pm.me','gmx.com','gmx.net','mail.com',
  'zoho.com','yandex.com','yandex.ru','tutanota.com','hey.com','fastmail.com',
  'qq.com','163.com','126.com','foxmail.com','hotmail.fr','yahoo.co.uk','yahoo.fr',
  'web.de','t-online.de','comcast.net','verizon.net','att.net','sbcglobal.net',
  'cox.net','bellsouth.net','duck.com','duckduckgo.com','inbox.com','mailinator.com',
]);

// Routes that consume a run (the ones that actually cost money in upstream APIs).
const METERED_ROUTES = new Set([
  'POST /api/demo-flow','POST /api/smb-flow','POST /api/investor-flow',
  'POST /api/hydrate','POST /api/generate-demo-thread','POST /api/clearsignals',
  'POST /api/clearsignals-lookback','POST /api/clearsignals-export','POST /api/coach-chat',
  'POST /api/coach-voice/provision','POST /api/comparison','POST /api/atomize',
  'POST /api/meeting-analysis','POST /api/individual-scan','POST /api/company-intel',
  'POST /api/test-llm','POST /api/upload-doc','POST /api/xs-prepare',
  'POST /api/cross-sell/prepare','POST /api/ai-prepare','POST /api/mentor/enrich-company',
  'POST /api/mentor/brief',
]);

// â”€â”€â”€ STORE (Postgres, with in-memory fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// app_users: email PK, runs_used, runs_granted (purchased+redeemed), redeemed jsonb.
let _db = null;
const memUsers = new Map();   // email -> { runs_used, runs_granted, redeemed:Set, password_hash }

function pool() { try { return _db && _db.getPool && _db.getPool(); } catch { return null; } }

async function initSchema() {
  const p = pool();
  if (!p) { console.warn('[auth] No DATABASE_URL â€” using in-memory user store (resets on deploy).'); return; }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        email         TEXT PRIMARY KEY,
        runs_used     INTEGER NOT NULL DEFAULT 0,
        runs_granted  INTEGER NOT NULL DEFAULT 0,
        redeemed      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        password_hash TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_seen     TIMESTAMPTZ DEFAULT NOW()
      );
      -- Migration for tables created before password auth existed.
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
      CREATE TABLE IF NOT EXISTS app_payments (
        id          TEXT PRIMARY KEY,
        email       TEXT,
        runs        INTEGER,
        amount_cents INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      -- Globally one-time redemption of purchased license keys.
      CREATE TABLE IF NOT EXISTS app_redemptions (
        code        TEXT PRIMARY KEY,
        email       TEXT,
        runs        INTEGER,
        source      TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      -- Prepaid one-time codes minted by the admin and sold via PayPal/etc.
      CREATE TABLE IF NOT EXISTS app_codes (
        code         TEXT PRIMARY KEY,
        runs         INTEGER NOT NULL DEFAULT 10,
        redeemed_by  TEXT,
        redeemed_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('[auth] Schema ready (app_users, app_payments)');
  } catch (e) { console.error('[auth] initSchema failed:', e.message); }
}

async function ensureUser(email) {
  const p = pool();
  if (!p) { if (!memUsers.has(email)) memUsers.set(email, { runs_used: 0, runs_granted: 0, redeemed: new Set() }); return; }
  await p.query(
    `INSERT INTO app_users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_seen = NOW()`,
    [email]
  );
}

async function getUser(email) {
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    return { email, runs_used: u.runs_used, runs_granted: u.runs_granted, redeemed: [...u.redeemed] };
  }
  const r = await p.query(`SELECT email, runs_used, runs_granted, redeemed FROM app_users WHERE email = $1`, [email]);
  if (!r.rows.length) return { email, runs_used: 0, runs_granted: 0, redeemed: [] };
  const row = r.rows[0];
  return { email, runs_used: row.runs_used, runs_granted: row.runs_granted, redeemed: row.redeemed || [] };
}

// ─── PASSWORDS (scrypt, no dependency) ────────────────────────────────────────
// Stored format: scrypt$<saltB64>$<hashB64>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// Fetch just the stored password hash (null if user missing or never set one).
async function getPasswordHash(email) {
  const p = pool();
  if (!p) { const u = memUsers.get(email); return (u && u.password_hash) || null; }
  const r = await p.query(`SELECT password_hash FROM app_users WHERE email = $1`, [email]);
  return r.rows.length ? (r.rows[0].password_hash || null) : null;
}
async function userExists(email) {
  const p = pool();
  if (!p) return memUsers.has(email);
  const r = await p.query(`SELECT 1 FROM app_users WHERE email = $1`, [email]);
  return r.rows.length > 0;
}
async function setPassword(email, passwordHash) {
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    u.password_hash = passwordHash; memUsers.set(email, u); return;
  }
  await p.query(`UPDATE app_users SET password_hash = $2, last_seen = NOW() WHERE email = $1`, [email, passwordHash]);
}

// Brute-force guard for password login: lock 15 min after 5 misses per email.
const loginFails = new Map(); // email -> { count, until }
function loginLocked(email) {
  const f = loginFails.get(email);
  return !!(f && f.until > Date.now());
}
function recordLoginFail(email) {
  const f = loginFails.get(email) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  loginFails.set(email, f);
}
function clearLoginFails(email) { loginFails.delete(email); }

// Atomically consume 1 run if allowance remains. Returns the updated user, or null if exhausted.
async function consumeRun(email) {
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    if (u.runs_used >= FREE_RUNS + u.runs_granted) return null;
    u.runs_used += 1; memUsers.set(email, u);
    return { runs_used: u.runs_used, runs_granted: u.runs_granted };
  }
  const r = await p.query(
    `UPDATE app_users SET runs_used = runs_used + 1, last_seen = NOW()
     WHERE email = $1 AND runs_used < $2 + runs_granted
     RETURNING runs_used, runs_granted`,
    [email, FREE_RUNS]
  );
  return r.rows.length ? r.rows[0] : null;
}

async function grantRuns(email, n) {
  const p = pool();
  if (!p) { const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() }; u.runs_granted += n; memUsers.set(email, u); return; }
  await p.query(`UPDATE app_users SET runs_granted = runs_granted + $2 WHERE email = $1`, [email, n]);
}

// Redeem the free promo code (per-user, one-time).
async function redeemFreeCode(email) {
  const code = DISCOUNT_CODE;
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    if (u.redeemed.has(code)) return { ok: false, error: 'You have already redeemed this code.' };
    u.redeemed.add(code); u.runs_granted += DISCOUNT_RUNS; memUsers.set(email, u);
    return { ok: true, granted: DISCOUNT_RUNS };
  }
  const r = await p.query(
    `UPDATE app_users
       SET runs_granted = runs_granted + $2,
           redeemed = redeemed || to_jsonb($3::text)
     WHERE email = $1 AND NOT (redeemed ? $3)
     RETURNING runs_granted`,
    [email, DISCOUNT_RUNS, code]
  );
  if (!r.rows.length) return { ok: false, error: 'You have already redeemed this code.' };
  return { ok: true, granted: DISCOUNT_RUNS };
}

// Claim a purchased license key globally (one redemption per key, across all users).
const memGlobalCodes = new Map(); // code -> email
async function claimGlobalCode(code, email, runs, source) {
  const p = pool();
  if (!p) { if (memGlobalCodes.has(code)) return false; memGlobalCodes.set(code, email); return true; }
  const r = await p.query(
    `INSERT INTO app_redemptions (code, email, runs, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO NOTHING RETURNING code`,
    [code, email, runs, source || LICENSE_PROVIDER]
  );
  return r.rows.length > 0;
}

function licenseConfigured() {
  return LICENSE_PROVIDER === 'gumroad' ? !!GUMROAD_PRODUCT_ID : LICENSE_PROVIDER === 'lemonsqueezy';
}

// â”€â”€ Prepaid codes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const memCodes = new Map(); // code -> { runs, redeemedBy }
function isAdmin(email) { return !!ADMIN_EMAIL && email === ADMIN_EMAIL; }

// Human-friendly, unambiguous code: DRIX-XXXX-XXXX (no 0/O/1/I).
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => A[crypto.randomInt(0, A.length)]).join('');
  return `DRIX-${seg()}-${seg()}`;
}

async function generateCodes(count, runs) {
  const n = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
  const r = Math.max(1, parseInt(runs, 10) || RUNS_PER_PURCHASE);
  const codes = [];
  while (codes.length < n) { const c = makeCode(); if (!codes.includes(c)) codes.push(c); }
  const p = pool();
  if (!p) { for (const c of codes) memCodes.set(c, { runs: r, redeemedBy: null }); return codes; }
  for (const c of codes) {
    await p.query(`INSERT INTO app_codes (code, runs) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [c, r]);
  }
  return codes;
}

// Claim a prepaid code (one-time). Returns runs granted, or null if invalid/used.
async function claimPrepaidCode(code, email) {
  const c = String(code || '').trim().toUpperCase();
  const p = pool();
  if (!p) {
    const rec = memCodes.get(c);
    if (!rec || rec.redeemedBy) return null;
    rec.redeemedBy = email; return rec.runs;
  }
  const r = await p.query(
    `UPDATE app_codes SET redeemed_by = $2, redeemed_at = NOW()
     WHERE code = $1 AND redeemed_by IS NULL RETURNING runs`,
    [c, email]
  );
  return r.rows.length ? r.rows[0].runs : null;
}

async function codesSummary() {
  const p = pool();
  if (!p) { const all = [...memCodes.values()]; return { total: all.length, redeemed: all.filter(x => x.redeemedBy).length }; }
  const r = await p.query(`SELECT COUNT(*)::int total, COUNT(redeemed_by)::int redeemed FROM app_codes`);
  return r.rows[0] || { total: 0, redeemed: 0 };
}

// Verify a license key with the configured provider. Returns { ok, error? }. No webhook.
async function verifyLicense(key) {
  try {
    if (LICENSE_PROVIDER === 'gumroad') {
      if (!GUMROAD_PRODUCT_ID) return { ok: false, error: 'Codes are not set up yet.' };
      const body = new URLSearchParams({ product_id: GUMROAD_PRODUCT_ID, license_key: key, increment_uses_count: 'false' });
      const r = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) return { ok: false, error: 'Invalid code.' };
      const p = d.purchase || {};
      if (p.refunded || p.chargebacked || p.disputed) return { ok: false, error: 'That purchase was refunded or disputed.' };
      return { ok: true };
    }
    if (LICENSE_PROVIDER === 'lemonsqueezy') {
      const body = new URLSearchParams({ license_key: key });
      const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
        method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.valid) return { ok: false, error: 'Invalid code.' };
      if (LS_PRODUCT_ID && String(d.meta?.product_id) !== String(LS_PRODUCT_ID)) return { ok: false, error: 'Invalid code.' };
      return { ok: true };
    }
    return { ok: false, error: 'Invalid code.' };
  } catch (e) {
    console.error('[auth] verifyLicense error:', e.message);
    return { ok: false, error: 'Could not verify the code. Try again.' };
  }
}

// Top-level redeem: free promo code (per-user) OR purchased license key (global one-time).
async function redeemCode(email, codeRaw) {
  const raw = String(codeRaw || '').trim();
  if (!raw) return { ok: false, error: 'Enter a code.' };
  if (raw.toLowerCase() === DISCOUNT_CODE) return redeemFreeCode(email);

  // Prepaid code (DRIX-XXXX-XXXX) minted by the admin and sold via PayPal/etc.
  if (/^DRIX-/i.test(raw)) {
    const granted = await claimPrepaidCode(raw, email);
    if (!granted) return { ok: false, error: 'Invalid or already-used code.' };
    await grantRuns(email, granted);
    return { ok: true, granted };
  }

  // Otherwise treat it as a purchased license key (Gumroad/LS), if configured.
  if (!licenseConfigured()) return { ok: false, error: 'Invalid code.' };
  const v = await verifyLicense(raw);
  if (!v.ok) return { ok: false, error: v.error || 'Invalid code.' };
  const claimed = await claimGlobalCode(raw, email, RUNS_PER_PURCHASE, LICENSE_PROVIDER);
  if (!claimed) return { ok: false, error: 'This code has already been redeemed.' };
  await grantRuns(email, RUNS_PER_PURCHASE);
  return { ok: true, granted: RUNS_PER_PURCHASE };
}

// â”€â”€â”€ SESSION (HMAC-signed cookie, no dependency) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
}
function makeToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (sig !== sign(payload)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    return data.email;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const attrs = [
    `drix_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`, 'Secure',
  ];
  // Scope to the parent domain so the cookie is shared across getthedrix.com
  // and readyleads.getthedrix.com (same-site, so SameSite=Lax still applies).
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  res.append('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  const attrs = ['drix_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Secure'];
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  res.append('Set-Cookie', attrs.join('; '));
}
function sessionEmail(req) { return verifyToken(parseCookies(req).drix_session); }

// â”€â”€â”€ EMAIL VALIDATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function validateBusinessEmail(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  // The admin email is always allowed, even if it's a personal provider.
  if (ADMIN_EMAIL && email === ADMIN_EMAIL) return { ok: true, email };
  // Always-allow list: these emails ALWAYS get in, bypassing the business-domain
  // rule (additive — normal business-email self-serve still works for everyone else).
  if (ALLOWLIST_EMAILS.has(email)) return { ok: true, email };
  const domain = email.split('@')[1];
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, error: 'Please use your business email address (personal Gmail/Yahoo/Outlook etc. are not accepted).' };
  }
  return { ok: true, email };
}

// ─── PASSWORD RESET (the only flow that emails — sign-in/up never wait on email) ──
// Token = HMAC-signed { email, exp, pw } where pw is a fragment of the CURRENT
// password hash. Changing the password invalidates outstanding reset links.
function makeResetToken(email, currentHash) {
  const pw = crypto.createHash('sha256').update(String(currentHash || 'none')).digest('hex').slice(0, 16);
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + RESET_TTL_MS, pw })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
async function verifyResetToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = String(token).split('.');
  if (sig !== sign(payload)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    const currentHash = await getPasswordHash(data.email);
    const pw = crypto.createHash('sha256').update(String(currentHash || 'none')).digest('hex').slice(0, 16);
    if (pw !== data.pw) return null; // password changed since the link was issued
    return data.email;
  } catch { return null; }
}

async function sendResetEmail(email, resetUrl) {
  if (!RESEND_API_KEY) {
    console.warn(`[auth] RESEND_API_KEY not set — reset link for ${email}: ${resetUrl}`);
    return { ok: true, devLink: resetUrl };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: email,
        subject: 'Reset your DRiX Ready Leads password',
        html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="margin:0 0 8px">Reset your password</h2>
          <p style="color:#444">Click the button below to choose a new password. This link expires in 30 minutes.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none">Choose a new password</a>
          </p>
          <p style="color:#888;font-size:12px">If the button doesn't work, paste this link into your browser:<br>${resetUrl}</p>
          <p style="color:#888;font-size:12px;margin-top:16px">If you didn't request this, ignore this email — your password is unchanged.</p>
        </div>`,
      }),
    });
    if (!resp.ok) { const t = await resp.text(); console.error('[auth] Resend failed:', resp.status, t.slice(0, 200)); return { ok: false, error: 'Could not send the reset email. Try again.' }; }
    return { ok: true };
  } catch (e) { console.error('[auth] sendResetEmail error:', e.message); return { ok: false, error: 'Could not send the reset email. Try again.' }; }
}

// â”€â”€â”€ STRIPE (REST, no dependency; activates when STRIPE_SECRET_KEY set) â”€â”€â”€â”€â”€â”€â”€
function stripeEnabled() { return !!STRIPE_SECRET_KEY; }
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
async function stripeCreateCheckout(email, baseUrl) {
  const params = {
    mode: 'payment',
    'customer_email': email,
    'success_url': `${baseUrl}/?paid=1`,
    'cancel_url': `${baseUrl}/?canceled=1`,
    'client_reference_id': email,
    'metadata': { email, runs: RUNS_PER_PURCHASE },
    'line_items': [{
      quantity: 1,
      'price_data': {
        currency: 'usd',
        'unit_amount': PURCHASE_PRICE_CENTS,
        'product_data': { name: `DRiX Ready Leads â€” ${RUNS_PER_PURCHASE} runs` },
      },
    }],
  };
  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params).join('&'),
  });
  const data = await resp.json();
  if (!resp.ok) { console.error('[auth] Stripe checkout failed:', JSON.stringify(data).slice(0, 300)); throw new Error(data?.error?.message || 'Stripe error'); }
  return data.url;
}
function verifyStripeSig(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return true; // if not configured, accept (dev). Set it in prod.
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(s => s.split('=')));
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));
  } catch { return false; }
}

// â”€â”€â”€ PAYPAL (Orders API v2, redirect + capture, no webhook) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function paypalEnabled() { return !!PAYPAL_CLIENT_ID && !!PAYPAL_SECRET; }

async function paypalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || 'PayPal auth failed');
  return d.access_token;
}

// Create an order tagged with the buyer's email; returns { id, approveUrl }.
async function paypalCreateOrder(email, baseUrl) {
  const token = await paypalToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: email,
      description: `DRiX Ready Leads â€” ${RUNS_PER_PURCHASE} runs`,
      amount: { currency_code: 'USD', value: (PURCHASE_PRICE_CENTS / 100).toFixed(2) },
    }],
    application_context: {
      brand_name: 'DRiX Ready Leads',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: `${baseUrl}/api/pay/paypal/capture`,
      cancel_url: `${baseUrl}/account?canceled=1`,
    },
  };
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) { console.error('[auth] PayPal create order failed:', JSON.stringify(d).slice(0, 300)); throw new Error('Could not start checkout.'); }
  const approve = (d.links || []).find(l => l.rel === 'approve');
  return { id: d.id, approveUrl: approve && approve.href };
}

// Capture an approved order. Returns { ok, email, runs, captureId } on success.
async function paypalCapture(orderId) {
  const token = await paypalToken();
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const d = await r.json();
  if (!r.ok || d.status !== 'COMPLETED') { console.error('[auth] PayPal capture not completed:', JSON.stringify(d).slice(0, 300)); return { ok: false }; }
  const pu = (d.purchase_units || [])[0] || {};
  const cap = (pu.payments && pu.payments.captures && pu.payments.captures[0]) || {};
  const email = (pu.custom_id || '').toLowerCase();
  return { ok: true, email, runs: RUNS_PER_PURCHASE, captureId: cap.id || d.id };
}

// â”€â”€â”€ INSTALL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function install(app, deps = {}) {
  _db = deps.db || null;
  // Behind Railway's proxy: trust X-Forwarded-Proto so req.protocol is https
  // (needed for Secure cookies and correct Stripe redirect URLs).
  try { app.set('trust proxy', true); } catch (_) {}
  initSchema().catch(() => {});

  // â”€â”€ CORS for the auth API â”€â”€
  // Lets the DRiX marketing site (getthedrix.com) call /api/auth/* with the
  // session cookie. Only echoes back origins on the allowlist; handles the
  // preflight OPTIONS that a JSON POST triggers.
  app.use('/api/auth', (req, res, next) => {
    const origin = (req.headers.origin || '').replace(/\/+$/, '');
    if (origin && AUTH_ALLOWED_ORIGINS.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.append('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Stripe webhook needs the RAW body â€” register BEFORE the JSON gate matters.
  // (server.js mounts express.json globally; we capture raw just for this path.)
  const express = require('express');
  app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body || {});
    if (!verifyStripeSig(raw, req.headers['stripe-signature'] || '')) return res.status(400).send('bad signature');
    let evt; try { evt = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }
    if (evt.type === 'checkout.session.completed') {
      const s = evt.data.object;
      const email = (s.client_reference_id || s.customer_email || s.metadata?.email || '').toLowerCase();
      const runs = parseInt(s.metadata?.runs || RUNS_PER_PURCHASE, 10);
      if (email) {
        try {
          await ensureUser(email);
          await grantRuns(email, runs);
          const p = pool();
          if (p) await p.query(`INSERT INTO app_payments (id,email,runs,amount_cents) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
            [s.id, email, runs, s.amount_total || PURCHASE_PRICE_CENTS]);
          console.log(`[auth] Stripe payment: +${runs} runs for ${email}`);
        } catch (e) { console.error('[auth] webhook grant failed:', e.message); }
      }
    }
    res.json({ received: true });
  });

  // ── Auth API (email + password — instant access, no email round-trip) ──

  // CREATE ACCOUNT: new users are in immediately with FREE_RUNS trial runs.
  // Legacy accounts created under the old email-code system have no password;
  // signing up with that email simply sets their password (runs are preserved).
  app.post('/api/auth/signup', async (req, res) => {
    const v = validateBusinessEmail(req.body?.email);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const password = String(req.body?.password || '');
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    try {
      const existingHash = await getPasswordHash(v.email);
      if (existingHash) {
        return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.', code: 'ACCOUNT_EXISTS' });
      }
      await ensureUser(v.email);
      await setPassword(v.email, hashPassword(password));
      setSessionCookie(res, makeToken(v.email));
      const u = await getUser(v.email);
      console.log(`[auth] Signup: ${v.email}`);
      res.json({ ok: true, email: v.email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    } catch (e) { console.error('[auth] signup error:', e.message); res.status(500).json({ error: 'Could not create your account. Try again.' }); }
  });

  // SIGN IN: email + password. Locks 15 minutes after 5 bad attempts.
  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    if (loginLocked(email)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

    // Owner bypass: BYPASS_EMAIL signs in with BYPASS_SECRET as the password.
    if (bypassEnabled() && email === BYPASS_EMAIL && safeEqual(password, BYPASS_SECRET)) {
      clearLoginFails(email);
      await ensureUser(email);
      setSessionCookie(res, makeToken(email));
      const u = await getUser(email);
      console.log(`[auth] Owner bypass sign-in: ${email}`);
      return res.json({ ok: true, email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    }

    try {
      const exists = await userExists(email);
      const hash = exists ? await getPasswordHash(email) : null;
      if (exists && !hash) {
        // Legacy email-code account that never set a password.
        return res.status(400).json({
          error: 'This account predates passwords. Use "Create account" with this email to set yours — your runs are saved.',
          code: 'NO_PASSWORD_SET',
        });
      }
      if (!hash || !verifyPassword(password, hash)) {
        recordLoginFail(email);
        return res.status(400).json({ error: 'Incorrect email or password.' });
      }
      clearLoginFails(email);
      await ensureUser(email); // bumps last_seen
      setSessionCookie(res, makeToken(email));
      const u = await getUser(email);
      res.json({ ok: true, email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    } catch (e) { console.error('[auth] login error:', e.message); res.status(500).json({ error: 'Sign-in failed. Try again.' }); }
  });

  // FORGOT PASSWORD: emails a reset link (the one place email speed doesn't gate access).
  // Always responds ok so the endpoint can't be used to probe which emails have accounts.
  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    try {
      const exists = await userExists(email);
      if (exists) {
        const currentHash = await getPasswordHash(email);
        const token = makeResetToken(email, currentHash);
        const reqBase = `${req.protocol}://${req.get('host')}`;
        const baseUrl = (APP_URL && !/localhost|127\.0\.0\.1/.test(APP_URL)) ? APP_URL : reqBase;
        const resetUrl = `${baseUrl}/account?reset=${encodeURIComponent(token)}`;
        const sent = await sendResetEmail(email, resetUrl);
        if (sent.devLink) return res.json({ ok: true, devLink: sent.devLink });
      }
      res.json({ ok: true });
    } catch (e) { console.error('[auth] forgot-password error:', e.message); res.json({ ok: true }); }
  });

  // RESET PASSWORD: token from the email link + new password. Signs the user in.
  app.post('/api/auth/reset-password', async (req, res) => {
    const password = String(req.body?.password || '');
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    try {
      const email = await verifyResetToken(req.body?.token);
      if (!email) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
      await ensureUser(email);
      await setPassword(email, hashPassword(password));
      clearLoginFails(email);
      setSessionCookie(res, makeToken(email));
      const u = await getUser(email);
      console.log(`[auth] Password reset: ${email}`);
      res.json({ ok: true, email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    } catch (e) { console.error('[auth] reset-password error:', e.message); res.status(500).json({ error: 'Could not reset your password. Try again.' }); }
  });

  app.post('/api/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

  app.get('/api/auth/me', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'Not signed in' });
    const u = await getUser(email);
    res.json({
      email, free: FREE_RUNS, runs_used: u.runs_used, runs_granted: u.runs_granted,
      remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used),
      redeemed: u.redeemed, stripe_enabled: stripeEnabled(),
      license_enabled: licenseConfigured(), buy_url: BUY_URL, runs_per_purchase: RUNS_PER_PURCHASE,
      is_admin: isAdmin(email), paypal_enabled: paypalEnabled(),
    });
  });

  app.post('/api/auth/redeem', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'Not signed in' });
    await ensureUser(email);
    const r = await redeemCode(email, req.body?.code);
    if (!r.ok) return res.status(400).json({ error: r.error });
    const u = await getUser(email);
    res.json({ ok: true, granted: r.granted, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
  });

  app.post('/api/auth/checkout', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'Not signed in' });
    if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY in Railway.' });
    try {
      // Use the real request host (correct on Railway). Only fall back to APP_URL
      // if it's a real public URL, never localhost.
      const reqBase = `${req.protocol}://${req.get('host')}`;
      const baseUrl = (APP_URL && !/localhost|127\.0\.0\.1/.test(APP_URL)) ? APP_URL : reqBase;
      const url = await stripeCreateCheckout(email, baseUrl);
      res.json({ ok: true, url });
    } catch (e) { res.status(502).json({ error: e.message || 'Could not start checkout.' }); }
  });

  // â”€â”€ PayPal: fully automated buy â†’ auto-credit (no webhook) â”€â”€
  app.post('/api/auth/checkout-paypal', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'Not signed in' });
    if (!paypalEnabled()) return res.status(503).json({ error: 'PayPal is not configured yet. Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in Railway.' });
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const order = await paypalCreateOrder(email, baseUrl);
      if (!order.approveUrl) throw new Error('No approval URL from PayPal.');
      res.json({ ok: true, url: order.approveUrl });
    } catch (e) { res.status(502).json({ error: e.message || 'Could not start checkout.' }); }
  });

  // Buyer is redirected back here from PayPal after approving. Capture + credit.
  app.get('/api/pay/paypal/capture', async (req, res) => {
    const orderId = req.query.token; // PayPal returns ?token=<orderId>
    if (!orderId) return res.redirect('/account?error=payment');
    try {
      const cap = await paypalCapture(String(orderId));
      if (!cap.ok || !cap.email) return res.redirect('/account?error=payment');
      // Idempotent credit: only grant once per capture id.
      const claimed = await claimGlobalCode(`paypal:${cap.captureId}`, cap.email, cap.runs, 'paypal');
      if (claimed) {
        await ensureUser(cap.email);
        await grantRuns(cap.email, cap.runs);
        console.log(`[auth] PayPal: +${cap.runs} runs for ${cap.email} (capture ${cap.captureId})`);
      }
      return res.redirect('/account?paid=1');
    } catch (e) { console.error('[auth] PayPal capture error:', e.message); return res.redirect('/account?error=payment'); }
  });

  // â”€â”€ Admin: mint prepaid codes â”€â”€
  function adminOK(req) {
    const email = sessionEmail(req);
    if (isAdmin(email)) return true;
    if (ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN) return true;
    return false;
  }
  app.post('/api/admin/generate-codes', async (req, res) => {
    if (!adminOK(req)) return res.status(403).json({ error: 'Admin only.' });
    const codes = await generateCodes(req.body?.count, req.body?.runs);
    res.json({ ok: true, count: codes.length, runs_each: req.body?.runs || RUNS_PER_PURCHASE, codes });
  });
  app.get('/api/admin/codes-summary', async (req, res) => {
    if (!adminOK(req)) return res.status(403).json({ error: 'Admin only.' });
    res.json(await codesSummary());
  });

  // Account / redeem / buy page (signed-in users; otherwise the login wall).
  // A ?reset= token always gets the login page so the reset form can render.
  app.get('/account', (req, res) => {
    const email = sessionEmail(req);
    const file = (email && !req.query.reset) ? 'account.html' : 'login.html';
    res.sendFile(require('path').join(__dirname, 'public', file));
  });

  // â”€â”€ THE GATE â”€â”€
  app.use((req, res, next) => {
    const p = req.path;
    // Always-open paths
    if (p.startsWith('/api/auth/') || p.startsWith('/api/pay/') || p === '/api/stripe/webhook' || p === '/healthz') return next();

    const email = sessionEmail(req);

    if (p.startsWith('/api/')) {
      if (!email) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH_REQUIRED' });
      req.userEmail = email;
      const key = `${req.method} ${p}`;
      if (METERED_ROUTES.has(key)) {
        return consumeRun(email).then((u) => {
          if (!u) return res.status(402).json({
            error: 'You are out of runs. Redeem a code or buy more to continue.',
            code: 'PAYMENT_REQUIRED',
          });
          res.set('X-Runs-Remaining', String(Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used)));
          next();
        }).catch((e) => { console.error('[auth] consumeRun error:', e.message); res.status(500).json({ error: 'Metering error' }); });
      }
      return next();
    }

    // Non-API navigation: signed-in users get the app; everyone else is sent to
    // the login. If LOGIN_URL is set (the marketing site now hosts sign-in), we
    // bounce there and remember where they were headed via ?next=. Otherwise we
    // fall back to the app's built-in login wall.
    if (email) return next();
    const accept = req.headers.accept || '';
    if (req.method === 'GET' && accept.includes('text/html')) {
      if (LOGIN_URL) {
        const dest = encodeURIComponent(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        return res.redirect(302, `${LOGIN_URL}/?signin=1&next=${dest}`);
      }
      return res.status(200).sendFile(require('path').join(__dirname, 'public', 'login.html'));
    }
    return next();
  });
}

module.exports = { install };
// end of auth.js
