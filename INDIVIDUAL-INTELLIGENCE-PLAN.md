# DRiX Individual Intelligence — Detailed Plan

## Vision

The individual intelligence module exists to answer one question: **"Who is this person, really — and how do I reach them?"**

Not surface-level firmographic data. Not a LinkedIn summary reworded. Deep psychographic intelligence that tells a sales rep what this person cares about, how they think, what scares them, what they've publicly committed to, and exactly how to frame a conversation so it lands.

The end state: a rep walks into a meeting knowing more about the buyer than the buyer's own colleagues do — their decision style, their career trajectory, their public positions, their likely objections, and the precise language that will resonate.

---

## Current Pipeline (What We Have Today)

### Stage 1: Apollo Person Enrichment
- Input: LinkedIn URL or email
- Output: Structured employment history, education, skills, phone, email, photo, current company, title
- Strength: Fast, structured, reliable for basic identity resolution
- Weakness: Only works when Apollo has the person in their database. Thin on senior executives at smaller companies. No behavioral or psychographic data.

### Stage 2: Apollo Company Enrichment
- Input: Company domain (from the person's current employer)
- Output: Company size, revenue, industry, sub-industry, founding year, technologies used, keywords
- Strength: Good baseline firmographics
- Weakness: Static. Doesn't tell you what the company is *doing right now* — only what it *is*.

### Stage 3: Deep Individual Web Research (Brave Search)
- Phase 1 — Discovery (6 parallel searches):
  - Pure name search
  - Name + company
  - Name + domain (site:domain)
  - Profile pages (LinkedIn, Twitter, GitHub, Medium, etc.)
  - Appointments, certifications, board memberships
  - Publications, patents, speaking
- Phase 2 — Deep Dive (7 parallel searches):
  - Podcasts and interviews
  - Conference talks and videos
  - News mentions
  - PR and press releases
  - Published content (blogs, articles, whitepapers)
  - Awards and recognition
  - Volunteer work and board seats

### Stage 4: Deep Company Research (Brave Search)
- Company's own website (site:domain searches)
- Investor relations pages
- SEC filings (10-K, 10-Q, 8-K)
- Press releases (last 6 months)
- News coverage
- Earnings and financials
- Leadership changes
- Partnerships and acquisitions
- Product launches
- Hiring signals (what roles they're filling tells you their priorities)

### Stage 5: LLM Psychographic Analysis
- Input: Full enrichment package (Apollo structured data + all web research + uploaded documents)
- Model: Claude via OpenRouter (32k token output, 3-minute timeout)
- Output:
  - **Psychographic archetype** (grower, defender, optimizer, pioneer, builder)
  - **Decision style** (analytical, intuitive, consensus, directive)
  - **Company situation** (growth phase, challenges, strategic direction)
  - **Unlimited atoms** (tagged facts, signals, insights — no artificial cap)
  - **Career highlights** (what they're proud of)
  - **Public signals** (what they've said publicly that reveals priorities)
  - **Conversation starters** (non-obvious entry points)
  - **Pitch angles** (multiple approaches ranked by likely resonance)
  - **Phrases to use / avoid** (language calibration)
  - **Likely objections** (with pre-framed responses)
  - **Rapport hooks** (personal interests, shared connections, common ground)
  - **Pain signals** (what's keeping them up at night)

### Stage 6: Source Labeling
- Every insight tagged with origin: `api_enrichment`, `web_research`, `model_knowledge`, or `uploaded_doc`
- Rep knows what's verified fact vs. inferred intelligence

---

## Current Gaps and Weaknesses

1. **LinkedIn dependency via Apollo** — If Apollo can't match the person, we get nothing from Stage 1. Many decision-makers at mid-market companies aren't in Apollo's database, or their data is stale.

2. **Search quality ceiling** — Brave Search is good but it's one engine. People who aren't publicly vocal produce thin results. No way to go deeper when initial searches come back empty.

3. **No real-time social signals** — We don't check what they've posted on LinkedIn/Twitter in the last 30 days. Recent activity is gold for rapport hooks and timing.

4. **Company intelligence is scrape-dependent** — If the company's IR page is JavaScript-rendered, we get nothing. SEC filing search works but we don't actually parse the filing content.

5. **No email/calendar context** — The rep probably already has emails, meeting notes, or CRM data about this person. We don't use any of it unless they manually upload it.

6. **No video/audio analysis** — We find podcast links and conference talk URLs but can't process what was actually said in them.

7. **No competitive context** — We don't know what other vendors are selling to this person or what technology decisions they've recently made.

8. **Single-shot analysis** — The LLM runs once. No iterative refinement, no "this was thin, go dig deeper on X."

9. **No semantic memory** — Each research session starts from scratch. No ability to say "we researched someone similar last month — what patterns apply here?"

---

## Enhancement Plan: API-Powered Intelligence Layers

### Tier 1: Immediate High-Impact (Use What You Have)

#### ProxyCurl — Full LinkedIn Intelligence
**What it adds:** Direct LinkedIn profile scraping. Full profile data, posts, comments, articles, recommendations, skills endorsements, volunteer work, certifications — everything on their LinkedIn page, structured as JSON.

**Why it matters:** This is the single biggest gap-closer. Apollo gives you the *summary*. ProxyCurl gives you the *full story*. Recent posts reveal current priorities. Recommendations reveal reputation. Activity patterns reveal engagement style. Endorsement patterns reveal what peers think they're good at.

**Implementation:**
- Call ProxyCurl with the LinkedIn URL before Apollo (it's more comprehensive)
- Extract recent posts (last 30-90 days) — these are gold for timing and rapport
- Parse recommendations for reputation signals
- Extract activity feed for engagement patterns
- Fall back to Apollo if ProxyCurl fails or has rate limits

#### Firecrawl — Intelligent Web Scraping
**What it adds:** AI-powered web scraping that handles JavaScript-rendered pages, extracts structured data, and crawls linked pages.

**Why it matters:** Our current `fetchAndStrip()` can't handle modern SPAs. Company IR pages, press rooms, and team bios are often React/Next.js rendered. Firecrawl gets the actual content.

**Implementation:**
- Replace raw fetch with Firecrawl for company website crawling
- Crawl the company's /about, /team, /leadership, /press, /investors pages
- Extract the person's bio from their company page (often has info not on LinkedIn)
- Parse press releases and blog posts that mention them
- Get the actual content of SEC filings instead of just finding the links

#### Jina — Clean Text Extraction from Any URL
**What it adds:** Reader API that converts any URL into clean, LLM-ready text. Handles JavaScript rendering, removes boilerplate, extracts the article/content body.

**Why it matters:** When we find a podcast appearance, news article, or blog post about the person, we currently just store the title and URL. Jina lets us extract the actual content so the LLM can read what was actually said.

**Implementation:**
- After Stage 3 finds web results, run the top 10-20 most relevant URLs through Jina
- Extract actual article text, interview quotes, presentation content
- Feed these full texts into the enrichment package
- Especially valuable for: podcast show notes, conference talk descriptions, blog posts they wrote

#### SerpAPI + Serper (Dual Search)
**What it adds:** Additional search engines (Google via SerpAPI, Serper for SERP data). Different results than Brave. Google-specific features like Knowledge Graph, People Also Ask.

**Why it matters:** Brave misses things Google finds, and vice versa. Running both and deduplicating gives 40-60% more coverage. Google's Knowledge Graph sometimes has structured data about executives that Brave doesn't surface.

**Implementation:**
- Run critical searches (name + company, recent news) through both Brave AND Google
- Deduplicate by URL
- Use SerpAPI's structured data (Knowledge Graph panels, featured snippets) as high-confidence signals
- Serper for "People Also Ask" related to the person/company — reveals common questions about them

#### Google YouTube API
**What it adds:** Search for videos featuring the person. Conference talks, interviews, webinars, panel discussions.

**Why it matters:** When someone speaks at a conference, they reveal their actual priorities, communication style, and what they want to be known for — unfiltered by PR. A 30-minute keynote tells you more than 100 LinkedIn posts.

**Implementation:**
- Search YouTube for "{name} {company}" + "{name} keynote|panel|interview"
- Extract video titles, descriptions, and durations
- For top results: grab auto-generated transcripts (YouTube API provides captions)
- Feed transcript excerpts into the enrichment package as first-person quotes

---

### Tier 2: Deeper Intelligence (High Value, More Integration Work)

#### Pinecone or Qdrant — Semantic Memory / Flywheel Cache
**What it adds:** Vector database for storing and retrieving intelligence by semantic similarity. The "Layer 2" cache we discussed — system-wide entity knowledge that compounds over time.

**Why it matters:** Right now, if 5 different reps research 5 different VPs of IT at mid-market banks, each starts from scratch. With a vector DB, we store every insight and can semantically query: "What do we know about people in similar roles at similar companies?" Patterns emerge. The system gets smarter with every run.

**Implementation:**
- After every successful individual scan, embed the atoms and store in Pinecone/Qdrant
- On new scans, first query: "What do we already know about this person?" (exact match)
- Then query: "What do we know about similar people?" (semantic similarity)
- Feed relevant matches into the LLM as "patterns observed in similar buyers"
- This is the flywheel — each research session makes future sessions smarter

#### Nylas — Rep's Own Email/Calendar Context
**What it adds:** Access to the rep's email and calendar. Prior conversations with this prospect, meeting history, email threads, attachments exchanged.

**Why it matters:** The rep has already interacted with this person (or their company). Emails contain objections raised, questions asked, interest signals, timeline indicators. This is private intelligence that no API can provide — it's *their* relationship data.

**Implementation:**
- Optional integration — rep connects their email account
- Search for all threads involving the prospect's email or company domain
- Extract key signals: topics discussed, objections raised, commitments made, timeline mentions
- Feed summary into enrichment package as "prior relationship context"
- Calendar: show past meetings and upcoming meetings with this account

#### GitHub — Technical Buyer Intelligence
**What it adds:** Public repos, contributions, starred projects, organizations, README content.

**Why it matters:** For technical buyers (CTO, VP Engineering, CISO), their GitHub activity reveals: what technologies they're evaluating (stars), what they've built (repos), what they contribute to (open source philosophy), what languages/frameworks they prefer. A CISO who stars security automation repos has different priorities than one starring compliance frameworks.

**Implementation:**
- If the person has a GitHub profile (often linked from LinkedIn or findable by name)
- Pull: starred repos (last 50), organizations, pinned repos, recent contribution activity
- Analyze: technology preferences, open source philosophy, areas of active interest
- Feed into enrichment package under "technical interests and signals"

#### Moz — Company Digital Authority
**What it adds:** Domain authority, page authority, spam score, linking domains, top pages.

**Why it matters:** Tells you how seriously the company invests in their digital presence. A company with DA 80 and thousands of backlinks is established and probably has sophisticated marketing. DA 25 with few links means they're either early-stage or have neglected digital. This contextualizes budget conversations and technology maturity.

**Implementation:**
- Pull domain metrics for the target company
- Include in company intelligence section
- Use as a signal for: company maturity, marketing sophistication, competitive positioning

#### IBM Natural Language Understanding — Sentiment & Entity Extraction
**What it adds:** Professional NLU for sentiment analysis, entity extraction, keyword extraction, concept tagging on text content.

**Why it matters:** When we find articles, press releases, or posts by/about the person, NLU can extract sentiment, key themes, and concepts at scale — faster and cheaper than running everything through a large LLM. Pre-processes text before the psychographic LLM pass.

**Implementation:**
- Run all extracted web content through IBM NLU before the LLM stage
- Extract: entities mentioned, sentiment per entity, keywords, categories
- Feed structured NLU output into enrichment package (cleaner signal for the LLM)
- Use sentiment analysis on press coverage to gauge company reputation and trajectory

---

### Tier 3: Advanced / Experimental

#### Eleven Labs — Voice Intelligence
**What it adds:** Speech-to-text + voice analysis on audio content.

**Why it matters:** If we find podcast episodes or conference talks (audio), we can transcribe them AND analyze communication patterns — speaking pace, formality level, energy. These map to personality traits and preferred communication styles.

**Implementation:**
- When YouTube/podcast search finds audio content, download and process
- Transcribe for content (what they said)
- Analyze voice patterns for communication style (how they say it)
- Inform the "phrases to use / avoid" and "communication preferences" sections

#### Zep — Conversation Memory
**What it adds:** Long-term conversation memory with semantic search. Purpose-built for maintaining context across sessions.

**Why it matters:** If a rep uses the system multiple times for the same prospect (which they will — before a first call, before a follow-up, before a proposal), Zep can maintain continuity. "Last time you researched this person, the key finding was X. Since then, they've posted about Y."

**Implementation:**
- Store each research session's key findings in Zep
- On repeat visits, surface: what's changed, what's new, what was the previous strategy
- Enable "What happened since I last looked?" differential intelligence

#### Multiple LLM Models — Cross-Validation
**What it adds:** Run the psychographic analysis through 2-3 different models (Claude + GPT-4 + Gemini) and compare.

**Why it matters:** Different models have different knowledge bases and analytical strengths. Where they agree, you have high confidence. Where they disagree, you have interesting uncertainty worth flagging.

**Available models from your list:**
- Anthropic Claude (via OpenRouter — current)
- OpenAI GPT-4 (Personal or Service Account)
- Google Gemini
- Deepseek
- Grok (xAI)
- Mistral

**Implementation:**
- Run the psychographic prompt through 2 models in parallel
- Compare outputs: flag agreements (high confidence) and disagreements (investigate)
- Use the strongest model (Claude) as primary, second model as validator
- Surface disagreements to the rep: "Our analysis suggests X, but an alternative read is Y"

---

## The Full Vision: End-to-End Intelligence Flow

```
USER INPUT                    ENRICHMENT LAYER              ANALYSIS LAYER              OUTPUT
─────────────                 ─────────────────              ──────────────              ──────
LinkedIn URL ──────────┐
                       │
Email ─────────────────┤     ┌─ ProxyCurl (full LinkedIn)
                       │     ├─ Apollo (structured data)
Company URL ───────────┤     ├─ Brave + Google (web)
                       ├────►├─ Firecrawl (company sites)    ┌─ IBM NLU (pre-process)     ┌─ Psychographic profile
Uploaded docs ─────────┤     ├─ YouTube (talks/interviews)   ├─ Claude (primary)          ├─ Unlimited atoms
                       │     ├─ Jina (article extraction)    ├─ GPT-4 (validator)         ├─ Pitch angles
Rep's email history ───┤     ├─ GitHub (technical signals)   └─ Vector DB (patterns)      ├─ Objection handling
(Nylas)                │     ├─ Moz (domain authority)                                    ├─ Rapport hooks
                       │     └─ SEC/EDGAR (filings)                                       ├─ Pain signals
Prior research ────────┘                                                                  ├─ Conversation starters
(Pinecone/Qdrant)            ┌─ Pinecone (semantic memory)                                └─ Confidence scores
                             └─ Zep (session continuity)                                     per insight
```

---

## Implementation Priority

### Phase 1: Now (validate core pipeline)
- Deploy current code (Apollo + Brave + LLM + doc uploads)
- Retest Shane Harkins to validate quality
- Fix any gaps that surface

### Phase 2: Quick Wins (1-2 days each)
1. **ProxyCurl** — biggest single improvement for person intelligence
2. **Jina** — actually read the articles we find instead of just listing URLs
3. **Serper/SerpAPI** — dual-search for better coverage
4. **Firecrawl** — fix company page scraping (JS-rendered sites)

### Phase 3: Deep Intelligence (1 week)
5. **YouTube API** — find and transcribe their talks
6. **Pinecone/Qdrant** — build the flywheel cache
7. **GitHub** — technical buyer signals
8. **Moz** — company digital maturity

### Phase 4: Relationship Intelligence (2 weeks)
9. **Nylas** — rep's own email history with the prospect
10. **Multi-model validation** — cross-check psychographic assessments
11. **Zep** — session memory and differential intelligence

### Phase 5: Integration with PitchSimAI
12. Feed completed individual intelligence into PitchSimAI
13. Simulate the buying committee using real psychographic profiles
14. Validate pitch strategy against simulated buyer reactions

---

## Success Metrics

- **Coverage:** % of searches that return 20+ meaningful web results (target: 80%+)
- **Atom count:** Average atoms per individual scan (target: 50+ with no filler)
- **Source diversity:** Average number of distinct sources per profile (target: 15+)
- **Freshness:** % of insights less than 6 months old (target: 60%+)
- **Actionability:** Every atom should suggest a behavior (something to say, avoid, reference, or leverage)
- **Accuracy:** Spot-check 10% of profiles against manual LinkedIn/web review
- **Rep satisfaction:** "Did this tell you something you didn't already know?" (target: 90% yes)
