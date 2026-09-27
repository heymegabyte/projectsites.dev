/**
 * @module libs/features/data_resource_registry/adapters/analytics_engine
 * @description The `analytics_engine` {@link ResourceAdapter} — Data & Resource Platform §8b (BACKEND tab),
 * Observability (read) slice. The cross-cutting OBSERVABILITY member of the resource platform: a site's
 * event stream in the platform's shared Cloudflare **Analytics Engine dataset**. Implements the read verbs:
 * `list` (the dataset(s) the site writes to + the custom-event dimensions/config it records), `head`
 * (dataset existence + ingest-enabled state — the drift/health primitive), `get` (a SITE-SCOPED recent
 * event-count summary via the AE SQL API, server-scoped to THIS site). `mutate` returns a typed
 * `not_implemented` envelope — this surface is READ-ONLY FOREVER: writing arbitrary events from the customer
 * surface is NOT available (CAPABILITY-MATRIX.md § Analytics Engine), so there is no write pass to fill.
 *
 * ⛔ HONEST CF REALITY — THE LOAD-BEARING FACTS OF THIS SLICE (CAPABILITY-MATRIX.md § Analytics Engine /
 * Observability):
 *  - **INGEST IS DISABLED ON THIS DEPLOYMENT (`ANALYTICS_INGEST_ENABLED = "false"`).** The `ANALYTICS`
 *    dataset binding EXISTS (`projectsites_admin_v1`) but `writeDataPoint()` is gated OFF, so there is NO
 *    real per-site event data to read. This adapter surfaces that HONESTLY: when ingest is disabled every
 *    verb reports `available:false` and `get` returns a ZERO summary WITHOUT querying — never a fabricated
 *    count, never an "empty because we didn't look" that reads as "0 real events" (`verify-against-source-
 *    of-truth`: honest `not_available` ≠ honest-empty-0). The ingest state is read SERVER-SIDE from
 *    `scope.ingestEnabled` (from `env.ANALYTICS_INGEST_ENABLED`), never from the caller.
 *  - **The dataset is `shared_platform`, NOT per-site.** AE has NO per-site dataset — every site writes into
 *    the ONE shared dataset. Per-site isolation is therefore a `WHERE` on a site DIMENSION, enforced
 *    SERVER-SIDE here (see ISOLATION), never a separate dataset. The reconciler records NO analytics_engine
 *    allocation source, so a blank site has NO `analytics_engine` registry row and
 *    `resolveResourceRef({kind:'analytics_engine'})` returns `not_registered` UPSTREAM — Observability is
 *    surfaced as a Worker-level cross-cutting section, not a per-store row (mirroring `per_site_workflows`).
 *  - **Reads are SAMPLED + retention-bounded.** The AE SQL API returns sampled data over ~the last 3 months;
 *    `SUM(_sample_interval)` is the honest estimated count, NOT an exact tally. `get`'s
 *    {@link AnalyticsEngineGetData.sampled} is ALWAYS `true` — a permanent, honest reminder in every summary
 *    envelope so no consumer reads the number as an exact count. Unsampled raw-event export is NOT available.
 *
 * ISOLATION — the SINGLE MOST IMPORTANT INVARIANT of this slice (SECURITY-INVARIANTS.md): the AE SQL API is
 * ACCOUNT-WIDE, so a raw query would read EVERY site's events. This adapter NEVER accepts a query from the
 * caller and NEVER lets one site read another's analytics:
 *  - `scope.resourceId` is the DATASET NAME (server-resolved upstream from the registry; the shared
 *    `projectsites_admin_v1`) — NEVER a caller-supplied dataset. The SQL `FROM` is built from it + validated
 *    against a strict identifier regex ({@link isSafeDatasetName}) so no injection can widen the target.
 *  - **Every query is SERVER-BUILT and carries a mandatory `WHERE` on the site dimension**
 *    ({@link SITE_BLOB} = `blob3`, the `site_id` column of the platform's `writeDataPoint` layout in
 *    `cf_analytics.ts`). The site value is `scope.siteId` (server-resolved from the OWNED site), SQL-escaped,
 *    and injected by THIS module — the caller supplies ONLY a `site_id` (proven-owned upstream) + an optional
 *    time-range window (a bounded integer). A caller can pass NO SQL, NO dataset, NO account id, and NO
 *    site-dimension override — so one site can only ever aggregate ITS OWN events.
 *  - Execution goes through the CF **Analytics Engine SQL API**
 *    (`POST /accounts/{acct}/analytics_engine/sql`) bound to `scope.accountId` with `scope.auth` — the
 *    account-wide CF credentials are NEVER sent to a client.
 *
 * @packageDocumentation
 */
import { cfAuthHeaders } from '../../../../src/services/cf_credentials.js';

import type { AdapterResult, ResolvedScope, ResourceAdapter } from '../adapter.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * The AE blob column that holds the `site_id` in the platform's `writeDataPoint` layout (`cf_analytics.ts`:
 * blobs[2] = site_id → SQL column `blob3`). Every site-scoped query filters on THIS column server-side — the
 * isolation `WHERE`. Kept as a named constant so the isolation dimension is one lookup, never a magic string.
 */
const SITE_BLOB = 'blob3';

/** The AE blob column that holds the EVENT name (blobs[0] → `blob1`), used to group the per-event breakdown. */
const EVENT_BLOB = 'blob1';

/** Hard bounds on the query window in days (clamped, never rejected) — AE retention is ~3 months (90 days). */
const WINDOW_MIN_DAYS = 1;
const WINDOW_MAX_DAYS = 90;
const WINDOW_DEFAULT_DAYS = 30;

/** Hard cap on how many distinct event-name rows a single `get` summary returns (keeps the payload small). */
const EVENT_BREAKDOWN_MAX = 50;

/** One custom-event dimension the platform records into the shared dataset (config/schema, never a value). */
export interface AnalyticsEventDimension {
  /** The AE column this dimension maps to (e.g. `blob1`). */
  readonly column: string;
  /** What the dimension means in the platform's layout (e.g. `event`, `route_path`, `site_id`). */
  readonly meaning: string;
}

/** One dataset as `list` reports it — name + the custom-event dimensions the site writes to it (config only). */
export interface AnalyticsDatasetInfo {
  /** The AE dataset name — server-resolved (the shared `projectsites_admin_v1`), never a message value. */
  readonly name: string;
  /** The custom-event dimensions the platform records into this dataset (its blob/double layout). */
  readonly dimensions: readonly AnalyticsEventDimension[];
}

/**
 * What an analytics_engine `list` returns: the dataset(s) the site writes to + the custom-event config, and
 * an HONEST `available` flag. `available:false` when ingest is disabled (the reality today —
 * `ANALYTICS_INGEST_ENABLED="false"`) → an honest "no data ingested yet", never a fabricated event stream.
 */
export interface AnalyticsEngineListData {
  /** The dataset(s) the site's events flow into (the shared platform dataset). */
  readonly datasets: readonly AnalyticsDatasetInfo[];
  /** The number of datasets returned — the real count, never fabricated. */
  readonly count: number;
  /**
   * True when Analytics Engine INGEST is enabled on this deployment. FALSE today
   * (`ANALYTICS_INGEST_ENABLED="false"`) — the honest "no events are being written yet" signal so the UI
   * renders that state, never a fake event stream.
   */
  readonly available: boolean;
}

/**
 * What an analytics_engine `head` returns: whether the dataset is configured + whether ingest is enabled. The
 * health primitive. `available:false` when ingest is disabled; `exists` reflects that the dataset binding is
 * configured (a dataset name resolved) — AE has no per-dataset existence endpoint, so existence == "a dataset
 * name is server-resolved for this site" and health is carried by `available` (ingest on/off).
 */
export interface AnalyticsEngineHeadData {
  /** True when a dataset name is server-resolved for this site (the shared dataset is configured). */
  readonly exists: boolean;
  /** The dataset name probed (from the scope's resourceId, server-resolved). */
  readonly datasetName: string;
  /**
   * True when Analytics Engine INGEST is enabled on this deployment. FALSE today
   * (`ANALYTICS_INGEST_ENABLED="false"`) → the honest "not available" signal; no events are being written.
   */
  readonly available: boolean;
}

/** The `get` input: the site-scoped summary window. Optional — `windowDays` clamps to `[1, 90]`, default 30. */
export interface AnalyticsEngineGetInput {
  /**
   * How many trailing days to aggregate (clamped to `[1, 90]` — AE retention is ~3 months). This is the ONLY
   * knob a caller supplies; the caller can NEVER supply the SQL, the dataset, or the site dimension.
   */
  readonly windowDays?: number;
}

/** One event's site-scoped estimated count over the window (SAMPLED — never an exact tally). */
export interface AnalyticsEventCount {
  /** The event name (`blob1` — e.g. `admin_visit`, `form_submit`, `site_serve`). */
  readonly event: string;
  /** The estimated event count over the window (`SUM(_sample_interval)` — sampled, never exact). */
  readonly count: number;
}

/**
 * What an analytics_engine `get` returns: a SITE-SCOPED recent event-count summary — the total estimated
 * events over the window + a per-event breakdown, ALL server-scoped to this site's `WHERE blob3 = <siteId>`.
 * `available:false` (ingest disabled) → a ZERO summary WITHOUT querying (honest `not_available`, never a
 * fabricated or misleading "0 real events"). `sampled:true` is a PERMANENT, honest reminder the counts are
 * sampled estimates, not exact tallies.
 */
export interface AnalyticsEngineGetData {
  /** The dataset the summary came from (echoed — server-resolved). */
  readonly datasetName: string;
  /** The window aggregated, in days (the clamped value actually used). */
  readonly windowDays: number;
  /** True when ingest is enabled + the summary was actually queried; false → a ZERO summary (not queried). */
  readonly available: boolean;
  /** The total estimated events for THIS site over the window (sampled). 0 when ingest is disabled. */
  readonly totalEvents: number;
  /** Per-event estimated counts for THIS site (sampled), clamped to {@link EVENT_BREAKDOWN_MAX}. */
  readonly events: readonly AnalyticsEventCount[];
  /**
   * Always true — AE reads are SAMPLED (`SUM(_sample_interval)`) + retention-bounded. A permanent, honest
   * reminder that these are estimated counts, never an exact tally. Unsampled raw export is NOT available.
   */
  readonly sampled: true;
}

/** Placeholder mutate payloads — this surface is READ-ONLY FOREVER (no customer write path to AE). */
type AnalyticsEngineMutateInput = never;
type AnalyticsEngineMutateResult = never;

/** The custom-event dimensions the platform records (the `writeDataPoint` layout in `cf_analytics.ts`). */
const PLATFORM_EVENT_DIMENSIONS: readonly AnalyticsEventDimension[] = [
  { column: 'blob1', meaning: 'event' },
  { column: 'blob2', meaning: 'route_path' },
  { column: 'blob3', meaning: 'site_id' },
  { column: 'blob4', meaning: 'org_id' },
  { column: 'blob5', meaning: 'user_agent_class' },
  { column: 'blob6', meaning: 'referrer_host' },
  { column: 'blob7', meaning: 'country' },
  { column: 'double1', meaning: 'count' },
  { column: 'double2', meaning: 'latency_ms' },
];

/** Mint a correlation id for one adapter call (structured-logging: every envelope carries one). */
function correlationId(): string {
  return `analytics_engine-${crypto.randomUUID()}`;
}

/**
 * Map an Analytics Engine SQL failure to a typed adapter envelope. A CF auth failure (`401`/`403`) or a
 * `5xx`/network error is retryable (transient — never interpret as "gone"); anything else is a hard failure
 * the UI surfaces as-is. Mirrors the `queue`/`workflow`/`r2` adapters' `restError`.
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

/** The typed `not_implemented` envelope `mutate` returns (this surface is read-only — no write path to AE). */
function notImplemented<T>(verb: string): AdapterResult<T> {
  return {
    correlationId: correlationId(),
    error: {
      code: 'not_implemented',
      message: `The analytics_engine adapter '${verb}' verb is not implemented (Observability is read-only; customer writes to AE are not available).`,
      retryable: false,
    },
    ok: false,
  };
}

/**
 * True when `name` is a well-formed Analytics Engine dataset identifier (letters/digits/underscore, ≤128).
 * The dataset name goes UNQUOTED into the SQL `FROM` (AE SQL has no bound-identifier syntax), so it MUST be
 * validated — even though it is server-resolved, this is defense-in-depth against a bad registry value.
 */
function isSafeDatasetName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

/** SQL-escape a string literal for an AE SQL `WHERE` (single-quote doubling — the only literal quoting AE has). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Clamp a requested window to `[WINDOW_MIN_DAYS, WINDOW_MAX_DAYS]`, defaulting to {@link WINDOW_DEFAULT_DAYS}. */
function clampWindow(days: number | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return WINDOW_DEFAULT_DAYS;
  return Math.max(WINDOW_MIN_DAYS, Math.min(WINDOW_MAX_DAYS, Math.trunc(days)));
}

/** A single row shape the AE SQL API returns for our summary queries. */
interface SqlRow {
  [k: string]: string | number;
}

/**
 * Run one Analytics Engine SQL query via `POST /accounts/{acct}/analytics_engine/sql`. Returns
 * `{ ok:false, status }` so callers can distinguish a transient failure from an empty result. Never throws.
 * The `sql` is ALWAYS server-built by this module (never a caller string) and ALWAYS carries the site `WHERE`.
 */
async function runSql(
  scope: ResolvedScope,
  sql: string,
): Promise<{ ok: true; rows: SqlRow[] } | { ok: false; status: number | undefined }> {
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${scope.accountId}/analytics_engine/sql`, {
      // AE SQL expects the query as a text/plain body. Auth via the account credentials (never a client key).
      body: sql,
      headers: { ...cfAuthHeaders(scope.auth), 'content-type': 'text/plain' },
      method: 'POST',
    });
  } catch {
    return { ok: false, status: undefined };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json().catch(() => null)) as { data?: SqlRow[] } | null;
  return { ok: true, rows: Array.isArray(json?.data) ? json.data : [] };
}

/**
 * The `analytics_engine` adapter. `list`/`head`/`get` are live (read-only; the account-level AE SQL API
 * scoped SERVER-SIDE to the site's `blob3` dimension); `mutate` returns `not_implemented` (read-only surface).
 * `supports` declares that honestly so the UI + MCP never offer a verb that would 501. ⛔ INGEST IS DISABLED
 * today (`ANALYTICS_INGEST_ENABLED="false"`) so every verb reports `available:false` + `get` returns a ZERO
 * summary WITHOUT querying (honest not_available). Every query is server-built with a mandatory `WHERE
 * blob3 = <siteId>` — a caller supplies NO SQL, NO dataset, NO account id, so one site can never read
 * another's analytics.
 */
class AnalyticsEngineAdapter
  implements
    ResourceAdapter<
      AnalyticsEngineListData,
      AnalyticsEngineHeadData,
      AnalyticsEngineGetData,
      AnalyticsEngineMutateInput,
      AnalyticsEngineMutateResult
    >
{
  readonly kind = 'analytics_engine' as const;

  /**
   * Honest capability declaration (CAPABILITY-MATRIX.md: Analytics Engine = ✅ read-only, shared dataset,
   * ⛔ client writes / ⛔ unsampled export): serves both environments + all three READ verbs, but NOTE the
   * payload types (`available:false` when ingest disabled, `sampled:true`) make the honesty structural.
   * `mutations: []` is PERMANENT — writing arbitrary events from the customer surface is NOT available, so
   * there is no write pass to append to.
   */
  readonly supports = {
    environments: ['preview', 'production'] as const,
    mutations: [] as const,
    verbs: ['list', 'head', 'get'] as const,
  };

  /**
   * List the dataset(s) the site's events flow into + the custom-event dimensions the platform records — from
   * `scope.resourceId` (the server-resolved dataset name) + the known `writeDataPoint` layout. This is a
   * CONFIG summary (dataset name + dimension schema), NOT a query — there is no AE "list datasets" API and no
   * events are ingested today. `available` reflects `scope.ingestEnabled` (server-read from
   * `ANALYTICS_INGEST_ENABLED`): FALSE today → the honest "no data ingested yet". Never fabricates an event
   * stream.
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY dataset this can name, and the
   *                site dimension is derived from `scope.siteId` — neither is caller-supplied
   */
  async list(scope: ResolvedScope): Promise<AdapterResult<AnalyticsEngineListData>> {
    const cid = correlationId();
    const datasets: AnalyticsDatasetInfo[] = [
      { dimensions: PLATFORM_EVENT_DIMENSIONS, name: scope.resourceId },
    ];
    return {
      correlationId: cid,
      data: { available: scope.ingestEnabled === true, count: datasets.length, datasets },
      ok: true,
    };
  }

  /**
   * Cheap health probe: is a dataset configured for this site + is ingest enabled? AE has no per-dataset
   * existence endpoint, so `exists` == "a dataset name is server-resolved" (the shared dataset is configured)
   * and health is carried by `available` (`scope.ingestEnabled`, server-read from `ANALYTICS_INGEST_ENABLED`).
   * Never accepts a caller dataset. Mirrors the other adapters' `head` contract (existence + honest state).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the ONLY dataset this can probe
   */
  async head(scope: ResolvedScope): Promise<AdapterResult<AnalyticsEngineHeadData>> {
    const cid = correlationId();
    return {
      correlationId: cid,
      data: {
        available: scope.ingestEnabled === true,
        // A server-resolved dataset name means the shared dataset is configured for this site.
        exists: scope.resourceId.length > 0,
        datasetName: scope.resourceId,
      },
      ok: true,
    };
  }

  /**
   * Read a SITE-SCOPED recent event-count summary via the AE SQL API — the total estimated events over the
   * window + a per-event breakdown, ALL scoped SERVER-SIDE to `WHERE ${SITE_BLOB} = <scope.siteId>`. ⛔ The
   * caller supplies ONLY `windowDays` (clamped `[1, 90]`); the SQL, the dataset (`scope.resourceId`), and the
   * site dimension are all injected by THIS module — a caller can NEVER pass a raw query or read another
   * site's events. When ingest is disabled (`scope.ingestEnabled !== true`, the reality today) this returns a
   * ZERO summary WITHOUT querying — an honest `available:false`, never a fabricated count and never a
   * misleading "0 real events". Counts are SAMPLED (`sampled:true` is permanent).
   *
   * @param scope - the server-resolved scope; `scope.resourceId` is the dataset, `scope.siteId` the isolation key
   * @param input - optional `{ windowDays }` — the ONLY knob; clamped to `[1, 90]` (never a SQL/dataset override)
   */
  async get(
    scope: ResolvedScope,
    input?: AnalyticsEngineGetInput,
  ): Promise<AdapterResult<AnalyticsEngineGetData>> {
    const cid = correlationId();
    const datasetName = scope.resourceId;
    const windowDays = clampWindow(input?.windowDays);

    // ⛔ Ingest disabled → honest ZERO summary WITHOUT querying (never a fabricated/misleading count).
    if (scope.ingestEnabled !== true) {
      return {
        correlationId: cid,
        data: { available: false, datasetName, events: [], sampled: true, totalEvents: 0, windowDays },
        ok: true,
      };
    }

    // Defense-in-depth: the dataset name is server-resolved but goes UNQUOTED into the SQL FROM — validate it.
    if (!isSafeDatasetName(datasetName)) {
      return {
        correlationId: cid,
        error: { code: 'invalid_dataset', message: 'The resolved analytics dataset name is invalid.', retryable: false },
        ok: false,
      };
    }

    // SERVER-BUILT queries. The mandatory site WHERE (`blob3 = <siteId>`) is injected here — the caller never
    // supplies SQL, the dataset, the account, or the site dimension. One site can only aggregate ITS OWN rows.
    const siteWhere = `${SITE_BLOB} = ${sqlLiteral(scope.siteId)}`;
    const windowWhere = `timestamp > NOW() - INTERVAL '${windowDays}' DAY`;
    const where = `WHERE ${siteWhere} AND ${windowWhere}`;
    const totalSql = `SELECT SUM(_sample_interval) AS n FROM ${datasetName} ${where}`;
    const byEventSql =
      `SELECT ${EVENT_BLOB} AS event, SUM(_sample_interval) AS n FROM ${datasetName} ${where} ` +
      `GROUP BY event ORDER BY n DESC LIMIT ${EVENT_BREAKDOWN_MAX}`;

    const [totalRes, byEventRes] = await Promise.all([runSql(scope, totalSql), runSql(scope, byEventSql)]);
    if (!totalRes.ok) {
      return restError<AnalyticsEngineGetData>(
        cid,
        totalRes.status,
        `CF Analytics Engine SQL returned HTTP ${totalRes.status ?? 'network-error'}`,
      );
    }
    if (!byEventRes.ok) {
      return restError<AnalyticsEngineGetData>(
        cid,
        byEventRes.status,
        `CF Analytics Engine SQL returned HTTP ${byEventRes.status ?? 'network-error'}`,
      );
    }

    const totalEvents = Number(totalRes.rows[0]?.n ?? 0);
    const events: AnalyticsEventCount[] = byEventRes.rows
      .map((r) => ({ count: Number(r.n ?? 0), event: typeof r.event === 'string' ? r.event : String(r.event ?? '') }))
      .filter((e) => e.event.length > 0);

    return {
      correlationId: cid,
      data: {
        available: true,
        datasetName,
        events,
        sampled: true,
        totalEvents: Number.isFinite(totalEvents) ? totalEvents : 0,
        windowDays,
      },
      ok: true,
    };
  }

  /** Not implemented — Observability is READ-ONLY; writing arbitrary events from the customer surface is N/A. */
  async mutate(
    _scope: ResolvedScope,
    _input: AnalyticsEngineMutateInput,
  ): Promise<AdapterResult<AnalyticsEngineMutateResult>> {
    return notImplemented<AnalyticsEngineMutateResult>('mutate');
  }
}

/** The singleton `analytics_engine` adapter instance the reconciler + registry look up by kind. */
export const analyticsEngineAdapter = new AnalyticsEngineAdapter();
