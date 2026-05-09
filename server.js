// server.js — DRiX Demo v3
// Three-URL ingest → 6D-tagged atoms → pain points → 5 strategies → (on-select) DRiX Ready Lead
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

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
const FIRECRAWL_API_KEY   = process.env.FIRECRAWL_API_KEY || '';
const APOLLO_API_KEY      = process.env.APOLLO_API_KEY || '';

if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY not set.');
if (!LEADHYDRATION_URL)  console.warn('⚠️  LEADHYDRATION_URL not set — hydration step will fail loud.');
if (!RESEND_API_KEY)     console.warn('⚠️  RESEND_API_KEY not set — email report step will fail loud.');
if (!TDE_API_KEY)        console.warn('⚠️  TDE_API_KEY not set — TDE cache lookups will be skipped (fresh ingest every time).');
if (!FIRECRAWL_API_KEY)  console.warn('⚠️  FIRECRAWL_API_KEY not set — fetches use basic HTTP (SPAs may return empty content).');
if (!APOLLO_API_KEY)     console.warn('⚠️  APOLLO_API_KEY not set — decision-maker lookup will be skipped.');
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
if (!CEREBRAS_API_KEY)   console.warn('⚠️  CEREBRAS_API_KEY not set — comparison synthesis will fall back to OpenRouter.');

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

// ─── FIRECRAWL — JS-rendering scraper for SPAs and modern sites ─────────────
// When FIRECRAWL_API_KEY is set, fetch via Firecrawl which executes JavaScript
// and returns clean markdown — far richer than regex-stripped HTML for SPAs.
// Returns the same shape as the basic fetch: {url, title, description, text}
// or null on missing key / failure / thin content (caller falls back).
async function firecrawlScrape(url) {
  if (!FIRECRAWL_API_KEY) return null;
  try {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) {
      console.log(`[Firecrawl] ${res.status} for ${url} — falling back to basic fetch`);
      return null;
    }
    const data = await res.json();
    const md = data?.data?.markdown || data?.markdown || '';
    if (!md || md.length < 50) {
      console.log(`[Firecrawl] thin content (${md.length} chars) for ${url} — falling back`);
      return null;
    }
    const meta = data?.data?.metadata || {};
    console.log(`[Firecrawl] Scraped ${md.length} chars from ${url}`);
    return {
      url,
      title: meta.title || meta.ogTitle || null,
      description: meta.description || meta.ogDescription || null,
      text: md.slice(0, 40000)
    };
  } catch (e) {
    console.log(`[Firecrawl] ${url}: ${e.message} — falling back to basic fetch`);
    return null;
  }
}

// ─── APOLLO — decision-maker lookup ─────────────────────────────────────────
// Given a customer domain and a target persona/title (the AI-identified role
// from a strategy's target_persona), returns the best matching person from
// Apollo's database. Returns null on missing key, no domain, or no matches.
async function apolloFindContact(domain, persona) {
  if (!APOLLO_API_KEY) return null;
  const cleanDomain = String(domain || '')
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
  if (!cleanDomain) return null;
  try {
    const body = {
      api_key: APOLLO_API_KEY,
      q_organization_domains: cleanDomain,
      per_page: 5,
      page: 1
    };
    if (persona) body.person_titles = [persona];
    const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      console.log(`[Apollo] ${res.status} for ${cleanDomain} (${persona || 'any'}) — no decision maker returned`);
      return null;
    }
    const data = await res.json();
    const people = Array.isArray(data?.people) ? data.people : [];
    if (!people.length) {
      console.log(`[Apollo] No people found for ${cleanDomain} matching "${persona || 'any'}"`);
      return null;
    }
    const best = people[0];
    const name = `${best.first_name || ''} ${best.last_name || ''}`.trim();
    const result = {
      name: name || null,
      title: best.title || null,
      email: best.email || null,
      linkedin: best.linkedin_url || null,
      organization: best.organization?.name || null,
      persona: persona || null,
      source: 'apollo'
    };
    console.log(`[Apollo] Found ${name || '(unnamed)'} (${result.title || 'no title'}) for ${cleanDomain} — persona: ${persona || 'any'}`);
    return result;
  } catch (e) {
    console.log(`[Apollo] ${cleanDomain} (${persona || 'any'}): ${e.message}`);
    return null;
  }
}

async function fetchAndStrip(url) {
  // Try Firecrawl first — JS-rendering, clean markdown. Falls through on miss.
  const fc = await firecrawlScrape(url);
  if (fc) return fc;
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

    // ── PHASE 5: Decision-maker lookup — Apollo against the AI-identified
    //    target_persona of the top-pick strategy. One Apollo call per demo;
    //    additional calls fire lazily in /api/hydrate when the user picks a
    //    different (non-top-pick) strategy.
    const decisionMakers = {}; // strategy_id → contact object
    const customerDomain = String(customer?.target?.url || customer?.source_url || customer_url || '')
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
    const topPickId = strategies?.top_pick_id;
    const topPick   = (strategies?.strategies || []).find(s => s.id === topPickId);
    if (APOLLO_API_KEY && customerDomain && topPick?.target_persona) {
      send('phase', { phase: 'decision_maker', message: `Identifying ${topPick.target_persona} at ${customerDomain}…` });
      const contact = await apolloFindContact(customerDomain, topPick.target_persona);
      if (contact) decisionMakers[topPickId] = contact;
      send('decision_maker', { strategy_id: topPickId, persona: topPick.target_persona, contact: contact || null });
    }

    // ── Persist the run so /api/hydrate can retrieve it by run_id ────────
    runStore.set(run_id, {
      email, sender, solution, customer,
      pain_points, pain_groups, strategies,
      decisionMakers,
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
      error: 'DRiX Ready Lead not connected',
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

    // Apollo: look up the decision maker for this strategy's persona, if not
    // already cached from the demo-flow top-pick lookup. One call per unique
    // (strategy_id, persona) pair within the run's lifetime.
    const cacheKeyDM = chosenStrategy.id || 'custom';
    let decisionMaker = run.decisionMakers?.[cacheKeyDM] || null;
    if (!decisionMaker && APOLLO_API_KEY && chosenStrategy.target_persona) {
      const dmDomain = String(customerWebsite || '')
        .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
      if (dmDomain) {
        decisionMaker = await apolloFindContact(dmDomain, chosenStrategy.target_persona);
        if (decisionMaker) {
          run.decisionMakers = run.decisionMakers || {};
          run.decisionMakers[cacheKeyDM] = decisionMaker;
        }
      }
    }

    // Pass the strategy's persona × pain anchor as a hint so questions/emails
    // align to the chosen angle, not some other persona/pain.
    const strategyHint = chosenStrategy.target_persona && chosenStrategy.pain_anchor
      ? `[Chosen angle — anchor on: persona "${chosenStrategy.target_persona}", pain "${chosenStrategy.pain_anchor}"]`
      : '';
    const enrichedIndustry = strategyHint
      ? `${industryName} ${strategyHint}`
      : industryName;

    // Retry up to 2 times — LeadHydration's LLM can return null on cold starts.
    let hydration;
    for (let attempt = 0; attempt < 3; attempt++) {
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
      if (painRes.ok) {
        hydration = await painRes.json();
        break;
      }
      const txt = await painRes.text();
      console.error(`[hydrate] attempt ${attempt + 1}/3 — ${painRes.status}: ${txt.slice(0, 300)}`);
      if (attempt < 2 && (painRes.status >= 500 || txt.includes('null response'))) {
        console.log(`[hydrate] Retrying in ${3 + attempt * 3}s…`);
        await new Promise(r => setTimeout(r, (3 + attempt * 3) * 1000));
        continue;
      }
      throw new Error(`LeadHydration /company-pain failed (${painRes.status}): ${txt.slice(0, 300)}`);
    }
    if (!hydration) throw new Error('LeadHydration returned no data after 3 attempts');

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
      hydration,
      decision_maker: decisionMaker || null
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
      error: 'DRiX Ready Lead not connected',
      detail: 'ClearSignals is hosted inside DRiX Ready Lead. Set LEADHYDRATION_URL to enable.'
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

    // Retry up to 2 times — LeadHydration's LLM can return null on cold starts.
    let analysis;
    for (let attempt = 0; attempt < 3; attempt++) {
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
      if (csRes.ok) {
        analysis = await csRes.json();
        break;
      }
      const txt = await csRes.text();
      console.error(`[clearsignals] attempt ${attempt + 1}/3 — ${csRes.status}: ${txt.slice(0, 300)}`);
      if (attempt < 2 && (csRes.status >= 500 || txt.includes('null response'))) {
        console.log(`[clearsignals] Retrying in ${3 + attempt * 3}s…`);
        await new Promise(r => setTimeout(r, (3 + attempt * 3) * 1000));
        continue;
      }
      throw new Error(`ClearSignals analyze failed (${csRes.status}): ${txt.slice(0, 300)}`);
    }
    if (!analysis) throw new Error('ClearSignals returned no data after 3 attempts');
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
      name: `DRiX Coach - ${custName}`,
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
  const title = `DRiX Report ... ${esc(run.customer?.target?.name || run.industry || 'Customer')}`;

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
    const filename = `DRiX-report-${String(customerLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${run_id}.html`;

    const emailBody = `
      <p>Your DRiX analysis for <b>${escHtml(customerLabel)}</b> is attached as an HTML file you can open in any browser. You can also download a Word document from the app.</p>
      <p>The report includes: positioning atoms, pain points (company / sub-industry / industry), the 5 sales strategies generated, and if you ran it, the DRiX Ready Lead output (discovery questions, email drip) and ClearSignals analysis.</p>
      <p>... WinTech Partners</p>
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
        subject: `DRiX Report - ${customerLabel}`,
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

// ─── DOCX REPORT — proper Word document via docx-js ─────────────────────────
// Lazy-load so a missing package never crashes the server on startup.
let _docx;
function loadDocx() {
  if (!_docx) _docx = require('docx');
  return _docx;
}

app.get('/api/report/:run_id/doc', async (req, res) => {
  const run = runStore.get(req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found or expired' });

  try {
    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat,
      AlignmentType, Header, Footer, PageNumber, PageBreak, BorderStyle
    } = loadDocx();

    const customerName = run.customer?.target?.name || run.industry || 'Customer';
    const d = new Date(run.created_at || Date.now());
    const children = [];

    // ── Helpers ──
    const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
    const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
    const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
    const p = (t) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t || '', font: 'Arial', size: 22 })] });
    const bold = (label, value) => new Paragraph({
      spacing: { after: 100 },
      children: [
        new TextRun({ text: label, bold: true, font: 'Arial', size: 22 }),
        new TextRun({ text: value || '', font: 'Arial', size: 22 }),
      ],
    });
    const bul = (t) => new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      spacing: { after: 60 },
      children: [new TextRun({ text: t || '', font: 'Arial', size: 22 })],
    });
    const spacer = () => new Paragraph({ spacing: { after: 200 }, children: [] });
    const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

    // ── Title page ──
    children.push(
      new Paragraph({ spacing: { before: 3000 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: 'DRiX Analysis Report', font: 'Arial', size: 52, bold: true, color: '1B3A5C' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: customerName, font: 'Arial', size: 36, color: '2E75B6' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), font: 'Arial', size: 24, color: '666666' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `Run ID: ${run.run_id || ''}`, font: 'Arial', size: 20, color: '999999' })],
      }),
      pageBreak()
    );

    // ── Positioning Context ──
    children.push(h1('Positioning Context'));
    for (const [label, entry] of [['Sender', run.sender], ['Solution', run.solution], ['Customer', run.customer]]) {
      if (!entry) continue;
      children.push(h2(`${label} — ${entry.target?.name || ''}`));
      if (entry.summary) children.push(p(entry.summary));
      for (const a of (entry.atoms || [])) {
        children.push(bold(`[${(a.type || '').replace(/_/g, ' ')}]  `, a.claim || ''));
        if (a.evidence) children.push(p(`Evidence: ${a.evidence}`));
      }
      children.push(spacer());
    }
    children.push(pageBreak());

    // ── Pain Points ──
    const pg = run.pain_groups || {};
    children.push(h1('Pain Points'));
    for (const [label, key] of [['Company-Specific', 'company_pain'], ['Sub-Industry', 'subindustry_pain'], ['Industry-Wide', 'industry_pain']]) {
      const pains = pg[key] || [];
      if (!pains.length) continue;
      children.push(h2(`${label} (${pains.length})`));
      for (const pp of pains) {
        children.push(bold('', pp.title || ''));
        if (pp.description) children.push(p(pp.description));
        const tags = [
          pp.persona && `Persona: ${pp.persona}`,
          pp.urgency && `Urgency: ${pp.urgency}`,
          pp.economic_lever && pp.economic_lever !== 'None' && `Lever: ${pp.economic_lever}`,
          pp.inertia_force && pp.inertia_force !== 'None' && `Inertia: ${pp.inertia_force}`,
        ].filter(Boolean);
        if (tags.length) children.push(p(tags.join('  |  ')));
      }
    }
    children.push(pageBreak());

    // ── Strategies ──
    const strats = run.strategies?.strategies || [];
    if (strats.length) {
      children.push(h1(`Sales Strategies (${strats.length})`));
      for (const s of strats) {
        const chosen = run.chosen_strategy && run.chosen_strategy.id === s.id;
        children.push(h2(`${s.id || ''} — ${s.title || ''}${chosen ? '  [SELECTED]' : ''}`));
        if (s.explanation) children.push(p(s.explanation));
        const tags = [
          s.target_persona && `Persona: ${s.target_persona}`,
          s.pain_anchor && `Pain: ${s.pain_anchor}`,
          s.strategy_force,
          s.confidence != null && `${s.confidence}% confidence`,
        ].filter(Boolean);
        if (tags.length) children.push(p(tags.join('  |  ')));
        children.push(spacer());
      }
      children.push(pageBreak());
    }

    // ── Hydration ──
    const hy = run.hydration || {};
    if (run.hydration) {
      children.push(h1(`Lead Hydration${run.chosen_strategy ? ' — ' + (run.chosen_strategy.title || '') : ''}`));
      if (hy.whoIsThis) children.push(bold('Who is this:  ', hy.whoIsThis));
      if (hy.primaryLead) children.push(bold('Primary lead:  ', `${hy.primaryLead.title || ''} — ${hy.primaryLead.topic || ''}`));
      children.push(spacer());

      const questions = Array.isArray(hy.questions) ? hy.questions : [];
      if (questions.length) {
        children.push(h2(`Discovery Questions (${questions.length})`));
        for (const q of questions) {
          children.push(bold(`[${q.stage || 'Q'}]  `, q.question || ''));
          if (q.purpose) children.push(bul(`Why: ${q.purpose}`));
          if (q.pain_it_targets || q.pain_point) children.push(bul(`Pain: ${q.pain_it_targets || q.pain_point}`));
          if (q.tone_guidance) children.push(bul(`Tone: ${q.tone_guidance}`));
          const pos = Array.isArray(q.positive_responses) ? q.positive_responses : [];
          for (const r of pos) {
            children.push(bul(`Positive: "${r.response || ''}"${r.next_step ? ' — Next: ' + r.next_step : ''}`));
          }
          const neg = Array.isArray(q.neutral_negative_responses) ? q.neutral_negative_responses : (q.negative_responses || []);
          for (const r of neg) {
            children.push(bul(`Negative: "${r.response || ''}"${r.pivot ? ' — Pivot: ' + r.pivot : ''}`));
          }
          children.push(spacer());
        }
      }

      const emails = hy.emailCampaign || hy.emailSequence || [];
      if (emails.length) {
        children.push(h2(`Email Drip Campaign (${emails.length} steps)`));
        for (const em of emails) {
          children.push(bold(em.label || `Email ${em.step || ''}`, em.sendDay ? `  —  ${em.sendDay}` : ''));
          if (em.subject || em.subject_line) children.push(bold('Subject:  ', em.subject || em.subject_line));
          if (em.body || em.content) children.push(p(em.body || em.content));
          children.push(spacer());
        }
      }
      children.push(pageBreak());
    }

    // ── ClearSignals ──
    const cs = run.clearsignals_analysis || null;
    if (cs) {
      children.push(h1('ClearSignals — Email Thread Analysis'));
      const health = cs.deal_health || {};
      children.push(bold('Deal Health:  ', `${health.score ?? '?'}/100 — ${health.label || ''}`));
      if (health.summary || health.explanation) children.push(p(health.summary || health.explanation));

      const threadAn = Array.isArray(cs.thread_analysis) ? cs.thread_analysis : [];
      if (threadAn.length) {
        children.push(h2('Thread Analysis'));
        for (const t of threadAn) {
          children.push(bold(`${t.from || t.author || 'Message'}:  `, t.assessment || t.sentiment || ''));
          if (t.insight || t.analysis || t.summary) children.push(p(t.insight || t.analysis || t.summary));
        }
      }
      const nextSteps = Array.isArray(cs.next_steps) ? cs.next_steps : [];
      if (nextSteps.length) {
        children.push(h2('Recommended Next Steps'));
        for (const s of nextSteps) {
          children.push(bul(typeof s === 'string' ? s : (s.action || s.step || JSON.stringify(s))));
        }
      }
    }

    // ── Build Document ──
    const doc = new Document({
      styles: {
        default: { document: { run: { font: 'Arial', size: 22 } } },
        paragraphStyles: [
          { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 32, bold: true, font: 'Arial', color: '1B3A5C' },
            paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0,
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2E75B6', space: 1 } } } },
          { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 26, bold: true, font: 'Arial', color: '2E75B6' },
            paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
          { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 24, bold: true, font: 'Arial', color: '404040' },
            paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } },
        ],
      },
      numbering: {
        config: [{
          reference: 'bullets',
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        }],
      },
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: {
          default: new Header({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: `DRiX Report - ${customerName}`, font: 'Arial', size: 18, color: '999999' })],
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Page ', font: 'Arial', size: 18, color: '999999' }),
                new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 18, color: '999999' }),
              ],
            })],
          }),
        },
        children,
      }],
    });

    const buf = await Packer.toBuffer(doc);
    const safeName = String(customerName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="DRiX-Report-${safeName}-${req.params.run_id}.docx"`);
    res.send(buf);
  } catch (err) {
    console.error('[docx-report]', err);
    res.status(500).json({ error: `Report generation failed: ${err.message}` });
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

// ─── COMPARISON ENDPOINT (live DRiX vs Standard AI) ─────────────────────────

// Retry helper — single retry with backoff for flaky API calls
async function fetchWithRetry(url, options, { label = 'fetch', retries = 2, backoffMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) {
        const body = await resp.text();
        const err = new Error(`${label} ${resp.status}: ${body.slice(0, 200)}`);
        err.status = resp.status;
        // 429 = rate limit — ALWAYS retry with longer backoff
        if (resp.status === 429 && attempt < retries) {
          const wait = backoffMs * (attempt + 1) * 2; // escalating: 4s, 8s, ...
          console.warn(`[${label}] Rate limited (429), waiting ${wait}ms before retry ${attempt + 1}/${retries}...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        // Don't retry other 4xx errors (auth, bad request) — only 5xx and network failures
        if (resp.status >= 400 && resp.status < 500) throw err;
        if (attempt < retries) {
          console.warn(`[${label}] attempt ${attempt + 1} failed (${resp.status}), retrying in ${backoffMs}ms...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
      return resp;
    } catch (e) {
      if (e.status === 429 && attempt < retries) {
        const wait = backoffMs * (attempt + 1) * 2;
        console.warn(`[${label}] Rate limited (429), waiting ${wait}ms before retry ${attempt + 1}/${retries}...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (e.status && e.status >= 400 && e.status < 500) throw e;
      if (attempt < retries) {
        console.warn(`[${label}] attempt ${attempt + 1} error: ${e.message}, retrying in ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    }
  }
}

// Cerebras-first synthesis with OpenRouter fallback
async function synthesizeWithFallback(prompt, { label = 'Synth', temperature = 0.5, max_tokens = 2000 } = {}) {
  // Primary: Cerebras
  if (CEREBRAS_API_KEY) {
    try {
      const resp = await fetchWithRetry('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          temperature, max_tokens
        }),
        signal: AbortSignal.timeout(45000)
      }, { label: `${label}/Cerebras`, retries: 2, backoffMs: 2000 });
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) {
        console.log(`[${label}] Cerebras OK (${text.length} chars)`);
        return text;
      }
    } catch (e) {
      console.warn(`[${label}] Cerebras failed: ${e.message}, falling back to OpenRouter...`);
    }
  }

  // Fallback: OpenRouter
  if (OPENROUTER_API_KEY) {
    try {
      const resp = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://tde-demo.up.railway.app',
          'X-Title': `DRiX ${label}`
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content: prompt }],
          temperature, max_tokens
        }),
        signal: AbortSignal.timeout(45000)
      }, { label: `${label}/OpenRouter`, retries: 2, backoffMs: 3000 });
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) {
        console.log(`[${label}] OpenRouter fallback OK (${text.length} chars)`);
        return text;
      }
    } catch (e) {
      console.warn(`[${label}] OpenRouter fallback also failed: ${e.message}`);
    }
  }

  throw new Error(`${label}: All providers failed (Cerebras + OpenRouter)`);
}

// Pre-loaded WinTech atoms from seed file — no scraping needed for sender
const WINTECH_SEED = (() => {
  try {
    const raw = require('./seed-wintech.json');
    return {
      target: { name: 'WinTech Partners', url: 'https://wintechpartners.com', role: 'sender' },
      summary: raw.summary,
      atoms: raw.atoms || [],
      source_url: 'wintechpartners.com',
      source: 'seed_file'
    };
  } catch (e) {
    console.error('Failed to load seed-wintech.json:', e.message);
    return { target: { name: 'WinTech Partners' }, summary: '', atoms: [], source_url: 'wintechpartners.com', source: 'seed_file' };
  }
})();
console.log(`   WinTech seed: ${WINTECH_SEED.atoms.length} atoms loaded`);

// ─── DEMO DOC SETS (multi-source atomize) ────────────────────────────────────
// Each company has 4 URLs to ingest. Pre-warmed at boot for instant demo runs.
const DEMO_DOCS = {
  'AIAIVN': [
    { url: 'https://www.aiaivn.com/', label: 'Homepage' },
    { url: 'https://www.aiaivn.com/about', label: 'About' },
    { url: 'https://www.aiaivn.com/services', label: 'Services' },
    { url: 'https://www.aiaivn.com/contact', label: 'Contact' }
  ],
  'Techcombank': [
    { url: 'https://www.techcombank.com.vn/', label: 'Homepage' },
    { url: 'https://www.techcombank.com.vn/personal-banking', label: 'Personal Banking' },
    { url: 'https://www.techcombank.com.vn/investors', label: 'Investors' },
    { url: 'https://www.techcombank.com.vn/about-us/press-media/news', label: 'News & Media' }
  ],
  'FPT Software': [
    { url: 'https://www.fpt-software.com/', label: 'Homepage' },
    { url: 'https://www.fpt-software.com/about-fpt-software/', label: 'About Us' },
    { url: 'https://www.fpt-software.com/service/', label: 'Services' },
    { url: 'https://www.fpt-software.com/newsroom/news/', label: 'News' }
  ]
};
const DOC_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#06b6d4'];

async function prewarmDemoDocs() {
  console.log('[PREWARM] Starting demo doc pre-warm...');
  for (const [company, docs] of Object.entries(DEMO_DOCS)) {
    for (const doc of docs) {
      try {
        const result = await ingestOne({ url: doc.url, role: 'customer', hint_name: company, demoMode: true });
        doc._cached = true;
        doc._atomCount = result.atoms?.length || 0;
        console.log(`[PREWARM] OK ${company} / ${doc.label}: ${doc._atomCount} atoms`);
      } catch (e) {
        doc._cached = false;
        console.log(`[PREWARM] SKIP ${company} / ${doc.label}: ${e.message}`);
      }
    }
  }
  console.log('[PREWARM] Complete.');
}

// ─── CPP (Communication Personality Profiles) ──────────────────────────────
// Each profile shapes HOW the TDE synthesis writes — same atoms, different voice.
const CPP_PROFILES = {
  steve: {
    name: 'Steve Winfield',
    title: 'Founder, WinTech Partners',
    label: 'The Educator',
    voice: `COMMUNICATION PERSONALITY — Steve Winfield (The Educator):

WRITING MECHANICS (non-negotiable):
- NEVER uses em dashes (—). Instead uses ellipsis (...) for pauses and parenthetical thoughts.
- Writes in short, punchy paragraphs. Rarely more than 3 sentences per paragraph.
- Uses "..." frequently to create natural conversational rhythm and trailing thoughts.
- Contractions always: "I'm", "we're", "don't", "it's", "you're" — never the formal version.
- Exclamation marks when genuinely excited, but not excessively.
- Sentence fragments are fine and encouraged. "Pretty simple." "Not even close." "Here's why."
- No semicolons. Ever.
- No bullet points or numbered lists in emails. Writes in flowing prose.

TONE AND APPROACH:
- Warm, direct, and confident. Speaks like a teacher who respects the student's intelligence.
- Conversational...like he's talking to you across a table, not writing a business document.
- Leads with a specific observation about the recipient that proves research depth. Not a compliment...an insight.
- Builds from "here's what I noticed about you" to "here's what that means" to "here's what we should do about it."
- References his 25 years in enterprise tech and time as a Texas public school teacher/principal naturally...never as a brag, always as proof of methodology.

VOCABULARY:
- Plain English, zero jargon unless the recipient uses it first.
- Says "here's the thing" and "let me be direct" and "look" and "the reality is."
- Avoids corporate buzzwords like "synergy", "leverage", "ecosystem", "paradigm."
- Prefers "we built this because" over "our solution enables."
- Uses "you" and "your" heavily...it's always about the recipient.

CLOSING STYLE:
- Proposes a specific next step with a reason...never a generic "let's hop on a call."
- Example: "I'd like to show you what your reseller data looks like after decomposition...20 minutes, and you'll know if this is worth pursuing."

WHAT HE NEVER DOES:
- Never uses em dashes. Uses ellipsis instead.
- Never flatters without substance.
- Never uses templated openings like "I hope this email finds you well."
- Never claims capabilities he can't demonstrate live.
- Never writes in a formal or corporate register.`
  },
  hormozi: {
    name: 'Alex Hormozi',
    title: 'CEO, Acquisition.com',
    label: 'The Closer',
    voice: `COMMUNICATION PERSONALITY — Alex Hormozi (The Closer):
- Tone: High-energy, brutally direct, zero fluff. Every sentence either delivers value or drives toward a decision. Speaks with the confidence of someone who has built and sold multiple $100M+ businesses.
- Structure: Opens with a provocative truth or counterintuitive insight that stops the reader. Quickly establishes credibility through specific outcomes ("we did X which resulted in Y"). Frames everything as "here's what you're leaving on the table" not "here's what we offer."
- Signature moves: Uses dollar amounts and percentages constantly. Reframes problems as "you're not lacking X, you're doing Y wrong." Makes the cost of inaction feel more painful than the cost of action. Compresses complex ideas into punchy one-liners.
- Vocabulary: Conversational and punchy. Short sentences. Sentence fragments for emphasis. Uses "Look," and "Here's the deal" and "The math is simple." Turns nouns into verbs. Says "print money" and "unlock" and "compound."
- Closing style: Creates urgency through logic, not pressure. "You can keep doing it the old way and get the same results, or we can show you in 15 minutes why that's costing you $X/month. Either way, the math doesn't change."
- What he NEVER does: Never apologizes for being direct. Never buries the lead. Never writes long paragraphs. If it takes more than 3 sentences to make a point, the point isn't clear enough. NEVER uses em dashes. Uses periods, commas, or sentence breaks instead.`
  },
  ninjio: {
    name: 'NINJIO',
    title: 'Cybersecurity Awareness',
    label: 'The Security Authority',
    voice: `COMMUNICATION PERSONALITY — NINJIO (The Security Authority):
- Tone: Authoritative, measured, and mission-driven. Speaks as a trusted security advisor, not a vendor. Balances urgency about threats with calm confidence in solutions. The voice of "we've seen this before and here's how you handle it."
- Structure: Opens by naming a specific, relevant threat or compliance gap the recipient faces. Grounds every claim in real-world incidents or regulatory requirements. Builds the case through risk quantification before presenting the solution. Always connects to business impact, not just technical risk.
- Signature moves: References specific threat vectors, compliance frameworks (SOC 2, ISO 27001, GDPR), and breach statistics. Uses "the question isn't if, it's when" framing. Positions security as a business enabler, not a cost center. Cites industry-specific attack patterns relevant to the recipient's vertical.
- Vocabulary: Professional and precise without being impenetrable. Uses security terminology accurately but explains impact in business terms. Says "attack surface" and "threat landscape" and "behavioral indicators." Avoids fear-mongering — prefers "exposure" to "vulnerability" and "resilience" to "defense."
- Closing style: Proposes a specific assessment or audit as the logical first step. "We typically start with a 30-minute behavioral threat assessment — it shows you exactly where your human attack surface is exposed and what it would cost you if someone exploited it tomorrow."
- What NINJIO NEVER does: Never oversimplifies threats. Never uses scare tactics without data. Never positions security as optional or negotiable. Never ignores the human element. Always connects technical threats to human behavior. NEVER uses em dashes. Uses periods, commas, or semicolons to separate clauses.`
  }
};

// Model IDs available through OpenRouter for the "standard" side
const COMPARISON_MODELS = {
  chatgpt: 'openai/gpt-4o',
  gemini:  'google/gemini-2.5-flash',
  claude:  'anthropic/claude-sonnet-4'
};

const COMPARISON_PROMPTS = {
  email: (companyName) => `You are a sales outreach specialist. Write a cold outreach email from Steve Winfield at WinTech Partners to ${companyName}.

WinTech Partners offers DRiX (Data Reimagined Experience), an AI-powered intelligence platform including content decomposition (TDE), voice profiling (CPP), relationship intelligence (TrueGraph), cybersecurity (Chimera Secured), and lead enrichment (DRiX Ready Lead).

Research ${companyName} and write a personalized, compelling outreach email that would get a response from a senior decision-maker. Include specific details about the target company and explain why WinTech's solutions are relevant to them.`,

  pitch: (companyName) => `You are a B2B sales strategist. Create a sales pitch for WinTech Partners' DRiX platform targeting ${companyName}.

WinTech Partners offers DRiX (Data Reimagined Experience) with: TDE (decomposition engine), CPP (voice profiling), TrueGraph (relationship intelligence), Chimera Secured (behavioral email security, $4/user/month), DRiX Ready Lead (batch lead enrichment), ClearSignals AI (sales coaching), DRiX Widgets (reseller mini-sites), and DRiX Agents (multichannel AI assistants).

The pitch should include an opening hook, value proposition, differentiation, and call to action. Make it specific to ${companyName} and their industry.`,

  partnership: (companyName) => `You are a business development analyst. Analyze the potential partnership between WinTech Partners and ${companyName}.

WinTech Partners is an AI product company founded by Steve Winfield (25yr enterprise tech, ex-Microsoft, CISSP). Their DRiX platform includes TDE, CPP, TrueGraph, Chimera Secured, DRiX Ready Lead, ClearSignals AI, DRiX Widgets, and DRiX Agents.

Provide: partnership model, synergies, specific value each side brings, risks, and recommended next steps. Be specific about how both companies' capabilities complement each other.`
};

const TDE_SYNTHESIS_PROMPT = `You are a sharp, opinionated sales strategist synthesizing a targeted sales output using ONLY the atomic intelligence units provided below.

VOICE AND QUALITY RULES (apply ALWAYS, even without a CPP voice profile):
- Write like a smart human who has spent a week studying this company, not like an AI generating a report.
- Lead with insight. Don't open with "Company X operates with a core mission of..." Start with what's INTERESTING or surprising.
- Vary sentence length. Mix short punchy observations with longer analytical ones.
- Be specific. Name products, tools, teams, numbers. "Leading provider of digital services" is useless. "Running 4 separate customer portals with no unified data layer" is useful.
- When describing pain points, be direct: "They're stuck doing X, which means Y" not "The organization faces challenges in..."
- When mapping WinTech capabilities, explain WHY it matters for THIS company. Don't describe the product generically.
- Cross-reference sender atoms with customer atoms to find specific overlaps.
- This should be dramatically more specific and targeted than what a generic AI would produce.

HARD FORMAT RULES:
- Every claim you make MUST come from the atoms provided. Do NOT invent facts.
- NEVER put atom IDs, bracket references, or citation markers inline in the text. The output must read as clean, professional copy with zero visible references.
- Do NOT use markdown formatting. Write in plain text with clear paragraph breaks.
- ABSOLUTE RULE: NEVER use em dashes anywhere in the output. Use periods, commas, ellipsis (...), or restructure the sentence instead. Zero exceptions.

SENDER ATOMS (WinTech Partners):
{SENDER_ATOMS}

CUSTOMER ATOMS ({CUSTOMER_NAME}):
{CUSTOMER_ATOMS}

TASK: {TASK_DESCRIPTION}

After writing the main output, add a section at the end labeled "---ATOMS_USED---" followed by a JSON array of EVERY atom_id whose content you drew on (from both sender and customer atoms). This is how we track provenance — keep it thorough. Example:
---ATOMS_USED---
["atom-id-1", "atom-id-2", "atom-id-3"]`;

const TDE_TASKS = {
  email: (customerName, writerName) => `Write a cold outreach email from ${writerName} at WinTech Partners to ${customerName}. The email should reference SPECIFIC facts about the customer that reveal you deeply understand their business — not generic compliments. Address the email to a specific person if a contact atom is available, otherwise to the most relevant persona. Include a specific, concrete proposal based on the overlap between WinTech's capabilities and the customer's needs or gaps.`,

  pitch: (customerName, writerName) => `Create a sales pitch from ${writerName} at WinTech Partners targeting ${customerName}. The pitch must reference specific customer pain points, gaps, or opportunities found in their atoms, and map specific WinTech products/capabilities to each one. Include concrete proof points and differentiation that come from the atoms, not generic value propositions.`,

  partnership: (customerName, writerName) => `Analyze the potential partnership between WinTech Partners and ${customerName}, written by ${writerName}. Use specific atoms from both sides to identify: concrete capability overlaps, specific gaps each side fills for the other, named team members and their relevant experience, specific products that complement each other, and honest risks or weaknesses from both sides' atoms. This should read like an analyst who has deeply studied both companies, not a template.`
};

app.post('/api/comparison', async (req, res) => {
  const { company_url, company_name, scenario, model, cpp } = req.body || {};

  if (!company_url || !scenario || !model) {
    return res.status(400).json({ error: 'Require company_url, scenario, model' });
  }
  if (!COMPARISON_MODELS[model]) {
    return res.status(400).json({ error: `Invalid model: ${model}. Use chatgpt, gemini, or claude.` });
  }
  if (!COMPARISON_PROMPTS[scenario]) {
    return res.status(400).json({ error: `Invalid scenario: ${scenario}. Use email, pitch, or partnership.` });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Server not configured — missing OPENROUTER_API_KEY' });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');
  res.flushHeaders?.();
  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  const displayName = company_name || company_url;
  const prompt = COMPARISON_PROMPTS[scenario](displayName);

  try {
    // ── STANDARD AI SIDE — fire and forget ──────────────────────────────
    send('standard_status', { message: `Sending prompt to ${model}...` });

    // Standard side fires independently and sends its result the moment it arrives
    const standardPromise = (async () => {
      try {
        console.log(`[comparison] Standard side: calling ${COMPARISON_MODELS[model]} via OpenRouter...`);
        const stdT0 = Date.now();
        const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.APP_URL || 'https://tde-demo.up.railway.app',
            'X-Title': 'TDE Comparison Demo'
          },
          body: JSON.stringify({
            model: COMPARISON_MODELS[model],
            messages: [
              { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 2000
          }),
          signal: AbortSignal.timeout(45000)
        }, { label: `Standard/${model}`, retries: 1, backoffMs: 2000 });
        // fetchWithRetry guarantees response.ok — errors already thrown
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || '(No response)';
        console.log(`[comparison] Standard side done: ${text.length} chars in ${Date.now() - stdT0}ms`);
        send('standard_done', { text });
        return text;
      } catch (e) {
        console.error(`[comparison] Standard side FAILED: ${e.message}`);
        send('standard_error', { message: e.message });
        throw e;
      }
    })();

    // ── TDE SIDE — full pipeline ────────────────────────────────────────
    send('tde_phase', { phase: 'fetch', message: `Fetching ${displayName}...` });

    // Ingest customer (live scrape + decompose, cached after first run)
    let customer;
    try {
      customer = await ingestOne({
        url: normUrl(company_url),
        role: 'customer',
        hint_name: company_name,
        demoMode: true
      });
    } catch (ingestErr) {
      send('tde_error', { message: `Customer ingest failed: ${ingestErr.message}` });
      await standardPromise.catch(() => {});
      send('done', {});
      clearInterval(keepAlive);
      return res.end();
    }

    // WinTech sender atoms — loaded from seed file (always available, no scraping)
    const sender = WINTECH_SEED;

    send('tde_phase', { phase: 'decompose', message: `Decomposed ${customer.atoms?.length || 0} customer atoms + ${sender.atoms?.length || 0} sender atoms` });

    // Build source provenance map
    const sourceMap = {};
    (customer.atoms || []).forEach(a => {
      const src = a.source_url || customer.source_url || company_url;
      if (!sourceMap[src]) sourceMap[src] = { url: src, name: customer.target?.name || displayName, role: 'customer', count: 0 };
      sourceMap[src].count++;
    });
    (sender.atoms || []).forEach(a => {
      const src = a.source_url || sender.source_url || 'wintechpartners.com';
      if (!sourceMap[src]) sourceMap[src] = { url: src, name: sender.target?.name || 'WinTech Partners', role: 'sender', count: 0 };
      sourceMap[src].count++;
    });

    send('tde_phase', { phase: 'tag', message: `All atoms tagged across 9 dimensions` });
    send('tde_phase', { phase: 'cross', message: `Cross-referencing ${Object.keys(sourceMap).length} sources...` });

    // Build synthesis prompt — generous atom budget now that Cerebras handles volume
    const MAX_SYNTH_ATOMS = 30;
    const senderAtomsForSynth = (sender.atoms || []).slice(0, MAX_SYNTH_ATOMS);
    const customerAtomsForSynth = (customer.atoms || []).slice(0, MAX_SYNTH_ATOMS);

    const truncClaim = (c) => c && c.length > 300 ? c.slice(0, 300) + '...' : (c || '');
    const senderAtomText = senderAtomsForSynth.map(a =>
      `[${a.atom_id || a.id || '?'}] (${a.type}) ${truncClaim(a.claim)}${a.evidence ? ' | Evidence: ' + truncClaim(a.evidence) : ''}`
    ).join('\n');

    const customerAtomText = customerAtomsForSynth.map(a =>
      `[${a.atom_id || a.id || '?'}] (${a.type}) ${truncClaim(a.claim)}${a.evidence ? ' | Evidence: ' + truncClaim(a.evidence) : ''}`
    ).join('\n');

    // Resolve CPP profile
    const cppProfile = CPP_PROFILES[cpp] || CPP_PROFILES.steve;
    const writerName = cppProfile.name;
    const taskDesc = TDE_TASKS[scenario](customer.target?.name || displayName, writerName);

    // Build synthesis prompt — CPP voice goes FIRST so it's treated as a primary constraint
    const cppBlock = `WRITER VOICE PROFILE (CPP — Communication Personality Profile):
You MUST write the ENTIRE output in the voice and style described below. This is the HIGHEST PRIORITY instruction. Every sentence, every word choice, every punctuation mark must match this person's writing style. If the voice profile says "never use em dashes" then there must be ZERO em dashes in your output.

${cppProfile.voice}

---END OF VOICE PROFILE---
Now, using that exact voice, complete the following task using ONLY the atoms provided:`;

    let synthesisPrompt = cppBlock + '\n\n' + TDE_SYNTHESIS_PROMPT
      .replace('{SENDER_ATOMS}', senderAtomText)
      .replace('{CUSTOMER_NAME}', customer.target?.name || displayName)
      .replace('{CUSTOMER_ATOMS}', customerAtomText)
      .replace('{TASK_DESCRIPTION}', taskDesc);

    const totalSynthAtoms = senderAtomsForSynth.length + customerAtomsForSynth.length;
    send('tde_phase', { phase: 'cpp', message: `Applying ${cppProfile.label} voice profile (${writerName})...` });
    send('tde_phase', { phase: 'synthesize', message: `Synthesizing from ${totalSynthAtoms} atoms as ${writerName}...` });

    // Cerebras direct (~2000 tok/s) with OpenRouter fallback
    const useCerebras = !!CEREBRAS_API_KEY;
    const synthUrl = useCerebras
      ? 'https://api.cerebras.ai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const synthModel = useCerebras ? 'gpt-oss-120b' : 'google/gemini-2.5-flash';
    const synthHeaders = useCerebras
      ? { 'Authorization': `Bearer ${CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' }
      : { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://tde-demo.up.railway.app', 'X-Title': 'TDE Comparison Synthesis' };

    console.log(`[comparison] Synthesis via ${useCerebras ? 'Cerebras direct' : 'OpenRouter'}: ${synthModel}, prompt ~${synthesisPrompt.length} chars`);
    const synthT0 = Date.now();

    let synthesisText = '';
    try {
      const synthesisResponse = await fetchWithRetry(synthUrl, {
        method: 'POST',
        headers: synthHeaders,
        body: JSON.stringify({
          model: synthModel,
          messages: [
            { role: 'user', content: synthesisPrompt }
          ],
          temperature: 0.4,
          max_tokens: 3000
        }),
        signal: AbortSignal.timeout(30000)
      }, { label: `Synthesis/${synthModel}`, retries: 1, backoffMs: 1500 });

      console.log(`[comparison] Synthesis response: ${synthesisResponse.status} in ${Date.now() - synthT0}ms`);
      // fetchWithRetry guarantees response.ok — errors already thrown
      const synthesisData = await synthesisResponse.json();
      synthesisText = synthesisData?.choices?.[0]?.message?.content || '';
      console.log(`[comparison] Synthesis done: ${synthesisText.length} chars in ${Date.now() - synthT0}ms`);

      if (!synthesisText) {
        throw new Error('Empty synthesis response from LLM');
      }
    } catch (synthErr) {
      console.error(`[comparison] Synthesis failed: ${synthErr.message}`);
      throw new Error(`Synthesis failed: ${synthErr.message}`);
    }

    // Nuclear em-dash removal — no matter what the LLM does, strip them
    synthesisText = synthesisText.replace(/—/g, '...').replace(/–/g, ', ');

    // Parse out the atoms_used section
    let atomsUsedIds = [];
    const atomsSplit = synthesisText.split('---ATOMS_USED---');
    if (atomsSplit.length > 1) {
      synthesisText = atomsSplit[0].trim();
      try {
        atomsUsedIds = JSON.parse(atomsSplit[1].trim());
      } catch {}
    }

    // Find the actual atom objects that were used
    const allAtoms = [...senderAtomsForSynth, ...customerAtomsForSynth];
    const senderIds = new Set((sender.atoms || []).map(a => a.atom_id || a.id));
    const atomsUsed = atomsUsedIds.length > 0
      ? allAtoms.filter(a => atomsUsedIds.includes(a.atom_id || a.id))
      : allAtoms.slice(0, 8); // fallback: show first 8 if parsing failed

    // Send TDE result with atoms and source provenance
    send('tde_done', {
      text: synthesisText,
      atoms_used: atomsUsed.map(a => {
        const isSender = senderIds.has(a.atom_id || a.id);
        return {
        atom_id: a.atom_id || a.id,
        type: a.type,
        claim: a.claim,
        evidence: a.evidence,
        confidence: a.confidence,
        source_url: a.source_url || (isSender ? (sender.source_url || 'wintechpartners.com') : (customer.source_url || company_url)),
        source_name: isSender ? (sender.target?.name || 'WinTech Partners') : (customer.target?.name || displayName),
        source_role: isSender ? 'sender' : 'customer',
        d_persona: a.d_persona,
        d_buying_stage: a.d_buying_stage,
        d_emotional_driver: a.d_emotional_driver,
        d_evidence_type: a.d_evidence_type,
        d_credibility: a.d_credibility,
        d_recency: a.d_recency,
        d_economic_driver: a.d_economic_driver,
        d_status_quo_pressure: a.d_status_quo_pressure,
        d_industry: a.d_industry
      };}),
      sources: Object.values(sourceMap),
      total_atoms: allAtoms.length,
      cpp: { key: cpp || 'steve', name: cppProfile.name, label: cppProfile.label, title: cppProfile.title }
    });

    // Wait for standard side to finish (it sends its own events, just need to not close SSE early)
    await standardPromise.catch(() => {});

    send('done', {});

  } catch (err) {
    console.error('[comparison]', err.message);
    send('tde_error', { message: err.message });
    // Standard side sends its own events, just make sure it finishes
    if (typeof standardPromise !== 'undefined') await standardPromise.catch(() => {});
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ─── ATOMIZE ENDPOINT (multi-doc Chunking vs DRiX decomposition) ─────────────

app.post('/api/atomize', async (req, res) => {
  const { company_name } = req.body || {};

  const docs = DEMO_DOCS[company_name];
  if (!docs) {
    return res.status(400).json({ error: `Unknown company: ${company_name}. Use: ${Object.keys(DEMO_DOCS).join(', ')}` });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');
  res.flushHeaders?.();
  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 15000);
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  try {
    // ── STEP 1: Send source list with colors ──
    const sources = docs.map((d, i) => ({
      index: i, url: d.url, label: d.label, color: DOC_COLORS[i]
    }));
    send('sources', { sources });

    // ── STEP 2: Fetch raw text from all docs (for soup visual) ──
    send('phase', { step: 'fetch', message: `Fetching ${docs.length} pages from ${company_name}...` });

    const fetchResults = await Promise.allSettled(
      docs.map(d => fetchAndStrip(d.url))
    );

    const fetched = [];
    for (let i = 0; i < fetchResults.length; i++) {
      if (fetchResults[i].status === 'fulfilled' && fetchResults[i].value?.text?.length > 100) {
        fetched.push({
          index: i,
          label: docs[i].label,
          url: docs[i].url,
          color: DOC_COLORS[i],
          text: fetchResults[i].value.text,
          title: fetchResults[i].value.title || docs[i].label
        });
      } else {
        console.log(`[atomize] Skip ${docs[i].label}: ${fetchResults[i].reason?.message || 'too little content'}`);
      }
    }

    if (fetched.length < 2) {
      throw new Error(`Only ${fetched.length} doc(s) had enough content. Need at least 2.`);
    }

    // Confirm which sources actually worked
    send('sources_final', {
      sources: fetched.map(f => ({ index: f.index, label: f.label, color: f.color, chars: f.text.length }))
    });

    // ── STEP 3: CHUNK SIDE — concatenate into soup, then split ──
    send('phase', { step: 'soup', message: `${fetched.length} pages fetched. Building the soup...` });

    // Clean raw text for display — strip URLs, image refs, markdown artifacts
    function cleanForDisplay(text) {
      return text
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')            // markdown images
        .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, '$1')  // markdown links
        .replace(/https?:\/\/\S+/g, '')                       // bare URLs
        .replace(/\{[^}]*\}/g, '')                             // curly brace artifacts
        .replace(/\|[|\s-]+\|/g, '')                           // markdown table borders
        .replace(/[*#]{2,}/g, '')                              // markdown bold/heading markers
        .replace(/\s{3,}/g, '  ')                              // collapse whitespace
        .replace(/\n{3,}/g, '\n\n')                            // collapse newlines
        .trim();
    }

    const soupText = fetched.map(f => cleanForDisplay(f.text)).join('\n\n');
    send('soup', {
      text: soupText.slice(0, 3000),
      total_chars: soupText.length,
      doc_count: fetched.length
    });

    send('phase', { step: 'chunking', message: 'Splitting soup into arbitrary chunks...' });

    // Split soup into 4-6 chunks at arbitrary boundaries
    let paragraphs = soupText.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 80);
    if (paragraphs.length < 4) {
      const sentences = soupText.match(/[^.!?]+[.!?]+/g) || [soupText];
      const chunkSize = Math.ceil(sentences.length / 5);
      paragraphs = [];
      for (let i = 0; i < sentences.length; i += chunkSize) {
        paragraphs.push(sentences.slice(i, i + chunkSize).join(' ').trim());
      }
    }
    if (paragraphs.length > 6) {
      const merged = [];
      const mergeSize = Math.ceil(paragraphs.length / 6);
      for (let i = 0; i < paragraphs.length; i += mergeSize) {
        merged.push(paragraphs.slice(i, i + mergeSize).join('\n\n'));
      }
      paragraphs = merged;
    }

    const chunks = paragraphs.map((text, i) => ({
      id: `chunk-${i}`, index: i, text: text.slice(0, 600), char_count: text.length
    }));

    send('chunks', { chunks, total: chunks.length });

    // ── STEP 4: DRiX SIDE — real decomposition from all docs ──
    send('phase', { step: 'decompose', message: `DRiX: Decomposing ${fetched.length} sources into atomic claims...` });

    const allAtoms = [];
    for (let fi = 0; fi < fetched.length; fi++) {
      const f = fetched[fi];
      try {
        const result = await ingestOne({
          url: f.url, role: 'customer', hint_name: company_name, demoMode: true
        });
        const docAtoms = (result.atoms || []).map(a => ({
          atom_id: a.atom_id || a.id,
          type: a.type, claim: a.claim, evidence: a.evidence, confidence: a.confidence,
          tags: a.tags || [],
          d_persona: a.d_persona, d_buying_stage: a.d_buying_stage,
          d_emotional_driver: a.d_emotional_driver, d_evidence_type: a.d_evidence_type,
          d_credibility: a.d_credibility, d_recency: a.d_recency,
          d_economic_driver: a.d_economic_driver, d_status_quo_pressure: a.d_status_quo_pressure,
          d_industry: a.d_industry,
          source_index: f.index,
          source_label: f.label,
          source_color: f.color
        }));
        allAtoms.push(...docAtoms);
        send('phase', { step: 'decompose_progress', message: `Source ${fi + 1}/${fetched.length}: ${docAtoms.length} atoms from ${f.label}` });
      } catch (e) {
        console.log(`[atomize] Ingest failed for ${f.label}: ${e.message}`);
        send('phase', { step: 'decompose_progress', message: `Source ${fi + 1}/${fetched.length}: ${f.label} skipped` });
      }
    }

    send('atoms', {
      atoms: allAtoms, total: allAtoms.length,
      by_source: fetched.map(f => ({
        index: f.index, label: f.label, color: f.color,
        count: allAtoms.filter(a => a.source_index === f.index).length
      }))
    });

    // ── STEP 5: Cross-reference with WinTech atoms ──
    send('phase', { step: 'cross_ref', message: `Cross-referencing ${allAtoms.length} customer atoms with ${WINTECH_SEED.atoms.length} WinTech atoms...` });

    const crossRefs = [];
    const senderAtoms = WINTECH_SEED.atoms || [];
    for (const custAtom of allAtoms.slice(0, 30)) {
      for (const sendAtom of senderAtoms) {
        const tagOverlap = (custAtom.tags || []).filter(t => (sendAtom.tags || []).includes(t));
        if (tagOverlap.length >= 2) {
          crossRefs.push({
            customer_atom: custAtom.atom_id,
            customer_claim: custAtom.claim,
            customer_source: custAtom.source_label,
            customer_color: custAtom.source_color,
            sender_atom: sendAtom.atom_id,
            sender_claim: sendAtom.claim,
            match_type: 'shared tags',
            shared_tags: tagOverlap
          });
          break;
        }
      }
    }

    send('cross_refs', {
      refs: crossRefs.slice(0, 10),
      total_checked: allAtoms.length * senderAtoms.length
    });

    // ── STEP 6: Parallel synthesis — chunks vs atoms ──
    send('phase', { step: 'synthesize', message: 'Synthesizing outputs from both sides...' });

    const sourceLabels = fetched.map(f => `Source ${f.index}: ${f.label} (${f.url})`).join('\n');

    // CHUNK SIDE: standard LLM gets the soup chunks, no structure
    const chunkPrompt = `You are a sales rep preparing for a call with ${company_name}. You were given these text chunks scraped from their website. Write a sales brief covering what this company does and how you might sell to them.

${chunks.map((c, i) => `--- Chunk ${i + 1} ---\n${c.text}`).join('\n\n')}

Write 3-4 paragraphs. Be specific where you can. You have NO source attribution ... all chunks are anonymous text blobs with no structure or tagging.`;

    // ATOM SIDE: DRiX synthesis with source attribution markers
    const sourceSlots = fetched.map(f => `{{S${f.index}}}...{{/S${f.index}}} = ${f.label}`).join('\n');

    const atomSynthPrompt = `You are a sharp, opinionated sales strategist at WinTech Partners. You have structured atomic intelligence about ${company_name} extracted from ${fetched.length} source documents, cross-referenced against WinTech's own capabilities. Your job is to write a brief that a sales rep can read in 2 minutes and walk into a meeting sounding like they've studied this company for a week.

CRITICAL WRITING RULES:
- Write like a smart human, not a corporate brochure. Vary sentence length. Use short punchy observations. Be specific.
- Lead with insight, not summaries. Don't start with "Company X operates with a core mission of..." — start with what's INTERESTING.
- Name specific products, tools, teams, numbers. Vague claims like "leading provider" are useless without specifics.
- The pain points section should feel like you've found where it hurts. Be direct: "They're stuck doing X, which means Y."
- When mapping WinTech capabilities, explain WHY it matters for THIS company, not what the product does generically.
- NEVER use em dashes. Use periods, commas, or ellipsis (...) instead. Zero exceptions.
- Do NOT use markdown formatting. Plain text with paragraph breaks only.
- Do NOT include atom IDs, brackets, or source numbers in the readable text.
- Every claim must come from the atoms below. Do NOT invent facts.

SOURCES:
${sourceLabels}

CUSTOMER ATOMS (${allAtoms.length} total):
${allAtoms.slice(0, 40).map(a => `[S${a.source_index}] (${a.type}) ${a.claim}`).join('\n')}

WINTECH CAPABILITY ATOMS:
${senderAtoms.slice(0, 15).map(a => `[WT] (${a.type}) ${a.claim}`).join('\n')}

CROSS-REFERENCES (customer need <-> WinTech capability):
${crossRefs.slice(0, 5).map(r => `${r.customer_claim} <-> ${r.sender_claim}`).join('\n')}

Write 4 paragraphs:
1. What makes this company tick — their angle, their bet, what they're building toward. Make it specific.
2. Where it hurts — pain points, friction, gaps in their current approach. Be direct about what's broken or missing.
3. The WinTech play — map specific DRiX capabilities to their specific problems. Use the cross-references. Explain the "so what."
4. How to open the conversation — not generic "propose a pilot" language. Give the rep a concrete hook and a reason the prospect would take the meeting.

SOURCE ATTRIBUTION (invisible to reader, used for provenance highlighting):
Wrap each sentence with the source marker it came from:
${sourceSlots}
{{WT}}...{{/WT}} = WinTech intelligence

Example: {{S0}}They're running separate portals for retail and corporate, which means duplicate content and fragmented analytics.{{/S0}} {{WT}}TDE can ingest both portals and surface the overlaps they're missing.{{/WT}}

EVERY sentence must be wrapped in exactly ONE marker. If a sentence blends sources, use the primary one.`;

    // ── CHUNK SIDE: OpenRouter only (slower "normal AI") ──
    // Try primary model, fallback to a second model if it fails
    const CHUNK_MODELS = ['google/gemini-2.5-flash', 'anthropic/claude-sonnet-4', 'meta-llama/llama-4-maverick'];

    async function chunkSynthesize() {
      for (const model of CHUNK_MODELS) {
        try {
          const resp = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': process.env.APP_URL || 'https://tde-demo.up.railway.app',
              'X-Title': 'DRiX Atomize - Chunk Side'
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: chunkPrompt }],
              temperature: 0.7, max_tokens: 2000
            }),
            signal: AbortSignal.timeout(50000)
          }, { label: `ChunkSynth/${model}`, retries: 2, backoffMs: 3000 });
          const data = await resp.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text) {
            console.log(`[ChunkSynth] OK via ${model} (${text.length} chars)`);
            return text;
          }
        } catch (e) {
          console.warn(`[ChunkSynth] ${model} failed: ${e.message}, trying next...`);
        }
      }
      throw new Error('All chunk models failed');
    }

    // ── ATOM SIDE: Cerebras ALWAYS (fast TDE), OpenRouter fallback ──
    async function atomSynthesize() {
      return synthesizeWithFallback(atomSynthPrompt, {
        label: 'AtomSynth', temperature: 0.4, max_tokens: 2500
      }).then(text => text.replace(/—/g, '...').replace(/–/g, ', '));
    }

    const [chunkResult, atomResult] = await Promise.allSettled([
      chunkSynthesize(),
      atomSynthesize()
    ]);

    if (chunkResult.status === 'fulfilled') {
      send('chunk_synthesis', { text: chunkResult.value });
    } else {
      send('chunk_synthesis', { text: `(Chunk synthesis failed: ${chunkResult.reason?.message || 'unknown'})` });
    }

    if (atomResult.status === 'fulfilled') {
      send('atom_synthesis', { text: atomResult.value });
    } else {
      send('atom_synthesis', { text: `(Atom synthesis failed: ${atomResult.reason?.message || 'unknown'})` });
    }

    // ── STEP 7: Blind spots detection ──
    // A blind spot = an atom whose KEY CONCEPT is absent from the chunk synthesis.
    // We use distinctive words (>5 chars, not stopwords) and require that fewer than
    // 30% of them appear in the chunk output. This catches facts the chunks lost.
    const chunkText = chunkResult.status === 'fulfilled' ? chunkResult.value.toLowerCase() : '';
    const stopWords = new Set(['about','which','their','these','those','where','would','could','should',
      'being','other','after','before','through','between','during','against','under','there','having']);
    const blindSpots = [];
    if (chunkText) {
      for (const atom of allAtoms) {
        const distinctWords = atom.claim.toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 5 && !stopWords.has(w))
          .map(w => w.replace(/[^a-z0-9]/g, ''));
        if (distinctWords.length < 2) continue;
        const matched = distinctWords.filter(w => chunkText.includes(w)).length;
        const matchPct = matched / distinctWords.length;
        // If fewer than 30% of distinctive words found, it's a blind spot
        if (matchPct < 0.3 && atom.claim.length > 30) {
          blindSpots.push({
            claim: atom.claim, type: atom.type,
            source_index: atom.source_index,
            source_label: atom.source_label,
            source_color: atom.source_color
          });
        }
      }
    }

    send('blind_spots', {
      spots: blindSpots.slice(0, 8),
      total_missed: blindSpots.length,
      total_atoms: allAtoms.length,
      pct_missed: allAtoms.length ? Math.round(blindSpots.length / allAtoms.length * 100) : 0
    });

    send('done', {});

  } catch (err) {
    console.error('[atomize]', err.message);
    send('error', { message: err.message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ DRiX Demo v3 listening on port ${PORT}`);
  console.log(`   model: ${OPENROUTER_MODEL_ID}`);
  console.log(`   drix-ready-lead: ${LEADHYDRATION_URL || '(not configured)'}`);
  console.log(`   database: ${db.isConfigured() ? 'connected' : '(not configured — set DATABASE_URL)'}`);
  console.log(`   voice-coach: ${ELEVENLABS_API_KEY ? 'enabled' : '(not configured — set ELEVENLABS_API_KEY)'}`);
  if (db.isConfigured()) await db.initSchema();
  // Pre-warm demo docs in background (non-blocking)
  prewarmDemoDocs().catch(e => console.error('[PREWARM] error:', e.message));
});
