# site_connections

Owner-facing **Connections panel** — the sixth Resources sub-tab in the bolt editor (beside Media / Files / Buckets / Automations / Functions). A read + disconnect view of a site's connected MCP (Model Context Protocol) providers (Mailchimp, Stripe, HubSpot, GitHub, Slack, …) with a status chip + connected-at. Access tokens are NEVER returned.

## No new backend — reuses `mcp_connections`

This feature ships **zero new worker routes**. It consumes the already-shipped routes in `libs/features/mcp_connections/handlers.ts`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sites/:siteId/mcp/connections` | List active connections (+ provider catalog) |
| DELETE | `/api/sites/:siteId/mcp/connections/:id` | Revoke a connection + clear its encrypted tokens |

Both are `orgId + userId + siteOwned`-guarded (404, never 403, on a foreign/missing site — no cross-org leak). Connect/OAuth is the **separate existing** `/api/mcp/:provider/connect` flow — this panel adds **no new OAuth**.

## Flag gates the TAB, not the endpoint

The `mcp/connections` endpoint is **shared** with the admin's `/admin/mcp` surface, so it is deliberately **NOT** flag-gated. The `site_connections` flag gates **only** the editor Resources → Connections TAB:

- The editor has no cross-origin session, so the React `ConnectionsPanel` asks the Angular admin parent over `postMessage` (`PS_RES_CONNECTIONS` / `PS_RES_CONNECTION_DISCONNECT`).
- `bolt-embed.service.ts` resolves `site_connections` via `GET /api/feature-flags/site_connections` **before** the list/delete fetch. Off/default/rollout-0 (`flagEnabled()` false) → `{ ok:false, enabled:false }` → the panel renders a friendly "not enabled" card and the tab self-hides. On → it proxies to the reused endpoint.

## Wiring

- **Editor tab**: `app/components/workbench/ResourcesPanel.tsx` (`Section` + `SECTION_ORDER` + tab def + render switch).
- **Editor panel**: `app/components/workbench/ConnectionsPanel.tsx` (+ `__tests__/connections-panel.spec.ts`).
- **Editor bridge**: `app/lib/embed/embedded-mode.ts` (`ConnectionEntry`, the two request/response message types, `requestConnections()` + `disconnectConnection(id)`).
- **Admin bridge**: `apps/project-sites/frontend/src/app/services/bolt-embed.service.ts` (`PS_RES_CONNECTIONS` + `PS_RES_CONNECTION_DISCONNECT` cases; `PsMessage.connectionId`).
- **Flag**: `src/modules/feature_flags/registry.ts` + `docs.ts` (`site_connections`, default OFF, experimental).
- **Verifier**: `e2e/editor-live/editor-nav.mjs` TAB_PROBES `connections` probe.

> Default DARK. The lead flips the prod flag + deploys (editor Pages · Angular admin R2 · Worker) + live-verifies.
