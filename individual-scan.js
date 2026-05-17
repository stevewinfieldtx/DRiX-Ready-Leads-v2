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
 * PHASE 1: Discovery — figure out who this person actually is (bio pages, LinkedIn, org charts, announcements)
 * PHASE 2: Deep dive — podcasts, talks, news, content, certifications, awards
 *
 * Does NOT depend on having the right company name upfront. Searches with and without it.
 */
async function deepResearch(name, company, title, companyDomain) {
  if (!BRAVE_API_KEY || !name) {
    console.log('[individual-scan] No BRAVE_API_KEY or no name — skipping deep research');
    return { discovery: [], profile_pages: [], certifications: [], podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  }

  console.log(`[individual-scan] Deep research: "${name}" (title: ${title || 'unknown'}) at ${company || 'unknown'} (domain: ${companyDomain || 'none'})`);

  const results = { discovery: [], profile_pages: [], certifications: [], podcasts: [], videos: [], news: [], pr: [], talks: [], content: [], awards: [], volunteer: [] };
  const seen = new Set();

  function dedup(items) {
    return items.filter(item => {
      const key = item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Classification helpers
  const isPodcast = (r) => /podcast|episode|ep\.|listen|spotify|apple.podcast/i.test(r.title + r.url + r.description);
  const isVideo = (r) => /youtube\.com|vimeo|video|webinar|recording/i.test(r.title + r.url);
  const isConference = (r) => /conference|summit|forum|keynote|panel|speaker|fireside/i.test(r.title + r.description);
  const isPR = (r) => /press.release|newswire|announces|appointed|promoted|named|hired|joins/i.test(r.title + r.url + r.description);
  const isContent = (r) => /author|written.by|blog|medium\.com|linkedin\.com\/pulse|contributed/i.test(r.title + r.url + r.description);
  const isAward = (r) => /award|winner|recognized|honored|top.40|influential|rising.star/i.test(r.title + r.description);
  const isVolunteer = (r) => /volunteer|nonprofit|board.member|advisory|mentor|charity|foundation/i.test(r.title + r.description);
  const isProfile = (r) => /linkedin\.com|theorg\.com|zoominfo|rocketreach|apollo|crunchbase|about|leadership|team|bio/i.test(r.url + r.title);
  const isCert = (r) => /certif|cissp|ccsp|ccna|cism|cisa|pmp|aws.cert|azure.cert|comptia/i.test(r.title + r.description);

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: DISCOVERY — figure out who they are, find their full bio
  // ═══════════════════════════════════════════════════════════════════════

  // 1a. Pure name + title search (no company dependency — catches everything)
  const discoveryResults1 = await braveSearch(`"${name}" ${title || ''}`, 10);
  results.discovery.push(...dedup(discoveryResults1));
  await delay(800);

  // 1b. Name + company name (if we have one)
  if (company) {
    const discoveryResults2 = await braveSearch(`"${name}" "${company}"`, 10);
    results.discovery.push(...dedup(discoveryResults2));
    await delay(800);
  }

  // 1c. Name + company DOMAIN (this is the URL the user gave us — use it!)
  if (companyDomain && companyDomain !== company) {
    const discoveryResults3 = await braveSearch(`"${name}" "${companyDomain}"`, 10);
    results.discovery.push(...dedup(discoveryResults3));
    await delay(800);
  }

  // 1d. Search the company's OWN WEBSITE for this person (leadership pages, bios, about us)
  if (companyDomain) {
    const siteResults = await braveSearch(`"${name}" site:${companyDomain}`, 10);
    results.profile_pages.push(...dedup(siteResults));
    await delay(800);
  }

  // 1e. Profile pages (LinkedIn, TheOrg, ZoomInfo, company team pages)
  const profileResults = await braveSearch(`"${name}" ${title || ''} site:linkedin.com OR site:theorg.com OR site:zoominfo.com OR leadership OR "about us"`, 10);
  results.profile_pages.push(...dedup(profileResults.filter(isProfile)));
  await delay(800);

  // 1f. Hiring / appointment announcements (these are GOLD — they contain career history summaries)
  const appointResults = await braveSearch(`"${name}" appointed OR hired OR joins OR named OR promoted ${title || ''}`, 10);
  results.pr.push(...dedup(appointResults.filter(isPR)));
  results.discovery.push(...dedup(appointResults));
  await delay(800);

  // 1g. Certifications and credentials
  const certResults = await braveSearch(`"${name}" certification OR certified OR CISSP OR CCSP OR PMP OR credentials`, 8);
  results.certifications = dedup(certResults.filter(isCert));
  results.discovery.push(...dedup(certResults));
  await delay(800);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: DEEP DIVE — now that we know who they are, find their activity
  // ═══════════════════════════════════════════════════════════════════════

  // 2a. Podcasts
  const podResults = await braveSearch(`"${name}" podcast interview`, 10);
  results.podcasts = dedup(podResults.filter(isPodcast));
  await delay(800);

  // 2b. Videos / talks / webinars
  const vidResults = await braveSearch(`"${name}" video OR keynote OR webinar OR presentation`, 10);
  results.videos = dedup(vidResults.filter(r => isVideo(r) || isConference(r)));
  await delay(800);

  // 2c. Conference speaking
  const confResults = await braveSearch(`"${name}" speaker conference summit panel`, 10);
  results.talks = dedup(confResults.filter(isConference));
  await delay(800);

  // 2d. News mentions (try with AND without company to cast a wider net)
  const newsResults1 = await braveNewsSearch(`"${name}" ${title || ''}`, 10);
  results.news.push(...dedup(newsResults1));
  await delay(800);

  if (company) {
    const newsResults2 = await braveNewsSearch(`"${name}" "${company}"`, 10);
    results.news.push(...dedup(newsResults2));
    await delay(800);
  }

  // 2e. PR announcements from company
  if (company) {
    const prResults = await braveSearch(`"${company}" "${name}" press release OR announces`, 8);
    results.pr.push(...dedup(prResults.filter(isPR)));
    await delay(800);
  }

  // 2f. Published content / thought leadership
  const contentResults = await braveSearch(`"${name}" author blog article OR "written by" OR contributed`, 10);
  results.content = dedup(contentResults.filter(isContent));
  await delay(800);

  // 2g. Awards & recognition
  const awardResults = await braveSearch(`"${name}" award OR recognized OR honored OR "top 40" OR influential`, 8);
  results.awards = dedup(awardResults.filter(isAward));
  await delay(800);

  // 2h. Volunteer / board / community
  const volResults = await braveSearch(`"${name}" volunteer OR "board member" OR nonprofit OR advisory OR mentor`, 8);
  results.volunteer = dedup(volResults.filter(isVolunteer));

  // Dedup discovery results one final time
  const discoveryUrls = new Set();
  results.discovery = results.discovery.filter(item => {
    const key = item.url || item.title;
    if (discoveryUrls.has(key)) return false;
    discoveryUrls.add(key);
    return true;
  });

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Deep research complete: ${total} findings`);
  console.log(`  Discovery: ${results.discovery.length}, Profiles: ${results.profile_pages.length}, Certs: ${results.certifications.length}`);
  console.log(`  Podcasts: ${results.podcasts.length}, Talks: ${results.talks.length}, News: ${results.news.length}`);
  console.log(`  PR: ${results.pr.length}, Content: ${results.content.length}, Awards: ${results.awards.length}`);

  return results;
}

/**
 * Deep web research on a COMPANY.
 * Pulls recent filings, PR, earnings, strategic moves, leadership changes, partnerships.
 */
async function deepCompanyResearch(companyName, domain) {
  if (!BRAVE_API_KEY || (!companyName && !domain)) {
    console.log('[individual-scan] No BRAVE_API_KEY or no company info — skipping company research');
    return { about: [], sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [], investor_relations: [] };
  }

  // Use domain as search term if company name is garbage (short abbreviations, etc.)
  // e.g. "ndbt" is useless but "ndbt.com" will find "North Dallas Bank and Trust"
  const searchName = companyName || domain;
  const altSearchName = domain && domain !== companyName ? domain : null;

  console.log(`[individual-scan] Company deep research: "${searchName}" (domain: ${domain || 'none'}, alt: ${altSearchName || 'none'})`);

  const results = { about: [], sec_filings: [], press_releases: [], news: [], earnings: [], leadership: [], partnerships: [], product_launches: [], hiring_signals: [], investor_relations: [] };
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

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 0: DISCOVER THE COMPANY — search THEIR website, find about pages
  // ═══════════════════════════════════════════════════════════════════════

  if (domain) {
    // Search the company's own website — about pages, leadership, products, services
    const siteResults = await braveSearch(`site:${domain} about OR leadership OR services OR products OR "about us"`, 10);
    results.about.push(...dedup(siteResults));
    await delay(800);

    // Investor relations page (if public)
    const irResults = await braveSearch(`site:${domain} investor OR "investor relations" OR annual report OR SEC`, 8);
    results.investor_relations = dedup(irResults);
    await delay(800);
  }

  // General company overview search
  const overviewResults = await braveSearch(`"${searchName}" company overview OR about OR history`, 10);
  results.about.push(...dedup(overviewResults));
  await delay(800);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: REGULATORY & FINANCIAL FILINGS
  // ═══════════════════════════════════════════════════════════════════════

  // SEC filings (10-K, 10-Q, 8-K) — search with both name and domain
  const secResults = await braveSearch(`"${searchName}" SEC 10-K OR 10-Q OR 8-K filing site:sec.gov`, 8);
  results.sec_filings = dedup(secResults);
  await delay(800);

  if (altSearchName) {
    const secResults2 = await braveSearch(`"${altSearchName}" SEC filing site:sec.gov`, 5);
    results.sec_filings.push(...dedup(secResults2));
    await delay(800);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: RECENT NEWS & PR
  // ═══════════════════════════════════════════════════════════════════════

  // Press releases
  const prResults = await braveNewsSearch(`"${searchName}" press release OR announces OR unveiled OR launched`, 10);
  results.press_releases = dedup(prResults);
  await delay(800);

  // General news
  const newsResults = await braveNewsSearch(`"${searchName}"`, 10);
  results.news.push(...dedup(newsResults));
  await delay(800);

  // Also search with domain if different
  if (altSearchName) {
    const newsResults2 = await braveNewsSearch(`"${altSearchName}"`, 8);
    results.news.push(...dedup(newsResults2));
    await delay(800);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3: FINANCIALS & EARNINGS
  // ═══════════════════════════════════════════════════════════════════════

  const earningsResults = await braveSearch(`"${searchName}" earnings OR revenue OR quarterly results OR annual report`, 8);
  results.earnings = dedup(earningsResults.filter(r => /earning|revenue|profit|quarter|fiscal|financial|annual.report|growth/i.test(r.title + r.description)));
  await delay(800);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 4: LEADERSHIP & STRATEGIC MOVES
  // ═══════════════════════════════════════════════════════════════════════

  const leaderResults = await braveNewsSearch(`"${searchName}" CEO OR CTO OR CFO OR CIO OR VP appointed OR hired OR joins`, 8);
  results.leadership = dedup(leaderResults);
  await delay(800);

  const partnerResults = await braveNewsSearch(`"${searchName}" partnership OR acquisition OR merger OR alliance OR agreement`, 8);
  results.partnerships = dedup(partnerResults);
  await delay(800);

  const productResults = await braveNewsSearch(`"${searchName}" launches OR "new product" OR "new service" OR release OR unveils`, 8);
  results.product_launches = dedup(productResults);
  await delay(800);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 5: HIRING & GROWTH SIGNALS
  // ═══════════════════════════════════════════════════════════════════════

  const hiringResults = await braveSearch(`"${searchName}" hiring OR jobs OR layoffs OR headcount OR expansion OR "open positions"`, 8);
  results.hiring_signals = dedup(hiringResults.filter(r => /hiring|layoff|headcount|workforce|recruit|expansion|new.office|open.position|careers/i.test(r.title + r.description)));

  const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[individual-scan] Company research complete: ${total} findings`);
  console.log(`  About: ${results.about.length}, IR: ${results.investor_relations.length}, SEC: ${results.sec_filings.length}`);
  console.log(`  PR: ${results.press_releases.length}, News: ${results.news.length}, Earnings: ${results.earnings.length}`);
  console.log(`  Leadership: ${results.leadership.length}, Partnerships: ${results.partnerships.length}, Products: ${results.product_launches.length}`);

  return results;
}

// =============================================================================
// LLM PSYCHOGRAPHIC INFERENCE — Analyzes REAL data, doesn't guess
// =============================================================================

const PSYCHOGRAPHIC_PROMPT = `You are an elite B2B sales psychologist and intelligence analyst. You have TWO sources of information:

1. ENRICHED DATA — real, verified data from APIs and web searches (employment history, education, skills, public appearances, news, company filings, press releases). This is your PRIMARY source.
2. YOUR OWN KNOWLEDGE — what you already know about this person, their company, their industry, their certifications, their role type, and how people in similar positions think and buy. USE THIS FREELY.

THE CRITICAL RULE: Never return "insufficient data" or generic filler. EVERY person has a story. If the enrichment data is thin, lean harder on your own knowledge — what does a person with this title at this type of company typically care about? What do their certifications tell you? What does their industry context imply? What does their company's market position suggest?

When you use enrichment data, cite it. When you use your own knowledge, say so (e.g. "Based on typical CIO priorities in community banking..."). Both are valuable. A profile that combines verified data with informed inference is infinitely better than "insufficient data."

YOUR JOB: Produce a psychographic profile that tells a sales rep exactly WHO this person is and HOW to engage them. Think about what ChatGPT would say if someone asked "tell me everything about this person and how to sell to them" — then do BETTER than that because you have actual enrichment data on top of your knowledge.

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
- NEVER return generic filler like "Generic CIO value proposition - cost optimization." That is useless garbage. Every output must be specific to THIS person at THIS company.
- Reference specific career moves, tenure patterns, education, certifications, public appearances when available.
- Show your evidence for every inference. "They spent 12 years at one company → defender archetype" is good. "They seem like a defender" is garbage.
- The key_insight and opening_hook should be SPECIFIC TO THIS PERSON. If you could use the same hook for anyone with a similar title, it's too generic. Redo it.
- If the enrichment data includes their certifications (CISSP, CCSP, etc.) — analyze what those certifications MEAN about how they think and what they value.
- If they have podcast/conference/published content — reference it in the hook. That's gold.
- When enrichment data is thin, use your knowledge of the COMPANY, the INDUSTRY, and the ROLE to fill in the gaps. A CIO at a community bank has very different priorities than a CIO at a Fortune 500 tech company. Use that.
- The COMPANY_INTELLIGENCE section contains live data: about pages, investor relations, SEC filings, press releases, earnings, leadership changes, partnerships, product launches, and hiring signals. USE THIS to:
  * Identify what the company is focused on RIGHT NOW (growth? cost-cutting? transformation?)
  * Spot pain points or priorities from filings/earnings (revenue pressure, competitive threats, strategic pivots)
  * Find timely hooks (congratulate on a recent product launch, reference a recent partnership)
  * Understand if the company is growing (hiring) or contracting (layoffs) — critical for sales approach
  * Link the person's role to the company's current strategic direction
- Even if company_intelligence is empty, use what you KNOW about the company. If it's "North Dallas Bank and Trust" — you know it's a community bank in Texas, you know what community banks care about, you know regulatory pressures they face. USE THAT.

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
 * @param {string} opts.company_url - Company website URL (e.g. ndbt.com)
 * @param {number} opts.tier - 1=full, 2=quick (reserved for future)
 */
async function scanIndividual({ linkedin_url, email, title, name, company_url, tier = 1, supplementalDocs = null }) {
  const startTime = Date.now();
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;

  // Extract domain from company_url if provided (strip protocol, www, trailing paths)
  let inputCompanyDomain = '';
  if (company_url) {
    inputCompanyDomain = company_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[individual-scan] STARTING PIPELINE`);
  console.log(`  LinkedIn: ${linkedin_url || 'N/A'}`);
  console.log(`  Email: ${email || 'N/A'}`);
  console.log(`  Name hint: ${name || 'N/A'}`);
  console.log(`  Title hint: ${title || 'N/A'}`);
  console.log(`  Company URL: ${company_url || 'N/A'} (domain: ${inputCompanyDomain || 'N/A'})`);
  console.log(`${'═'.repeat(60)}`);

  // ─── STAGE 1: APOLLO ENRICHMENT ────────────────────────────────────────────
  console.log('\n[1/5] Apollo Person Enrichment...');
  const apolloPerson = await apolloEnrichPerson(linkedin_url, email);

  let personName = name;
  let personTitle = title;
  let personCompany = '';
  let companyDomain = inputCompanyDomain; // Start with what the user gave us
  let apolloCompany = null;

  if (apolloPerson) {
    personName = apolloPerson.name || name || nameFromSlug(linkedinSlug);
    personTitle = apolloPerson.title || title;
    personCompany = apolloPerson.organization?.name || '';
    // Use Apollo's domain if we don't already have one, or if Apollo's is more specific
    if (!companyDomain) {
      companyDomain = apolloPerson.organization?.primary_domain || '';
    }
    console.log(`  ✓ Found: ${personName}, ${personTitle} @ ${personCompany}`);
  } else {
    personName = name || nameFromSlug(linkedinSlug);
    // Try to derive company name from the domain the user provided
    if (inputCompanyDomain) {
      personCompany = domainToCompanyName(inputCompanyDomain);
      console.log(`  ✗ No Apollo data — derived company name from URL: "${personCompany}"`);
    } else {
      personCompany = companyFromEmail(email) || '';
      console.log(`  ✗ No Apollo data — using hints: ${personName}, ${personCompany}`);
    }
  }

  // Company enrichment via Apollo — try with the domain we have
  if (companyDomain && !apolloCompany) {
    console.log(`  [1b] Apollo Company Enrichment (${companyDomain})...`);
    apolloCompany = await apolloEnrichCompany(companyDomain);
    if (apolloCompany) {
      // Apollo gave us the real company name — use it
      if (!personCompany || personCompany.length < (apolloCompany.name || '').length) {
        personCompany = apolloCompany.name;
      }
      console.log(`  ✓ Company: ${apolloCompany.name}, ~${apolloCompany.estimated_num_employees || '?'} employees, ${apolloCompany.industry || 'unknown industry'}`);
    }
  }

  // ─── STAGE 2: DEEP WEB RESEARCH (INDIVIDUAL) ───────────────────────────────
  console.log('\n[2/5] Deep Web Research — Individual (podcasts, talks, news, content)...');
  // Pass BOTH the company name AND the domain — searches will use whichever works better
  const webResearch = await deepResearch(personName, personCompany, personTitle, companyDomain);

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
    supplementalDocs,
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
          { role: 'user', content: `Analyze this individual and produce a comprehensive psychographic intelligence profile.\n\nENRICHED DATA (verified from APIs and web searches):\n\n${JSON.stringify(enrichmentPackage, null, 2)}\n\nIMPORTANT: If the enrichment data above is thin or incomplete, DO NOT return generic filler. Use your own knowledge of this person, their company, their industry, their certifications, and their role to build a thorough profile. Clearly label which insights come from the enrichment data vs. your own knowledge. A sales rep needs actionable intelligence — "insufficient data" helps nobody.` },
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
      // Raw data (for debugging / display)
      enrichment: enrichmentPackage,
      web_research: webResearch,
      company_research: companyResearch,
      company_url: company_url || null,
      company_domain: companyDomain || null,
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

function buildEnrichmentPackage({ apolloPerson, apolloCompany, webResearch, companyResearch, personName, personTitle, personCompany, linkedin_url, email, supplementalDocs }) {
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
      discovery: (webResearch.discovery || []).slice(0, 15),
      profile_pages: (webResearch.profile_pages || []).slice(0, 10),
      certifications: (webResearch.certifications || []).slice(0, 10),
      podcasts: webResearch.podcasts.slice(0, 8),
      conference_talks: webResearch.talks.slice(0, 8),
      videos: webResearch.videos.slice(0, 8),
      news_mentions: webResearch.news.slice(0, 10),
      pr_announcements: webResearch.pr.slice(0, 8),
      published_content: webResearch.content.slice(0, 8),
      awards: webResearch.awards.slice(0, 8),
      volunteer_board: webResearch.volunteer.slice(0, 8),
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
        about_pages: (companyResearch.about || []).slice(0, 8),
        investor_relations: (companyResearch.investor_relations || []).slice(0, 5),
        sec_filings: companyResearch.sec_filings.slice(0, 8),
        recent_press_releases: companyResearch.press_releases.slice(0, 10),
        recent_news: companyResearch.news.slice(0, 10),
        earnings_financials: companyResearch.earnings.slice(0, 8),
        leadership_changes: companyResearch.leadership.slice(0, 8),
        partnerships_acquisitions: companyResearch.partnerships.slice(0, 8),
        product_launches: companyResearch.product_launches.slice(0, 8),
        hiring_signals: companyResearch.hiring_signals.slice(0, 8),
      };
    }
  }

  // Uploaded documents (first-party intel from the sales rep)
  if (supplementalDocs && supplementalDocs.length > 0) {
    pkg.uploaded_documents = supplementalDocs.map(doc => ({
      filename: doc.filename,
      content: doc.text.slice(0, 30000), // Cap each doc at 30k chars to stay in context
      source: 'uploaded_doc',
    }));
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
  return domainToCompanyName(domain);
}

/** Convert a domain like "ndbt.com" to a rough company name like "Ndbt" */
function domainToCompanyName(domain) {
  if (!domain) return '';
  return domain
    .replace(/^www\./i, '')
    .replace(/\.(com|io|co|net|org|edu|gov|bank|finance|tech)$/i, '')
    .replace(/\./g, ' ')
    .split(' ')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = { scanIndividual };
