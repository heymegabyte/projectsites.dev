/**
 * @module libs/features/data_resource_registry/adapters/r2
 * @description The `r2` {@link ResourceAdapter} — Data & Resource Platform §5, Phase 3 (R2 read) slice
 * PLUS the first WRITE slice (`mutate({action:'put'|'delete'})`), mirroring the `kv` adapter exactly.
 *
 * Implements the read verbs against a site's OWN dedicated Cloudflare R2 bucket: `list` (its objects,
 * prefix + continuation-token paginated + honest `truncated`/`cursor`, NEVER a fabricated total),
 * `head` (bucket existence probe), `get` (ONE object's METADATA — size/etag/content-type/uploaded +
 * http + custom metadata — NOT the object bytes) — PLUS the first WRITE slice: `mutate` is a
 * discriminated NAMED-mutation union (never a `runAnything`/`{command}` mega-verb — tool-design-as-api):
 * `put` writes one SMALL object's bytes (optional content-type + http/custom metadata), `delete` removes
 * one object. Both are guarded — an OVERWRITE (put over an existing object) and a DELETE are destructive
 * of the prior object, so each REQUIRES an explicit `confirm:true`; without it `mutate` returns a typed
 * `confirmation_required` envelope that REPORTS what WOULD change (the key + whether it exists) and writes
 * NOTHING (SECURITY-INVARIANTS INV-9/INV-11). bulk_delete/provision/destroy remain future verbs.
 *
 * LARGE / MULTIPART objects are NOT embedded (directive + INV-6/§Static-Assets): `put` caps inline bytes
 * at {@link PUT_MAX_INLINE_BYTES}; a larger object returns a typed `object_too_large` envelope whose
 * message NOTES that a short-lived SCOPED upload URL (a signed R2 URL, a LATER pass) is required — the
 * adapter NEVER buffers an arbitrarily large body into a JSON request nor embeds raw bytes, and the
 * account-wide R2 credentials NEVER reach the client. The multipart/presigned-upload path is an honest
 * future increment; this pass writes small objects directly and is explicit about the boundary.
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
import {
  runProvisionMutation,
  type ProvisionInput,
  type ProvisionMutateResult,
} from '../provision_mutation.js';

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

/**
 * Max object bytes `put` will accept INLINE. A larger object is NOT embedded — it returns
 * `object_too_large` noting a short-lived SCOPED (signed) upload URL is required (a later pass). This
 * keeps the adapter from buffering an arbitrarily large body into a JSON request (INV-6 / directive) and
 * keeps `put` a shape an MCP tool can safely return. R2 objects can be far larger (multipart to 5 TiB);
 * that path is presigned-URL, not inline-bytes.
 */
const PUT_MAX_INLINE_BYTES = 25 * 1024 * 1024;

/** Hard bound on an object key's length (R2 keys are ≤1024 bytes UTF-8). */
const KEY_MAX_BYTES = 1024;

/**
 * The `put` mutation input: write ONE SMALL object's bytes to the site's OWN R2 bucket, with optional
 * content-type + http/custom metadata. `confirm` is REQUIRED when the object already exists (an overwrite
 * is destructive of the prior object — INV-9/INV-11): without it, `mutate` returns `confirmation_required`
 * and REPORTS the key + that it exists, changing nothing. Bodies larger than {@link PUT_MAX_INLINE_BYTES}
 * are rejected with `object_too_large` (use a signed upload URL — a later pass), NEVER embedded.
 */
export interface R2PutInput {
  readonly action: 'put';
  readonly key: string;
  /** The object bytes to store, as a string body (this inline path is for SMALL objects only). */
  readonly body: string;
  /** Optional content-type to store on the object (defaults to application/octet-stream). */
  readonly contentType?: string;
  /** Optional HTTP metadata (cache-control, content-disposition, …) stored on the object. */
  readonly httpMetadata?: Record<string, unknown>;
  /** Optional custom metadata map stored alongside the object. */
  readonly customMetadata?: Record<string, unknown>;
  /** Must be `true` to overwrite an EXISTING object (a new object needs no confirm). */
  readonly confirm?: boolean;
}

/**
 * The `delete` mutation input: remove ONE object from the site's OWN R2 bucket. DESTRUCTIVE — `confirm`
 * is REQUIRED (INV-9/INV-11): without it, `mutate` returns `confirmation_required` and REPORTS the key +
 * whether it currently exists, deleting nothing.
 */
export interface R2DeleteInput {
  readonly action: 'delete';
  readonly key: string;
  /** Must be `true` to actually delete (destructive-op gate). */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the r2 adapter — NEVER a generic `{ command }` field. */
export type R2MutateInput = R2PutInput | R2DeleteInput | ProvisionInput;

/** What an R2 `put` returns: the key written + whether it overwrote a prior object + a metadata echo. */
export interface R2PutResult {
  readonly action: 'put';
  readonly key: string;
  /** True when an object already existed at this key (this write overwrote it). */
  readonly overwritten: boolean;
  /** The content-type stored on the object. */
  readonly contentType: string;
  /** True when http and/or custom metadata was stored alongside the object. */
  readonly metadataStored: boolean;
}

/** What an R2 `delete` returns: the key + whether it existed before (honest, not a fabricated success). */
export interface R2DeleteResult {
  readonly action: 'delete';
  readonly key: string;
  /** True when the object existed and was removed; false when it was already absent (delete is idempotent). */
  readonly existed: boolean;
}

/** The discriminated result union a successful `mutate` returns. */
export type R2MutateResult = R2PutResult | R2DeleteResult | ProvisionMutateResult;

/**
 * ONE readable bucket-configuration setting (the `bucket_config` READ verb). Two honest shapes:
 *  - OWNER-MANAGEABLE (`requiresPlatformAdmin:false`): CORS + object-lifecycle rules are BUCKET-level in the
 *    CF R2 REST API — read directly and reported as `value` (the parsed rule set / a count summary), never a
 *    fabricated control.
 *  - PLATFORM-ADMINISTERED (`requiresPlatformAdmin:true`): public-access (the `r2.dev` managed domain, which
 *    exposes the bucket to the open internet) + custom-domain attachment require DNS/zone ownership and an
 *    account-wide toggle a single site OWNER cannot manage on this shared CF account (SECURITY-INVARIANTS
 *    INV-6/INV-7). These are reported WITH the current state (when readable) + an honest `reason` — NEVER a
 *    fake CRUD toggle the owner could click but that would never take effect.
 *
 * `available:false` marks a setting whose CF read itself failed transiently (auth/5xx/network) — the caller
 * must NOT read that as "off"/"empty" (that would be a lying-empty per `verify-against-source-of-truth`).
 */
export interface R2BucketConfigSetting {
  /** Stable key: `cors` | `lifecycle` | `public_access` | `custom_domains`. */
  readonly key: string;
  /** Human label for the Data-tab row. */
  readonly label: string;
  /** True when this setting is platform-administered — the site owner cannot manage it here (honest, not a fake control). */
  readonly requiresPlatformAdmin: boolean;
  /** Why it's platform-administered (present only when `requiresPlatformAdmin`) — surfaced to the owner verbatim. */
  readonly reason?: string;
  /** True when the setting was read successfully; false → the CF read failed transiently (NOT "off"/"empty"). */
  readonly available: boolean;
  /** The read value (parsed CORS rules, lifecycle rule summary, public-access state, custom-domain list) — present when `available`. */
  readonly value?: unknown;
}

/**
 * What the `bucket_config` READ verb returns: the site bucket's readable settings. `exists:false` when the
 * bucket our registry row claims is gone on CF (→ drift, mirrors `head`). Each setting is honest about whether
 * the OWNER can manage it (`requiresPlatformAdmin`) and whether the read itself succeeded (`available`).
 */
export interface R2BucketConfigData {
  /** True when CF confirms the bucket exists (a `200` from the bucket GET). */
  readonly exists: boolean;
  /** The probed bucket name (echoed for audit — it came from the scope, not the caller). */
  readonly bucketName: string;
  /** The readable configuration settings (CORS, lifecycle, public-access, custom-domains). */
  readonly settings: readonly R2BucketConfigSetting[];
}

/** The `preview_url` input: which object to mint a short-lived scoped preview/download URL for. */
export interface R2PreviewUrlInput {
  readonly key: string;
}

/**
 * Common-content-type classification of an object for the `preview_url` verb — drives how a client renders the
 * short-lived scoped URL (inline image/text/json/pdf vs a download for large/binary). NEVER account credentials.
 */
export type R2PreviewKind = 'image' | 'text' | 'json' | 'pdf' | 'binary' | 'unknown';

/**
 * What the `preview_url` READ verb returns. Honest by construction (SECURITY-INVARIANTS INV-6):
 *  - `found:false` when the object does not exist (an honest miss, never a fabricated URL).
 *  - `available:false` + `approach` when short-lived signed-URL minting is NOT wired for the per-site bucket
 *    (the account-wide R2 S3 credentials are NOT held in the Worker by design, so we do NOT fabricate a
 *    creds-bearing URL). `approach` describes HOW a preview/download WILL be served (a server-minted signed R2
 *    URL, or a streamed proxy for large/binary) so the surface is honest about the boundary.
 *  - a `url` is present ONLY when a genuinely SCOPED short-lived URL was minted server-side — and it is NEVER
 *    an account credential; it is a time-boxed, single-object, GET-only handle.
 */
export interface R2PreviewUrlData {
  readonly key: string;
  /** True when the object exists (metadata probe succeeded). */
  readonly found: boolean;
  /** The object's stored content-type, when found — drives `kind`. */
  readonly contentType?: string;
  /** Size in bytes, when found — large objects use a streamed/scoped approach, never inline bytes. */
  readonly size?: number;
  /** Common-content-type classification driving how a client renders the URL. */
  readonly kind?: R2PreviewKind;
  /** True when a genuinely scoped short-lived URL was minted; false → not wired (see `approach`). */
  readonly available: boolean;
  /** The short-lived SCOPED preview/download URL — present ONLY when `available`. NEVER an account credential. */
  readonly url?: string;
  /** Seconds until `url` expires, when minted (short-lived by construction). */
  readonly expiresInSeconds?: number;
  /** Honest description of HOW a preview/download is (or will be) served — always present when NOT `available`. */
  readonly approach?: string;
}

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `r2-${crypto.randomUUID()}`;
}

/**
 * Classify a stored content-type into a {@link R2PreviewKind} for the `preview_url` verb. A common, inline-safe
 * type (image/text/json/pdf) previews in place; everything else is `binary` (download via a scoped/streamed
 * handle). `unknown` when the object carries no content-type. Pure — no I/O, no credentials.
 */
function previewKindFor(contentType: string | undefined, size: number | undefined): R2PreviewKind {
  void size; // size does not change the KIND (it changes the delivery approach), kept for signature clarity.
  if (typeof contentType !== 'string' || contentType.length === 0) return 'unknown';
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('text/') || ct === 'application/xml' || ct.endsWith('+xml')) return 'text';
  return 'binary';
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
 * The `r2` adapter. `list`/`head`/`get` are live (read-only, `get` = METADATA only); `mutate` implements
 * the `put` + `delete` named mutations (destructive/overwrite gated on `confirm:true`; large objects use a
 * signed URL, not inline bytes). Two additional READ-ONLY surfaces: {@link R2Adapter.bucketConfig} (read the
 * bucket's CORS/lifecycle/public-access/custom-domain settings — honest `requiresPlatformAdmin` per setting,
 * never a fake control) and {@link R2Adapter.previewUrl} (a short-lived SCOPED preview/download URL for one
 * object — NEVER account credentials; honest `not_available` + approach when signed-URL minting isn't wired).
 * `supports` declares the four interface verbs honestly so the UI + MCP only ever offer a verb that runs.
 */
class R2Adapter
  implements ResourceAdapter<R2ListData, R2HeadData, R2GetData, R2MutateInput, R2MutateResult>
{
  readonly kind = 'r2' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): r2 serves both environments, all three read
   * verbs, and the `put`/`delete` named mutations (the first WRITE slice — SMALL objects inline; large
   * objects need a signed upload URL, a later pass). bulk_delete/provision/destroy land later — append them
   * here as they are implemented so the UI/MCP never offer an unwired verb.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['put', 'delete', 'provision'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
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

  /**
   * Probe whether ONE object currently EXISTS in the site's OWN R2 bucket (a cheap `HEAD` on the objects
   * endpoint). Returns `true`/`false` on a definitive answer, or `undefined` when the probe itself failed
   * (auth/5xx/network) — the caller must NOT interpret an indeterminate probe as "absent" (that would let
   * an overwrite skip its confirm gate on a transient blip). Used to decide whether a `put`/`delete` needs
   * `confirm:true` and to report the honest before-state. Operates ONLY on `scope.resourceId`'s bucket.
   */
  private async objectExists(scope: ResolvedScope, key: string): Promise<boolean | undefined> {
    const encoded = encodeURIComponent(key);
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(scope.resourceId)}/objects/${encoded}`,
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
   * Run a NAMED mutation against the site's OWN R2 bucket (the FIRST write slice). `put` writes one SMALL
   * object's bytes (optional content-type + http/custom metadata); `delete` removes one object. Both operate
   * ONLY on `scope.resourceId` (server-resolved upstream — this adapter accepts NO bucket name and cannot be
   * redirected). Guarding (SECURITY-INVARIANTS INV-9/INV-11): a `delete`, and a `put` that would OVERWRITE an
   * existing object, are destructive of the prior object and REQUIRE `confirm:true`; without it the mutation
   * returns a typed `confirmation_required` envelope that REPORTS what WOULD change (the key + whether it
   * exists) and writes NOTHING. An indeterminate existence probe FAILS CLOSED for the confirm gate. LARGE
   * objects are refused with `object_too_large` (a signed upload URL is a later pass) — never buffered inline,
   * never embedded. Every payload is validated here (key non-empty + bounded, body a string within the inline
   * cap). Returns a typed {@link R2MutateResult} describing what actually changed.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY bucket this can write
   * @param input - the discriminated `{ action:'put'|'delete', … }` mutation
   */
  async mutate(scope: ResolvedScope, input: R2MutateInput): Promise<AdapterResult<R2MutateResult>> {
    const cid = correlationId();

    // PROVISION runs BEFORE the put/delete handling: it CREATES the bucket, so `scope.resourceId` is
    // empty (the name is the output). Delegated to the shared provision bridge (idempotency → quota →
    // provisioner → registry record → recoverable partial).
    if (input && input.action === 'provision') {
      return runProvisionMutation(cid, scope, 'r2', input);
    }

    if (!input || (input.action !== 'put' && input.action !== 'delete')) {
      return {
        correlationId: cid,
        error: { code: 'invalid_action', message: 'Unknown R2 mutation action.', retryable: false },
        ok: false,
      };
    }

    const key = input.key;
    if (typeof key !== 'string' || key.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_key', message: 'Object key is missing or empty.', retryable: false },
        ok: false,
      };
    }
    if (new TextEncoder().encode(key).length > KEY_MAX_BYTES) {
      return {
        correlationId: cid,
        error: {
          code: 'invalid_key',
          message: `Object key exceeds the ${KEY_MAX_BYTES}-byte R2 limit.`,
          retryable: false,
        },
        ok: false,
      };
    }
    const encoded = encodeURIComponent(key);
    const bucketPath = `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(scope.resourceId)}/objects/${encoded}`;

    if (input.action === 'delete') {
      // DESTRUCTIVE — require confirm. Report whether the object exists so the caller knows what they're removing.
      if (input.confirm !== true) {
        const exists = await this.objectExists(scope, key);
        return {
          correlationId: cid,
          error: {
            code: 'confirmation_required',
            message: `Deleting R2 object "${key}" is destructive${
              exists === true
                ? ' (the object currently exists)'
                : exists === false
                  ? ' (the object does not currently exist)'
                  : ''
            }. Re-run with confirm:true to delete it.`,
            retryable: false,
          },
          ok: false,
        };
      }
      // Probe existence BEFORE the delete so the result honestly reports whether it existed (delete is
      // idempotent — deleting an absent object still succeeds). An indeterminate probe → report existed:false
      // conservatively; the delete still runs.
      const existedBefore = await this.objectExists(scope, key);
      let res: Response;
      try {
        res = await fetch(bucketPath, { headers: { ...cfAuthHeaders(scope.auth) }, method: 'DELETE' });
      } catch (err) {
        return restError<R2MutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
      }
      // A 404 on delete means the object was already gone — an idempotent success, not an error.
      if (!res.ok && res.status !== 404) {
        return restError<R2MutateResult>(cid, res.status, `CF R2 delete returned HTTP ${res.status}`);
      }
      return {
        correlationId: cid,
        data: { action: 'delete', existed: existedBefore === true, key },
        ok: true,
      };
    }

    // action === 'put'
    const body = input.body;
    if (typeof body !== 'string') {
      return {
        correlationId: cid,
        error: { code: 'invalid_body', message: 'A string body is required for put.', retryable: false },
        ok: false,
      };
    }
    // LARGE object → NOT embedded. A signed, short-lived SCOPED upload URL is required (a later pass) —
    // the adapter never buffers an arbitrarily large body into a JSON request, never embeds raw bytes.
    if (new TextEncoder().encode(body).length > PUT_MAX_INLINE_BYTES) {
      return {
        correlationId: cid,
        error: {
          code: 'object_too_large',
          message: `Object exceeds the ${Math.floor(
            PUT_MAX_INLINE_BYTES / (1024 * 1024),
          )} MiB inline-upload limit. Large/multipart uploads require a short-lived scoped upload URL (a signed R2 URL), not embedded bytes.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // Determine overwrite state to gate the confirm + report the honest before-state. An INDETERMINATE
    // probe fails CLOSED for the confirm gate (treat as "might exist") so a transient blip can't let an
    // unconfirmed overwrite through.
    const existsBefore = await this.objectExists(scope, key);
    if (existsBefore !== false && input.confirm !== true) {
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `R2 object "${key}" already exists — writing overwrites the current object. Re-run with confirm:true to overwrite.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // CF R2 object PUT: the raw body is the object bytes; content-type rides the request content-type header;
    // custom metadata rides as `x-amz-meta-*` headers on the R2 REST data plane. We send small objects only.
    const contentType =
      typeof input.contentType === 'string' && input.contentType.length > 0
        ? input.contentType
        : 'application/octet-stream';
    const headers: Record<string, string> = { ...cfAuthHeaders(scope.auth), 'content-type': contentType };
    const hasCustom = input.customMetadata !== undefined && input.customMetadata !== null;
    if (hasCustom) {
      for (const [k, v] of Object.entries(input.customMetadata as Record<string, unknown>)) {
        // Only string-serializable values; skip anything non-primitive rather than fail the write.
        if (v !== null && typeof v !== 'object') headers[`x-amz-meta-${k}`] = String(v);
      }
    }
    const hasHttp = input.httpMetadata !== undefined && input.httpMetadata !== null;
    if (hasHttp) {
      const http = input.httpMetadata as Record<string, unknown>;
      if (typeof http['cacheControl'] === 'string') headers['cache-control'] = http['cacheControl'] as string;
      if (typeof http['contentDisposition'] === 'string')
        headers['content-disposition'] = http['contentDisposition'] as string;
    }

    let res: Response;
    try {
      res = await fetch(bucketPath, { body, headers, method: 'PUT' });
    } catch (err) {
      return restError<R2MutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: unknown } | null;
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<R2MutateResult>(cid, res.status, `CF R2 put failed: ${detail}`);
    }
    return {
      correlationId: cid,
      data: {
        action: 'put',
        contentType,
        key,
        metadataStored: hasCustom || hasHttp,
        overwritten: existsBefore === true,
      },
      ok: true,
    };
  }

  /**
   * READ the site bucket's configuration (`bucket_config` — READ-ONLY, no confirm). Reports, per setting,
   * whether the OWNER can manage it here + the current value when readable:
   *  - **CORS** (`cors`) + **object-lifecycle rules** (`lifecycle`) are BUCKET-level in the CF R2 REST API →
   *    read directly, `requiresPlatformAdmin:false`, value = the parsed rule set / a count summary.
   *  - **public access** (`public_access`, the `r2.dev` managed domain that exposes the bucket to the open
   *    internet) + **custom domains** (`custom_domains`) require DNS/zone ownership + an account-wide toggle a
   *    single site OWNER cannot manage on this SHARED CF account → `requiresPlatformAdmin:true` + an honest
   *    `reason`, with the current state attached when it reads (never a fake CRUD control — INV-6/INV-7).
   *
   * Operates ONLY on `scope.resourceId`'s bucket (server-resolved upstream — accepts NO bucket name). An honest
   * `not_available` (`available:false`) marks a setting whose CF read failed transiently — NEVER read as "off".
   * A `404` on the bucket itself → `exists:false` (drift, mirrors {@link head}). Account credentials never leave
   * the Worker (only `data` + typed errors + `correlationId` are returned).
   */
  async bucketConfig(scope: ResolvedScope): Promise<AdapterResult<R2BucketConfigData>> {
    const cid = correlationId();
    const bucketName = scope.resourceId;
    const base = `${CF_API_BASE}/accounts/${scope.accountId}/r2/buckets/${encodeURIComponent(bucketName)}`;

    // Bucket existence first — a gone bucket is drift, not an empty config.
    let headRes: Response;
    try {
      headRes = await fetch(base, {
        headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
        method: 'GET',
      });
    } catch (err) {
      return restError<R2BucketConfigData>(
        cid,
        undefined,
        err instanceof Error ? err.message : 'CF request failed',
      );
    }
    if (
      headRes.status === 404 ||
      (headRes.status >= 400 && headRes.status < 500 && headRes.status !== 401 && headRes.status !== 403)
    ) {
      return {
        correlationId: cid,
        data: { bucketName, exists: false, settings: [] },
        ok: true,
      };
    }
    if (!headRes.ok) {
      return restError<R2BucketConfigData>(cid, headRes.status, `CF R2 bucket read returned HTTP ${headRes.status}`);
    }

    // Read a bucket-level sub-resource; `available:false` on any transient failure (never "empty"/"off").
    const readSub = async (
      path: string,
    ): Promise<{ available: boolean; value?: unknown }> => {
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, {
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'GET',
        });
      } catch {
        return { available: false };
      }
      // A 404 here means "no rules configured" — an honest empty, not a failure.
      if (res.status === 404) return { available: true, value: null };
      if (!res.ok) return { available: false };
      const json = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown } | null;
      if (!json?.success) return { available: false };
      return { available: true, value: json.result ?? null };
    };

    const [cors, lifecycle, publicAccess, customDomains] = await Promise.all([
      readSub('/cors'),
      readSub('/lifecycle'),
      // The managed (`r2.dev`) public-access state + the attached custom domains are readable, but MANAGING
      // them is platform-administered (DNS/zone ownership + an account-wide public-exposure toggle).
      readSub('/domains/managed'),
      readSub('/domains/custom'),
    ]);

    const settings: R2BucketConfigSetting[] = [
      {
        available: cors.available,
        key: 'cors',
        label: 'CORS rules',
        requiresPlatformAdmin: false,
        value: cors.value,
      },
      {
        available: lifecycle.available,
        key: 'lifecycle',
        label: 'Object lifecycle rules',
        requiresPlatformAdmin: false,
        value: lifecycle.value,
      },
      {
        available: publicAccess.available,
        key: 'public_access',
        label: 'Public access (r2.dev managed domain)',
        reason:
          'Exposing this bucket to the public internet is an account-wide setting managed by the platform, not per-site — request public access through support.',
        requiresPlatformAdmin: true,
        value: publicAccess.value,
      },
      {
        available: customDomains.available,
        key: 'custom_domains',
        label: 'Custom domains',
        reason:
          'Attaching a custom domain to this bucket requires DNS/zone ownership managed by the platform — request a custom domain through support.',
        requiresPlatformAdmin: true,
        value: customDomains.value,
      },
    ];

    return {
      correlationId: cid,
      data: { bucketName, exists: true, settings },
      ok: true,
    };
  }

  /**
   * Return a SHORT-LIVED SCOPED preview/download URL for ONE object (`preview_url` — READ-ONLY, no confirm).
   * SECURITY-INVARIANTS INV-6: this NEVER returns account credentials. It first probes the object's metadata
   * (via {@link get} — METADATA only, never bytes) to (1) honestly report `found:false` for a missing object
   * rather than fabricating a URL, and (2) classify the content-type (image/text/json/pdf/binary) so the caller
   * knows how to render it.
   *
   * Signed-URL minting for a per-site bucket is NOT wired (the account-wide R2 S3 credentials are deliberately
   * NOT held in the Worker), so — rather than fabricate a creds-bearing URL — this returns `available:false`
   * with an honest `approach` describing HOW a preview/download WILL be served once minting lands: a
   * server-minted, time-boxed, single-object, GET-only signed R2 URL for common inline types, or a streamed
   * scoped proxy for large/binary objects (never inline bytes, never a raw credential). When minting IS wired,
   * a `url` is present and is ALWAYS a scoped short-lived handle, never an account credential.
   *
   * Operates ONLY on `scope.resourceId`'s bucket (server-resolved upstream — accepts NO bucket name). The key is
   * validated (non-empty) before any I/O.
   */
  async previewUrl(scope: ResolvedScope, input: R2PreviewUrlInput): Promise<AdapterResult<R2PreviewUrlData>> {
    const cid = correlationId();
    const key = input?.key;
    if (typeof key !== 'string' || key.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_key', message: 'Object key is missing or empty.', retryable: false },
        ok: false,
      };
    }

    // Probe metadata first (never bytes) — honest found:false + content-type classification.
    const meta = await this.get(scope, { key });
    if (!meta.ok) {
      // Transient CF failure reading metadata — surface as-is (retryable), never a fabricated URL.
      return {
        correlationId: cid,
        error: meta.error ?? { code: 'cf_request_failed', message: 'Could not read the object.', retryable: true },
        ok: false,
      };
    }
    if (meta.data?.found !== true) {
      return {
        correlationId: cid,
        data: { available: false, found: false, key, approach: 'The object does not exist — nothing to preview.' },
        ok: true,
      };
    }

    const contentType = meta.data.contentType;
    const size = meta.data.size;
    const kind = previewKindFor(contentType, size);

    // Signed-URL minting for the per-site bucket is NOT wired (INV-6: no account R2 S3 credentials in the
    // Worker). Return the HONEST approach — never a fabricated creds-bearing URL.
    const approach =
      kind === 'binary' || (typeof size === 'number' && size > PUT_MAX_INLINE_BYTES)
        ? 'A large/binary object will be served through a server-streamed, scoped, GET-only proxy — never inline bytes and never an account credential.'
        : 'A short-lived, single-object, GET-only signed R2 URL will be minted server-side for inline preview — it is a scoped time-boxed handle, never an account credential.';

    return {
      correlationId: cid,
      data: {
        approach,
        available: false,
        contentType,
        found: true,
        key,
        kind,
        size,
      },
      ok: true,
    };
  }
}

/** The singleton `r2` adapter instance the reconciler + registry look up by kind. */
export const r2Adapter = new R2Adapter();
