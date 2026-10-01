-- Migration 0522: Comparison + Alternative Pages Engine
--
-- Supports feature #31 — auto /vs/{competitor} + /alternatives/{competitor}.
--
-- competitors: registry of competing products per site. Each has a pricing
-- URL that a weekly scheduled Worker re-fetches via Browser Rendering REST.
--
-- comparison_pages: one row per (site, competitor, kind). kind in
-- ('vs','alternatives') so we can ship both shapes off the same data source.

CREATE TABLE IF NOT EXISTS competitors (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  slug            TEXT NOT NULL,           -- "stripe", "square"
  name            TEXT NOT NULL,
  homepage_url    TEXT,
  pricing_url     TEXT,
  pricing_json    TEXT,                    -- {plans:[{name,price_usd,...}], scraped_at}
  pricing_scraped_at TEXT,
  screenshot_r2   TEXT,
  features_json   TEXT,                    -- {has_x: bool, has_y: bool, ...}
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_competitors_slug
  ON competitors(site_id, slug)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS comparison_pages (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  competitor_slug TEXT NOT NULL,
  kind            TEXT NOT NULL            -- 'vs' or 'alternatives'
                    CHECK (kind IN ('vs','alternatives')),
  route_slug      TEXT NOT NULL,
  content_json    TEXT,
  jsonld_json     TEXT,                    -- ItemList + FAQPage
  comparison_table_json TEXT,              -- side-by-side feature/pricing rows
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','published','rejected')),
  published_at    TEXT,
  r2_path         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comparison_pages_unique
  ON comparison_pages(site_id, competitor_slug, kind)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comparison_pages_status
  ON comparison_pages(site_id, status)
  WHERE deleted_at IS NULL;

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_comparison_pages', NULL, 'comparison_pages', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Comparison + Alternative Pages: /vs/{competitor} + /alternatives/{competitor} with weekly pricing refresh.","owner_email":"brian@megabyte.space"}');
