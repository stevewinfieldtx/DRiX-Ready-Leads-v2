# DRiX Ready Lead --- Pilot Deployment Plan

**Sales Intelligence and Strategy Engine**

Version 1.0 | May 2026 | CONFIDENTIAL

---

## Table of Contents

1. Product Overview
2. How ReadyLead Works
3. Prerequisites
4. Infrastructure Setup
5. Microsoft 365 Integration
6. DRiX Entra Connector (Shared Registration for ClearSignals + ReadyLead)
7. Security and Permissions Architecture
8. Entra App Gallery Strategy
9. External Service Configuration
10. Application Deployment
11. Pricing Structure
12. Onboarding Channel Partners
13. Week-by-Week Pilot Schedule
14. Success Metrics and Reporting
15. Post-Pilot: Scaling to Production

---

## 1. Product Overview

DRiX Ready Lead is a sales intelligence and strategy engine that transforms raw web presence data into actionable, persona-targeted sales strategies. Unlike contact databases or lead enrichment tools, ReadyLead performs deep research and strategic analysis --- delivering the kind of pre-meeting intelligence that would normally require a team of analysts working for a week, in under 60 seconds.

ReadyLead is purpose-built for channel partners and resellers who sell somebody else's product. These partners typically earn 20--30% of the deal value, which means they cannot afford to spend a week researching every prospect. ReadyLead gives a two-person partner firm the preparation capability of a team ten times their size.

**Core Capabilities:**

- 9-dimensional atomic decomposition of any company from its web presence (100--200 tagged intelligence atoms per entity)
- Multi-entity analysis: seller, solution, and customer analyzed in parallel
- AI-generated pain points at three levels: company-specific, sub-industry, and industry-wide
- Five persona-anchored sales strategies with confidence scoring
- Competitive intelligence: automatic competitor discovery and battlecard generation
- Individual OSINT: digital footprint analysis of the specific person being pitched
- Company intelligence enrichment: email security posture, financial data (FDIC/SEC), tech stack signals, org signals, and buying committee identification
- Lead hydration: discovery questions, email campaigns, and strategic insight generation
- AI coach: text chat and voice agent for deal strategy coaching

---

## 2. How ReadyLead Works

### 2.1 The Pipeline

A single ReadyLead run executes a multi-phase intelligence pipeline:

**Phase 1 --- Entity Ingestion:** Three URLs are scraped and decomposed into 9-dimensional tagged atoms (100--200 per entity). The nine dimensions are: persona, buying stage, emotional driver, evidence type, credibility, recency, economic driver, status quo pressure, and industry classification (NAICS/SIC).

**Phase 2 --- Competitive Intelligence:** The solution's competitors are discovered via search, scraped, and analyzed. Battlecard atoms are generated and merged into the solution's intelligence.

**Phase 3 --- Individual OSINT (optional):** If a LinkedIn URL or individual name is provided, ReadyLead researches the specific person's digital footprint --- social media, conference talks, published content, community memberships --- and generates personalized pitch angles.

**Phase 4 --- Company Intelligence Enrichment:** The customer's domain is analyzed for email security posture (DMARC/SPF/DKIM), financial data (FDIC for banks, SEC for public companies), tech stack signals, org signals (hiring patterns, leadership changes), and buying committee composition with Apollo name resolution.

**Phase 5 --- Pain Surfacing:** A dedicated AI pass generates 2--4 pain points at each of three levels: company-specific, sub-industry, and industry-wide. Each pain point includes primary and secondary persona ownership, urgency, economic lever, and inertia force.

**Phase 6 --- Strategy Generation:** Five distinct sales strategies are generated, each anchored on a unique persona-pain pair. Strategies include confidence scoring, economic pull vs. counter-inertia classification, and concrete first steps.

**Phase 7 --- Decision Maker Lookup:** Apollo identifies the real decision maker matching the top strategy's target persona at the customer's company.

**Phase 8 --- Hydration (on strategy selection):** When the user selects a strategy, the system generates discovery questions, email campaign drafts, and strategic insight tailored to that specific angle.

### 2.2 Caching and Intelligence Accumulation

ReadyLead employs aggressive three-layer caching:

- **In-memory cache:** Instant retrieval within the current server session
- **PostgreSQL cache:** Persistent across server restarts
- **TDE service cache:** Cross-session persistence with the Targeted Decomposition Engine

Intelligence accumulates over time. Each "refresh" pass discovers new atoms and merges them with existing ones rather than replacing them. A company researched three times has richer intelligence than one researched once.

### 2.3 The Coach

After generating strategies, reps can interact with an AI sales coach that has full context of the deal intelligence:

- **Text coach:** Conversational chat for strategy refinement, objection handling, script writing, and roleplay
- **Voice coach:** Real-time voice conversation via ElevenLabs conversational AI agent, provisioned with the full deal context

---

## 3. Prerequisites

### 3.1 Technical Requirements

| Component | Minimum Requirement |
|-----------|-------------------|
| Node.js | v18+ (LTS recommended) |
| PostgreSQL | v14+ (hosted or self-managed) |
| Operating System | Linux, macOS, or Windows Server |
| RAM | 2GB minimum for application server |
| Storage | 1GB for application + database growth |
| Network | Outbound HTTPS to OpenRouter, Apollo, Brave, Firecrawl APIs |
| Browser | Chrome 90+ or Edge 90+ |

### 3.2 API Keys and Accounts

| Service | Required? | What You Need | Purpose |
|---------|-----------|--------------|---------|
| OpenRouter | Required | API key + credits | All LLM processing (Claude Sonnet 4) |
| PostgreSQL | Required | Connection string | Data persistence and caching |
| Firecrawl | Recommended | API key | JS-rendered web scraping (SPAs) |
| Apollo.io | Recommended | API key + credits | Decision maker lookup, buying committee |
| Brave Search | Recommended | API key | Competitive discovery, individual OSINT |
| LeadHydration | Required | URL + API key | Discovery questions, email campaigns |
| ElevenLabs | Optional | API key | Voice coach feature |
| Cerebras | Optional | API key | Fast inference for comparison demos |
| Resend | Optional | API key | Email report delivery |

### 3.3 Organizational Requirements

- Executive sponsor at the partner organization
- 2--5 sales reps with active prospect pipelines
- IT contact if Microsoft 365 integration is desired (for email/calendar context)
- 30-minute onboarding session scheduled for pilot reps

---

## 4. Infrastructure Setup

### 4.1 Clone and Install

```bash
git clone https://github.com/stevewinfieldtx/DRiX-Ready-Leads.git
cd DRiX-Ready-Leads
npm install
cd client && npm install && npm run build && cd ..
```

### 4.2 Environment Configuration

Create a `.env` file in the project root:

```env
# ── Core ──────────────────────────────────────────────
PORT=3001
DATABASE_URL=postgresql://user:password@host:5432/readylead?sslmode=require

# ── AI Processing (Required) ─────────────────────────
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_MODEL_ID=anthropic/claude-sonnet-4

# ── Web Scraping (Recommended) ───────────────────────
FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── Contact Intelligence (Recommended) ───────────────
APOLLO_API_KEY=your-apollo-api-key

# ── Search Intelligence (Recommended) ────────────────
BRAVE_API_KEY=your-brave-search-api-key

# ── Lead Hydration Service (Required) ────────────────
LEADHYDRATION_URL=https://your-leadhydration-instance.up.railway.app
LEADHYDRATION_API_KEY=your-leadhydration-api-key

# ── ClearSignals Integration (Optional) ──────────────
CLEARSIGNALS_URL=https://your-clearsignals-instance.up.railway.app

# ── TDE Cache Service (Optional) ─────────────────────
TDE_BASE_URL=https://your-tde-instance.up.railway.app
TDE_API_KEY=your-tde-api-key

# ── Voice Coach (Optional) ───────────────────────────
ELEVENLABS_API_KEY=your-elevenlabs-api-key

# ── Comparison Demo (Optional) ───────────────────────
CEREBRAS_API_KEY=your-cerebras-api-key

# ── Email Reports (Optional) ─────────────────────────
RESEND_API_KEY=your-resend-api-key
REPORT_FROM_EMAIL=info@NYNImpact.com
```

### 4.3 Database Initialization

```bash
npm start
```

The schema initializes automatically on first startup. You should see:

```
DRiX Demo v3 running on port 3001
```

### 4.4 Verify Installation

Navigate to `http://localhost:3001` in your browser. The ReadyLead interface should load. Run a test with any public company URL to verify the pipeline works end-to-end.

---

## 5. Microsoft 365 Integration

### 5.1 Overview

Microsoft 365 integration enables ReadyLead to detect upcoming meetings from a rep's Outlook calendar and automatically pre-build intelligence on the attendees and their companies. This transforms ReadyLead from an on-demand tool into a proactive intelligence engine.

The integration uses the Microsoft Graph API with strictly read-only permissions.

### 5.2 Desktop Add-in Approach (Recommended for Pilot)

The desktop add-in is the fastest path to deployment. Each rep installs the Outlook add-in individually --- no IT admin involvement required.

**How it works:**

1. Rep installs the ReadyLead add-in in Outlook (desktop or web)
2. The add-in reads the rep's calendar and detects upcoming meetings
3. For each meeting, it extracts attendee names, email addresses, and company domains
4. ReadyLead prompts the rep to run intelligence on any unresearched attendees
5. All heavy processing happens on the ReadyLead server --- the add-in is a lightweight context collector

**Installation:**

1. Open Outlook on the web or desktop
2. Go to Settings (gear icon) then "Get Add-ins" or "Manage Add-ins"
3. Select "My add-ins" then "Add a custom add-in" then "Add from URL"
4. Enter the ReadyLead add-in manifest URL provided during onboarding
5. Authorize with read-only permissions

**Add-in Manifest Permissions:**

```xml
<Permissions>ReadItem</Permissions>
```

This is the lowest permission tier Microsoft offers. The add-in can only access the email or calendar event the user currently has open.

### 5.3 Server-Level Approach (Recommended for Production)

For production deployments, a Microsoft 365 admin registers ReadyLead at the tenant level:

1. Register the application in Azure Portal (Microsoft Entra ID)
2. Request `Calendars.Read` and `Mail.Read` as application permissions
3. Grant admin consent
4. Scope access using Application Access Policy (see Section 7)

This enables automated calendar scanning and proactive intelligence generation without per-user login.

### 5.4 What Calendar Integration Enables

With calendar access, ReadyLead can:

- Detect meetings with external attendees 24--48 hours in advance
- Auto-extract attendee company domains for intelligence pre-loading
- Prompt the rep: "You have a meeting with Acme Corp tomorrow. Run ReadyLead?"
- Pre-cache entity ingests so the full run is faster when the rep clicks "go"
- After the meeting: prompt for coach debrief or ClearSignals thread analysis

---

## 6. DRiX Entra Connector (Shared Registration for ClearSignals + ReadyLead)

### 6.1 What Is the DRiX Entra Connector?

The DRiX Entra Connector is a single Azure App Registration that serves every product in the DRiX platform. Rather than requiring separate Microsoft 365 integrations for ClearSignals, ReadyLead, and future DRiX products, the connector provides one shared Client ID, Tenant ID, and Client Secret across the entire platform.

If the customer has already set up the DRiX Entra Connector for ClearSignals, ReadyLead uses it automatically --- no new registration required.

**For existing ClearSignals customers:**

1. Open the existing DRiX Entra Connector registration in Azure Portal
2. Go to "API permissions"
3. Add `Calendars.Read` (delegated) if not already present
4. Click "Grant admin consent" to approve the new permission
5. No other changes required --- ReadyLead uses the same DRiX Entra Connector credentials

**For new customers deploying both products:**

Register a single application named "DRiX Entra Connector" and include all permissions for both products:

| Permission | Type | Used By |
|------------|------|---------|
| `Mail.Read` | Delegated or Application | ClearSignals (email thread analysis) |
| `Calendars.Read` | Delegated or Application | ReadyLead (meeting detection) |
| `User.Read` | Delegated | Both (user profile) |
| `Contacts.Read` | Delegated (optional) | ReadyLead (contact auto-populate) |

### 6.2 DRiX Entra Connector Access Policy

The same Application Access Policy that scopes ClearSignals to specific mailboxes also governs ReadyLead's access --- because they share the DRiX Entra Connector (same App ID = same policy):

```powershell
# If a policy already exists for ClearSignals, ReadyLead inherits it automatically
# (same App ID = same policy applies)

# To verify:
Test-ApplicationAccessPolicy -AppId "your-shared-client-id" `
  -Identity pilotuser@company.com
# Expected: AccessCheckResult = Granted
```

### 6.3 Benefits of the DRiX Entra Connector

- Customer sets up Microsoft 365 integration once via the DRiX Entra Connector for the entire platform
- Single security review for IT approval
- One Application Access Policy controls both products
- Adding future DRiX products (TrueGraph, Chimera Secured, etc.) requires only adding new permissions to the existing connector --- no new app setup
- Consistent branding: partners and IT teams always see "DRiX Entra Connector" regardless of which product triggered the integration

---

## 7. Security and Permissions Architecture

### 7.1 Read-Only by Design

ReadyLead enforces a strict read-only security posture across all integrations. The application cannot send, modify, or delete any data in the customer's environment.

**Microsoft 365 Permissions --- What Is and Is Not Requested:**

| Requested (Read-Only) | NOT Requested (Never) |
|-----------------------|----------------------|
| `Mail.Read` | `Mail.ReadWrite`, `Mail.Send` |
| `Calendars.Read` | `Calendars.ReadWrite` |
| `Contacts.Read` | `Contacts.ReadWrite` |
| `User.Read` | `User.ReadWrite.All` |
| | `Files.ReadWrite` (no OneDrive/SharePoint access) |

**Outlook Add-in Manifest:** Declares `ReadItem` permission only --- the lowest tier available. The add-in can access only the item currently open on screen.

**Application Access Policy:** Scopes server-level access to a specific security group of mailboxes. ReadyLead cannot access any mailbox outside the approved group.

### 7.2 External API Security

| Service | Data Sent | Data Received | Storage |
|---------|-----------|---------------|---------|
| OpenRouter (LLM) | Scraped web content, entity atoms | AI-generated analysis | Not stored by OpenRouter |
| Apollo.io | Company domain, persona title | Contact name, title, email | Cached in PostgreSQL |
| Brave Search | Search queries (company names) | Search result URLs and snippets | Not stored |
| Firecrawl | Target URLs | Rendered page content | Not stored |
| ElevenLabs | Deal context (coach prompt) | Voice audio stream | Temporary agent (auto-deleted) |

### 7.3 Data Handling

- Web-scraped content is processed into atoms and the raw HTML is discarded
- Atoms are stored in PostgreSQL with the customer's run data
- In-memory caches are cleared on server restart
- No customer email body content is stored --- only sender metadata (name, domain) is used for matching
- OAuth tokens are encrypted at rest using AES-256
- All API communication uses HTTPS (TLS 1.2+)

### 7.4 Security Talking Points for Partner IT Teams

When a channel partner's IT team evaluates ReadyLead:

- ReadyLead only reads calendar and email metadata --- it does not access email body content through the Microsoft 365 integration
- The Outlook add-in uses the lowest permission tier (`ReadItem`) and can only see the currently open item
- Application Access Policies restrict which mailboxes are accessible
- All AI processing uses the customer's own API keys --- WinTech does not see the prompts or responses
- No data is shared between customers
- ReadyLead works entirely without Microsoft 365 integration --- the O365 connection is optional for calendar-triggered runs

---

## 8. Entra App Gallery Strategy

### 8.1 Current Status (May 2026)

Microsoft has paused all new Entra App Gallery submissions during the Secure Future Initiative. No new SSO or provisioning applications are being accepted. Update requests for existing listings are handled case-by-case.

### 8.2 Pilot Phase: Non-Gallery Application

During the pilot and early production phases, the DRiX Entra Connector deploys as a non-gallery application. The functionality is identical to a gallery-listed app --- the only difference is manual registration by the customer's admin.

### 8.3 Gallery Listing Requirements (When Submissions Reopen)

The DRiX Entra Connector must meet:

- Federated SSO via OpenID Connect / OAuth 2.0 (Password SSO no longer accepted)
- Multitenant application using the Microsoft Entra consent framework
- Public documentation of SSO configuration, protocols, permissions, and business justifications
- Engineering and support contact for post-gallery customer support
- Membership in the Microsoft Partner Network
- SCIM 2.0 provisioning endpoint (optional but recommended; requires 100+ non-gallery customers before qualification)

### 8.4 Preparation Checklist

- [ ] Implement OIDC-based SSO (multitenant registration)
- [ ] Build SCIM 2.0 provisioning endpoint with OAuth 2.0 Client Credentials flow
- [ ] Publish SSO documentation publicly
- [ ] Join Microsoft Partner Network (partner.microsoft.com)
- [ ] Track non-gallery deployments for gallery qualification
- [ ] Monitor Secure Future Initiative for reopening announcements

---

## 9. External Service Configuration

### 9.1 OpenRouter (Required)

OpenRouter provides access to Claude Sonnet 4 for all LLM processing.

1. Create an account at openrouter.ai
2. Add credits (recommended: $50 for pilot, covers ~20 full runs)
3. Generate an API key
4. The default model (`anthropic/claude-sonnet-4`) handles all analysis tasks

**Cost Estimate:** ~$2.85 per fresh run (all services), ~$0.65 per cached run.

### 9.2 Apollo.io (Recommended)

Apollo provides decision-maker lookup and buying committee resolution.

1. Create an account at apollo.io
2. Basic plan: 900 credits/month ($49) --- supports ~130--180 runs
3. Pro plan: 2,400 credits/month ($99) --- supports ~350--480 runs
4. Each run uses 5--7 credits (top-pick lookup + buying committee)

### 9.3 Brave Search (Recommended)

Brave Search enables competitive discovery and individual OSINT research.

1. Sign up at brave.com/search/api
2. Base plan: $3/1,000 queries
3. Each run uses 5--15 queries (~$0.015--$0.045)
4. Effectively negligible cost

### 9.4 Firecrawl (Recommended)

Firecrawl provides JavaScript-rendered web scraping for modern single-page applications.

1. Sign up at firecrawl.dev
2. Grow plan: $0.001/page
3. Each run scrapes 3--7 pages (~$0.003--$0.007)
4. Without Firecrawl, ReadyLead falls back to basic HTTP scraping (many modern sites will return empty content)

### 9.5 LeadHydration (Required)

LeadHydration is the companion service that generates discovery questions, email campaigns, and strategic insight from ReadyLead's intelligence.

```env
LEADHYDRATION_URL=https://your-leadhydration-instance.up.railway.app
LEADHYDRATION_API_KEY=your-api-key
```

Deploy the LeadHydration service before starting the ReadyLead pilot. It runs as a separate Node.js application with its own OpenRouter API key.

### 9.6 ElevenLabs (Optional)

ElevenLabs powers the voice coach feature.

1. Sign up at elevenlabs.io
2. The voice coach creates a temporary conversational AI agent per run
3. Cost: $0.10--$0.50 per conversation session
4. Most pilot reps will use text coach more frequently than voice

---

## 10. Application Deployment

### 10.1 Recommended: Railway

1. Push code to GitHub
2. Create a Railway project at railway.app
3. Connect your GitHub repository
4. Add all environment variables in the Railway dashboard
5. Add a PostgreSQL database as a Railway service
6. Railway auto-deploys on git push

Railway also hosts the LeadHydration and TDE services, keeping the full stack in one platform.

### 10.2 Alternative Deployment Options

| Platform | Pros | Cons |
|----------|------|------|
| Railway | Easy setup, managed Postgres, auto-deploy | U.S.-hosted |
| Render | Free tier available, auto-deploy | Cold starts on free tier |
| AWS EC2 / ECS | Full control, any region, compliance options | More setup complexity |
| Azure App Service | Native Microsoft integration | Higher cost for small deployments |
| Self-hosted | Complete data sovereignty | Requires infrastructure team |

### 10.3 Infrastructure Cost Estimates

| Component | Pilot (Monthly) | Production (Monthly) |
|-----------|-----------------|---------------------|
| Railway (ReadyLead server) | $5--$10 | $10--$20 |
| Railway (LeadHydration) | $5--$10 | $10--$20 |
| PostgreSQL (Railway add-on) | $5--$10 | $10--$25 |
| TDE service (optional, Railway) | $5--$10 | $10--$20 |
| **Infrastructure total** | **$20--$40** | **$40--$85** |

Variable costs (API usage) are additional --- see Section 11.

---

## 11. Pricing Structure

### 11.1 Two-Tier Pricing Model

ReadyLead uses a seat + usage pricing model designed for channel partners:

**Seat License: $100/user/month**

Includes:

- Continuous intelligence updates on seller and solution entities (atoms kept current)
- Refreshed customer intelligence as new data arrives
- Unlimited access to the AI text coach (chat widget)
- Unlimited access to the AI voice coach (ElevenLabs agent)
- Dashboard access with saved runs and historical intelligence
- Shared DRiX platform Microsoft 365 integration

**Usage Pack: $1,000 per 200 runs**

Each "run" is a full ReadyLead intelligence pipeline execution (all phases). Usage packs are shared across the team --- not per-user.

- Effective rate: $5.00 per run
- Average cost to serve: $1.65 per run (mix of fresh and cached)
- Gross margin: ~67%

### 11.2 Typical Deployment Scenarios

| Team Size | Seats | Usage/Month | Monthly Cost | Cost per Rep |
|-----------|-------|-------------|-------------|-------------|
| Small partner (2 reps) | 2 x $100 | ~40 runs (1 pack) | $700 | $350 |
| Mid partner (5 reps) | 5 x $100 | ~100 runs (1 pack) | $1,500 | $300 |
| Large partner (10 reps) | 10 x $100 | ~200 runs (2 packs) | $3,000 | $300 |

### 11.3 Pilot Pricing

Pilot pricing: $80/user/month for the seat license. Usage packs at standard $1,000/200 rate.

### 11.4 Channel Partner Economics

ReadyLead is designed for resellers who earn 20--30% of the deals they close. The ROI model:

- A partner closing a $100K deal earns $20--30K
- ReadyLead at $300/month per rep is paid for by closing one additional small deal per quarter
- The intelligence depth enables partners to compete against firms with dedicated research teams
- Cached intelligence compounds --- researching a company once enriches all future interactions with that company

---

## 12. Onboarding Channel Partners

### 12.1 Pre-Onboarding Checklist

- [ ] ReadyLead server deployed and accessible
- [ ] OpenRouter API key configured with sufficient credits
- [ ] LeadHydration service deployed and connected
- [ ] Apollo.io API key configured (for decision-maker lookup)
- [ ] Firecrawl API key configured (for modern site scraping)
- [ ] Brave Search API key configured (for competitive discovery)
- [ ] Partner user accounts created
- [ ] Microsoft 365 add-in manifest URL ready (if using calendar integration)
- [ ] Test run completed with a sample company URL

### 12.2 Onboarding Session Agenda (30 minutes)

**Minutes 1--5: The Problem**

- Channel partners can't afford dedicated research teams
- At 20--30% margins, pre-meeting prep has to be fast or it doesn't happen
- Walking in cold vs. walking in with ReadyLead intelligence

**Minutes 5--15: Live Demo**

- Enter a real prospect URL the partner is currently pursuing
- Watch the pipeline execute in real time (fetch, decompose, pain, strategies)
- Review the five strategies --- show persona-pain anchoring
- Click a strategy to hydrate --- show discovery questions and email campaign
- Open the coach and ask a strategy question

**Minutes 15--20: Outlook Integration (if applicable)**

- Install the Outlook add-in
- Show calendar detection and meeting-triggered intelligence
- Demonstrate how cached entities make repeat runs faster

**Minutes 20--25: Daily Workflow**

- Morning: Check calendar for upcoming meetings, run ReadyLead on any unresearched prospects
- Before meeting: Review strategies, coach through objection handling
- After meeting: Use ClearSignals for thread analysis (if integrated)

**Minutes 25--30: Q&A and Support**

- How to submit feedback
- Support contact information
- Pilot timeline and review dates

---

## 13. Week-by-Week Pilot Schedule

### Week 1: Setup and Onboarding

| Day | Activity | Owner |
|-----|----------|-------|
| Day 1 | Deploy ReadyLead + LeadHydration infrastructure | Technical lead |
| Day 2 | Configure API keys (OpenRouter, Apollo, Brave, Firecrawl) | Technical lead |
| Day 3 | Install Outlook add-in (if using O365 integration), verify | Technical lead |
| Day 4 | Onboarding session with partner reps | Pilot coordinator |
| Day 5 | Reps run first ReadyLead intelligence on real prospects | Pilot reps |

**Week 1 Milestone:** All pilot reps have run ReadyLead on at least 2 real prospects each.

### Week 2: Active Usage

| Activity | Frequency |
|----------|-----------|
| Reps run ReadyLead before prospect meetings | Before each meeting |
| Coach used for strategy refinement | As needed |
| Calendar integration triggers pre-meeting intelligence | Automated |
| Check-in with pilot reps | Mid-week |

**Week 2 Milestone:** Each rep has used ReadyLead intelligence in at least 3 real prospect conversations.

### Week 3: Deepening

| Activity | Frequency |
|----------|-----------|
| Reps explore individual OSINT (LinkedIn research) | At least 2 per rep |
| Compare ReadyLead-prepared vs. unprepared meetings | Ongoing |
| Voice coach used for roleplay or objection practice | At least once per rep |
| ClearSignals integration tested (if deployed) | Once |

**Week 3 Milestone:** Reps report qualitative improvement in meeting quality. At least one deal advanced specifically due to ReadyLead intelligence.

### Week 4: Review and Assessment

| Day | Activity | Owner |
|-----|----------|-------|
| Day 22 | Collect rep feedback on intelligence quality and accuracy | Pilot coordinator |
| Day 23 | Review usage metrics (runs, coach sessions, strategies selected) | Technical lead |
| Day 24 | Calculate ROI: meetings prepared vs. deals advanced | Pilot coordinator |
| Day 25 | Partner leadership review | Sales leader |
| Day 26--28 | Compile pilot report with go/no-go recommendation | Pilot coordinator |

**Week 4 Milestone:** Pilot report delivered with usage data, qualitative feedback, and recommendation for full deployment.

---

## 14. Success Metrics and Reporting

### 14.1 Quantitative Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Total runs executed | 40+ across all reps | Platform analytics |
| Meetings prepared with ReadyLead | 80%+ of external meetings | Rep self-report |
| Strategies selected and hydrated | 20+ | Platform analytics |
| Coach sessions (text + voice) | 10+ across all reps | Platform analytics |
| Individual OSINT scans | 5+ | Platform analytics |
| Cache hit rate (repeat entities) | 40%+ by week 4 | Server logs |

### 14.2 Qualitative Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Intelligence accuracy | 80%+ rated "accurate" by reps | Post-pilot survey |
| Rep satisfaction score | 7+/10 | Post-pilot survey |
| Meeting confidence improvement | "Significantly better" or higher | Rep interview |
| Strategy relevance | At least 3 of 5 strategies rated "usable" per run | Rep feedback |
| Deal attribution | At least 1 deal advanced due to ReadyLead | Rep interview |

### 14.3 Pilot Report Template

1. Executive summary (go/no-go recommendation)
2. Usage statistics (runs, hydrations, coach sessions, individual scans)
3. Representative deal examples (3--5 prospects where ReadyLead changed the approach)
4. Intelligence accuracy assessment (atom quality, strategy relevance, pain accuracy)
5. Rep feedback summary
6. Partner leadership feedback
7. Cost analysis (actual API spend vs. pricing model)
8. Recommendations for full deployment (team size, usage pack quantity, O365 integration)

---

## 15. Post-Pilot: Scaling to Production

### 15.1 Infrastructure Scaling

| Component | Pilot | Production |
|-----------|-------|-----------|
| ReadyLead server | Single instance | Load-balanced (2+ instances) |
| LeadHydration | Single instance | Auto-scaling behind load balancer |
| PostgreSQL | Shared or small instance | Dedicated with read replicas |
| TDE service | Optional | Deployed for cross-session atom persistence |

### 15.2 Microsoft 365 Scaling

- Move from desktop add-in to admin-deployed add-in (Microsoft 365 admin center)
- Transition from delegated to application-level permissions with Application Access Policy
- Configure webhook-based calendar subscriptions (Microsoft Graph Subscriptions) for real-time meeting detection instead of polling
- Prepare for Entra App Gallery submission when Microsoft reopens the program

### 15.3 Security Hardening

- Enable SSO (OIDC) for user authentication
- Encrypt all API keys and OAuth tokens at rest (AES-256)
- Configure database SSL and network isolation
- Set up audit logging for all data access
- Implement role-based access control
- Review and rotate client secrets on 6-month cycle

### 15.4 ClearSignals Integration

For partners using both products:

- Single DRiX Entra Connector registration (shared credentials across all DRiX products)
- ReadyLead pre-meeting intelligence flows into ClearSignals post-meeting thread analysis
- Atoms generated by ReadyLead enrich ClearSignals opportunity context
- One Microsoft 365 integration serves both products

### 15.5 Monitoring

- Application health checks (`/healthz` endpoint)
- OpenRouter API usage and cost tracking
- Apollo credit consumption monitoring
- Cache hit rates (target: 60%+ by month 3)
- Run latency tracking (target: under 90 seconds for fresh run)

---

*For pilot setup assistance:*

**stevewinfieldtx@gmail.com** | **clearsignalsai.com**
