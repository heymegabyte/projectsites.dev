-- 0656_feature_flags_consolidate.down.sql — manual rollback for 0656_feature_flags_consolidate.sql
--
-- NOT auto-discovered by `wrangler d1 migrations apply` (lives outside migrations/,
-- which only globs NNNN_*.sql at its top level — this directory is a deliberate
-- escape hatch so a down-script can never be accidentally forward-applied).
--
-- Apply manually only, via:
--   wrangler d1 execute project-sites-db --remote \
--     --file=migrations/rollback/0656_feature_flags_consolidate.down.sql
--
-- Reverses 0656 cleanly with ZERO data loss: the up-migration only ADDED 4 columns
-- (key, enabled_v2, rollout_percent, stage) + 1 index to the legacy `feature_flags`
-- table and never touched `flag_name`/`enabled`/`metadata_json` (still fully intact)
-- or the live `flag_overrides` table (untouched by 0656 in either direction). Dropping
-- these 4 columns returns `feature_flags` to its exact pre-0656 shape; no runtime code
-- reads them (the live resolver reads `flag_overrides` + the code registry — see 0656's
-- header comment), so this rollback is safe to run at any time with zero behavioral
-- change to the running Worker.
--
-- D1/SQLite (3.35+) supports DROP COLUMN natively — no CREATE+copy+DROP+RENAME dance
-- needed for this reversal (that pattern is reserved for column TYPE changes /
-- renames, which this migration never performed).

DROP INDEX IF EXISTS idx_feature_flags_key;

ALTER TABLE feature_flags DROP COLUMN stage;
ALTER TABLE feature_flags DROP COLUMN rollout_percent;
ALTER TABLE feature_flags DROP COLUMN enabled_v2;
ALTER TABLE feature_flags DROP COLUMN key;
