# Data & Resource Platform — Authoritative Design (Resource Registry)

> Section 1 of the site-scoped Cloudflare resource-management directive. This is the SSOT for the
> **resource registry** model, the distinct resource-concept types, the CF adapter interface, and the
> server-side identifier-resolution model. The Data tab (editor + admin) and the parity MCP tools
> BOTH read/write through this one shared server model — never a second, parallel system.
>
> Cross-refs: `docs/data-platform-scope.md` (per-site D1 keystone) · `docs/FUNCTIONS-CONVERGENCE.md`
> (WfP Functions) · `SECURITY-INVARIANTS.md` · `CAPABILITY-MATRIX.md` · `PHASED-PLAN.md` (siblings).

---

## 0. The one-sentence thesis

Every Cloudflare resource a customer's site touches is a **row the platform owns and resolves
server-side** — the browser and MCP caller supply only `{ site_id, environment }` (both authed), and
the trusted service maps that to the real CF account id / namespace / database id / bucket name /
binding, executes via the CF REST API, and records drift + usage back to the row. No client ever
names a CF resource id; the registry is the only place ids live.

This is a **generalisation of the already-live per-site-D1 keystone** (`site_data_db.ts` +
`site_database_allocations`), NOT a new subsystem. We EXTEND `site_database_allocations` and add one
sibling registry table for the resource kinds that aren't a per-site-one-of allocation.

---

## 1. Reuse-first: what already exists (do NOT rebuild)

Recon confirmed the following are LIVE and are the foundation this design extends. Building a
parallel table/resolver/adapter would be drift (`drift-detection`).

| Existing artifact | What it already does | This design's stance |
|---|---|---|
| `site_database_allocations` (migrations `0573` + `0633` + `0634`) | One row per site (PK `site_id`) recording the site's **dedicated** D1 (`d1_database_id`/`_name`), KV (`kv_namespace_id`/`_name`), R2 (`r2_bucket_name`), plus the Neon/Hyperdrive escape-hatch columns | **KEEP as the per-site "one dedicated allocation of each kind" table.** Add columns (below) rather than a new table. |
| `src/services/site_data_db.ts` → `resolveSiteDataDb(env, siteId, {orgId})` | Server-resolves the D1 id from the allocation, lazy-provisions, denylists shared platform ids (`FORBIDDEN_DB_IDS`), executes via CF REST `/query` bound to ONE id | **This IS the resolver contract.** Generalise its shape into the adapter interface (§5) — one resolver per resource kind, same guarantees. |
| `src/services/d1_provisioner.ts` / `kv_provisioner.ts` / `r2_provisioner.ts` | `POST` CF REST → `INSERT … ON CONFLICT(site_id) DO UPDATE`; idempotent; honest-fail | **These ARE the `mutate:provision` methods** for D1 (live), KV + R2 (inert, wire them per `PHASED-PLAN`). |
| `src/services/cf_credentials.ts` → `resolveCfCredentials` + `cfAuthHeaders` + `CfAuth` | SSOT for CF auth: per-org encrypted global key → bundled global key → `CF_API_TOKEN` Bearer; account is ALWAYS `env.CF_ACCOUNT_ID` | **Every adapter method takes its auth from here.** Never a second credential path (WfP's direct `CF_API_TOKEN` use is the one legacy exception — unify it). |
| `src/services/wfp_dispatch.ts` | Uploads the per-site Functions worker `site-<id>` / `site-<id>-preview`; **bindings attached to the ONE user script at deploy** via `metadata.bindings[]` | **This IS the "binding attaches to a specific User Worker at deploy" fact.** The registry RECORDS those bindings; it does not re-implement upload. |
| `libs/features/platform_mcp/{service,schemas,handlers}.ts` | JSON-RPC platform MCP; tools are a `const` array; dispatch re-scopes `WHERE id=? AND org_id=?` | **Parity MCP tools live HERE** (only wired JSON-RPC transport). One tool per registry read/mutate. |
| `libs/features/site_data_api/site_db_handlers.ts` + `handlers.ts` (`ownsSiteData`) | The canonical site-scoped route order + IDOR guard for the D1 Tables surface | **Every new resource route copies this order** (see `SECURITY-INVARIANTS.md`). |
| `src/middleware/auth.ts` + `src/services/site_ownership.ts` (`assertSiteOwned`) | Bearer → `c.get('orgId')`/`c.get('userId')`; ownership = `sites.org_id === orgId`, 404-on-foreign | **The authed context** every resolution starts from. |

Master D1 (`ea3e839a…`) and the non-prod default (`f5b59818…`) are on `FORBIDDEN_DB_IDS` and are
NEVER a registry row for a customer surface — the shared platform DB is fenced off structurally
(it isn't in `site_database_allocations`) and by denylist.

---

## 2. The distinct resource concepts (explicit types)

The directive's key insight: "a Cloudflare resource" is NOT one thing. The registry models these as
**explicit, non-interchangeable types** so the resolver, the UI, and the MCP never conflate them.

```ts
// libs/features/site_resources/types.ts  (new feature module)

/**
 * The FIVE orthogonal concepts. A registry row is (siteId, environment, resourceKind, concept-shape).
 * These are deliberately distinct: an account-resource is a global CF object; a wfp-namespace is a
 * dispatch container; a DO-namespace is a class binding on a script; a vectorize-namespace is a
 * metadata partition INSIDE one index; an environment splits every kind into preview|production.
 */
export type ResourceConcept =
  | 'account_resource'      // a standalone CF object owned by the account: a D1 db, a KV namespace,
                            //   an R2 bucket, a Vectorize index, a Queue, an Analytics dataset.
                            //   Has its own CF id/name. This is the ONLY kind the provisioners create.
  | 'wfp_namespace'         // the Workers-for-Platforms DISPATCH namespace (project-sites-endpoints,
                            //   6ea19ae4…). Holds user scripts; is NOT a data store and NOT a quota
                            //   pool. One per platform, not per site. A site "lives in" it via its
                            //   script name, never owns it.
  | 'do_namespace'          // a Durable Object CLASS binding declared on a specific Worker script
                            //   (e.g. SITE_BUILDER → SiteBuilderContainer). Instances are addressed
                            //   by name/id AT RUNTIME; there is NO generic "browse all DO state" API.
  | 'vectorize_namespace'   // a metadata NAMESPACE (partition) inside ONE Vectorize index
                            //   (RAG_INDEX = projectsites-rag). NOT a separate index; a filter key.
  | 'binding';              // the ATTACHMENT of an account_resource (or service/DO/AI) to ONE User
                            //   Worker at deploy (metadata.bindings[] in wfp_dispatch). A binding is
                            //   a relationship row, not a CF object; it is created at upload, not
                            //   provisioned, and it is scoped to a single script + environment.

/** The concrete resource KINDS the platform surfaces (what a UI section / MCP tool targets). */
export type ResourceKind =
  | 'd1'                    // account_resource — per-site dedicated (site_database_allocations)
  | 'kv'                    // account_resource — per-site dedicated (allocation) OR shared shim
  | 'r2'                    // account_resource — per-site dedicated (allocation) OR shared shim
  | 'durable_object'        // do_namespace — SITE_BUILDER only; instance ops opt-in, state NOT browsable
  | 'workflow'              // account_resource (Workflow binding) — platform-level, run instances
  | 'queue'                 // account_resource — UNSUPPORTED on this deployment (no QUEUE binding)
  | 'vectorize'             // account_resource (index) + vectorize_namespace (partition)
  | 'analytics_engine'      // account_resource (dataset) — read-only observability
  | 'connection';           // an MCP/OAuth connection to an EXTERNAL provider (mcp_connections) —
                            //   registry surfaces it as observability, not a CF resource.

/** Every kind is split into two isolated environments. preview MUST NEVER read/write production. */
export type ResourceEnvironment = 'preview' | 'production';

/** Whether the site OWNS a dedicated CF object, or SHARES a platform object via a key/prefix shim. */
export type ResourceTenancy =
  | 'dedicated'             // a genuinely per-site CF object (its own id) — e.g. provisioned per-site D1
  | 'shared_shim'           // a shared platform object reached with a site-scoped prefix
                            //   (Functions __PS_KV `site:<id>:`, __PS_R2 `sites-data/<id>/`)
  | 'shared_platform';      // a platform-only object never customer-facing (master D1) — registry
                            //   records it ONLY to denylist it, never to surface it.
```

Why each is its own type (the HARD facts these encode, per `CAPABILITY-MATRIX.md`):

- **account_resource ≠ wfp_namespace** — the dispatch namespace does not raise D1/KV/R2 account
  quotas; putting a script in it grants no storage. Modelling them as the same "resource" would
  imply a namespace has a quota. It does not.
- **do_namespace** is a class binding, not a data store — there is **no CF API to enumerate or read
  arbitrary DO instance state**. The type exists so the UI/MCP can offer the *possible* instance ops
  (per-DO addressed calls, alarms) and honestly refuse "browse all state".
- **vectorize_namespace ≠ a Vectorize index** — a namespace is a metadata partition inside one
  index; you cannot `create index` per site cheaply, but you CAN partition by namespace. The type
  keeps "index" (account_resource) and "namespace" (partition) separate.
- **environment** is orthogonal to every kind — the WfP worker splits into `site-<id>` vs
  `site-<id>-preview` (real, live in `wfp_dispatch.ts`); a preview D1/KV/R2 is a *different
  allocation row* keyed on environment. Preview isolation is structural, not a flag.
- **binding** is a relationship, created at deploy, scoped to one script — recording it lets the UI
  show "what this User Worker can reach" and lets us detect drift ("binding row says `__PS_KV` →
  namespace X, but the last upload attached Y").

---

## 3. The registry schema (EXACT columns)

Two tables. **Table A extends the existing `site_database_allocations`** for the per-site
"one dedicated of-each-kind" allocations (D1/KV/R2 already there). **Table B is a new
`site_resource_registry`** for the general case: bindings, DO/workflow/vectorize/queue associations,
per-environment rows, and any resource that is not a single per-site allocation. Table B references
Table A by `site_id` — it does not duplicate the allocation columns.

### 3.1 Table A — `site_database_allocations` (EXTEND, migration `0635`)

Existing columns (KEEP, from `0573`/`0633`/`0634`): `tenant_id`, `site_id` (PK), `db_plan`,
`region`, `shard_id`, `hyperdrive_binding_name`, `neon_project_id`, `neon_database`, `neon_schema`,
`status`, `created_at`, `updated_at`, `d1_database_id`, `d1_database_name`, `kv_namespace_id`,
`kv_namespace_name`, `r2_bucket_name`.

The PK is `site_id`, so this table holds the **production** dedicated allocation per site (the live
path today). Preview dedicated allocations + all other resource kinds go in Table B (which is keyed
on `(site_id, environment, resource_kind, resource_concept, binding_name)`), keeping A backward
compatible and race-safe (its upserts already key on `site_id`).

Additive columns for drift/sync/usage on the per-site allocation (all NULLABLE, additive):

```sql
-- migrations/0635_site_allocation_registry_columns.sql
ALTER TABLE site_database_allocations ADD COLUMN d1_last_sync_at   TEXT;   -- ISO; last CF head/list reconcile
ALTER TABLE site_database_allocations ADD COLUMN kv_last_sync_at   TEXT;
ALTER TABLE site_database_allocations ADD COLUMN r2_last_sync_at   TEXT;
ALTER TABLE site_database_allocations ADD COLUMN drift_json        TEXT;   -- JSON: per-kind {code,detail,detected_at}[]
ALTER TABLE site_database_allocations ADD COLUMN deletion_protected INTEGER NOT NULL DEFAULT 1; -- 1=block destroy
-- usage snapshots are cached in Table B rows (usage_json) to avoid widening A per-kind.
```

### 3.2 Table B — `site_resource_registry` (NEW, migration `0636`)

The general registry row. One row per (site, environment, kind, concept, binding-name). This is what
the discovery/overview surface enumerates and what non-allocation kinds live in.

```sql
-- migrations/0636_site_resource_registry.sql
CREATE TABLE IF NOT EXISTS site_resource_registry (
  id                    TEXT PRIMARY KEY NOT NULL,            -- UUIDv7 (time-ordered; uuid-version-discipline)
  org_id                TEXT NOT NULL,                        -- owner org — the authz key (redundant w/ site for fast scoping)
  site_id               TEXT NOT NULL,                        -- owner site (FK → sites.id); resolution key
  owner_user_id         TEXT,                                 -- user who first provisioned (audit only; authz is org_id)

  environment           TEXT NOT NULL DEFAULT 'production',   -- 'preview' | 'production'  (isolation axis)
  resource_concept      TEXT NOT NULL,                        -- ResourceConcept enum (§2)
  resource_kind         TEXT NOT NULL,                        -- ResourceKind enum (§2)
  tenancy               TEXT NOT NULL DEFAULT 'dedicated',    -- ResourceTenancy enum (§2)

  cf_account_id         TEXT NOT NULL,                        -- always env.CF_ACCOUNT_ID at record time (never client)
  wfp_dispatch_namespace TEXT,                                -- WFP_NAMESPACE_NAME for wfp/binding rows; else NULL
  user_worker_script    TEXT,                                 -- site-<id>[-preview] the binding attaches to; else NULL

  resource_id_or_name   TEXT,                                 -- the CF id (d1 uuid, kv id, vectorize index) OR name
                                                              --   (r2 bucket, dataset, queue) — R2/queue identity IS the name
  resource_display_name TEXT,                                 -- human label (ps-site-<id>, projectsites-rag, …)
  binding_name          TEXT,                                 -- the in-worker binding symbol (__PS_KV, DATA, RAG_INDEX)
                                                              --   for concept='binding'; NULL for standalone resources
  vectorize_namespace   TEXT,                                 -- the metadata partition for concept='vectorize_namespace'

  lifecycle_state       TEXT NOT NULL DEFAULT 'requested',    -- requested|provisioning|active|degraded|retiring|retired|error
  provisioning_method   TEXT NOT NULL DEFAULT 'lazy',         -- 'lazy'|'eager'|'imported'|'binding_only'|'external'
                                                              --   binding_only = attached at deploy, no standalone object
                                                              --   external = an mcp_connections/OAuth link (kind='connection')
  access_policy         TEXT NOT NULL DEFAULT 'site_scoped',  -- 'site_scoped'|'read_only'|'superadmin_only'|'no_direct'
                                                              --   no_direct = reachable only via service binding (per-site D1)

  deletion_protected    INTEGER NOT NULL DEFAULT 1,           -- 1=block destroy without explicit confirm+superadmin

  deploy_id             TEXT,                                 -- site_snapshots.id / build version this binding shipped with
  deployed_version      TEXT,                                 -- sites.current_build_version | functions_deployed_at marker

  last_sync_at          TEXT,                                 -- ISO; last successful CF head/list reconcile of THIS row
  drift_code            TEXT,                                 -- NULL when clean; else a typed drift code (§6)
  drift_detail          TEXT,                                 -- JSON detail for the drift
  last_error_code       TEXT,                                 -- last provisioning/mutate failure (typed)
  last_error_detail     TEXT,
  usage_json            TEXT,                                 -- JSON cache of last usage snapshot {metric,value,as_of}[]

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT,                                 -- soft delete

  UNIQUE (site_id, environment, resource_kind, resource_concept, binding_name, vectorize_namespace)
);
CREATE INDEX IF NOT EXISTS idx_srr_site ON site_resource_registry (site_id, environment);
CREATE INDEX IF NOT EXISTS idx_srr_org  ON site_resource_registry (org_id);
CREATE INDEX IF NOT EXISTS idx_srr_kind ON site_resource_registry (resource_kind, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_srr_cfid ON site_resource_registry (resource_id_or_name);
```

Column-to-directive mapping (every field the directive named is present):

| Directive field | Column(s) |
|---|---|
| site_id | `site_id` |
| owner | `org_id` (authz) + `owner_user_id` (audit) |
| environment preview\|production | `environment` |
| cf_account_id | `cf_account_id` |
| wfp_dispatch_namespace | `wfp_dispatch_namespace` |
| user_worker_script | `user_worker_script` |
| resource_kind | `resource_kind` (+ `resource_concept`, `tenancy`) |
| resource_id_or_name | `resource_id_or_name` (+ `resource_display_name`) |
| binding_name | `binding_name` |
| lifecycle_state | `lifecycle_state` |
| provisioning_method | `provisioning_method` |
| dedicated_vs_shared | `tenancy` |
| access_policy | `access_policy` |
| deletion_protection | `deletion_protected` |
| deploy/version assoc | `deploy_id` + `deployed_version` |
| last_sync | `last_sync_at` |
| drift/errors | `drift_code` + `drift_detail` + `last_error_code` + `last_error_detail` |
| usage | `usage_json` |

Enum discipline (`zod-everywhere`): every enum column is validated by a Zod schema in
`libs/features/site_resources/schemas.ts`; TS types are `z.infer`, never hand-duplicated.

### 3.3 Why two tables, not one

- Table A is a proven, race-safe **allocation ledger** (PK `site_id`, idempotent upserts) that the
  live D1 path already depends on — widening its PK or duplicating its rows per environment would
  break `resolveSiteDataDb`. Keep it as "the production dedicated allocation of each account_resource
  kind per site".
- Table B carries everything A structurally can't: **per-environment** rows, **bindings**
  (relationships), **DO/workflow/vectorize/queue** associations, and imported/external resources.
  It is additive and never on the hot path (D1 Tables still resolves through A).
- The registry READ (overview) is `LEFT JOIN`-style: enumerate A's dedicated allocations for the
  site AND B's rows, present as one list. Provisioners write A (the allocation) and MAY mirror a
  Table-B row for cross-kind uniformity; the resolver reads A first (fast path) then B.

---

## 4. Server-side identifier-resolution model

**The single most important invariant: no CF identifier is ever accepted from the client.** The
caller (browser via editor bridge, or MCP) supplies only `{ site_id, environment, resource_kind }`
plus per-kind operands (a table name, a KV key, an R2 object key, a vectorize query) — all
non-identifier. The trusted service resolves the CF id.

Resolution algorithm (generalises `resolveSiteDataDb`, enforced in `site_resources/resolver.ts`):

```
resolveResource(env, { siteId, environment, kind, concept }, { orgId /* from c.get, never body */ }):
  1. AUTH        orgId = authed context (401 if absent). NEVER from body/header/query.
  2. FLAG        isFlagOn(env, flagFor(kind), {orgId, siteId}) else → caller-appropriate 404/isError.
  3. OWNERSHIP   assertSiteOwned/ownsSiteData(env, orgId, siteId) else → 404 (never 403).
  4. VALIDATE    operands (table/key/namespace) via isSafeIdent / per-kind Zod; else 400.
  5. LOOKUP      read the CF id from the REGISTRY for (siteId, environment, kind[, concept]):
                   - d1/kv/r2 production → site_database_allocations (Table A)
                   - everything else / preview → site_resource_registry (Table B)
                 (lazy-provision here if provisioning_method='lazy' and no row — via the kind's
                  mutate:provision adapter method; idempotent.)
  6. DENYLIST    if the resolved id ∈ FORBIDDEN_DB_IDS (or the analogous shared-platform set for the
                 kind) → fail closed ('forbidden_shared_*'); log + 500, never confirm.
  7. CREDS       auth = resolveCfCredentials(env, orgId); account = env.CF_ACCOUNT_ID (never client).
  8. BIND        mint the kind's adapter executor bound to EXACTLY that one id/name (like makeExecutor).
  9. EXECUTE     run the requested op through the adapter; retry 5xx (3×) as makeExecutor does.
```

The executor returned by step 8 can only address the id it was minted with (the `site_data_db.ts`
`SiteDataD1` pattern) — there is no method to redirect it at another resource. This is the structural
guarantee, not just a check.

`environment` selects the row: a `preview` request resolves the `-preview` allocation (Table B row
with `environment='preview'`), which points at a DIFFERENT CF id than production. A preview op can
never touch a production id because it never resolves one.

---

## 5. The CF adapter interface (typed contract per resource kind)

One adapter per `ResourceKind`, each a narrow typed API (`tool-design-as-api` — no `runAnything`).
Every method is Zod-validated in and out, takes auth from `cf_credentials`, and returns a typed
envelope. The interface is uniform so the UI + MCP + resolver treat all kinds the same, while each
implementation honestly reflects what the CF API supports (`CAPABILITY-MATRIX.md`).

```ts
// libs/features/site_resources/adapter.ts

/** Uniform result envelope for every adapter method (tool-design-as-api). */
export interface AdapterResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable?: boolean };
  readonly correlationId: string;
}

/** The scope every method resolves against — NEVER carries a CF id from the caller. */
export interface ResolvedScope {
  readonly siteId: string;
  readonly orgId: string;                 // authed
  readonly environment: ResourceEnvironment;
  readonly auth: CfAuth;                   // from resolveCfCredentials
  readonly accountId: string;             // env.CF_ACCOUNT_ID
  readonly resourceId: string;            // resolved from the registry (the ONLY id, server-side)
}

/**
 * Typed contract per resource kind. Not all kinds implement all verbs — a kind returns a
 * `not_supported` typed error for a verb the CF API genuinely can't back (honest "not available").
 * Verbs:
 *  - list   → enumerate children (D1 tables, KV keys, R2 objects, Vectorize namespaces, workflow runs)
 *  - head   → cheap existence/metadata probe of the resource itself (for sync/drift, no body)
 *  - get    → read one child (a table page, one KV value, one R2 object, one workflow run)
 *  - mutate → a NAMED, typed mutation (provision | destroy | put | delete | seed | trigger …);
 *             free-form writes are forbidden — each mutation is its own discriminated variant.
 */
export interface ResourceAdapter<TList, THead, TGet, TMutateInput, TMutateResult> {
  readonly kind: ResourceKind;
  /** Which environments + concepts this adapter serves (drives the UI). */
  readonly supports: {
    readonly environments: readonly ResourceEnvironment[];
    readonly verbs: readonly ('list' | 'head' | 'get' | 'mutate')[];
    readonly mutations: readonly string[];   // named mutations this kind allows ([] = read-only)
  };
  list(scope: ResolvedScope, input?: unknown): Promise<AdapterResult<TList>>;
  head(scope: ResolvedScope): Promise<AdapterResult<THead>>;
  get(scope: ResolvedScope, input: unknown): Promise<AdapterResult<TGet>>;
  mutate(scope: ResolvedScope, input: TMutateInput): Promise<AdapterResult<TMutateResult>>;
}
```

Per-kind method names + what each maps to on the CF REST API (verified surface in
`CAPABILITY-MATRIX.md`):

| Kind | `list` | `head` | `get` | `mutate` (named) |
|---|---|---|---|---|
| **d1** | list tables (`sqlite_master`) — reuse `listSiteTables` | `HEAD` db meta (`/d1/database/{id}`) | table page (`/query` SELECT) | `provision` \| `destroy` \| `query_write` (parameterized, gated) \| `seed` |
| **kv** | list keys (`/storage/kv/namespaces/{id}/keys`) | namespace meta | one value (`/values/{key}`) | `provision` \| `destroy` \| `put` \| `delete` \| `bulk_delete` |
| **r2** | list objects (S3 `ListObjectsV2`) | bucket head | one object (GET) | `provision` \| `destroy` \| `put` \| `delete` |
| **durable_object** | list instances **from our own index** (no CF list API) | DO class binding presence | one instance's exposed state via addressed fetch | `reset_instance` (addressed) \| `send` (addressed) — **no browse-all** |
| **workflow** | list runs (`/workflows/{name}/instances`) | workflow binding presence | one run status/steps | `trigger` \| `terminate` \| `resume` |
| **queue** | — (**not_supported**: no QUEUE binding on this deployment) | not_supported | not_supported | not_supported |
| **vectorize** | list namespaces (from our index metadata) | index meta (`/vectorize/v2/indexes/{name}`) | query by namespace (`/query`) | `upsert` \| `delete_by_ids` (scoped to site namespace) |
| **analytics_engine** | — | dataset presence | query (SQL API, read-only) | none (read-only) |
| **connection** | list `mcp_connections` for site | connection health probe | one connection status | `revoke` (external OAuth) — **no CF object** |

`mutate` is a discriminated union per kind (`{ action: 'provision' } | { action: 'put', key, value } | …`),
each variant with its own Zod schema — never a generic `{ sql }`/`{ command }` field.

The D1 adapter's `list`/`get`/`mutate:query_write` are thin wrappers over the ALREADY-LIVE
`resolveSiteDataDb` + `listSiteTables` + the `site_data_api` handlers — the adapter formalises the
existing surface, it does not replace it.

---

## 6. Drift + sync model

- **`head` is the sync primitive.** A periodic (or on-open) reconcile calls each row's adapter
  `head`; on success updates `last_sync_at`, clears `drift_code`. On mismatch (row says the resource
  exists but CF `head` 404s, or the id/name differs) sets a typed `drift_code`.
- **Drift codes** (typed, `zod-everywhere`): `resource_missing_on_cf` (row exists, CF doesn't) ·
  `id_mismatch` (registry id ≠ what a fresh list returns) · `binding_mismatch` (recorded binding ≠
  last upload's `metadata.bindings[]`) · `orphan_on_cf` (CF object exists with our naming, no row) ·
  `forbidden_shared` (resolved a denylisted id — always logged, never surfaced to the customer).
- Drift is a merge-/ops-blocker surfaced in the overview, per `drift-detection`. The reconciler is a
  reusable tool (`site_resources/reconcile.ts`), mirrored as an MCP tool (`data_reconcile_resources`)
  and re-run every verification pass — the same discipline as
  `verify-against-source-of-truth` for data surfaces.

---

## 7. Feature-flag + module placement

- New feature module: `libs/features/site_resources/` with the full 7-field `manifest.ts`
  (`feature-module-architecture`). Flag key **`site_resource_platform`**
  (`enabled=0, rollout=0, stage='experimental'`), registered in the flag registry + manifest + docs
  (the "new flag = 3 places" rule).
- Per-kind sub-behaviour rides existing/added flags where they exist: `per_site_data` (D1, live),
  `per_site_kv`, `per_site_r2` (reserved), and the umbrella `site_resource_platform` gates the
  overview + registry surface. Server guard returns **404 when off** (never 403); UI returns null.
- Files stay within `inverted-abstraction-pyramid` sizes: `resolver.ts` + each `adapters/<kind>.ts`
  thin; `service.ts` holds the reconcile/registry logic.

---

## 8. What this design explicitly does NOT do (honest scope)

- Does not create a per-site Vectorize INDEX (CF has no cheap per-tenant index; we partition one
  index by namespace) — `vectorize_namespace` type.
- Does not expose a "browse all Durable Object state" surface (no CF API exists) — DO ops are
  opt-in, addressed, instance-scoped.
- Does not surface Queues on this deployment (no `QUEUE` binding) — the kind renders `not_supported`.
- Does not bind a site's per-site D1 as a WfP `d1` binding (a Worker can't statically bind thousands)
  — per-site D1 stays REST-resolved; Functions reach it (future) via the `__PS_SVC` service binding →
  platform worker → REST (`access_policy='no_direct'`).
- Does not send any account token to the browser or MCP (`SECURITY-INVARIANTS.md`).
