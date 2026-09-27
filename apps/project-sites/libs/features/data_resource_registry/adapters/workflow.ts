/**
 * @module libs/features/data_resource_registry/adapters/workflow
 * @description The `workflow` {@link ResourceAdapter} — Data & Resource Platform §6 (BACKEND tab),
 * Workflows (read) slice. The COMPUTE-PLANE member of the resource platform: a site's Cloudflare
 * **Workflow RUNS** (instances) of the platform-bound workflow definitions. Implements the read verbs:
 * `list` (the workflow's recent RUN INSTANCES — id/status/timestamps), `head` (does the workflow
 * DEFINITION exist + its config), `get` (ONE run instance's status + STEPS — sanitized, secrets never
 * dumped). `mutate` returns a typed `not_implemented` envelope (this pass is READ-ONLY) — never a raw
 * throw, never a `runAnything` mega-verb (tool-design-as-api). trigger/pause/resume/restart/terminate
 * land in the write pass (append to `supports.mutations` + implement `mutate` in the same fire).
 *
 * ⛔ HONEST CF REALITY — THE LOAD-BEARING FACTS OF THIS SLICE (CAPABILITY-MATRIX.md § Workflows):
 *  - **Workflows are `shared_platform`, NOT per-site.** The 6 workflow bindings (`SITE_WORKFLOW`, …) are
 *    platform-owned code-deployed DEFINITIONS; a CUSTOMER SITE does NOT own a workflow definition. There
 *    is NO CF API to CREATE a per-site workflow definition (definitions are code-deployed, not
 *    API-created). Per-SITE workflow provisioning is therefore NOT wired — the reconciler's
 *    `readAllocationSources` records NO workflow allocation source, so a blank site has NO `workflow`
 *    registry row and `resolveResourceRef({kind:'workflow'})` returns `not_registered` UPSTREAM. This
 *    adapter is only ever invoked once a `workflow` row exists; the UI + MCP surface the honest "no
 *    site-owned workflow yet" (mirroring `per_site_r2`/`per_site_vectorize`) — NEVER a fabricated run.
 *  - **The CF instances API is ACCOUNT-LEVEL, but this surface is SITE-SCOPED.** `GET .../workflows/
 *    {name}/instances` returns EVERY instance of that workflow name across the whole account — it is NOT
 *    natively per-site. Isolation is enforced here: `scope.resourceId` is the workflow NAME resolved
 *    server-side from the OWNED site's registry row (never caller-supplied), and a `get` of ONE instance
 *    binds BOTH the resolved workflow name AND the requested instance id — a caller can supply NO
 *    workflow name and NO account id. A future write pass keys every mutation to the same resolved name.
 *  - **NEVER optimistically claim a run finished.** `get` returns the ACTUAL CF instance status
 *    (`queued`/`running`/`paused`/`errored`/`terminated`/`complete`/`unknown`) exactly as CF reports it —
 *    a run in flight reads `running`, never a guessed `complete` (`verify-against-source-of-truth`).
 *
 * ISOLATION (same structural guarantee as the `d1`/`kv`/`r2`/`vectorize` CF-REST adapters):
 *  - `scope.resourceId` is the workflow NAME (server-resolved upstream from the registry
 *    `resolveResourceRef`, `resource_id_or_name` = the workflow's name). NEVER a caller-supplied name.
 *  - Execution goes through the CF **Workflows REST API** (`/accounts/{acct}/workflows/{name}/...`) bound
 *    to `scope.resourceId` — the account-wide CF credentials are NEVER sent to a client.
 *
 * ⛔ SENSITIVE STEP OUTPUT — `get` returns each step's name/type/status/timestamps + a bounded, SANITIZED
 * preview of a step's `output`/`error` (a workflow step can carry an API key or PII in its output). Raw
 * step output is NEVER dumped: {@link sanitizeStepPayload} redacts obvious secret-shaped keys and truncates
 * to a hard cap, so an inspector shows "what happened" without spilling a credential into the JSON envelope.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard bound on how many run instances a single `list` returns (keeps the CF payload + response small). */
const LIST_MIN = 1;
const LIST_MAX = 100;
const LIST_DEFAULT = 25;

/** Hard cap on how many steps a single `get` surfaces (a long-running workflow can have many steps). */
const STEPS_MAX = 200;

/** Hard cap (chars) on a single sanitized step output/error preview — never buffer a large payload. */
const STEP_PAYLOAD_MAX = 2000;

/** The instance statuses the CF Workflows API reports (a lifecycle signal, never a secret). */
export type WorkflowInstanceStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'errored'
  | 'terminated'
  | 'complete'
  | 'waiting'
  | 'waitingForPause'
  | 'unknown';

/** One workflow RUN INSTANCE as `list` reports it — id + status + timestamps ONLY (never step output). */
export interface WorkflowInstanceSummary {
  /** The CF instance id — an opaque handle, scoped server-side to the site's workflow. */
  readonly id: string;
  /** The run status exactly as CF reports it (never an optimistic guess). */
  readonly status: WorkflowInstanceStatus;
  /** When the instance was created/enqueued (ISO 8601), when present. */
  readonly createdOn?: string;
  /** When the instance last changed (ISO 8601), when present. */
  readonly modifiedOn?: string;
}

/** What a workflow `list` returns: the workflow's recent run instances + an HONEST count. */
export interface WorkflowListData {
  /** The workflow name these runs belong to (from the scope's resourceId, server-resolved). */
  readonly workflowName: string;
  /** The run instances returned (newest-first, clamped). */
  readonly instances: readonly WorkflowInstanceSummary[];
  /** The number of instances returned this page — the real count, never fabricated. */
  readonly count: number;
  /** CF's pagination cursor for the next page, when more remain (honest — never a fake total). */
  readonly cursor?: string;
}

/**
 * What a workflow `head` returns: whether the workflow DEFINITION exists on CF + its config. This is the
 * definition existence probe (the drift primitive) — NOT a per-site object (workflows are platform-owned).
 */
export interface WorkflowHeadData {
  /** True when CF confirms the workflow definition exists (a `200` from the workflow GET). */
  readonly exists: boolean;
  /** The workflow name probed (from the scope's resourceId, server-resolved). */
  readonly workflowName: string;
  /** The class/script the workflow binds to, when CF reports it. */
  readonly className?: string;
  /** The script name backing the workflow, when CF reports it. */
  readonly scriptName?: string;
}

/** The `get` input: which run instance to read (by its id). */
export interface WorkflowGetInput {
  readonly id: string;
}

/** One step of a run instance as `get` reports it — SANITIZED, never a raw secret-bearing payload. */
export interface WorkflowStepInfo {
  /** The step name, when present. */
  readonly name?: string;
  /** The step type (`step`/`sleep`/`waitForEvent`/…), when present. */
  readonly type?: string;
  /** The step status exactly as CF reports it. */
  readonly status?: string;
  /** When the step started (ISO 8601), when present. */
  readonly start?: string;
  /** When the step ended (ISO 8601), when present. */
  readonly end?: string;
  /** A bounded, SANITIZED preview of the step's output — secret-shaped keys redacted, truncated. */
  readonly outputPreview?: string;
  /** A bounded, SANITIZED preview of the step's error, when it errored. */
  readonly errorPreview?: string;
}

/**
 * What a workflow `get` returns: ONE run instance's status + steps, or `found:false`. The status is the
 * ACTUAL CF status (never optimistic). `outputSanitized:true` is a reminder raw step output is never dumped.
 */
export interface WorkflowGetData {
  /** True when the instance exists for this workflow; false → the other fields are absent (honest miss). */
  readonly found: boolean;
  /** The workflow name (server-resolved). */
  readonly workflowName: string;
  /** The instance id requested. */
  readonly instanceId: string;
  /** The run status exactly as CF reports it, present only when found. */
  readonly status?: WorkflowInstanceStatus;
  /** When the instance was created/enqueued (ISO 8601), when present. */
  readonly createdOn?: string;
  /** When the instance last changed (ISO 8601), when present. */
  readonly modifiedOn?: string;
  /** The run's steps (SANITIZED), present only when found. Clamped to {@link STEPS_MAX}. */
  readonly steps?: readonly WorkflowStepInfo[];
  /** Always true — step output/error were SANITIZED + bounded, never dumped raw (see module docs). */
  readonly outputSanitized: true;
}

/** Placeholder mutate payloads — this pass is read-only; trigger/pause/resume/restart/terminate land later. */
type WorkflowMutateInput = never;
type WorkflowMutateResult = never;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `workflow-${crypto.randomUUID()}`;
}

/**
 * Map a Workflows REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a
 * `5xx`/network error is retryable (transient — never interpret as "gone"); anything else is a hard
 * failure the UI surfaces as-is. Mirrors the `vectorize`/`kv`/`r2` adapters' `restError`.
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
      message: `The workflow adapter '${verb}' verb is not implemented yet.`,
      retryable: false,
    },
    ok: false,
  };
}

/**
 * Map a raw CF `status` string to a typed {@link WorkflowInstanceStatus}. Anything unrecognised becomes
 * `unknown` (never dropped, never optimistically coerced to `complete`). This is a lifecycle signal only.
 */
function toStatus(raw: unknown): WorkflowInstanceStatus {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'paused':
    case 'errored':
    case 'terminated':
    case 'complete':
    case 'waiting':
    case 'waitingForPause':
      return raw;
    default:
      return 'unknown';
  }
}

/** Clamp a requested `limit` to `[LIST_MIN, LIST_MAX]`, defaulting to {@link LIST_DEFAULT}. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return LIST_DEFAULT;
  return Math.max(LIST_MIN, Math.min(LIST_MAX, Math.trunc(limit)));
}

/** True when a JSON key name looks like it holds a secret (redacted from any surfaced step payload). */
function isSecretishKey(key: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|authorization|auth|bearer|credential|private[_-]?key|connection[_-]?string|dsn|cookie|session)/i.test(
    key,
  );
}

/**
 * SANITIZE a step's arbitrary output/error payload into a bounded, secret-free preview string. A workflow
 * step can carry an API key or PII in its output; this NEVER dumps it raw. Object payloads are walked and
 * any secret-shaped key's value is replaced with `[redacted]`; the result is JSON-stringified then hard-
 * truncated to {@link STEP_PAYLOAD_MAX} chars. A primitive payload is coerced to a truncated string.
 * Returns `undefined` for an absent payload (no fabricated preview).
 */
export function sanitizeStepPayload(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return undefined;

  const redact = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSecretishKey(k) ? '[redacted]' : redact(v, depth + 1);
      }
      return out;
    }
    return value;
  };

  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else {
    try {
      text = JSON.stringify(redact(payload, 0));
    } catch {
      text = String(payload);
    }
  }
  if (typeof text !== 'string') return undefined;
  return text.length > STEP_PAYLOAD_MAX ? `${text.slice(0, STEP_PAYLOAD_MAX)}…[truncated]` : text;
}

/** Reshape a raw CF instance list row into the typed {@link WorkflowInstanceSummary}. */
function toInstanceSummary(row: {
  id?: unknown;
  status?: unknown;
  created_on?: unknown;
  modified_on?: unknown;
}): WorkflowInstanceSummary | null {
  if (typeof row?.id !== 'string' || row.id.length === 0) return null;
  return {
    createdOn: typeof row.created_on === 'string' ? row.created_on : undefined,
    id: row.id,
    modifiedOn: typeof row.modified_on === 'string' ? row.modified_on : undefined,
    status: toStatus(row.status),
  };
}

/** Reshape one raw CF step object into a SANITIZED {@link WorkflowStepInfo}. */
function toStepInfo(raw: unknown): WorkflowStepInfo {
  const o = (raw ?? {}) as {
    name?: unknown;
    type?: unknown;
    status?: unknown;
    start?: unknown;
    end?: unknown;
    output?: unknown;
    error?: unknown;
  };
  return {
    end: typeof o.end === 'string' ? o.end : undefined,
    errorPreview: sanitizeStepPayload(o.error),
    name: typeof o.name === 'string' ? o.name : undefined,
    outputPreview: sanitizeStepPayload(o.output),
    start: typeof o.start === 'string' ? o.start : undefined,
    status: typeof o.status === 'string' ? o.status : undefined,
    type: typeof o.type === 'string' ? o.type : undefined,
  };
}

/**
 * The `workflow` adapter. `list`/`head`/`get` are live (read-only; account-level CF API scoped SERVER-SIDE
 * to the site's resolved workflow name); `mutate` returns `not_implemented`. `supports` declares that
 * honestly so the UI + MCP never offer a verb that would 501. Reads the CF Workflows REST API bound to
 * `scope.resourceId` (the workflow name, server-resolved) — never a caller name, never an account id.
 */
class WorkflowAdapter
  implements
    ResourceAdapter<
      WorkflowListData,
      WorkflowHeadData,
      WorkflowGetData,
      WorkflowMutateInput,
      WorkflowMutateResult
    >
{
  readonly kind = 'workflow' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md: Workflows = ✅ runs, read-heavy): serves both
   * environments + all three read verbs. `mutations: []` — this pass is read-only; trigger/terminate/
   * resume/pause/restart (all keyed to the resolved workflow name) land in the write pass (append them
   * here + implement `mutate` in the same fire).
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['list', 'head', 'get'] as const,
  };

  /**
   * List the workflow's recent RUN INSTANCES (id/status/timestamps) via the CF Workflows REST
   * `workflows/{name}/instances`. The workflow name is `scope.resourceId` (server-resolved from the OWNED
   * site's registry row); the account is `scope.accountId`; auth is `scope.auth` — none caller-supplied.
   * The CF API is account-level for that name; this surface is only reached once the site OWNS a workflow
   * row, and a future write pass keys mutations to the same resolved name. An empty page is an HONEST
   * empty list + count 0 (never a fabricated run). CF's `result_info.cursor` is surfaced for pagination
   * (never a fake total).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY workflow this can address
   * @param input - optional `{ limit?, cursor? }` — clamped to `[1, 100]`; cursor is CF's page token
   */
  async list(
    scope: ResolvedScope,
    input?: { limit?: number; cursor?: string },
  ): Promise<AdapterResult<WorkflowListData>> {
    const cid = correlationId();
    const workflowName = scope.resourceId;
    const limit = clampLimit(input?.limit);

    const url = new URL(
      `${CF_API_BASE}/accounts/${scope.accountId}/workflows/${encodeURIComponent(workflowName)}/instances`,
    );
    url.searchParams.set('per_page', String(limit));
    if (typeof input?.cursor === 'string' && input.cursor.length > 0) {
      url.searchParams.set('cursor', input.cursor);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
        method: 'GET',
      });
    } catch (err) {
      return restError<WorkflowListData>(
        cid,
        undefined,
        err instanceof Error ? err.message : 'CF request failed',
      );
    }

    if (!res.ok) {
      return restError<WorkflowListData>(
        cid,
        res.status,
        `CF Workflows instances list returned HTTP ${res.status}`,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ id?: unknown; status?: unknown; created_on?: unknown; modified_on?: unknown }>;
      result_info?: { cursor?: unknown } | null;
    } | null;

    const rows = Array.isArray(json?.result) ? json.result : [];
    const instances = rows
      .map(toInstanceSummary)
      .filter((i): i is WorkflowInstanceSummary => i !== null);
    const cursor =
      typeof json?.result_info?.cursor === 'string' && json.result_info.cursor.length > 0
        ? json.result_info.cursor
        : undefined;

    return {
      correlationId: cid,
      data: { count: instances.length, cursor, instances, workflowName },
      ok: true,
    };
  }

  /**
   * Cheap existence/config probe of the workflow DEFINITION via the CF Workflows REST `workflows/{name}`,
   * the drift primitive. The workflow name lives in `scope.resourceId` (resolved server-side); the account
   * is `scope.accountId`; auth is `scope.auth`. Never accepts a caller name. Mirrors the `d1`/`kv`/`r2`/
   * `vectorize` adapters' `head` contract.
   *
   * @returns `{ exists: true, ... }` on a `200`; `{ exists: false }` on a `404`/non-auth `4xx` (→ drift);
   *          a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<WorkflowHeadData>> {
    const cid = correlationId();
    const workflowName = scope.resourceId;

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/workflows/${encodeURIComponent(workflowName)}`,
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
        result?: { name?: unknown; class_name?: unknown; script_name?: unknown } | null;
      } | null;
      return {
        correlationId: cid,
        data: {
          className: typeof json?.result?.class_name === 'string' ? json.result.class_name : undefined,
          exists: true,
          scriptName: typeof json?.result?.script_name === 'string' ? json.result.script_name : undefined,
          workflowName,
        },
        ok: true,
      };
    }

    // 404 (and other non-auth 4xx) => the workflow definition our row claims does not exist on CF => drift.
    if (
      res.status === 404 ||
      (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403)
    ) {
      return { correlationId: cid, data: { exists: false, workflowName }, ok: true };
    }

    // 401/403 (auth) or 5xx (server) — a probe failure we can't interpret as "gone". Retryable.
    return restError<WorkflowHeadData>(cid, res.status, `CF Workflows head returned HTTP ${res.status}`);
  }

  /**
   * Read ONE run instance's status + STEPS via the CF Workflows REST `workflows/{name}/instances/{id}`.
   * Binds BOTH the resolved workflow name (`scope.resourceId`) AND the requested instance id — a caller
   * supplies only the instance id, never the workflow name/account. The status is the ACTUAL CF status
   * (never optimistically claimed complete). **Steps are SANITIZED** — {@link sanitizeStepPayload} redacts
   * secret-shaped keys + truncates, so a step carrying a credential/PII in its output is never dumped. A
   * `404` is an HONEST `{ found:false }`, not an error.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY workflow this can address
   * @param input - `{ id }` — the run instance id to read (scoped to the site's workflow; never a raw name)
   */
  async get(scope: ResolvedScope, input: WorkflowGetInput): Promise<AdapterResult<WorkflowGetData>> {
    const cid = correlationId();
    const workflowName = scope.resourceId;
    const instanceId = input?.id;

    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_id', message: 'Workflow instance id is missing or empty.', retryable: false },
        ok: false,
      };
    }

    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/workflows/${encodeURIComponent(
          workflowName,
        )}/instances/${encodeURIComponent(instanceId)}`,
        { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
      );
    } catch (err) {
      return restError<WorkflowGetData>(
        cid,
        undefined,
        err instanceof Error ? err.message : 'CF request failed',
      );
    }

    // A missing instance is an HONEST found:false (never an error).
    if (res.status === 404) {
      return {
        correlationId: cid,
        data: { found: false, instanceId, outputSanitized: true, workflowName },
        ok: true,
      };
    }

    if (!res.ok) {
      return restError<WorkflowGetData>(
        cid,
        res.status,
        `CF Workflows instance get returned HTTP ${res.status}`,
      );
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: {
        id?: unknown;
        status?: unknown;
        created_on?: unknown;
        modified_on?: unknown;
        steps?: unknown;
      } | null;
    } | null;

    if (!json?.result) {
      return restError<WorkflowGetData>(cid, res.status, 'CF Workflows instance get returned no result');
    }

    const r = json.result;
    const rawSteps = Array.isArray(r.steps) ? r.steps.slice(0, STEPS_MAX) : [];
    const steps = rawSteps.map(toStepInfo);

    return {
      correlationId: cid,
      data: {
        createdOn: typeof r.created_on === 'string' ? r.created_on : undefined,
        found: true,
        instanceId,
        modifiedOn: typeof r.modified_on === 'string' ? r.modified_on : undefined,
        outputSanitized: true,
        status: toStatus(r.status),
        steps,
        workflowName,
      },
      ok: true,
    };
  }

  /** Not implemented in this read pass — trigger/pause/resume/restart/terminate land in the write pass. */
  async mutate(
    _scope: ResolvedScope,
    _input: WorkflowMutateInput,
  ): Promise<AdapterResult<WorkflowMutateResult>> {
    return notImplemented<WorkflowMutateResult>('mutate');
  }
}

/** The singleton `workflow` adapter instance the reconciler + registry look up by kind. */
export const workflowAdapter = new WorkflowAdapter();
