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
 * `site_id`. This surface reads AND WRITES the customer's OWN dedicated D1 (blank at first) — never
 * the shared DB, never another site's DB (`resolveSiteDataDb` server-resolves the id + denylists the
 * shared platform ids). P1 (this slice) ships the full grid/console CRUD; typed undo / Time-Travel
 * snapshots / ERD land in later slices.
 *
 * | Method | Path                                                | Auth  | Purpose                                        |
 * | ------ | --------------------------------------------------- | ----- | ---------------------------------------------- |
 * | GET    | /api/sites/:siteId/db/tables                        | orgId | List the site's OWN tables (lazy-provision)    |
 * | GET    | /api/sites/:siteId/db/tables/:table                 | orgId | Browse one table's rows (paginated; `_rowid`)  |
 * | POST   | /api/sites/:siteId/db/tables                        | orgId | Create a table (manual: name + typed columns)  |
 * | DELETE | /api/sites/:siteId/db/tables/:table                 | orgId | Drop a table                                   |
 * | POST   | /api/sites/:siteId/db/tables/:table/rows            | orgId | Insert one row                                 |
 * | PATCH  | /api/sites/:siteId/db/tables/:table/rows/:rowid     | orgId | Update one row (by `_rowid`)                   |
 * | DELETE | /api/sites/:siteId/db/tables/:table/rows/:rowid     | orgId | Delete one row (by `_rowid`)                   |
 * | POST   | /api/sites/:siteId/db/tables/:table/columns         | orgId | Add one (nullable) column                      |
 * | PATCH  | /api/sites/:siteId/db/tables/:table/columns/:column | orgId | Rename a column                                |
 * | DELETE | /api/sites/:siteId/db/tables/:table/columns/:column | orgId | Drop a column                                  |
 * | POST   | /api/sites/:siteId/db/sample-data                   | orgId | Seed 3 related sample tables (non-destructive) |
 * | POST   | /api/sites/:siteId/db/ai-seed                       | orgId | AI-generate rows for a table / CREATE from prompt |
 * | POST   | /api/sites/:siteId/db/query                         | orgId | Raw single-statement SQL console (row-capped)  |
 * | GET    | /api/sites/:siteId/build-files                      | orgId | List the site's published R2 build files       |
 *
 * Every route: (1) 401 if unauthenticated; (2) **404 (dark) when the `per_site_data` flag is off** —
 * per `feature-flags` never 403, never leak existence; (3) `ownsSiteData` IDOR guard (404 on a
 * foreign/missing site); (4) then and only then resolves the per-site D1. Table + column names are
 * validated against `isSafeIdent` (D1 REST cannot bind an identifier) and confirmed to exist before
 * mutating; every value is bound, never interpolated; rows are targeted by their stable `rowid`.
 *
 * The `sample-data` + `ai-seed` WRITE routes execute through the SAME per-site executor
 * (`resolveSiteDataDb`) — the write plane was already live (the D1 REST `/query` endpoint is
 * read-or-write); these routes just wire the two owner-facing "populate my blank DB" actions to it,
 * parameterized + isolated + FORBIDDEN_DB_IDS-guarded like every other per-site query.
 *
 * @packageDocumentation
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { dbQueryOne } from '../../../src/services/db.js';
import {
  buildAddColumnSql,
  buildCreateTableSql,
  buildDropColumnSql,
  buildInsertRowSql,
  buildRenameColumnSql,
  buildUpdateRowSql,
  createSampleData,
  insertSeedRows,
  introspectColumns,
  isSafeIdent,
  listSiteTables,
  quoteIdent,
  resolveSiteDataDb,
  type ResolveSiteDataDbResult,
  type SiteDataD1,
  SiteDataD1Error,
  type SiteTableColumn,
} from '../../../src/services/site_data_db.js';

import { ownsSiteData } from './handlers.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteDbApi = new Hono<AppContext>();

/** The flag gating the entire per-site data platform (default-off / DARK). */
const FLAG = 'per_site_data';

/** Workers AI model used to generate seed rows / table plans (Cloudflare-first, zero per-token bill). */
const AI_SEED_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/** Body for `POST /db/ai-seed`: EITHER seed an existing `table`, OR CREATE one from a `prompt`. */
const AiSeedBodySchema = z
  .object({
    /** Existing table to seed (validated against the live table list + isSafeIdent). */
    table: z.string().max(64).optional(),
    /** Free-form instruction — the theme of the rows, or (with no `table`) the new table to build. */
    prompt: z.string().max(2000).optional(),
    /** How many rows to generate (clamped 1–50, default 12). */
    rowCount: z.number().int().optional(),
  })
  .strict();

/** Clamp an AI-seed rowCount into `[1, 50]` (default 12). */
function clampSeedRowCount(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 12;
  return Math.min(Math.max(Math.trunc(raw), 1), 50);
}

/** Pull the first balanced JSON value ({…} or […]) out of an LLM response. */
function extractFirstJson(text: string): unknown {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1]! : text).trim();
  const startObj = candidate.indexOf('{');
  const startArr = candidate.indexOf('[');
  const start =
    startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startObj, startArr);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Normalise whatever JSON the model returned into an array of row objects (`{rows:[…]}` or `[…]`). */
function coerceRowArray(json: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { rows?: unknown }).rows)
      ? (json as { rows: unknown[] }).rows
      : [];
  return arr.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
  );
}

/**
 * Ask Workers AI for `rowCount` rows matching `columns` (+ optional `prompt` theme). Returns
 * validated row objects (never throws — an unparseable/empty response yields `[]` so the route can
 * report an honest "AI returned no rows" rather than a 500). Mirrors the JSON-extraction discipline
 * in `ai_admin_features.ts`.
 */
async function generateSeedRows(
  env: Env,
  columns: SiteTableColumn[],
  rowCount: number,
  prompt: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  const colDesc = columns
    .filter((c) => c.pk !== 1)
    .map((c) => `${c.name} (${c.type || 'TEXT'})`)
    .join(', ');
  const system =
    'You generate realistic sample data for a SQL table. Output STRICT JSON: an array of ' +
    `${rowCount} row objects. Each object has EXACTLY these keys: ${colDesc}. ` +
    'Use realistic, varied values matching each column type (ISO dates for date/text time columns, ' +
    'numbers for INTEGER/REAL). Do NOT include an id/primary-key field. Output JSON only, no prose.';
  const user = prompt?.trim()
    ? `Theme for the data: ${prompt.trim()}`
    : 'Generate a realistic, varied spread of rows.';
  try {
    const result = (await env.AI.run(AI_SEED_MODEL as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    } as Parameters<Ai['run']>[1])) as { response?: string };
    const raw = typeof result?.response === 'string' ? result.response : '';
    return coerceRowArray(extractFirstJson(raw)).slice(0, rowCount);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'ai_seed_generation_failed',
        service: 'site_db_handlers',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

/** Ask Workers AI to design a table (name + columns) from a bare prompt. Returns null on failure. */
async function generateTablePlan(
  env: Env,
  prompt: string,
): Promise<{ table: string; columns: Array<{ name: string; type: string; notnull?: boolean }> } | null> {
  const system =
    'Design a SQLite table for the user request. Output STRICT JSON: ' +
    '{ "table": "<snake_case name, letters/digits/underscore, starts with a letter>", ' +
    '"columns": [ { "name": "<snake_case>", "type": "TEXT"|"INTEGER"|"REAL", "notnull": true|false } ] }. ' +
    'Do NOT include an id column (it is added automatically). 3-8 columns. Output JSON only, no prose.';
  try {
    const result = (await env.AI.run(AI_SEED_MODEL as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt.trim() },
      ],
    } as Parameters<Ai['run']>[1])) as { response?: string };
    const raw = typeof result?.response === 'string' ? result.response : '';
    const json = extractFirstJson(raw) as
      | { table?: unknown; columns?: unknown }
      | null;
    if (!json || typeof json.table !== 'string' || !Array.isArray(json.columns)) return null;
    const columns = json.columns
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        name: String(c.name ?? ''),
        type: String(c.type ?? 'TEXT'),
        notnull: c.notnull === true,
      }));
    return { columns, table: json.table };
  } catch {
    return null;
  }
}

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
      // `_rowid` is the stable per-row key the grid targets for inline edit + delete (rows may have
      // no user-facing PK). The pragma `columns` list below does NOT include it, so the grid renders
      // only real columns and keeps `_rowid` as a hidden handle.
      resolved.db.query(`SELECT rowid AS _rowid, * FROM ${q} LIMIT ? OFFSET ?`, [limit, offset]),
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

/**
 * Run the shared 4-step gate (auth → flag-dark-404 → ownership-404 → resolve) and return the
 * resolved per-site executor, OR a Response the caller should return verbatim. Collapses the
 * boilerplate the two WRITE routes + build-files share. Returns `{ db }` on success.
 */
async function gateAndResolve(
  c: Context<AppContext>,
  siteId: string,
): Promise<{ db: SiteDataD1 } | Response> {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Per-site data is not enabled' } }, 404);
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  const resolved = await resolveSiteDataDb(c.env, siteId, { orgId });
  if (!resolved.ok) return resolveFailure(c, siteId, resolved.reason);
  return { db: resolved.db };
}

/**
 * POST — seed the site's OWN blank D1 with three RELATED sample tables (`customers`/`products`/
 * `orders`). Non-destructive + idempotent: a table that already has rows is skipped, not clobbered.
 * The whole point of the Data tab's "Load sample data" empty-state button.
 */
siteDbApi.post('/api/sites/:siteId/db/sample-data', async (c) => {
  const { siteId } = c.req.param();
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;

  try {
    const result = await createSampleData(gate.db);
    return c.json({
      data: { rowCounts: result.rowCounts, skipped: result.skipped, tables: result.tables },
      ok: true,
    });
  } catch (err) {
    if (err instanceof SiteDataD1Error)
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: 'Could not seed sample data.' }, ok: false },
        502,
      );
    throw err;
  }
});

/**
 * POST — AI-seed rows. Two modes:
 *  - `{ table }` (existing): introspect its columns, ask Workers AI for `rowCount` matching rows,
 *    INSERT them parameterized (real columns only), return a preview.
 *  - `{ prompt }` (no `table`, or a `table` that doesn't exist yet): ask the model to DESIGN a table,
 *    CREATE it (safe identifiers + clamped types), then seed it.
 * Every value is bound, never interpolated; the AI can never inject a column or an identifier.
 */
siteDbApi.post('/api/sites/:siteId/db/ai-seed', async (c) => {
  const { siteId } = c.req.param();
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;
  const { db } = gate;

  const parsed = AiSeedBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid seed request' }, ok: false }, 400);
  const { table: rawTable, prompt } = parsed.data;
  const rowCount = clampSeedRowCount(parsed.data.rowCount);

  if (rawTable !== undefined && !isSafeIdent(rawTable))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid table name' }, ok: false }, 400);

  try {
    const existingTables = await listSiteTables(db);
    let table = rawTable;
    let createdTable = false;

    // Mode B: no existing target → the prompt must DESIGN + CREATE a table first.
    if (!table || !existingTables.includes(table)) {
      if (!prompt?.trim())
        return c.json(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Provide an existing table, or a prompt describing a new one.',
            },
            ok: false,
          },
          400,
        );
      const plan = await generateTablePlan(c.env, prompt);
      const built = plan ? buildCreateTableSql(plan) : null;
      if (!built)
        return c.json(
          { error: { code: 'AI_GENERATION_ERROR', message: 'The AI could not design a table.' }, ok: false },
          502,
        );
      // If the caller named a table that doesn't exist, honor a valid name over the AI's guess.
      if (rawTable && isSafeIdent(rawTable)) {
        const overridden = buildCreateTableSql({ columns: plan!.columns, table: rawTable });
        if (overridden) {
          await db.query(overridden.sql);
          table = rawTable;
        } else {
          await db.query(built.sql);
          table = built.table;
        }
      } else {
        await db.query(built.sql);
        table = built.table;
      }
      createdTable = true;
    }

    const columns = await introspectColumns(db, table);
    if (columns.length === 0)
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: 'Target table has no columns.' }, ok: false },
        502,
      );

    const rows = await generateSeedRows(c.env, columns, rowCount, prompt);
    if (rows.length === 0)
      return c.json(
        {
          data: { createdTable, inserted: 0, previewRows: [], table },
          error: { code: 'AI_GENERATION_ERROR', message: 'The AI returned no rows.' },
          ok: false,
        },
        502,
      );

    const { inserted } = await insertSeedRows(db, table, columns, rows);

    // Preview the freshly-inserted tail (parameterized limit).
    const preview = await db.query(
      `SELECT * FROM ${quoteIdent(table)} ORDER BY ROWID DESC LIMIT ?`,
      [Math.min(inserted, 10)],
    );

    return c.json({
      data: { createdTable, inserted, previewRows: preview.results, table },
      ok: true,
    });
  } catch (err) {
    if (err instanceof SiteDataD1Error)
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: 'Could not seed the table.' }, ok: false },
        502,
      );
    throw err;
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P1 grid/console CRUD — structured mutations + a raw SQL console, all through the SAME per-site
// executor (`gateAndResolve` → `resolveSiteDataDb`), so every write is org-owned, flag-dark-404'd,
// FORBIDDEN_DB_IDS-guarded, and identifier-safe. The D1 REST `/query` plane is single-statement
// read-OR-write, so no new transport is needed — only safe SQL builders + the gate.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Body for `POST /db/tables` — a manually-defined table (name + typed columns). */
const CreateTableBodySchema = z
  .object({
    table: z.string().min(1).max(64),
    columns: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            type: z.string().max(16).optional(),
            notnull: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

/** Body for row insert/update — a column→value map (unknown keys are dropped by the SQL builder). */
const RowValuesBodySchema = z.object({ values: z.record(z.string(), z.unknown()) }).strict();

/** Body for `POST /db/tables/:table/columns` — one new (nullable) column. */
const AddColumnBodySchema = z
  .object({ name: z.string().min(1).max(64), type: z.string().max(16).optional() })
  .strict();

/** Body for `PATCH /db/tables/:table/columns/:column` — the new column name. */
const RenameColumnBodySchema = z.object({ name: z.string().min(1).max(64) }).strict();

/** Body for the raw SQL console — one statement + optional bound params (primitives only). */
const RawQueryBodySchema = z
  .object({
    sql: z.string().min(1).max(10_000),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).optional(),
  })
  .strict();

/** Cap the rows a single console query streams back to the client (payload safety). */
const MAX_CONSOLE_ROWS = 500;

/** Uniform 502 for a per-site D1 error (the DB itself failed, not the request). */
function dataStoreError(c: Context<AppContext>, message: string) {
  return c.json({ error: { code: 'DATA_STORE_ERROR', message }, ok: false }, 502);
}

/**
 * Extend {@link gateAndResolve} with a table check: validate `table` against {@link isSafeIdent}
 * (D1 REST cannot bind an identifier), confirm it exists in THIS site's DB (clean 404, never a raw
 * SQL error), and return the executor + the live column set (so row/column mutators don't
 * re-introspect). Returns a `Response` the caller returns verbatim on any gate/validation failure.
 * DB reads here can throw {@link SiteDataD1Error}; callers wrap the call in try/catch → 502.
 */
async function gateResolveAndRequireTable(
  c: Context<AppContext>,
  siteId: string,
  table: string,
): Promise<{ db: SiteDataD1; columns: SiteTableColumn[] } | Response> {
  if (!isSafeIdent(table))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid table name' }, ok: false }, 400);
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;
  const tables = await listSiteTables(gate.db);
  if (!tables.includes(table))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Table not found' }, ok: false }, 404);
  const columns = await introspectColumns(gate.db, table);
  return { columns, db: gate.db };
}

/** POST — create a table from a manual definition (name + typed columns). 409 if it already exists. */
siteDbApi.post('/api/sites/:siteId/db/tables', async (c) => {
  const { siteId } = c.req.param();
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;

  const parsed = CreateTableBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid table definition' }, ok: false }, 400);

  const built = buildCreateTableSql({
    columns: parsed.data.columns.map((col) => ({
      name: col.name,
      notnull: col.notnull,
      type: col.type ?? 'TEXT',
    })),
    table: parsed.data.table,
  });
  if (!built)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid table or column name' }, ok: false }, 400);

  try {
    if ((await listSiteTables(gate.db)).includes(built.table))
      return c.json({ error: { code: 'CONFLICT', message: 'A table with that name already exists' }, ok: false }, 409);
    await gate.db.query(built.sql);
    return c.json(
      { data: { columns: await introspectColumns(gate.db, built.table), table: built.table }, ok: true },
      201,
    );
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not create the table.');
    throw err;
  }
});

/** DELETE — drop a table (destructive; the UI gates this behind type-to-confirm). */
siteDbApi.delete('/api/sites/:siteId/db/tables/:table', async (c) => {
  const { siteId, table } = c.req.param();
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    await gate.db.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    return c.json({ data: { dropped: true, table }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not drop the table.');
    throw err;
  }
});

/** POST — insert one row (only real, non-PK columns from the payload are written). */
siteDbApi.post('/api/sites/:siteId/db/tables/:table/rows', async (c) => {
  const { siteId, table } = c.req.param();
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    const parsed = RowValuesBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid row payload' }, ok: false }, 400);
    const built = buildInsertRowSql(table, gate.columns, parsed.data.values);
    if (!built)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'No writable columns in payload' }, ok: false }, 400);
    const res = await gate.db.query(built.sql, built.params);
    return c.json({ data: { inserted: Number(res.meta.rows_written ?? 0) || 1, table }, ok: true }, 201);
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not insert the row.');
    throw err;
  }
});

/** PATCH — update one row by its stable SQLite `rowid` (the `_rowid` the browse surface exposes). */
siteDbApi.patch('/api/sites/:siteId/db/tables/:table/rows/:rowid', async (c) => {
  const { siteId, table, rowid } = c.req.param();
  const rowidNum = Number.parseInt(rowid, 10);
  if (!Number.isInteger(rowidNum))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid row id' }, ok: false }, 400);
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    const parsed = RowValuesBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid row payload' }, ok: false }, 400);
    const built = buildUpdateRowSql(table, gate.columns, parsed.data.values, rowidNum);
    if (!built)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'No writable columns in payload' }, ok: false }, 400);
    const res = await gate.db.query(built.sql, built.params);
    return c.json({ data: { table, updated: Number(res.meta.rows_written ?? 0) }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not update the row.');
    throw err;
  }
});

/** DELETE — remove one row by its stable SQLite `rowid`. */
siteDbApi.delete('/api/sites/:siteId/db/tables/:table/rows/:rowid', async (c) => {
  const { siteId, table, rowid } = c.req.param();
  const rowidNum = Number.parseInt(rowid, 10);
  if (!Number.isInteger(rowidNum))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid row id' }, ok: false }, 400);
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    const res = await gate.db.query(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`, [rowidNum]);
    return c.json({ data: { deleted: Number(res.meta.rows_written ?? 0), table }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not delete the row.');
    throw err;
  }
});

/** POST — add one (nullable) column to a table. 409 if the column already exists. */
siteDbApi.post('/api/sites/:siteId/db/tables/:table/columns', async (c) => {
  const { siteId, table } = c.req.param();
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    const parsed = AddColumnBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column definition' }, ok: false }, 400);
    if (gate.columns.some((col) => col.name === parsed.data.name))
      return c.json({ error: { code: 'CONFLICT', message: 'A column with that name already exists' }, ok: false }, 409);
    const sql = buildAddColumnSql(table, parsed.data.name, parsed.data.type ?? 'TEXT');
    if (!sql)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
    await gate.db.query(sql);
    return c.json({ data: { columns: await introspectColumns(gate.db, table), table }, ok: true }, 201);
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not add the column.');
    throw err;
  }
});

/** PATCH — rename a column. */
siteDbApi.patch('/api/sites/:siteId/db/tables/:table/columns/:column', async (c) => {
  const { siteId, table, column } = c.req.param();
  if (!isSafeIdent(column))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    if (!gate.columns.some((col) => col.name === column))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Column not found' }, ok: false }, 404);
    const parsed = RenameColumnBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
    if (gate.columns.some((col) => col.name === parsed.data.name))
      return c.json({ error: { code: 'CONFLICT', message: 'A column with that name already exists' }, ok: false }, 409);
    const sql = buildRenameColumnSql(table, column, parsed.data.name);
    if (!sql)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
    await gate.db.query(sql);
    return c.json({ data: { columns: await introspectColumns(gate.db, table), table }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not rename the column.');
    throw err;
  }
});

/** DELETE — drop a column (SQLite refuses to drop a PK / last / indexed column → surfaces as 502). */
siteDbApi.delete('/api/sites/:siteId/db/tables/:table/columns/:column', async (c) => {
  const { siteId, table, column } = c.req.param();
  if (!isSafeIdent(column))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
  try {
    const gate = await gateResolveAndRequireTable(c, siteId, table);
    if (gate instanceof Response) return gate;
    if (!gate.columns.some((col) => col.name === column))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Column not found' }, ok: false }, 404);
    const sql = buildDropColumnSql(table, column);
    if (!sql)
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid column name' }, ok: false }, 400);
    await gate.db.query(sql);
    return c.json({ data: { columns: await introspectColumns(gate.db, table), table }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Could not drop the column.');
    throw err;
  }
});

/**
 * POST — the raw SQL console. Runs ONE statement against the site's OWN isolated D1 (never shared,
 * FORBIDDEN_DB_IDS-guarded upstream), so arbitrary SQL only ever touches the owner's own data. Rows
 * are capped at {@link MAX_CONSOLE_ROWS}; a SQL error is surfaced verbatim (400) because seeing the
 * real error IS the point of a console.
 */
siteDbApi.post('/api/sites/:siteId/db/query', async (c) => {
  const { siteId } = c.req.param();
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;
  const parsed = RawQueryBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid query' }, ok: false }, 400);
  try {
    const res = await gate.db.query(parsed.data.sql, parsed.data.params ?? []);
    return c.json({
      data: {
        meta: res.meta,
        rowCount: res.results.length,
        rows: res.results.slice(0, MAX_CONSOLE_ROWS),
        truncated: res.results.length > MAX_CONSOLE_ROWS,
      },
      ok: true,
    });
  } catch (err) {
    if (err instanceof SiteDataD1Error)
      return c.json({ error: { code: 'SQL_ERROR', message: err.message }, ok: false }, 400);
    throw err;
  }
});

/** Body for the cross-table content search — one query string + an optional total-hit cap. */
const SearchBodySchema = z
  .object({ q: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() })
  .strict();

/** Escape LIKE wildcards so a user's `%` / `_` / `\` are matched literally (paired with `ESCAPE '\'`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * POST — ADVANCED cross-table search over the site's OWN isolated D1. Matches BOTH (a) table NAMES that
 * contain `q`, and (b) CONTENT: scans each user table's text-ish columns with a wildcard-escaped `LIKE`
 * and returns the table + column + stable `rowid` + a short surrounding snippet per hit — so the UI can
 * show a "matched inside <table>" result distinct from a table-name match. Read-only, org-owned + flag-dark
 * upstream (`gateAndResolve`); bounded (per-table + total caps) so a large DB stays fast.
 */
siteDbApi.post('/api/sites/:siteId/db/search', async (c) => {
  const { siteId } = c.req.param();
  const gate = await gateAndResolve(c, siteId);
  if (gate instanceof Response) return gate;

  const parsed = SearchBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid search' }, ok: false }, 400);

  const q = parsed.data.q.trim();
  const limit = parsed.data.limit ?? 50;
  const like = `%${escapeLike(q)}%`;
  const qLower = q.toLowerCase();

  /** Caps that keep the scan fast on a big DB (customer per-site DBs are small, but never unbounded). */
  const MAX_TABLES = 40;
  const PER_TABLE = 5;

  try {
    const tables = await listSiteTables(gate.db); // already hides sqlite_*/_cf_*/d1_migrations
    const nameMatches = tables.filter((t) => t.toLowerCase().includes(qLower)).slice(0, 25);

    const contentMatches: Array<{ table: string; column: string; rowid: number; snippet: string }> = [];
    let truncated = false;

    for (const table of tables.slice(0, MAX_TABLES)) {
      if (contentMatches.length >= limit) {
        truncated = true;
        break;
      }

      let textCols: string[];
      try {
        const columns = await introspectColumns(gate.db, table);
        textCols = columns
          .filter((col) => isSafeIdent(col.name))
          .filter((col) => {
            const t = (col.type || '').toUpperCase();
            return t === '' || /CHAR|CLOB|TEXT|VARCHAR/.test(t); // text-ish only (skip numeric/blob)
          })
          .map((col) => col.name);
      } catch {
        continue; // a table we can't introspect is skipped, never fails the whole search
      }

      if (textCols.length === 0) {
        continue;
      }

      const where = textCols.map((col) => `${quoteIdent(col)} LIKE ? ESCAPE '\\'`).join(' OR ');
      let rows: Record<string, unknown>[];
      try {
        rows = (
          await gate.db.query<Record<string, unknown>>(
            `SELECT rowid AS _rowid, * FROM ${quoteIdent(table)} WHERE ${where} LIMIT ?`,
            [...textCols.map(() => like), PER_TABLE],
          )
        ).results;
      } catch {
        continue;
      }

      for (const row of rows) {
        if (contentMatches.length >= limit) {
          truncated = true;
          break;
        }

        const hitCol = textCols.find((col) => String(row[col] ?? '').toLowerCase().includes(qLower)) ?? textCols[0];
        const raw = String(row[hitCol] ?? '');
        const idx = raw.toLowerCase().indexOf(qLower);
        const start = Math.max(0, idx - 24);
        const end = idx + q.length + 40;
        const snippet = `${start > 0 ? '…' : ''}${raw.slice(start, end)}${raw.length > end ? '…' : ''}`;
        contentMatches.push({ column: hitCol, rowid: Number(row._rowid) || 0, snippet, table });
      }
    }

    return c.json({ data: { contentMatches, nameMatches, query: q, truncated }, ok: true });
  } catch (err) {
    if (err instanceof SiteDataD1Error) return dataStoreError(c, 'Search could not run.');
    throw err;
  }
});

/**
 * GET — list the site's PUBLISHED R2 build files under `sites/{slug}/{version}/*` (the whole site,
 * not just `/assets/*` which `GET /api/sites/:id/build-assets` already lists). The version resolves
 * from `?version=` (validated, never a path traversal) or, when omitted, the current pointer in
 * `sites/{slug}/_manifest.json` (falling back to the site's `current_build_version` column).
 *
 * Read-only + org-owned + flag-gated like every per-site surface. Skips `_meta/*` internals so the
 * list is the real deliverable. Returns `{ files, totalSize, version }`.
 */
siteDbApi.get('/api/sites/:siteId/build-files', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId)
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  const { siteId } = c.req.param();

  if (!(await isFlagOn(c.env, FLAG, { orgId, siteId })))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Per-site data is not enabled' } }, 404);

  // Ownership + slug in one query (the R2 prefix needs the slug).
  const site = await dbQueryOne<{ slug: string; current_build_version: string | null }>(
    c.env.DB,
    'SELECT slug, current_build_version FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
    [siteId, orgId],
  );
  if (!site) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  // Resolve the version: explicit query param (validated) → manifest pointer → the D1 column.
  const rawVersion = c.req.query('version');
  let version: string | null = null;
  if (typeof rawVersion === 'string' && rawVersion) {
    // A version is an R2 path segment — reject anything that could escape the prefix.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(rawVersion))
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid version' } }, 400);
    version = rawVersion;
  } else {
    try {
      const manifest = await c.env.SITES_BUCKET.get(`sites/${site.slug}/_manifest.json`);
      if (manifest) {
        const data = (await manifest.json()) as { current_version?: string };
        if (typeof data.current_version === 'string' && data.current_version)
          version = data.current_version;
      }
    } catch {
      /* fall through to the D1 column */
    }
    if (!version) version = site.current_build_version;
  }

  if (!version)
    return c.json({ data: { files: [], totalSize: 0, version: null }, ok: true });

  const prefix = `sites/${site.slug}/${version}/`;
  const listed = await c.env.SITES_BUCKET.list({ limit: 1000, prefix });
  const files = listed.objects
    .filter((obj) => !obj.key.includes('/_meta/'))
    .map((obj) => {
      const rel = obj.key.slice(prefix.length);
      return {
        key: obj.key,
        name: rel || obj.key.split('/').pop() || obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
        url: `https://${site.slug}.projectsites.dev/${rel}`,
      };
    });
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return c.json({ data: { files, totalSize, version }, ok: true });
});
