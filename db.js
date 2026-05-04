// db.js — PostgreSQL persistence for TDE runs
// Stores both summary (full JSON blob per run) and normalized detail tables
// (atoms, pains, strategies, hydration, discovery questions, emails, coaching).
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (err) => console.error('[db] Pool error:', err.message));
  }
  return pool;
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
async function initSchema() {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      -- Master run record with full JSON blob for quick retrieval
      CREATE TABLE IF NOT EXISTS runs (
        id              TEXT PRIMARY KEY,
        email           TEXT,
        sender_url      TEXT,
        solution_url    TEXT,
        customer_url    TEXT,
        industry        TEXT,
        subindustry     TEXT,
        region          TEXT,
        recipient_role  TEXT,
        individual_name TEXT,
        full_result     JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- Individual 9D-tagged atoms
      CREATE TABLE IF NOT EXISTS atoms (
        id          SERIAL PRIMARY KEY,
        run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
        source_role TEXT NOT NULL,
        claim       TEXT,
        type        TEXT,
        dimensions  JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Pain points (company / sub-industry / industry)
      CREATE TABLE IF NOT EXISTS pains (
        id                SERIAL PRIMARY KEY,
        run_id            TEXT REFERENCES runs(id) ON DELETE CASCADE,
        pain_group        TEXT NOT NULL,
        title             TEXT,
        description       TEXT,
        severity          TEXT,
        persona_primary   JSONB,
        persona_secondary JSONB,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );

      -- Sales strategies
      CREATE TABLE IF NOT EXISTS strategies (
        id            SERIAL PRIMARY KEY,
        run_id        TEXT REFERENCES runs(id) ON DELETE CASCADE,
        strategy_id   TEXT,
        title         TEXT,
        explanation   TEXT,
        target_persona TEXT,
        pain_anchor   TEXT,
        chosen        BOOLEAN DEFAULT FALSE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- Hydration results (one per strategy selection)
      CREATE TABLE IF NOT EXISTS hydrations (
        id              SERIAL PRIMARY KEY,
        run_id          TEXT REFERENCES runs(id) ON DELETE CASCADE,
        strategy_id     TEXT,
        strategy_title  TEXT,
        hydration_result JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- Discovery questions (normalized from hydration)
      CREATE TABLE IF NOT EXISTS discovery_questions (
        id                  SERIAL PRIMARY KEY,
        hydration_id        INTEGER REFERENCES hydrations(id) ON DELETE CASCADE,
        stage               TEXT,
        question            TEXT,
        purpose             TEXT,
        pain_it_targets     TEXT,
        tone_guidance       TEXT,
        positive_responses  JSONB,
        negative_responses  JSONB,
        unexpected_response JSONB,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );

      -- Email sequences (normalized from hydration)
      CREATE TABLE IF NOT EXISTS email_sequences (
        id            SERIAL PRIMARY KEY,
        hydration_id  INTEGER REFERENCES hydrations(id) ON DELETE CASCADE,
        step_number   INTEGER,
        label         TEXT,
        subject       TEXT,
        body          TEXT,
        send_day      TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- ClearSignals coaching analyses
      CREATE TABLE IF NOT EXISTS coaching_analyses (
        id              SERIAL PRIMARY KEY,
        run_id          TEXT REFERENCES runs(id) ON DELETE CASCADE,
        thread_excerpt  TEXT,
        analysis_result JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- Ingest cache: persists atom payloads across deploys (30-day TTL)
      CREATE TABLE IF NOT EXISTS ingest_cache (
        url         TEXT NOT NULL,
        role        TEXT NOT NULL,
        payload     JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (url, role)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_ingest_cache_ttl ON ingest_cache(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_atoms_run      ON atoms(run_id);
      CREATE INDEX IF NOT EXISTS idx_pains_run      ON pains(run_id);
      CREATE INDEX IF NOT EXISTS idx_strategies_run ON strategies(run_id);
      CREATE INDEX IF NOT EXISTS idx_hydrations_run ON hydrations(run_id);
      CREATE INDEX IF NOT EXISTS idx_dq_hydration   ON discovery_questions(hydration_id);
      CREATE INDEX IF NOT EXISTS idx_emails_hydration ON email_sequences(hydration_id);
      CREATE INDEX IF NOT EXISTS idx_coaching_run   ON coaching_analyses(run_id);
      CREATE INDEX IF NOT EXISTS idx_runs_email     ON runs(email);
      CREATE INDEX IF NOT EXISTS idx_runs_created   ON runs(created_at DESC);
    `);
    console.log('[db] Schema initialized');
  } catch (err) {
    console.error('[db] Schema init failed:', err.message);
  }
}

// ─── SAVE HELPERS ────────────────────────────────────────────────────────────

// Save after demo-flow completes (run + atoms + pains + strategies)
async function saveRun(runId, inputs, results) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert master run record
    await client.query(`
      INSERT INTO runs (id, email, sender_url, solution_url, customer_url,
                        industry, subindustry, region, recipient_role, individual_name, full_result)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET full_result = EXCLUDED.full_result
    `, [
      runId,
      inputs.email || null,
      inputs.sender_company_url || null,
      inputs.solution_url || null,
      inputs.customer_url || null,
      inputs.industry || null,
      inputs.subindustry || null,
      inputs.region || null,
      inputs.recipient_role || null,
      inputs.individual_name || null,
      JSON.stringify(results)
    ]);

    // 2. Insert atoms (sender, solution, customer)
    for (const role of ['sender', 'solution', 'customer']) {
      const entry = results[role];
      if (!entry?.atoms?.length) continue;
      const values = [];
      const params = [];
      let idx = 1;
      for (const atom of entry.atoms) {
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push(
          runId,
          role,
          atom.claim || null,
          atom.type || null,
          JSON.stringify({
            persona: atom.persona,
            buying_stage: atom.buying_stage,
            emotional_driver: atom.emotional_driver,
            evidence_type: atom.evidence_type,
            recency: atom.recency,
            economic_driver: atom.economic_driver,
            status_quo_pressure: atom.status_quo_pressure,
            industry: atom.industry
          })
        );
      }
      if (values.length) {
        await client.query(
          `INSERT INTO atoms (run_id, source_role, claim, type, dimensions) VALUES ${values.join(',')}`,
          params
        );
      }
    }

    // 3. Insert pain points
    for (const group of ['company_pain', 'subindustry_pain', 'industry_pain']) {
      const pains = results.pain_groups?.[group] || [];
      for (const pain of pains) {
        await client.query(`
          INSERT INTO pains (run_id, pain_group, title, description, severity, persona_primary, persona_secondary)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          runId,
          group,
          pain.title || null,
          pain.description || null,
          pain.severity || null,
          pain.persona_primary ? JSON.stringify(pain.persona_primary) : null,
          pain.persona_secondary ? JSON.stringify(pain.persona_secondary) : null
        ]);
      }
    }

    // 4. Insert strategies
    const strats = results.strategies?.strategies || [];
    for (const s of strats) {
      await client.query(`
        INSERT INTO strategies (run_id, strategy_id, title, explanation, target_persona, pain_anchor)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        runId,
        s.id || null,
        s.title || null,
        s.explanation || null,
        s.target_persona || null,
        s.pain_anchor || null
      ]);
    }

    await client.query('COMMIT');
    console.log(`[db] Run ${runId} saved (${strats.length} strategies, atoms + pains)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[db] saveRun failed:`, err.message);
  } finally {
    client.release();
  }
}

// Save after hydrate completes (hydration + discovery questions + emails)
async function saveHydration(runId, strategyId, strategyTitle, hydrationResult) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // Mark the chosen strategy
    await client.query(`
      UPDATE strategies SET chosen = TRUE WHERE run_id = $1 AND strategy_id = $2
    `, [runId, strategyId]);

    // Insert hydration record
    const hRes = await client.query(`
      INSERT INTO hydrations (run_id, strategy_id, strategy_title, hydration_result)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [runId, strategyId, strategyTitle, JSON.stringify(hydrationResult)]);
    const hydrationId = hRes.rows[0].id;

    // Insert discovery questions
    const questions = hydrationResult?.questions || [];
    for (const q of questions) {
      await client.query(`
        INSERT INTO discovery_questions
          (hydration_id, stage, question, purpose, pain_it_targets, tone_guidance,
           positive_responses, negative_responses, unexpected_response)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        hydrationId,
        q.stage || null,
        q.question || null,
        q.purpose || null,
        q.pain_it_targets || q.pain_point || null,
        q.tone_guidance || null,
        q.positive_responses ? JSON.stringify(q.positive_responses) : null,
        q.neutral_negative_responses ? JSON.stringify(q.neutral_negative_responses) : null,
        q.unexpected_response ? JSON.stringify(q.unexpected_response) :
          q.expected_answer_unexpected ? JSON.stringify({ response: q.expected_answer_unexpected }) : null
      ]);
    }

    // Insert email sequences
    const emails = hydrationResult?.emailCampaign || hydrationResult?.emailSequence || [];
    for (let i = 0; i < emails.length; i++) {
      const em = emails[i];
      await client.query(`
        INSERT INTO email_sequences (hydration_id, step_number, label, subject, body, send_day)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        hydrationId,
        em.step || i + 1,
        em.label || null,
        em.subject || em.subject_line || null,
        em.body || em.content || null,
        em.sendDay || null
      ]);
    }

    // Update the full_result blob on the run to include hydration
    await client.query(`
      UPDATE runs SET full_result = full_result || $1::jsonb WHERE id = $2
    `, [JSON.stringify({ hydration: hydrationResult, chosen_strategy: { id: strategyId, title: strategyTitle } }), runId]);

    await client.query('COMMIT');
    console.log(`[db] Hydration saved for run ${runId} (strategy: ${strategyId}, ${questions.length} questions, ${emails.length} emails)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[db] saveHydration failed:`, err.message);
  } finally {
    client.release();
  }
}

// Save after ClearSignals coaching analysis
async function saveCoaching(runId, threadText, analysisResult) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO coaching_analyses (run_id, thread_excerpt, analysis_result)
      VALUES ($1, $2, $3)
    `, [
      runId,
      (threadText || '').slice(0, 1000),  // store first 1000 chars as excerpt
      JSON.stringify(analysisResult)
    ]);

    // Also append to the run blob
    await p.query(`
      UPDATE runs SET full_result = full_result || $1::jsonb WHERE id = $2
    `, [JSON.stringify({ clearsignals_analysis: analysisResult }), runId]);

    console.log(`[db] Coaching analysis saved for run ${runId}`);
  } catch (err) {
    console.error(`[db] saveCoaching failed:`, err.message);
  }
}

// ─── INGEST CACHE (30-day TTL) ───────────────────────────────────────────────
// This is the REAL cache that persists across server restarts / deploys.
// Keyed by normalized URL + role. Returns full atom payload instantly.

const CACHE_TTL_DAYS = 30;

async function getCachedIngest(url, role) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      SELECT payload FROM ingest_cache
      WHERE url = $1 AND role = $2 AND created_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'
      ORDER BY created_at DESC LIMIT 1
    `, [url, role]);
    if (res.rows.length) return res.rows[0].payload;
    return null;
  } catch (err) {
    console.error('[db] getCachedIngest error:', err.message);
    return null;
  }
}

async function setCachedIngest(url, role, payload) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO ingest_cache (url, role, payload) VALUES ($1, $2, $3)
      ON CONFLICT (url, role) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()
    `, [url, role, JSON.stringify(payload)]);
  } catch (err) {
    console.error('[db] setCachedIngest error:', err.message);
  }
}

async function getCachedArchetype(industryKey) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      SELECT payload FROM ingest_cache
      WHERE url = $1 AND role = 'archetype' AND created_at > NOW() - INTERVAL '${CACHE_TTL_DAYS} days'
      ORDER BY created_at DESC LIMIT 1
    `, [industryKey]);
    if (res.rows.length) return res.rows[0].payload;
    return null;
  } catch (err) {
    console.error('[db] getCachedArchetype error:', err.message);
    return null;
  }
}

async function setCachedArchetype(industryKey, payload) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO ingest_cache (url, role, payload) VALUES ($1, 'archetype', $2)
      ON CONFLICT (url, role) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()
    `, [industryKey, JSON.stringify(payload)]);
  } catch (err) {
    console.error('[db] setCachedArchetype error:', err.message);
  }
}

// ─── QUERY HELPERS (for future use) ──────────────────────────────────────────

async function getRunsByEmail(email, limit = 20) {
  const p = getPool();
  if (!p) return [];
  const res = await p.query(
    `SELECT id, email, industry, region, created_at FROM runs WHERE email = $1 ORDER BY created_at DESC LIMIT $2`,
    [email, limit]
  );
  return res.rows;
}

async function getRunFull(runId) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
  return res.rows[0] || null;
}

function isConfigured() {
  return Boolean(DATABASE_URL);
}

module.exports = {
  initSchema,
  saveRun,
  saveHydration,
  saveCoaching,
  getRunsByEmail,
  getRunFull,
  getCachedIngest,
  setCachedIngest,
  getCachedArchetype,
  setCachedArchetype,
  isConfigured,
  getPool
};
