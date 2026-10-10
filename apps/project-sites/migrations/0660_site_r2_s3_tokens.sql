-- Per-site R2 **S3 API tokens** (Buckets B5 slice 1 — the credential foundation for object ops).
--
-- R2 has NO REST *object* API — only the S3-compatible API — so listing/putting/getting/deleting a
-- site's OWN bucket objects requires per-site R2 S3 access keys (an Access Key ID + Secret). This
-- table records, per SITE, the bucket-SCOPED Cloudflare R2 S3 token the Worker mints once and REUSES
-- on every subsequent object op for that site (the CF create-token endpoint returns the secret only in
-- its create response, so we cannot re-derive it — it MUST be stored). The secret is held AES-GCM
-- encrypted (`secret_enc`, via ai_crypto `encrypt()`/`MCP_ENCRYPTION_KEY`) — this is data-at-rest the
-- Worker decrypts every request, NOT a show-once value.
--
-- Isolation is structural, mirroring `site_r2_allocations` (0645) + the per-site D1 model: the CF token
-- is scoped to ONLY this site's real bucket names (`scope_bucket_ids`, a JSON array of the
-- `ps-site-{siteId}-{slug}` names the site owns) — never account-wide, never another site's buckets.
-- One ACTIVE row per site (idempotent provision: an existing active row is reused, never a 2nd CF
-- token). `cf_token_id` is the CF API token id (= the S3 Access Key ID) so a later slice can rotate /
-- revoke the token at Cloudflare. `rotated_at` records the last rotation; `deleted_at` soft-deletes.
--
-- Additive + reversible: creates a new table + index; touches no existing data. Feature-flagged
-- (`r2_bucket_manager`, DARK by default — the SAME flag the Buckets manager uses; no new flag) → the
-- credential path that reaches here stays off until the flag is enabled, so zero real R2 S3 tokens are
-- minted. Object ops (slice 2) still read env keys today; this table is dormant until slice 2 wires it.
CREATE TABLE IF NOT EXISTS site_r2_s3_tokens (
  id               TEXT NOT NULL PRIMARY KEY,          -- UUIDv7 (time-ordered) row id
  tenant_id        TEXT NOT NULL,                       -- org / tenant the token belongs to
  site_id          TEXT NOT NULL,                       -- the OWNING site (every read is scoped by this)
  access_key_id    TEXT NOT NULL,                       -- R2 S3 Access Key ID (= the CF API token id)
  secret_enc       TEXT NOT NULL,                       -- AES-GCM(secret) — the Secret Access Key, at rest
  cf_token_id      TEXT NOT NULL,                       -- CF API token id (for rotate/revoke at Cloudflare)
  scope_bucket_ids TEXT NOT NULL,                       -- JSON array of the site's real bucket names the token is scoped to
  status           TEXT NOT NULL DEFAULT 'active',      -- active | rotating | revoked | retired
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at       TEXT,                                -- last rotation (null until first rotate)
  deleted_at       TEXT
);

-- The hot lookup + idempotency check: "does this site already have an ACTIVE S3 token?".
CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site ON site_r2_s3_tokens (site_id, status);
