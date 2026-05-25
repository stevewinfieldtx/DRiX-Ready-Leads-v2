import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { motion } from 'framer-motion'
import {
  Target, Search, Building2, ExternalLink, Check, Pencil, Save,
  TrendingUp, Users, Filter, Sparkles, Upload, FileText, X,
  ChevronRight, ChevronDown, Printer, Share2, Archive, Loader2, Mail, Phone,
} from 'lucide-react'
import { MENTORS } from '../data/fiVietnamMentors'
import {
  rankMentors, SECTOR_OPTIONS, NEED_OPTIONS, STAGE_OPTIONS,
  GEO_TREE, geosFromTree, leafIdsUnder, fitParagraph,
} from '../lib/mentorMatch'
import type { FounderProfile, MatchResult, Stage, GeoNode } from '../lib/mentorMatch'
import type { ReactNode } from 'react'

const STORAGE_KEY = 'drix_founder_profile_v2'
const EMAIL_KEY = 'drix_founder_email'

const EMPTY: FounderProfile = {
  companyName: '', oneLiner: '', sectors: [], stage: 'Pre-seed',
  raising: true, raiseAmount: '', geos: ['Vietnam'], needs: ['Capital', 'Sales/GTM/Channel'],
}

const tierColor: Record<'A' | 'B' | 'C', string> = { A: 'var(--green)', B: 'var(--yellow)', C: 'var(--text-muted)' }

interface Brief {
  mentor: { name: string; title?: string; company?: string; url?: string; investor?: string }
  brief: {
    fit_paragraph?: string; how_to_talk?: string; how_to_pitch?: string
    elevator_pitch_amendment?: string; deck_amendments?: string[]
    firm_brief?: string; employer_brief?: string; smart_questions?: string[]
    other_relevant?: string; confidence_note?: string
  }
  contact?: { email?: string; phone?: string; linkedin?: string; location?: string } | null
  scan?: { leadership_style?: string; career_highlights?: string[]; public_signals?: string[] } | null
  firm_intel?: { name?: string; summary?: string } | null
  id?: string
  generated_at?: string
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all duration-150 ${
        active ? 'border-drix-accent text-drix-bg' : 'border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50'}`}
      style={active ? { background: 'var(--dx-accent)' } : { background: 'transparent' }}>
      {active && <Check size={11} className="inline mr-1 -mt-0.5" />}{label}
    </button>
  )
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--text-muted)'
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1"><span className="text-drix-dim">{label}</span><span className="text-drix-muted font-semibold">{value}/{max}</span></div>
      <div className="h-1.5 rounded-full bg-drix-bg overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}

function TreeBranch({ node, selected, onToggleLeaf, onToggleBranch }: {
  node: GeoNode; selected: Set<string>
  onToggleLeaf: (id: string) => void; onToggleBranch: (leaves: string[], on: boolean) => void
}) {
  const [open, setOpen] = useState(node.id === 'world' || node.id === 'asia')
  if (!node.children) {
    const on = selected.has(node.id)
    return (
      <label className="flex items-center gap-2 py-1 pl-6 cursor-pointer text-sm text-drix-dim hover:text-drix-text">
        <input type="checkbox" checked={on} onChange={() => onToggleLeaf(node.id)} className="accent-[var(--dx-accent)]" />
        {node.name}
      </label>
    )
  }
  const leaves = leafIdsUnder(node)
  const allOn = leaves.every((l) => selected.has(l))
  const someOn = !allOn && leaves.some((l) => selected.has(l))
  return (
    <div>
      <div className="flex items-center gap-1.5 py-1">
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-drix-muted hover:text-drix-text">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <label className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-drix-text">
          <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = someOn }}
            onChange={() => onToggleBranch(leaves, !allOn)} className="accent-[var(--dx-accent)]" />
          {node.name}
        </label>
      </div>
      {open && <div className="ml-3 border-l border-drix-border/50 pl-1">
        {node.children.map((c) => (
          <TreeBranch key={c.id} node={c} selected={selected} onToggleLeaf={onToggleLeaf} onToggleBranch={onToggleBranch} />
        ))}
      </div>}
    </div>
  )
}

function BriefView({ brief, compact }: { brief: Brief; compact?: boolean }) {
  const b = brief.brief || {}
  const Section = ({ title, children, color = 'var(--green)' }: { title: string; children: ReactNode; color?: string }) => (
    <div className="mb-3">
      <div className="text-[11px] uppercase tracking-wider font-bold mb-1" style={{ color }}>{title}</div>
      <div className="text-[13px] text-drix-dim leading-relaxed">{children}</div>
    </div>
  )
  return (
    <div className={compact ? '' : 'glass rounded-2xl p-6 mt-4'}>
      {!compact && <h2 className="text-xl font-extrabold text-drix-text mb-1">{brief.mentor?.name}</h2>}
      {!compact && <div className="text-sm text-drix-muted mb-4">{brief.mentor?.title} · {brief.mentor?.company}</div>}
      {b.fit_paragraph && <Section title="Why this match">{b.fit_paragraph}</Section>}
      {b.how_to_talk && <Section title="How to talk to them" color="var(--dx-accent)">{b.how_to_talk}</Section>}
      {b.how_to_pitch && <Section title="How to pitch" color="var(--dx-accent)">{b.how_to_pitch}</Section>}
      {b.elevator_pitch_amendment && <Section title="Your elevator pitch, tailored" color="var(--purple)">{b.elevator_pitch_amendment}</Section>}
      {b.deck_amendments && b.deck_amendments.length > 0 && (
        <Section title="Deck amendments" color="var(--purple)">
          <ul className="space-y-1">{b.deck_amendments.map((d, i) => <li key={i} className="flex gap-2"><Check size={13} className="mt-0.5 flex-shrink-0 text-drix-green" />{d}</li>)}</ul>
        </Section>
      )}
      {b.smart_questions && b.smart_questions.length > 0 && (
        <Section title="Smart questions to ask" color="var(--cyan)">
          <ul className="space-y-1">{b.smart_questions.map((q, i) => <li key={i} className="flex gap-2"><span className="text-drix-accent">{i + 1}.</span>{q}</li>)}</ul>
        </Section>
      )}
      {b.firm_brief && <Section title="Their investment firm" color="var(--yellow)">{b.firm_brief}</Section>}
      {b.employer_brief && <Section title="Their company" color="var(--yellow)">{b.employer_brief}</Section>}
      {brief.scan?.leadership_style && <Section title="Leadership style" color="var(--purple)">{brief.scan.leadership_style}</Section>}
      {b.other_relevant && <Section title="Also relevant">{b.other_relevant}</Section>}
      {brief.contact && (brief.contact.email || brief.contact.phone || brief.contact.linkedin) && (
        <div className="rounded-lg border border-drix-border bg-drix-surface2 p-3 mt-2">
          <div className="text-[11px] uppercase tracking-wider font-bold mb-2 text-drix-accent">Contact</div>
          <div className="flex flex-wrap gap-4 text-[13px] text-drix-dim">
            {brief.contact.email && <span className="inline-flex items-center gap-1.5"><Mail size={12} /> {brief.contact.email}</span>}
            {brief.contact.phone && <span className="inline-flex items-center gap-1.5"><Phone size={12} /> {brief.contact.phone}</span>}
            {brief.contact.linkedin && <a href={brief.contact.linkedin} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-drix-accent"><ExternalLink size={12} /> LinkedIn</a>}
          </div>
        </div>
      )}
      {b.confidence_note && <p className="text-[11px] text-drix-muted mt-3 italic">{b.confidence_note}</p>}
    </div>
  )
}

export default function MentorMatch() {
  const [params] = useSearchParams()
  const sharedId = params.get('brief')

  const [form, setForm] = useState<FounderProfile>(EMPTY)
  const [email, setEmail] = useState('')
  const [saved, setSaved] = useState<FounderProfile | null>(null)
  const [editing, setEditing] = useState(true)

  const [companyText, setCompanyText] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [docs, setDocs] = useState<{ filename: string; text: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [geoSel, setGeoSel] = useState<Set<string>>(new Set(['vn']))

  const [query, setQuery] = useState('')
  const [investorsOnly, setInvestorsOnly] = useState(false)
  const [tierAOnly, setTierAOnly] = useState(false)
  const [visible, setVisible] = useState(10)
  const [openId, setOpenId] = useState<number | null>(null)
  const [briefs, setBriefs] = useState<Record<number, { loading: boolean; data?: Brief; error?: string }>>({})

  const [archive, setArchive] = useState<{ id: string; mentor_name: string; mentor_company: string; score: number; created_at: string }[]>([])
  const [sharedBrief, setSharedBrief] = useState<Brief | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) { const p = { ...EMPTY, ...JSON.parse(raw) } as FounderProfile; setForm(p); setSaved(p); setEditing(false) }
      const e = localStorage.getItem(EMAIL_KEY); if (e) setEmail(e)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!sharedId) return
    fetch(`/api/mentor/brief/${sharedId}`).then((r) => r.json())
      .then((row) => { if (row?.brief) setSharedBrief(row.brief as Brief) }).catch(() => {})
  }, [sharedId])

  const toggleArr = (key: 'sectors' | 'needs', val: string) =>
    setForm((f) => { const arr = f[key]; return { ...f, [key]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val] } })

  const toggleLeaf = (id: string) => setGeoSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleBranch = (leaves: string[], on: boolean) =>
    setGeoSel((s) => { const n = new Set(s); leaves.forEach((l) => (on ? n.add(l) : n.delete(l))); return n })

  const uploadDoc = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData(); fd.append('file', file)
        const res = await fetch('/api/upload-doc', { method: 'POST', body: fd })
        if (res.ok) { const d = await res.json(); setDocs((p) => [...p, { filename: d.filename || file.name, text: d.text || '' }]) }
      } catch { /* ignore */ }
    }
    setUploading(false)
  }

  const analyzeCompany = async () => {
    setAnalyzing(true)
    try {
      const res = await fetch('/api/mentor/enrich-company', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: companyText, docs, youtube_url: youtubeUrl }),
      })
      if (res.ok) {
        const d = await res.json()
        setForm((f) => ({
          ...f,
          oneLiner: f.oneLiner || (d.summary ? String(d.summary).split('. ')[0] : ''),
          summary: d.summary || '',
          sectors: Array.from(new Set([...(d.sectors || []), ...f.sectors])),
        }))
      }
    } catch { /* backend may be offline */ }
    setAnalyzing(false)
  }

  const saveProfile = () => {
    const profile: FounderProfile = { ...form, geos: geosFromTree([...geoSel]) }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profile)); if (email) localStorage.setItem(EMAIL_KEY, email) } catch { /* ignore */ }
    setForm(profile); setSaved(profile); setEditing(false); setVisible(10)
    if (email) {
      fetch('/api/mentor/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, profile }) }).catch(() => {})
    }
  }

  const loadArchive = () => {
    if (!email) return
    fetch(`/api/mentor/briefs?email=${encodeURIComponent(email)}`).then((r) => r.json())
      .then((d) => setArchive(d.briefs || [])).catch(() => {})
  }
  useEffect(() => { if (saved && email) loadArchive() }, [saved]) // eslint-disable-line

  const openBrief = async (r: MatchResult) => {
    if (!saved) return
    const id = r.mentor.id
    setOpenId(openId === id ? null : id)
    if (briefs[id]?.data || briefs[id]?.loading) return
    setBriefs((b) => ({ ...b, [id]: { loading: true } }))
    try {
      const res = await fetch('/api/mentor/brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ founder: { ...saved, score: r.score }, mentor: { ...r.mentor, score: r.score }, deep: true, save: !!email, email }),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Request failed (${res.status})`)
      const data = (await res.json()) as Brief
      setBriefs((b) => ({ ...b, [id]: { loading: false, data } }))
      if (email) loadArchive()
    } catch (e) {
      setBriefs((b) => ({ ...b, [id]: { loading: false, error: e instanceof Error ? e.message : 'Failed' } }))
    }
  }

  const ranked: MatchResult[] = useMemo(() => (saved ? rankMentors(saved, MENTORS) : []), [saved])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ranked.filter((r) => {
      if (investorsOnly && r.mentor.investor === 'none') return false
      if (tierAOnly && r.tier !== 'A') return false
      if (q) { const hay = `${r.mentor.name} ${r.mentor.title} ${r.mentor.company}`.toLowerCase(); if (!hay.includes(q)) return false }
      return true
    })
  }, [ranked, query, investorsOnly, tierAOnly])

  const counts = useMemo(() => ({
    total: ranked.length, a: ranked.filter((r) => r.tier === 'A').length, investors: ranked.filter((r) => r.mentor.investor !== 'none').length,
  }), [ranked])

  if (sharedBrief) {
    return (
      <div className="min-h-screen pt-24 pb-20 px-4 sm:px-6 lg:px-8 max-w-3xl mx-auto">
        <Link to="/mentor-match" className="text-xs text-drix-accent">← Back to Mentor Match</Link>
        <BriefView brief={sharedBrief} />
      </div>
    )
  }

  return (
    <div className="min-h-screen pt-24 pb-20 px-4 sm:px-6 lg:px-8">
      <style>{`@media print { .no-print { display: none !important; } .print-area { box-shadow: none !important; } }`}</style>
      <div className="max-w-7xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="mb-8 no-print">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-drix-accent mb-3"><Target size={14} /> DRiX · Mentor Match</div>
          <h1 className="text-3xl sm:text-4xl font-extrabold gradient-text mb-2">Find the mentors worth your time, and walk in prepared.</h1>
          <p className="text-drix-dim max-w-2xl text-sm leading-relaxed">
            Describe your company once (paste text or upload a deck/PDF). DRiX suggests your sectors, ranks every mentor by fit,
            and writes you a meeting brief. Demo roster: {MENTORS.length} Founder Institute Vietnam mentors.
          </p>
        </motion.div>

        <div className="glass rounded-2xl p-5 sm:p-6 mb-8 no-print">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-sm font-bold text-drix-text"><Building2 size={16} className="text-drix-accent" /> Your Founder Profile</div>
            {saved && !editing && <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-drix-dim hover:text-drix-text"><Pencil size={12} /> Edit</button>}
          </div>

          {saved && !editing ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="font-bold text-drix-text">{saved.companyName || 'Unnamed company'}</span>
              <span className="text-drix-dim">{saved.stage}</span>
              <span className="text-drix-dim">{saved.raising ? `Raising ${saved.raiseAmount || ''}`.trim() : 'Not raising'}</span>
              <span className="text-drix-muted text-xs">{saved.sectors.join(' · ') || 'No sectors'}</span>
              <span className="text-drix-muted text-xs">{saved.geos.join(' · ')}</span>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Company name</label>
                  <input value={form.companyName} onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} placeholder="e.g. Acme AI"
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Your email (saves profile + archive)</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Describe your company — paste anything, or upload</label>
                <textarea value={companyText} onChange={(e) => setCompanyText(e.target.value)} rows={4} placeholder="What you do, who you serve, traction, the raise…"
                  className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent" />
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-drix-border text-drix-dim hover:text-drix-text cursor-pointer">
                    <Upload size={13} /> {uploading ? 'Uploading…' : 'Upload PDF / DOC / PPT'}
                    <input type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md" className="hidden" onChange={(e) => uploadDoc(e.target.files)} />
                  </label>
                  <input value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} placeholder="YouTube URL (optional)"
                    className="flex-1 min-w-[180px] bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-xs text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent" />
                  <button onClick={analyzeCompany} disabled={analyzing}
                    className="dx-btn-cyan inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-50">
                    {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Analyze → suggest sectors
                  </button>
                </div>
                {docs.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {docs.map((d, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 text-[11px] bg-drix-surface2 border border-drix-border rounded-full px-2.5 py-1 text-drix-dim">
                        <FileText size={11} /> {d.filename}
                        <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))}><X size={11} className="hover:text-drix-red" /></button>
                      </span>
                    ))}
                  </div>
                )}
                {form.summary && <p className="text-xs text-drix-muted mt-2 italic">{form.summary}</p>}
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">Sectors {form.sectors.length > 0 && <span className="text-drix-accent normal-case">· suggested, edit freely</span>}</label>
                <div className="flex flex-wrap gap-2">{SECTOR_OPTIONS.map((s) => <Chip key={s} label={s} active={form.sectors.includes(s)} onClick={() => toggleArr('sectors', s)} />)}</div>
              </div>

              <div className="grid sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Stage</label>
                  <select value={form.stage} onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as Stage }))}
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text focus:outline-none focus:border-drix-accent">
                    {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Raising now?</label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setForm((f) => ({ ...f, raising: true }))} className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold border ${form.raising ? 'border-drix-accent text-drix-bg' : 'border-drix-border text-drix-dim'}`} style={form.raising ? { background: 'var(--dx-accent)' } : {}}>Yes</button>
                    <button type="button" onClick={() => setForm((f) => ({ ...f, raising: false }))} className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold border ${!form.raising ? 'border-drix-accent text-drix-bg' : 'border-drix-border text-drix-dim'}`} style={!form.raising ? { background: 'var(--dx-accent)' } : {}}>No</button>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-1.5">Target raise</label>
                  <input value={form.raiseAmount} onChange={(e) => setForm((f) => ({ ...f, raiseAmount: e.target.value }))} placeholder="e.g. $500K pre-seed" disabled={!form.raising}
                    className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent disabled:opacity-40" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">What you need help with</label>
                <div className="flex flex-wrap gap-2">{NEED_OPTIONS.map((n) => <Chip key={n} label={n} active={form.needs.includes(n)} onClick={() => toggleArr('needs', n)} />)}</div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-drix-muted font-bold mb-2">Relevant geographies</label>
                <div className="bg-drix-surface2 border border-drix-border rounded-lg p-3 max-h-64 overflow-y-auto">
                  <TreeBranch node={GEO_TREE} selected={geoSel} onToggleLeaf={toggleLeaf} onToggleBranch={toggleBranch} />
                </div>
                <p className="text-[11px] text-drix-muted mt-1">Mapped to: {geosFromTree([...geoSel]).join(', ') || 'none selected'}</p>
              </div>

              <button onClick={saveProfile} className="dx-btn-primary inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold hover:shadow-glow transition-all">
                <Save size={15} /> {saved ? 'Update & re-rank' : 'Save profile & match'}
              </button>
            </div>
          )}
        </div>

        {saved && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-6 no-print">
              {[{ icon: Users, label: 'Mentors ranked', val: counts.total, color: 'var(--dx-accent)' },
                { icon: TrendingUp, label: 'Tier A matches', val: counts.a, color: 'var(--green)' },
                { icon: Building2, label: 'Investors in roster', val: counts.investors, color: 'var(--purple)' }].map((s) => (
                <div key={s.label} className="glass-light rounded-xl p-4 flex items-center gap-3">
                  <s.icon size={20} style={{ color: s.color }} />
                  <div><div className="text-xl font-extrabold text-drix-text leading-none">{s.val}</div><div className="text-[11px] text-drix-muted mt-0.5">{s.label}</div></div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 mb-5 no-print">
              <div className="relative flex-1 min-w-[220px]">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-drix-muted" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, title, or firm…"
                  className="w-full bg-drix-surface2 border border-drix-border rounded-lg pl-9 pr-3 py-2 text-sm text-drix-text placeholder:text-drix-muted focus:outline-none focus:border-drix-accent" />
              </div>
              <button onClick={() => setInvestorsOnly((v) => !v)} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border ${investorsOnly ? 'border-drix-accent text-drix-accent bg-drix-accent/10' : 'border-drix-border text-drix-dim'}`}><Filter size={12} /> Investors only</button>
              <button onClick={() => setTierAOnly((v) => !v)} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border ${tierAOnly ? 'text-drix-bg' : 'border-drix-border text-drix-dim'}`} style={tierAOnly ? { background: 'var(--green)', borderColor: 'var(--green)' } : {}}>Tier A only</button>
            </div>

            <div className="text-[11px] text-drix-muted mb-2 no-print">Showing {Math.min(visible, filtered.length)} of {filtered.length}</div>
            <div className="space-y-3">
              {filtered.slice(0, visible).map((r) => {
                const isOpen = openId === r.mentor.id
                const bstate = briefs[r.mentor.id]
                return (
                  <div key={r.mentor.id} className="rounded-xl border border-drix-border bg-drix-surface print-area">
                    <div className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-base font-extrabold" style={{ background: `${tierColor[r.tier]}22`, color: tierColor[r.tier] }}>{r.score}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-drix-text">{r.mentor.name}</span>
                            <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: `${tierColor[r.tier]}22`, color: tierColor[r.tier] }}>Tier {r.tier}</span>
                            {r.mentor.investor === 'explicit' && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded" style={{ background: 'rgba(181,131,255,0.15)', color: 'var(--purple)' }}>Investor</span>}
                            {r.mentor.investor === 'verify' && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,199,87,0.15)', color: 'var(--yellow)' }}>Investor?</span>}
                          </div>
                          <div className="text-[12px] text-drix-dim">{r.mentor.title}{r.mentor.title && r.mentor.company ? ' · ' : ''}{r.mentor.company}</div>
                          <p className="text-[13px] text-drix-dim leading-relaxed mt-2">{fitParagraph(r, saved)}</p>
                          <button onClick={() => openBrief(r)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-drix-accent no-print">
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {isOpen ? 'Hide brief' : 'View full meeting brief'}
                          </button>
                        </div>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="border-t border-drix-border px-4 py-4">
                        <div className="grid md:grid-cols-5 gap-4">
                          <div className="md:col-span-2 space-y-2">{r.subscores.map((s) => <Bar key={s.label} {...s} />)}
                            <div className="text-xs font-semibold mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: 'rgba(90,169,255,0.1)', color: 'var(--dx-accent)' }}><Sparkles size={11} /> {r.archetype}</div>
                          </div>
                          <div className="md:col-span-3">
                            {bstate?.loading && <div className="flex items-center gap-2 text-sm text-drix-dim"><Loader2 size={16} className="animate-spin" /> Running DRiX deep scan + drafting your brief…</div>}
                            {bstate?.error && (
                              <div className="text-sm text-drix-dim">
                                <p className="text-drix-yellow mb-2">Deep brief unavailable ({bstate.error}). Role-based guidance:</p>
                                <p><span className="font-bold text-drix-text">Open: </span>{r.playbook.open}</p>
                                <p><span className="font-bold text-drix-text">Focus: </span>{r.playbook.focus}</p>
                                <p><span className="font-bold text-drix-text">Ask: </span>{r.playbook.ask}</p>
                                <p><span className="font-bold text-drix-red">Avoid: </span>{r.playbook.avoid}</p>
                              </div>
                            )}
                            {bstate?.data && <BriefView brief={bstate.data} compact />}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 mt-4 no-print">
                          {r.mentor.url && <a href={r.mentor.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text"><ExternalLink size={12} /> Profile</a>}
                          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text"><Printer size={12} /> Print</button>
                          {bstate?.data?.id && (
                            <button onClick={() => { navigator.clipboard?.writeText(`${location.origin}/mentor-match?brief=${bstate.data!.id}`) }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text"><Share2 size={12} /> Copy share link</button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {visible < filtered.length && (
              <div className="text-center mt-5 no-print">
                <button onClick={() => setVisible((v) => v + 10)} className="dx-btn-primary px-5 py-2.5 rounded-lg text-sm font-bold">Show more mentors</button>
              </div>
            )}

            {archive.length > 0 && (
              <div className="glass rounded-2xl p-5 mt-8 no-print">
                <div className="flex items-center gap-2 text-sm font-bold text-drix-text mb-3"><Archive size={15} className="text-drix-accent" /> Your archived briefs</div>
                <div className="space-y-1.5">
                  {archive.map((a) => (
                    <a key={a.id} href={`/mentor-match?brief=${a.id}`} className="flex items-center justify-between text-sm py-1.5 border-b border-drix-border/40 hover:text-drix-text text-drix-dim">
                      <span>{a.mentor_name} <span className="text-drix-muted">· {a.mentor_company}</span></span>
                      <span className="text-drix-muted text-xs">{new Date(a.created_at).toLocaleDateString()}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
