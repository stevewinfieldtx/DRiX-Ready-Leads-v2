# Company Intel Integration Guide
## How to wire company-intel.js into the demo flow

The `company-intel.js` module is already written and saved. The require line
has already been added to server.js line 16:

```js
const { enrichCompany, extractDomain } = require('./company-intel');
```

---

## WHERE TO WIRE IT IN server.js

Find the section where the customer URL is ingested and atoms are returned.
It will look something like one of these patterns:

```js
// Pattern A — explicit customer ingest
const customerResult = await ingestUrl(customerUrl, 'customer');

// Pattern B — inside the demo flow SSE handler
const [senderResult, solutionResult, customerResult] = await Promise.all([...]);

// Pattern C — sequential ingest inside /api/demo-flow
send('phase', { phase: 'ingest_customer', ... });
const customerResult = await ingestOneUrl(customer_url, 'customer');
```

---

## THE CALL TO ADD

Right after the customer ingest returns atoms, before pain/strategy
generation, add this block:

```js
// ── COMPANY INTEL ENRICHMENT ──────────────────────────────────────────────
// Runs after customer URL ingest, before pain/strategy generation.
// Adds: email security posture, FDIC/SEC financial data, tech stack,
// org signals (job postings / hires), buying committee, deal signals.
// intelResult.intelAtoms are 9D-tagged and merged into customer atoms.

const customerDomain = extractDomain(customer_url);
const intelResult = await enrichCompany(
  customerDomain,
  customerResult?.target?.name || customerDomain,
  {
    solutionCategory: solution_category || solutionResult?.target?.name || 'software',
    industry:         customerResult?.target?.industry || industry || null,
    apolloKey:        APOLLO_API_KEY,
    braveKey:         BRAVE_API_KEY,
    openRouterKey:    OPENROUTER_API_KEY,
    modelId:          OPENROUTER_MODEL_ID,
  }
).catch(err => {
  console.warn('[company-intel] Enrichment failed (non-fatal):', err.message);
  return null;
});

// Merge intel atoms into customer atoms (they are already 9D-tagged)
if (intelResult?.intelAtoms?.length > 0) {
  customerResult.atoms = [...(customerResult.atoms || []), ...intelResult.intelAtoms];
  console.log(`[demo-flow] +${intelResult.intelAtoms.length} intel atoms merged (total: ${customerResult.atoms.length})`);
}

// Attach full intel package to run store for UI access
if (runId) {
  runStore.set(runId, { ...(runStore.get(runId) || {}), companyIntel: intelResult });
}

// Stream intel summary to client if using SSE
if (send && intelResult) {
  send('company_intel', {
    emailSecurity:    intelResult.emailSecurity,
    financial:        intelResult.financial,
    buyingCommittee:  intelResult.buyingCommittee,
    dealSignals:      intelResult.dealSignals,
    complianceHooks:  intelResult.complianceHooks,
    accountSummary:   intelResult.accountSummary,
    criticalFindings: intelResult.criticalFindings,
    isGreenfield:     intelResult.isGreenfield,
    isBankRegulated:  intelResult.isBankRegulated,
  });
}
// ── END COMPANY INTEL ENRICHMENT ──────────────────────────────────────────
```

---

## ALSO ADD: Standalone REST Endpoint (optional but useful for testing)

Find the block of other `app.post` routes and add:

```js
// POST /api/company-intel
// Body: { url, company_name, solution_category, industry }
app.post('/api/company-intel', async (req, res) => {
  const { url, company_name, solution_category, industry } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  const domain = extractDomain(url);
  const name = company_name || domain;

  try {
    const intel = await enrichCompany(domain, name, {
      solutionCategory: solution_category || null,
      industry:         industry || null,
      apolloKey:        APOLLO_API_KEY,
      braveKey:         BRAVE_API_KEY,
      openRouterKey:    OPENROUTER_API_KEY,
      modelId:          OPENROUTER_MODEL_ID,
    });
    res.json(intel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

---

## WHAT THE CLIENT RECEIVES

After wiring, the SSE stream includes a new `company_intel` phase event
alongside the existing ingest/pain/strategies/email phases.

```
company_intel event payload:
  emailSecurity.provider        → "Microsoft 365 / EOP"
  emailSecurity.dmarcPolicy     → "none"        ← CRITICAL
  emailSecurity.isGreenfield    → true           ← no vendor to displace
  emailSecurity.findings[]      → CRITICAL/HIGH findings list

  financial.source              → "fdic" | "sec" | null
  financial.totalAssets         → raw number in dollars
  financial.efficiencyRatio     → 81.29 (banks only)
  financial.regulatoryFlags[]   → cost pressure flags

  buyingCommittee.roles[]       → 5 role objects with hot buttons
  buyingCommittee.identified[]  → Apollo-resolved names (if found)

  dealSignals[]                 → ranked CRITICAL/HIGH/MEDIUM signals
  complianceHooks[]             → regulatory non-discretionary pitch angles
  accountSummary                → 2-3 sentence rep brief
  criticalFindings[]            → pre-merged top flags for pre-call prep
```

---

## ENVIRONMENT VARIABLES

No new env vars required. company-intel.js reuses existing keys:

| Key                  | Required? | Used for                         |
|----------------------|-----------|----------------------------------|
| OPENROUTER_API_KEY   | YES       | Buying committee + synthesis LLM |
| OPENROUTER_MODEL_ID  | optional  | Defaults to claude-sonnet-4.5    |
| APOLLO_API_KEY       | optional  | Name resolution for committee    |
| BRAVE_API_KEY        | optional  | Job postings + org signals       |

DNS/MX/FDIC/SEC are all free public APIs — no key required.

---

## TESTING

Always run before Railway push:
```bash
node --check server.js
```

Test the standalone endpoint locally:
```bash
curl -X POST http://localhost:3001/api/company-intel \
  -H "Content-Type: application/json" \
  -d '{
    "url": "ndbt.com",
    "company_name": "North Dallas Bank and Trust",
    "solution_category": "email security",
    "industry": "community banking"
  }'
```

Expected in response:
- emailSecurity.dmarcPolicy: "none"
- emailSecurity.isGreenfield: true
- emailSecurity.provider: "Microsoft 365 / EOP"
- financial.source: "fdic"
- financial.efficiencyRatio: ~81
- buyingCommittee.roles: (5 objects)
- dealSignals: (6-10 ranked signals)

---

## ARCHITECTURE NOTE

company-intel.js runs 6 layers, with layers 1-4 in parallel:

```
enrichCompany(domain, name, opts)
  │
  ├── [parallel] Layer 1: getEmailSecurityPosture()  — DNS/MX/DMARC/SPF
  ├── [parallel] Layer 2: getFDICData() + getSECData() — financial
  ├── [parallel] Layer 3: getTechStackSignals()       — HTTP headers + DNS
  ├── [parallel] Layer 4: getOrgSignals()             — Brave job/news search
  │
  ├── [sequential] Layer 5: getBuyingCommittee()      — LLM roles + Apollo names
  └── [sequential] Layer 6: synthesizeDealSignals()   — LLM synthesis → atoms

Total expected runtime: 8-20 seconds depending on API key availability
All layers are defensive — failure in any layer does not stop the others
```

The output intelAtoms are 9D-tagged and drop directly into the existing
customer atom store. No schema changes required in db.js.
