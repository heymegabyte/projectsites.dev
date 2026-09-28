# data_queues — per-site Queues surface

One of the 5 per-kind surfaces of the **Data & Resource Platform**. A site owner lists the queues bound
to their site's OWN resources, describes one (delivery delay, retention, DLQ, backlog,
producers/consumers), and sends a message. On THIS deployment there is **no `QUEUE` binding** (producer
+ consumer blocks are commented; the Worker falls back to Workflows), so `queue` is in
`UNSUPPORTED_KINDS` and the surface is HONEST — `resolveResourceRef` returns `unsupported_kind` and the
tile reads "Not available", never a fabricated queue. Reached from the **Queues** tile in the Namespace
Summary rollup (`app/components/workbench/NamespaceSummary.tsx`) — but a platform-unsupported tile is a
non-actionable tile (never a doomed control), so the Queues tile shows its honest "Not available" state
in place rather than opening a dead drill-in.

- **Flag:** `per_site_queues` (default OFF / DARK, `experimental`).
- **Backend (already shipped):** the `queue` adapter in
  `libs/features/data_resource_registry/adapters/queue.ts` (`list`/`get`/`send`) + the parity MCP tools
  `data_queues_*` in `libs/features/platform_mcp/service.ts`. BOTH the
  `/api/sites/:siteId/resources/:kind/*` routes (kind=`queue`) and the MCP tools gate on this flag.
- **Isolation:** server-resolved via `resolveResourceRef` reusing `assertSiteOwned`; the client never
  names a CF id. Distinct from `queues_inspector` (the shared-platform super-admin tool).
- **Safe disabled behavior:** flag OFF → the routes + `data_queues_*` MCP tools **404 (never 403)**.
  When a `QUEUE` binding exists in future, the Namespace Summary tile becomes an actionable drill-in
  automatically (its actionability derives from the resource being supported).

This module's `feature.manifest.ts` ties the reserved flag to its owning surface (per
`feature-module-architecture` + `drift-detection`). The adapter + MCP tools + their flag-off tests
already existed.
