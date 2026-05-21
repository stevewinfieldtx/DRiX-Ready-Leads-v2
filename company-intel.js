// company-intel.js — DRiX Company Intelligence Engine
//
// Enriches any customer entity AFTER basic URL ingest, BEFORE pain/strategy generation.
// Adds six intelligence layers that the basic website scrape cannot provide:
//
//   Layer 1: Email Security Posture  — DNS/MX/DMARC/SPF fingerprinting
//   Layer 2: Financial Intelligence  — FDIC (banks), SEC EDGAR (public cos), web fallback
//   Layer 3: Tech Stack Signals      — header/DNS-derived stack beyond BuiltWith
//   Layer 4: Org Signals             — job postings, recent hires, role gaps
//   Layer 5: Buying Committee        — 5 likely roles + Apollo name resolution
//   Layer 6: Deal Signal Synthesis   — LLM synthesis of all layers into ranked signals
//
// Usage in server.js:
//   const { enrichCompany } = require('./company-intel');
//   const intel = await enrichCompany(domain, { solutionCategory, industry, apolloKey, braveKey, openRouterKey, modelId });
//   // intel.atoms → merge into customer atoms before pain/strategy generation
//   // intel.emailSecurity, intel.financial, etc. → available for UI display
//
// All functions are defensive — every layer gracefully degrades if an API key
// is missing or a lookup fails. The caller always gets a result; it just may
// be thinner. Never throws.

'use strict';

const dns = require('dns').promises;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// Known email security providers identifiable from MX hostnames
const EMAIL_PROVIDERS = [
  { pattern: /protection\.outlook\.com/i,   name: 'Microsoft 365 / EOP',    secure: 'basic',    vendor: 'microsoft' },
  { pattern: /google\.com/i,                name: 'Google Workspace',        secure: 'basic',    vendor: 'google' },
  { pattern: /mimecast\.com/i,              name: 'Mimecast',                secure: 'advanced', vendor: 'mimecast' },
  { pattern: /proofpoint\.com/i,            name: 'Proofpoint',              secure: 'advanced', vendor: 'proofpoint' },
  { pattern: /barracuda\.com/i,             name: 'Barracuda',               secure: 'advanced', vendor: 'barracuda' },
  { pattern: /trustifi/i,                   name: 'Trustifi',                secure: 'advanced', vendor: 'trustifi' },
  { pattern: /mxlogic/i,                    name: 'McAfee MXLogic',          secure: 'advanced', vendor: 'mcafee' },
  { pattern: /ppe\.hostedemail\.com/i,      name: 'Proofpoint Essentials',   secure: 'advanced', vendor: 'proofpoint' },
  { pattern: /messagelabs\.com/i,           name: 'Symantec Email Security', secure: 'advanced', vendor: 'broadcom' },
  { pattern: /trendmicro\.com/i,            name: 'Trend Micro',             secure: 'advanced', vendor: 'trendmicro' },
  { pattern: /sophos\.com/i,               name: 'Sophos Email',            secure: 'advanced', vendor: 'sophos' },
  { pattern: /cisco\.com/i,                name: 'Cisco Email Security',    secure: 'advanced', vendor: 'cisco' },
  { pattern: /spamtitan/i,                  name: 'SpamTitan',               secure: 'advanced', vendor: 'titanhq' },
  { pattern: /forcepoint\.com/i,            name: 'Forcepoint Email',        secure: 'advanced', vendor: 'forcepoint' },
  { pattern: /mailchannels\.net/i,          name: 'MailChannels',            secure: 'basic',    vendor: 'mailchannels' },
  { pattern: /sendgrid\.net/i,              name: 'SendGrid (outbound only)', secure: 'none',    vendor: 'sendgrid' },
];

const DMARC_POLICY_LABELS = {
  none:        { label: 'MONITORING ONLY — not enforcing', risk: 'critical', color: 'red' },
  quarantine:  { label: 'Quarantine — partial enforcement', risk: 'medium',   color: 'yellow' },
  reject:      { label: 'Reject — fully enforced',          risk: 'low',      color: 'green' },
  missing:     { label: 'NO DMARC RECORD',                  risk: 'critical', color: 'red' },
};

// ─── LAYER 1: EMAIL SECURITY POSTURE ─────────────────────────────────────────

/**
 * Resolve MX records and identify email security provider.
 * Uses Node's built-in dns module — no external dependencies.
 */
async function lookupMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return records.map(r => ({ priority: r.priority, exchange: r.exchange }));
  } catch (err) {
    console.log(`[company-intel] MX lookup failed for ${domain}: ${err.message}`);
    return [];
  }
}

async function lookupTXT(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    return records.map(r => r.join('')); // TXT records can be split into chunks
  } catch {
    return [];
  }
}

async function lookupDMARC(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    return records.map(r => r.join(''))[0] || null;
  } catch {
    return null;
  }
}

async function lookupAutodiscover(domain) {
  try {
    const cname = await dns.resolveCname(`autodiscover.${domain}`);
    return cname[0] || null;
  } catch {
    return null;
  }
}

/**
 * Full email security fingerprint for a domain.
 * Returns structured intel about email vendor, DMARC posture, and attack surface.
 */
async function getEmailSecurityPosture(domain) {
  console.log(`[company-intel] Email security fingerprint: ${domain}`);

  const [mxRecords, txtRecords, dmarcRaw, autodiscover] = await Promise.all([
    lookupMX(domain),
    lookupTXT(domain),
    lookupDMARC(domain),
    lookupAutodiscover(domain),
  ]);

  // Identify primary email provider from MX
  let provider = { name: 'Unknown', secure: 'unknown', vendor: 'unknown' };
  const primaryMX = mxRecords[0]?.exchange || '';
  for (const ep of EMAIL_PROVIDERS) {
    if (ep.pattern.test(primaryMX)) {
      provider = ep;
      break;
    }
  }

  // Parse DMARC policy
  let dmarcPolicy = 'missing';
  let dmarcAlertEmail = null;
  if (dmarcRaw) {
    const policyMatch = dmarcRaw.match(/p=(\w+)/i);
    if (policyMatch) dmarcPolicy = policyMatch[1].toLowerCase();
    const ruaMatch = dmarcRaw.match(/rua=mailto:([^\s;]+)/i);
    if (ruaMatch) dmarcAlertEmail = ruaMatch[1];
  }

  // Parse SPF
  const spfRecord = txtRecords.find(r => r.startsWith('v=spf1')) || null;
  const spfStrict = spfRecord ? (spfRecord.includes('-all') ? 'strict' : spfRecord.includes('~all') ? 'softfail' : 'permissive') : 'missing';

  // M365 confirmation
  const isM365 = /outlook\.com/i.test(primaryMX) || /outlook\.com/i.test(autodiscover || '');

  // Security gap assessment
  const hasAdvancedSecurity = provider.secure === 'advanced';
  const dmarcInfo = DMARC_POLICY_LABELS[dmarcPolicy] || DMARC_POLICY_LABELS.missing;
  const isVulnerable = dmarcPolicy === 'none' || dmarcPolicy === 'missing' || !hasAdvancedSecurity;

  // Competitive context for solution pitching
  const incumbentVendor = hasAdvancedSecurity ? provider.vendor : null;
  const isGreenfield = !hasAdvancedSecurity; // No advanced security to displace

  console.log(`[company-intel] Email: provider=${provider.name}, dmarc=${dmarcPolicy}, greenfield=${isGreenfield}`);

  return {
    domain,
    mx: mxRecords,
    primaryMX,
    provider: provider.name,
    providerVendor: provider.vendor,
    securityLevel: provider.secure,
    dmarc: dmarcRaw,
    dmarcPolicy,
    dmarcRisk: dmarcInfo.risk,
    dmarcLabel: dmarcInfo.label,
    dmarcAlertEmail,
    spf: spfRecord,
    spfStrict,
    autodiscover,
    isM365,
    isGreenfield,
    incumbentVendor,
    isVulnerable,
    findings: buildEmailFindings(provider, dmarcPolicy, dmarcInfo, isM365, spfStrict),
  };
}

function buildEmailFindings(provider, dmarcPolicy, dmarcInfo, isM365, spfStrict) {
  const findings = [];

  if (dmarcPolicy === 'missing') {
    findings.push({ severity: 'CRITICAL', label: 'No DMARC Record', detail: 'Domain has zero DMARC protection. Anyone can spoof this domain with no detection mechanism in place.' });
  } else if (dmarcPolicy === 'none') {
    findings.push({ severity: 'CRITICAL', label: `DMARC p=none — ${dmarcInfo.label}`, detail: 'DMARC is monitoring only. Spoofed emails impersonating this domain are NOT quarantined or rejected. Direct BEC/phishing vulnerability.' });
  } else if (dmarcPolicy === 'quarantine') {
    findings.push({ severity: 'MEDIUM', label: 'DMARC p=quarantine — partial enforcement', detail: 'DMARC sends suspicious emails to spam. Not all mail clients enforce this. Full reject is best practice.' });
  }

  if (provider.secure === 'basic' || provider.secure === 'none') {
    findings.push({ severity: 'HIGH', label: `${provider.name} — Basic Protection Only`, detail: `MX points only to ${provider.name}. No dedicated advanced email security layer detected. Sophisticated BEC and encrypted malware bypass basic filters.` });
  }

  if (isM365 && provider.secure === 'basic') {
    findings.push({ severity: 'HIGH', label: 'M365 Greenfield — No Overlay Security', detail: 'Microsoft 365 confirmed via DNS. M365 is the #1 targeted platform for BEC attacks. EOP alone is insufficient for regulated industries.' });
  }

  if (spfStrict === 'permissive' || spfStrict === 'missing') {
    findings.push({ severity: 'MEDIUM', label: `SPF ${spfStrict === 'missing' ? 'Missing' : 'Permissive (+all)'}`, detail: 'SPF record does not strictly limit authorized senders, increasing spoofing risk.' });
  }

  return findings;
}


// ─── LAYER 2: FINANCIAL INTELLIGENCE ─────────────────────────────────────────

/**
 * Detect if the company is a bank and pull FDIC Call Report data.
 * Uses the free FDIC BankFind API — no key required.
 */
async function getFDICData(companyName) {
  try {
    // Search by name
    // FDIC BankFind API — use filters= with NAME contains search
    // Strip legal suffixes for better matching ("Bank and Trust" → "North Dallas Bank")
    const searchName = companyName
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .replace(/\b(and Trust|Trust Co|Trust Company|National Association|NA|Corp|Inc|LLC|Co)\b/gi, '')
      .trim();
    const url = `https://banks.data.fdic.gov/api/institutions?filters=NAME%3A${encodeURIComponent(searchName)}&fields=NAME,CERT,ASSET,NETINC,REPDTE,CITY,STALP,ACTIVE,ESTYMD,EQ,DEP,INTINC,NONII,NONIX,EFFICIENCYRATE,ROA,NIM,LVRATIO&limit=3&sort_by=ASSET&sort_order=DESC&output=json`;
    
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DRiX-CompanyIntel/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const institutions = data?.data || [];
    if (institutions.length === 0) return null;

    // Take the largest matching institution
    const inst = institutions[0]?.data;
    if (!inst) return null;

    console.log(`[company-intel] FDIC match: ${inst.NAME} | CERT: ${inst.CERT} | Assets: $${(inst.ASSET/1000).toFixed(1)}B`);

    return {
      source: 'fdic',
      isBank: true,
      name: inst.NAME,
      certNumber: inst.CERT,
      city: inst.CITY,
      state: inst.STALP,
      founded: inst.ESTYMD ? inst.ESTYMD.substring(0, 4) : null,
      totalAssets: inst.ASSET ? inst.ASSET * 1000 : null, // FDIC reports in thousands
      totalDeposits: inst.DEP ? inst.DEP * 1000 : null,
      equity: inst.EQ ? inst.EQ * 1000 : null,
      netIncome: inst.NETINC ? inst.NETINC * 1000 : null,
      interestIncome: inst.INTINC ? inst.INTINC * 1000 : null,
      nonInterestExpense: inst.NONIX ? inst.NONIX * 1000 : null,
      efficiencyRatio: inst.EFFICIENCYRATE || null,
      roa: inst.ROA || null,
      nim: inst.NIM || null,
      leverageRatio: inst.LVRATIO || null,
      reportDate: inst.REPDTE,
      regulatoryFlags: buildBankFlags(inst),
    };
  } catch (err) {
    console.log(`[company-intel] FDIC lookup failed: ${err.message}`);
    return null;
  }
}

function buildBankFlags(inst) {
  const flags = [];
  if (inst.EFFICIENCYRATE && inst.EFFICIENCYRATE > 75) {
    flags.push({ severity: 'major', label: `Efficiency Ratio ${inst.EFFICIENCYRATE.toFixed(1)}%`, detail: 'Above 75% threshold — cost pressure. Every vendor spend needs ROI justification or compliance mandate.' });
  }
  if (inst.ROA && inst.ROA < 0.5) {
    flags.push({ severity: 'major', label: `ROA ${inst.ROA.toFixed(2)}%`, detail: 'Below 0.5% floor — profitability under pressure. Frame solution as risk avoidance cost, not technology investment.' });
  }
  if (inst.NIM && inst.NIM < 2.5) {
    flags.push({ severity: 'minor', label: `NIM ${inst.NIM.toFixed(2)}%`, detail: 'Net interest margin compressed. Bank may be squeezing non-interest expenses.' });
  }
  return flags;
}

/**
 * Look up SEC EDGAR filings for a public company.
 * Works for any publicly-traded company — not just banks.
 */
async function getSECData(companyName) {
  try {
    // EDGAR full-text search
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(companyName)}%22&dateRange=custom&startdt=${new Date().getFullYear() - 2}-01-01&forms=10-K,10-Q,8-K&hits.hits._source=period_of_report,file_date,form_type,display_names,biz_location`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DRiX-CompanyIntel/1.0 contact@nyniimpact.com' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hits = data?.hits?.hits || [];
    if (hits.length === 0) return null;

    // Extract key filing metadata
    const filings = hits.slice(0, 5).map(h => ({
      form: h._source?.form_type,
      date: h._source?.file_date,
      period: h._source?.period_of_report,
      company: h._source?.display_names?.[0],
    }));

    const latestAnnual = filings.find(f => f.form === '10-K');
    const latestQuarterly = filings.find(f => f.form === '10-Q');
    const recentEvents = filings.filter(f => f.form === '8-K');

    console.log(`[company-intel] SEC EDGAR: ${filings.length} filings found, latest 10-K: ${latestAnnual?.date || 'none'}`);

    return {
      source: 'sec',
      isPublic: true,
      latestAnnualReport: latestAnnual,
      latestQuarterlyReport: latestQuarterly,
      recentEvents: recentEvents.slice(0, 3),
      filings,
    };
  } catch (err) {
    console.log(`[company-intel] SEC EDGAR lookup failed: ${err.message}`);
    return null;
  }
}


// ─── LAYER 3: TECH STACK SIGNALS ─────────────────────────────────────────────

/**
 * Lightweight tech stack detection from HTTP headers and DNS patterns.
 * Complements Firecrawl-based content scraping without requiring another API key.
 */
async function getTechStackSignals(domain) {
  const signals = [];

  try {
    // Fetch homepage headers
    const res = await fetch(`https://${domain}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DRiX/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });

    const headers = Object.fromEntries(res.headers.entries());

    // Server technology
    if (headers['x-powered-by']) signals.push({ name: headers['x-powered-by'], category: 'server', source: 'header' });
    if (headers['server']) signals.push({ name: headers['server'], category: 'server', source: 'header' });

    // Cloud providers from headers
    if (headers['cf-ray']) signals.push({ name: 'Cloudflare CDN', category: 'infrastructure', source: 'header' });
    if (headers['x-amz-cf-id'] || headers['x-amz-request-id']) signals.push({ name: 'AWS', category: 'infrastructure', source: 'header' });
    if (headers['x-azure-ref'] || headers['x-ms-request-id']) signals.push({ name: 'Microsoft Azure', category: 'infrastructure', source: 'header' });
    if (headers['x-goog-backend-server-latency'] || headers['x-guploader-uploadid']) signals.push({ name: 'Google Cloud', category: 'infrastructure', source: 'header' });
    if (headers['x-vercel-id']) signals.push({ name: 'Vercel', category: 'infrastructure', source: 'header' });
    if (headers['x-netlify-id'] || headers['server']?.includes('Netlify')) signals.push({ name: 'Netlify', category: 'infrastructure', source: 'header' });
    if (headers['x-shopify-stage'] || headers['x-sorting-hat-shopid']) signals.push({ name: 'Shopify', category: 'ecommerce', source: 'header' });

    // CMS
    if (headers['x-wp-total'] || headers['x-wp-totalpages']) signals.push({ name: 'WordPress', category: 'cms', source: 'header' });
    if (headers['x-drupal-cache'] || headers['x-generator']?.includes('Drupal')) signals.push({ name: 'Drupal', category: 'cms', source: 'header' });
    if (headers['x-ghost-cache-status']) signals.push({ name: 'Ghost CMS', category: 'cms', source: 'header' });

    // Security headers (absence is a signal too)
    const hasHSTS = !!headers['strict-transport-security'];
    const hasCSP = !!headers['content-security-policy'];
    const hasXFrame = !!headers['x-frame-options'];
    if (!hasHSTS) signals.push({ name: 'Missing HSTS', category: 'security_gap', source: 'header' });
    if (!hasCSP) signals.push({ name: 'Missing CSP', category: 'security_gap', source: 'header' });

    console.log(`[company-intel] Tech stack signals: ${signals.length} detected from headers`);
  } catch (err) {
    console.log(`[company-intel] Header inspection failed for ${domain}: ${err.message}`);
  }

  // DNS-based stack signals
  try {
    // Check for common SaaS DNS patterns
    const checks = [
      { subdomain: 'mail', hint: 'Email server exists' },
      { subdomain: 'mail.protection.outlook', hint: 'Microsoft 365 confirmed' },
      { subdomain: 'em', hint: 'Possible SendGrid/marketing email' },
      { subdomain: 'go', hint: 'Possible marketing automation (Marketo/Pardot pattern)' },
    ];

    for (const check of checks) {
      try {
        await dns.resolve(`${check.subdomain}.${domain}`);
        signals.push({ name: check.hint, category: 'dns_signal', source: 'dns' });
      } catch { /* not found = no signal */ }
    }
  } catch { /* ignore DNS errors */ }

  return signals;
}


// ─── LAYER 4: ORG SIGNALS ────────────────────────────────────────────────────

/**
 * Search for job postings, recent hires, and org-level signals using Brave.
 * Job postings reveal: tech stack they need, roles they're filling (gaps),
 * investment direction, and budget signals.
 */
async function getOrgSignals(companyName, domain, braveApiKey) {
  if (!braveApiKey) {
    console.log('[company-intel] No BRAVE_API_KEY — skipping org signals');
    return { openRoles: [], hireSignals: [], newsSignals: [], jobPostings: [] };
  }

  const braveSearch = async (query) => {
    try {
      const params = new URLSearchParams({ q: query, count: '8', mkt: 'en-US', safesearch: 'off' });
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'X-Subscription-Token': braveApiKey, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.web?.results || []).map(r => ({ title: r.title, url: r.url, description: r.description || '' }));
    } catch { return []; }
  };

  console.log(`[company-intel] Org signals research: ${companyName}`);

  const [jobResults, hireResults, newsResults, financeResults] = await Promise.all([
    braveSearch(`"${companyName}" job openings hiring 2025 2026 security technology`),
    braveSearch(`"${companyName}" announces hires appoints new 2025 2026`),
    braveSearch(`"${companyName}" news announcement 2025 2026`),
    braveSearch(`"${companyName}" earnings revenue financial results 2025`),
  ]);

  // Parse job signals
  const jobPostings = jobResults
    .filter(r => /indeed|glassdoor|linkedin|career|job|hire/i.test(r.url))
    .slice(0, 5)
    .map(r => ({
      title: r.title.replace(/\s*[-|]\s*.*$/, '').trim(),
      url: r.url,
      snippet: r.description.slice(0, 150),
    }));

  // Extract role signals from job titles
  const openRoles = jobPostings.map(j => {
    const title = j.title;
    const dept = inferDepartment(title);
    const signal = inferJobSignal(title);
    return { title, dept, signal, url: j.url };
  }).filter(r => r.signal);

  // Recent hire signals
  const hireSignals = hireResults
    .filter(r => /hires|appoints|joins|welcomes|promoted/i.test(r.title))
    .slice(0, 4)
    .map(r => ({ headline: r.title, url: r.url, snippet: r.description.slice(0, 120) }));

  // News signals
  const newsSignals = newsResults
    .slice(0, 5)
    .map(r => ({ headline: r.title, url: r.url, snippet: r.description.slice(0, 120) }));

  // Finance signals
  const financeSignals = financeResults
    .slice(0, 3)
    .map(r => ({ headline: r.title, url: r.url, snippet: r.description.slice(0, 150) }));

  console.log(`[company-intel] Org signals: ${openRoles.length} role signals, ${hireSignals.length} hire signals, ${newsSignals.length} news items`);

  return { openRoles, hireSignals, newsSignals, financeSignals, jobPostings };
}

function inferDepartment(title) {
  const t = title.toLowerCase();
  if (/security|ciso|infosec|cyber|soc/i.test(t)) return 'Security';
  if (/it|infrastructure|network|sysadmin|cloud|devops|architect/i.test(t)) return 'IT';
  if (/cio|cto|vp.*tech|chief.*tech/i.test(t)) return 'Technology Leadership';
  if (/compliance|audit|risk|bsa|aml/i.test(t)) return 'Compliance';
  if (/finance|cfo|accounting|treasury/i.test(t)) return 'Finance';
  if (/marketing|content|brand/i.test(t)) return 'Marketing';
  if (/sales|business dev|account/i.test(t)) return 'Sales';
  if (/operations|ops|manager/i.test(t)) return 'Operations';
  return 'General';
}

function inferJobSignal(title) {
  const t = title.toLowerCase();
  if (/information security officer|iso$/i.test(t)) return 'Building dedicated security function — security buying authority being created';
  if (/ciso|chief.*security/i.test(t)) return 'Elevating security to C-suite — major security investment cycle incoming';
  if (/security analyst|security engineer/i.test(t)) return 'Growing security team — budget allocated for security tooling';
  if (/cloud architect|cloud engineer/i.test(t)) return 'Cloud migration in progress — new attack surface being created';
  if (/compliance officer|risk officer/i.test(t)) return 'Compliance investment — regulatory pressure driving spend';
  if (/cio|chief information/i.test(t)) return 'CIO role open or transitioning — security priorities may be reshaping';
  if (/it.*manager|infrastructure manager/i.test(t)) return 'IT leadership gap — potential evaluation cycle for tools and vendors';
  if (/helpdesk|it support/i.test(t)) return 'IT team growing — expanding user base and email footprint';
  return null;
}


// ─── LAYER 5: BUYING COMMITTEE ────────────────────────────────────────────────

/**
 * Generate the 5 most likely buying committee roles for a given
 * company type + solution category + industry vertical.
 * Uses LLM for role generation, then Apollo for name resolution.
 */
async function getBuyingCommittee(companyName, domain, industry, solutionCategory, orgSignals, openRouterKey, modelId, apolloKey) {
  // ── Role Generation (LLM) ──
  let roles = [];
  if (openRouterKey) {
    try {
      const prompt = buildCommitteePrompt(companyName, industry, solutionCategory, orgSignals);
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://drix.nyniimpact.com',
          'X-Title': 'DRiX Company Intel',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash', // Fast model for structured committee generation
          messages: [
            { role: 'system', content: 'You generate structured buying committee intelligence. Return JSON only, no markdown.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 1200,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content.replace(/^```json\n?|```$/g, '').trim());
          roles = parsed.committee || [];
          console.log(`[company-intel] Buying committee: ${roles.length} roles generated`);
        }
      }
    } catch (err) {
      console.log(`[company-intel] Committee LLM call failed: ${err.message}`);
    }
  }

  // ── Name Resolution (Apollo) ──
  let identified = [];
  if (apolloKey && domain && roles.length > 0) {
    identified = await resolveCommitteeNamesApollo(domain, roles, apolloKey);
  }

  return { roles, identified };
}

function buildCommitteePrompt(companyName, industry, solutionCategory, orgSignals) {
  const roleHints = orgSignals?.openRoles?.map(r => r.title).join(', ') || 'none detected';
  const hireHints = orgSignals?.hireSignals?.map(h => h.headline).slice(0, 3).join(' | ') || 'none detected';

  return `You are a B2B sales intelligence engine. Generate the 5 most likely BUYING COMMITTEE MEMBERS for the following situation.

COMPANY: ${companyName}
INDUSTRY: ${industry || 'Unknown'}
SOLUTION BEING SOLD: ${solutionCategory || 'Technology/Software'}
OPEN ROLES DETECTED: ${roleHints}
RECENT HIRES/SIGNALS: ${hireHints}

TASK: Identify the 5 roles most likely to be involved in an evaluation and purchase of "${solutionCategory}" at this type of company in the ${industry} industry. For each role:

1. Title — the specific job title (not generic)
2. Role in deal — Economic Buyer | Technical Evaluator | Champion | End User | Approver | Gatekeeper
3. Priority — 1 (first contact) to 5 (last/budget approval)
4. Hot button — the ONE thing this person cares most about regarding the solution (10 words max)
5. Likely objection — the most likely pushback from this role (10 words max)
6. Pitch angle — how to frame the solution for this specific role (1 sentence)
7. Email format guess — based on company domain ${companyName.split(' ')[0].toLowerCase()}

OUTPUT (JSON only):
{
  "committee": [
    {
      "priority": 1,
      "title": "<specific job title>",
      "role_in_deal": "<one of the role types above>",
      "hot_button": "<10 words max>",
      "likely_objection": "<10 words max>",
      "pitch_angle": "<1 sentence>",
      "email_guess": "<first.last@domain.com pattern>"
    }
  ]
}

RULES:
- Rank by who you should contact FIRST (priority 1) to last (priority 5)
- Base roles on the actual industry and solution — a bank buying email security has different roles than a manufacturer buying ERP
- If org signals suggest a specific role is open or recently hired, weight that role higher
- Never assign the same role twice
- Exactly 5 roles`;
}

async function resolveCommitteeNamesApollo(domain, roles, apolloKey) {
  const identified = [];

  try {
    // Apollo People Search by domain + title
    for (const role of roles.slice(0, 3)) { // Top 3 roles only to limit API calls
      try {
        const searchBody = {
          q_organization_domains: [domain],
          person_titles: [role.title],
          page: 1,
          per_page: 3,
        };

        const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apolloKey,
          },
          body: JSON.stringify(searchBody),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) continue;
        const data = await res.json();
        const people = data?.people || [];

        for (const person of people.slice(0, 1)) {
          identified.push({
            name: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
            title: person.title || role.title,
            email: person.email || null,
            linkedinUrl: person.linkedin_url || null,
            confidence: person.email ? 90 : 70,
            source: 'apollo',
            roleInDeal: role.role_in_deal,
            priority: role.priority,
            hotButton: role.hot_button,
          });
        }

        // Rate limit courtesy
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.log(`[company-intel] Apollo role lookup failed for "${role.title}": ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[company-intel] Apollo committee resolution failed: ${err.message}`);
  }

  console.log(`[company-intel] Apollo resolved ${identified.length} names for buying committee`);
  return identified;
}


// ─── LAYER 6: DEAL SIGNAL SYNTHESIS ──────────────────────────────────────────

/**
 * LLM synthesis pass — takes all raw intel and generates ranked deal signals,
 * regulatory compliance hooks, and a one-paragraph account summary.
 */
async function synthesizeDealSignals(companyName, emailSecurity, financial, techStack, orgSignals, solutionCategory, openRouterKey, modelId) {
  if (!openRouterKey) {
    return { signals: [], complianceHooks: [], accountSummary: '', atoms: [] };
  }

  const prompt = buildSynthesisPrompt(companyName, emailSecurity, financial, techStack, orgSignals, solutionCategory);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://drix.nyniimpact.com',
        'X-Title': 'DRiX Company Intel',
      },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: 'You are a B2B sales intelligence synthesizer. Return JSON only.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response');

    const parsed = JSON.parse(content.replace(/^```json\n?|```$/g, '').trim());
    console.log(`[company-intel] Synthesis: ${parsed.signals?.length || 0} deal signals, ${parsed.atoms?.length || 0} atoms`);
    return parsed;
  } catch (err) {
    console.log(`[company-intel] Synthesis LLM failed: ${err.message}`);
    return { signals: [], complianceHooks: [], accountSummary: '', atoms: [] };
  }
}

function buildSynthesisPrompt(companyName, emailSecurity, financial, techStack, orgSignals, solutionCategory) {
  return `You are synthesizing B2B sales intelligence into actionable deal signals and TDE atoms.

COMPANY: ${companyName}
SOLUTION BEING SOLD: ${solutionCategory || 'Technology/Software'}

═══ EMAIL SECURITY POSTURE ═══
MX Provider: ${emailSecurity?.provider || 'Unknown'}
Security Level: ${emailSecurity?.securityLevel || 'unknown'}
DMARC Policy: ${emailSecurity?.dmarcPolicy || 'unknown'} — ${emailSecurity?.dmarcLabel || ''}
M365 Confirmed: ${emailSecurity?.isM365 || false}
Greenfield (no competing vendor): ${emailSecurity?.isGreenfield || false}
Critical Findings: ${emailSecurity?.findings?.map(f => f.label).join(' | ') || 'none'}

═══ FINANCIAL INTELLIGENCE ═══
${financial ? JSON.stringify(financial, null, 2) : 'Not available'}

═══ TECH STACK SIGNALS ═══
${techStack?.map(s => `${s.name} (${s.category})`).join(', ') || 'Not available'}

═══ ORG SIGNALS ═══
Open Roles: ${orgSignals?.openRoles?.map(r => r.title).join(', ') || 'none'}
Recent Hires: ${orgSignals?.hireSignals?.map(h => h.headline).join(' | ') || 'none'}
Recent News: ${orgSignals?.newsSignals?.map(n => n.headline).join(' | ') || 'none'}

═══ TASK ═══

Produce THREE outputs:

1. DEAL SIGNALS (6-10 ranked by urgency):
Each signal has: type (CRITICAL|HIGH|MEDIUM|LOW), label (5-8 words), detail (1 sentence explaining sales relevance), category (email_security|financial|technology|org|regulatory|competitive)

2. COMPLIANCE HOOKS (3-5):
Regulatory or compliance reasons why the solution purchase is non-discretionary spend.
Format: { law, requirement, pitch_angle }

3. ACCOUNT SUMMARY (2-3 sentences):
Crisp account brief a rep reads in 15 seconds before a call.

4. TDE ATOMS (10-20):
Convert the highest-value intel findings into TDE-format atoms. Each atom:
{
  "atom_id": "ci-<kebab>",
  "type": "buying_trigger|weakness|stack_signal|mission_gap|proof_point",
  "claim": "<one clear sentence>",
  "evidence": "<paraphrase of the raw intel, max 20 words>",
  "tags": ["<3-5 tags>"],
  "confidence": "high|medium|low",
  "d_persona": "<Executive/C-Suite|CFO/Finance|CISO/Security|CTO/IT|VP Sales|VP Marketing|Operations|Practitioner|End User|General>",
  "d_buying_stage": "<Awareness|Interest|Evaluation|Decision|Retention|Advocacy>",
  "d_emotional_driver": "<Fear/Risk|Aspiration/Growth|Validation/Proof|Curiosity|Trust/Credibility|Urgency|FOMO>",
  "d_evidence_type": "<Statistic/Data|Case Study|Analyst Report|Customer Quote|Framework/Model|Anecdote/Story|Expert Opinion|Product Demo|Comparison|Definition>",
  "d_credibility": 1-5,
  "d_recency": "<Current Quarter|This Year|Last 1-2 Years|Dated (3-5yr)|Evergreen>",
  "d_economic_driver": "<ROI|Cost-Out|Speed|Quality|Growth|Risk-Reduction|None>",
  "d_status_quo_pressure": "<Sunk Cost|Change Fatigue|Risk Aversion|Political Cost|Procedural Gravity|No Forcing Function|Counter-Inertia|None>",
  "d_industry": { "naics": "<sector>", "sic": "<division>" }
}

Focus atoms on BUYING TRIGGERS and WEAKNESSES — these are what drive the sales conversation.

OUTPUT (JSON only):
{
  "signals": [ { "type": "...", "label": "...", "detail": "...", "category": "..." } ],
  "complianceHooks": [ { "law": "...", "requirement": "...", "pitch_angle": "..." } ],
  "accountSummary": "...",
  "atoms": [ { atom } ]
}`;
}


// ─── MAIN EXPORT: enrichCompany ───────────────────────────────────────────────

/**
 * Full company intelligence enrichment pipeline.
 *
 * @param {string} domain - Company domain (e.g. 'ndbt.com')
 * @param {string} companyName - Company name (e.g. 'North Dallas Bank & Trust')
 * @param {Object} opts
 *   @param {string} opts.solutionCategory - What's being sold (e.g. 'email security')
 *   @param {string} opts.industry - Industry/vertical (e.g. 'Community Banking')
 *   @param {string} opts.apolloKey - Apollo API key (optional)
 *   @param {string} opts.braveKey - Brave Search API key (optional)
 *   @param {string} opts.openRouterKey - OpenRouter API key (required for LLM layers)
 *   @param {string} opts.modelId - LLM model ID (optional, defaults to claude-sonnet)
 * @returns {Object} Full intelligence package — never throws
 */
async function enrichCompany(domain, companyName, opts = {}) {
  const { solutionCategory, industry, apolloKey, braveKey, openRouterKey, modelId } = opts;
  const startTime = Date.now();

  console.log(`\n[company-intel] ═══ ENRICHMENT START: ${companyName} (${domain}) ═══`);
  console.log(`[company-intel] Solution: ${solutionCategory || 'unspecified'} | Industry: ${industry || 'unspecified'}`);

  // ── Run Layers 1-4 in Parallel ──────────────────────────────────────────
  const [emailSecurity, fdic, sec, techStack, orgSignals] = await Promise.all([
    getEmailSecurityPosture(domain).catch(e => { console.log(`[company-intel] Layer 1 failed: ${e.message}`); return null; }),
    getFDICData(companyName).catch(e => { console.log(`[company-intel] FDIC failed: ${e.message}`); return null; }),
    getSECData(companyName).catch(e => { console.log(`[company-intel] SEC failed: ${e.message}`); return null; }),
    getTechStackSignals(domain).catch(e => { console.log(`[company-intel] Layer 3 failed: ${e.message}`); return []; }),
    getOrgSignals(companyName, domain, braveKey).catch(e => { console.log(`[company-intel] Layer 4 failed: ${e.message}`); return {}; }),
  ]);

  // Merge financial data (FDIC takes precedence for banks, SEC for public cos)
  const financial = fdic || sec || null;

  // ── Layer 5: Buying Committee (sequential — needs org signals) ──────────
  const buyingCommittee = await getBuyingCommittee(
    companyName, domain, industry, solutionCategory,
    orgSignals, openRouterKey, modelId, apolloKey
  ).catch(e => { console.log(`[company-intel] Layer 5 failed: ${e.message}`); return { roles: [], identified: [] }; });

  // ── Layer 6: Synthesis (sequential — needs all previous layers) ─────────
  const synthesis = await synthesizeDealSignals(
    companyName, emailSecurity, financial, techStack, orgSignals,
    solutionCategory, openRouterKey, modelId
  ).catch(e => { console.log(`[company-intel] Layer 6 failed: ${e.message}`); return { signals: [], complianceHooks: [], accountSummary: '', atoms: [] }; });

  const elapsed = Date.now() - startTime;
  console.log(`[company-intel] ═══ ENRICHMENT COMPLETE in ${(elapsed / 1000).toFixed(1)}s ═══`);
  console.log(`[company-intel] Email: ${emailSecurity?.provider || 'unknown'} | DMARC: ${emailSecurity?.dmarcPolicy || 'unknown'} | Greenfield: ${emailSecurity?.isGreenfield}`);
  console.log(`[company-intel] Financial: ${financial?.source || 'none'} | Signals: ${synthesis?.signals?.length || 0} | Atoms: ${synthesis?.atoms?.length || 0}`);

  return {
    // Metadata
    domain,
    companyName,
    enrichedAt: new Date().toISOString(),
    elapsedMs: elapsed,

    // Layer 1
    emailSecurity,

    // Layer 2
    financial,

    // Layer 3
    techStack,

    // Layer 4
    orgSignals,

    // Layer 5
    buyingCommittee,

    // Layer 6
    dealSignals: synthesis?.signals || [],
    complianceHooks: synthesis?.complianceHooks || [],
    accountSummary: synthesis?.accountSummary || '',

    // TDE-ready atoms — merge these into the customer atoms before pain/strategy generation
    // These are 9D-tagged and ready to drop straight into the existing atom store
    intelAtoms: synthesis?.atoms || [],

    // Convenience flags for UI
    isGreenfield: emailSecurity?.isGreenfield ?? null,
    isBankRegulated: !!fdic,
    isPubliclyTraded: !!sec,
    hasAdvancedEmailSecurity: emailSecurity?.securityLevel === 'advanced',
    criticalFindings: [
      ...(emailSecurity?.findings?.filter(f => f.severity === 'CRITICAL') || []),
      ...(financial?.regulatoryFlags?.filter(f => f.severity === 'major') || []),
    ],
  };
}

// ─── UTILITY: Extract domain from URL ────────────────────────────────────────

/**
 * Extract clean domain from a URL.
 * Handles https://www.example.com/path → example.com
 */
function extractDomain(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    // Fallback: strip common prefixes
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  enrichCompany,
  extractDomain,
  // Layer exports for testing / partial use
  getEmailSecurityPosture,
  getFDICData,
  getSECData,
  getTechStackSignals,
  getOrgSignals,
  getBuyingCommittee,
  synthesizeDealSignals,
};
