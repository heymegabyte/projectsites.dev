/**
 * @module libs/features/site_data_api/site_db_handlers
 *
 * @description
 * Hono routes for the **per-site D1 "Tables" surface** — the Data-tab view of a customer's OWN
 * Cloudflare D1 (Data Platform re-arch foundation, `docs/data-platform-scope.md`). This is the
 * FIRST slice: lazily provision a blank per-site D1 and read its tables, with tenant isolation
 * enforced server-side BEFORE any owner can reach it.
 *
 * Distinct from `handlers.ts` (`siteDataApi`): that surface reads PLATFORM tables
 * (`form_submissions`, `visitor_events`, `site_data`) from the SHARED master D1 scoped by
 * `site_id`. This surface reads the customer's OWN dedicated D1 (blank at first) — never the shared
 * DB, never another site's DB (`resolveSiteDataDb` server-resolves the id + denylists the shared
 * platform ids). CRUD / create-table / typed inline editing / undo / Time-Travel snapshots land in
 * later slices; this fire ships provision + isolation + list/browse.
 *
 * | Method | Path                                        | Auth  | Purpose                                     |
 * | ------ | ------------------------------------------- | ----- | ------------------------------------------- |
 * | GET    | /api/sites/:siteId/db/tables                | orgId | List the site's OWN tables (lazy-provision) |
 * | GET    | /api/sites/:siteId/db/tables/:table         | orgId | Browse one table's rows (paginated)         |
 *
 * Every route: (1) 401 if unauthenticated; (2) **404 (dark) when the `per_site_data` flag is off** —
 * per `feature-flags` never 403, never leak existence; (3) `ownsSiteData` IDOR guard (404 on a
 * foreign/missing site); (4) then and only then resolves the per-site D1. Table names are validated
 * against `isSafeIdent` (D1 REST cannot bind an identifier) and confirmed to exist before browsing.
 *
 * @packageDocumentation
 */
import { type Context, Hono } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import {
  isSafeIdent,
  listSiteTables,
  quoteIdent,
  resolveSiteDataDb,
  type ResolveSiteDataDbResult,
  SiteDataD1Error,
} from '../../../src/services/site_data_db.js';

import { ownsSiteData } from './handlers.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteDbApi = new Hono<AppContext>();

/** The flag gating the entire per-site data platform (default-off / DARK). */
const FLAG = 'per_site_data';

/** Clamp a browse `limit` query param into `[1, 200]` (default 50). */
function clampRowLimit(raw: string | undefined | null): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** Clamp a browse `offset` query param to a non-negative integer (default 0). */
function clampOffset(raw: string | undefined | null): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Map a resolve failure to an honest HTTP response. `forbidden_shared_db` should be structurally
 * impossible (the shared ids are never in `site_database_allocations`) — if it ever fires it's a
 * bug/attack, so it logs + returns a generic 500 rather than confirming anything.
 */
function resolveFailure(
  c: Context<AppContext>,
  siteId: string,
  reason: Extract<ResolveSiteDataDbResult, { ok: false }>['reason'],
) {
  if (reason === 'no_cf_credentials' || reason === 'no_account_id') {
    return c.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: 'Site database is not configured yet.' } },
      503,
    );
  }
  if (reason === 'forbidden_shared_db') {
    console.warn(
      JSON.stringify({
        level: 'error',
        msg: 'per_site_d1_isolation_guard_tripped',
        service: 'site_db_handlers',
        siteId,
      }),
    );
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Data store error.' } }, 500);
  }
  // provision_failed / not_provisioned
  return c.json(
    { error: { code: 'DATA_STORE_ERROR', message: 'Could not open the site database.' } },
    502,
  );
}

/** GET the customer-owned tables in a site's own D1 (creating a blank D1 on first access). */
siteDbApi.get('/api/sites/:siteId/db/tables', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId } = c.req.param();

  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Per-site data is not enabled' } }, 404);
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const resolved = await resolveSiteDataDb(c.env, siteId, { orgId });
  if (!resolved.ok) return resolveFailure(c, siteId, resolved.reason);

  try {
    const tables = await listSiteTables(resolved.db);
    return c.json({
      data: {
        databaseId: resolved.databaseId,
        provisioned: resolved.provisioned,
        tables: tables.map((name) => ({ name })),
      },
    });
  } catch (err) {
    if (err instanceof SiteDataD1Error)
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: 'Could not read site tables.' } },
        502,
      );
    throw err;
  }
});

/** Browse one table's rows (paginated) from a site's own D1. */
siteDbApi.get('/api/sites/:siteId/db/tables/:table', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table } = c.req.param();

  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Per-site data is not enabled' } }, 404);
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  // D1 REST cannot bind an identifier — validate the table name against the allowlist first.
  if (!isSafeIdent(table))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid table name' } }, 400);

  const resolved = await resolveSiteDataDb(c.env, siteId, { orgId });
  if (!resolved.ok) return resolveFailure(c, siteId, resolved.reason);

  try {
    // Confirm the table exists in THIS site's DB (clean 404 instead of a raw SQL error).
    const tables = await listSiteTables(resolved.db);
    if (!tables.includes(table))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Table not found' } }, 404);

    const limit = clampRowLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const q = quoteIdent(table);

    const [countRes, rowsRes, colRes] = await Promise.all([
      resolved.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q}`),
      resolved.db.query(`SELECT * FROM ${q} LIMIT ? OFFSET ?`, [limit, offset]),
      resolved.db.query<{ name: string; type: string; notnull: number; pk: number }>(
        `SELECT name, type, "notnull", pk FROM pragma_table_info(?)`,
        [table],
      ),
    ]);
    const total = Number(countRes.results[0]?.n ?? 0);

    return c.json({
      data: {
        columns: colRes.results,
        limit,
        offset,
        rows: rowsRes.results,
        table,
        total,
      },
    });
  } catch (err) {
    if (err instanceof SiteDataD1Error)
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: 'Could not read table rows.' } },
        502,
      );
    throw err;
  }
});
