// server.js — TDE Demo v3
// Three-URL ingest → 6D-tagged atoms → pain points → 5 strategies → (on-select) real LeadHydration
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
const LEADHYDRATION_URL   = (process.env.LEADHYDRATION_URL || '').replace(/\/+$/, '');
const LEADHYDRATION_API_KEY = process.env.LEADHYDRATION_API_KEY || '';

if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY not set.');
if (!LEADHYDRATION_URL)  console.warn('⚠️  LEADHYDRATION_URL not set — hydration step will fail loud.');

// ─── 9D TAXONOMY ─────────────────────────────────────────────────────────────
// Dimensions 1-6 mirror TargetedDecomposition/src/config.js canonical taxonomy.
// Dimensions 7-9 extend it per Steve's 2026-04-21 scope expansion:
//   7. d_economic_driver       — positive-pull forces
//   8. d_status_quo_pressure   — inertia forces (JOLT / Dixon: do-nothing, change fatigue, etc.)
//   9. d_industry              — NAICS top-sector + SIC division per atom
const DIMENSIONS = {
  persona: ['Executive/C-Suite', 'CFO/Finance', 'CISO/Security', 'CTO/IT', 'VP Sales', 'VP Marketing', 'Operations', 'Practitioner', 'End User', 'General'],
  buying_stage: ['Awareness', 'Interest', 'Evaluation', 'Decision', 'Retention', 'Advocacy'],
  emotional_driver: ['Fear/Risk', 'Aspiration/Growth', 'Validation/Proof', 'Curiosity', 'Trust/Credibility', 'Urgency', 'FOMO'],
  evidence_type: ['Statistic/Data', 'Case Study', 'Analyst Report', 'Customer Quote', 'Framework/Model', 'Anecdote/Story', 'Expert Opinion', 'Product Demo', 'Comparison', 'Definition'],
  recency_tier: ['Current Quarter', 'This Year', 'Last 1-2 Years', 'Dated (3-5yr)', 'Evergreen'],
  economic_driver: ['ROI', 'Cost-Out', 'Speed', 'Quality', 'Growth', 'Risk-Reduction', 'None'],
  status_quo_pressure: ['Sunk Cost', 'Change Fatigue', 'Risk Aversion', 'Political Cost', 'Procedural Gravity', 'No Forcing Function', 'Counter-Inertia', 'None'],
  // NAICS top-level sectors (2-digit). SIC divisions are the top-level SIC codes (A-J).
  naics_sectors: ['11 Agriculture, Forestry, Fishing & Hunting', '21 Mining, Oil & Gas', '22 Utilities', '23 Construction', '31-33 Manufacturing', '42 Wholesale Trade', '44-45 Retail Trade', '48-49 Transportation & Warehousing', '51 Information', '52 Finance & Insurance', '53 Real Estate & Rental', '54 Professional, Scientific & Technical Services', '55 Management of Companies', '56 Administrative & Support', '61 Educational Services', '62 Health Care & Social Assistance', '71 Arts, Entertainment & Recreation', '72 Accommodation & Food Services', '81 Other Services', '92 Public Administration'],
  sic_divisions: ['A Agriculture, Forestry & Fishing', 'B Mining', 'C Construction', 'D Manufacturing', 'E Transportation, Communications, Utilities', 'F Wholesale Trade', 'G Retail Trade', 'H Finance, Insurance, Real Estate', 'I Services', 'J Public Administration'],
};

// ─── IN-MEMORY STORE for this session's demo runs ────────────────────────────
const runStore = new Map(); // run_id → { sender, solution, customer, industry, strategies, ... }

// ─── PROMPTS ─────────────────────────────────────────────────────────────────
const INGEST_PROMPT = `You are the ingest phase of TDE (Targeted Decomposition Engine).

INPUT: raw content about an entity (scraped web page, About section, etc.).
INPUT also specifies which ROLE this entity plays: "sender" (the company selling), "solution" (the product being sold), or "customer" (the company being sold to / evaluated as a target).

TASK: decompose into ATOMIC RETRIEVABLE UNITS. Each atom is a single, self-contained fact.

ATOM TYPES:
  "mission", "product", "icp", "proof_point", "team", "stack_signal",
  "buying_trigger", "differentiator", "partnership", "contact", "weakness", "mission_gap"

EVERY ATOM IS TAGGED ACROSS 9 DIMENSIONS (d_* fields):
  1. d_persona:              one of [${DIMENSIONS.persona.join(' | ')}]
  2. d_buying_stage:         one of [${DIMENSIONS.buying_stage.join(' | ')}]
  3. d_emotional_driver:     one of [${DIMENSIONS.emotional_driver.join(' | ')}]
  4. d_evidence_type:        one of [${DIMENSIONS.evidence_type.join(' | ')}]
  5. d_credibility:          integer 1-5 (1 = anecdotal, 5 = tier-1 analyst / peer-reviewed)
  6. d_recency:              one of [${DIMENSIONS.recency_tier.join(' | ')}]
  7. d_economic_driver:      one of [${DIMENSIONS.economic_driver.join(' | ')}]
      — The POSITIVE economic pull this atom speaks to. Use "None" if the atom is purely about inertia / status quo / operational context.
  8. d_status_quo_pressure:  one of [${DIMENSIONS.status_quo_pressure.join(' | ')}]
      — The INERTIA force this atom evidences OR counters. Use "Counter-Inertia" when the atom's job is to defuse inertia (e.g. "90-day parallel run with zero decommissioning" defuses Sunk Cost). Use "None" if the atom doesn't touch inertia at all.
  9. d_industry:             object { "naics": "<NAICS top sector>", "sic": "<SIC division>" }
      — NAICS valid values: [${DIMENSIONS.naics_sectors.join(' | ')}]
      — SIC valid values:   [${DIMENSIONS.sic_divisions.join(' | ')}]
      — Both are required. Pick the single best top-level code for each system.

SCHEMA per atom:
  {
    "atom_id": "<kebab-case unique id>",
    "type": "<one of atom types above>",
    "claim": "<one clear sentence>",
    "evidence": "<paraphrase from source, max 20 words, YOUR words not a direct quote>",
    "tags": ["<3-6 lowercase tags>"],
    "confidence": "high" | "medium" | "low",
    "d_persona": "...",
    "d_buying_stage": "...",
    "d_emotional_driver": "...",
    "d_evidence_type": "...",
    "d_credibility": 1-5,
    "d_recency": "...",
    "d_economic_driver": "...",
    "d_status_quo_pressure": "...",
    "d_industry": { "naics": "...", "sic": "..." }
  }

OUTPUT (JSON only, no markdown fences):
  {
    "target": { "name": "<entity name>", "url": "<url>", "role": "<sender|solution|customer>" },
    "summary": "<2-3 sentence positioning paragraph>",
    "atoms": [ 12-25 atoms ]
  }

DISCIPLINE:
- 12-25 atoms. Each stands alone. Don't invent facts.
- Pick the SINGLE best match for each dimension — no arrays, no hedges.
- "mission_gap" atoms — flag when stated mission is broader than current offering.
- Evidence = paraphrase, NOT a direct quote.
- d_economic_driver and d_status_quo_pressure are INDEPENDENT — an atom can score high on both (e.g. an analyst report that proves market value AND proves incumbent retention).`;

const INDUSTRY_ARCHETYPE_PROMPT = `You are the target-archetype synthesizer of TDE.

INPUT: industry (NAICS sector + subsector), region (one of Anglo, LatAm, Brazil, Northern Europe, Southern Europe, MENA, South Asia, East Asia, Southeast Asia).

TASK: synthesize a REPRESENTATIVE target profile for that industry/region combination — the kind of atoms you'd expect from decomposing a real company in the segment. Make it specific, plausible, and regionally nuanced. Label it clearly as a synthetic archetype.

SAME SCHEMA as INGEST: 12-20 atoms, each tagged with ALL 9 d_* dimensions (see the INGEST instructions for exact field names and valid values). Include d_persona, d_buying_stage, d_emotional_driver, d_evidence_type, d_credibility, d_recency, d_economic_driver, d_status_quo_pressure, and d_industry (with naics + sic sub-fields).

OUTPUT (JSON only):
  {
    "target": { "name": "<e.g. 'Archetype: Discrete Manufacturer — Northern Europe'>", "url": null, "role": "customer", "is_archetype": true, "industry": "<echo>", "subindustry": "<echo>", "region": "<echo>" },
    "summary": "<2-3 sentence positioning paragraph for the typical company>",
    "atoms": [ 12-20 atoms with full 9D tags ]
  }

DISCIPLINE:
- Atoms should reflect what's COMMONLY true for companies in this segment AND region.
- Include weakness / mission_gap / buying_trigger atoms — these drive the sales conversation.
- Model both economic pull (ROI, speed, cost-out, quality, growth, risk-reduction) AND status-quo pressure (sunk cost, change fatigue, risk aversion, political cost, procedural gravity) — they're common in every real deal.
- Be industry- and region-specific. Don't emit generic "they want to grow" atoms.`;

const STRATEGIES_PROMPT = `You are the sales-strategy generator of TDE.

INPUT: customer atoms, sender (seller) atoms, solution atoms, region context. Each set is 9D-tagged.

TASK: produce EXACTLY 5 distinct Discovery-stage sales strategies for how the sender could win this customer with this solution. These are first-touch strategies — the buyer is cold / newly hydrated.

THE CORE RULE — (Persona × Pain) ANCHORING:
- Each strategy MUST be anchored on a distinct (Persona, Pain) PAIR drawn from the customer's atoms.
- No two of the 5 strategies may share the same pair. If two strategies target "CTO × Integration Cost," drop the weaker one and find a different pair.
- The persona comes from this exact list: Executive/C-Suite, CFO/Finance, CISO/Security, CTO/IT, VP Sales, VP Marketing, Operations, Practitioner, End User, General.
- The pain_anchor is a SHORT 2-5 word label (e.g. "Integration Cost", "Change Fatigue", "Compliance Review Backlog") — this is what will render as a chip on the strategy card.
- pain_anchor should correspond to real atoms tagged with weakness / mission_gap / buying_trigger, OR to a d_status_quo_pressure signal.

EACH STRATEGY MUST:
1. Have a crisp title (4-8 words).
2. Have a clear explanation (2-4 sentences) a non-technical exec understands.
3. Explicitly reference atoms from all three sources (customer pain, sender capability, solution capability).
4. Name the first concrete step requiring minimal customer commitment.
5. Include a confidence score (0-100).
6. Emit both target_persona (from the list above) and pain_anchor (short label).
7. Note whether it's optimized for positive economic pull, for neutralizing status-quo inertia, or balanced — via the strategy_force field.

DISCIPLINE:
- Five DIFFERENT (Persona × Pain) angles. Spread the personas — don't put all 5 at the CTO.
- No generic "digital transformation" waffle.
- All strategies are Discovery-stage. Do not write close-the-deal strategies here.

OUTPUT (JSON only):
{
  "customer_label": "<short label for the customer — company name or archetype>",
  "solution_label": "<short label for the solution>",
  "sender_label": "<short label for the sender company>",
  "strategies": [
    {
      "id": "s1",
      "title": "<4-8 words>",
      "target_persona": "<one persona>",
      "pain_anchor": "<2-5 word pain label>",
      "strategy_force": "economic_pull" | "counter_inertia" | "balanced",
      "explanation": "<2-4 sentences>",
      "customer_pain": "<specific pain from customer atoms, 1 sentence>",
      "sender_contribution": "<what the sender brings>",
      "solution_contribution": "<what the solution delivers>",
      "first_step": "<concrete 30-day low-cash proposal>",
      "confidence": 0-100
    }
    // ... 5 total, s1..s5, each with a DIFFERENT (target_persona, pain_anchor) pair
  ],
  "top_pick_id": "<s1..s5>",
  "top_pick_reasoning": "<one sentence>"
}`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, userContent, { maxTokens = 4500, temperature = 0.3 } = {}) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'TDE Demo v3'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL_ID,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

async function fetchAndStrip(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TDEDemo/3.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const description = descMatch ? descMatch[1].trim() : null;
    return { url, title, description, text: cleaned.slice(0, 40000) };
  } catch (e) {
    throw new Error(`Fetch ${url}: ${e.message}`);
  }
}

async function ingestOne({ url, role, hint_name }) {
  const fetched = await fetchAndStrip(url);
  if (!fetched.text || fetched.text.length < 200) {
    throw new Error(`Fetched ${url} had too little text (${fetched.text.length} chars). Try a richer page.`);
  }
  const userContent = JSON.stringify({
    role,
    target_name: hint_name || fetched.title || 'unknown',
    target_url: url,
    content: `PAGE TITLE: ${fetched.title || ''}\nMETA DESCRIPTION: ${fetched.description || ''}\n\n${fetched.text}`
  });
  const parsed = await callLLM(INGEST_PROMPT, userContent, { maxTokens: 6000 });
  if (!parsed?.atoms?.length) throw new Error(`Ingest for ${url} returned no atoms`);
  return {
    target: { ...parsed.target, role, url },
    summary: parsed.summary,
    atoms: parsed.atoms,
    source_url: url,
    ingested_at: new Date().toISOString()
  };
}

async function synthesizeCustomerArchetype({ industry, subindustry, region }) {
  const userContent = JSON.stringify({ industry, subindustry, region });
  const parsed = await callLLM(INDUSTRY_ARCHETYPE_PROMPT, userContent, { maxTokens: 5000 });
  if (!parsed?.atoms?.length) throw new Error('Archetype synthesis returned no atoms');
  return {
    target: { ...parsed.target, role: 'customer', is_archetype: true },
    summary: parsed.summary,
    atoms: parsed.atoms,
    industry,
    subindustry,
    region,
    ingested_at: new Date().toISOString()
  };
}

function extractPainPoints(customerEntry) {
  // Pain atoms are weakness / mission_gap / buying_trigger with medium+ confidence
  const painTypes = new Set(['weakness', 'mission_gap', 'buying_trigger']);
  return (customerEntry.atoms || [])
    .filter(a => painTypes.has(a.type))
    .map(a => ({
      atom_id: a.atom_id,
      type: a.type,
      title: (a.claim || '').split('.')[0].slice(0, 80),
      description: a.claim,
      evidence: a.evidence,
      confidence: a.confidence,
      persona: a.d_persona,
      urgency: a.d_emotional_driver === 'Urgency' || a.d_emotional_driver === 'Fear/Risk' ? 'high' : 'medium'
    }));
}

// ─── ENDPOINTS ───────────────────────────────────────────────────────────────

// Health
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    model: OPENROUTER_MODEL_ID,
    leadhydration_configured: Boolean(LEADHYDRATION_URL),
    runs_in_memory: runStore.size
  });
});

// Main demo flow — streaming SSE
// Phases: fetch (parallel) → ingest (parallel) → pain (immediate) → strategies (1 LLM call)
app.post('/api/demo-flow', async (req, res) => {
  const {
    email,
    sender_company_url,
    solution_url,
    customer_url,
    industry, subindustry, region,
    recipient_role
  } = req.body || {};

  // Validation
  if (!email) return res.status(400).json({ error: 'Require email (your email)' });
  if (!sender_company_url) return res.status(400).json({ error: 'Require sender_company_url' });
  if (!solution_url) return res.status(400).json({ error: 'Require solution_url' });
  if (!customer_url && !(industry && subindustry && region)) {
    return res.status(400).json({ error: 'Require customer_url OR (industry + subindustry + region)' });
  }
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured — missing OPENROUTER_API_KEY' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const run_id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // ── PHASE 1 + 2: Fetch + Ingest all sources in parallel ──────────────
    send('phase', { phase: 'fetch', message: 'Fetching sender, solution, customer in parallel…' });

    const senderPromise   = ingestOne({ url: normUrl(sender_company_url), role: 'sender' });
    const solutionPromise = ingestOne({ url: normUrl(solution_url),       role: 'solution' });
    const customerPromise = customer_url
      ? ingestOne({ url: normUrl(customer_url), role: 'customer' })
      : synthesizeCustomerArchetype({ industry, subindustry, region });

    // Settle individually so one failure doesn't kill the rest
    const [senderRes, solutionRes, customerRes] = await Promise.allSettled([
      senderPromise, solutionPromise, customerPromise
    ]);

    if (senderRes.status === 'rejected')   throw new Error(`Sender: ${senderRes.reason.message}`);
    if (solutionRes.status === 'rejected') throw new Error(`Solution: ${solutionRes.reason.message}`);
    if (customerRes.status === 'rejected') throw new Error(`Customer: ${customerRes.reason.message}`);

    const sender   = senderRes.value;
    const solution = solutionRes.value;
    const customer = customerRes.value;

    send('phase', { phase: 'ingest', message: 'All three decomposed into 6D-tagged atoms.' });
    send('atoms', {
      sender:   { target: sender.target,   summary: sender.summary,   atoms: sender.atoms },
      solution: { target: solution.target, summary: solution.summary, atoms: solution.atoms },
      customer: { target: customer.target, summary: customer.summary, atoms: customer.atoms }
    });

    // ── PHASE 3: Pain points (from customer atoms — instant, no LLM) ─────
    const pain_points = extractPainPoints(customer);
    send('pain', { pain_points });

    // ── PHASE 4: 5 strategies ────────────────────────────────────────────
    send('phase', { phase: 'strategies', message: 'Generating 5 sales strategies…' });
    const stratInput = JSON.stringify({
      sender:   { name: sender.target?.name,   summary: sender.summary,   atoms: sender.atoms },
      solution: { name: solution.target?.name, summary: solution.summary, atoms: solution.atoms },
      customer: { name: customer.target?.name, summary: customer.summary, atoms: customer.atoms, is_archetype: !!customer.target?.is_archetype },
      region: region || null,
      recipient_role: recipient_role || 'Senior executive'
    });
    const strategies = await callLLM(STRATEGIES_PROMPT, stratInput, { maxTokens: 4000 });
    send('strategies', strategies);

    // ── Persist the run so /api/hydrate can retrieve it by run_id ────────
    runStore.set(run_id, {
      email, sender, solution, customer,
      pain_points, strategies,
      industry, subindustry, region,
      recipient_role,
      created_at: new Date().toISOString()
    });
    // Clean up runs older than 1 hour
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of runStore.entries()) {
      if (new Date(v.created_at).getTime() < cutoff) runStore.delete(k);
    }

    send('done', { run_id });
    res.end();
  } catch (err) {
    console.error('[demo-flow]', err.message);
    send('error', { message: err.message });
    res.end();
  }
});

// Hydration endpoint — called AFTER user picks a strategy
// Proxies to the real LeadHydration service: solution → company-pain
app.post('/api/hydrate', async (req, res) => {
  const { run_id, strategy_id, custom_strategy } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'Require run_id' });
  const run = runStore.get(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  if (!LEADHYDRATION_URL) {
    return res.status(503).json({
      error: 'LeadHydration not connected',
      detail: 'Set LEADHYDRATION_URL env var to enable this step. Demo cannot proceed without the real service.'
    });
  }

  // Resolve which strategy was selected
  let chosenStrategy = null;
  if (custom_strategy) {
    chosenStrategy = { id: 'custom', title: custom_strategy.title, explanation: custom_strategy.explanation, is_custom: true };
  } else if (strategy_id) {
    chosenStrategy = (run.strategies?.strategies || []).find(s => s.id === strategy_id);
  }
  if (!chosenStrategy) return res.status(400).json({ error: 'Require strategy_id or custom_strategy' });

  try {
    // STEP 1: Call LeadHydration /api/agent/solution with the solution URL.
    //         Returns { name, type, capabilities[], targetMarket }.
    const solutionRes = await fetch(`${LEADHYDRATION_URL}/api/agent/solution`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LEADHYDRATION_API_KEY ? { 'Authorization': `Bearer ${LEADHYDRATION_API_KEY}` } : {})
      },
      body: JSON.stringify({ url: run.solution.source_url })
    });
    if (!solutionRes.ok) {
      const txt = await solutionRes.text();
      throw new Error(`LeadHydration /solution failed (${solutionRes.status}): ${txt.slice(0, 300)}`);
    }
    const solutionIntel = await solutionRes.json();

    // STEP 2: Call LeadHydration /api/agent/company-pain for the rich discovery intel.
    //         Takes { companyName, website, industry, solution, tier } and returns
    //         { whoIsThis, painIndicators[], primaryLead, score, questions[] }.
    const customerName = run.customer?.target?.name || 'Target Customer';
    const customerWebsite = run.customer?.source_url || run.customer?.target?.url || '';
    const industryName = run.customer?.industry || run.industry || solutionIntel.targetMarket || 'Unknown';
    const tier = run.customer?.target?.is_archetype ? 2 : 3; // archetype = LLM-only, real URL = deep

    const painRes = await fetch(`${LEADHYDRATION_URL}/api/agent/company-pain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LEADHYDRATION_API_KEY ? { 'Authorization': `Bearer ${LEADHYDRATION_API_KEY}` } : {})
      },
      body: JSON.stringify({
        companyName: customerName,
        website: customerWebsite,
        industry: industryName,
        solution: {
          name: solutionIntel.name,
          type: solutionIntel.type,
          capabilities: solutionIntel.capabilities,
          targetMarket: solutionIntel.targetMarket
        },
        tier,
        lang: 'en'
      })
    });
    if (!painRes.ok) {
      const txt = await painRes.text();
      throw new Error(`LeadHydration /company-pain failed (${painRes.status}): ${txt.slice(0, 300)}`);
    }
    const hydration = await painRes.json();

    return res.json({
      run_id,
      chosen_strategy: chosenStrategy,
      solution_intel: solutionIntel,
      hydration
    });
  } catch (err) {
    console.error('[hydrate]', err.message);
    return res.status(502).json({ error: `Hydration failed: ${err.message}` });
  }
});

function normUrl(u) {
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, '');
}

// ─── STATIC METADATA ENDPOINTS (for UI dropdowns) ────────────────────────────
app.get('/api/meta/naics', (_req, res) => res.json(NAICS_TAXONOMY));
app.get('/api/meta/regions', (_req, res) => res.json(REGIONS));
app.get('/api/meta/dimensions', (_req, res) => res.json(DIMENSIONS));

// ─── NAICS TAXONOMY (subset — 2-digit sector → 3-digit subsectors) ───────────
const NAICS_TAXONOMY = [
  { code: '11', name: 'Agriculture, Forestry, Fishing & Hunting', sub: [
    { code: '111', name: 'Crop Production' }, { code: '112', name: 'Animal Production & Aquaculture' },
    { code: '113', name: 'Forestry & Logging' }, { code: '114', name: 'Fishing, Hunting & Trapping' }
  ]},
  { code: '21', name: 'Mining, Quarrying, Oil & Gas', sub: [
    { code: '211', name: 'Oil & Gas Extraction' }, { code: '212', name: 'Mining (except Oil & Gas)' }, { code: '213', name: 'Support for Mining' }
  ]},
  { code: '22', name: 'Utilities', sub: [
    { code: '221', name: 'Utilities (Electric, Gas, Water)' }
  ]},
  { code: '23', name: 'Construction', sub: [
    { code: '236', name: 'Construction of Buildings' }, { code: '237', name: 'Heavy & Civil Engineering' }, { code: '238', name: 'Specialty Trade Contractors' }
  ]},
  { code: '31-33', name: 'Manufacturing', sub: [
    { code: '311', name: 'Food Manufacturing' }, { code: '312', name: 'Beverage & Tobacco' },
    { code: '313', name: 'Textile Mills' },       { code: '315', name: 'Apparel' },
    { code: '321', name: 'Wood Products' },       { code: '322', name: 'Paper' },
    { code: '324', name: 'Petroleum & Coal' },    { code: '325', name: 'Chemical' },
    { code: '326', name: 'Plastics & Rubber' },   { code: '327', name: 'Nonmetallic Minerals' },
    { code: '331', name: 'Primary Metal' },       { code: '332', name: 'Fabricated Metal' },
    { code: '333', name: 'Machinery' },           { code: '334', name: 'Computer & Electronic Products' },
    { code: '335', name: 'Electrical Equipment' },{ code: '336', name: 'Transportation Equipment' },
    { code: '337', name: 'Furniture' },           { code: '339', name: 'Miscellaneous Manufacturing' }
  ]},
  { code: '42', name: 'Wholesale Trade', sub: [
    { code: '423', name: 'Durable Goods' }, { code: '424', name: 'Nondurable Goods' }, { code: '425', name: 'Wholesale Electronic Markets' }
  ]},
  { code: '44-45', name: 'Retail Trade', sub: [
    { code: '441', name: 'Motor Vehicle & Parts Dealers' }, { code: '443', name: 'Electronics & Appliance Stores' },
    { code: '444', name: 'Building Material & Garden Equipment' }, { code: '445', name: 'Food & Beverage Stores' },
    { code: '448', name: 'Clothing & Accessories' }, { code: '452', name: 'General Merchandise' },
    { code: '454', name: 'Nonstore Retailers (incl. e-commerce)' }
  ]},
  { code: '48-49', name: 'Transportation & Warehousing', sub: [
    { code: '481', name: 'Air Transportation' }, { code: '483', name: 'Water Transportation' },
    { code: '484', name: 'Truck Transportation' }, { code: '485', name: 'Transit & Ground Passenger' },
    { code: '492', name: 'Couriers & Messengers' }, { code: '493', name: 'Warehousing & Storage' }
  ]},
  { code: '51', name: 'Information', sub: [
    { code: '511', name: 'Publishing (incl. Software)' }, { code: '512', name: 'Motion Picture & Sound' },
    { code: '515', name: 'Broadcasting' }, { code: '517', name: 'Telecommunications' },
    { code: '518', name: 'Data Processing, Hosting (Cloud)' }, { code: '519', name: 'Other Information Services' }
  ]},
  { code: '52', name: 'Finance & Insurance', sub: [
    { code: '521', name: 'Monetary Authorities' }, { code: '522', name: 'Credit Intermediation (Banks)' },
    { code: '523', name: 'Securities & Investments' }, { code: '524', name: 'Insurance Carriers' },
    { code: '525', name: 'Funds, Trusts, & Other Financial Vehicles' }
  ]},
  { code: '53', name: 'Real Estate & Rental', sub: [
    { code: '531', name: 'Real Estate' }, { code: '532', name: 'Rental & Leasing' }
  ]},
  { code: '54', name: 'Professional, Scientific & Technical Services', sub: [
    { code: '541', name: 'Legal, Accounting, Consulting, Engineering, Design, Research, Advertising' }
  ]},
  { code: '55', name: 'Management of Companies & Enterprises', sub: [
    { code: '551', name: 'Holding Companies & Corporate Offices' }
  ]},
  { code: '56', name: 'Administrative & Support; Waste Management', sub: [
    { code: '561', name: 'Administrative & Support Services' }, { code: '562', name: 'Waste Management & Remediation' }
  ]},
  { code: '61', name: 'Educational Services', sub: [
    { code: '611', name: 'Educational Services (Schools, Universities, Training)' }
  ]},
  { code: '62', name: 'Health Care & Social Assistance', sub: [
    { code: '621', name: 'Ambulatory Health Care' }, { code: '622', name: 'Hospitals' },
    { code: '623', name: 'Nursing & Residential Care' }, { code: '624', name: 'Social Assistance' }
  ]},
  { code: '71', name: 'Arts, Entertainment & Recreation', sub: [
    { code: '711', name: 'Performing Arts & Spectator Sports' }, { code: '712', name: 'Museums & Historical Sites' },
    { code: '713', name: 'Amusement, Gambling & Recreation' }
  ]},
  { code: '72', name: 'Accommodation & Food Services', sub: [
    { code: '721', name: 'Accommodation' }, { code: '722', name: 'Food Services & Drinking Places' }
  ]},
  { code: '81', name: 'Other Services (except Public Administration)', sub: [
    { code: '811', name: 'Repair & Maintenance' }, { code: '812', name: 'Personal & Laundry Services' },
    { code: '813', name: 'Religious, Civic, Professional Orgs' }
  ]},
  { code: '92', name: 'Public Administration', sub: [
    { code: '921', name: 'Executive, Legislative & General Government' }, { code: '922', name: 'Justice, Public Order, Safety' }
  ]}
];

// ─── REGIONS (Steve's 9-region taxonomy) ─────────────────────────────────────
const REGIONS = [
  { id: 'anglo', name: 'Anglo',             countries: ['Australia', 'Canada', 'New Zealand', 'UK', 'US'] },
  { id: 'latam', name: 'LatAm',             countries: ['Mexico', 'Central America', 'South America (excluding Brazil)'] },
  { id: 'brazil', name: 'Brazil',           countries: ['Brazil'] },
  { id: 'northern_europe', name: 'Northern Europe', countries: ['Austria', 'Belgium', 'Denmark', 'Finland', 'France', 'Germany', 'Netherlands', 'Norway', 'Sweden', 'Switzerland'] },
  { id: 'southern_europe', name: 'Southern Europe', countries: ['Greece', 'Italy', 'Portugal', 'Spain'] },
  { id: 'mena',  name: 'Middle East & North Africa', countries: ['Egypt', 'Qatar', 'Saudi Arabia', 'UAE', 'Morocco', 'Jordan', 'Kuwait'] },
  { id: 'south_asia', name: 'South Asia',   countries: ['Bangladesh', 'India', 'Pakistan', 'Sri Lanka', 'Nepal'] },
  { id: 'east_asia',  name: 'East Asia',    countries: ['China', 'Japan', 'Korea', 'Taiwan'] },
  { id: 'southeast_asia', name: 'Southeast Asia', countries: ['Indonesia', 'Malaysia', 'Philippines', 'Thailand', 'Vietnam', 'Singapore'] }
];

// ─── BOOT ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ TDE Demo v3 listening on port ${PORT}`);
  console.log(`   model: ${OPENROUTER_MODEL_ID}`);
  console.log(`   leadhydration: ${LEADHYDRATION_URL || '(not configured)'}`);
});
