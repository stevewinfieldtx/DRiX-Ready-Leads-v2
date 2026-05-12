// Individual-level digital footprint scan via Maigret API.
// Calls the DRiX Maigret API service, then atomizes discovered accounts
// into TDE-compatible 9D atoms for pitch synthesis.

const MAIGRET_API_URL = (process.env.MAIGRET_API_URL || 'https://drix-api.up.railway.app').replace(/\/$/, '');

// Map Maigret site tags to TDE evidence types
const TAG_TO_EVIDENCE = {
  coding: 'technical_community',
  tech: 'technical_community',
  blog: 'thought_leadership',
  writing: 'thought_leadership',
  video: 'media_presence',
  forum: 'community_participation',
  news: 'media_presence',
  finance: 'professional_network',
  shopping: 'consumer_signal',
};

// High-value sites where account presence alone is a strong signal
const HIGH_VALUE_SITES = {
  GitHub: { signal: 'active_developer', dimension: 'd_persona' },
  'Stack Overflow': { signal: 'technical_problem_solver', dimension: 'd_persona' },
  Medium: { signal: 'content_creator', dimension: 'd_credibility' },
  Substack: { signal: 'newsletter_author', dimension: 'd_credibility' },
  Reddit: { signal: 'community_participant', dimension: 'd_emotional_driver' },
  HackerNews: { signal: 'tech_opinion_leader', dimension: 'd_persona' },
  'dev.to': { signal: 'technical_blogger', dimension: 'd_credibility' },
  Mastodon: { signal: 'post_twitter_migrant', dimension: 'd_persona' },
  Keybase: { signal: 'crypto_identity_aware', dimension: 'd_persona' },
  SpeakerDeck: { signal: 'conference_speaker', dimension: 'd_credibility' },
  SlideShare: { signal: 'presentation_author', dimension: 'd_credibility' },
  ProductHunt: { signal: 'product_evaluator', dimension: 'd_buying_stage' },
  YouTube: { signal: 'video_presence', dimension: 'd_credibility' },
  Quora: { signal: 'public_expert', dimension: 'd_credibility' },
  GitLab: { signal: 'alt_code_platform', dimension: 'd_persona' },
  DockerHub: { signal: 'container_ecosystem', dimension: 'd_persona' },
  NPM: { signal: 'package_maintainer', dimension: 'd_credibility' },
  PyPI: { signal: 'package_maintainer', dimension: 'd_credibility' },
  Crunchbase: { signal: 'investment_activity', dimension: 'd_economic_driver' },
  AngelList: { signal: 'startup_ecosystem', dimension: 'd_economic_driver' },
};

/**
 * Classify persona type from a job title string.
 * Returns one of: technical, business, security, executive, channel, general
 */
function classifyPersona(title) {
  if (!title) return 'general';
  const t = title.toLowerCase();

  if (/\b(cto|vp\s*eng|architect|devops|sre|developer|software|platform|infra)/i.test(t)) return 'technical';
  if (/\b(ciso|security|soc\s|infosec|cyber|threat)/i.test(t)) return 'security';
  if (/\b(ceo|coo|cfo|cro|president|founder|board|managing\s*director)/i.test(t)) return 'executive';
  if (/\b(channel|partner|alliance|distribution|reseller|var\b|msp\b)/i.test(t)) return 'channel';
  if (/\b(cmo|marketing|sales|revenue|growth|demand|brand|content\s*market)/i.test(t)) return 'business';

  return 'general';
}

/**
 * Convert Maigret scan results into TDE-compatible 9D atoms.
 */
function maigretResultsToAtoms(scanResult, context = {}) {
  const atoms = [];
  const { individual_name, recipient_role } = context;
  const now = new Date().toISOString();

  const totalFound = scanResult.total_found || 0;
  const siteNames = (scanResult.accounts || []).map(a => a.site).join(', ');

  atoms.push({
    content: `Individual digital footprint scan: ${totalFound} accounts discovered across platforms. Active on: ${siteNames || 'none detected'}.`,
    d_persona: individual_name || 'target_individual',
    d_buying_stage: 'research',
    d_emotional_driver: 'awareness',
    d_evidence_type: 'osint_scan',
    d_credibility: Math.min(5, Math.max(1, Math.ceil(totalFound / 3))),
    d_recency: now,
    d_economic_driver: 'neutral',
    d_status_quo_pressure: 'neutral',
    d_industry: 'cross_industry',
    source: 'maigret_scan',
    source_url: null,
  });

  for (const account of (scanResult.accounts || [])) {
    const siteInfo = HIGH_VALUE_SITES[account.site];
    const primaryTag = (account.tags || [])[0] || 'general';
    const evidenceType = TAG_TO_EVIDENCE[primaryTag] || 'digital_presence';

    const atom = {
      content: `${individual_name || 'Target individual'} has an active ${account.site} account (${account.url}). ${siteInfo ? `Signal: ${siteInfo.signal}.` : ''}`,
      d_persona: individual_name || 'target_individual',
      d_buying_stage: siteInfo?.dimension === 'd_buying_stage' ? 'active_evaluation' : 'research',
      d_emotional_driver: account.site === 'Reddit' || account.site === 'Mastodon' ? 'unfiltered_opinion' : 'professional_presence',
      d_evidence_type: evidenceType,
      d_credibility: siteInfo ? 4 : 2,
      d_recency: now,
      d_economic_driver: siteInfo?.dimension === 'd_economic_driver' ? 'investment_signal' : 'neutral',
      d_status_quo_pressure: 'neutral',
      d_industry: 'cross_industry',
      source: 'maigret_scan',
      source_url: account.url,
    };

    if (siteInfo) {
      atom[siteInfo.dimension] = siteInfo.signal;
    }

    atoms.push(atom);
  }

  if (scanResult.username_resolution) {
    const ur = scanResult.username_resolution;
    atoms.push({
      content: `Username resolution: LinkedIn slug "${ur.linkedin_slug}", email prefix "${ur.email_prefix}". Candidates tested: ${(ur.candidates_generated || []).join(', ')}.`,
      d_persona: individual_name || 'target_individual',
      d_buying_stage: 'research',
      d_emotional_driver: 'identity_mapping',
      d_evidence_type: 'osint_metadata',
      d_credibility: 5,
      d_recency: now,
      d_economic_driver: 'neutral',
      d_status_quo_pressure: 'neutral',
      d_industry: 'cross_industry',
      source: 'maigret_scan',
      source_url: null,
    });
  }

  return atoms;
}

/**
 * Run individual Maigret scan and return TDE atoms.
 */
async function scanIndividual({ linkedin_url, email, title, name, tier = 1 }) {
  const persona_type = classifyPersona(title);

  console.log(`[individual-scan] starting: linkedin=${linkedin_url} email=${email || 'n/a'} persona=${persona_type} tier=${tier}`);

  const body = { linkedin_url, persona_type, tier };
  if (email) body.email = email;

  let scanResult;
  try {
    const res = await fetch(`${MAIGRET_API_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Maigret API ${res.status}: ${text.slice(0, 300)}`);
    }

    scanResult = await res.json();
    console.log(`[individual-scan] complete: ${scanResult.total_found} accounts in ${scanResult.elapsed_seconds}s`);
  } catch (err) {
    console.error(`[individual-scan] failed:`, err.message);
    return {
      scan: { error: err.message, total_found: 0, accounts: [] },
      atoms: [],
    };
  }

  const atoms = maigretResultsToAtoms(scanResult, {
    individual_name: name,
    recipient_role: title,
  });

  return { scan: scanResult, atoms };
}

module.exports = { scanIndividual, classifyPersona, maigretResultsToAtoms };
