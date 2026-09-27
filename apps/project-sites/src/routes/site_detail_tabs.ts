/**
 * Per-project tab endpoints for `/admin/sites/:id`.
 *
 * Closes TEST-PLAN.md TAB-01..TAB-13 by exposing:
 *
 *   GET    /api/sites/:siteId/logs/tail                  — polled live tail
 *   POST   /api/sites/:siteId/snapshots/:snapId/rollback — promote snapshot to current
 *   POST   /api/sites/:siteId/sql/exec                   — read-only D1 console
 *   GET    /api/sites/:siteId/integration-providers      — per-site MCP providers
 *   DELETE /api/sites/:siteId/integration-providers/:key — disconnect MCP provider
 *
 * Auth-required, org-scoped via the existing `authMiddleware` on `/api/*`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { internalError } from '@project-sites/shared';
import { dbQuery, dbQueryOne, dbExecute } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';
import { isSuperAdmin } from '../services/sysadmin.js';

const tabs = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/logs/tail
// Returns the latest 200 log rows for the site (audit + workflow_jobs union).
// Angular client polls every 3s; native WS upgrade is a future step.
// ─────────────────────────────────────────────────────────────────────────────
tabs.get('/api/sites/:siteId/logs/tail', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  const rows = await dbQuery<{
    created_at: string;
    actor_id: string | null;
    action: string;
    target_id: string | null;
    message: string | null;
    metadata_json: string | null;
  }>(
    c.env.DB,
    `SELECT created_at, actor_id, action, target_id, message, metadata_json
       FROM audit_logs
      WHERE org_id = ?1 AND target_id = ?2
      ORDER BY created_at DESC
      LIMIT 200`,
    [orgId, siteId],
  );

  const logs = (rows.data ?? []).map((r) => ({
    ts: r.created_at,
    level: r.action.includes('error') ? 'error' : r.action.includes('warn') ? 'warn' : 'info',
    source: r.actor_id ?? 'system',
    message: r.message ?? r.action,
  }));

  return c.json({ logs });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/snapshots/:snapshotId/rollback
// Promote the named snapshot to the live serving slot + write audit row.
// ─────────────────────────────────────────────────────────────────────────────
tabs.post('/api/sites/:siteId/snapshots/:snapshotId/rollback', async (c) => {
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  const snap = await dbQueryOne<{ id: string; snapshot_name: string }>(
    c.env.DB,
    `SELECT id, snapshot_name
       FROM site_snapshots
      WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL`,
    [snapshotId, siteId],
  );
  if (!snap) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  // The actual R2 path copy + KV invalidation happens in the deploy worker
  // (see site_serving.ts). Here we record the intent + bump the site's
  // updated_at so polling clients see the change.
  const { error: rollbackErr } = await dbExecute(
    c.env.DB,
    `UPDATE sites SET updated_at = datetime('now') WHERE id = ?1 AND org_id = ?2`,
    [siteId, orgId],
  );
  // Pre-guarded (snapshot loaded + org-scoped WHERE) — surface a DB failure instead
  // of a lying "rollback recorded" that polling clients would act on.
  if (rollbackErr) throw internalError(`Failed to record rollback: ${rollbackErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.snapshot.rollback',
    target_type: 'site',
    target_id: siteId,
    message: `Rolled back to ${snap.snapshot_name}`,
    metadata_json: { snapshot_id: snap.id, snapshot_name: snap.snapshot_name },
  });

  return c.json({ ok: true, snapshot_name: snap.snapshot_name });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/sites/:siteId/snapshots/:snapshotId
// Rename a snapshot and/or set its description. `snapshots.component.ts`'s create
// dialog dropped the user-facing description field (auto-generated) and DOCUMENTS
// this endpoint as the operator escape-hatch ("Operators who need a custom note can
// still PATCH the row via the API `PATCH /sites/:id/snapshots/:snapId`") — but the
// route did not exist and returned 404, a documented-but-dead capability. This makes
// it real. Org-scoped (IDOR guard on the site); UNIQUE(site_id, snapshot_name)
// collision → clean 409 (never a swallowed 500); at least one field required.
// ─────────────────────────────────────────────────────────────────────────────
const PatchSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(240).optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined, {
    message: 'name or description required',
  });

tabs.patch('/api/sites/:siteId/snapshots/:snapshotId', async (c) => {
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  const parsed = PatchSnapshotSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name or description required' } }, 400);
  }
  const { name, description } = parsed.data;

  // IDOR guard: the site must belong to the caller's org before we touch its rows.
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  const snap = await dbQueryOne<{ id: string; snapshot_name: string }>(
    c.env.DB,
    `SELECT id, snapshot_name FROM site_snapshots
      WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL`,
    [snapshotId, siteId],
  );
  if (!snap) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  // Pre-check UNIQUE(site_id, snapshot_name) so a rename collision is a clean 409,
  // not a swallowed SQL error surfaced as a generic 500.
  if (name && name !== snap.snapshot_name) {
    const clash = await dbQueryOne<{ id: string }>(
      c.env.DB,
      `SELECT id FROM site_snapshots
        WHERE site_id = ?1 AND snapshot_name = ?2 AND id != ?3 AND deleted_at IS NULL`,
      [siteId, name, snapshotId],
    );
    if (clash) {
      return c.json(
        { error: { code: 'CONFLICT', message: `A snapshot named "${name}" already exists` } },
        409,
      );
    }
  }

  const { error: updErr } = await dbExecute(
    c.env.DB,
    `UPDATE site_snapshots
        SET snapshot_name = COALESCE(?1, snapshot_name),
            description   = COALESCE(?2, description),
            updated_at    = datetime('now')
      WHERE id = ?3 AND site_id = ?4`,
    [name ?? null, description ?? null, snapshotId, siteId],
  );
  if (updErr) throw internalError(`Failed to update snapshot: ${updErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.snapshot.updated',
    target_type: 'site',
    target_id: siteId,
    message: `Snapshot '${snap.snapshot_name}' updated${name && name !== snap.snapshot_name ? ` → '${name}'` : ''}`,
    metadata_json: {
      snapshot_id: snapshotId,
      renamed: !!(name && name !== snap.snapshot_name),
      described: description !== undefined,
    },
  });

  // Re-read so the response reflects exactly what persisted (never a lying echo).
  const updated = await dbQueryOne<{
    id: string;
    snapshot_name: string;
    description: string | null;
  }>(
    c.env.DB,
    `SELECT id, snapshot_name, description FROM site_snapshots WHERE id = ?1 AND site_id = ?2`,
    [snapshotId, siteId],
  );
  return c.json({ data: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/sql/exec
// Read-only D1 console. Rejects DDL/DML; allowlist: SELECT, EXPLAIN, WITH, PRAGMA.
// ─────────────────────────────────────────────────────────────────────────────
const SqlExecSchema = z.object({
  query: z.string().min(1).max(8_000),
  // Positional bind params for ?1, ?2, … — values are BOUND, never concatenated into the
  // SQL (the epic's "parameterize values, never concatenate" mandate). Booleans are coerced
  // to 0/1 at bind time (SQLite has no native boolean). Capped at 50 to bound abuse.
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .max(50)
    .optional(),
});

const READONLY_PREFIX = /^\s*(SELECT|EXPLAIN|WITH|PRAGMA)\b/i;
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|VACUUM|REPLACE|TRUNCATE)\b/i;

/**
 * Serialize ONE D1 result cell for JSON transport. A BLOB comes back from D1 as an `ArrayBuffer` (or a
 * typed-array view); `JSON.stringify` would mangle it to a useless `{}` — indistinguishable from an
 * empty object. Convert it to a typed envelope `{ __blob: true, bytes, hex }` (hex = first 16 bytes)
 * so the editor renders a read-only "BLOB · N bytes" chip instead of garbled text. Every non-binary
 * value passes through unchanged. Pure.
 */
export function toBlobCell(value: unknown): unknown {
  let bytes: Uint8Array | null = null;

  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (!bytes) {
    return value;
  }

  const hex = Array.from(bytes.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');

  return { __blob: true, bytes: bytes.byteLength, hex };
}

/** Map every cell of every SQL result row through {@link toBlobCell} (BLOB → a JSON-safe envelope). Pure. */
export function serializeSqlRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(row)) {
      out[key] = toBlobCell(row[key]);
    }

    return out;
  });
}

tabs.post('/api/sites/:siteId/sql/exec', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  // The raw D1 console reads the SHARED multi-tenant database — restrict it to platform
  // administrators (a site owner must never be able to `SELECT * FROM users`). AL-792.
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'The SQL console is restricted to platform administrators.',
        },
      },
      403,
    );
  }

  let body: { query: string; params?: Array<string | number | boolean | null> };
  try {
    body = SqlExecSchema.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'invalid body' }, 400);
  }

  const q = body.query.trim();
  if (!READONLY_PREFIX.test(q)) {
    return c.json(
      { ok: false, error: 'read-only: only SELECT / EXPLAIN / WITH / PRAGMA allowed' },
      400,
    );
  }
  if (FORBIDDEN_KEYWORDS.test(q)) {
    return c.json({ ok: false, error: 'DDL not allowed' }, 400);
  }

  // Org-scope check: site must belong to the caller's org.
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ ok: false, error: 'site not found' }, 404);
  }

  // Positional bind params — values are bound (never concatenated), booleans → 0/1 (no
  // native SQLite boolean). Only call `.bind()` when params exist so a no-param query
  // keeps its exact prepared-statement path.
  const boundParams = (body.params ?? []).map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const t0 = Date.now();
  try {
    const stmt = c.env.DB.prepare(q);
    const result = await (boundParams.length > 0 ? stmt.bind(...boundParams) : stmt).all();
    // Serialize BLOB cells (D1 ArrayBuffer → a typed envelope) so binary never reaches the editor as a
    // garbled `{}`; column keys are unchanged by the transform.
    const rows = serializeSqlRows((result.results ?? []) as Array<Record<string, unknown>>);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    await writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'site.sql.exec',
      target_type: 'site',
      target_id: siteId,
      message: 'SQL query executed',
      // Log the param COUNT, never the values — bind params can carry sensitive filter
      // values (emails, tokens); the epic mandates redacting sensitive parameter values.
      metadata_json: {
        query: q.slice(0, 200),
        rowcount: rows.length,
        param_count: boundParams.length,
      },
    });
    const meta = (result.meta ?? {}) as {
      rows_read?: number;
      rows_written?: number;
      duration?: number;
    };
    return c.json({
      ok: true,
      columns,
      rows,
      duration_ms: Date.now() - t0,
      // D1 query cost — surfaced so the SQL workspace can show read/write cost.
      // null (never 0) when the runtime doesn't report it, so the UI can say "n/a".
      rows_read: meta.rows_read ?? null,
      rows_written: meta.rows_written ?? null,
      d1_duration_ms: meta.duration ?? null,
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'query failed' }, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/sql/nl2sql — AI SQL assistant (natural language → SQL)
// Grounds Workers AI (Llama, free) on the REAL server-fetched schema and returns ONE
// read-only SELECT for the operator to REVIEW. It NEVER executes — the returned SQL is
// run (if the user chooses) through /sql/exec, which independently enforces the
// SELECT/EXPLAIN/WITH/PRAGMA allowlist + super-admin gate. Super-admin ONLY (shared DB).
// ─────────────────────────────────────────────────────────────────────────────
const Nl2SqlSchema = z.object({ question: z.string().min(1).max(500) });

/** The valid, current Workers AI Llama alias (per model-alias discipline — 70B fp8-fast, free). */
const NL2SQL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Build the chat messages for NL→SQL — a strict SQLite-expert system prompt grounded in the real DDL.
 * Read-only by construction (the model is told to emit ONE SELECT and never mutate); the schema is
 * bounded so a huge DB can't blow the context. Pure + exported for tests.
 */
export function buildNl2SqlMessages(
  question: string,
  schemaDdl: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system =
    'You are a careful SQLite expert. Translate the user request into ONE single read-only SQLite ' +
    'SELECT that answers it. Rules: (1) output ONLY the SQL — no prose, no markdown fences, no ' +
    'explanation; (2) NEVER write or modify data (no INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE); ' +
    '(3) use ONLY tables and columns present in the schema; (4) add a LIMIT of at most 100 unless the ' +
    'request is an aggregate; (5) if it cannot be answered from this schema, output exactly: ' +
    '-- cannot answer from this schema';
  const schema = schemaDdl.trim() ? schemaDdl.trim().slice(0, 12_000) : '(no tables)';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Schema:\n${schema}\n\nRequest: ${question.trim()}\n\nSQL:` },
  ];
}

/**
 * Extract a clean single SQL statement from the model's text — strips a markdown fence, a leading
 * "sql" language hint, and a trailing semicolon. Best-effort; the read-exec path re-validates the
 * allowlist regardless, so a stray write can never execute. Pure + exported for tests.
 */
export function extractSqlFromAiText(text: string): string {
  let t = (text ?? '').trim();
  const fence = /```(?:sql)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    t = fence[1].trim();
  }
  t = t.replace(/^sql\s*\n/i, '').trim();
  return t.replace(/;\s*$/, '').trim();
}

tabs.post('/api/sites/:siteId/sql/nl2sql', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'The SQL console is restricted to platform administrators.',
        },
      },
      403,
    );
  }

  let body: { question: string };
  try {
    body = Nl2SqlSchema.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'invalid body' }, 400);
  }

  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ ok: false, error: 'site not found' }, 404);
  }

  // Ground the model on the REAL schema (server-fetched DDL) — NEVER a client-supplied schema.
  let schemaDdl = '';
  try {
    const rows = await c.env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY name LIMIT 200`,
    ).all();
    schemaDdl = ((rows.results ?? []) as Array<{ sql?: unknown }>)
      .map((r) => String(r.sql ?? ''))
      .filter(Boolean)
      .join(';\n');
  } catch {
    schemaDdl = '';
  }

  let sql = '';
  try {
    const ai = c.env.AI as {
      run: (model: string, inputs: unknown) => Promise<{ response?: string } | string>;
    };
    const out = await ai.run(NL2SQL_MODEL, {
      messages: buildNl2SqlMessages(body.question, schemaDdl),
    });
    const text = typeof out === 'string' ? out : String(out?.response ?? '');
    sql = extractSqlFromAiText(text);
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: 'AI temporarily unavailable',
        detail: e instanceof Error ? e.message : 'ai_error',
      },
      502,
    );
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.sql.nl2sql',
    target_type: 'site',
    target_id: siteId,
    // Log the question + model, never row data. The generated SQL is not executed here.
    message: 'NL→SQL generated',
    metadata_json: { question: body.question.slice(0, 200), model: NL2SQL_MODEL },
  });

  // Return the SQL for REVIEW — never executed here (the user runs it through the guarded /sql/exec).
  return c.json({ ok: true, sql, model: NL2SQL_MODEL });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/sql/schema
// Read-only SQLite schema introspection for the D1 manager — every table & view with
// its columns (+ pk/notnull/default), indexes (+ their columns), and foreign keys,
// plus each object's CREATE SQL. Triggers are included too (name + the table they fire
// on + CREATE SQL; they carry no columns/indexes/FKs). Super-admin ONLY (reads the
// shared multi-tenant DB — AL-792).
// PRAGMA arguments cannot be bound, so each object name is re-validated against
// sqlite_master and only a confirmed identifier is ever interpolated (no injection).
// ─────────────────────────────────────────────────────────────────────────────
tabs.get('/api/sites/:siteId/sql/schema', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Schema introspection is restricted to platform administrators.',
        },
      },
      403,
    );
  }
  const site = await c.env.DB.prepare(
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(siteId, orgId)
    .first<{ id: string }>();
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'site not found' } }, 404);
  }

  // Enumerate real tables/views/triggers (never the sqlite_% internal objects). No "AND
  // name" here — validating a specific name is a separate parameterized lookup below.
  // `tbl_name` is the table a trigger fires on (== name for tables/views; unused there).
  const master = await c.env.DB.prepare(
    `SELECT name, type, sql, tbl_name FROM sqlite_master WHERE type IN (?1, ?2, ?3) ORDER BY name`,
  )
    .bind('table', 'view', 'trigger')
    .all<{ name: string; type: string; sql: string | null; tbl_name: string | null }>();
  const objects = (master.results ?? []).filter((r) => !r.name.startsWith('sqlite_'));

  // Names come from sqlite_master (a trusted source), but PRAGMA arguments cannot be
  // bound — so format-check each identifier before interpolating it (belt-and-suspenders
  // against any exotic object name). Only plain SQLite identifiers reach a PRAGMA.
  const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const tables: Array<Record<string, unknown>> = [];
  for (const obj of objects) {
    if (!SAFE_IDENT.test(obj.name)) continue;

    // Triggers aren't tables — table_info/index_list/foreign_key_list are all empty for
    // them. Surface just the CREATE SQL + the table they fire on (sqlite_master.tbl_name),
    // skipping the three useless PRAGMA round-trips.
    if (obj.type === 'trigger') {
      tables.push({
        name: obj.name,
        type: 'trigger',
        create_sql: obj.sql ?? null,
        on_table: obj.tbl_name ?? null,
        columns: [],
        indexes: [],
        foreign_keys: [],
      });
      continue;
    }

    const ident = `"${obj.name}"`;

    const cols = await c.env.DB.prepare(`PRAGMA table_info(${ident})`).all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>();
    const idxList = await c.env.DB.prepare(`PRAGMA index_list(${ident})`).all<{
      name: string;
      unique: number;
      origin: string;
    }>();
    const indexes: Array<{ name: string; unique: boolean; columns: string[] }> = [];
    for (const idx of idxList.results ?? []) {
      const idxCols = await c.env.DB.prepare(
        `PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`,
      ).all<{ name: string }>();
      indexes.push({
        name: idx.name,
        unique: idx.unique === 1,
        columns: (idxCols.results ?? []).map((r) => r.name),
      });
    }
    const fks = await c.env.DB.prepare(`PRAGMA foreign_key_list(${ident})`).all<{
      from: string;
      table: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>();

    tables.push({
      name: obj.name,
      type: obj.type,
      create_sql: obj.sql ?? null,
      on_table: null,
      columns: (cols.results ?? []).map((col) => ({
        name: col.name,
        type: col.type,
        notnull: col.notnull,
        dflt_value: col.dflt_value,
        pk: col.pk,
      })),
      indexes,
      foreign_keys: (fks.results ?? []).map((fk) => ({
        from: fk.from,
        table: fk.table,
        to: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
      })),
    });
  }

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.sql.schema',
    target_type: 'site',
    target_id: siteId,
    message: 'Schema introspected',
    metadata_json: { table_count: tables.length },
  });

  return c.json({ data: { tables } });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/sql/migrations
// The applied-migration ledger for the platform D1 — the wrangler-managed
// `d1_migrations` table (one row per applied migration file: name + applied_at).
// Super-admin ONLY (reads the shared multi-tenant DB — AL-792). Read-only, bounded.
// Honest: `d1_migrations` is ABSENT on a DB that never ran `wrangler d1 migrations
// apply` → returns `available:false` (never a fabricated "0 migrations"). We do NOT
// offer applied-vs-pending "drift": the migration FILES aren't present in the running
// Worker, so we can't compute pending without lying — the UI states this.
// ─────────────────────────────────────────────────────────────────────────────
tabs.get('/api/sites/:siteId/sql/migrations', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Migration status is restricted to platform administrators.',
        },
      },
      403,
    );
  }
  // Org-scope check (defense-in-depth; a super-admin passes regardless).
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  }
  try {
    const result = await c.env.DB.prepare(
      `SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 500`,
    ).all();
    const migrations = (result.results ?? []) as Array<{ name: string; applied_at: string }>;
    await writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'site.sql.migrations',
      target_type: 'site',
      target_id: siteId,
      message: 'Viewed applied migrations',
      metadata_json: { count: migrations.length },
    });
    return c.json({ data: { available: true, count: migrations.length, migrations } });
  } catch {
    // No `d1_migrations` table (this DB never migrated via wrangler) — honest
    // "unavailable", NOT an error and NOT a fabricated empty ledger.
    return c.json({ data: { available: false, count: 0, migrations: [] } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/sql/exec-write
// The WRITE half of the D1 manager — the standard SQLite-editor operations
// (CREATE / DROP / ALTER TABLE, INSERT / UPDATE / DELETE / REPLACE). Super-admin
// ONLY (shared multi-tenant DB — AL-792) with two safety guards that make a
// fat-finger non-catastrophic:
//   1. PROTECTED_TABLES denylist — the write path REFUSES to mutate or drop the
//      platform's own tables (auth/billing/tenancy). A super-admin can still SELECT
//      them via the read console; they can never be written/dropped from the editor.
//   2. Destructive statements (DROP / ALTER / TRUNCATE, and DELETE/UPDATE with no
//      WHERE = whole-table mutation) require `confirm: true` — the UI's typed-confirm.
// Single-statement only (`.prepare().run()` — no multi-statement injection).
// ─────────────────────────────────────────────────────────────────────────────
const SqlWriteSchema = z.object({
  statement: z.string().min(1).max(16_000),
  confirm: z.boolean().optional(),
  // Positional bind params for ?1, ?2, … — values are BOUND, never concatenated into the
  // statement (the epic's "parameterize values, never concatenate" mandate). This is what
  // lets the grid's typed row editors (Add/Edit/Delete) generate a parameterized statement
  // instead of stringifying user values into SQL. Booleans → 0/1 at bind time (SQLite has no
  // native boolean). Capped at 200 (an INSERT can carry one param per column of a wide table).
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .max(200)
    .optional(),
});

/**
 * Platform tables the write console must NEVER create/mutate/drop — nuking one
 * would break auth/billing/tenancy for every tenant. Read (SELECT) is unaffected.
 */
const PROTECTED_TABLES = new Set<string>([
  'users',
  'orgs',
  'memberships',
  'sessions',
  'magic_links',
  'oauth_states',
  'subscriptions',
  'webhook_events',
  'audit_logs',
  'feature_flags',
  'feature_flag_overrides',
  'feature_flag_audit',
  'sites',
  'hostnames',
  'workflow_jobs',
  'wallets',
  'wallet_ledger',
  'cost_categories',
  'sqlite_master',
  'sqlite_sequence',
  'sqlite_temp_master',
  'd1_migrations',
]);

const WRITE_PREFIX = /^\s*(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE)\b/i;
const DESTRUCTIVE_PREFIX = /^\s*(DROP|ALTER|TRUNCATE)\b/i;
/** DELETE/UPDATE with no WHERE = whole-table mutation → treat as destructive. */
const UNSCOPED_MUTATION = /^\s*(DELETE\s+FROM|UPDATE)\b(?![\s\S]*\bWHERE\b)/i;

/** Best-effort target-table extraction for the denylist check (IF [NOT] EXISTS stripped first). */
function sqlTargetTable(stmt: string): string | null {
  const cleaned = stmt.replace(/\bIF\s+(NOT\s+)?EXISTS\b/gi, ' ');
  const m = cleaned.match(/\b(?:INTO|FROM|UPDATE|TABLE)\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i);
  return m ? m[1].toLowerCase() : null;
}

tabs.post('/api/sites/:siteId/sql/exec-write', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'The SQL console is restricted to platform administrators.',
        },
      },
      403,
    );
  }

  let body: {
    statement: string;
    confirm?: boolean;
    params?: Array<string | number | boolean | null>;
  };
  try {
    body = SqlWriteSchema.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'invalid body' }, 400);
  }

  const q = body.statement.trim();
  if (!WRITE_PREFIX.test(q)) {
    return c.json(
      {
        ok: false,
        error:
          'write console: use CREATE / DROP / ALTER / INSERT / UPDATE / DELETE / REPLACE (SELECT → read console)',
      },
      400,
    );
  }

  // Denylist: never let the console write/drop a platform table.
  const target = sqlTargetTable(q);
  if (target && PROTECTED_TABLES.has(target)) {
    return c.json(
      {
        ok: false,
        error: `"${target}" is a protected platform table — it can be read but not modified from the console.`,
      },
      400,
    );
  }

  // Destructive statements need an explicit confirm (the UI's type-to-confirm).
  const destructive = DESTRUCTIVE_PREFIX.test(q) || UNSCOPED_MUTATION.test(q);
  if (destructive && body.confirm !== true) {
    return c.json(
      {
        ok: false,
        error:
          'destructive statement — re-run with confirm:true (DROP/ALTER, or DELETE/UPDATE without WHERE)',
        needs_confirm: true,
      },
      400,
    );
  }

  // Org-scope check: site must belong to the caller's org.
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ ok: false, error: 'site not found' }, 404);
  }

  // Positional bind params — bound (never concatenated), booleans → 0/1. Only call `.bind()`
  // when params exist so a no-param statement keeps its exact prepared-statement path.
  const boundParams = (body.params ?? []).map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const t0 = Date.now();
  try {
    const stmt = c.env.DB.prepare(q);
    const result = await (boundParams.length > 0 ? stmt.bind(...boundParams) : stmt).run();
    const meta = (result.meta ?? {}) as { changes?: number; last_row_id?: number };
    await writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'site.sql.write',
      target_type: 'site',
      target_id: siteId,
      message: destructive ? 'SQL destructive write executed' : 'SQL write executed',
      // Log the param COUNT, never the values — bind params can carry sensitive data; the
      // epic mandates redacting sensitive parameter values from the audit trail.
      metadata_json: {
        statement: q.slice(0, 200),
        destructive,
        rows_affected: meta.changes ?? 0,
        param_count: boundParams.length,
      },
    });
    return c.json({
      ok: true,
      rows_affected: meta.changes ?? 0,
      last_row_id: meta.last_row_id ?? null,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'statement failed' }, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/integrations
// Lists MCP providers + their connection status for this site.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDERS: Array<{ key: string; name: string; oauth_supported: boolean }> = [
  { key: 'mailchimp', name: 'Mailchimp', oauth_supported: true },
  { key: 'stripe', name: 'Stripe', oauth_supported: true },
  { key: 'hubspot', name: 'HubSpot', oauth_supported: true },
  { key: 'github', name: 'GitHub', oauth_supported: true },
  { key: 'slack', name: 'Slack', oauth_supported: true },
  { key: 'notion', name: 'Notion', oauth_supported: true },
  { key: 'resend', name: 'Resend', oauth_supported: false },
];

tabs.get('/api/sites/:siteId/integration-providers', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  // Org-scope the site. This handler used to sit at `/integrations`, where the
  // newsletter-integrations route (forms.ts, registered first) SHADOWED it — so it
  // never ran and its missing ownership check was harmless. On its own
  // `/integration-providers` path it is reachable, so it MUST verify the site
  // belongs to the caller's org (else any authed user could read another org's
  // per-site provider status by guessing siteId).
  const owned = await dbQueryOne(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const conns = await dbQuery<{ provider: string }>(
    c.env.DB,
    `SELECT provider FROM mcp_connections
      WHERE site_id = ?1 AND deleted_at IS NULL`,
    [siteId],
  );
  const connected = new Set((conns.data ?? []).map((r) => r.provider));

  const providers = PROVIDERS.map((p) => ({
    ...p,
    status: connected.has(p.key) ? ('connected' as const) : ('disconnected' as const),
  }));

  return c.json({ providers });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sites/:siteId/integration-providers/:key
// Soft-delete the mcp_connections row for this site + provider.
// ─────────────────────────────────────────────────────────────────────────────
tabs.delete('/api/sites/:siteId/integration-providers/:key', async (c) => {
  const siteId = c.req.param('siteId');
  const provider = c.req.param('key');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  const owned = await dbQueryOne(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const { error: disconnectErr } = await dbExecute(
    c.env.DB,
    `UPDATE mcp_connections
        SET deleted_at = datetime('now')
      WHERE site_id = ?1 AND provider = ?2 AND deleted_at IS NULL`,
    [siteId, provider],
  );
  // Site ownership is pre-guarded above. changes===0 is a VALID idempotent success
  // here (the provider was already disconnected) — NOT a 404. Only surface a real
  // DB error so a failed disconnect never reports success.
  if (disconnectErr) throw internalError(`Failed to disconnect integration: ${disconnectErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.integrations.disconnect',
    target_type: 'site',
    target_id: siteId,
    message: `Disconnected ${provider}`,
    metadata_json: { provider },
  });

  return c.json({ ok: true });
});

export { tabs as siteDetailTabs };
