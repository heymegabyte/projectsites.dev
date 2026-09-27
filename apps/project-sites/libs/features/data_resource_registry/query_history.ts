/**
 * @module libs/features/data_resource_registry/query_history
 * @description Per-site D1 **query history** (Data & Resource Platform — PHASED-PLAN "query history").
 *
 * Records the STATEMENT TEMPLATE of every `exec`/`explain` run against a customer's OWN dedicated
 * per-site D1, and reads the recent history back for the editor's Data tab + the MCP. Two functions:
 *  - {@link recordQueryHistory} — FIRE-AND-FORGET / best-effort write; NEVER blocks or fails the
 *    query the customer actually asked for (the d1 adapter awaits nothing on it and swallows errors).
 *  - {@link readQueryHistory} — newest-first read of one owned site's recent history (clamped).
 *
 * ISOLATION + PRIVACY (SECURITY-INVARIANTS):
 *  - History lives in the SHARED PLATFORM D1 (`env.DB`), org+site-scoped — NEVER in the customer's
 *    own per-site D1 (no pollution of customer data, no cross-tenant leakage). The caller passes the
 *    platform `DB` binding explicitly; this module never touches a per-site D1.
 *  - `sqlText` is the STATEMENT TEMPLATE ONLY (the SQL string with its `?` placeholders). Bound
 *    parameter VALUES are NEVER accepted, stored, or logged here — they are the customer's data and
 *    may be sensitive. The write signature has NO `params` field by construction: it is structurally
 *    impossible to persist a param value through this module.
 *
 * @packageDocumentation
 */
import { dbInsert, dbQuery } from '../../../src/services/db.js';
import { uuidv7 } from '../../../src/lib/uuid.js';

import type { SqlEffect } from './adapters/d1.js';
import type { ResourceEnvironment } from './schemas.js';

/** Hard bounds on a history read so a caller can never pull an unbounded dump. */
const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 200;
const HISTORY_LIMIT_DEFAULT = 25;

/**
 * One recorded query-history entry. Deliberately carries NO parameter VALUES — only the statement
 * template + execution meta. `sqlText` is the template as the caller submitted it (`?` placeholders
 * intact); the bound values are omitted by construction.
 */
export interface QueryHistoryInput {
  /** The OWNED site whose per-site D1 was queried (server-resolved upstream). */
  readonly siteId: string;
  /** The authed org (scoping + isolation). */
  readonly orgId: string;
  /** The environment the query ran against. */
  readonly environment: ResourceEnvironment;
  /** The honest classification of the statement's effect (from `classifySql`). */
  readonly statementKind: SqlEffect;
  /** The STATEMENT TEMPLATE only — the SQL string WITH its `?` placeholders. NEVER param values. */
  readonly sqlText: string;
  /** D1-reported query wall-time in ms, when present. */
  readonly durationMs?: number | undefined;
  /** D1-reported rows read, when present. */
  readonly rowsRead?: number | undefined;
  /** D1-reported rows written, when present. */
  readonly rowsWritten?: number | undefined;
  /** Whether the query succeeded. */
  readonly ok: boolean;
  /** Typed error code when `ok` is false. */
  readonly errorCode?: string | undefined;
}

/** One row of query history as read back for a caller (camelCase, newest-first). */
export interface QueryHistoryEntry {
  readonly id: string;
  readonly siteId: string;
  readonly environment: string;
  readonly statementKind: string;
  /** The statement TEMPLATE (with `?` placeholders) — never param values. */
  readonly sqlText: string;
  readonly durationMs: number | null;
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

/** Cap the SQL template we persist so a pathological statement can't bloat the history row. */
const SQL_TEXT_MAX = 100_000;

/**
 * Record ONE query-history entry — FIRE-AND-FORGET / best-effort. Returns a promise that ALWAYS
 * resolves (never rejects): any failure is swallowed + logged, so a history write can NEVER block or
 * fail the customer's actual query. The caller (the d1 adapter) does not await the result on the hot
 * path — it fires this and moves on.
 *
 * Only the STATEMENT TEMPLATE + execution meta are written; the input has no param-value field, so a
 * bound value is structurally impossible to persist here.
 *
 * @param db - the SHARED PLATFORM D1 binding (`env.DB`) — NEVER a per-site D1
 * @param input - the entry to record (statement template + meta; no param values)
 */
export async function recordQueryHistory(
  db: D1Database,
  input: QueryHistoryInput,
): Promise<void> {
  try {
    await dbInsert(db, 'data_query_history', {
      id: uuidv7(),
      site_id: input.siteId,
      org_id: input.orgId,
      environment: input.environment,
      statement_kind: input.statementKind,
      // Template only — trimmed to a sane cap. NEVER param values.
      sql_text: input.sqlText.slice(0, SQL_TEXT_MAX),
      duration_ms: input.durationMs ?? null,
      rows_read: input.rowsRead ?? null,
      rows_written: input.rowsWritten ?? null,
      ok: input.ok ? 1 : 0,
      error_code: input.errorCode ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Best-effort: a history write failure NEVER surfaces to the caller. Log for observability only.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'query_history',
        event: 'record_failed',
        message: err instanceof Error ? err.message : 'unknown error',
        siteId: input.siteId,
      }),
    );
  }
}

/** Clamp a requested history `limit` into `[1, 200]`, defaulting to 25 for a missing/invalid value. */
export function clampHistoryLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, Math.floor(limit)));
}

/** Raw `data_query_history` row shape as D1 returns it (snake_case, INTEGER booleans). */
interface QueryHistoryRow {
  id: string;
  site_id: string;
  environment: string;
  statement_kind: string;
  sql_text: string;
  duration_ms: number | null;
  rows_read: number | null;
  rows_written: number | null;
  ok: number;
  error_code: string | null;
  created_at: string;
}

/**
 * Read the recent query history for ONE owned site, newest-first. The caller MUST have already
 * proven org ownership of `siteId` (route/dispatcher gate) — this function additionally scopes the
 * SELECT to `org_id` (belt-and-braces isolation: a foreign site's history is never returned). The
 * platform DB is read directly; no CF id is ever named. `limit` is clamped to `[1, 200]`.
 *
 * @param db - the SHARED PLATFORM D1 binding (`env.DB`)
 * @param siteId - the OWNED site (server-side; from the dispatcher/route)
 * @param orgId - the authed org (belt-and-braces scope)
 * @param opts.environment - optional environment filter; when absent, all environments are returned
 * @param opts.limit - max rows (clamped to `[1, 200]`, default 25)
 * @returns validated {@link QueryHistoryEntry}[] newest-first
 */
export async function readQueryHistory(
  db: D1Database,
  siteId: string,
  orgId: string,
  opts: { environment?: ResourceEnvironment; limit?: number } = {},
): Promise<QueryHistoryEntry[]> {
  const limit = clampHistoryLimit(opts.limit);
  const clauses = ['site_id = ?', 'org_id = ?'];
  const params: unknown[] = [siteId, orgId];
  if (opts.environment) {
    clauses.push('environment = ?');
    params.push(opts.environment);
  }
  params.push(limit);
  const { data } = await dbQuery<QueryHistoryRow>(
    db,
    `SELECT id, site_id, environment, statement_kind, sql_text, duration_ms, rows_read,
            rows_written, ok, error_code, created_at
       FROM data_query_history
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    params,
  );
  return data.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    environment: row.environment,
    statementKind: row.statement_kind,
    sqlText: row.sql_text,
    durationMs: row.duration_ms,
    rowsRead: row.rows_read,
    rowsWritten: row.rows_written,
    ok: row.ok !== 0,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));
}
