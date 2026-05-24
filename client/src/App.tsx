import { Routes, Route, useLocation } from 'react-router'
import { AnimatePresence, motion } from 'framer-motion'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import HowItWorks from './pages/HowItWorks'
import DrixApp from './pages/DrixApp'
import MentorMatch from './pages/MentorMatch'

function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  )
}

export default function App() {
  const location = useLocation()

  return (
    <div className="min-h-screen bg-drix-bg text-drix-text">
      <Navbar />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<PageWrapper><Landing /></PageWrapper>} />
          <Route path="/how-it-works" element={<PageWrapper><HowItWorks /></PageWrapper>} />
          <Route path="/app" element={<PageWrapper><DrixApp /></PageWrapper>} />
          <Route path="/mentor-match" element={<PageWrapper><MentorMatch /></PageWrapper>} />
        </Routes>
      </AnimatePresence>
    </div>
  )
}
