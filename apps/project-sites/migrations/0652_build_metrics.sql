-- 0652_build_metrics.sql (fire-60 — generation speed + cost north star)
-- ADDITIVE ONLY. One row per site-generation workflow run, written at terminal
-- outcome (published | error | halted) by src/services/build_metrics.ts.
-- Baseline reader: scripts/gen-baseline.mjs (p50/p95 total_ms + phase breakdown
-- + est_cost over last N builds). Instrumentation is fire-and-forget: a metrics
-- failure never blocks or fails a build.

CREATE TABLE IF NOT EXISTS build_metrics (
  -- Stable per-run id: the Workflow instance id (event.instanceId) — survives
  -- hibernation replays, unlike the per-wake traceId.
  build_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  org_id TEXT,
  -- ISO-8601. started_at = workflow event.timestamp (replay-stable).
  started_at TEXT NOT NULL,
  -- ISO-8601, NULL unless outcome='published'.
  published_at TEXT,
  -- Wall-clock ms from started_at to the terminal outcome.
  total_ms INTEGER,
  -- JSON {"collecting":ms,"imaging":ms,"generating":ms,"publishing":ms}.
  -- 'imaging' is 0 in the container pipeline (image gen rides inside the
  -- container build); the key is kept for status-machine compatibility.
  phase_ms TEXT,
  -- Worker-side LLM token totals (external_llm + in-workflow gateway calls).
  -- Container-internal Claude/DeepSeek tokens are NOT surfaced yet (the
  -- container reports elapsed seconds only) — est_cost_usd covers that via
  -- container minutes. See build_pricing.ts.
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  -- JSON {"<model>":{"calls":n,"tokens_in":n,"tokens_out":n}, ...}.
  model_calls TEXT,
  -- Token cost (build_pricing MODEL_PRICES_PER_MTOK) + container minutes cost.
  est_cost_usd REAL NOT NULL DEFAULT 0,
  -- Container build duration (finalStatus.elapsed * 1000), 0 when unknown.
  container_ms INTEGER NOT NULL DEFAULT 0,
  -- published | error | halted (logo-approval halts are deliberate non-failures).
  outcome TEXT NOT NULL DEFAULT 'error',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_build_metrics_site_started
  ON build_metrics(site_id, started_at);

CREATE INDEX IF NOT EXISTS idx_build_metrics_started
  ON build_metrics(started_at);

CREATE INDEX IF NOT EXISTS idx_build_metrics_outcome
  ON build_metrics(outcome, started_at);
