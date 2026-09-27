/**
 * @module libs/features/data_resource_registry/adapters/vectorize
 * @description The `vectorize` {@link ResourceAdapter} — Data & Resource Platform §5, Vectorize (read) slice.
 *
 * Implements the read verbs against a site's OWN metadata NAMESPACE inside the SHARED Cloudflare Vectorize
 * index: `list` (the site's namespace summary — index name/dimensions/metric/metadata-indexes + the
 * server-derived namespace), `head` (index/namespace existence + config probe), `get` (index describe +
 * NAMESPACE-SCOPED `get-by-ids` — fetch specific vectors' metadata, filtered to the site's namespace so a
 * foreign vector is NEVER returned) — PLUS the WRITE slice: `mutate({action:'upsert'|'delete'})`. `mutate`
 * is a discriminated NAMED-mutation union (never a `runAnything`/`{command}` mega-verb — tool-design-as-api):
 * `upsert` writes vectors, `delete` removes vectors by id. BOTH are FORCE-SCOPED to the site's server-derived
 * namespace (see ISOLATION) — a caller can never write or delete into another site's partition.
 *
 * WRITE ISOLATION — the namespace is the tenant boundary, and it is FORCED, never trusted:
 *  - `upsert`: every vector's `namespace` field is OVERWRITTEN with the server-derived namespace before it is
 *    sent to CF. A caller-supplied `namespace`/`values`-adjacent namespace is stripped and replaced — so an
 *    upserted vector ALWAYS lands in the site's own partition, never a foreign one, regardless of input.
 *  - `delete`: CF's `delete_by_ids` has NO namespace filter (unlike `get_by_ids`), so a bare delete would let
 *    a caller remove ANOTHER site's vector by guessing its id. To make cross-site delete IMPOSSIBLE, the
 *    adapter first runs a NAMESPACE-SCOPED `get_by_ids` (the site's own namespace as the filter) to learn
 *    which of the requested ids actually live in THIS site's namespace, then deletes ONLY those — a foreign
 *    id simply isn't in the confirmed set and is never sent to `delete_by_ids`. `delete` REQUIRES
 *    `confirm:true` (destructive of the prior vector — INV-9/INV-11); without it `mutate` returns a typed
 *    `confirmation_required` envelope that REPORTS how many ids WOULD be removed (the in-namespace count) and
 *    deletes NOTHING.
 *
 * ISOLATION — the same structural guarantee as `site_data_db.ts` / the `d1` + `kv` + `r2` adapters, with the
 * Vectorize twist that per-site isolation is a NAMESPACE (metadata partition) inside ONE shared index, NOT a
 * dedicated per-site index (CAPABILITY-MATRIX.md: "namespace ≠ quota", HARD FACT #4):
 *  - `scope.resourceId` is the SHARED index name (server-resolved upstream from the registry
 *    `resolveResourceRef`, `resource_id_or_name` = `projectsites-rag`) — NEVER a caller-supplied index.
 *  - The site's NAMESPACE is DERIVED SERVER-SIDE from `scope.siteId` ({@link siteNamespace}, matching the
 *    write-side `site-<id.slice(0,8)>` convention in `site_dna.ts`/`advanced_features.ts`) — it is NEVER
 *    accepted from the caller. Every namespace-scoped verb (`get`'s `get-by-ids`, `mutate`'s `upsert` +
 *    `delete`) forces this derived namespace as the CF `namespace` filter/field, so one site can only ever
 *    see/query/write/delete its OWN partition of the shared index. A request can supply NO index name and NO
 *    namespace.
 *  - Execution goes through the CF **Vectorize v2 REST API**
 *    (`/accounts/{acct}/vectorize/v2/indexes/{name}/...`) bound to `scope.resourceId` — the account-wide CF
 *    credentials are NEVER sent to a client. (A Worker's `RAG_INDEX` binding is the SHARED index; the
 *    management surface reaches it via REST scoped by namespace, mirroring how per-site D1 uses REST.)
 *
 * PER-SITE VECTORIZE PROVISIONING IS NOT WIRED YET (honest resolution) — the reconciler's
 * `readAllocationSources` records only D1/KV/R2 allocation columns; there is NO vectorize allocation source,
 * so a blank site has NO `vectorize` registry row and `resolveResourceRef({kind:'vectorize'})` returns
 * `not_registered` UPSTREAM. This adapter is therefore only ever invoked once a `vectorize` row exists; the
 * MCP tools surface the honest "no Vectorize namespace yet" (mirroring `per_site_kv`/`per_site_r2`) until
 * per-site Vectorize provisioning lands — NEVER a fabricated namespace or index.
 *
 * VECTOR VALUES ARE NEVER RETURNED (directive, mirrors R2 metadata-only) — `get` returns each vector's id +
 * METADATA (namespace-scoped), never the raw float embedding. The metadata is enough for the Data tab's
 * inspector; a future pass can expose more. Buffering large vector arrays into a JSON envelope is not a shape
 * an MCP tool should return.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard bound on how many ids a single `get-by-ids` may request (keeps the CF payload + response small). */
const GET_BY_IDS_MIN = 1;
const GET_BY_IDS_MAX = 100;

/**
 * Derive a site's OWN Vectorize NAMESPACE from its site id, SERVER-SIDE — the isolation key. Matches the
 * write-side convention (`site-<first-8-of-siteId>` in `site_dna.ts` / `advanced_features.ts`) so the
 * management surface reads the SAME partition the platform writes. NEVER caller-supplied.
 */
export function siteNamespace(siteId: string): string {
  return `site-${siteId.slice(0, 8)}`;
}

/** One metadata index on a Vectorize index (a field CF has been told to index for filtering). */
export interface VectorizeMetadataIndex {
  readonly propertyName: string;
  readonly type?: string;
}

/**
 * What a Vectorize `head` returns: whether the shared index exists + its config, plus the site's
 * server-derived namespace (echoed for the caller's audit — it came from the scope's siteId, not the caller).
 */
export interface VectorizeHeadData {
  /** True when CF confirms the index exists (a `200` from the index GET). */
  readonly exists: boolean;
  /** The shared index name probed (from the scope's resourceId, server-resolved). */
  readonly indexName: string;
  /** The site's OWN namespace inside that index (server-derived from siteId). */
  readonly namespace: string;
  /** Vector dimensionality (e.g. 768), when present. */
  readonly dimensions?: number;
  /** Distance metric (`cosine` | `euclidean` | `dot-product`), when present. */
  readonly metric?: string;
}

/**
 * What a Vectorize `list` returns: the site's namespace summary — the shared index's config + the metadata
 * indexes + the site's OWN server-derived namespace. There is NO Cloudflare "list namespaces" API and no way
 * to enumerate a namespace's vectors cheaply, so this is an HONEST index/namespace SUMMARY, never a fabricated
 * vector count or a cross-namespace listing (CAPABILITY-MATRIX.md: no per-site index, scope to the namespace).
 */
export interface VectorizeListData {
  /** The shared index name (server-resolved). */
  readonly indexName: string;
  /** The site's OWN namespace (server-derived from siteId) — the only partition this site can address. */
  readonly namespace: string;
  /** Vector dimensionality, when present. */
  readonly dimensions?: number;
  /** Distance metric, when present. */
  readonly metric?: string;
  /** The metadata indexes configured on the shared index (filterable fields), best-effort. */
  readonly metadataIndexes: readonly VectorizeMetadataIndex[];
}

/** The `get` input: describe the index and OPTIONALLY fetch specific vectors' metadata (namespace-scoped). */
export interface VectorizeGetInput {
  /** Vector ids to fetch (namespace-scoped `get-by-ids`); omit/empty to only describe the index + namespace. */
  readonly ids?: readonly string[];
}

/** One vector as a namespace-scoped `get-by-ids` reports it — id + metadata ONLY, never the raw values. */
export interface VectorizeVectorInfo {
  readonly id: string;
  /** The stored metadata map for this vector, when present. */
  readonly metadata?: Record<string, unknown>;
  /** The vector's namespace as CF reports it (always the site's own — a cross-namespace id can't return). */
  readonly namespace?: string;
}

/**
 * What a Vectorize `get` returns: the index describe (name/dimensions/metric) + the site's namespace + any
 * requested vectors' id+metadata (NAMESPACE-SCOPED — a foreign vector is never returned). `metadataOnly:true`
 * is a reminder that the raw float values are never embedded in the envelope.
 */
export interface VectorizeGetData {
  readonly indexName: string;
  readonly namespace: string;
  readonly dimensions?: number;
  readonly metric?: string;
  /** The vectors fetched by `get-by-ids`, filtered to the site's namespace. Empty when no ids were requested. */
  readonly vectors: readonly VectorizeVectorInfo[];
  /** Always true — id + metadata only were returned, never the raw embedding values (see module docs). */
  readonly metadataOnly: true;
}

/** Hard bound on how many ids one `delete` may request (keeps the confirm-probe + delete payload small). */
const DELETE_IDS_MAX = 1000;
/** Hard bound on how many vectors one `upsert` may write in a single call. */
const UPSERT_VECTORS_MAX = 1000;

/** One vector to upsert — id + float `values`, plus optional metadata. The namespace is FORCED, never accepted. */
export interface VectorizeUpsertVector {
  readonly id: string;
  /** The embedding — an array of finite numbers. */
  readonly values: readonly number[];
  /** Optional metadata map stored alongside the vector. */
  readonly metadata?: Record<string, unknown>;
  /**
   * A caller MAY include a `namespace` field, but it is IGNORED and OVERWRITTEN with the site's server-derived
   * namespace before the vector is sent to CF — a caller can never place a vector in a foreign partition.
   */
  readonly namespace?: string;
}

/**
 * The `upsert` mutation input: write vectors to the site's OWN namespace. Every vector's `namespace` is FORCED
 * to the server-derived value (INV-1 — no caller-supplied namespace). Insert-or-overwrite by id (CF upsert
 * replaces a same-id vector in full). Upsert is NOT gated on `confirm` — it is additive/overwrite-by-own-id
 * within the site's own partition, mirroring KV `put` on a NEW key; the destructive gate is on `delete`.
 */
export interface VectorizeUpsertInput {
  readonly action: 'upsert';
  /** The vectors to write (each forced into the site's namespace). At least one; clamped to the max. */
  readonly vectors: readonly VectorizeUpsertVector[];
}

/**
 * The `delete` mutation input: remove vectors BY ID from the site's OWN namespace. DESTRUCTIVE — `confirm` is
 * REQUIRED (INV-9/INV-11): without it, `mutate` returns `confirmation_required` and REPORTS how many of the
 * requested ids actually live in the site's namespace (the count that WOULD be removed), deleting nothing.
 * Isolation: only ids CONFIRMED to be in the site's own namespace (via a namespace-scoped probe) are ever
 * deleted — a foreign id is never sent to CF's `delete_by_ids`.
 */
export interface VectorizeDeleteInput {
  readonly action: 'delete';
  /** The vector ids to remove (only those in the site's own namespace are actually deleted). */
  readonly ids: readonly string[];
  /** Must be `true` to actually delete (destructive-op gate). */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the vectorize adapter — NEVER a generic `{ command }` field. */
export type VectorizeMutateInput = VectorizeUpsertInput | VectorizeDeleteInput;

/** What a successful `upsert` returns: how many vectors were written + the (forced) namespace + CF mutation id. */
export interface VectorizeUpsertResult {
  readonly action: 'upsert';
  /** The site's OWN namespace every vector was forced into (echoed for the caller's audit). */
  readonly namespace: string;
  /** How many vectors were sent to CF (after clamping). */
  readonly count: number;
  /** CF's async mutation id for the upsert, when present (Vectorize writes are eventually-applied). */
  readonly mutationId?: string;
}

/** What a successful `delete` returns: how many in-namespace ids were removed + how many were skipped. */
export interface VectorizeDeleteResult {
  readonly action: 'delete';
  /** The site's OWN namespace the delete was scoped to. */
  readonly namespace: string;
  /** How many of the requested ids were confirmed in the site's namespace and deleted. */
  readonly deleted: number;
  /** How many requested ids were NOT in the site's namespace (foreign/absent) and were SKIPPED, not deleted. */
  readonly skipped: number;
  /** CF's async mutation id for the delete, when present (absent when nothing was in-namespace to delete). */
  readonly mutationId?: string;
}

/** The discriminated result union a successful `mutate` returns. */
export type VectorizeMutateResult = VectorizeUpsertResult | VectorizeDeleteResult;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `vectorize-${crypto.randomUUID()}`;
}

/**
 * Map a Vectorize REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a `5xx`/network
 * error is retryable (transient — never interpret as "gone"); anything else is a hard failure the UI surfaces
 * as-is. Mirrors the `kv`/`r2` adapters' `restError`.
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

/** Clamp a requested delete `ids` list to at most {@link DELETE_IDS_MAX} well-formed string ids (deduped, order-kept). */
function clampDeleteIds(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= DELETE_IDS_MAX) break;
  }
  return out;
}

/** Clamp a requested `ids` list to at most {@link GET_BY_IDS_MAX} well-formed string ids (deduped order-kept). */
function clampIds(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= GET_BY_IDS_MAX) break;
  }
  return out;
}

/** Normalize CF's metadata-index list shape into our typed array (defensive against null/absent). */
function toMetadataIndexes(raw: unknown): VectorizeMetadataIndex[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      const o = (m ?? {}) as { propertyName?: unknown; property_name?: unknown; indexType?: unknown; type?: unknown };
      const propertyName =
        typeof o.propertyName === 'string'
          ? o.propertyName
          : typeof o.property_name === 'string'
            ? o.property_name
            : '';
      const type =
        typeof o.indexType === 'string' ? o.indexType : typeof o.type === 'string' ? o.type : undefined;
      return { propertyName, type };
    })
    .filter((m) => m.propertyName.length > 0);
}

/**
 * GET the shared index's config via the CF Vectorize v2 REST `indexes/{name}`. Returns
 * `{ ok, status, dimensions, metric }` — `ok:false` with the status so callers can distinguish a 404
 * (index gone → drift) from a transient failure. Never throws.
 */
async function fetchIndexConfig(
  scope: ResolvedScope,
): Promise<{ ok: boolean; status: number | undefined; dimensions?: number; metric?: string }> {
  let res: Response;
  try {
    res = await fetch(
      `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(scope.resourceId)}`,
      { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
    );
  } catch {
    return { ok: false, status: undefined };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json().catch(() => null)) as {
    result?: { config?: { dimensions?: number; metric?: string } | null };
  } | null;
  return {
    dimensions: json?.result?.config?.dimensions,
    metric: json?.result?.config?.metric,
    ok: true,
    status: res.status,
  };
}

/**
 * The `vectorize` adapter. `list`/`head`/`get` are live (read-only; per-site isolation is a server-derived
 * NAMESPACE inside the shared index); `mutate` implements the `upsert` + `delete` named mutations, BOTH
 * force-scoped to the site's server-derived namespace (a caller can never write/delete a foreign partition),
 * `delete` gated on `confirm:true`. `supports` declares this honestly so the UI + MCP only ever offer a verb
 * that runs.
 */
class VectorizeAdapter
  implements
    ResourceAdapter<
      VectorizeListData,
      VectorizeHeadData,
      VectorizeGetData,
      VectorizeMutateInput,
      VectorizeMutateResult
    >
{
  readonly kind = 'vectorize' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md): vectorize serves both environments, all three read
   * verbs (each namespace-scoped where it addresses vectors), and the `upsert`/`delete` named mutations — both
   * FORCE-SCOPED to the site's server-derived namespace (a caller can never write/delete another site's
   * partition). `delete` is destructive → gated on `confirm:true`. query-write lands later; append it here +
   * implement in the same fire so the UI/MCP never offer an unwired verb.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['upsert', 'delete'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
  };

  /**
   * Summarise the site's namespace inside the SHARED index — the index name + dimensions/metric + configured
   * metadata indexes + the site's OWN server-derived namespace. There is NO CF "list namespaces" API and no
   * cheap per-namespace vector count, so this is an HONEST summary (never a fabricated vector total, never a
   * cross-namespace listing). A caller uses this to see "which namespace am I in + what fields can I filter",
   * then `get` with ids to inspect specific vectors.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY (shared) index this can address,
   *                and the namespace is derived from `scope.siteId` — neither is caller-supplied
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<VectorizeListData>> {
    const cid = correlationId();
    const indexName = scope.resourceId;
    const namespace = siteNamespace(scope.siteId);

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`,
        { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
      );
    } catch (err) {
      return restError<VectorizeListData>(
        cid,
        undefined,
        err instanceof Error ? err.message : 'CF request failed',
      );
    }

    if (!res.ok) {
      return restError<VectorizeListData>(cid, res.status, `CF Vectorize index get returned HTTP ${res.status}`);
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: {
        name?: string;
        config?: { dimensions?: number; metric?: string } | null;
        metadataIndexes?: unknown;
        metadata_indexes?: unknown;
      };
    } | null;

    if (!json?.result) {
      return restError<VectorizeListData>(cid, res.status, 'CF Vectorize index get returned no result');
    }

    const r = json.result;
    return {
      correlationId: cid,
      data: {
        dimensions: r.config?.dimensions,
        indexName,
        metadataIndexes: toMetadataIndexes(r.metadataIndexes ?? r.metadata_indexes),
        metric: r.config?.metric,
        namespace,
      },
      ok: true,
    };
  }

  /**
   * Cheap existence/config probe of the SHARED index via the CF Vectorize v2 REST index GET, echoing the
   * site's server-derived namespace. The index name lives in `scope.resourceId` (resolved server-side); the
   * account is `scope.accountId`; auth is `scope.auth`. Never accepts a caller name/namespace. Mirrors the
   * `d1`/`kv`/`r2` adapters' `head` contract.
   *
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/non-auth `4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<VectorizeHeadData>> {
    const cid = correlationId();
    const indexName = scope.resourceId;
    const namespace = siteNamespace(scope.siteId);

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`,
        { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
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
        result?: { name?: string; config?: { dimensions?: number; metric?: string } | null };
      } | null;
      return {
        correlationId: cid,
        data: {
          dimensions: json?.result?.config?.dimensions,
          exists: true,
          indexName,
          metric: json?.result?.config?.metric,
          namespace,
        },
        ok: true,
      };
    }

    // 404 (and other non-auth 4xx) => the shared index our row claims does not exist on CF => drift.
    if (
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)
    ) {
      return { correlationId: cid, data: { exists: false, indexName, namespace }, ok: true };
    }

    // 401/403 (auth) or 5xx (server) — a probe failure we can't interpret as "gone". Retryable.
    return restError<VectorizeHeadData>(cid, res.status, `CF Vectorize head returned HTTP ${res.status}`);
  }

  /**
   * Describe the shared index (name/dimensions/metric) + the site's namespace, and OPTIONALLY fetch specific
   * vectors' id+METADATA via a **NAMESPACE-SCOPED** `get-by-ids`. The `namespace` filter is the site's OWN
   * server-derived namespace — CF returns only vectors in that partition, so a foreign vector id yields no
   * result (isolation is structural, not a post-filter). **Returns id + METADATA ONLY — never the raw vector
   * values.** No ids → an index+namespace describe with an empty `vectors` list (never an error).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY (shared) index this can address,
   *                the namespace is derived from `scope.siteId`
   * @param input - `{ ids? }` — optional vector ids to fetch (namespace-scoped; clamped to 100, deduped)
   */
  async get(scope: ResolvedScope, input?: VectorizeGetInput): Promise<AdapterResult<VectorizeGetData>> {
    const cid = correlationId();
    const indexName = scope.resourceId;
    const namespace = siteNamespace(scope.siteId);
    const ids = clampIds(input?.ids);

    // Always describe the index first (dimensions/metric) so a `get` with no ids is still useful + honest.
    const config = await fetchIndexConfig(scope);
    if (!config.ok) {
      // A 404 on the shared index is drift; anything else is a transient probe failure. Surface honestly.
      return restError<VectorizeGetData>(
        cid,
        config.status,
        `CF Vectorize index describe returned HTTP ${config.status ?? 'network-error'}`,
      );
    }

    // No ids requested → describe-only (empty vectors). Never fabricate vectors.
    if (ids.length === 0) {
      return {
        correlationId: cid,
        data: {
          dimensions: config.dimensions,
          indexName,
          metadataOnly: true,
          metric: config.metric,
          namespace,
          vectors: [],
        },
        ok: true,
      };
    }

    // NAMESPACE-SCOPED get-by-ids — CF returns only vectors in the site's OWN namespace. A cross-namespace id
    // simply isn't returned (structural isolation). We also re-filter by namespace defensively below.
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/get_by_ids`,
        {
          body: JSON.stringify({ ids, namespace }),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'POST',
        },
      );
    } catch (err) {
      return restError<VectorizeGetData>(
        cid,
        undefined,
        err instanceof Error ? err.message : 'CF request failed',
      );
    }

    if (!res.ok) {
      return restError<VectorizeGetData>(
        cid,
        res.status,
        `CF Vectorize get_by_ids returned HTTP ${res.status}`,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ id?: string; namespace?: string; metadata?: Record<string, unknown> | null }>;
    } | null;

    const rawVectors = Array.isArray(json?.result) ? json.result : [];
    // Defense-in-depth: only surface vectors whose reported namespace matches the site's own. CF already
    // scopes by the `namespace` filter, but never trust a mismatched partition into the response.
    const vectors: VectorizeVectorInfo[] = rawVectors
      .filter((v) => typeof v?.id === 'string' && (v.namespace === undefined || v.namespace === namespace))
      .map((v) => ({
        id: v.id as string,
        metadata:
          v.metadata && typeof v.metadata === 'object' ? (v.metadata as Record<string, unknown>) : undefined,
        namespace: v.namespace,
      }));

    return {
      correlationId: cid,
      data: {
        dimensions: config.dimensions,
        indexName,
        metadataOnly: true,
        metric: config.metric,
        namespace,
        vectors,
      },
      ok: true,
    };
  }

  /**
   * NAMESPACE-SCOPED existence probe: of `ids`, return the subset that actually live in the site's OWN
   * namespace. Runs a `get_by_ids` with the site's derived namespace as the CF filter, so CF returns only
   * in-namespace vectors; we defensively re-filter by namespace too. Returns `undefined` when the probe itself
   * fails (auth/5xx/network) — the caller must NOT interpret an indeterminate probe as "none in namespace"
   * (that would let a delete silently no-op on a transient blip). This is what makes cross-site delete
   * IMPOSSIBLE: a foreign id is never confirmed, so it's never deleted.
   */
  private async confirmedNamespaceIds(
    scope: ResolvedScope,
    ids: readonly string[],
    namespace: string,
  ): Promise<string[] | undefined> {
    if (ids.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(scope.resourceId)}/get_by_ids`,
        {
          body: JSON.stringify({ ids, namespace }),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'POST',
        },
      );
    } catch {
      return undefined; // network failure — indeterminate, never "none".
    }
    if (!res.ok) return undefined; // auth/5xx/4xx — indeterminate, never "none".
    const json = (await res.json().catch(() => null)) as {
      result?: Array<{ id?: string; namespace?: string }>;
    } | null;
    const raw = Array.isArray(json?.result) ? json.result : [];
    const requested = new Set(ids);
    // Only ids CF reported AND whose namespace matches the site's own (defense-in-depth) count as confirmed.
    return raw
      .filter(
        (v) =>
          typeof v?.id === 'string' &&
          requested.has(v.id) &&
          (v.namespace === undefined || v.namespace === namespace),
      )
      .map((v) => v.id as string);
  }

  /**
   * Run a NAMED mutation against the site's OWN Vectorize NAMESPACE (the WRITE slice). `upsert` writes vectors
   * (each vector's namespace FORCED to the server-derived value — a caller-supplied namespace is stripped +
   * overwritten, so a vector can never land in a foreign partition); `delete` removes vectors BY ID, but ONLY
   * those confirmed to be in the site's own namespace (a namespace-scoped probe first learns which requested
   * ids are in-namespace — a foreign id is never sent to `delete_by_ids`, so cross-site delete is impossible).
   * Both operate ONLY on `scope.resourceId` (the shared index, server-resolved upstream) + the derived
   * namespace — this adapter accepts NO index name and NO namespace and cannot be redirected (INV-1/INV-9).
   * `delete` is DESTRUCTIVE and REQUIRES `confirm:true`: without it, `mutate` returns a typed
   * `confirmation_required` envelope that REPORTS the in-namespace id count that WOULD be removed and deletes
   * NOTHING (INV-9/INV-11). CF Vectorize writes are ASYNC — a successful result carries CF's `mutationId`;
   * vectors become queryable a few seconds later (never claimed instantly-applied).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY (shared) index this can address,
   *                the namespace is derived from `scope.siteId` — neither is caller-supplied
   * @param input - the discriminated `{ action:'upsert'|'delete', … }` mutation
   */
  async mutate(scope: ResolvedScope, input: VectorizeMutateInput): Promise<AdapterResult<VectorizeMutateResult>> {
    const cid = correlationId();
    const namespace = siteNamespace(scope.siteId);

    if (!input || (input.action !== 'upsert' && input.action !== 'delete')) {
      return {
        correlationId: cid,
        error: { code: 'invalid_action', message: 'Unknown Vectorize mutation action.', retryable: false },
        ok: false,
      };
    }

    // ── upsert ────────────────────────────────────────────────────────────────────
    if (input.action === 'upsert') {
      const rawVectors = Array.isArray(input.vectors) ? input.vectors : [];
      if (rawVectors.length === 0) {
        return {
          correlationId: cid,
          error: { code: 'invalid_vectors', message: 'At least one vector is required for upsert.', retryable: false },
          ok: false,
        };
      }
      // Validate + FORCE the namespace on every vector. A caller-supplied namespace is IGNORED + overwritten —
      // the vector always lands in the site's own partition (INV-1). Clamp the batch size.
      const clamped = rawVectors.slice(0, UPSERT_VECTORS_MAX);
      const forced: Array<{ id: string; values: number[]; namespace: string; metadata?: Record<string, unknown> }> = [];
      for (const v of clamped) {
        const id = typeof v?.id === 'string' ? v.id.trim() : '';
        if (id.length === 0) {
          return {
            correlationId: cid,
            error: { code: 'invalid_vector_id', message: 'Every vector needs a non-empty string id.', retryable: false },
            ok: false,
          };
        }
        if (!Array.isArray(v.values) || v.values.length === 0 || !v.values.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
          return {
            correlationId: cid,
            error: {
              code: 'invalid_vector_values',
              message: `Vector "${id}" needs a non-empty array of finite numeric values.`,
              retryable: false,
            },
            ok: false,
          };
        }
        forced.push({
          id,
          // FORCED namespace — the isolation guarantee. Any caller-supplied `v.namespace` is discarded.
          namespace,
          values: [...v.values],
          ...(v.metadata && typeof v.metadata === 'object' ? { metadata: v.metadata as Record<string, unknown> } : {}),
        });
      }

      // CF Vectorize v2 upsert takes an NDJSON body (one vector object per line).
      const ndjson = forced.map((v) => JSON.stringify(v)).join('\n');
      let res: Response;
      try {
        res = await fetch(
          `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(scope.resourceId)}/upsert`,
          {
            body: ndjson,
            headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/x-ndjson' },
            method: 'POST',
          },
        );
      } catch (err) {
        return restError<VectorizeMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
      }
      if (!res.ok) {
        return restError<VectorizeMutateResult>(cid, res.status, `CF Vectorize upsert returned HTTP ${res.status}`);
      }
      const json = (await res.json().catch(() => null)) as { result?: { mutationId?: string } } | null;
      return {
        correlationId: cid,
        data: {
          action: 'upsert',
          count: forced.length,
          namespace,
          ...(json?.result?.mutationId ? { mutationId: json.result.mutationId } : {}),
        },
        ok: true,
      };
    }

    // ── delete ────────────────────────────────────────────────────────────────────
    const requestedIds = clampDeleteIds(input.ids);
    if (requestedIds.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_ids', message: 'At least one vector id is required for delete.', retryable: false },
        ok: false,
      };
    }

    // NAMESPACE ISOLATION for delete: CF's delete_by_ids has NO namespace filter, so we first CONFIRM which of
    // the requested ids actually live in the site's OWN namespace. Only those are ever deleted — a foreign id
    // is never sent to delete_by_ids, making cross-site delete impossible. An indeterminate probe → fail the
    // op (never delete on an ambiguous probe).
    const confirmed = await this.confirmedNamespaceIds(scope, requestedIds, namespace);
    if (confirmed === undefined) {
      return restError<VectorizeMutateResult>(cid, undefined, 'Could not verify the vectors’ namespace before delete.');
    }
    const skipped = requestedIds.length - confirmed.length;

    // DESTRUCTIVE — require confirm. Report how many in-namespace ids WOULD be removed so the caller knows the
    // blast radius. A foreign/absent id is already excluded from `confirmed`, so the reported count is honest.
    if (input.confirm !== true) {
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `Deleting Vectorize vectors is destructive — ${confirmed.length} of ${requestedIds.length} requested id(s) are in this site's namespace and would be removed${
            skipped > 0 ? ` (${skipped} not in your namespace, would be skipped)` : ''
          }. Re-run with confirm:true to delete.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // Nothing in the site's namespace to delete → an honest no-op success (idempotent), never a CF call that
    // could touch a foreign id.
    if (confirmed.length === 0) {
      return {
        correlationId: cid,
        data: { action: 'delete', deleted: 0, namespace, skipped },
        ok: true,
      };
    }

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/vectorize/v2/indexes/${encodeURIComponent(scope.resourceId)}/delete_by_ids`,
        {
          body: JSON.stringify({ ids: confirmed }),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'POST',
        },
      );
    } catch (err) {
      return restError<VectorizeMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }
    if (!res.ok) {
      return restError<VectorizeMutateResult>(cid, res.status, `CF Vectorize delete_by_ids returned HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as { result?: { mutationId?: string } } | null;
    return {
      correlationId: cid,
      data: {
        action: 'delete',
        deleted: confirmed.length,
        namespace,
        skipped,
        ...(json?.result?.mutationId ? { mutationId: json.result.mutationId } : {}),
      },
      ok: true,
    };
  }
}

/** The singleton `vectorize` adapter instance the reconciler + registry look up by kind. */
export const vectorizeAdapter = new VectorizeAdapter();
