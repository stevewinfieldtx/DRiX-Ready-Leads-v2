# Related Projects — Potential Integration

## PitchSimAI
**Location:** `C:\Users\SteveWinfiel_12vs805\Documents\PitchSimAI`
**Stack:** Python backend (FastAPI + Alembic), React/Vite frontend
**What it does:** AI-powered pitch simulation and practice tool
- Persona library (seed/personas.json) — pre-built buyer personas
- Agent chat — conversational role-play against simulated buyers
- Committee generator — simulates a buying committee (multiple stakeholders)
- LinkedIn enrichment service (backend/services/linkedin_enrichment.py)

**What it is NOT:** It's not pitch delivery practice (practicing saying the words). It's pitch VALIDATION — you feed it your pitch/strategy and it simulates whether it would actually land with a particular buying committee.

**Integration opportunity:** DRiX generates intelligence + strategy. PitchSimAI stress-tests that strategy against AI-simulated versions of the actual buyer team BEFORE you walk in. The flow: DRiX builds the psychographic profiles and pitch angles → PitchSimAI ingests those profiles to model the committee → tells you where your pitch would fail, what objections you'd hit, which angles would resonate vs. fall flat.

**Overlap to consolidate:** LinkedIn enrichment exists in both projects. Should converge on one pipeline.

---

## BrainTrustBrief
**Location:** `C:\Users\SteveWinfiel_12vs805\Documents\BrainTrustBrief`
**Stack:** React/Vite frontend (has node_modules with d3, recharts/victory dependencies — likely data visualization)
**What it does:** Briefing / intelligence presentation tool (details TBD — need to read source)

**Integration opportunity:** Could serve as the delivery layer for DRiX intelligence — formatted briefs, visual dashboards, data presentation.

---

## Job Hunting App (Pitch Practice Module)
**Location:** TBD
**What it does:** AI-powered pitch/interview PRACTICE for job seekers — actually rehearsing delivery

**Key difference from PitchSimAI:** This IS practice (delivery/rehearsal). PitchSimAI is validation (will this strategy work against this committee). Different problems, potentially shared infrastructure for the LLM conversation layer but different UX and feedback loops.

---

## TargetedDecomposition (TDE)
**Location:** `C:\Users\SteveWinfiel_12vs805\Documents\TargetedDecomposition`
**Stack:** Node.js/Express, deployed on Railway
**What it does:** The central data storage and intelligence engine. ALL data flows through here.

**Already has:**
- Ingestors for: audio, docx, pdf, pptx, text, web, youtube
- Qdrant vector database integration (semantic memory — the flywheel cache!)
- Intel cache routes (API for cached intelligence)
- Solution research module
- LLM utilities
- Tagger (9D atom tagging)
- Munger (data processing/transformation)
- Analyzers (analytical passes over ingested data)
- Research routes (API endpoints for research operations)
- Recover-from-Qdrant script (data resilience)

**Relationship to DRiX:** TDE is the backend brain. DRiX already calls it for cache lookups (`ingestFromTdeCache`) and warm-up (`warmTdeCacheAsync`). The document upload feature we just added to DRiX (multer + pdf-parse + mammoth) is technically redundant — TDE already has mature ingestors. Should route doc uploads through TDE instead of processing locally.

**Key insight:** The Qdrant integration means the semantic flywheel cache (Tier 2 in the intelligence plan) already has infrastructure. We don't need to build it — we need to USE it for individual intelligence.

---

## Priority Order
1. Validate DRiX core pipeline works (Shane Harkins retest)
2. Deploy doc upload feature
3. Route doc processing through TDE's existing ingestors instead of DRiX's local extraction
4. Leverage TDE's Qdrant for the individual intelligence flywheel cache
5. Then explore PitchSimAI integration — validate strategy against simulated buyers
