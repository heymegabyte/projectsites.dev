-- Migration 0521: Integration Directory Generator
--
-- Supports feature #30 — auto /integrations/{service-a}/{service-b} pages.
--
-- integration_services: registry of known integrable services per site
-- (e.g. Stripe, Mailchimp, HubSpot). Populated from research data or admin
-- seed. Each row carries config metadata used in page generation.
--
-- integration_pages: cross-product pages. axis = (service_a × service_b).
-- The page content_json carries hero, setup-steps, FAQs, screenshots refs.

CREATE TABLE IF NOT EXISTS integration_services (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  slug            TEXT NOT NULL,           -- "stripe", "mailchimp", "hubspot"
  name            TEXT NOT NULL,           -- "Stripe"
  category        TEXT,                    -- "payments", "email", "crm"
  homepage_url    TEXT,
  docs_url        TEXT,
  screenshot_r2   TEXT,                    -- R2 key for cached screenshot
  config_json     TEXT,                    -- {oauth: bool, sdk: "node", ...}
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_services_slug
  ON integration_services(site_id, slug)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS integration_pages (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  service_a_slug  TEXT NOT NULL,           -- alphabetical lower
  service_b_slug  TEXT NOT NULL,           -- alphabetical upper (a < b)
  route_slug      TEXT NOT NULL,           -- /integrations/{a}/{b}
  content_json    TEXT,
  jsonld_json     TEXT,                    -- SoftwareApplication + ItemList
  word_count      INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','published','rejected')),
  published_at    TEXT,
  r2_path         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_pages_pair
  ON integration_pages(site_id, service_a_slug, service_b_slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_integration_pages_status
  ON integration_pages(site_id, status)
  WHERE deleted_at IS NULL;

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_integration_directory', NULL, 'integration_directory', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Integration Directory: auto /integrations/{a}/{b} pages with real screenshots + setup steps.","owner_email":"brian@megabyte.space"}');
