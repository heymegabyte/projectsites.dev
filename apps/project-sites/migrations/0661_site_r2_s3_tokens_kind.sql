-- Per-site R2 S3 tokens: add a `kind` discriminator (Buckets B5 slice 4 — owner-facing scoped key).
--
-- The `site_r2_s3_tokens` table (0660) records the Worker's INTERNAL bucket-scoped R2 S3 token — the
-- one the Worker mints once + REUSES on every object op (secret held AES-GCM encrypted at rest, decrypted
-- each request; NOT show-once). Slice 4 adds a SEPARATE, OWNER-VISIBLE scoped key the site owner can
-- create / rotate / revoke to use R2 from their OWN tooling (wrangler, aws-cli, SDKs). It is a DISTINCT
-- credential from the Worker's internal token — same table shape, different lifecycle + visibility:
--
--   • kind='internal' → the Worker's token (0660 rows; secret stored + reused — the object-ops rail).
--   • kind='owner'    → the owner's scoped key. The Secret Access Key is returned ONCE at create/rotate
--                       and NEVER persisted (we store only the access_key_id + cf_token_id + status +
--                       timestamps). `secret_enc` is NOT NULL on the table, so owner rows store a single
--                       space ' ' sentinel there (never the real secret) — the owner secret only ever
--                       lives in the create/rotate HTTP response body, then is gone.
--
-- Why the discriminator is load-bearing: `ensureSiteS3Token`/`invalidateSiteS3Tokens` (src/services/
-- site_r2.ts) resolve "the site's ACTIVE token" by `site_id + status='active'`. WITHOUT a kind filter an
-- owner key would be returned as the Worker's internal object-ops token — and its secret is unstored, so
-- object ops would break. Both the internal path and the owner path now filter on `kind`, so the two
-- never cross. An owner can hold at most ONE active key (idempotent create; rotate supersedes).
--
-- Additive + reversible: adds a nullable column with a DEFAULT of 'internal' (so every existing 0660 row
-- reads back as the Worker's internal token, unchanged) + a composite lookup index. Touches no existing
-- data, drops/alters nothing. Governed by the SAME flag as the object-ops credential path
-- (`r2_bucket_manager`, enabled/100%/beta) — no new flag. The owner-key routes 404 when it's off.
ALTER TABLE site_r2_s3_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'internal'; -- 'internal' (Worker) | 'owner' (owner-visible)

-- The hot lookup + idempotency check now keys on (site_id, kind, status): "does this site already have an
-- ACTIVE token of THIS kind?". Complements idx_site_r2_s3_tokens_site (0660) which stays for kind-agnostic reads.
CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site_kind ON site_r2_s3_tokens (site_id, kind, status);
