-- Migration: site_tags feature
-- Feature flag: site_tags (experimental, default-off)
-- Adds org-scoped tag definitions + per-site tag assignments.

CREATE TABLE IF NOT EXISTS site_tags (
  id         TEXT PRIMARY KEY NOT NULL,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'blue',
  emoji      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_tags_org ON site_tags(org_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_tags_org_name ON site_tags(org_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS site_tag_assignments (
  id         TEXT PRIMARY KEY NOT NULL,
  site_id    TEXT NOT NULL REFERENCES sites(id),
  tag_id     TEXT NOT NULL REFERENCES site_tags(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_tag_assignments ON site_tag_assignments(site_id, tag_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_site_tag_assignments_tag ON site_tag_assignments(tag_id, deleted_at);

-- Register feature flag
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_site_tags', NULL, 'site_tags', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Per-site colored label pills (Site Tags & Labels). Org-scoped tags with custom names, colors, and emoji. Filterable in the site list. CRUD at /api/site-tags/*.","e2e_tests":[],"smoke_steps":"1. Enable flag via admin UI\n2. POST /api/site-tags to create a tag\n3. PUT /api/sites/:id/tags to assign it\n4. GET /api/site-tags to list with site counts","owner_email":"brian@megabyte.space"}');
