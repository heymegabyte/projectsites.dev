-- Per-OBJECT public visibility + revoke-safe signed shares (Buckets B9 — the FINAL §21 clause).
--
-- R2 has NO per-object public S3 ACL (CF constraint #1) — the only way to expose ONE object of an
-- otherwise-private bucket is a Worker object-serving GATEWAY in front of a control-plane that says
-- "this slug maps to this object AND is still allowed to serve". This table IS that control plane.
--
-- One row per (site, bucket, object) the owner has flipped PUBLIC. The handle a share link carries is
-- `public_slug` — a cryptographically-random, unguessable (≥128-bit) token; it is the ONLY way to reach
-- the object (never the raw object key), so there is no object-key enumeration surface. The unauthed
-- gateway `GET /api/r2/public/:slug` resolves the slug to the row and DENIES (404, never 403, never a
-- leak) when `revoked_at` is set OR `expires_at` has passed OR `visibility != 'public'` — so a revoke is
-- immediate and an expiry is enforced SERVER-SIDE. (Public-BUCKET inheritance — a bucket with
-- `public_access=1` ⇒ ALL its objects public — is resolved from `site_r2_allocations`, not stored here,
-- so toggling a bucket public/private never has to backfill per-object rows.)
--
-- Isolation is structural, mirroring `site_r2_allocations` (0645) + `site_r2_s3_tokens` (0660): every
-- row is scoped to the OWNING `site_id` + `allocation_id` (the real bucket the caller proved they own in
-- the authed make-public route). The gateway never reads a key/bucket from the request — it reads them
-- from the resolved row — so a valid slug can only ever serve the ONE object it was minted for.
--
-- Additive + reversible: creates a new table + two indexes; touches no existing data. The authed
-- make-public/revoke routes are flag-gated (`r2_bucket_manager`, DARK) so no share can be minted until
-- the flag is on; the unauthed gateway simply 404s every slug while the table is empty.
CREATE TABLE IF NOT EXISTS object_visibility (
  id            TEXT NOT NULL PRIMARY KEY,            -- UUIDv7 (time-ordered) row id
  site_id       TEXT NOT NULL,                         -- the OWNING site (every lookup is scoped by this)
  allocation_id TEXT NOT NULL,                         -- site_r2_allocations.id (the real owned bucket)
  bucket_name   TEXT NOT NULL,                         -- the REAL R2 bucket name (ps-site-…) the object lives in
  object_key    TEXT NOT NULL,                         -- the object key within that bucket
  visibility    TEXT NOT NULL DEFAULT 'private',       -- 'public' | 'private'
  public_slug   TEXT NOT NULL,                         -- unguessable (≥128-bit) share handle — the ONLY public reference
  expires_at    TEXT,                                  -- optional server-enforced expiry (null = never)
  revoked_at    TEXT,                                  -- set on revoke → the link dies immediately (null = live)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The upsert / owner-side lookup: "is THIS object (of this site's bucket) already shared?".
CREATE INDEX IF NOT EXISTS idx_object_visibility_object
  ON object_visibility (site_id, bucket_name, object_key);

-- The gateway hot path: resolve a share by its slug. UNIQUE so a slug maps to at most ONE object (a
-- collision on mint is impossible to serve ambiguously) and the resolve is a single-row index hit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_object_visibility_slug
  ON object_visibility (public_slug);
