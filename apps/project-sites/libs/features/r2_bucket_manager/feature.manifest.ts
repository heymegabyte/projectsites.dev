/**
 * Feature manifest — R2 Bucket Manager.
 *
 * The authoritative, site-scoped catalog + view over ALL of a site's R2 surfaces: the protected
 * isogit "Project code · Preview" system bucket (surfaced but never mutable) UNIONED with the site's
 * OWN custom buckets. The layer ON TOP of the per-site custom-bucket plane (`r2_buckets` +
 * `site_r2_allocations`) — it reconciles them into one list the editor Resources → Buckets tab
 * renders. Service foundation in `src/services/site_r2_manager.ts`; catalog table `site_r2_buckets`
 * (migration 0647). Flag DARK by default → every route 404s until enabled, so zero real R2 resources
 * are created and the already-live `r2_buckets` surface is unaffected.
 */
export const manifest = {
  slug: 'r2_bucket_manager',
  name: 'R2 Bucket Manager',
  description:
    "Authoritative site-scoped R2 bucket manager in the editor Resources tab. Presents a site's buckets as ONE list: the protected isogit \"Project code · Preview\" system bucket (surfaced, never mutable — config/reset/empty/delete HARD-THROW server-side) unioned with the site's OWN custom buckets. Slice 1 ships the catalog (site_r2_buckets) + service foundation (resolveSiteBuckets + assertBucketMutable + assertBucketOwnedBySite); later slices add create/reset/delete/explorer/Code-selector. Reuses assertSiteOwned + FORBIDDEN_BUCKET_NAMES + ai_crypto (credential ref, never the secret). Flag-gated DARK → 404 when off.",
  flagKey: 'r2_bucket_manager',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
};
