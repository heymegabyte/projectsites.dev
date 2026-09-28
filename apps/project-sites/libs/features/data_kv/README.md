# data_kv — per-site KV surface

One of the 5 per-kind surfaces of the **Data & Resource Platform**. A site owner lists keys
(cursor-paginated), gets a value (size-capped + truncated flag), and puts/deletes keys in their site's
OWN dedicated Cloudflare **KV namespace** — NEVER the shared platform `CACHE_KV` / `PROMPT_STORE`.
Reached from the **KV** tile in the Namespace Summary rollup
(`app/components/workbench/NamespaceSummary.tsx`), which opens the drill-in with `{ kind: 'kv' }`
(the `KvBrowser` / generic `ResourceDetailPanel` read+write path).

- **Flag:** `per_site_kv` (default OFF / DARK, `experimental`).
- **Backend (already shipped):** the `kv` adapter in
  `libs/features/data_resource_registry/adapters/kv.ts` (`list`/`get`/`put`/`delete` + bulk) + the
  parity MCP tools `data_kv_*` in `libs/features/platform_mcp/service.ts`. BOTH the
  `/api/sites/:siteId/resources/:kind/detail`+`/mutate` routes (kind=`kv`) and the MCP tools gate on
  this flag.
- **Isolation:** server-resolved to the site's OWN `kv_namespace_id` (from `site_database_allocations`)
  via `resolveResourceRef` reusing `assertSiteOwned`; the client never supplies a namespace id.
  Distinct from `kv_inspector` (the shared-platform super-admin tool), which is unaffected.
- **Safe disabled behavior:** flag OFF → the routes + `data_kv_*` MCP tools **404 (never 403)** and the
  tile's drill-in renders the calm "not enabled yet" state. Nothing regresses.

This module's `feature.manifest.ts` ties the reserved flag to its owning surface (per
`feature-module-architecture` + `drift-detection`). This fire wired the reachable editor drill-in; the
adapter + MCP tools + their flag-off tests already existed.
