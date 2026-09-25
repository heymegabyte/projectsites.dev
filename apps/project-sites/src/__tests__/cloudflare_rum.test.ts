/**
 * Coverage for the Cloudflare RUM source (`services/cloudflare_rum.ts`) + its owner route
 * (`routes/cloudflare_rum.ts`).
 *
 * Service: µs→ms conversion (a raw 1_988_000 is 1988 ms, not 1.988 M), CLS passthrough, Google
 * ratings, honest-empty on 0 samples, and fail-soft null on CF errors / missing creds — using the
 * REAL shape observed live for `franklin-barbecue.projectsites.dev` (2026-09-25 probe).
 * Route: auth 401, tenant-scoped 404 (non-leak), owned 200, host resolved SERVER-SIDE (primary
 * hostname → else slug subdomain), and fail-soft `available:false` (never a 500).
 */
import { getCloudflareRumSummary, usToMs, rateMetric } from '../services/cloudflare_rum.js';
import type { Env } from '../types/env.js';

const ENV = {
  CLOUDFLARE_API_KEY: 'k',
  CLOUDFLARE_EMAIL: 'e@x.com',
  CF_ACCOUNT_ID: 'acct',
} as unknown as Env;

function mockFetch(body: unknown, ok = true): void {
  global.fetch = jest.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

/** The live-observed groups for franklin-barbecue (µs timing, unitless CLS). */
const LIVE_BODY = {
  data: {
    viewer: {
      accounts: [
        {
          pageload: [{ count: 1837 }],
          webVitals: [
            {
              count: 1126,
              quantiles: {
                largestContentfulPaintP75: 1_988_000,
                interactionToNextPaintP75: 48_000,
                cumulativeLayoutShiftP75: 0.4,
              },
            },
          ],
          perf: [
            {
              count: 670,
              quantiles: {
                responseTimeP75: 14_000,
                firstContentfulPaintP75: 744_000,
                pageLoadTimeP75: 2_008_000,
                dnsTimeP75: 3_000,
                connectionTimeP75: 52_000,
              },
            },
          ],
        },
      ],
    },
  },
};

describe('usToMs', () => {
  it('converts microseconds to rounded milliseconds', () => {
    expect(usToMs(1_988_000)).toBe(1988);
    expect(usToMs(14_000)).toBe(14);
    expect(usToMs(1_499)).toBe(1); // rounds
  });
  it('is null-safe for absent / non-finite quantiles', () => {
    expect(usToMs(null)).toBeNull();
    expect(usToMs(undefined)).toBeNull();
    expect(usToMs(Number.NaN)).toBeNull();
  });
});

describe('rateMetric (Google bands)', () => {
  it('classifies good / needs / poor at the boundaries', () => {
    expect(rateMetric(2500, [2500, 4000])).toBe('good');
    expect(rateMetric(2501, [2500, 4000])).toBe('needs');
    expect(rateMetric(4000, [2500, 4000])).toBe('needs');
    expect(rateMetric(4001, [2500, 4000])).toBe('poor');
  });
  it('returns null for an unmeasured value or an unrated metric', () => {
    expect(rateMetric(null, [2500, 4000])).toBeNull();
    expect(rateMetric(2008, null)).toBeNull();
  });
});

describe('getCloudflareRumSummary — conversion + rating (live shape)', () => {
  it('converts µs→ms, passes CLS through unitless, and rates against Google bands', async () => {
    mockFetch(LIVE_BODY);
    const s = await getCloudflareRumSummary(ENV, 'franklin-barbecue.projectsites.dev', 'S', 'U');
    expect(s).not.toBeNull();
    expect(s!.source).toBe('cloudflare_rum');
    expect(s!.sampled).toBe(true);
    expect(s!.host).toBe('franklin-barbecue.projectsites.dev');
    expect(s!.pageviews).toBe(1837);
    // Core Web Vitals: LCP 1988ms (good), INP 48ms (good), CLS 0.4 unitless (poor).
    expect(s!.webVitals.lcp).toEqual({ p75: 1988, rating: 'good', samples: 1126 });
    expect(s!.webVitals.inp).toEqual({ p75: 48, rating: 'good', samples: 1126 });
    expect(s!.webVitals.cls).toEqual({ p75: 0.4, rating: 'poor', samples: 1126 });
    // Navigation Timing: TTFB 14ms (good, the latency the HTTP dataset can't give), pageLoad
    // 2008ms carries NO rating (timing metric, no Google band).
    expect(s!.navTiming.ttfb).toEqual({ p75: 14, rating: 'good', samples: 670 });
    expect(s!.navTiming.fcp).toEqual({ p75: 744, rating: 'good', samples: 670 });
    expect(s!.navTiming.pageLoad).toEqual({ p75: 2008, rating: null, samples: 670 });
  });

  it('reports honest-empty (null p75, 0 samples) when a dataset has no events — never a fake 0', async () => {
    mockFetch({
      data: {
        viewer: {
          accounts: [
            { pageload: [{ count: 0 }], webVitals: [{ count: 0, quantiles: {} }], perf: [{ count: 0, quantiles: {} }] },
          ],
        },
      },
    });
    const s = await getCloudflareRumSummary(ENV, 'quiet.projectsites.dev', 'S', 'U');
    expect(s!.pageviews).toBeNull();
    expect(s!.webVitals.lcp).toEqual({ p75: null, rating: null, samples: 0 });
    expect(s!.navTiming.ttfb).toEqual({ p75: null, rating: null, samples: 0 });
  });

  it('fails soft to null on a CF GraphQL error', async () => {
    mockFetch({ data: null, errors: [{ message: 'boom' }] });
    expect(await getCloudflareRumSummary(ENV, 'h', 'S', 'U')).toBeNull();
  });

  it('fails soft to null on a non-2xx CF response', async () => {
    mockFetch({}, false);
    expect(await getCloudflareRumSummary(ENV, 'h', 'S', 'U')).toBeNull();
  });

  it('returns null (never a fake 0) when no CF credentials are present', async () => {
    const called = jest.fn();
    global.fetch = called as unknown as typeof fetch;
    const s = await getCloudflareRumSummary({} as Env, 'h', 'S', 'U');
    expect(s).toBeNull();
    expect(called).not.toHaveBeenCalled(); // never even hits the network without creds
  });
});
