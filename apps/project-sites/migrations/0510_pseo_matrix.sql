-- Migration 0510: pSEO matrix pages
--
-- Supports feature #17: pSEO Matrix Builder.
-- service × city × intent × season generator with thin-content guardrail.

CREATE TABLE IF NOT EXISTS pseo_pages (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  service         TEXT NOT NULL,            -- e.g. "plumbing"
  city            TEXT NOT NULL,            -- e.g. "Newark"
  intent          TEXT NOT NULL             -- 'price'|'how-to'|'diagnostic'|'emergency'
                    CHECK (intent IN ('price','how-to','diagnostic','emergency')),
  season          TEXT NOT NULL             -- 'spring'|'summer'|'fall'|'winter'|'all'
                    CHECK (season IN ('spring','summer','fall','winter','all')),
  route_slug      TEXT NOT NULL,            -- computed: /c/{city}/{service}-{intent}[-{season}]
  html_content    TEXT,                     -- generated HTML (stored for diff/approval)
  word_count      INTEGER,
  image_count     INTEGER,
  internal_links  INTEGER,
  has_local_biz_jsonld INTEGER NOT NULL DEFAULT 0,
  slop_hits       INTEGER NOT NULL DEFAULT 0,  -- banned-word occurrences found
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','published','rejected')),
  published_at    TEXT,
  r2_path         TEXT,                     -- R2 key after publish
  ai_model        TEXT,
  ai_tokens_used  INTEGER,
  thin_content    INTEGER NOT NULL DEFAULT 0,  -- 1 = failed ≥800-word guardrail
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pseo_route
  ON pseo_pages(site_id, service, city, intent, season)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pseo_site_status
  ON pseo_pages(site_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pseo_org
  ON pseo_pages(org_id, status, created_at)
  WHERE deleted_at IS NULL;

-- Feature flag seed (enabled=0, rollout=0, stage='experimental')
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_pseo_matrix_builder', NULL, 'pseo_matrix_builder', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"pSEO matrix builder: generates service×city×intent×season pages per site. Admin promotes from /admin/pseo.","owner_email":"brian@megabyte.space"}');
