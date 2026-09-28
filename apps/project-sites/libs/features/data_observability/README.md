# data_observability — per-site Observability surface

One of the 5 per-kind surfaces of the **Data & Resource Platform**. A site owner queries their site's
OWN per-site-resource logs/metrics (invocations, errors, latency, per-kind usage) over a 1–90 day
window, backed by the account **Analytics Engine** dataset (the `analytics_engine` ResourceKind — the
Namespace Summary buckets it under "observability"). The server builds AE SQL scoped
`WHERE blob3 = siteId` and is HONEST that ingest is currently disabled (`available:false`) rather than
fabricating numbers. Read-only — no mutation path. Reached from the **Observability** tile in the
Namespace Summary rollup (`app/components/workbench/NamespaceSummary.tsx`), which opens the drill-in
with `{ kind: 'analytics_engine' }` (mapped from the summary's `observability` key).

- **Flag:** `per_site_observability` (default OFF / DARK, `experimental`).
- **Backend (already shipped):** the `analytics_engine` adapter in
  `libs/features/data_resource_registry/adapters/analytics_engine.ts` (`list`/`get`) + the parity MCP
  tools `data_observability_*` / `data_analytics_*` in `libs/features/platform_mcp/service.ts`. BOTH the
  `/api/sites/:siteId/resources/:kind/detail` route (kind=`analytics_engine`) and the MCP tools gate on
  this flag.
- **Isolation:** server-resolved from the authed `{ site_id }` reusing `assertSiteOwned`; a foreign
  site's telemetry is never returned. Distinct from the platform-wide analytics / data-overview
  surfaces (which read the master D1).
- **Safe disabled behavior:** flag OFF → the routes + MCP tools **404 (never 403)** and the tile's
  drill-in renders the calm "not enabled yet" state. Nothing regresses.

This module's `feature.manifest.ts` ties the reserved flag to its owning surface (per
`feature-module-architecture` + `drift-detection`). This fire wired the reachable editor drill-in; the
adapter + MCP tools + their flag-off tests already existed.
