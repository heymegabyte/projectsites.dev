-- 0638_scan_profiles.sql — Lead-Scanner Scan Profiles (SCOPE.md:68) (feature: scan_profiles)
-- D1 persistence for the lead scanner's editable "what to hunt" config. An operator
-- creates a profile (geo bboxes / OSM categories / providers / free-text filters /
-- cadence) and the cron geo-sweep iterates the DUE ones, running each bbox through
-- the orchestrator. The profile contract + due/run-spec logic are the pure core in
-- src/services/scan_profiles.ts; this table is its storage arm.
--
-- ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS. No ALTER, no DROP.
CREATE TABLE IF NOT EXISTS scan_profiles (
  id                TEXT PRIMARY KEY NOT NULL,   -- UUIDv7 (Worker-minted; sorts by creation)
  org_id            TEXT NOT NULL,               -- owning org (platform ops → 'system')
  name              TEXT NOT NULL,               -- human name, e.g. "Newark trades — weekly"
  enabled           INTEGER NOT NULL DEFAULT 0,  -- off by default; only runs when explicitly on
  bboxes_json       TEXT NOT NULL DEFAULT '[]',  -- JSON array of [south, west, north, east]
  categories_json   TEXT NOT NULL DEFAULT '[]',  -- JSON array of OSM/Places category keys
  providers_json    TEXT NOT NULL DEFAULT '["osm"]', -- JSON array, preference order
  filters           TEXT NOT NULL DEFAULT '',    -- free-text operator intent (the editable verbiage)
  source            TEXT NOT NULL DEFAULT 'osm', -- provenance label written to the CRM
  max_leads_per_run INTEGER NOT NULL DEFAULT 50, -- cost guard (leads sunk per bbox run)
  interval_minutes  INTEGER NOT NULL DEFAULT 0,  -- cadence; 0 = manual-only
  last_run_at       INTEGER,                      -- epoch ms of last successful run; NULL = never
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT                          -- soft delete (never physically remove)
);

-- Hot path is "live profiles for this org, newest first" (the list route + the cron's
-- due-set scan). One composite index covers both.
CREATE INDEX IF NOT EXISTS idx_scan_profiles_org
  ON scan_profiles (org_id, deleted_at, created_at);

-- Feature flag — dark by default (experimental). Server guard 404s until promoted.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_scan_profiles', NULL, 'scan_profiles', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Scan Profiles: D1-persisted CRUD for the lead scanner''s editable \"what to hunt\" config. GET/POST/PATCH/DELETE /api/admin/scan-profiles let a Super-Admin create, tune, pause and soft-delete scan profiles (geo bboxes, OSM/Places categories, providers, free-text filters, cadence, per-run lead cap); the cron geo-sweep reads the due profiles and runs each bbox through the lead_scan_orchestrator. Guards: auth 401 -> this flag (404, never 403) -> super-admin 403 -> Zod 400. Failure mode when off: every route 404s; the existing ad-hoc POST /api/admin/leads/scan-osm (lead_scanner flag) still works, so nothing regresses.","owner_email":"brian@megabyte.space","e2e_tests":["e2e/scan_profiles/scan-profiles.spec.ts"]}');
