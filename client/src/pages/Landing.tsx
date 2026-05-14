import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { motion, useInView, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, Sparkles, Target, Brain, Mail, TrendingUp, Shield, Layers } from 'lucide-react'
import ParticleCanvas from '../components/ParticleCanvas'

function FadeInSection({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {children}
    </motion.div>
  )
}

export default function Landing() {
  const heroRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const heroOpacity = useTransform(scrollYProgress, [0, 0.8], [1, 0])
  const heroScale = useTransform(scrollYProgress, [0, 0.8], [1, 0.95])
  const [count, setCount] = useState(0)

  useEffect(() => {
    const target = 47
    const duration = 2000
    const step = target / (duration / 16)
    let current = 0
    const timer = setInterval(() => {
      current += step
      if (current >= target) {
        setCount(target)
        clearInterval(timer)
      } else {
        setCount(Math.floor(current))
      }
    }, 16)
    return () => clearInterval(timer)
  }, [])

  const steps = [
    {
      icon: <Layers className="w-6 h-6" />,
      title: 'Gather Everything',
      desc: 'We take what you know about your prospect, plus what you don\'t. Every page, post, signal, and pattern.',
      color: 'from-drix-cyan to-drix-accent',
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: 'Break It Down',
      desc: 'We decompose it all into intelligence atoms — the smallest meaningful bits of insight about your buyer.',
      color: 'from-drix-accent to-drix-purple',
    },
    {
      icon: <Target className="w-6 h-6" />,
      title: 'Rebuild to Close',
      desc: 'Then we reconstruct those atoms into exactly what you need: the right message, for the right person, at the right time.',
      color: 'from-drix-purple to-drix-pink',
    },
  ]

  const features = [
    {
      icon: <Sparkles className="w-6 h-6" />,
      title: 'Deal Intelligence',
      desc: 'Every insight about your buyer, organized and ready when you need it.',
    },
    {
      icon: <Target className="w-6 h-6" />,
      title: 'Pain Mapping',
      desc: 'We find what keeps your prospect up at night, so you can speak directly to it.',
    },
    {
      icon: <Mail className="w-6 h-6" />,
      title: 'Ready-to-Send Outreach',
      desc: 'Emails, discovery questions, and follow-ups — written for your specific deal.',
    },
    {
      icon: <TrendingUp className="w-6 h-6" />,
      title: 'Close More, Faster',
      desc: 'Our process helps you close deals more often, faster, and more consistently.',
    },
    {
      icon: <Shield className="w-6 h-6" />,
      title: 'Thread Analysis',
      desc: 'Paste any email reply and get instant deal-health scoring plus next-step coaching.',
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: 'AI Sales Coach',
      desc: 'Ask anything about your deal. Get answers grounded in real intelligence, not generic advice.',
    },
  ]

  return (
    <div className="relative">
      {/* ─── HERO ─── */}
      <motion.section
        ref={heroRef}
        style={{ opacity: heroOpacity, scale: heroScale }}
        className="relative min-h-screen flex items-center justify-center overflow-hidden"
      >
        {/* Background image with overlay */}
        <div className="absolute inset-0 z-0">
          <img
            src="/hero-bg.jpg"
            alt=""
            className="w-full h-full object-cover opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-drix-bg/60 via-drix-bg/40 to-drix-bg" />
          <div className="absolute inset-0 bg-gradient-to-r from-drix-bg/50 via-transparent to-drix-bg/50" />
        </div>

        <ParticleCanvas />

        <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-24 pb-16">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-drix-accent/10 border border-drix-accent/20 mb-8"
          >
            <Sparkles size={14} className="text-drix-accent" />
            <span className="text-xs font-semibold tracking-widest uppercase text-drix-accent">
              Sales Intelligence...Reimagined
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15 }}
            className="text-5xl sm:text-6xl lg:text-7xl font-black tracking-tight leading-[1.05] mb-6"
          >
            <span className="gradient-text glow-text">Know Your Buyer.</span>
            <br />
            <span className="text-drix-text">Close the Deal.</span>
          </motion.h1>

          {/* Subheadline - THE CORE MESSAGE, SIMPLIFIED */}
          <motion.p
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="text-lg sm:text-xl text-drix-dim max-w-2xl mx-auto mb-6 leading-relaxed"
          >
            We take everything you know about your prospect — plus what you don't —
            break it into intelligence atoms, and rebuild it into exactly what you need
            to close deals faster and more often.
          </motion.p>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.45 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
          >
            <Link
              to="/app"
              className="group inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all duration-300 hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
            >
              Start Building Intelligence
              <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link
              to="/how-it-works"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-sm font-bold border border-drix-border text-drix-dim hover:text-drix-text hover:border-drix-accent/50 transition-all duration-300"
            >
              See How It Works
            </Link>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="grid grid-cols-3 gap-6 max-w-lg mx-auto"
          >
            <div className="text-center">
              <div className="text-3xl sm:text-4xl font-black gradient-text">{count}%</div>
              <div className="text-[10px] sm:text-xs text-drix-muted uppercase tracking-widest font-semibold mt-1">Faster Close</div>
            </div>
            <div className="text-center">
              <div className="text-3xl sm:text-4xl font-black gradient-text">Deep</div>
              <div className="text-[10px] sm:text-xs text-drix-muted uppercase tracking-widest font-semibold mt-1">Contextual Tagging</div>
            </div>
            <div className="text-center">
              <div className="text-3xl sm:text-4xl font-black gradient-text">5</div>
              <div className="text-[10px] sm:text-xs text-drix-muted uppercase tracking-widest font-semibold mt-1">Sales Strategies</div>
            </div>
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10"
        >
          <div className="w-6 h-10 rounded-full border-2 border-drix-border flex items-start justify-center p-2">
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-1 h-2 rounded-full bg-drix-accent"
            />
          </div>
        </motion.div>
      </motion.section>

      {/* ─── HOW IT WORKS SECTION ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="text-center mb-16">
              <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-accent mb-4 block">
                The Process
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-4">
                Three Steps to Smarter Selling
              </h2>
              <p className="text-drix-dim max-w-xl mx-auto">
                No fluff. No jargon. Just a process that gets you to "yes" faster.
              </p>
            </div>
          </FadeInSection>

          <div className="grid md:grid-cols-3 gap-6">
            {steps.map((step, i) => (
              <FadeInSection key={i} delay={i * 0.15}>
                <div className="group relative glass rounded-2xl p-8 hover:border-drix-accent/30 transition-all duration-500 hover:-translate-y-1">
                  <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${step.color} mb-6 shadow-lg`}>
                    <span className="text-drix-bg">{step.icon}</span>
                  </div>
                  <div className="text-xs font-bold text-drix-muted uppercase tracking-widest mb-3">
                    Step {i + 1}
                  </div>
                  <h3 className="text-xl font-bold text-drix-text mb-3">{step.title}</h3>
                  <p className="text-sm text-drix-dim leading-relaxed">{step.desc}</p>
                  {/* Connecting line */}
                  {i < 2 && (
                    <div className="hidden md:block absolute top-12 -right-3 w-6 h-px bg-gradient-to-r from-drix-border to-drix-accent/50" />
                  )}
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FEATURES GRID ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-drix-accent/[0.02] to-transparent" />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="text-center mb-16">
              <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-purple mb-4 block">
                What You Get
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-4">
                Everything You Need to Close
              </h2>
              <p className="text-drix-dim max-w-xl mx-auto">
                Intelligence that actually helps you sell. Not reports that sit in your inbox.
              </p>
            </div>
          </FadeInSection>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((feat, i) => (
              <FadeInSection key={i} delay={i * 0.08}>
                <div className="group glass rounded-xl p-6 hover:border-drix-accent/20 transition-all duration-300 hover:-translate-y-0.5 h-full">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-drix-accent/10 to-drix-purple/10 flex items-center justify-center mb-4 text-drix-accent group-hover:shadow-glow transition-shadow duration-300">
                    {feat.icon}
                  </div>
                  <h3 className="text-sm font-bold text-drix-text mb-2">{feat.title}</h3>
                  <p className="text-xs text-drix-dim leading-relaxed">{feat.desc}</p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      {/* ─── DECOMPOSITION VISUAL ─── */}
      <section className="relative py-24 sm:py-32 overflow-hidden">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <FadeInSection>
              <div>
                <span className="text-xs font-semibold tracking-[3px] uppercase text-drix-green mb-4 block">
                  The Secret Sauce
                </span>
                <h2 className="text-3xl sm:text-4xl font-black text-drix-text mb-6">
                  We Break It Down.<br />
                  <span className="gradient-text">So You Can Build It Up.</span>
                </h2>
                <p className="text-drix-dim leading-relaxed mb-6">
                  Every company, every buyer, every deal — we decompose it all into intelligence atoms.
                  The smallest, most meaningful bits of insight. Tagged across nine dimensions so
                  we can reconstruct them into exactly what you need, when you need it.
                </p>
                <p className="text-drix-dim leading-relaxed mb-8">
                  Think of it as LEGO blocks for sales intelligence. We break your prospect down
                  into pieces, then reassemble them into the perfect pitch, the perfect email,
                  the perfect discovery call.
                </p>
                <Link
                  to="/app"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold bg-drix-surface2 border border-drix-border text-drix-text hover:border-drix-accent/50 hover:bg-drix-surface3 transition-all duration-300"
                >
                  Try It Now
                  <ArrowRight size={14} />
                </Link>
              </div>
            </FadeInSection>

            <FadeInSection delay={0.2}>
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-r from-drix-accent/10 to-drix-purple/10 rounded-2xl blur-2xl" />
                <img
                  src="/decompose.jpg"
                  alt="Data decomposition visualization"
                  className="relative rounded-2xl border border-drix-border/50 shadow-2xl"
                />
              </div>
            </FadeInSection>
          </div>
        </div>
      </section>

      {/* ─── CTA SECTION ─── */}
      <section className="relative py-24 sm:py-32">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <FadeInSection>
            <div className="relative glass rounded-3xl p-10 sm:p-16 text-center overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-drix-accent/5 via-transparent to-drix-purple/5" />
              <div className="relative z-10">
                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-drix-text mb-6">
                  Ready to Close More Deals?
                </h2>
                <p className="text-drix-dim max-w-lg mx-auto mb-8 text-lg">
                  Stop guessing what your buyer wants to hear. Start knowing.
                  Build your first intelligence profile in under a minute.
                </p>
                <Link
                  to="/app"
                  className="inline-flex items-center gap-2 px-10 py-4 rounded-xl text-sm font-bold hover:shadow-glow-lg transition-all duration-300 hover:-translate-y-0.5"
                  style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
                >
                  Launch DRiX
                  <ArrowRight size={16} />
                </Link>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer className="border-t border-drix-border/50 py-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src="/DRiX-Logo.jpg" alt="DRiX" className="h-7 w-auto" />
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
