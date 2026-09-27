/**
 * @module libs/features/data_resource_registry/adapters/connection
 * @description The `connection` {@link ResourceAdapter} — Data & Resource Platform §8a, Connections (read)
 * slice. The DATABASE-CONNECTION member of the data plane: a site's OUTBOUND connections to EXTERNAL
 * providers — Hyperdrive / external DB (postgres/mysql) + `mcp_connections` OAuth/paste-key links
 * (Stripe/HubSpot/GitHub/Slack/Resend-MCP/…). Implements the read verbs: `list` (the site's configured
 * connections — id/name/type/MASKED host/status), `head` (does the site have ANY connection + how many),
 * `get` (one connection's metadata WITHOUT secrets). `mutate` returns a typed `not_implemented` envelope
 * (this pass is READ-ONLY) — never a raw throw, never a `runAnything` mega-verb (tool-design-as-api).
 * `revoke` lands in the write pass (append to `supports.mutations` + implement `mutate` in the same fire).
 *
 * ⛔ CREDENTIAL ISOLATION — THE LOAD-BEARING INVARIANT OF THIS SLICE (SECURITY-INVARIANTS §credentials,
 * CAPABILITY-MATRIX "⛔ read secret back"). A connection carries a password / token / full connection
 * string; NONE of it may EVER reach the client or an MCP tool. This adapter enforces that STRUCTURALLY:
 *  - It NEVER SELECTs the `access_token_encrypted` / `refresh_token_encrypted` columns (or any secret
 *    column). The SQL column list is an allowlist — a secret column is not on it, so it cannot leak even
 *    if a serializer changes. (`encrypted-named-column-may-store-plaintext`: we don't even read the bytes.)
 *  - It surfaces ONLY: `id`, `name` (display name), `type` (provider/engine), a MASKED host, and
 *    health/status metadata (status, connected/updated timestamps). A full host/connection string is
 *    reduced to a mask ({@link maskHost}) — the customer confirms WHICH connection, never its address.
 *  - There is NO verb that returns a secret. `mutate:revoke` (future) revokes the EXTERNAL token; it never
 *    reads one back.
 *
 * ISOLATION (site-scoped, same structural guarantee as `site_data_db.ts` / the CF-REST adapters):
 *  - A connection is NOT a Cloudflare account object, so it is NOT resolved via `resolveResourceRef` and
 *    reaches NO CF REST API. Its rows live in the platform's own D1 (`mcp_connections`, `shared_platform`
 *    storage with per-site rows). This adapter reads them through `scope.db` (server-attached, never
 *    caller-supplied), ALWAYS filtered by `scope.resourceId` — which for this kind is the OWNED `siteId`
 *    (the route/dispatcher already proved ownership). A foreign site's rows are unreachable: the
 *    `WHERE site_id = ?` binds the site the scope was minted with, and no caller-supplied id ever touches
 *    the query.
 *  - Hyperdrive / external-DB connections, when modelled, are the same shape (id/name/type/masked-host/
 *    status) — never their secret. Today the concrete backing store is `mcp_connections`.
 *
 * HONEST "not registered": a blank site has NO connections — `list` returns an empty array + count 0 and
 * `head` returns `exists:false` (the Data tab's honest empty state), NEVER a fabricated connection
 * (`verify-against-source-of-truth`). No connection store configured for the deployment (no `scope.db`)
 * is also `not_registered` — never a guessed row.
 *
 * @packageDocumentation
 */
import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

/** The external-connection statuses `mcp_connections.status` uses (a health signal, never a secret). */
export type ConnectionStatus = 'active' | 'revoked' | 'expired' | 'error' | 'unknown';

/**
 * One connection as `list`/`get` report it — SECRET-FREE by construction. Only the id + display name +
 * provider/engine type + a MASKED host + health/status metadata. NEVER a token, password, or full
 * connection string.
 */
export interface ConnectionInfo {
  /** The `mcp_connections.id` (or Hyperdrive config id) — an opaque handle, not a secret. */
  readonly id: string;
  /** Human display name (falls back to the provider when the row has none). */
  readonly name: string;
  /** The provider / engine: `stripe` | `hubspot` | `postgres` | `mysql` | `hyperdrive` | … */
  readonly type: string;
  /** A MASKED host/endpoint hint (e.g. `db…example.com`), or absent when the row exposes none. NEVER full. */
  readonly maskedHost?: string;
  /** Health/status (`active`/`revoked`/`expired`/…) — never a secret. */
  readonly status: ConnectionStatus;
  /** When the connection was first established (ISO 8601), when present. */
  readonly connectedAt?: string;
  /** When the connection row was last updated (ISO 8601), when present. */
  readonly updatedAt?: string;
}

/** What a connection `list` returns: the site's connections + an HONEST count (never fabricated). */
export interface ConnectionListData {
  readonly connections: readonly ConnectionInfo[];
  /** The number of connections returned — the real row count for the site, never invented. */
  readonly count: number;
}

/** What a connection `head` returns: whether the site has ANY connection + how many. */
export interface ConnectionHeadData {
  /** True when the site has ≥1 connection row. */
  readonly exists: boolean;
  /** Total connection rows for the site (0 when none) — the honest existence signal. */
  readonly count: number;
}

/** The `get` input: which connection to read (by its id). */
export interface ConnectionGetInput {
  readonly id: string;
}

/** What a connection `get` returns: ONE connection's SECRET-FREE metadata, or `found:false`. */
export interface ConnectionGetData {
  /** True when the connection exists for this site; false → the other fields are absent (honest miss). */
  readonly found: boolean;
  /** The connection's secret-free metadata, present only when found. */
  readonly connection?: ConnectionInfo;
  /** Always true — a reminder the raw secret/token/connection-string is NEVER returned (module docs). */
  readonly secretsRedacted: true;
}

/** Placeholder mutate payloads — this pass is read-only; `revoke` lands in the write pass. */
type ConnectionMutateInput = never;
type ConnectionMutateResult = never;

/** The `mcp_connections` row shape this adapter reads — SECRET COLUMNS ARE DELIBERATELY ABSENT. */
interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly display_name: string | null;
  readonly account_metadata_json: string | null;
  readonly status: string | null;
  readonly connected_at: string | null;
  readonly updated_at: string | null;
}

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `connection-${crypto.randomUUID()}`;
}

/** The typed `not_implemented` envelope every read-only-pass-unfilled verb returns. */
function notImplemented<T>(verb: string): AdapterResult<T> {
  return {
    correlationId: correlationId(),
    error: {
      code: 'not_implemented',
      message: `The connection adapter '${verb}' verb is not implemented yet.`,
      retryable: false,
    },
    ok: false,
  };
}

/** The typed `not_registered` envelope — no connection store configured for this deployment. */
function notRegistered<T>(cid: string): AdapterResult<T> {
  return {
    correlationId: cid,
    error: {
      code: 'not_registered',
      message: 'No connection store is configured for this site.',
      retryable: false,
    },
    ok: false,
  };
}

/**
 * Map a raw `status` string to a typed {@link ConnectionStatus}. Anything unrecognised becomes `unknown`
 * (never dropped, never guessed as `active`). This is a health signal only — never a secret.
 */
function toStatus(raw: string | null | undefined): ConnectionStatus {
  switch (raw) {
    case 'active':
    case 'revoked':
    case 'expired':
    case 'error':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * MASK a host/endpoint so the customer can recognise a connection without ever seeing its full address.
 * Keeps the first label + the registrable tail (e.g. `db-primary.internal.example.com` → `db…example.com`),
 * and never returns a value long enough to reconstruct the endpoint. A short/opaque host is masked to
 * `…`. This never touches a password or token — those columns are never read.
 */
export function maskHost(host: string | null | undefined): string | undefined {
  if (typeof host !== 'string') return undefined;
  const trimmed = host.trim();
  if (trimmed.length === 0) return undefined;
  const labels = trimmed.split('.').filter((l) => l.length > 0);
  if (labels.length <= 2) {
    // No safe middle to keep — reveal at most the first character of the first label.
    const head = labels[0] ?? trimmed;
    return `${head.slice(0, 1)}…`;
  }
  const first = labels[0];
  const tail = labels.slice(-2).join('.');
  return `${first.slice(0, 2)}…${tail}`;
}

/**
 * Pull a MASKED host out of a connection's `account_metadata_json` WITHOUT ever exposing a secret. Only a
 * small allowlist of NON-SECRET host-ish keys is inspected (`host`/`hostname`/`endpoint`/`server`); the
 * value is immediately reduced to a mask. Returns `undefined` when the metadata has no host-ish field or
 * is unparseable — a connection with no exposable host is honest, never fabricated. A stored secret is
 * never in these keys, and the raw value never leaves this function.
 */
function maskedHostFromMetadata(metadataJson: string | null): string | undefined {
  if (typeof metadataJson !== 'string' || metadataJson.length === 0) return undefined;
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    meta = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const key of ['host', 'hostname', 'endpoint', 'server'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0) return maskHost(value);
  }
  return undefined;
}

/** Reshape a raw {@link ConnectionRow} into the SECRET-FREE {@link ConnectionInfo} the client sees. */
function toConnectionInfo(row: ConnectionRow): ConnectionInfo {
  return {
    connectedAt: row.connected_at ?? undefined,
    id: row.id,
    maskedHost: maskedHostFromMetadata(row.account_metadata_json),
    name: row.display_name ?? row.provider,
    status: toStatus(row.status),
    type: row.provider,
    updatedAt: row.updated_at ?? undefined,
  };
}

/**
 * The `connection` adapter. `list`/`head`/`get` are live (read-only, SECRET-FREE); `mutate` returns
 * `not_implemented`. `supports` declares that honestly so the UI + MCP never offer a verb that would 501.
 * Reads the platform's own D1 (`mcp_connections`) via `scope.db`, ALWAYS filtered by the OWNED site id in
 * `scope.resourceId` — never a CF REST API, never a caller-supplied id, and never a secret column.
 */
class ConnectionAdapter
  implements
    ResourceAdapter<
      ConnectionListData,
      ConnectionHeadData,
      ConnectionGetData,
      ConnectionMutateInput,
      ConnectionMutateResult
    >
{
  readonly kind = 'connection' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md: Connections = ✅ read+revoke): serves both
   * environments + all three read verbs. `mutations: []` — this pass is read-only; `revoke` (revokes the
   * EXTERNAL token, never reads a secret back) lands in the write pass (append it here + implement
   * `mutate` in the same fire).
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['list', 'head', 'get'] as const,
  };

  /**
   * List the site's OWN connections — id/name/type/MASKED host/status ONLY (NEVER a secret). Reads
   * `mcp_connections` via `scope.db`, filtered to `scope.resourceId` (the OWNED site id). A blank site
   * reads as an empty array + count 0 (the Data tab's honest empty state), never an error, never a
   * fabricated row. No `scope.db` → `not_registered` (no connection store configured).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the OWNED site id (not a CF id), and
   *                `scope.db` is the server-attached D1 handle. Neither is caller-supplied.
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<ConnectionListData>> {
    const cid = correlationId();
    const db = scope.db;
    if (!db) return notRegistered<ConnectionListData>(cid);

    let rows: ConnectionRow[];
    try {
      // Allowlisted, SECRET-FREE column list — the `*_encrypted` columns are DELIBERATELY not selected.
      const result = await db
        .prepare(
          `SELECT id, provider, display_name, account_metadata_json, status, connected_at, updated_at
             FROM mcp_connections
             WHERE site_id = ?
             ORDER BY connected_at DESC`,
        )
        .bind(scope.resourceId)
        .all<ConnectionRow>();
      rows = (result.results ?? []) as ConnectionRow[];
    } catch (err) {
      return {
        correlationId: cid,
        error: {
          code: 'db_query_failed',
          message: err instanceof Error ? err.message : 'Could not read the site connections.',
          retryable: true,
        },
        ok: false,
      };
    }

    const connections = rows.map(toConnectionInfo);
    return { correlationId: cid, data: { connections, count: connections.length }, ok: true };
  }

  /**
   * Cheap existence probe — does the site have ANY connection, and how many? Reads a COUNT from
   * `mcp_connections` via `scope.db`, filtered to `scope.resourceId` (the OWNED site id). Never reads a
   * secret column. `{ exists:false, count:0 }` for a blank site (honest empty), a typed retryable error
   * on a DB failure. No `scope.db` → `not_registered`.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the OWNED site id, `scope.db` the D1
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<ConnectionHeadData>> {
    const cid = correlationId();
    const db = scope.db;
    if (!db) return notRegistered<ConnectionHeadData>(cid);

    let count = 0;
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM mcp_connections WHERE site_id = ?`)
        .bind(scope.resourceId)
        .first<{ n: number }>();
      count = typeof row?.n === 'number' ? row.n : 0;
    } catch (err) {
      return {
        correlationId: cid,
        error: {
          code: 'db_query_failed',
          message: err instanceof Error ? err.message : 'Could not probe the site connections.',
          retryable: true,
        },
        ok: false,
      };
    }

    return { correlationId: cid, data: { count, exists: count > 0 }, ok: true };
  }

  /**
   * Read ONE connection's SECRET-FREE metadata (id/name/type/MASKED host/status) from the site's OWN
   * connections. Reads `mcp_connections` via `scope.db`, filtered to BOTH `scope.resourceId` (the OWNED
   * site id) AND the requested connection id — so a foreign site's connection can never be read even if
   * its id is guessed. **Returns metadata ONLY — never a token, password, or connection string.** A
   * missing id is an HONEST `{ found:false }`, not an error. No `scope.db` → `not_registered`.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the OWNED site id, `scope.db` the D1
   * @param input - `{ id }` — the connection id to read (scoped to the site; never a raw secret)
   */
  async get(scope: ResolvedScope, input: ConnectionGetInput): Promise<AdapterResult<ConnectionGetData>> {
    const cid = correlationId();
    const db = scope.db;
    if (!db) return notRegistered<ConnectionGetData>(cid);

    const id = input?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_id', message: 'Connection id is missing or empty.', retryable: false },
        ok: false,
      };
    }

    let row: ConnectionRow | null;
    try {
      // Both the site id AND the connection id bind the query — cross-site read is structurally impossible.
      // SECRET-FREE column allowlist — the `*_encrypted` columns are never selected.
      row = await db
        .prepare(
          `SELECT id, provider, display_name, account_metadata_json, status, connected_at, updated_at
             FROM mcp_connections
             WHERE site_id = ? AND id = ?
             LIMIT 1`,
        )
        .bind(scope.resourceId, id)
        .first<ConnectionRow>();
    } catch (err) {
      return {
        correlationId: cid,
        error: {
          code: 'db_query_failed',
          message: err instanceof Error ? err.message : 'Could not read the connection.',
          retryable: true,
        },
        ok: false,
      };
    }

    if (!row) {
      return { correlationId: cid, data: { found: false, secretsRedacted: true }, ok: true };
    }
    return {
      correlationId: cid,
      data: { connection: toConnectionInfo(row), found: true, secretsRedacted: true },
      ok: true,
    };
  }

  /** Not implemented in this read pass — `revoke` (revokes the external token) lands in the write pass. */
  async mutate(
    _scope: ResolvedScope,
    _input: ConnectionMutateInput,
  ): Promise<AdapterResult<ConnectionMutateResult>> {
    return notImplemented<ConnectionMutateResult>('mutate');
  }
}

/** The singleton `connection` adapter instance the reconciler + registry look up by kind. */
export const connectionAdapter = new ConnectionAdapter();
