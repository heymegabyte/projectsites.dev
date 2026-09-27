# Data Resource Registry

**Section 1 of the Data & Resource Platform** (`docs/data-resource-platform/DESIGN.md`) — the
authoritative, server-side registry of every Cloudflare resource a customer's site touches.

## What it is

Every Cloudflare resource a site uses is a **row the platform owns and resolves server-side**. The
browser (via the editor bridge) and the MCP caller supply only `{ site_id, environment }` — both
**authed** — plus per-kind non-identifier operands (a table name, a KV key, a vectorize namespace).
The trusted service maps that to the real CF account id / namespace / database id / bucket name /
binding and executes via the CF REST API. **No client ever names a CF resource id.** This is a
generalisation of the already-live per-site-D1 keystone (`site_data_db.ts` +
`site_database_allocations`), not a new subsystem.

This fire ships the **contract + service foundation only** — no routes are wired yet:

- **`schemas.ts`** — Zod schemas + `z.infer` types for the registry model and the distinct
  resource concepts (`ResourceConcept`, `ResourceKind`, `ResourceEnvironment` = `preview|production`,
  `ResourceTenancy`, `ResourceRecord`, `BindingRecord`, `ResourceRef`, `ResolvedResourceRef`).
- **`service.ts`** — `recordResource` / `listResources` / `getResource`, and the keystone
  **`resolveResourceRef(env, siteId, ref, { orgId })`** — resolves a CF id SERVER-SIDE from the
  registry + the authed `site+env`, and **rejects any id not owned by that site+env**.
- **`adapter.ts`** — the typed CF resource **adapter interface** (`ResourceAdapter`,
  `ResolvedScope`, `AdapterResult`) each per-kind adapter (d1/kv/r2/…) implements. Interface only.
- **`migrations/0643_data_resource_registry.sql`** — the `site_resource_registry` table (Table B) +
  additive drift/sync columns on `site_database_allocations` (Table A).

## The isolation guarantee (why `resolveResourceRef` is the keystone)

`resolveResourceRef` mirrors the canonical site-scoped route order and reuses the canonical guards:

1. **AUTH** — `orgId` from the authed context (`c.get('orgId')`); `undefined` → `unauthorized`.
   Never from the ref/body/header.
2. **SUPPORT** — a `not_supported` kind (e.g. `queue` on this deployment) → `unsupported_kind`.
3. **OWNERSHIP** — `assertSiteOwned(env, orgId, siteId)` (injectable; `ownsSiteData` is the
   equivalent colocated guard) — a foreign site → `not_owned` (the route renders **404, never 403**
   — never leak existence).
4. **LOOKUP** — the CF id lives ONLY in a registry row for the OWNED `site_id` + authed `org_id` +
   requested `environment` + `kind`. No owned row → `not_registered`.
5. **DENYLIST** — a resolved id on the shared-platform denylist (`FORBIDDEN_DB_IDS` for D1) →
   `forbidden_shared`, **fail closed** (logged, never surfaced).
6. **ACCOUNT** — always `env.CF_ACCOUNT_ID`, never the client.

A `preview` ref resolves the preview row (a **different** CF id than production), so a preview op can
never touch a production id — it never resolves one. A ref for another site/env has no matching owned
row and is rejected at step 3 or 4. The `ResourceRef` schema is `.strict()`, so a client cannot even
*submit* a `resourceId`/`databaseId`/`accountId` — the parse rejects it.

## Feature flag — `data_resource_platform`

Registered in the **3 required places**: `src/modules/feature_flags/registry.ts` (FLAG_REGISTRY),
`src/modules/feature_flags/docs.ts` (FLAG_DOCS), and this module's `feature.manifest.ts` (`flagKey`).

Default: `enabled=0, rollout_percent=0, stage='experimental'` (dark).

### Safe-disabled behavior

- **This fire wires no routes**, so there is nothing that 404s yet — the flag exists to gate the
  future overview/registry surface + the parity MCP tools. When those land, their server guard MUST
  return **404 when the flag is off** (never 403), and any UI returns `null`.
- The service functions are pure library code with **zero side effects at import** — importing this
  module changes nothing at runtime until a caller invokes it behind the flag gate.
- Migration `0643` is **additive** (a new table + nullable columns), so applying it is inert until
  the feature is enabled and rows are written.

## Data model (two tables)

- **Table A — `site_database_allocations`** (extended): the per-site "one dedicated allocation of
  each account_resource kind" (D1/KV/R2), the live path today. Migration `0643` adds
  `d1_last_sync_at` / `kv_last_sync_at` / `r2_last_sync_at` / `drift_json` / `deletion_protected`.
- **Table B — `site_resource_registry`** (new): the general registry — per-environment rows,
  bindings (relationships), DO/workflow/vectorize/queue associations, and imported/external
  resources. `UNIQUE (site_id, environment, resource_kind, resource_concept, binding_name,
  vectorize_namespace)`.

## Tests

`__tests__/schemas.test.ts` (enum + shape + strict-mode CF-id rejection) and
`__tests__/service.test.ts` (the `resolveResourceRef` site-isolation guard — a ref from another
site/env is rejected; a resolved shared-platform id fails closed). Run from `apps/project-sites`:

```bash
npm test -- data_resource_registry
```
