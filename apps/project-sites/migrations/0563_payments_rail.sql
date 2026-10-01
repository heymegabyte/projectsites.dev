-- Migration 0563: payments_rail feature module tables + feature flag seed

CREATE TABLE IF NOT EXISTS payments_rail_events (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  site_id      TEXT,
  provider     TEXT NOT NULL CHECK(provider IN ('stripe','square')),
  event_type   TEXT NOT NULL,
  amount_cents INTEGER,
  currency     TEXT DEFAULT 'usd',
  status       TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_payments_rail', NULL, 'payments_rail', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Unified payments rail events for Stripe and Square. Captures payment lifecycle events per org and site for audit, reconciliation, and revenue analytics.","owner_email":"brian@megabyte.space"}');
