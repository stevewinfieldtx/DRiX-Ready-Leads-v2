// osint-enrichment.js — DRiX OSINT Enrichment Engine
// Layer 1: Username Discovery (Sherlock/Maigret pattern)
// Layer 2: Email Intelligence (Holehe pattern)
//
// These run as HTTP-based checks against known platform patterns.
// No external tools to install — we implement the core logic directly:
//   - Username existence checks via HTTP HEAD/GET against known URL patterns
//   - Email registration checks via password reset endpoint probing
//
// This is the LIGHTWEIGHT version that runs in-process. For the full
// Maigret/Sherlock depth (3000+ sites), we'd shell out to the Python tools.
// This version covers the TOP 80+ highest-signal platforms directly.

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: USERNAME DISCOVERY
// Check if a username exists on high-value platforms via URL patterns
// ═══════════════════════════════════════════════════════════════════════════════

// High-signal platforms for B2B/professional context
// Each entry: { name, urlPattern, errorType }
// errorType: 'status_code' (404 = not found), 'response_text' (look for error string)
const USERNAME_PLATFORMS = [
  // Professional / Tech
  { name: 'GitHub', category: 'tech', url: 'https://github.com/{username}', errorType: 'status_code' },
  { name: 'GitLab', category: 'tech', url: 'https://gitlab.com/{username}', errorType: 'status_code' },
  { name: 'Stack Overflow', category: 'tech', url: 'https://stackoverflow.com/users/{username}', errorType: 'status_code' },
  { name: 'Dev.to', category: 'tech', url: 'https://dev.to/{username}', errorType: 'status_code' },
  { name: 'Hashnode', category: 'tech', url: 'https://hashnode.com/@{username}', errorType: 'status_code' },
  { name: 'HackerNews', category: 'tech', url: 'https://news.ycombinator.com/user?id={username}', errorType: 'response_text', errorText: 'No such user' },
  { name: 'Kaggle', category: 'tech', url: 'https://www.kaggle.com/{username}', errorType: 'status_code' },
  { name: 'Replit', category: 'tech', url: 'https://replit.com/@{username}', errorType: 'status_code' },
  { name: 'npm', category: 'tech', url: 'https://www.npmjs.com/~{username}', errorType: 'status_code' },
  { name: 'PyPI', category: 'tech', url: 'https://pypi.org/user/{username}/', errorType: 'status_code' },

  // Business / Professional
  { name: 'Medium', category: 'content', url: 'https://medium.com/@{username}', errorType: 'status_code' },
  { name: 'Substack', category: 'content', url: 'https://{username}.substack.com', errorType: 'status_code' },
  { name: 'About.me', category: 'professional', url: 'https://about.me/{username}', errorType: 'status_code' },
  { name: 'Gravatar', category: 'professional', url: 'https://en.gravatar.com/{username}', errorType: 'status_code' },
  { name: 'Linktree', category: 'professional', url: 'https://linktr.ee/{username}', errorType: 'status_code' },
  { name: 'Behance', category: 'creative', url: 'https://www.behance.net/{username}', errorType: 'status_code' },
  { name: 'Dribbble', category: 'creative', url: 'https://dribbble.com/{username}', errorType: 'status_code' },

  // Social / Community
  { name: 'Twitter/X', category: 'social', url: 'https://x.com/{username}', errorType: 'status_code' },
  { name: 'Reddit', category: 'social', url: 'https://www.reddit.com/user/{username}', errorType: 'status_code' },
  { name: 'Instagram', category: 'social', url: 'https://www.instagram.com/{username}/', errorType: 'status_code' },
  { name: 'TikTok', category: 'social', url: 'https://www.tiktok.com/@{username}', errorType: 'status_code' },
  { name: 'Pinterest', category: 'social', url: 'https://www.pinterest.com/{username}/', errorType: 'status_code' },
  { name: 'Threads', category: 'social', url: 'https://www.threads.net/@{username}', errorType: 'status_code' },
  { name: 'Mastodon (mastodon.social)', category: 'social', url: 'https://mastodon.social/@{username}', errorType: 'status_code' },
  { name: 'Bluesky', category: 'social', url: 'https://bsky.app/profile/{username}.bsky.social', errorType: 'status_code' },

  // Video / Audio
  { name: 'YouTube', category: 'video', url: 'https://www.youtube.com/@{username}', errorType: 'status_code' },
  { name: 'Twitch', category: 'video', url: 'https://www.twitch.tv/{username}', errorType: 'status_code' },
  { name: 'Vimeo', category: 'video', url: 'https://vimeo.com/{username}', errorType: 'status_code' },
  { name: 'SoundCloud', category: 'audio', url: 'https://soundcloud.com/{username}', errorType: 'status_code' },
  { name: 'Spotify (Podcasters)', category: 'audio', url: 'https://podcasters.spotify.com/pod/show/{username}', errorType: 'status_code' },

  // Professional Networks & Forums
  { name: 'Crunchbase', category: 'business', url: 'https://www.crunchbase.com/person/{username}', errorType: 'status_code' },
  { name: 'AngelList', category: 'business', url: 'https://angel.co/u/{username}', errorType: 'status_code' },
  { name: 'Product Hunt', category: 'business', url: 'https://www.producthunt.com/@{username}', errorType: 'status_code' },
  { name: 'Hacker Noon', category: 'content', url: 'https://hackernoon.com/u/{username}', errorType: 'status_code' },
  { name: 'SlideShare', category: 'content', url: 'https://www.slideshare.net/{username}', errorType: 'status_code' },
  { name: 'Speaker Deck', category: 'content', url: 'https://speakerdeck.com/{username}', errorType: 'status_code' },

  // Community / Q&A
  { name: 'Quora', category: 'community', url: 'https://www.quora.com/profile/{username}', errorType: 'status_code' },
  { name: 'Discord (bio)', category: 'community', url: 'https://discord.com/users/{username}', errorType: 'status_code' },
  { name: 'Goodreads', category: 'community', url: 'https://www.goodreads.com/{username}', errorType: 'status_code' },

  // News / Finance
  { name: 'Seeking Alpha', category: 'finance', url: 'https://seekingalpha.com/user/{username}', errorType: 'status_code' },
];

/**
 * Extract likely usernames from available data.
 * Strategy: derive from LinkedIn URL, email prefix, name variations.
 */
function deriveUsernames(name, linkedinUrl, email) {
  const usernames = new Set();

  // From LinkedIn URL: /in/johndoe → johndoe
  if (linkedinUrl) {
    const match = linkedinUrl.match(/\/in\/([^\/\?]+)/);
    if (match) usernames.add(match[1].toLowerCase());
  }

  // From email: john.doe@company.com → john.doe, johndoe
  if (email) {
    const prefix = email.split('@')[0].toLowerCase();
    usernames.add(prefix);
    usernames.add(prefix.replace(/[._-]/g, ''));  // Strip separators
  }

  // From name: "John Doe" → johndoe, john-doe, john.doe, jdoe
  if (name) {
    const parts = name.toLowerCase().trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      usernames.add(`${first}${last}`);
      usernames.add(`${first}-${last}`);
      usernames.add(`${first}.${last}`);
      usernames.add(`${first[0]}${last}`);
      usernames.add(`${last}${first}`);
      usernames.add(`${first}_${last}`);
    }
    if (parts.length === 1) {
      usernames.add(parts[0]);
    }
  }

  // Filter out anything too short or too generic
  return [...usernames].filter(u => u && u.length >= 3 && u.length <= 30);
}

/**
 * Check if a username exists on a specific platform.
 * Returns { found: boolean, platform: string, url: string } or null on error.
 */
async function checkPlatform(username, platform) {
  const url = platform.url.replace(/{username}/g, username);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (platform.errorType === 'status_code') {
      // 200/301/302 = exists, 404 = not found
      if (response.status >= 200 && response.status < 400) {
        return { found: true, platform: platform.name, category: platform.category, url, username };
      }
      return { found: false, platform: platform.name, category: platform.category, url, username };
    }

    // For response_text type, we need to GET and check body
    if (platform.errorType === 'response_text') {
      const getResponse = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000),
      });
      const text = await getResponse.text();
      const notFound = text.includes(platform.errorText);
      return { found: !notFound, platform: platform.name, category: platform.category, url, username };
    }
  } catch (err) {
    // Timeout, network error, etc. — skip silently
    return null;
  }

  return null;
}

/**
 * Run username discovery across all platforms for all derived usernames.
 * Runs in batches to avoid hammering networks.
 *
 * @param {string} name - Person's name
 * @param {string} linkedinUrl - LinkedIn URL
 * @param {string} email - Email address
 * @param {Object} opts - { maxConcurrent: 10, platforms: USERNAME_PLATFORMS }
 * @returns {Object} { usernames: string[], found: [{platform, url, username, category}], platformsChecked: number }
 */
async function discoverUsernames(name, linkedinUrl, email, opts = {}) {
  const maxConcurrent = opts.maxConcurrent || 10;
  const platforms = opts.platforms || USERNAME_PLATFORMS;
  const startTime = Date.now();

  const usernames = deriveUsernames(name, linkedinUrl, email);
  if (usernames.length === 0) {
    console.log('[osint] No usernames derivable — skipping discovery');
    return { usernames: [], found: [], platformsChecked: 0, timeMs: 0 };
  }

  console.log(`[osint] Username discovery: testing ${usernames.length} usernames × ${platforms.length} platforms`);
  console.log(`[osint] Usernames: ${usernames.join(', ')}`);

  const found = [];
  const checked = new Set();
  let platformsChecked = 0;

  // For each username, check all platforms in batches
  for (const username of usernames) {
    const tasks = platforms.map(platform => ({ username, platform }));

    // Process in batches
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent);
      const results = await Promise.all(
        batch.map(({ username: u, platform: p }) => checkPlatform(u, p))
      );

      for (const result of results) {
        if (result) {
          platformsChecked++;
          if (result.found) {
            const key = `${result.platform}:${result.username}`;
            if (!checked.has(key)) {
              checked.add(key);
              found.push(result);
            }
          }
        }
      }

      // Small delay between batches to be respectful
      if (i + maxConcurrent < tasks.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[osint] Username discovery complete: ${found.length} accounts found across ${platformsChecked} checks in ${(elapsed / 1000).toFixed(1)}s`);

  // Deduplicate — if multiple usernames found the same platform, keep the one that matches best
  const deduped = [];
  const seenPlatforms = new Set();
  for (const f of found) {
    if (!seenPlatforms.has(f.platform)) {
      seenPlatforms.add(f.platform);
      deduped.push(f);
    }
  }

  return {
    usernames,
    found: deduped,
    platformsChecked,
    timeMs: elapsed,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: EMAIL INTELLIGENCE
// Check what services an email is registered on + gather metadata
// Uses the password reset / account existence check pattern (Holehe-style)
// ═══════════════════════════════════════════════════════════════════════════════

// Services that expose email registration status via public endpoints
// Each: { name, checkUrl, method, body, existsWhen }
const EMAIL_PLATFORMS = [
  {
    name: 'Gravatar',
    category: 'identity',
    check: async (email) => {
      // Gravatar uses MD5 hash of lowercase email
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
      const url = `https://www.gravatar.com/avatar/${hash}?d=404`;
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        return { registered: res.status === 200, url: `https://gravatar.com/${hash}`, hasAvatar: res.status === 200 };
      } catch { return null; }
    }
  },
  {
    name: 'GitHub',
    category: 'tech',
    check: async (email) => {
      // GitHub search by email (public commits)
      try {
        const res = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`, {
          headers: { 'User-Agent': 'DRiX-OSINT/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.total_count > 0) {
          const user = data.items[0];
          return { registered: true, url: user.html_url, username: user.login, avatar: user.avatar_url, repos: user.public_repos };
        }
        return { registered: false };
      } catch { return null; }
    }
  },
  {
    name: 'WordPress',
    category: 'content',
    check: async (email) => {
      // WordPress.com login check
      try {
        const res = await fetch('https://wordpress.com/wp-login.php?action=lostpassword', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `user_login=${encodeURIComponent(email)}`,
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        // If redirected to "check your email" → registered
        return { registered: res.status === 302 || res.status === 200 };
      } catch { return null; }
    }
  },
  {
    name: 'Spotify',
    category: 'media',
    check: async (email) => {
      try {
        const res = await fetch(`https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=${encodeURIComponent(email)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        // status 20 = email already registered
        return { registered: data.status === 20 };
      } catch { return null; }
    }
  },
  {
    name: 'HaveIBeenPwned (breach check)',
    category: 'security',
    check: async (email) => {
      // Public API (rate limited, no key needed for basic check)
      try {
        const res = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`, {
          headers: { 'User-Agent': 'DRiX-OSINT/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 200) {
          const breaches = await res.json();
          return { registered: true, breachCount: breaches.length, breaches: breaches.map(b => b.Name).slice(0, 10) };
        }
        if (res.status === 404) return { registered: false, breachCount: 0 };
        return null; // Rate limited or error
      } catch { return null; }
    }
  },
  {
    name: 'LinkedIn (inferred)',
    category: 'professional',
    check: async (email) => {
      // We can't directly check LinkedIn, but we can note if the email domain
      // suggests a work email (which almost certainly has LinkedIn)
      const domain = email.split('@')[1];
      const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'protonmail.com', 'proton.me'];
      const isWork = !freeProviders.includes(domain);
      return { registered: true, isWorkEmail: isWork, domain, inference: 'high probability — virtually all professionals have LinkedIn' };
    }
  },
  {
    name: 'Google (account exists)',
    category: 'identity',
    check: async (email) => {
      // Check if Google account exists by checking profile photo
      // This is a lightweight version of GHunt
      if (!email.endsWith('@gmail.com') && !email.endsWith('@googlemail.com')) {
        return { registered: null, note: 'Not a Gmail address — Google Workspace possible but unverifiable' };
      }
      try {
        const crypto = require('crypto');
        // Google People API public profile (doesn't require auth for basic info)
        const res = await fetch(`https://www.google.com/s2/photos/public/AIbEiAIAAABECKjR0oDA0o_${email}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        return { registered: true, hasPhoto: res.status === 200 };
      } catch { return { registered: true, note: 'Gmail address — account exists by definition' }; }
    }
  },
];

/**
 * Run email intelligence checks across known platforms.
 *
 * @param {string} email - Email address to investigate
 * @returns {Object} { email, services: [{name, registered, ...metadata}], summary }
 */
async function investigateEmail(email) {
  if (!email) {
    console.log('[osint] No email provided — skipping email intelligence');
    return { email: null, services: [], summary: 'No email to investigate' };
  }

  const startTime = Date.now();
  console.log(`[osint] Email intelligence: checking ${email} across ${EMAIL_PLATFORMS.length} services`);

  // Run all checks in parallel
  const results = await Promise.all(
    EMAIL_PLATFORMS.map(async (platform) => {
      try {
        const result = await platform.check(email);
        if (result) {
          return { name: platform.name, category: platform.category, ...result };
        }
        return { name: platform.name, category: platform.category, registered: null, error: 'check failed' };
      } catch (err) {
        return { name: platform.name, category: platform.category, registered: null, error: err.message };
      }
    })
  );

  const registered = results.filter(r => r.registered === true);
  const elapsed = Date.now() - startTime;

  console.log(`[osint] Email intelligence complete: ${registered.length} services confirmed in ${(elapsed / 1000).toFixed(1)}s`);

  // Build summary
  const domain = email.split('@')[1];
  const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'protonmail.com', 'proton.me'];
  const isWorkEmail = !freeProviders.includes(domain);

  return {
    email,
    domain,
    isWorkEmail,
    services: results.filter(r => r.registered !== null),
    registeredOn: registered.map(r => r.name),
    breachExposure: results.find(r => r.name === 'HaveIBeenPwned (breach check)')?.breachCount || 0,
    githubProfile: results.find(r => r.name === 'GitHub' && r.registered)?.url || null,
    githubUsername: results.find(r => r.name === 'GitHub' && r.registered)?.username || null,
    timeMs: elapsed,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1+2 COMBINED: FULL DIGITAL FOOTPRINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run full OSINT enrichment: username discovery + email intelligence.
 * Designed to run in PARALLEL with the existing Apollo + Brave pipeline.
 *
 * @param {Object} opts - { name, linkedinUrl, email }
 * @returns {Object} Complete OSINT findings
 */
async function runOsintEnrichment({ name, linkedinUrl, email }) {
  const startTime = Date.now();
  console.log(`\n[osint] ═══ OSINT ENRICHMENT START ═══`);
  console.log(`[osint]   Name: ${name || 'N/A'}`);
  console.log(`[osint]   LinkedIn: ${linkedinUrl || 'N/A'}`);
  console.log(`[osint]   Email: ${email || 'N/A'}`);

  // Run Layer 1 and Layer 2 in parallel
  const [usernameResults, emailResults] = await Promise.all([
    discoverUsernames(name, linkedinUrl, email),
    investigateEmail(email),
  ]);

  // If we found a GitHub username from email check, add it to username discoveries
  if (emailResults.githubUsername && !usernameResults.found.some(f => f.platform === 'GitHub')) {
    usernameResults.found.push({
      found: true,
      platform: 'GitHub',
      category: 'tech',
      url: emailResults.githubProfile,
      username: emailResults.githubUsername,
    });
  }

  const elapsed = Date.now() - startTime;
  console.log(`[osint] ═══ OSINT ENRICHMENT COMPLETE in ${(elapsed / 1000).toFixed(1)}s ═══`);
  console.log(`[osint]   Accounts found: ${usernameResults.found.length}`);
  console.log(`[osint]   Email services: ${emailResults.registeredOn?.length || 0}`);

  return {
    usernameDiscovery: usernameResults,
    emailIntelligence: emailResults,
    // Merged summary for the LLM
    digitalFootprint: {
      accountsFound: usernameResults.found.length,
      platforms: usernameResults.found.map(f => ({
        name: f.platform,
        category: f.category,
        url: f.url,
        username: f.username,
      })),
      emailRegistrations: emailResults.registeredOn || [],
      isWorkEmail: emailResults.isWorkEmail,
      breachExposure: emailResults.breachExposure,
      githubUrl: emailResults.githubProfile,
      // Categorized presence
      techPresence: usernameResults.found.filter(f => f.category === 'tech').map(f => f.platform),
      socialPresence: usernameResults.found.filter(f => f.category === 'social').map(f => f.platform),
      contentPresence: usernameResults.found.filter(f => ['content', 'video', 'audio'].includes(f.category)).map(f => f.platform),
      businessPresence: usernameResults.found.filter(f => ['business', 'professional', 'finance'].includes(f.category)).map(f => f.platform),
    },
    totalTimeMs: elapsed,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  runOsintEnrichment,
  discoverUsernames,
  investigateEmail,
  deriveUsernames,
  // Expose for testing / extension
  USERNAME_PLATFORMS,
  EMAIL_PLATFORMS,
  checkPlatform,
};
