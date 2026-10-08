-- 0659 — make workflow_jobs CANCELLABLE: widen the status CHECK to add 'cancelled'
-- and add a `cancel_requested` flag a running workflow can honor.
--
-- The Automations panel's CANCEL mutation (POST /api/sites/:id/automations/:id/cancel,
-- libs/features/site_automations) marks a running/queued job `cancelled` and best-effort
-- terminates the CF Workflow instance. The original 0001 CHECK
-- (`status IN ('queued','running','success','failed')`) had no terminal 'cancelled' value,
-- so the cancel write would be REJECTED by SQLite (constraint failure) — we must not fake
-- success, so the schema has to allow the real terminal state.
--
-- `cancel_requested` lets a long-running instance (one the binding can't cleanly terminate
-- mid-step) poll + bail cooperatively: the handler sets it to 1 alongside the status flip,
-- and the workflow checks it between steps. Purely additive (DEFAULT 0 = old behavior).
--
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table (mirrors 0579's
-- rename-copy-drop). Schema, indexes, and column order are identical to 0001; only the
-- status CHECK is extended by 'cancelled' and the `cancel_requested` column is appended.
-- Written as a safe rename-copy-drop so it is correct regardless of row count.

DROP TABLE IF EXISTS workflow_jobs_new;

CREATE TABLE workflow_jobs_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  site_id TEXT REFERENCES sites(id),
  job_name TEXT NOT NULL,
  dedupe_key TEXT,
  payload_pointer TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  result_pointer TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

-- Column-list copy (the new `cancel_requested` takes its DEFAULT 0 for existing rows).
INSERT INTO workflow_jobs_new (
  id, org_id, site_id, job_name, dedupe_key, payload_pointer, status, attempt,
  max_attempts, started_at, completed_at, error_message, result_pointer,
  created_at, updated_at, deleted_at
)
SELECT
  id, org_id, site_id, job_name, dedupe_key, payload_pointer, status, attempt,
  max_attempts, started_at, completed_at, error_message, result_pointer,
  created_at, updated_at, deleted_at
FROM workflow_jobs;

DROP TABLE workflow_jobs;

ALTER TABLE workflow_jobs_new RENAME TO workflow_jobs;

-- Recreate the 0001 + 0005 indexes (identical).
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_org ON workflow_jobs (org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_status ON workflow_jobs (status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_dedupe ON workflow_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_site_id ON workflow_jobs (site_id);
