# data_connections — per-site Connections surface

One of the 5 per-kind surfaces of the **Data & Resource Platform**. A site owner reads their site's
OWN external service connections (`mcp_connections` providers — masked host, secret-free column
allowlist; a connection value is NEVER echoed) from the **editor Data tab**, reached by clicking the
**Connections** tile in the Namespace Summary rollup (`app/components/workbench/NamespaceSummary.tsx`)
which opens the generic `ResourceDetailPanel` with `{ kind: 'connection' }`.

- **Flag:** `per_site_connections` (default OFF / DARK, `experimental`).
- **Backend (already shipped):** the `connection` adapter in
  `libs/features/data_resource_registry/adapters/connection.ts` (read `list`/`get`) + the parity MCP
  tools `data_connections_*` in `libs/features/platform_mcp/service.ts`. BOTH the
  `/api/sites/:siteId/resources/:kind/detail` route (kind=`connection`) and the MCP tools gate on this
  flag.
- **Isolation:** server-resolved via `assertSiteOwned` (the IDOR guard); the client never names a CF
  id. A foreign site's connections are never returned.
- **Safe disabled behavior:** flag OFF → the route + `data_connections_*` MCP tools **404 (never 403)**
  and the tile's drill-in renders the calm "not enabled yet" state (`ResourceDetailPanel` disabled
  card). Nothing regresses.

This module's `feature.manifest.ts` ties the reserved flag to its owning surface so the flag is not an
orphan (per `feature-module-architecture` + `drift-detection`). This fire wired the reachable editor
drill-in; the read adapter + MCP tools + their flag-off tests already existed.
