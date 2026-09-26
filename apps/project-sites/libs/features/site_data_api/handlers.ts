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
import { writeAuditLog } from '../../../src/services/audit.js';

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
  /**
   * `SELECT MAX(<ts>) AS ts` query (single `?` = siteId) for the table's most-recent
   * activity timestamp — powers the Overview "last activity" freshness label. Uses the
   * SAME timestamp column + soft-delete filter as `browseSql`'s ORDER BY.
   */
  lastActivitySql: string;
  /** Browse query — `?` siteId then `?` limit; selects only safe columns. */
  browseSql: string;
  /** Safe columns returned by browseSql (for UI headers + drift clarity). */
  columns: string[];
  /** When true, mask the `email` column value before returning. */
  maskEmail?: boolean;
  /**
   * When true, the site owner may permanently delete their OWN rows from this table
   * via the Data browser. Requires `browseSql` to SELECT a stable `id` (the delete
   * key) and the key to be present in {@link DELETABLE_OVERVIEW_TABLES}. Off by
   * default — analytics/snapshots/MCP/content are read-only here (own lifecycles).
   */
  deletable?: boolean;
}

/** Curated, read-only site-scoped tables. Column lists are the security boundary. */
export const SITE_DATA_OVERVIEW_TABLES: readonly OverviewTable[] = [
  {
    key: 'visitor_events',
    label: 'Visitor Events',
    description: 'Analytics pageviews and events',
    countSql: `SELECT COUNT(*) AS n FROM visitor_events WHERE site_id = ?`,
    lastActivitySql: `SELECT MAX(created_at) AS ts FROM visitor_events WHERE site_id = ?`,
    browseSql: `SELECT event_type, path, referrer, created_at FROM visitor_events WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`,
    columns: ['event_type', 'path', 'referrer', 'created_at'],
  },
  {
    key: 'form_submissions',
    label: 'Form Submissions',
    description: 'Contact and lead form entries',
    countSql: `SELECT COUNT(*) AS n FROM form_submissions WHERE site_id = ?`,
    lastActivitySql: `SELECT MAX(created_at) AS ts FROM form_submissions WHERE site_id = ?`,
    // PII-safe: no payload / ip_address / user_agent; email is masked below.
    // `id` is selected as the stable delete/edit key (a random UUID, not PII) but kept
    // OUT of `columns` so it's never a rendered / sortable / searchable column.
    // `notes` is the OWNER's own free-text annotation on a lead (not lead-supplied PII)
    // — displayed + owner-editable via the typed TEXT editor (EDITABLE_OVERVIEW_COLUMNS).
    browseSql: `SELECT id, form_name, status, notes, email, created_at FROM form_submissions WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`,
    columns: ['form_name', 'status', 'notes', 'email', 'created_at'],
    maskEmail: true,
    deletable: true,
  },
  {
    key: 'site_snapshots',
    label: 'Snapshots',
    description: 'Saved build versions',
    countSql: `SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL`,
    lastActivitySql: `SELECT MAX(created_at) AS ts FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL`,
    browseSql: `SELECT snapshot_name, build_version, created_at FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    columns: ['snapshot_name', 'build_version', 'created_at'],
  },
  {
    key: 'mcp_connections',
    label: 'MCP Connections',
    description: 'Connected integrations',
    // Token columns (access_token_encrypted, refresh_token_encrypted) are NEVER selected.
    countSql: `SELECT COUNT(*) AS n FROM mcp_connections WHERE site_id = ?`,
    lastActivitySql: `SELECT MAX(connected_at) AS ts FROM mcp_connections WHERE site_id = ?`,
    browseSql: `SELECT provider, display_name, status, connected_at FROM mcp_connections WHERE site_id = ? ORDER BY connected_at DESC LIMIT ?`,
    columns: ['provider', 'display_name', 'status', 'connected_at'],
  },
  {
    key: 'site_data',
    label: 'Content Store',
    description: 'CMS rows synced to the live site',
    countSql: `SELECT COUNT(*) AS n FROM site_data WHERE site_id = ? AND deleted_at IS NULL`,
    lastActivitySql: `SELECT MAX(created_at) AS ts FROM site_data WHERE site_id = ? AND deleted_at IS NULL`,
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
 * Tables whose OWN rows a site owner may permanently delete from the Data browser.
 * The KEY is the overview key; the VALUE is the real D1 table name — a trusted
 * literal, NEVER a user string, so it is safe to interpolate into the DELETE. This
 * map is BOTH the allowlist boundary AND the killswitch: a table absent here is
 * read-only, so an owner delete can only ever touch a tenant-owned lead row
 * (`form_submissions`), always scoped `WHERE id = ? AND site_id = ?`. Analytics,
 * snapshots, MCP connections, and the content store have their own lifecycles and
 * are intentionally NOT owner-deletable through this path.
 */
export const DELETABLE_OVERVIEW_TABLES: Readonly<Record<string, string>> = {
  form_submissions: 'form_submissions',
};

/**
 * Resolve an overview key to its real, DELETE-safe table name, or undefined when the
 * table is read-only (not in the allowlist). Callers MUST treat undefined as a 400 —
 * never fall back to the raw key (that would defeat the allowlist boundary).
 *
 * @param key - the `:table` path param
 * @returns the trusted real table name, or undefined for a read-only/unknown table
 * @example deletableTableName('form_submissions') // 'form_submissions'
 * @example deletableTableName('visitor_events')   // undefined (read-only)
 */
export function deletableTableName(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DELETABLE_OVERVIEW_TABLES, key)
    ? DELETABLE_OVERVIEW_TABLES[key]
    : undefined;
}

/**
 * How one owner-editable overview column is typed + validated. A discriminated union:
 * `enum` (a fixed option set mirroring a D1 CHECK constraint) or `text` (bounded free
 * text, e.g. an owner's private note on a lead). The `type` discriminant drives BOTH the
 * server validator ({@link validateEditableValue}) and the row-detail editor the UI renders.
 */
export type EditableColumnSpec =
  | { type: 'enum'; options: readonly string[] }
  | { type: 'text'; maxLength: number };

/**
 * Per-table, per-column EDIT allowlist for the owner Data browser — the boundary AND
 * killswitch for owner edits. OUTER key = overview key; INNER key = the (trusted,
 * quoted) column; value = how the field is typed + validated. Only a SAFE,
 * constraint-bounded column is exposed: `form_submissions.status` is a CHECK-
 * constrained enum, so an owner can retriage a lead (received → forwarded) but can
 * NEVER edit PII (email/payload) or a structural column. A table/column absent here
 * is read-only. Values are validated against `options` server-side; the UPDATE is
 * always `WHERE id = ? AND site_id = ?` (double-scoped to the owner's own row).
 */
export const EDITABLE_OVERVIEW_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, EditableColumnSpec>>>
> = {
  form_submissions: {
    status: { type: 'enum', options: ['received', 'forwarded', 'partial', 'failed'] },
    // Owner's private free-text note on a lead ("called back 3pm — interested"). Bounded
    // ≤2000 chars; empty string is valid (clears the note). Not lead-supplied PII.
    notes: { type: 'text', maxLength: 2000 },
  },
};

/**
 * Resolve an overview key to its real, UPDATE-safe table name, or undefined when the
 * table has no editable columns (read-only). The key is a member of the trusted
 * `EDITABLE_OVERVIEW_COLUMNS` key set, so it is safe to interpolate.
 *
 * @example editableTableName('form_submissions') // 'form_submissions'
 * @example editableTableName('visitor_events')   // undefined (read-only)
 */
export function editableTableName(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EDITABLE_OVERVIEW_COLUMNS, key) ? key : undefined;
}

/**
 * Resolve an (overview key, column) pair to its edit spec, or undefined when the
 * table/column is read-only. Callers MUST treat undefined as a 400 — never edit a
 * column absent from the allowlist (that would defeat the boundary + could write PII
 * or a structural column).
 *
 * @example editableColumn('form_submissions', 'status')?.type // 'enum'
 * @example editableColumn('form_submissions', 'email')        // undefined (read-only)
 */
export function editableColumn(key: string, column: string): EditableColumnSpec | undefined {
  const cols = EDITABLE_OVERVIEW_COLUMNS[key];
  return cols && Object.prototype.hasOwnProperty.call(cols, column) ? cols[column] : undefined;
}

/**
 * Validate a candidate value against a column's edit spec. Enum: the value (coerced to
 * string) must be one of `options`. Text: any string ≤ `maxLength` (empty = clear the
 * note; null/undefined coerce to ''). Returns the string to bind, or an error reason.
 *
 * @example validateEditableValue({type:'enum',options:['a','b']}, 'a') // { ok:true, value:'a' }
 * @example validateEditableValue({type:'enum',options:['a']}, 'x')     // { ok:false, reason:… }
 * @example validateEditableValue({type:'text',maxLength:5}, 'hello')   // { ok:true, value:'hello' }
 * @example validateEditableValue({type:'text',maxLength:2}, 'nope')    // { ok:false, reason:… }
 */
export function validateEditableValue(
  spec: EditableColumnSpec,
  raw: unknown,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (spec.type === 'text') {
    // Free text: an empty string is VALID (clears the note) — coerce null/undefined → ''
    // so "clear the note" is a first-class action. Reject only over-length.
    const value = raw == null ? '' : String(raw);
    return value.length <= spec.maxLength
      ? { ok: true, value }
      : { ok: false, reason: `Must be ${spec.maxLength} characters or fewer` };
  }
  // enum: the value (coerced to string) must be one of the allowed options.
  const value = String(raw ?? '');
  return spec.options.includes(value)
    ? { ok: true, value }
    : { ok: false, reason: `Value must be one of: ${spec.options.join(', ')}` };
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
 * precise single-column comparison for triaging (e.g. `status = new`, `age >= 18`).
 *
 * The `?filterOp=` operator is chosen from a fixed WHITELIST by KEY — the SQL
 * comparator is never taken from user text, so it's not an injection surface (the
 * column allowlist + parameterized value remain the boundaries). Value-free ops
 * (`null`/`notnull`) ignore `rawVal`; `contains` strips LIKE wildcards from the
 * needle (matching `buildDataSearch`) and wraps it `%needle%`. An unknown/absent op
 * defaults to `eq` (backward-compatible).
 *
 * @param columns - the table's safe column allowlist
 * @param rawCol - the client `?filterCol=` value
 * @param rawVal - the client `?filterVal=` value
 * @param rawOp - the client `?filterOp=` value (one of {@link FILTER_OPS}; default `eq`)
 * @returns `{ clause, params }` — `clause` is ` AND "col" <op> ?` (or IS [NOT] NULL, or '')
 * @example buildColumnFilter(['status'], 'status', 'new') // { clause: ' AND "status" = ?', params: ['new'] }
 * @example buildColumnFilter(['age'], 'age', '18', 'gte') // { clause: ' AND "age" >= ?', params: ['18'] }
 * @example buildColumnFilter(['note'], 'note', '', 'null') // { clause: ' AND "note" IS NULL', params: [] }
 */
export const FILTER_OPS = [
  'eq',
  'ne',
  'contains',
  'gt',
  'lt',
  'gte',
  'lte',
  'null',
  'notnull',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Map a raw `?filterOp=` string to a whitelisted {@link FilterOp}; unknown/absent → `eq`. */
function normalizeFilterOp(raw: string | undefined | null): FilterOp {
  const op = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (FILTER_OPS as readonly string[]).includes(op) ? (op as FilterOp) : 'eq';
}

export function buildColumnFilter(
  columns: readonly string[],
  rawCol: string | undefined | null,
  rawVal: string | undefined | null,
  rawOp?: string | undefined | null,
): { clause: string; params: string[] } {
  const col = String(rawCol ?? '').trim();
  if (!col || !columns.includes(col)) return { clause: '', params: [] };
  const op = normalizeFilterOp(rawOp);

  // Value-free operators — never look at rawVal.
  if (op === 'null') return { clause: ` AND "${col}" IS NULL`, params: [] };
  if (op === 'notnull') return { clause: ` AND "${col}" IS NOT NULL`, params: [] };

  const val = String(rawVal ?? '').trim().slice(0, 200);
  if (!val) return { clause: '', params: [] };

  if (op === 'contains') {
    // Strip LIKE wildcards from the needle (matching buildDataSearch) → a literal substring match.
    const needle = val.replace(/[%_]/g, '');
    if (!needle) return { clause: '', params: [] };
    return { clause: ` AND "${col}" LIKE ?`, params: [`%${needle}%`] };
  }

  // Comparison operators — the comparator string comes from a fixed switch, never from user text.
  switch (op) {
    case 'ne':
      return { clause: ` AND "${col}" != ?`, params: [val] };
    case 'gt':
      return { clause: ` AND "${col}" > ?`, params: [val] };
    case 'lt':
      return { clause: ` AND "${col}" < ?`, params: [val] };
    case 'gte':
      return { clause: ` AND "${col}" >= ?`, params: [val] };
    case 'lte':
      return { clause: ` AND "${col}" <= ?`, params: [val] };
    case 'eq':
    default:
      return { clause: ` AND "${col}" = ?`, params: [val] };
  }
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
      let lastActivity: string | null = null;
      try {
        // Row count + most-recent-activity timestamp in parallel; both tenant-scoped
        // (`WHERE site_id = ?`). MAX(ts) is null for an empty table → honest "no activity".
        const [countRow, tsRow] = await Promise.all([
          c.env.DB.prepare(t.countSql).bind(siteId).first<{ n: number }>(),
          c.env.DB.prepare(t.lastActivitySql).bind(siteId).first<{ ts: string | null }>(),
        ]);
        rowCount = Number(countRow?.n ?? 0);
        lastActivity = tsRow?.ts ?? null;
      } catch {
        rowCount = 0; // a missing/renamed table must never 500 the whole overview
        lastActivity = null;
      }
      return {
        key: t.key,
        label: t.label,
        description: t.description,
        columns: t.columns,
        row_count: rowCount,
        browsable: true,
        // Owner may delete their own rows here (server re-checks the allowlist).
        deletable: !!t.deletable,
        // Owner-editable columns (typed) for this table; {} = fully read-only. The
        // server re-validates the column + value on every PATCH (this is a UI hint).
        editableColumns: EDITABLE_OVERVIEW_COLUMNS[t.key] ?? {},
        // Most-recent activity timestamp (MAX of the table's ts column), or null when
        // the table is empty — the Overview shows an honest "last activity" freshness label.
        last_activity: lastActivity,
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
  // `count=0` skips the COUNT(*) — the client reuses its cached total when only paging/sorting (the
  // query, hence the count, is unchanged). Avoids an expensive exact count on EVERY nav (grid spec).
  // Default (any other value / absent) still counts, so existing callers are unchanged.
  const wantCount = c.req.query('count') !== '0';

  // Optional parameterized text search (OR-of-LIKE) + a precise single-column
  // exact-match filter, both injected after `WHERE site_id = ?` on BOTH the browse
  // AND count queries so `total` reflects the filtered set. Columns are allowlist-
  // validated (the injection boundary); values are parameterized + bounded.
  const { clause: searchClause, params: searchParams } = buildDataSearch(spec.columns, c.req.query('search'));
  const { clause: filterClause, params: filterParams } = buildColumnFilter(
    spec.columns,
    c.req.query('filterCol'),
    c.req.query('filterVal'),
    c.req.query('filterOp'),
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
  // `null` = not counted this request (client reuses its cached total). A number = the exact count.
  let total: number | null = wantCount ? 0 : null;
  try {
    if (wantCount) {
      const [browseRes, countRes] = await Promise.all([
        c.env.DB.prepare(browseSql).bind(siteId, ...extraParams, limit, offset).all(),
        c.env.DB.prepare(withSearch(spec.countSql)).bind(siteId, ...extraParams).first<{ n: number }>(),
      ]);
      rows = (browseRes.results || []) as Record<string, unknown>[];
      total = countRes?.n ?? 0;
    } else {
      // Paging/sorting only — skip the COUNT(*); the client keeps its cached total.
      const browseRes = await c.env.DB.prepare(browseSql)
        .bind(siteId, ...extraParams, limit, offset)
        .all();
      rows = (browseRes.results || []) as Record<string, unknown>[];
    }
  } catch {
    rows = []; // fail-soft: a missing/renamed table returns empty, never 500
    total = wantCount ? 0 : null;
  }
  if (spec.maskEmail) {
    rows = rows.map((r) => ('email' in r ? { ...r, email: maskEmailValue(r['email']) } : r));
  }

  // `data.{table,columns,rows}` is preserved for the existing consumer; `total` (null when the count
  // was skipped), `limit`, `offset` are additive for the paginated grid.
  return c.json({ data: { table: spec.key, columns: spec.columns, rows }, total, limit, offset });
});

/**
 * Permanently delete ONE of the site's own rows from a DELETABLE overview table
 * (currently only `form_submissions` — a tenant-owned lead). Read-only tables → 400.
 *
 * Safety chain: org auth (401) → {@link ownsSiteData} tenant gate (404, never a 403
 * leak) → {@link deletableTableName} resolves the real table from the allowlist (a
 * trusted literal, so a hostile `:table` string can NEVER reach the SQL) →
 * parameterized `WHERE id = ? AND site_id = ?` (double-scoped: the row must match the
 * given id AND belong to THIS owner's site) → `meta.changes === 0` means no such row
 * for this site → 404 (never a silent success). Every delete is audit-logged.
 * `form_submissions` has no `deleted_at`, so this is a HARD delete — the UI confirms
 * before calling (irreversible).
 */
siteDataApi.delete('/api/sites/:siteId/data-overview/:table/:rowId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table, rowId } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const realTable = deletableTableName(table);
  if (!realTable) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'This table is read-only and cannot be edited here' } },
      400,
    );
  }

  // `realTable` is a trusted allowlist literal (never the user string); `rowId` +
  // `siteId` are bound params. Double-scoping by site means a foreign rowId can
  // never be deleted even if guessed.
  const result = await c.env.DB.prepare(`DELETE FROM ${realTable} WHERE id = ? AND site_id = ?`)
    .bind(rowId, siteId)
    .run();

  const changes = Number(result.meta?.changes ?? 0);
  if (changes === 0) {
    // No row matched (already gone, or never belonged to this site) — 404, not a lie.
    return c.json({ error: { code: 'NOT_FOUND', message: 'Row not found' } }, 404);
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'site_data.row_deleted',
    message: `Deleted a row from ${table}`,
    target_type: table,
    target_id: rowId,
    metadata_json: { site_id: siteId, table, rows_affected: changes },
  });

  return c.json({ data: { id: rowId, deleted: true } });
});

/** Hard cap on one bulk-delete batch — bounds query cost + blast radius. */
const BULK_DELETE_CAP = 100;

/**
 * Bulk-delete up to {@link BULK_DELETE_CAP} of the site's own rows from a DELETABLE
 * overview table (currently `form_submissions` — clearing spam/test leads in one action).
 * Body: `{ ids: string[] }`.
 *
 * Same safety chain as the single-row delete — org auth (401) → {@link ownsSiteData}
 * (404) → {@link deletableTableName} trusted-literal table (read-only → 400) — plus:
 * the ids are deduped, validated as non-empty strings, and capped; the SQL is a
 * parameterized `id IN (?,?,…)` list (EVERY id is a bound param, never interpolated) AND
 * double-scoped by `site_id`, so a foreign/guessed id can never be deleted. Reports
 * honest partial results (`requested` vs `deleted` vs `skipped`) — ids that didn't match
 * a row for THIS site are silently skipped by the WHERE and surfaced in the count.
 */
siteDataApi.post('/api/sites/:siteId/data-overview/:table/bulk-delete', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const realTable = deletableTableName(table);
  if (!realTable) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'This table is read-only and cannot be edited here' } },
      400,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
  const rawIds = Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds || rawIds.length === 0) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Provide a non-empty "ids" array' } },
      400,
    );
  }
  // Dedupe + keep only non-empty strings (a hostile/blank id is dropped, never bound).
  const ids = [...new Set(rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (ids.length === 0) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'No valid row ids provided' } }, 400);
  }
  if (ids.length > BULK_DELETE_CAP) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: `Too many rows — delete at most ${BULK_DELETE_CAP} at a time`,
        },
      },
      400,
    );
  }

  // `realTable` is a trusted allowlist literal; every id is a bound `?` + the site scope.
  // Double-scoping by site means foreign ids can never be deleted even if guessed.
  const placeholders = ids.map(() => '?').join(', ');
  const result = await c.env.DB.prepare(
    `DELETE FROM ${realTable} WHERE id IN (${placeholders}) AND site_id = ?`,
  )
    .bind(...ids, siteId)
    .run();

  const deleted = Number(result.meta?.changes ?? 0);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'site_data.rows_bulk_deleted',
    message: `Bulk-deleted ${deleted} row${deleted === 1 ? '' : 's'} from ${table}`,
    target_type: table,
    target_id: siteId,
    metadata_json: { site_id: siteId, table, requested: ids.length, rows_affected: deleted },
  });

  // Honest partial-failure report: requested vs actually-deleted vs skipped.
  return c.json({ data: { requested: ids.length, deleted, skipped: ids.length - deleted } });
});

/**
 * Update ONE editable column of the site's own row in an EDITABLE overview table
 * (currently only `form_submissions.status` — retriage a lead). Body: `{ column, value }`.
 *
 * Safety chain mirrors the delete: org auth (401) → {@link ownsSiteData} tenant gate
 * (404) → {@link editableTableName} resolves a trusted literal table (read-only table
 * → 400) → {@link editableColumn} allowlists the column (non-editable → 400, so a
 * hostile column never reaches SQL) → {@link validateEditableValue} bounds the value
 * to the column's enum (invalid → 400) → parameterized `UPDATE … SET "col" = ? WHERE
 * id = ? AND site_id = ?` → `meta.changes === 0` → 404 → audit-logged. Reversible (a
 * status change), unlike the hard delete.
 */
siteDataApi.patch('/api/sites/:siteId/data-overview/:table/:rowId', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId, table, rowId } = c.req.param();
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const realTable = editableTableName(table);
  if (!realTable) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'This table is read-only and cannot be edited here' } },
      400,
    );
  }

  const body = (await c.req.json().catch(() => null)) as { column?: unknown; value?: unknown } | null;
  const column = typeof body?.column === 'string' ? body.column : '';
  const spec = editableColumn(table, column);
  if (!spec) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'This column is not editable' } }, 400);
  }
  const validated = validateEditableValue(spec, body?.value);
  if (!validated.ok) {
    return c.json({ error: { code: 'BAD_REQUEST', message: validated.reason } }, 400);
  }

  // `realTable` + `column` are trusted allowlist literals (quoted); the value, rowId,
  // and siteId are bound params. Double-scoped by site so a foreign row is untouchable.
  const result = await c.env.DB.prepare(
    `UPDATE ${realTable} SET "${column}" = ? WHERE id = ? AND site_id = ?`,
  )
    .bind(validated.value, rowId, siteId)
    .run();

  const changes = Number(result.meta?.changes ?? 0);
  if (changes === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Row not found' } }, 404);
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'site_data.row_updated',
    message: `Updated ${column} on a ${table} row`,
    target_type: table,
    target_id: rowId,
    metadata_json: { site_id: siteId, table, column, value: validated.value },
  });

  return c.json({ data: { id: rowId, column, value: validated.value, updated: true } });
});

/**
 * Recent data-management activity for the site — the owner's OWN mutations made from THIS
 * Data browser (row deletes + status edits), read from the append-only `audit_logs`.
 *
 * Read-only + org-scoped (`ownsSiteData` → 404) + site-scoped (the `site_id` the delete/edit
 * handlers set in `metadata_json`) + action-filtered to `site_data.*`, so application traffic
 * and unrelated audit events never leak in (console activity distinguished from app traffic).
 * The raw `metadata_json` (which may carry a column value) is NEVER returned — only the safe
 * human `message` + table + timestamp + actor — so no sensitive parameter value is exposed.
 * Fail-soft: any query error yields an empty list, never a 500.
 *
 * NOTE the path is `/data-activity`, NOT `/data-overview/activity` — the latter would be
 * shadowed by the `/data-overview/:table` browse route (`:table` = "activity").
 */
siteDataApi.get('/api/sites/:siteId/data-activity', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const siteId = c.req.param('siteId');
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  let events: Array<{ action: string; table: string; message: string; actor: string | null; at: string }> = [];
  try {
    // `org_id` is indexed (idx_audit_logs_org); the action allowlist + LIMIT bound the scan.
    // `json_extract($.site_id)` scopes to THIS site (the delete/edit handlers set it); siteId
    // is a bound param, never interpolated.
    const res = await c.env.DB.prepare(
      `SELECT created_at, actor_id, action, target_type, message
         FROM audit_logs
        WHERE org_id = ?
          AND action IN ('site_data.row_deleted', 'site_data.row_updated', 'site_data.rows_bulk_deleted')
          AND json_extract(metadata_json, '$.site_id') = ?
        ORDER BY created_at DESC
        LIMIT 50`,
    )
      .bind(orgId, siteId)
      .all<{
        created_at: string;
        actor_id: string | null;
        action: string;
        target_type: string | null;
        message: string | null;
      }>();
    events = (res.results || []).map((r) => ({
      action: r.action,
      table: r.target_type ?? '',
      message: r.message ?? r.action,
      actor: r.actor_id,
      at: r.created_at,
    }));
  } catch {
    events = []; // fail-soft — a missing audit table / query error → empty, never 500
  }

  return c.json({ data: { events } });
});
