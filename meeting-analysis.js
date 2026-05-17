// meeting-analysis.js — DRiX Meeting Analysis Engine
// Three-tier meeting intelligence: Single → Group → Ready Leads
//
// Every scan at every tier feeds TDE. Cache hits = near-zero cost, full price charged.
//
// Dependencies:
//   - individual-scan.js (scanIndividual)
//   - server.js TDE helpers (passed in via config)
//   - OpenRouter / Cerebras for synthesis

const { scanIndividual } = require('./individual-scan');

// ─── PROMPTS ─────────────────────────────────────────────────────────────────

const GROUP_DYNAMICS_PROMPT = `You are an elite meeting strategist and organizational psychologist. You analyze groups of people attending a meeting and determine how to navigate the room.

INPUT: Individual psychographic profiles for each meeting attendee. Each profile includes: archetype, decision style, risk appetite, motivations, communication preferences, and key insights.

TASK: Produce a GROUP DYNAMICS analysis that tells the user exactly how to work the room.

OUTPUT (JSON only, no markdown fences):
{
  "powerMap": {
    "decisionMaker": "<name of the person with final authority — infer from title, archetype, tenure>",
    "influencers": ["<names of people who shape the decision-maker's thinking>"],
    "blockers": ["<names of people likely to resist — defenders, risk-averse, political gatekeepers>"],
    "champions": ["<names of people likely to advocate for change — growers, pioneers>"],
    "observers": ["<names of people along for the ride — no strong pull either way>"]
  },
  "alliances": [
    "<description of likely alliance: 'X and Y are probably aligned because...' — based on complementary archetypes, shared motivations, or org structure>"
  ],
  "tensions": [
    "<description of likely tension: 'X and Y may clash because...' — based on opposing archetypes, competing priorities>"
  ],
  "groupStrategy": "<2-3 paragraph strategy for how to navigate this specific group. Address: who to win first, how to handle the blocker(s), how to leverage the champion(s), how to sequence your arguments.>",
  "sequencing": {
    "openWith": "<who to address first and why>",
    "buildMomentum": "<how to cascade buy-in through the group>",
    "neutralize": "<how to handle the blocker(s) without creating conflict>",
    "close": "<how to drive toward next steps given this group's dynamics>"
  },
  "landmines": [
    "<specific topics, phrases, or approaches that will trigger resistance from specific people — name the person and the trigger>"
  ],
  "roomEnergy": "<overall read: is this a skeptical room, an enthusiastic room, a divided room, a political room?>",
  "winCondition": "<what needs to happen in this meeting for it to be a success — given who's in the room>"
}

RULES:
- Every assertion must reference a specific person by name and cite their profile data.
- Be specific. "Address the CFO's concerns" is garbage. "Address Maria's sunk-cost anxiety about the existing Oracle investment" is good.
- The powerMap is NOT just about titles. A VP who's a Defender with high political influence can block a CTO's decision. Read the archetypes.
- Consider tenure and decision speed. A new hire has less political capital. A long-tenure Defender has deep organizational roots.
- If only 2 people are in the meeting, still do the full analysis — power dynamics exist in pairs too.`;

const READYLEADS_SYNTHESIS_PROMPT = `You are the DRiX Ready Leads meeting intelligence engine. You synthesize individual profiles, group dynamics, company context, industry context, and the specific solution being pitched into a comprehensive meeting strategy.

INPUT:
- Individual psychographic profiles for each attendee
- Group dynamics analysis (power map, alliances, tensions)
- Solution being pitched (what we're selling)
- Company context (what this company cares about right now)
- Industry context (regulatory, competitive, market forces)
- Meeting type (discovery, demo, negotiation, renewal)

TASK: Produce a FULL MEETING STRATEGY that intersects ALL of these dimensions.

OUTPUT (JSON only, no markdown fences):
{
  "executiveSummary": "<3-4 sentences: the single most important thing to know going into this meeting>",
  "solutionIntersection": {
    "perPerson": [
      {
        "name": "<attendee name>",
        "relevantPainPoints": ["<pain points THIS person has that our solution addresses>"],
        "messagingAngle": "<how to frame our solution specifically for this person's archetype and priorities>",
        "objections": [
          { "objection": "<what they'll push back on>", "response": "<specific counter grounded in their profile>" }
        ],
        "proofPoints": ["<specific evidence types that will resonate with this person — reference their evidence preferences and credibility thresholds>"],
        "economicFrame": "<which economic driver to emphasize: ROI, cost-out, speed, quality, growth, risk-reduction>",
        "statusQuoCounter": "<how to defuse their specific inertia — sunk cost, change fatigue, risk aversion, etc.>"
      }
    ]
  },
  "companyContext": {
    "strategicPriorities": ["<what the company is focused on right now>"],
    "recentEvents": ["<notable recent events that create openings or risks>"],
    "financialHealth": "<growing|stable|contracting|restructuring>",
    "buyingSignals": ["<signals that suggest they're ready to buy>"],
    "riskFactors": ["<signals that suggest they might stall or pass>"]
  },
  "industryOverlay": {
    "regulatoryPressures": ["<regulations or compliance drivers relevant to our solution>"],
    "competitiveLandscape": "<what competitors are doing in this space — how we differentiate>",
    "marketTrends": ["<industry trends that create urgency for our solution>"],
    "buyingPatterns": "<how companies in this industry typically buy — cycle, committee, criteria>"
  },
  "meetingScript": {
    "opening": "<exact opening approach — who to greet first, what to say, how to set the tone>",
    "agendaFraming": "<how to frame the meeting agenda in a way that serves our strategy>",
    "transitionPoints": [
      { "from": "<topic>", "to": "<topic>", "trigger": "<what signals it's time to move>" }
    ],
    "assignments": [
      { "topic": "<what to cover>", "directedAt": "<which attendee>", "why": "<strategic reason>" }
    ],
    "closingMove": "<how to close — what next step to propose, who to direct it at>"
  },
  "followUp": [
    {
      "person": "<name>",
      "action": "<what to send/do>",
      "channel": "email|linkedin|phone|text",
      "timing": "same-day|next-day|3-days|1-week",
      "contentAngle": "<what to emphasize in the follow-up for this specific person>"
    }
  ],
  "dealKillers": ["<things that will definitely kill this deal if they happen in the meeting>"],
  "wildcards": ["<unexpected things that could swing the meeting positively or negatively>"]
}

RULES:
- Every piece of advice must be grounded in the actual profile data. No generic sales platitudes.
- The solution intersection must be SPECIFIC to the actual solution being pitched. Don't just say "our solution addresses their pain" — say exactly HOW.
- Company context must reference real data from the enrichment. If we know they had a recent acquisition, reference it.
- Industry overlay must be specific to their actual industry, not generic "digital transformation" hand-waving.
- The meeting script should be detailed enough that someone could literally follow it.
- Follow-up should be differentiated per person — different people need different things after the meeting.`;

// ─── CORE ENGINE ─────────────────────────────────────────────────────────────

/**
 * Analyze a single person for a meeting. This is Tier 1 (free).
 * Wraps scanIndividual and stores results in TDE.
 *
 * @param {Object} attendee - { name, company, title, linkedin, email, company_url }
 * @param {Object} tdeConfig - { tdeRequest, warmTdeCacheAsync, tdeAvailable, urlToCollectionId }
 * @returns {Object} Individual profile
 */
async function analyzeSingle(attendee, tdeConfig) {
  const startTime = Date.now();

  // Run the individual scan pipeline
  const scanResult = await scanIndividual({
    linkedin_url: attendee.linkedin || null,
    email: attendee.email || null,
    title: attendee.title || null,
    name: attendee.name || null,
    company_url: attendee.company_url || null,
    tier: 1,
  });

  // Fire-and-forget: push person atoms into TDE for cache
  if (tdeConfig.tdeAvailable() && scanResult.atoms && scanResult.atoms.length > 0) {
    const collectionId = personCollectionId(attendee.name, attendee.company);
    warmPersonCache(collectionId, scanResult, tdeConfig);
  }

  return {
    name: scanResult.individual?.name || attendee.name,
    title: scanResult.individual?.title || attendee.title,
    company: scanResult.individual?.company || attendee.company,
    profileSummary: scanResult.summary || '',
    keyInsight: scanResult.key_insight || '',
    psychographic: scanResult.psychographic || null,
    communicationStyle: scanResult.psychographic?.communication_style || 'unknown',
    decisionRole: inferDecisionRole(scanResult),
    archetype: scanResult.psychographic?.archetype || 'unknown',
    decisionStyle: scanResult.psychographic?.decision_style || 'unknown',
    riskAppetite: scanResult.psychographic?.risk_appetite || 'unknown',
    approach: {
      openWith: scanResult.opening_hook || '',
      languageThatResonates: scanResult.phrases_to_use || [],
      avoid: scanResult.phrases_to_avoid || [],
    },
    conversationStarters: scanResult.conversation_starters || [],
    pitchAngles: scanResult.pitch_angles || [],
    objections: scanResult.objections || [],
    painSignals: scanResult.pain_signals || [],
    companySituation: scanResult.company_situation || null,
    rapportHooks: scanResult.rapport_hooks || [],
    atoms: scanResult.atoms || [],
    cacheStatus: 'miss', // TODO: check TDE first in future iteration
    pipelineTimeMs: Date.now() - startTime,
  };
}

/**
 * Analyze a group of people for a meeting. This is Tier 2 (premium).
 * Runs individual scans in parallel, then synthesizes group dynamics.
 *
 * @param {Array} attendees - Array of attendee objects
 * @param {Object} tdeConfig - TDE helper functions
 * @param {Object} llmConfig - { openrouterApiKey, modelId, cerebrasApiKey }
 * @returns {Object} Group analysis with individual profiles + dynamics
 */
async function analyzeGroup(attendees, tdeConfig, llmConfig) {
  const startTime = Date.now();

  if (!attendees || attendees.length < 2) {
    throw new Error('Group analysis requires at least 2 attendees');
  }
  if (attendees.length > 10) {
    throw new Error('Group analysis supports a maximum of 10 attendees');
  }

  // Scan all individuals in parallel
  console.log(`[meeting-analysis] Scanning ${attendees.length} attendees in parallel...`);
  const individualPromises = attendees.map(a => analyzeSingle(a, tdeConfig));
  const individuals = await Promise.all(individualPromises);

  // Synthesize group dynamics via LLM
  console.log(`[meeting-analysis] Synthesizing group dynamics...`);
  const groupDynamics = await synthesizeGroupDynamics(individuals, llmConfig);

  return {
    individuals,
    groupDynamics,
    attendeeCount: attendees.length,
    totalAtoms: individuals.reduce((sum, ind) => sum + (ind.atoms?.length || 0), 0),
    pipelineTimeMs: Date.now() - startTime,
  };
}

/**
 * Full Ready Leads meeting analysis. This is Tier 3 (full product).
 * Individual scans + group dynamics + solution × company × industry intersection.
 *
 * @param {Array} attendees - Array of attendee objects
 * @param {Object} context - { solution, company, industry, meetingType, notes }
 * @param {Object} tdeConfig - TDE helper functions
 * @param {Object} llmConfig - LLM configuration
 * @returns {Object} Complete meeting intelligence package
 */
async function analyzeReadyLeads(attendees, context, tdeConfig, llmConfig) {
  const startTime = Date.now();

  if (!attendees || attendees.length < 1) {
    throw new Error('Ready Leads analysis requires at least 1 attendee');
  }
  if (attendees.length > 10) {
    throw new Error('Ready Leads analysis supports a maximum of 10 attendees');
  }
  if (!context?.solution) {
    throw new Error('Ready Leads analysis requires context.solution');
  }

  // Step 1: Run group analysis (which includes individual scans)
  console.log(`[meeting-analysis] Ready Leads: full analysis for ${attendees.length} attendees...`);
  let groupResult;
  if (attendees.length === 1) {
    // Single attendee — just scan them, skip group dynamics
    const individual = await analyzeSingle(attendees[0], tdeConfig);
    groupResult = {
      individuals: [individual],
      groupDynamics: null,
      attendeeCount: 1,
      totalAtoms: individual.atoms?.length || 0,
    };
  } else {
    groupResult = await analyzeGroup(attendees, tdeConfig, llmConfig);
  }

  // Step 2: Synthesize the full Ready Leads intersection
  console.log(`[meeting-analysis] Ready Leads: synthesizing solution intersection...`);
  const synthesis = await synthesizeReadyLeads(
    groupResult.individuals,
    groupResult.groupDynamics,
    context,
    llmConfig
  );

  return {
    individuals: groupResult.individuals,
    groupDynamics: groupResult.groupDynamics,
    solutionIntersection: synthesis,
    context,
    attendeeCount: attendees.length,
    totalAtoms: groupResult.totalAtoms,
    pipelineTimeMs: Date.now() - startTime,
  };
}

// ─── LLM SYNTHESIS FUNCTIONS ─────────────────────────────────────────────────

async function synthesizeGroupDynamics(individuals, llmConfig) {
  if (!llmConfig.openrouterApiKey) {
    console.log('[meeting-analysis] No LLM configured — returning empty group dynamics');
    return null;
  }

  // Build a condensed profile summary for the LLM (strip raw atoms to save tokens)
  const profileSummaries = individuals.map(ind => ({
    name: ind.name,
    title: ind.title,
    company: ind.company,
    archetype: ind.archetype,
    decisionStyle: ind.decisionStyle,
    riskAppetite: ind.riskAppetite,
    keyInsight: ind.keyInsight,
    communicationStyle: ind.communicationStyle,
    profileSummary: ind.profileSummary,
    painSignals: ind.painSignals,
    conversationStarters: ind.conversationStarters?.slice(0, 4),
    objections: ind.objections?.slice(0, 3),
    companySituation: ind.companySituation,
  }));

  try {
    // Use Cerebras for speed if available, fall back to OpenRouter
    const useSpeed = !!llmConfig.cerebrasApiKey;
    const endpoint = useSpeed
      ? 'https://api.cerebras.ai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const headers = useSpeed
      ? { 'Authorization': `Bearer ${llmConfig.cerebrasApiKey}`, 'Content-Type': 'application/json' }
      : { 'Authorization': `Bearer ${llmConfig.openrouterApiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'DRiX Meeting Analysis' };
    const model = useSpeed ? 'llama-4-scout-17b-16e-instruct' : (llmConfig.modelId || 'anthropic/claude-sonnet-4.5');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: GROUP_DYNAMICS_PROMPT },
          { role: 'user', content: `Analyze the group dynamics for this meeting. Here are the individual profiles:\n\n${JSON.stringify(profileSummaries, null, 2)}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 8000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[meeting-analysis] Group dynamics synthesis failed:', err.message);
    return null;
  }
}

async function synthesizeReadyLeads(individuals, groupDynamics, context, llmConfig) {
  if (!llmConfig.openrouterApiKey) {
    console.log('[meeting-analysis] No LLM configured — returning empty synthesis');
    return null;
  }

  // Build condensed input for the synthesis prompt
  const profileSummaries = individuals.map(ind => ({
    name: ind.name,
    title: ind.title,
    company: ind.company,
    archetype: ind.archetype,
    decisionStyle: ind.decisionStyle,
    riskAppetite: ind.riskAppetite,
    keyInsight: ind.keyInsight,
    communicationStyle: ind.communicationStyle,
    profileSummary: ind.profileSummary,
    painSignals: ind.painSignals,
    pitchAngles: ind.pitchAngles?.slice(0, 3),
    objections: ind.objections?.slice(0, 4),
    companySituation: ind.companySituation,
    rapportHooks: ind.rapportHooks?.slice(0, 3),
  }));

  const synthesisInput = {
    attendees: profileSummaries,
    groupDynamics: groupDynamics || null,
    solution: context.solution,
    company: context.company || individuals[0]?.company || 'Unknown',
    industry: context.industry || 'Unknown',
    meetingType: context.meetingType || 'discovery',
    additionalNotes: context.notes || null,
  };

  try {
    // Ready Leads synthesis needs quality — use OpenRouter/Claude
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${llmConfig.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'DRiX Ready Leads Meeting Intelligence',
      },
      body: JSON.stringify({
        model: llmConfig.modelId || 'anthropic/claude-sonnet-4.5',
        messages: [
          { role: 'system', content: READYLEADS_SYNTHESIS_PROMPT },
          { role: 'user', content: `Produce a full meeting strategy for this engagement:\n\n${JSON.stringify(synthesisInput, null, 2)}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 16000,
      }),
      signal: AbortSignal.timeout(120000), // 2 min — complex synthesis
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LLM ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[meeting-analysis] Ready Leads synthesis failed:', err.message);
    return null;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function personCollectionId(name, company) {
  const slug = `${name || 'unknown'}-${company || 'unknown'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return `person-${slug}`;
}

function warmPersonCache(collectionId, scanResult, tdeConfig) {
  // Fire-and-forget: push individual atoms into TDE
  if (!tdeConfig.tdeAvailable()) return;

  (async () => {
    try {
      // Create collection for this person
      await tdeConfig.tdeRequest('POST', '/collections', {
        id: collectionId,
        name: scanResult.individual?.name || collectionId,
        description: `Individual intelligence: ${scanResult.individual?.name} at ${scanResult.individual?.company}`,
        templateId: 'business',
      });
    } catch (e) { /* already exists — fine */ }

    try {
      // Ingest the person's profile as content
      const content = [
        `# ${scanResult.individual?.name}`,
        `**Title:** ${scanResult.individual?.title}`,
        `**Company:** ${scanResult.individual?.company}`,
        '',
        `## Summary`,
        scanResult.summary || '',
        '',
        `## Key Insight`,
        scanResult.key_insight || '',
        '',
        `## Psychographic Profile`,
        `- Archetype: ${scanResult.psychographic?.archetype}`,
        `- Decision Style: ${scanResult.psychographic?.decision_style}`,
        `- Risk Appetite: ${scanResult.psychographic?.risk_appetite}`,
        `- Primary Motivation: ${scanResult.psychographic?.primary_motivation}`,
        '',
        `## Pain Signals`,
        ...(scanResult.pain_signals || []).map(p => `- ${p}`),
        '',
        `## Company Situation`,
        scanResult.company_situation ? JSON.stringify(scanResult.company_situation, null, 2) : 'N/A',
      ].join('\n');

      await tdeConfig.tdeRequest('POST', '/ingest', {
        collectionId,
        type: 'text',
        input: content,
        opts: { title: `${scanResult.individual?.name} - Individual Intelligence` },
      });
      console.log(`[meeting-analysis] TDE cache warmed for ${collectionId}`);
    } catch (e) {
      console.log(`[meeting-analysis] TDE cache warm failed for ${collectionId}: ${e.message}`);
    }
  })();
}

function inferDecisionRole(scanResult) {
  const title = (scanResult.individual?.title || '').toLowerCase();
  const archetype = (scanResult.psychographic?.archetype || '').toLowerCase();
  const decisionStyle = (scanResult.psychographic?.decision_style || '').toLowerCase();

  // C-level and VP → likely decision-maker
  if (/^(ceo|cto|cfo|cio|ciso|coo|president|owner|founder|managing director)/i.test(title)) {
    return 'decision-maker';
  }
  if (/^(vp|vice president|svp|evp|chief)/i.test(title)) {
    return archetype === 'defender' ? 'blocker' : 'decision-maker';
  }
  // Directors — influencers or blockers depending on archetype
  if (/director/i.test(title)) {
    if (archetype === 'defender' && decisionStyle === 'consensus') return 'blocker';
    return 'influencer';
  }
  // Managers — usually influencers
  if (/manager|lead|head of/i.test(title)) {
    return 'influencer';
  }
  // Everyone else
  if (archetype === 'pioneer' || archetype === 'grower') return 'champion';
  return 'observer';
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  analyzeSingle,
  analyzeGroup,
  analyzeReadyLeads,
  // Expose for testing
  synthesizeGroupDynamics,
  synthesizeReadyLeads,
  personCollectionId,
  inferDecisionRole,
};
