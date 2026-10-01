-- Migration 0520 — Marketplace + Creator Economy (IDEAS-50 #39, #40, #41, #42)
--
-- Adds creator-economy infrastructure on top of existing marketplace surfaces:
--
--   #39 Template Marketplace v1 — Framer-style 0% direct cut, 50% on referrals.
--     - Extends existing `templates` table with creator_user_id, stripe_product_id,
--       sales_count, total_revenue_cents.
--     - New `template_purchases` table tracks payments + license + referrer.
--     - New `marketplace_payouts` table records creator payout schedule (manual
--       by Brian today; auto via Stripe Connect Express once onboarded).
--
--   #40 Section Marketplace creator submissions — adds submission state machine
--     to the existing 30-seed `section_marketplace` table (status='approved' for
--     seeds, 'pending' for community submissions awaiting Brian's curation).
--
--   #41 Plugin / Integration Marketplace — Webflow-style 500-plugin catalog with
--     70/30 creator rev-share. Plugins have a JSON manifest declaring install
--     hooks for the site-build pipeline.
--
--   #42 AI Code Components — per-site generated components scaffolded with the
--     site's brand tokens auto-inherited from _brand.json.
--
-- All four features ship behind dedicated flags (enabled=0, rollout=0,
-- stage='experimental') and 404 when off.

-- ────────────────────────────────────────────────────────────────────────────
-- #39 Template Marketplace v1 — extends existing templates table
-- ────────────────────────────────────────────────────────────────────────────

-- Extend templates with creator economy columns. Idempotent ALTERs.
-- D1/SQLite does not support `IF NOT EXISTS` on ALTER TABLE — the migration
-- runner skips a column when the next migration replays. Callers tolerate
-- duplicate-column errors here.
ALTER TABLE templates ADD COLUMN creator_user_id TEXT;
ALTER TABLE templates ADD COLUMN stripe_product_id TEXT;
ALTER TABLE templates ADD COLUMN stripe_price_id TEXT;
ALTER TABLE templates ADD COLUMN sales_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN total_revenue_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN submission_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (submission_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE templates ADD COLUMN license_terms TEXT NOT NULL DEFAULT 'single-site';

CREATE INDEX IF NOT EXISTS idx_templates_creator
  ON templates(creator_user_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_templates_submission_status
  ON templates(submission_status) WHERE deleted_at IS NULL;

-- Per-purchase ledger. One row per Stripe PaymentIntent succeeded webhook.
-- The referrer_user_id column drives 50% revenue share on platform-referred
-- conversions (Framer pattern). Direct sales = referrer_user_id NULL.
CREATE TABLE IF NOT EXISTS template_purchases (
  id                      TEXT PRIMARY KEY,
  template_id             TEXT NOT NULL,
  buyer_user_id           TEXT NOT NULL,
  buyer_site_id           TEXT,                                   -- set when buyer installs into a site
  referrer_user_id        TEXT,                                   -- non-NULL = 50% platform share path
  stripe_payment_intent   TEXT NOT NULL UNIQUE,                   -- webhook idempotency key
  amount_cents            INTEGER NOT NULL CHECK (amount_cents >= 0),
  creator_share_cents     INTEGER NOT NULL CHECK (creator_share_cents >= 0),
  platform_share_cents    INTEGER NOT NULL CHECK (platform_share_cents >= 0),
  referrer_share_cents    INTEGER NOT NULL DEFAULT 0 CHECK (referrer_share_cents >= 0),
  license                 TEXT NOT NULL DEFAULT 'single-site'
                            CHECK (license IN ('single-site', 'unlimited', 'agency')),
  purchased_at            TEXT NOT NULL DEFAULT (datetime('now')),
  refunded_at             TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_template_purchases_template
  ON template_purchases(template_id, purchased_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_template_purchases_buyer
  ON template_purchases(buyer_user_id, purchased_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_template_purchases_referrer
  ON template_purchases(referrer_user_id, purchased_at DESC)
  WHERE deleted_at IS NULL AND referrer_user_id IS NOT NULL;

-- Creator payout schedule — settled monthly via Stripe Connect Express.
-- Today: rows created manually by Brian; status flips 'pending' → 'paid' on
-- Stripe transfer.created webhook (out of scope for this migration).
CREATE TABLE IF NOT EXISTS marketplace_payouts (
  id                      TEXT PRIMARY KEY,
  creator_user_id         TEXT NOT NULL,
  period_start            TEXT NOT NULL,                          -- ISO date
  period_end              TEXT NOT NULL,                          -- ISO date
  source                  TEXT NOT NULL                           -- which marketplace
                            CHECK (source IN ('template', 'section', 'plugin', 'referral')),
  gross_cents             INTEGER NOT NULL CHECK (gross_cents >= 0),
  platform_fee_cents      INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
  net_cents               INTEGER NOT NULL CHECK (net_cents >= 0),
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  stripe_transfer_id      TEXT,
  paid_at                 TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payouts_creator
  ON marketplace_payouts(creator_user_id, period_end DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_payouts_status
  ON marketplace_payouts(status, created_at DESC)
  WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- #40 Section Marketplace creator submissions
-- ────────────────────────────────────────────────────────────────────────────

-- Extend the existing section_marketplace table with a submission state machine.
-- Seed entries (30 rows from migration 0506) flip to 'approved' on this migration.
ALTER TABLE section_marketplace ADD COLUMN submission_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (submission_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE section_marketplace ADD COLUMN creator_user_id TEXT;
ALTER TABLE section_marketplace ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE section_marketplace ADD COLUMN submitted_at TEXT;
ALTER TABLE section_marketplace ADD COLUMN reviewed_at TEXT;
ALTER TABLE section_marketplace ADD COLUMN reviewer_user_id TEXT;
ALTER TABLE section_marketplace ADD COLUMN rejection_reason TEXT;

-- Seed rows authored by 'projectsites' stay approved. Any future row authored
-- by a community creator defaults to 'pending' via the INSERT path in code.
UPDATE section_marketplace SET submission_status = 'approved' WHERE author = 'projectsites';

CREATE INDEX IF NOT EXISTS idx_section_marketplace_submission
  ON section_marketplace(submission_status, submitted_at DESC)
  WHERE deleted_at IS NULL AND submission_status = 'pending';

-- ────────────────────────────────────────────────────────────────────────────
-- #41 Plugin / Integration Marketplace
-- ────────────────────────────────────────────────────────────────────────────

-- One row per plugin in the marketplace. Plugins declare install hooks via the
-- manifest_json field — the site-build pipeline reads this to know which assets
-- to inject (script tags, env vars, route handlers).
CREATE TABLE IF NOT EXISTS plugins (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL UNIQUE,                   -- 'stripe-checkout', 'calendly-embed', etc.
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  creator_user_id         TEXT,                                   -- NULL = projectsites-authored
  category                TEXT NOT NULL                           -- 'payments' | 'scheduling' | 'maps' | 'forms' | 'analytics' | 'ai' | 'social'
                            CHECK (category IN ('payments','scheduling','maps','forms','analytics','ai','social','other')),
  manifest_json           TEXT NOT NULL,                          -- JSON: { hooks: [...], env_vars: [...], scripts: [...] }
  price_cents             INTEGER NOT NULL DEFAULT 0,
  stripe_product_id       TEXT,
  install_count           INTEGER NOT NULL DEFAULT 0,
  sales_count             INTEGER NOT NULL DEFAULT 0,
  total_revenue_cents     INTEGER NOT NULL DEFAULT 0,
  rating_avg              REAL NOT NULL DEFAULT 0,
  rating_count            INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'pending'         -- pending → approved → live | rejected | archived
                            CHECK (status IN ('pending','approved','live','rejected','archived')),
  thumbnail_url           TEXT,
  repository_url          TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugins_category
  ON plugins(category, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_creator
  ON plugins(creator_user_id) WHERE deleted_at IS NULL AND creator_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plugins_status
  ON plugins(status, created_at DESC) WHERE deleted_at IS NULL;

-- Per-site plugin install record. Site-build pipeline reads from this table
-- to know which plugins to inject during the next build cycle.
CREATE TABLE IF NOT EXISTS plugin_installs (
  id                      TEXT PRIMARY KEY,
  plugin_id               TEXT NOT NULL,
  site_id                 TEXT NOT NULL,
  org_id                  TEXT NOT NULL,
  config_json             TEXT NOT NULL DEFAULT '{}',             -- per-install configuration
  price_paid_cents        INTEGER NOT NULL DEFAULT 0,
  stripe_payment_intent   TEXT,
  installed_by            TEXT NOT NULL,                          -- user_id
  installed_at            TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at          TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_installs_site
  ON plugin_installs(site_id, installed_at DESC)
  WHERE deleted_at IS NULL AND uninstalled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_installs_plugin
  ON plugin_installs(plugin_id, installed_at DESC)
  WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- #42 AI Code Components
-- ────────────────────────────────────────────────────────────────────────────

-- Per-site generated React components. Brand tokens auto-inherited from
-- the site's _brand.json (palette, fonts, tone) at generation time.
CREATE TABLE IF NOT EXISTS ai_components (
  id                      TEXT PRIMARY KEY,
  site_id                 TEXT NOT NULL,
  org_id                  TEXT NOT NULL,
  created_by              TEXT NOT NULL,                          -- user_id
  name                    TEXT NOT NULL,                          -- "MultiStepQuoteCalculator"
  description             TEXT NOT NULL,                          -- the prompt the user supplied
  component_code          TEXT NOT NULL,                          -- generated React TSX
  brand_tokens_snapshot   TEXT NOT NULL DEFAULT '{}',             -- _brand.json at generation time
  ai_model                TEXT NOT NULL,                          -- model used
  ai_tokens               INTEGER,                                -- tokens consumed
  status                  TEXT NOT NULL DEFAULT 'draft'           -- draft | published | archived
                            CHECK (status IN ('draft','published','archived')),
  published_to_marketplace INTEGER NOT NULL DEFAULT 0             -- 0/1 — when promoted to plugin marketplace
                            CHECK (published_to_marketplace IN (0,1)),
  marketplace_plugin_id   TEXT,                                   -- FK to plugins.id when published
  generation_count        INTEGER NOT NULL DEFAULT 1,             -- regeneration history
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT,
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_components_site
  ON ai_components(site_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_components_org
  ON ai_components(org_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_components_published
  ON ai_components(published_to_marketplace, created_at DESC)
  WHERE deleted_at IS NULL AND published_to_marketplace = 1;

-- ────────────────────────────────────────────────────────────────────────────
-- Feature flag seeds
-- ────────────────────────────────────────────────────────────────────────────

-- template_marketplace flag already seeded in earlier migration (0501-era).
-- Re-seed with the canonical description for parity with FLAG_REGISTRY.
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_template_marketplace', NULL, 'template_marketplace', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Framer-style template marketplace: creators submit, Brian curates, creator keeps 100% on direct sales + 50% on platform-referred conversions.","owner_email":"brian@megabyte.space"}');

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_plugin_marketplace', NULL, 'plugin_marketplace', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Plugin / integration marketplace: third-party integrations (Stripe, Calendly, MapBox, AI form-fill) installable per site. 70/30 rev-share to creator.","owner_email":"brian@megabyte.space"}');

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_ai_components', NULL, 'ai_components', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"AI Code Components generator: describe a widget in natural language, get a production React component scaffolded with the site brand tokens auto-inherited from _brand.json.","owner_email":"brian@megabyte.space"}');
