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
 * | POST   | /api/sites/:siteId/db/sample-data           | orgId | Seed 3 related sample tables (non-destructive) |
 * | POST   | /api/sites/:siteId/db/ai-seed               | orgId | AI-generate rows for a table / CREATE from prompt |
 * | GET    | /api/sites/:siteId/build-files              | orgId | List the site's published R2 build files    |
 *
 * Every route: (1) 401 if unauthenticated; (2) **404 (dark) when the `per_site_data` flag is off** —
 * per `feature-flags` never 403, never leak existence; (3) `ownsSiteData` IDOR guard (404 on a
 * foreign/missing site); (4) then and only then resolves the per-site D1. Table names are validated
 * against `isSafeIdent` (D1 REST cannot bind an identifier) and confirmed to exist before browsing.
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
  buildCreateTableSql,
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
