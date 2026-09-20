-- 0636: Site Operations — indexes powering the platform-wide sites list.
-- The super-admin console (/api/super-admin/ops/sites, docs/SITE-OPERATIONS.md) searches +
-- sorts every site (up to 1M) by created_at / status / business_name. These indexes keep the
-- ORDER BY + LIKE-filtered scans fast. Additive + idempotent — safe to re-run.
CREATE INDEX IF NOT EXISTS idx_sites_created_at ON sites (created_at);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites (status);
CREATE INDEX IF NOT EXISTS idx_sites_business_name ON sites (business_name);
