// Individual-level intelligence via web research.
// Searches for the person by name + company + role, scrapes the results,
// and decomposes into TDE-compatible 9D atoms — just like sender/solution/customer.

const MAIGRET_API_URL = (process.env.MAIGRET_API_URL || 'https://drix-api.up.railway.app').replace(/\/$/, '');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';

// ─── INDIVIDUAL INGEST PROMPT ────────────────────────────────────────────────
// Separate from the company ingest prompt. This is about a PERSON, not a company.
const INDIVIDUAL_INGEST_PROMPT = `You are the individual-intelligence phase of TDE (Targeted Decomposition Engine).

INPUT: web research results about a specific person — their LinkedIn profile, trade press mentions, podcast appearances, conference talks, blog posts, press releases quoting them, colleague testimonials, and any other publicly available information.

TASK: decompose into ATOMIC RETRIEVABLE UNITS about this INDIVIDUAL. Each atom is a single, self-contained fact about the person — NOT about their company (company atoms come from the customer ingest).

ATOM TYPES for individuals:
  "career_history", "public_statement", "thought_leadership", "conference_talk",
  "community_membership", "publication", "endorsement", "leadership_style",
  "professional_focus", "personal_signal", "vendor_opinion", "pain_signal",
  "decision_pattern", "contact_info"

EVERY ATOM IS TAGGED ACROSS 9 DIMENSIONS (d_* fields):
  1. d_persona:              the person's role/archetype
  2. d_buying_stage:         what stage their public signals suggest
  3. d_emotional_driver:     what motivates them based on evidence
  4. d_evidence_type:        one of [Direct Quote, Public Post, Third-Party Reference, Career Data, Conference Talk, Podcast, Press Release, Colleague Testimonial, Community Activity]
  5. d_credibility:          integer 1-5 (1 = inferred, 5 = direct quote or verified fact)
  6. d_recency:              one of [Current Quarter, This Year, Last 1-2 Years, Dated (3-5yr), Evergreen]
  7. d_economic_driver:      what economic lever they care about
  8. d_status_quo_pressure:  inertia signals from their public statements
  9. d_industry:             object { "naics": "<sector>", "sic": "<division>" }

OUTPUT (JSON only, no markdown fences):
  {
    "individual": {
      "name": "<person's name>",
      "title": "<current role>",
      "company": "<current company>",
      "linkedin_url": "<if provided>",
      "key_insight": "<the single most important thing a salesperson should know about this person — 1-2 sentences>"
    },
    "summary": "<2-3 sentence profile of this person's professional identity, priorities, and communication style>",
    "pitch_angles": [
      "<3-5 specific conversation openers grounded in the research>"
    ],
    "atoms": [ 20-50 atoms ]
  }

DISCIPLINE:
- 20-50 atoms. Each about the INDIVIDUAL, not their company.
- Prioritize: direct quotes, public opinions about vendors/tools, pain signals, leadership style indicators, career patterns.
- "public_statement" atoms are gold — exact things they've said publicly that reveal priorities.
- "vendor_opinion" atoms — any public praise or criticism of specific technologies/vendors.
- "pain_signal" atoms — complaints, frustrations, challenges they've mentioned publicly.
- "decision_pattern" atoms — how they make decisions, what they value, what they dismiss.
- The key_insight field should be the thing that makes a salesperson say "oh, THAT's how I get this person's attention."
- pitch_angles should reference specific facts from the research — never generic.`;

/**
 * Classify persona type from a job title string.
 */
function classifyPersona(title) {
  if (!title) return 'general';
  const t = title.toLowerCase();
  if (/\b(cto|vp\s*eng|architect|devops|sre|developer|software|platform|infra)/i.test(t)) return 'technical';
  if (/\b(ciso|security|soc\s|infosec|cyber|threat)/i.test(t)) return 'security';
  if (/\b(ceo|coo|cfo|cro|president|founder|board|managing\s*director)/i.test(t)) return 'executive';
  if (/\b(channel|partner|alliance|distribution|reseller|var\b|msp\b|category\s*manage)/i.test(t)) return 'channel';
  if (/\b(cmo|marketing|sales|revenue|growth|demand|brand|content\s*market)/i.test(t)) return 'business';
  return 'general';
}

/**
 * Extract person's name from LinkedIn URL slug.
 */
function nameFromSlug(slug) {
  if (!slug) return null;
  // Remove trailing hash suffixes and common suffixes like "ebg", "tx", numbers
  const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '').replace(/\d+$/, '');
  // Split on hyphens, capitalize each part
  return cleaned.split('-').filter(p => p.length > 1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/**
 * Build search queries to find information about this individual.
 */
function buildSearchQueries(name, linkedinSlug, email, title, company) {
  const queries = [];
  const personName = name || nameFromSlug(linkedinSlug);
  if (!personName) return queries;

  // Extract company from email domain if not provided
  const emailDomain = email ? email.split('@')[1]?.replace(/\.(com|io|co|net|org)$/i, '') : null;
  const companyName = company || emailDomain;

  // Core search: name + company
  if (companyName) {
    queries.push(`"${personName}" "${companyName}"`);
    queries.push(`"${personName}" "${companyName}" interview OR podcast OR keynote OR conference`);
    queries.push(`"${personName}" "${companyName}" channel OR partner OR strategy`);
  }

  // Trade press
  queries.push(`"${personName}" CRN OR "Channel Futures" OR "MSSP Alert" OR "Channel Partners"`);

  // General professional presence
  queries.push(`"${personName}" ${title || ''} interview OR quote OR podcast`);

  return queries.slice(0, 5); // Cap at 5 searches
}

/**
 * Perform web searches and aggregate results.
 * Uses Firecrawl for JS-rendered scraping when available, falls back to basic fetch.
 */
async function webResearchIndividual({ name, linkedin_url, email, title }) {
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;
  const personName = name || nameFromSlug(linkedinSlug);
  const emailDomain = email ? email.split('@')[1]?.replace(/\.(com|io|co|net|org)$/i, '') : null;

  if (!personName) {
    console.log('[individual-research] No name or slug — cannot search');
    return { searchResults: [], personName: null };
  }

  console.log(`[individual-research] Researching: ${personName} (${title || 'no title'}) at ${emailDomain || 'unknown company'}`);

  const queries = buildSearchQueries(personName, linkedinSlug, email, title, null);
  const allResults = [];

  for (const query of queries) {
    try {
      // Use Google search via fetch
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TDEDemo/3.0)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Extract URLs from search results
      const urlMatches = html.match(/https?:\/\/[^\s"<>]+/g) || [];
      const goodUrls = urlMatches.filter(u =>
        !u.includes('google.com') && !u.includes('googleapis.com') &&
        !u.includes('gstatic.com') && !u.includes('schema.org') &&
        !u.includes('w3.org') && u.length < 300
      ).slice(0, 3);

      for (const url of goodUrls) {
        if (allResults.some(r => r.url === url)) continue;
        try {
          // Try Firecrawl first
          let text = null;
          if (FIRECRAWL_API_KEY) {
            try {
              const fcRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
                signal: AbortSignal.timeout(15000)
              });
              if (fcRes.ok) {
                const fcData = await fcRes.json();
                text = fcData?.data?.markdown || null;
              }
            } catch (e) { /* fall through to basic fetch */ }
          }

          // Basic fetch fallback
          if (!text) {
            const pageRes = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TDEDemo/3.0)' },
              signal: AbortSignal.timeout(10000)
            });
            if (pageRes.ok) {
              const pageHtml = await pageRes.text();
              text = pageHtml
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ').trim();
            }
          }

          if (text && text.length > 100) {
            // Only keep if the person's name actually appears in the content
            const nameWords = personName.toLowerCase().split(/\s+/);
            const textLower = text.toLowerCase();
            const nameHits = nameWords.filter(w => w.length > 2 && textLower.includes(w)).length;
            if (nameHits >= Math.min(2, nameWords.length)) {
              allResults.push({ url, text: text.slice(0, 8000), query });
              console.log(`[individual-research] Found: ${url} (${text.length} chars, query: "${query}")`);
            }
          }
        } catch (e) { /* skip this URL */ }
      }
    } catch (e) {
      console.log(`[individual-research] Search failed for "${query}": ${e.message}`);
    }
  }

  console.log(`[individual-research] ${allResults.length} relevant pages found for ${personName}`);
  return { searchResults: allResults, personName };
}

/**
 * Run individual research and return structured intelligence.
 */
async function scanIndividual({ linkedin_url, email, title, name, tier = 1 }) {
  const persona_type = classifyPersona(title);
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;
  const personName = name || nameFromSlug(linkedinSlug);

  console.log(`[individual-scan] starting: name=${personName} linkedin=${linkedin_url} email=${email || 'n/a'} persona=${persona_type}`);

  // Step 1: Web research — find everything public about this person
  const { searchResults } = await webResearchIndividual({ name: personName, linkedin_url, email, title });

  // Step 2: Optionally run Maigret for supplementary platform discovery
  let maigretAccounts = [];
  try {
    const maigretBody = { linkedin_url, persona_type, tier };
    if (email) maigretBody.email = email;
    const maigretRes = await fetch(`${MAIGRET_API_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maigretBody),
      signal: AbortSignal.timeout(120000),
    });
    if (maigretRes.ok) {
      const maigretData = await maigretRes.json();
      // Filter false positives using name matching
      maigretAccounts = (maigretData.accounts || []).filter(account => {
        const ids = account.ids || {};
        const fullname = (ids.fullname || ids.username || ids.name || '').toLowerCase();
        if (!fullname || fullname.length < 2) return true;
        const nameParts = (personName || '').toLowerCase().split(/\s+/).filter(p => p.length > 2);
        return nameParts.some(part => fullname.includes(part)) || !ids.fullname;
      });
      console.log(`[individual-scan] Maigret: ${maigretAccounts.length} verified accounts (${maigretData.total_found} raw, ${(maigretData.total_found || 0) - maigretAccounts.length} filtered)`);
    }
  } catch (e) {
    console.log(`[individual-scan] Maigret skipped: ${e.message}`);
  }

  // Step 3: Combine all research into LLM input for decomposition
  const researchContent = [];

  if (searchResults.length) {
    researchContent.push('=== WEB RESEARCH RESULTS ===');
    for (const r of searchResults) {
      researchContent.push(`\n--- Source: ${r.url} ---\n${r.text.slice(0, 5000)}`);
    }
  }

  if (maigretAccounts.length) {
    researchContent.push('\n=== DIGITAL PLATFORM PRESENCE ===');
    researchContent.push('The following accounts were confirmed via OSINT scanning:');
    for (const a of maigretAccounts.slice(0, 20)) {
      const info = a.ids?.fullname ? ` (${a.ids.fullname})` : '';
      researchContent.push(`- ${a.site}: ${a.url}${info}`);
    }
  }

  if (linkedin_url) {
    researchContent.push(`\n=== LINKEDIN ===\nProfile URL: ${linkedin_url}`);
  }
  if (email) {
    researchContent.push(`Email: ${email}`);
  }
  if (title) {
    researchContent.push(`Title/Role: ${title}`);
  }

  const combinedResearch = researchContent.join('\n');

  if (combinedResearch.length < 200) {
    console.log('[individual-scan] Not enough research data to decompose');
    return {
      scan: { total_found: maigretAccounts.length, accounts: maigretAccounts, web_results: searchResults.length },
      atoms: [],
      individual: null,
      summary: 'Insufficient public data found for this individual.',
      pitch_angles: []
    };
  }

  // Step 4: Decompose via LLM — same pattern as sender/solution/customer
  if (!OPENROUTER_API_KEY) {
    console.log('[individual-scan] No OPENROUTER_API_KEY — returning raw research only');
    return {
      scan: { total_found: maigretAccounts.length, accounts: maigretAccounts, web_results: searchResults.length },
      atoms: [],
      individual: { name: personName, title, linkedin_url, email },
      summary: `Found ${searchResults.length} web sources and ${maigretAccounts.length} platform accounts. LLM decomposition unavailable.`,
      pitch_angles: []
    };
  }

  try {
    const userContent = JSON.stringify({
      person_name: personName,
      title: title || null,
      linkedin_url,
      email: email || null,
      research: combinedResearch
    });

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'TDE Individual Intelligence'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL_ID,
        messages: [
          { role: 'system', content: INDIVIDUAL_INGEST_PROMPT },
          { role: 'user', content: userContent }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 8000
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
    const parsed = JSON.parse(cleaned);

    console.log(`[individual-scan] LLM decomposed: ${(parsed.atoms || []).length} atoms, ${(parsed.pitch_angles || []).length} pitch angles`);

    return {
      scan: {
        total_found: maigretAccounts.length,
        accounts: maigretAccounts,
        web_results: searchResults.length,
        sources: searchResults.map(r => r.url)
      },
      atoms: parsed.atoms || [],
      individual: parsed.individual || { name: personName, title, linkedin_url, email },
      summary: parsed.summary || '',
      pitch_angles: parsed.pitch_angles || [],
      key_insight: parsed.individual?.key_insight || null
    };

  } catch (err) {
    console.error(`[individual-scan] LLM decomposition failed:`, err.message);
    return {
      scan: { total_found: maigretAccounts.length, accounts: maigretAccounts, web_results: searchResults.length },
      atoms: [],
      individual: { name: personName, title, linkedin_url, email },
      summary: `Web research found ${searchResults.length} sources but LLM decomposition failed: ${err.message}`,
      pitch_angles: []
    };
  }
}

module.exports = { scanIndividual, classifyPersona };
