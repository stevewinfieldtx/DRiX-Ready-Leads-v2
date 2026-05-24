import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { Menu, X, Zap } from 'lucide-react'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [location])

  const isActive = (path: string) => location.pathname === path

  const navLinks = [
    { path: '/', label: 'Home' },
    { path: '/how-it-works', label: 'How It Works' },
    { path: '/mentor-match', label: 'Mentor Match' },
    { path: '/app', label: 'Launch App' },
  ]

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'glass shadow-lg shadow-black/20'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center h-16 relative">
          {/* Brand — fixed width so center nav is truly centered */}
          <Link to="/" className="flex items-center gap-3 group flex-shrink-0">
            <img src="/DRiX-Logo.jpg" alt="DRiX" className="h-11 w-auto" />
          </Link>

          {/* Desktop Nav — absolutely centered */}
          <div className="hidden md:flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                className={`px-4 py-2 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all duration-200 ${
                  isActive(link.path)
                    ? 'text-drix-accent bg-drix-accent/10'
                    : 'text-drix-dim hover:text-drix-text hover:bg-white/5'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Launch Button — pushed to the right */}
          <div className="hidden md:block ml-auto">
            <Link
              to="/app"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-bold hover:shadow-glow transition-all duration-300 hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
            >
              <Zap size={14} />
              Launch App
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 rounded-lg text-drix-dim hover:text-drix-text hover:bg-white/5 transition-colors"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden glass border-t border-drix-border/50">
          <div className="px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                className={`block px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${
                  isActive(link.path)
                    ? 'text-drix-accent bg-drix-accent/10'
                    : 'text-drix-dim hover:text-drix-text hover:bg-white/5'
                }`}
              >
                {link.label}
              </Link>
            ))}
            <Link
              to="/app"
              className="block mt-2 px-4 py-3 rounded-lg text-sm font-bold text-center"
              style={{ background: 'linear-gradient(to right, #5aa9ff, #b583ff)', color: '#0a0e13' }}
            >
              <span className="inline-flex items-center gap-2">
                <Zap size={14} />
                Launch App
              </span>
            </Link>
          </div>
        </div>
      )}
    </nav>
  )
}
