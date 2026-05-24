import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import {
  Target, Search, Building2, Zap, ExternalLink, Check, Pencil, Save,
  TrendingUp, Users, Filter, Sparkles, MapPin, Briefcase,
} from 'lucide-react'
import { MENTORS } from '../data/fiVietnamMentors'
import {
  rankMentors, SECTOR_OPTIONS, NEED_OPTIONS, GEO_OPTIONS, STAGE_OPTIONS,
} from '../lib/mentorMatch'
import type { FounderProfile, MatchResult, Stage } from '../lib/mentorMatch'

const STORAGE_KEY = 'drix_founder_profile_v1'

const EMPTY: FounderProfile = {
  companyName: '',
  oneLiner: '',
  sectors: [],
  stage: 'Pre-seed',
  raising: true,
  raiseAmount: '',
  geos: ['Vietnam'],
  needs: ['Capital', 'Sales/GTM/Channel'],
}

const tierColor: Record<'A' | 'B' | 'C', string> = {
  A: 'var(--green)',
  B: 'var(--yellow)',
  C: 'var(--text-muted)',
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all duration-150 ${
        active
          ? 'border-drix-accent text-drix-bg'
          : 'border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50'
      }`}
      style={active ? { background: 'var(--dx-accent)' } : { background: 'transparent' }}
    >
      {active && <Check size={11} className="inline mr-1 -mt-0.5" />}
      {label}
    </button>
  )
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--text-muted)'
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-drix-dim">{label}</span>
        <span className="text-drix-muted font-semibold">{value}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-drix-bg overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

function ScoreRing({ score, tier }: { score: number; tier: 'A' | 'B' | 'C' }) {
  const r = 34
  const c = 2 * Math.PI * r
  const off = c - (score / 100) * c
  return (
    <div className="relative flex-shrink-0" style={{ width: 84, height: 84 }}>
      <svg width="84" height="84" className="-rotate-90">
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="7" />
        <circle
          cx="42" cy="42" r={r} fill="none" stroke={tierColor[tier]} strokeWidth="7"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-extrabold text-drix-text leading-none">{score}</span>
        <span className="text-[9px] uppercase tracking-widest font-bold" style={{ color: tierColor[tier] }}>
          Tier {tier}
        </span>
      </div>
    </div>
  )
}

export default function MentorMatch() {
  const [form, setForm] = useState<FounderProfile>(EMPTY)
  const [saved, setSaved] = useState<FounderProfile | null>(null)
  const [editing, setEditing] = useState(true)

  const [query, setQuery] = useState('')
  const [investorsOnly, setInvestorsOnly] = useState(false)
  const [tierAOnly, setTierAOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Load persisted profile
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const p = { ...EMPTY, ...JSON.parse(raw) } as FounderProfile
        setForm(p)
        setSaved(p)
        setEditing(false)
      }
    } catch { /* ignore */ }
  }, [])

  const toggle = (key: 'sectors' | 'needs' | 'geos', val: string) =>
    setForm((f) => {
      const arr = f[key]
      return { ...f, [key]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val] }
    })

  const saveProfile = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)) } catch { /* ignore */ }
    setSaved(form)
    setEditing(false)
  }

  const ranked: MatchResult[] = useMemo(
    () => (saved ? rankMentors(saved, MENTORS) : []),
    [saved],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ranked.filter((r) => {
      if (investorsOnly && r.mentor.investor === 'none') return false
      if (tierAOnly && r.tier !== 'A') return false
      if (q) {
        const hay = `${r.mentor.name} ${r.mentor.title} ${r.mentor.company}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [ranked, query, investorsOnly, tierAOnly])

  // keep a sensible selection
  useEffect(() => {
    if (filtered.length === 0) { setSelectedId(null); return }
    if (!filtered.some((r) => r.mentor.id === selectedId)) setSelectedId(filtered[0].mentor.id)
  }, [filtered, selectedId])

  const selected = filtered.find((r) => r.mentor.id === selectedId) || null

  const counts = useMemo(() => ({
    total: ranked.length,
    a: ranked.filter((r) => r.tier === 'A').length,
    investors: ranked.filter((r) => r.mentor.investor !== 'none').length,
  }), [ranked])

  return (
    <div className="min-h-screen pt-24 pb-20 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-drix-accent mb-3">
            <Target size={14} /> DRiX · Mentor Match
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold gradient-text mb-2">
            Find the mentors worth your time, and walk in prepared.
          </h1>
          <p className="text-drix-dim max-w-2xl text-sm leading-relaxed">
            Save your founder profile once. Then match it against any mentor or investor roster to see
            who fits your raise, why, and exactly how to run the meeting. Demo dataset: the{' '}
            <span className="text-drix-text font-semibold">Founder Institute Vietnam</span> roster
            ({MENTORS.length} mentors, investor-classified).
          </p>
        </motion.div>

        {/* ── PROFILE CARD ── */}
        <div className="glass rounded-2xl p-5 sm:p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-sm font-bold text-drix-text">
              <Building2 size={16} className="text-drix-accent" /> Your Founder Profile
            </div>
            {saved && !editing && (
              <button onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-drix-dim hover:text-drix-text">
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>

          {saved && !editing ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="font-bold text-drix-text">{saved.companyName || 'Unnamed company'}</span>
              <span className="text-drix-dim">{saved.stage}</span>
              <span className="text-drix-dim">{saved.raising ? `Raising ${saved.raiseAmount || ''}`.trim() : 'Not raising'}</span>
              <span className="text-drix-muted text-xs">{saved.sectors.join(' · ') || 'No sectors set'}</span>
              <span className="text-drix-muted text-xs">{saved.geos.join(' · ')}</span>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Company name</label>
                  <input
                    value={form.companyName}
                    onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
                    placeholder="e.g. Acme AI"
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">One-liner</label>
                  <input
                    value={form.oneLiner}
                    onChange={(e) => setForm((f) => ({ ...f, oneLiner: e.target.value }))}
                    placeholder="What you do, in one sentence"
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">Sectors</label>
                <div className="flex flex-wrap gap-2">
                  {SECTOR_OPTIONS.map((s) => (
                    <Chip key={s} label={s} active={form.sectors.includes(s)} onClick={() => toggle('sectors', s)} />
                  ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Stage</label>
                  <select
                    value={form.stage}
                    onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as Stage }))}
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text focus:outline-none focus:border-drix-accent"
                  >
                    {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Raising now?</label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setForm((f) => ({ ...f, raising: true }))}
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold border ${form.raising ? 'border-drix-accent text-drix-bg' : 'border-drix-border text-drix-dim'}`}
                      style={form.raising ? { background: 'var(--dx-accent)' } : {}}>Yes</button>
                    <button type="button" onClick={() => setForm((f) => ({ ...f, raising: false }))}
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold border ${!form.raising ? 'border-drix-accent text-drix-bg' : 'border-drix-border text-drix-dim'}`}
                      style={!form.raising ? { background: 'var(--dx-accent)' } : {}}>No</button>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Target raise</label>
                  <input
                    value={form.raiseAmount}
                    onChange={(e) => setForm((f) => ({ ...f, raiseAmount: e.target.value }))}
                    placeholder="e.g. $500K pre-seed"
                    disabled={!form.raising}
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent disabled:opacity-40"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">What you need help with</label>
                <div className="flex flex-wrap gap-2">
                  {NEED_OPTIONS.map((n) => (
                    <Chip key={n} label={n} active={form.needs.includes(n)} onClick={() => toggle('needs', n)} />
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">Relevant geographies</label>
                <div className="flex flex-wrap gap-2">
                  {GEO_OPTIONS.map((g) => (
                    <Chip key={g} label={g} active={form.geos.includes(g)} onClick={() => toggle('geos', g)} />
                  ))}
                </div>
              </div>

              <button onClick={saveProfile}
                className="dx-btn-primary inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold hover:shadow-glow transition-all">
                <Save size={15} /> {saved ? 'Update profile & re-rank' : 'Save profile & match'}
              </button>
            </div>
          )}
        </div>

        {/* ── RESULTS ── */}
        {saved && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {[
                { icon: Users, label: 'Mentors ranked', val: counts.total, color: 'var(--dx-accent)' },
                { icon: TrendingUp, label: 'Tier A matches', val: counts.a, color: 'var(--green)' },
                { icon: Briefcase, label: 'Investors in roster', val: counts.investors, color: 'var(--purple)' },
              ].map((s) => (
                <div key={s.label} className="glass-light rounded-xl p-4 flex items-center gap-3">
                  <s.icon size={20} style={{ color: s.color }} />
                  <div>
                    <div className="text-xl font-extrabold text-drix-text leading-none">{s.val}</div>
                    <div className="text-[11px] text-drix-muted mt-0.5">{s.label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <div className="relative flex-1 min-w-[220px]">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-drix-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, title, or firm…"
                  className="w-full bg-drix-surface2 border border-drix-border rounded-lg pl-9 pr-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent"
                />
              </div>
              <button onClick={() => setInvestorsOnly((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border ${investorsOnly ? 'border-drix-accent text-drix-accent bg-drix-accent/10' : 'border-drix-border text-drix-dim'}`}>
                <Filter size={12} /> Investors only
              </button>
              <button onClick={() => setTierAOnly((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border ${tierAOnly ? 'text-drix-bg' : 'border-drix-border text-drix-dim'}`}
                style={tierAOnly ? { background: 'var(--green)', borderColor: 'var(--green)' } : {}}>
                Tier A only
              </button>
            </div>

            <div className="grid lg:grid-cols-2 gap-5">
              {/* List */}
              <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
                <div className="text-[11px] text-drix-muted mb-1">
                  Showing {Math.min(filtered.length, 100)} of {filtered.length}
                </div>
                {filtered.slice(0, 100).map((r) => {
                  const sel = r.mentor.id === selectedId
                  return (
                    <button key={r.mentor.id} onClick={() => setSelectedId(r.mentor.id)}
                      className={`w-full text-left rounded-xl p-3 border transition-all ${
                        sel ? 'border-drix-accent bg-drix-accent/5' : 'border-drix-border bg-drix-surface hover:border-drix-accent/40'
                      }`}>
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-extrabold"
                          style={{ background: `${tierColor[r.tier]}22`, color: tierColor[r.tier] }}>
                          {r.score}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-drix-text text-sm truncate">{r.mentor.name}</span>
                            {r.mentor.investor === 'explicit' && (
                              <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: 'rgba(181,131,255,0.15)', color: 'var(--purple)' }}>Investor</span>
                            )}
                            {r.mentor.investor === 'verify' && (
                              <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,199,87,0.15)', color: 'var(--yellow)' }}>Investor?</span>
                            )}
                          </div>
                          <div className="text-[11px] text-drix-dim truncate">
                            {r.mentor.title}{r.mentor.title && r.mentor.company ? ' · ' : ''}{r.mentor.company}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {filtered.length === 0 && (
                  <div className="text-drix-muted text-sm p-6 text-center">No mentors match these filters.</div>
                )}
              </div>

              {/* Detail */}
              <div className="lg:sticky lg:top-24 self-start">
                {selected ? (
                  <motion.div key={selected.mentor.id}
                    initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
                    className="glass rounded-2xl p-5 sm:p-6">
                    <div className="flex items-start gap-4 mb-4">
                      <ScoreRing score={selected.score} tier={selected.tier} />
                      <div className="min-w-0">
                        <h3 className="text-lg font-extrabold text-drix-text">{selected.mentor.name}</h3>
                        <div className="text-sm text-drix-dim">{selected.mentor.title}</div>
                        <div className="text-sm text-drix-muted">{selected.mentor.company}</div>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-drix-muted">
                          <MapPin size={11} /> {selected.mentor.geos.join(', ')}
                        </div>
                      </div>
                    </div>

                    <div className="text-xs font-semibold mb-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                      style={{ background: 'rgba(90,169,255,0.1)', color: 'var(--dx-accent)' }}>
                      <Sparkles size={11} /> {selected.archetype}
                    </div>

                    {/* Subscores */}
                    <div className="space-y-2.5 mb-5">
                      {selected.subscores.map((s) => <Bar key={s.label} {...s} />)}
                    </div>

                    {/* Why */}
                    <div className="mb-5">
                      <div className="text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">Why this match</div>
                      <ul className="space-y-1.5">
                        {selected.reasons.map((why, i) => (
                          <li key={i} className="flex gap-2 text-[13px] text-drix-dim leading-relaxed">
                            <Check size={13} className="mt-0.5 flex-shrink-0 text-drix-green" /> {why}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Meeting playbook */}
                    <div className="rounded-xl border border-drix-border bg-drix-surface2 p-4 mb-4">
                      <div className="text-[11px] uppercase tracking-wider font-bold mb-3" style={{ color: 'var(--green)' }}>
                        Meeting Playbook
                      </div>
                      <div className="space-y-2.5 text-[13px] leading-relaxed">
                        <p><span className="font-bold text-drix-text">Open: </span><span className="text-drix-dim">{selected.playbook.open}</span></p>
                        <p><span className="font-bold text-drix-text">Focus: </span><span className="text-drix-dim">{selected.playbook.focus}</span></p>
                        <p><span className="font-bold text-drix-text">Ask: </span><span className="text-drix-dim">{selected.playbook.ask}</span></p>
                        <p><span className="font-bold" style={{ color: 'var(--red)' }}>Avoid: </span><span className="text-drix-dim">{selected.playbook.avoid}</span></p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {selected.mentor.url && (
                        <a href={selected.mentor.url} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all">
                          <ExternalLink size={13} /> Profile
                        </a>
                      )}
                      <Link to="/app"
                        className="dx-btn-purple-pink inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold hover:shadow-glow transition-all">
                        <Zap size={13} /> Run DRiX deep scan
                      </Link>
                    </div>
                    <p className="text-[11px] text-drix-muted mt-3 leading-relaxed">
                      Match + coaching above are from public role/firm signals. For this person's psychographic
                      profile, decision style, and phrases to use/avoid, run a full DRiX individual scan.
                    </p>
                  </motion.div>
                ) : (
                  <div className="glass rounded-2xl p-10 text-center text-drix-muted text-sm">
                    Select a mentor to see the match breakdown and meeting playbook.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
