/**
 * Log Explorer backend — real Worker tail-log search + cost-by-route attribution
 * for the `/admin/logs` admin section.
 *
 * Source of truth: **Cloudflare Workers Observability** (the `[observability]`
 * pipeline in `wrangler.toml`). Every request emits a structured
 * `console.warn(JSON.stringify({ eventName:'http_request', level, method, path,
 * status, durationMs, requestId, ts, … }))` line, which CF ingests and exposes
 * through the Observability Telemetry query API
 * (`POST /accounts/{id}/workers/observability/telemetry/query`, dataset
 * `cloudflare-workers`). This service queries that API, maps events to the log
 * rows the admin UI renders, applies a small search DSL in-worker, and rolls up
 * per-route cost.
 *
 * Auth: the worker-bundled global key (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`,
 * via {@link ./cf_credentials.ts}) — the same credential the analytics services
 * use. Fail-soft: any error returns an empty result (never throws) so the panel
 * degrades to its honest empty state instead of a crash.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';

/** A log row as the admin Log Explorer table renders it. */
export interface LogRow {
  id: string;
  ts: string;
  level: string;
  request_id: string;
  /**
   * Distributed-trace id correlating this row with the full request trace
   * (Workers Tracing / the error envelope's `correlationId`). `null` when the
   * event carried none — the UI links a row → its trace only when present.
   */
  trace_id: string | null;
  route: string;
  method: string;
  status: number | null;
  duration_ms: number | null;
  cost_estimate: number;
  /**
   * Structured error code (`NOT_FOUND`, `VALIDATION_ERROR`, …) from a thrown
   * `AppError` the error handler logged. `null` for ordinary request/info rows
   * (createLogger-shape events have no top-level `code`).
   */
  code: string | null;
  message: string;
  meta: unknown;
}

/** Per-route cost rollup row for the cost-by-route bar chart. */
export interface CostRow {
  route: string;
  request_count: number;
  total_cost: number;
  avg_duration_ms: number;
  error_count: number;
  cost_share_pct: number;
}

export type LogRange = '1h' | '6h' | '24h' | '7d' | '30d';

const RANGE_TO_MS: Record<LogRange, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

/** Coerce an arbitrary string to a known range (defaults to `24h`). */
export function parseLogRange(input: string | null | undefined): LogRange {
  return input === '1h' || input === '6h' || input === '7d' || input === '30d' ? input : '24h';
}

// ── Search DSL ───────────────────────────────────────────────────────────────

/** Parsed constraints from a Log Explorer DSL query (AND semantics). */
export interface LogFilters {
  level?: string;
  /** Route glob (`*` wildcard) compiled to a matcher. */
  routeMatch?: (path: string) => boolean;
  routeRaw?: string;
  minStatus?: number;
  exactStatus?: number;
  minDurationMs?: number;
  /** Free-text tokens (lowercased) matched against message + route. */
  text: string[];
}

/** Compile a `route:` glob (`/api/sites/*`) into a matcher. */
function globMatcher(glob: string): (path: string) => boolean {
  if (!glob.includes('*')) return (p) => p === glob || p.startsWith(glob);
  const re = new RegExp(
    '^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return (p) => re.test(p);
}

/**
 * Parse the Log Explorer search DSL. Supports (all AND-combined):
 *  - `level:error` — exact level
 *  - `route:/api/sites/*` / `path:/x` — route glob (`*` wildcard)
 *  - `status:500` / `status>=500` / `status>499` — status filter
 *  - `duration>2s` / `duration>500ms` / `duration>=1000` — min duration
 *  - any other token — free-text (matched against message + route)
 *
 * @param query - The raw DSL string (may be empty → matches everything).
 * @returns The parsed {@link LogFilters}.
 *
 * @example
 * parseLogQuery('level:error AND route:/api/sites/* AND duration>2s');
 * // → { level:'error', routeMatch: fn, minDurationMs:2000, text:[] }
 */
export function parseLogQuery(query: string): LogFilters {
  const filters: LogFilters = { text: [] };
  const tokens = (query ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && t.toUpperCase() !== 'AND');

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower.startsWith('level:')) {
      filters.level = lower.slice(6);
    } else if (lower.startsWith('route:') || lower.startsWith('path:')) {
      const glob = tok.slice(tok.indexOf(':') + 1);
      filters.routeRaw = glob;
      filters.routeMatch = globMatcher(glob);
    } else if (lower.startsWith('status')) {
      const m = /status\s*(>=|>|:|=)\s*(\d{3})/.exec(lower);
      if (m) {
        if (m[1] === '>=' || m[1] === '>')
          filters.minStatus = Number(m[2]) + (m[1] === '>' ? 1 : 0);
        else filters.exactStatus = Number(m[2]);
      }
    } else if (lower.startsWith('duration')) {
      const m = /duration\s*(>=|>)\s*(\d+(?:\.\d+)?)(ms|s)?/.exec(lower);
      if (m) {
        const n = Number(m[2]);
        filters.minDurationMs =
          m[3] === 's' ? n * 1000 : m[3] === 'ms' ? n : n >= 1000 ? n : n * 1000;
      }
    } else {
      filters.text.push(lower);
    }
  }
  return filters;
}

/** Does a mapped row satisfy every parsed constraint (AND)? */
export function rowMatches(row: LogRow, f: LogFilters): boolean {
  if (f.level && row.level.toLowerCase() !== f.level) return false;
  if (f.routeMatch && !f.routeMatch(row.route)) return false;
  if (f.exactStatus !== undefined && row.status !== f.exactStatus) return false;
  if (f.minStatus !== undefined && (row.status ?? 0) < f.minStatus) return false;
  if (f.minDurationMs !== undefined && (row.duration_ms ?? 0) < f.minDurationMs) return false;
  if (f.text.length > 0) {
    const hay = `${row.message} ${row.route} ${row.method}`.toLowerCase();
    if (!f.text.every((t) => hay.includes(t))) return false;
  }
  return true;
}

// ── Cost model ───────────────────────────────────────────────────────────────

/** $0.30 / million requests (Workers paid invocation price). */
const COST_PER_REQUEST = 0.3 / 1_000_000;
/** Nominal CPU weight per ms so slower routes attribute more cost (relative signal). */
const COST_PER_MS = 1.5e-9;

/** Estimated dollar cost of one request given its duration. */
export function estimateCost(durationMs: number | null): number {
  return COST_PER_REQUEST + (durationMs ?? 0) * COST_PER_MS;
}

// ── Observability query ──────────────────────────────────────────────────────

/**
 * One raw Observability event source we depend on. Two logger shapes flow in:
 *  - **createLogger / http_request** — `{ msg, path, requestId, durationMs, … }`
 *    (camelCase; the structured `console.warn` wrapper).
 *  - **thrown AppError** — logged by `middleware/error_handler.ts` via a raw
 *    `console.warn(JSON.stringify({ code, message, request_id, status, url,
 *    method }))` — snake_case `request_id`/`url`, a top-level `code`, `message`
 *    (not `msg`), and NO `path`/`requestId`. {@link mapEvent} reads both.
 */
interface ObsSource {
  ts?: string;
  level?: string;
  msg?: string;
  /** Thrown-AppError message key (error_handler emits `message`, not `msg`). */
  message?: string;
  /** Structured error code from a thrown AppError (`NOT_FOUND`, …). */
  code?: string;
  eventName?: string;
  service?: string;
  scope?: string;
  requestId?: string;
  /** Thrown-AppError snake_case request id (error_handler emits `request_id`). */
  request_id?: string;
  /** Distributed-trace id, either camel or snake depending on the emitter. */
  traceId?: string;
  trace_id?: string;
  method?: string;
  path?: string;
  /** Thrown-AppError route key (error_handler emits `url`, not `path`). */
  url?: string;
  route?: string;
  status?: number;
  durationMs?: number;
}
interface ObsResponse {
  success?: boolean;
  result?: { events?: { events?: Array<{ source?: ObsSource }> } };
  errors?: Array<{ message?: string }>;
}

/**
 * Map a raw Observability event to a {@link LogRow}, normalizing BOTH logger
 * shapes (createLogger camelCase + thrown-AppError snake_case — see
 * {@link ObsSource}). A 500 that threw an `AppError` therefore surfaces its real
 * `code` + `message` + route, never an empty/generic edge-level row.
 *
 * @param src - One raw Observability event source.
 * @param i - Index within the page (keeps `id` unique when `requestId` repeats).
 * @returns The normalized row the admin Log Explorer renders.
 */
export function mapEvent(src: ObsSource, i: number): LogRow {
  // Route: thrown-AppError events carry `url` (not `path`); fall through the rest.
  const route = src.path ?? src.url ?? src.route ?? src.service ?? src.scope ?? '—';
  // request_id: createLogger emits `requestId`; error_handler emits `request_id`.
  const requestId = src.requestId ?? src.request_id ?? '';
  // trace_id: either casing; `null` (not '') when absent so the UI can gate on it.
  const traceId = src.traceId ?? src.trace_id ?? null;
  const durationMs = typeof src.durationMs === 'number' ? src.durationMs : null;
  return {
    id: `${requestId || 'log'}:${src.ts ?? ''}:${i}`,
    ts: src.ts ?? '',
    level: src.level ?? 'info',
    request_id: requestId,
    trace_id: traceId,
    route,
    method: src.method ?? '',
    status: typeof src.status === 'number' ? src.status : null,
    duration_ms: durationMs,
    cost_estimate: estimateCost(durationMs),
    // Structured error code from a thrown AppError; `null` for ordinary rows.
    code: src.code ?? null,
    // Message: createLogger emits `msg`; error_handler emits `message`.
    message: src.msg ?? src.message ?? src.eventName ?? '',
    meta: src,
  };
}

/**
 * Query the Workers Observability Telemetry API for the most-recent events in
 * the window. Fail-soft: returns `[]` on missing creds or any API error.
 *
 * @param env - Worker bindings (needs `CF_ACCOUNT_ID` + global-key creds).
 * @param range - Time window.
 * @param limit - Max events to fetch (search uses ~200, cost uses ~1000).
 * @returns Mapped log rows, newest first.
 */
export async function queryObservability(
  env: Env,
  range: LogRange,
  limit: number,
): Promise<LogRow[]> {
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) return [];
  const auth = await resolveCfCredentials(env, null);
  if (!auth) return [];

  const to = Date.now();
  const from = to - RANGE_TO_MS[range];

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
      {
        body: JSON.stringify({
          queryId: 'admin-log-explorer',
          timeframe: { from, to },
          limit: Math.min(Math.max(limit, 1), 1000),
          parameters: { datasets: ['cloudflare-workers'] },
          view: 'events',
        }),
        headers: { ...cfAuthHeaders(auth), 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          body: (await res.text()).slice(0, 200),
          level: 'warn',
          op: 'queryObservability',
          service: 'logs_explorer',
          status: res.status,
        }),
      );
      return [];
    }
    const json = (await res.json()) as ObsResponse;
    const events = json.result?.events?.events ?? [];
    return events.map((e, i) => mapEvent(e.source ?? {}, i));
  } catch (err) {
    console.warn(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        level: 'warn',
        op: 'queryObservability',
        service: 'logs_explorer',
      }),
    );
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Result envelope for `POST /api/logs/search`. */
export interface SearchResult {
  items: LogRow[];
  next_cursor: string | null;
  total_returned: number;
}

/**
 * Search Worker tail logs. Fetches recent events from Observability, applies the
 * DSL filter in-worker, and returns up to `limit` rows.
 *
 * @remarks Single-page (no cursor) — `next_cursor` is always `null`; the UI hides
 *   "Load more" accordingly. Fail-soft (empty on error).
 */
export async function searchLogs(
  env: Env,
  opts: { query: string; range: LogRange; limit: number },
): Promise<SearchResult> {
  // Over-fetch (filtering happens in-worker) so a narrow DSL still fills a page.
  const raw = await queryObservability(env, opts.range, Math.min(opts.limit * 5, 1000));
  const filters = parseLogQuery(opts.query);
  const items = raw.filter((r) => rowMatches(r, filters)).slice(0, opts.limit);
  return { items, next_cursor: null, total_returned: items.length };
}

/** Result envelope for `GET /api/logs/cost-by-route`. */
export interface CostResult {
  range: string;
  grand_total_cost: number;
  rows: CostRow[];
}

/**
 * Roll up cost + volume per route over the window. Aggregates recent
 * `http_request` events (up to 1000) by route. Fail-soft (empty rows on error).
 */
export async function costByRoute(env: Env, range: LogRange): Promise<CostResult> {
  const rows = await queryObservability(env, range, 1000);
  const byRoute = new Map<
    string,
    { count: number; cost: number; durationTotal: number; errors: number }
  >();
  for (const r of rows) {
    // Only attribute cost to real request rows (have a method/status).
    if (!r.method && r.status === null) continue;
    const agg = byRoute.get(r.route) ?? { count: 0, cost: 0, durationTotal: 0, errors: 0 };
    agg.count += 1;
    agg.cost += r.cost_estimate;
    agg.durationTotal += r.duration_ms ?? 0;
    if ((r.status ?? 0) >= 500) agg.errors += 1;
    byRoute.set(r.route, agg);
  }
  const grand = [...byRoute.values()].reduce((s, a) => s + a.cost, 0);
  const costRows: CostRow[] = [...byRoute.entries()]
    .map(([route, a]) => ({
      route,
      request_count: a.count,
      total_cost: a.cost,
      avg_duration_ms: a.count > 0 ? a.durationTotal / a.count : 0,
      error_count: a.errors,
      cost_share_pct: grand > 0 ? (a.cost / grand) * 100 : 0,
    }))
    .sort((x, y) => y.total_cost - x.total_cost);
  return { range, grand_total_cost: grand, rows: costRows };
}
