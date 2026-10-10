-- 0649 — B2: retire the legacy 'uploads'/'production' DEFAULT display names → 'Preview'/'Production'.
--
-- DISPLAY-NAME ONLY. The physical `bucket_name` (ps-site-{siteId}-uploads) and every object are
-- UNTOUCHED: resolveSiteR2Allocation() looks up by the CURRENT display_name and uses the stored
-- bucket_name for every physical op, so renaming the label preserves the bucket + its contents.
-- provisionSiteR2() early-returns on an existing (site, display_name), so ensureDefaultSiteR2 reuses
-- the migrated row rather than creating a second '…-preview' bucket.
--
-- Additive + reversible (rename back) + idempotent (re-run is a no-op once renamed). Collision-guarded:
-- never rename INTO a display_name that already exists for the same site (that would make the by-name
-- resolver ambiguous). Scope: ONLY the site's is_default preview bucket + its production bucket — a
-- CUSTOM bucket a user happened to name 'uploads' is left alone.

UPDATE site_r2_allocations
   SET display_name = 'Preview', updated_at = datetime('now')
 WHERE is_default = 1
   AND environment = 'preview'
   AND display_name = 'uploads'
   AND deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM site_r2_allocations existing
      WHERE existing.site_id = site_r2_allocations.site_id
        AND existing.display_name = 'Preview'
        AND existing.deleted_at IS NULL
   );

UPDATE site_r2_allocations
   SET display_name = 'Production', updated_at = datetime('now')
 WHERE environment = 'production'
   AND display_name = 'production'
   AND deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM site_r2_allocations existing
      WHERE existing.site_id = site_r2_allocations.site_id
        AND existing.display_name = 'Production'
        AND existing.deleted_at IS NULL
   );
