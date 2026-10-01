-- Migration 0509: Content freshness rewrite drafts
--
-- Supports feature #16: Content Freshness Cron.
-- Daily cron scans sections idle >90d with low RUM dwell, queues
-- AI rewrites, owner approves in task inbox and admin UI.

CREATE TABLE IF NOT EXISTS content_rewrite_drafts (
  id                 TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id             TEXT NOT NULL,
  section_key        TEXT NOT NULL,          -- e.g. "hero", "services-intro"
  section_html_orig  TEXT,                   -- snapshot of original HTML (≤16KB)
  section_html_draft TEXT,                   -- AI-rewritten HTML
  brand_voice_hash   TEXT,                   -- sha256 of _brand.json at rewrite time
  dwell_seconds_avg  REAL,                   -- RUM median dwell at scan time
  last_rewrite_at    TEXT,                   -- ISO-8601 of previous rewrite (may be NULL)
  idle_days          INTEGER NOT NULL,       -- days since last_rewrite_at
  ai_model           TEXT,                   -- model used for draft
  ai_tokens_used     INTEGER,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','published')),
  approved_by        TEXT,                   -- user_id or 'auto'
  approved_at        TEXT,
  published_at       TEXT,
  task_inbox_id      TEXT,                   -- foreign ref to ai_task_inbox.id
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_crd_site_status
  ON content_rewrite_drafts(site_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crd_org_pending
  ON content_rewrite_drafts(org_id, status, created_at)
  WHERE deleted_at IS NULL AND status = 'pending';

-- Feature flag seed (enabled=0, rollout=0, stage='experimental')
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_content_freshness', NULL, 'content_freshness', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Daily cron rewrites site sections idle >90d with low dwell via Workers AI. Owner approves drafts in /admin/content-freshness.","owner_email":"brian@megabyte.space"}');
