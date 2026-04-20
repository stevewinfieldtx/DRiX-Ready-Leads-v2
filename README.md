# TDE Demo v2 — Live Edition

Live demonstration of WinTech's Targeted Decomposition Engine. **The hero flow: drop a URL, watch TDE fetch → decompose → generate WinTech × AIAIVN partnership angles → compose a send-ready outreach email in ~30 seconds.**

## The demo that actually sells

This is what you show Anthony when he says "give me a customer":

1. He names one ("let's do Techcombank")
2. You paste the URL into the big field at the top, click **Run Full Flow**
3. Live streaming phases: Fetching… → Decomposing… → Generating angles… → Composing email…
4. Atoms panel fills in (~12-25 atomic facts about the target)
5. Angles panel shows 3-4 specific WinTech × AIAIVN partnership ideas with a "top pick"
6. Email panel shows a send-ready outreach email with subject line, body, and a copy button
7. One click copies the whole email

**The punchline:** TDE didn't just summarize a website. It combined the target's atoms with WinTech's atoms and AIAIVN's atoms to produce a specific, actionable partnership proposal with the email to send.

## Also preserved from v1

- Pre-seeded AIAIVN (31 atoms) visible from the target list below
- Atom grid with filter chips
- Manual reconstruct still works via the existing endpoints (`/api/reconstruct`)

## Stack

Node.js 18+, Express, plain HTML/JS, OpenRouter. In-memory atom store (production TDE uses Qdrant + Postgres).

## Deploy to Railway

```bash
node --check server.js   # always before push
git add .
git commit -m "TDE demo v2 — live flow"
git push
```

Environment variables:
- `OPENROUTER_API_KEY` (required)
- `OPENROUTER_MODEL_ID` (optional, defaults to `anthropic/claude-sonnet-4.5`)

## API

### `POST /api/demo-flow` (the money endpoint)

Server-Sent Events stream. Phases: `fetch` → `ingest` → `angles` → `email`.

```json
{
  "url": "https://www.techcombank.com.vn",
  "recipient_role": "CTO"
}
```

### `POST /api/ingest-url`
Ingest a URL (fetch + decompose, no angles/email).

### `POST /api/ingest`
Ingest raw pasted content.

### `POST /api/reconstruct`
Generate output for a specific recipient from stored atoms.

### `POST /api/angles`
Generate WinTech × AIAIVN angles for a stored target.

### `GET /api/atoms`, `GET /api/atoms/:id`, `GET /healthz`

## Files

```
server.js              Express server + prompts
seed-aiaivn.json       31 pre-decomposed AIAIVN atoms
seed-wintech.json      15 WinTech support atoms (never shown as a target)
public/index.html      Single-page UI with live-flow panel
package.json
.env.example
```

## Demo rehearsal script

1. **Open the app** — AIAIVN target chip shows at bottom with atom count
2. **Skip straight to live demo** — the hero is the URL input at top
3. **Type/paste a URL** (or click a suggestion like Techcombank)
4. **Click Run Full Flow**
5. Watch phases light up one by one — this is the theater
6. Atoms panel fills — scroll to the `mission_gap` filter and click it to show "TDE finds where their reach exceeds their grasp"
7. Angles appear — highlight the "top pick" card and explain why it was chosen
8. Email appears — "this isn't a template, this is written FOR this specific recipient using the atoms we just extracted"
9. Click copy — "and now it's in my clipboard, ready to send"

Total demo time: ~45 seconds of watching + ~60 seconds of narration = **under two minutes**.

## Honest notes before you demo

- **Some sites won't fetch cleanly.** Heavy SPAs (React-only, no SSR) return mostly empty HTML. Have 2-3 known-good URLs ready as fallbacks. Vietnamese bank sites (Techcombank, BIDV, Vietcombank) and content-heavy sites generally work well.
- **First run takes longer.** OpenRouter cold start + three sequential LLM calls = 25-45 seconds typical. Tell him upfront: "about 30 seconds to watch it work."
- **If the email feels generic, it means the target didn't have enough content.** Blame the target's thin website, not TDE. Recovery line: "When we run this against a richer content source — LinkedIn profiles, their actual docs, a product catalog — the output gets sharper. This is just what their public homepage gave us."
