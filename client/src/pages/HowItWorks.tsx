import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { motion, useInView, AnimatePresence } from 'framer-motion'
import {
  ArrowRight, Sparkles, Zap, Layers, Brain, Target,
  MessageSquare, BarChart3, Users, ArrowLeft,
  Check, XIcon, Grid3x3, Mail, RefreshCw
} from 'lucide-react'

function FadeIn({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-60px' })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {children}
    </motion.div>
  )
}

export default function HowItWorks() {
  const [view, setView] = useState<'hub' | 'comparison' | 'atoms'>('hub')

  // ─── DRiX vs Normal AI comparison data ───────────────────────────────────
  const comparisons = [
    {
      normal: 'Generic research that gives you the same info everyone has',
      drix: '9-dimensional atom decomposition that finds what others miss',
      icon: <Grid3x3 size={16} />,
    },
    {
      normal: 'One-size-fits-all outreach that sounds like a template',
      drix: 'Every email and question is built from your specific deal atoms',
      icon: <Mail size={16} />,
    },
    {
      normal: 'Manual research across LinkedIn, news, websites — hours of work',
      drix: 'Parallel ingestion of sender, solution, and customer in seconds',
      icon: <Zap size={16} />,
    },
    {
      normal: 'Single persona targeting — one door to knock on',
      drix: 'Dual-persona pain mapping — two stakeholders for every pain point',
      icon: <Users size={16} />,
    },
    {
      normal: 'Static playbook — the same strategy every time',
      drix: 'Five unique strategies anchored on different persona x pain pairs',
      icon: <Brain size={16} />,
    },
    {
      normal: 'Generic discovery questions that show you did no homework',
      drix: 'Branching questions with positive/negative response paths mapped',
      icon: <MessageSquare size={16} />,
    },
    {
      normal: 'No follow-up system — you figure out the next move',
      drix: 'Multi-step email drip campaign generated automatically',
      icon: <Target size={16} />,
    },
    {
      normal: 'Static PDF reports that go nowhere',
      drix: 'Live ClearSignals thread analysis + AI Sales Coach on every deal',
      icon: <BarChart3 size={16} />,
    },
  ]

  // ─── Atomization explanation ────────────────────────────────────────────
  const atomTypes = [
    { label: 'Mission', color: 'bg-drix-accent', desc: 'What drives the company' },
    { label: 'Product', color: 'bg-drix-green', desc: 'What they actually sell' },
    { label: 'ICP', color: 'bg-drix-cyan', desc: 'Who they target' },
    { label: 'Proof Point', color: 'bg-drix-green', desc: 'Evidence that works' },
    { label: 'Team', color: 'bg-drix-purple', desc: 'Key players' },
    { label: 'Stack Signal', color: 'bg-drix-orange', desc: 'Tech they use' },
    { label: 'Buying Trigger', color: 'bg-drix-yellow', desc: 'What makes them buy' },
    { label: 'Differentiator', color: 'bg-drix-accent', desc: 'What sets them apart' },
    { label: 'Partnership', color: 'bg-drix-cyan', desc: 'Who they work with' },
    { label: 'Contact', color: 'bg-drix-orange', desc: 'How to reach them' },
    { label: 'Weakness', color: 'bg-drix-red', desc: 'Where they hurt' },
    { label: 'Mission Gap', color: 'bg-drix-pink', desc: 'What they are missing' },
  ]

  const dimensions = [
    { label: 'Persona', color: 'border-drix-accent' },
    { label: 'Stage', color: 'border-drix-cyan' },
    { label: 'Emotion', color: 'border-drix-pink' },
    { label: 'Evidence', color: 'border-drix-orange' },
    { label: 'Credibility', color: 'border-drix-green' },
    { label: 'Recency', color: 'border-drix-yellow' },
    { label: 'Economic', color: 'border-drix-green' },
    { label: 'Inertia', color: 'border-drix-red' },
    { label: 'Industry', color: 'border-drix-purple' },
  ]

  return (
    <div className="pt-24 pb-16">
      <AnimatePresence mode="wait">
        {/* ═══════════════════════════════════════════
            HUB VIEW — Two buttons
            ═══════════════════════════════════════════ */}
        {view === 'hub' && (
          <motion.div
            key="hub"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Hero */}
            <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-20 text-center">
              <FadeIn>
                <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-drix-accent/10 border border-drix-accent/20 text-xs font-semibold tracking-widest uppercase text-drix-accent mb-6">
                  <Sparkles size={14} />
                  How It Works
                </span>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-drix-text mb-6 tracking-tight">
                  Two ways to <span className="gradient-text">understand DRiX</span>
                </h1>
                <p className="text-lg text-drix-dim max-w-xl mx-auto leading-relaxed">
                  Pick the path that matters to you. See how we compare, or dive into how the technology works.
                </p>
              </FadeIn>
            </section>

            {/* Two Cards */}
            <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 mb-24">
              <div className="grid sm:grid-cols-2 gap-5">
                {/* DRiX vs Normal AI */}
                <FadeIn delay={0.1}>
                  <button
                    onClick={() => setView('comparison')}
                    className="group w-full glass rounded-2xl p-8 text-left border border-drix-border hover:border-drix-accent/40 transition-all duration-300 hover:-translate-y-1 hover:shadow-glow"
                  >
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-drix-accent to-drix-purple flex items-center justify-center mb-6 shadow-lg group-hover:shadow-glow transition-shadow">
                      <BarChart3 size={28} className="text-drix-bg" />
                    </div>
                    <h3 className="text-xl font-black text-drix-text mb-2">DRiX vs Normal AI</h3>
                    <p className="text-sm text-drix-dim leading-relaxed mb-6">
                      See how DRiX stacks up against the way you're probably using AI today. Spoiler: it's not even close.
                    </p>
                    <span className="inline-flex items-center gap-2 text-xs font-bold text-drix-accent group-hover:gap-3 transition-all">
                      See the comparison <ArrowRight size={14} />
                    </span>
                  </button>
                </FadeIn>

                {/* Understanding Atomization */}
                <FadeIn delay={0.2}>
                  <button
                    onClick={() => setView('atoms')}
                    className="group w-full glass rounded-2xl p-8 text-left border border-drix-border hover:border-drix-green/40 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_40px_rgba(61,220,132,0.15)]"
                  >
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-drix-green to-drix-cyan flex items-center justify-center mb-6 shadow-lg group-hover:shadow-[0_0_20px_rgba(61,220,132,0.3)] transition-shadow">
                      <Layers size={28} className="text-drix-bg" />
                    </div>
                    <h3 className="text-xl font-black text-drix-text mb-2">Understanding Atomization</h3>
                    <p className="text-sm text-drix-dim leading-relaxed mb-6">
                      The secret sauce. How we break everything down into intelligence atoms and tag them across nine dimensions.
                    </p>
                    <span className="inline-flex items-center gap-2 text-xs font-bold text-drix-green group-hover:gap-3 transition-all">
                      See how it works <ArrowRight size={14} />
                    </span>
                  </button>
                </FadeIn>
              </div>
            </section>

            {/* CTA */}
            <section className="max-w-lg mx-auto px-4 text-center mb-16">
              <FadeIn>
                <Link
                  to="/app"
                  className="dx-btn-primary inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all hover:-translate-y-0.5"
                >
                  Ready? Launch DRiX <ArrowRight size={16} />
                </Link>
              </FadeIn>
            </section>
          </motion.div>
        )}

        {/* ═══════════════════════════════════════════
            COMPARISON VIEW — DRiX vs Normal AI
            ═══════════════════════════════════════════ */}
        {view === 'comparison' && (
          <motion.div
            key="comparison"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.4 }}
          >
            {/* Header */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mb-16">
              <button
                onClick={() => setView('hub')}
                className="inline-flex items-center gap-2 text-xs font-bold text-drix-dim hover:text-drix-text transition-colors mb-6"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <FadeIn>
                <h1 className="text-4xl sm:text-5xl font-black text-drix-text mb-4 tracking-tight">
                  DRiX vs <span className="text-drix-muted">Normal AI</span>
                </h1>
                <p className="text-lg text-drix-dim max-w-xl leading-relaxed">
                  Most AI sales tools give you a paragraph and call it research. Here's what actually happens when you go deeper.
                </p>
              </FadeIn>
            </section>

            {/* Comparison Table */}
            <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-24">
              <div className="glass rounded-2xl border border-drix-border overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-4 bg-drix-surface2 border-b border-drix-border text-[10px] font-extrabold tracking-widest uppercase text-drix-muted">
                  <span></span>
                  <span className="text-center w-28 sm:w-36">Normal AI</span>
                  <span className="text-center w-28 sm:w-36 text-drix-accent">DRiX</span>
                </div>

                {comparisons.map((row, i) => (
                  <FadeIn key={i} delay={i * 0.06}>
                    <div className={`grid grid-cols-[1fr_auto_auto] gap-4 px-6 py-5 items-center ${i < comparisons.length - 1 ? 'border-b border-drix-border/40' : ''} hover:bg-drix-surface2/50 transition-colors`}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-drix-surface2 flex items-center justify-center text-drix-accent flex-shrink-0">
                          {row.icon}
                        </div>
                      </div>
                      <div className="w-28 sm:w-36 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-drix-red/10 text-drix-red">
                          <XIcon size={12} />
                        </span>
                        <p className="text-[11px] text-drix-muted mt-2 leading-snug">{row.normal}</p>
                      </div>
                      <div className="w-28 sm:w-36 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-drix-green/10 text-drix-green">
                          <Check size={12} />
                        </span>
                        <p className="text-[11px] text-drix-text mt-2 leading-snug font-medium">{row.drix}</p>
                      </div>
                    </div>
                  </FadeIn>
                ))}
              </div>
            </section>

            {/* Bottom CTA */}
            <section className="max-w-lg mx-auto px-4 text-center mb-16">
              <FadeIn>
                <Link
                  to="/app"
                  className="dx-btn-primary inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all hover:-translate-y-0.5"
                >
                  See It In Action <ArrowRight size={16} />
                </Link>
              </FadeIn>
            </section>
          </motion.div>
        )}

        {/* ═══════════════════════════════════════════
            ATOMIZATION VIEW — Understanding Atomization
            ═══════════════════════════════════════════ */}
        {view === 'atoms' && (
          <motion.div
            key="atoms"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.4 }}
          >
            {/* Header */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mb-16">
              <button
                onClick={() => setView('hub')}
                className="inline-flex items-center gap-2 text-xs font-bold text-drix-dim hover:text-drix-text transition-colors mb-6"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <FadeIn>
                <h1 className="text-4xl sm:text-5xl font-black text-drix-text mb-4 tracking-tight">
                  Understanding <span className="gradient-text">Atomization</span>
                </h1>
                <p className="text-lg text-drix-dim max-w-xl leading-relaxed">
                  We take everything — every URL, every page, every signal — and break it into the smallest meaningful bits of insight. Then we tag each one so we can rebuild them into exactly what you need.
                </p>
              </FadeIn>
            </section>

            {/* The 12 Atom Types */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
              <FadeIn>
                <div className="flex items-center gap-3 mb-8">
                  <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-green">12 Atom Types</span>
                  <div className="flex-1 h-px bg-drix-border/50" />
                </div>
              </FadeIn>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {atomTypes.map((atom, i) => (
                  <FadeIn key={i} delay={i * 0.04}>
                    <div className="glass rounded-xl p-5 border border-drix-border/50 hover:border-drix-accent/20 transition-all hover:-translate-y-0.5 group">
                      <div className="flex items-center gap-3 mb-3">
                        <div className={`w-3 h-3 rounded-full ${atom.color}`} />
                        <h3 className="text-sm font-bold text-drix-text">{atom.label}</h3>
                      </div>
                      <p className="text-xs text-drix-dim leading-relaxed">{atom.desc}</p>
                    </div>
                  </FadeIn>
                ))}
              </div>
            </section>

            {/* The 9 Dimensions */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
              <FadeIn>
                <div className="flex items-center gap-3 mb-8">
                  <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-purple">9 Tagging Dimensions</span>
                  <div className="flex-1 h-px bg-drix-border/50" />
                </div>
              </FadeIn>
              <FadeIn>
                <div className="glass rounded-2xl p-6 sm:p-8 border border-drix-border">
                  <p className="text-sm text-drix-dim mb-6 leading-relaxed">
                    Every atom is tagged across nine dimensions. This means when we need to reconstruct intelligence, we pull exactly the right atoms for the situation — not a generic dump of everything.
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-3">
                    {dimensions.map((dim, i) => (
                      <div key={i} className={`text-center p-3 rounded-lg bg-drix-surface border-l-2 ${dim.color}`}>
                        <div className="text-[10px] font-bold text-drix-text uppercase tracking-wide">{dim.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </FadeIn>
            </section>

            {/* Decomposition Visual */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
              <FadeIn>
                <div className="flex items-center gap-3 mb-8">
                  <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-accent">The Process</span>
                  <div className="flex-1 h-px bg-drix-border/50" />
                </div>
              </FadeIn>
              <FadeIn>
                <div className="grid sm:grid-cols-3 gap-6">
                  {/* Step 1: Ingest */}
                  <div className="glass rounded-2xl p-6 border border-drix-border text-center">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-drix-cyan to-drix-accent flex items-center justify-center mx-auto mb-4 shadow-lg">
                      <RefreshCw size={20} className="text-drix-bg" />
                    </div>
                    <div className="text-[10px] font-black tracking-[2px] uppercase text-drix-muted mb-2">Step 1</div>
                    <h3 className="text-base font-bold text-drix-text mb-2">Ingest</h3>
                    <p className="text-xs text-drix-dim leading-relaxed">
                      We pull in your company, your solution, and your prospect — all at once. URLs, LinkedIn profiles, industry data.
                    </p>
                  </div>
                  {/* Arrow */}
                  <div className="hidden sm:flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full bg-drix-surface2 border border-drix-border flex items-center justify-center">
                      <ArrowRight size={20} className="text-drix-accent" />
                    </div>
                  </div>
                  {/* Step 2: Decompose */}
                  <div className="glass rounded-2xl p-6 border border-drix-border text-center">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-drix-accent to-drix-purple flex items-center justify-center mx-auto mb-4 shadow-lg">
                      <Layers size={20} className="text-drix-bg" />
                    </div>
                    <div className="text-[10px] font-black tracking-[2px] uppercase text-drix-muted mb-2">Step 2</div>
                    <h3 className="text-base font-bold text-drix-text mb-2">Decompose</h3>
                    <p className="text-xs text-drix-dim leading-relaxed">
                      Everything is broken into intelligence atoms — tagged across 12 types and 9 dimensions. 50-150 atoms per source.
                    </p>
                  </div>
                  {/* Arrow */}
                  <div className="hidden sm:flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full bg-drix-surface2 border border-drix-border flex items-center justify-center">
                      <ArrowRight size={20} className="text-drix-green" />
                    </div>
                  </div>
                  {/* Step 3: Rebuild */}
                  <div className="glass rounded-2xl p-6 border border-drix-border text-center">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-drix-green to-drix-cyan flex items-center justify-center mx-auto mb-4 shadow-lg">
                      <Zap size={20} className="text-drix-bg" />
                    </div>
                    <div className="text-[10px] font-black tracking-[2px] uppercase text-drix-muted mb-2">Step 3</div>
                    <h3 className="text-base font-bold text-drix-text mb-2">Rebuild</h3>
                    <p className="text-xs text-drix-dim leading-relaxed">
                      Atoms are reconstructed into pain points, strategies, discovery questions, and outreach — exactly what you need to close.
                    </p>
                  </div>
                </div>
              </FadeIn>
            </section>

            {/* Bottom CTA */}
            <section className="max-w-lg mx-auto px-4 text-center mb-16">
              <FadeIn>
                <Link
                  to="/app"
                  className="dx-btn-green inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold hover:shadow-[0_0_40px_rgba(61,220,132,0.25)] transition-all hover:-translate-y-0.5"
                >
                  Try the Atomizer <ArrowRight size={16} />
                </Link>
              </FadeIn>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── FOOTER ─── */}
      <footer className="border-t border-drix-border/50 pt-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src="/logo.png" alt="DRiX" className="h-7 w-auto" />
            </div>
            <div className="text-xs text-drix-muted tracking-widest uppercase">
              by WinTech Partners
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
