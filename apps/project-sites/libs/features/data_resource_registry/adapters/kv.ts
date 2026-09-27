/**
 * @module libs/features/data_resource_registry/adapters/kv
 * @description The `kv` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 3 (KV read) slice.
 *
 * Implements the read verbs against a site's OWN dedicated Cloudflare KV namespace: `list` (its keys,
 * cursor-paginated + honest `list_complete`, NEVER a fabricated total), `head` (existence probe),
 * `get` (one key's value + metadata) — PLUS the first WRITE slice: `mutate({action:'put'|'delete'})`.
 * `mutate` is a discriminated NAMED-mutation union (never a `runAnything`/`{command}` mega-verb —
 * tool-design-as-api): `put` writes one key's value (optional TTL + metadata), `delete` removes one key,
 * `bulk_delete` removes MANY keys in one CF bulk request (clamped/rejected at the 10k CF cap). The
 * destructive verbs are guarded — an OVERWRITE (put over an existing key), a `delete`, and a `bulk_delete`
 * are destructive of the prior value(s), so each REQUIRES an explicit `confirm:true`; without it `mutate`
 * returns a typed `confirmation_required` envelope that REPORTS what WOULD change (the key, or the COUNT
 * for bulk) and writes nothing (SECURITY-INVARIANTS INV-9/INV-11). `bulkGet` is the read companion of
 * `get` — MANY keys at once (clamped to the CF cap, honest per-key miss); `provision`/`destroy` land later.
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
import {
  runProvisionMutation,
  type ProvisionInput,
  type ProvisionMutateResult,
} from '../provision_mutation.js';

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

/**
 * CF KV bulk API hard cap: a single bulk write/delete request accepts at most 10,000 keys
 * (https://developers.cloudflare.com/kv/api/write-key-value-pairs/#write-multiple-key-value-pairs).
 * We CLAMP a bulk_get page to this same bound; we REJECT an over-cap bulk_delete with an honest message
 * (a silent truncation of a DESTRUCTIVE op would delete a different set than the caller asked for).
 */
const BULK_MAX_KEYS = 10_000;

/**
 * The `bulk_delete` mutation input: remove MANY keys from the site's OWN KV namespace in one call.
 * DESTRUCTIVE — `confirm:true` is REQUIRED (INV-9/INV-11): without it, `mutate` returns a typed
 * `confirmation_required` envelope that REPORTS the count that WOULD be removed and deletes nothing.
 * Over the {@link BULK_MAX_KEYS} CF cap is REJECTED (never silently truncated — a partial destructive op
 * would remove a different set than requested).
 */
export interface KvBulkDeleteInput {
  readonly action: 'bulk_delete';
  /** The keys to delete (1..={@link BULK_MAX_KEYS}); over the cap is an honest `bulk_limit_exceeded` error. */
  readonly keys: readonly string[];
  /** Must be `true` to actually delete (destructive-op gate); without it the count is REPORTED, nothing deleted. */
  readonly confirm?: boolean;
}

/** The `bulk_get` read input: fetch MANY keys' values at once. `keys` is CLAMPED to {@link BULK_MAX_KEYS}. */
export interface KvBulkGetInput {
  /** The keys to read; a page over {@link BULK_MAX_KEYS} is CLAMPED (a read is non-destructive). */
  readonly keys: readonly string[];
}

/** One entry in a `bulk_get` response: the key + whether it was found + its value (honest per-key miss). */
export interface KvBulkGetValue {
  readonly key: string;
  /** True when the key exists in the namespace; false → `value` absent (an honest per-key miss). */
  readonly found: boolean;
  /** The raw value string when found; absent on a miss. */
  readonly value?: string;
}

/** What a `bulk_get` returns: one honest {@link KvBulkGetValue} per REQUESTED key + how many were clamped off. */
export interface KvBulkGetData {
  readonly values: readonly KvBulkGetValue[];
  /** Count of keys found (a value was returned). */
  readonly found: number;
  /** Count of requested keys that were missing. */
  readonly missing: number;
  /** How many keys past {@link BULK_MAX_KEYS} were dropped from an over-cap request (0 when within cap). */
  readonly clampedOff: number;
}

/** What a `bulk_delete` returns: how many keys were requested + submitted for deletion (honest, not fabricated). */
export interface KvBulkDeleteResult {
  readonly action: 'bulk_delete';
  /** Count of unique keys the CF bulk-delete request removed. */
  readonly requested: number;
}

/** The discriminated named-mutation union for the kv adapter — NEVER a generic `{ command }` field. */
export type KvMutateInput = KvPutInput | KvDeleteInput | KvBulkDeleteInput | ProvisionInput;

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
export type KvMutateResult = KvPutResult | KvDeleteResult | KvBulkDeleteResult | ProvisionMutateResult;

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
 * Normalize a bulk key list: coerce to an array of non-empty strings, drop blanks, de-duplicate (a
 * repeated key in a bulk op is one operation), and CLAMP to {@link BULK_MAX_KEYS} (returning how many were
 * dropped so the caller can report it honestly). A read (`bulk_get`) clamps silently-but-reported; a
 * destructive `bulk_delete` uses this only AFTER its own over-cap REJECTION so it never truncates a delete.
 */
function normalizeBulkKeys(keys: readonly string[] | undefined): { keys: string[]; clampedOff: number } {
  if (!Array.isArray(keys)) return { clampedOff: 0, keys: [] };
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k === 'string' && k.length > 0) seen.add(k);
  }
  const unique = Array.from(seen);
  if (unique.length <= BULK_MAX_KEYS) return { clampedOff: 0, keys: unique };
  return { clampedOff: unique.length - BULK_MAX_KEYS, keys: unique.slice(0, BULK_MAX_KEYS) };
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
   * verbs, and the `put`/`delete`/`bulk_delete`/`provision` named mutations. `bulk_get` is a read
   * companion of `get` (many keys at once) — exposed as the {@link KvAdapter.bulkGet} method, not a
   * mutate action (it changes nothing). Only wired verbs are listed so the UI/MCP never offer a dead verb.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['put', 'delete', 'bulk_delete', 'provision'] as const,
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

    // PROVISION runs BEFORE the put/delete handling: it CREATES the namespace, so `scope.resourceId` is
    // empty (the id is the output). Delegated to the shared provision bridge (idempotency → quota →
    // provisioner → registry record → recoverable partial).
    if (input && input.action === 'provision') {
      return runProvisionMutation(cid, scope, 'kv', input);
    }

    // BULK_DELETE — remove MANY keys in ONE CF bulk request. Destructive → confirm gate REPORTS the count.
    if (input && input.action === 'bulk_delete') {
      return this.bulkDelete(cid, scope, input);
    }

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

  /**
   * DELETE MANY keys from the site's OWN KV namespace in ONE CF bulk request
   * (`DELETE .../storage/kv/namespaces/{id}/bulk` with a JSON array body). DESTRUCTIVE — `confirm:true`
   * is REQUIRED (INV-9/INV-11): without it we return a typed `confirmation_required` envelope that REPORTS
   * the count that WOULD be removed and deletes NOTHING. An over-{@link BULK_MAX_KEYS} request is REJECTED
   * (`bulk_limit_exceeded`) rather than truncated — a partial destructive op would remove a DIFFERENT set
   * than the caller asked for. Empty/blank/duplicate keys are normalized out first; an empty effective set
   * is an honest `no_keys` rejection (never a fabricated success). Operates ONLY on `scope.resourceId`.
   */
  private async bulkDelete(
    cid: string,
    scope: ResolvedScope,
    input: KvBulkDeleteInput,
  ): Promise<AdapterResult<KvMutateResult>> {
    // Count UNIQUE non-empty keys BEFORE clamping so the over-cap check sees the caller's true intent.
    const uniqueRequested = new Set(
      (Array.isArray(input.keys) ? input.keys : []).filter((k) => typeof k === 'string' && k.length > 0),
    );
    if (uniqueRequested.size === 0) {
      return {
        correlationId: cid,
        error: { code: 'no_keys', message: 'No keys to delete.', retryable: false },
        ok: false,
      };
    }
    // REJECT (never truncate) an over-cap destructive request — honest, actionable message.
    if (uniqueRequested.size > BULK_MAX_KEYS) {
      return {
        correlationId: cid,
        error: {
          code: 'bulk_limit_exceeded',
          message: `Bulk delete accepts at most ${BULK_MAX_KEYS} keys per request (received ${uniqueRequested.size}). Split into smaller batches.`,
          retryable: false,
        },
        ok: false,
      };
    }
    const keys = Array.from(uniqueRequested);
    // DESTRUCTIVE gate — REPORT the count that would be removed; delete nothing without confirm.
    if (input.confirm !== true) {
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `Bulk-deleting ${keys.length} KV ${keys.length === 1 ? 'key' : 'keys'} is destructive. Re-run with confirm:true to remove ${keys.length === 1 ? 'it' : 'them'}.`,
          retryable: false,
        },
        ok: false,
      };
    }

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${scope.resourceId}/bulk`,
        {
          body: JSON.stringify(keys),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'DELETE',
        },
      );
    } catch (err) {
      return restError<KvMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: unknown } | null;
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<KvMutateResult>(cid, res.status, `CF KV bulk delete failed: ${detail}`);
    }
    return {
      correlationId: cid,
      data: { action: 'bulk_delete', requested: keys.length },
      ok: true,
    };
  }

  /**
   * Read MANY keys' values from the site's OWN KV namespace in ONE CF bulk request
   * (`GET .../storage/kv/namespaces/{id}/bulk/get`, body `{ keys: [...] }`). Non-destructive → NO confirm.
   * The `keys` list is CLAMPED to {@link BULK_MAX_KEYS} (and de-duplicated), and the returned
   * {@link KvBulkGetData.clampedOff} REPORTS how many were dropped — never a silent truncation. Every
   * REQUESTED (post-clamp) key gets an honest entry: `found:true` with its value, or `found:false` on a
   * miss (KV is eventually-consistent — a just-written key can be absent briefly). Operates ONLY on
   * `scope.resourceId`. An empty effective key set is an honest empty result, never an error.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can read
   * @param input - `{ keys }` — the exact keys to read (clamped to the CF cap)
   */
  async bulkGet(scope: ResolvedScope, input: KvBulkGetInput): Promise<AdapterResult<KvBulkGetData>> {
    const cid = correlationId();
    const { clampedOff, keys } = normalizeBulkKeys(input?.keys);
    if (keys.length === 0) {
      return { correlationId: cid, data: { clampedOff, found: 0, missing: 0, values: [] }, ok: true };
    }

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/storage/kv/namespaces/${scope.resourceId}/bulk/get`,
        {
          body: JSON.stringify({ keys }),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'GET',
        },
      );
    } catch (err) {
      return restError<KvBulkGetData>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      // CF returns { result: { values: { key: value | {value,...} }, ... } } for bulk/get.
      result?: { values?: Record<string, unknown> } | Record<string, unknown> | null;
      errors?: unknown;
    } | null;

    if (!res.ok || !json?.success) {
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<KvBulkGetData>(cid, res.status, `CF KV bulk get failed: ${detail}`);
    }

    // The values map may sit under result.values or be the result itself; a MISS is an absent/null entry.
    const resultObj = (json.result ?? {}) as Record<string, unknown>;
    const rawValues = (('values' in resultObj ? resultObj.values : resultObj) ?? {}) as Record<string, unknown>;

    let found = 0;
    let missing = 0;
    const values: KvBulkGetValue[] = keys.map((key) => {
      const raw = Object.prototype.hasOwnProperty.call(rawValues, key) ? rawValues[key] : undefined;
      if (raw === undefined || raw === null) {
        missing += 1;
        return { found: false, key };
      }
      // CF may return the bare string, or an object { value, metadata } depending on API options.
      const value =
        typeof raw === 'string'
          ? raw
          : typeof (raw as { value?: unknown }).value === 'string'
            ? String((raw as { value?: unknown }).value)
            : JSON.stringify(raw);
      found += 1;
      return { found: true, key, value };
    });

    return { correlationId: cid, data: { clampedOff, found, missing, values }, ok: true };
  }
}

/** The singleton `kv` adapter instance the reconciler + registry look up by kind. */
export const kvAdapter = new KvAdapter();
