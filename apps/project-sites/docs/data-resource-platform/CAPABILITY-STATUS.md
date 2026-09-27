# Capability Status — Honest per-Kind LIVE vs Not-Available

> The USER-facing honesty ledger for the Data & Resource Platform. `CAPABILITY-MATRIX.md` documents
> what the Cloudflare API *could* support; THIS file documents what is **actually wired and LIVE on
> this deployment** vs **honestly `not_available`** (with the CF reason) vs **requires-platform-admin**.
> Nothing that is mock-only, unsupported, or unwired is marked complete. Directive step-4 gate:
> "Do NOT call an unsupported or mock-only control complete."

## Legend

- **LIVE** = adapter method + MCP tool + tests green, reachable behind its flag (dispatches a real CF
  REST call or a real D1 read).
- **not_available** = the surface exists and returns an HONEST typed `not_available`/`available:false`
  result WITH the CF reason — never fabricated data, never a fake success. This IS the correct,
  complete behavior for a thing CF can't back.
- **requires-platform-admin** = a real control that exists but is gated to a platform operator
  (super-admin), not the site owner.
- **⛔ impossible** = no CF API can ever back it (a structural fact, not a missing feature).
- **DARK** = built + tested but flag-off (404 on the customer surface) until the go-live flip.

## Overall status

- **Code:** all 9 `ResourceKind` adapters + backend inventory + 45 `data_*` MCP tools + the 4 HTTP
  routes are built, typecheck-clean, and unit-tested (Phase 0 foundation + Phases 1–8 read/write
  layers, per `PROGRESS-LEDGER.md`).
- **Live reachability:** the whole surface is **DARK** behind `data_resource_platform` + the per-kind
  `per_site_*` flags (all default OFF/experimental). The per-site **D1 Tables** read surface
  (`/api/sites/:siteId/db/tables`, flag `per_site_data`) is the one already-live seed.
- **Go-live gate:** apply migrations **`0643`** (`site_resource_registry` + `site_database_allocations`
  sync columns) **+ `0644`** (`data_query_history`) to prod D1 (additive, run once), then flip the flags
  in `/admin/feature-flags`, then prod-verify. Until then, treat every row below as "code-complete,
  DARK".
- **Editor UI:** adapter + MCP + HTTP layers are complete for every kind; several per-kind editor
  write UIs (KV/R2/Vectorize/Workflows/DO panels) are the remaining build items (`PROGRESS-LEDGER.md`
  "Remaining: editor UI"). The generic `ResourceDetailPanel` + `WriteControls` already render every
  kind's read + write via the detail/mutate endpoints.

## D1 — the live keystone

| Op | Status | Notes |
|---|---|---|
| Table list / row browse | **LIVE** (`per_site_data`) | `/api/sites/:siteId/db/tables[/:table]` — the seed surface. Schema via `sqlite_master`. |
| Paginated row read | **LIVE** | `data_read_table` clamp 1..200, org-scoped. |
| Parameterized write (`exec`) | **LIVE** | Single-statement, leading-keyword classifier (read/mutating/destructive), unknown fails-closed, ground-truth `rows_written`, multi-statement refused, destructive confirm-gated. |
| EXPLAIN / migration history | **LIVE** | `explain` (refuses mutating SQL), `migrations` (reads `d1_migrations`, honest-empty when absent). |
| Backup / PITR (Time Travel) | **LIVE** | CF REST Time Travel IS exposed: `time_travel_info` (bookmark + 30-day window) + `restore` (confirm-gated DESTRUCTIVE whole-DB revert). |
| Query history | **LIVE** | Records the statement TEMPLATE only (no param values), org+site-scoped, fire-and-forget (never blocks). Needs migration `0644`. |
| Provision per-site D1 | **LIVE** | `data_provision_resource` / `mutate action:provision` — confirm-gated (billable), idempotent, real account quota-check. |
| **not_available:** PRAGMA introspection | not_available (CF) | CF REST `/query` blocks `PRAGMA` (SQLite authorizer) — use `sqlite_master`. |
| **not_available:** cross-site query, multi-statement scripts, streaming | not_available (CF) | Single parameterized statement per `/query`; no cross-site; parsed rows + `meta`, no stream. |

## KV — dedicated backend-ready, shim in use

| Op | Status | Notes |
|---|---|---|
| Key list (cursor+prefix), get, put, delete | **LIVE code, DARK** (`per_site_kv`) | `list_complete` + `cursor` exposed honestly (never a claimed total). Put/delete confirm-gated on overwrite/destructive, fail-closed on indeterminate probe. |
| Bulk get / bulk delete | **LIVE code, DARK** | ≤10k CF cap enforced — never truncates a destructive op; de-duped; reports count. |
| Provision per-site KV | **LIVE** | Via `data_provision_resource`. |
| **Dedicated KV resource** | **inert until provisioned** | `kv_provisioner.ts` + migration 0634 exist but are uncalled until `data_provision_resource` runs → adapter honestly returns `not_registered` for an unprovisioned site. The live per-site path today is the shared-shim (`__PS_KV` `site:<id>:` prefix). |
| **not_available:** value full-text search | not_available (CF) | List is key-prefix + cursor only; no server-side value search. Eventual consistency (~60s) → a just-written key may 404 briefly (surfaced as "propagating"). |

## R2 (data bucket) — dedicated backend-ready, shim in use

| Op | Status | Notes |
|---|---|---|
| Object list (prefix+continuation), head, get (metadata) | **LIVE code, DARK** (`per_site_r2`) | Manages the site's DATA bucket, NEVER the deploy-artifact bucket (`SITES_BUCKET` `sites/{slug}/…`) — INV-7. |
| Put / delete object | **LIVE code, DARK** | Confirm-gated destructive; large (>25 MiB) → signed-URL note; no creds leak. |
| Bucket config (CORS/lifecycle) | **LIVE code, DARK** (read) | Owner-readable. |
| Preview URL | **LIVE code, DARK** | Content-type classify; honest `available:false` when signing is unwired (no creds fabrication). |
| Provision per-site R2 | **LIVE** | Via `data_provision_resource`. |
| **Dedicated R2 resource** | **inert until provisioned** | `r2_provisioner.ts` exists but is uncalled → honest `not_registered` for an unprovisioned site. Live per-site path today is the shim (`__PS_R2` `sites-data/<id>/`). |
| **not_available:** multipart upload | not_available (CF) | Per-site REST buckets have no multipart lifecycle + the S3 API needs creds kept server-side. Part-size/count limits + ascending-parts + overwrite-confirm are still enforced+tested; MCP carries handles only (no body); server-proxy approach documented. |
| **requires-platform-admin:** public access / custom domain | requires-platform-admin | `bucket_config` returns `requiresPlatformAdmin:true` with an honest reason — no fake CRUD. |
| **not_available:** object-body search | not_available (CF) | List is prefix + cursor; large objects stream, never buffered. |

## Vectorize / AI-Search — shared index, per-site namespace

| Op | Status | Notes |
|---|---|---|
| Namespace summary (`list`), describe, get-by-ids | **LIVE code, DARK** (`per_site_vectorize`) | Namespace `site-<id8>` inside the shared `projectsites-rag` index; foreign vectors filtered out. |
| Upsert / delete by id | **LIVE code, DARK** | Namespace force-scoped (smuggled namespace stripped on upsert); delete confirms in-namespace ids first so cross-site delete is structurally impossible; confirm-gated. |
| **Dedicated Vectorize resource** | **inert** | Per-site Vectorize provisioning is unwired → an unprovisioned site honestly returns `not_registered`; the reconciler records NO vectorize allocation (never fabricated). |
| **not_available:** vector query, per-site index, AutoRAG | not_available (CF) | Query verb is remaining work; per-site DEDICATED index ⛔ (namespace ≠ quota, HARD FACT #4); AutoRAG binding is commented (`rag.ts` falls back to Vectorize + Llama). |

## Connections (external providers / DB connections)

| Op | Status | Notes |
|---|---|---|
| List / describe connections | **LIVE code, DARK** (`per_site_connections`) | Reads `mcp_connections` (secret-free column allowlist, masked host). NOT a CF resource — the per-site OAuth/paste-key providers. |
| **not_available:** revoke, health probe | not_available (remaining) | Revoke + health probe + editor UI are remaining work. |
| **⛔ impossible:** read a stored secret back | ⛔ | Secrets are AES-GCM at rest (`MCP_ENCRYPTION_KEY`), never decrypted to the client. No Hyperdrive/external-DB binding exists on this deployment. |

## Workflows

| Op | Status | Notes |
|---|---|---|
| Run-instance list, status/steps | **LIVE code, DARK** (`per_site_workflows` + `mcp_server`) | Actual CF status, never optimistic; steps sanitized. Instance id is site-bound. |
| Start / pause / resume | **LIVE code, DARK** | `start` needs no confirm. |
| Restart / terminate | **LIVE code, DARK** | Confirm-gated; replay/state-discard warnings; instance bound to workflow name+id → foreign impossible. |
| **not_available:** per-site workflow DEFINITION | not_available (CF) | Definitions are code-deployed, not API-created. Workflows are `shared_platform` (6 platform bindings); the registry associates a RUN with a site. An unprovisioned site honestly returns `not_registered`. |

## Durable Objects — ops-only

| Op | Status | Notes |
|---|---|---|
| Class-namespace list, id describe | **LIVE code, DARK** (`per_site_durable_objects`) | `instancesEnumerable:false`, `stateBrowsable:false` — surfaces namespaces/ids only, never state. Only `SITE_BUILDER` is bound; no per-site DO → honest `not_registered`. |
| Manage (`status_probe` / `reset`) | **LIVE code, DARK** | CLOSED enum — NO arbitrary-method passthrough (rejected at the Zod boundary); confirm-gated reset. |
| **⛔ impossible:** browse all instances / read arbitrary instance state / list instances via CF | ⛔ | There is NO CF API to enumerate DO instances or read arbitrary state (HARD FACT #3). Peek ≠ history (HARD FACT #1). |

## Queues

| Op | Status | Notes |
|---|---|---|
| List / describe (config+metrics+DLQ+backlog) | **LIVE code, DARK** (`per_site_queues`) | Honest `not_available` — there is **NO `QUEUE` binding** on this deployment (producer + consumer blocks commented; code falls back to Workflows). `queue` is in `UNSUPPORTED_KINDS` so `resolveResourceRef` returns `unsupported_kind` upstream. |
| Send (produce) | **LIVE code, DARK** | Producer-only, site-scoped; honest `not_available` without a binding. |
| **not_available / ⛔:** message history, browse-without-lease | ⛔ | ⛔ no message-history/log API (peek = current head, HARD FACT #1); pull = leases + ack (reading leases a message, HARD FACT #2). On this deployment: everything (no binding). If ever enabled, MUST label "current messages (leased)", never "history". |

## Analytics Engine / Observability — read-only

| Op | Status | Notes |
|---|---|---|
| Dataset + dimension list, site-scoped event summary | **LIVE code, DARK** (`per_site_observability`) | Server-built AE SQL scoped `WHERE blob3=siteId`; 1–90 day window. |
| **not_available:** any of it, right now — INGEST DISABLED | available:false (this deployment) | `ANALYTICS_INGEST_ENABLED="false"` → the adapter honestly reports `available:false` (never a fabricated event stream). The dataset `projectsites_admin_v1` is `shared_platform`, `WHERE`-scoped per site, not per-site. |
| **not_available:** client writes, unsampled export, history beyond retention | not_available (CF) | No customer-surface writes; SQL read is sampled (~3 months). Reconcile display against ground truth (`visitor_events`/`form_submissions` in the MASTER D1, not the per-site D1) per `verify-against-source-of-truth`. |

## Backend inventory (scheduled tasks + Worker bindings + secrets)

| Op | Status | Notes |
|---|---|---|
| Scheduled tasks (Cron Triggers) | **LIVE code, DARK** (`data_backend_inventory`) | From `site_functions_schedules` — WfP has NO native cron; runs via the platform `scheduled()` dispatcher. |
| Worker bindings inventory | **LIVE code, DARK** | Each binding carries `managed` + `manageRoute` (when a real management surface exists) OR honest `managed:false` + `notAvailableReason` — no fake CRUD for products whose APIs aren't integrated (Secrets Store / AI / Browser Rendering / Images are read-only presence + doc link). |
| Secret NAMES + last-change | **LIVE code, DARK** | ⛔ NEVER secret VALUES — SELECTs `key/scope/is_secret/created_at/updated_at` only; no `value`/`ciphertext` field exists on the shape (value-leak test enforced). |

## One-line summary per kind (LIVE vs not_available)

- **D1** — LIVE (list/read live behind `per_site_data`; write/EXPLAIN/migrations/Time-Travel/history/provision built; not_available: PRAGMA, cross-site, multi-statement).
- **KV** — read+write+bulk+provision built (DARK); dedicated resource inert until provisioned; not_available: value search (eventual consistency).
- **R2** — list/head/get/put/delete/bucket-config/preview+provision built (DARK); dedicated inert until provisioned; not_available: multipart (per-site REST buckets), body search; requires-platform-admin: public-access/custom-domain; NEVER the deploy-artifact bucket.
- **Vectorize** — namespace list/describe/upsert/delete built (DARK); not_available: query (remaining), per-site index (⛔ namespace≠quota), AutoRAG (commented).
- **Connections** — list/describe built (DARK); not_available: revoke+health (remaining); ⛔ read secret back; no Hyperdrive/external-DB binding.
- **Workflows** — run list/status/start/pause/resume/restart/terminate built (DARK); not_available: per-site DEFINITION (code-deployed only).
- **Durable Objects** — namespace/id describe + status_probe/reset built (DARK); ⛔ browse-all-state, list-instances-via-CF, state read.
- **Queues** — list/describe/send built but honest not_available — NO `QUEUE` binding on this deployment; ⛔ message history; pull=leases+ack.
- **Analytics Engine** — dataset list + site summary built but honest available:false — INGEST DISABLED (`ANALYTICS_INGEST_ENABLED="false"`); shared dataset, read-only, sampled.
- **Backend inventory** — cron triggers + bindings (managed/not-available honesty) + secret NAMES built (DARK); ⛔ secret values.
