-- 0656_feature_flags_consolidate.sql
-- Feature-flags schema consolidation (fire-81, architecture/cleanup).
--
-- CONTEXT: two shapes have coexisted since ~0500-0613:
--   LEGACY  `feature_flags`   (id, org_id, flag_name, enabled, metadata_json) — the
--           0001 initial-schema shape, seeded by every 05xx/06xx_*_flag.sql governance
--           migration (id/flag_name/enabled/metadata_json — description+stage+
--           rollout_percent+owner_email+e2e_tests packed into metadata_json). Per
--           0613_prune_dead_flags.sql's own comment: "the legacy `feature_flags` D1
--           table … is NOT read at runtime — only `flag_overrides` + the code registry
--           are." Confirmed again this fire via full-repo grep: zero runtime SELECT/
--           UPDATE against this table (`site_dna.ts:34` documents a PAST bug where a
--           bespoke query hit it and was fixed by routing through the canonical
--           resolver). It is a write-only admin-governance artifact.
--   MODERN  `flag_overrides`  (id, scope, scope_id, flag_key, value_json, set_by,
--           reason, set_at, expires_at) — migration 0500, the LIVE resolution engine
--           (`src/modules/feature_flags/services.ts` resolveFlag/isFlagOn), reads this
--           table exclusively (tenant > org > global > code-registry precedence) and
--           the admin UI (`src/routes/features.ts`) reads/writes it exclusively too.
--
-- This migration is ADDITIVE ONLY (per [[one-way-two-way-doors]] — a column drop is a
-- one-way door held this fire; see OPERATING-PRINCIPLES canonical answer #3). It:
--   1. Adds the 4 modern columns (`key`, `enabled_v2`, `rollout_percent`, `stage`) to
--      the LEGACY `feature_flags` table so its shape converges toward the universal
--      [[feature-flags]] rule's documented D1 contract (key/enabled/rollout_percent/
--      stage/description/owner_email), without renaming or dropping `flag_name`/
--      `enabled`/`metadata_json` — those stay inert-but-present for any out-of-tree
--      reader and as a historical record. `enabled_v2` (not `enabled`) avoids a
--      same-name type collision with the existing INTEGER `enabled` column.
--   2. Backfills every existing legacy-shaped row (`key` NULL) by parsing
--      `metadata_json` — `key` ← `flag_name` (the registry key), `enabled_v2` ←
--      existing `enabled`, `rollout_percent` ← `json_extract(metadata_json,
--      '$.rollout_percent')` (default 0), `stage` ← `json_extract(metadata_json,
--      '$.stage')` (default 'experimental'). D1/SQLite ships `json_extract` natively
--      (no extension needed).
--   3. Adds a UNIQUE index on `key` (partial, WHERE key IS NOT NULL AND deleted_at IS
--      NULL) so future governance-seed migrations can `INSERT ... ON CONFLICT(key) DO
--      UPDATE` instead of the current `id`-keyed `INSERT OR IGNORE` (which silently
--      no-ops a re-seed with updated metadata — a latent footgun this leaves fixable
--      without a further migration).
--
-- NEVER drops/renames `flag_name`, `enabled`, or `metadata_json` — those remain
-- readable+documented-inert. `flag_overrides` (the live table) is UNTOUCHED — it was
-- already fully modern-shaped; no columns added, no rows backfilled, nothing to do.
--
-- Idempotent: every statement uses IF NOT EXISTS / is safe to re-run; the backfill
-- UPDATE is scoped to `WHERE key IS NULL` so re-running it after a partial apply is a
-- no-op for already-backfilled rows.

-- ── 1. Add modern columns to the legacy table (nullable / defaulted — zero blast
--       radius on existing writers, which never reference these columns) ──────────
ALTER TABLE feature_flags ADD COLUMN key TEXT;
ALTER TABLE feature_flags ADD COLUMN enabled_v2 INTEGER;
ALTER TABLE feature_flags ADD COLUMN rollout_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feature_flags ADD COLUMN stage TEXT NOT NULL DEFAULT 'experimental';

-- ── 2. Backfill modern columns from the legacy shape for every row that hasn't been
--       converged yet (key IS NULL is the "legacy-shaped row" marker going forward —
--       any row inserted post-migration via the modern path will set `key` directly) ──
UPDATE feature_flags
SET
  key = flag_name,
  enabled_v2 = enabled,
  rollout_percent = COALESCE(
    CAST(json_extract(metadata_json, '$.rollout_percent') AS INTEGER),
    0
  ),
  stage = COALESCE(
    json_extract(metadata_json, '$.stage'),
    'experimental'
  )
WHERE key IS NULL
  AND flag_name IS NOT NULL;

-- ── 3. Unique index on the new `key` column so future seeds can upsert by key
--       (partial: only rows that HAVE a key participate; legacy rows that somehow
--       never backfilled — e.g. a NULL flag_name — never collide) ──────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_key
  ON feature_flags(key)
  WHERE key IS NOT NULL AND deleted_at IS NULL;
