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

import { ownsSiteData } from '../site_data_api/handlers.js';

import { reconcileResources } from './reconciler.js';
import { listResources } from './service.js';
import {
  type ResourceDriftCode,
  type ResourceEnvironment,
  ResourceEnvironmentSchema,
  type ResourceKind,
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
  const environment =
    parseEnvironment(c.req.query('environment')) ??
    parseEnvironment(await readBodyEnvironment(c.req.raw.clone()));
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

// ─────────────────────────────────────────────────────────────────────────────
// helpers (pure — grouping / sorting / re-shaping the reconcile result)
// ─────────────────────────────────────────────────────────────────────────────

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
