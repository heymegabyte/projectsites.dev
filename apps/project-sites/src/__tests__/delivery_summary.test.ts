/**
 * Unit tests for buildDeliverySummary — pure delivery & performance data aggregator.
 *
 * Covers:
 *  - Happy path with real-world CF data (74% 200s, 9% 504s, 4% cache-hit, 1.16GB/30d)
 *  - Cache hit ratio computation (hit / (hit + miss) only, uncacheable excluded)
 *  - Empty maps → has_data=false, hit_ratio_pct=null (NOT 0)
 *  - Status class bucketing (2xx/3xx/4xx/5xx/other)
 *  - top_statuses sort order and top-8 cap
 */
import { buildDeliverySummary, resolveDeliveryZone } from '../services/multi_url_analytics';

describe('buildDeliverySummary', () => {
  it('correctly buckets status codes and totals from real-world CF data', () => {
    const byStatus = new Map([
      [200, 74],
      [204, 13],
      [302, 2],
      [404, 1],
      [504, 9],
    ]);
    const byCache = new Map<string, number>();
    const result = buildDeliverySummary(byStatus, byCache, 0, 30);

    expect(result.total_requests).toBe(99);
    expect(result.has_data).toBe(true);

    const statusMap = new Map(result.by_status_class.map((s) => [s.class, s.count]));
    expect(statusMap.get('2xx')).toBe(87); // 74+13
    expect(statusMap.get('3xx')).toBe(2);
    expect(statusMap.get('4xx')).toBe(1);
    expect(statusMap.get('5xx')).toBe(9);
    expect(statusMap.has('other')).toBe(false); // no 'other' bucket when zero

    // sorted count-desc
    expect(result.by_status_class[0].class).toBe('2xx');
    expect(result.by_status_class[0].count).toBe(87);

    // top_statuses[0] is the highest-count individual status
    expect(result.top_statuses[0]).toEqual({ status: 200, count: 74 });
  });

  it('computes cache hit ratio correctly (hit / (hit + miss), not including uncacheable)', () => {
    const byStatus = new Map<number, number>();
    const byCache = new Map([
      ['hit', 1475],
      ['miss', 3139],
      ['none', 26879], // uncacheable — excluded from ratio
    ]);
    const result = buildDeliverySummary(byStatus, byCache, 0, 30);

    expect(result.cache.hit).toBe(1475);
    expect(result.cache.miss).toBe(3139);
    expect(result.cache.uncacheable).toBe(26879);
    // Math.round(100 * 1475 / (1475 + 3139)) = Math.round(100 * 1475/4614) = Math.round(31.97...) = 32
    expect(result.cache.hit_ratio_pct).toBe(32);
  });

  it('returns hit_ratio_pct=null (NOT 0) when both hit and miss are zero', () => {
    const result = buildDeliverySummary(new Map(), new Map(), 0, 30);

    expect(result.has_data).toBe(false);
    expect(result.total_requests).toBe(0);
    // CRITICAL: must be null, never 0 — a fake 0 would look like "0% cache-hit rate"
    expect(result.cache.hit_ratio_pct).toBeNull();
    expect(result.cache.hit_ratio_pct).not.toBe(0);
  });

  it('drops zero-count status class buckets from by_status_class', () => {
    const byStatus = new Map([[200, 5]]);
    const result = buildDeliverySummary(byStatus, new Map(), 0, 7);

    expect(result.by_status_class.length).toBe(1);
    expect(result.by_status_class[0].class).toBe('2xx');
    expect(result.by_status_class.find((s) => s.class === '5xx')).toBeUndefined();
  });

  it('caps top_statuses at 8 entries', () => {
    // 10 distinct status codes → only top 8 returned
    const byStatus = new Map<number, number>();
    for (let i = 0; i < 10; i++) {
      byStatus.set(200 + i, 10 - i);
    }
    const result = buildDeliverySummary(byStatus, new Map(), 0, 7);

    expect(result.top_statuses.length).toBe(8);
    // first entry should be highest count (status 200 → count 10)
    expect(result.top_statuses[0].status).toBe(200);
    expect(result.top_statuses[0].count).toBe(10);
  });

  it('includes revalidated/updating/stale in cache hit bucket', () => {
    const byCache = new Map([
      ['hit', 100],
      ['revalidated', 50],
      ['updating', 25],
      ['stale', 10],
      ['miss', 200],
      ['expired', 20],
      ['bypass', 15], // uncacheable
    ]);
    const result = buildDeliverySummary(new Map(), byCache, 0, 30);

    expect(result.cache.hit).toBe(185); // 100+50+25+10
    expect(result.cache.miss).toBe(220); // 200+20
    expect(result.cache.uncacheable).toBe(15); // bypass
    expect(result.cache.hit_ratio_pct).toBe(46); // Math.round(100 * 185/405) = 46
  });

  it('propagates response_bytes and range_days', () => {
    const result = buildDeliverySummary(
      new Map([[200, 100]]),
      new Map(),
      1_245_000_000, // ~1.16 GB
      30,
    );
    expect(result.response_bytes).toBe(1_245_000_000);
    expect(result.range_days).toBe(30);
  });

  it('threads zone_resolved so the UI can tell "not available" from "no traffic yet"', () => {
    // Defaults false (back-compat) — an unresolved zone must NOT read as "no traffic".
    expect(buildDeliverySummary(new Map(), new Map(), 0, 7).zone_resolved).toBe(false);
    // When the zone resolved but there's genuinely no edge traffic yet.
    const resolvedEmpty = buildDeliverySummary(new Map(), new Map(), 0, 7, true);
    expect(resolvedEmpty.zone_resolved).toBe(true);
    expect(resolvedEmpty.has_data).toBe(false);
  });
});

describe('resolveDeliveryZone (delivery/audience decouple)', () => {
  const auth = {} as never;

  it('resolves *.projectsites.dev subdomains to the shared zone — so edge delivery works for subdomains WITHOUT the audience path resolving a zone (audience stays first-party D1)', async () => {
    const z = await resolveDeliveryZone({} as never, auth, 'harborline-coffee-roasters-boston.projectsites.dev');
    expect(z?.zone_id).toBe('9ceaa211750dd31899fd5d1bf8d1ec46');
  });

  it('honors an env.CF_ZONE_ID override for the shared projectsites.dev zone', async () => {
    const z = await resolveDeliveryZone({ CF_ZONE_ID: 'zone-override' } as never, auth, 'x.projectsites.dev');
    expect(z?.zone_id).toBe('zone-override');
  });
});
