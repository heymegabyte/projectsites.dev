-- 0644_data_query_history.sql
--
-- Per-site D1 query history (Data & Resource Platform — PHASED-PLAN "query history").
-- Records the STATEMENT TEMPLATE of every `exec`/`explain` run against a customer's OWN
-- dedicated per-site D1, so the editor's Data tab + the MCP can surface "recent queries".
--
-- CRITICAL isolation + privacy (SECURITY-INVARIANTS):
--  - This table lives in the SHARED PLATFORM D1 (env.DB), org+site-scoped — NEVER in the
--    customer's own per-site D1 (no pollution of customer data, no cross-tenant leakage).
--  - `sql_text` stores the STATEMENT TEMPLATE ONLY (the SQL string with its `?` placeholders).
--    Bound parameter VALUES are NEVER persisted — they are the customer's data and may be
--    sensitive (PII, secrets). Only the template + D1's execution meta are recorded.
--  - Recording is FIRE-AND-FORGET / best-effort: a failure to log NEVER blocks or fails the
--    query the customer actually asked for.
--
-- Additive + append-only. `id` is a UUIDv7 (time-ordered) minted by the Worker.

CREATE TABLE IF NOT EXISTS data_query_history (
  id             TEXT PRIMARY KEY NOT NULL,           -- UUIDv7 (Worker-minted, time-ordered)
  site_id        TEXT NOT NULL,                        -- the OWNED site whose per-site D1 was queried
  org_id         TEXT NOT NULL,                        -- authed org (scoping + isolation)
  environment    TEXT NOT NULL DEFAULT 'production',   -- 'preview' | 'production'
  statement_kind TEXT NOT NULL DEFAULT 'unknown',      -- read_only | mutating | destructive | unknown
  sql_text       TEXT NOT NULL,                        -- STATEMENT TEMPLATE ONLY — never param VALUES
  duration_ms    INTEGER,                              -- D1-reported query wall-time (ms), when present
  rows_read      INTEGER,                              -- D1-reported rows read, when present
  rows_written   INTEGER,                              -- D1-reported rows written, when present
  ok             INTEGER NOT NULL DEFAULT 1,           -- 1 = succeeded, 0 = failed
  error_code     TEXT,                                 -- typed error code when ok = 0
  created_at     TEXT NOT NULL                          -- ISO 8601 timestamp of execution
);

-- Newest-first reads for one site+environment (the "recent history" query pattern).
CREATE INDEX IF NOT EXISTS idx_data_query_history_site_env_created
  ON data_query_history (site_id, environment, created_at DESC);
