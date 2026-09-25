/**
 * @file Cloudflare Web Analytics RUM — the CF-native, per-host performance + Core Web Vitals
 * source. Unlike `httpRequestsAdaptiveGroups` (structurally EMPTY for `*.projectsites.dev`
 * subdomains — see the `metric-sourced-from-dead-table` incident), the RUM datasets DO attribute
 * per subdomain, so this is the ONE Cloudflare dataset that gives real edge-measured Core Web
 * Vitals + Navigation Timing (including TTFB, which the HTTP dataset cannot) for a customer's
 * generated site. It is an INDEPENDENT second source to our first-party `app.js` beacon — a
 * cross-check, never a replacement.
 *
 * Honesty contract (per the analytics epic):
 *  - RUM is adaptive-SAMPLED — `sampled: true`, `source: 'cloudflare_rum'` are always set.
 *  - Timing quantiles arrive in MICROSECONDS; we convert to ms once, here (a raw 1_988_000 is
 *    1988 ms, not 1.988 M ms). CLS is unitless and passes through untouched.
 *  - A metric with zero samples (or a null quantile) is reported as `null` with `samples: 0` —
 *    NEVER a fabricated 0.
 *
 * Tenant safety: the caller resolves the site → its OWNED host server-side (never a client
 * hostname); this module only queries the host it is handed.
 */
import type { Env } from '../types/env.js';

/** Google Core Web Vitals / timing thresholds (ms, except CLS which is unitless). */
const THRESHOLDS = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  ttfb: [800, 1800],
  fcp: [1800, 3000],
} as const;

/** A metric rating against Google's good / needs-improvement / poor bands. */
export type RumRating = 'good' | 'needs' | 'poor';

/** One RUM metric: the p75 value (ms for timing, unitless for CLS), its rating, and sample count. */
export interface RumMetric {
  /** p75 value — ms for timing metrics, unitless for CLS; `null` when there are no samples. */
  p75: number | null;
  /** Google-band rating, or `null` when unmeasured or the metric has no defined bands. */
  rating: RumRating | null;
  /** Number of sampled RUM events behind this metric (0 → honest-empty, never a fake 0 value). */
  samples: number;
}

/** The typed CF RUM summary for one owned host over one time window. */
export interface CloudflareRumSummary {
  source: 'cloudflare_rum';
  /** RUM is adaptive-sampled — always true; the UI must label estimates as such. */
  sampled: true;
  /** The single owned host these metrics reflect (resolved server-side by the caller). */
  host: string;
  /** Sampled pageload event count over the window (`null` when the dataset returned nothing). */
  pageviews: number | null;
  /** Cloudflare-measured Core Web Vitals (independent of our first-party beacon). */
  webVitals: { lcp: RumMetric; inp: RumMetric; cls: RumMetric };
  /** Navigation Timing — incl. TTFB (`responseTime`), the latency the HTTP dataset can't give. */
  navTiming: {
    ttfb: RumMetric;
    fcp: RumMetric;
    pageLoad: RumMetric;
    dns: RumMetric;
    connect: RumMetric;
  };
  /** The queried window (ISO 8601). */
  window: { since: string; until: string };
}

/** Microseconds → milliseconds, rounded; null-safe (a null/absent quantile stays null). */
export function usToMs(us: number | null | undefined): number | null {
  if (typeof us !== 'number' || !Number.isFinite(us)) {
    return null;
  }
  return Math.round(us / 1000);
}

/** Rate a value against a `[good, needs]` threshold pair; `null` in → `null` out. */
export function rateMetric(
  value: number | null,
  bounds: readonly [number, number] | null,
): RumRating | null {
  if (value === null || bounds === null) {
    return null;
  }
  const [good, needs] = bounds;
  if (value <= good) {
    return 'good';
  }
  if (value <= needs) {
    return 'needs';
  }
  return 'poor';
}

/**
 * A metric kind — `cls` is unitless, `timing` is a µs→ms metric with NO rating bands (pageLoad /
 * dns / connect), and the rest are µs→ms metrics rated against {@link THRESHOLDS}.
 */
type MetricKind = 'lcp' | 'inp' | 'ttfb' | 'fcp' | 'cls' | 'timing';

/** Build a {@link RumMetric} from a raw quantile: convert (if timing), rate, and carry the sample count. */
function metric(
  rawQuantile: number | null | undefined,
  samples: number,
  kind: MetricKind,
): RumMetric {
  // CLS is unitless (no µs conversion); every other metric is µs → ms.
  const value =
    kind === 'cls' ? (typeof rawQuantile === 'number' ? rawQuantile : null) : usToMs(rawQuantile);
  // `timing` metrics (pageLoad/dns/connect) have no Google bands → rating stays null.
  const bounds = kind === 'timing' ? null : THRESHOLDS[kind];
  // Zero samples → honest-empty: the value is meaningless without data (never a fabricated 0).
  if (!(samples > 0) || value === null) {
    return { p75: null, rating: null, samples: samples > 0 ? samples : 0 };
  }
  return { p75: value, rating: rateMetric(value, bounds), samples };
}

/** Shape of the three RUM groups we read (only the fields we select). */
interface RumGroup {
  count?: number;
  quantiles?: Record<string, number | null>;
}
interface RumResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        pageload?: RumGroup[];
        webVitals?: RumGroup[];
        perf?: RumGroup[];
      }>;
    };
  };
  errors?: Array<{ message: string }> | null;
}

/**
 * Fetch the Cloudflare RUM summary for ONE owned host over a window. Issues a SINGLE GraphQL
 * request (all three RUM datasets aliased together — "one CF request per host, not per widget").
 * Auth uses the global key (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`) which carries account-level
 * Analytics:Read, falling back to a `CF_API_TOKEN` bearer.
 *
 * @param env - Worker env (CF creds + optional `CF_ACCOUNT_ID`)
 * @param host - the site's OWNED host, resolved server-side by the caller (never a client value)
 * @param sinceISO - window start (ISO 8601 `Time`)
 * @param untilISO - window end (ISO 8601 `Time`)
 * @returns the typed summary, or `null` when CF errors / creds are absent (caller fails soft)
 * @throws never — returns `null` on any failure so a live request degrades gracefully
 * @example const rum = await getCloudflareRumSummary(env, 'franklin-barbecue.projectsites.dev', s, u)
 */
export async function getCloudflareRumSummary(
  env: Env,
  host: string,
  sinceISO: string,
  untilISO: string,
): Promise<CloudflareRumSummary | null> {
  const account = env.CF_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL) {
    headers['X-Auth-Key'] = env.CLOUDFLARE_API_KEY;
    headers['X-Auth-Email'] = env.CLOUDFLARE_EMAIL;
  } else if (env.CF_API_TOKEN) {
    headers['Authorization'] = `Bearer ${env.CF_API_TOKEN}`;
  } else {
    return null; // no creds → caller reports honestly-unavailable, never a fake 0
  }

  const query = `query($a:String!,$s:Time!,$u:Time!,$h:String!){
    viewer{accounts(filter:{accountTag:$a}){
      pageload: rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$u,requestHost:$h}){ count }
      webVitals: rumWebVitalsEventsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$u,requestHost:$h}){ count quantiles{ largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 } }
      perf: rumPerformanceEventsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$u,requestHost:$h}){ count quantiles{ responseTimeP75 firstContentfulPaintP75 pageLoadTimeP75 dnsTimeP75 connectionTimeP75 } }
    }}
  }`;

  let json: RumResponse;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { a: account, s: sinceISO, u: untilISO, h: host } }),
    });
    if (!res.ok) {
      return null;
    }
    json = (await res.json()) as RumResponse;
  } catch {
    return null; // network/parse failure → fail soft
  }
  if (json.errors && json.errors.length > 0) {
    return null;
  }

  const acct = json.data?.viewer?.accounts?.[0];
  const pageload = acct?.pageload?.[0];
  const wv = acct?.webVitals?.[0];
  const perf = acct?.perf?.[0];
  const wq = wv?.quantiles ?? {};
  const pq = perf?.quantiles ?? {};
  const wvSamples = wv?.count ?? 0;
  const perfSamples = perf?.count ?? 0;
  const pageloadCount = pageload?.count;

  return {
    source: 'cloudflare_rum',
    sampled: true,
    host,
    pageviews: typeof pageloadCount === 'number' && pageloadCount > 0 ? pageloadCount : null,
    webVitals: {
      lcp: metric(wq.largestContentfulPaintP75, wvSamples, 'lcp'),
      inp: metric(wq.interactionToNextPaintP75, wvSamples, 'inp'),
      cls: metric(wq.cumulativeLayoutShiftP75, wvSamples, 'cls'),
    },
    navTiming: {
      ttfb: metric(pq.responseTimeP75, perfSamples, 'ttfb'),
      fcp: metric(pq.firstContentfulPaintP75, perfSamples, 'fcp'),
      pageLoad: metric(pq.pageLoadTimeP75, perfSamples, 'timing'),
      dns: metric(pq.dnsTimeP75, perfSamples, 'timing'),
      connect: metric(pq.connectionTimeP75, perfSamples, 'timing'),
    },
    window: { since: sinceISO, until: untilISO },
  };
}

/**
 * Cached wrapper over {@link getCloudflareRumSummary} — ONE CF GraphQL request per host per ~5-min
 * window, instead of one per dashboard load / per public-share view (the epic's "batch/cache; one CF
 * request per host, not per widget"). The cache key is the SERVER-RESOLVED owned host + day-window,
 * so it never varies by the raw since/until timestamps (which would defeat the cache) and never keys
 * on a client value. Caches SUCCESS only (a transient CF failure isn't cached → it retries next call).
 *
 * Env-mock-safe: when `CACHE_KV` is unbound (unit tests / a minimal env) it falls through to a direct
 * fetch — the cache is an optimization, never a hard dependency. KV read/write failures never break
 * the request.
 *
 * @param env - Worker env (CF creds + optional `CACHE_KV`)
 * @param host - the OWNED host, resolved server-side by the caller (never a client value)
 * @param days - the day window (clamped 1..30); the cache key + the since/until derive from it
 * @returns the (possibly cached) summary, or null when CF errors / creds are absent
 * @example const rum = await getCachedCloudflareRum(env, 'acme.projectsites.dev', 30)
 */
export async function getCachedCloudflareRum(
  env: Env,
  host: string,
  days: number,
): Promise<CloudflareRumSummary | null> {
  const clamped = Math.min(30, Math.max(1, Math.floor(days)));
  const key = `cf_rum:v1:${host}:${clamped}`;
  const kv = env.CACHE_KV;

  if (kv) {
    try {
      const cached = (await kv.get(key, 'json')) as CloudflareRumSummary | null;
      if (cached) {
        return cached;
      }
    } catch {
      /* a cache read never breaks the live path */
    }
  }

  const until = new Date();
  const since = new Date(until.getTime() - clamped * 24 * 60 * 60 * 1000);
  const summary = await getCloudflareRumSummary(
    env,
    host,
    since.toISOString(),
    until.toISOString(),
  );

  // Cache success only (5 min) — a null (CF error / no creds) is left to retry on the next call.
  if (summary && kv) {
    try {
      await kv.put(key, JSON.stringify(summary), { expirationTtl: 300 });
    } catch {
      /* best-effort — a cache write never breaks the request */
    }
  }

  return summary;
}
