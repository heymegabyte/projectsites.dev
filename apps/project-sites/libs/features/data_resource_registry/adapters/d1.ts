/**
 * @module libs/features/data_resource_registry/adapters/d1
 * @description The `d1` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 2 (read + gated WRITE).
 *
 * Implements the read verbs against a site's OWN Cloudflare D1: `list` (its tables), `head` (existence
 * probe), `get` (one table's columns + a row page) — PLUS the gated WRITE slice: `mutate({action:'exec'})`,
 * a single PARAMETERIZED SQL statement run through the same CF REST D1 `/query` plane. `mutate` is a
 * discriminated NAMED-mutation union (never a `runAnything`/`{command}` mega-verb — tool-design-as-api).
 *
 * SQL CLASSIFICATION — honest, NOT a false "sandboxed read-only" claim (PHASED-PLAN.md: "distinguish
 * potentially mutating SQL; do not pretend a simple regex reliably makes arbitrary SQL read-only"). The
 * statement is classified by its LEADING keyword after stripping comments/CTEs:
 *  - READ-ONLY  → `SELECT` / `PRAGMA` / `EXPLAIN` / `WITH … SELECT` / `VALUES`
 *  - MUTATING   → `INSERT` / `UPDATE` / `DELETE` / `REPLACE` / `CREATE` / `ALTER` / `DROP` / `TRUNCATE` /
 *                 `WITH … <mutating>` (a CTE that ends in a write)
 *  - DESTRUCTIVE (a subset of mutating) → `DROP` / `TRUNCATE` / `ALTER` / a `DELETE` with NO `WHERE`
 * A MUTATING statement requires an explicit `confirm:true`; without it `mutate` returns a typed
 * `confirmation_required` envelope that REPORTS the detected statement kind and executes NOTHING
 * (SECURITY-INVARIANTS INV-9/INV-11). A DESTRUCTIVE statement is additionally FLAGGED and its message
 * NOTES that D1 Time Travel (30-day PITR) is the recovery path — the caller restores to a pre-write
 * timestamp via `wrangler d1 time-travel restore`, since the CF REST plane does not expose a bookmark
 * create call here. The classifier is BEST-EFFORT: the leading-keyword parse decides the confirm gate,
 * but the GROUND TRUTH of what changed is D1's own `rows_written` / `changed_db` meta on the result —
 * this adapter NEVER claims the classifier sandboxes arbitrary SQL, it relies on parameterized exec +
 * that meta. Identifiers can't be REST-parameterized, so DDL/DML that names a table is the caller's
 * responsibility; only bound `params[]` are ever interpolated as VALUES.
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` `resolveSiteDataDb`:
 *  - Every verb operates ONLY on the `scope.resourceId` it was minted with. That id was SERVER-RESOLVED
 *    upstream (`service.resolveResourceRef` / the site's `site_database_allocations` row) — it is NEVER a
 *    caller-supplied id. This adapter accepts NO id parameter and does NOT re-resolve: resolution happened
 *    upstream, so it must NOT call `resolveSiteDataDb` (that would re-do the ownership+provision work).
 *  - The shared-platform D1 ids ({@link FORBIDDEN_DB_IDS}) are refused at every verb as defense-in-depth on
 *    top of the resolver's denylist — a scope that somehow carries a shared id fails closed
 *    (`forbidden_shared`) and is treated by the reconciler as NOT a "missing" signal.
 *  - Execution goes through the CF **D1 REST API** — `head` via the database GET, `list`/`get`/`mutate` via
 *    the same REST `/query` plane `resolveSiteDataDb` executes through. We reuse the exact low-level query
 *    mechanism ({@link makeSiteDataExecutor} from `site_data_db.ts`) bound to `scope.resourceId`, rather than
 *    duplicating the fetch — a Worker can't statically bind thousands of per-site D1s. The executor is
 *    single-statement + env/id-bound at mint time (INV-9): a `mutate` can only ever write the resolved id.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';
import {
  FORBIDDEN_DB_IDS,
  isSafeIdent,
  makeSiteDataExecutor,
  quoteIdent,
  type SiteDataD1Error,
} from '../../../../src/services/site_data_db.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';
import {
  runProvisionMutation,
  type ProvisionInput,
  type ProvisionMutateResult,
} from '../provision_mutation.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard bounds on a `get` page so a caller can never pull an unbounded table dump. */
const GET_LIMIT_MIN = 1;
const GET_LIMIT_MAX = 200;
const GET_LIMIT_DEFAULT = 50;

/** What a D1 `head` returns: whether the database exists + a little CF metadata when it does. */
export interface D1HeadData {
  /** True when CF confirms the database exists (a `200` from the D1 GET). */
  readonly exists: boolean;
  /** The probed database id (echoed for the caller's audit — it came from the scope, not the caller). */
  readonly databaseId: string;
  /** CF-reported name, when present in the `200` body. */
  readonly name?: string;
  /** CF-reported number of tables, when present (a blank per-site D1 reads as a low/zero count). */
  readonly numTables?: number;
}

/** What a D1 `list` returns: the customer-owned table names (SQLite/D1 internals hidden). */
export interface D1ListData {
  readonly tables: readonly { readonly name: string }[];
}

/** One column's shape as reported by `PRAGMA table_info` (the columns a `get` page carries). */
export interface D1ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: boolean;
  readonly pk: boolean;
}

/** The `get` input: which table + an optional page window (bounds clamped server-side). */
export interface D1GetInput {
  readonly table: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** What a D1 `get` returns: one table's columns + a bounded row page + the window that produced it. */
export interface D1GetData {
  readonly table: string;
  readonly columns: readonly D1ColumnInfo[];
  readonly rows: readonly Record<string, unknown>[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

/**
 * The honest classification of one SQL statement's effect (see module docs). `read_only` runs without a
 * confirm; `mutating` needs `confirm:true`; `destructive` is a mutating subset that is ALSO flagged +
 * carries the Time-Travel recovery note. `unknown` (empty / unparseable leading keyword) is treated as
 * mutating for the confirm gate — fail CLOSED, never assume a blank statement is a safe read.
 */
export type SqlEffect = 'read_only' | 'mutating' | 'destructive' | 'unknown';

/**
 * The `exec` mutation input: run ONE PARAMETERIZED SQL statement against the site's OWN D1. `params[]` are
 * bound VALUES only (identifiers can't be REST-parameterized). A MUTATING statement (see {@link SqlEffect})
 * REQUIRES `confirm:true`; without it `mutate` returns `confirmation_required` reporting the detected kind
 * and runs NOTHING. A DESTRUCTIVE statement is additionally flagged with a Time-Travel recovery note.
 */
export interface D1ExecInput {
  readonly action: 'exec';
  /** A single SQL statement. Multiple statements are refused (the REST `/query` plane is single-statement). */
  readonly sql: string;
  /** Bound parameter VALUES (positional `?`), never identifiers. */
  readonly params?: readonly unknown[];
  /** Must be `true` to run a MUTATING/DESTRUCTIVE statement (a read-only statement needs no confirm). */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the d1 adapter — NEVER a generic `{ sql }` bare field. */
export type D1MutateInput = D1ExecInput | ProvisionInput;

/**
 * What a successful `exec` returns: the honestly-classified effect, D1's GROUND-TRUTH meta (`rowsRead`/
 * `rowsWritten`/`changedDb` — the authoritative "what changed", not the classifier's guess), and the row
 * page for a read-only statement (a mutating statement typically returns no rows).
 */
export interface D1ExecResult {
  readonly action: 'exec';
  /** The classifier's leading-keyword verdict (best-effort — see `changedDb` for ground truth). */
  readonly effect: SqlEffect;
  /** True when the statement was flagged destructive (DROP/TRUNCATE/ALTER/DELETE-without-WHERE). */
  readonly destructive: boolean;
  /** Rows the result carried (a SELECT/PRAGMA/RETURNING page); empty for a plain write. */
  readonly rows: readonly Record<string, unknown>[];
  /** D1-reported rows read (ground truth from the `/query` meta). */
  readonly rowsRead: number;
  /** D1-reported rows written (ground truth — the real mutation signal, not the classifier). */
  readonly rowsWritten: number;
  /** D1-reported whether the database changed (ground truth). */
  readonly changedDb: boolean;
}

/** The discriminated result union a successful `mutate` returns. */
export type D1MutateResult = D1ExecResult | ProvisionMutateResult;

/** SQLite keywords whose statement MUTATES the database. */
const MUTATING_KEYWORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'REINDEX',
  'VACUUM',
  'ANALYZE',
]);

/** Read-only leading keywords (a `WITH … SELECT` resolves to its trailing statement — see below). */
const READ_ONLY_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'PRAGMA',
  'EXPLAIN',
  'VALUES',
]);

/**
 * Strip SQL comments (`-- line` and block comments) + collapse whitespace so the leading-keyword parse
 * sees the real first token. Best-effort — string-literal-aware enough for classification, NOT a full SQL
 * parser (the confirm gate is the safety net, D1's `rows_written` is the ground truth).
 */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify a single SQL statement's effect by its LEADING keyword (see module docs). Honest + best-effort:
 * decides the confirm gate; D1's result meta is the ground truth of what actually changed. `EXPLAIN` /
 * `EXPLAIN QUERY PLAN` is always read-only regardless of what it explains. A `WITH` CTE is resolved to its
 * trailing top-level statement (a CTE ending in `DELETE`/`INSERT`/`UPDATE` is mutating). An `ALTER`/`DROP`/
 * `TRUNCATE`, or a `DELETE` with no `WHERE`, is DESTRUCTIVE.
 */
export function classifySql(rawSql: string): SqlEffect {
  const sql = stripSqlNoise(rawSql);
  if (sql.length === 0) return 'unknown';

  // EXPLAIN [QUERY PLAN] <inner> — always read-only, regardless of the inner statement.
  const explainMatch = /^EXPLAIN\b/i.exec(sql);
  if (explainMatch) return 'read_only';

  // Resolve the effective leading keyword. For WITH-CTEs, find the FIRST top-level DML/DDL keyword after
  // the CTE list (a CTE body is parenthesised; the trailing statement is the classified one).
  const firstWord = /^([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? '';
  let effective = firstWord;
  if (firstWord === 'WITH') {
    // Scan for the first mutating/read keyword that appears at paren-depth 0 after the CTE definitions.
    effective = leadingKeywordAfterCte(sql);
  }

  if (READ_ONLY_KEYWORDS.has(effective)) return 'read_only';
  if (MUTATING_KEYWORDS.has(effective)) {
    if (isDestructive(effective, sql)) return 'destructive';
    return 'mutating';
  }
  // Unknown leading token (a rare pragma spelling, or garbage) → fail CLOSED as mutating-unknown.
  return 'unknown';
}

/** Find the first top-level (paren-depth 0) DML/DDL keyword after a `WITH` CTE list. */
function leadingKeywordAfterCte(sql: string): string {
  let depth = 0;
  const tokens = sql.split(/([(),\s]+)/);
  for (const tok of tokens) {
    for (const ch of tok) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;
    const word = /^[A-Za-z]+$/.test(tok) ? tok.toUpperCase() : '';
    if (word === 'WITH' || word === 'RECURSIVE' || word === 'AS') continue;
    if (READ_ONLY_KEYWORDS.has(word) || MUTATING_KEYWORDS.has(word)) return word;
  }
  return 'SELECT'; // a WITH that never reaches a DML keyword is a read CTE.
}

/** A DROP/TRUNCATE/ALTER, or a DELETE with no WHERE clause, is destructive of existing data. */
function isDestructive(keyword: string, sql: string): boolean {
  if (keyword === 'DROP' || keyword === 'TRUNCATE' || keyword === 'ALTER' || keyword === 'VACUUM') {
    return true;
  }
  if (keyword === 'DELETE') {
    // A DELETE with no WHERE wipes the whole table — destructive. `\bWHERE\b` case-insensitive.
    return !/\bWHERE\b/i.test(sql);
  }
  return false;
}

/** Reject a multi-statement payload (the REST `/query` plane runs ONE statement per call). */
function isMultiStatement(sql: string): boolean {
  const stripped = stripSqlNoise(sql);
  // A single trailing semicolon is fine; a semicolon with more SQL after it is a second statement.
  const withoutTrailing = stripped.replace(/;+\s*$/, '');
  return withoutTrailing.includes(';');
}

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `d1-${crypto.randomUUID()}`;
}

/** The shared-id defense-in-depth check — returns a `forbidden_shared` envelope, or `undefined` to proceed. */
function refuseSharedId<T>(cid: string, databaseId: string): AdapterResult<T> | undefined {
  if (FORBIDDEN_DB_IDS.has(databaseId)) {
    return {
      correlationId: cid,
      error: {
        code: 'forbidden_shared',
        message: 'Refusing to touch a shared-platform database id.',
        retryable: false,
      },
      ok: false,
    };
  }
  return undefined;
}

/**
 * Map a per-site D1 query failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a
 * `5xx`/network error is retryable (transient — never interpret as "gone"); anything else is a hard
 * query failure the UI surfaces as-is.
 */
function queryError<T>(cid: string, err: unknown): AdapterResult<T> {
  const status = (err as Partial<SiteDataD1Error>)?.status;
  const isAuth = status === 401 || status === 403;
  const isServer = typeof status === 'number' && status >= 500;
  return {
    correlationId: cid,
    error: {
      code: isAuth ? 'cf_unauthorized' : isServer ? 'cf_server_error' : 'cf_query_failed',
      message: err instanceof Error ? err.message : 'per-site D1 query failed',
      retryable: isAuth || isServer || status === undefined,
    },
    ok: false,
  };
}

/** Clamp a requested page `limit` into `[1, 200]`, defaulting to 50 for a missing/invalid value. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return GET_LIMIT_DEFAULT;
  return Math.min(GET_LIMIT_MAX, Math.max(GET_LIMIT_MIN, Math.floor(limit)));
}

/** Clamp a requested `offset` to a non-negative integer (default 0). */
function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/**
 * The `d1` adapter. `list`/`head`/`get` are live (read-only); `mutate({action:'exec'})` runs one gated
 * PARAMETERIZED statement (mutating/destructive statements gated on `confirm:true`, classified honestly).
 * `supports` declares this so the UI + MCP only ever offer a verb that runs.
 */
class D1Adapter
  implements ResourceAdapter<D1ListData, D1HeadData, D1GetData, D1MutateInput, D1MutateResult>
{
  readonly kind = 'd1' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): d1 serves both environments, all three read verbs,
   * and the `exec` named mutation (a single gated PARAMETERIZED statement). provision/seed/destroy named
   * mutations land later — append them here + implement in the same fire so the UI/MCP never offer an
   * unwired verb.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['exec', 'provision'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
  };

  /**
   * Enumerate the site's OWN customer tables — hides SQLite/D1/Cloudflare internals (`sqlite_*`, `_cf_*`,
   * `d1_migrations`), matching `listSiteTables`'s filtering, so a blank per-site D1 reads as an empty set
   * (the Data tab's "New table / Ask AI" empty state), never a confusing list of plumbing tables.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY database this can enumerate
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<D1ListData>> {
    const cid = correlationId();
    const databaseId = scope.resourceId;
    const forbidden = refuseSharedId<D1ListData>(cid, databaseId);
    if (forbidden) return forbidden;

    const db = makeSiteDataExecutor(scope.auth, scope.accountId, databaseId);
    try {
      const { results } = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE '_cf_%'
             AND name <> 'd1_migrations'
           ORDER BY name`,
      );
      // Defense-in-depth: the SQL WHERE already hides SQLite/D1/CF internals, but re-apply the same
      // filter in JS so a mocked/misbehaving executor (or a future query change) can never leak a
      // `sqlite_*` / `_cf_*` / `d1_migrations` plumbing table — and drop any non-safe identifier.
      const tables = results
        .map((r) => r.name)
        .filter(isSafeIdent)
        .filter(
          (name) =>
            !/^sqlite_/.test(name) && !/^_cf_/.test(name) && name !== 'd1_migrations',
        )
        .map((name) => ({ name }));
      return { correlationId: cid, data: { tables }, ok: true };
    } catch (err) {
      return queryError<D1ListData>(cid, err);
    }
  }

  /**
   * Cheap existence/metadata probe of the site's OWN D1 via the CF REST D1 GET. The id lives in
   * `scope.resourceId` (resolved server-side), the account is `scope.accountId`, and auth is `scope.auth`.
   * Never accepts a caller id.
   *
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/`4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/network; `forbidden_shared` if the id is denylisted
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<D1HeadData>> {
    const cid = correlationId();
    const databaseId = scope.resourceId;
    const forbidden = refuseSharedId<D1HeadData>(cid, databaseId);
    if (forbidden) return forbidden;

    let res: Response;
    try {
      res = await fetch(`${CF_API_BASE}/accounts/${scope.accountId}/d1/database/${databaseId}`, {
        headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
        method: 'GET',
      });
    } catch (err) {
      // Network failure — transient, retryable, NOT a "missing" signal.
      return {
        correlationId: cid,
        error: {
          code: 'cf_request_failed',
          message: err instanceof Error ? err.message : 'CF request failed',
          retryable: true,
        },
        ok: false,
      };
    }

    if (res.ok) {
      const json = (await res.json().catch(() => null)) as {
        result?: { uuid?: string; name?: string; num_tables?: number };
      } | null;
      return {
        correlationId: cid,
        data: {
          databaseId,
          exists: true,
          name: json?.result?.name,
          numTables: json?.result?.num_tables,
        },
        ok: true,
      };
    }

    // 404 (and other non-auth 4xx) => the database our row claims does not exist on CF => drift.
    if (
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)
    ) {
      return { correlationId: cid, data: { databaseId, exists: false }, ok: true };
    }

    // 401/403 (auth) or 5xx (server) — a probe failure we can't interpret as "gone". Retryable.
    return {
      correlationId: cid,
      error: {
        code: res.status === 401 || res.status === 403 ? 'cf_unauthorized' : 'cf_server_error',
        message: `CF D1 head returned HTTP ${res.status}`,
        retryable: res.status >= 500,
      },
      ok: false,
    };
  }

  /**
   * Read ONE table's columns (`PRAGMA table_info`) + a bounded row page from the site's OWN D1. The table
   * name is validated with {@link isSafeIdent} (D1 REST can't parameterize an identifier) and quoted before
   * it touches SQL. `limit` is clamped to `[1, 200]` (default 50), `offset` to `>= 0`; `total` is a full
   * `COUNT(*)` so the UI can paginate honestly (per the `paginated-endpoint-silent-cap-needs-total` rule).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY database this can read
   * @param input - `{ table, limit?, offset? }` — `table` MUST be a real customer table in this D1
   */
  async get(scope: ResolvedScope, input: D1GetInput): Promise<AdapterResult<D1GetData>> {
    const cid = correlationId();
    const databaseId = scope.resourceId;
    const forbidden = refuseSharedId<D1GetData>(cid, databaseId);
    if (forbidden) return forbidden;

    const table = input?.table;
    if (!isSafeIdent(table)) {
      return {
        correlationId: cid,
        error: {
          code: 'invalid_table',
          message: 'Table name is missing or not a valid SQLite identifier.',
          retryable: false,
        },
        ok: false,
      };
    }
    const limit = clampLimit(input?.limit);
    const offset = clampOffset(input?.offset);
    const quoted = quoteIdent(table);

    const db = makeSiteDataExecutor(scope.auth, scope.accountId, databaseId);
    try {
      const [{ results: colRows }, { results: countRows }, { results: rows }] = await Promise.all([
        db.query<{ name: string; type: string; notnull: number; pk: number }>(
          `PRAGMA table_info(${quoted})`,
        ),
        db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoted}`),
        db.query<Record<string, unknown>>(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [
          limit,
          offset,
        ]),
      ]);

      // An empty PRAGMA => the table does not exist in THIS database (isSafeIdent only proves the NAME is
      // well-formed, not that the table is real). Surface it honestly rather than a confusing empty page.
      if (colRows.length === 0) {
        return {
          correlationId: cid,
          error: {
            code: 'table_not_found',
            message: `Table '${table}' does not exist in this database.`,
            retryable: false,
          },
          ok: false,
        };
      }

      const columns: D1ColumnInfo[] = colRows.map((c) => ({
        name: c.name,
        notnull: c.notnull === 1,
        pk: c.pk === 1,
        type: c.type,
      }));
      const total = countRows[0]?.n ?? 0;
      return {
        correlationId: cid,
        data: { columns, limit, offset, rows, table, total },
        ok: true,
      };
    } catch (err) {
      return queryError<D1GetData>(cid, err);
    }
  }

  /**
   * Run ONE PARAMETERIZED SQL statement against the site's OWN D1 (the gated WRITE slice). `exec` operates
   * ONLY on `scope.resourceId` (server-resolved upstream — this adapter accepts NO database id and cannot be
   * redirected; INV-9). The statement is CLASSIFIED honestly by its leading keyword ({@link classifySql}):
   * a MUTATING/DESTRUCTIVE/unknown statement REQUIRES `confirm:true`; without it this returns a typed
   * `confirmation_required` envelope that REPORTS the detected kind and runs NOTHING (INV-9/INV-11). A
   * DESTRUCTIVE statement's message additionally NOTES D1 Time Travel (30-day PITR) as the recovery path.
   * The classifier decides the gate ONLY — the GROUND TRUTH of what changed is D1's `rows_written`/
   * `changed_db` meta on the result (this adapter never claims the classifier sandboxes arbitrary SQL). Only
   * bound `params[]` VALUES are interpolated; identifiers are the caller's responsibility. Multiple
   * statements are refused (the REST `/query` plane is single-statement).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY database this can write
   * @param input - the discriminated `{ action:'exec', sql, params?, confirm? }` mutation
   */
  async mutate(scope: ResolvedScope, input: D1MutateInput): Promise<AdapterResult<D1MutateResult>> {
    const cid = correlationId();

    // PROVISION runs BEFORE the resolved-id checks: it CREATES the database, so `scope.resourceId` is
    // empty (the id is the output) and the shared-id denylist doesn't apply yet. Delegated to the shared
    // provision bridge (idempotency → quota → provisioner → registry record → recoverable partial).
    if (input && input.action === 'provision') {
      return runProvisionMutation(cid, scope, 'd1', input);
    }

    const databaseId = scope.resourceId;
    const forbidden = refuseSharedId<D1MutateResult>(cid, databaseId);
    if (forbidden) return forbidden;

    if (!input || input.action !== 'exec') {
      return {
        correlationId: cid,
        error: { code: 'invalid_action', message: 'Unknown D1 mutation action.', retryable: false },
        ok: false,
      };
    }

    const sql = input.sql;
    if (typeof sql !== 'string' || stripSqlNoiseIsEmpty(sql)) {
      return {
        correlationId: cid,
        error: { code: 'invalid_sql', message: 'SQL statement is missing or empty.', retryable: false },
        ok: false,
      };
    }
    if (isMultiStatement(sql)) {
      return {
        correlationId: cid,
        error: {
          code: 'multi_statement',
          message: 'Only a single SQL statement per call is supported (the D1 REST query API is single-statement).',
          retryable: false,
        },
        ok: false,
      };
    }
    const params = input.params ?? [];
    if (!Array.isArray(params)) {
      return {
        correlationId: cid,
        error: { code: 'invalid_params', message: 'params must be an array of bound values.', retryable: false },
        ok: false,
      };
    }

    const effect = classifySql(sql);
    const isMutating = effect !== 'read_only';
    const destructive = effect === 'destructive';

    // Confirm gate: any statement the classifier does NOT prove read-only requires confirm:true. An
    // `unknown` leading token fails CLOSED here (treated as mutating) — never assume a blank/odd statement
    // is a safe read.
    if (isMutating && input.confirm !== true) {
      const kindLabel =
        effect === 'destructive'
          ? 'a DESTRUCTIVE statement'
          : effect === 'unknown'
            ? 'a statement whose effect could not be verified read-only'
            : 'a data-mutating statement';
      const travelNote = destructive
        ? ' This is destructive — before re-running, note that D1 Time Travel (30-day point-in-time recovery) is the rollback path: `wrangler d1 time-travel restore` to a pre-write timestamp.'
        : '';
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `This SQL is classified as ${kindLabel} (best-effort leading-keyword classification; D1's rows_written is the ground truth). Re-run with confirm:true to execute it.${travelNote}`,
          retryable: false,
        },
        ok: false,
      };
    }

    const db = makeSiteDataExecutor(scope.auth, scope.accountId, databaseId);
    try {
      const { results, meta } = await db.query<Record<string, unknown>>(sql, params);
      return {
        correlationId: cid,
        data: {
          action: 'exec',
          changedDb: meta.changed_db === true,
          destructive,
          effect,
          rows: results,
          rowsRead: meta.rows_read ?? 0,
          rowsWritten: meta.rows_written ?? 0,
        },
        ok: true,
      };
    } catch (err) {
      return queryError<D1MutateResult>(cid, err);
    }
  }
}

/** True when a SQL string is only comments/whitespace (used by `mutate`'s empty-statement guard). */
function stripSqlNoiseIsEmpty(sql: string): boolean {
  return stripSqlNoise(sql).length === 0;
}

/** The singleton `d1` adapter instance the reconciler + registry look up by kind. */
export const d1Adapter = new D1Adapter();
