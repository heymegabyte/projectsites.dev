/**
 * @module libs/features/site_data_api/handlers
 *
 * @description
 * Hono routes for **per-site D1 data tables** — a generic key→JSON row store
 * (`site_data`) that generated websites poll to stay in sync, plus the
 * authenticated admin CRUD behind it. One public read endpoint (resolves the
 * site from the request `host`) and four org-scoped admin endpoints (list
 * tables, read/upsert/delete rows). Table names are whitelisted
 * (`ALLOWED_PUBLIC_TABLES`) to prevent data leaks; every admin route guards
 * ownership through {@link ownsSiteData} (404, never 403, on a foreign/missing
 * site so cross-org `site_data` never leaks via a passed `:siteId`).
 *
 * | Method | Path                                       | Auth   | Purpose                                          |
 * | ------ | ------------------------------------------ | ------ | ------------------------------------------------ |
 * | GET    | /api/public-data/:table                     | public | Live read for a generated site (host-resolved)   |
 * | GET    | /api/sites/:siteId/data/:table              | orgId  | Admin read of one table's rows                   |
 * | PUT    | /api/sites/:siteId/data/:table/:rowId       | orgId  | Admin upsert of one row                          |
 * | DELETE | /api/sites/:siteId/data/:table/:rowId       | orgId  | Admin soft-delete of one row                     |
 * | GET    | /api/sites/:siteId/data                      | orgId  | Admin list of a site's tables + row counts       |
 *
 * Extracted VERBATIM from the `search.ts` monolith (route-decomposition
 * installment 21) — only the route-registration receiver changed (`search.` →
 * `siteDataApi.`) and the `/api/public-data/:table` handler's dynamic
 * `import('../services/site_serving.js')` was re-pathed to
 * `../../../src/services/site_serving.js` for the new module depth. The
 * `ALLOWED_PUBLIC_TABLES` whitelist and the `ownsSiteData` IDOR guard moved with
 * the routes (both were exclusive to this group). Routes return explicit JSON
 * with inline status codes (no `onError`) and bubble unexpected throws to the
 * app-level error handler exactly as before, so behavior is byte-identical.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteDataApi = new Hono<AppContext>();

// ── Public Site Data API (read-only, for live polling from generated sites) ──

/**
 * Public read-only endpoint for per-site D1 data tables. Generated websites poll
 * this to stay in sync when clients edit data. Tables are whitelisted below to
 * prevent data leaks.
 */
const ALLOWED_PUBLIC_TABLES = new Set([
  'services',
  'team_members',
  'business_hours',
  'faq',
  'menu_items',
  'gallery',
  'social_links',
  'specials',
  'products',
  'classes',
  'listings',
  'amenities',
  'reviews',
  'brand_config',
  'policies',
]);

// ── Data Overview (real site-scoped platform tables) ─────────────────────────
//
// The `site_data` CMS store above is empty for nearly every site; the data a
// site OWNER actually cares about lives in the shared platform tables, scoped by
// `site_id`. This registry powers the editor "Data" tab + admin data overview:
// a curated, read-only view of THIS site's real rows. Each entry carries an
// EXPLICIT safe-column allowlist for browsing — `form_submissions` has PII
// (email/payload/ip) and `mcp_connections` has encrypted tokens, so those
// columns are NEVER selected. `email` is additionally masked at render.

interface OverviewTable {
  /** URL-safe key + `:table` param value. */
  key: string;
  /** Human label for the UI. */
  label: string;
  /** One-line description. */
  description: string;
  /** COUNT(*) query — a single `?` bound to siteId. */
  countSql: string;
  /** Browse query — `?` siteId then `?` limit; selects only safe columns. */
  browseSql: string;
  /** Safe columns returned by browseSql (for UI headers + drift clarity). */
  columns: string[];
  /** When true, mask the `email` column value before returning. */
  maskEmail?: boolean;
}

/** Curated, read-only site-scoped tables. Column lists are the security boundary. */
export const SITE_DATA_OVERVIEW_TABLES: readonly OverviewTable[] = [
  {
    key: 'visitor_events',
    label: 'Visitor Events',
    description: 'Analytics pageviews and events',
    countSql: `SELECT COUNT(*) AS n FROM visitor_events WHERE site_id = ?`,
    browseSql: `SELECT event_type, path, referrer, created_at FROM visitor_events WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`,
    columns: ['event_type', 'path', 'referrer', 'created_at'],
  },
  {
    key: 'form_submissions',
    label: 'Form Submissions',
    description: 'Contact and lead form entries',
    countSql: `SELECT COUNT(*) AS n FROM form_submissions WHERE site_id = ?`,
    // PII-safe: no payload / ip_address / user_agent; email is masked below.
    browseSql: `SELECT form_name, status, email, created_at FROM form_submissions WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`,
    columns: ['form_name', 'status', 'email', 'created_at'],
    maskEmail: true,
  },
  {
    key: 'site_snapshots',
    label: 'Snapshots',
    description: 'Saved build versions',
    countSql: `SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL`,
    browseSql: `SELECT snapshot_name, build_version, created_at FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    columns: ['snapshot_name', 'build_version', 'created_at'],
  },
  {
    key: 'mcp_connections',
    label: 'MCP Connections',
    description: 'Connected integrations',
    // Token columns (access_token_encrypted, refresh_token_encrypted) are NEVER selected.
    countSql: `SELECT COUNT(*) AS n FROM mcp_connections WHERE site_id = ?`,
    browseSql: `SELECT provider, display_name, status, connected_at FROM mcp_connections WHERE site_id = ? ORDER BY connected_at DESC LIMIT ?`,
    columns: ['provider', 'display_name', 'status', 'connected_at'],
  },
  {
    key: 'site_data',
    label: 'Content Store',
    description: 'CMS rows synced to the live site',
    countSql: `SELECT COUNT(*) AS n FROM site_data WHERE site_id = ? AND deleted_at IS NULL`,
    browseSql: `SELECT table_name, data_json, created_at FROM site_data WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    columns: ['table_name', 'data_json', 'created_at'],
  },
];

/**
 * Look up an overview table by its key. Returns undefined for an unknown key so
 * the browse route can reject it (allowlist — never interpolate a user string).
 *
 * @param key - the `:table` path param
 * @returns the matching {@link OverviewTable} or undefined
 * @example overviewTable('visitor_events')?.label // 'Visitor Events'
 */
export function overviewTable(key: string): OverviewTable | undefined {
  return SITE_DATA_OVERVIEW_TABLES.find((t) => t.key === key);
}

/**
 * Clamp a browse `limit` query param to a safe 1–100 range (default 25).
 * A non-numeric / missing value falls back to 25; never returns 0 or negatives.
 *
 * @param raw - the raw `limit` query string
 * @returns an integer in [1, 100]
 * @example clampBrowseLimit('9999') // 100 ; clampBrowseLimit(undefined) // 25
 */
export function clampBrowseLimit(raw: string | undefined | null): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(n, 100);
}

/**
 * Build the parameterized text-search predicate for a browse query. Searches the
 * table's non-timestamp safe columns (the same allowlist that gates orderBy — the
 * SQL-injection boundary). LIKE wildcards `%`/`_` are STRIPPED from user input (repo
 * convention) so they can't act as metacharacters; the value is bounded to 100 chars.
 * Returns an empty clause + params when there's nothing to search.
 *
 * @param columns - the table's safe column allowlist
 * @param rawSearch - the client `?search=` value
 * @returns `{ clause, params }` — `clause` is ` AND (...)` (or ''); one param per column
 * @example buildDataSearch(['path','created_at'], 'ab') // { clause: ' AND ("path" LIKE ?)', params: ['%ab%'] }
 */
export function buildDataSearch(
  columns: readonly string[],
  rawSearch: string | undefined | null,
): { clause: string; params: string[] } {
  const search = String(rawSearch ?? '')
    .trim()
    .slice(0, 100)
    .replace(/[%_]/g, '');
  const cols = search ? columns.filter((col) => !/_at$/.test(col)) : [];
  if (cols.length === 0) return { clause: '', params: [] };
  return {
    clause: ` AND (${cols.map((col) => `"${col}" LIKE ?`).join(' OR ')})`,
    params: cols.map(() => `%${search}%`),
  };
}

/**
 * Build a parameterized exact-match column filter clause for a browse query
 * (`?filterCol=&filterVal=`). The column MUST be in the table's safe allowlist (the
 * SQL-injection boundary — same set that gates orderBy + search); anything else, or
 * an empty value, yields no clause. The value is parameterized (never concatenated)
 * and bounded to 200 chars. Complements the OR-of-LIKE `buildDataSearch` with a
 * precise single-column `= ?` for triaging (e.g. `status = new`).
 *
 * @param columns - the table's safe column allowlist
 * @param rawCol - the client `?filterCol=` value
 * @param rawVal - the client `?filterVal=` value
 * @returns `{ clause, params }` — `clause` is ` AND "col" = ?` (or ''); one param
 * @example buildColumnFilter(['status','path'], 'status', 'new') // { clause: ' AND "status" = ?', params: ['new'] }
 */
export function buildColumnFilter(
  columns: readonly string[],
  rawCol: string | undefined | null,
  rawVal: string | undefined | null,
): { clause: string; params: string[] } {
  const col = String(rawCol ?? '').trim();
  if (!col || !columns.includes(col)) return { clause: '', params: [] };
  const val = String(rawVal ?? '').trim().slice(0, 200);
  if (!val) return { clause: '', params: [] };
  return { clause: ` AND "${col}" = ?`, params: [val] };
}

/**
 * Mask an email local part for display: `brian@x.com` → `b***@x.com`.
 * Non-string / malformed values return '' so a browse row never leaks a raw
 * address. A one-char local part still masks fully (`a@x.com` → `*@x.com`).
 *
 * @param email - the raw email value from the row
 * @returns the masked email, or '' when the input isn't a valid-looking address
 * @example maskEmailValue('brian@megabyte.space') // 'b***@megabyte.space'
 */
export function maskEmailValue(email: unknown): string {
  if (typeof email !== 'string' || !email.includes('@')) return '';
  const [local, ...rest] = email.split('@');
  const domain = rest.join('@');
  if (!local || !domain) return '';
  const head = local.length > 1 ? `${local[0]}***` : '*';
  return `${head}@${domain}`;
}

siteDataApi.get('/api/public-data/:table', async (c) => {
  const table = c.req.param('table');
  if (!ALLOWED_PUBLIC_TABLES.has(table)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Unknown table' } }, 400);
  }

  // Resolve site from hostname (subdomain or custom domain).
  const hostname = c.req.header('host') || '';
  const { resolveSite } = await import('../../../src/services/site_serving.js');
  const site = await resolveSite(c.env, c.env.DB, hostname);
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }

  try {
    const result = await c.env.DB.prepare(
      `SELECT * FROM site_data WHERE site_id = ? AND table_name = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`,
    )
      .bind(site.site_id, table)
      .all();

    const rows = (result.results || []).map((row: Record<string, unknown>) => {
      try {
        return { id: row['id'], ...JSON.parse((row['data_json'] as string | undefined) ?? '{}') };
      } catch {
        return { id: row['id'] };
      }
    });

    return c.json({ data: rows }, 200, {
      'Cache-Control': 'public, max-age=10, stale-while-revalidate=30',
      'Access-Control-Allow-Origin': '*',
    });
  } catch {
    return c.json({ data: [] }, 200, {
      'Cache-Control': 'public, max-age=10',
      'Access-Control-Allow-Origin': '*',
    });
  }
});

/**
 * IDOR guard for the `/api/sites/:siteId/data/*` family: every handler scopes its
 * query by the `:siteId` PATH param alone, so without verifying that site belongs to
 * the caller's org a user could read/write/delete ANOTHER org's `site_data` by passing
 * a foreign siteId (orgId was only used for the 401 auth check). Returns false → 404.
 */
async function ownsSiteData(db: D1Database, siteId: string, orgId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
    .bind(siteId, orgId)
    .first();
  return !!row;
}

/** Authenticated endpoint for admin to read/write site data. */
siteDataApi.get('/api/sites/:siteId/data/:table', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  if (!ALLOWED_PUBLIC_TABLES.has(table)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Unknown table' } }, 400);
  }

  const result = await c.env.DB.prepare(
    `SELECT * FROM site_data WHERE site_id = ? AND table_name = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`,
  )
    .bind(siteId, table)
    .all();

  const rows = (result.results || []).map((row: Record<string, unknown>) => {
    try {
      return {
        id: row['id'],
        sort_order: row['sort_order'],
        ...JSON.parse((row['data_json'] as string | undefined) ?? '{}'),
      };
    } catch {
      return { id: row['id'], sort_order: row['sort_order'] };
    }
  });

  return c.json({ data: rows });
});

/** Upsert a row in a site data table. */
siteDataApi.put('/api/sites/:siteId/data/:table/:rowId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table, rowId } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  if (!ALLOWED_PUBLIC_TABLES.has(table)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Unknown table' } }, 400);
  }

  // `.catch(() => null)` + object-guard: a malformed or non-object body must
  // never silently clobber the row's `data_json` with garbage (a bare string
  // or `{}` recovered from a parse failure). Reject with a 400 BEFORE the write;
  // a well-formed object (incl. an intentional empty `{}` clear) still writes.
  const body = (await c.req.json().catch(() => null)) as {
    data?: unknown;
    sort_order?: number;
  } | null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON object body' } }, 400);
  }
  const dataJson = JSON.stringify(body.data ?? body);

  await c.env.DB.prepare(
    `INSERT INTO site_data (id, site_id, table_name, data_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data_json = ?, sort_order = ?, updated_at = datetime('now')`,
  )
    .bind(rowId, siteId, table, dataJson, body.sort_order ?? 0, dataJson, body.sort_order ?? 0)
    .run();

  return c.json({ data: { id: rowId, updated: true } });
});

/** Delete a row from a site data table. */
siteDataApi.delete('/api/sites/:siteId/data/:table/:rowId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table, rowId } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  await c.env.DB.prepare(
    `UPDATE site_data SET deleted_at = datetime('now') WHERE id = ? AND site_id = ? AND table_name = ?`,
  )
    .bind(rowId, siteId, table)
    .run();

  return c.json({ data: { id: rowId, deleted: true } });
});

/** List all tables for a site (for admin data grid). */
siteDataApi.get('/api/sites/:siteId/data', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const siteId = c.req.param('siteId');
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const result = await c.env.DB.prepare(
    `SELECT DISTINCT table_name, COUNT(*) as row_count FROM site_data WHERE site_id = ? AND deleted_at IS NULL GROUP BY table_name ORDER BY table_name`,
  )
    .bind(siteId)
    .all();

  return c.json({ data: result.results || [] });
});

/**
 * Data overview: the site's REAL platform tables (visitor_events, form_submissions,
 * snapshots, MCP connections, content store) with live row counts. Read-only,
 * org-scoped (IDOR-guarded), fail-soft per table (a missing table → 0, never 500).
 * Powers the editor "Data" tab + admin data overview.
 */
siteDataApi.get('/api/sites/:siteId/data-overview', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const siteId = c.req.param('siteId');
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const tables = await Promise.all(
    SITE_DATA_OVERVIEW_TABLES.map(async (t) => {
      let rowCount = 0;
      try {
        const row = await c.env.DB.prepare(t.countSql).bind(siteId).first<{ n: number }>();
        rowCount = Number(row?.n ?? 0);
      } catch {
        rowCount = 0; // a missing/renamed table must never 500 the whole overview
      }
      return {
        key: t.key,
        label: t.label,
        description: t.description,
        columns: t.columns,
        row_count: rowCount,
        browsable: true,
      };
    }),
  );

  return c.json({ data: { tables } });
});

/**
 * Browse the most-recent rows of one overview table. Read-only; only the table's
 * safe-column allowlist is selected (never PII payloads or encrypted tokens);
 * `email` is masked. Unknown table → 400; missing table at runtime → empty rows.
 */
siteDataApi.get('/api/sites/:siteId/data-overview/:table', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  const spec = overviewTable(table);
  if (!spec) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Unknown table' } }, 400);
  }
  const limit = clampBrowseLimit(c.req.query('limit'));
  const offset = Math.max(0, Number.parseInt(String(c.req.query('offset') ?? '0'), 10) || 0);
  const orderBy = c.req.query('orderBy');
  const dir = String(c.req.query('dir') ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // Optional parameterized text search (OR-of-LIKE) + a precise single-column
  // exact-match filter, both injected after `WHERE site_id = ?` on BOTH the browse
  // AND count queries so `total` reflects the filtered set. Columns are allowlist-
  // validated (the injection boundary); values are parameterized + bounded.
  const { clause: searchClause, params: searchParams } = buildDataSearch(spec.columns, c.req.query('search'));
  const { clause: filterClause, params: filterParams } = buildColumnFilter(
    spec.columns,
    c.req.query('filterCol'),
    c.req.query('filterVal'),
  );
  const extraClause = `${searchClause}${filterClause}`;
  const extraParams = [...searchParams, ...filterParams];
  const withSearch = (sql: string): string =>
    extraClause ? sql.replace(/WHERE site_id = \?/i, `WHERE site_id = ?${extraClause}`) : sql;

  // Server-side pagination — never load a whole table into the browser. A VALID
  // orderBy (in the column allowlist) rebuilds the ORDER BY with that validated
  // identifier; anything else keeps the spec's default sort, so an unknown/hostile
  // column string can never reach the SQL (allowlist is the injection boundary).
  const base = withSearch(spec.browseSql);
  const browseSql =
    orderBy && spec.columns.includes(orderBy)
      ? `${base.replace(/\s+ORDER BY\s+.+\s+LIMIT\s+\?\s*$/i, '')} ORDER BY "${orderBy}" ${dir} LIMIT ? OFFSET ?`
      : base.replace(/\s+LIMIT\s+\?\s*$/i, ' LIMIT ? OFFSET ?');

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  try {
    const [browseRes, countRes] = await Promise.all([
      c.env.DB.prepare(browseSql).bind(siteId, ...extraParams, limit, offset).all(),
      c.env.DB.prepare(withSearch(spec.countSql)).bind(siteId, ...extraParams).first<{ n: number }>(),
    ]);
    rows = (browseRes.results || []) as Record<string, unknown>[];
    total = countRes?.n ?? 0;
  } catch {
    rows = []; // fail-soft: a missing/renamed table returns empty, never 500
    total = 0;
  }
  if (spec.maskEmail) {
    rows = rows.map((r) => ('email' in r ? { ...r, email: maskEmailValue(r['email']) } : r));
  }

  // `data.{table,columns,rows}` is preserved for the existing consumer; `total`,
  // `limit`, `offset` are additive for the paginated grid.
  return c.json({ data: { table: spec.key, columns: spec.columns, rows }, total, limit, offset });
});
