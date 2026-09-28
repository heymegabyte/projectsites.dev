/**
 * Feature manifest — per-site Observability (Data & Resource Platform, one of the 5 per-kind surfaces).
 *
 * The site-owned Observability surface: an owner queries their OWN site's per-site-resource
 * logs/metrics (invocations, errors, latency, per-kind usage) over a 1–90 day window. Backed by the
 * account Analytics Engine dataset (the `analytics_engine` ResourceKind — the summary buckets it under
 * "observability"); the server builds AE SQL scoped `WHERE blob3 = siteId`, and is HONEST that ingest
 * is currently disabled (`available:false`) rather than fabricating numbers. Read-only — no mutation
 * path. The read dispatch already lives in the `data_resource_registry` analytics_engine adapter
 * (`adapters/analytics_engine.ts`) and the parity MCP tools `data_observability_*` / `data_analytics_*`;
 * BOTH the routes + tools are gated on THIS flag (`per_site_observability`). Server-resolved from the
 * authed { site_id } reusing `assertSiteOwned`; a foreign site's telemetry is never returned. Distinct
 * from the platform-wide analytics/data-overview surfaces (which read the master D1). Reached from the
 * editor Data tab's Namespace Summary "Observability" tile. Flag DARK → the routes + MCP tools 404.
 *
 * Ties the reserved `per_site_observability` flag to its owning surface so the flag is NOT an orphan.
 */
export const manifest = {
  slug: 'data_observability',
  name: 'Observability (per-site)',
  description:
    'Per-site Observability drill-in (editor Data tab, from the Namespace Summary tile): read a site’s OWN resource logs/metrics (Analytics Engine), owned-gated + read-only. DARK when off.',
  flagKey: 'per_site_observability',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
  unitTests: ['../libs/features/platform_mcp/__tests__/platform_mcp_data_analytics.test.ts'],
};
