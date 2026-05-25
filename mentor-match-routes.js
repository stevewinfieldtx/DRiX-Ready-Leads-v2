// ═══════════════════════════════════════════════════════════════════════════
//  DRiX — Mentor Match backend routes
//  Founder ↔ mentor/investor matching, enrichment, deep briefs, and archive.
//
//  Registered from server.js:
//     const registerMentorMatch = require('./mentor-match-routes');
//     registerMentorMatch(app, { callLLM });
//
//  Reuses existing DRiX building blocks:
//     - callLLM(systemPrompt, userContent, opts) → parsed JSON   (passed in)
//     - scanIndividual({...})                    → deep psychographic scan (Apollo + web + LLM)
//     - enrichCompany() / extractDomain()        → firm / employer intelligence
//     - db.getPool()                             → Postgres (Railway)
// ═══════════════════════════════════════════════════════════════════════════

const db = require('./db');
const { scanIndividual } = require('./individual-scan');
const { enrichCompany, extractDomain } = require('./company-intel');

// Canonical sector vocabulary — MUST mirror client/src/lib/mentorMatch.ts SECTOR_OPTIONS
const SECTOR_OPTIONS = [
  'AI/ML', 'SaaS/Enterprise', 'Fintech', 'Cybersecurity', 'E-commerce/Marketplace',
  'Edtech', 'Healthtech', 'Logistics/Mobility', 'Web3/Crypto', 'Marketing/Martech',
  'Proptech/RealEstate', 'Foodtech', 'Hardware/IoT/DeepTech', 'Gaming',
  'Climate/Energy', 'Media/Content',
];

// ─── DB schema (additive — does not touch existing tables) ──────────────────
async function initMentorTables() {
  const p = db.getPool && db.getPool();
  if (!p) { console.warn('[mentor-match] No DB pool — archive/profile persistence disabled.'); return; }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS founder_profiles (
        email       TEXT PRIMARY KEY,
        profile     JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS mentor_briefs (
        id              TEXT PRIMARY KEY,
        email           TEXT,
        mentor_name     TEXT,
        mentor_company  TEXT,
        score           INTEGER,
        founder_snapshot JSONB,
        brief           JSONB NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_mentor_briefs_email ON mentor_briefs(email);`);
    console.log('[mentor-match] DB tables ready.');
  } catch (err) {
    console.error('[mentor-match] initMentorTables failed:', err.message);
  }
}

function newId() {
  return 'mb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── Prompts ────────────────────────────────────────────────────────────────
const SECTOR_PROMPT = `You are a startup analyst. Read the founder's description of their company (which may include pasted text and extracted document content) and do two things:
1. Write a tight 2-3 sentence neutral summary of what the company does.
2. Choose the most relevant sectors STRICTLY from this fixed list (do not invent new labels):
${SECTOR_OPTIONS.map((s) => `- ${s}`).join('\n')}

Return ONLY valid JSON, no prose, in exactly this shape:
{"summary": "...", "sectors": ["...", "..."]}
Pick 1-4 sectors, most relevant first. If unsure, pick the closest matches from the list only.`;

const BRIEF_PROMPT = `You are an elite startup fundraising and partnership coach preparing a founder for a specific mentor/investor meeting. You are given (a) the founder's profile, (b) the mentor's directory record, and (c) optional deep-scan intelligence about the mentor.

Be specific, honest, and actionable. Do NOT invent facts about the person you were not given — if the deep scan is thin, give role-based guidance and say what to verify. Never fabricate the mentor's personal opinions; ground "how to talk to them" in their role, firm, and any provided scan signals.

Return ONLY valid JSON in exactly this shape:
{
  "fit_paragraph": "3-5 sentences: why this mentor is or isn't a strong match for THIS founder, in plain language.",
  "how_to_talk": "2-4 sentences on communication approach for this person's role/seniority/region.",
  "how_to_pitch": "2-4 sentences on the pitch angle most likely to land with them.",
  "elevator_pitch_amendment": "A rewritten ~30-second elevator pitch for the founder, tailored to THIS mentor's lens.",
  "deck_amendments": ["3-6 concrete, specific changes to the founder's pitch deck for this meeting"],
  "firm_brief": "What the founder should know about the mentor's investment firm / fund (stage, likely thesis, check posture) — mark clearly if inferred vs known.",
  "employer_brief": "What the founder should know about the company the mentor works for (if different from a fund).",
  "smart_questions": ["3-5 sharp questions the founder should ask this mentor"],
  "other_relevant": "Anything else useful for the conversation.",
  "confidence_note": "One line on how grounded this brief is (deep-scan vs role-based inference)."
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────
function isLinkedIn(url) { return typeof url === 'string' && /linkedin\.com\/in\//i.test(url); }

function compactScan(scan) {
  if (!scan || typeof scan !== 'object') return null;
  return {
    recognized: scan.scan?.recognized ?? null,
    confidence: scan.scan?.confidence ?? null,
    summary: scan.summary || '',
    key_insight: scan.target?.key_insight || '',
    leadership_style: scan.leadership_style || '',
    career_highlights: (scan.career_highlights || []).slice(0, 8),
    public_signals: (scan.public_signals || []).slice(0, 8),
    pain_signals: (scan.pain_signals || []).slice(0, 6),
    pitch_angles: (scan.pitch_angles || []).slice(0, 6),
    vendor_opinions: (scan.vendor_opinions || []).slice(0, 6),
  };
}

function extractContact(scan) {
  if (!scan || typeof scan !== 'object') return null;
  const t = scan.target || {};
  const c = scan.contact || t.contact || {};
  const out = {
    email: c.email || t.email || null,
    phone: c.phone || t.phone || null,
    linkedin: t.linkedin || c.linkedin || null,
    location: t.location || c.location || null,
  };
  return (out.email || out.phone || out.linkedin || out.location) ? out : null;
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = function registerMentorMatch(app, deps = {}) {
  const { callLLM } = deps;
  if (typeof callLLM !== 'function') {
    console.error('[mentor-match] registerMentorMatch requires { callLLM }. Routes NOT registered.');
    return;
  }

  initMentorTables();

  // ── 1) Enrich company text/docs → summary + suggested sectors ─────────────
  app.post('/api/mentor/enrich-company', async (req, res) => {
    try {
      const { text = '', docs = [], youtube_url = '' } = req.body || {};
      const docText = (Array.isArray(docs) ? docs : [])
        .map((d) => `--- ${d.filename || 'document'} ---\n${(d.text || '').slice(0, 8000)}`)
        .join('\n\n');
      const parts = [];
      if (text.trim()) parts.push(`FOUNDER DESCRIPTION:\n${text.trim()}`);
      if (youtube_url.trim()) parts.push(`REFERENCE VIDEO: ${youtube_url.trim()}`);
      if (docText.trim()) parts.push(`UPLOADED DOCUMENTS:\n${docText}`);
      const userContent = parts.join('\n\n');
      if (!userContent.trim()) return res.status(400).json({ error: 'Provide company text, a document, or a video URL.' });

      const out = await callLLM(SECTOR_PROMPT, userContent, { maxTokens: 1200, temperature: 0.2 });
      const sectors = Array.isArray(out?.sectors)
        ? out.sectors.filter((s) => SECTOR_OPTIONS.includes(s))
        : [];
      res.json({ summary: out?.summary || '', sectors });
    } catch (err) {
      console.error('[mentor-match] enrich-company:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── 2) Deep mentor brief ─────────────────────────────────────────────────
  app.post('/api/mentor/brief', async (req, res) => {
    try {
      const { founder = {}, mentor = {}, deep = true, save = false, email = '' } = req.body || {};
      if (!mentor.name) return res.status(400).json({ error: 'mentor.name required' });

      // (a) Deep psychographic scan (Apollo + web + LLM) — best-effort
      let scan = null;
      if (deep) {
        try {
          scan = await scanIndividual({
            linkedin_url: isLinkedIn(mentor.url) ? mentor.url : null,
            name: mentor.name,
            title: mentor.title || '',
            company_url: null,
            tier: 1,
          });
        } catch (e) {
          console.warn('[mentor-match] scanIndividual failed:', e.message);
        }
      }

      // (b) Firm / employer intelligence — best-effort (needs a domain)
      let firmIntel = null;
      try {
        const domain = mentor.company && /\./.test(mentor.company) ? extractDomain(mentor.company) : null;
        if (domain) firmIntel = await enrichCompany(domain).catch(() => null);
      } catch { /* ignore */ }

      // (c) Tailored coaching brief via LLM
      const userContent = JSON.stringify({
        founder: {
          company: founder.companyName, one_liner: founder.oneLiner, summary: founder.summary || '',
          sectors: founder.sectors, stage: founder.stage, raising: founder.raising,
          raise: founder.raiseAmount, geos: founder.geos, needs: founder.needs,
        },
        mentor: {
          name: mentor.name, title: mentor.title, company: mentor.company,
          classification: mentor.classification, investor: mentor.investor,
        },
        deep_scan: compactScan(scan),
        firm_intel: firmIntel ? { name: firmIntel.name, summary: firmIntel.summary, industry: firmIntel.industry, size: firmIntel.size } : null,
      });

      const brief = await callLLM(BRIEF_PROMPT, userContent, { maxTokens: 6000, temperature: 0.4 });

      const result = {
        mentor: { name: mentor.name, title: mentor.title, company: mentor.company, url: mentor.url, investor: mentor.investor },
        brief: brief || {},
        contact: extractContact(scan),
        scan: compactScan(scan),
        firm_intel: firmIntel || null,
        generated_at: new Date().toISOString(),
      };

      if (save) {
        const id = newId();
        try {
          const p = db.getPool && db.getPool();
          if (p) {
            await p.query(
              `INSERT INTO mentor_briefs (id, email, mentor_name, mentor_company, score, founder_snapshot, brief, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
              [id, email || null, mentor.name, mentor.company || null, mentor.score ?? null,
               JSON.stringify(founder), JSON.stringify(result)],
            );
            result.id = id;
          }
        } catch (e) { console.warn('[mentor-match] save brief failed:', e.message); }
      }

      res.json(result);
    } catch (err) {
      console.error('[mentor-match] brief:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── 3) Founder profile persistence ───────────────────────────────────────
  app.post('/api/mentor/profile', async (req, res) => {
    try {
      const { email, profile } = req.body || {};
      if (!email || !profile) return res.status(400).json({ error: 'email and profile required' });
      const p = db.getPool && db.getPool();
      if (!p) return res.status(503).json({ error: 'DB not configured' });
      await p.query(
        `INSERT INTO founder_profiles (email, profile, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (email) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()`,
        [email, JSON.stringify(profile)],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[mentor-match] save profile:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/mentor/profile', async (req, res) => {
    try {
      const email = req.query.email;
      const p = db.getPool && db.getPool();
      if (!p) return res.status(503).json({ error: 'DB not configured' });
      const r = await p.query(`SELECT profile FROM founder_profiles WHERE email = $1`, [email]);
      res.json({ profile: r.rows[0]?.profile || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 4) Archive: list + fetch one (shareable) ─────────────────────────────
  app.get('/api/mentor/briefs', async (req, res) => {
    try {
      const email = req.query.email;
      const p = db.getPool && db.getPool();
      if (!p) return res.status(503).json({ error: 'DB not configured' });
      const r = await p.query(
        `SELECT id, mentor_name, mentor_company, score, created_at
           FROM mentor_briefs WHERE email = $1 ORDER BY created_at DESC LIMIT 100`,
        [email],
      );
      res.json({ briefs: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/mentor/brief/:id', async (req, res) => {
    try {
      const p = db.getPool && db.getPool();
      if (!p) return res.status(503).json({ error: 'DB not configured' });
      const r = await p.query(`SELECT * FROM mentor_briefs WHERE id = $1`, [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[mentor-match] routes registered: /api/mentor/{enrich-company,brief,profile,briefs,brief/:id}');
};
