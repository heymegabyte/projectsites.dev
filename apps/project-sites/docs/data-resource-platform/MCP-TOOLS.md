# MCP Tools — ProjectSites `data_*` (UI ↔ MCP Parity Reference)

> The complete list of Data & Resource Platform tools on the **platform MCP**
> (`libs/features/platform_mcp/service.ts`) — the only wired JSON-RPC transport. Every tool has a
> Data-tab / Backend-tab UI counterpart on the SAME server-side registry + authz services (INV-12):
> the MCP path is **no weaker** than the UI — it cannot reach a resource the tab couldn't, cannot skip
> the flag, and cannot supply a CF id.

## Contract (every tool)

- **Input always carries `{ site_id, environment }`** (both authed; `environment` = `preview | production`)
  plus per-kind non-identifier operands. A CF account id / database id / namespace id / bucket name is
  **NEVER** an input — the trusted service resolves it server-side (`resolveResourceRef`) from a row the
  caller's org owns.
- **Scope** — read tools require **`data:read`**; any mutation requires **`data:write`**. Both were added
  to `VALID_SCOPES` so resource tools don't ride `sites:read`/`sites:write`. Enforced at dispatch
  (`hasScope(token, tool.requiredScope)`).
- **Owned-site re-scope** — every tool re-runs `WHERE id=? AND org_id=?` on `token.org_id` (the MCP
  equivalent of `ownsSiteData`) and returns an `isError` result when the flag is off (never leaks).
- **Confirm gate** — destructive/billable mutations require `confirm: true`; the result is an honest
  `isError` (never a fabricated success) when confirmation is missing, quota is at cap, or the CF API
  can't back the op.
- **No credentials in the result** — the `{ content:[{type:'text',text}], isError? }` envelope carries
  resolved data + typed errors only; never `CfAuth`, `MCP_ENCRYPTION_KEY`, or any stored secret.

`environment` is omitted from the Inputs column below (it is on every tool). Inputs marked with `?` are
optional. Mutations that require `confirm:true` are noted in Purpose.

## Overview + reconcile (`data:read`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_list_resources` | data:read | site_id | List the site's allocated D1/KV/R2/DO/Workflow/Vectorize/Analytics resources. |
| `data_reconcile_resources` | data:read | site_id | Reconcile the registry vs CF; report per-kind drift. |

## D1 (`per_site_data`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_list_tables` | data:read | site_id | List tables in the per-site D1. |
| `data_read_table` | data:read | site_id, table, limit?, offset? | Read paginated rows from one table (1–200). |
| `data_d1_exec` | data:write | site_id, sql, params?, confirm? | Run ONE parameterized statement; classify read/mutating; destructive needs confirm. |
| `data_d1_explain` | data:read | site_id, sql, params? | EXPLAIN QUERY PLAN for a read statement (refuses mutating SQL). |
| `data_d1_migrations` | data:read | site_id | List applied migrations from `d1_migrations`. |
| `data_d1_query_history` | data:read | site_id, limit? | Recent query history — statement TEMPLATES + timing/effect (no param values). |
| `data_d1_time_travel_info` | data:read | site_id, timestamp? | Read Time Travel bookmark + 30-day recovery window. |
| `data_d1_restore` | data:write | site_id, bookmark?, timestamp?, confirm | Restore DB to a point in time (DESTRUCTIVE; confirm; bookmark XOR timestamp). |

## KV (`per_site_kv`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_kv_list_keys` | data:read | site_id, prefix?, cursor?, limit? | Cursor-paginated key list with optional prefix. |
| `data_kv_get` | data:read | site_id, key | Read one key's value + metadata. |
| `data_kv_put` | data:write | site_id, key, value, expiration_ttl?, metadata?, confirm? | Write one key; confirm required to overwrite. |
| `data_kv_delete` | data:write | site_id, key, confirm | Delete one key (confirm; idempotent). |
| `data_kv_bulk_get` | data:read | site_id, keys[] | Read many keys at once (clamped to the 10k CF cap). |
| `data_kv_bulk_delete` | data:write | site_id, keys[], confirm | Delete many keys at once (confirm; ≤10k, never truncated). |

## R2 data bucket (`per_site_r2`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_r2_list_objects` | data:read | site_id, prefix?, cursor?, limit? | Continuation-token paginated object list. |
| `data_r2_head_object` | data:read | site_id, key | Read object metadata only (size/etag/timestamps). |
| `data_r2_put_object` | data:write | site_id, key, body, content_type?, http_metadata?, custom_metadata?, confirm? | Write a small inline object; confirm to overwrite. |
| `data_r2_delete_object` | data:write | site_id, key, confirm | Delete one object (confirm; idempotent). |
| `data_r2_multipart_create` | data:write | site_id, key, content_type?, http_metadata?, custom_metadata? | Begin a multipart upload; returns upload_id + part limits. |
| `data_r2_multipart_complete` | data:write | site_id, key, upload_id, parts[], confirm? | Assemble parts into the final object; confirm if the key exists. |
| `data_r2_multipart_abort` | data:write | site_id, key, upload_id | Cancel an in-flight multipart (idempotent cleanup). |
| `data_r2_bucket_config` | data:read | site_id | Read bucket config (CORS, lifecycle; public-access = requires-platform-admin). |
| `data_r2_preview_url` | data:read | site_id, key | Get a scoped short-lived preview/download URL. |

## Vectorize / AI-Search (`per_site_vectorize`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_vectorize_list` | data:read | site_id | Summarize the site's vector namespace in the shared index. |
| `data_vectorize_describe` | data:read | site_id, ids[] | Index config + fetch vector metadata by id. |
| `data_vectorize_upsert` | data:write | site_id, vectors[] | Write vectors (namespace force-scoped; async). |
| `data_vectorize_delete` | data:write | site_id, ids[], confirm | Delete vectors by id (confirm; in-namespace only; async). |

## Connections (`per_site_connections`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_connections_list` | data:read | site_id | List the site's outbound/provider connections. |
| `data_connection_describe` | data:read | site_id, id | Read one connection's metadata (masked host, status). |

## Workflows (`per_site_workflows` + `mcp_server`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_workflows_list` | data:read | site_id, cursor?, limit? | List workflow run instances (paginated). |
| `data_workflow_get_instance` | data:read | site_id, id | Read one run's status + sanitized steps. |
| `data_workflow_start` | data:write | site_id, params? | Start a new run (idempotent; no confirm). |
| `data_workflow_control` | data:write | site_id, instanceId, op, confirm? | pause/resume/restart/terminate (restart/terminate need confirm). |

## Durable Objects (`per_site_durable_objects`)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_durable_objects_list` | data:read | site_id | List DO CLASS namespaces (never instances — no CF API exists). |
| `data_durable_object_describe` | data:read | site_id, id | Describe a named DO id (metadata only; state not browsable). |
| `data_durable_object_manage` | data:write | site_id, action, object_id, confirm? | Run a platform-defined op — CLOSED enum `status_probe`|`reset` (reset needs confirm). |

## Queues (`per_site_queues`) — honest not_available (no binding)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_queues_list` | data:read | site_id | List queue(s) config + metrics (not per-message; not_available without a binding). |
| `data_queue_describe` | data:read | site_id, id | Describe one queue's config + metrics. |
| `data_queue_send` | data:write | site_id, messages[], confirm? | Produce messages (1–100 non-empty strings; producer-only). |

## Observability / Analytics Engine (`per_site_observability`) — honest available:false (ingest off)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_analytics_list` | data:read | site_id | List AE datasets + custom-event dimensions. |
| `data_analytics_query_summary` | data:read | site_id, window_days? | Site-scoped event-count summary (1–90 day window). |

## Backend inventory + provisioning (cross-cutting)

| Tool | Scope | Inputs | Purpose |
|---|---|---|---|
| `data_backend_inventory` | data:read | site_id | Inventory scheduled tasks, Worker bindings, and secret NAMES (never values). |
| `data_provision_resource` | data:write | site_id, kind, confirm | Provision a per-site D1/KV/R2 (confirm — real billable infra; idempotent; account-quota-checked). |

## Totals

**45 `data_*` tools** — 28 `data:read`, 17 `data:write`. (`data_resource_platform` is the umbrella
FLAG key, not a tool.) Every one gates on its per-kind flag
(default OFF/experimental → `isError` when off) and re-scopes to the caller's owned site. Kinds whose
CF backing is absent on this deployment (Queues — no binding; Analytics Engine — ingest disabled)
expose their tools but return an honest `not_available`/`available:false` result, never fabricated
data. See `CAPABILITY-STATUS.md` for the per-op LIVE-vs-not_available breakdown.
