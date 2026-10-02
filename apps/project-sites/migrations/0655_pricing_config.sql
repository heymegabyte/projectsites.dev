-- 0655_pricing_config.sql
-- Super-admin-editable pricing config for the cost-metering engine (PRICING-MODEL.md Wave 2,
-- fire-86 pricing-engine-v2). Moves the hardcoded unit prices + flat platform fee out of
-- src/services/site_cost.ts (DEFAULT_UNIT_PRICES + PLATFORM_FEE_USD) into a D1 table a
-- super-admin can edit, read behind the default-OFF `pricing_config_v2` flag.
--
-- ADDITIVE ONLY — this migration NEVER drops or alters an existing table. It creates one new
-- table and seeds it with rows matching the CURRENT hardcoded values, so when the flag flips ON
-- the computed cost is byte-identical to today's hardcoded path (the flag-off path is unchanged).
--
-- Precision note: unit prices carry sub-cent precision ($0.001 D1 rows-read, $0.015 R2 storage),
-- which an INTEGER cents column can't represent losslessly. The mandated `value_cents` column is
-- kept (whole-cent view: $50 → 5000), and an additive companion `value_usd` REAL column holds the
-- FULL-precision authoritative USD rate. The reader prefers `value_usd` when present, else falls
-- back to `value_cents / 100` — so identity is guaranteed for every seeded row.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS pricing_config (
  key         TEXT PRIMARY KEY,
  value_cents INTEGER,
  value_usd   REAL,
  description TEXT,
  updated_at  TEXT
);

-- Seed rows — EXACTLY the current site_cost.ts constants (value_usd is authoritative; value_cents
-- is the rounded whole-cent view). priceUsd per key from DEFAULT_UNIT_PRICES + PLATFORM_FEE_USD.
INSERT OR IGNORE INTO pricing_config (key, value_cents, value_usd, description, updated_at) VALUES
  ('worker_requests', 30,   0.3,    'Worker requests — USD per MILLION requests',           '2026-10-02T00:00:00Z'),
  ('worker_cpu',      2,    0.02,   'Worker CPU — USD per MILLION CPU-ms',                   '2026-10-02T00:00:00Z'),
  ('d1_rows_read',    0,    0.001,  'D1 rows read — USD per MILLION rows',                   '2026-10-02T00:00:00Z'),
  ('d1_rows_written', 100,  1.0,    'D1 rows written — USD per MILLION rows',                '2026-10-02T00:00:00Z'),
  ('d1_storage',      75,   0.75,   'D1 storage — USD per GB-month',                         '2026-10-02T00:00:00Z'),
  ('r2_storage_std',  2,    0.015,  'R2 storage — USD per GB-month',                         '2026-10-02T00:00:00Z'),
  ('r2_class_a',      450,  4.5,    'R2 Class A (write/list) — USD per MILLION operations',  '2026-10-02T00:00:00Z'),
  ('r2_class_b',      36,   0.36,   'R2 Class B (read) — USD per MILLION operations',        '2026-10-02T00:00:00Z'),
  ('platform_fee',    5000, 50.0,   'Flat per-site platform fee (#2) in USD',               '2026-10-02T00:00:00Z');
