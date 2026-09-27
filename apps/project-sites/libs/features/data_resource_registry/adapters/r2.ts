/**
 * @module libs/features/data_resource_registry/adapters/r2
 * @description The `r2` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 3 (R2 read) slice.
 *
 * Implements the read verbs against a site's OWN dedicated Cloudflare R2 bucket: `list` (its objects,
 * prefix + continuation-token paginated + honest `truncated`/`cursor`, NEVER a fabricated total),
 * `head` (bucket existence probe), `get` (ONE object's METADATA — size/etag/content-type/uploaded +
 * http + custom metadata — NOT the object bytes this pass). `mutate` returns a typed `not_implemented`
 * envelope (this pass is READ-ONLY) — never a raw throw, never a `runAnything` mega-verb
 * (tool-design-as-api). put/delete/bulk_delete/provision/destroy land in the write pass (append to
 * `supports.mutations` + implement `mutate` in the same fire).
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` / the `d1` + `kv` adapters:
 *  - Every verb operates ONLY on the `scope.resourceId` it was minted with. For R2 that id is the
 *    site's dedicated BUCKET NAME (R2 has no uuid — the name is the identifier), SERVER-RESOLVED
 *    upstream (`service.resolveResourceRef` / the site's `site_database_allocations.r2_bucket_name`
 *    row) — it is NEVER a caller-supplied name. This adapter accepts NO bucket parameter and does NOT
 *    re-resolve.
 *  - Execution goes through the CF **R2 REST API** (`/accounts/{acct}/r2/buckets/{bucket}/...`) bound to
 *    `scope.resourceId` — a Worker can't statically bind thousands of per-site R2 buckets, and the
 *    account-wide R2 S3 credentials are NEVER sent to a client.
 *  - The SHARED platform bucket (`env.SITES_BUCKET`, where `sites/{slug}/…` static assets live) is a
 *    SEPARATE surface — this adapter never touches it and never exposes its name. A per-site bucket
 *    holds the CUSTOMER's own R2 objects, distinct from the DEPLOYED WORKER STATIC ASSETS served from
 *    the shared bucket.
 *
 * DEPLOYED STATIC ASSETS vs R2 OBJECTS (directive) — this adapter surfaces a site's dedicated R2
 * bucket, the customer's own object store. That is NOT the platform's deployed-site static assets
 * (those live under the shared `sites/{slug}/{version}/…` prefix and are served by `site_serving.ts`).
 * The two must never be conflated: this adapter can only ever address the per-site bucket name the
 * scope carries.
 *
 * OBJECT `get` RETURNS METADATA ONLY (directive) — for an object, `get` returns size/etag/
 * content-type/uploaded + http + custom metadata; it does NOT embed the raw bytes in the adapter/MCP
 * response. Large transfers must go through an authorized handle/URL (a signed R2 URL) in a LATER
 * pass — buffering an arbitrarily large object into a JSON envelope would blow the Worker's memory and
 * is not a shape an MCP tool should return. The metadata is enough for the Data tab's object browser;
 * a "download this object" affordance mints a short-lived signed URL server-side (future increment).
 *
 * HONEST "not available": a blank site has NO R2 allocation yet (per-site R2 provisioning is
 * backend-ready via `r2_provisioner.ts` but INERT until wired behind `per_site_r2`). When the resolver
 * can't produce a bucket name, the caller gets `not_registered`/`not_provisioned` UPSTREAM — this
 * adapter is only ever invoked with a real resolved name. If a verb's CF call reports the bucket is
 * gone, `head` returns `exists:false` (→ drift), matching the `d1`/`kv` adapters' contract.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard bounds on a `list` page so a caller can never pull an unbounded object dump (R2 REST max = 1000). */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 1000;
const LIST_LIMIT_DEFAULT = 100;

/** What an R2 `head` returns: whether the bucket exists + a little CF metadata when it does. */
export interface R2HeadData {
  /** True when CF confirms the bucket exists (a `200` from the R2 bucket GET). */
  readonly exists: boolean;
  /** The probed bucket name (echoed for the caller's audit — it came from the scope, not the caller). */
  readonly bucketName: string;
  /** CF-reported creation timestamp, when present in the `200` body. */
  readonly createdAt?: string;
  /** CF-reported storage location hint, when present. */
  readonly location?: string;
}

/**
 * One object as CF's `GET .../objects` reports it in a list page. Only the light per-object fields the
 * list endpoint returns (key + size + etag + upload time); the full http/custom metadata is fetched
 * per-object via {@link R2Adapter.get}, not in the list.
 */
export interface R2ObjectInfo {
  readonly key: string;
  /** Size in bytes. */
  readonly size: number;
  /** The object's ETag (content hash), when present. */
  readonly etag?: string;
  /** Last-modified / upload timestamp (ISO 8601), when present. */
  readonly uploaded?: string;
}

/**
 * What an R2 `list` returns: a page of objects + HONEST pagination — `truncated` (are there more?) and
 * the opaque `cursor` (continuation token) for the next page. NO fabricated total (the R2 REST list
 * endpoint cannot count without paging every object — per the
 * `paginated-endpoint-silent-cap-needs-total` / capability-matrix "no fake total" rule).
 */
export interface R2ListData {
  readonly objects: readonly R2ObjectInfo[];
  /** True when more pages remain (CF `result_info.is_truncated`). */
  readonly truncated: boolean;
  /** Opaque continuation token for the NEXT page; absent/empty on the last page. */
  readonly cursor?: string;
}

/** The `list` input: an optional page window (prefix + cursor + limit; bounds clamped server-side). */
export interface R2ListInput {
  /** Object-key prefix filter (R2 lists by prefix). */
  readonly prefix?: string;
  /** Opaque continuation token from a previous page's `cursor`. */
  readonly cursor?: string;
  /** Page size, clamped to `[1, 1000]` (default 100). */
  readonly limit?: number;
}

/** The `get` input: which object's METADATA to read (never the bytes this pass). */
export interface R2GetInput {
  readonly key: string;
}

/**
 * What an R2 `get` returns: ONE object's METADATA — never the raw bytes. Size/etag/content-type/
 * uploaded + the http + custom metadata maps. `found:false` when the object does not exist.
 */
export interface R2GetData {
  readonly key: string;
  /** True when the object exists; false → the other fields are absent (an honest miss, not an error). */
  readonly found: boolean;
  /** Size in bytes, when found. */
  readonly size?: number;
  /** The object's ETag (content hash), when found. */
  readonly etag?: string;
  /** The stored content-type (from the object's http metadata), when found. */
  readonly contentType?: string;
  /** Last-modified / upload timestamp (ISO 8601), when found. */
  readonly uploaded?: string;
  /** The object's HTTP metadata (content-disposition, cache-control, …), when present. */
  readonly httpMetadata?: Record<string, unknown>;
  /** The object's custom metadata map, when present. */
  readonly customMetadata?: Record<string, unknown>;
  /**
   * Always true for this pass — a reminder to the caller that only METADATA was returned, never the
   * object bytes. A future pass mints a signed URL for the actual download (see module docs).
   */
  readonly metadataOnly: true;
}

/** Placeholder mutate payloads — this pass is read-only; put/delete/provision land later. */
type R2MutateInput = never;
type R2MutateResult = never;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `r2-${crypto.randomUUID()}`;
}

/**
 * Map an R2 REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a `5xx`/network
 * error is retryable (transient — never interpret as "gone"); anything else is a hard failure the UI
 * surfaces as-is. Mirrors the `kv` adapter's `restError`.
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

/** The typed `not_implemented` envelope every read-only-pass-unfilled verb returns. */
function notImplemented<T>(verb: string): AdapterResult<T> {
  return {
    correlationId: correlationId(),
    error: {
      code: 'not_implemented',
      message: `The r2 adapter '${verb}' verb is not implemented yet.`,
      retryable: false,
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
 * Normalize a CF-reported metadata bag (http or custom) into a plain object, or `undefined` when the
 * source is empty/absent. Defensive: R2 REST may return `null`, `{}`, or a populated object.
 */
function metaOrUndefined(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && Object.keys(raw as object).length > 0) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The `r2` adapter. `list`/`head`/`get` are live (read-only, `get` = METADATA only); `mutate` returns
 * `not_implemented`. `supports` declares that honestly so the UI + MCP never offer a verb that would 501.
 */
class R2Adapter
  implements ResourceAdapter<R2ListData, R2HeadData, R2GetData, R2MutateInput, R2MutateResult>
{
  readonly kind = 'r2' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): r2 serves both environments and all three read
   * verbs. `mutations: []` — this pass is read-only; put/delete/bulk_delete/provision/destroy land in the
   * write pass (append them here + implement `mutate` in the same fire).
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['list', 'head', 'get'] as const,
  };

  /**
   * Enumerate the site's OWN objects via the CF R2 REST `GET .../objects` — prefix + continuation-token
   * paginated. Returns the page of objects + HONEST `truncated` + `cursor` (never a fabricated total; the
   * R2 REST list endpoint can't count without paging every object). A blank per-site bucket reads as an
   * empty page with `truncated:false` (the Data tab's empty state), never an error.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY bucket this can enumerate
   * @param input - optional `{ prefix?, cursor?, limit? }` — `limit` clamped to `[1, 1000]`
   */
  async list(scope: ResolvedScope, input?: R2ListInput): Promise<AdapterResult<R2ListData>> {
    const cid = correlationId();
    const bucketName = scope.resourceId;
    const limit = clampLimit(input?.limit);

    const url = new URL(
      `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
    );
    url.searchParams.set('per_page', String(limit));
    if (input?.prefix) url.searchParams.set('prefix', input.prefix);
    if (input?.cursor) url.searchParams.set('cursor', input.cursor);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
        method: 'GET',
      });
    } catch (err) {
      return restError<R2ListData>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ key: string; size?: number; etag?: string; uploaded?: string }>;
      result_info?: { cursor?: string; is_truncated?: boolean };
      errors?: unknown;
    } | null;

    if (!res.ok || !json?.success) {
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<R2ListData>(cid, res.status, `CF R2 objects list failed: ${detail}`);
    }

    const objects: R2ObjectInfo[] = (json.result ?? []).map((o) => ({
      etag: o.etag,
      key: o.key,
      size: typeof o.size === 'number' ? o.size : 0,
      uploaded: o.uploaded,
    }));
    // CF signals "more pages" via result_info.is_truncated + a continuation cursor. An absent/empty
    // cursor or is_truncated=false means this is the last page. HONEST completeness — no invented total.
    const rawCursor = json.result_info?.cursor ?? '';
    const truncated = json.result_info?.is_truncated === true && rawCursor.length > 0;
    return {
      correlationId: cid,
      data: { cursor: truncated ? rawCursor : undefined, objects, truncated },
      ok: true,
    };
  }

  /**
   * Cheap existence/metadata probe of the site's OWN R2 bucket via the CF REST bucket GET. The name lives
   * in `scope.resourceId` (resolved server-side), the account is `scope.accountId`, and auth is
   * `scope.auth`. Never accepts a caller name. Mirrors the `d1`/`kv` adapters' `head` contract.
   *
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/non-auth `4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<R2HeadData>> {
    const cid = correlationId();
    const bucketName = scope.resourceId;

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
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
        result?: { name?: string; creation_date?: string; location?: string };
      } | null;
      return {
        correlationId: cid,
        data: {
          bucketName,
          createdAt: json?.result?.creation_date,
          exists: true,
          location: json?.result?.location,
        },
        ok: true,
      };
    }

    // 404 (and other non-auth 4xx) => the bucket our row claims does not exist on CF => drift.
    if (
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)
    ) {
      return { correlationId: cid, data: { bucketName, exists: false }, ok: true };
    }

    // 401/403 (auth) or 5xx (server) — a probe failure we can't interpret as "gone". Retryable.
    return restError<R2HeadData>(cid, res.status, `CF R2 head returned HTTP ${res.status}`);
  }

  /**
   * Read ONE object's METADATA (size/etag/content-type/uploaded + http + custom metadata) from the site's
   * OWN R2 bucket via the CF REST `GET .../objects/{key}`. **Returns METADATA ONLY — never the object
   * bytes** (see module docs: large transfers use a signed URL in a later pass). A `404` is an HONEST
   * "object not found", returned as `{ found: false }`, NOT an error. The key is URL-encoded before it
   * touches the path (never interpolated raw).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY bucket this can read
   * @param input - `{ key }` — the exact object key whose metadata to read
   */
  async get(scope: ResolvedScope, input: R2GetInput): Promise<AdapterResult<R2GetData>> {
    const cid = correlationId();
    const bucketName = scope.resourceId;
    const key = input?.key;
    if (typeof key !== 'string' || key.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_key', message: 'Object key is missing or empty.', retryable: false },
        ok: false,
      };
    }

    const encoded = encodeURIComponent(key);
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encoded}`,
        {
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'GET',
        },
      );
    } catch (err) {
      return restError<R2GetData>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }

    // Genuine miss — an honest "not found", never an error envelope.
    if (res.status === 404) {
      return { correlationId: cid, data: { found: false, key, metadataOnly: true }, ok: true };
    }
    if (!res.ok) {
      return restError<R2GetData>(cid, res.status, `CF R2 object metadata get returned HTTP ${res.status}`);
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: {
        key?: string;
        size?: number;
        etag?: string;
        uploaded?: string;
        http_metadata?: Record<string, unknown> | null;
        custom_metadata?: Record<string, unknown> | null;
      };
    } | null;

    if (!json?.success || !json.result) {
      return restError<R2GetData>(cid, res.status, 'CF R2 object metadata get returned no result');
    }

    const r = json.result;
    const http = metaOrUndefined(r.http_metadata);
    // The stored content-type rides inside http_metadata on the R2 REST metadata response.
    const contentType =
      typeof http?.['contentType'] === 'string'
        ? (http['contentType'] as string)
        : typeof http?.['content_type'] === 'string'
          ? (http['content_type'] as string)
          : undefined;
    return {
      correlationId: cid,
      data: {
        contentType,
        customMetadata: metaOrUndefined(r.custom_metadata),
        etag: r.etag,
        found: true,
        httpMetadata: http,
        key,
        metadataOnly: true,
        size: typeof r.size === 'number' ? r.size : undefined,
        uploaded: r.uploaded,
      },
      ok: true,
    };
  }

  /** Not implemented in this read pass — put/delete/bulk_delete/provision/destroy land in the write pass. */
  async mutate(_scope: ResolvedScope, _input: R2MutateInput): Promise<AdapterResult<R2MutateResult>> {
    return notImplemented<R2MutateResult>('mutate');
  }
}

/** The singleton `r2` adapter instance the reconciler + registry look up by kind. */
export const r2Adapter = new R2Adapter();
