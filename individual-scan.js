// individual-scan.js — DRiX Individual Intelligence v2
// Multi-stage pipeline: Apollo enrichment → Brave deep research → LLM psychographic inference
//
// REPLACES: the old "ask the LLM to remember things" approach.
// NOW: enriches with REAL data from APIs, then asks the LLM to ANALYZE real facts.
//
// Environment variables used:
//   APOLLO_API_KEY       — Apollo.io person/company enrichment
//   BRAVE_API_KEY        — Brave Search for deep web research (podcasts, talks, news, etc.)
//   OPENROUTER_API_KEY   — LLM for psychographic inference + brief generation
//   OPENROUTER_MODEL_ID  — Model to use (default: anthropic/claude-sonnet-4.5)

const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
const APOLLO_API_KEY      = process.env.APOLLO_API_KEY || '';
const BRAVE_API_KEY       = process.env.BRAVE_API_KEY || '';

// =============================================================================
// APOLLO ENRICHMENT
// =============================================================================

async function apolloEnrichPerson(linkedinUrl, email) {
  if (!APOLLO_API_KEY) {
    console.log('[individual-scan] No APOLLO_API_KEY — skipping person enrichment');
    return null;
  }

  const payload = {
    reveal_personal_emails: true,
    reveal_phone_number: true,
  };
  if (linkedinUrl) payload.linkedin_url = linkedinUrl;
  if (email) payload.email = email;

  try {
    const response = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${APOLLO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.log(`[individual-scan] Apollo person: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.person || null;
  } catch (err) {
    console.error('[individual-scan] Apollo person enrichment failed:', err.message);
    return null;
  }
}

async function apolloEnrichCompany(domain) {
  if (!APOLLO_API_KEY || !domain) return null;

  try {
    const response = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
      headers: {
        'Authorization': `Api-Key ${APOLLO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.organization || null;
  } catch (err) {
    console.error('[individual-scan] Apollo company enrichment failed:', err.message);
    return null;
  }
}

// =============================================================================
// BRAVE SEARCH — DEEP WEB RESEARCH
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
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      date: r.age || '',
    }));
  } catch (err) {
    console.error(`[individual-scan] Brave search failed for "${query.slice(0, 40)}":`, err.message);
    return [];
  }
}

async function braveNewsSearch(query, count = 10) {
  if (!BRAVE_API_KEY) return [];

  try {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const response = await fetch(`https://api.search.brave.com/res/v1/news/search?${params}`, {
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      date: r.age || '',
      source: r.meta_url?.hostname || '',
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Deep web research on an individual.
 * Runs multiple Brave Search queries to find podcasts, talks, news, content, etc.
 */
async function deepResearch(name, company, title) {
  if (!BRAVE_API_KEY || !name) {
    console.log('[individual-scan] No BRAVE_API_KEY or no name — skipping deep research');
    return { podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  }

  console.log(`[individual-scan] Deep research: "${name}" at ${company || 'unknown'}`);

  const results = { podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  const seen = new Set();

  function dedup(items) {
    return items.filter(item => {
      const key = item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Helper for classification
  const isPodcast = (r) => /podcast|episode|ep\.|listen|spotify|apple.podcast/i.test(r.title + r.url + r.description);
  const isVideo = (r) => /youtube\.com|vimeo|video|webinar|recording/i.test(r.title + r.url);
  const isConference = (r) => /conference|summit|forum|keynote|panel|speaker|fireside/i.test(r.title + r.description);
  const isNews = (r) => /reuters|bloomberg|techcrunch|fortune|forbes|wsj|bizjournals|cnbc/i.test(r.url);
  const isPR = (r) => /press.release|newswire|announces|appointed|promoted|named/i.test(r.title + r.url + r.description);
  const isContent = (r) => /author|written.by|blog|medium\.com|linkedin\.com\/pulse|contributed/i.test(r.title + r.url + r.description);
  const isAward = (r) => /award|winner|recognized|honored|top.40|influential|rising.star/i.test(r.title + r.description);
  const isVolunteer = (r) => /volunteer|nonprofit|board.member|advisory|mentor|charity|foundation/i.test(r.title + r.description);

  // Run searches with 1-second spacing to respect rate limits
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // 1. Podcasts
  const podResults = await braveSearch(`"${name}" podcast interview`, 10);
  results.podcasts = dedup(podResults.filter(isPodcast));
  await delay(1000);

  // 2. Videos / talks
  const vidResults = await braveSearch(`"${name}" site:youtube.com OR keynote OR presentation`, 10);
  results.videos = dedup(vidResults.filter(r => isVideo(r) || isConference(r)));
  await delay(1000);

  // 3. Conference speaking
  const confResults = await braveSearch(`"${name}" speaker conference summit`, 10);
  results.talks = dedup(confResults.filter(isConference));
  await delay(1000);

  // 4. News mentions
  const newsResults = await braveNewsSearch(`"${name}" ${company || ''}`, 10);
  results.news = dedup(newsResults);
  await delay(1000);

  // 5. PR announcements
  if (company) {
    const prResults = await braveSearch(`${company} "${name}" press release OR announces`, 5);
    results.pr = dedup(prResults.filter(isPR));
    await delay(1000);
  }

  // 6. Published content
  const contentResults = await braveSearch(`"${name}" author blog article OR "written by"`, 10);
  results.content = dedup(contentResults.filter(isContent));
  await delay(1000);

  // 7. Awards
  const awardResults = await braveSearch(`"${name}" award OR recognized OR honored`, 5);
  results.awards = dedup(awardResults.filter(isAward));
  await delay(1000);

  // 8. Volunteer / board work
  const volResults = await braveSearch(`"${name}" volunteer OR "board member" OR nonprofit OR advisory`, 5);
  results.volunteer = dedup(volResults.filter(isVolunteer));

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Deep research complete: ${total} findings (${results.podcasts.length} podcasts, ${results.talks.length} talks, ${results.news.length} news, ${results.content.length} content, ${results.awards.length} awards)`);

  return results;
}

/**
 * Deep web research on a COMPANY.
 * Pulls recent filings, PR, earnings, strategic moves, leadership changes, partnerships.
 */
async function deepCompanyResearch(companyName, domain) {
  if (!BRAVE_API_KEY || !companyName) {
    console.log('[individual-scan] No BRAVE_API_KEY or no company — skipping company research');
    return { sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [] };
  }

  console.log(`[individual-scan] Company deep research: "${companyName}" (${domain || 'no domain'})`);

  const results = { sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [] };
  const seen = new Set();

  function dedup(items) {
    return items.filter(item => {
      const key = item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // 1. SEC filings (10-K, 10-Q, 8-K) — public companies
  const secResults = await braveSearch(`"${companyName}" SEC 10-K OR 10-Q OR 8-K filing 2025 OR 2026`, 8);
  results.sec_filings = dedup(secResults.filter(r => /sec\.gov|10-[kq]|8-k|annual.report|quarterly|filing/i.test(r.title + r.url + r.description)));
  await delay(1000);

  // 2. Press releases (last 6 months)
  const prResults = await braveNewsSearch(`"${companyName}" press release OR announces OR unveiled OR launched`, 10);
  results.press_releases = dedup(prResults);
  await delay(1000);

  // 3. General news coverage
  const newsResults = await braveNewsSearch(`"${companyName}" ${domain ? 'site:reuters.com OR site:bloomberg.com OR site:techcrunch.com OR site:wsj.com' : ''}`, 10);
  results.news = dedup(newsResults);
  await delay(1000);

  // 4. Earnings / financials
  const earningsResults = await braveSearch(`"${companyName}" earnings OR revenue OR quarterly results 2025 OR 2026`, 8);
  results.earnings = dedup(earningsResults.filter(r => /earning|revenue|profit|quarter|fiscal|financial.results|beat|miss/i.test(r.title + r.description)));
  await delay(1000);

  // 5. Leadership changes
  const leaderResults = await braveNewsSearch(`"${companyName}" CEO OR CTO OR CFO OR VP appointed OR hired OR joins`, 8);
  results.leadership = dedup(leaderResults.filter(r => /appoint|hire|join|named|promoted|depart|resign|new.ceo|new.cto/i.test(r.title + r.description)));
  await delay(1000);

  // 6. Partnerships & acquisitions
  const partnerResults = await braveNewsSearch(`"${companyName}" partnership OR acquisition OR merger OR "strategic alliance" OR "signed agreement"`, 8);
  results.partnerships = dedup(partnerResults);
  await delay(1000);

  // 7. Product launches / major releases
  const productResults = await braveNewsSearch(`"${companyName}" launches OR "new product" OR "new feature" OR release OR unveils`, 8);
  results.product_launches = dedup(productResults);
  await delay(1000);

  // 8. Hiring signals (growing, cutting, etc.)
  const hiringResults = await braveSearch(`"${companyName}" hiring OR layoffs OR "open positions" OR headcount OR expansion`, 5);
  results.hiring_signals = dedup(hiringResults.filter(r => /hiring|layoff|headcount|workforce|recruit|rif|downsize|expansion|new.office/i.test(r.title + r.description)));

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Company research complete: ${total} findings (${results.sec_filings.length} filings, ${results.press_releases.length} PR, ${results.news.length} news, ${results.earnings.length} earnings, ${results.leadership.length} leadership, ${results.partnerships.length} partnerships)`);

  return results;
}

// =============================================================================
// LLM PSYCHOGRAPHIC INFERENCE — Analyzes REAL data, doesn't guess
// =============================================================================

const PSYCHOGRAPHIC_PROMPT = `You are an elite B2B sales psychologist and intelligence analyst. You have been given REAL, VERIFIED data about an individual — their actual employment history, education, skills, public appearances, news mentions, and company context.

Your job is to ANALYZE this real data and produce a psychographic profile that tells a sales rep exactly WHO this person is and HOW to engage them.

ARCHETYPES (pick the best fit):
- GROWER: Ambitious, ascending trajectory, wants bigger scope, motivated by career advancement and recognition. Engaged by opportunity and competitive advantage.
- DEFENDER: Protective of what works, risk-averse, long tenure, values stability. Engaged by risk reduction and proven solutions.
- OPTIMIZER: Efficiency-focused, data-driven, iterates and improves. Engaged by measurable ROI and specific metrics.
- PIONEER: Cutting-edge seeker, early adopter, thought leader, speaks at conferences. Engaged by innovation and being first.
- BUILDER: Creates from scratch, entrepreneurial, long-term thinker. Engaged by ownership, extensibility, and compounding value.

DECISION STYLES:
- Analytical: Needs data, proof, methodology
- Intuitive: Goes with gut after initial validation
- Consensus: Needs team buy-in before moving
- Directive: Decides fast and alone

CRITICAL RULES:
- Base EVERYTHING on the actual data provided. Reference specific career moves, tenure patterns, education, public appearances.
- Show your evidence for every inference. "They spent 12 years at one company → defender archetype" is good. "They seem like a defender" is garbage.
- The key_insight and opening_hook should be SPECIFIC TO THIS PERSON. If you could use the same hook for anyone with a similar title, it's too generic. Redo it.
- NEVER fabricate data. If something isn't in the provided enrichment, don't invent it.
- If they have podcast/conference/published content — reference it in the hook. That's gold.
- The COMPANY_INTELLIGENCE section contains live data: SEC filings, press releases, earnings, leadership changes, partnerships, product launches, and hiring signals. USE THIS to:
  * Identify what the company is focused on RIGHT NOW (growth? cost-cutting? transformation?)
  * Spot pain points or priorities from filings/earnings (revenue pressure, competitive threats, strategic pivots)
  * Find timely hooks (congratulate on a recent product launch, reference a recent partnership)
  * Understand if the company is growing (hiring) or contracting (layoffs) — critical for sales approach
  * Link the person's role to the company's current strategic direction

OUTPUT (JSON only, no markdown fences):
{
  "recognized": true,
  "confidence": "high" | "medium" | "low",
  "individual": {
    "name": "<full name>",
    "title": "<current role>",
    "company": "<current company>",
    "linkedin_url": "<as provided>",
    "key_insight": "<the single most important thing a salesperson should know — WHY this person will or won't buy, based on real evidence>"
  },
  "psychographic": {
    "archetype": "<grower|defender|optimizer|pioneer|builder>",
    "archetype_confidence": "<high|medium|low>",
    "archetype_evidence": ["<specific evidence from their data>"],
    "decision_style": "<analytical|intuitive|consensus|directive>",
    "decision_speed": "<fast|moderate|deliberate>",
    "risk_appetite": "<risk-seeking|calculated|risk-averse>",
    "primary_motivation": "<what drives them — based on evidence>",
    "secondary_motivation": "<what else matters>",
    "communication_style": "<data-driven|narrative|direct|collaborative>",
    "status_sensitivity": "<high|moderate|low>",
    "engagement_approach": "<2-3 sentences: exactly HOW to approach this specific person>"
  },
  "summary": "<3-5 sentence profile — who they are, career arc, what they care about>",
  "career_highlights": ["<key moves and patterns>"],
  "public_signals": ["<podcasts, talks, articles, news — reference specific titles>"],
  "leadership_style": "<how they lead based on evidence>",
  "opening_hook": "<exact words to open a cold outreach — must reference something specific about them>",
  "conversation_starters": ["<4 specific things to reference in a meeting — from their real data>"],
  "pitch_angles": ["<5 specific angles grounded in their psychographic profile and real data>"],
  "phrases_to_use": ["<words that resonate with their archetype>"],
  "phrases_to_avoid": ["<words that will shut them down based on archetype>"],
  "objections": [
    { "objection": "<likely objection based on their profile>", "response": "<specific counter>" }
  ],
  "rapport_hooks": ["<specific things from their background to reference for rapport>"],
  "pain_signals": ["<likely pain points — label as inferred vs known>"],
  "company_situation": {
    "strategic_direction": "<what the company is focused on based on filings, PR, earnings>",
    "financial_health": "<growing|stable|contracting|restructuring — based on earnings/filings>",
    "recent_moves": ["<notable recent events: launches, partnerships, leadership changes>"],
    "market_position": "<competitive context from news>",
    "hiring_trajectory": "<expanding|stable|contracting — based on hiring signals>",
    "relevance_to_sale": "<how the company situation creates opportunity or risk for our pitch>"
  },
  "atoms": [
    {
      "atom_id": "<kebab-case-id>",
      "type": "<career_history|public_statement|thought_leadership|conference_talk|community_membership|publication|endorsement|leadership_style|professional_focus|personal_signal|vendor_opinion|pain_signal|decision_pattern|psychographic_signal|company_financial|company_strategic|company_product|company_leadership|company_hiring|company_partnership>",
      "claim": "<one clear sentence about this person>",
      "evidence": "<specific data point this is based on>",
      "confidence": "high" | "medium" | "low",
      "d_persona": "<their role category>",
      "d_buying_stage": "<inferred>",
      "d_emotional_driver": "<what motivates them>",
      "d_evidence_type": "<source type>",
      "d_credibility": 1-5,
      "d_recency": "<best guess>",
      "d_economic_driver": "<what economic lever they care about>",
      "d_status_quo_pressure": "<inertia signals>",
      "d_industry": { "naics": "<sector>", "sic": "<division>" }
    }
  ]
}

DISCIPLINE:
- Generate AS MANY ATOMS AS THE DATA SUPPORTS. No artificial limit. If there are 200 data points, create 200 atoms. More is better — thoroughness over speed. This is a preparation tool, not a real-time lookup.
- Every atom must cite specific evidence from the provided data.
- Include atoms for company-level intelligence too: financial signals, strategic pivots, leadership changes, product launches, hiring patterns. These are just as valuable as personal atoms.
- The psychographic section is THE MOST IMPORTANT OUTPUT. It must be evidence-based and actionable.
- pitch_angles must be specific to this person's archetype + situation. No generic BS.
- conversation_starters should include at least 8 items — draw from personal background AND company situation.
- objections should include at least 6 with specific counters tailored to the archetype.`;

// =============================================================================
// MAIN PIPELINE
// =============================================================================

/**
 * Run complete individual intelligence pipeline.
 *
 * @param {Object} opts
 * @param {string} opts.linkedin_url - LinkedIn URL
 * @param {string} opts.email - Email address
 * @param {string} opts.title - Job title (hint)
 * @param {string} opts.name - Name (hint)
 * @param {number} opts.tier - 1=full, 2=quick (reserved for future)
 */
async function scanIndividual({ linkedin_url, email, title, name, tier = 1 }) {
  const startTime = Date.now();
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[individual-scan] STARTING PIPELINE`);
  console.log(`  LinkedIn: ${linkedin_url || 'N/A'}`);
  console.log(`  Email: ${email || 'N/A'}`);
  console.log(`  Name hint: ${name || 'N/A'}`);
  console.log(`  Title hint: ${title || 'N/A'}`);
  console.log(`${'═'.repeat(60)}`);

  // ─── STAGE 1: APOLLO ENRICHMENT ────────────────────────────────────────────
  console.log('\n[1/4] Apollo Person Enrichment...');
  const apolloPerson = await apolloEnrichPerson(linkedin_url, email);

  let personName = name;
  let personTitle = title;
  let personCompany = '';
  let companyDomain = '';
  let apolloCompany = null;

  if (apolloPerson) {
    personName = apolloPerson.name || name || nameFromSlug(linkedinSlug);
    personTitle = apolloPerson.title || title;
    personCompany = apolloPerson.organization?.name || '';
    companyDomain = apolloPerson.organization?.primary_domain || '';
    console.log(`  ✓ Found: ${personName}, ${personTitle} @ ${personCompany}`);

    // Company enrichment
    if (companyDomain) {
      console.log(`  [1b] Apollo Company Enrichment (${companyDomain})...`);
      apolloCompany = await apolloEnrichCompany(companyDomain);
      if (apolloCompany) {
        console.log(`  ✓ Company: ~${apolloCompany.estimated_num_employees || '?'} employees, ${apolloCompany.industry || 'unknown industry'}`);
      }
    }
  } else {
    personName = name || nameFromSlug(linkedinSlug);
    personCompany = companyFromEmail(email) || '';
    console.log(`  ✗ No Apollo data — using hints: ${personName}, ${personCompany}`);
  }

  // ─── STAGE 2: DEEP WEB RESEARCH (INDIVIDUAL) ───────────────────────────────
  console.log('\n[2/5] Deep Web Research — Individual (podcasts, talks, news, content)...');
  const webResearch = await deepResearch(personName, personCompany, personTitle);

  // ─── STAGE 3: DEEP WEB RESEARCH (COMPANY) ─────────────────────────────────
  console.log('\n[3/5] Deep Web Research — Company (filings, PR, earnings, strategy)...');
  const companyResearch = await deepCompanyResearch(personCompany, companyDomain);

  // ─── STAGE 4: BUILD ENRICHMENT PACKAGE FOR LLM ────────────────────────────
  console.log('\n[4/5] Assembling enrichment data...');

  const enrichmentPackage = buildEnrichmentPackage({
    apolloPerson,
    apolloCompany,
    webResearch,
    companyResearch,
    personName,
    personTitle,
    personCompany,
    linkedin_url,
    email,
  });

  // ─── STAGE 5: LLM PSYCHOGRAPHIC ANALYSIS ──────────────────────────────────
  console.log('\n[5/5] LLM Psychographic Analysis...');

  if (!OPENROUTER_API_KEY) {
    console.log('  ✗ No OPENROUTER_API_KEY — returning raw enrichment only');
    return {
      scan: { total_found: 0, accounts: [], web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0) },
      atoms: [],
      individual: { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      summary: 'LLM not configured — returning raw enrichment data.',
      pitch_angles: [],
      enrichment: enrichmentPackage,
      web_research: webResearch,
      pipeline_time_ms: Date.now() - startTime,
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3100',
        'X-Title': 'DRiX Individual Intelligence v2',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL_ID,
        messages: [
          { role: 'system', content: PSYCHOGRAPHIC_PROMPT },
          { role: 'user', content: `Analyze this individual and produce a psychographic intelligence profile.\n\nENRICHED DATA (verified from APIs — this is REAL, not guessed):\n\n${JSON.stringify(enrichmentPackage, null, 2)}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 32000,
      }),
      signal: AbortSignal.timeout(180000), // 3 min — large psychographic output, no rush
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    const elapsed = Date.now() - startTime;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[individual-scan] PIPELINE COMPLETE in ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`  Archetype: ${parsed.psychographic?.archetype?.toUpperCase() || 'unknown'}`);
    console.log(`  Decision style: ${parsed.psychographic?.decision_style || 'unknown'}`);
    console.log(`  Risk appetite: ${parsed.psychographic?.risk_appetite || 'unknown'}`);
    console.log(`  Atoms: ${(parsed.atoms || []).length}`);
    console.log(`${'═'.repeat(60)}\n`);

    return {
      scan: {
        total_found: Object.values(webResearch).reduce((s, a) => s + a.length, 0),
        accounts: [],
        web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0),
        recognized: parsed.recognized ?? true,
        confidence: parsed.confidence || 'medium',
      },
      atoms: parsed.atoms || [],
      individual: parsed.individual || { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      psychographic: parsed.psychographic || null,
      summary: parsed.summary || '',
      pitch_angles: parsed.pitch_angles || [],
      key_insight: parsed.individual?.key_insight || null,
      opening_hook: parsed.opening_hook || null,
      conversation_starters: parsed.conversation_starters || [],
      career_highlights: parsed.career_highlights || [],
      public_signals: parsed.public_signals || [],
      leadership_style: parsed.leadership_style || null,
      pain_signals: parsed.pain_signals || [],
      phrases_to_use: parsed.phrases_to_use || [],
      phrases_to_avoid: parsed.phrases_to_avoid || [],
      objections: parsed.objections || [],
      rapport_hooks: parsed.rapport_hooks || [],
      company_situation: parsed.company_situation || null,
      // Raw enrichment data (for debugging / display)
      enrichment: enrichmentPackage,
      web_research: webResearch,
      company_research: companyResearch,
      pipeline_time_ms: elapsed,
    };

  } catch (err) {
    console.error(`[individual-scan] LLM analysis failed:`, err.message);
    // Still return what we have from enrichment
    return {
      scan: { total_found: 0, accounts: [], web_results: Object.values(webResearch).reduce((s, a) => s + a.length, 0) },
      atoms: [],
      individual: { name: personName, title: personTitle, company: personCompany, linkedin_url, email },
      summary: `LLM analysis failed (${err.message}) — raw enrichment data available.`,
      pitch_angles: [],
      enrichment: enrichmentPackage,
      web_research: webResearch,
      pipeline_time_ms: Date.now() - startTime,
    };
  }
}

// =============================================================================
// ENRICHMENT PACKAGE BUILDER
// =============================================================================

function buildEnrichmentPackage({ apolloPerson, apolloCompany, webResearch, companyResearch, personName, personTitle, personCompany, linkedin_url, email }) {
  const pkg = {
    person: {
      name: personName,
      title: personTitle,
      company: personCompany,
      email: email || apolloPerson?.email || null,
      phone: apolloPerson?.phone_numbers?.[0]?.number || null,
      linkedin_url,
      location: apolloPerson ? `${apolloPerson.city || ''}, ${apolloPerson.state || ''}`.replace(/^, |, $/, '') : null,
      photo_url: apolloPerson?.photo_url || null,
    },
    employment_history: [],
    education: [],
    skills: [],
    company_context: null,
    company_intelligence: null,
    web_research: {
      podcasts: webResearch.podcasts.slice(0, 5),
      conference_talks: webResearch.talks.slice(0, 5),
      videos: webResearch.videos.slice(0, 5),
      news_mentions: webResearch.news.slice(0, 8),
      pr_announcements: webResearch.pr.slice(0, 5),
      published_content: webResearch.content.slice(0, 5),
      awards: webResearch.awards.slice(0, 5),
      volunteer_board: webResearch.volunteer.slice(0, 5),
    },
  };

  // Employment history from Apollo (already structured — no text parsing!)
  if (apolloPerson?.employment_history) {
    pkg.employment_history = apolloPerson.employment_history.map(job => ({
      title: job.title || '',
      company: job.organization_name || '',
      start_date: job.start_date || '',
      end_date: job.end_date || '',
      is_current: job.current || !job.end_date,
      description: job.description || '',
    }));
  }

  // Education from Apollo
  if (apolloPerson?.education) {
    pkg.education = apolloPerson.education.map(edu => ({
      school: edu.school_name || edu.school || '',
      degree: edu.degree || '',
      field: edu.field_of_study || edu.major || '',
      start_year: edu.start_date || '',
      end_year: edu.end_date || '',
    }));
  }

  // Skills
  pkg.skills = apolloPerson?.skills || [];

  // Company context (static profile from Apollo)
  if (apolloCompany || apolloPerson?.organization) {
    const org = apolloCompany || apolloPerson.organization || {};
    pkg.company_context = {
      name: org.name || personCompany,
      industry: org.industry || '',
      sub_industry: org.sub_industry || org.industry_tag_name || '',
      size: org.estimated_num_employees || '',
      revenue: org.annual_revenue_printed || '',
      founded: org.founded_year || '',
      website: org.website_url || org.primary_domain || '',
      location: [org.city, org.state, org.country].filter(Boolean).join(', ') || '',
      description: org.short_description || org.description || '',
      technologies: (org.current_technologies || []).slice(0, 20),
      keywords: (org.keywords || []).slice(0, 15),
    };
  }

  // Company intelligence (LIVE research — filings, PR, earnings, strategy)
  if (companyResearch) {
    const hasData = Object.values(companyResearch).some(arr => arr.length > 0);
    if (hasData) {
      pkg.company_intelligence = {
        sec_filings: companyResearch.sec_filings.slice(0, 5),
        recent_press_releases: companyResearch.press_releases.slice(0, 8),
        recent_news: companyResearch.news.slice(0, 8),
        earnings_financials: companyResearch.earnings.slice(0, 5),
        leadership_changes: companyResearch.leadership.slice(0, 5),
        partnerships_acquisitions: companyResearch.partnerships.slice(0, 5),
        product_launches: companyResearch.product_launches.slice(0, 5),
        hiring_signals: companyResearch.hiring_signals.slice(0, 5),
      };
    }
  }

  return pkg;
}

// =============================================================================
// HELPERS
// =============================================================================

function nameFromSlug(slug) {
  if (!slug) return null;
  const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '').replace(/\d+$/, '');
  return cleaned.split(/[-_]/).filter(p => p.length > 1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function companyFromEmail(email) {
  if (!email) return null;
  const domain = email.split('@')[1];
  if (!domain) return null;
  return domain.replace(/\.(com|io|co|net|org|edu|gov)$/i, '').replace(/\./g, ' ').split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = { scanIndividual };
