# data_durable_objects — per-site Durable Objects surface

One of the 5 per-kind surfaces of the **Data & Resource Platform**. A site owner reads the Durable
Object namespaces bound to their site's OWN resources (class, script, id-derivation). Honest by
design: `instancesEnumerable:false`, `stateBrowsable:false` — Cloudflare cannot read DO state, so the
surface shows namespaces/ids only, never fabricated state. Reached from the **Durable Objects** tile in
the Namespace Summary rollup (`app/components/workbench/NamespaceSummary.tsx`), which opens the drill-in
with `{ kind: 'durable_object' }`.

- **Flag:** `per_site_durable_objects` (default OFF / DARK, `experimental`).
- **Backend (already shipped):** the `durable_object` adapter in
  `libs/features/data_resource_registry/adapters/durable_object.ts` (read `list`/`get` + a CLOSED
  status_probe|reset manage, no arbitrary-method passthrough) + the parity MCP tools `data_do_*` in
  `libs/features/platform_mcp/service.ts`. BOTH the `/api/sites/:siteId/resources/:kind/*` routes
  (kind=`durable_object`) and the MCP tools gate on this flag.
- **Isolation:** server-resolved via `resolveResourceRef` reusing `assertSiteOwned` + the shared-id
  denylist; the client never names a CF id. Only `SITE_BUILDER` is bound → honest `not_registered` when
  a site has no per-site DO.
- **Safe disabled behavior:** flag OFF → the routes + `data_do_*` MCP tools **404 (never 403)** and the
  tile's drill-in renders the calm "not enabled yet" state. Nothing regresses.

This module's `feature.manifest.ts` ties the reserved flag to its owning surface (per
`feature-module-architecture` + `drift-detection`). This fire wired the reachable editor drill-in; the
adapter + MCP tools + their flag-off tests already existed.
