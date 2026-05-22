#!/usr/bin/env node
/* ============================================================================
 * benchmark_drix.js  —  Turnkey DRiX vs Standard-AI benchmark
 * ----------------------------------------------------------------------------
 * WHAT THIS MEASURES (read this before quoting any number):
 *   For each real company, this hits your POST /api/comparison endpoint to get
 *   two cold-outreach outputs:
 *       - "standard" : a frontier model (GPT-4o / Gemini / Claude) writing from
 *                      just the company name  -> the BASELINE
 *       - "drix"     : your atom-grounded TDE synthesis                -> DRiX
 *   A NEUTRAL third LLM (different from both generators) then acts as the target
 *   buyer and, BLIND to which is which and with A/B order counterbalanced, says
 *   which it would more likely respond to and scores each 1-10. We repeat J times
 *   per company and bootstrap a company-level DRiX win-rate + a likelihood-to-
 *   respond score lift.
 *
 *   This is an LLM-as-judge benchmark. It is an honest INTERNAL signal of whether
 *   DRiX's grounded output beats a strong vanilla baseline. It is NOT a real-world
 *   reply-rate or conversion forecast: the buyer is simulated. Lead with the
 *   50% / 25% haircut figures when communicating it, and say "blind LLM-judge
 *   win-rate", not "DRiX lifts replies by X%".
 *
 * WHERE IT POINTS:
 *   By default it targets your live production app:
 *       https://readyleads.getthedrix.com   (your Railway deployment)
 *   Override anytime with  BENCH_BASE_URL=https://some-other-host
 *   No local server needed. (Note: .env's APP_URL is a localhost dev value, so
 *   it is intentionally NOT used as the default here.)
 *
 * USAGE:
 *   node benchmark_drix.js --self-test        # offline: validates math + parsing + CSV, no network/cost
 *   node benchmark_drix.js --dry-run          # checks config + that the app is reachable, prints plan, no cost
 *   node benchmark_drix.js                     # LIVE run (incurs API cost) against the production app
 *   node benchmark_drix.js --export-csv        # rebuild benchmark_results.csv from existing JSON, no cost
 *   node benchmark_drix.js --scenario pitch --baseline claude --rounds 4
 *
 * PREREQS for a live run:
 *   1) The app is reachable (it is — readyleads.getthedrix.com). To point elsewhere:
 *      BENCH_BASE_URL=https://your-host node benchmark_drix.js
 *   2) OPENROUTER_API_KEY available (used for the judge). Your .env already has it.
 * ========================================================================== */

'use strict';
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Config (CLI overrides below) ───────────────────────────────────────────
const DEFAULT_APP_URL = 'https://readyleads.getthedrix.com'; // live production app (Railway)
const RAW_BASE   = process.env.BENCH_BASE_URL || DEFAULT_APP_URL;
const BASE_URL   = RAW_BASE.replace(/\/+$/, ''); // strip trailing slash so URL joins are clean
const JUDGE_MODEL= process.env.BENCH_JUDGE_MODEL || 'anthropic/claude-sonnet-4';
// ^ Neutral judge: NOT gpt-4o (standard side) and NOT the TDE synth model
//   (cerebras gpt-oss-120b / gemini-flash). Override via BENCH_JUDGE_MODEL.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const COMPANIES_FILE = path.join(__dirname, 'benchmark_companies.json');
const RESULTS_FILE   = path.join(__dirname, 'benchmark_results.json');
const RESULTS_CSV    = path.join(__dirname, 'benchmark_results.csv');

const DEFAULTS = {
  scenario: 'email',     // email | pitch | partnership
  baseline: 'chatgpt',   // chatgpt(gpt-4o) | gemini | claude  -> the model DRiX must beat
  rounds: 3,             // J: judge passes per company (order counterbalanced)
  bootstrap: 10000,
  cpp: 'steve',
  perCompanyTimeoutMs: 150000,
};

const SCORE_DIMS = ['relevance', 'specificity', 'credibility', 'likelihood_to_respond'];
const PRIMARY_DIM = 'likelihood_to_respond';

// ─── tiny arg parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { ...DEFAULTS, mode: 'live' };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--self-test') a.mode = 'self-test';
    else if (t === '--dry-run') a.mode = 'dry-run';
    else if (t === '--export-csv') a.mode = 'export-csv';
    else if (t === '--scenario') a.scenario = argv[++i];
    else if (t === '--baseline') a.baseline = argv[++i];
    else if (t === '--rounds') a.rounds = parseInt(argv[++i], 10);
    else if (t === '--bootstrap') a.bootstrap = parseInt(argv[++i], 10);
    else if (t === '--judge') a.judgeModel = argv[++i];
    else if (t === '--help' || t === '-h') a.mode = 'help';
  }
  return a;
}

// ─── stats helpers ────────────────────────────────────────────────────────────
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;

function bootstrapCI(values, nResamples, ci, rng) {
  // values: one number per company (e.g. that company's DRiX win fraction)
  const n = values.length, means = [];
  for (let r = 0; r < nResamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[(rng() * n) | 0];
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor((1 - ci) / 2 * nResamples)];
  const hi = means[Math.ceil((1 + ci) / 2 * nResamples) - 1];
  return [lo, hi];
}

// Deterministic RNG so reruns of the analysis are reproducible (seeded)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── SSE client for POST /api/comparison ───────────────────────────────────────
async function runComparison({ company_url, company_name }, scenario, baseline, cpp, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = {};
  try {
    const resp = await fetch(`${BASE_URL}/api/comparison`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ company_url, company_name, scenario, model: baseline, cpp }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = null, data = '';
        for (const ln of chunk.split('\n')) {
          if (ln.startsWith('event:')) ev = ln.slice(6).trim();
          else if (ln.startsWith('data:')) data += ln.slice(5).trim();
          // lines starting with ':' are keepalive comments — ignore
        }
        if (ev) { try { events[ev] = JSON.parse(data || '{}'); } catch { events[ev] = { _raw: data }; } }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const standard = events.standard_done?.text;
  const drix = events.tde_done?.text;
  if (!standard) throw new Error('standard side missing: ' + (events.standard_error?.message || 'no standard_done'));
  if (!drix) throw new Error('DRiX side missing: ' + (events.tde_error?.message || 'no tde_done'));
  return { standard, drix };
}

// ─── Blind judge (neutral model via OpenRouter) ─────────────────────────────────
function buildJudgePrompt(scenario, companyName, textA, textB) {
  const noun = scenario === 'partnership' ? 'partnership analysis'
             : scenario === 'pitch' ? 'sales pitch' : 'cold outreach email';
  return `You are a busy senior decision-maker at ${companyName}. Two different vendors sent you the ${noun} below (A and B). You do not know who wrote either one.

Judge them ONLY on substance from your seat as the buyer:
- relevance: how specifically it speaks to ${companyName}'s real situation
- specificity: concrete, verifiable details vs generic vendor filler
- credibility: would a sharp executive trust it, or does it feel like AI boilerplate
- likelihood_to_respond: how likely you are to actually reply

Ignore length, surface polish, and formatting. Do not favor whichever comes first. If they are close, still pick the one you would more likely respond to.

Return ONLY a JSON object, no markdown:
{"winner":"A"|"B","A":{"relevance":1-10,"specificity":1-10,"credibility":1-10,"likelihood_to_respond":1-10},"B":{"relevance":1-10,"specificity":1-10,"credibility":1-10,"likelihood_to_respond":1-10},"reason":"one sentence"}

=== ${noun.toUpperCase()} A ===
${textA}

=== ${noun.toUpperCase()} B ===
${textB}`;
}

function parseJudgeJSON(raw) {
  let s = (raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  const obj = JSON.parse(s);
  if (obj.winner !== 'A' && obj.winner !== 'B') throw new Error('judge winner not A/B');
  for (const side of ['A', 'B']) {
    if (!obj[side]) throw new Error('judge missing side ' + side);
    for (const d of SCORE_DIMS) {
      const v = Number(obj[side][d]);
      if (!(v >= 0 && v <= 10)) throw new Error(`judge ${side}.${d} out of range`);
      obj[side][d] = v;
    }
  }
  return obj;
}

async function judgeOnce(scenario, companyName, drixText, stdText, drixIsA, judgeModel) {
  const textA = drixIsA ? drixText : stdText;
  const textB = drixIsA ? stdText : drixText;
  const prompt = buildJudgePrompt(scenario, companyName, textA, textB);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'DRiX Benchmark Judge',
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`judge HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 160)}`);
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJudgeJSON(content);
    // Map A/B back to drix/standard
    const drixSide = drixIsA ? 'A' : 'B';
    const stdSide = drixIsA ? 'B' : 'A';
    return {
      drix_won: parsed.winner === drixSide,
      drix_scores: parsed[drixSide],
      std_scores: parsed[stdSide],
      drix_is_A: drixIsA,
      reason: parsed.reason || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Aggregation + report ───────────────────────────────────────────────────────
function summarize(companyResults, nBootstrap) {
  const rng = mulberry32(12345);
  const perCompanyWinFrac = [];     // company-level DRiX win fraction (over its judge passes)
  const perCompanyScoreLift = [];   // company-level mean (drix - std) on PRIMARY_DIM
  let decisionWins = 0, decisionTotal = 0;
  const allDrixLR = [], allStdLR = [];

  for (const c of companyResults) {
    const dec = c.decisions;
    if (!dec || !dec.length) continue;
    const wins = dec.filter(d => d.drix_won).length;
    perCompanyWinFrac.push(wins / dec.length);
    const drixLR = dec.map(d => d.drix_scores[PRIMARY_DIM]);
    const stdLR = dec.map(d => d.std_scores[PRIMARY_DIM]);
    perCompanyScoreLift.push(mean(drixLR) - mean(stdLR));
    allDrixLR.push(...drixLR); allStdLR.push(...stdLR);
    decisionWins += wins; decisionTotal += dec.length;
  }

  const winRate = mean(perCompanyWinFrac);
  const [wLo, wHi] = bootstrapCI(perCompanyWinFrac, nBootstrap, 0.95, rng);
  const scoreLift = mean(perCompanyScoreLift);
  const [sLo, sHi] = bootstrapCI(perCompanyScoreLift, nBootstrap, 0.95, mulberry32(54321));

  return {
    nCompanies: perCompanyWinFrac.length,
    decisionWins, decisionTotal,
    winRate, winRateCI: [wLo, wHi],
    edge: winRate - 0.5,
    scoreLift, scoreLiftCI: [sLo, sHi],
    drixLRmean: mean(allDrixLR), stdLRmean: mean(allStdLR),
    perCompanyWinFrac, perCompanyScoreLift,
  };
}

function printReport(s, cfg) {
  const pct = x => (x * 100).toFixed(1) + '%';
  const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
  console.log('\n' + '='.repeat(72));
  console.log('DRiX vs STANDARD-AI  —  BLIND LLM-JUDGE BENCHMARK');
  console.log(`scenario=${cfg.scenario}  baseline=${cfg.baseline}  judge=${cfg.judgeModel || JUDGE_MODEL}  rounds/company=${cfg.rounds}`);
  console.log('(Simulated buyer judging real product output — internal signal, NOT a reply-rate forecast)');
  console.log('='.repeat(72));
  console.log(`Companies scored:        ${s.nCompanies}`);
  console.log(`Judge decisions:         ${s.decisionTotal}  (DRiX won ${s.decisionWins})`);
  console.log('-'.repeat(72));
  console.log(`DRiX WIN-RATE:           ${pct(s.winRate)}   95% CI [${pct(s.winRateCI[0])}, ${pct(s.winRateCI[1])}]`);
  console.log(`  edge over 50/50:       ${f(s.edge * 100, 1)} pts`);
  console.log(`Likelihood-to-respond:   DRiX ${s.drixLRmean.toFixed(2)} vs Standard ${s.stdLRmean.toFixed(2)}  (0-10 scale)`);
  console.log(`  score lift:            ${f(s.scoreLift)}   95% CI [${f(s.scoreLiftCI[0])}, ${f(s.scoreLiftCI[1])}]`);
  console.log('-'.repeat(72));
  console.log('CONSERVATIVE HAIRCUTS (lead with these, not the raw figure):');
  console.log(`  win-rate edge   100%: ${pct(0.5 + s.edge)}   50%: ${pct(0.5 + s.edge * 0.5)}   25%: ${pct(0.5 + s.edge * 0.25)}`);
  console.log(`  score lift      100%: ${f(s.scoreLift)}    50%: ${f(s.scoreLift * 0.5)}    25%: ${f(s.scoreLift * 0.25)}`);
  console.log('='.repeat(72));
  console.log('REMINDER: "blind LLM-judge win-rate of DRiX vs ' + cfg.baseline + '", simulated buyer.');
  console.log('Frame externally as a directional internal benchmark, with the haircuts.');
  console.log('='.repeat(72));
  console.log(`\n>>> Suggested cell C29 (DRiX win-rate):           ${pct(s.winRate)}`);
  console.log(`>>> Alt cell C29 (likelihood-to-respond lift):    ${f(s.scoreLift)} of 10`);
}

// ─── CSV export (spreadsheet-friendly, one row per company + OVERALL) ────────────
function csvEsc(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const num = (v, d = 4) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : v;

function buildCSV(companyResults, summary) {
  const header = ['company_name', 'company_url', 'judge_passes', 'drix_wins', 'drix_win_rate'];
  for (const d of SCORE_DIMS) { header.push('drix_' + d, 'std_' + d); }
  header.push('likelihood_lift', 'win_rate_ci', 'lift_ci', 'error');

  const rows = [header];
  for (const c of (companyResults || [])) {
    const dec = c.decisions || [];
    const wins = dec.filter(d => d.drix_won).length;
    const row = [c.company_name, c.company_url, dec.length, wins, dec.length ? wins / dec.length : ''];
    for (const d of SCORE_DIMS) {
      row.push(dec.length ? mean(dec.map(x => x.drix_scores[d])) : '');
      row.push(dec.length ? mean(dec.map(x => x.std_scores[d])) : '');
    }
    const lift = dec.length ? (mean(dec.map(x => x.drix_scores[PRIMARY_DIM])) - mean(dec.map(x => x.std_scores[PRIMARY_DIM]))) : '';
    row.push(lift, '', '', c.error || '');
    rows.push(row);
  }

  if (summary) {
    const o = new Array(header.length).fill('');
    o[0] = 'OVERALL';
    o[2] = summary.decisionTotal;
    o[3] = summary.decisionWins;
    o[4] = summary.winRate;
    const di = header.indexOf('drix_' + PRIMARY_DIM), si = header.indexOf('std_' + PRIMARY_DIM);
    if (di >= 0) o[di] = summary.drixLRmean;
    if (si >= 0) o[si] = summary.stdLRmean;
    o[header.indexOf('likelihood_lift')] = summary.scoreLift;
    if (summary.winRateCI) o[header.indexOf('win_rate_ci')] = `${num(summary.winRateCI[0])} to ${num(summary.winRateCI[1])}`;
    if (summary.scoreLiftCI) o[header.indexOf('lift_ci')] = `${num(summary.scoreLiftCI[0])} to ${num(summary.scoreLiftCI[1])}`;
    rows.push(o);
  }

  return rows.map(r => r.map(v => csvEsc(num(v))).join(',')).join('\n') + '\n';
}

function writeCSV(companyResults, summary, file) {
  fs.writeFileSync(file, buildCSV(companyResults, summary));
}

// ─── self-test (offline) ────────────────────────────────────────────────────────
function selfTest() {
  console.log('SELF-TEST (offline, no network, no cost)\n');
  let ok = true;
  // 1) judge JSON parsing, including code-fence + prose wrappers
  const samples = [
    '{"winner":"A","A":{"relevance":8,"specificity":7,"credibility":8,"likelihood_to_respond":7},"B":{"relevance":5,"specificity":4,"credibility":5,"likelihood_to_respond":4},"reason":"A is specific"}',
    '```json\n{"winner":"B","A":{"relevance":3,"specificity":3,"credibility":4,"likelihood_to_respond":3},"B":{"relevance":9,"specificity":8,"credibility":8,"likelihood_to_respond":9},"reason":"B grounded"}\n```',
    'Sure! Here is my verdict: {"winner":"A","A":{"relevance":6,"specificity":6,"credibility":6,"likelihood_to_respond":6},"B":{"relevance":6,"specificity":5,"credibility":5,"likelihood_to_respond":5},"reason":"close"}',
  ];
  for (const raw of samples) {
    try { const p = parseJudgeJSON(raw); console.log('  parse OK ->', p.winner); }
    catch (e) { ok = false; console.log('  parse FAIL:', e.message); }
  }
  // 2) bad JSON should throw
  try { parseJudgeJSON('no json here'); ok = false; console.log('  FAIL: bad input did not throw'); }
  catch { console.log('  bad-input correctly rejected'); }

  // 3) bootstrap + summarize on synthetic decisions where DRiX clearly wins
  const rng = mulberry32(7);
  const companyResults = [];
  for (let c = 0; c < 12; c++) {
    const decisions = [];
    for (let j = 0; j < 3; j++) {
      const drixLR = 6 + rng() * 3, stdLR = 4 + rng() * 2;
      decisions.push({
        drix_won: drixLR > stdLR,
        drix_scores: { relevance: 7, specificity: 7, credibility: 7, likelihood_to_respond: drixLR },
        std_scores: { relevance: 5, specificity: 5, credibility: 5, likelihood_to_respond: stdLR },
        drix_is_A: j % 2 === 0, reason: 'synthetic',
      });
    }
    companyResults.push({ company_name: 'Test' + c, company_url: 'https://test' + c + '.com', decisions });
  }
  const s = summarize(companyResults, 2000);
  console.log(`\n  summarize -> winRate=${(s.winRate * 100).toFixed(1)}% CI[${(s.winRateCI[0] * 100).toFixed(1)},${(s.winRateCI[1] * 100).toFixed(1)}]  scoreLift=${s.scoreLift.toFixed(2)}`);
  if (!(s.winRate > 0.5 && s.scoreLift > 0)) { ok = false; console.log('  FAIL: expected DRiX-favoring synthetic result'); }
  if (!(s.winRateCI[0] <= s.winRate && s.winRate <= s.winRateCI[1])) { ok = false; console.log('  FAIL: CI does not bracket point estimate'); }

  // 4) CSV builder: header + 12 company rows + OVERALL row, rectangular
  const csv = buildCSV(companyResults, s);
  const lines = csv.trim().split('\n');
  const cols = lines[0].split(',').length;
  const allSameWidth = lines.every(l => l.split(',').length === cols);
  console.log(`  CSV -> ${lines.length} lines, ${cols} cols, OVERALL row present: ${/^OVERALL,/.test(lines[lines.length - 1])}`);
  if (lines.length !== 1 + 12 + 1) { ok = false; console.log('  FAIL: expected header + 12 + OVERALL rows'); }
  if (!allSameWidth) { ok = false; console.log('  FAIL: ragged CSV columns'); }
  if (!/^OVERALL,/.test(lines[lines.length - 1])) { ok = false; console.log('  FAIL: missing OVERALL row'); }
  try {
    const tmp = path.join(os.tmpdir(), 'drix_selftest_' + Date.now() + '.csv');
    writeCSV(companyResults, s, tmp);
    const back = fs.readFileSync(tmp, 'utf8');
    if (back.split('\n').filter(Boolean).length !== lines.length) { ok = false; console.log('  FAIL: written CSV line count mismatch'); }
    fs.unlinkSync(tmp);
    console.log('  CSV file write/read OK');
  } catch (e) { ok = false; console.log('  CSV file write FAIL:', e.message); }

  console.log('\n  default target BASE_URL =', BASE_URL);
  if (!/^https:\/\//.test(BASE_URL)) { ok = false; console.log('  FAIL: default target is not https production URL'); }

  printReport(s, { scenario: 'email', baseline: 'chatgpt', rounds: 3 });
  console.log('\nSELF-TEST ' + (ok ? 'PASSED' : 'FAILED'));
  process.exit(ok ? 0 : 1);
}

// ─── config / preflight ─────────────────────────────────────────────────────────
function loadCompanies() {
  if (!fs.existsSync(COMPANIES_FILE)) throw new Error('missing ' + COMPANIES_FILE);
  const data = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const list = data.companies || data;
  const bad = list.filter(c => !c.company_url || !c.company_name);
  if (bad.length) throw new Error('every company needs company_name + company_url');
  return list;
}

async function serverReachable() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${BASE_URL}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok || r.status === 404; // any HTTP answer means it's up
  } catch { return false; }
}

function printPlan(companies, cfg) {
  const judgeCalls = companies.length * cfg.rounds;
  console.log('PLAN');
  console.log(`  target app:      ${BASE_URL}`);
  console.log(`  scenario:        ${cfg.scenario}`);
  console.log(`  baseline (beat): ${cfg.baseline}`);
  console.log(`  judge model:     ${cfg.judgeModel || JUDGE_MODEL}`);
  console.log(`  companies:       ${companies.length}`);
  console.log(`  rounds/company:  ${cfg.rounds}`);
  console.log(`  COST ~ ${companies.length} comparison calls (each = 1 scrape + 2 LLM gens)`);
  console.log(`         + ${judgeCalls} judge LLM calls`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.mode === 'help') { console.log(fs.readFileSync(__filename, 'utf8').split('* =====')[1] || 'see header'); return; }
  if (cfg.mode === 'self-test') return selfTest();

  if (cfg.mode === 'export-csv') {
    if (!fs.existsSync(RESULTS_FILE)) throw new Error('no benchmark_results.json yet — run a live benchmark first.');
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    writeCSV(data.companies || [], data.summary, RESULTS_CSV);
    console.log('Wrote ' + RESULTS_CSV);
    return;
  }

  if (!['email', 'pitch', 'partnership'].includes(cfg.scenario)) throw new Error('bad --scenario');
  if (!['chatgpt', 'gemini', 'claude'].includes(cfg.baseline)) throw new Error('bad --baseline');
  const companies = loadCompanies();

  // Avoid self-preference bias: judge must not be the same model as the baseline generator.
  const BASELINE_MODEL_IDS = { chatgpt: 'openai/gpt-4o', gemini: 'google/gemini-2.5-flash', claude: 'anthropic/claude-sonnet-4' };
  let judgeModel = cfg.judgeModel || JUDGE_MODEL;
  if (judgeModel === BASELINE_MODEL_IDS[cfg.baseline]) {
    const alt = cfg.baseline === 'claude' ? 'openai/gpt-4o' : 'anthropic/claude-sonnet-4';
    console.log(`[note] judge (${judgeModel}) is the same model as the '${cfg.baseline}' baseline; switching judge to ${alt} to avoid self-preference bias.`);
    judgeModel = alt;
  }
  cfg.judgeModel = judgeModel;

  printPlan(companies, cfg);

  if (cfg.mode === 'dry-run') {
    if (!OPENROUTER_API_KEY) console.log('\n[dry-run] WARNING: OPENROUTER_API_KEY not set — judge would fail.');
    const up = await serverReachable();
    console.log(`\n[dry-run] app reachable at ${BASE_URL}: ${up ? 'YES' : 'NO (check the URL / that the app is up)'}`);
    console.log('[dry-run] no API calls made. Re-run without --dry-run to execute.');
    return;
  }

  // LIVE
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing — judge cannot run.');
  if (!(await serverReachable())) throw new Error(`App not reachable at ${BASE_URL}. Set BENCH_BASE_URL if your URL differs.`);
  console.log('\nLIVE RUN — this incurs API cost.\n');

  const companyResults = [];
  for (let ci = 0; ci < companies.length; ci++) {
    const co = companies[ci];
    process.stdout.write(`[${ci + 1}/${companies.length}] ${co.company_name} ... `);
    let pair;
    try {
      pair = await runComparison(co, cfg.scenario, cfg.baseline, cfg.cpp, cfg.perCompanyTimeoutMs);
    } catch (e) {
      console.log('SKIP (comparison failed: ' + e.message + ')');
      companyResults.push({ ...co, error: e.message, decisions: [] });
      continue;
    }
    const decisions = [];
    for (let j = 0; j < cfg.rounds; j++) {
      const drixIsA = j % 2 === 0; // counterbalance position across passes
      try {
        decisions.push(await judgeOnce(cfg.scenario, co.company_name, pair.drix, pair.standard, drixIsA, cfg.judgeModel));
      } catch (e) {
        console.log(`(judge pass ${j + 1} failed: ${e.message}) `);
      }
    }
    const wins = decisions.filter(d => d.drix_won).length;
    console.log(`DRiX ${wins}/${decisions.length}`);
    companyResults.push({ ...co, standard: pair.standard, drix: pair.drix, decisions });
  }

  const s = summarize(companyResults, cfg.bootstrap);
  printReport(s, cfg);

  const payload = {
    _meta: {
      generated_at: new Date().toISOString(),
      method: 'blind LLM-judge, position-counterbalanced; bootstrap over companies',
      simulated_buyer: true,
      base_url: BASE_URL, scenario: cfg.scenario, baseline: cfg.baseline,
      judge_model: judgeModel, rounds_per_company: cfg.rounds, bootstrap: cfg.bootstrap,
      note: 'Internal LLM-judge benchmark. Not a real-world reply-rate. Communicate with 50%/25% haircuts.',
    },
    summary: s,
    companies: companyResults,
  };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(payload, null, 2));
  writeCSV(companyResults, s, RESULTS_CSV);
  console.log(`\nFull results (every email + every judge verdict): ${RESULTS_FILE}`);
  console.log(`Spreadsheet-ready per-company CSV:                 ${RESULTS_CSV}`);
}

main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
