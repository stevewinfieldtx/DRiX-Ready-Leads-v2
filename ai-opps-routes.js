// ai-opps-routes.js — ADD-ON (strictly additive — no edits to existing code)
//
// AI Opps intake. The user gives:
//   1) user_email             (required)
//   2) user_company_url       (required) — becomes BOTH sender_company_url and
//                                          solution_url for /api/demo-flow. The
//                                          ingest cache dedupes by URL, so the
//                                          user company is only ingested once.
//   At LEAST ONE of:
//   3) customer_url           → customer_url for /api/demo-flow
//   4) industry (NAICS)       → industry  (archetype synthesis if no customer_url)
//   5) subindustry (NAICS)    → subindustry
//   6) recipient_role         → recipient_role
//
// The page POSTs the prepared payload directly to /api/demo-flow with
// flow_mode: 'ai-opps' — server.js's strategy step swaps in
// STRATEGIES_PROMPT_AI_OPPS for this flag. Everything downstream
// (pain, /api/hydrate, clearsignals, coach, report) is unchanged.
//
// All new endpoints live under /ai-opps and /api/ai-*  — no collision with any
// existing route. Registered from server.js via a single additive require()
// line, identical pattern to registerMentorMatch / cross-sell.

const path = require('path');

module.exports = function registerAiOpps(app, deps = {}) {
  const { fetchAndStrip } = deps;
  if (typeof fetchAndStrip !== 'function') {
    throw new Error('ai-opps-routes: fetchAndStrip must be passed in from server.js');
  }

  // ─── GET /ai-opps  ── serve the AI Opps intake page ────────────────────────
  app.get('/ai-opps', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ai-opps.html'));
  });

  // ─── POST /api/ai-prepare ──────────────────────────────────────────────────
  // Validates the loose input set, builds a normalized payload the client
  // posts to /api/demo-flow. We do NOT proxy demo-flow here (avoids
  // duplicating SSE plumbing) — the client posts the prepared payload itself.
  const prepareHandler = async (req, res) => {
    try {
      const {
        email,
        user_company_url,
        customer_url,
        industry,
        subindustry,
        recipient_role,
        user_notes
      } = req.body || {};

      // ── Required ────────────────────────────────────────────────────────
      if (!email) return res.status(400).json({ error: 'Require email (your email)' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email looks invalid.' });
      if (!user_company_url) return res.status(400).json({ error: 'Require user_company_url (your company URL)' });

      // ── At least one of the four must be present ────────────────────────
      const hasCustomer    = !!(customer_url && customer_url.trim());
      const hasIndustry    = !!(industry && industry.trim());
      const hasSubindustry = !!(subindustry && subindustry.trim());
      const hasRole        = !!(recipient_role && recipient_role.trim());
      if (!hasCustomer && !hasIndustry && !hasSubindustry && !hasRole) {
        return res.status(400).json({
          error: 'Require at least one of: customer_url, industry, subindustry, recipient_role'
        });
      }

      // ── Build payload for /api/demo-flow ────────────────────────────────
      // Per Steve's design call: the user_company_url is reused as BOTH sender
      // and solution. The ingest cache dedupes by URL so the second ingestOne
      // call is an instant hit, not a duplicate LLM run. The AI Opps prompt
      // explicitly tells the LLM that sender and solution are the same entity
      // and that the "solution" is AI integration, not a separate product.
      const payload = {
        email,
        sender_company_url: user_company_url,
        solution_url:       user_company_url,
        flow_mode:          'ai-opps'
      };
      if (hasCustomer)    payload.customer_url   = customer_url.trim();
      if (hasIndustry)    payload.industry       = industry.trim();
      if (hasSubindustry) payload.subindustry    = subindustry.trim();
      if (hasRole)        payload.recipient_role = recipient_role.trim();

      // Optional free-form notes from the user — pre-fetched into docs_customer
      // so the customer ingest LLM has the user's framing of why AI fits here.
      if (user_notes && String(user_notes).trim()) {
        payload.docs_customer = [{
          filename: 'USER NOTES (AI Opps intake)',
          text: `USER NOTES (from ${user_company_url}):\n\n${String(user_notes).trim()}`
        }];
      }

      // ── Return prepared payload + meta the UI can show ──────────────────
      return res.json({
        ok: true,
        prepared: payload,
        meta: {
          user_company_url,
          customer_url: hasCustomer ? customer_url.trim() : null,
          industry: hasIndustry ? industry.trim() : null,
          subindustry: hasSubindustry ? subindustry.trim() : null,
          recipient_role: hasRole ? recipient_role.trim() : null,
          notes_chars: user_notes ? String(user_notes).trim().length : 0,
          flow_mode: 'ai-opps',
          inputs_summary: [
            hasCustomer    && 'customer URL',
            hasIndustry    && 'industry',
            hasSubindustry && 'sub-industry',
            hasRole        && 'role/title'
          ].filter(Boolean).join(', ')
        }
      });
    } catch (err) {
      console.error('[ai-opps/prepare] failed:', err);
      return res.status(500).json({ error: err.message || 'ai-opps prepare failed' });
    }
  };
  app.post('/api/ai-prepare', prepareHandler);

  console.log('[ai-opps] add-on routes registered: GET /ai-opps, POST /api/ai-prepare');
};
