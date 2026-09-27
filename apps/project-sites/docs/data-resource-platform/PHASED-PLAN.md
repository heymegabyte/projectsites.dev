# Phased Implementation Plan

> Section 1 companion to `DESIGN.md`. The implementation phases AFTER this foundation (registry
> schema + adapter interface + resolver). One phase per resource kind, each listing the **UI section**
> + **parity MCP tools** + **adapter methods** + **tests**, ordered by value (discovery/overview
> first). Every phase obeys `SECURITY-INVARIANTS.md`, ships behind a flag, and ends green per
> `verification-loop` (deploy + prod-E2E on a changed route).
>
> **UI transport constraint (applies to EVERY phase):** the embedded editor (`editor.projectsites.dev`
> iframe) **cannot call the Worker API directly** — it speaks to the Angular admin via the `PS_*`
> postMessage bridge (`BoltEmbedService`). So every editor-side resource surface adds a
> `PS_RES_*_REQUEST/RESPONSE` pair (mirroring the live `PS_SITEDB_TABLES_REQUEST/RESPONSE`), the
> Angular host makes the authed API call, and posts the result back. The Angular admin can call the
> API directly. Never wire the editor to fetch the API itself.

## Tab assignment (Data vs Backend)

**Directive (Brian, 2026-09-27):** the resource surface splits across TWO editor tabs. The phase
sections below are ORDERED so every DATA-tab phase ships before every BACKEND-tab phase; each phase's
detailed spec is unchanged — only the sequence and the tab label are added.

- **DATA tab** — the data/storage plane: **D1**, **KV**, **R2**, **database connections**
  (Hyperdrive / external DB), and **Vectorize / AI-Search** (it is a data + search STORE, so it lives
  with the data plane, not the compute plane).
- **BACKEND tab** (the FINAL tab) — the compute/bindings plane: **Durable Objects**, **Workflows**,
  **Queues**, **scheduled tasks** (Cron Triggers), and **Worker bindings** (service bindings, Secrets
  Store, AI, Browser Rendering, Images, etc.).
- **Overview / discovery is SHARED** (Phase 1): it is not one tab's — EACH tab renders its OWN
  reconciled inventory (the Data tab lists its data-plane rows; the Backend tab lists its compute-plane
  rows) from the same registry + reconciler. One panel component, two filtered views.
- **Observability is CROSS-CUTTING → surfaced under BACKEND.** Site-filtered logs + Analytics Engine
  are Worker-LEVEL signals (they describe the running Worker, not a single data store), so they render
  on the Backend tab — noted explicitly here so a later fire doesn't file them under Data.

| Phase | Kind | Tab |
|---|---|---|
| 0 | Foundation (registry + adapter + resolver) | shared |
| 1 | Discovery / Overview | shared (per-tab filtered view) |
| 2 | D1 | Data |
| 3 | KV | Data |
| 4 | R2 | Data |
| 5 | Vectorize / AI-Search | Data |
| 8 · Connections | Hyperdrive / external DB connections | Data |
| 6 | Workflows | Backend |
| 7 | Durable Objects | Backend |
| 8 · Queues + Worker bindings + Observability | Queues · Cron Triggers · Worker bindings · logs + Analytics Engine | Backend |

Note: Phase 8 is split across BOTH tabs by concern — its **Connections** half (DB connections) is a
DATA-tab surface; its **Queues + scheduled-tasks + Worker-bindings + Observability** half is a
BACKEND-tab surface. Build the Connections half with the Data-tab wave, the rest with the Backend wave.

## Phase 0 (FOUNDATION — this directive, do first)

Ships the shared model everything else builds on:

- Migrations `0635` (extend `site_database_allocations` — sync/drift/deletion cols) + `0636`
  (`site_resource_registry`).
- `libs/features/site_resources/` module: `manifest.ts` (flag `site_resource_platform`), `schemas.ts`
  (Zod for every enum + envelope), `types.ts` (§2 concepts), `resolver.ts` (generalised
  `resolveResource`), `adapter.ts` (interface), `reconcile.ts` (head-based drift), `service.ts`.
- `data:read` + `data:write` scopes added to `VALID_SCOPES` (`api_tokens.ts`).
- Tests: resolver IDOR/flag/denylist/preview-isolation unit tests; schema round-trip; drift-code
  enum. **Gate: green before Phase 1.**

## Phase 1 — Discovery / Overview (HIGHEST VALUE, do first after foundation) — Tab: SHARED

The single screen that answers "what does this site have?" — the reconciled inventory across all
kinds. Highest value because it's the entry point, needs no per-kind write, and surfaces drift.
**Shared across both tabs**: the Data tab renders the data-plane rows, the Backend tab renders the
compute-plane rows — one panel component, two filtered views over the same registry + reconciler.

- **UI section**: "Resources" overview in the Data tab — a list of the site's registry rows (Table A
  allocations + Table B rows) grouped by kind × environment, each with lifecycle_state, tenancy,
  last_sync, drift badge, usage chip. Empty state = "provision" launchpad per `embarrassingly-easy`.
  Editor bridge: `PS_RES_OVERVIEW_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_resources({ site_id, environment? })` (the recon's named tool) +
  `data_reconcile_resources({ site_id })` (runs `head` sweep, returns drift). Copy `list_snapshots`
  as the template; owned-check + `ok()`.
- **Adapter methods**: `head` for every implemented kind (existence/metadata probe) + the reconciler
  calling them.
- **Tests**: overview returns only the caller's site (foreign→404); reconcile flags a
  `resource_missing_on_cf` when a row's CF `head` 404s; MCP tool re-scopes on `token.org_id`;
  prod-E2E asserts the overview renders live for a real site.

---

# DATA-tab phases (ship BEFORE Backend-tab phases) — D1 · KV · R2 · Vectorize · Connections

## Phase 2 — D1 (ENHANCE the live surface) — Tab: DATA

D1 is already live (`per_site_data`); this phase formalises it behind the adapter + adds parity MCP.

- **UI section**: existing "Tables" surface (`SiteTablesPanel`, `/api/sites/:siteId/db/tables`) —
  keep, re-route through the adapter; add table-schema view, parameterized row write (gated), seed.
  Bridge already exists: `PS_SITEDB_TABLES/ROWS_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_tables` · `data_read_table({ site_id, table, limit, offset, environment? })`
  · (write later) `data_query_write` — all `data:read` except the gated write.
- **Adapter methods**: `d1.list` (tables) · `d1.get` (page) · `d1.head` · `d1.mutate:{provision,seed,
  query_write,destroy}` — wrap `resolveSiteDataDb` + `listSiteTables` + `site_data_api` handlers.
- **Tests**: reuse `site_data_db.test.ts` + `site-db.test.ts`; add adapter contract test + MCP
  owned-check; no-PRAGMA + single-statement assertions; `per-site-d1.spec.ts` extended.

## Phase 3 — KV (wire the ready backend) — Tab: DATA

`kv_provisioner.ts` + allocation columns exist; build the surface (flag `per_site_kv`).

- **UI section**: "KV" — key list (cursor-paginated, honest `list_complete`+`cursor`, no fake total),
  value get/put/delete, bulk delete, TTL. Bridge: `PS_RES_KV_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_kv_keys` · `data_get_kv` · `data_put_kv` (write) · `data_delete_kv` (write).
- **Adapter methods**: `kv.list` (keys+cursor) · `kv.get` (value) · `kv.head` · `kv.mutate:{provision,
  put,delete,bulk_delete,destroy}`.
- **Tests**: provision idempotency (`kv_provisioner` test exists to extend); cursor pagination
  honesty; put→get→delete causal; eventual-consistency "propagating" state; foreign→404; prod-E2E.

## Phase 4 — R2 data bucket (wire the ready backend) — Tab: DATA

`r2_provisioner.ts` + `r2_bucket_name` exist; build the surface (flag `per_site_r2`).

- **UI section**: "Storage (R2)" — object list (prefix + continuation token), object get (stream /
  presign), put, delete, size/type. MUST NOT expose the deploy-artifact prefix (INV-7). Bridge:
  `PS_RES_R2_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_objects` · `data_get_object` · `data_put_object` (write) ·
  `data_delete_object` (write).
- **Adapter methods**: `r2.list` (objects+token) · `r2.get` (stream/presign) · `r2.head` ·
  `r2.mutate:{provision,put,delete,destroy}`.
- **Tests**: deploy-artifact prefix is unreachable from the data surface; presign scoping; streaming
  large object (no buffer); foreign→404; prod-E2E.

## Phase 5 — Vectorize / AI-Search (namespace partition) — Tab: DATA

Index bound (`RAG_INDEX`); surface the per-site NAMESPACE (not a per-site index). Vectorize is a
data + search STORE → it lives on the DATA tab with D1/KV/R2, not the compute-plane Backend tab.

- **UI section**: "AI Search (Vectorize)" — list the site's namespaces (from our metadata index),
  query within the namespace, upsert/delete-by-ids scoped to it, index dim/metric display. Bridge:
  `PS_RES_VEC_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_vector_namespaces` · `data_query_vectors` · `data_upsert_vectors` (write)
  · `data_delete_vectors` (write).
- **Adapter methods**: `vectorize.list` (namespaces) · `vectorize.get`/`query` · `vectorize.head`
  (index meta) · `vectorize.mutate:{upsert,delete_by_ids}` — all namespace-scoped; reuse
  `services/rag.ts` partitioning.
- **Tests**: cross-namespace query is impossible (scope enforced); namespace≠index assertion; AutoRAG
  fallback path; foreign→404; prod-E2E.

---

# BACKEND-tab phases (ship AFTER Data-tab phases) — Workflows · Durable Objects · Queues · scheduled tasks · Worker bindings · Observability

> The Backend tab is the FINAL tab. Build the DATA-tab surfaces (Phases 2–5 + the Connections half of
> Phase 8) first; then this compute/bindings plane. Observability (logs + Analytics Engine) is
> cross-cutting but surfaces HERE — it describes the running Worker, not any single store.

## Phase 6 — Workflows (run instances, read-heavy) — Tab: BACKEND

Platform workflows bound; surface per-site RUNS.

- **UI section**: "Workflows" — list the site's own runs (server-scoped to runs triggered for the
  site), one run's status/steps/errors, retry/terminate. Plus per-site schedule management
  (`site_functions_schedules`, since WfP has no native cron). Bridge: `PS_RES_WF_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_workflow_runs` · `data_get_workflow_run` · `data_trigger_workflow`
  (write) · `data_terminate_workflow` (write).
- **Adapter methods**: `workflow.list` (runs) · `workflow.get` (run) · `workflow.head` (binding) ·
  `workflow.mutate:{trigger,terminate,resume}`.
- **Tests**: run listing scoped to the site (no cross-site runs); trigger→status causal; schedule
  CRUD; foreign→404; prod-E2E.

## Phase 7 — Durable Objects (opt-in instance ops ONLY) — Tab: BACKEND

Honest, narrow: `SITE_BUILDER` only; NO state browse.

- **UI section**: "Compute (Durable Objects)" — list instances **from our own index** (CF has no list
  API), each instance's explicitly-exposed status, reset/send (addressed). A prominent honest note:
  "arbitrary DO state is not browsable" (⛔ HARD FACT). Bridge: `PS_RES_DO_REQUEST/RESPONSE`.
- **MCP tools**: `data_list_do_instances` (our index) · `data_reset_do_instance` (write, addressed) ·
  `data_send_do` (write, addressed).
- **Adapter methods**: `durable_object.list` (our index) · `durable_object.get` (exposed status) ·
  `durable_object.head` (class binding) · `durable_object.mutate:{reset_instance,send}` — all
  addressed to a known instance; `list`/`get` of arbitrary state return `not_supported`.
- **Tests**: browse-all-state is not offered (returns `not_supported`); addressed reset works;
  foreign→404; prod-E2E.

## Phase 8 — Connections (DATA tab) + Queues/scheduled-tasks/Worker-bindings/Observability (BACKEND tab)

Low-lift closers, SPLIT across both tabs by concern. Build the **Connections** half with the DATA-tab
wave (it's a DB-connection surface); build the rest with the BACKEND-tab wave.

- **Connections (read + revoke) — Tab: DATA**: "Connections" section lists **Hyperdrive / external
  DB connections** + `mcp_connections` + health, revoke. This is the database-connection member of the
  data plane, so it lives on the DATA tab beside D1/KV/R2. MCP: `data_list_connections` ·
  `data_revoke_connection` (write). Adapter `connection.{list,get,head,mutate:revoke}`. Tests: revoke
  revokes the external token; no secret returned; foreign→404; prod-E2E. Bridge:
  `PS_RES_CONN_REQUEST/RESPONSE`.
- **Queues (`not_supported` today) — Tab: BACKEND**: render the section as "not enabled on this
  account" (no `QUEUE` binding) — never a fake empty queue. Adapter returns `not_supported` for every
  verb; MCP tool returns an honest `isError`. If ever enabled: pull (leased batch) with explicit
  ack/retry, depth, DLQ — labelled "current messages (leased)", never "history" (HARD FACTS #1/#2).
  Bridge: `PS_RES_QUEUE_REQUEST/RESPONSE`.
- **Scheduled tasks (Cron Triggers) — Tab: BACKEND**: list the site's schedules
  (`site_functions_schedules`, since WfP has no native cron — cross-ref Phase 6's per-site schedule
  management), next-run/last-run, create/edit/delete. MCP: `backend_list_schedules` ·
  `backend_upsert_schedule` (write) · `backend_delete_schedule` (write). Bridge:
  `PS_RES_CRON_REQUEST/RESPONSE`.
- **Worker bindings (read) — Tab: BACKEND**: surface the site Worker's declared bindings — service
  bindings, Secrets Store, AI, Browser Rendering, Images, etc. — resolved from the registry + deploy
  manifest (NEVER a raw CF id from the client; INV per SECURITY-INVARIANTS). Read-only presence +
  metadata; NEVER return secret values. MCP: `backend_list_bindings` · `backend_get_binding`. Adapter
  `worker_binding.{list,get,head}` (read-only). Bridge: `PS_RES_BIND_REQUEST/RESPONSE`.
- **Observability (read, cross-cutting) — Tab: BACKEND**: reads Analytics Engine / CWV per subdomain,
  **reconciled against ground truth** (`verify-against-source-of-truth`: cross-check display vs D1
  `visitor_events`/`form_submissions` in the MASTER D1). It describes the running Worker (not one data
  store) → surfaced on the BACKEND tab. MCP: `data_read_observability`. Adapter
  `analytics_engine.{head,get}` (read-only). Tests: observability reconciles (lying-empty guard);
  foreign→404; prod-E2E.

---

## Cross-cutting per phase (the checklist every phase satisfies)

1. Feature module + 7-field manifest + flag (registry + manifest + docs).
2. Adapter methods Zod-validated in/out; executor single-resource + env-bound (INV-9).
3. Route order = the 5-step canonical order (INV-2); 404-never-403 on customer surface (INV-3).
4. Editor surface via `PS_RES_*` bridge (Angular makes the API call); Angular admin may call directly.
5. Parity MCP tool(s) on the platform MCP; same guards; `data:read`/`data:write` scope (INV-12).
6. Unit tests (foreign→404, flag-off→404, client-id-ignored, preview≠prod) + prod-E2E on a changed
   route (`verification-loop`) + `e2e/FEATURES.md` row.
7. Drift-clean: `npm run validate:features` + no CF id read from request + no credential in any
   serializer.

## Ordering rationale (tab split first, then by value)

**Primary sequence = the tab split (Brian 2026-09-27): all DATA-tab surfaces ship before all
BACKEND-tab surfaces.** Overview (Phase 1) is the shared map that makes every surface discoverable →
first, rendered per-tab. Then the DATA wave: D1 (Phase 2) is already live → formalise + add MCP parity
for immediate coverage; KV (3) + R2 (4) have ready backends → cheapest new surfaces; Vectorize (5) is
the remaining data store; the Connections half of Phase 8 (DB connections) closes the DATA tab. Then
the BACKEND wave (the final tab): Workflows (6) + DO (7) are platform-bound/honest-narrow; Queues +
scheduled-tasks + Worker-bindings + Observability (8) are the lowest-lift closers (mostly
read/not_supported), with Observability surfaced here because it's Worker-level, not per-store. Within
each tab, order remains by value/effort. This ships the data plane the customer touches first, defers
the compute plane to the final tab, and keeps every phase green.
