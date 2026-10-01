-- Migration 0519: Conversational editing changesets
--
-- Supports the conversational_editing feature module (idea #1):
-- natural-language site editing with reversible, parent-chained changesets.
-- Undo is forward-only — reverting creates a NEW 'reverted' changeset chained
-- to the original; history is never mutated.

CREATE TABLE IF NOT EXISTS site_changesets (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL,
  chat_id             TEXT,                  -- conversation this edit belongs to (nullable)
  created_by          TEXT,                  -- user_id who applied/reverted
  prompt              TEXT,                  -- natural-language edit request
  status              TEXT DEFAULT 'applied' -- 'applied' | 'reverted'
                        CHECK (status IN ('applied','reverted')),
  parent_changeset_id TEXT,                  -- previous changeset (or the reverted target)
  r2_bundle_key       TEXT,                  -- sites/{slug}/changesets/{id}/files.json
  revert_reason       TEXT,                  -- human-readable reason when status='reverted'
  applied_at          TEXT DEFAULT (datetime('now')),
  reverted_at         TEXT,                  -- stamped on the original when reverted
  deleted_at          TEXT
);

CREATE TABLE IF NOT EXISTS changeset_files (
  id           TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  before_hash  TEXT,                         -- sha256 of file content before the edit
  after_hash   TEXT,                         -- sha256 of file content after the edit
  op_kind      TEXT,                         -- 'replace' | 'insert' | 'delete'
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_changesets_site_id
  ON site_changesets(site_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_changeset_files_changeset_id
  ON changeset_files(changeset_id);

-- Feature flag seed (enabled=0, rollout=0, stage='experimental')
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_conversational_editing', NULL, 'conversational_editing', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Natural-language site editing with reversible, parent-chained changesets. Undo is forward-only; history is preserved.","owner_email":"brian@megabyte.space"}');
