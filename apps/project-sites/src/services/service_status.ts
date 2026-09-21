/**
 * service_status.ts — pure roll-up core for the Super-admin "Service Status" widget.
 * We depend on many services (Cloudflare Workers/D1/R2/KV, Stripe, SES, PostHog, Sentry, Listmonk,
 * the LLM/CRM/CMS containers, DeepSeek/Workers-AI, …). The widget must show, at a glance, whether
 * anything is down + the numbers Brian asked for — uptime % and latency — plus a sparkline of recent
 * probes so an outage is visible. Probing the vendor APIs is a SERVER concern (secrets + no CORS);
 * this module is the pure part it can be tested on: given time-series health samples per service, it
 * classifies each service (operational / degraded / down / unknown), computes uptime + p50/p95
 * latency, finds the last incident, and rolls the fleet into one summary for the widget header.
 * Pure — samples in, status out; `now` is injected so tests are deterministic (no Date.now).
 */

/** Operational state of a single service. */
export type ServiceState = 'operational' | 'degraded' | 'down' | 'unknown';

/** One health probe of a service at a point in time. */
export interface HealthSample {
  /** Epoch milliseconds the probe ran. */
  at: number;
  /** True when the probe succeeded within its threshold. */
  ok: boolean;
  /** Round-trip latency in ms (0 when the probe failed/timed out). */
  latencyMs: number;
}

/** A service's identity + its recent probe samples (unordered is fine — roll-up sorts). */
export interface ServiceSamples {
  /** Stable key, e.g. `cloudflare_d1`, `stripe`, `ses`. */
  key: string;
  /** Human label, e.g. `Cloudflare D1`. */
  label: string;
  /** The probe samples to roll up. */
  samples: HealthSample[];
}

/** Tunables for the roll-up; `now` is required so results are deterministic + testable. */
export interface RollupOptions {
  /** Epoch ms treated as "now" — the window's upper bound. */
  now: number;
  /** How far back to consider (default 24h). */
  windowMs?: number;
  /** Uptime % below this → `degraded` (default 99.5). */
  minUptimePct?: number;
  /** p95 latency (ms) above this → `degraded` (default 1500). */
  slowLatencyMs?: number;
  /** Cap on the sparkline series length (most-recent kept; default 48). */
  maxSeriesPoints?: number;
}

/** Rolled-up status for one service — everything the widget card renders. */
export interface ServiceStatus {
  key: string;
  label: string;
  state: ServiceState;
  /** Percent of ok probes in the window (0–100, 2 dp), or null when there is no data. */
  uptimePct: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  latestLatencyMs: number | null;
  latestAt: number | null;
  /** Epoch ms of the most recent failed probe in the window, or null. */
  lastIncidentAt: number | null;
  sampleCount: number;
  /** Recent samples (oldest→newest, capped) for the sparkline / "was it down" chart. */
  series: HealthSample[];
  /** Why degraded/down; '' when operational/unknown. */
  reason: string;
}

/** Fleet-wide summary for the widget header ("All systems operational" vs "1 service down"). */
export interface StatusSummary {
  total: number;
  operational: number;
  degraded: number;
  down: number;
  unknown: number;
  /** Worst state present — drives the banner colour/label. */
  worst: ServiceState;
  /** Mean of known service uptimes (2 dp), or null when nothing is known. */
  overallUptimePct: number | null;
}

/** Severity ordering — higher is worse; `unknown` outranks `operational` so a partial-data fleet
 *  never reports "all operational". */
const STATE_RANK: Record<ServiceState, number> = { operational: 0, unknown: 1, degraded: 2, down: 3 };

/**
 * Nearest-rank percentile of a latency set, rounded to whole ms. Non-finite values are dropped.
 *
 * @param values - latency samples (any order)
 * @param p - percentile in [0,100]
 * @returns the percentile in ms, or null when there are no finite values
 * @example percentileMs([110, 120, 130, 140], 95) // 140
 * @example percentileMs([], 50) // null
 */
export function percentileMs(values: readonly number[], p: number): number | null {
  const arr = (values ?? []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * arr.length);
  const idx = Math.min(arr.length - 1, Math.max(0, rank - 1));
  return Math.round(arr[idx]);
}

/**
 * Roll one service's probe samples into a {@link ServiceStatus}. State logic (in order): the most
 * recent probe failing → `down`; else uptime below target → `degraded`; else p95 latency above
 * target → `degraded`; else `operational`. No samples in the window → `unknown` (never a false
 * "operational"). Pure — never mutates the input, never throws.
 *
 * @param input - the service key/label + its samples
 * @param opts - roll-up tunables (must include `now`)
 * @returns the service's rolled-up status
 * @example rollUpService({ key:'d1', label:'D1', samples:[{at:1,ok:true,latencyMs:80}] }, { now:1 }).state // 'operational'
 */
export function rollUpService(input: ServiceSamples, opts: RollupOptions): ServiceStatus {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const minUptime = opts.minUptimePct ?? 99.5;
  const slow = opts.slowLatencyMs ?? 1500;
  const cap = opts.maxSeriesPoints ?? 48;
  const since = opts.now - windowMs;

  const inWindow = (input.samples ?? [])
    .filter((s) => s && Number.isFinite(s.at) && s.at >= since && s.at <= opts.now)
    .slice()
    .sort((a, b) => a.at - b.at);

  const base = { key: input.key, label: input.label };

  if (inWindow.length === 0) {
    return {
      ...base,
      state: 'unknown',
      uptimePct: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      latestLatencyMs: null,
      latestAt: null,
      lastIncidentAt: null,
      sampleCount: 0,
      series: [],
      reason: 'no probe data in the window',
    };
  }

  const okSamples = inWindow.filter((s) => s.ok);
  const latencies = okSamples.map((s) => s.latencyMs).filter((v) => Number.isFinite(v));
  const uptimePct = Math.round((okSamples.length / inWindow.length) * 10000) / 100;
  const p50 = percentileMs(latencies, 50);
  const p95 = percentileMs(latencies, 95);
  const latest = inWindow[inWindow.length - 1];
  const incidents = inWindow.filter((s) => !s.ok);
  const lastIncidentAt = incidents.length ? incidents[incidents.length - 1].at : null;

  let state: ServiceState;
  let reason = '';
  if (!latest.ok) {
    state = 'down';
    reason = 'the most recent probe failed';
  } else if (uptimePct < minUptime) {
    state = 'degraded';
    reason = `uptime ${uptimePct}% is below the ${minUptime}% target`;
  } else if (p95 !== null && p95 > slow) {
    state = 'degraded';
    reason = `p95 latency ${p95}ms exceeds the ${slow}ms target`;
  } else {
    state = 'operational';
  }

  return {
    ...base,
    state,
    uptimePct,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    latestLatencyMs: Number.isFinite(latest.latencyMs) ? latest.latencyMs : null,
    latestAt: latest.at,
    lastIncidentAt,
    sampleCount: inWindow.length,
    series: inWindow.slice(-cap),
    reason,
  };
}

/**
 * The worst (highest-severity) state in a list: `down` > `degraded` > `unknown` > `operational`.
 * Empty list → `operational`.
 *
 * @param states - the states to reduce
 * @returns the worst state present
 * @example worstState(['operational','degraded','operational']) // 'degraded'
 */
export function worstState(states: readonly ServiceState[]): ServiceState {
  return (states ?? []).reduce<ServiceState>((w, s) => (STATE_RANK[s] > STATE_RANK[w] ? s : w), 'operational');
}

/**
 * Summarize a fleet of statuses for the widget header: per-state counts, the worst state, and the
 * mean of the KNOWN uptimes (services with no data are excluded from the average). Pure.
 *
 * @param statuses - the rolled-up services
 * @returns the {@link StatusSummary}
 * @example summarize([{ state:'operational', uptimePct:100 } as any]).worst // 'operational'
 */
export function summarize(statuses: readonly ServiceStatus[]): StatusSummary {
  const list = statuses ?? [];
  const count = (st: ServiceState): number => list.filter((s) => s.state === st).length;
  const known = list.map((s) => s.uptimePct).filter((v): v is number => v !== null && Number.isFinite(v));
  const overallUptimePct = known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 100) / 100 : null;

  return {
    total: list.length,
    operational: count('operational'),
    degraded: count('degraded'),
    down: count('down'),
    unknown: count('unknown'),
    worst: worstState(list.map((s) => s.state)),
    overallUptimePct,
  };
}

/**
 * Roll up every service + produce the fleet summary in one call — the exact shape the status
 * endpoint returns to the Super-admin widget. Pure.
 *
 * @param inputs - one entry per monitored service
 * @param opts - roll-up tunables (must include `now`)
 * @returns `{ services, summary }`
 * @example rollUpServices([], { now: 0 }).summary.worst // 'operational'
 */
export function rollUpServices(
  inputs: readonly ServiceSamples[],
  opts: RollupOptions,
): { services: ServiceStatus[]; summary: StatusSummary } {
  const services = (inputs ?? []).map((i) => rollUpService(i, opts));
  return { services, summary: summarize(services) };
}
