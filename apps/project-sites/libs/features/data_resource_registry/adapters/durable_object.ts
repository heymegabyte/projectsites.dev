/**
 * @module libs/features/data_resource_registry/adapters/durable_object
 * @description The `durable_object` {@link ResourceAdapter} — Data & Resource Platform §7 (BACKEND tab),
 * Durable Objects slice. The COMPUTE-PLANE member of the resource platform: a site's Cloudflare
 * **Durable Object CLASS namespaces** (the class bindings on a Worker) + the object IDs a caller can
 * NAME. Implements the read verbs: `list` (the DO namespaces/classes CF exposes for the account —
 * NEVER "all instances", which CF cannot enumerate), `head` (does the DO class namespace exist + its
 * config), `get` (ONE object id's derivable METADATA ONLY — the id + its hex + the namespace it belongs
 * to; ⛔ NEVER the object's private storage or in-memory state, which no CF API can read) — PLUS the
 * narrow WRITE verb: `mutate({action, objectId, confirm?})`.
 *
 * ⛔ THE LOAD-BEARING WRITE INVARIANT — a NARROW, opt-in, AUTHENTICATED management interface ONLY:
 * `mutate` exposes a CLOSED, platform-defined allowlist of management actions ({@link DurableObjectManageAction}
 * = `status_probe` | `reset`) addressed to a KNOWN instance the platform created — it is **NEVER an arbitrary
 * method call into customer code** merely because a caller holds an object id, and it is **NEVER public**. A
 * caller can only pick from the fixed enum; there is no `{method, args}` passthrough. The addressed instance is
 * bound to the site's SERVER-RESOLVED namespace (`scope.resourceId`) — a caller supplies NO namespace/account,
 * so it can never reach another site's object. `reset` (state-changing) is `confirm`-gated (INV-9/INV-11);
 * `status_probe` (read-only) is not. On THIS deployment there is NO per-site DO namespace AND CF exposes no API
 * to reach an arbitrary instance's state, so every action is an HONEST `not_available` that runs NOTHING —
 * never a fabricated result, never a call into customer code. (This is the tool-design-as-api discipline: a
 * defined management API, not a `runAnything` into a DO.)
 *
 * ⛔ HONEST CF REALITY — THE LOAD-BEARING FACTS OF THIS SLICE (CAPABILITY-MATRIX.md § Durable Objects,
 * HARD FACT #3 "no generic DO-state browse"):
 *  - **There is NO Cloudflare API to enumerate DO INSTANCES or read arbitrary instance storage.** DO
 *    instances are addressed AT RUNTIME by a Worker that holds the class binding (`env.SITE_BUILDER.get(id)`);
 *    alarms + SQLite-backed storage (10 GB) live INSIDE the instance. This is a STRUCTURAL fact, not a
 *    missing feature. So this adapter's `list` lists **NAMESPACES (classes)**, not instances, via the CF
 *    management API `GET /accounts/{acct}/workers/durable_objects/namespaces` — and `get` returns ONLY the
 *    derivable METADATA of a NAMED object id (never its state). {@link DurableObjectGetData.stateBrowsable}
 *    is ALWAYS `false` — a permanent, honest reminder in every `get` envelope. A "browse all DO data" API
 *    is NEVER fabricated.
 *  - **Only `SITE_BUILDER` is bound on this deployment; there is NO per-SITE DO namespace.** Every other DO
 *    class (Collab/Voice/AppRuntime/catalog apps) is commented out → `not bound`. The reconciler records NO
 *    durable_object allocation source, so a blank site has NO `durable_object` registry row and
 *    `resolveResourceRef({kind:'durable_object'})` returns `not_registered` UPSTREAM — the honest
 *    "no site-owned Durable Object" (mirroring `per_site_r2`/`per_site_vectorize`/`per_site_workflows`).
 *    This adapter is only ever invoked once a `durable_object` row exists.
 *  - **The CF namespaces API is ACCOUNT-LEVEL, but this surface is SITE-SCOPED.** The management API returns
 *    EVERY DO namespace across the account — it is NOT natively per-site. Isolation is enforced here:
 *    `scope.resourceId` is the DO namespace ID resolved SERVER-SIDE from the OWNED site's registry row
 *    (never caller-supplied), and `list`/`head` surface ONLY the namespace matching that resolved id — a
 *    caller supplies NO namespace id and NO account id. A future write pass keys every addressed op to the
 *    same resolved namespace + a NAMED object id.
 *
 * ISOLATION (same structural guarantee as the `d1`/`kv`/`r2`/`vectorize`/`workflow` CF-REST adapters):
 *  - `scope.resourceId` is the DO NAMESPACE ID (server-resolved upstream from the registry
 *    `resolveResourceRef`, `resource_id_or_name` = the namespace's id). NEVER a caller-supplied id.
 *  - Execution goes through the CF **Workers Durable Objects REST API**
 *    (`/accounts/{acct}/workers/durable_objects/namespaces...`) — the account-wide CF credentials are NEVER
 *    sent to a client (a Worker can't statically bind thousands of per-site DO namespaces).
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** One Durable Object CLASS namespace as `list` reports it — class binding metadata, NEVER an instance. */
export interface DurableObjectNamespaceInfo {
  /** The CF namespace id — an opaque handle, scoped server-side to the site's resolved namespace. */
  readonly id: string;
  /** The DO CLASS this namespace binds (e.g. `SiteBuilderContainer`), when CF reports it. */
  readonly className?: string;
  /** The script the class is defined on (e.g. `project-sites`), when CF reports it. */
  readonly scriptName?: string;
  /** True when the class uses SQLite-backed storage, when CF reports it. */
  readonly useSqlite?: boolean;
}

/**
 * What a DO `list` returns: the site's OWN DO CLASS namespace(s) + an HONEST count. This lists NAMESPACES
 * (classes), NEVER instances — CF has no API to enumerate instances (⛔ HARD FACT). A blank/absent match is
 * an honest empty list, never a fabricated instance.
 */
export interface DurableObjectListData {
  /** The DO class namespaces this site owns (scoped to the resolved namespace id). */
  readonly namespaces: readonly DurableObjectNamespaceInfo[];
  /** The number of namespaces returned — the real count, never fabricated. */
  readonly count: number;
  /**
   * Always false — CF cannot enumerate DO INSTANCES or browse their state. A permanent, honest reminder
   * so no consumer ever reads this list as "all instances".
   */
  readonly instancesEnumerable: false;
}

/**
 * What a DO `head` returns: whether the DO CLASS namespace exists on CF + its class/script. This is the
 * class-binding existence probe (the drift primitive) — NOT an instance (instances aren't listable).
 */
export interface DurableObjectHeadData {
  /** True when CF confirms the DO namespace exists (found in the account namespaces list). */
  readonly exists: boolean;
  /** The namespace id probed (from the scope's resourceId, server-resolved). */
  readonly namespaceId: string;
  /** The DO class the namespace binds, when CF reports it. */
  readonly className?: string;
  /** The script the class is defined on, when CF reports it. */
  readonly scriptName?: string;
}

/** The `get` input: which object id's derivable metadata to read (an id the caller already KNOWS). */
export interface DurableObjectGetInput {
  /** The object id to describe — a NAMED instance id (hex or a from-name id). NEVER a browse. */
  readonly id: string;
}

/**
 * What a DO `get` returns: the derivable METADATA of a NAMED object id — its id, its namespace, and (best
 * effort) the hex form. ⛔ NEVER the object's private storage or in-memory state. `stateBrowsable:false` is
 * a PERMANENT, honest reminder that no CF API can read a DO's state — this returns identity metadata only.
 */
export interface DurableObjectGetData {
  /** The object id the caller named (echoed — scoped to the site's resolved namespace). */
  readonly objectId: string;
  /** The namespace id the object belongs to (server-resolved from the scope). */
  readonly namespaceId: string;
  /** The hex form of the id when it is a valid 64-char hex id, else absent (never fabricated). */
  readonly hexId?: string;
  /**
   * Always false — CF cannot read a Durable Object's private storage or in-memory state. This envelope
   * carries identity metadata ONLY; the object's state is NEVER dumped (⛔ HARD FACT #3).
   */
  readonly stateBrowsable: false;
}

/**
 * The FIXED, platform-defined management actions this adapter exposes. This is a CLOSED allowlist of NAMED
 * ops a ProjectSites opt-in AUTHENTICATED management interface would offer against a managed DO class — it is
 * NEVER an arbitrary method name into customer code. Adding an action here is a deliberate platform decision;
 * a caller can only ever pick from this enum.
 *
 * - `status_probe` — invoke a managed class's EXPLICITLY-EXPOSED, platform-defined status endpoint (a safe,
 *   read-only "are you healthy / what's your public status" op). NON-state-changing → no confirm.
 * - `reset` — a platform-defined, state-changing management op on a managed instance (e.g. clear transient
 *   in-memory state / re-arm an alarm on a class the platform controls). State-changing → confirm-gated.
 */
export type DurableObjectManageAction = 'status_probe' | 'reset';

/**
 * The `mutate` input for the durable_object adapter: a NARROW, ADDRESSED management op against a KNOWN
 * instance the platform created. ⛔ THE CRITICAL ISOLATION FACT: `action` is a FIXED enum
 * ({@link DurableObjectManageAction}) — this is NEVER an arbitrary method call into customer code merely
 * because a caller holds an object id. `objectId` names ONE instance; the instance is bound to the site's
 * SERVER-RESOLVED namespace (`scope.resourceId`) — a caller supplies NO namespace and NO account id, so it can
 * only ever address an instance within its OWN namespace. `reset` (state-changing) REQUIRES `confirm:true`;
 * `status_probe` (read-only) needs none.
 */
export interface DurableObjectManageInput {
  /** The management action — a FIXED platform-defined op, NEVER an arbitrary customer method name. */
  readonly action: DurableObjectManageAction;
  /** The KNOWN instance id to address (bound to the site's resolved namespace; never a browse, never widened). */
  readonly objectId: string;
  /** Must be `true` for the state-changing `reset`; ignored for the read-only `status_probe`. */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the durable_object adapter — a CLOSED set, never `{ method }`. */
export type DurableObjectMutateInput = DurableObjectManageInput;

/**
 * What a durable_object `mutate` returns: the action taken + the addressed object + whether the platform could
 * actually run it. On THIS deployment there is NO per-site DO namespace AND no CF API can reach an arbitrary
 * instance's state, so `available` is `false` and the op is an honest `not_available` (nothing was called into
 * customer code) — never a fabricated result. `stateBrowsable` is permanently `false` (mirrors `get`): even a
 * management op NEVER dumps the object's private storage.
 */
export interface DurableObjectMutateResult {
  /** The management action performed (or attempted). */
  readonly action: DurableObjectManageAction;
  /** The object id addressed (echoed — bound to the site's resolved namespace). */
  readonly objectId: string;
  /** The namespace id the object belongs to (server-resolved from the scope). */
  readonly namespaceId: string;
  /**
   * Whether a per-site DO management interface is reachable on this deployment. FALSE today — only
   * `SITE_BUILDER` is bound, there is no per-site DO namespace, and CF exposes no API to reach an arbitrary
   * instance. When false the op ran NOTHING (honest `not_available`).
   */
  readonly available: boolean;
  /** Always false — a management op NEVER reads/dumps the object's private storage or in-memory state. */
  readonly stateBrowsable: false;
}

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `durable_object-${crypto.randomUUID()}`;
}

/**
 * Map a Durable Objects REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a
 * `5xx`/network error is retryable (transient — never interpret as "gone"); anything else is a hard
 * failure the UI surfaces as-is. Mirrors the `workflow`/`kv`/`r2` adapters' `restError`.
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

/** A raw CF DO-namespace row as the management API reports it. */
interface RawDoNamespace {
  id?: unknown;
  class?: unknown;
  script?: unknown;
  use_sqlite?: unknown;
}

/** Reshape a raw CF namespace row into the typed {@link DurableObjectNamespaceInfo}. */
function toNamespaceInfo(row: RawDoNamespace): DurableObjectNamespaceInfo | null {
  if (typeof row?.id !== 'string' || row.id.length === 0) return null;
  return {
    className: typeof row.class === 'string' ? row.class : undefined,
    id: row.id,
    scriptName: typeof row.script === 'string' ? row.script : undefined,
    useSqlite: typeof row.use_sqlite === 'boolean' ? row.use_sqlite : undefined,
  };
}

/**
 * Fetch the account's DO namespaces via the CF management REST API and return the SINGLE namespace whose
 * id matches `scope.resourceId` (the site's server-resolved namespace) — the account API is account-level,
 * so we filter to the resolved id server-side (a caller can never widen this to another namespace). Returns
 * `{ ok:false, status }` so callers can distinguish a transient failure from a genuine "not found". Never
 * throws.
 */
async function fetchOwnNamespace(
  scope: ResolvedScope,
): Promise<
  | { ok: true; match: DurableObjectNamespaceInfo | undefined }
  | { ok: false; status: number | undefined }
> {
  let res: Response;
  try {
    res = await fetch(
      `${CF_API_BASE}/accounts/${scope.accountId}/workers/durable_objects/namespaces`,
      { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
    );
  } catch {
    return { ok: false, status: undefined };
  }
  if (!res.ok) return { ok: false, status: res.status };

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: RawDoNamespace[];
  } | null;

  const rows = Array.isArray(json?.result) ? json.result : [];
  // Account-level list → filter to the ONE namespace the scope resolved to (server-side isolation).
  const match = rows
    .map(toNamespaceInfo)
    .find((n): n is DurableObjectNamespaceInfo => n !== null && n.id === scope.resourceId);
  return { match, ok: true };
}

/** True when `id` is a well-formed 64-char lowercase-hex Durable Object id (else no hex form is claimed). */
function toHexId(id: string): string | undefined {
  return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : undefined;
}

/**
 * The `durable_object` adapter. `list`/`head`/`get` are live (read-only; account-level CF API scoped
 * SERVER-SIDE to the site's resolved DO namespace); `mutate` implements a NARROW, platform-defined management
 * interface (`status_probe`/`reset`) addressed to a KNOWN instance — ⛔ NEVER an arbitrary method call into
 * customer code. `supports` declares that honestly so the UI + MCP never offer a verb that would 501. ⛔ `list`
 * lists NAMESPACES (classes), NEVER instances (CF cannot enumerate instances); `get` returns identity METADATA
 * of a NAMED object id, NEVER its state (no CF API can read DO storage). Reads the CF Durable Objects REST API
 * bound to `scope.resourceId` (the namespace id, server-resolved) — never a caller id, never an account id.
 */
class DurableObjectAdapter
  implements
    ResourceAdapter<
      DurableObjectListData,
      DurableObjectHeadData,
      DurableObjectGetData,
      DurableObjectMutateInput,
      DurableObjectMutateResult
    >
{
  readonly kind = 'durable_object' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md: Durable Objects = ✅ ops-only, SITE_BUILDER only,
   * ⛔ browse-all state, ⛔ list instances via CF): serves both environments + all three read verbs + the
   * NARROW `status_probe`/`reset` management mutations. NOTE `list` surfaces NAMESPACES not instances and
   * `get`/`mutate` surface metadata/ops not state — the types (`instancesEnumerable:false`,
   * `stateBrowsable:false`) make that honesty structural. ⛔ The `mutations` list is a CLOSED, platform-defined
   * allowlist — NEVER an arbitrary method into customer code; `reset` is confirm-gated. On this deployment
   * there is no per-site DO namespace, so `mutate` honestly reports `available:false` and runs nothing.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['status_probe', 'reset'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
  };

  /**
   * List the site's OWN DO CLASS namespace(s) via the CF management REST `workers/durable_objects/namespaces`
   * — filtered SERVER-SIDE to `scope.resourceId` (the resolved namespace id). ⛔ This lists NAMESPACES
   * (classes), NEVER instances — CF has no API to enumerate DO instances (`instancesEnumerable:false` is a
   * permanent reminder). An absent match is an HONEST empty list + count 0, never a fabricated instance.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can address
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<DurableObjectListData>> {
    const cid = correlationId();
    const found = await fetchOwnNamespace(scope);
    if (!found.ok) {
      return restError<DurableObjectListData>(
        cid,
        found.status,
        `CF Durable Objects namespaces list returned HTTP ${found.status ?? 'network-error'}`,
      );
    }
    const namespaces = found.match ? [found.match] : [];
    return {
      correlationId: cid,
      data: { count: namespaces.length, instancesEnumerable: false, namespaces },
      ok: true,
    };
  }

  /**
   * Cheap existence/config probe of the DO CLASS namespace — does `scope.resourceId` exist on CF + its
   * class/script? The management API is account-level, so we fetch the account namespaces and match the
   * resolved id server-side (the drift primitive). Never accepts a caller id. Mirrors the `d1`/`kv`/`r2`/
   * `workflow` adapters' `head` contract.
   *
   * @returns `{ exists: true, ... }` when the namespace is in the account list; `{ exists: false }` when it
   *          is absent (→ drift); a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<DurableObjectHeadData>> {
    const cid = correlationId();
    const namespaceId = scope.resourceId;
    const found = await fetchOwnNamespace(scope);
    if (!found.ok) {
      return restError<DurableObjectHeadData>(
        cid,
        found.status,
        `CF Durable Objects head returned HTTP ${found.status ?? 'network-error'}`,
      );
    }
    // Absent from the account list => the namespace our row claims does not exist on CF => drift.
    if (!found.match) {
      return { correlationId: cid, data: { exists: false, namespaceId }, ok: true };
    }
    return {
      correlationId: cid,
      data: {
        className: found.match.className,
        exists: true,
        namespaceId,
        scriptName: found.match.scriptName,
      },
      ok: true,
    };
  }

  /**
   * Describe the derivable METADATA of a NAMED object id within the site's OWN namespace — its id, its
   * namespace, and (best effort) its hex form. ⛔ Returns identity metadata ONLY — NEVER the object's
   * private storage or in-memory state, which no CF API can read (`stateBrowsable:false` is permanent). This
   * does NOT fetch CF (there is no per-object metadata endpoint) — it echoes the NAMED id bound to the
   * server-resolved namespace, so a caller can confirm WHICH object it addressed without any state ever
   * being dumped. A missing/empty id is an `invalid_id` error.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can address
   * @param input - `{ id }` — the object id to describe (an id the caller already KNOWS; never a browse)
   */
  async get(scope: ResolvedScope, input: DurableObjectGetInput): Promise<AdapterResult<DurableObjectGetData>> {
    const cid = correlationId();
    const objectId = input?.id;
    if (typeof objectId !== 'string' || objectId.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_id', message: 'Durable Object id is missing or empty.', retryable: false },
        ok: false,
      };
    }
    // ⛔ NO state read — there is no CF API for it. Return identity metadata only, bound to the resolved
    // namespace. stateBrowsable is permanently false so this can never be read as "the object's data".
    return {
      correlationId: cid,
      data: {
        hexId: toHexId(objectId),
        namespaceId: scope.resourceId,
        objectId,
        stateBrowsable: false,
      },
      ok: true,
    };
  }

  /**
   * Run a NARROW, platform-defined management action against a KNOWN instance in the site's OWN namespace.
   *
   * ⛔ THE ISOLATION INVARIANT: `input.action` is a CLOSED enum ({@link DurableObjectManageAction}) — a caller
   * can only pick `status_probe` or `reset`. This is **NEVER an arbitrary method call into customer code** and
   * there is NO `{method, args}` passthrough — the platform decides what a managed class exposes. `input.objectId`
   * names ONE instance, bound to `scope.resourceId` (the DO namespace, server-resolved upstream — this adapter
   * accepts NO namespace/account and cannot be redirected, INV-1/INV-9), so a caller can only ever address an
   * instance inside its OWN namespace.
   *
   * GUARDING (INV-9/INV-11): `reset` is STATE-CHANGING → REQUIRES `confirm:true`; without it, `mutate` returns a
   * typed `confirmation_required` envelope that WARNS and runs NOTHING. `status_probe` is read-only → no confirm.
   *
   * HONESTY: on THIS deployment there is NO per-site DO namespace (only `SITE_BUILDER` is bound) AND CF exposes
   * no API to reach an arbitrary instance's state, so once past validation every action returns an honest
   * `not_available` (available:false) that runs NOTHING — never a fabricated result, and NEVER a call into
   * customer code. `stateBrowsable` is permanently false: a management op never dumps the object's state.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY namespace this can address
   * @param input - the discriminated `{ action, objectId, confirm? }` management op (a CLOSED action set)
   */
  async mutate(
    scope: ResolvedScope,
    input: DurableObjectMutateInput,
  ): Promise<AdapterResult<DurableObjectMutateResult>> {
    const cid = correlationId();

    // ⛔ CLOSED allowlist — reject anything outside the platform-defined management actions. This is the
    // structural guarantee that a caller can NEVER name an arbitrary customer method: there is no passthrough.
    if (!input || (input.action !== 'status_probe' && input.action !== 'reset')) {
      return {
        correlationId: cid,
        error: {
          code: 'invalid_action',
          message:
            'Unknown Durable Object management action. Only the platform-defined ops (status_probe, reset) are allowed — arbitrary method calls into a Durable Object are never permitted.',
          retryable: false,
        },
        ok: false,
      };
    }

    const objectId = input.objectId;
    if (typeof objectId !== 'string' || objectId.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_id', message: 'Durable Object id is missing or empty.', retryable: false },
        ok: false,
      };
    }

    // DESTRUCTIVE/STATE-CHANGING gate: `reset` changes instance state → REQUIRES confirm:true. Without it, WARN
    // and run NOTHING (INV-9/INV-11). `status_probe` is read-only → no confirm. This gate runs BEFORE the
    // availability check so a caller learns the confirm requirement even on a deployment without per-site DOs.
    if (input.action === 'reset' && input.confirm !== true) {
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `Resetting Durable Object "${objectId}" is a state-changing management op — its transient in-memory state / alarm is cleared. Re-run with confirm:true to reset it.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // ⛔ HONEST not_available — there is NO per-site DO namespace on this deployment (only SITE_BUILDER is bound)
    // and CF exposes no API to address an arbitrary instance's state. Nothing is called into customer code; the
    // op runs NOTHING. When a per-site DO management interface is later wired, this returns the addressed op's
    // real result — still ONLY the closed action set, still namespace-bound, never a raw method passthrough.
    return {
      correlationId: cid,
      data: {
        action: input.action,
        available: false,
        namespaceId: scope.resourceId,
        objectId,
        stateBrowsable: false,
      },
      ok: true,
    };
  }
}

/** The singleton `durable_object` adapter instance the reconciler + registry look up by kind. */
export const durableObjectAdapter = new DurableObjectAdapter();
