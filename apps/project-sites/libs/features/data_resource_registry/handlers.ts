/**
 * @module libs/features/data_resource_registry/handlers
 *
 * @description
 * Hono routes for the **Resource Overview + Reconcile** surface (Data & Resource Platform §1 + §6 —
 * `docs/data-resource-platform/DESIGN.md`). This is the FIRST wired surface over the Authoritative
 * Resource Registry: a site owner reads the CF resources their OWN site touches (grouped by
 * `resource_kind`) and can trigger a server-side reconcile that diffs the registry against what CF
 * actually reports and records any drift.
 *
 * The security keystone is the same as every per-site route (copied from the D1 "Tables" surface,
 * `site_data_api/site_db_handlers.ts`): the caller NEVER names a CF id/account/namespace/resource_id.
 * They address only their OWNED `siteId` (path param) + an `environment` enum, and the trusted
 * service ({@link listResources} / {@link reconcileResources}) resolves every real id from a
 * registry row the caller already proved they own. `resolveResourceRef` is the deeper id-resolution
 * fence; these routes never accept an id to resolve in the first place.
 *
 * | Method | Path                                            | Auth  | Purpose                                        |
 * | ------ | ----------------------------------------------- | ----- | ---------------------------------------------- |
 * | GET    | /api/sites/:siteId/resources?environment=…      | orgId | List the site's registry rows (grouped by kind)|
 * | POST   | /api/sites/:siteId/resources/reconcile          | orgId | Reconcile registry ↔ CF; record + return drift |
 *
 * The 5-step server gate on EVERY route (never reordered):
 *   1. AUTH       — `orgId` from the authed context, else 401. NEVER from the body/query.
 *   2. FLAG       — `isFlagOn(env, 'data_resource_platform', …)`, else **404 (DARK)** — per
 *                   `feature-flags` never 403, never leak existence.
 *   3. OWNERSHIP  — `ownsSiteData(env.DB, siteId, orgId)` (the canonical IDOR guard), else 404
 *                   (never 403 — a 403 would confirm the id exists to a prober).
 *   4. OPERANDS   — validate the `environment` enum (`ResourceEnvironmentSchema`), else 400.
 *   5. RESOLVE    — only then call the trusted service, which server-resolves every CF id.
 *
 * Since `site_resource_registry` is EMPTY until a reconcile seeds it, the GET honestly returns an
 * empty list for a site that has never reconciled — an honest-empty state, not an error.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { resolveCfCredentials } from '../../../src/services/cf_credentials.js';

import { ownsSiteData } from '../site_data_api/handlers.js';

import type { AdapterResult, ResolvedScope } from './adapter.js';
import { IMPLEMENTED_ADAPTERS, reconcileResources } from './reconciler.js';
import { listResources, resolveResourceRef } from './service.js';
import {
  type ResourceDetailAction,
  ResourceDetailActionSchema,
  ResourceDetailParamsSchema,
  type ResourceDriftCode,
  type ResourceEnvironment,
  ResourceEnvironmentSchema,
  type ResourceKind,
  ResourceKindSchema,
  ResourceMutateBodySchema,
  type ResourceRecord,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const resourceRegistryApi = new Hono<AppContext>();

/** The flag gating the entire Data & Resource Platform overview surface (default-off / DARK). */
const FLAG = 'data_resource_platform';

/**
 * One drift finding as the reconcile route surfaces it. Kept structurally loose (kind + optional
 * typed drift code + optional detail) so it stays compatible with whatever richer object the
 * reconciler returns — the route only re-shapes to the stable public envelope, it does not own the
 * reconcile logic.
 */
interface DriftFinding {
  resourceKind?: ResourceKind;
  driftCode?: ResourceDriftCode | null;
  detail?: string | null;
}

/**
 * Parse + validate the `environment` query param against the enum. Defaults to `'production'`
 * (matching `ResourceRefSchema`/`RecordResourceInputSchema`) when absent. Returns `null` when a
 * value is present but not a valid environment → the route renders 400.
 */
function parseEnvironment(raw: string | undefined): ResourceEnvironment | null {
  if (raw === undefined || raw === '') return 'production';
  const parsed = ResourceEnvironmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * GET the site's registry rows for one environment, grouped by `resource_kind` for the overview UI.
 * Read-only. Server-resolves nothing beyond the OWNED site + env (no CF id is ever accepted).
 */
resourceRegistryApi.get('/api/sites/:siteId/resources', async (c) => {
  // 1. AUTH
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId } = c.req.param();

  // 2. FLAG (DARK → 404, never 403 / never leak existence)
  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Resource platform is not enabled' } },
      404,
    );

  // 3. OWNERSHIP (IDOR guard — 404 on foreign/missing, never 403)
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  // 4. OPERANDS
  const environment = parseEnvironment(c.req.query('environment'));
  if (environment === null)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid environment' } },
      400,
    );

  // 5. RESOLVE — trusted service reads only rows for the OWNED site + env.
  try {
    const resources = await listResources(c.env, siteId, environment);
    return c.json({
      data: {
        environment,
        resources: sortByKind(resources),
        countsByKind: countByKind(resources),
      },
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        msg: 'resource_registry_list_failed',
        service: 'data_resource_registry_handlers',
        siteId,
        environment,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Could not read site resources.' } },
      500,
    );
  }
});

/**
 * POST reconcile: diff the registry against what CF actually reports for the OWNED site + env,
 * record any drift, and return the number reconciled plus the drift list. Delegates entirely to
 * {@link reconcileResources} (authored alongside) — this route only runs the 5-step gate and
 * re-shapes the result to the stable public envelope.
 */
resourceRegistryApi.post('/api/sites/:siteId/resources/reconcile', async (c) => {
  // 1. AUTH
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId } = c.req.param();

  // 2. FLAG (DARK → 404)
  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Resource platform is not enabled' } },
      404,
    );

  // 3. OWNERSHIP (IDOR guard — 404 on foreign/missing)
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  // 4. OPERANDS — reconcile targets ONE environment; default production. Body may carry it too.
  // A query param that is PRESENT-but-invalid must 400 immediately — never let `??` treat its
  // `null` like an ABSENT param and silently fall through to the body/production default (that
  // swallowed `staging` and 502'd inside the reconciler). Only an ABSENT query defers to the body.
  const rawQueryEnv = c.req.query('environment');
  const queryEnv = parseEnvironment(rawQueryEnv);
  const environment =
    rawQueryEnv !== undefined && rawQueryEnv !== ''
      ? queryEnv
      : (queryEnv ?? parseEnvironment(await readBodyEnvironment(c.req.raw.clone())));
  if (environment === null)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid environment' } },
      400,
    );

  // 5. RESOLVE — the reconciler server-resolves every CF id from OWNED rows; no id is accepted here.
  try {
    const result = await reconcileResources(c.env, siteId, environment);
    return c.json({
      data: {
        environment,
        reconciled: result.reconciled,
        drift: (result.drift ?? []).map(toDriftFinding),
      },
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        msg: 'resource_registry_reconcile_failed',
        service: 'data_resource_registry_handlers',
        siteId,
        environment,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Could not reconcile site resources.' } },
      502,
    );
  }
});

/**
 * GET one resource's DETAIL: dispatch a `list` or `get` READ verb to the kind's adapter for the
 * OWNED site + environment, and return the adapter's typed {@link AdapterResult} verbatim under
 * `{ data: { kind, action, result } }`. This is the generic per-kind drill-in the editor's
 * ResourceDetailPanel drives — one endpoint that serves EVERY implemented kind, because every
 * adapter shares the uniform `list`/`get` → `AdapterResult` contract (adapter.ts).
 *
 * The caller NEVER names a CF id (INV-1): it addresses `:kind` + `?action=` + bounded, non-identifier
 * params (`table`/`key`/`prefix`/`cursor`/`id`/`ids`/`limit`/`offset`). The 5-step gate resolves the
 * real CF id server-side from a registry row the caller proved it owns:
 *   1. AUTH       — `orgId` from context, else 401.
 *   2. FLAG       — `isFlagOn(data_resource_platform)`, else 404 (DARK, never 403).
 *   3. OWNERSHIP  — `ownsSiteData`, else 404 (IDOR, never 403).
 *   4. OPERANDS   — validate `kind` ∈ ResourceKind, `action` ∈ {list,get}, `environment` enum, and
 *                   the safe params — else 400.
 *   5. RESOLVE    — `resolveResourceRef` maps `{kind,environment}` → the OWNED CF id (or a typed
 *                   reason), then dispatch to `IMPLEMENTED_ADAPTERS[kind].list|get(scope, params)`.
 *
 * Honest passthrough: a kind with NO owned registry row resolves `not_registered` → a 200
 * `{ result: { ok:false, error:{code:'not_registered'} } }` (an honest "nothing to show", not a 500);
 * a kind with no wired adapter → `not_registered` likewise; an `unsupported_kind` (queue) →
 * `not_supported`. The adapter's own typed errors (`table_not_found`, `cf_unauthorized`, …) pass
 * through untouched — the surface renders them as-is, never fabricating data.
 */
resourceRegistryApi.get('/api/sites/:siteId/resources/:kind/detail', async (c) => {
  // 1. AUTH
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, kind: rawKind } = c.req.param();

  // 2. FLAG (DARK → 404, never 403 / never leak existence)
  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Resource platform is not enabled' } },
      404,
    );

  // 3. OWNERSHIP (IDOR guard — 404 on foreign/missing, never 403)
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  // 4. OPERANDS — kind + action + environment + safe params (never a CF id).
  const parsedKind = ResourceKindSchema.safeParse(rawKind);
  if (!parsedKind.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid resource kind' } }, 400);
  const kind = parsedKind.data;

  const parsedAction = ResourceDetailActionSchema.safeParse(c.req.query('action'));
  if (!parsedAction.success)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'action must be "list" or "get"' } },
      400,
    );
  const action = parsedAction.data;

  const environment = parseEnvironment(c.req.query('environment'));
  if (environment === null)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid environment' } }, 400);

  const parsedParams = ResourceDetailParamsSchema.safeParse(collectDetailParams(c.req));
  if (!parsedParams.success)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid detail parameters' } },
      400,
    );

  // 5. RESOLVE + dispatch — the CF id is server-resolved from an OWNED registry row.
  try {
    const result = await runDetail(c.env, siteId, orgId, kind, action, environment, parsedParams.data);
    return c.json({ data: { action, kind, result } });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        msg: 'resource_registry_detail_failed',
        service: 'data_resource_registry_handlers',
        siteId,
        kind,
        action,
        environment,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Could not read this resource.' } },
      500,
    );
  }
});

/**
 * POST one resource's MUTATE: dispatch a NAMED, typed write verb to the kind's adapter for the OWNED site +
 * environment, and return the adapter's typed {@link AdapterResult} verbatim under
 * `{ data: { kind, action, result } }`. This is the generic per-kind WRITE the editor's ResourceDetailPanel
 * drives — one endpoint that serves EVERY implemented kind, because every adapter shares the uniform
 * `mutate(scope, {action, ...input, confirm}) → AdapterResult` contract (adapter.ts). This is the OWNER acting
 * on their OWN resource (the embedded editor bridge carries the owner session).
 *
 * The caller NEVER names a CF id (INV-1): it addresses `:kind` + a body `{ action, input?, confirm? }` whose
 * `input` carries only bounded, non-identifier operands (key/value, sql/params, ids, instanceId, messages, …).
 * The 5-step gate resolves the real CF id server-side from a registry row the caller proved it owns:
 *   1. AUTH       — `orgId` from context, else 401.
 *   2. FLAG       — `isFlagOn(data_resource_platform)`, else 404 (DARK, never 403).
 *   3. OWNERSHIP  — `ownsSiteData`, else 404 (IDOR, never 403).
 *   4. OPERANDS   — validate `kind` ∈ ResourceKind, the `{action,input?,confirm?}` body (`.strict` strips a
 *                   smuggled id), the `environment` enum, and that `action` ∈ the adapter's declared
 *                   `supports.mutations` — else 400 (or an honest `not_supported`/`not_registered` result).
 *   5. RESOLVE    — for `provision` (which PRODUCES the id) attach `scope.env` + `scope.tenantId` and dispatch
 *                   with an empty `resourceId`; for every other action `resolveResourceRef` maps
 *                   `{kind,environment}` → the OWNED CF id, then dispatch `IMPLEMENTED_ADAPTERS[kind].mutate`.
 *
 * Honest passthrough: `confirmation_required` (a destructive/billable op awaiting `confirm:true`),
 * `not_available`/`not_supported` (a verb the CF API can't back), `not_registered` (no owned row), and the
 * adapter's own typed errors (`cf_unauthorized`, `quota_at_cap`, …) ALL pass through as a 200
 * `{ result: { ok:false, error } }` — the surface renders them as-is, never fabricating a success.
 */
resourceRegistryApi.post('/api/sites/:siteId/resources/:kind/mutate', async (c) => {
  // 1. AUTH
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, kind: rawKind } = c.req.param();

  // 2. FLAG (DARK → 404, never 403 / never leak existence)
  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Resource platform is not enabled' } },
      404,
    );

  // 3. OWNERSHIP (IDOR guard — 404 on foreign/missing, never 403)
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  // 4. OPERANDS — kind + the {action,input?,confirm?} body (strict strips a smuggled id) + environment.
  const parsedKind = ResourceKindSchema.safeParse(rawKind);
  if (!parsedKind.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid resource kind' } }, 400);
  const kind = parsedKind.data;

  const rawBody = (await c.req.json().catch(() => null)) as unknown;
  const parsedBody = ResourceMutateBodySchema.safeParse(rawBody);
  if (!parsedBody.success)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'action is required; a CF id may not be supplied' } },
      400,
    );
  const { action, input, confirm } = parsedBody.data;

  const environment = parseEnvironment(c.req.query('environment'));
  if (environment === null)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid environment' } }, 400);

  // 5. RESOLVE + dispatch — the CF id is server-resolved from an OWNED registry row (or PRODUCED by provision).
  try {
    const result = await runMutate(c.env, siteId, orgId, kind, action, environment, input, confirm);
    return c.json({ data: { action, kind, result } });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        msg: 'resource_registry_mutate_failed',
        service: 'data_resource_registry_handlers',
        siteId,
        kind,
        action,
        environment,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Could not perform this action.' } },
      500,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers (pure — grouping / sorting / re-shaping the reconcile result)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A typed adapter-style envelope the detail route returns WITHOUT calling CF when the ref cannot be
 * resolved to an owned CF id — an honest "nothing to show here" rather than a 500. Mirrors
 * {@link AdapterResult} so the client renders resolve-failures with the SAME code path as an adapter's
 * own typed errors. `not_registered`/`not_owned` are the common "blank site" cases (no row yet);
 * `not_supported` is a kind the CF API can't back (queue).
 */
function resolveFailureEnvelope(reason: string): AdapterResult<never> {
  const notSupported = reason === 'unsupported_kind';
  return {
    correlationId: `resolve-${reason}`,
    error: {
      code: notSupported ? 'not_supported' : reason === 'not_registered' ? 'not_registered' : reason,
      message: notSupported
        ? 'This resource kind is not available on this deployment.'
        : reason === 'not_registered'
          ? 'No resource of this kind is connected to this site yet.'
          : 'This resource could not be read.',
      retryable: reason === 'no_account_id',
    },
    ok: false,
  };
}

/**
 * Resolve the OWNED CF id for `(siteId, kind, environment)`, build the adapter scope, and dispatch the
 * requested read verb. Returns the adapter's {@link AdapterResult} — or an honest
 * {@link resolveFailureEnvelope} when the ref can't resolve or the kind has no wired adapter/verb.
 * NEVER accepts a CF id; every id comes from the registry via {@link resolveResourceRef}.
 */
async function runDetail(
  env: Env,
  siteId: string,
  orgId: string,
  kind: ResourceKind,
  action: ResourceDetailAction,
  environment: ResourceEnvironment,
  params: Record<string, unknown>,
): Promise<AdapterResult<unknown>> {
  const adapter = IMPLEMENTED_ADAPTERS[kind];
  // A kind with no wired CF-backed adapter is an honest "nothing to show" (never a 500).
  if (!adapter) return resolveFailureEnvelope('not_registered');

  // The verb the caller wants must be one this adapter actually serves (honest capability gate).
  if (!adapter.supports.verbs.includes(action)) {
    return {
      correlationId: `unsupported-${action}`,
      error: {
        code: 'not_supported',
        message: `The ${kind} resource does not support '${action}'.`,
        retryable: false,
      },
      ok: false,
    };
  }

  // Server-resolve the CF id from an OWNED registry row (INV-1/§4) — the caller named only the kind.
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind },
    { orgId },
  );
  if (!resolved.ok) return resolveFailureEnvelope(resolved.reason);

  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return resolveFailureEnvelope('no_account_id');
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) return resolveFailureEnvelope('no_account_id');

  const scope: ResolvedScope = {
    accessPolicy: resolved.accessPolicy,
    accountId,
    auth,
    // D1 handle for D1-backed kinds (e.g. connection reads mcp_connections); CF-REST adapters ignore it.
    db: env.DB,
    environment,
    ingestEnabled: env.ANALYTICS_INGEST_ENABLED === 'true',
    orgId,
    resourceId: resolved.resourceId,
    siteId,
  };

  return action === 'list' ? adapter.list(scope, params) : adapter.get(scope, params);
}

/**
 * The named mutations that CREATE a new CF resource rather than operate on an already-resolved one. For these,
 * `scope.resourceId` is EMPTY (the id is what the mutation PRODUCES), so resolve is SKIPPED and the scope is
 * built with `env` + `tenantId` instead (`service.provisionResource` needs the DB + creds). Every other
 * mutation operates on an owned, server-resolved id. Kept as a set so the "produces vs operates-on" split is
 * one lookup (mirrors `PROVISION_META` in service.ts).
 */
const PRODUCING_MUTATIONS: ReadonlySet<string> = new Set(['provision']);

/**
 * Resolve the OWNED CF id for `(siteId, kind, environment)`, build the adapter scope, and dispatch the requested
 * NAMED mutation. Returns the adapter's {@link AdapterResult} — or an honest {@link resolveFailureEnvelope}
 * when the ref can't resolve or the kind has no wired adapter/verb/mutation. NEVER accepts a CF id; every id
 * comes from the registry via {@link resolveResourceRef} (or is PRODUCED by a `provision` mutation).
 *
 * The `{action, ...input, confirm}` object is merged into the adapter's discriminated `mutate` union: the
 * top-level `confirm` hoists a destructive/billable approval so the caller need not nest it, and only bounded,
 * non-identifier `input` operands reach the adapter (the route's `.strict()` body already stripped a smuggled id).
 */
async function runMutate(
  env: Env,
  siteId: string,
  orgId: string,
  kind: ResourceKind,
  action: string,
  environment: ResourceEnvironment,
  input: Record<string, unknown> | undefined,
  confirm: boolean | undefined,
): Promise<AdapterResult<unknown>> {
  const adapter = IMPLEMENTED_ADAPTERS[kind];
  // A kind with no wired CF-backed adapter is an honest "nothing to act on" (never a 500).
  if (!adapter) return resolveFailureEnvelope('not_registered');

  // The adapter must actually declare `mutate` AND the specific named mutation (honest capability gate) — the
  // UI drives only mutations from `supports.mutations`, but re-check server-side so a crafted call can't reach
  // an unwired verb.
  if (!adapter.supports.verbs.includes('mutate') || !adapter.supports.mutations.includes(action)) {
    return {
      correlationId: `unsupported-${action}`,
      error: {
        code: 'not_supported',
        message: `The ${kind} resource does not support the '${action}' action.`,
        retryable: false,
      },
      ok: false,
    };
  }

  // Merge the mutation payload: the discriminated `{ action, ...input }` union + a hoisted top-level confirm
  // (so a destructive/billable op can be approved without nesting confirm inside input). A nested
  // `input.confirm` still works; the explicit top-level one wins when present.
  const mutateInput = {
    ...(input ?? {}),
    action,
    ...(confirm !== undefined ? { confirm } : {}),
  } as never;

  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return resolveFailureEnvelope('no_account_id');
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) return resolveFailureEnvelope('no_account_id');

  // PROVISION (and any future producing mutation) CREATES the resource, so there is no owned id to resolve yet
  // — the ownership gate already ran in the route. Build the scope with `env` + `tenantId` (the provisioner's
  // DB + creds source) and an EMPTY resourceId; `service.provisionResource` re-scopes every read on site+org.
  if (PRODUCING_MUTATIONS.has(action)) {
    const scope: ResolvedScope = {
      accessPolicy: 'no_direct',
      accountId,
      auth,
      db: env.DB,
      env,
      environment,
      ingestEnabled: env.ANALYTICS_INGEST_ENABLED === 'true',
      orgId,
      resourceId: '', // the id is what provision PRODUCES
      siteId,
      tenantId: orgId,
    };
    return adapter.mutate(scope, mutateInput);
  }

  // Every non-producing mutation operates on an OWNED, server-resolved id (INV-1/§4) — the caller named only
  // the kind + action + safe operands.
  const resolved = await resolveResourceRef(env, siteId, { environment, kind }, { orgId });
  if (!resolved.ok) return resolveFailureEnvelope(resolved.reason);

  const scope: ResolvedScope = {
    accessPolicy: resolved.accessPolicy,
    accountId,
    auth,
    // D1 handle for D1-backed kinds (e.g. connection); CF-REST adapters ignore it. env is attached too so a
    // kind's mutate that lazily needs it never fails — additive, never widens a CF-REST adapter's contract.
    db: env.DB,
    env,
    environment,
    ingestEnabled: env.ANALYTICS_INGEST_ENABLED === 'true',
    orgId,
    resourceId: resolved.resourceId,
    siteId,
    tenantId: orgId,
  };

  return adapter.mutate(scope, mutateInput);
}

/**
 * Collect the SAFE detail params from the query string into a plain object for
 * {@link ResourceDetailParamsSchema}. Only reads the known keys (never a CF id); `ids` accepts either
 * repeated `?ids=` params or a single comma-separated value. Absent keys are omitted so Zod defaults +
 * `.strict()` behave. Numeric coercion is left to the schema (`z.coerce.number`).
 */
function collectDetailParams(req: {
  query: (k: string) => string | undefined;
  queries: (k: string) => string[] | undefined;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['table', 'key', 'prefix', 'cursor', 'id', 'limit', 'offset'] as const) {
    const value = req.query(key);
    if (value !== undefined && value !== '') out[key] = value;
  }
  const idsMulti = req.queries('ids');
  if (idsMulti && idsMulti.length > 0) {
    const ids = idsMulti.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) out.ids = ids;
  }
  return out;
}

/** Stable kind ordering for the overview (mirrors `ResourceKindSchema` declaration order). */
const KIND_ORDER: readonly ResourceKind[] = [
  'd1',
  'kv',
  'r2',
  'durable_object',
  'workflow',
  'queue',
  'vectorize',
  'analytics_engine',
  'connection',
];

/**
 * Sort registry rows by `resource_kind` (declaration order), then concept, then id — a deterministic
 * order the UI can group on without re-sorting. `listResources` already orders by
 * kind/concept/created_at at the SQL layer; this keeps the guarantee explicit + stable if the query
 * ever changes.
 */
function sortByKind(rows: ResourceRecord[]): ResourceRecord[] {
  const rank = (k: ResourceKind): number => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? KIND_ORDER.length : i;
  };
  return [...rows].sort(
    (a, b) =>
      rank(a.resourceKind) - rank(b.resourceKind) ||
      a.resourceConcept.localeCompare(b.resourceConcept) ||
      a.id.localeCompare(b.id),
  );
}

/** Count rows per kind so the overview can render a per-kind tally without re-scanning client-side. */
function countByKind(rows: ResourceRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.resourceKind] = (counts[row.resourceKind] ?? 0) + 1;
  return counts;
}

/** Narrow whatever the reconciler returns per drift entry to the stable public {@link DriftFinding}. */
function toDriftFinding(entry: unknown): DriftFinding {
  if (entry && typeof entry === 'object') {
    const e = entry as Record<string, unknown>;
    return {
      resourceKind: (e.resourceKind ?? e.resource_kind) as ResourceKind | undefined,
      driftCode: (e.driftCode ?? e.drift_code ?? null) as ResourceDriftCode | null,
      detail: (e.driftDetail ?? e.drift_detail ?? e.detail ?? null) as string | null,
    };
  }
  return { detail: String(entry) };
}

/**
 * Best-effort read of an `environment` field from a JSON body (reconcile accepts it in query OR
 * body). Never throws — a missing/invalid/non-JSON body yields `undefined`, so the query param + the
 * `'production'` default remain the source of truth.
 */
async function readBodyEnvironment(req: Request): Promise<string | undefined> {
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return undefined;
    const body = (await req.json()) as { environment?: unknown } | null;
    return typeof body?.environment === 'string' ? body.environment : undefined;
  } catch {
    return undefined;
  }
}
