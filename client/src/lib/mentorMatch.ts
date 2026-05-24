// ─────────────────────────────────────────────────────────────────────────
//  DRiX — Founder ↔ Mentor Match Engine
//  Generic, sector/stage-agnostic scoring. Works for ANY founder profile.
//  The deep psychographic layer (likes/dislikes/phrases) is produced by the
//  DRiX individual-scan pipeline — this engine decides WHO is worth scanning
//  and gives role-based meeting coaching.
// ─────────────────────────────────────────────────────────────────────────

export interface Mentor {
  id: number
  name: string
  title: string
  company: string
  classification: string
  investor: 'explicit' | 'verify' | 'none'
  url: string
  sectors: string[]
  functions: string[]
  geos: string[]
  stages: string[]
}

export type Stage = 'Idea/Accelerator' | 'Pre-seed' | 'Seed' | 'Series A' | 'Growth/Late'

export interface FounderProfile {
  companyName: string
  oneLiner: string
  sectors: string[]
  stage: Stage
  raising: boolean
  raiseAmount: string
  geos: string[]
  needs: string[]
}

export interface MatchResult {
  mentor: Mentor
  score: number // 0–100
  tier: 'A' | 'B' | 'C'
  subscores: { label: string; value: number; max: number }[]
  reasons: string[]
  archetype: string
  engagement: string
  playbook: { open: string; focus: string; ask: string; avoid: string }
}

// Canonical option lists (shared with the UI) ------------------------------
export const SECTOR_OPTIONS = [
  'AI/ML', 'SaaS/Enterprise', 'Fintech', 'Cybersecurity', 'E-commerce/Marketplace',
  'Edtech', 'Healthtech', 'Logistics/Mobility', 'Web3/Crypto', 'Marketing/Martech',
  'Proptech/RealEstate', 'Foodtech', 'Hardware/IoT/DeepTech', 'Gaming',
  'Climate/Energy', 'Media/Content',
]

export const NEED_OPTIONS = [
  'Capital', 'Fundraising intros', 'Sales/GTM/Channel', 'Marketing', 'Product/Design',
  'Engineering/Tech', 'Security', 'Legal', 'Finance/Accounting', 'Operations',
  'People/Talent', 'Coaching/Advisory',
]

export const GEO_OPTIONS = [
  'Vietnam', 'Singapore/SEA', 'Indonesia/SEA', 'Malaysia/SEA', 'US/Western',
  'Korea/Japan/Taiwan', 'Europe', 'Australia', 'Hong Kong', 'India', 'Middle East', 'Canada',
]

export const STAGE_OPTIONS: Stage[] = ['Idea/Accelerator', 'Pre-seed', 'Seed', 'Series A', 'Growth/Late']

const STAGE_ORDER: Stage[] = ['Idea/Accelerator', 'Pre-seed', 'Seed', 'Series A', 'Growth/Late']

// Map founder "needs" to mentor "function" tags --------------------------
const NEED_TO_FUNCTION: Record<string, string[]> = {
  'Capital': ['Capital/Investing'],
  'Fundraising intros': ['Capital/Investing'],
  'Sales/GTM/Channel': ['Sales/GTM/Channel', 'Founder/CEO'],
  'Marketing': ['Marketing'],
  'Product/Design': ['Product/Design'],
  'Engineering/Tech': ['Engineering/Tech'],
  'Security': ['Security'],
  'Legal': ['Legal'],
  'Finance/Accounting': ['Finance/Accounting'],
  'Operations': ['Operations'],
  'People/Talent': ['People/Talent'],
  'Coaching/Advisory': ['Coaching/Advisory', 'Founder/CEO'],
}

const SEA = new Set(['Vietnam', 'Singapore/SEA', 'Indonesia/SEA', 'Malaysia/SEA', 'Hong Kong'])

function overlap(a: string[], b: string[]): number {
  const setB = new Set(b)
  return a.filter((x) => setB.has(x)).length
}

// Dimension fractions [0,1] ------------------------------------------------
function capitalFrac(f: FounderProfile, m: Mentor): number {
  const base = m.investor === 'explicit' ? 1 : m.investor === 'verify' ? 0.6 : 0
  if (base === 0) return 0
  const stageHit = stageFrac(f, m)
  const secHit = m.sectors.length === 0 ? 0.5 : overlap(f.sectors, m.sectors) > 0 ? 1 : 0.25
  return base * (0.5 + 0.25 * stageHit + 0.25 * secHit)
}

function sectorFrac(f: FounderProfile, m: Mentor): number {
  if (f.sectors.length === 0) return 0.5
  if (m.sectors.length === 0) return 0.4 // generalist — neutral, not penalized
  const hit = overlap(f.sectors, m.sectors)
  return Math.min(1, 0.25 + hit / f.sectors.length)
}

function needFrac(f: FounderProfile, m: Mentor): number {
  if (f.needs.length === 0) return 0.5
  let matched = 0
  for (const need of f.needs) {
    const fns = NEED_TO_FUNCTION[need] || []
    const satisfied =
      overlap(fns, m.functions) > 0 ||
      ((need === 'Capital' || need === 'Fundraising intros') && m.investor !== 'none')
    if (satisfied) matched++
  }
  return matched / f.needs.length
}

function geoFrac(f: FounderProfile, m: Mentor): number {
  if (f.geos.length === 0) return 0.5
  if (overlap(f.geos, m.geos) > 0) return 1
  const founderSEA = f.geos.some((g) => SEA.has(g))
  const mentorSEA = m.geos.some((g) => SEA.has(g))
  if (founderSEA && mentorSEA) return 0.6
  return 0.2
}

function stageFrac(f: FounderProfile, m: Mentor): number {
  if (m.stages.length === 0) return 0.4
  if (m.stages.includes(f.stage)) return 1
  const idx = STAGE_ORDER.indexOf(f.stage)
  const adjacent = [STAGE_ORDER[idx - 1], STAGE_ORDER[idx + 1]].filter(Boolean) as string[]
  if (m.stages.some((s) => adjacent.includes(s))) return 0.6
  return 0.3
}

function archetypeOf(m: Mentor): string {
  if (m.investor === 'explicit') return 'Investor (check-writer)'
  if (m.investor === 'verify') return 'Likely investor (verify)'
  if (m.functions.includes('Legal')) return 'Legal / structuring advisor'
  if (m.functions.includes('Coaching/Advisory')) return 'Coach / advisor'
  if (m.functions.includes('Sales/GTM/Channel')) return 'GTM / commercial operator'
  if (m.functions.includes('Founder/CEO')) return 'Founder / operator'
  if (m.functions.includes('Engineering/Tech')) return 'Technical operator'
  return 'Operator / advisor'
}

// Role-based meeting coaching (honest, not fabricated personal preferences)
function playbookFor(m: Mentor, f: FounderProfile): MatchResult['playbook'] {
  const arch = archetypeOf(m)
  if (arch.startsWith('Investor') || arch.startsWith('Likely')) {
    return {
      open: `Lead with one crisp line: what ${f.companyName || 'you'} does and the wedge. Respect their time.`,
      focus: 'Traction signal, why-now, defensible moat, and the size of the market. Investors pattern-match fast.',
      ask: m.investor === 'verify'
        ? 'Confirm whether they write checks at your stage before pitching — title is ambiguous. If yes, ask about check size and process.'
        : 'A clear ask: are you a fit for their stage/thesis, and what would they need to see to take a next meeting?',
      avoid: 'Avoid feature tours, inflated TAM, and vague "we have no competitors." Do not bluff numbers — they will probe.',
    }
  }
  if (arch.startsWith('Legal')) {
    return {
      open: 'Frame the specific structuring/IP/contract question you need help thinking through.',
      focus: 'Cap table, SAFE/convertible terms, IP ownership, cross-border (VN/SEA) entity questions.',
      ask: 'Whether they can review a specific document or refer you to the right specialist.',
      avoid: 'Avoid treating a free meeting as full legal advice — get scope clear up front.',
    }
  }
  if (arch.startsWith('Coach')) {
    return {
      open: 'Be candid about the founder problem you are wrestling with — coaches reward openness.',
      focus: 'Decision-making, team, founder resilience, and the one thing keeping you up at night.',
      ask: 'For a framework or a follow-up cadence, not a quick fix.',
      avoid: 'Avoid pitching — this is not an investor; treat it as development time.',
    }
  }
  // operators
  return {
    open: `Open with the specific operating problem ${m.functions.join('/') || 'they'} can help with — be concrete.`,
    focus: 'Tactical playbooks, intros to their network, and what they wish they had known at your stage.',
    ask: 'One specific, easy-to-grant ask (a warm intro, a doc review, or a 20-min follow-up).',
    avoid: 'Avoid a generic "any advice?" — operators give the most when the ask is sharp.',
  }
}

export function scoreMentor(f: FounderProfile, m: Mentor): MatchResult {
  const W = f.raising
    ? { capital: 30, sector: 22, need: 23, geo: 10, stage: 15 }
    : { capital: 8, sector: 30, need: 42, geo: 10, stage: 10 }

  const dims = {
    capital: capitalFrac(f, m),
    sector: sectorFrac(f, m),
    need: needFrac(f, m),
    geo: geoFrac(f, m),
    stage: stageFrac(f, m),
  }

  const subscores = [
    { label: f.raising ? 'Capital fit' : 'Capital (advisory)', value: Math.round(dims.capital * W.capital), max: W.capital },
    { label: 'Sector fit', value: Math.round(dims.sector * W.sector), max: W.sector },
    { label: 'Need / expertise fit', value: Math.round(dims.need * W.need), max: W.need },
    { label: 'Geography / network', value: Math.round(dims.geo * W.geo), max: W.geo },
    { label: 'Stage fit', value: Math.round(dims.stage * W.stage), max: W.stage },
  ]
  const score = Math.min(100, subscores.reduce((a, s) => a + s.value, 0))
  const tier: 'A' | 'B' | 'C' = score >= 68 ? 'A' : score >= 45 ? 'B' : 'C'

  // Reasons
  const reasons: string[] = []
  if (f.raising && m.investor === 'explicit') reasons.push('Confirmed investor — writes checks.')
  if (f.raising && m.investor === 'verify') reasons.push('At a fund, but title is generic — verify they invest at your stage.')
  const secHits = f.sectors.filter((s) => m.sectors.includes(s))
  if (secHits.length) reasons.push(`Sector overlap: ${secHits.join(', ')}.`)
  else if (m.sectors.length === 0 && (m.investor !== 'none')) reasons.push('Generalist investor — sector not a blocker.')
  const needHits = f.needs.filter((n) => overlap(NEED_TO_FUNCTION[n] || [], m.functions) > 0 || ((n === 'Capital' || n === 'Fundraising intros') && m.investor !== 'none'))
  if (needHits.length) reasons.push(`Can help with: ${needHits.join(', ')}.`)
  const geoHits = f.geos.filter((g) => m.geos.includes(g))
  if (geoHits.length) reasons.push(`Shared geography: ${geoHits.join(', ')}.`)
  if (m.stages.includes(f.stage)) reasons.push(`Active at your stage (${f.stage}).`)
  if (reasons.length === 0) reasons.push('Low overlap with your profile — likely lower priority for this raise.')

  const archetype = archetypeOf(m)
  const engagement =
    archetype.startsWith('Investor') || archetype.startsWith('Likely')
      ? 'Pitch-ready meeting: treat as a potential check or a path to one.'
      : archetype.startsWith('Legal')
      ? 'Advisory meeting: scope a specific structuring/IP question.'
      : archetype.startsWith('Coach')
      ? 'Development meeting: bring a real founder problem, not a pitch.'
      : 'Working session: bring one sharp, easy-to-grant ask.'

  return { mentor: m, score, tier, subscores, reasons, archetype, engagement, playbook: playbookFor(m, f) }
}

export function rankMentors(f: FounderProfile, mentors: Mentor[]): MatchResult[] {
  return mentors.map((m) => scoreMentor(f, m)).sort((a, b) => b.score - a.score)
}
