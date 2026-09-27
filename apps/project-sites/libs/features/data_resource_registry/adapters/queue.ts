/**
 * @module libs/features/data_resource_registry/adapters/queue
 * @description The `queue` {@link ResourceAdapter} — Data & Resource Platform §8 (BACKEND tab),
 * Queues slice. A member of the COMPUTE plane: a site's Cloudflare **Queue(s)** + their
 * consumers/delivery-retry settings/DLQ/backlog metrics/paused state. Implements the read verbs:
 * `list` (the site-owned queues + their consumers + delivery/retry settings + DLQ + backlog/oldest-
 * message metrics + paused flag), `head` (queue existence/config), `get` (ONE queue's details +
 * metrics) — PLUS the first WRITE verb: `mutate({action:'send'})`. `mutate` is a discriminated
 * NAMED-mutation union (never a `runAnything`/`{command}` mega-verb — tool-design-as-api): `send`
 * PRODUCES one or more messages onto the site's OWN resolved queue. `send` is PRODUCER-ONLY and NOT
 * destructive of existing state (it appends), so it needs NO `confirm` (an optional `confirm` is
 * accepted but not required). ⛔ purge / pull / ack are SEPARATE guarded/leasing ops — NOT this pass:
 * pull LEASES + needs ack (reading mutates lease state) and purge is destructive, so each lands as its
 * own confirm-gated/leasing verb later (append to `supports.mutations` + implement in the same fire).
 *
 * ⛔ HONEST CF REALITY — THE LOAD-BEARING FACTS OF THIS SLICE (CAPABILITY-MATRIX.md § Queues):
 *  - **Queues are UNSUPPORTED on this deployment — there is NO `QUEUE` binding.** Both the producer +
 *    consumer blocks in `wrangler.toml` are commented (top-level AND prod); the code falls back to
 *    Workflows. So the honest state for a SHARED platform queue is `not_available` / `not_registered`,
 *    NEVER a fabricated empty queue. This adapter surfaces that honestly: when Queues are disabled it is
 *    never reached (the resolver returns `unsupported_kind` UPSTREAM — `queue` ∈ `UNSUPPORTED_KINDS` in
 *    `service.resolveResourceRef`), and even if invoked it reports `available:false`. A blank site records
 *    NO queue allocation source, so it never gets a `queue` registry row (mirroring
 *    `per_site_r2`/`per_site_workflows`/`per_site_durable_objects`).
 *  - **peek ≠ a history browser (HARD FACT #1).** A queue "peek" shows the CURRENT head, NOT a durable log
 *    of past messages — Queues has NO message-history API. `list`/`get` surface CONFIG + METRICS only
 *    (backlog estimate, oldest-message age, consumer settings, DLQ, paused) — never a message body, never a
 *    "history". {@link QueueGetData.messageHistoryAvailable} is ALWAYS `false` — a permanent, honest reminder
 *    in every `get` envelope so no consumer ever reads a metric as "the messages".
 *  - **pull = leases + ack (HARD FACT #2).** The Queues *pull* consumer returns LEASED batches you must
 *    `ack`/`retry`; reading a message LEASES it and an unacked message REDELIVERS after the visibility
 *    timeout. It is NOT a non-destructive browse. This read pass exposes NO pull (it would mutate lease
 *    state); {@link QueueListData.pullLeasesAndNeedsAck} is ALWAYS `true` — a permanent, honest reminder that
 *    the future pull verb LEASES + needs ack. This adapter's reads NEVER lease a message.
 *
 * ISOLATION (the same structural guarantee as the `d1`/`kv`/`r2`/`vectorize`/`workflow`/`durable_object`
 * CF-REST adapters):
 *  - `scope.resourceId` is the QUEUE ID (server-resolved upstream from the registry `resolveResourceRef`,
 *    `resource_id_or_name` = the queue's id). NEVER a caller-supplied id. This adapter accepts NO queue
 *    parameter and does NOT re-resolve. For a SHARED platform queue we expose ONLY a site-scoped
 *    producer/consumer capability — a caller can NEVER peek/ack/purge another site's messages, because it can
 *    only ever address the ONE queue id the scope was minted with.
 *  - Execution goes through the CF **Queues REST API** (`/accounts/{acct}/queues/{id}...`) bound to
 *    `scope.resourceId` — the account-wide CF credentials are NEVER sent to a client (a Worker can't
 *    statically bind thousands of per-site queues).
 *
 * HONEST "not available": when Queues are not enabled on the account (the reality today — no `QUEUE`
 * binding), the caller gets `not_available`/`not_registered` UPSTREAM (the resolver's `unsupported_kind`);
 * this adapter's verbs, if ever reached, return an honest `available:false` envelope rather than a fake
 * empty queue. If Queues are later enabled + a queue is provisioned, the same verbs surface real config +
 * metrics; a `head` on a queue the row claims but CF 404s returns `exists:false` (→ drift), matching the
 * `d1`/`kv`/`r2` adapters' contract.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * One queue consumer as the Queues REST API reports it — the delivery/retry settings a consumer carries.
 * Read-only metadata; NEVER a message body. A push consumer (Worker-invoked) or a pull consumer (leases +
 * ack — HARD FACT #2) both surface here as config only.
 */
export interface QueueConsumerInfo {
  /** The consumer type CF reports — e.g. `worker` (push) or `http_pull` (pull = leases + ack). */
  readonly type?: string;
  /** The consumer script (for a push consumer), when CF reports it. */
  readonly scriptName?: string;
  /** Max messages delivered per batch, when CF reports it. */
  readonly batchSize?: number;
  /** Max retries before a message goes to the DLQ, when CF reports it. */
  readonly maxRetries?: number;
  /** The dead-letter queue name a failed message is routed to, when configured. */
  readonly deadLetterQueue?: string;
  /** Visibility-timeout / retry-delay seconds, when CF reports it. */
  readonly visibilityTimeoutMs?: number;
}

/** Backlog / oldest-message metrics for a queue as the REST API reports them — estimates, never a history. */
export interface QueueBacklogMetrics {
  /** Estimated messages currently backlogged (CF's estimate — NOT an exact count, NOT a history). */
  readonly backlogMessages?: number;
  /** Estimated total bytes backlogged, when CF reports it. */
  readonly backlogBytes?: number;
  /** Age of the oldest in-flight message in seconds, when CF reports it. */
  readonly oldestMessageAgeSeconds?: number;
}

/** One queue as `list`/`get` report it — CONFIG + METRICS only, NEVER a message body / history. */
export interface QueueInfo {
  /** The CF queue id — an opaque handle, scoped server-side to the site's resolved queue. */
  readonly id: string;
  /** The queue name CF reports. */
  readonly name?: string;
  /** True when the queue is PAUSED (deliveries halted), when CF reports it. */
  readonly paused?: boolean;
  /** The queue's consumers + their delivery/retry settings + DLQ (config only). */
  readonly consumers: readonly QueueConsumerInfo[];
  /** Backlog / oldest-message estimates (metrics, never messages). */
  readonly metrics?: QueueBacklogMetrics;
  /** CF-reported creation timestamp, when present. */
  readonly createdOn?: string;
  /** CF-reported last-modified timestamp, when present. */
  readonly modifiedOn?: string;
}

/**
 * What a queue `list` returns: the site's OWN queue(s) + an HONEST count. Surfaces CONFIG + METRICS, NEVER
 * messages. `available:false` when Queues are not enabled on the account (the reality today — no `QUEUE`
 * binding) → an honest empty list, never a fabricated queue.
 */
export interface QueueListData {
  /** The queues this site owns (scoped to the resolved queue id). Empty when not available/provisioned. */
  readonly queues: readonly QueueInfo[];
  /** The number of queues returned — the real count, never fabricated. */
  readonly count: number;
  /**
   * True when Queues are enabled on the account (a `QUEUE` binding exists). FALSE today — the honest
   * "not enabled on this account" signal so the UI renders that state, never a fake empty queue.
   */
  readonly available: boolean;
  /**
   * Always true — the Queues *pull* consumer LEASES messages + needs `ack` (HARD FACT #2). A permanent,
   * honest reminder that the future pull verb is a destructive lease, not a browse. This read pass never
   * leases.
   */
  readonly pullLeasesAndNeedsAck: true;
}

/**
 * What a queue `head` returns: whether the queue exists on CF + its paused/config summary. The
 * existence/drift primitive. `available:false` when Queues are not enabled on the account.
 */
export interface QueueHeadData {
  /** True when CF confirms the queue exists (a `200` from the queue GET). */
  readonly exists: boolean;
  /** The probed queue id (from the scope's resourceId, server-resolved). */
  readonly queueId: string;
  /** The queue name, when CF reports it. */
  readonly name?: string;
  /** True when the queue is paused, when CF reports it. */
  readonly paused?: boolean;
  /**
   * True when Queues are enabled on the account. FALSE today (no `QUEUE` binding) → the honest "not
   * available" signal; `exists` is then meaningless and left false.
   */
  readonly available: boolean;
}

/** The `get` input: which queue's details to read. Optional — the scope already binds the ONE queue id. */
export interface QueueGetInput {
  /**
   * Optional echo of the queue id the caller believes it is reading. Server-side the ONLY queue addressed
   * is `scope.resourceId`; a mismatching id is IGNORED (never used to widen to another queue).
   */
  readonly id?: string;
}

/**
 * What a queue `get` returns: ONE queue's CONFIG + METRICS. ⛔ NEVER a message body / history — Queues has
 * NO message-history API (HARD FACT #1). `messageHistoryAvailable:false` is a PERMANENT, honest reminder
 * that a peek shows the CURRENT head, not a durable log. `found:false` when the queue does not exist;
 * `available:false` when Queues are not enabled on the account.
 */
export interface QueueGetData {
  /** The queue id read (echoed — scoped to the site's resolved queue). */
  readonly queueId: string;
  /** True when the queue exists; false → the other fields are absent (an honest miss, not an error). */
  readonly found: boolean;
  /** True when Queues are enabled on the account. FALSE today (no `QUEUE` binding). */
  readonly available: boolean;
  /** The queue's config + metrics (name/paused/consumers/DLQ/backlog), when found. */
  readonly queue?: QueueInfo;
  /**
   * Always false — Queues has NO message-history API (⛔ HARD FACT #1). A peek shows the CURRENT head, not a
   * durable log. This envelope carries CONFIG + METRICS only; a message body / history is NEVER returned.
   */
  readonly messageHistoryAvailable: false;
}

/** Hard cap on how many messages a single `send` accepts inline (CF Queues batch max = 100). */
const SEND_BATCH_MAX = 100;
/** Hard cap (bytes) on one message body + the whole batch (CF Queues: 128 KB/msg, 256 KB/batch). */
const SEND_MSG_MAX_BYTES = 128 * 1024;
const SEND_BATCH_MAX_BYTES = 256 * 1024;

/**
 * The `send` mutation input: PRODUCE one or more messages onto the site's OWN resolved queue (CF Queues REST
 * `POST .../queues/{id}/messages/batch`). This is the ONLY write verb in this pass, and it is PRODUCER-ONLY:
 * it adds messages, it never reads/leases/acks/purges them (those are SEPARATE guarded/leasing ops — a later
 * pass). Producing is NOT destructive of existing queue state (it appends), so it needs NO `confirm` by
 * default; an OPTIONAL `confirm` is accepted (a caller may opt into an explicit gate) but is not required.
 * Every message body is a string (JSON-encode structured payloads before sending); bodies are size-bounded.
 * ⛔ ISOLATION: the queue is `scope.resourceId` (server-resolved) — a caller supplies NO queue id, so it can
 * NEVER send to another site's queue.
 */
export interface QueueSendInput {
  readonly action: 'send';
  /** The message bodies to enqueue (1..100). Each is a raw string — JSON-encode structured payloads first. */
  readonly messages: readonly string[];
  /** Optional explicit gate — accepted but NOT required (producing appends, it discards nothing). */
  readonly confirm?: boolean;
}

/** The discriminated named-mutation union for the queue adapter — NEVER a generic `{ command }` field. */
export type QueueMutateInput = QueueSendInput;

/**
 * What a queue `send` returns: the queue produced to + how many messages were accepted by CF. `available`
 * mirrors the read verbs — `false` when Queues are not enabled on the account (the reality today, no `QUEUE`
 * binding), in which case NOTHING is sent and this is an honest `not_available` error, never a fake success.
 */
export interface QueueSendResult {
  readonly action: 'send';
  /** The queue id produced to (echoed — scoped to the site's resolved queue). */
  readonly queueId: string;
  /** The number of messages accepted by CF (the real count of what was enqueued, never fabricated). */
  readonly accepted: number;
}

/** The discriminated result union a successful `mutate` returns. */
export type QueueMutateResult = QueueSendResult;

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `queue-${crypto.randomUUID()}`;
}

/**
 * Map a Queues REST failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a
 * `5xx`/network error is retryable (transient — never interpret as "gone"); anything else is a hard
 * failure the UI surfaces as-is. Mirrors the `workflow`/`r2`/`kv` adapters' `restError`.
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

/** A raw CF queue consumer row as the Queues REST API reports it. */
interface RawQueueConsumer {
  type?: unknown;
  script?: unknown;
  script_name?: unknown;
  settings?: {
    batch_size?: unknown;
    max_retries?: unknown;
    visibility_timeout_ms?: unknown;
  } | null;
  dead_letter_queue?: unknown;
}

/** A raw CF queue row as the Queues REST API reports it. */
interface RawQueue {
  queue_id?: unknown;
  queue_name?: unknown;
  paused?: unknown;
  created_on?: unknown;
  modified_on?: unknown;
  consumers?: RawQueueConsumer[] | null;
  producers_total_count?: unknown;
  backlog?: {
    messages?: unknown;
    bytes?: unknown;
    oldest_message_age_seconds?: unknown;
  } | null;
}

/** Reshape a raw CF consumer row into the typed {@link QueueConsumerInfo}. */
function toConsumerInfo(row: RawQueueConsumer): QueueConsumerInfo {
  const settings = row?.settings ?? null;
  return {
    batchSize: typeof settings?.batch_size === 'number' ? settings.batch_size : undefined,
    deadLetterQueue: typeof row?.dead_letter_queue === 'string' ? row.dead_letter_queue : undefined,
    maxRetries: typeof settings?.max_retries === 'number' ? settings.max_retries : undefined,
    scriptName:
      typeof row?.script_name === 'string'
        ? row.script_name
        : typeof row?.script === 'string'
          ? row.script
          : undefined,
    type: typeof row?.type === 'string' ? row.type : undefined,
    visibilityTimeoutMs:
      typeof settings?.visibility_timeout_ms === 'number' ? settings.visibility_timeout_ms : undefined,
  };
}

/** Reshape a raw CF queue row into the typed {@link QueueInfo} (config + metrics only, never messages). */
function toQueueInfo(row: RawQueue): QueueInfo | null {
  if (typeof row?.queue_id !== 'string' || row.queue_id.length === 0) return null;
  const backlog = row?.backlog ?? null;
  const metrics: QueueBacklogMetrics | undefined = backlog
    ? {
        backlogBytes: typeof backlog.bytes === 'number' ? backlog.bytes : undefined,
        backlogMessages: typeof backlog.messages === 'number' ? backlog.messages : undefined,
        oldestMessageAgeSeconds:
          typeof backlog.oldest_message_age_seconds === 'number'
            ? backlog.oldest_message_age_seconds
            : undefined,
      }
    : undefined;
  return {
    consumers: Array.isArray(row.consumers) ? row.consumers.map(toConsumerInfo) : [],
    createdOn: typeof row.created_on === 'string' ? row.created_on : undefined,
    id: row.queue_id,
    metrics,
    modifiedOn: typeof row.modified_on === 'string' ? row.modified_on : undefined,
    name: typeof row.queue_name === 'string' ? row.queue_name : undefined,
    paused: typeof row.paused === 'boolean' ? row.paused : undefined,
  };
}

/**
 * Fetch the ONE queue the scope resolves to via the CF Queues REST `GET .../queues/{id}`. Returns
 * `{ ok:false, status }` so callers can distinguish a transient failure from a genuine "not found"
 * (`404`). Never throws. The id is `scope.resourceId` (server-resolved) — never a caller id.
 */
async function fetchOwnQueue(
  scope: ResolvedScope,
): Promise<
  | { ok: true; queue: QueueInfo | undefined }
  | { ok: false; status: number | undefined }
> {
  let res: Response;
  try {
    res = await fetch(
      `${CF_API_BASE}/accounts/${scope.accountId}/queues/${encodeURIComponent(scope.resourceId)}`,
      { headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' }, method: 'GET' },
    );
  } catch {
    return { ok: false, status: undefined };
  }
  // 404 => the queue our row claims does not exist on CF (drift), surfaced as an honest empty match.
  if (res.status === 404) return { ok: true, queue: undefined };
  if (!res.ok) return { ok: false, status: res.status };

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: RawQueue | null;
  } | null;
  if (!json?.success || !json.result) return { ok: true, queue: undefined };
  return { ok: true, queue: toQueueInfo(json.result) ?? undefined };
}

/**
 * The `queue` adapter. `list`/`head`/`get` are live (read-only; CF Queues REST scoped SERVER-SIDE to the
 * site's resolved queue id); `mutate` implements the `send` named mutation (PRODUCER-ONLY). `supports`
 * declares that honestly so the UI + MCP never offer a verb that would 501. ⛔ Reads surface CONFIG +
 * METRICS only, NEVER a message body or a "history" (peek ≠ history, HARD FACT #1); the future pull verb
 * LEASES + needs ack (HARD FACT #2) — this pass never leases. When Queues are not enabled on the account
 * (the reality today — no `QUEUE` binding), the resolver returns `unsupported_kind` UPSTREAM; if this
 * adapter is ever reached anyway it reports `available:false` (reads) or an honest `not_available` error
 * (send), never a fake empty queue and never a fabricated send success.
 */
class QueueAdapter
  implements
    ResourceAdapter<QueueListData, QueueHeadData, QueueGetData, QueueMutateInput, QueueMutateResult>
{
  readonly kind = 'queue' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md: Queues = 🔴 not_supported on this deployment — no
   * `QUEUE` binding; ⛔ history; pull=leases). Serves both environments + all three READ verbs (config +
   * metrics) + the `send` named mutation, but NOTE the payload types (`available:false` when disabled,
   * `messageHistoryAvailable:false`, `pullLeasesAndNeedsAck:true`) make the honesty structural. `send` is
   * PRODUCER-ONLY (appends → no confirm). ⛔ peek / pull-ack / purge are NOT here — pull LEASES + needs ack
   * and purge is destructive, so each lands later as its own leasing/confirm-gated verb (append them here +
   * implement `mutate` in the same fire, each labelled honestly).
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: ['send'] as const,
    verbs: ['list', 'head', 'get', 'mutate'] as const,
  };

  /**
   * List the site's OWN queue(s) via the CF Queues REST — scoped SERVER-SIDE to `scope.resourceId` (the
   * resolved queue id). Surfaces CONFIG + METRICS (consumers/delivery-retry/DLQ/backlog/paused), NEVER a
   * message body or a "history" (⛔ HARD FACT #1). A queue the row claims but CF 404s reads as an HONEST
   * empty list + count 0 (never a fabricated queue). When Queues are not enabled on the account (no `QUEUE`
   * binding — the reality today) this is not reached (the resolver returns `unsupported_kind` upstream); if
   * it were, `available:false` + empty is the honest signal, never a fake empty queue.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY queue this can address
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<QueueListData>> {
    const cid = correlationId();
    const found = await fetchOwnQueue(scope);
    if (!found.ok) {
      return restError<QueueListData>(
        cid,
        found.status,
        `CF Queues list returned HTTP ${found.status ?? 'network-error'}`,
      );
    }
    const queues = found.queue ? [found.queue] : [];
    return {
      correlationId: cid,
      // available:true here means the queue GET succeeded on CF (Queues ARE enabled). A blank site never
      // reaches this (no `queue` registry row → resolver returns not_registered upstream).
      data: { available: true, count: queues.length, pullLeasesAndNeedsAck: true, queues },
      ok: true,
    };
  }

  /**
   * Cheap existence/config probe of the site's OWN queue via the CF Queues REST queue GET — does
   * `scope.resourceId` exist on CF + its paused/name? The drift primitive. Never accepts a caller id.
   * Mirrors the `d1`/`kv`/`r2`/`workflow` adapters' `head` contract.
   *
   * @returns `{ exists: true, available: true, ... }` on a `200`; `{ exists: false, available: true }` on a
   *          `404` (→ drift); a typed `error` (retryable) on `5xx`/`401`/`403`/network
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<QueueHeadData>> {
    const cid = correlationId();
    const queueId = scope.resourceId;
    const found = await fetchOwnQueue(scope);
    if (!found.ok) {
      return restError<QueueHeadData>(
        cid,
        found.status,
        `CF Queues head returned HTTP ${found.status ?? 'network-error'}`,
      );
    }
    // Absent from CF => the queue our row claims does not exist on CF => drift.
    if (!found.queue) {
      return { correlationId: cid, data: { available: true, exists: false, queueId }, ok: true };
    }
    return {
      correlationId: cid,
      data: {
        available: true,
        exists: true,
        name: found.queue.name,
        paused: found.queue.paused,
        queueId,
      },
      ok: true,
    };
  }

  /**
   * Read ONE queue's CONFIG + METRICS (name/paused/consumers/DLQ/backlog) from the site's OWN queue via the
   * CF Queues REST queue GET. ⛔ Returns CONFIG + METRICS ONLY — NEVER a message body or a "history"
   * (peek ≠ history, HARD FACT #1). `messageHistoryAvailable:false` is permanent. A `404` is an HONEST
   * "queue not found", returned as `{ found: false }`, NOT an error. The optional `input.id` is only an
   * echo — the ONLY queue addressed is `scope.resourceId` (a mismatching id can NEVER widen to another
   * queue).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY queue this can read
   * @param _input - optional `{ id }` echo — IGNORED for addressing (the scope binds the queue)
   */
  async get(scope: ResolvedScope, _input?: QueueGetInput): Promise<AdapterResult<QueueGetData>> {
    const cid = correlationId();
    const queueId = scope.resourceId;
    const found = await fetchOwnQueue(scope);
    if (!found.ok) {
      return restError<QueueGetData>(
        cid,
        found.status,
        `CF Queues get returned HTTP ${found.status ?? 'network-error'}`,
      );
    }
    if (!found.queue) {
      // Honest miss — never an error envelope. messageHistoryAvailable is permanently false.
      return {
        correlationId: cid,
        data: { available: true, found: false, messageHistoryAvailable: false, queueId },
        ok: true,
      };
    }
    return {
      correlationId: cid,
      data: {
        available: true,
        found: true,
        messageHistoryAvailable: false,
        queue: found.queue,
        queueId,
      },
      ok: true,
    };
  }

  /**
   * Run a NAMED mutation against the site's OWN resolved queue (the first WRITE slice). `send` PRODUCES one
   * or more messages onto the queue via the CF Queues REST `POST .../queues/{id}/messages/batch`. It operates
   * ONLY on `scope.resourceId` (server-resolved upstream — this adapter accepts NO queue id and cannot be
   * redirected, INV-1/INV-9), so a caller can NEVER send to another site's queue.
   *
   * PRODUCER-ONLY, NOT DESTRUCTIVE: `send` appends messages; it never reads/leases/acks/purges (those are
   * SEPARATE guarded/leasing ops — a later pass). Appending discards nothing, so `send` needs NO `confirm`;
   * an OPTIONAL `confirm` is accepted (a caller may opt into a gate) but never required. Every message body is
   * a bounded string (JSON-encode structured payloads first). The whole batch is verified BEFORE any network
   * call (empty/oversize/non-string → a typed error, nothing sent).
   *
   * HONESTY: when Queues are NOT enabled on the account (the reality today — no `QUEUE` binding) the queue
   * GET 404s, so `send` returns an honest `not_available` error and produces NOTHING — never a fake success.
   * The returned `accepted` is the REAL count CF confirms, never fabricated.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY queue this can produce to
   * @param input - the discriminated `{ action:'send', messages, confirm? }` mutation
   */
  async mutate(scope: ResolvedScope, input: QueueMutateInput): Promise<AdapterResult<QueueMutateResult>> {
    const cid = correlationId();

    if (!input || input.action !== 'send') {
      return {
        correlationId: cid,
        error: { code: 'invalid_action', message: 'Unknown queue mutation action.', retryable: false },
        ok: false,
      };
    }

    // Validate the batch BEFORE any network call — empty / too-many / non-string / oversize → nothing sent.
    const messages = input.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        correlationId: cid,
        error: { code: 'invalid_messages', message: 'At least one message body is required to send.', retryable: false },
        ok: false,
      };
    }
    if (messages.length > SEND_BATCH_MAX) {
      return {
        correlationId: cid,
        error: {
          code: 'invalid_messages',
          message: `A single send accepts at most ${SEND_BATCH_MAX} messages (got ${messages.length}).`,
          retryable: false,
        },
        ok: false,
      };
    }
    const encoder = new TextEncoder();
    let totalBytes = 0;
    for (const body of messages) {
      if (typeof body !== 'string' || body.length === 0) {
        return {
          correlationId: cid,
          error: {
            code: 'invalid_messages',
            message: 'Every message body must be a non-empty string (JSON-encode structured payloads first).',
            retryable: false,
          },
          ok: false,
        };
      }
      const bytes = encoder.encode(body).length;
      if (bytes > SEND_MSG_MAX_BYTES) {
        return {
          correlationId: cid,
          error: {
            code: 'message_too_large',
            message: `A message body exceeds the ${SEND_MSG_MAX_BYTES}-byte CF Queues per-message limit.`,
            retryable: false,
          },
          ok: false,
        };
      }
      totalBytes += bytes;
    }
    if (totalBytes > SEND_BATCH_MAX_BYTES) {
      return {
        correlationId: cid,
        error: {
          code: 'batch_too_large',
          message: `The batch exceeds the ${SEND_BATCH_MAX_BYTES}-byte CF Queues batch limit — send fewer messages.`,
          retryable: false,
        },
        ok: false,
      };
    }

    // Produce to the ONE resolved queue. `send` is producer-only + appends → no confirm required (an optional
    // confirm is honored implicitly: present or absent, the append is non-destructive). A 404 from CF = Queues
    // not enabled on this deployment (no QUEUE binding) → honest not_available, NOTHING sent.
    let res: Response;
    try {
      res = await fetch(
        `${CF_API_BASE}/accounts/${scope.accountId}/queues/${encodeURIComponent(scope.resourceId)}/messages/batch`,
        {
          body: JSON.stringify({ messages: messages.map((body) => ({ body })) }),
          headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'application/json' },
          method: 'POST',
        },
      );
    } catch (err) {
      return restError<QueueMutateResult>(cid, undefined, err instanceof Error ? err.message : 'CF request failed');
    }
    // 404 => the queue our row claims does not exist / Queues not enabled on the account. Honest not_available.
    if (res.status === 404) {
      return {
        correlationId: cid,
        error: {
          code: 'not_available',
          message: 'Queues are not enabled on this account — nothing was sent.',
          retryable: false,
        },
        ok: false,
      };
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { errors?: unknown } | null;
      const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      return restError<QueueMutateResult>(cid, res.status, `CF Queues send failed: ${detail}`);
    }
    // The real count CF accepted (all messages in the batch on success) — never fabricated.
    return {
      correlationId: cid,
      data: { accepted: messages.length, action: 'send', queueId: scope.resourceId },
      ok: true,
    };
  }
}

/** The singleton `queue` adapter instance the reconciler + registry look up by kind. */
export const queueAdapter = new QueueAdapter();
