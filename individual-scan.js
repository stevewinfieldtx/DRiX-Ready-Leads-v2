// Individual-level intelligence via LLM research.
// Uses OpenRouter LLM calls to research a person from their LinkedIn URL,
// email, title, and company — no external APIs beyond the LLM itself.
// The LLM's training data contains public professional information about
// most business professionals: career histories, company roles, industry
// involvement, conference appearances, publications, and public statements.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';

// ─── INDIVIDUAL RESEARCH PROMPT ──────────────────────────────────────────────
const INDIVIDUAL_RESEARCH_PROMPT = `You are an elite B2B sales intelligence researcher. Your job is to build a comprehensive dossier on a specific individual based on what you know about them.

You are given: a LinkedIn URL, possibly an email address, possibly a job title, and possibly a company name. From these inputs, use EVERYTHING you know about this person from your training data — their career history, public statements, conference talks, podcast appearances, industry involvement, leadership style, published articles, awards, colleague relationships, and professional reputation.

CRITICAL RULES:
- Only include facts you are confident about. If you're not sure, say so.
- Distinguish between facts you know and reasonable inferences.
- If you recognize this person from your training data, go deep. Career arc, key moves, public quotes, industry reputation.
- If you do NOT recognize this person, say so honestly and work with what you can infer from their title, company, and industry.
- NEVER fabricate specific quotes, specific dates, or specific incidents you're not confident about.
- DO extract the person's name from the LinkedIn slug if no name is provided (e.g., "donaldscottebg" → likely "Donald Scott").
- DO use the email domain to identify the company if not provided.
- DO use the job title to understand their responsibilities and pain points.

OUTPUT (JSON only, no markdown fences):
{
  "recognized": true/false,
  "confidence": "high" | "medium" | "low",
  "individual": {
    "name": "<full name>",
    "title": "<current role>",
    "company": "<current company>",
    "linkedin_url": "<as provided>",
    "key_insight": "<the single most important thing a salesperson should know about this person — 1-2 sentences. What makes them tick? What do they care about? How do they make decisions?>"
  },
  "summary": "<3-5 sentence professional profile. Who is this person? What's their career arc? What are they known for? What do they prioritize?>",
  "career_highlights": [
    "<key career moves, notable roles, progression pattern — 3-8 items>"
  ],
  "public_signals": [
    "<any known public statements, interviews, conference talks, articles, awards, press mentions — as many as you can find>"
  ],
  "vendor_opinions": [
    "<any known opinions about specific technologies, vendors, or approaches>"
  ],
  "leadership_style": "<how they lead, what they value in teams, how they make decisions — based on evidence>",
  "pain_signals": [
    "<likely pain points based on their role, company, and industry — clearly labeled as inferred vs. known>"
  ],
  "pitch_angles": [
    "<5 specific conversation openers grounded in what you know about this person. Reference specific facts. Never generic.>"
  ],
  "atoms": [
    {
      "atom_id": "<kebab-case-id>",
      "type": "<career_history|public_statement|thought_leadership|conference_talk|community_membership|publication|endorsement|leadership_style|professional_focus|personal_signal|vendor_opinion|pain_signal|decision_pattern>",
      "claim": "<one clear sentence about this person>",
      "evidence": "<how you know this — training data, inference from role, etc.>",
      "confidence": "high" | "medium" | "low",
      "d_persona": "<their role>",
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
- 15-40 atoms depending on how much you know.
- If you recognize them: go deep. Career arc, public quotes, industry reputation, colleague relationships, awards.
- If you don't recognize them: be honest, work from title/company/industry, clearly label everything as inferred.
- The key_insight field is the MOST IMPORTANT output. It should make a salesperson say "oh, THAT's how I get this person's attention."
- pitch_angles must reference specific facts, not generic "let's discuss your challenges" language.`;

/**
 * Extract person's name from LinkedIn URL slug.
 */
function nameFromSlug(slug) {
  if (!slug) return null;
  const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '').replace(/\d+$/, '');
  return cleaned.split(/[-_]/).filter(p => p.length > 1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/**
 * Extract company from email domain.
 */
function companyFromEmail(email) {
  if (!email) return null;
  const domain = email.split('@')[1];
  if (!domain) return null;
  return domain.replace(/\.(com|io|co|net|org|edu|gov)$/i, '').replace(/\./g, ' ').split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/**
 * Run individual research via LLM and return structured intelligence.
 */
async function scanIndividual({ linkedin_url, email, title, name, tier = 1 }) {
  const linkedinSlug = linkedin_url ? (linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1] || null) : null;
  const personName = name || nameFromSlug(linkedinSlug);
  const company = companyFromEmail(email);

  console.log(`[individual-scan] starting: name=${personName} title=${title || 'unknown'} company=${company || 'unknown'} linkedin=${linkedin_url}`);

  if (!OPENROUTER_API_KEY) {
    console.log('[individual-scan] No OPENROUTER_API_KEY — cannot research');
    return {
      scan: { total_found: 0, accounts: [], web_results: 0 },
      atoms: [],
      individual: { name: personName, title, linkedin_url, email },
      summary: 'LLM not configured — cannot research individual.',
      pitch_angles: []
    };
  }

  // Build the research request — give the LLM everything we have
  const researchInput = {
    linkedin_url: linkedin_url || null,
    linkedin_slug: linkedinSlug || null,
    email: email || null,
    email_domain: email ? email.split('@')[1] : null,
    name: personName || null,
    title: title || null,
    company: company || null
  };

  try {
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
          { role: 'system', content: INDIVIDUAL_RESEARCH_PROMPT },
          { role: 'user', content: `Research this individual and build a complete intelligence dossier:\n\n${JSON.stringify(researchInput, null, 2)}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 8000
      }),
      signal: AbortSignal.timeout(60000)
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

    console.log(`[individual-scan] LLM research complete: recognized=${parsed.recognized}, confidence=${parsed.confidence}, ${(parsed.atoms || []).length} atoms, ${(parsed.pitch_angles || []).length} pitch angles`);

    return {
      scan: {
        total_found: 0,
        accounts: [],
        web_results: 0,
        recognized: parsed.recognized,
        confidence: parsed.confidence
      },
      atoms: parsed.atoms || [],
      individual: parsed.individual || { name: personName, title, linkedin_url, email },
      summary: parsed.summary || '',
      pitch_angles: parsed.pitch_angles || [],
      key_insight: parsed.individual?.key_insight || null,
      career_highlights: parsed.career_highlights || [],
      public_signals: parsed.public_signals || [],
      vendor_opinions: parsed.vendor_opinions || [],
      leadership_style: parsed.leadership_style || null,
      pain_signals: parsed.pain_signals || []
    };

  } catch (err) {
    console.error(`[individual-scan] LLM research failed:`, err.message);
    return {
      scan: { total_found: 0, accounts: [], web_results: 0 },
      atoms: [],
      individual: { name: personName, title, linkedin_url, email },
      summary: `Individual research failed: ${err.message}`,
      pitch_angles: []
    };
  }
}

module.exports = { scanIndividual };
