-- Migration 0520: Trust Center, Enterprise Plan, Stripe App status
--
-- Three enterprise-readiness features land in one migration:
--
--   1. trust_center          — per-customer-org + per-published-site Trust Center.
--                              AI models used, content provenance, audit-log
--                              access policy, data residency, AI-outage fallback
--                              behavior. Compliance asset (EU AI Act high-risk
--                              obligations, Aug 2 2026) + sales asset.
--
--   2. enterprise_plan       — $500-$2000/mo enterprise contract row per org.
--                              Captures SLA %, SSO posture (SAML/OIDC), custom
--                              terms markdown, dedicated Slack channel, annual
--                              contract value. Stripe product wiring deferred
--                              until Brian provisions the products (see README).
--
--   3. stripe_app_status     — installation-analytics row per (org, source) for
--                              the Stripe App Marketplace listing. The growth
--                              agent owns the marketplace manifest; this table
--                              backs the admin /admin/stripe-app-status surface.
--

-- ─── 1. Trust Center ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trust_profiles (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  site_id            TEXT,                       -- NULL => org-level profile; non-NULL => per-published-site
  ai_models_json     TEXT NOT NULL DEFAULT '[]', -- JSON array of { vendor, model, purpose, version }
  data_residency     TEXT NOT NULL DEFAULT 'global', -- 'global' | 'us' | 'eu' | 'apac'
  audit_log_policy   TEXT NOT NULL DEFAULT 'on-request', -- 'on-request' | 'self-serve' | 'realtime-stream'
  content_provenance TEXT NOT NULL DEFAULT '[]', -- JSON array describing AI-generated vs human-authored content
  ai_outage_behavior TEXT NOT NULL DEFAULT 'graceful-degradation', -- 'graceful-degradation' | 'queue-and-retry' | 'manual-fallback'
  custom_disclosures TEXT,                       -- Markdown — additional disclosures for the public Trust page
  published          INTEGER NOT NULL DEFAULT 0, -- 0 = draft, 1 = published to /trust
  published_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_profiles_org_site
  ON trust_profiles(org_id, COALESCE(site_id, ''))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trust_profiles_site
  ON trust_profiles(site_id)
  WHERE deleted_at IS NULL AND site_id IS NOT NULL;

-- Feature flag seed
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_trust_center', NULL, 'trust_center', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Per-org and per-published-site Trust Center: AI models used, content provenance, audit log, data residency, AI outage fallback. EU AI Act high-risk obligations (Aug 2 2026).","owner_email":"brian@megabyte.space"}');

-- ─── 2. Enterprise Plan ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enterprise_contracts (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL UNIQUE,
  plan_tier                TEXT NOT NULL DEFAULT 'enterprise-small', -- 'enterprise-small' | 'enterprise-mid' | 'enterprise-large'
  sla_pct                  REAL NOT NULL DEFAULT 99.9, -- e.g. 99.9, 99.95
  sso_enabled              INTEGER NOT NULL DEFAULT 0, -- 0/1
  sso_provider             TEXT,                       -- 'saml' | 'oidc' | 'cloudflare-access' | NULL
  sso_metadata_url         TEXT,                       -- SAML metadata URL OR OIDC discovery URL
  custom_terms_md          TEXT,                       -- Markdown overrides for the legal terms shown to the org
  dedicated_slack_channel  TEXT,                       -- Slack channel ID/name for dedicated support
  annual_value_cents       INTEGER NOT NULL DEFAULT 0, -- ACV in cents (USD)
  contract_start           TEXT,
  contract_end             TEXT,
  audit_export_enabled     INTEGER NOT NULL DEFAULT 1, -- enterprise tier defaults audit-export ON
  contract_signed_url      TEXT,                       -- R2 URL of countersigned PDF
  status                   TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'churned' | 'cancelled'
  notes                    TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at               TEXT
);

CREATE INDEX IF NOT EXISTS idx_enterprise_contracts_status
  ON enterprise_contracts(status)
  WHERE deleted_at IS NULL;

-- Per-org SLA monitoring snapshots (rolled up daily by a Workflow once wired)
CREATE TABLE IF NOT EXISTS enterprise_sla_metrics (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  measured_on     TEXT NOT NULL,             -- YYYY-MM-DD
  uptime_pct      REAL NOT NULL,             -- 0-100
  incidents_count INTEGER NOT NULL DEFAULT 0,
  p95_latency_ms  INTEGER,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enterprise_sla_metrics_unique
  ON enterprise_sla_metrics(org_id, measured_on);

-- Append-only audit exports (one row per export bundle request)
CREATE TABLE IF NOT EXISTS enterprise_audit_exports (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  requested_by TEXT,
  range_start TEXT NOT NULL,
  range_end   TEXT NOT NULL,
  r2_key      TEXT,                          -- output bundle location
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ready' | 'expired' | 'failed'
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_enterprise_audit_exports_org
  ON enterprise_audit_exports(org_id, created_at DESC);

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_enterprise_plan', NULL, 'enterprise_plan', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Enterprise plan ($500-$2000/mo): Cloudflare Access SSO (SAML/OIDC), 99.9% SLA monitoring, audit-log export, custom terms, dedicated Slack. Requires Brian to provision Stripe products + Access SSO before promotion.","owner_email":"brian@megabyte.space"}');

-- ─── 3. Stripe App Marketplace install analytics ─────────────────────────────

CREATE TABLE IF NOT EXISTS stripe_app_installations (
  id              TEXT PRIMARY KEY,
  org_id          TEXT,                        -- NULL until the install is associated with a projectsites org
  stripe_account  TEXT NOT NULL,              -- Stripe account id (acct_...)
  install_source  TEXT NOT NULL DEFAULT 'marketplace', -- 'marketplace' | 'direct' | 'referral'
  status          TEXT NOT NULL DEFAULT 'installed', -- 'installed' | 'uninstalled' | 'paused'
  installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at  TEXT,
  last_event_at   TEXT,
  metadata_json   TEXT,                        -- arbitrary install payload from Stripe
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_app_install_account
  ON stripe_app_installations(stripe_account)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_app_install_status
  ON stripe_app_installations(status)
  WHERE deleted_at IS NULL;

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_stripe_app_status', NULL, 'stripe_app_status', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Admin dashboard for Stripe App Marketplace installs. The growth agent owns the manifest; this surface backs /admin/stripe-app-status with install analytics + lifecycle events.","owner_email":"brian@megabyte.space"}');
