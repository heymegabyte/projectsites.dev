/**
 * @module libs/features/data_resource_registry/adapters/d1
 * @description The `d1` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 1 → 2 (read) slice.
 *
 * Implements the read verbs against a site's OWN Cloudflare D1: `list` (its tables), `head` (existence
 * probe), `get` (one table's columns + a row page). `mutate` returns a typed `not_implemented` envelope
 * (Phase 2 is READ-ONLY) — never a raw throw, never a `runAnything` mega-verb (tool-design-as-api).
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` `resolveSiteDataDb`:
 *  - Every verb operates ONLY on the `scope.resourceId` it was minted with. That id was SERVER-RESOLVED
 *    upstream (`service.resolveResourceRef` / the site's `site_database_allocations` row) — it is NEVER a
 *    caller-supplied id. This adapter accepts NO id parameter and does NOT re-resolve: resolution happened
 *    upstream, so it must NOT call `resolveSiteDataDb` (that would re-do the ownership+provision work).
 *  - The shared-platform D1 ids ({@link FORBIDDEN_DB_IDS}) are refused at every verb as defense-in-depth on
 *    top of the resolver's denylist — a scope that somehow carries a shared id fails closed
 *    (`forbidden_shared`) and is treated by the reconciler as NOT a "missing" signal.
 *  - Execution goes through the CF **D1 REST API** — `head` via the database GET, `list`/`get` via the same
 *    REST `/query` plane `resolveSiteDataDb` executes through. We reuse the exact low-level query mechanism
 *    ({@link makeSiteDataExecutor} from `site_data_db.ts`) bound to `scope.resourceId`, rather than
 *    duplicating the fetch — a Worker can't statically bind thousands of per-site D1s.
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

/** Placeholder mutate payloads — Phase 2 is read-only; provision/seed/put land later. */
type D1MutateInput = never;
type D1MutateResult = never;

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

/** The typed `not_implemented` envelope every Phase-2-unfilled verb returns. */
function notImplemented<T>(verb: string): AdapterResult<T> {
  return {
    correlationId: correlationId(),
    error: {
      code: 'not_implemented',
      message: `The d1 adapter '${verb}' verb is not implemented yet.`,
      retryable: false,
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
 * The `d1` adapter. `list`/`head`/`get` are live (read-only); `mutate` returns `not_implemented`.
 * `supports` declares that honestly so the UI + MCP never offer a verb that would 501.
 */
class D1Adapter
  implements ResourceAdapter<D1ListData, D1HeadData, D1GetData, D1MutateInput, D1MutateResult>
{
  readonly kind = 'd1' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): d1 serves both environments and all three read
   * verbs. `mutations: []` — Phase 2 is read-only; provision/destroy/seed named mutations land in Phase 3
   * (append them here + implement `mutate` in the same fire).
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['list', 'head', 'get'] as const,
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

  /** Not implemented in Phase 2 — provision/destroy/seed named mutations land in Phase 3 (read-only now). */
  async mutate(_scope: ResolvedScope, _input: D1MutateInput): Promise<AdapterResult<D1MutateResult>> {
    return notImplemented<D1MutateResult>('mutate');
  }
}

/** The singleton `d1` adapter instance the reconciler + registry look up by kind. */
export const d1Adapter = new D1Adapter();
