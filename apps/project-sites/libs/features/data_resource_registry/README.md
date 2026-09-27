# Data Resource Registry — Developer Guide

**The Data & Resource Platform** (`docs/data-resource-platform/`) — the authoritative, server-side
registry of every Cloudflare resource a customer's site touches, plus the typed per-kind adapter
layer that reads/writes those resources through the CF REST API without ever accepting a CF id from
the client.

This is the DEVELOPER doc (model + interface + how to extend). For the honest per-kind capability
status see `docs/data-resource-platform/CAPABILITY-STATUS.md`; for the UI↔MCP tool list see
`docs/data-resource-platform/MCP-TOOLS.md`; for the non-negotiable security rules see
`docs/data-resource-platform/SECURITY-INVARIANTS.md`.

## Contents

- [The registry model](#the-registry-model)
- [The `ResourceAdapter` interface](#the-resourceadapter-interface)
- [The 9 kinds + their implemented methods](#the-9-kinds--their-implemented-methods)
- [HTTP endpoints](#http-endpoints)
- [Flag gating](#flag-gating)
- [The security model](#the-security-model)
- [How to add a new kind](#how-to-add-a-new-kind)
- [Go-live gate](#go-live-gate)

## The registry model

Every CF resource a site uses is a **row the platform owns** in `site_resource_registry` (migration
`0643`). The browser (via the editor bridge) and the MCP caller supply only `{ site_id, environment }`
— both **authed** — plus per-kind non-identifier operands (a table name, a KV key, a vectorize
namespace). The trusted service maps that to the real CF account id / database id / namespace id /
bucket name and executes via the CF REST API. **No client ever names a CF resource id.** This is a
generalisation of the already-live per-site-D1 keystone (`site_data_db.ts` + `site_database_allocations`),
not a new subsystem.

`schemas.ts` is the single source of truth (Zod → `z.infer`, never hand-duplicated). The five
orthogonal **concepts** are kept distinct so the resolver/UI/MCP never conflate them:

- **`account_resource`** — a standalone CF object (D1 db, KV ns, R2 bucket, Vectorize index, Queue,
  AE dataset).
- **`wfp_namespace`** — the Workers-for-Platforms DISPATCH namespace (a container, not a store, not a
  quota pool).
- **`do_namespace`** — a Durable Object CLASS binding on a Worker (instances addressed at runtime;
  state NOT browsable).
- **`vectorize_namespace`** — a metadata partition inside ONE Vectorize index (a filter key, not a
  separate index).
- **`binding`** — the attachment of a resource to ONE User Worker at deploy (a relationship, not a CF
  object).

Every kind is split into `preview | production` environments — a preview ref resolves a DIFFERENT CF
id than production, so cross-env access is structurally impossible (INV-4).

Two tables back the model:

- **Table A — `site_database_allocations`** (extended by `0643` with sync/drift columns): the per-site
  "one dedicated allocation of each account_resource kind" (D1 live; KV/R2 columns ready). The live
  provisioning path.
- **Table B — `site_resource_registry`** (new in `0643`): the general registry — per-environment rows,
  bindings, DO/workflow/vectorize/queue associations, imported/external resources.
  `UNIQUE (site_id, environment, resource_kind, resource_concept, binding_name, vectorize_namespace)`.

### Service surface (`service.ts`)

- `recordResource(env, input)` — upsert a registry row; the service supplies `id` (UUIDv7),
  `cf_account_id` (= `env.CF_ACCOUNT_ID`, never the client), and timestamps.
- `listResources(env, siteId, environment)` — the site's rows for one environment (route runs the
  ownership gate first).
- `getResource(env, siteId, rowId)` — one row, scoped to the owning site (id AND site must match).
- `resolveResourceRef(env, siteId, ref, { orgId })` — **the keystone.** Resolves a CF id SERVER-SIDE
  from an owned registry row and rejects any id not owned by the authed `(org, site, env)`.
- `provisionResource(env, siteId, kind, opts)` — creates a per-site DEDICATED D1/KV/R2 (confirm-gated,
  idempotent, real account-quota-checked), records the allocation + registry row, returns a typed
  `record_failed` (with the created id) on a recoverable partial failure.

`reconciler.ts` (`reconcileResources`) does two directions in one pass: records what really exists
(from Table A allocations), then head-probes each existing registry row of an implemented kind and
sets `drift_code='resource_missing_on_cf'` when the row claims a resource CF says is gone.

## The `ResourceAdapter` interface

One adapter per kind (`adapters/*.ts`), each a narrow typed API (`tool-design-as-api` — no
`runAnything`). Defined in `adapter.ts`:

```ts
interface ResourceAdapter<TList, THead, TGet, TMutateInput, TMutateResult> {
  readonly kind: ResourceKind;
  readonly supports: {
    readonly environments: readonly ResourceEnvironment[];
    readonly verbs: readonly ('list' | 'head' | 'get' | 'mutate')[];
    readonly mutations: readonly string[]; // [] = read-only
  };
  list(scope: ResolvedScope, input?: unknown): Promise<AdapterResult<TList>>;
  head(scope: ResolvedScope): Promise<AdapterResult<THead>>;
  get(scope: ResolvedScope, input: unknown): Promise<AdapterResult<TGet>>;
  mutate(scope: ResolvedScope, input: TMutateInput): Promise<AdapterResult<TMutateResult>>;
}
```

The four verbs:

- **`list`** — enumerate children (D1 tables, KV keys, R2 objects, Vectorize namespaces, workflow runs).
- **`head`** — cheap existence/metadata probe of the resource itself (the sync/drift primitive; no body).
- **`get`** — read ONE child (a table page, one KV value, one R2 object, one workflow run).
- **`mutate`** — a NAMED, typed mutation (`provision | put | delete | exec | trigger | …`) — a
  discriminated union per kind, NEVER a generic `{ sql }` / `{ command }` field.

Every method returns a uniform `AdapterResult<T>` = `{ ok, data?, error? {code,message,retryable?},
correlationId }` — never raw stdout, never the auth used to fetch. A kind returns a `not_supported` /
`not_available` typed error (in the envelope) for a verb the CF API genuinely can't back.

`ResolvedScope` NEVER carries a caller CF id: `resourceId` is server-resolved from the registry,
`auth` comes from `resolveCfCredentials`, `accountId` is `env.CF_ACCOUNT_ID`. The executor minted for a
scope can address ONLY that one id, for that one environment (INV-9). `IMPLEMENTED_ADAPTERS`
(`reconciler.ts`) is the registry of wired adapters the routes + reconciler dispatch through.

## The 9 kinds + their implemented methods

`ResourceKind` = `d1 | kv | r2 | durable_object | workflow | queue | vectorize | analytics_engine |
connection`. What each adapter implements (mutations in the `mutate` union):

- **`d1`** — `list` (tables via `sqlite_master`), `head`, `get` (paginated rows). Mutations:
  `exec` (parameterized, single-statement; leading-keyword classifier read/mutating/destructive,
  confirm-gated destructive), `explain` (EXPLAIN QUERY PLAN; refuses mutating SQL), `migrations`
  (reads `d1_migrations`), `time_travel_info`, `restore` (confirm-gated, DESTRUCTIVE PITR),
  `provision`.
- **`kv`** — `list` (cursor+prefix), `head`, `get` (value+metadata+TTL). Mutations: `put`,
  `delete`, `bulk_get`, `bulk_delete` (≤10k CF cap, never truncate destructive), `provision`.
  Destructive/overwrite require `confirm:true`, fail-closed on indeterminate probe.
- **`r2`** — `list` (prefix+continuation), `head`, `get` (metadata). Mutations: `put`, `delete`,
  `bucket_config` (CORS/lifecycle readable; public-access = `requiresPlatformAdmin`), `preview_url`,
  the multipart trio (honest `not_available` on per-site REST buckets), `provision`.
- **`vectorize`** — `list` (namespace summary), `head`, `get` (by-ids). Mutations: `upsert`
  (namespace force-scoped), `delete` (confirms in-namespace ids first — cross-site delete
  impossible). Namespace `site-<id8>` inside the shared `projectsites-rag` index.
- **`connection`** — `list`, `head`, `get` reading `mcp_connections` (secret-free column allowlist,
  masked host). Read-only (no CF object; secrets never returned).
- **`workflow`** — `list` (instances), `head`, `get` (status+sanitized steps; actual CF status,
  never optimistic). Mutations: `start`, `pause`, `resume`, confirm-gated `restart`/`terminate`.
- **`durable_object`** — `list` (CLASS namespaces, `instancesEnumerable:false`), `head`, `get`
  (id metadata only, `stateBrowsable:false`). Mutation: `manage` (CLOSED enum `status_probe|reset`,
  no arbitrary-method passthrough; confirm-gated reset).
- **`queue`** — `list`, `head`, `get` (config+metrics+DLQ+backlog). Mutation: `send`
  (producer-only). Honest `not_available` — no `QUEUE` binding on this deployment; `queue` is in
  `UNSUPPORTED_KINDS` so `resolveResourceRef` returns `unsupported_kind` upstream.
- **`analytics_engine`** — `list` (datasets+dimensions), `head`, `get` (site-scoped AE SQL summary).
  Read-only. Honest `available:false` — AE ingest is disabled (`ANALYTICS_INGEST_ENABLED="false"`).

Backend inventory (`backend_inventory.ts`, `getBackendInventory`) is a flat READ-ONLY list of a
site's scheduled tasks (Cron Triggers from `site_functions_schedules`), Worker bindings
(with `managed`/`notAvailableReason` honesty + doc links, no fake CRUD), and secret NAMES + last-change
(NEVER values) — not a per-kind adapter.

## HTTP endpoints

All under `resourceRegistryApi` (`handlers.ts`), mounted in `src/index.ts`. Each runs the same
5-step gate: **AUTH** (401) → **FLAG** (404 dark) → **OWNERSHIP** (`ownsSiteData`, 404 IDOR) →
**OPERANDS** (Zod, 400) → **RESOLVE** (server-resolve the CF id, then dispatch).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sites/:siteId/resources?environment=…` | List the site's registry rows, grouped by kind (+ `countsByKind`). |
| GET | `/api/sites/:siteId/resources/:kind/detail?action=list\|get&…` | Dispatch a READ verb to the kind's adapter; returns the `AdapterResult` verbatim. |
| POST | `/api/sites/:siteId/resources/:kind/mutate` | Dispatch a NAMED write verb; body `{ action, input?, confirm? }` — never a CF id. |
| POST | `/api/sites/:siteId/resources/reconcile` | Reconcile registry ↔ CF; record + return drift. |

The detail/mutate routes address only `:kind` + `?action=` + bounded, non-identifier params
(`table`/`key`/`prefix`/`cursor`/`id`/`ids`/`limit`/`offset` for detail; `{action,input?,confirm?}`
for mutate). A kind with no owned row resolves `not_registered` → a 200
`{ result: { ok:false, error } }` (honest "nothing to show", never a 500). `provision` is the one
mutation that PRODUCES the id (resolve is skipped; the scope carries `env` + `tenantId`).

The already-live per-site **D1 Tables** surface (`GET /api/sites/:siteId/db/tables[/:table]`,
`site_data_api/site_db_handlers.ts`, flag `per_site_data`) is the seed of this platform; Phase 2 will
re-route it through the `d1` adapter.

## Flag gating

- **`data_resource_platform`** — the umbrella flag gating the overview/reconcile/detail/mutate routes.
  Default `enabled=0, rollout=0, stage=experimental` (DARK → server 404, UI null). Registered in the
  three required places: `src/modules/feature_flags/registry.ts`, `.../docs.ts`, and this module's
  `feature.manifest.ts`.
- **Per-kind flags** gate the MCP parity tools: `per_site_data` (D1, LIVE), `per_site_kv`,
  `per_site_r2`, `per_site_vectorize`, `per_site_connections`, `per_site_workflows`,
  `per_site_durable_objects`, `per_site_queues`, `per_site_observability`. All registered in
  FLAG_REGISTRY + FLAG_DOCS, default OFF/experimental, ready for a go-live flip.

Server guard returns **404 when off** (never 403 — never leak existence).

## The security model

Grounded in `SECURITY-INVARIANTS.md` (all BUILD-BREAKING):

- **INV-1 — no client CF ids, ever.** The caller supplies only `{ site_id, environment }` + safe
  operands. Every CF id is server-resolved. `ResourceRefSchema`/`ResourceMutateBodySchema` are
  `.strict()`, so a smuggled `resourceId`/`databaseId`/`accountId` is rejected at the boundary.
- **INV-2/3 — canonical route order + 404-never-403.** AUTH → FLAG → OWNERSHIP → OPERANDS → RESOLVE.
  Foreign/unknown site, flag-off, or missing resource → 404 on the customer surface (a prober can't
  tell "doesn't exist" from "not yours"). Super-admin platform surfaces use 403; customer resource
  routes never do.
- **INV-4 — preview ≠ production is STRUCTURAL.** `environment` resolves a different row → a different
  CF id; a preview op never resolves a production id.
- **INV-5 — shared-shim scope is a TRUSTED server prefix**, not a bypassable client key. A resolve
  landing on a shared-platform id (`FORBIDDEN_DB_IDS` for D1) fails closed (`forbidden_shared`, logged,
  never surfaced).
- **INV-6 — no CF creds to the browser/MCP.** `CfAuth`, `MCP_ENCRYPTION_KEY`, stored provider secrets
  live ONLY in the Worker. Adapter results carry data + typed errors + `correlationId` only.
- **INV-9 — executors are single-resource, env-bound at mint.** `mutate` is a discriminated union of
  named mutations; destructive ones (`delete`/`terminate`/`restore`/`destroy`) require `confirm:true`
  and respect `deletion_protected`.
- **INV-11 — deletion protection + destructive gating.** `deletion_protected=1` by default;
  whole-resource destruction is approval-required + super-admin-gated.
- **INV-12 — MCP parity is no weaker path.** The parity tools live in the platform MCP, re-run the
  owned-site check on `token.org_id`, gate on the same flag, resolve ids via the same resolver, and
  carry `data:read`/`data:write` scopes — they cannot reach anything the Data tab couldn't.

## How to add a new kind

1. **Schema** — add the kind to `ResourceKindSchema` (+ concept mapping notes) in `schemas.ts`. Keep
   any new operand fields on `ResourceDetailParamsSchema` bounded + `.strict()`.
2. **Adapter** — create `adapters/<kind>.ts` implementing `ResourceAdapter`. Declare `supports`
   (environments/verbs/mutations) HONESTLY — a verb the CF API can't back returns a `not_supported` /
   `not_available` typed error, never a fabricated success. Take auth from `scope.auth`; never read a
   client id. Zod-validate `list`/`get`/`mutate` inputs; make `mutate` a discriminated union.
3. **Register** — add the adapter to `IMPLEMENTED_ADAPTERS` in `reconciler.ts` (this wires it into the
   detail/mutate routes AND the drift sweep). Only add it if its `head` is real — a `head` that would
   throw `not_implemented` must NOT be registered.
4. **Provisioner (if `account_resource`)** — if the kind is per-site provisionable, add it to
   `ProvisionableKind` + `ACCOUNT_RESOURCE_CAPS` + `KIND_LIST_SPEC` in `quota.ts`, `PROVISION_META` +
   `runProvisioner` in `service.ts`, and a `readAllocationSources` branch in `reconciler.ts`.
5. **Flag** — add a `per_site_<kind>` flag in the three required places (registry + docs + manifest).
6. **MCP parity** — add the `data_<kind>_*` tool(s) to the platform MCP with the matching
   `data:read`/`data:write` scope, the owned-site re-scope, and the same resolver. Reads = `data:read`;
   mutations = `data:write` + confirm gates.
7. **Tests** — colocate `__tests__/`: assert foreign-org → not-owned, flag-off → 404, client-id →
   ignored, preview → never resolves production id, and every mutation's confirm/fail-closed path.
8. **Docs** — add the kind's row to `CAPABILITY-STATUS.md` (honest LIVE vs not_available) and its
   tools to `MCP-TOOLS.md`.

## Go-live gate

The platform ships code-complete but **DARK**. Go-live requires: (1) apply migrations **`0643`**
(`site_resource_registry` + `site_database_allocations` sync columns) **and `0644`**
(`data_query_history`) to prod D1 — additive, run once; (2) flip `data_resource_platform` (+ the
relevant `per_site_*` flags) in `/admin/feature-flags`; (3) prod-verify the changed routes per the
global `verification-loop`. Nothing here is complete until UI + MCP + adapter + tests are green and
the changed surface is prod-verified.

## Tests

`__tests__/` — schema (enum + shape + strict-mode CF-id rejection), service (`resolveResourceRef`
site-isolation + shared-id fail-closed), and per-adapter suites (defense-filters, confirm gates,
no-credential-leak). Run from `apps/project-sites`:

```bash
npm test -- data_resource_registry
```
