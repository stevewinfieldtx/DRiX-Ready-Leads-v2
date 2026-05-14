import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import {
  Zap, AlertCircle,
  MessageSquare, Download, X, Send, Mic
} from 'lucide-react'

/* ═══════════════════════════════════════════════════════════════════════════
   DRiX APP — ALL ORIGINAL LOGIC PRESERVED
   This component contains the complete DRiX intelligence builder with
   every feature, API call, renderer, and interaction from the original.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── TYPES ─────────────────────────────────────────────────────────────────
interface NaicsSector {
  code: string
  name: string
  sub: { code: string; name: string }[]
}

interface AppState {
  naics: NaicsSector[] | null
  runId: string | null
  strategies: any
  selected: Set<string>
  customStrategy: { title: string; explanation: string } | null
  topPickId: string | null
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
const esc = (s: any) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)
  )

const shortCode = (s: any) => {
  if (!s) return '—'
  const m = String(s).match(/^(\d{2}(?:-\d{2})?|[A-J])\s+(.*)$/)
  return m ? m[1] : String(s).slice(0, 10)
}

const short = (s: any) => {
  if (!s) return '—'
  return String(s).split(/[\/,.]/)[0].split(' ').slice(0, 2).join(' ')
}

export default function DrixApp() {
  // ─── STATE ──────────────────────────────────────────────────────────────
  const [appState, setAppState] = useState<AppState>({
    naics: null,
    runId: null,
    strategies: null,
    selected: new Set(),
    customStrategy: null,
    topPickId: null,
  })
  const [statusText, setStatusText] = useState('Checking…')
  const [statusWarn, setStatusWarn] = useState(false)
  const [mode, setMode] = useState<'production' | 'demo'>('production')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [phases, setPhases] = useState<{ id: string; text: string; state: 'pending' | 'running' | 'done' | 'error' }[]>([
    { id: 'ph-fetch', text: 'Waiting to fetch…', state: 'pending' },
    { id: 'ph-ingest', text: 'Waiting to decompose…', state: 'pending' },
    { id: 'ph-pain', text: 'Waiting to extract pain points…', state: 'pending' },
    { id: 'ph-strategies', text: 'Waiting to generate strategies…', state: 'pending' },
  ])

  // Panel visibility
  const [showAtoms, setShowAtoms] = useState(false)
  const [showPain, setShowPain] = useState(false)
  const [showStrategies, setShowStrategies] = useState(false)
  const [showHydration, setShowHydration] = useState(false)
  const [showIndividual, setShowIndividual] = useState(false)

  // Panel HTML content
  const [atomsHtml, setAtomsHtml] = useState('')
  const [painHtml, setPainHtml] = useState('')
  const [strategiesHtml, setStrategiesHtml] = useState('')
  const [hydrationHtml, setHydrationHtml] = useState('')
  const [individualHtml, setIndividualHtml] = useState('')

  // Modals
  const [stormOpen, setStormOpen] = useState(false)
  const [csOpen, setCsOpen] = useState(false)
  const [coachOpen, setCoachOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [csOutput, setCsOutput] = useState('')
  const [csStatus, setCsStatus] = useState('')
  const [coachMsgs, setCoachMsgs] = useState<{ role: string; text: string }[]>([
    { role: 'system', text: 'Ask me anything about this deal. I know the pains, personas, strategies, discovery questions, and competitive angles.' },
  ])
  const [coachInput, setCoachInput] = useState('')
  const [coachTyping, setCoachTyping] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('Provisioning voice agent...')
  const [reportStatus, setReportStatus] = useState('')

  // Refs for coach
  const coachHistoryRef = useRef<{ role: string; content: string }[]>([])
  const coachEndRef = useRef<HTMLDivElement>(null)

  // Ref so window.onProceed always calls the LATEST hydrate (avoids stale closure)
  const hydrateRef = useRef<(id: string) => Promise<void>>(async () => {})

  // Industry / subindustry state
  const [selectedIndustry, setSelectedIndustry] = useState('')
  const [subindustryOptions, setSubindustryOptions] = useState<{ code: string; name: string }[]>([])

  // Depth indicator state
  const [depth, setDepth] = useState({
    industry: false,
    title: false,
    company: false,
    individual: false,
  })

  // Wizard step state
  const [wizardStep, setWizardStep] = useState(0)

  // Wizard field state (controlled inputs)
  const [fEmail, setFEmail] = useState('')
  const [fSender, setFSender] = useState('')
  const [fSolution, setFSolution] = useState('')
  const [fTitle, setFTitle] = useState('')
  const [fCustomer, setFCustomer] = useState('')
  const [fIndividual, setFIndividual] = useState('')
  const [fIndividualEmail, setFIndividualEmail] = useState('')
  const [fSubindustry, setFSubindustry] = useState('')

  // (All inputs are now controlled — no refs needed)

  // ─── BOOT ───────────────────────────────────────────────────────────────
  useEffect(() => {
    checkHealth()
    loadMeta()
  }, [])

  useEffect(() => {
    if (coachEndRef.current) {
      coachEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [coachMsgs, coachTyping])

  const checkHealth = async () => {
    try {
      const r = await fetch('/healthz')
      const d = await r.json()
      setStatusText(
        d.leadhydration_configured
          ? `${d.model} · DRiX Ready`
          : `${d.model} · ⚠ DRiX Ready not configured`
      )
      if (!d.leadhydration_configured) setStatusWarn(true)
    } catch {
      setStatusText('Connection issue')
      setStatusWarn(true)
    }
  }

  const loadMeta = async () => {
    try {
      const n = await fetch('/api/meta/naics').then((x) => x.json())
      setAppState((s) => ({ ...s, naics: n }))
    } catch (e) {
      console.error('Failed to load meta:', e)
    }
  }

  // ─── INDUSTRY CHANGE ────────────────────────────────────────────────────
  const onIndustryChange = (code: string) => {
    setSelectedIndustry(code)
    if (!code) {
      setSubindustryOptions([])
      setDepth((d) => ({ ...d, industry: false }))
      return
    }
    const sec = appState.naics?.find((s) => s.code === code)
    if (!sec) {
      setSubindustryOptions([])
      return
    }
    setSubindustryOptions(sec.sub)
    setDepth((d) => ({ ...d, industry: true }))
  }

  // ─── UPDATE DEPTH ───────────────────────────────────────────────────────
  const updateDepth = (field: keyof typeof depth, value: string) => {
    setDepth((d) => ({ ...d, [field]: !!value.trim() }))
  }

  // ─── RUN FLOW ───────────────────────────────────────────────────────────
  const runFlow = useCallback(async (forceFresh = false) => {
    setError('')
    const email = fEmail.trim()
    const sender = fSender.trim()
    const solution = fSolution.trim()

    if (!email || !sender || !solution) {
      setError('Fill in email, your company URL, and the solution URL.')
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Email looks invalid.')
      return
    }

    const body: any = {
      email,
      sender_company_url: sender,
      solution_url: solution,
      mode: mode === 'demo' ? 'demo' : 'production',
      ...(forceFresh ? { force_fresh: true } : {}),
    }

    const cust = fCustomer.trim()
    if (cust) body.customer_url = cust

    const ind = selectedIndustry
    const sub = fSubindustry
    if (ind && appState.naics) {
      const indName = appState.naics.find((s) => s.code === ind)?.name || ind
      body.industry = `${indName} (NAICS ${ind})`
      if (sub) {
        const subName =
          appState.naics
            .find((s) => s.code === ind)
            ?.sub.find((x) => x.code === sub)?.name || sub
        body.subindustry = `${subName} (NAICS ${sub})`
      }
    }

    const title = fTitle.trim()
    if (title) body.recipient_role = title

    const individual = fIndividual.trim()
    const individualEmail = fIndividualEmail.trim()
    if (individual) {
      body.individual_linkedin = individual
      body.individual_name = individual
    }
    if (individualEmail) body.individual_email = individualEmail

    setRunning(true)
    setShowAtoms(false)
    setShowPain(false)
    setShowStrategies(false)
    setShowHydration(false)
    setShowIndividual(false)
    setAtomsHtml('')
    setPainHtml('')
    setStrategiesHtml('')
    setHydrationHtml('')
    setIndividualHtml('')
    setAppState((s) => ({
      ...s,
      runId: null,
      strategies: null,
      selected: new Set(),
      customStrategy: null,
    }))
    setPhases([
      { id: 'ph-fetch', text: 'Fetching sender, solution, customer in parallel…', state: 'running' },
      { id: 'ph-ingest', text: 'Waiting to decompose…', state: 'pending' },
      { id: 'ph-pain', text: 'Waiting to extract pain points…', state: 'pending' },
      { id: 'ph-strategies', text: 'Waiting to generate strategies…', state: 'pending' },
    ])

    try {
      const res = await fetch('/api/demo-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Request failed (${res.status})`)
      }
      await readSSE(res, handleSSE)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }, [mode, appState.naics, fEmail, fSender, fSolution, fCustomer, selectedIndustry, fSubindustry, fTitle, fIndividual, fIndividualEmail])

  // Expose force-fresh retry on window for the retry button
  useEffect(() => {
    ;(window as any).__runFlowFresh = () => runFlow(true)
    return () => { delete (window as any).__runFlowFresh }
  }, [runFlow])

  const readSSE = async (response: Response, handler: (event: string, data: any) => void) => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop()!
      for (const block of events) {
        if (!block.trim()) continue
        const em = block.match(/^event:\s*(.+)$/m)
        const dm = block.match(/^data:\s*(.+)$/m)
        if (!em || !dm) continue
        let data
        try {
          data = JSON.parse(dm[1])
        } catch {
          continue
        }
        handler(em[1].trim(), data)
      }
    }
  }

  const handleSSE = (event: string, data: any) => {
    switch (event) {
      case 'phase':
        setPhases((prev) =>
          prev.map((p) =>
            p.id === 'ph-' + data.phase
              ? { ...p, text: data.message, state: 'running' as const }
              : { ...p, state: p.state === 'running' ? 'done' : p.state }
          )
        )
        break
      case 'atoms':
        renderAtoms(data)
        setPhases((prev) =>
          prev.map((p) =>
            p.id === 'ph-fetch' || p.id === 'ph-ingest'
              ? { ...p, state: 'done' as const }
              : p
          )
        )
        break
      case 'individual':
        renderIndividual(data)
        break
      case 'pain':
        renderPain(data.pain_groups, data.pain_points)
        setPhases((prev) =>
          prev.map((p) => (p.id === 'ph-pain' ? { ...p, state: 'done' as const } : p))
        )
        break
      case 'strategies':
        setAppState((s) => ({
          ...s,
          strategies: data,
          topPickId: data.top_pick_id,
          ...(data.run_id ? { runId: data.run_id } : {})
        }))
        if ((data.strategies || []).length === 0) {
          console.error('[DRiX] Server returned 0 strategies — showing retry option')
        }
        renderStrategies(data)
        setPhases((prev) =>
          prev.map((p) =>
            p.id === 'ph-strategies' ? { ...p, state: 'done' as const } : p
          )
        )
        break
      case 'done':
        setAppState((s) => ({ ...s, runId: data.run_id }))
        break
      case 'error':
        setError(data.message)
        break
    }
  }

  // ─── RENDERERS (all original logic preserved) ───────────────────────────

  const renderAtoms = (data: any) => {
    const groups = [
      { key: 'sender', label: 'Sender (you)', role: 'sender' },
      { key: 'solution', label: 'Solution / product', role: 'solution' },
      { key: 'customer', label: 'Customer', role: 'customer' },
    ]
    let html = `
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
        <span style="width:14px;height:2px;background:var(--dx-accent);border-radius:2px;"></span>
        6D-Tagged Atoms
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        ${groups.map((g) => renderAtomGroup(data[g.key], g)).join('')}
      </div>
    `
    // Responsive
    html += `<style>@media(max-width:960px){.atoms-triple{grid-template-columns:1fr!important}}</style>`
    setAtomsHtml(html)
    setShowAtoms(true)
  }

  const renderAtomGroup = (entry: any, g: any) => {
    if (!entry)
      return `<div style="background:var(--surface);border:1px solid var(--dx-border);border-radius:10px;padding:14px;"><div style="font-size:12px;font-weight:800;color:var(--text);">${esc(g.label)}</div><div style="font-size:11px;color:var(--text-dim);margin-top:4px;">No data.</div></div>`
    const name = entry.target?.name || g.label
    const atoms = entry.atoms || []
    const count = atoms.length
    let sourceBadge = ''
    if (entry.source === 'local_cache') {
      sourceBadge = `<span style="font-size:9px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(61,220,132,0.18);color:var(--green);border:1px solid rgba(61,220,132,0.4)">⚡ Memory cache</span>`
    } else if (entry.source === 'db_cache') {
      sourceBadge = `<span style="font-size:9px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(61,220,132,0.14);color:var(--green);border:1px solid rgba(61,220,132,0.35)">⚡ DB cache (30d)</span>`
    } else if (entry.source === 'tde_cache') {
      sourceBadge = `<span style="font-size:9px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(181,131,255,0.14);color:var(--purple);border:1px solid rgba(181,131,255,0.35)">◈ DRiX cache</span>`
    } else if (entry.source === 'fresh') {
      sourceBadge = `<span style="font-size:9px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(90,212,255,0.10);color:var(--cyan);border:1px solid rgba(90,212,255,0.30)">⌁ Fresh (warming DRiX)</span>`
    }

    const byType: Record<string, any[]> = {}
    atoms.forEach((a: any) => {
      const t = a.type || 'unknown'
      if (!byType[t]) byType[t] = []
      byType[t].push(a)
    })
    const typeOrder = [
      'mission', 'product', 'icp', 'proof_point', 'team', 'stack_signal',
      'buying_trigger', 'differentiator', 'partnership', 'contact',
      'weakness', 'mission_gap',
    ]
    const sortedTypes = Object.keys(byType).sort(
      (a, b) =>
        (typeOrder.indexOf(a) === -1 ? 99 : typeOrder.indexOf(a)) -
        (typeOrder.indexOf(b) === -1 ? 99 : typeOrder.indexOf(b))
    )

    const typeColors: Record<string, string> = {
      mission: '#5aa9ff', product: '#3ddc84', icp: '#5ad4ff', proof_point: '#3ddc84',
      team: '#b583ff', stack_signal: '#ff9d5a', buying_trigger: '#ffc757',
      differentiator: '#5aa9ff', partnership: '#5ad4ff', contact: '#ff9d5a',
      weakness: '#ff5a5a', mission_gap: '#ff67c3',
    }

    const accordionHtml = sortedTypes.map((type) => {
      const items = byType[type]
      const typeLabel = type.replace(/_/g, ' ')
      return `
        <div style="border:1px solid var(--dx-border);border-radius:8px;overflow:hidden;margin-bottom:4px;">
          <div onclick="this.classList.toggle('open');var b=this.nextElementSibling;b.style.display=b.style.display==='none'?'':'none';var a=this.querySelector('.arrow');a.textContent=a.textContent==='▶'?'▼':'▶';a.classList.toggle('open')" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:var(--surface-3);transition:background 0.15s;user-select:none;" onmouseover="this.style.background='rgba(90,169,255,0.08)'" onmouseout="this.style.background='var(--surface-3)'">
            <span class="arrow" style="font-size:9px;color:var(--text-muted);transition:transform 0.15s;width:12px;">▶</span>
            <span style="font-size:11px;font-weight:800;text-transform:capitalize;color:var(--text);letter-spacing:0.3px;flex:1;">${esc(typeLabel)}</span>
            <span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px;background:rgba(90,169,255,0.12);color:var(--dx-accent);letter-spacing:0.5px;">${items.length}</span>
          </div>
          <div style="display:none;flex-direction:column;gap:6px;padding:8px 10px;max-height:500px;overflow-y:auto;">
            ${items.map((a) => renderAtomMini(a, typeColors[type] || '#5aa9ff')).join('')}
          </div>
        </div>
      `
    }).join('')

    const roleColors: Record<string, string> = {
      sender: 'rgba(90,169,255,0.15);color:var(--dx-accent)',
      solution: 'rgba(61,220,132,0.15);color:var(--green)',
      customer: 'rgba(181,131,255,0.15);color:var(--purple)',
    }

    return `
      <div style="background:var(--surface);border:1px solid var(--dx-border);border-radius:10px;padding:14px 14px 10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;gap:8px;">
          <div>
            <div style="font-size:12px;font-weight:800;letter-spacing:0.3px;color:var(--text);">${esc(name)}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;">
              <span style="font-size:10px;color:var(--text-muted);font-weight:700;letter-spacing:1.5px;">${count} ATOMS</span>
              <span style="font-size:10px;color:var(--text-muted);font-weight:700;letter-spacing:1.5px;background:rgba(181,131,255,0.12);color:var(--purple);padding:1px 6px;border-radius:4px;">${sortedTypes.length} TYPES</span>
              ${sourceBadge}
            </div>
          </div>
          <span style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;font-weight:800;padding:2px 8px;border-radius:10px;background:${roleColors[g.role] || ''};">${esc(g.role)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;font-style:italic;line-height:1.5;">${esc(entry.summary || '')}</div>
        <div style="display:flex;flex-direction:column;gap:4px;">${accordionHtml}</div>
      </div>
    `
  }

  const renderAtomMini = (a: any, color: string) => {
    const cred = parseInt(a.d_credibility) || 0
    const credPct = Math.min(100, cred * 20)
    const ind = a.d_industry || {}
    const indValue =
      ind.naics || ind.sic
        ? `${esc(shortCode(ind.naics))}<br><span style="color:var(--muted)">${esc(shortCode(ind.sic))}</span>`
        : '—'
    return `
      <div style="background:var(--bg);border:1px solid var(--dx-border);border-left:3px solid ${color};border-radius:6px;padding:8px 10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
          <span style="font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:${color};font-weight:800;">${esc((a.type || '').replace(/_/g, ' '))}</span>
          <span style="font-size:9px;color:var(--text-muted);font-weight:700;letter-spacing:1px;text-transform:uppercase;">${esc(a.confidence || '')}</span>
        </div>
        <div style="font-size:12px;color:var(--text);line-height:1.4;margin-bottom:6px;">${esc(a.claim)}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:4px;">
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--dx-accent);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Persona</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_persona))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--cyan);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Stage</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_buying_stage))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--pink);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Emotion</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_emotional_driver))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--orange);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Evidence</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_evidence_type))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--green);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Cred</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${cred || '—'}/5</div>
            <div style="height:3px;background:var(--bg);border-radius:2px;margin-top:3px;overflow:hidden;">
              <div style="height:100%;background:var(--green);border-radius:2px;width:${credPct}%;"></div>
            </div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--yellow);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Recency</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_recency))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--green);background:rgba(61,220,132,0.06);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Econ</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_economic_driver))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--red);background:rgba(255,90,90,0.05);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Inertia</div>
            <div style="font-size:9px;color:var(--text);font-weight:600;margin-top:1px;">${esc(short(a.d_status_quo_pressure))}</div>
          </div>
          <div style="background:var(--surface-3);border-radius:3px;padding:3px 5px;font-size:8px;line-height:1.2;text-align:left;min-height:32px;border-left:2px solid var(--purple);background:rgba(181,131,255,0.06);">
            <div style="font-size:7px;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;font-weight:700;">Industry</div>
            <div style="font-size:8px;color:var(--text);font-weight:600;margin-top:1px;line-height:1.25;">${indValue}</div>
          </div>
        </div>
      </div>
    `
  }

  const renderIndividual = (data: any) => {
    if (!data) return
    const name = data.target?.name || 'Target Individual'
    const title = data.target?.title || ''
    const company = data.target?.company || ''
    const keyInsight = data.target?.key_insight || ''
    const pitchAngles = data.pitch_angles || []
    const careerHighlights = data.career_highlights || []
    const publicSignals = data.public_signals || []
    const vendorOpinions = data.vendor_opinions || []
    const leadershipStyle = data.leadership_style || ''
    const painSignals = data.pain_signals || []
    const atomCount = (data.atoms || []).length
    const recognized = data.scan?.recognized
    const confidence = data.scan?.confidence || ''

    const listItems = (items: string[]) =>
      items
        .map(
          (i) =>
            `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;line-height:1.5">${esc(i)}</div>`
        )
        .join('')

    let html = `
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
        <span style="width:14px;height:2px;background:var(--dx-accent);border-radius:2px;"></span>
        Individual Intelligence — ${esc(name)}
      </div>
      <div style="background:var(--surface);border:1px solid var(--dx-border);border-radius:10px;padding:16px;margin-top:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div>
            <div style="font-size:16px;font-weight:700;">${esc(name)}</div>
            ${title || company ? `<div style="font-size:13px;color:var(--text-dim)">${esc(title)}${title && company ? ' — ' : ''}${esc(company)}</div>` : ''}
          </div>
          ${confidence ? `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:4px 10px;border-radius:12px;${recognized ? 'background:rgba(61,220,132,0.12);color:var(--green)' : 'background:rgba(245,158,11,0.12);color:#f59e0b'}">${recognized ? 'Recognized' : 'Inferred'} · ${esc(confidence)}</div>` : ''}
        </div>
        ${keyInsight ? `
        <div style="background:rgba(90,169,255,0.08);border-left:3px solid var(--cyan);padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:14px;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--cyan);margin-bottom:4px;">Key Insight</div>
          <div style="font-size:14px;line-height:1.5;">${esc(keyInsight)}</div>
        </div>` : ''}
        <div style="font-size:13px;color:var(--text-dim);margin-bottom:14px;line-height:1.6;">${esc(data.summary || '')}</div>
        ${pitchAngles.length ? `
        <div style="margin-bottom:14px;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--green);margin-bottom:8px;">Conversation Openers (${pitchAngles.length})</div>
          ${pitchAngles.map((a: string) => `<div style="background:rgba(61,220,132,0.06);border:1px solid rgba(61,220,132,0.2);border-radius:6px;padding:8px 10px;margin:4px 0;font-size:12px;line-height:1.5">${esc(a)}</div>`).join('')}
        </div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          ${careerHighlights.length ? `<div><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--cyan);margin-bottom:8px;">Career Highlights (${careerHighlights.length})</div>${listItems(careerHighlights)}</div>` : ''}
          ${painSignals.length ? `<div><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#ef4444;margin-bottom:8px;">Pain Signals (${painSignals.length})</div>${listItems(painSignals)}</div>` : ''}
          ${publicSignals.length ? `<div><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#a78bfa;margin-bottom:8px;">Public Signals (${publicSignals.length})</div>${listItems(publicSignals)}</div>` : ''}
          ${vendorOpinions.length ? `<div><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#f59e0b;margin-bottom:8px;">Vendor Opinions (${vendorOpinions.length})</div>${listItems(vendorOpinions)}</div>` : ''}
        </div>
        ${leadershipStyle ? `
        <div style="margin-top:14px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#a78bfa;margin-bottom:4px;">Leadership Style</div>
          <div style="font-size:12px;line-height:1.5;">${esc(leadershipStyle)}</div>
        </div>` : ''}
        <div style="margin-top:12px;font-size:11px;color:var(--text-muted)">${atomCount} behavioral atoms extracted</div>
      </div>
    `
    setIndividualHtml(html)
    setShowIndividual(true)
  }

  const renderPain = (painGroups: any, painPointsFlat: any[]) => {
    const groups = painGroups || {
      company_pain: [],
      subindustry_pain: [],
      industry_pain: painPointsFlat || [],
    }
    const total =
      (groups.company_pain?.length || 0) +
      (groups.subindustry_pain?.length || 0) +
      (groups.industry_pain?.length || 0)
    if (total === 0) {
      setPainHtml(
        `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;"><span style="width:14px;height:2px;background:var(--dx-accent);border-radius:2px;"></span>Customer Pain Points</div><div style="color:var(--text-dim);font-size:13px;">Pain surfacing returned nothing — try a richer customer URL, or add industry/sub-industry.</div>`
      )
      setShowPain(true)
      return
    }

    const section = (label: string, items: any[], tone: string) => {
      if (!items || !items.length) return ''
      const toneColors: Record<string, { border: string; bg: string }> = {
        company: { border: 'var(--red)', bg: 'rgba(255,90,90,0.05)' },
        subindustry: { border: 'var(--orange)', bg: 'rgba(255,157,90,0.05)' },
        industry: { border: 'var(--cyan)', bg: 'rgba(90,212,255,0.04)' },
      }
      const tc = toneColors[tone] || toneColors.company
      return `
        <div style="margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${tc.border};">${esc(label)}</span>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--surface-2);color:var(--text-dim);">${items.length}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">
            ${items.map((p) => renderPainCard(p, tone)).join('')}
          </div>
        </div>
      `
    }

    setPainHtml(`
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
        <span style="width:14px;height:2px;background:var(--dx-accent);border-radius:2px;"></span>
        Pain Points — ${total} across company, sub-industry, industry
      </div>
      ${section('Company-specific', groups.company_pain, 'company')}
      ${section('Sub-industry', groups.subindustry_pain, 'subindustry')}
      ${section('Industry-wide', groups.industry_pain, 'industry')}
    `)
    setShowPain(true)
  }

  const renderPainCard = (p: any, tone: string) => {
    const personaChips = (per: any) => {
      if (!per) return ''
      const u = per.urgency || p.urgency
      const el = per.economic_lever || p.economic_lever
      const inf = per.inertia_force || p.inertia_force
      return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:9px;">
        ${u ? `<span style="background:var(--surface-2);color:var(--text-dim);padding:2px 6px;border-radius:8px;font-weight:600;letter-spacing:0.5px;${u === 'high' ? 'background:rgba(255,90,90,0.15);color:var(--red);' : u === 'medium' ? 'background:rgba(255,199,87,0.15);color:var(--yellow);' : 'background:rgba(61,220,132,0.12);color:var(--green);'}">urgency: ${esc(u)}</span>` : ''}
        ${el && el !== 'None' ? `<span style="background:var(--surface-2);color:var(--text-dim);padding:2px 6px;border-radius:8px;font-weight:600;letter-spacing:0.5px;">pull: ${esc(el)}</span>` : ''}
        ${inf && inf !== 'None' ? `<span style="background:var(--surface-2);color:var(--text-dim);padding:2px 6px;border-radius:8px;font-weight:600;letter-spacing:0.5px;">inertia: ${esc(inf)}</span>` : ''}
      </div>`
    }

    const borderColors: Record<string, string> = {
      company: 'var(--red)',
      subindustry: 'var(--orange)',
      industry: 'var(--cyan)',
    }
    const bgColors: Record<string, string> = {
      company: 'rgba(255,90,90,0.04)',
      subindustry: 'rgba(255,157,90,0.04)',
      industry: 'rgba(90,212,255,0.04)',
    }

    let personaHtml = ''
    if (p.persona_primary && p.persona_secondary) {
      personaHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
        <div style="flex:1;min-width:140px;background:var(--surface-2);border-radius:6px;padding:6px 8px;border-left:2px solid var(--dx-accent);">
          <div style="font-size:8px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);font-weight:700;margin-bottom:2px;">Primary Owner</div>
          <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:2px;">${esc(p.persona_primary.title || '')}</div>
          ${p.persona_primary.rationale ? `<div style="font-size:10px;color:var(--dx-accent);font-weight:600;line-height:1.4;margin-bottom:2px;">${esc(p.persona_primary.rationale)}</div>` : ''}
          <div style="font-size:10px;color:var(--text-dim);line-height:1.4;font-style:italic;">${esc(p.persona_primary.perspective || '')}</div>
          ${personaChips(p.persona_primary)}
        </div>
        <div style="flex:1;min-width:140px;background:var(--surface-2);border-radius:6px;padding:6px 8px;border-left:2px solid var(--text-muted);">
          <div style="font-size:8px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);font-weight:700;margin-bottom:2px;">Also Affected</div>
          <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:2px;">${esc(p.persona_secondary.title || '')}</div>
          ${p.persona_secondary.rationale ? `<div style="font-size:10px;color:var(--dx-accent);font-weight:600;line-height:1.4;margin-bottom:2px;">${esc(p.persona_secondary.rationale)}</div>` : ''}
          <div style="font-size:10px;color:var(--text-dim);line-height:1.4;font-style:italic;">${esc(p.persona_secondary.perspective || '')}</div>
          ${personaChips(p.persona_secondary)}
        </div>
      </div>`
    } else if (p.persona) {
      personaHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:9px;margin-bottom:6px;"><span style="background:var(--surface-2);color:var(--text-dim);padding:2px 6px;border-radius:8px;font-weight:600;letter-spacing:0.5px;">${esc(p.persona)}</span></div>`
    }

    return `
      <div style="background:${bgColors[tone] || bgColors.company};border:1px solid ${borderColors[tone] || borderColors.company}30;border-left:3px solid ${borderColors[tone] || borderColors.company};border-radius:8px;padding:12px 14px;">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">${esc(p.title || '')}</div>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.5;margin-bottom:6px;">${esc(p.description || '')}</div>
        ${p.evidence ? `<div style="font-size:10px;color:var(--text-muted);font-style:italic;margin-bottom:6px;line-height:1.4;border-left:2px solid var(--dx-border);padding-left:6px;">${esc(p.evidence)}</div>` : ''}
        ${personaHtml}
      </div>
    `
  }

  const renderStrategies = (data: any) => {
    const strats = data.strategies || []
    const topId = data.top_pick_id

    // Show retry prompt if 0 strategies
    const retryBlock = strats.length === 0 ? `
      <div style="background:rgba(255,90,90,0.08);border:1px solid rgba(255,90,90,0.25);border-radius:12px;padding:20px;text-align:center;margin-bottom:16px;">
        <div style="font-size:14px;font-weight:700;color:var(--red);margin-bottom:8px;">Strategy generation failed</div>
        <div style="font-size:13px;color:var(--text-dim);margin-bottom:14px;">The AI model didn't return strategies. This can happen with cached stale data or model timeouts.</div>
        <button onclick="window.__retryStrategies()" style="background:linear-gradient(to right,#5aa9ff,#b583ff);color:#0a0e13;border:none;border-radius:10px;padding:10px 24px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;">Retry with Fresh Data →</button>
      </div>
    ` : ''

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:0;display:flex;align-items:center;gap:8px;">
          <span style="width:14px;height:2px;background:var(--dx-accent);border-radius:2px;"></span>
          Sales Strategies — ${strats.length}
        </div>
        <div style="font-size:12px;color:var(--text-dim);">
          <strong>${esc(data.sender_label || 'You')}</strong> selling
          <strong>${esc(data.solution_label || 'your solution')}</strong> to
          <strong>${esc(data.customer_label || 'the customer')}</strong>
        </div>
      </div>
      ${retryBlock}
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${strats.map((s: any) => renderStratCard(s, s.id === topId)).join('')}
        <div style="background:var(--bg);border:2px dashed var(--dx-border);border-radius:12px;padding:14px 16px;text-align:center;">
          <button onclick="window.toggleCustomStrat()" style="background:transparent;border:none;color:var(--dx-accent);font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;padding:4px 8px;">+ Add your own (6th) strategy</button>
          <div id="custom-strat-form" style="display:none;text-align:left;margin-top:8px;">
            <input type="text" id="custom-title-input" placeholder="Strategy title" style="width:100%;margin-bottom:8px;background:var(--surface-2);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;color:var(--text);font-size:13px;font-family:inherit;" />
            <textarea id="custom-explain-input" placeholder="Explain in 2-3 sentences why this wins." style="width:100%;margin-bottom:8px;background:var(--surface-2);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;color:var(--text);font-size:13px;font-family:inherit;resize:vertical;min-height:60px;"></textarea>
            <button onclick="window.saveCustomStrat()" style="background:transparent;border:1px solid var(--dx-border);color:var(--text-dim);padding:8px 16px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;font-family:inherit;">Save custom strategy</button>
          </div>
        </div>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--dx-border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div id="strat-action-info" style="font-size:13px;color:var(--text);font-weight:600;">Click a strategy to select it. Multi-select to trigger Sales Advisor Storm.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="btn-proceed" disabled onclick="window.onProceed()" style="background:var(--surface-3);color:var(--text-dim);border:1px solid var(--dx-border);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:800;cursor:not-allowed;font-family:inherit;transition:all 0.15s;letter-spacing:0.3px;opacity:0.7;">Proceed with selected →</button>
          <button id="btn-storm" disabled onclick="window.onAdvisorStorm()" style="display:none;background:linear-gradient(135deg,var(--dx-accent),var(--purple));color:#fff;border:none;border-radius:10px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;opacity:0.4;cursor:not-allowed;">Run Sales Advisor Storm</button>
        </div>
      </div>
    `
    setStrategiesHtml(html)
    setShowStrategies(true)
  }

  const renderStratCard = (s: any, isTop: boolean) => {
    const confPct = Math.max(0, Math.min(100, parseInt(s.confidence) || 0))
    const persona = s.target_persona || 'General'
    const pain = s.pain_anchor || '—'
    const force = s.strategy_force || 'balanced'
    const forceLabel = force === 'economic_pull' ? 'Econ Pull' : force === 'counter_inertia' ? 'Counter Inertia' : 'Balanced'
    const forceStyles: Record<string, string> = {
      economic_pull: 'background:rgba(61,220,132,0.12);color:var(--green);',
      counter_inertia: 'background:rgba(255,103,195,0.12);color:var(--pink);',
      balanced: 'background:rgba(90,169,255,0.12);color:var(--dx-accent);',
    }
    return `
      <div class="strat-card ${isTop ? 'top-pick' : ''}" data-strat-id="${esc(s.id)}" onclick="window.toggleStrat('${esc(s.id)}')" style="background:var(--surface-2);border:2px solid var(--dx-border);border-radius:12px;padding:16px 18px;position:relative;cursor:pointer;transition:all 0.15s;${isTop ? '' : ''}">
        ${isTop ? `<div style="position:absolute;top:12px;right:14px;font-size:9px;letter-spacing:1.5px;font-weight:800;color:var(--yellow);background:rgba(255,199,87,0.15);padding:3px 8px;border-radius:10px;">TOP PICK</div>` : ''}
        <div style="display:flex;gap:10px;margin-bottom:10px;padding-right:80px;align-items:flex-start;">
          <div class="strat-check" style="width:22px;height:22px;border:2px solid var(--dx-border);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s;background:var(--bg);margin-top:2px;"></div>
          <div style="font-size:15px;font-weight:700;color:var(--text);line-height:1.3;">${esc(s.title)}</div>
        </div>
        <div style="margin-bottom:10px;">
          <span style="display:inline-flex;align-items:center;gap:0;font-size:11px;font-weight:800;letter-spacing:0.3px;margin-bottom:10px;padding:0;border:1px solid var(--dx-border);border-radius:14px;overflow:hidden;max-width:100%;">
            <span style="background:rgba(90,169,255,0.15);color:var(--dx-accent);padding:4px 10px;">${esc(persona)}</span>
            <span style="background:var(--surface-3);color:var(--text-muted);padding:4px 6px;font-size:10px;">×</span>
            <span style="background:rgba(255,90,90,0.12);color:#ff9a9a;padding:4px 10px;">${esc(pain)}</span>
          </span>
          <span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase;padding:3px 8px;border-radius:10px;margin-left:6px;vertical-align:middle;${forceStyles[force] || forceStyles.balanced}">${esc(forceLabel)}</span>
        </div>
        <div style="font-size:13px;color:var(--text-dim);line-height:1.55;margin-bottom:10px;margin-top:10px;">${esc(s.explanation)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px;">
          <div style="background:var(--bg);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;"><div style="font-size:8px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:3px;">Customer pain</div><div style="font-size:11px;color:var(--text);line-height:1.4;">${esc(s.customer_pain)}</div></div>
          <div style="background:var(--bg);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;"><div style="font-size:8px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:3px;">You bring</div><div style="font-size:11px;color:var(--text);line-height:1.4;">${esc(s.sender_contribution)}</div></div>
          <div style="background:var(--bg);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;"><div style="font-size:8px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:3px;">Solution delivers</div><div style="font-size:11px;color:var(--text);line-height:1.4;">${esc(s.solution_contribution)}</div></div>
          <div style="background:var(--bg);border:1px solid var(--dx-border);border-radius:6px;padding:8px 10px;"><div style="font-size:8px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:3px;">First step</div><div style="font-size:11px;color:var(--text);line-height:1.4;">${esc(s.first_step)}</div></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:10px;border-top:1px dashed var(--dx-border);">
          <span style="font-size:10px;background:rgba(90,169,255,0.1);color:var(--dx-accent);padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:0.3px;">${esc(persona)}</span>
          <span style="font-size:10px;color:var(--text-dim);font-weight:700;letter-spacing:0.5px;">CONFIDENCE ${confPct}<span style="display:inline-block;width:60px;height:4px;background:var(--surface-3);border-radius:2px;margin-left:6px;vertical-align:middle;"><span style="display:block;height:100%;background:var(--green);border-radius:2px;width:${confPct}%;"></span></span></span>
        </div>
      </div>
    `
  }

  // ─── STRATEGY SELECTION (imperative via window) ─────────────────────────
  useEffect(() => {
    window.toggleStrat = (id: string) => {
      setAppState((s) => {
        const newSelected = new Set(s.selected)
        if (newSelected.has(id)) {
          newSelected.delete(id)
        } else {
          newSelected.add(id)
        }
        // Update UI
        setTimeout(() => updateStratUI(newSelected), 0)
        return { ...s, selected: newSelected }
      })
    }

    window.toggleCustomStrat = () => {
      const form = document.getElementById('custom-strat-form')
      if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none'
    }

    window.saveCustomStrat = () => {
      const title = (document.getElementById('custom-title-input') as HTMLInputElement)?.value.trim()
      const expl = (document.getElementById('custom-explain-input') as HTMLTextAreaElement)?.value.trim()
      if (!title || !expl) {
        setError('Custom strategy needs a title and an explanation.')
        return
      }
      setAppState((s) => {
        const newState = { ...s, customStrategy: { title, explanation: expl } }
        // Add card
        setTimeout(() => {
          const list = document.querySelector('.strat-list')
          if (!list) return
          const card = document.createElement('div')
          card.className = 'strat-card selected'
          card.setAttribute('data-strat-id', 'custom')
          card.onclick = () => window.toggleStrat?.('custom')
          card.innerHTML = `
            <div style="display:flex;gap:10px;margin-bottom:10px;padding-right:80px;align-items:flex-start;">
              <div class="strat-check" style="width:22px;height:22px;border:2px solid var(--green);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--green);color:#0a0e13;font-weight:900;font-size:14px;">✓</div>
              <div style="font-size:15px;font-weight:700;color:var(--text);line-height:1.3;">${esc(title)} <span style="font-size:10px;color:var(--text-muted);margin-left:6px;">(your custom)</span></div>
            </div>
            <div style="font-size:13px;color:var(--text-dim);line-height:1.55;margin-bottom:10px;">${esc(expl)}</div>
          `
          list.insertBefore(card, list.lastElementChild)
          const newSelected = new Set(s.selected)
          newSelected.add('custom')
          updateStratUI(newSelected)
        }, 0)
        return newState
      })
      const form = document.getElementById('custom-strat-form')
      if (form) form.style.display = 'none'
      const tIn = document.getElementById('custom-title-input') as HTMLInputElement
      const eIn = document.getElementById('custom-explain-input') as HTMLTextAreaElement
      if (tIn) tIn.value = ''
      if (eIn) eIn.value = ''
    }

    window.onProceed = () => {
      setAppState((s) => {
        if (s.selected.size !== 1) return s
        const id = [...s.selected][0]
        setTimeout(() => hydrateRef.current(id), 0)
        return s
      })
    }

    window.__retryStrategies = () => {
      // Clear the strategy cache on the server, then re-run the entire flow with force_fresh
      fetch('/api/clear-strategy-cache', { method: 'POST' }).catch(() => {})
      // Small delay then re-trigger with force_fresh=true
      setTimeout(() => {
        window.__runFlowFresh?.()
      }, 300)
    }

    window.onAdvisorStorm = () => {
      setAppState((s) => {
        const n = s.selected.size
        if (n < 2) return s
        setStormOpen(true)
        window._stormCallback = () => {
          setStormOpen(false)
          let best = null
          for (const id of s.selected) {
            if (id === 'custom') continue
            const strat = (s.strategies?.strategies || []).find((x: any) => x.id === id)
            if (strat && (!best || (parseInt(strat.confidence) || 0) > (parseInt(best.confidence) || 0))) best = strat
          }
          const winnerId = best ? best.id : [...s.selected][0]
          hydrateRef.current(winnerId)
        }
        return s
      })
    }

    return () => {
      delete window.toggleStrat
      delete window.toggleCustomStrat
      delete window.saveCustomStrat
      delete window.onProceed
      delete window.onAdvisorStorm
      delete window._stormCallback
      delete window.__retryStrategies
    }
  }, [])

  const updateStratUI = (selected: Set<string>) => {
    const count = selected.size
    const info = document.getElementById('strat-action-info')
    const proceed = document.getElementById('btn-proceed') as HTMLButtonElement
    const storm = document.getElementById('btn-storm') as HTMLButtonElement

    // Update checkmarks
    document.querySelectorAll('.strat-card').forEach((card) => {
      const id = card.getAttribute('data-strat-id')
      const check = card.querySelector('.strat-check') as HTMLElement
      if (!check) return
      if (selected.has(id || '')) {
        card.classList.add('selected')
        check.style.borderColor = 'var(--green)'
        check.style.background = 'var(--green)'
        check.style.color = '#0a0e13'
        check.style.fontWeight = '900'
        check.innerHTML = '✓'
      } else {
        card.classList.remove('selected')
        check.style.borderColor = 'var(--dx-border)'
        check.style.background = 'var(--bg)'
        check.style.color = ''
        check.style.fontWeight = ''
        check.innerHTML = ''
      }
    })

    if (!info || !proceed || !storm) return
    if (count === 0) {
      info.textContent = 'Click a strategy to select it. Multi-select to trigger Sales Advisor Storm.'
      info.style.fontWeight = '600'
      info.style.color = 'var(--text)'
      info.style.fontSize = '13px'
      proceed.disabled = true
      proceed.style.opacity = '0.7'
      proceed.style.background = 'var(--surface-3)'
      proceed.style.color = 'var(--text-dim)'
      proceed.style.border = '1px solid var(--dx-border)'
      proceed.style.cursor = 'not-allowed'
      proceed.style.display = ''
      storm.disabled = true
      storm.style.display = 'none'
    } else if (count === 1) {
      info.innerHTML = `<strong>${count}</strong> strategy selected. Click proceed to hydrate the lead.`
      info.style.fontWeight = '600'
      info.style.color = 'var(--text)'
      info.style.fontSize = '13px'
      proceed.disabled = false
      proceed.style.opacity = '1'
      proceed.style.background = 'linear-gradient(135deg,var(--green),var(--dx-accent))'
      proceed.style.color = '#0a0e13'
      proceed.style.border = 'none'
      proceed.style.cursor = 'pointer'
      proceed.style.display = ''
      storm.disabled = true
      storm.style.display = 'none'
    } else {
      info.innerHTML = `<strong>${count}</strong> strategies selected. Run Advisor Storm to converge on one.`
      proceed.disabled = true
      proceed.style.display = 'none'
      storm.disabled = false
      storm.style.opacity = '1'
      storm.style.display = ''
    }
  }

  // ─── HYDRATION ──────────────────────────────────────────────────────────
  const hydrate = async (strategyId: string) => {
    if (!appState.runId) {
      setError('No run in memory — rerun the flow.')
      return
    }
    setShowHydration(true)
    setHydrationHtml(`
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
        <span style="width:14px;height:2px;background:var(--green);border-radius:2px;"></span>
        Lead Hydration
      </div>
      <div style="color:var(--text-dim);font-size:13px;display:flex;align-items:center;gap:10px;">
        <span style="width:14px;height:14px;border:2px solid var(--dx-border);border-top-color:var(--dx-accent);border-radius:50%;animation:spin 0.8s linear infinite;display:inline-block;vertical-align:middle;"></span>
        Calling DRiX Ready Lead ... researching solution, mapping pain, generating discovery questions...
      </div>
    `)

    try {
      const body =
        strategyId === 'custom'
          ? { run_id: appState.runId, custom_strategy: appState.customStrategy }
          : { run_id: appState.runId, strategy_id: strategyId }
      const res = await fetch('/api/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || err.error || `Hydration failed (${res.status})`)
      }
      const data = await res.json()
      renderHydration(data)
    } catch (e: any) {
      setHydrationHtml(`
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
          <span style="width:14px;height:2px;background:var(--green);border-radius:2px;"></span>
          Lead Hydration
        </div>
        <div style="background:rgba(255,90,90,0.1);border:1px solid rgba(255,90,90,0.3);color:#ff9a9a;padding:12px 16px;border-radius:10px;font-size:13px;">${esc(e.message)}</div>
      `)
    }
  }

  // Keep the ref pointing at the latest hydrate so window.onProceed never goes stale
  hydrateRef.current = hydrate

  const renderHydration = (data: any) => {
    const h = data.hydration || {}
    const chosen = data.chosen_strategy || {}
    const score = h.score || 0
    const scoreColor =
      score >= 80 ? 'var(--red)' : score >= 60 ? 'var(--orange)' : score >= 40 ? 'var(--yellow)' : 'var(--text-muted)'

    const painsHtml = (h.painIndicators || [])
      .map(
        (p: any) => `
      <div style="background:rgba(255,90,90,0.04);border:1px solid rgba(255,90,90,0.3);border-radius:8px;padding:10px 12px;">
        <div style="font-size:12px;font-weight:700;color:var(--red);margin-bottom:4px;">${esc(p.label)}</div>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">${esc(p.explanation)}</div>
      </div>
    `
      )
      .join('')

    const questionsHtml = (h.questions || [])
      .map(
        (q: any) => `
      <div style="background:var(--surface-2);border:1px solid var(--dx-border);border-radius:10px;padding:16px 18px;margin-bottom:14px;">
        <div style="font-size:10px;letter-spacing:1.3px;text-transform:uppercase;color:var(--dx-accent);font-weight:800;margin-bottom:6px;">${esc(q.stage || 'Question')}</div>
        <div style="font-size:14px;color:var(--text);line-height:1.55;margin-bottom:12px;font-weight:600;">${esc(q.question)}</div>
        <div style="margin-bottom:10px;">
          <div style="font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:4px;">Purpose — why ask this</div>
          <div style="font-size:12px;color:var(--text-dim);line-height:1.55;">${esc(q.purpose || '')}</div>
        </div>
        ${q.pain_it_targets ? `<div style="margin-bottom:10px;"><div style="font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:4px;">Pain it targets</div><div style="font-size:12px;color:var(--text-dim);line-height:1.55;">${esc(q.pain_it_targets)}</div></div>` : ''}
        ${q.tone_guidance ? `<div style="background:rgba(90,169,255,0.06);border-left:2px solid var(--dx-accent);padding:8px 12px;border-radius:4px;font-size:11px;color:var(--text-dim);line-height:1.5;margin-top:4px;font-style:italic;">${esc(q.tone_guidance)}</div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
          <div>
            ${(q.positive_responses || [])
              .map(
                (r: any) => `
              <div style="border-radius:6px;padding:10px 12px;border:1px solid var(--dx-border);background:rgba(61,220,132,0.05);border-left:2px solid var(--green);margin-bottom:6px;">
                <div style="font-size:9px;letter-spacing:1.3px;text-transform:uppercase;font-weight:800;margin-bottom:4px;color:var(--green);">If they say (positive)</div>
                <div style="font-size:11px;color:var(--text);font-style:italic;line-height:1.5;margin-bottom:6px;">"${esc(r.response)}"</div>
                <div style="font-size:11px;color:var(--text-dim);line-height:1.5;"><strong style="color:var(--text);">Next:</strong> ${esc(r.next_step)}</div>
              </div>
            `
              )
              .join('')}
          </div>
          <div>
            ${(q.neutral_negative_responses || q.negative_responses || [])
              .map(
                (r: any) => `
              <div style="border-radius:6px;padding:10px 12px;border:1px solid var(--dx-border);background:rgba(255,90,90,0.04);border-left:2px solid var(--red);margin-bottom:6px;">
                <div style="font-size:9px;letter-spacing:1.3px;text-transform:uppercase;font-weight:800;margin-bottom:4px;color:var(--red);">If they say (pivot to recover)</div>
                <div style="font-size:11px;color:var(--text);font-style:italic;line-height:1.5;margin-bottom:6px;">"${esc(r.response)}"</div>
                <div style="font-size:11px;color:var(--text-dim);line-height:1.5;"><strong>Pivot:</strong> ${esc(r.pivot || r.next_step || '')}</div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `
      )
      .join('')

    const emails = h.emailCampaign || h.emailSequence || []
    const emailsHtml = emails
      .map(
        (em: any, i: number) => `
      <div style="background:var(--surface-2);border:1px solid var(--dx-border);border-left:3px solid var(--cyan);border-radius:8px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:var(--cyan);">${esc(em.label || 'Email ' + (em.step || i + 1))}</span>
          ${em.sendDay ? `<span style="font-size:10px;color:var(--text-muted);background:var(--surface-3);padding:2px 8px;border-radius:8px;">${esc(em.sendDay)}</span>` : ''}
        </div>
        <div style="font-size:13px;color:var(--text);margin-bottom:8px;line-height:1.5;"><strong style="color:var(--text-dim);font-weight:700;">Subject:</strong> ${esc(em.subject || em.subject_line || '')}</div>
        <div style="font-size:12px;color:var(--text-dim);line-height:1.65;white-space:normal;">${esc(em.body || em.content || '').replace(/\n/g, '<br>')}</div>
      </div>
    `
      )
      .join('')

    setHydrationHtml(`
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;">
        <span style="width:14px;height:2px;background:var(--green);border-radius:2px;"></span>
        Lead Hydration — Strategy: ${esc(chosen.title || '')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--dx-border);flex-wrap:wrap;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:13px;color:var(--text-dim);line-height:1.55;">${esc(h.whoIsThis || '—')}</div>
        </div>
        <div style="border:2px solid ${scoreColor};border-radius:10px;padding:8px 16px;text-align:center;min-width:80px;color:${scoreColor}">
          <div style="font-size:24px;font-weight:900;line-height:1;">${score}</div>
          <div style="font-size:9px;letter-spacing:1.5px;color:var(--text-muted);font-weight:800;margin-top:3px;">FIT SCORE</div>
        </div>
      </div>
      ${h.primaryLead ? `<div style="background:var(--surface-2);border-left:3px solid var(--dx-accent);padding:10px 14px;border-radius:6px;margin-bottom:16px;"><div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:4px;">Primary lead — who to target</div><div style="font-size:14px;color:var(--text);font-weight:700;">${esc(h.primaryLead.title)} · <span style="color:var(--text-dim);font-weight:500">${esc(h.primaryLead.topic)}</span></div></div>` : ''}
      ${painsHtml ? `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:8px;"><span style="width:14px;height:2px;background:var(--red);border-radius:2px;"></span>Pain Indicators</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-bottom:16px;">${painsHtml}</div>` : ''}
      ${questionsHtml ? `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:8px;"><span style="width:14px;height:2px;background:var(--green);border-radius:2px;"></span>Discovery Questions</div>${questionsHtml}` : ''}
      ${emailsHtml ? `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px;"><span style="width:14px;height:2px;background:var(--cyan);border-radius:2px;"></span>Email Drip Campaign (${emails.length}-step sequence)</div><div style="display:flex;flex-direction:column;gap:10px;">${emailsHtml}</div>` : ''}
    `)
  }

  // ─── CLEARSIGNALS ───────────────────────────────────────────────────────
  const submitClearSignals = async () => {
    const thread = (document.getElementById('cs-thread') as HTMLTextAreaElement)?.value.trim()
    if (!thread || thread.length < 50) {
      setCsStatus('Thread must be at least 50 characters.')
      return
    }
    if (!appState.runId) {
      setCsStatus('No active run — complete hydration first.')
      return
    }
    setCsStatus('Analyzing...')
    setCsOutput('')
    try {
      const res = await fetch('/api/clearsignals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: appState.runId, thread_text: thread }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Request failed')
      renderClearSignals(data.analysis || {})
      setCsStatus('Done.')
    } catch (e: any) {
      setCsStatus('Error: ' + e.message)
    }
  }

  const renderClearSignals = (a: any) => {
    const d = a.result || a
    const health = d.deal_health || {}
    const threadAn = Array.isArray(d.thread_analysis)
      ? d.thread_analysis
      : Array.isArray(d.email_analysis)
        ? d.email_analysis
        : Array.isArray(d.messages)
          ? d.messages
          : Array.isArray(d.analysis)
            ? d.analysis
            : []
    const nextSteps = Array.isArray(d.next_steps)
      ? d.next_steps
      : Array.isArray(d.recommended_actions)
        ? d.recommended_actions
        : Array.isArray(d.action_items)
          ? d.action_items
          : []
    void (d.rep_scorecard || d.scorecard || {})
    const scoreColor =
      health.score >= 70 ? 'var(--green)' : health.score >= 40 ? 'var(--yellow)' : 'var(--red)'

    const customerMsgs = threadAn.filter((t: any) => {
      const from = (t.message_from || t.from || t.author || '').toLowerCase()
      return !from.includes('jason') && !from.includes('rep') && !from.includes('seller') && !from.includes('atlas')
    })
    const customerNeeds = customerMsgs
      .filter((t: any) => t.signal_reading || t.what_it_means)
      .map((t: any) => t.signal_reading || t.what_it_means)

    let html = `
      <div style="display:flex;gap:14px;align-items:center;padding:12px 14px;background:var(--surface-2);border:1px solid var(--dx-border);border-radius:10px;margin-bottom:16px;">
        <div style="border:2px solid ${scoreColor};border-radius:50%;width:70px;height:70px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;color:${scoreColor}">
          <div style="font-size:22px;font-weight:800;line-height:1;">${esc(health.score ?? '?')}</div>
          <div style="font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;opacity:0.7;margin-top:2px;">STATUS</div>
        </div>
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:4px;">${esc(health.label || '')} ${health.win_probability != null ? `<span style="font-weight:500;color:var(--text-dim);font-size:12px">Win likelihood: ${health.win_probability}%</span>` : ''}</div>
          <div style="font-size:12px;color:var(--text-dim);line-height:1.55;">${esc(health.status_summary || health.summary || health.explanation || '')}</div>
        </div>
      </div>
    `

    if (customerNeeds.length) {
      html += `<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:var(--purple);margin:14px 0 8px;">What the customer is telling you</div>`
      html += customerNeeds.map((n: string) => `<div style="font-size:12px;color:var(--text);line-height:1.55;padding:6px 10px;border-left:2px solid var(--dx-accent);margin-bottom:6px;background:rgba(90,169,255,0.04);border-radius:0 6px 6px 0;">${esc(n)}</div>`).join('')
    }

    if (nextSteps.length) {
      html += `<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:var(--purple);margin:14px 0 8px;">Recommended next moves</div>`
      html += nextSteps
        .map((s: any) => {
          if (typeof s === 'string')
            return `<div style="background:var(--surface-2);border:1px solid var(--dx-border);border-radius:8px;padding:10px 12px;margin-bottom:8px;"><div style="font-size:12px;font-weight:700;color:var(--text);flex:1;">${esc(s)}</div></div>`
          return `
          <div style="background:var(--surface-2);border:1px solid var(--dx-border);border-radius:8px;padding:10px 12px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <div style="font-size:12px;font-weight:700;color:var(--text);flex:1;">${esc(s.action || '')}</div>
              ${s.timing ? `<span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(168,85,247,0.15);color:var(--purple);text-transform:uppercase;letter-spacing:0.5px;">${esc(s.timing)}</span>` : ''}
            </div>
            ${s.methodology ? `<div style="font-size:9px;color:var(--text-dim);font-weight:600;letter-spacing:0.3px;margin-bottom:4px;">${esc(s.methodology)}</div>` : ''}
            ${s.script ? `<div onclick="navigator.clipboard.writeText(this.innerText).then(()=>{this.style.outline='2px solid var(--green)';setTimeout(()=>this.style.outline='',800)})" style="font-size:12px;color:var(--text-dim);line-height:1.55;padding:8px 10px;background:var(--bg);border:1px solid var(--dx-border);border-radius:6px;white-space:pre-wrap;cursor:pointer;position:relative;">${esc(s.script)}</div>` : ''}
          </div>`
        })
        .join('')
    }

    setCsOutput(html)
  }

  // ─── COACH CHAT ─────────────────────────────────────────────────────────
  const sendCoachMsg = async () => {
    const msg = coachInput.trim()
    if (!msg || !appState.runId) return
    setCoachInput('')
    setCoachMsgs((prev) => [...prev, { role: 'user', text: msg }])
    setCoachTyping(true)

    try {
      const res = await fetch('/api/coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: appState.runId,
          message: msg,
          history: coachHistoryRef.current,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Coach failed')
      const reply = data.reply || ''
      coachHistoryRef.current.push({ role: 'user', content: msg })
      coachHistoryRef.current.push({ role: 'assistant', content: reply })
      setCoachMsgs((prev) => [...prev, { role: 'assistant', text: reply }])
    } catch (e: any) {
      setCoachMsgs((prev) => [...prev, { role: 'system', text: 'Error: ' + e.message }])
    } finally {
      setCoachTyping(false)
    }
  }

  // ─── VOICE COACH ────────────────────────────────────────────────────────
  const openVoiceCoach = async () => {
    if (!appState.runId) return
    setVoiceOpen(true)
    setVoiceStatus('Provisioning voice agent...')
    try {
      const res = await fetch('/api/coach-voice/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: appState.runId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Provisioning failed')
      setVoiceStatus(data.reused ? 'Voice coach ready (reusing existing).' : 'Voice coach ready.')
      const area = document.getElementById('voice-widget-area')
      if (area) {
        area.innerHTML = `<elevenlabs-convai agent-id="${esc(data.agent_id)}"></elevenlabs-convai>`
      }
      if (!document.querySelector('script[src*="elevenlabs.io/convai-widget"]')) {
        const s = document.createElement('script')
        s.src = 'https://elevenlabs.io/convai-widget/index.js'
        s.async = true
        document.body.appendChild(s)
      }
    } catch (e: any) {
      setVoiceStatus('Error: ' + e.message)
    }
  }

  // ─── DOWNLOAD REPORT ────────────────────────────────────────────────────
  const downloadReport = async () => {
    if (!appState.runId) {
      setReportStatus('No run to download yet — complete the demo first.')
      return
    }
    setReportStatus('Building report...')
    try {
      const res = await fetch(`/api/report/${encodeURIComponent(appState.runId)}/doc`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `DRiX-Report-${appState.runId}.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setReportStatus('Downloaded.')
    } catch (e: any) {
      setReportStatus(e.message)
    }
  }

  // ─── STYLES ─────────────────────────────────────────────────────────────
  const appStyles = `
    @keyframes spin { to { transform: rotate(360deg); } }
    .strat-card:hover { border-color: var(--dx-accent) !important; }
    .strat-card.selected { border-color: var(--green) !important; background: linear-gradient(135deg, var(--surface-2) 0%, rgba(61,220,132,0.06) 100%) !important; }
    @media (max-width: 960px) { .atoms-triple { grid-template-columns: 1fr !important; } }
  `

  return (
    <div className="pt-20 pb-16">
      <style>{appStyles}</style>

      {/* Header */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-drix-accent/10 border border-drix-accent/20 mb-4">
            <Zap size={14} className="text-drix-accent" />
            <span className="text-xs font-semibold tracking-widest uppercase text-drix-accent">
              Intelligence Builder
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-drix-text mb-3 tracking-tight">
            Build Your <span className="text-drix-accent">Intelligence</span>
          </h1>
          <p className="text-drix-dim max-w-2xl mx-auto text-sm leading-relaxed">
            Fill in what you know. Skip what you don't. DRiX adapts to whatever depth you provide.
          </p>
        </motion.div>

        {/* Status Bar */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="flex items-center justify-between mb-6 flex-wrap gap-3"
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-drix-dim bg-drix-surface rounded-full px-3 py-1.5 border border-drix-border">
              <span
                className={`w-1.5 h-1.5 rounded-full ${statusWarn ? 'bg-drix-yellow' : 'bg-drix-green'}`}
                style={statusWarn ? { boxShadow: '0 0 8px var(--yellow)' } : { boxShadow: '0 0 8px var(--green)' }}
              />
              <span>{statusText}</span>
            </div>
          </div>
          <Link
            to="/"
            className="text-xs text-drix-muted hover:text-drix-text transition-colors"
          >
            ← Back to Home
          </Link>
        </motion.div>

        {/* Wizard Panel */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="glass rounded-2xl p-6 sm:p-8 mb-8"
        >
          {/* Mode Switch */}
          <div className="flex items-center gap-3 mb-6 p-3 bg-drix-surface2 rounded-xl border border-drix-border">
            <span className={`text-[11px] font-extrabold tracking-widest uppercase ${mode === 'production' ? 'text-drix-green' : 'text-drix-muted'}`}>
              PRODUCTION
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={mode === 'demo'}
                onChange={(e) => setMode(e.target.checked ? 'demo' : 'production')}
              />
              <div className="w-10 h-[22px] bg-drix-green peer-checked:bg-drix-yellow rounded-full peer transition-colors duration-200 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-[18px]" />
            </label>
            <span className={`text-[11px] font-extrabold tracking-widest uppercase ${mode === 'demo' ? 'text-drix-yellow' : 'text-drix-muted'}`}>
              DEMO
            </span>
            <span className="text-[11px] text-drix-dim ml-2">
              {mode === 'demo' ? 'Limited to 20 atoms per category' : 'Full atom generation (50-150 per source)'}
            </span>
          </div>

          {/* ─── WIZARD ─── */}
          <div className="relative overflow-hidden min-h-[280px]">
            {/* Progress dots */}
            <div className="flex items-center justify-center gap-2 mb-8">
              {[0, 1, 2, 3, 4, 5].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    s < wizardStep ? 'w-6 bg-drix-accent' : s === wizardStep ? 'w-6 bg-drix-accent animate-pulse' : 'w-2 bg-drix-surface3'
                  }`}
                />
              ))}
            </div>

            {/* Step 0: Email */}
            {wizardStep === 0 && (
              <motion.div
                key="step0"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-md mx-auto text-center"
              >
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-drix-accent to-drix-purple mb-5 shadow-glow">
                  <Zap size={24} className="text-drix-bg" />
                </div>
                <h3 className="text-xl font-black text-drix-text mb-2">Let's get started</h3>
                <p className="text-sm text-drix-dim mb-6">Enter your email to begin building intelligence.</p>
                <input
                  type="email"
                  value={fEmail}
                  onChange={(e) => setFEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && fEmail.trim()) setWizardStep(1) }}
                  placeholder="you@yourcompany.com"
                  autoFocus
                  className="w-full max-w-sm mx-auto bg-drix-surface2 border border-drix-border rounded-xl px-5 py-3.5 text-base text-drix-text outline-none focus:border-drix-accent focus:shadow-glow transition-all h-[50px] text-center"
                />
                <div className="mt-6">
                  <button
                    onClick={() => fEmail.trim() && setWizardStep(1)}
                    disabled={!fEmail.trim()}
                    className="dx-btn-primary px-8 py-3.5 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  >
                    Next →
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 1: Reseller + Solution (required) */}
            {wizardStep === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-lg mx-auto"
              >
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-green to-drix-accent mb-4 shadow-lg">
                    <span className="text-drix-bg font-black text-lg">1</span>
                  </div>
                  <h3 className="text-lg font-black text-drix-text mb-1">Who are you and what do you sell?</h3>
                  <p className="text-xs text-drix-dim">These two fields are required. Everything else is optional.</p>
                </div>
                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Reseller / your company URL <span className="text-drix-red">*</span></label>
                    <input
                      type="text"
                      value={fSender}
                      onChange={(e) => setFSender(e.target.value)}
                      placeholder="yourcompany.com"
                      autoFocus
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-green focus:shadow-[0_0_20px_rgba(61,220,132,0.15)] transition-all h-[46px]"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Solution URL <span className="text-drix-red">*</span></label>
                    <input
                      type="text"
                      value={fSolution}
                      onChange={(e) => setFSolution(e.target.value)}
                      placeholder="yourcompany.com/products/flagship"
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-green focus:shadow-[0_0_20px_rgba(61,220,132,0.15)] transition-all h-[46px]"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-8">
                  <button
                    onClick={() => setWizardStep(0)}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => fSender.trim() && fSolution.trim() && setWizardStep(2)}
                    disabled={!fSender.trim() || !fSolution.trim()}
                    className="dx-btn-green px-7 py-3 rounded-xl text-sm font-bold hover:shadow-glow transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  >
                    Next →
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 2: Industry + Subindustry */}
            {wizardStep === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-lg mx-auto"
              >
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-cyan to-drix-accent mb-4 shadow-lg">
                    <span className="text-drix-bg font-black text-lg">2</span>
                  </div>
                  <h3 className="text-lg font-black text-drix-text mb-1">What industry are they in?</h3>
                  <p className="text-xs text-drix-dim">Optional — narrows the intelligence to their market.</p>
                </div>
                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Industry</label>
                    <select
                      value={selectedIndustry}
                      onChange={(e) => onIndustryChange(e.target.value)}
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-cyan focus:shadow-[0_0_20px_rgba(90,212,255,0.15)] transition-all h-[46px] appearance-none cursor-pointer"
                      style={{
                        backgroundImage: `linear-gradient(45deg,transparent 50%,var(--text-dim) 50%),linear-gradient(135deg,var(--text-dim) 50%,transparent 50%)`,
                        backgroundPosition: `calc(100% - 18px) 50%, calc(100% - 13px) 50%`,
                        backgroundSize: '5px 5px',
                        backgroundRepeat: 'no-repeat',
                        paddingRight: '32px',
                      }}
                    >
                      <option value="">{appState.naics ? 'Skip or select...' : 'Loading industries...'}</option>
                      {appState.naics?.map((sec) => (
                        <option key={sec.code} value={sec.code}>{sec.code} — {sec.name}</option>
                      ))}
                    </select>
                  </div>
                  {selectedIndustry && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="flex flex-col gap-1.5"
                    >
                      <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Subindustry</label>
                      <select
                        value={fSubindustry}
                        onChange={(e) => setFSubindustry(e.target.value)}
                        className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-cyan focus:shadow-[0_0_20px_rgba(90,212,255,0.15)] transition-all h-[46px] appearance-none cursor-pointer"
                        style={{
                          backgroundImage: `linear-gradient(45deg,transparent 50%,var(--text-dim) 50%),linear-gradient(135deg,var(--text-dim) 50%,transparent 50%)`,
                          backgroundPosition: `calc(100% - 18px) 50%, calc(100% - 13px) 50%`,
                          backgroundSize: '5px 5px',
                          backgroundRepeat: 'no-repeat',
                          paddingRight: '32px',
                        }}
                      >
                        <option value="">Select subindustry...</option>
                        {subindustryOptions.map((s) => (
                          <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                        ))}
                      </select>
                    </motion.div>
                  )}
                </div>
                <div className="flex items-center justify-between mt-8">
                  <button
                    onClick={() => setWizardStep(1)}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => setWizardStep(3)}
                    className="dx-btn-cyan px-7 py-3 rounded-xl text-sm font-bold hover:shadow-glow transition-all hover:-translate-y-0.5"
                  >
                    {selectedIndustry ? 'Next →' : 'Skip →'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Title + Company URL */}
            {wizardStep === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-lg mx-auto"
              >
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-purple to-drix-pink mb-4 shadow-lg">
                    <span className="text-drix-bg font-black text-lg">3</span>
                  </div>
                  <h3 className="text-lg font-black text-drix-text mb-1">Who are you selling to?</h3>
                  <p className="text-xs text-drix-dim">Optional — the more specific, the sharper the intelligence.</p>
                </div>
                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Buyer Title / Persona</label>
                    <input
                      type="text"
                      value={fTitle}
                      onChange={(e) => { setFTitle(e.target.value); updateDepth('title', e.target.value) }}
                      placeholder="e.g. VP of IT, CISO, CFO"
                      autoFocus
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-purple focus:shadow-[0_0_20px_rgba(181,131,255,0.15)] transition-all h-[46px]"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Company URL</label>
                    <input
                      type="text"
                      value={fCustomer}
                      onChange={(e) => { setFCustomer(e.target.value); updateDepth('company', e.target.value) }}
                      placeholder="customer.com"
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-purple focus:shadow-[0_0_20px_rgba(181,131,255,0.15)] transition-all h-[46px]"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-8">
                  <button
                    onClick={() => setWizardStep(2)}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => setWizardStep(4)}
                    className="dx-btn-purple-pink px-7 py-3 rounded-xl text-sm font-bold hover:shadow-glow transition-all hover:-translate-y-0.5"
                  >
                    {(fTitle || fCustomer) ? 'Next →' : 'Skip →'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 4: Individual LinkedIn + Email */}
            {wizardStep === 4 && (
              <motion.div
                key="step4"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-lg mx-auto"
              >
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-orange to-drix-yellow mb-4 shadow-lg">
                    <span className="text-drix-bg font-black text-lg">4</span>
                  </div>
                  <h3 className="text-lg font-black text-drix-text mb-1">Know the person?</h3>
                  <p className="text-xs text-drix-dim">Optional — individual-level intelligence when you have it.</p>
                </div>
                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Individual LinkedIn URL</label>
                    <input
                      type="text"
                      value={fIndividual}
                      onChange={(e) => { setFIndividual(e.target.value); updateDepth('individual', e.target.value) }}
                      placeholder="linkedin.com/in/janedoe"
                      autoFocus
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-orange focus:shadow-[0_0_20px_rgba(255,157,90,0.15)] transition-all h-[46px]"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">Individual Email</label>
                    <input
                      type="email"
                      value={fIndividualEmail}
                      onChange={(e) => setFIndividualEmail(e.target.value)}
                      placeholder="jane.doe@company.com"
                      className="bg-drix-surface2 border border-drix-border rounded-xl px-4 py-3 text-sm text-drix-text outline-none focus:border-drix-orange focus:shadow-[0_0_20px_rgba(255,157,90,0.15)] transition-all h-[46px]"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-8">
                  <button
                    onClick={() => setWizardStep(3)}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => setWizardStep(5)}
                    className="dx-btn-orange px-7 py-3 rounded-xl text-sm font-bold hover:shadow-glow transition-all hover:-translate-y-0.5"
                  >
                    {(fIndividual || fIndividualEmail) ? 'Next →' : 'Skip →'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 5: Review & Submit */}
            {wizardStep === 5 && (
              <motion.div
                key="step5"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -40 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="max-w-lg mx-auto"
              >
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-drix-accent to-drix-purple mb-4 shadow-lg animate-pulse-glow">
                    <Zap size={20} className="text-drix-bg" />
                  </div>
                  <h3 className="text-lg font-black text-drix-text mb-1">Ready to build</h3>
                  <p className="text-xs text-drix-dim">Here's what we're working with. Hit the button when ready.</p>
                </div>
                <div className="space-y-2.5 bg-drix-surface rounded-xl p-5 border border-drix-border">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Email</span>
                    <span className="text-drix-text font-medium truncate max-w-[200px]">{fEmail}</span>
                  </div>
                  <div className="h-px bg-drix-border/50" />
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Reseller</span>
                    <span className="text-drix-text font-medium truncate max-w-[200px]">{fSender}</span>
                  </div>
                  <div className="h-px bg-drix-border/50" />
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Solution</span>
                    <span className="text-drix-text font-medium truncate max-w-[200px]">{fSolution}</span>
                  </div>
                  {(selectedIndustry || fTitle || fCustomer || fIndividual) && <div className="h-px bg-drix-border/50" />}
                  {selectedIndustry && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Industry</span>
                      <span className="text-drix-accent font-medium">{appState.naics?.find(s => s.code === selectedIndustry)?.name}</span>
                    </div>
                  )}
                  {fTitle && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Persona</span>
                      <span className="text-drix-purple font-medium">{fTitle}</span>
                    </div>
                  )}
                  {fCustomer && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Company</span>
                      <span className="text-drix-purple font-medium">{fCustomer}</span>
                    </div>
                  )}
                  {fIndividual && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-drix-muted text-xs uppercase tracking-wider font-semibold">Individual</span>
                      <span className="text-drix-orange font-medium truncate max-w-[200px]">{fIndividual}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between mt-8">
                  <button
                    onClick={() => setWizardStep(4)}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => runFlow()}
                    disabled={running}
                    className="dx-btn-primary px-8 py-3.5 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center gap-2"
                  >
                    {running && <span className="w-4 h-4 border-2 border-drix-bg/30 border-t-drix-bg rounded-full animate-spin" />}
                    {running ? 'Building Intelligence...' : 'Build Intelligence →'}
                  </button>
                </div>
              </motion.div>
            )}
          </div>

          {/* Depth Indicator */}
          <div className="flex items-center gap-2 flex-wrap p-3 bg-drix-surface2 rounded-lg border border-drix-border text-[10px] mt-6">
            <span className="font-extrabold text-drix-muted tracking-widest uppercase mr-1">Depth:</span>
            {(['reseller', 'solution', 'industry', 'title', 'company', 'individual'] as const).map((varName, i) => (
              <span key={varName} className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded-md font-bold tracking-wide transition-all ${
                    varName === 'reseller' || varName === 'solution' || depth[varName as keyof typeof depth]
                      ? 'bg-drix-accent/15 text-drix-accent'
                      : 'bg-drix-surface3 text-drix-muted'
                  }`}
                >
                  {varName.toUpperCase()}
                </span>
                {i < 5 && <span className="text-drix-border text-[9px]">→</span>}
              </span>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 bg-drix-red/10 border border-drix-red/30 text-[#ff9a9a] px-4 py-3 rounded-xl text-sm flex items-center gap-2">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Phases */}
          {phases.some((p) => p.state !== 'pending') && (
            <div className="mt-6 space-y-1.5">
              {phases.map((phase) => (
                <div
                  key={phase.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all duration-300 ${
                    phase.state === 'running'
                      ? 'border-drix-accent/50 bg-drix-accent/5'
                      : phase.state === 'done'
                        ? 'border-drix-border/50 opacity-60'
                        : 'border-drix-border/30'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                      phase.state === 'running'
                        ? 'bg-drix-accent text-white animate-pulse'
                        : phase.state === 'done'
                          ? 'bg-drix-green text-white'
                          : 'bg-drix-surface3 text-drix-muted'
                    }`}
                  >
                    {phase.state === 'done' ? '✓' : phase.id.split('-')[1]?.[0]?.toUpperCase()}
                  </div>
                  <span
                    className={`text-xs ${
                      phase.state === 'running' ? 'text-drix-text' : phase.state === 'done' ? 'text-drix-dim line-through' : 'text-drix-muted'
                    }`}
                  >
                    {phase.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* ─── RESULT PANELS ─── */}
        {/* Atoms */}
        {showAtoms && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 sm:p-8 mb-6"
          >
            <div dangerouslySetInnerHTML={{ __html: atomsHtml }} />
          </motion.div>
        )}

        {/* Individual */}
        {showIndividual && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 sm:p-8 mb-6"
          >
            <div dangerouslySetInnerHTML={{ __html: individualHtml }} />
          </motion.div>
        )}

        {/* Pain */}
        {showPain && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 sm:p-8 mb-6"
          >
            <div dangerouslySetInnerHTML={{ __html: painHtml }} />
          </motion.div>
        )}

        {/* Strategies */}
        {showStrategies && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 sm:p-8 mb-6"
          >
            <div className="strat-list" dangerouslySetInnerHTML={{ __html: strategiesHtml }} />
          </motion.div>
        )}

        {/* Hydration */}
        {showHydration && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 sm:p-8 mb-6"
          >
            <div dangerouslySetInnerHTML={{ __html: hydrationHtml }} />

            {/* ClearSignals Launcher */}
            {appState.runId && (
              <div className="mt-6 p-4 sm:p-5 rounded-xl bg-gradient-to-br from-drix-purple/10 to-drix-accent/5 border border-drix-purple/20">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-extrabold text-drix-purple tracking-tight">ClearSignals AI — Email Thread Analyzer</div>
                    <div className="text-xs text-drix-dim mt-1">Paste any reply thread for deal-health scoring and next-step coaching.</div>
                  </div>
                  <button
                    onClick={() => setCsOpen(true)}
                    className="dx-btn-primary px-5 py-2.5 rounded-lg text-xs font-bold hover:shadow-glow transition-all whitespace-nowrap"
                  >
                    Analyze Thread
                  </button>
                </div>
              </div>
            )}

            {/* Coach Launcher */}
            {appState.runId && (
              <div className="mt-4 p-4 sm:p-5 rounded-xl bg-gradient-to-br from-drix-accent/10 to-drix-purple/5 border border-drix-accent/20">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-extrabold text-drix-accent tracking-tight">AI Sales Coach</div>
                    <div className="text-xs text-drix-dim mt-1 max-w-md">Ask anything about this deal — pain points, objections, what to say, who to target.</div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => setCoachOpen(true)}
                      className="px-5 py-2.5 rounded-lg text-xs font-bold bg-drix-accent text-white hover:shadow-glow transition-all flex items-center gap-2"
                    >
                      <MessageSquare size={14} />
                      Chat
                    </button>
                    <button
                      onClick={openVoiceCoach}
                      className="px-5 py-2.5 rounded-lg text-xs font-bold bg-drix-purple text-white hover:shadow-glow transition-all flex items-center gap-2"
                    >
                      <Mic size={14} />
                      Voice
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Report Launcher */}
            {appState.runId && (
              <div className="mt-4 p-4 sm:p-5 rounded-xl bg-gradient-to-br from-drix-green/10 to-drix-accent/5 border border-drix-green/20">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-extrabold text-drix-green tracking-tight">Save Full Report</div>
                    <div className="text-xs text-drix-dim mt-1 max-w-md">Download a complete Word report with all atoms, pain points, strategies, and outreach.</div>
                  </div>
                  <button
                    onClick={downloadReport}
                    className="px-5 py-2.5 rounded-lg text-xs font-bold bg-drix-green text-drix-bg hover:shadow-glow transition-all flex items-center gap-2 whitespace-nowrap"
                  >
                    <Download size={14} />
                    Download
                  </button>
                </div>
                {reportStatus && (
                  <div className={`mt-3 text-xs ${reportStatus === 'Downloaded.' ? 'text-drix-green' : reportStatus.includes('Error') ? 'text-drix-red' : 'text-drix-dim'}`}>
                    {reportStatus}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* ─── STORM MODAL ─── */}
      {stormOpen && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setStormOpen(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass rounded-2xl p-8 max-w-lg w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-black mb-3 gradient-text">Sales Advisor Storm</h3>
            <p className="text-sm text-drix-dim leading-relaxed mb-4">
              You selected <strong className="text-drix-text">multiple</strong> strategies. In production, DRiX runs a{' '}
              <strong>modified Miro Fish</strong> multi-agent deliberation across our Sales Advisor panel — converging on a single top strategy with confidence levels for each alternative.
            </p>
            <div className="bg-drix-yellow/5 border-l-4 border-drix-yellow rounded-r-lg p-4 mb-6">
              <p className="text-xs text-drix-text leading-relaxed">
                <strong className="text-drix-yellow">For this demo</strong>, we'll proceed with your highest-confidence selection. The full Advisor Storm is coming in the next release.
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setStormOpen(false)}
                className="px-5 py-2.5 rounded-lg text-xs font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setStormOpen(false)
                  if (window._stormCallback) window._stormCallback()
                }}
                className="dx-btn-green px-5 py-2.5 rounded-lg text-xs font-bold hover:shadow-glow transition-all"
              >
                Proceed →
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* ─── CLEARSIGNALS MODAL ─── */}
      {csOpen && (
        <div className="fixed inset-0 bg-black/65 z-50 flex items-start justify-center p-6 pt-16 overflow-y-auto backdrop-blur-sm" onClick={() => setCsOpen(false)}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl max-w-3xl w-full shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-drix-border">
              <div className="text-base font-extrabold text-drix-purple">ClearSignals AI — Email Thread Analysis</div>
              <button onClick={() => setCsOpen(false)} className="text-drix-dim hover:text-drix-text text-2xl leading-none">
                <X size={20} />
              </button>
            </div>
            <div className="p-5">
              <label className="block text-[11px] font-bold tracking-wide uppercase text-drix-dim mb-2">
                Paste the full email thread:
              </label>
              <textarea
                id="cs-thread"
                rows={8}
                placeholder="From: prospect@acme.com&#10;Subject: Re: Follow-up&#10;&#10;Thanks for the note. Honestly, timing is tough..."
                className="w-full bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2.5 text-xs text-drix-text font-mono leading-relaxed resize-y outline-none focus:border-drix-purple transition-colors"
              />
              <div className="flex items-center gap-4 mt-3">
                <button
                  onClick={submitClearSignals}
                  className="dx-btn-primary px-5 py-2.5 rounded-lg text-xs font-bold hover:shadow-glow transition-all"
                >
                  Analyze
                </button>
                <span className="text-xs text-drix-dim">{csStatus}</span>
              </div>
              {csOutput && (
                <div className="mt-4" dangerouslySetInnerHTML={{ __html: csOutput }} />
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* ─── COACH CHAT PANEL ─── */}
      {coachOpen && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed bottom-0 right-4 sm:right-8 w-[380px] max-w-[calc(100vw-2rem)] max-h-[70vh] glass border border-drix-border border-b-0 rounded-t-xl z-50 flex flex-col shadow-2xl shadow-black/50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-drix-border bg-gradient-to-r from-drix-accent/10 to-drix-purple/5 rounded-t-xl">
            <span className="text-sm font-extrabold text-drix-accent">AI Sales Coach</span>
            <button onClick={() => setCoachOpen(false)} className="text-drix-dim hover:text-drix-text">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-[200px] max-h-[calc(70vh-120px)]">
            {coachMsgs.map((msg, i) => (
              <div
                key={i}
                className={`max-w-[88%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'self-end bg-drix-accent text-white rounded-br-sm'
                    : msg.role === 'system'
                      ? 'self-center text-drix-dim italic text-[11px]'
                      : 'self-start bg-drix-surface2 text-drix-text border border-drix-border rounded-bl-sm'
                }`}
              >
                {msg.text}
              </div>
            ))}
            {coachTyping && (
              <div className="self-start text-drix-dim italic text-[11px] px-3">Coach is thinking...</div>
            )}
            <div ref={coachEndRef} />
          </div>
          <div className="flex gap-2 p-3 border-t border-drix-border">
            <textarea
              value={coachInput}
              onChange={(e) => setCoachInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendCoachMsg()
                }
              }}
              placeholder="What should I lead with?"
              rows={1}
              className="flex-1 bg-drix-surface2 border border-drix-border rounded-lg px-3 py-2 text-xs text-drix-text resize-none outline-none focus:border-drix-accent transition-colors min-h-[36px] max-h-[80px]"
            />
            <button
              onClick={sendCoachMsg}
              disabled={!coachInput.trim() || coachTyping}
              className="bg-drix-accent text-white rounded-lg px-4 text-xs font-bold hover:bg-drix-accent/90 transition-colors disabled:opacity-40"
            >
              <Send size={14} />
            </button>
          </div>
        </motion.div>
      )}

      {/* ─── VOICE COACH MODAL ─── */}
      {voiceOpen && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setVoiceOpen(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass rounded-2xl p-8 max-w-lg w-full text-center relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setVoiceOpen(false)} className="absolute top-4 right-4 text-drix-dim hover:text-drix-text text-xl">
              <X size={20} />
            </button>
            <div className="text-lg font-black text-drix-accent mb-2">Voice Coach</div>
            <div className="text-xs text-drix-dim mb-6 leading-relaxed">
              Talk to your AI sales coach by voice. It knows everything from this intelligence run.
            </div>
            <div id="voice-widget-area" />
            <div className="text-xs text-drix-dim mt-4">{voiceStatus}</div>
          </motion.div>
        </div>
      )}

      {/* Footer */}
      <footer className="mt-16 text-center">
        <div className="text-[10px] text-drix-border tracking-[2px] uppercase">
          DRiX · Data Reimagined Experience · by WinTech Partners
        </div>
      </footer>
    </div>
  )
}

// Window extensions
declare global {
  interface Window {
    toggleStrat?: (id: string) => void
    toggleCustomStrat?: () => void
    saveCustomStrat?: () => void
    onProceed?: () => void
    onAdvisorStorm?: () => void
    _stormCallback?: (() => void) | undefined
    __retryStrategies?: () => void
    __runFlowFresh?: () => void
  }
}
