/**
 * @module libs/features/data_resource_registry/reconciler
 * @description Reconcile the Authoritative Resource Registry against the REAL per-site allocations
 * and the live Cloudflare control plane (Data & Resource Platform §1 + §6).
 *
 * Two directions, one pass ({@link reconcileResources}):
 *
 *  1. **Record what really exists** — read the per-site allocation SOURCES for the owned site
 *     (`site_database_allocations`: the D1 allocation, plus the KV/R2 allocation columns when present)
 *     and UPSERT a {@link ResourceRecord} into `site_resource_registry` via {@link recordResource}
 *     for each REAL allocation. Honest empty: a kind with NO allocation source records NOTHING (an
 *     empty registry for a blank site is the correct state, per `verify-against-source-of-truth` —
 *     we never fabricate a row for a resource the source doesn't actually claim).
 *
 *  2. **Detect drift on what we already claim** — for each existing registry row of an IMPLEMENTED
 *     kind, call that kind's adapter {@link ResourceAdapter.head} against a SERVER-RESOLVED scope and,
 *     when the row claims the resource exists but the CF head 404s, set the row's `drift_code` to
 *     `resource_missing_on_cf`. This is exactly the "render-clean but wrong-data" gap that a
 *     display-only check is blind to: a registry row can SAY a D1 exists while CF has none.
 *
 * SECURITY — this is a trusted server-side reconciler, but it obeys the same identifier discipline as
 * every route: it NEVER accepts a CF id/account/namespace from a caller. `siteId` + `environment` are
 * the only inputs; the org is resolved from the owned site; every CF id comes from a registry row or a
 * per-site allocation row the site OWNS; the account is `env.CF_ACCOUNT_ID`; credentials come from
 * `resolveCfCredentials`. The route that triggers a reconcile runs the canonical 5-step gate
 * (401 → flag-dark 404 → `assertSiteOwned`/`ownsSiteData` 404 → validate `environment` enum → run) —
 * see `site_db_handlers.ts`; this module is the "then and only then run" body.
 *
 * All D1 access goes through the repo `dbQuery`/`dbUpdate` helpers + the registry `service.ts`
 * (`recordResource`/`listResources`) — never raw `db.prepare` here.
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQueryOne, dbUpdate } from '../../../src/services/db.js';
import { resolveCfCredentials } from '../../../src/services/cf_credentials.js';

import { analyticsEngineAdapter } from './adapters/analytics_engine.js';
import { connectionAdapter } from './adapters/connection.js';
import { d1Adapter } from './adapters/d1.js';
import { durableObjectAdapter } from './adapters/durable_object.js';
import { kvAdapter } from './adapters/kv.js';
import { queueAdapter } from './adapters/queue.js';
import { r2Adapter } from './adapters/r2.js';
import { vectorizeAdapter } from './adapters/vectorize.js';
import { workflowAdapter } from './adapters/workflow.js';
import type { ResourceAdapter, ResolvedScope } from './adapter.js';
import {
  type ResourceEnvironment,
  ResourceEnvironmentSchema,
  type ResourceKind,
  type ResourceRecord,
} from './schemas.js';
import { listResources, recordResource } from './service.js';

/**
 * The adapters implemented so far, keyed by kind. Only kinds present here get a live `head` drift
 * probe; every other kind's registry rows are left untouched (Phase 2 fills the rest). Keeping this
 * map here (not a global singleton) means the reconciler drift-checks EXACTLY the kinds that have a
 * real CF-backed adapter — never a kind whose `head` would throw `not_implemented`.
 */
export const IMPLEMENTED_ADAPTERS: Partial<
  Record<ResourceKind, ResourceAdapter<unknown, unknown, unknown, unknown, unknown>>
> = {
  d1: d1Adapter,
  kv: kvAdapter,
  r2: r2Adapter,
  // vectorize: read-only adapter wired. `readAllocationSources` records NO vectorize allocation source
  // (per-site Vectorize provisioning isn't wired), so a blank site never gets a vectorize row — this map
  // entry only head-drift-checks a vectorize row if one already exists. Honest, never fabricated.
  vectorize: vectorizeAdapter,
  // connection: read-only adapter wired. A connection is NOT a CF account object + `readAllocationSources`
  // records NO connection allocation source, so a blank site never gets a `connection` registry row — this
  // map entry only head-checks a connection row if one already exists. Its `head` reads `mcp_connections`
  // via `scope.db` (attached in `scopeForRow`), not a CF REST API. Honest, never fabricated.
  connection: connectionAdapter,
  // workflow: read-only adapter wired. Workflows are `shared_platform` (code-deployed definitions), NOT
  // per-site — there is no CF API to create a per-site workflow definition, and `readAllocationSources`
  // records NO workflow allocation source, so a blank site never gets a `workflow` registry row. This map
  // entry only head-drift-checks a `workflow` row if one already exists (its `head` probes the workflow
  // DEFINITION via the CF Workflows REST API bound to the resolved workflow name). Honest, never fabricated.
  workflow: workflowAdapter,
  // durable_object: read-only adapter wired. DOs are addressed AT RUNTIME by a Worker holding the class
  // binding — there is NO CF API to enumerate instances or read arbitrary state (⛔ HARD FACT #3). Only
  // `SITE_BUILDER` is bound; there is NO per-site DO namespace, and `readAllocationSources` records NO
  // durable_object allocation source, so a blank site never gets a `durable_object` registry row. This map
  // entry only head-drift-checks a `durable_object` row if one already exists (its `head` probes the DO
  // CLASS namespace via the CF management REST API filtered to the resolved namespace id). Honest, never
  // fabricated — the adapter surfaces namespaces/ids, never object state.
  durable_object: durableObjectAdapter,
  // queue: read-only adapter wired. Queues are UNSUPPORTED on this deployment — there is NO `QUEUE` binding
  // (both producer + consumer blocks commented), the code falls back to Workflows, and `queue` is in
  // `UNSUPPORTED_KINDS` so `resolveResourceRef` returns `unsupported_kind` UPSTREAM. `readAllocationSources`
  // records NO queue allocation source, so a blank site never gets a `queue` registry row. This map entry
  // only head-drift-checks a `queue` row if one already exists (its `head` probes the queue via the CF Queues
  // REST API bound to the resolved queue id). Honest, never fabricated — the adapter surfaces config +
  // metrics only, never a message body or a "history" (peek ≠ history; pull = leases + ack).
  queue: queueAdapter,
  // analytics_engine: read-only observability adapter wired. AE INGEST is disabled on this deployment
  // (`ANALYTICS_INGEST_ENABLED="false"`) so its `head` honestly reports `available:false` (never a fabricated
  // event stream); the dataset is `shared_platform` (one shared `projectsites_admin_v1`, NOT per-site), and
  // `readAllocationSources` records NO analytics_engine allocation source, so a blank site never gets an
  // `analytics_engine` registry row — Observability is a cross-cutting Worker-level section, not a per-store
  // row. This map entry only head-checks an `analytics_engine` row if one already exists; `head` never 404s
  // (AE has no per-dataset existence endpoint), so it never flips a row to drift — an honest health probe.
  analytics_engine: analyticsEngineAdapter,
};

/** One recorded allocation: which kind, and the CF id/name the source row actually holds. */
interface AllocationSource {
  readonly kind: ResourceKind;
  /** The CF id (D1 uuid, KV namespace id) or name (R2 bucket) from the allocation row. */
  readonly resourceIdOrName: string;
  /** Optional human label from the allocation row (e.g. `ps-site-<id>`). */
  readonly displayName?: string;
}

/**
 * Per-row drift outcome recorded during the head sweep. `resourceKind` (not `kind`) mirrors the
 * registry column name so the `handlers.ts` public re-shape (`toDriftFinding` reads `resourceKind`)
 * captures it without a rename.
 */
export interface ReconcileDriftFinding {
  readonly registryRowId: string;
  readonly resourceKind: ResourceKind;
  readonly driftCode: 'resource_missing_on_cf';
}

/** The typed summary {@link reconcileResources} returns — honest counts, no side-channel. */
export interface ReconcileResult {
  readonly siteId: string;
  readonly environment: ResourceEnvironment;
  /**
   * Total rows this pass reconciled = allocations recorded + existing rows head-checked. The public
   * `handlers.ts` reconcile envelope surfaces this as `reconciled`.
   */
  readonly reconciled: number;
  /** How many real allocation sources were found + upserted this pass. */
  readonly recorded: number;
  /** How many existing registry rows of implemented kinds were head-probed. */
  readonly checked: number;
  /** Rows whose `head` 404'd while the row claims existence — `drift_code` was set. */
  readonly drift: readonly ReconcileDriftFinding[];
  /** Typed non-fatal notes (e.g. `no_cf_credentials` → drift sweep skipped). Never throws. */
  readonly notes: readonly string[];
}

/** The allocation-source row shape (Table A). All CF-id/name columns are nullable. */
interface AllocationRow {
  org_id: string | null;
  tenant_id: string | null;
  d1_database_id: string | null;
  d1_database_name: string | null;
  kv_namespace_id: string | null;
  kv_namespace_name: string | null;
  r2_bucket_name: string | null;
}

/**
 * Read the per-site allocation sources for the owned site and map each REAL (non-null) allocation to
 * a typed {@link AllocationSource}. Table A holds ONE dedicated allocation of each account_resource
 * kind (`site_database_allocations`); a column that is NULL means "no allocation of that kind" and is
 * skipped — never recorded. Also returns the row's `org_id`/`tenant_id` so the recorder can stamp the
 * registry row with the same owner the allocation carries.
 *
 * @param env - worker env (DB)
 * @param siteId - the OWNED site (server-side, from the route param — never client id)
 * @returns the org that owns the allocations (or `null`) + the list of real allocation sources
 */
async function readAllocationSources(
  env: Env,
  siteId: string,
): Promise<{ orgId: string | null; tenantId: string | null; sources: AllocationSource[] }> {
  const row = await dbQueryOne<AllocationRow>(
    env.DB,
    `SELECT org_id, tenant_id,
            d1_database_id, d1_database_name,
            kv_namespace_id, kv_namespace_name,
            r2_bucket_name
       FROM site_database_allocations
       WHERE site_id = ? AND status = 'active'`,
    [siteId],
  );

  const sources: AllocationSource[] = [];
  if (!row) return { orgId: null, sources, tenantId: null };

  // D1 — the dedicated per-site database (the keystone allocation).
  if (row.d1_database_id) {
    sources.push({
      displayName: row.d1_database_name ?? undefined,
      kind: 'd1',
      resourceIdOrName: row.d1_database_id,
    });
  }
  // KV — the dedicated per-site namespace (present once KV per-site provisioning lands).
  if (row.kv_namespace_id) {
    sources.push({
      displayName: row.kv_namespace_name ?? undefined,
      kind: 'kv',
      resourceIdOrName: row.kv_namespace_id,
    });
  }
  // R2 — the dedicated per-site bucket (R2 has no uuid; the NAME is the identifier).
  if (row.r2_bucket_name) {
    sources.push({
      displayName: row.r2_bucket_name,
      kind: 'r2',
      resourceIdOrName: row.r2_bucket_name,
    });
  }

  return { orgId: row.org_id ?? null, sources, tenantId: row.tenant_id ?? null };
}

/**
 * UPSERT a registry row for one real allocation. Idempotent: if an active row for
 * `(site, env, kind, account_resource)` already carries this exact CF id, nothing is written; a row
 * that exists with a STALE id gets its id + display name refreshed; otherwise a fresh row is recorded
 * via {@link recordResource} (which mints the UUIDv7 + stamps the server account). Returns `true` when
 * a NEW row was recorded (for the honest `recorded` count).
 */
async function upsertAllocationRow(
  env: Env,
  siteId: string,
  environment: ResourceEnvironment,
  orgId: string,
  source: AllocationSource,
): Promise<boolean> {
  // Is there already a live account_resource row for this kind + env on this site?
  const existing = await dbQueryOne<{ id: string; resource_id_or_name: string | null }>(
    env.DB,
    `SELECT id, resource_id_or_name FROM site_resource_registry
       WHERE site_id = ? AND environment = ? AND resource_kind = ?
         AND resource_concept = 'account_resource' AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`,
    [siteId, environment, source.kind],
  );

  if (existing) {
    // Refresh a stale id/name in place; a matching id is a no-op (idempotent reconcile).
    if (existing.resource_id_or_name !== source.resourceIdOrName) {
      await dbUpdate(
        env.DB,
        'site_resource_registry',
        {
          resource_display_name: source.displayName ?? null,
          resource_id_or_name: source.resourceIdOrName,
        },
        'id = ?',
        [existing.id],
      );
    }
    return false;
  }

  // A per-site allocation is a DEDICATED account_resource; a blank site D1 is reachable only via a
  // service binding (`no_direct`), matching how `resolveSiteDataDb` fences it. `deletionProtected`
  // defaults on in the registry — a real per-site store is never a casual delete.
  await recordResource(env, {
    accessPolicy: source.kind === 'd1' ? 'no_direct' : 'site_scoped',
    deletionProtected: true,
    environment,
    lifecycleState: 'active',
    orgId,
    provisioningMethod: 'lazy',
    resourceConcept: 'account_resource',
    resourceDisplayName: source.displayName,
    resourceIdOrName: source.resourceIdOrName,
    resourceKind: source.kind,
    siteId,
    tenancy: 'dedicated',
  });
  return true;
}

/**
 * Build a {@link ResolvedScope} for a head probe from an EXISTING registry row. The scope's
 * `resourceId` is the id ALREADY stored in the row (server-resolved, never caller-supplied); the
 * account is `env.CF_ACCOUNT_ID`; `auth` is the passed server credential. Returns `null` when the
 * row has no CF id to probe (a requested/provisioning row with a NULL id — nothing to head yet).
 */
function scopeForRow(
  env: Env,
  row: ResourceRecord,
  auth: NonNullable<Awaited<ReturnType<typeof resolveCfCredentials>>>,
  account: string,
): ResolvedScope | null {
  if (!row.resourceIdOrName) return null;
  return {
    accessPolicy: row.accessPolicy,
    accountId: account,
    auth,
    // The D1 handle is used ONLY by D1-backed kinds (e.g. `connection` reads `mcp_connections`); the
    // CF-REST adapters ignore it. Attaching it here is additive + never widens their contract.
    db: env.DB,
    environment: row.environment,
    // Server-read AE ingest state — consumed ONLY by the `analytics_engine` adapter's `head`/`get`; every
    // other adapter ignores it. Additive, never widens their contract.
    ingestEnabled: env.ANALYTICS_INGEST_ENABLED === 'true',
    orgId: row.orgId,
    resourceId: row.resourceIdOrName,
    siteId: row.siteId,
  };
}

/**
 * Reconcile the registry for one `(site, environment)`.
 *
 * The caller MUST have already proven the requester owns `siteId` (route-level `assertSiteOwned`/
 * `ownsSiteData`) and validated the `environment` enum — this function does not re-run auth, it does
 * the reconcile body. It (1) records every real per-site allocation and (2) head-probes every
 * existing registry row of an implemented kind, flagging `resource_missing_on_cf` where the row
 * claims existence but CF 404s.
 *
 * Never throws for an expected condition (missing credentials, an adapter's typed `head` failure):
 * those become `notes` / are skipped so a reconcile of a partially-configured site degrades honestly
 * instead of 500-ing. `environment` is validated here too (defense-in-depth) — an invalid value is a
 * programming error and DOES throw via Zod.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param siteId - the OWNED site (server-side; never a client-supplied CF id)
 * @param environment - 'preview' | 'production' (validated against the enum)
 * @returns a typed {@link ReconcileResult} — recorded/checked counts + drift findings + notes
 */
export async function reconcileResources(
  env: Env,
  siteId: string,
  environment: ResourceEnvironment,
): Promise<ReconcileResult> {
  const env2 = ResourceEnvironmentSchema.parse(environment);
  const notes: string[] = [];

  // ── 1. Record real allocations (honest empty when a kind has no source) ──────────────────────
  const { orgId, sources } = await readAllocationSources(env, siteId);
  let recorded = 0;
  if (sources.length > 0 && !orgId) {
    // Allocations exist but carry no owning org — cannot stamp the registry row's authz key. Skip
    // recording (never guess an org); the drift sweep below still runs on any existing rows.
    notes.push('allocation_source_missing_org');
  } else if (orgId) {
    for (const source of sources) {
      if (await upsertAllocationRow(env, siteId, env2, orgId, source)) recorded += 1;
    }
  }

  // ── 2. Drift sweep — head every existing row of an implemented kind ──────────────────────────
  const rows = await listResources(env, siteId, env2);
  const drift: ReconcileDriftFinding[] = [];
  let checked = 0;

  // Only implemented kinds are worth probing (others have no CF-backed adapter yet).
  const implementedRows = rows.filter((r) => IMPLEMENTED_ADAPTERS[r.resourceKind]);
  if (implementedRows.length > 0) {
    const auth = await resolveCfCredentials(env, orgId);
    const account = env.CF_ACCOUNT_ID;
    if (!auth) {
      notes.push('no_cf_credentials'); // drift sweep skipped — cannot call CF without creds
    } else if (!account) {
      notes.push('no_account_id');
    } else {
      for (const row of implementedRows) {
        const adapter = IMPLEMENTED_ADAPTERS[row.resourceKind];
        if (!adapter) continue;
        const scope = scopeForRow(env, row, auth, account);
        if (!scope) continue; // no CF id on the row yet — nothing to head
        checked += 1;

        const result = await adapter.head(scope);
        // A row that CLAIMS existence (it has an id) but whose head reports the resource is gone is
        // drift. `ok:false` with a 404-class error === "resource_missing_on_cf". A retryable/transient
        // failure (5xx / network) is NOT treated as drift — we don't flip a row on a blip.
        const missing =
          result.ok === false &&
          result.error !== undefined &&
          result.error.retryable !== true &&
          (result.data as { exists?: boolean } | undefined)?.exists !== true;
        const explicitlyAbsent =
          result.ok === true && (result.data as { exists?: boolean } | undefined)?.exists === false;

        if (explicitlyAbsent || missing) {
          await dbUpdate(
            env.DB,
            'site_resource_registry',
            {
              drift_code: 'resource_missing_on_cf',
              drift_detail: JSON.stringify({
                correlationId: result.correlationId,
                detectedAt: new Date().toISOString(),
                probe: 'head',
              }),
              last_sync_at: new Date().toISOString(),
              lifecycle_state: 'degraded',
            },
            'id = ?',
            [row.id],
          );
          drift.push({
            driftCode: 'resource_missing_on_cf',
            registryRowId: row.id,
            resourceKind: row.resourceKind,
          });
        } else if (explicitlyPresent(result)) {
          // Clean head — clear any stale drift + stamp the sync time (idempotent).
          await dbUpdate(
            env.DB,
            'site_resource_registry',
            { drift_code: null, drift_detail: null, last_sync_at: new Date().toISOString() },
            'id = ?',
            [row.id],
          );
        }
      }
    }
  }

  return { checked, drift, environment: env2, notes, recorded, reconciled: recorded + checked, siteId };
}

/** True when a head result affirmatively reports the resource exists (drives the clean-sync branch). */
function explicitlyPresent(result: { ok: boolean; data?: unknown }): boolean {
  return result.ok === true && (result.data as { exists?: boolean } | undefined)?.exists === true;
}
