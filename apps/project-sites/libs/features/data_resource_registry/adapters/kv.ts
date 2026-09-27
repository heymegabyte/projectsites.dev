/**
 * @module libs/features/data_resource_registry/adapters/kv
 * @description The `kv` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 3 (KV read) slice.
 *
 * Implements the read verbs against a site's OWN dedicated Cloudflare KV namespace: `list` (its keys,
 * cursor-paginated + honest `list_complete`, NEVER a fabricated total), `head` (existence probe),
 * `get` (one key's value + metadata) — PLUS the first WRITE slice: `mutate({action:'put'|'delete'})`.
 * `mutate` is a discriminated NAMED-mutation union (never a `runAnything`/`{command}` mega-verb —
 * tool-design-as-api): `put` writes one key's value (optional TTL + metadata), `delete` removes one key.
 * Both are guarded — an OVERWRITE (put over an existing key) and a DELETE are destructive of the prior
 * value, so each REQUIRES an explicit `confirm:true`; without it `mutate` returns a typed
 * `confirmation_required` envelope that REPORTS what WOULD change (the key + whether it exists) and
 * writes nothing (SECURITY-INVARIANTS INV-9/INV-11). bulk_delete/provision/destroy remain future verbs.
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` / the `d1` adapter:
 *  - Every verb operates ONLY on the `scope.resourceId` it was minted with. That id is the site's
 *    dedicated KV namespace id, SERVER-RESOLVED upstream (`service.resolveResourceRef` / the site's
 *    `site_database_allocations.kv_namespace_id` row) — it is NEVER a caller-supplied id. This adapter
 *    accepts NO namespace id parameter and does NOT re-resolve.
 *  - Execution goes through the CF **KV REST API** (`/accounts/{acct}/storage/kv/namespaces/{id}/...`)
 *    bound to `scope.resourceId` — a Worker can't statically bind thousands of per-site KV namespaces.
 *  - The FROZEN `PS_KV_REQUEST` editor bridge inspects the SHARED account-level namespaces (not
 *    site-scoped) and is a SEPARATE surface — this adapter never touches it and never exposes a shared
 *    namespace id.
 *
 * HONEST "not available": a blank site has NO KV allocation yet (per-site KV provisioning is
 * backend-ready but INERT until wired behind `per_site_kv`). When the resolver can't produce a
 * namespace id, the caller gets `not_registered`/`not_provisioned` UPSTREAM — this adapter is only
 * ever invoked with a real resolved id. If a verb's CF call reports the namespace is gone, `head`
 * returns `exists:false` (→ drift), matching the `d1` adapter's contract.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard bounds on a `list` page so a caller can never pull an unbounded key dump (CF KV max = 1000). */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 1000;
const LIST_LIMIT_DEFAULT = 100;

/** Max value bytes `get` will return inline (CF KV values can be ≤25 MiB; we cap what we buffer). */
const GET_MAX_VALUE_BYTES = 1_000_000;

/** What a KV `head` returns: whether the namespace exists + a little CF metadata when it does. */
export interface KvHeadData {
  /** True when CF confirms the namespace exists (a `200` from the KV namespace GET). */
  readonly exists: boolean;
  /** The probed namespace id (echoed for the caller's audit — it came from the scope, not the caller). */
  readonly namespaceId: string;
  /** CF-reported title, when present in the `200` body. */
  readonly title?: string;
}

/** One key as CF's `GET .../keys` reports it (name + optional expiration + optional metadata). */
export interface KvKeyInfo {
  readonly name: string;
  /** Absolute expiration (Unix seconds) when the key has a TTL, else absent. */
  readonly expiration?: number;
  /** Small opaque metadata object stored alongside the key, when present. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * What a KV `list` returns: a page of keys + HONEST pagination — `listComplete` (are there more?) and
 * the opaque `cursor` for the next page. NO fabricated total (CF KV cannot count without paging every
 * key — per the `paginated-endpoint-silent-cap-needs-total` / capability-matrix "no fake total" rule).
 */
export interface KvListData {
  readonly keys: readonly KvKeyInfo[];
  /** True when this is the last page (CF `result_info.list_complete`). */
  readonly listComplete: boolean;
  /** Opaque cursor for the NEXT page; absent/empty on the last page. */
  readonly cursor?: string;
}

/** The `list` input: an optional page window (prefix + cursor + limit; bounds clamped server-side). */
export interface KvListInput {
  /** Key-name prefix filter (CF KV lists by prefix). */
  readonly prefix?: string;
  /** Opaque cursor from a previous page's `cursor`. */
  readonly cursor?: string;
  /** Page size, clamped to `[1, 1000]` (default 100). */
  readonly limit?: number;
}

/** The `get` input: which key to read. */
export interface KvGetInput {
  readonly key: string;
}

/** What a KV `get` returns: the key's value + its metadata + whether it was found. */
export interface KvGetData {
  readonly key: string;
  /** True when the key exists; false → `value`/`metadata` are absent (a just-written key can 404 briefly). */
  readonly found: boolean;
  /** The raw value string (KV stores bytes; we return the text body). Absent when not found. */
  readonly value?: string;
  /** The key's metadata object, when present. */
  readonly metadata?: Record<string, unknown>;
  /** True when the value exceeded {@link GET_MAX_VALUE_BYTES} and was NOT buffered (honest, not silent). */
  readonly truncated?: boolean;
}

/** CF KV minimum TTL for a value with `expirationTtl` (seconds) — the CF API rejects anything below 60. */
const KV_MIN_EXPIRATION_TTL = 60;
/** Max value bytes `put` will accept (CF KV values can be ≤25 MiB; we cap what we upload inline). */
const PUT_MAX_VALUE_BYTES = 25 * 1024 * 1024;
/** Hard bound on a key's length (CF KV keys are ≤512 bytes). */
const KEY_MAX_BYTES = 512;

/**
 * The `put` mutation input: write ONE key's value to the site's OWN KV namespace, with optional TTL +
 * metadata. `confirm` is REQUIRED when the key already exists (an overwrite is destructive of the prior
 * value — INV-9/INV-11): without it, `mutate` returns `confirmation_required` and REPORTS the key + that
 * it exists, changing nothing.
 */
export interface KvPutInput {
  readonly action: 'put';
  readonly key: string;
  /** The raw value string to store (KV stores bytes; we upload the text body). */
  readonly value: string;
  /** Optional absolute TTL in seconds (CF minimum 60); omit for a non-expiring key. */
  readonly expirationTtl?: number;
  /** Optional small opaque metadata object stored alongside the key. */
  readonly metadata?: Record<string, unknown>;
  /** Must be `true` to overwrite an EXISTING key (a new key needs no confirm). */
  readonly confirm?: boolean;
}

/**
 * The `delete` mutation input: remove ONE key from the site's OWN KV namespace. DESTRUCTIVE — `confirm`
 * is REQUIRED (INV-9/INV-11): without it, `mutate` returns `confirmation_required` and REPORTS the key +
 * whether it currently exists, deleting nothing.
 */
export interface KvDeleteInput {
  readonly action: 'delete';
  readonly key: string;
  /** Must be `true` to actually delete (destructive-op gate). */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the kv adapter — NEVER a generic `{ command }` field. */
export type KvMutateInput = KvPutInput | KvDeleteInput;

/** What a KV `put` returns: the key written + whether it overwrote a prior value + TTL/metadata echoes. */
export interface KvPutResult {
  readonly action: 'put';
  readonly key: string;
  /** True when a value already existed at this key (this write overwrote it). */
  readonly overwritten: boolean;
  /** The absolute TTL applied (seconds), when one was requested. */
  readonly expirationTtl?: number;
  /** True when metadata was stored alongside the value. */
  readonly metadataStored: boolean;
}

/** What a KV `delete` returns: the key + whether it existed before the delete (honest, not a fabricated success). */
export interface KvDeleteResult {
  readonly action: 'delete';
  readonly key: string;
  /** True when the key existed and was removed; false when it was already absent (delete is idempotent). */
  readonly existed: boolean;
}

/** The discriminated result union a successful `mutate` returns. */
export type KvMutateResult = KvPutResult | KvDeleteResult;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `kv-${crypto.randomUUID()}`;
}

/**
 * Map a KV REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a `5xx`/network
 * error is retryable (transient — never interpret as "gone"); anything else is a hard failure the UI
 * surfaces as-is. Mirrors the `d1` adapter's `queryError`.
 */
function restError<T>(cid: string, status: number | undefined, message: string): AdapterResult<T> {
  const isAuth = status === 401 || status === 403;
  const isServer = typeof status === 'number' && status >= 500;
  return {
    correlationId: cid,
    error: {
      code: isAuth ? 'cf_unauthorized' : isServer ? 'cf_server_error' : 'cf_request_failed',
      message,
      retryable: isAuth || isServer || status === undefined,
    },
    ok: false,
  };
}

/** Clamp a requested page `limit` into `[1, 1000]`, defaulting to 100 for a missing/invalid value. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return LIST_LIMIT_DEFAULT;
  return Math.min(LIST_LIMIT_MAX, Math.max(LIST_LIMIT_MIN, Math.floor(limit)));
}

/**
 * The `kv` adapter. `list`/`head`/`get` are live (read-only); `mutate` implements the `put` + `delete`
 * named mutations (destructive/overwrite gated on `confirm:true`). `supports` declares this honestly so
 * the UI + MCP only ever offer a verb that runs.
 */
class KvAdapter
  implements ResourceAdapter<KvListData, KvHeadData, KvGetData, KvMutateInput, KvMutateResult>
{
  readonly kind = 'kv' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): kv serves both environments, all three read
   * verbs, and the `put`/`delete` named mutations (the first WRITE slice). bulk_delete/provision/destroy
   * land later — append them here as they are implemented so the UI/MCP never offer an unwired verb.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['put', 'delete'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
  };

  /**
   * Enumerate the site's OWN keys via the CF KV REST `GET .../keys` — cursor-paginated. Returns the page
   * of keys + HONEST `listComplete` + `cursor` (never a fabricated total; CF KV can't count without
   * paging every key). A blank per-site namespace reads as an empty page with `listComplete:true` (the
   * Data tab's empty state), never an error.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can enumerate
   * @param input - optional `{ prefix?, cursor?, limit? }` — `limit` clamped to `[1, 1000]`
   */
  async list(scope: ResolvedScope, input?: KvListInput): Promise<AdapterResult<KvListData>> {
    const cid = correlationId();
    const namespaceId = scope.resourceId;
    const limit = clampLimit(input?.limit);

    const url = new URL(
      `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${namespaceId}/keys`,
    );
    url.searchParams.set('limit', String(limit));
    if (input?.prefix) url.searchParams.set('prefix', input.prefix);
    if (input?.cursor) url.searchParams.set('cursor', input.cursor);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
        method: 'GET',
      });
    } catch (err) {
      return restError<KvListData>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ name: string; expiration?: number; metadata?: Record<string, unknown> }>;
      result_info?: { cursor?: string; count?: number };
      errors?: unknown;
    } | null;

    if (!res.ok || !json?.success) {
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<KvListData>(cid, res.status, `CF KV keys list failed: ${detail}`);
    }

    const keys: KvKeyInfo[] = (json.result ?? []).map((k) => ({
      expiration: k.expiration,
      metadata: k.metadata,
      name: k.name,
    }));
    // CF signals "more pages" by returning a non-empty cursor in result_info. An empty/absent cursor
    // means this is the last page. This is the HONEST completeness signal — no invented total.
    const cursor = json.result_info?.cursor ?? '';
    const listComplete = cursor.length === 0;
    return {
      correlationId: cid,
      data: { cursor: listComplete ? undefined : cursor, keys, listComplete },
      ok: true,
    };
  }

  /**
   * Cheap existence/metadata probe of the site's OWN KV namespace via the CF REST namespace GET. The id
   * lives in `scope.resourceId` (resolved server-side), the account is `scope.accountId`, and auth is
   * `scope.auth`. Never accepts a caller id. Mirrors the `d1` adapter's `head` contract.
   *
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/non-auth `4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<KvHeadData>> {
    const cid = correlationId();
    const namespaceId = scope.resourceId;

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${namespaceId}`,
        {
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'GET',
        },
      );
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
        result?: { id?: string; title?: string };
      } | null;
      return {
        correlationId: cid,
        data: { exists: true, namespaceId, title: json?.result?.title },
        ok: true,
      };
    }

    // 404 (and other non-auth 4xx) => the namespace our row claims does not exist on CF => drift.
    if (
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)
    ) {
      return { correlationId: cid, data: { exists: false, namespaceId }, ok: true };
    }

    // 401/403 (auth) or 5xx (server) — a probe failure we can't interpret as "gone". Retryable.
    return restError<KvHeadData>(cid, res.status, `CF KV head returned HTTP ${res.status}`);
  }

  /**
   * Read ONE key's value + metadata from the site's OWN KV namespace. The value comes from the CF REST
   * `GET .../values/{key}` (returns the raw body + `expiration`/`metadata` headers). A `404` is an
   * HONEST "key not found" (KV is eventually-consistent — a just-written key may 404 briefly), returned
   * as `{ found: false }`, NOT an error. Oversized values are flagged `truncated`, never silently
   * dropped. The key is URL-encoded before it touches the path (never interpolated raw).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can read
   * @param input - `{ key }` — the exact key to read
   */
  async get(scope: ResolvedScope, input: KvGetInput): Promise<AdapterResult<KvGetData>> {
    const cid = correlationId();
    const namespaceId = scope.resourceId;
    const key = input?.key;
    if (typeof key !== 'string' || key.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_key', message: 'Key is missing or empty.', retryable: false },
        ok: false,
      };
    }

    const encoded = encodeURIComponent(key);
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${namespaceId}/values/${encoded}`,
        {
          headers: { ...cfAuthHeaders(scope.auth) },
          method: 'GET',
        },
      );
    } catch (err) {
      return restError<KvGetData>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }

    // Eventual-consistency / genuine miss — an honest "not found", never an error envelope.
    if (res.status === 404) {
      return { correlationId: cid, data: { found: false, key }, ok: true };
    }
    if (!res.ok) {
      return restError<KvGetData>(cid, res.status, `CF KV value get returned HTTP ${res.status}`);
    }

    // Metadata rides in a response header on the values endpoint; parse it defensively.
    let metadata: Record<string, unknown> | undefined;
    const metaHeader = res.headers.get('x-kv-metadata') ?? res.headers.get('cf-kv-metadata');
    if (metaHeader) {
      try {
        const parsed = JSON.parse(metaHeader) as unknown;
        if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
      } catch {
        // Malformed metadata header — omit it rather than fail the read.
      }
    }

    // Guard the buffered value size — never buffer an arbitrarily large body inline.
    const lenHeader = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(lenHeader) && lenHeader > GET_MAX_VALUE_BYTES) {
      return { correlationId: cid, data: { found: true, key, metadata, truncated: true }, ok: true };
    }
    const value = await res.text();
    if (value.length > GET_MAX_VALUE_BYTES) {
      return { correlationId: cid, data: { found: true, key, metadata, truncated: true }, ok: true };
    }
    return { correlationId: cid, data: { found: true, key, metadata, value }, ok: true };
  }

  /**
   * Probe whether ONE key currently HAS a value in the site's OWN KV namespace (a cheap `HEAD` on the
   * values endpoint). Returns `true`/`false` on a definitive answer, or `undefined` when the probe itself
   * failed (auth/5xx/network) — the caller must NOT interpret an indeterminate probe as "absent" (that would
   * let an overwrite skip its confirm gate on a transient blip). Used to decide whether a `put`/`delete`
   * needs `confirm:true` and to report the honest before-state.
   */
  private async keyExists(scope: ResolvedScope, key: string): Promise<boolean | undefined> {
    const encoded = encodeURIComponent(key);
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${scope.resourceId}/values/${encoded}`,
        { headers: { ...cfAuthHeaders(scope.auth) }, method: 'HEAD' },
      );
    } catch {
      return undefined; // network failure — indeterminate, never "absent".
    }
    if (res.status === 404) return false;
    if (res.ok) return true;
    return undefined; // auth/5xx — indeterminate.
  }

  /**
   * Run a NAMED mutation against the site's OWN KV namespace (the FIRST write slice). `put` writes one
   * key's value (optional TTL + metadata); `delete` removes one key. Both operate ONLY on
   * `scope.resourceId` (server-resolved upstream — this adapter accepts NO namespace id and cannot be
   * redirected). Guarding (SECURITY-INVARIANTS INV-9/INV-11): a `delete`, and a `put` that would OVERWRITE
   * an existing key, are destructive of the prior value and REQUIRE `confirm:true`; without it the mutation
   * returns a typed `confirmation_required` envelope that REPORTS what WOULD change (the key + whether it
   * exists) and writes NOTHING. Every payload is validated here (key non-empty + bounded, value bounded,
   * TTL ≥ CF's 60s minimum). Returns a typed {@link KvMutateResult} describing what actually changed.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can write
   * @param input - the discriminated `{ action:'put'|'delete', … }` mutation
   */
  async mutate(scope: ResolvedScope, input: KvMutateInput): Promise<AdapterResult<KvMutateResult>> {
    const cid = correlationId();

    if (!input || (input.action !== 'put' && input.action !== 'delete')) {
      return {
        correlationId: cid,
        error: { code: 'invalid_action', message: 'Unknown KV mutation action.', retryable: false },
        ok: false,
      };
    }

    const key = input.key;
    if (typeof key !== 'string' || key.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_key', message: 'Key is missing or empty.', retryable: false },
        ok: false,
      };
    }
    if (new TextEncoder().encode(key).length > KEY_MAX_BYTES) {
      return {
        correlationId: cid,
        error: {
          code: 'invalid_key',
          message: `Key exceeds the ${KEY_MAX_BYTES}-byte KV limit.`,
          retryable: false,
        },
        ok: false,
      };
    }
    const encoded = encodeURIComponent(key);

    if (input.action === 'delete') {
      // DESTRUCTIVE — require confirm. Report whether the key exists so the caller knows what they're removing.
      if (input.confirm !== true) {
        const exists = await this.keyExists(scope, key);
        return {
          correlationId: cid,
          error: {
            code: 'confirmation_required',
            message: `Deleting KV key "${key}" is destructive${
              exists === true ? ' (the key currently exists)' : exists === false ? ' (the key does not currently exist)' : ''
            }. Re-run with confirm:true to delete it.`,
            retryable: false,
          },
          ok: false,
        };
      }
      // Probe existence BEFORE the delete so the result honestly reports whether it existed (delete is
      // idempotent — deleting an absent key still 200s). An indeterminate probe → report existed:false-unknown
      // conservatively as false; the delete still runs.
      const existedBefore = await this.keyExists(scope, key);
      let res: Response;
      try {
        res = await fetch(
          `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${scope.resourceId}/values/${encoded}`,
          { headers: { ...cfAuthHeaders(scope.auth) }, method: 'DELETE' },
        );
      } catch (err) {
        return restError<KvMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
      }
      // A 404 on delete means the key was already gone — an idempotent success, not an error.
      if (!res.ok && res.status !== 404) {
        return restError<KvMutateResult>(cid, res.status, `CF KV delete returned HTTP ${res.status}`);
      }
      return {
        correlationId: cid,
        data: { action: 'delete', existed: existedBefore === true, key },
        ok: true,
      };
    }

    // action === 'put'
    const value = input.value;
    if (typeof value !== 'string') {
      return {
        correlationId: cid,
        error: { code: 'invalid_value', message: 'A string value is required for put.', retryable: false },
        ok: false,
      };
    }
    if (new TextEncoder().encode(value).length > PUT_MAX_VALUE_BYTES) {
      return {
        correlationId: cid,
        error: {
          code: 'value_too_large',
          message: 'Value exceeds the 25 MiB KV value limit.',
          retryable: false,
        },
        ok: false,
      };
    }
    let expirationTtl: number | undefined;
    if (input.expirationTtl !== undefined) {
      if (typeof input.expirationTtl !== 'number' || !Number.isFinite(input.expirationTtl)) {
        return {
          correlationId: cid,
          error: { code: 'invalid_ttl', message: 'expirationTtl must be a number of seconds.', retryable: false },
          ok: false,
        };
      }
      expirationTtl = Math.floor(input.expirationTtl);
      if (expirationTtl < KV_MIN_EXPIRATION_TTL) {
        return {
          correlationId: cid,
          error: {
            code: 'invalid_ttl',
            message: `expirationTtl must be at least ${KV_MIN_EXPIRATION_TTL} seconds (CF KV minimum).`,
            retryable: false,
          },
          ok: false,
        };
      }
    }

    // Determine overwrite state to gate the confirm + report the honest before-state. An INDETERMINATE
    // probe fails CLOSED for the confirm gate (treat as "might exist") so a transient blip can't let an
    // unconfirmed overwrite through.
    const existsBefore = await this.keyExists(scope, key);
    if (existsBefore !== false && input.confirm !== true) {
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `KV key "${key}" already exists — writing overwrites its current value. Re-run with confirm:true to overwrite.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // CF KV value PUT: raw body is the value; TTL rides as a query param; metadata rides as multipart, but
    // the single-value endpoint also accepts a `metadata` FORM field alongside `value`. We use multipart
    // form-data ONLY when metadata is present (so a plain value is a clean raw PUT); TTL is always a query param.
    const url = new URL(
      `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${scope.resourceId}/values/${encoded}`,
    );
    if (expirationTtl !== undefined) url.searchParams.set('expiration_ttl', String(expirationTtl));

    let res: Response;
    const hasMetadata = input.metadata !== undefined && input.metadata !== null;
    try {
      if (hasMetadata) {
        const form = new FormData();
        form.set('value', value);
        form.set('metadata', JSON.stringify(input.metadata));
        res = await fetch(url.toString(), {
          body: form,
          headers: { ...cfAuthHeaders(scope.auth) }, // let fetch set the multipart boundary content-type
          method: 'PUT',
        });
      } else {
        res = await fetch(url.toString(), {
          body: value,
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'text/plain' },
          method: 'PUT',
        });
      }
    } catch (err) {
      return restError<KvMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: unknown } | null;
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<KvMutateResult>(cid, res.status, `CF KV put failed: ${detail}`);
    }
    return {
      correlationId: cid,
      data: {
        action: 'put',
        key,
        metadataStored: hasMetadata,
        overwritten: existsBefore === true,
        ...(expirationTtl !== undefined ? { expirationTtl } : {}),
      },
      ok: true,
    };
  }
}

/** The singleton `kv` adapter instance the reconciler + registry look up by kind. */
export const kvAdapter = new KvAdapter();
