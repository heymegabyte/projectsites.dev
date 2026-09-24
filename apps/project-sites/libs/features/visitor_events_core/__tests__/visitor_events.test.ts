/**
 * Unit tests for Visitor Events Core.
 * Covers: recordVisitorEvent insert, traffic rollup (pageviews / unique
 * sessions / conversions / topPaths / byType), and degrade-to-0 on table error.
 */

import {
  recordVisitorEvent,
  getTrafficSummary,
  recordPageviewFromRequest,
  isPageRequest,
  percentile,
  FLAG_KEY,
} from '../service.js';
import type { Env } from '../../../../src/types/env.js';

interface Ev {
  id: string;
  org_id: string;
  site_id: string;
  session_id: string;
  event_type: string;
  path: string | null;
  referrer: string | null;
  metadata: string;
}

function makeEnv(opts: { throwAll?: boolean } = {}): { env: Env; events: Ev[] } {
  const events: Ev[] = [];
  function prepare(sql: string) {
    let bound: unknown[] = [];
    const api = {
      bind: (...p: unknown[]) => {
        bound = p;
        return api;
      },
      run: async () => {
        if (sql.includes('INSERT INTO visitor_events')) {
          const [id, org_id, site_id, session_id, event_type, path, referrer, metadata] =
            bound as string[];
          events.push({
            id,
            org_id,
            site_id,
            session_id,
            event_type,
            path: path ?? null,
            referrer: referrer ?? null,
            metadata,
          });
        }
        return { meta: { changes: 1 } };
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        if (opts.throwAll) throw new Error('no such table: visitor_events');
        const site = bound[0] as string;
        const rows = events.filter((e) => e.site_id === site);
        if (sql.includes("event_type = 'web_vital'")) {
          // AN-CWV: the getWebVitalsSummary SELECT of {metric, value, path} rows.
          return {
            results: rows
              .filter((e) => e.event_type === 'web_vital')
              .map((e) => {
                const m = JSON.parse(e.metadata || '{}') as { metric?: string; value?: number };
                return { metric: m.metric ?? null, value: Number(m.value), path: e.path };
              }) as unknown as T[],
          };
        }
        if (sql.includes('GROUP BY path')) {
          const m = new Map<string, number>();
          rows
            .filter((e) => e.event_type === 'pageview' && e.path)
            .forEach((e) => m.set(e.path!, (m.get(e.path!) ?? 0) + 1));
          return { results: [...m].map(([path, n]) => ({ path, n })) as unknown as T[] };
        }
        if (sql.includes('GROUP BY event_type')) {
          const m = new Map<string, number>();
          rows.forEach((e) => m.set(e.event_type, (m.get(e.event_type) ?? 0) + 1));
          return {
            results: [...m].map(([event_type, n]) => ({ event_type, n })) as unknown as T[],
          };
        }
        if (sql.includes('COUNT(DISTINCT session_id)')) {
          return {
            results: [{ n: new Set(rows.map((e) => e.session_id)).size }] as unknown as T[],
          };
        }
        if (sql.includes("event_type = 'conversion'")) {
          return {
            results: [
              { n: rows.filter((e) => e.event_type === 'conversion').length },
            ] as unknown as T[],
          };
        }
        if (sql.includes("event_type = 'pageview'")) {
          return {
            results: [
              { n: rows.filter((e) => e.event_type === 'pageview').length },
            ] as unknown as T[],
          };
        }
        return { results: [{ n: 0 }] as unknown as T[] };
      },
    };
    return api;
  }
  return { env: { DB: { prepare } as unknown as D1Database } as unknown as Env, events };
}

describe('visitor_events_core service', () => {
  it('exposes the flag key', () => {
    expect(FLAG_KEY).toBe('site_analytics');
  });

  it('records a web_vital CWV sample with {metric,value} metadata (AN-CWV)', async () => {
    const { env } = makeEnv();
    const ctx = { orgId: 'org1', siteId: 'site1' };
    const { id } = await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-cwv-0001',
      eventType: 'web_vital',
      path: '/pricing',
      metadata: { metric: 'LCP', value: 2500 },
    });
    expect(id).toBeTruthy();
    const s = await getTrafficSummary(env, 'site1', 30);
    expect(s.byType).toEqual(expect.arrayContaining([{ type: 'web_vital', count: 1 }]));
  });

  it('summarizes Core Web Vitals p75 per metric, null when a metric has no samples (AN-CWV)', async () => {
    const { env } = makeEnv();
    const ctx = { orgId: 'org1', siteId: 'site1' };
    // 4 LCP samples → nearest-rank p75 of [1000,2000,3000,4000] = 3000.
    for (const value of [2000, 4000, 1000, 3000]) {
      await recordVisitorEvent(env, ctx, {
        sessionId: 'sess-cwv-lcp-1',
        eventType: 'web_vital',
        path: '/',
        metadata: { metric: 'LCP', value },
      });
    }
    await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-cwv-cls-1',
      eventType: 'web_vital',
      path: '/',
      metadata: { metric: 'CLS', value: 0.08 },
    });
    const s = await getTrafficSummary(env, 'site1', 30);
    expect(s.webVitals.lcp).toEqual({ p75: 3000, samples: 4 });
    expect(s.webVitals.cls).toEqual({ p75: 0.08, samples: 1 });
    // No INP samples → null, never a fabricated 0 (honesty contract).
    expect(s.webVitals.inp).toBeNull();
  });

  it('ranks slowest pages by LCP p75, requiring a per-page sample floor (AN-CWV per-path)', async () => {
    const { env } = makeEnv();
    const ctx = { orgId: 'org1', siteId: 'site1' };
    const push = async (path: string, values: number[]) => {
      for (const value of values) {
        await recordVisitorEvent(env, ctx, {
          sessionId: 'sess-cwv-path-1',
          eventType: 'web_vital',
          path,
          metadata: { metric: 'LCP', value },
        });
      }
    };
    await push('/slow', [4000, 4200, 4400, 4600, 4800, 5000]); // p75 = 4800
    await push('/fast', [1000, 1100, 1200, 1300, 1400, 1500]); // p75 = 1400
    await push('/thin', [9000, 9500]); // 2 samples < floor(5) → EXCLUDED (unreliable p75)
    const pages = (await getTrafficSummary(env, 'site1', 30)).webVitals.slowestPages;
    expect(pages.map((p) => p.path)).toEqual(['/slow', '/fast']); // worst first, /thin dropped
    expect(pages[0]).toEqual({ path: '/slow', lcpP75: 4800, samples: 6 });
    expect(pages[0].lcpP75).toBeGreaterThan(pages[1].lcpP75);
  });

  describe('percentile (nearest-rank)', () => {
    it('picks the nearest-rank value for p75', () => {
      expect(percentile([10, 20, 30, 40], 75)).toBe(30); // ceil(0.75·4)=3 → 3rd
      expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 75)).toBe(8); // ceil(7.5)=8 → 8th
    });
    it('sorts unsorted input without mutating it', () => {
      const input = [40, 10, 30, 20];
      expect(percentile(input, 75)).toBe(30);
      expect(input).toEqual([40, 10, 30, 20]);
    });
    it('returns the lone value for a single sample and 0 for an empty one', () => {
      expect(percentile([2500], 75)).toBe(2500);
      expect(percentile([], 75)).toBe(0); // callers gate on sample count, not this
    });
  });

  it('records an event and rolls up traffic', async () => {
    const { env } = makeEnv();
    const ctx = { orgId: 'org1', siteId: 'site1' };
    await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-aaaa1111',
      eventType: 'pageview',
      path: '/',
    });
    await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-aaaa1111',
      eventType: 'pageview',
      path: '/pricing',
    });
    await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-bbbb2222',
      eventType: 'pageview',
      path: '/',
    });
    await recordVisitorEvent(env, ctx, {
      sessionId: 'sess-bbbb2222',
      eventType: 'conversion',
      path: '/thanks',
    });

    const s = await getTrafficSummary(env, 'site1', 30);
    expect(s.pageviews).toBe(3);
    expect(s.uniqueSessions).toBe(2);
    expect(s.conversions).toBe(1);
    expect(s.topPaths).toEqual(
      expect.arrayContaining([
        { path: '/', count: 2, uniques: 2 }, // AN9 — unique visitors per page
        { path: '/pricing', count: 1, uniques: 1 },
      ]),
    );
    expect(s.byType).toEqual(
      expect.arrayContaining([
        { type: 'pageview', count: 3 },
        { type: 'conversion', count: 1 },
      ]),
    );
  });

  it('rejects an event with too-short sessionId', async () => {
    const { env } = makeEnv();
    await expect(
      recordVisitorEvent(env, { orgId: 'o', siteId: 's' }, {
        sessionId: 'x',
        eventType: 'pageview',
      } as never),
    ).rejects.toThrow();
  });

  it('degrades to an all-zero summary when the table errors', async () => {
    const { env } = makeEnv({ throwAll: true });
    const s = await getTrafficSummary(env, 'site1', 30);
    expect(s).toMatchObject({
      pageviews: 0,
      uniqueSessions: 0,
      conversions: 0,
      topPaths: [],
      byType: [],
    });
  });
});

describe('edge pageview recording', () => {
  const HUMAN_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  function req(ua: string): Request {
    return new Request('https://megabytelabs.projectsites.dev/', {
      headers: { 'user-agent': ua, 'cf-connecting-ip': '203.0.113.7', referer: 'https://google.com/' },
    });
  }

  it('classifies pages vs assets correctly', () => {
    expect(isPageRequest('/')).toBe(true);
    expect(isPageRequest('/about')).toBe(true);
    expect(isPageRequest('/services/')).toBe(true);
    expect(isPageRequest('/pricing.html')).toBe(true);
    expect(isPageRequest('/styles.css')).toBe(false);
    expect(isPageRequest('/app.js')).toBe(false);
    expect(isPageRequest('/hero.png?v=2')).toBe(false);
    expect(isPageRequest('/fonts/inter.woff2')).toBe(false);
  });

  it('records a pageview for a human page navigation', async () => {
    const { env, events } = makeEnv();
    await recordPageviewFromRequest(env, { orgId: 'org1', siteId: 'site1' }, req(HUMAN_UA), '/pricing?ref=x');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ site_id: 'site1', event_type: 'pageview', path: '/pricing' });
    expect(events[0].session_id.length).toBeGreaterThanOrEqual(8);
  });

  it('persists CF geo (country + city + region) into metadata — AN2', async () => {
    const { env, events } = makeEnv();
    const r = Object.assign(req(HUMAN_UA), {
      cf: { country: 'US', city: 'Newark', region: 'New Jersey' },
    }) as unknown as Request;
    await recordPageviewFromRequest(env, { orgId: 'org1', siteId: 'site1' }, r, '/about');
    expect(events).toHaveLength(1);
    const meta = JSON.parse(events[0].metadata) as {
      country: string;
      city: string;
      region: string;
    };
    expect(meta.country).toBe('US');
    expect(meta.city).toBe('Newark');
    expect(meta.region).toBe('New Jersey');
  });

  it('geo is null when the CF edge omits it (graceful)', async () => {
    const { env, events } = makeEnv();
    await recordPageviewFromRequest(env, { orgId: 'org1', siteId: 'site1' }, req(HUMAN_UA), '/');
    const meta = JSON.parse(events[0].metadata) as { city: string | null; region: string | null };
    expect(meta.city).toBeNull();
    expect(meta.region).toBeNull();
  });

  it('skips static assets', async () => {
    const { env, events } = makeEnv();
    await recordPageviewFromRequest(env, { orgId: 'org1', siteId: 'site1' }, req(HUMAN_UA), '/main.css');
    expect(events).toHaveLength(0);
  });

  it('skips known bots', async () => {
    const { env, events } = makeEnv();
    await recordPageviewFromRequest(env, { orgId: 'org1', siteId: 'site1' }, req('GPTBot/1.0'), '/');
    expect(events).toHaveLength(0);
  });

  it('never throws even if the DB write fails', async () => {
    const env = { DB: { prepare: () => { throw new Error('boom'); } } as unknown as D1Database } as unknown as Env;
    await expect(
      recordPageviewFromRequest(env, { orgId: 'o', siteId: 's' }, req(HUMAN_UA), '/'),
    ).resolves.toBeUndefined();
  });
});
