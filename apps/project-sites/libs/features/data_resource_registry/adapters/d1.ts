/**
 * @module libs/features/data_resource_registry/adapters/d1
 * @description The `d1` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 1 slice.
 *
 * This fire implements ONE verb honestly: {@link D1Adapter.head} — a cheap existence/metadata probe
 * of a site's OWN Cloudflare D1, used by the reconciler's drift sweep to detect a row that CLAIMS a
 * database exists while CF has none (`resource_missing_on_cf`). `list`/`get`/`mutate` return a typed
 * `not_implemented` envelope for now (Phase 2 fills them) — never a raw throw, never a `runAnything`
 * mega-verb (tool-design-as-api).
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` `resolveSiteDataDb`:
 *  - `head` probes ONLY the `scope.resourceId` it was minted with. That id was SERVER-RESOLVED from
 *    the registry (`service.resolveResourceRef`) or a per-site allocation row the site owns — it is
 *    NEVER a caller-supplied id. This adapter does not accept an id parameter at all.
 *  - The shared-platform D1 ids ({@link FORBIDDEN_DB_IDS}) are refused at head time as defense-in-depth
 *    on top of the resolver's denylist — a scope that somehow carries a shared id fails closed
 *    (`forbidden_shared`) and is treated by the reconciler as NOT a "missing" signal (we never flip a
 *    customer row to drift because we refused to probe a platform id).
 *  - Execution goes through the CF **D1 REST API** (`GET /accounts/{acct}/d1/database/{id}`) — the same
 *    REST plane `resolveSiteDataDb` uses, because a Worker can't statically bind thousands of per-site
 *    D1s. A `200` = exists; a `404`/`4xx` (non-auth) = the database is gone (drift); a `5xx`/network is
 *    a transient/retryable failure, NOT drift.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';
import { FORBIDDEN_DB_IDS } from '../../../../src/services/site_data_db.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

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

/** Placeholder payloads for the unimplemented verbs — narrowed in Phase 2. */
type D1ListData = never;
type D1GetData = never;
type D1MutateInput = never;
type D1MutateResult = never;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `d1-${crypto.randomUUID()}`;
}

/** The typed `not_implemented` envelope every Phase-1-unfilled verb returns. */
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

/**
 * The `d1` adapter. Only {@link D1Adapter.head} is live; `supports` declares that honestly so the UI +
 * MCP never offer a verb that would 501. `mutations: []` — this adapter is read-only in Phase 1.
 */
class D1Adapter
  implements ResourceAdapter<D1ListData, D1HeadData, D1GetData, D1MutateInput, D1MutateResult>
{
  readonly kind = 'd1' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): d1 serves both environments, but in this
   * Phase 1 slice only `head` is backed by the CF API — `list`/`get`/`mutate` return `not_implemented`.
   * Updated to `['list','head','get','mutate']` + real `mutations` when Phase 2 fills them.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['head'] as const,
  };

  /**
   * Cheap existence/metadata probe of the site's OWN D1 via the CF REST D1 GET. Reuses the exact
   * server-resolution discipline of `resolveSiteDataDb`: the id lives in `scope.resourceId` (resolved
   * server-side), the account is `scope.accountId` (`env.CF_ACCOUNT_ID`), and auth is `scope.auth`
   * (`resolveCfCredentials`). Never accepts a caller id.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY database this can probe
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/`4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/network; `forbidden_shared` if the id is denylisted
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<D1HeadData>> {
    const cid = correlationId();
    const databaseId = scope.resourceId;

    // Defense-in-depth: never probe a shared-platform id even if a scope somehow carries one.
    if (FORBIDDEN_DB_IDS.has(databaseId)) {
      return {
        correlationId: cid,
        error: {
          code: 'forbidden_shared',
          message: 'Refusing to probe a shared-platform database id.',
          retryable: false,
        },
        ok: false,
      };
    }

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
    if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)) {
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

  /** Not implemented in Phase 1 — enumerate a D1's tables lands with the Tables surface migration. */
  async list(_scope: ResolvedScope, _input?: unknown): Promise<AdapterResult<D1ListData>> {
    return notImplemented<D1ListData>('list');
  }

  /** Not implemented in Phase 1 — read one table page lands in Phase 2. */
  async get(_scope: ResolvedScope, _input: unknown): Promise<AdapterResult<D1GetData>> {
    return notImplemented<D1GetData>('get');
  }

  /** Not implemented in Phase 1 — provision/destroy/seed named mutations land in Phase 2. */
  async mutate(_scope: ResolvedScope, _input: D1MutateInput): Promise<AdapterResult<D1MutateResult>> {
    return notImplemented<D1MutateResult>('mutate');
  }
}

/** The singleton `d1` adapter instance the reconciler + registry look up by kind. */
export const d1Adapter = new D1Adapter();
