-- Per-site KV + R2 provisioning (Data Platform re-arch, Phase 0c — docs/data-platform-scope.md).
--
-- Complements 0633 (per-site D1 columns) with the per-site KV namespace + R2 bucket the KV/R2
-- provisioners create + record. One allocation row per site holds all its resource ids. Additive
-- + reversible (nullable columns; touches no data).
ALTER TABLE site_database_allocations ADD COLUMN kv_namespace_id TEXT;
ALTER TABLE site_database_allocations ADD COLUMN kv_namespace_name TEXT;
ALTER TABLE site_database_allocations ADD COLUMN r2_bucket_name TEXT;

CREATE INDEX IF NOT EXISTS idx_site_db_alloc_kv ON site_database_allocations (kv_namespace_id);
