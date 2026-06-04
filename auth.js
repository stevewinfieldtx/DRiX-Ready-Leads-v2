// auth.js — DRiX Ready Leads authentication, metering, discount codes, Stripe
// ─────────────────────────────────────────────────────────────────────────────
// Self-contained. No new npm dependencies (uses Node crypto + global fetch).
//
// What this does:
//   1. AUTH WALL  — every /api/* route (except /api/auth/*) requires a logged-in
//      user with a verified BUSINESS email. Login = email one-time passcode (OTP)
//      delivered via the existing Resend account. Session = HMAC-signed cookie.
//   2. METERING   — each "run" (an expensive API endpoint) consumes 1 credit.
//      Every user gets 3 FREE runs. After that they must buy more or redeem a code.
//   3. DISCOUNT   — code "steveisawesome" (exact, lowercase) grants 10 runs at no
//      cost, redeemable ONCE per user.
//   4. STRIPE     — Checkout for a 10-run pack at $10. Activates automatically once
//      STRIPE_SECRET_KEY is set in Railway env. Webhook credits the runs on payment.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FREE_RUNS         = 3;                 // free runs every user gets
const RUNS_PER_PURCHASE = 10;                // 10 runs per $10 pack
const PURCHASE_PRICE_CENTS = 1000;           // $10.00
const DISCOUNT_CODE     = 'steveisawesome';  // exact, lowercase
const DISCOUNT_RUNS     = 10;                 // runs the code grants
const OTP_TTL_MS        = 10 * 60 * 1000;    // passcode valid 10 minutes
const SESSION_TTL_MS    = 30 * 24 * 60 * 60 * 1000; // 30 days

const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('drix-session::' + (process.env.OPENROUTER_API_KEY || 'fallback')).digest('hex');

const RESEND_API_KEY   = process.env.RESEND_API_KEY || '';
const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'steve.winfield@wintechpartners.com';
const APP_URL          = (process.env.APP_URL || '').replace(/\/+$/, '');

// ── Cross-site login (auth lives on the DRiX marketing site) ─────────────────
// COOKIE_DOMAIN   — scope the session cookie to the parent domain so it's valid
//                   on BOTH getthedrix.com and readyleads.getthedrix.com.
//                   e.g. ".getthedrix.com"  (leave blank for old host-only behavior)
// LOGIN_URL       — where to bounce un-authed visitors. e.g. "https://www.getthedrix.com"
// AUTH_ALLOWED_ORIGINS — origins allowed to call /api/auth/* with credentials
//                   (the marketing site). Comma-separated, no trailing slash.
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim();
const LOGIN_URL     = (process.env.LOGIN_URL || '').replace(/\/+$/, '');
const AUTH_ALLOWED_ORIGINS = new Set(
  (process.env.AUTH_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
);
// Optional invite-only switch. When this is non-empty, ONLY these emails can sign
// in (and they bypass the business-domain rule). Leave blank for open self-serve.
const ALLOWLIST_EMAILS = new Set(
  (process.env.ALLOWLIST_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// ── License-key payments (Gumroad / Lemon Squeezy) — NO WEBHOOK ──────────────
// Buyer purchases on Gumroad/LS → receives a license key → pastes it in the app's
// redeem box → server verifies the key with one API call and grants 10 runs.
// Each key is one-time across all users (enforced in app_redemptions).
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || '';
const LS_PRODUCT_ID      = process.env.LEMONSQUEEZY_PRODUCT_ID || ''; // optional product lock
const BUY_URL            = process.env.BUY_URL || '';                 // your Gumroad/LS product page
const LICENSE_PROVIDER   = (process.env.LICENSE_PROVIDER
  || (GUMROAD_PRODUCT_ID ? 'gumroad' : (process.env.LEMONSQUEEZY ? 'lemonsqueezy' : ''))).toLowerCase();

// ── Prepaid codes (processor-proof: PayPal/Venmo/etc. just collect money) ────
// Admin mints one-time "10-run" codes and hands them to buyers after payment.
// ADMIN_EMAIL can always sign in (bypasses the business-email rule) and gets the
// "generate codes" power. ADMIN_TOKEN is an optional no-login backup for the API.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ── PayPal (fully automated: create order → buyer pays → return → auto-credit) ─
// No webhook: we capture on return and read the buyer's email from the order's
// custom_id, so the right account is credited even if the session is lost.
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET || '';
const PAYPAL_ENV       = (process.env.PAYPAL_ENV || 'live').toLowerCase();
const PAYPAL_BASE      = PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

// Free / consumer email providers are NOT business emails — block them.
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

// ─── STORE (Postgres, with in-memory fallback) ───────────────────────────────
// app_users: email PK, runs_used, runs_granted (purchased+redeemed), redeemed jsonb.
let _db = null;
const memUsers = new Map();   // email -> { runs_used, runs_granted, redeemed:Set }
const otpStore = new Map();   // email -> { hash, exp, tries }

function pool() { try { return _db && _db.getPool && _db.getPool(); } catch { return null; } }

async function initSchema() {
  const p = pool();
  if (!p) { console.warn('[auth] No DATABASE_URL — using in-memory user store (resets on deploy).'); return; }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        email         TEXT PRIMARY KEY,
        runs_used     INTEGER NOT NULL DEFAULT 0,
        runs_granted  INTEGER NOT NULL DEFAULT 0,
        redeemed      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_seen     TIMESTAMPTZ DEFAULT NOW()
      );
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

// ── Prepaid codes ────────────────────────────────────────────────────────────
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

// ─── SESSION (HMAC-signed cookie, no dependency) ─────────────────────────────
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

// ─── EMAIL VALIDATION ────────────────────────────────────────────────────────
function validateBusinessEmail(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  // The admin email is always allowed, even if it's a personal provider.
  if (ADMIN_EMAIL && email === ADMIN_EMAIL) return { ok: true, email };
  // Invite-only mode: if an allowlist is configured, only those emails get in
  // (and they skip the business-domain rule).
  if (ALLOWLIST_EMAILS.size > 0) {
    if (!ALLOWLIST_EMAILS.has(email)) {
      return { ok: false, error: "This email isn't on the DRiX access list yet. Contact us to request access." };
    }
    return { ok: true, email };
  }
  const domain = email.split('@')[1];
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, error: 'Please use your business email address (personal Gmail/Yahoo/Outlook etc. are not accepted).' };
  }
  return { ok: true, email };
}

// ─── OTP DELIVERY (Resend) ───────────────────────────────────────────────────
async function sendOtpEmail(email, code) {
  if (!RESEND_API_KEY) {
    console.warn(`[auth] RESEND_API_KEY not set — OTP for ${email} is ${code} (logged, not emailed).`);
    return { ok: true, devCode: code };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: email,
        subject: `Your DRiX sign-in code: ${code}`,
        html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="margin:0 0 8px">Sign in to DRiX Ready Leads</h2>
          <p style="color:#444">Enter this code to continue. It expires in 10 minutes.</p>
          <div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#0f172a;color:#fff;padding:16px 0;text-align:center;border-radius:10px">${code}</div>
          <p style="color:#888;font-size:12px;margin-top:16px">If you didn't request this, ignore this email.</p>
        </div>`,
      }),
    });
    if (!resp.ok) { const t = await resp.text(); console.error('[auth] Resend failed:', resp.status, t.slice(0, 200)); return { ok: false, error: 'Could not send the code. Try again.' }; }
    return { ok: true };
  } catch (e) { console.error('[auth] sendOtpEmail error:', e.message); return { ok: false, error: 'Could not send the code. Try again.' }; }
}

function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashCode(email, code) { return crypto.createHmac('sha256', SESSION_SECRET).update(`${email}:${code}`).digest('hex'); }

// ─── STRIPE (REST, no dependency; activates when STRIPE_SECRET_KEY set) ───────
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
        'product_data': { name: `DRiX Ready Leads — ${RUNS_PER_PURCHASE} runs` },
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

// ─── PAYPAL (Orders API v2, redirect + capture, no webhook) ──────────────────
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
      description: `DRiX Ready Leads — ${RUNS_PER_PURCHASE} runs`,
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

// ─── INSTALL ─────────────────────────────────────────────────────────────────
function install(app, deps = {}) {
  _db = deps.db || null;
  // Behind Railway's proxy: trust X-Forwarded-Proto so req.protocol is https
  // (needed for Secure cookies and correct Stripe redirect URLs).
  try { app.set('trust proxy', true); } catch (_) {}
  initSchema().catch(() => {});

  // ── CORS for the auth API ──
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

  // Stripe webhook needs the RAW body — register BEFORE the JSON gate matters.
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

  // ── Auth API ──
  app.post('/api/auth/request-code', async (req, res) => {
    const v = validateBusinessEmail(req.body?.email);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const code = newCode();
    otpStore.set(v.email, { hash: hashCode(v.email, code), exp: Date.now() + OTP_TTL_MS, tries: 0 });
    const sent = await sendOtpEmail(v.email, code);
    if (!sent.ok) return res.status(502).json({ error: sent.error });
    res.json({ ok: true, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
  });

  app.post('/api/auth/verify', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const rec = otpStore.get(email);
    if (!rec || Date.now() > rec.exp) return res.status(400).json({ error: 'Code expired. Request a new one.' });
    if (rec.tries >= 5) { otpStore.delete(email); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }
    rec.tries += 1;
    if (hashCode(email, code) !== rec.hash) return res.status(400).json({ error: 'Incorrect code.' });
    otpStore.delete(email);
    await ensureUser(email);
    setSessionCookie(res, makeToken(email));
    const u = await getUser(email);
    res.json({ ok: true, email, remaining: FREE_RUNS + u.runs_granted - u.runs_used });
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

  // ── PayPal: fully automated buy → auto-credit (no webhook) ──
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

  // ── Admin: mint prepaid codes ──
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
  app.get('/account', (req, res) => {
    const email = sessionEmail(req);
    const file = email ? 'account.html' : 'login.html';
    res.sendFile(require('path').join(__dirname, 'public', file));
  });

  // ── THE GATE ──
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
