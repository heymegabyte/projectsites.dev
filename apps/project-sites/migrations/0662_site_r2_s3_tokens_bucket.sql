-- Per-site R2 S3 tokens: add a `bucket_name` scope (Buckets B4 — per-BUCKET owner keys).
--
-- Slice 4 (0661) gave each SITE one owner-visible scoped R2 S3 key (kind='owner'), scoped to ALL the
-- site's buckets. B4 adds a FINER grain: an owner key scoped to ONE of the site's buckets. The two
-- coexist — a NULL `bucket_name` is the existing SITE-WIDE owner key (every bucket), a SET `bucket_name`
-- is a PER-BUCKET key (that one bucket only). The service mints a per-bucket key by passing a single
-- bucket to the same CF Create-Token path (`bucketScopeResources(account, [bucketName])`) and persisting
-- the bucket name here.
--
--   • bucket_name IS NULL  → the 0661 site-wide owner key (all the site's buckets). Existing rows read
--                            back unchanged (the column defaults to NULL, so no 0660/0661 row is touched).
--   • bucket_name = '<name>' → a per-bucket owner key, scoped to exactly that real bucket name
--                            (`ps-site-{siteId}-{slug}`). Lookup keys on (site_id, kind, bucket_name, status).
--
-- Why the scope is load-bearing: `activeOwnerKeyRow` (site-wide) resolves by (site_id, kind='owner',
-- status='active') AND bucket_name IS NULL, so a per-bucket key is never mistaken for the site-wide key
-- (and vice-versa). Per-bucket create/rotate/revoke/status all filter on bucket_name, so the grains never
-- cross — a site can hold the site-wide key AND one per-bucket key per bucket, independently.
--
-- Additive + reversible: adds ONE nullable column (DEFAULT NULL → every existing row reads back as the
-- site-wide owner key, unchanged) + a composite lookup index. Touches no existing data, drops/alters
-- nothing. Governed by the SAME flag as the owner-key / object-ops credential path (`r2_bucket_manager`,
-- enabled/100%/beta) — no new flag. The per-bucket key routes 404 when it's off.
ALTER TABLE site_r2_s3_tokens ADD COLUMN bucket_name TEXT; -- NULL = site-wide owner key (0661); set = per-bucket key

-- The hot lookup + idempotency check now keys on (site_id, kind, bucket_name, status): "does this site
-- already have an ACTIVE owner key for THIS bucket?". Complements idx_site_r2_s3_tokens_site_kind (0661)
-- which stays for the site-wide / kind-scoped reads.
CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site_kind_bucket
  ON site_r2_s3_tokens (site_id, kind, bucket_name, status);
