-- Migration 0520: pSEO Matrix v2 (post-March-2026, user-task-keyed)
--
-- Supports feature #29 — pSEO Matrix v2.
--
-- Distinct from v1 (pseo_pages, axes = service × city × intent × season).
-- v2 stores axes as a flexible JSON blob (axes_json on pseo_axes) so the same
-- engine can target user-task axes (e.g. "find-nearest", "compare-pricing",
-- "book-now", "emergency") rather than keyword permutations.
--
-- Hard floor: every pseo_pages_v2 row must score unique_data_pct >= 40 (live
-- Google Places content / real reviews / real pricing). The 40% gate runs in
-- the publish handler; rows below the floor stay status='draft' forever.

CREATE TABLE IF NOT EXISTS pseo_axes (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  axis_name       TEXT NOT NULL,           -- e.g. "user_task", "city", "service_offering"
  values_json     TEXT NOT NULL,           -- JSON array of axis values
  cap             INTEGER NOT NULL DEFAULT 200,  -- max pages per axis combo
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_pseo_axes_site
  ON pseo_axes(site_id, axis_name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pseo_pages_v2 (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL,
  axis_combo_hash   TEXT NOT NULL,         -- sha-256 of sorted JSON of {axis_name: value}
  axis_combo_json   TEXT NOT NULL,         -- the actual combo, for debugging
  slug              TEXT NOT NULL,         -- /tasks/{user-task}/{city} or similar
  content_json      TEXT,                  -- structured blocks (hero, body, faq, jsonld)
  word_count        INTEGER,
  unique_data_pct   INTEGER NOT NULL DEFAULT 0,  -- 0..100; must be >=40 to publish
  data_sources_json TEXT,                  -- {"google_places":N,"reviews":N,"pricing":N}
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','published','rejected','below_floor')),
  published_at      TEXT,
  r2_path           TEXT,
  ai_model          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pseo_v2_combo
  ON pseo_pages_v2(site_id, axis_combo_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pseo_v2_site_status
  ON pseo_pages_v2(site_id, status, unique_data_pct)
  WHERE deleted_at IS NULL;

-- Feature flag seed (registered in src/modules/feature_flags/registry.ts)
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_pseo_matrix_v2', NULL, 'pseo_matrix_v2', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"pSEO v2: user-tasks (not keywords) + >=40% unique data floor per page.","owner_email":"brian@megabyte.space"}');
