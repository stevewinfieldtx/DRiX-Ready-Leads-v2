// server.js — TDE Demo v3
// Three-URL ingest → 6D-tagged atoms → pain points → 5 strategies → (on-select) real LeadHydration
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
// Lazy-loaded on first docx download so a missing package can't crash the server
let docx;
function getDocx() {
  if (!docx) docx = require('docx');
  return docx;
}

const db = require('./db');

const app = express();
// Default to 3001 so we don't collide with LeadHydration (which defaults to 3000).
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
const LEADHYDRATION_URL   = (process.env.LEADHYDRATION_URL || '').replace(/\/+$/, '');
const LEADHYDRATION_API_KEY = process.env.LEADHYDRATION_API_KEY || '';
const RESEND_API_KEY      = process.env.RESEND_API_KEY || '';
const REPORT_FROM_EMAIL   = process.env.REPORT_FROM_EMAIL || 'info@NYNImpact.com';
const TDE_BASE_URL        = (process.env.TDE_BASE_URL || 'https://targeteddecomposition-production.up.railway.app').replace(/\/+$/, '');
const TDE_API_KEY         = process.env.TDE_API_KEY || '';
// Minimum atoms in a TDE collection to treat it as a real cache hit. Below this
// we'd rather do a fresh demo-lightweight ingest than reconstruct from thin air.
const TDE_MIN_ATOMS       = parseInt(process.env.TDE_MIN_ATOMS || '15', 10);

if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY not set.');
if (!LEADHYDRATION_URL)  console.warn('⚠️  LEADHYDRATION_URL not set — hydration step will fail loud.');
if (!RESEND_API_KEY)     console.warn('⚠️  RESEND_API_KEY not set — email report step will fail loud.');
if (!TDE_API_KEY)        console.warn('⚠️  TDE_API_KEY not set — TDE cache lookups will be skipped (fresh ingest every time).');

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

// ─── LOCAL INGEST CACHE ─────────────────────────────────────────────────────
// Keyed by normalized URL → full ingest result (atoms, summary, target).
// This is the REAL cache — skips ALL LLM calls on repeat URLs within this
// server process lifetime. TDE cache is the cross-session persistence layer;
// this is the instant in-session layer that actually makes repeats feel fast.
const ingestCache = new Map(); // normalized_url → { target, summary, atoms, ... }
const painCache = new Map();   // hash(atoms+industry+subindustry) → pain_groups
const strategyCache = new Map(); // hash(atoms+role) → strategies
const INGEST_CACHE_MAX = 100; // max entries before we start evicting oldest

function cacheKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 24);
}
function setWithEvict(map, key, val, max = INGEST_CACHE_MAX) {
  map.set(key, val);
  if (map.size > max) { map.delete(map.keys().next().value); }
}

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
    "atoms": [ 50-150 atoms ]
  }

DISCIPLINE:
- 50-150 atoms. Each stands alone. Don't invent facts. MORE IS BETTER — extract every distinct fact.
- Pick the SINGLE best match for each dimension — no arrays, no hedges.
- "mission_gap" atoms — flag when stated mission is broader than current offering.
- Evidence = paraphrase, NOT a direct quote.
- d_economic_driver and d_status_quo_pressure are INDEPENDENT — an atom can score high on both (e.g. an analyst report that proves market value AND proves incumbent retention).`;

const INDUSTRY_ARCHETYPE_PROMPT = `You are the target-archetype synthesizer of TDE.

INPUT: industry (required), optional subindustry, optional region.

TASK: synthesize a REPRESENTATIVE target profile for that industry (and, if provided, narrowed by subindustry + region) — the kind of atoms that characterize companies in this segment as a CLASS. Label it clearly as a synthetic archetype.

SAME SCHEMA as INGEST: 50-150 atoms, each tagged with ALL 9 d_* dimensions. Include d_persona, d_buying_stage, d_emotional_driver, d_evidence_type, d_credibility, d_recency, d_economic_driver, d_status_quo_pressure, and d_industry.

OUTPUT (JSON only):
  {
    "target": { "name": "<e.g. 'Archetype: Discrete Manufacturer (Northern Europe)' — omit region qualifier if none provided>", "url": null, "role": "customer", "is_archetype": true, "industry": "<echo>", "subindustry": "<echo or null>", "region": "<echo or null>" },
    "summary": "<2-3 sentence positioning paragraph for the typical company in this class>",
    "atoms": [ 50-150 atoms with full 9D tags ]
  }

CRITICAL ANTI-FABRICATION RULES (violate these and the output is a lie):
- This is an ARCHETYPE, not a real company. No real company exists to have a history. THEREFORE:
- NEVER reference specific past events. No "failed ERP rollout in 2023", no "last year's 40-hour line outage", no "the Oracle migration that went over budget by $2.3M", no "their acquisition of X in 2021."
- NEVER invent specific dollar figures, specific percentages, specific dates, specific project names, specific executive names, specific vendor histories, or specific incidents.
- Atoms MUST be phrased as segment-typical patterns: "companies in this segment commonly operate on aging ERPs", "margin pressure is acute at sub-5% EBIT", "regulatory reporting cycles force quarterly data reconciliation." These are TRUE of the class, without pretending a specific incident happened.
- Credibility scores reflect how typical the pattern is across the segment, NOT fabricated source authority. d_evidence_type "Statistic/Data" is fine if the statistic describes the segment (e.g. "industry-wide, 60% of firms cite X"), not a made-up fact about a phantom company.
- Pain atoms describe forces that exist in the segment. Weakness/mission_gap atoms describe patterns, not incidents.

DISCIPLINE:
- Atoms reflect what's COMMONLY true for companies in this class.
- Include weakness / mission_gap / buying_trigger atoms — these drive the sales conversation.
- Model both economic pull (ROI, speed, cost-out, quality, growth, risk-reduction) AND status-quo pressure (sunk cost, change fatigue, risk aversion, political cost, procedural gravity).
- Be industry- and region-specific in patterns, not in invented specifics.`;

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

CRITICAL ANTI-FABRICATION RULES (this is where sales tools lose trust):
- If the customer is an ARCHETYPE (input.customer.is_archetype === true), NO SPECIFIC PAST EVENTS EXIST. You have no real company to reference. Therefore you must NEVER reference a specific historical incident, a specific dollar figure, a specific project name, a specific dated outage, a specific failed implementation, or a specific past vendor. Pain is framed at the segment level: "firms in this segment commonly face X" rather than "you experienced X in 2023." A made-up specific is worse than a real generic — it poisons the whole output.
- If the customer is a REAL URL (is_archetype is falsy), specifics are allowed ONLY when the exact fact is present in the customer atoms provided. You do not have access to the company's internal history, financials, or unlisted incidents. If it's not in the atoms, you do not know it. Do not invent.
- Forbidden patterns UNLESS the exact thing is in the provided atoms: "your 2023 [X]", "last quarter's [Y]", "the $[N]M you lost on [Z]", "after your failed [vendor] migration", "the [N] hours of downtime you had". All of these are lies by default. Only use them when the atoms literally contain the fact.
- When you want to reference pain but don't have a specific grounded fact, use segment-level phrasing: "manufacturers at your scale typically see...", "regional banks in this region commonly...", "the pain point most acute for companies matching your profile is...". Honest genericity beats dishonest specificity every time.
- customer_pain, explanation, and first_step are the three fields where fabrication is most tempting. Police yourself hardest there.

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

const PAIN_PROMPT = `Pain-surfacing phase of TDE. Be concise — short sentences only.

INPUT: customer atoms, optional industry/sub-industry/region, is_archetype flag.

Produce 2-4 pain points at each of three levels:
  1) company_pain — specific to THIS customer (empty array if is_archetype=true)
  2) subindustry_pain — patterns typical of the sub-industry/segment
  3) industry_pain — broader forces affecting the whole industry

Persona titles must be one of: Executive/C-Suite | CFO/Finance | CISO/Security | CTO/IT | VP Sales | VP Marketing | Operations | Practitioner | End User | General
Urgency: "high" | "medium" | "low"
Economic levers: ROI | Cost-Out | Speed | Quality | Growth | Risk-Reduction
Inertia forces: Sunk Cost | Change Fatigue | Risk Aversion | Political Cost | Procedural Gravity | No Forcing Function | Market Dynamics

Each pain point:
{
  "id": "<kebab-id>",
  "level": "company|subindustry|industry",
  "title": "<3-6 word label>",
  "description": "<1 sentence>",
  "evidence": "<1 sentence — cite atom if company-level, else segment observation>",
  "persona_primary": {
    "title": "<role>",
    "rationale": "<1 sentence — why they own this>",
    "perspective": "<1 sentence — their inner voice>",
    "urgency": "<level>", "economic_lever": "<lever>", "inertia_force": "<force>"
  },
  "persona_secondary": {
    "title": "<different role>",
    "rationale": "<1 sentence — why they're affected>",
    "perspective": "<1 sentence — their inner voice>",
    "urgency": "<level>", "economic_lever": "<lever>", "inertia_force": "<force>"
  }
}

Every pain MUST have two distinct personas with different roles. Each persona gets their own urgency/lever/inertia.
Company-level: only cite facts from provided atoms — do NOT invent. Sub-industry/industry: use segment-typical patterns, no invented incidents.
If is_archetype=true, company_pain must be [].

JSON only, no markdown: { "company_pain": [...], "subindustry_pain": [...], "industry_pain": [...] }`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, userContent, { maxTokens = 4500, temperature = 0.3, retries = 1 } = {}) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (!content) {
      console.warn(`[callLLM] Empty response (attempt ${attempt + 1}/${retries + 1}, finish_reason=${finishReason}, model=${data?.model || '?'})`);
      if (attempt < retries) { await new Promise(r => setTimeout(r, 1500)); continue; }
      throw new Error(`Empty LLM response after ${retries + 1} attempts (finish_reason: ${finishReason || 'unknown'} — model may have filtered this content)`);
    }
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  }
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

// ─── TDE SERVICE INTEGRATION ─────────────────────────────────────────────────
// TDE-Demo uses the real TDE service as a knowledge cache: every URL we ingest
// is mapped to a TDE collection ID. When the user runs the demo:
//   1. We check TDE for that collection.
//   2. If it has enough atoms already (TDE_MIN_ATOMS), we reconstruct a rich
//      digest from TDE and feed that to our 9D-atom LLM pass. This is cheaper
//      and more accurate than scraping one page.
//   3. On a miss, we fall back to the lightweight scrape+LLM and fire off
//      POST /research/{id} in the background so the collection warms up for
//      next time (fire-and-forget, the user's demo doesn't wait on it).
function tdeAvailable() { return !!TDE_API_KEY && !!TDE_BASE_URL; }

async function tdeRequest(method, path, body) {
  const res = await fetch(`${TDE_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': TDE_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === 'GET' ? 15000 : 90000) // swarm writes can be slow
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`TDE ${method} ${path} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function urlToCollectionId(url) {
  return (url || '')
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_').replace(/_$/, '')
    .substring(0, 60);
}

// Fire-and-forget: push the URL into TDE so the atoms exist on the NEXT run.
// We use POST /ingest (lightweight: fetch + decompose into TDE's atom schema),
// NOT POST /research (which kicks off the full multi-agent swarm — too slow /
// expensive for demo warming). Ingest is async on TDE's side too; it returns
// {ok:true, status:'ingestion_started'} immediately.
function warmTdeCacheAsync(collectionId, url, role, hint_name) {
  if (!tdeAvailable()) return;

  // Ensure the collection exists before /ingest. Create is idempotent — TDE
  // returns an error if it already exists, which we swallow.
  (async () => {
    try {
      await tdeRequest('POST', `/collections`, {
        id: collectionId,
        name: hint_name || collectionId,
        description: `Auto-created by TDE-Demo (role: ${role})`,
        templateId: 'business'
      });
    } catch (e) { /* already exists or no perms — fine */ }

    try {
      await tdeRequest('POST', `/ingest`, {
        collectionId,
        type: 'web',
        input: url,
        opts: { title: hint_name || '' }
      });
      console.log(`[TDE] Warmup ingest queued for ${collectionId} (${role})`);
    } catch (e) {
      console.log(`[TDE] Warmup skipped for ${collectionId}: ${e.message}`);
    }
  })();
}

// Try to build our 9D atoms from a TDE collection. Returns null on cache miss
// (or if TDE is unreachable/collection thin); caller falls back to fresh scrape.
async function ingestFromTdeCache({ url, role, hint_name }) {
  if (!tdeAvailable()) return null;
  const collectionId = urlToCollectionId(url);
  let col = null;
  try {
    col = await tdeRequest('GET', `/collections/${collectionId}`);
  } catch (e) {
    // 404 or otherwise — not in cache.
    return null;
  }
  const atomCount = col?.stats?.atomCount || 0;
  if (atomCount < TDE_MIN_ATOMS) {
    console.log(`[TDE] MISS ${collectionId}: only ${atomCount} atoms (< ${TDE_MIN_ATOMS}).`);
    return null;
  }

  // Pull a rich digest from TDE — that's our LLM input instead of a raw scrape.
  let digest = '';
  try {
    const reconstruct = await tdeRequest('POST', `/reconstruct/${collectionId}`, {
      intent: 'enrichment',
      query: `Complete profile of ${hint_name || url}: mission, products, ICP, differentiators, proof points, team, stack signals, buying triggers, partnerships, weaknesses, gaps. Aggregate everything useful for decomposing into retrievable atoms.`,
      format: 'text',
      max_atoms: 30,
      max_words: 1500
    });
    digest = typeof reconstruct.output === 'string'
      ? reconstruct.output
      : JSON.stringify(reconstruct.output || {});
  } catch (e) {
    console.log(`[TDE] Reconstruct failed for ${collectionId}: ${e.message} — falling back to fresh.`);
    return null;
  }
  if (!digest || digest.length < 200) {
    console.log(`[TDE] Reconstruct returned too little for ${collectionId} (${digest.length} chars) — falling back.`);
    return null;
  }

  console.log(`[TDE] HIT ${collectionId}: ${atomCount} atoms, reconstructed ${digest.length} chars.`);

  // Re-decompose the TDE digest through our 9D-tagged INGEST_PROMPT so the
  // atoms match TDE-Demo's schema (persona, buying_stage, ..., industry).
  const userContent = JSON.stringify({
    role,
    target_name: hint_name || col.name || url,
    target_url: url,
    content: `SOURCE: TDE cache (collection "${collectionId}", ${atomCount} atoms)\n\n${digest}`
  });
  const parsed = await callLLM(INGEST_PROMPT, userContent, { maxTokens: 32000 });
  if (!parsed?.atoms?.length) return null;
  return {
    target: { ...parsed.target, role, url },
    summary: parsed.summary,
    atoms: parsed.atoms,
    source_url: url,
    source: 'tde_cache',
    tde_collection: collectionId,
    tde_atom_count: atomCount,
    ingested_at: new Date().toISOString()
  };
}

async function ingestOne({ url, role, hint_name, demoMode }) {
  // Step 0a — LOCAL in-memory cache. Instant return, zero LLM calls, zero DB calls.
  const cacheKey = `${url}::${role}`;
  if (ingestCache.has(cacheKey)) {
    console.log(`[CACHE] MEM HIT ${cacheKey} — instant`);
    return { ...ingestCache.get(cacheKey), source: 'local_cache' };
  }

  // Step 0b — POSTGRES cache (30-day TTL). Survives deploys.
  const dbCached = await db.getCachedIngest(url, role);
  if (dbCached) {
    console.log(`[CACHE] DB HIT ${url} (${role}) — no LLM call needed`);
    // Populate memory cache too
    ingestCache.set(cacheKey, dbCached);
    if (ingestCache.size > INGEST_CACHE_MAX) {
      const oldest = ingestCache.keys().next().value;
      ingestCache.delete(oldest);
    }
    return { ...dbCached, source: 'db_cache' };
  }

  // Step 1 — prefer TDE service cache.
  const cached = await ingestFromTdeCache({ url, role, hint_name }).catch(e => {
    console.log(`[TDE] Cache lookup error: ${e.message}`);
    return null;
  });
  if (cached) {
    // Store in both memory + Postgres for next time
    ingestCache.set(cacheKey, cached);
    if (ingestCache.size > INGEST_CACHE_MAX) {
      const oldest = ingestCache.keys().next().value;
      ingestCache.delete(oldest);
    }
    db.setCachedIngest(url, role, cached).catch(e => console.error('[db] cache write:', e.message));
    return cached;
  }

  // Step 2 — fresh demo-lightweight ingest (scrape the URL, run our INGEST_PROMPT).
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
  // In demo mode, use a smaller token limit since we'll cap atoms anyway
  const ingestTokens = demoMode ? 8000 : 32000;
  const ingestPrompt = demoMode
    ? INGEST_PROMPT.replace('50-150 atoms', '15-25 atoms').replace('50-150 atoms. Each stands alone.', '15-25 atoms. Each stands alone.')
    : INGEST_PROMPT;
  const parsed = await callLLM(ingestPrompt, userContent, { maxTokens: ingestTokens });
  if (!parsed?.atoms?.length) throw new Error(`Ingest for ${url} returned no atoms`);

  // Step 3 — fire TDE warmup in the background so next time this URL is a cache hit.
  const collectionId = urlToCollectionId(url);
  warmTdeCacheAsync(collectionId, url, role, parsed.target?.name || hint_name);

  const result = {
    target: { ...parsed.target, role, url },
    summary: parsed.summary,
    atoms: parsed.atoms,
    source_url: url,
    source: 'fresh',
    tde_collection: collectionId,
    ingested_at: new Date().toISOString()
  };

  // Store in memory cache + Postgres (30-day TTL) for instant repeats
  ingestCache.set(cacheKey, result);
  if (ingestCache.size > INGEST_CACHE_MAX) {
    const oldest = ingestCache.keys().next().value;
    ingestCache.delete(oldest);
  }
  db.setCachedIngest(url, role, result).catch(e => console.error('[db] cache write:', e.message));

  return result;
}

function industryCacheKey(industry, subindustry, region) {
  return [industry, subindustry, region].filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

async function synthesizeCustomerArchetype({ industry, subindustry, region, demoMode }) {
  const industryKey = industryCacheKey(industry, subindustry, region);
  const tdeKey = 'tde_demo_archetype';

  // Step 0a — LOCAL in-memory cache for archetypes.
  const localKey = `archetype::${industryKey}`;
  if (ingestCache.has(localKey)) {
    console.log(`[CACHE] Archetype MEM HIT ${industryKey} — instant`);
    return { ...ingestCache.get(localKey), source: 'local_cache' };
  }

  // Step 0b — POSTGRES cache (30-day TTL). Survives deploys.
  const dbCached = await db.getCachedArchetype(industryKey);
  if (dbCached) {
    console.log(`[CACHE] Archetype DB HIT ${industryKey} — no LLM call`);
    ingestCache.set(localKey, dbCached);
    if (ingestCache.size > INGEST_CACHE_MAX) {
      const oldest = ingestCache.keys().next().value;
      ingestCache.delete(oldest);
    }
    return { ...dbCached, source: 'db_cache' };
  }

  // Step 1 — check TDE's industry intel cache. If a fresh archetype exists,
  // reuse it. TDE's /intel/industry/:key is purpose-built for industry-level
  // knowledge with a 30-day TTL.
  if (tdeAvailable() && industryKey) {
    try {
      const cached = await tdeRequest('GET', `/intel/industry/${encodeURIComponent(industryKey)}?solution_key=${tdeKey}`);
      if (cached?.found) {
        const bundle = cached.solution_pain_cache;
        if (bundle?.found && bundle?.fresh && bundle?.archetype?.atoms?.length) {
          console.log(`[TDE] Archetype HIT ${industryKey} (${bundle.archetype.atoms.length} atoms).`);
          return {
            ...bundle.archetype,
            target: { ...bundle.archetype.target, role: 'customer', is_archetype: true },
            industry, subindustry, region,
            source: 'tde_cache',
            tde_industry_key: industryKey,
            ingested_at: new Date().toISOString()
          };
        }
      }
    } catch (e) {
      console.log(`[TDE] Archetype cache lookup failed: ${e.message}`);
    }
  }

  // Step 2 — synthesize fresh via LLM (the demo-lightweight path).
  const userContent = JSON.stringify({ industry, subindustry, region });
  const archetypeTokens = demoMode ? 8000 : 32000;
  const archetypePrompt = demoMode
    ? INDUSTRY_ARCHETYPE_PROMPT.replace('50-150 atoms', '15-25 atoms').replace('50-150 atoms, each tagged', '15-25 atoms, each tagged')
    : INDUSTRY_ARCHETYPE_PROMPT;
  const parsed = await callLLM(archetypePrompt, userContent, { maxTokens: archetypeTokens });
  if (!parsed?.atoms?.length) throw new Error('Archetype synthesis returned no atoms');

  const archetype = {
    target: { ...parsed.target, role: 'customer', is_archetype: true },
    summary: parsed.summary,
    atoms: parsed.atoms,
    industry, subindustry, region,
    source: 'fresh',
    tde_industry_key: industryKey,
    ingested_at: new Date().toISOString()
  };

  // Step 3 — save to TDE so NEXT run hits the cache (fire-and-forget).
  if (tdeAvailable() && industryKey) {
    const painPoints = (parsed.atoms || [])
      .filter(a => ['weakness', 'mission_gap', 'buying_trigger'].includes(a.type))
      .map(a => ({ title: (a.claim || '').slice(0, 80), description: a.claim, evidence: a.evidence, type: a.type, persona: a.d_persona }));
    tdeRequest('PUT', `/intel/industry/${encodeURIComponent(industryKey)}`, {
      industry_name: industry,
      sub_industries: subindustry ? [subindustry] : [],
      pain_points: painPoints,
      observations: [{ at: new Date().toISOString(), source: 'tde_demo', summary: parsed.summary }],
      // solution_pains lets us stash the FULL archetype keyed by consumer.
      // Here we key it to 'tde_demo_archetype' so TDE-Demo can pull it back
      // whole on the next run without needing custom schema.
      solution_pains: {
        [tdeKey]: { archetype: { target: archetype.target, summary: archetype.summary, atoms: archetype.atoms } }
      },
      tags: ['tde_demo', region || 'global'].filter(Boolean)
    }).then(() => {
      console.log(`[TDE] Archetype SAVED to /intel/industry/${industryKey}`);
    }).catch((e) => {
      console.log(`[TDE] Archetype save failed: ${e.message}`);
    });
  }

  // Store in memory + Postgres (30-day TTL) for instant repeats
  ingestCache.set(localKey, archetype);
  if (ingestCache.size > INGEST_CACHE_MAX) {
    const oldest = ingestCache.keys().next().value;
    ingestCache.delete(oldest);
  }
  db.setCachedArchetype(industryKey, archetype).catch(e => console.error('[db] archetype cache write:', e.message));

  return archetype;
}

async function extractPainPoints(customerEntry, { industry, subindustry } = {}) {
  const isArchetype = !!customerEntry.target?.is_archetype;
  const ind = industry || customerEntry.industry || null;
  const subInd = subindustry || customerEntry.subindustry || null;

  // Cache key: customer atoms + industry + subindustry
  const pk = cacheKey({ atoms: customerEntry.atoms, industry: ind, subindustry: subInd });

  // 1. In-memory cache
  if (painCache.has(pk)) {
    console.log(`[pain] Memory cache hit (${pk})`);
    return painCache.get(pk);
  }

  // 2. Postgres cache
  const dbCached = await db.getCachedIngest(pk, 'pain');
  if (dbCached) {
    console.log(`[pain] DB cache hit (${pk})`);
    setWithEvict(painCache, pk, dbCached);
    return dbCached;
  }

  // 3. Fresh LLM call
  console.log(`[pain] Cache miss — calling LLM (${pk})`);
  const userContent = JSON.stringify({
    is_archetype: isArchetype,
    industry: ind, subindustry: subInd,
    customer: {
      name: customerEntry.target?.name,
      summary: customerEntry.summary,
      atoms: customerEntry.atoms
    }
  });
  const parsed = await callLLM(PAIN_PROMPT, userContent, { maxTokens: 4000 });
  const result = {
    company_pain:     Array.isArray(parsed.company_pain)     ? parsed.company_pain     : [],
    subindustry_pain: Array.isArray(parsed.subindustry_pain) ? parsed.subindustry_pain : [],
    industry_pain:    Array.isArray(parsed.industry_pain)    ? parsed.industry_pain    : []
  };

  // Store in both caches
  setWithEvict(painCache, pk, result);
  db.setCachedIngest(pk, 'pain', result);
  return result;
}

// ─── ENDPOINTS ───────────────────────────────────────────────────────────────

// Health
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    model: OPENROUTER_MODEL_ID,
    leadhydration_configured: Boolean(LEADHYDRATION_URL),
    email_configured: Boolean(RESEND_API_KEY),
    email_from: REPORT_FROM_EMAIL,
    tde_configured: tdeAvailable(),
    tde_url: TDE_BASE_URL,
    tde_min_atoms: TDE_MIN_ATOMS,
    runs_in_memory: runStore.size,
    ingest_cache_memory: ingestCache.size,
    pain_cache_memory: painCache.size,
    strategy_cache_memory: strategyCache.size,
    database_configured: db.isConfigured()
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
    recipient_role,
    individual_name,
    mode
  } = req.body || {};
  const isDemo = mode === 'demo';
  const DEMO_ATOMS_PER_CATEGORY = 20;

  // Validation
  if (!email) return res.status(400).json({ error: 'Require email (your email)' });
  if (!sender_company_url) return res.status(400).json({ error: 'Require sender_company_url' });
  if (!solution_url) return res.status(400).json({ error: 'Require solution_url' });
  if (!customer_url && !industry) {
    return res.status(400).json({ error: 'Require customer_url OR industry (subindustry + region optional)' });
  }
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured — missing OPENROUTER_API_KEY' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');
  // Keep-alive ping to prevent Railway/HTTP2 proxy timeout
  res.flushHeaders?.();
  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  const run_id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // ── PHASE 1 + 2: Fetch + Ingest all sources in parallel ──────────────
    const t0 = Date.now();
    send('phase', { phase: 'fetch', message: 'Fetching sender, solution, customer in parallel…' });

    const senderPromise   = ingestOne({ url: normUrl(sender_company_url), role: 'sender', demoMode: isDemo });
    const solutionPromise = ingestOne({ url: normUrl(solution_url),       role: 'solution', demoMode: isDemo });
    const customerPromise = customer_url
      ? ingestOne({ url: normUrl(customer_url), role: 'customer', demoMode: isDemo })
      : synthesizeCustomerArchetype({ industry, subindustry, region, demoMode: isDemo });

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

    // DEMO MODE: limit atoms to N per category (atom type)
    if (isDemo) {
      [sender, solution, customer].forEach(entry => {
        if (!entry || !entry.atoms) return;
        const byType = {};
        entry.atoms.forEach(a => {
          const t = a.type || 'unknown';
          if (!byType[t]) byType[t] = [];
          byType[t].push(a);
        });
        const trimmed = [];
        Object.values(byType).forEach(group => {
          trimmed.push(...group.slice(0, DEMO_ATOMS_PER_CATEGORY));
        });
        entry.atoms = trimmed;
      });
    }

    const ingestMs = Date.now() - t0;
    const allCached = [sender, solution, customer].every(e => ['local_cache', 'db_cache'].includes(e.source));
    send('phase', { phase: 'ingest', message: allCached
      ? `All three from cache — ${ingestMs}ms (no LLM calls)`
      : `All three decomposed into 9D-tagged atoms (${Math.round(ingestMs/1000)}s).` });
    send('atoms', {
      sender:   { target: sender.target,   summary: sender.summary,   atoms: sender.atoms,   source: sender.source,   tde_collection: sender.tde_collection,   tde_atom_count: sender.tde_atom_count },
      solution: { target: solution.target, summary: solution.summary, atoms: solution.atoms, source: solution.source, tde_collection: solution.tde_collection, tde_atom_count: solution.tde_atom_count },
      customer: { target: customer.target, summary: customer.summary, atoms: customer.atoms, source: customer.source, tde_collection: customer.tde_collection, tde_atom_count: customer.tde_atom_count }
    });

    // ── PHASE 3: Pain points — dedicated LLM pass that always returns company,
    //    sub-industry, and industry pain groups (not just an atom-type filter).
    send('phase', { phase: 'pain', message: 'Surfacing company, sub-industry, industry pain…' });
    const pain_groups = await extractPainPoints(customer, { industry, subindustry });
    const pain_points = [
      ...pain_groups.company_pain,
      ...pain_groups.subindustry_pain,
      ...pain_groups.industry_pain
    ];
    send('pain', { pain_groups, pain_points });

    // ── PHASE 4: 5 strategies (cached by sender+solution+customer atoms + role) ──
    send('phase', { phase: 'strategies', message: 'Generating 5 sales strategies…' });
    const sk = cacheKey({
      sender_atoms: sender.atoms,
      solution_atoms: solution.atoms,
      customer_atoms: customer.atoms,
      recipient_role: recipient_role || 'Senior executive'
    });
    let strategies;

    // 1. In-memory
    if (strategyCache.has(sk)) {
      console.log(`[strategy] Memory cache hit (${sk})`);
      strategies = strategyCache.get(sk);
    } else {
      // 2. Postgres
      const dbStrat = await db.getCachedIngest(sk, 'strategy');
      if (dbStrat) {
        console.log(`[strategy] DB cache hit (${sk})`);
        strategies = dbStrat;
        setWithEvict(strategyCache, sk, strategies);
      } else {
        // 3. Fresh LLM call
        console.log(`[strategy] Cache miss — calling LLM (${sk})`);
        const stratInput = JSON.stringify({
          sender:   { name: sender.target?.name,   summary: sender.summary,   atoms: sender.atoms },
          solution: { name: solution.target?.name, summary: solution.summary, atoms: solution.atoms },
          customer: { name: customer.target?.name, summary: customer.summary, atoms: customer.atoms, is_archetype: !!customer.target?.is_archetype },
          recipient_role: recipient_role || 'Senior executive'
        });
        strategies = await callLLM(STRATEGIES_PROMPT, stratInput, { maxTokens: 4000 });
        setWithEvict(strategyCache, sk, strategies);
        db.setCachedIngest(sk, 'strategy', strategies);
      }
    }
    send('strategies', strategies);

    // ── Persist the run so /api/hydrate can retrieve it by run_id ────────
    runStore.set(run_id, {
      email, sender, solution, customer,
      pain_points, pain_groups, strategies,
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
    clearInterval(keepAlive);
    res.end();

    // ── Persist to Postgres (fire-and-forget — never blocks the SSE response) ─
    db.saveRun(run_id, {
      email, sender_company_url, solution_url, customer_url,
      industry, subindustry, region, recipient_role, individual_name
    }, {
      sender, solution, customer,
      pain_groups, pain_points, strategies
    }).catch(err => console.error('[db] async saveRun:', err.message));

  } catch (err) {
    console.error('[demo-flow]', err.message);
    send('error', { message: err.message });
    clearInterval(keepAlive);
    res.end();
  }
});

// Build a LeadHydration-compatible solution object directly from TDE atoms.
// This is the "reuse what we already know" shortcut: the demo already ingested
// the solution URL into 9D-tagged atoms, so there's no need to hit
// LeadHydration's /api/agent/solution again (which would re-scrape + re-LLM).
function synthesizeSolutionFromAtoms(solutionEntry, painGroups) {
  const atoms = solutionEntry?.atoms || [];
  const byType = (t) => atoms.filter(a => a.type === t).map(a => a.claim).filter(Boolean);

  const capabilities    = [...byType('product'), ...byType('differentiator')].slice(0, 8);
  const differentiators = byType('differentiator').slice(0, 5);
  const icpClaims       = byType('icp');
  const targetMarket    = icpClaims.length ? icpClaims.join(' ') : (solutionEntry?.summary || '');

  // Flatten pain_groups into a single painPointsSolved array so the
  // LeadHydration LLM sees the specific pains we already surfaced.
  const pg = painGroups || {};
  const painPointsSolved = [
    ...(pg.company_pain     || []),
    ...(pg.subindustry_pain || []),
    ...(pg.industry_pain    || [])
  ].map(p => p.title || p.description).filter(Boolean).slice(0, 10);

  return {
    name: solutionEntry?.target?.name || 'Solution',
    type: 'Business Software',
    description: solutionEntry?.summary || '',
    capabilities,
    targetMarket,
    differentiators,
    painPointsSolved
  };
}

// Hydration endpoint — called AFTER user picks a strategy.
// Reuses TDE's already-computed solution atoms and pain groups instead of
// re-running LeadHydration's /api/agent/solution (expensive duplicate work).
// We still call /api/agent/company-pain to generate the rich discovery intel
// (questions, email campaign, strategic insight) that TDE doesn't produce
// on its own — but with tier=2 (LLM-only) so it doesn't redo the deep scrape.
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
    const solutionIntel = synthesizeSolutionFromAtoms(run.solution, run.pain_groups);

    const customerName = run.customer?.target?.name || 'Target Customer';
    const customerWebsite = run.customer?.source_url || run.customer?.target?.url || '';
    const industryName = run.customer?.industry || run.industry || solutionIntel.targetMarket || '';

    // Pass the strategy's persona × pain anchor as a hint so questions/emails
    // align to the chosen angle, not some other persona/pain.
    const strategyHint = chosenStrategy.target_persona && chosenStrategy.pain_anchor
      ? `[Chosen angle — anchor on: persona "${chosenStrategy.target_persona}", pain "${chosenStrategy.pain_anchor}"]`
      : '';
    const enrichedIndustry = strategyHint
      ? `${industryName} ${strategyHint}`
      : industryName;

    const painRes = await fetch(`${LEADHYDRATION_URL}/api/agent/company-pain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LEADHYDRATION_API_KEY ? { 'Authorization': `Bearer ${LEADHYDRATION_API_KEY}` } : {})
      },
      body: JSON.stringify({
        companyName: customerName,
        ...(customerWebsite ? { website: customerWebsite } : {}),
        ...(enrichedIndustry ? { industry: enrichedIndustry } : {}),
        solution: solutionIntel,
        tier: 2, // LLM-only — TDE already did the deep research; don't redo it
        lang: 'en'
      }),
      signal: AbortSignal.timeout(120_000) // 2 min — cold path can be slow
    });
    if (!painRes.ok) {
      const txt = await painRes.text();
      throw new Error(`LeadHydration /company-pain failed (${painRes.status}): ${txt.slice(0, 300)}`);
    }
    const hydration = await painRes.json();

    // Persist so the email report can include the hydration result.
    run.chosen_strategy = chosenStrategy;
    run.solution_intel  = solutionIntel;
    run.hydration       = hydration;

    // Persist hydration to Postgres (fire-and-forget)
    db.saveHydration(run_id, chosenStrategy.id || strategy_id, chosenStrategy.title || '', hydration)
      .catch(err => console.error('[db] async saveHydration:', err.message));

    return res.json({
      run_id,
      chosen_strategy: chosenStrategy,
      solution_intel: solutionIntel,
      solution_source: 'tde_atoms', // so the UI can show "reused from TDE"
      hydration
    });
  } catch (err) {
    console.error('[hydrate]', err.message);
    return res.status(502).json({ error: `Hydration failed: ${err.message}` });
  }
});

// ClearSignals — analyze a pasted email thread.
// Proxies to LeadHydration /api/coaching-analyze with run context pre-filled.
app.post('/api/clearsignals', async (req, res) => {
  const { run_id, thread_text } = req.body || {};
  if (!run_id)      return res.status(400).json({ error: 'Require run_id' });
  if (!thread_text) return res.status(400).json({ error: 'Require thread_text (the email thread to analyze)' });
  if (thread_text.length < 50) {
    return res.status(422).json({ error: 'thread_text must be at least 50 characters.' });
  }

  const run = runStore.get(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  if (!LEADHYDRATION_URL) {
    return res.status(503).json({
      error: 'LeadHydration not connected',
      detail: 'ClearSignals is hosted inside LeadHydration — set LEADHYDRATION_URL to enable.'
    });
  }

  try {
    const customerName = run.customer?.target?.name || 'Target Customer';
    // Pain context hands our already-discovered pain labels to ClearSignals so
    // it can align its analysis to the specific pains we surfaced.
    const painLabels = [
      ...(run.pain_groups?.company_pain     || []),
      ...(run.pain_groups?.subindustry_pain || []),
      ...(run.pain_groups?.industry_pain    || [])
    ].map(p => p.title).filter(Boolean).slice(0, 8);

    const csRes = await fetch(`${LEADHYDRATION_URL}/api/coaching-analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LEADHYDRATION_API_KEY ? { 'Authorization': `Bearer ${LEADHYDRATION_API_KEY}` } : {})
      },
      body: JSON.stringify({
        thread_text,
        companyName: customerName,
        pain_context: { painLabels }
      }),
      signal: AbortSignal.timeout(120_000) // 2 min — cold path can be slow
    });
    if (!csRes.ok) {
      const txt = await csRes.text();
      console.error(`[clearsignals] LeadHydration ${csRes.status}:`, txt.slice(0, 500));
      console.error(`[clearsignals] Sent thread_text length=${thread_text.length}, companyName=${customerName}, painLabels=${painLabels.length}`);
      throw new Error(`ClearSignals analyze failed (${csRes.status}): ${txt.slice(0, 300)}`);
    }
    const analysis = await csRes.json();
    // Keep the latest ClearSignals run attached to the run for the email report.
    run.clearsignals_analysis = analysis;

    // Persist coaching analysis to Postgres (fire-and-forget)
    db.saveCoaching(run_id, thread_text, analysis?.result || analysis)
      .catch(err => console.error('[db] async saveCoaching:', err.message));

    return res.json({ run_id, analysis });
  } catch (err) {
    console.error('[clearsignals]', err.message);
    return res.status(502).json({ error: `ClearSignals failed: ${err.message}` });
  }
});

// ─── COACH CHAT ──────────────────────────────────────────────────────────────
// Conversational sales coach grounded in the run's TDE data.
// Not JSON-mode — returns plain conversational text.

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const COACH_VOICE_ID     = process.env.COACH_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';

function buildCoachContext(run) {
  const parts = [];

  // Company context
  const custName = run.customer?.target?.name || 'Target Customer';
  const custSummary = run.customer?.summary || '';
  parts.push(`COMPANY: ${custName}\n${custSummary}`);

  // Pain points — compact summary
  const painGroups = run.pain_groups || {};
  for (const group of ['company_pain', 'subindustry_pain', 'industry_pain']) {
    const pains = painGroups[group] || [];
    if (!pains.length) continue;
    const label = group.replace('_pain', '').replace('_', ' ');
    parts.push(`PAIN POINTS (${label}):\n${pains.map(p => {
      let line = `- ${p.title}: ${p.description || ''}`;
      if (p.persona_primary) line += ` [Owner: ${p.persona_primary.title} — ${p.persona_primary.rationale || ''} | Feels: ${p.persona_primary.perspective || ''}]`;
      if (p.persona_secondary) line += ` [Also: ${p.persona_secondary.title} — ${p.persona_secondary.perspective || ''}]`;
      return line;
    }).join('\n')}`);
  }

  // Strategies
  const strats = run.strategies?.strategies || [];
  if (strats.length) {
    parts.push(`SALES STRATEGIES:\n${strats.map(s =>
      `- ${s.title}: ${s.explanation || ''} [persona: ${s.target_persona || '?'}, pain: ${s.pain_anchor || '?'}]`
    ).join('\n')}`);
  }

  // Chosen strategy + hydration
  if (run.chosen_strategy) {
    parts.push(`CHOSEN STRATEGY: ${run.chosen_strategy.title || ''}\n${run.chosen_strategy.explanation || ''}`);
  }
  if (run.hydration) {
    const h = run.hydration;
    if (h.questions?.length) {
      parts.push(`DISCOVERY QUESTIONS:\n${h.questions.map(q => {
        let line = `- [${q.stage}] "${q.question}" — Purpose: ${q.purpose || ''}`;
        if (q.tone_guidance) line += ` | Tone: ${q.tone_guidance}`;
        return line;
      }).join('\n')}`);
    }
    if (h.strategicInsight) parts.push(`STRATEGIC INSIGHT: ${h.strategicInsight}`);
    if (h.extraBackground) parts.push(`EXTRA BACKGROUND: ${h.extraBackground}`);
  }

  // Solution context
  const solName = run.solution?.target?.name || 'Solution';
  const solSummary = run.solution?.summary || '';
  parts.push(`SOLUTION: ${solName}\n${solSummary}`);

  // Sender context
  const senderName = run.sender?.target?.name || 'Seller';
  const senderSummary = run.sender?.summary || '';
  parts.push(`SELLER: ${senderName}\n${senderSummary}`);

  // Key atoms (top claims by type for quick reference)
  const custAtoms = run.customer?.atoms || [];
  if (custAtoms.length) {
    const byType = {};
    custAtoms.forEach(a => {
      if (!byType[a.type]) byType[a.type] = [];
      if (byType[a.type].length < 5) byType[a.type].push(a.claim);
    });
    parts.push(`KEY CUSTOMER ATOMS:\n${Object.entries(byType).map(([t, claims]) =>
      `  ${t}: ${claims.join(' | ')}`
    ).join('\n')}`);
  }

  return parts.join('\n\n');
}

const COACH_SYSTEM_PROMPT = `You are an elite B2B sales coach embedded inside OppIntelAI. The rep just completed a deep intelligence run on a target account. You have ALL the data — pain points with dual-persona owners, sales strategies, discovery questions, competitive positioning, and 9D-tagged atoms.

YOUR ROLE: Strategic sales advisor. The rep asks you questions and you give specific, actionable advice grounded in the data below. You are NOT a chatbot. You are a coach who has studied every detail of this deal.

HOW TO COACH:
- Reference specific pain points, personas, and strategies from the data
- Give exact words and scripts when asked "what should I say"
- Use MEDDPICC, Challenger, JOLT, and Sandler frameworks naturally
- Push back when the rep's approach is weak — suggest better angles
- When they ask about objections, roleplay both sides: what the prospect will say and what the rep should counter with
- Keep responses concise (2-4 sentences for simple questions, longer for roleplay/scripts)
- Be warm but direct. You're a trusted colleague, not a script reader.

NEVER:
- Make up data that isn't in the context below
- Give generic advice like "build rapport" without specifics
- Repeat information without adding coaching value
- Be sycophantic — be honest about weak angles

`;

app.post('/api/coach-chat', async (req, res) => {
  const { run_id, message, history } = req.body || {};
  if (!run_id)  return res.status(400).json({ error: 'Require run_id' });
  if (!message) return res.status(400).json({ error: 'Require message' });

  const run = runStore.get(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  const context = buildCoachContext(run);
  const systemPrompt = COACH_SYSTEM_PROMPT + `\n---\nDEAL INTELLIGENCE:\n${context}\n---`;

  // Build conversation messages
  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-20)) { // keep last 20 turns
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'TDE Coach'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL_ID,
        messages,
        temperature: 0.5,
        max_tokens: 2000
        // No response_format: json_object — we want plain text
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`);
    }
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || '';
    return res.json({ reply });
  } catch (err) {
    console.error('[coach-chat]', err.message);
    return res.status(502).json({ error: `Coach failed: ${err.message}` });
  }
});

// ─── VOICE COACH PROVISIONING ────────────────────────────────────────────────
// Creates a temporary ElevenLabs conversational agent with the run's data
// baked into the system prompt. Returns agent_id for widget embed.

const voiceAgentStore = new Map(); // run_id → { agent_id, created_at }

app.post('/api/coach-voice/provision', async (req, res) => {
  const { run_id } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'Require run_id' });
  if (!ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });

  const run = runStore.get(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  // Return existing agent if already provisioned for this run
  if (voiceAgentStore.has(run_id)) {
    const existing = voiceAgentStore.get(run_id);
    return res.json({ agent_id: existing.agent_id, reused: true });
  }

  try {
    const context = buildCoachContext(run);
    const custName = run.customer?.target?.name || 'Target Customer';
    const voicePrompt = COACH_SYSTEM_PROMPT + `\n---\nDEAL INTELLIGENCE:\n${context}\n---\n\nADDITIONAL VOICE RULES:\n- You are on a voice call. Keep responses spoken-length (2-3 sentences per turn unless they ask for more).\n- Leave room for back-and-forth. Don't monologue.\n- When giving scripts, say "Here's what I'd say:" and deliver it in a natural spoken cadence.\n- If they want to roleplay, commit to the character fully.\n`;

    const payload = {
      name: `TDE Coach — ${custName}`,
      conversation_config: {
        agent: {
          prompt: { prompt: voicePrompt, llm: 'gpt-4o', temperature: 0.6 },
          first_message: `Hey! I've studied everything from your ${custName} intelligence run — pain points, personas, strategies, discovery questions. What do you want to work on?`,
          language: 'en'
        },
        tts: { voice_id: COACH_VOICE_ID }
      }
    };

    const elRes = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!elRes.ok) {
      const txt = await elRes.text();
      throw new Error(`ElevenLabs ${elRes.status}: ${txt.slice(0, 300)}`);
    }
    const result = await elRes.json();
    const agent_id = result.agent_id;

    voiceAgentStore.set(run_id, { agent_id, created_at: Date.now() });
    // Clean up voice agents older than 2 hours
    const cutoff = Date.now() - 7200000;
    for (const [k, v] of voiceAgentStore.entries()) {
      if (v.created_at < cutoff) {
        // Fire-and-forget cleanup
        fetch(`https://api.elevenlabs.io/v1/convai/agents/${v.agent_id}`, {
          method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).catch(() => {});
        voiceAgentStore.delete(k);
      }
    }

    console.log(`[coach-voice] Provisioned agent ${agent_id} for run ${run_id} (${custName})`);
    return res.json({ agent_id, reused: false });
  } catch (err) {
    console.error('[coach-voice]', err.message);
    return res.status(502).json({ error: `Voice provisioning failed: ${err.message}` });
  }
});

// ─── HTML REPORT GENERATOR ───────────────────────────────────────────────────
// Produces a self-contained HTML file summarizing a run — atoms, pain groups,
// strategies, chosen strategy, hydration (questions + email drip), and
// ClearSignals analysis if it was run. Inline CSS, no external assets.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function buildReportHtml(run) {
  const esc = escHtml;
  const d = new Date(run.created_at || Date.now());
  const title = `TDE report — ${esc(run.customer?.target?.name || run.industry || 'Customer')}`;

  const atomMini = (a) => `
    <div class="atom">
      <div class="atom-head"><span class="atom-type">${esc((a.type || '').replace(/_/g, ' '))}</span>
        <span class="atom-conf">${esc(a.confidence || '')}</span></div>
      <div class="atom-claim">${esc(a.claim || '')}</div>
      ${a.evidence ? `<div class="atom-evi">${esc(a.evidence)}</div>` : ''}
    </div>`;

  const atomGroup = (label, entry) => {
    if (!entry) return '';
    return `
      <div class="group">
        <div class="group-title">${esc(label)} — ${esc(entry.target?.name || '')}</div>
        <div class="group-sum">${esc(entry.summary || '')}</div>
        <div class="atoms">${(entry.atoms || []).map(atomMini).join('')}</div>
      </div>`;
  };

  const painSection = (label, items, tone) => {
    if (!items || !items.length) return '';
    return `
      <div class="pain-block pain-${tone}">
        <div class="pain-block-label">${esc(label)} (${items.length})</div>
        ${items.map(p => `
          <div class="pain-item">
            <div class="pain-title">${esc(p.title || '')}</div>
            <div class="pain-desc">${esc(p.description || '')}</div>
            ${p.evidence ? `<div class="pain-evi">${esc(p.evidence)}</div>` : ''}
            <div class="pain-chips">
              ${p.persona ? `<span>Persona: ${esc(p.persona)}</span>` : ''}
              ${p.urgency ? `<span>Urgency: ${esc(p.urgency)}</span>` : ''}
              ${p.economic_lever && p.economic_lever !== 'None' ? `<span>Pull: ${esc(p.economic_lever)}</span>` : ''}
              ${p.inertia_force && p.inertia_force !== 'None' ? `<span>Inertia: ${esc(p.inertia_force)}</span>` : ''}
            </div>
          </div>
        `).join('')}
      </div>`;
  };

  const stratCard = (s) => {
    const chosen = run.chosen_strategy && run.chosen_strategy.id === s.id;
    return `
      <div class="strat ${chosen ? 'strat-chosen' : ''}">
        <div class="strat-head">
          <span class="strat-id">${esc(s.id || '')}</span>
          <span class="strat-title">${esc(s.title || '')}</span>
          ${chosen ? '<span class="strat-chosen-badge">SELECTED</span>' : ''}
        </div>
        <div class="strat-chips">
          ${s.target_persona ? `<span>👤 ${esc(s.target_persona)}</span>` : ''}
          ${s.pain_anchor    ? `<span>⚡ ${esc(s.pain_anchor)}</span>` : ''}
          ${s.strategy_force ? `<span>${esc(s.strategy_force)}</span>` : ''}
          ${s.confidence != null ? `<span>${esc(s.confidence)}% confidence</span>` : ''}
        </div>
        <div class="strat-section"><b>Explanation</b><div>${esc(s.explanation || '')}</div></div>
        <div class="strat-section"><b>Customer pain</b><div>${esc(s.customer_pain || '')}</div></div>
        <div class="strat-section"><b>Sender contribution</b><div>${esc(s.sender_contribution || '')}</div></div>
        <div class="strat-section"><b>Solution contribution</b><div>${esc(s.solution_contribution || '')}</div></div>
        <div class="strat-section"><b>First step</b><div>${esc(s.first_step || '')}</div></div>
      </div>`;
  };

  const h = run.hydration || {};
  const questions = Array.isArray(h.questions) ? h.questions : [];
  const emails    = h.emailCampaign || h.emailSequence || [];
  const cs        = run.clearsignals_analysis || null;

  const qCard = (q) => {
    const pos = Array.isArray(q.positive_responses) ? q.positive_responses : [];
    const neg = Array.isArray(q.neutral_negative_responses) ? q.neutral_negative_responses : (q.negative_responses || []);
    return `
      <div class="q">
        <div class="q-stage">${esc(q.stage || 'Question')}</div>
        <div class="q-text">${esc(q.question || '')}</div>
        ${q.purpose ? `<div class="q-block"><b>Why we ask this</b><div>${esc(q.purpose)}</div></div>` : ''}
        ${q.pain_it_targets || q.pain_point ? `<div class="q-block"><b>Pain it targets</b><div>${esc(q.pain_it_targets || q.pain_point)}</div></div>` : ''}
        ${q.tone_guidance ? `<div class="q-block"><b>How to deliver</b><div>${esc(q.tone_guidance)}</div></div>` : ''}
        ${pos.length ? `<div class="q-resp q-pos"><b>Expected positive responses</b>${pos.map(r => `
          <div class="q-resp-item">
            <div class="q-resp-quote">"${esc(r.response || '')}"</div>
            ${r.next_step ? `<div class="q-resp-next"><b>Next:</b> ${esc(r.next_step)}</div>` : ''}
          </div>`).join('')}</div>` : ''}
        ${neg.length ? `<div class="q-resp q-neg"><b>Possible negative responses — how to pivot</b>${neg.map(r => `
          <div class="q-resp-item">
            <div class="q-resp-quote">"${esc(r.response || '')}"</div>
            ${r.pivot ? `<div class="q-resp-next"><b>Pivot:</b> ${esc(r.pivot)}</div>` : ''}
          </div>`).join('')}</div>` : ''}
        ${q.unexpected_response && typeof q.unexpected_response === 'object' ? `<div class="q-unexp"><b>If they say something unexpected:</b><div class="q-resp-item"><div class="q-resp-quote">"${esc(q.unexpected_response.response || '')}"</div>${q.unexpected_response.pivot ? `<div class="q-resp-next"><b>Pivot:</b> ${esc(q.unexpected_response.pivot)}</div>` : ''}</div></div>` : q.expected_answer_unexpected ? `<div class="q-unexp"><b>If they say something unexpected:</b> ${esc(q.expected_answer_unexpected)}</div>` : ''}
      </div>`;
  };

  const emailCard = (em, i) => `
    <div class="email">
      <div class="email-head">
        <b>${esc(em.label || ('Email ' + (em.step || i+1)))}</b>
        ${em.sendDay ? `<span class="email-day">${esc(em.sendDay)}</span>` : ''}
      </div>
      <div class="email-subject"><b>Subject:</b> ${esc(em.subject || em.subject_line || '')}</div>
      <div class="email-body">${esc(em.body || em.content || '').replace(/\n/g, '<br>')}</div>
    </div>`;

  const csSection = cs ? (() => {
    const health = cs.deal_health || {};
    const threadAn = Array.isArray(cs.thread_analysis) ? cs.thread_analysis : [];
    const nextSteps = Array.isArray(cs.next_steps) ? cs.next_steps : [];
    return `
      <div class="section">
        <h2>ClearSignals — Email Thread Analysis</h2>
        <div class="cs-health"><b>Deal Health:</b> ${esc(health.score ?? '?')}/100 — ${esc(health.label || '')}<div>${esc(health.summary || health.explanation || '')}</div></div>
        ${threadAn.length ? `<h3>Thread analysis</h3>${threadAn.map(t => `
          <div class="cs-msg"><b>${esc(t.from || t.author || 'Message')}</b> — ${esc(t.assessment || t.sentiment || '')}<div>${esc(t.insight || t.analysis || t.summary || '')}</div></div>
        `).join('')}` : ''}
        ${nextSteps.length ? `<h3>Next steps</h3><ol>${nextSteps.map(s => `<li>${esc(typeof s === 'string' ? s : (s.action || s.step || JSON.stringify(s)))}</li>`).join('')}</ol>` : ''}
      </div>`;
  })() : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0e13; color: #e8ecf2; max-width: 960px; margin: 0 auto; padding: 32px 24px; line-height: 1.55; }
  h1 { font-size: 22px; margin-bottom: 6px; }
  h2 { font-size: 16px; color: #5aa9ff; margin: 28px 0 10px; border-bottom: 1px solid #2a3542; padding-bottom: 6px; }
  h3 { font-size: 13px; color: #a8b2c0; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 1px; }
  .meta { color: #a8b2c0; font-size: 12px; margin-bottom: 20px; }
  .section { margin-bottom: 28px; }
  .group { background: #121820; border: 1px solid #2a3542; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .group-title { font-size: 13px; font-weight: 800; margin-bottom: 4px; }
  .group-sum { font-size: 12px; color: #a8b2c0; margin-bottom: 10px; }
  .atoms { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr)); gap: 8px; }
  .atom { background: #1a222c; border: 1px solid #2a3542; border-radius: 6px; padding: 8px 10px; font-size: 11px; }
  .atom-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .atom-type { color: #5aa9ff; font-weight: 700; }
  .atom-conf { color: #6b7685; }
  .atom-claim { color: #e8ecf2; line-height: 1.4; margin-bottom: 4px; }
  .atom-evi { color: #6b7685; font-style: italic; font-size: 10px; }
  .pain-block { border-left: 3px solid #ff5a5a; background: #1a222c; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .pain-subindustry { border-left-color: #ff9d5a; }
  .pain-industry    { border-left-color: #5ad4ff; }
  .pain-block-label { font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .pain-company .pain-block-label     { color: #ff5a5a; }
  .pain-subindustry .pain-block-label { color: #ff9d5a; }
  .pain-industry .pain-block-label    { color: #5ad4ff; }
  .pain-item { margin-bottom: 10px; }
  .pain-title { font-weight: 700; font-size: 13px; }
  .pain-desc { font-size: 12px; color: #a8b2c0; }
  .pain-evi { font-size: 11px; color: #6b7685; font-style: italic; margin: 4px 0; }
  .pain-chips span { display: inline-block; background: #222c38; color: #a8b2c0; font-size: 10px; padding: 2px 6px; border-radius: 8px; margin-right: 4px; }
  .strat { background: #121820; border: 1px solid #2a3542; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .strat-chosen { border-color: #3ddc84; }
  .strat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .strat-id { background: #5aa9ff; color: #0a0e13; font-weight: 800; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .strat-title { font-weight: 800; font-size: 14px; flex: 1; }
  .strat-chosen-badge { background: #3ddc84; color: #0a0e13; font-weight: 800; padding: 2px 8px; border-radius: 10px; font-size: 10px; }
  .strat-chips span { display: inline-block; background: #222c38; color: #a8b2c0; font-size: 11px; padding: 3px 8px; border-radius: 10px; margin-right: 6px; }
  .strat-section { font-size: 12px; margin-top: 8px; }
  .strat-section b { color: #5aa9ff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; display: block; margin-bottom: 2px; }
  .q { background: #121820; border: 1px solid #2a3542; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .q-stage { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #b583ff; margin-bottom: 4px; }
  .q-text { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
  .q-block { font-size: 12px; margin-bottom: 8px; }
  .q-block b { color: #5aa9ff; text-transform: uppercase; letter-spacing: 0.8px; font-size: 10px; display: block; margin-bottom: 2px; }
  .q-resp { background: #1a222c; border-radius: 6px; padding: 10px; margin-top: 8px; font-size: 12px; }
  .q-pos { border-left: 3px solid #3ddc84; }
  .q-neg { border-left: 3px solid #ff5a5a; }
  .q-resp b { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; display: block; margin-bottom: 6px; }
  .q-pos > b { color: #3ddc84; }
  .q-neg > b { color: #ff5a5a; }
  .q-resp-item { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #2a3542; }
  .q-resp-item:last-child { border-bottom: none; }
  .q-resp-quote { font-style: italic; color: #e8ecf2; margin-bottom: 4px; }
  .q-resp-next { color: #a8b2c0; font-size: 11px; }
  .q-resp-next b { display: inline; color: inherit; text-transform: none; letter-spacing: normal; font-size: 11px; }
  .q-unexp { margin-top: 8px; padding: 8px 10px; background: rgba(255,199,87,0.08); border-left: 3px solid #ffc757; font-size: 11px; color: #ffc757; }
  .q-unexp b { color: #ffc757; }
  .email { background: #121820; border: 1px solid #2a3542; border-left: 3px solid #5ad4ff; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .email-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .email-day { color: #6b7685; font-size: 10px; background: #222c38; padding: 2px 8px; border-radius: 8px; }
  .email-subject { font-size: 13px; margin-bottom: 6px; }
  .email-body { font-size: 12px; color: #a8b2c0; line-height: 1.7; }
  .cs-health { background: #1a222c; border-left: 3px solid #b583ff; padding: 10px 12px; margin-bottom: 12px; font-size: 12px; }
  .cs-msg { background: #1a222c; border-left: 3px solid #b583ff; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; }
  @media print {
    body { background: #fff !important; color: #111 !important; }
    .section, .atom, .pain-item, .strat, .group, .email-card, .cs-health, .cs-msg {
      background: #f8f8f8 !important; color: #111 !important; border-color: #ccc !important;
    }
    .atom-claim, .pain-desc, .strat-explain, .email-body, .group-sum {
      color: #333 !important;
    }
    h1, h2, .group-title, .pain-block-label, .strat-title, .pain-title {
      color: #000 !important;
    }
    .meta, .atom-evi, .pain-evi, .strat-chips span, .pain-chips span {
      color: #555 !important;
    }
    .section { page-break-inside: avoid; }
    .strat, .pain-block { page-break-inside: avoid; }
  }
</style></head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">Run ${esc(run.run_id || '')} · Generated ${esc(d.toISOString())}${run.email ? ' · For ' + esc(run.email) : ''}</div>

  <div class="section">
    <h2>Positioning Context</h2>
    ${atomGroup('Sender',   run.sender)}
    ${atomGroup('Solution', run.solution)}
    ${atomGroup('Customer', run.customer)}
  </div>

  <div class="section">
    <h2>Pain Points</h2>
    ${painSection('Company-specific', run.pain_groups?.company_pain,     'company')}
    ${painSection('Sub-industry',     run.pain_groups?.subindustry_pain, 'subindustry')}
    ${painSection('Industry-wide',    run.pain_groups?.industry_pain,    'industry')}
  </div>

  ${run.strategies?.strategies?.length ? `
  <div class="section">
    <h2>Sales Strategies (${run.strategies.strategies.length})</h2>
    ${run.strategies.strategies.map(stratCard).join('')}
  </div>` : ''}

  ${run.hydration ? `
  <div class="section">
    <h2>Lead Hydration${run.chosen_strategy ? ' — Strategy: ' + esc(run.chosen_strategy.title || '') : ''}</h2>
    ${h.whoIsThis     ? `<p><b>Who is this:</b> ${esc(h.whoIsThis)}</p>` : ''}
    ${h.primaryLead   ? `<p><b>Primary lead:</b> ${esc(h.primaryLead.title || '')} — ${esc(h.primaryLead.topic || '')}</p>` : ''}
    ${questions.length ? `<h3>Discovery Questions (${questions.length})</h3>${questions.map(qCard).join('')}` : ''}
    ${emails.length    ? `<h3>Email Drip Campaign (${emails.length} steps)</h3>${emails.map(emailCard).join('')}` : ''}
  </div>` : ''}

  ${csSection}

</body></html>`;
}

// POST /api/send-report — email the self-contained HTML report via Resend.
// Requires RESEND_API_KEY and a verified REPORT_FROM_EMAIL on the Resend account.
app.post('/api/send-report', async (req, res) => {
  const { run_id, to } = req.body || {};
  if (!run_id) return res.status(400).json({ error: 'Require run_id' });

  const run = runStore.get(run_id);
  if (!run) return res.status(404).json({ error: 'run_id not found or expired' });

  if (!RESEND_API_KEY) {
    return res.status(503).json({
      error: 'Email not configured',
      detail: 'Set RESEND_API_KEY in Railway env vars to enable the email report.'
    });
  }

  const recipient = (to || run.email || '').trim();
  if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
    return res.status(400).json({ error: 'Valid recipient email required (form email or `to` field)' });
  }

  try {
    const html = buildReportHtml({ ...run, run_id });
    const attachment = Buffer.from(html, 'utf8').toString('base64');
    const customerLabel = run.customer?.target?.name || run.industry || 'customer';
    const filename = `TDE-report-${String(customerLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${run_id}.html`;

    const emailBody = `
      <p>Your TDE analysis for <b>${escHtml(customerLabel)}</b> is attached as an HTML file you can open in any browser. You can also download a Word document from the app.</p>
      <p>The report includes: positioning atoms, pain points (company / sub-industry / industry), the 5 sales strategies generated, and — if you ran it — the lead hydration output (discovery questions, email drip) and ClearSignals thread analysis.</p>
      <p>— TDE Demo</p>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: [recipient],
        subject: `TDE report — ${customerLabel}`,
        html: emailBody,
        attachments: [{ filename, content: attachment }]
      })
    });

    const data = await resendRes.json().catch(() => ({}));
    if (!resendRes.ok) {
      throw new Error(`Resend ${resendRes.status}: ${data.message || JSON.stringify(data).slice(0, 300)}`);
    }

    console.log(`[report] Emailed ${filename} to ${recipient} (resend id: ${data.id || '?'})`);
    return res.json({
      ok: true,
      to: recipient,
      from: REPORT_FROM_EMAIL,
      filename,
      resend_id: data.id || null,
      note: `Email sent from ${REPORT_FROM_EMAIL}. If you don't see it, check spam.`
    });
  } catch (err) {
    console.error('[send-report]', err.message);
    return res.status(502).json({ error: `Email failed: ${err.message}` });
  }
});

// GET /api/report/:run_id — same HTML report, served inline (as a backup
// if the email doesn't arrive, or for local preview). Not linked from the
// UI, but handy for debugging.
app.get('/api/report/:run_id', (req, res) => {
  const run = runStore.get(req.params.run_id);
  if (!run) return res.status(404).send('<h2 style="font-family:sans-serif;padding:40px">Run not found or expired</h2>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildReportHtml({ ...run, run_id: req.params.run_id }));
});

// ─── DOCX REPORT GENERATOR ──────────────────────────────────────────────────
function buildReportDocx(run) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = getDocx();
  const d = new Date(run.created_at || Date.now());
  const customerName = run.customer?.target?.name || run.industry || 'Customer';
  const sections = [];

  // Helper: bold + normal text in one paragraph
  const bp = (label, value) => new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: label, bold: true, size: 20, font: 'Calibri' }),
      new TextRun({ text: value || '', size: 20, font: 'Calibri' }),
    ],
  });
  const heading = (text, level = HeadingLevel.HEADING_1) => new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, font: 'Calibri' })],
  });
  const body = (text) => new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: text || '', size: 20, font: 'Calibri' })],
  });
  const bullet = (text) => new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text: text || '', size: 20, font: 'Calibri' })],
  });

  // ── Title & meta
  sections.push(
    heading(`TDE Report — ${customerName}`),
    body(`Run ${run.run_id || ''} · Generated ${d.toISOString()}${run.email ? ' · For ' + run.email : ''}`),
    new Paragraph({ spacing: { after: 200 }, children: [] })
  );

  // ── Positioning Context (atoms)
  for (const [label, entry] of [['Sender', run.sender], ['Solution', run.solution], ['Customer', run.customer]]) {
    if (!entry) continue;
    sections.push(heading(`${label} — ${entry.target?.name || ''}`, HeadingLevel.HEADING_2));
    if (entry.summary) sections.push(body(entry.summary));
    for (const a of (entry.atoms || [])) {
      sections.push(bp(`[${(a.type || '').replace(/_/g, ' ')}] `, a.claim || ''));
      if (a.evidence) sections.push(body(`  Evidence: ${a.evidence}`));
    }
  }

  // ── Pain Points
  const pg = run.pain_groups || {};
  for (const [label, key] of [['Company-specific', 'company_pain'], ['Sub-industry', 'subindustry_pain'], ['Industry-wide', 'industry_pain']]) {
    const pains = pg[key] || [];
    if (!pains.length) continue;
    sections.push(heading(`Pain Points — ${label} (${pains.length})`, HeadingLevel.HEADING_2));
    for (const p of pains) {
      sections.push(bp('', p.title || ''));
      if (p.description) sections.push(body(p.description));
      const chips = [
        p.persona && `Persona: ${p.persona}`,
        p.urgency && `Urgency: ${p.urgency}`,
        p.economic_lever && p.economic_lever !== 'None' && `Pull: ${p.economic_lever}`,
        p.inertia_force && p.inertia_force !== 'None' && `Inertia: ${p.inertia_force}`,
      ].filter(Boolean);
      if (chips.length) sections.push(body(chips.join(' · ')));
    }
  }

  // ── Strategies
  const strats = run.strategies?.strategies || [];
  if (strats.length) {
    sections.push(heading(`Sales Strategies (${strats.length})`, HeadingLevel.HEADING_2));
    for (const s of strats) {
      const chosen = run.chosen_strategy && run.chosen_strategy.id === s.id;
      sections.push(bp(`${s.id || ''} — `, `${s.title || ''}${chosen ? '  ★ SELECTED' : ''}`));
      if (s.explanation) sections.push(body(s.explanation));
      const chips = [
        s.target_persona && `Persona: ${s.target_persona}`,
        s.pain_anchor && `Pain: ${s.pain_anchor}`,
        s.strategy_force && s.strategy_force,
        s.confidence != null && `${s.confidence}% confidence`,
      ].filter(Boolean);
      if (chips.length) sections.push(body(chips.join(' · ')));
    }
  }

  // ── Hydration
  const h = run.hydration || {};
  if (run.hydration) {
    sections.push(heading(`Lead Hydration${run.chosen_strategy ? ' — Strategy: ' + (run.chosen_strategy.title || '') : ''}`, HeadingLevel.HEADING_2));
    if (h.whoIsThis) sections.push(bp('Who is this: ', h.whoIsThis));
    if (h.primaryLead) sections.push(bp('Primary lead: ', `${h.primaryLead.title || ''} — ${h.primaryLead.topic || ''}`));

    const questions = Array.isArray(h.questions) ? h.questions : [];
    if (questions.length) {
      sections.push(heading(`Discovery Questions (${questions.length})`, HeadingLevel.HEADING_3));
      for (const q of questions) {
        sections.push(bp(`[${q.stage || 'Q'}] `, q.question || ''));
        if (q.purpose) sections.push(body(`Why: ${q.purpose}`));
        if (q.pain_it_targets || q.pain_point) sections.push(body(`Pain: ${q.pain_it_targets || q.pain_point}`));
        if (q.tone_guidance) sections.push(body(`Tone: ${q.tone_guidance}`));
        const pos = Array.isArray(q.positive_responses) ? q.positive_responses : [];
        for (const r of pos) {
          sections.push(bullet(`✓ "${r.response || ''}"${r.next_step ? ' → ' + r.next_step : ''}`));
        }
        const neg = Array.isArray(q.neutral_negative_responses) ? q.neutral_negative_responses : (q.negative_responses || []);
        for (const r of neg) {
          sections.push(bullet(`✗ "${r.response || ''}"${r.pivot ? ' → Pivot: ' + r.pivot : ''}`));
        }
      }
    }

    const emails = h.emailCampaign || h.emailSequence || [];
    if (emails.length) {
      sections.push(heading(`Email Drip Campaign (${emails.length} steps)`, HeadingLevel.HEADING_3));
      for (const em of emails) {
        sections.push(bp(em.label || `Email ${em.step || ''}`, em.sendDay ? ` — ${em.sendDay}` : ''));
        if (em.subject || em.subject_line) sections.push(bp('Subject: ', em.subject || em.subject_line));
        if (em.body || em.content) sections.push(body(em.body || em.content));
        sections.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      }
    }
  }

  // ── ClearSignals
  const cs = run.clearsignals_analysis || null;
  if (cs) {
    sections.push(heading('ClearSignals — Email Thread Analysis', HeadingLevel.HEADING_2));
    const health = cs.deal_health || {};
    sections.push(bp('Deal Health: ', `${health.score ?? '?'}/100 — ${health.label || ''}`));
    if (health.summary || health.explanation) sections.push(body(health.summary || health.explanation));
    const threadAn = Array.isArray(cs.thread_analysis) ? cs.thread_analysis : [];
    if (threadAn.length) {
      sections.push(heading('Thread Analysis', HeadingLevel.HEADING_3));
      for (const t of threadAn) {
        sections.push(bp(`${t.from || t.author || 'Message'}: `, t.assessment || t.sentiment || ''));
        if (t.insight || t.analysis || t.summary) sections.push(body(t.insight || t.analysis || t.summary));
      }
    }
    const nextSteps = Array.isArray(cs.next_steps) ? cs.next_steps : [];
    if (nextSteps.length) {
      sections.push(heading('Next Steps', HeadingLevel.HEADING_3));
      for (const s of nextSteps) {
        sections.push(bullet(typeof s === 'string' ? s : (s.action || s.step || JSON.stringify(s))));
      }
    }
  }

  return new Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
        heading1: { run: { font: 'Calibri', size: 32, bold: true, color: '1a1a2e' } },
        heading2: { run: { font: 'Calibri', size: 26, bold: true, color: '2d3a4a' } },
        heading3: { run: { font: 'Calibri', size: 22, bold: true, color: '3d4f6a' } },
      },
    },
    sections: [{ children: sections }],
  });
}

// GET /api/report/:run_id/docx — download Word report
app.get('/api/report/:run_id/docx', async (req, res) => {
  const run = runStore.get(req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found or expired' });
  try {
    const doc = buildReportDocx({ ...run, run_id: req.params.run_id });
    const { Packer } = getDocx();
    const buf = await Packer.toBuffer(doc);
    const label = run.customer?.target?.name || run.industry || 'customer';
    const safeName = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="TDE-Report-${safeName}-${req.params.run_id}.docx"`);
    res.send(buf);
  } catch (err) {
    console.error('[docx-report]', err.message);
    res.status(500).json({ error: `DOCX generation failed: ${err.message}` });
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
app.listen(PORT, async () => {
  console.log(`✅ TDE Demo v3 listening on port ${PORT}`);
  console.log(`   model: ${OPENROUTER_MODEL_ID}`);
  console.log(`   leadhydration: ${LEADHYDRATION_URL || '(not configured)'}`);
  console.log(`   database: ${db.isConfigured() ? 'connected' : '(not configured — set DATABASE_URL)'}`);
  console.log(`   voice-coach: ${ELEVENLABS_API_KEY ? 'enabled' : '(not configured — set ELEVENLABS_API_KEY)'}`);
  if (db.isConfigured()) await db.initSchema();
});
