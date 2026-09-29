-- R2 Bucket Manager catalog (the authoritative superset over the per-site custom-bucket plane).
--
-- The Manager (editor Resources → Buckets) presents a SITE'S buckets as ONE authoritative list: the
-- protected isogit "Project code · Preview" system bucket + the site's OWN custom buckets. This table
-- is the Manager's catalog. It COMPLEMENTS `site_r2_allocations` (0645) — it does NOT replace it:
-- 0645 remains the plane that actually provisions a site's custom CF R2 buckets; this catalog is the
-- Manager's superset view that ALSO models a per-bucket credential reference (never the secret) and a
-- provisioning state, and marks each row's `kind`.
--
-- The system bucket is SYNTHESIZED at read time (never stored) — it references the shared platform
-- `SITES_BUCKET` under `sites/{slug}/`, which is on the resolver's FORBIDDEN_BUCKET_NAMES denylist and
-- is never mutable from the per-site plane. So every row here is a CUSTOM (`is_system = 0`) bucket; the
-- `is_system` column + partial index exist so a future migration could persist a system row if needed
-- without a schema change.
--
-- Isolation is structural (every read is `WHERE site_id = ?`) + defense-in-depth (a hard denylist on the
-- shared platform bucket names in the resolver + `assertBucketOwnedBySite`).
--
-- Additive + reversible: creates a new table + indexes; touches no existing data. Feature-flagged
-- (`r2_bucket_manager`, DARK by default) → zero real R2 resources until the flag is enabled.
CREATE TABLE IF NOT EXISTS site_r2_buckets (
  id             TEXT NOT NULL PRIMARY KEY,          -- UUIDv7 (time-ordered) catalog id
  tenant_id      TEXT NOT NULL,                       -- org / tenant the bucket belongs to
  site_id        TEXT NOT NULL,                       -- the OWNING site (every read is scoped by this)
  bucket_name    TEXT NOT NULL,                       -- the REAL Cloudflare R2 bucket name (site-prefixed)
  display_name   TEXT NOT NULL,                       -- the tenant-facing short name (what the owner typed)
  kind           TEXT NOT NULL DEFAULT 'custom',       -- 'system' | 'custom' (system rows are synthesized, not stored)
  is_system      INTEGER NOT NULL DEFAULT 0,           -- 1 = the protected isogit "Project code · Preview" bucket
  jurisdiction   TEXT,                                -- optional data-residency hint (eu | fedramp); null = default
  provision_state TEXT NOT NULL DEFAULT 'active',      -- provisioning | active | deleting | retired
  credential_ref TEXT,                                -- id/reference into the encrypted credential store (ai_crypto) — NEVER the secret
  account_id     TEXT,                                -- the CF account the bucket lives in (for the S3 address bundle)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

-- One real bucket name is globally unique in R2; enforce it here too (idempotent create + no dupes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_r2_buckets_name ON site_r2_buckets (bucket_name);
-- The hot lookup: the Manager lists a site's OWN custom buckets (system rows excluded, keyset by id).
CREATE INDEX IF NOT EXISTS idx_site_r2_buckets_site ON site_r2_buckets (site_id, is_system, provision_state);
CREATE INDEX IF NOT EXISTS idx_site_r2_buckets_tenant ON site_r2_buckets (tenant_id);
