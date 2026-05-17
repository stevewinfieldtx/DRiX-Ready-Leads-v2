// competitive-intel.js — Competitive Discovery & Battlecard Generation
//
// Called during solution ingest. Identifies competitors, generates offensive
// battlecard atoms (how WE beat each competitor), and creates lightweight
// competitor stubs for TDE storage (neutral positioning, terminology).
//
// KEY RULES:
// - Battlecard atoms live UNDER the solution entity (offensive only)
// - Competitor stubs are neutral (their positioning, their claims against others)
// - No entity ever says "here's how we lose" — always offensive
// - Rep only sees the solution's battlecard atoms, never the stubs directly

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';

// =============================================================================
// BRAVE SEARCH (mirrors individual-scan.js pattern)
// =============================================================================

async function braveSearch(query, count = 10) {
  if (!BRAVE_API_KEY) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      offset: '0',
      mkt: 'en-US',
      safesearch: 'off',
    });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { 'X-Subscription-Token': BRAVE_API_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
    }));
  } catch (err) {
    console.error(`[competitive] Brave search failed for "${query.slice(0, 40)}":`, err.message);
    return [];
  }
}

// =============================================================================
// PROMPTS
// =============================================================================

const COMPETITOR_DISCOVERY_PROMPT = `You are a competitive intelligence analyst. Given information about a solution/product, identify its top competitors.

INPUT: Solution name, URL, and page content (scraped from their website).

TASK: Identify the 3-5 most direct competitors to this solution. For each competitor, provide:
- Their name
- Their primary URL (best guess from your knowledge)
- A one-sentence positioning statement (how they describe themselves)
- The specific market overlap with the input solution (why they compete)

RULES:
- Only include DIRECT competitors — companies that a buyer would evaluate head-to-head
- Do NOT include tangential companies that happen to be in the same broad space
- Use your knowledge of the competitive landscape — you likely know these companies
- If the solution is very niche and you can only identify 2-3 competitors, that's fine

OUTPUT (JSON only, no markdown fences):
{
  "solution_name": "<name of the input solution>",
  "solution_category": "<2-4 word market category, e.g. 'email security' or 'SASE/SSE'>",
  "competitors": [
    {
      "name": "<competitor name>",
      "url": "<their website URL>",
      "positioning": "<one sentence — how they describe themselves>",
      "overlap": "<one sentence — why a buyer would compare them to the input solution>"
    }
  ]
}`;

const BATTLECARD_PROMPT = `You are an elite competitive sales strategist. You work for the SOLUTION company. Your job is to produce offensive competitive intelligence — how WE beat each competitor.

INPUT:
- Solution information (our product — what we do, our strengths, our positioning)
- Competitor name and basic positioning
- Web research about the competitive landscape (reviews, comparisons, G2/Gartner mentions)

TASK: Generate battlecard atoms for how OUR SOLUTION beats this specific competitor. Each atom is a self-contained competitive insight.

ATOM TYPES for competitive intel:
- "competitive_win": A scenario or buyer type where we consistently beat them
- "competitive_counter": When they say X, we respond with Y
- "competitive_trigger": Signal that this competitor is in the deal (phrases, requirements, incumbent indicators)
- "competitive_weakness": A known weakness of theirs that we exploit (from reviews, losses, market perception)
- "competitive_positioning": How to frame us vs. them in a single sentence

RULES:
- OFFENSIVE ONLY. We never say "they beat us when..." — only "we beat them when..."
- Every atom must be specific and actionable. "We're better" is garbage. "We win on deployment speed — 2 hours vs. their 6-week POC" is good.
- Ground claims in real market knowledge — G2 reviews, Gartner positioning, known customer wins, deployment models
- Include counter-objections: what does the competitor's sales team say about us, and how do we respond?
- Think about what a rep needs in the moment: prospect says "we're also looking at [competitor]" — what do you say NEXT?

OUTPUT (JSON only, no markdown fences):
{
  "competitor_name": "<name>",
  "win_rate_estimate": "<our estimated win rate against them: dominant|favorable|even|underdog>",
  "one_liner": "<single sentence positioning against this competitor>",
  "atoms": [
    {
      "atom_id": "<kebab-case-id>",
      "type": "<competitive_win|competitive_counter|competitive_trigger|competitive_weakness|competitive_positioning>",
      "claim": "<one clear sentence — actionable competitive insight>",
      "evidence": "<what this is based on — market knowledge, reviews, known positioning>",
      "confidence": "high" | "medium" | "low",
      "tags": ["<3-6 lowercase tags>"],
      "scenario": "<when to use this — e.g. 'prospect mentions compliance requirements' or 'incumbent renewal coming up'>"
    }
  ]
}

DISCIPLINE:
- Generate 15-25 atoms per competitor. Cover: win scenarios (5+), counter-objections (5+), triggers (3+), weaknesses (3+), positioning (2+).
- Every atom must pass the "is this useful in a live deal?" test. If not, cut it.
- Include specific language — actual phrases the competitor uses, actual phrases we should use back.`;

const COMPETITOR_STUB_PROMPT = `You are a competitive intelligence cataloger. Create a neutral reference profile for this company.

INPUT: Company name, URL, and any web research about them.

TASK: Create a neutral profile of this company — how THEY position themselves, what THEY claim, who THEY say they beat. This is NOT about beating them — it's cataloging their own messaging and terminology.

For each of their known competitors (including the solution that triggered this research), include their offensive claims — "here's how THEY say they beat [competitor]." Always from THEIR perspective.

OUTPUT (JSON only, no markdown fences):
{
  "company_name": "<name>",
  "url": "<url>",
  "category": "<market category>",
  "positioning": "<2-3 sentence — how they describe themselves>",
  "key_claims": ["<their top 5-8 marketing claims>"],
  "target_buyer": "<who they sell to — company size, industry, persona>",
  "pricing_signal": "<enterprise|mid-market|smb|freemium|unknown>",
  "terminology": ["<key terms/phrases they use that would signal their presence in a deal>"],
  "their_competitive_claims": [
    {
      "against": "<competitor name>",
      "claim": "<how they say they beat that competitor — from THEIR perspective>"
    }
  ],
  "atoms": [
    {
      "atom_id": "<kebab-case-id>",
      "type": "<product|positioning|icp|proof_point|differentiator|terminology>",
      "claim": "<one sentence — neutral fact about this company>",
      "evidence": "<source>",
      "confidence": "high" | "medium" | "low",
      "tags": ["<3-6 lowercase tags>"]
    }
  ]
}

DISCIPLINE:
- 20-40 atoms. Neutral tone. This is a reference card, not a battlecard.
- The "terminology" field is critical — these are the words/phrases that signal this company is in a deal (for email thread analysis).
- "their_competitive_claims" captures how THEY talk about beating others. This is THEIR offensive positioning.`;

// =============================================================================
// MAIN PIPELINE
// =============================================================================

/**
 * Run competitive discovery for a solution.
 * Called after the solution's own ingest is complete.
 *
 * @param {Object} opts
 * @param {string} opts.solutionName - Name of the solution (e.g. "Trustifi")
 * @param {string} opts.solutionUrl - URL of the solution
 * @param {string} opts.solutionContent - Scraped page text (already available from ingest)
 * @param {Function} opts.callLLM - Reference to server.js callLLM function
 * @param {Function} opts.fetchAndStrip - Reference to server.js fetchAndStrip function
 * @param {Function} [opts.onProgress] - Optional progress callback
 * @returns {Object} { battlecard_atoms: [...], competitor_stubs: [...], competitors_found: [...] }
 */
async function discoverCompetitors({ solutionName, solutionUrl, solutionContent, callLLM, fetchAndStrip, onProgress }) {
  const log = (msg) => {
    console.log(`[competitive] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  log(`Discovering competitors for ${solutionName}...`);

  // ─── STEP 1: Identify competitors via LLM (uses solution page content + LLM knowledge)
  const discoveryResult = await callLLM(
    COMPETITOR_DISCOVERY_PROMPT,
    JSON.stringify({
      solution_name: solutionName,
      solution_url: solutionUrl,
      page_content: (solutionContent || '').slice(0, 15000), // Cap to avoid token overflow
    }),
    { maxTokens: 4000 }
  );

  if (!discoveryResult?.competitors?.length) {
    log('No competitors identified — skipping competitive intel');
    return { battlecard_atoms: [], competitor_stubs: [], competitors_found: [] };
  }

  const competitors = discoveryResult.competitors.slice(0, 5); // Max 5
  log(`Found ${competitors.length} competitors: ${competitors.map(c => c.name).join(', ')}`);

  // ─── STEP 2: Research each competitor (Brave search for comparison/review content)
  const competitorResearch = {};
  await Promise.all(competitors.map(async (comp) => {
    const queries = [
      `${solutionName} vs ${comp.name}`,
      `${comp.name} vs ${solutionName} comparison`,
      `${comp.name} review ${discoveryResult.solution_category || ''}`,
    ];
    const results = await Promise.all(queries.map(q => braveSearch(q, 5)));
    competitorResearch[comp.name] = results.flat();
    log(`  Researched ${comp.name}: ${competitorResearch[comp.name].length} results`);
  }));

  // ─── STEP 3: Generate battlecard atoms for each competitor (offensive — lives under solution)
  log('Generating battlecard atoms (how we beat each competitor)...');
  const battlecardResults = await Promise.all(competitors.map(async (comp) => {
    try {
      const result = await callLLM(
        BATTLECARD_PROMPT,
        JSON.stringify({
          solution_name: solutionName,
          solution_url: solutionUrl,
          solution_content: (solutionContent || '').slice(0, 10000),
          competitor_name: comp.name,
          competitor_positioning: comp.positioning,
          competitor_overlap: comp.overlap,
          web_research: (competitorResearch[comp.name] || []).slice(0, 15),
        }),
        { maxTokens: 16000 }
      );
      if (result?.atoms?.length) {
        // Tag each atom with the competitor it's about
        result.atoms.forEach(a => {
          a.competitor = comp.name;
          a.competitor_url = comp.url;
        });
        log(`  Battlecard for ${comp.name}: ${result.atoms.length} atoms`);
        return {
          competitor: comp.name,
          win_rate: result.win_rate_estimate || 'unknown',
          one_liner: result.one_liner || '',
          atoms: result.atoms,
        };
      }
      return null;
    } catch (err) {
      log(`  Battlecard for ${comp.name} failed: ${err.message}`);
      return null;
    }
  }));

  const battlecards = battlecardResults.filter(Boolean);
  const allBattlecardAtoms = battlecards.flatMap(b => b.atoms);
  log(`Total battlecard atoms: ${allBattlecardAtoms.length}`);

  // ─── STEP 4: Generate competitor stubs (neutral — stored in TDE for Clear Signals / future hydration)
  log('Generating competitor stubs (neutral profiles)...');
  const stubs = await Promise.all(competitors.map(async (comp) => {
    try {
      // Try to scrape competitor's site for stub content
      let compContent = '';
      if (comp.url && fetchAndStrip) {
        try {
          const fetched = await fetchAndStrip(comp.url);
          compContent = fetched?.text || '';
        } catch (e) {
          log(`  Could not scrape ${comp.url}: ${e.message}`);
        }
      }

      const result = await callLLM(
        COMPETITOR_STUB_PROMPT,
        JSON.stringify({
          company_name: comp.name,
          url: comp.url,
          category: discoveryResult.solution_category || '',
          known_competitors: competitors.map(c => c.name).filter(n => n !== comp.name).concat([solutionName]),
          web_content: compContent.slice(0, 10000),
          web_research: (competitorResearch[comp.name] || []).slice(0, 10),
        }),
        { maxTokens: 16000 }
      );

      if (result) {
        log(`  Stub for ${comp.name}: ${result.atoms?.length || 0} atoms, ${result.terminology?.length || 0} terms`);
        return {
          ...result,
          source_solution: solutionName, // Which solution triggered this stub creation
          stub_type: 'competitive_discovery',
          created_at: new Date().toISOString(),
        };
      }
      return null;
    } catch (err) {
      log(`  Stub for ${comp.name} failed: ${err.message}`);
      return null;
    }
  }));

  const validStubs = stubs.filter(Boolean);
  log(`Competitor stubs created: ${validStubs.length}`);

  // ─── RETURN ─────────────────────────────────────────────────────────────
  return {
    solution_name: solutionName,
    solution_category: discoveryResult.solution_category || '',
    competitors_found: competitors,
    battlecard_atoms: allBattlecardAtoms, // These go INTO the solution's atom set
    battlecard_summary: battlecards.map(b => ({
      competitor: b.competitor,
      win_rate: b.win_rate,
      one_liner: b.one_liner,
      atom_count: b.atoms.length,
    })),
    competitor_stubs: validStubs, // These get stored in TDE separately
    total_battlecard_atoms: allBattlecardAtoms.length,
    total_stub_atoms: validStubs.reduce((sum, s) => sum + (s.atoms?.length || 0), 0),
  };
}

module.exports = {
  discoverCompetitors,
  COMPETITOR_DISCOVERY_PROMPT,
  BATTLECARD_PROMPT,
  COMPETITOR_STUB_PROMPT,
};
