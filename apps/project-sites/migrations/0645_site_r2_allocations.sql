-- Per-site R2 bucket allocations (Buckets feature — the R2 analog of site_database_allocations 0573).
--
-- Records, per SITE, which Cloudflare R2 buckets it OWNS (created via the CF R2 REST API using the
-- server-side global key + env.CF_ACCOUNT_ID — never client-supplied). Mirrors the per-site D1 model:
-- the site's REAL bucket names are site-prefixed (`ps-site-{siteId}-{slug}`) so tenant names never
-- collide across sites, and this mapping is the ONLY source of a per-site bucket name — a client can
-- never name a raw bucket. Isolation is structural (a query is always `WHERE site_id = ?`) + a hard
-- denylist on the shared platform bucket names in the resolver.
--
-- One row per (site_id, bucket_name). `is_default` marks the site's auto-provisioned "preview" bucket.
-- `environment` = preview | production (Promote snapshots preview → production). `public_access` mirrors
-- whether the bucket has an r2.dev / custom public base URL enabled.
--
-- Additive + reversible: creates a new table + indexes; touches no existing data. Feature-flagged
-- (`r2_buckets`, DARK by default) → zero real R2 resources until the flag is enabled.
CREATE TABLE IF NOT EXISTS site_r2_allocations (
  id             TEXT NOT NULL PRIMARY KEY,          -- UUIDv7 (time-ordered) allocation id
  tenant_id      TEXT NOT NULL,                       -- org / tenant the bucket belongs to
  site_id        TEXT NOT NULL,                       -- the OWNING site (every read is scoped by this)
  bucket_name    TEXT NOT NULL,                       -- the REAL Cloudflare R2 bucket name (site-prefixed)
  display_name   TEXT NOT NULL,                       -- the tenant-facing short name (what the owner typed)
  environment    TEXT NOT NULL DEFAULT 'preview',     -- preview | production
  is_default     INTEGER NOT NULL DEFAULT 0,          -- 1 = the site's auto-provisioned default bucket
  public_access  INTEGER NOT NULL DEFAULT 0,          -- 1 = a public base URL (r2.dev / custom domain) is enabled
  public_base_url TEXT,                               -- the public base URL when public_access = 1
  jurisdiction   TEXT,                                -- optional data-residency hint (eu | fedramp); null = default
  status         TEXT NOT NULL DEFAULT 'active',      -- active | provisioning | deleting | retired
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

-- One real bucket name is globally unique in R2; enforce it here too (idempotent create + no dupes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_r2_alloc_bucket ON site_r2_allocations (bucket_name);
-- The hot lookup: every read lists a site's OWN buckets.
CREATE INDEX IF NOT EXISTS idx_site_r2_alloc_site ON site_r2_allocations (site_id, status);
CREATE INDEX IF NOT EXISTS idx_site_r2_alloc_tenant ON site_r2_allocations (tenant_id);
-- Fast "does this site already have a default bucket?" idempotency check.
CREATE INDEX IF NOT EXISTS idx_site_r2_alloc_default ON site_r2_allocations (site_id, is_default);
