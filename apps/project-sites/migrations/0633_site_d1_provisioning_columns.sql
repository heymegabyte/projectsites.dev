-- Per-site D1 provisioning (Data Platform re-arch, Phase 0c — docs/data-platform-scope.md).
--
-- site_database_allocations (0573) modelled the db_plan enum (incl. `d1_tenant_db`) but had NO
-- column for the provisioned tenant D1's Cloudflare uuid/name. The provisioner needs to record
-- which D1 database a site owns. Additive + reversible (adds two nullable columns; touches no data).
ALTER TABLE site_database_allocations ADD COLUMN d1_database_id TEXT;
ALTER TABLE site_database_allocations ADD COLUMN d1_database_name TEXT;

CREATE INDEX IF NOT EXISTS idx_site_db_alloc_d1 ON site_database_allocations (d1_database_id);
