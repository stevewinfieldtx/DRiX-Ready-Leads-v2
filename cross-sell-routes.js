// cross-sell-routes.js — ADD-ON (strictly additive — no edits to existing code)
//
// Partner-facing cross-sell intake. The partner provides four URLs:
//   1) partner_company_url       → becomes sender_company_url
//   2) installed_solution_url    → pre-fetched, injected into docs_customer
//                                  (so the customer atoms know "they already
//                                  own this", and the strategy LLM will avoid
//                                  recommending duplicates and lean into the
//                                  existing relationship)
//   3) cross_sell_urls (1..N)    → first one becomes solution_url; the rest are
//                                  pre-fetched and pushed into docs_solution
//                                  so the regular pipeline merges all candidates
//                                  into ONE solution profile (per Steve's choice)
//   4) customer_url              → customer_url (unchanged)
//
// After /api/cross-sell/prepare returns the normalized payload, the client
// POSTs it to the existing /api/demo-flow endpoint. The regular process then
// takes over with zero modifications to its code path.
//
// All new endpoints live under /cross-sell and /api/cross-sell/* — no collision
// with any existing route. Registered from server.js via a single additive
// require() line, identical pattern to registerMentorMatch.

const path = require('path');

module.exports = function registerCrossSell(app, deps = {}) {
  const { fetchAndStrip } = deps;
  if (typeof fetchAndStrip !== 'function') {
    throw new Error('cross-sell-routes: fetchAndStrip must be passed in from server.js');
  }

  // ─── GET /cross-sell ── serve the partner intake page ──────────────────────
  // (public/cross-sell.html is also served automatically by express.static,
  //  but this gives us a clean URL without the .html extension.)
  app.get('/cross-sell', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cross-sell.html'));
  });

  // ─── Pre-fetch helper ──────────────────────────────────────────────────────
  // Converts a URL into the {filename, text} shape that /api/demo-flow's
  // docs_solution / docs_customer arrays expect. Failures are non-fatal —
  // we return a small stub explaining we couldn't fetch the page so the LLM
  // still knows the URL was claimed (it just won't have rich content for it).
  async function urlToDoc(url, labelPrefix) {
    if (!url) return null;
    const host = String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    try {
      const fetched = await fetchAndStrip(url);
      const blob = [
        `SOURCE URL: ${url}`,
        fetched.title       ? `PAGE TITLE: ${fetched.title}` : '',
        fetched.description ? `META DESCRIPTION: ${fetched.description}` : '',
        '',
        fetched.text || ''
      ].filter(Boolean).join('\n');
      return {
        filename: `${labelPrefix} — ${host}`,
        text: blob,
        url
      };
    } catch (e) {
      console.warn(`[cross-sell] Failed to fetch ${url}: ${e.message}`);
      return {
        filename: `${labelPrefix} — ${host} (fetch failed)`,
        text: `SOURCE URL: ${url}\n\n(Unable to fetch this page automatically: ${e.message}. Treat this URL as a claimed reference; rely on other atoms for substance.)`,
        url,
        fetch_failed: true
      };
    }
  }

  // ─── POST /api/cross-sell/prepare ──────────────────────────────────────────
  // Takes the partner's 4 inputs (+ email + optional fields), pre-fetches the
  // installed solution and the secondary cross-sell URLs, and returns the
  // exact payload the client can post to /api/demo-flow.
  //
  // We do NOT proxy /api/demo-flow ourselves — that would require duplicating
  // the SSE streaming logic. Letting the client POST to /api/demo-flow
  // directly keeps the regular process the single source of truth.
  app.post('/api/cross-sell/prepare', async (req, res) => {
    try {
      const {
        email,
        partner_company_url,
        installed_solution_url,
        cross_sell_urls,
        customer_url,
        industry,
        subindustry,
        partner_notes
      } = req.body || {};

      // ── Validation ──────────────────────────────────────────────────────
      if (!email)                  return res.status(400).json({ error: 'Require email (your partner email)' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email looks invalid.' });
      if (!partner_company_url)    return res.status(400).json({ error: 'Require partner_company_url (the sender)' });
      if (!installed_solution_url) return res.status(400).json({ error: 'Require installed_solution_url' });
      if (!customer_url)           return res.status(400).json({ error: 'Require customer_url' });
      const candidates = (Array.isArray(cross_sell_urls) ? cross_sell_urls : [])
        .map(u => (u || '').trim()).filter(Boolean);
      if (!candidates.length) {
        return res.status(400).json({ error: 'Require at least one cross_sell_url' });
      }

      // ── Single-combined-run shape (per Steve's choice) ───────────────────
      // First candidate is the "primary" — gets full ingestion via solution_url.
      // Remaining candidates get pre-fetched into docs_solution so they merge
      // into the same solution atom set.
      const [primarySolution, ...otherSolutions] = candidates;

      // ── Pre-fetch in parallel ───────────────────────────────────────────
      const work = [
        urlToDoc(installed_solution_url, 'INSTALLED at customer (already owns)'),
        ...otherSolutions.map((u, i) => urlToDoc(u, `CROSS-SELL CANDIDATE #${i + 2}`))
      ];
      const fetched = await Promise.all(work);
      const installedDoc = fetched[0];
      const otherDocs    = fetched.slice(1).filter(Boolean);

      // The installed-solution doc gets a clear preface so the customer ingest
      // LLM knows what it's looking at and tags it appropriately.
      if (installedDoc) {
        installedDoc.text =
          `══════════════════════════════════════════════════\n` +
          `CONTEXT FROM PARTNER: The customer ALREADY OWNS / HAS DEPLOYED the\n` +
          `product described below (supplied by the partner: ${partner_company_url}).\n` +
          `Treat these atoms as evidence of the existing footprint at this customer.\n` +
          `══════════════════════════════════════════════════\n\n` +
          installedDoc.text;
      }

      // Partner notes (free-form, optional) appended as a second customer doc
      // so the LLM has the partner's commentary on the cross-sell motion.
      const docs_customer = installedDoc ? [installedDoc] : [];
      if (partner_notes && String(partner_notes).trim()) {
        docs_customer.push({
          filename: 'PARTNER NOTES',
          text: `PARTNER NOTES (from ${partner_company_url}):\n\n${String(partner_notes).trim()}`
        });
      }

      // ── Build the payload for /api/demo-flow ────────────────────────────
      const payload = {
        email,
        sender_company_url: partner_company_url,
        solution_url:       primarySolution,
        customer_url:       customer_url,
        docs_customer:      docs_customer.length ? docs_customer : undefined,
        docs_solution:      otherDocs.length     ? otherDocs     : undefined
      };
      if (industry)        payload.industry = industry;
      if (subindustry)     payload.subindustry = subindustry;

      // ── Return prepared payload + meta the UI can show ──────────────────
      return res.json({
        ok: true,
        prepared: payload,
        meta: {
          partner_company_url,
          installed_solution_url,
          installed_text_chars: installedDoc?.text?.length || 0,
          installed_fetch_failed: !!installedDoc?.fetch_failed,
          cross_sell_urls: candidates,
          merged_candidates: candidates.length,
          primary_cross_sell_url: primarySolution,
          secondary_cross_sell_urls: otherSolutions,
          secondary_total_chars: otherDocs.reduce((n, d) => n + (d.text?.length || 0), 0),
          secondary_fetch_failures: otherDocs.filter(d => d.fetch_failed).map(d => d.url)
        }
      });
    } catch (err) {
      console.error('[cross-sell/prepare] failed:', err);
      return res.status(500).json({ error: err.message || 'cross-sell prepare failed' });
    }
  });

  console.log('[cross-sell] add-on routes registered: GET /cross-sell, POST /api/cross-sell/prepare');
};
