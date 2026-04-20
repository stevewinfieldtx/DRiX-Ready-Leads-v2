// server.js — TDE Demo v2 (live-ingest edition)
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';

if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY not set.');

const atomStore = new Map();

try {
  const seedPath = path.join(__dirname, 'seed-aiaivn.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    atomStore.set('aiaivn', seed);
    console.log(`✅ Pre-seeded AIAIVN: ${seed.atoms.length} atoms`);
  }
  const wintechPath = path.join(__dirname, 'seed-wintech.json');
  if (fs.existsSync(wintechPath)) {
    const wt = JSON.parse(fs.readFileSync(wintechPath, 'utf8'));
    atomStore.set('wintech', wt);
    console.log(`✅ Pre-seeded WinTech: ${wt.atoms.length} atoms`);
  }
} catch (e) {
  console.warn('Seed load skipped:', e.message);
}

const INGEST_PROMPT = `You are the ingest phase of TDE (Targeted Decomposition Engine).

INPUT: raw content about a company (scraped web pages, About pages, etc.).

TASK: decompose into ATOMIC RETRIEVABLE UNITS. Each atom is a single, self-contained fact.

ATOM TYPES:
  "mission", "product", "icp", "proof_point", "team", "stack_signal",
  "buying_trigger", "differentiator", "partnership", "contact", "weakness", "mission_gap"

SCHEMA per atom:
  {
    "atom_id": "<kebab-case unique id>",
    "type": "<one of above>",
    "claim": "<one clear sentence>",
    "evidence": "<paraphrase from source, max 20 words, YOUR words not a direct quote>",
    "tags": ["<3-6 lowercase tags>"],
    "confidence": "high" | "medium" | "low",
    "audience_relevance": {
      "technical_buyer": 0-10, "business_buyer": 0-10,
      "investor": 0-10, "partner": 0-10, "general": 0-10
    }
  }

OUTPUT (JSON only):
  {
    "target": { "name": "<entity name>", "url": "<url>" },
    "summary": "<2-3 sentence positioning paragraph>",
    "atoms": [ 12-25 atoms ]
  }

DISCIPLINE:
- 12-25 atoms. Each stands alone. Don't invent.
- "mission_gap" atoms — flag when stated mission is broader than current offering.
- Evidence = paraphrase, NOT a direct quote.`;

const RECONSTRUCT_PROMPT = `You are the reconstruct phase of TDE.

INPUT: summary, atoms, recipient_intent, output_format, sender_context

TASK: pick 4-8 most relevant atoms. Compose in the requested format.

DISCIPLINE:
- Weave atoms into natural prose. Don't bullet-list them.
- Include specifics. Vague output is a failure.
- Email = 4-6 short paragraphs with subject line.

OUTPUT (JSON only):
  {
    "output_format": "<echo>",
    "composed": { "subject": "<if email>", "body": "<the output>" },
    "atoms_used": ["<atom_id>", ...],
    "reasoning": "<1-2 sentences: why these atoms>"
  }`;

const ANGLES_PROMPT = `You are the engagement-angle generator of TDE.

INPUT: target_summary + target_atoms, seller_name, seller_company, solution_name, solution_description, optional seller_atoms, context.

TASK: identify 3-4 specific, concrete ways the seller's solution could help this target.

EACH ANGLE MUST:
1. Reference specific atoms from the target (pain, trigger, gap, weakness, stack, mission).
2. Tie explicitly to capabilities of the named solution — not generic "AI" or "consulting."
3. Be actionable in 30-90 days — no abstract "strategic partnership."
4. Propose a first step requiring minimal cash/commitment from the target.

DISCIPLINE:
- Be specific. "AI for banking" is bad. "Real-time multilingual translation at their 3 flagship branches for international private-banking clients" is good.
- Reference atom types (mission_gap, weakness, buying_trigger are especially valuable).
- If an angle needs a capability the solution plainly doesn't have, SKIP IT.

OUTPUT (JSON only):
  {
    "target_name": "<echo>",
    "seller_label": "<seller_company or seller_name — short label to display>",
    "solution_label": "<solution_name — short label to display>",
    "angles": [
      {
        "title": "<crisp name>",
        "thesis": "<one-sentence why>",
        "seller_contribution": "<what the seller/seller_company brings — relationship, delivery, context>",
        "solution_contribution": "<specific capability of the solution>",
        "target_pain_addressed": "<specific atom or pattern>",
        "first_step": "<concrete 30-day low-cash proposal>",
        "confidence": "high" | "medium" | "low"
      }
    ],
    "top_pick": "<title of your lead angle, one sentence reasoning>"
  }`;

const INDUSTRY_PROFILE_PROMPT = `You are the target-profile synthesizer of TDE.

INPUT: an industry/segment description (e.g. "Regional banks in Southeast Asia", "DTC pet-food brands", "Mid-market manufacturers in the US Midwest").

TASK: synthesize a REPRESENTATIVE target profile for that industry — the kind of atoms you'd expect from decomposing a real company in the segment. Make it plausible, specific, and useful for generating engagement angles. Label it clearly as a synthetic industry archetype, not a real company.

ATOM TYPES (same as ingest):
  "mission", "product", "icp", "proof_point", "team", "stack_signal",
  "buying_trigger", "differentiator", "partnership", "contact", "weakness", "mission_gap"

SCHEMA per atom (same as ingest):
  {
    "atom_id": "<kebab-case unique id>",
    "type": "<one of above>",
    "claim": "<one clear sentence>",
    "evidence": "<why this is typical of the segment, max 20 words>",
    "tags": ["<3-6 lowercase tags>"],
    "confidence": "high" | "medium" | "low",
    "audience_relevance": {
      "technical_buyer": 0-10, "business_buyer": 0-10,
      "investor": 0-10, "partner": 0-10, "general": 0-10
    }
  }

OUTPUT (JSON only):
  {
    "target": { "name": "<e.g. 'Archetype: Regional Bank (SE Asia)'>", "url": null, "is_archetype": true, "industry": "<echo input>" },
    "summary": "<2-3 sentence positioning paragraph describing the typical company in this segment>",
    "atoms": [ 12-20 atoms — typical patterns for this industry ]
  }

DISCIPLINE:
- Atoms should reflect what's COMMONLY true for companies in this industry, not a specific named company.
- Include pain points and mission_gaps that would be genuinely addressable by a range of solutions.
- Be industry-specific. Don't generate generic "they want to grow revenue" atoms.`;

async function callLLM(systemPrompt, userContent, { maxTokens = 4500, temperature = 0.3 } = {}) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://tde-demo.wintechpartners.com',
      'X-Title': 'TDE Demo'
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

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'target';
}

async function fetchAndStrip(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TDEDemo/1.0; +https://wintechpartners.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const html = await res.text();

    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const description = descMatch ? descMatch[1].trim() : null;

    return { url, title, description, text: cleaned.slice(0, 40000) };
  } catch (e) {
    throw new Error(`Fetch error: ${e.message}`);
  }
}

// ============================================================================
// ENDPOINTS
// ============================================================================
app.get('/api/atoms', (_req, res) => {
  const list = Array.from(atomStore.entries())
    .filter(([id]) => id !== 'wintech')
    .map(([id, v]) => ({
      target_id: id,
      name: v.target?.name || id,
      url: v.target?.url,
      atom_count: v.atoms?.length || 0,
      ingested_at: v.ingested_at
    }));
  res.json({ targets: list });
});

app.get('/api/atoms/:id', (req, res) => {
  const entry = atomStore.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

app.post('/api/ingest', async (req, res) => {
  const { target_name, target_url, content } = req.body || {};
  if (!content || typeof content !== 'string' || content.length < 100) {
    return res.status(400).json({ error: 'Provide content (string, min 100 chars)' });
  }
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const userContent = JSON.stringify({
      target_name: target_name || 'unknown',
      target_url: target_url || 'unknown',
      content: content.slice(0, 50000)
    });
    const parsed = await callLLM(INGEST_PROMPT, userContent, { maxTokens: 6000 });
    if (!parsed?.atoms?.length) return res.status(502).json({ error: 'LLM returned no atoms' });

    const target_id = slugify(parsed.target?.name || target_name || 'target');
    const entry = {
      target: parsed.target,
      summary: parsed.summary,
      atoms: parsed.atoms,
      ingested_at: new Date().toISOString()
    };
    atomStore.set(target_id, entry);
    res.json({ target_id, ...entry });
  } catch (err) {
    console.error('[ingest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ingest-url', async (req, res) => {
  const { url, hint_name } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Provide url' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const fetched = await fetchAndStrip(url);
    if (!fetched.text || fetched.text.length < 200) {
      return res.status(422).json({ error: 'Fetched page had too little text content.' });
    }

    const userContent = JSON.stringify({
      target_name: hint_name || fetched.title || 'unknown',
      target_url: url,
      content: `PAGE TITLE: ${fetched.title || ''}\nMETA DESCRIPTION: ${fetched.description || ''}\n\n${fetched.text}`
    });

    const parsed = await callLLM(INGEST_PROMPT, userContent, { maxTokens: 6000 });
    if (!parsed?.atoms?.length) return res.status(502).json({ error: 'LLM returned no atoms' });

    const target_id = slugify(parsed.target?.name || hint_name || 'target');
    const entry = {
      target: parsed.target,
      summary: parsed.summary,
      atoms: parsed.atoms,
      ingested_at: new Date().toISOString(),
      source_url: url
    };
    atomStore.set(target_id, entry);
    res.json({ target_id, ...entry });
  } catch (err) {
    console.error('[ingest-url]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reconstruct', async (req, res) => {
  const { target_id, recipient_intent, output_format, sender_context } = req.body || {};
  if (!target_id || !recipient_intent) return res.status(400).json({ error: 'Require target_id and recipient_intent' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const entry = atomStore.get(target_id);
  if (!entry) return res.status(404).json({ error: `No atoms for target_id: ${target_id}` });

  try {
    const userContent = JSON.stringify({
      summary: entry.summary,
      atoms: entry.atoms,
      recipient_intent,
      output_format: output_format || 'email',
      sender_context: sender_context || 'Salesperson (provide sender_context for better results)'
    });
    const parsed = await callLLM(RECONSTRUCT_PROMPT, userContent, { maxTokens: 2500 });
    if (!parsed?.composed?.body) return res.status(502).json({ error: 'LLM returned no output' });
    res.json(parsed);
  } catch (err) {
    console.error('[reconstruct]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/angles', async (req, res) => {
  const { target_id, context } = req.body || {};
  if (!target_id) return res.status(400).json({ error: 'Require target_id' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const target = atomStore.get(target_id);
  if (!target) return res.status(404).json({ error: `No atoms for target_id: ${target_id}` });

  const wintech = atomStore.get('wintech');
  const aiaivn = atomStore.get('aiaivn');
  if (!wintech || !aiaivn) return res.status(500).json({ error: 'WinTech/AIAIVN atoms not loaded' });

  try {
    const userContent = JSON.stringify({
      target_name: target.target?.name || target_id,
      target_summary: target.summary,
      target_atoms: target.atoms,
      wintech_summary: wintech.summary,
      wintech_atoms: wintech.atoms,
      aiaivn_summary: aiaivn.summary,
      aiaivn_atoms: aiaivn.atoms,
      context: context || 'First-touch outreach — warm, specific reason to talk.'
    });
    const parsed = await callLLM(ANGLES_PROMPT, userContent, { maxTokens: 3500 });
    if (!parsed?.angles?.length) return res.status(502).json({ error: 'LLM returned no angles' });
    res.json(parsed);
  } catch (err) {
    console.error('[angles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full streaming demo: (fetch URL OR synthesize industry) → atoms → angles → email
app.post('/api/demo-flow', async (req, res) => {
  const {
    url,
    industry,
    hint_name,
    recipient_role,
    salesperson,
    sender_company,
    solution
  } = req.body || {};

  if (!url && !industry) return res.status(400).json({ error: 'Require either url or industry' });
  if (!salesperson) return res.status(400).json({ error: 'Require salesperson' });
  if (!solution) return res.status(400).json({ error: 'Require solution' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sellerLabel = sender_company && sender_company.trim()
    ? sender_company.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
    : salesperson;
  const solutionLabel = solution.length > 40 ? solution.slice(0, 40) + '…' : solution;

  try {
    let entry, target_id;

    if (url) {
      // URL MODE: fetch + decompose real page
      send('phase', { phase: 'fetch', message: `Fetching ${url}…` });
      const fetched = await fetchAndStrip(url);
      send('phase', { phase: 'fetch', message: `Retrieved ${fetched.text.length.toLocaleString()} chars`, chars: fetched.text.length });

      send('phase', { phase: 'ingest', message: 'Decomposing into atoms…' });
      const ingestUserContent = JSON.stringify({
        target_name: hint_name || fetched.title || 'unknown',
        target_url: url,
        content: `PAGE TITLE: ${fetched.title || ''}\nMETA DESCRIPTION: ${fetched.description || ''}\n\n${fetched.text}`
      });
      const ingested = await callLLM(INGEST_PROMPT, ingestUserContent, { maxTokens: 6000 });
      if (!ingested?.atoms?.length) throw new Error('Ingest returned no atoms');

      target_id = slugify(ingested.target?.name || hint_name || 'target');
      entry = {
        target: ingested.target,
        summary: ingested.summary,
        atoms: ingested.atoms,
        ingested_at: new Date().toISOString(),
        source_url: url
      };
    } else {
      // INDUSTRY MODE: synthesize archetype target
      send('phase', { phase: 'fetch', message: `Synthesizing industry archetype: ${industry}…` });
      const profileUserContent = JSON.stringify({ industry });
      const profile = await callLLM(INDUSTRY_PROFILE_PROMPT, profileUserContent, { maxTokens: 5000 });
      if (!profile?.atoms?.length) throw new Error('Industry synthesis returned no atoms');
      send('phase', { phase: 'fetch', message: `Synthesized archetype for "${industry}"` });

      send('phase', { phase: 'ingest', message: 'Archetype atoms ready…' });
      target_id = slugify(profile.target?.name || industry);
      entry = {
        target: { ...profile.target, industry },
        summary: profile.summary,
        atoms: profile.atoms,
        ingested_at: new Date().toISOString(),
        industry,
        is_archetype: true
      };
    }

    atomStore.set(target_id, entry);
    send('atoms', { target_id, ...entry });

    // ========= ANGLES =========
    send('phase', { phase: 'angles', message: `Generating engagement angles for ${entry.target?.name}…` });

    const anglesUserContent = JSON.stringify({
      target_name: entry.target?.name || target_id,
      target_summary: entry.summary,
      target_atoms: entry.atoms,
      seller_name: salesperson,
      seller_company: sender_company || '',
      solution_name: solutionLabel,
      solution_description: solution,
      context: industry
        ? `First-touch outreach to an archetype company in: ${industry}. The salesperson wants to understand engagement potential across this segment.`
        : 'First-touch outreach — specific reason to talk.'
    });
    const angles = await callLLM(ANGLES_PROMPT, anglesUserContent, { maxTokens: 3500 });
    // Attach labels the UI will display
    angles.seller_label = angles.seller_label || sellerLabel;
    angles.solution_label = angles.solution_label || solutionLabel;
    send('angles', angles);

    // ========= EMAIL =========
    send('phase', { phase: 'email', message: 'Composing outreach email…' });
    const topAngle = angles?.angles?.find(a => a.title === angles?.top_pick) || angles?.angles?.[0];

    const senderContext = [
      `Sender: ${salesperson}`,
      sender_company ? `Company: ${sender_company}` : null,
      `Selling: ${solution}`,
      'Tone: warm, direct, first-touch. Sign with the sender name. Never mention WinTech or AIAIVN unless those are the sender/solution inputs.'
    ].filter(Boolean).join(' · ');

    const intent = topAngle
      ? `${recipient_role || 'Senior executive'} at ${entry.target?.name}${entry.is_archetype ? ' (industry archetype — keep the email generalizable across the segment)' : ''}. First-touch email from ${salesperson}${sender_company ? ` at ${sender_company}` : ''} about ${solution}. Lead with this specific angle: ${topAngle.title}. Thesis: ${topAngle.thesis}. What the sender brings: ${topAngle.seller_contribution || topAngle.wintech_contribution || ''}. What the solution delivers: ${topAngle.solution_contribution || topAngle.aiaivn_contribution || ''}. Addresses: ${topAngle.target_pain_addressed}. First step: ${topAngle.first_step}. Warm but direct. Specific to the target. No generic AI pitch. Sign off as ${salesperson}.`
      : `${recipient_role || 'Senior executive'} at ${entry.target?.name}. First-touch email from ${salesperson}${sender_company ? ` at ${sender_company}` : ''} about ${solution}. Warm, specific, references something concrete about their business. Sign off as ${salesperson}.`;

    const emailUserContent = JSON.stringify({
      summary: entry.summary,
      atoms: entry.atoms,
      recipient_intent: intent,
      output_format: 'email',
      sender_context: senderContext
    });
    const email = await callLLM(RECONSTRUCT_PROMPT, emailUserContent, { maxTokens: 2500 });
    send('email', email);

    send('done', { target_id });
    res.end();
  } catch (err) {
    console.error('[demo-flow]', err.message);
    send('error', { message: err.message });
    res.end();
  }
});

// ============================================================================
// HYDRATION PROMPT — multi-agent enrichment inline
// Generates a real opportunity card: industry mapping, pain scoring,
// prequalification, contact angles, recommended next action.
// ============================================================================
const HYDRATION_PROMPT = `You are the LeadHydration multi-agent engine.

You receive a target company's atoms (decomposed facts), the salesperson, the solution being sold, and an engagement angle. You play FIVE roles in sequence and produce ONE unified opportunity card:

1. INDUSTRY AGENT — classify industry, map SIC + NAICS codes, identify verticals
2. PAIN AGENT — identify the top 3 most acute pain points visible in the atoms, score each 1-10 for urgency and 1-10 for fit with THE solution named in the input (not any hardcoded product line)
3. SOLUTION AGENT — recommend a concrete deployment of the named solution (and any adjacent capabilities implied by the engagement angle) for the lead angle's context
4. PREQUALIFY AGENT — produce an MQL score 0-100 with reasoning (is this worth the salesperson's time?)
5. CUSTOMER AGENT — recommend the single highest-leverage first action the salesperson should take, with a specific opener and a specific desired outcome

OUTPUT (JSON only, no markdown fences):
{
  "opportunity_id": "<already provided in input — echo it>",
  "company_name": "<echo>",
  "industry": {
    "primary": "<industry name>",
    "sic_codes": ["<code>: <label>", ...],
    "naics_codes": ["<code>: <label>", ...],
    "vertical_tags": ["<tag>", "<tag>"]
  },
  "pain_points": [
    {
      "title": "<short crisp name>",
      "description": "<1-2 sentences grounded in the atoms>",
      "urgency": 0-10,
      "fit": 0-10,
      "evidence_atom_types": ["<atom type>", ...]
    }
  ],
  "recommended_solution": {
    "combination": "<specific product combo, e.g. 'LeadHydration + ClearSignals + CPP'>",
    "why": "<1-2 sentences tying this combo to the top pain>",
    "first_deployment_scope": "<concrete 30-day pilot scope>"
  },
  "prequalify": {
    "mql_score": 0-100,
    "tier": "HOT" | "WARM" | "NURTURE" | "DISQUALIFY",
    "reasoning": "<1-2 sentences>",
    "blockers": ["<thing to verify>", "<thing to watch>"]
  },
  "recommended_action": {
    "action": "<verb phrase — 'Call', 'Send video', 'LinkedIn DM', etc>",
    "target": "<who specifically to contact, from contact atoms if available>",
    "opener": "<1-sentence opening line the salesperson should use>",
    "desired_outcome": "<the specific thing that means this touch succeeded>"
  }
}

DISCIPLINE:
- Every claim must trace to the target's atoms. Do not invent facts.
- Pain points must be GROUNDED in atoms — if no weakness/mission_gap/buying_trigger atoms support a pain, lower its urgency score.
- MQL scoring: 80+ HOT, 60-79 WARM, 40-59 NURTURE, <40 DISQUALIFY.
- Opener must be specific to THIS company, not a template.
- Keep all copy tight. This is scannable intelligence for a salesperson, not a whitepaper.`;

// ============================================================================
// LEADHYDRATION HANDOFF — REAL inline hydration
// ============================================================================
const LEADHYDRATION_URL = process.env.LEADHYDRATION_URL || '';
const LEADHYDRATION_API_KEY = process.env.LEADHYDRATION_API_KEY || '';

app.post('/api/handoff/leadhydration', async (req, res) => {
  const { target_id, angle, email, recipient_role, salesperson, sender_company, solution } = req.body || {};
  if (!target_id) return res.status(400).json({ error: 'Require target_id' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const entry = atomStore.get(target_id);
  if (!entry) return res.status(404).json({ error: `No atoms for target_id: ${target_id}` });

  const contactAtom = entry.atoms.find(a => a.type === 'contact');
  const opportunity_id = `OPP-${Date.now().toString(36).toUpperCase().slice(-6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // Run actual hydration via LLM
  try {
    const hydrationInput = JSON.stringify({
      opportunity_id,
      company_name: entry.target?.name || target_id,
      company_url: entry.target?.url || entry.source_url || '',
      summary: entry.summary,
      atoms: entry.atoms.map(a => ({
        type: a.type,
        claim: a.claim,
        tags: a.tags,
        confidence: a.confidence
      })),
      engagement_angle: angle ? {
        title: angle.title,
        thesis: angle.thesis,
        seller_contribution: angle.seller_contribution || angle.wintech_contribution,
        solution_contribution: angle.solution_contribution || angle.aiaivn_contribution,
        first_step: angle.first_step
      } : null,
      recipient_role: recipient_role || 'Senior executive',
      contact_hint: contactAtom ? contactAtom.claim : null,
      salesperson: salesperson || 'Salesperson',
      sender_company: sender_company || '',
      solution: solution || ''
    });

    const hydration = await callLLM(HYDRATION_PROMPT, hydrationInput, { maxTokens: 3500 });

    if (!hydration?.pain_points || !hydration?.prequalify) {
      return res.status(502).json({ error: 'Hydration returned malformed data' });
    }

    return res.json({
      status: 'hydrated',
      destination: 'leadhydration-inline',
      portal_url: `https://leadhydration.com/portal/${opportunity_id.toLowerCase()}`,
      atoms_sent: entry.atoms.length,
      hydration
    });
  } catch (err) {
    console.error('[hydration]', err.message);
    return res.status(500).json({ error: `Hydration failed: ${err.message}` });
  }
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    model: OPENROUTER_MODEL_ID,
    targets_loaded: atomStore.size
  });
});

app.listen(PORT, () => {
  console.log(`✅ TDE Demo v2 listening on port ${PORT}`);
  console.log(`   model: ${OPENROUTER_MODEL_ID}`);
  console.log(`   targets loaded: ${atomStore.size}`);
});
