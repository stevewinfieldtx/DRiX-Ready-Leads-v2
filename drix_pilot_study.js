#!/usr/bin/env node
/* ============================================================================
 * drix_pilot_study.js  —  Basic-CRM vs DRiX, win-probability & cycle-turns
 * ----------------------------------------------------------------------------
 * Produces THREE pilot numbers, all measured by the simulation against YOUR tool
 * (no industry-average borrowing):
 *
 *   (1) WIN PROBABILITY per pitch — a simulated senior buyer estimates the % chance
 *       this outreach advances the opportunity (positive reply -> meeting).
 *       Reported: basic-CRM X%  ->  DRiX Y%   (uplift in points and x).
 *   (2) CYCLE TURNS — the same buyer estimates how many back-and-forth email
 *       exchanges it takes to reach a yes. Reported: CRM ~N  ->  DRiX ~M.
 *   (3) THE CONTRAST is the thing customers actually face: a basic CRM mail-merge
 *       email (name + company only) vs DRiX deep personalization.
 *
 * Arms:
 *   - "crm"  : a fixed mail-merge TEMPLATE (no LLM) — represents "what you do today".
 *   - "drix" : fetched live from /api/comparison (tde_done) — the real product.
 * The buyer-judge scores each email BLIND (it is never told which arm it is).
 * Bootstraps over companies for 95% CIs.
 *
 * This is an LLM-as-judge simulation: the buyer is simulated and the numbers are
 * AI-inferred pilot estimates, to be validated by a real pilot. They are the
 * measured output of this defined, reproducible procedure — not made up, and not
 * borrowed from third-party studies.
 *
 * USAGE:
 *   node drix_pilot_study.js --self-test     # offline checks, no cost
 *   node drix_pilot_study.js --dry-run       # plan + reachability + cost, no cost
 *   node drix_pilot_study.js                  # LIVE run (API cost)
 *   node drix_pilot_study.js --export-csv     # rebuild CSV from saved JSON, no cost
 *   node drix_pilot_study.js --rounds 6 --scenario email
 * ========================================================================== */

'use strict';
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_APP_URL = 'https://readyleads.getthedrix.com';
const BASE_URL = (process.env.BENCH_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || 'anthropic/claude-sonnet-4';
const DRIX_FETCH_MODEL = 'gemini';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const COMPANIES_FILE = path.join(__dirname, 'benchmark_companies.json');
const RESULTS_FILE = path.join(__dirname, 'pilot_study_results.json');
const RESULTS_CSV = path.join(__dirname, 'pilot_study_results.csv');

const ARMS = [
  { key: 'crm', label: 'Basic CRM mail-merge (name + company only)' },
  { key: 'drix', label: 'DRiX deep personalization' },
];

const DEFAULTS = { scenario: 'email', rounds: 6, bootstrap: 10000, cpp: 'steve', perCompanyTimeoutMs: 240000 };
const MAX_TURNS = 8; // cap / "would ignore" value

// ─── Basic CRM mail-merge template (NO LLM — this is literally what a CRM sends) ──
function crmEmail(companyName) {
  return `Subject: Quick question

Hi there,

I hope this email finds you well. My name is Steve Winfield and I'm with WinTech Partners. We offer DRiX, an AI-powered intelligence platform that helps companies like ${companyName} work smarter with their data.

I'd love to schedule a quick 15-minute call to show you what we can do for ${companyName}. Are you available sometime this week or next?

Best regards,
Steve Winfield
WinTech Partners`;
}

// ─── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { ...DEFAULTS, mode: 'live' };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--self-test') a.mode = 'self-test';
    else if (t === '--dry-run') a.mode = 'dry-run';
    else if (t === '--export-csv') a.mode = 'export-csv';
    else if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--rounds') a.rounds = parseInt(argv[++i], 10);
    else if (t === '--bootstrap') a.bootstrap = parseInt(argv[++i], 10);
    else if (t === '--judge') a.judgeModel = argv[++i];
    else if (t === '--help' || t === '-h') a.mode = 'help';
  }
  return a;
}

// ─── stats ──────────────────────────────────────────────────────────────────
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
function bootstrapCI(values, n, ci, rng) {
  const k = values.length, ms = [];
  if (!k) return [NaN, NaN];
  for (let r = 0; r < n; r++) { let s = 0; for (let i = 0; i < k; i++) s += values[(rng() * k) | 0]; ms.push(s / k); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor((1 - ci) / 2 * n)], ms[Math.ceil((1 + ci) / 2 * n) - 1]];
}
function mulberry32(seed) {
  return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
async function withRetry(fn, attempts, delayMs) {
  let last; for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { last = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs)); } } throw last;
}

// ─── DRiX side ──────────────────────────────────────────────────────────────
async function fetchDrix({ company_url, company_name }, scenario, cpp, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = {};
  try {
    const resp = await fetch(`${BASE_URL}/api/comparison`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ company_url, company_name, scenario, model: DRIX_FETCH_MODEL, cpp }), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = null, data = '';
        for (const ln of chunk.split('\n')) { if (ln.startsWith('event:')) ev = ln.slice(6).trim(); else if (ln.startsWith('data:')) data += ln.slice(5).trim(); }
        if (ev) { try { events[ev] = JSON.parse(data || '{}'); } catch { events[ev] = { _raw: data }; } }
      }
    }
  } finally { clearTimeout(timer); }
  const drix = events.tde_done?.text;
  if (!drix) throw new Error('no tde_done: ' + (events.tde_error?.message || 'unknown'));
  return drix;
}

// ─── Buyer-judge: absolute win probability + expected turns (blind to arm) ──────
function judgePrompt(companyName, emailText) {
  return `You are a busy, skeptical senior decision-maker at ${companyName}. You received the cold outreach below from a vendor. Judge it ONLY from your seat as the buyer.

Estimate two things realistically (cold outreach to a senior buyer usually succeeds at LOW rates unless it is specific and relevant to your actual situation):
- win_probability: the % chance (0-100) you respond positively and agree to a first meeting because of this outreach.
- expected_turns: how many back-and-forth email exchanges it would take to get you to that yes (1 = you'd reply yes immediately; ${MAX_TURNS} = you'd ignore it / never get there).

Return ONLY JSON, no markdown:
{"win_probability": <0-100>, "expected_turns": <1-${MAX_TURNS}>, "reason":"one sentence"}

=== OUTREACH ===
${emailText}`;
}

function parseJudge(raw) {
  let s = (raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  const o = JSON.parse(s);
  const wp = Number(o.win_probability), tn = Number(o.expected_turns);
  if (!(wp >= 0 && wp <= 100)) throw new Error('win_probability out of range');
  if (!(tn >= 1 && tn <= MAX_TURNS)) throw new Error('expected_turns out of range');
  return { win_probability: wp, expected_turns: tn, reason: o.reason || '' };
}

async function judgeEmail(companyName, emailText, judgeModel) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'DRiX Pilot Study' },
      body: JSON.stringify({ model: judgeModel, messages: [{ role: 'user', content: judgePrompt(companyName, emailText) }], temperature: 0.3, max_tokens: 300 }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`judge HTTP ${resp.status}`);
    const data = await resp.json();
    return parseJudge(data?.choices?.[0]?.message?.content || '');
  } finally { clearTimeout(timer); }
}

// ─── aggregate ────────────────────────────────────────────────────────────────
function summarizeArm(companyResults, armKey, nBoot) {
  const wp = [], tn = [];
  for (const c of companyResults) {
    const d = c.arms?.[armKey]?.scores || [];
    if (!d.length) continue;
    wp.push(mean(d.map(x => x.win_probability)));
    tn.push(mean(d.map(x => x.expected_turns)));
  }
  return {
    n: wp.length,
    winProb: mean(wp), winProbCI: bootstrapCI(wp, nBoot, 0.95, mulberry32(101)),
    turns: mean(tn), turnsCI: bootstrapCI(tn, nBoot, 0.95, mulberry32(202)),
  };
}

function printReport(sum, cfg) {
  const crm = sum.crm, drix = sum.drix;
  const p = x => x.toFixed(1);
  console.log('\n' + '='.repeat(74));
  console.log('DRiX PILOT STUDY  —  basic CRM mail-merge  vs  DRiX  (simulated buyer)');
  console.log(`scenario=${cfg.scenario}  judge=${cfg.judgeModel || JUDGE_MODEL}  rounds/arm=${cfg.rounds}  companies=${crm.n}`);
  console.log('='.repeat(74));
  console.log('METRIC 1 — WIN PROBABILITY (chance the outreach advances the opportunity)');
  console.log(`  Basic CRM:  ${p(crm.winProb)}%   95% CI [${p(crm.winProbCI[0])}, ${p(crm.winProbCI[1])}]`);
  console.log(`  DRiX:       ${p(drix.winProb)}%   95% CI [${p(drix.winProbCI[0])}, ${p(drix.winProbCI[1])}]`);
  const upPts = drix.winProb - crm.winProb;
  const upX = crm.winProb > 0 ? drix.winProb / crm.winProb : NaN;
  console.log(`  UPLIFT:     +${p(upPts)} points   (${isFinite(upX) ? upX.toFixed(1) + 'x' : 'n/a'})`);
  console.log('-'.repeat(74));
  console.log('METRIC 2 — CYCLE TURNS (email exchanges to reach a yes; lower is better)');
  console.log(`  Basic CRM:  ${p(crm.turns)} turns   95% CI [${p(crm.turnsCI[0])}, ${p(crm.turnsCI[1])}]`);
  console.log(`  DRiX:       ${p(drix.turns)} turns   95% CI [${p(drix.turnsCI[0])}, ${p(drix.turnsCI[1])}]`);
  const tcut = crm.turns - drix.turns;
  console.log(`  REDUCTION:  -${p(tcut)} turns   (${crm.turns > 0 ? (tcut / crm.turns * 100).toFixed(0) : 'n/a'}% shorter)`);
  console.log('='.repeat(74));
  console.log('Simulated-buyer estimates (AI-judge). Lead with these as pilot projections; a live pilot confirms.');
  console.log(`\n>>> Headline: DRiX lifts win probability ${p(crm.winProb)}% -> ${p(drix.winProb)}% (+${p(upPts)} pts) and cuts the cycle ${p(crm.turns)} -> ${p(drix.turns)} turns.`);
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function csvEsc(v) { const s = (v == null) ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const num = (v, d = 2) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : v;
function buildCSV(companyResults, sum) {
  const header = ['company_name', 'arm', 'rounds', 'win_probability_%', 'expected_turns', 'error'];
  const rows = [header];
  for (const c of (companyResults || [])) {
    for (const a of ARMS) {
      const d = c.arms?.[a.key]?.scores || [];
      rows.push([c.company_name, a.key, d.length,
        d.length ? mean(d.map(x => x.win_probability)) : '',
        d.length ? mean(d.map(x => x.expected_turns)) : '',
        c.arms?.[a.key]?.error || c.error || '']);
    }
  }
  if (sum) for (const a of ARMS) {
    const s = sum[a.key];
    rows.push(['OVERALL', a.key, s.n, s.winProb, s.turns,
      `winCI ${num(s.winProbCI[0])}-${num(s.winProbCI[1])}; turnCI ${num(s.turnsCI[0])}-${num(s.turnsCI[1])}`]);
  }
  return rows.map(r => r.map(v => csvEsc(num(v))).join(',')).join('\n') + '\n';
}
function writeCSV(c, s, f) { fs.writeFileSync(f, buildCSV(c, s)); }

// ─── self-test ─────────────────────────────────────────────────────────────────
function selfTest() {
  console.log('SELF-TEST (offline)\n'); let ok = true;
  try { const p = parseJudge('{"win_probability":35,"expected_turns":3,"reason":"x"}'); if (p.win_probability !== 35) ok = false; console.log('  parse OK'); } catch (e) { ok = false; console.log('  parse FAIL', e.message); }
  try { parseJudge('{"win_probability":150,"expected_turns":3}'); ok = false; console.log('  FAIL: out-of-range not caught'); } catch { console.log('  out-of-range rejected'); }
  // CRM template is deterministic and contains the company name, no LLM
  const e = crmEmail('Acme'); if (!e.includes('Acme') || e.length < 100) { ok = false; console.log('  FAIL: crm template'); } else console.log('  CRM template OK');
  // synthetic: DRiX higher win prob, fewer turns
  const rng = mulberry32(5); const cr = [];
  for (let i = 0; i < 30; i++) {
    const mk = (wlo, tlo) => { const a = []; for (let j = 0; j < 6; j++) a.push({ win_probability: wlo + rng() * 10, expected_turns: tlo + rng() * 1.5 }); return a; };
    cr.push({ company_name: 'C' + i, arms: { crm: { scores: mk(12, 5.5) }, drix: { scores: mk(38, 3.5) } } });
  }
  const sum = {}; for (const a of ARMS) sum[a.key] = summarizeArm(cr, a.key, 2000);
  console.log(`  CRM win=${sum.crm.winProb.toFixed(1)}% turns=${sum.crm.turns.toFixed(1)} | DRiX win=${sum.drix.winProb.toFixed(1)}% turns=${sum.drix.turns.toFixed(1)}`);
  if (!(sum.drix.winProb > sum.crm.winProb && sum.drix.turns < sum.crm.turns)) { ok = false; console.log('  FAIL: expected DRiX better'); }
  const lines = buildCSV(cr, sum).trim().split('\n');
  const cols = lines[0].split(',').length; const rect = lines.every(l => l.split(',').length === cols);
  if (!rect || lines.length !== 1 + 30 * 2 + 2) { ok = false; console.log('  FAIL: CSV shape', lines.length); } else console.log('  CSV OK (' + lines.length + ' lines)');
  try { const tmp = path.join(os.tmpdir(), 'p_' + Date.now() + '.csv'); writeCSV(cr, sum, tmp); fs.unlinkSync(tmp); console.log('  CSV write OK'); } catch (e2) { ok = false; console.log('  CSV write FAIL', e2.message); }
  printReport(sum, { scenario: 'email', rounds: 6 });
  console.log('\nSELF-TEST ' + (ok ? 'PASSED' : 'FAILED'));
  process.exit(ok ? 0 : 1);
}

// ─── preflight ───────────────────────────────────────────────────────────────
function loadCompanies() {
  if (!fs.existsSync(COMPANIES_FILE)) throw new Error('missing ' + COMPANIES_FILE);
  const d = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const list = d.companies || d;
  if (list.some(c => !c.company_url || !c.company_name)) throw new Error('company needs name+url');
  return list;
}
async function serverReachable() {
  try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000); const r = await fetch(`${BASE_URL}/`, { signal: ctrl.signal }); clearTimeout(t); return r.ok || r.status === 404; } catch { return false; }
}
function printPlan(companies, cfg) {
  const judge = companies.length * ARMS.length * cfg.rounds;
  console.log('PLAN');
  console.log(`  target app:   ${BASE_URL}`);
  console.log(`  arms:         basic-CRM (template, no LLM)  vs  DRiX (live)`);
  console.log(`  metrics:      win probability (%), expected turns to yes`);
  console.log(`  judge:        ${cfg.judgeModel || JUDGE_MODEL}`);
  console.log(`  companies:    ${companies.length}   rounds/arm: ${cfg.rounds}`);
  console.log(`  COST ~ ${companies.length} DRiX fetches + ${judge} judge calls (CRM arm is free)`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.mode === 'help') { console.log(fs.readFileSync(__filename, 'utf8').split('* =====')[1] || 'see header'); return; }
  if (cfg.mode === 'self-test') return selfTest();
  if (cfg.mode === 'export-csv') {
    if (!fs.existsSync(RESULTS_FILE)) throw new Error('no pilot_study_results.json yet — run live first.');
    const d = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    writeCSV(d.companies || [], d.summary, RESULTS_CSV); console.log('Wrote ' + RESULTS_CSV); return;
  }
  if (!['email', 'pitch', 'partnership'].includes(cfg.scenario)) throw new Error('bad --scenario');
  const companies = loadCompanies();
  cfg.judgeModel = cfg.judgeModel || JUDGE_MODEL;
  printPlan(companies, cfg);
  if (cfg.mode === 'dry-run') {
    if (!OPENROUTER_API_KEY) console.log('\n[dry-run] WARNING: OPENROUTER_API_KEY not set.');
    console.log(`\n[dry-run] app reachable: ${(await serverReachable()) ? 'YES' : 'NO'}`);
    console.log('[dry-run] no API calls made.'); return;
  }
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing.');
  if (!(await serverReachable())) throw new Error(`App not reachable at ${BASE_URL}.`);
  console.log('\nLIVE RUN — incurs API cost.\n');

  const companyResults = [];
  for (let ci = 0; ci < companies.length; ci++) {
    const co = companies[ci];
    process.stdout.write(`[${ci + 1}/${companies.length}] ${co.company_name} ... `);
    let drixText;
    try { drixText = await withRetry(() => fetchDrix(co, cfg.scenario, cfg.cpp, cfg.perCompanyTimeoutMs), 2, 3000); }
    catch (e) { console.log('SKIP (' + e.message + ')'); companyResults.push({ ...co, error: e.message, arms: {} }); continue; }
    const texts = { crm: crmEmail(co.company_name), drix: drixText };
    const arms = {};
    const parts = [];
    for (const a of ARMS) {
      const scores = [];
      for (let j = 0; j < cfg.rounds; j++) { try { scores.push(await judgeEmail(co.company_name, texts[a.key], cfg.judgeModel)); } catch { } }
      arms[a.key] = { scores };
      parts.push(`${a.key} win=${scores.length ? mean(scores.map(s => s.win_probability)).toFixed(0) : '?'}%`);
    }
    console.log(parts.join('  '));
    companyResults.push({ ...co, arms });
  }

  const summary = {}; for (const a of ARMS) summary[a.key] = summarizeArm(companyResults, a.key, cfg.bootstrap);
  printReport(summary, cfg);

  fs.writeFileSync(RESULTS_FILE, JSON.stringify({
    _meta: { generated_at: new Date().toISOString(), simulated_buyer: true, base_url: BASE_URL, scenario: cfg.scenario, judge_model: cfg.judgeModel, rounds_per_arm: cfg.rounds, arms: ARMS, note: 'Basic-CRM vs DRiX. Simulated-buyer pilot estimates, not measured outcomes.' },
    summary, companies: companyResults,
  }, null, 2));
  writeCSV(companyResults, summary, RESULTS_CSV);
  console.log(`\nResults: ${RESULTS_FILE}\nCSV:     ${RESULTS_CSV}`);
}

main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
