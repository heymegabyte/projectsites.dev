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
import {
  buildDeliverySummary,
  clampCustomDays,
  resolveDeliveryZone,
} from '../services/multi_url_analytics';

describe('buildDeliverySummary — CF adaptive sampleInterval (honesty)', () => {
  const st = new Map([[200, 100]]);
  it('surfaces a valid sampleInterval (the confidence of the sampled estimate)', () => {
    const r = buildDeliverySummary(st, new Map(), 0, 30, true, new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), 3.3);
    expect(r.sample_interval).toBeCloseTo(3.3);
  });
  it('defaults to null when omitted, and null-guards 0 / negative / non-finite', () => {
    expect(buildDeliverySummary(st, new Map(), 0, 30).sample_interval).toBeNull();
    expect(
      buildDeliverySummary(st, new Map(), 0, 30, true, new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), 0).sample_interval,
    ).toBeNull();
    expect(
      buildDeliverySummary(st, new Map(), 0, 30, true, new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), -1).sample_interval,
    ).toBeNull();
  });
});

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

    // top_statuses[0] is the highest-count individual status (bytes/visits default 0 — none passed)
    expect(result.top_statuses[0]).toEqual({ status: 200, count: 74, bytes: 0, visits: 0 });
  });

  it('carries per-status bytes + visits into top_statuses when provided', () => {
    const byStatus = new Map([
      [200, 100],
      [404, 20],
    ]);
    const byStatusBytes = new Map([
      [200, 5_000_000],
      [404, 8_000],
    ]);
    const byStatusVisits = new Map([
      [200, 60],
      [404, 15],
    ]);
    const result = buildDeliverySummary(
      byStatus,
      new Map(),
      0,
      30,
      false,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      byStatusBytes,
      byStatusVisits,
    );
    const s200 = result.top_statuses.find((s) => s.status === 200);
    const s404 = result.top_statuses.find((s) => s.status === 404);
    expect(s200).toEqual({ status: 200, count: 100, bytes: 5_000_000, visits: 60 });
    // The owner-facing signal: 15 REAL visitors hit a 404 (not just 20 raw requests).
    expect(s404?.visits).toBe(15);
    expect(s404?.bytes).toBe(8_000);
  });

  it('defaults per-status bytes + visits to 0 when the maps omit a status (a real measured 0, never fabricated)', () => {
    const byStatus = new Map([[200, 5]]);
    const result = buildDeliverySummary(byStatus, new Map(), 0, 7);
    expect(result.top_statuses[0]).toEqual({ status: 200, count: 5, bytes: 0, visits: 0 });
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

  it('splits edge bytes by cache-state (hit / miss / uncacheable) from byCacheBytes', () => {
    const byCache = new Map([
      ['hit', 100],
      ['miss', 40],
      ['none', 10],
    ]);
    const byCacheBytes = new Map([
      ['hit', 5_000_000],
      ['miss', 8_000_000],
      ['none', 1_000_000],
    ]);
    const result = buildDeliverySummary(
      new Map(),
      byCache,
      14_000_000,
      30,
      false,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      byCacheBytes,
    );
    expect(result.cache.hit_bytes).toBe(5_000_000);
    expect(result.cache.miss_bytes).toBe(8_000_000); // the "you could cache this to save bandwidth" signal
    expect(result.cache.uncacheable_bytes).toBe(1_000_000); // 'none' → uncacheable bucket
  });

  it('splits edge VISITS by cache-state (hit / miss / uncacheable) from byCacheVisits', () => {
    const byCache = new Map([
      ['hit', 100],
      ['miss', 40],
      ['none', 10],
    ]);
    // visits ≠ the request counts above — proving the builder reads byCacheVisits, not by_cache.
    const byCacheVisits = new Map([
      ['hit', 60],
      ['miss', 22],
      ['none', 4],
    ]);
    const result = buildDeliverySummary(
      new Map(),
      byCache,
      0,
      30,
      false,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      byCacheVisits,
    );
    expect(result.cache.hit_visits).toBe(60);
    expect(result.cache.miss_visits).toBe(22); // "cache misses touched N REAL visitors" (not raw requests)
    expect(result.cache.uncacheable_visits).toBe(4); // 'none' → uncacheable bucket
  });

  it('defaults cache bytes + visits to 0 when the maps are omitted (a real 0, never fabricated)', () => {
    const result = buildDeliverySummary(new Map(), new Map([['hit', 5]]), 0, 7);
    expect(result.cache.hit_bytes).toBe(0);
    expect(result.cache.miss_bytes).toBe(0);
    expect(result.cache.uncacheable_bytes).toBe(0);
    expect(result.cache.hit_visits).toBe(0);
    expect(result.cache.miss_visits).toBe(0);
    expect(result.cache.uncacheable_visits).toBe(0);
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

  it('folds the edge connection/content breakdowns (protocol/tls/content/method) top-N by count', () => {
    const result = buildDeliverySummary(
      new Map([[200, 100]]),
      new Map(),
      0,
      7,
      true,
      new Map([
        ['HTTP/3', 70],
        ['HTTP/2', 30],
      ]),
      new Map([
        ['TLSv1.3', 99],
        ['TLSv1.2', 1],
      ]),
      new Map([
        ['js', 60],
        ['html', 40],
      ]),
      new Map([['GET', 100]]),
      new Map([
        ['Search Engine Crawler', 42],
        ['Monitoring & Site Analytics', 8],
      ]),
    );
    expect(result.protocols).toEqual([
      { label: 'HTTP/3', count: 70 },
      { label: 'HTTP/2', count: 30 },
    ]);
    expect(result.tls[0]).toEqual({ label: 'TLSv1.3', count: 99 });
    expect(result.content_types.map((r) => r.label)).toEqual(['js', 'html']);
    expect(result.methods).toEqual([{ label: 'GET', count: 100 }]);
    expect(result.verified_bots).toEqual([
      { label: 'Search Engine Crawler', count: 42 },
      { label: 'Monitoring & Site Analytics', count: 8 },
    ]);
  });

  it('defaults the edge breakdowns to [] when the maps are not provided (back-compat)', () => {
    const r = buildDeliverySummary(new Map([[200, 5]]), new Map(), 0, 7);
    expect(r.protocols).toEqual([]);
    expect(r.tls).toEqual([]);
    expect(r.content_types).toEqual([]);
    expect(r.methods).toEqual([]);
    expect(r.verified_bots).toEqual([]);
  });
});

describe('resolveDeliveryZone (delivery/audience decouple)', () => {
  const auth = {} as never;

  it('resolves *.projectsites.dev subdomains to the shared zone — so edge delivery works for subdomains WITHOUT the audience path resolving a zone (audience stays first-party D1)', async () => {
    const z = await resolveDeliveryZone(
      {} as never,
      auth,
      'harborline-coffee-roasters-boston.projectsites.dev',
    );
    expect(z?.zone_id).toBe('9ceaa211750dd31899fd5d1bf8d1ec46');
  });

  it('honors an env.CF_ZONE_ID override for the shared projectsites.dev zone', async () => {
    const z = await resolveDeliveryZone(
      { CF_ZONE_ID: 'zone-override' } as never,
      auth,
      'x.projectsites.dev',
    );
    expect(z?.zone_id).toBe('zone-override');
  });
});

describe('clampCustomDays (custom lookback param)', () => {
  it('accepts 1–90, clamps above 90, and rejects invalid/absent to undefined', () => {
    expect(clampCustomDays('14')).toBe(14);
    expect(clampCustomDays('1')).toBe(1);
    expect(clampCustomDays('90')).toBe(90);
    expect(clampCustomDays('365')).toBe(90); // clamped to the 90-day cost bound
    expect(clampCustomDays('0')).toBeUndefined();
    expect(clampCustomDays('-5')).toBeUndefined();
    expect(clampCustomDays('abc')).toBeUndefined();
    expect(clampCustomDays('')).toBeUndefined();
    expect(clampCustomDays(undefined)).toBeUndefined();
    expect(clampCustomDays(null)).toBeUndefined();
  });
});
