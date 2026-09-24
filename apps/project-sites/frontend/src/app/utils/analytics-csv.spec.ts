import { buildAnalyticsCsv, type AnalyticsCsvInput } from './analytics-csv';

const BASE: AnalyticsCsvInput = {
  source: 'First-party (visitor_events)',
  range: '7d',
  envelope: {
    pageviews: 120,
    uniques: 90,
    total_requests: 340,
    series: [{ date: '2026-09-23', page_views: 40 }],
    top_pages: [{ path: '/pricing', views: 30 }],
    top_countries: [{ country: 'US', views: 88 }],
    top_referrers: [{ referrer: 'google', views: 22 }],
    urls_included: [{ hostname: 'acme.projectsites.dev', resolved_zone: false }],
  },
  traffic: {
    byDevice: [{ label: 'mobile', count: 70 }],
    byBrowser: [{ label: 'Chrome', count: 61 }],
    byOs: [{ label: 'iOS', count: 44 }],
    byChannel: [{ label: 'organic', count: 55 }],
    byConversionKind: [{ label: 'call', count: 9 }],
    bounceRatePercent: 42,
    webVitals: { lcp: { p75: 2372, samples: 12 }, inp: null, cls: { p75: 0.05, samples: 12 } },
  },
};

function rows(csv: string): string[] {
  return csv.trimEnd().split('\n');
}

describe('buildAnalyticsCsv', () => {
  it('writes the ACCURATE resolved source, never a hardcoded "cloudflare_graphql"', () => {
    const csv = buildAnalyticsCsv(BASE);
    expect(csv).toContain('summary,source,First-party (visitor_events)');
    expect(csv).not.toContain('cloudflare_graphql');
  });

  it('includes the CF-envelope summary + breakdowns', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r[0]).toBe('section,key,value');
    expect(r).toContain('summary,page_views,120');
    expect(r).toContain('summary,unique_visitors,90');
    expect(r).toContain('summary,total_requests,340');
    expect(r).toContain('by_day,2026-09-23,40');
    expect(r).toContain('top_page,/pricing,30');
    expect(r).toContain('country,US,88');
    expect(r).toContain('referrer,google,22');
    expect(r).toContain('url_included,acme.projectsites.dev,unresolved');
  });

  it('includes the D1 breakdowns the prior export dropped (device/channel/conversion)', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r).toContain('device,mobile,70');
    expect(r).toContain('channel,organic,55');
    expect(r).toContain('conversion,call,9');
    expect(r).toContain('summary,bounce_rate_percent,42');
  });

  it('exports the full device/browser/os platform trio in that grouped order', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r).toContain('device,mobile,70');
    expect(r).toContain('browser,Chrome,61');
    expect(r).toContain('os,iOS,44');
    // The three tech dimensions stay grouped, device → browser → os (mirrors the card).
    const device = r.findIndex((l) => l.startsWith('device,'));
    const browser = r.findIndex((l) => l.startsWith('browser,'));
    const os = r.findIndex((l) => l.startsWith('os,'));
    expect(device).toBeLessThan(browser);
    expect(browser).toBeLessThan(os);
  });

  it('omits browser/os rows when those breakdowns are absent (never a fabricated row)', () => {
    const csv = buildAnalyticsCsv({
      ...BASE,
      traffic: { byDevice: [{ label: 'mobile', count: 70 }] },
    });
    expect(csv).toContain('device,mobile,70'); // device still present
    expect(csv).not.toContain('browser,');
    expect(csv).not.toContain('os,');
  });

  it('emits a CWV row only for a MEASURED metric (null → omitted, never a fake 0)', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r).toContain('web_vital,lcp_p75_ms,2372');
    expect(r).toContain('web_vital,cls_p75,0.05');
    expect(r.some((line) => line.startsWith('web_vital,inp'))).toBeFalse(); // inp null → omitted
  });

  it('omits measured-only rows when the traffic block is null / empty', () => {
    const csv = buildAnalyticsCsv({ ...BASE, traffic: null });
    expect(csv).toContain('summary,page_views,120'); // envelope still exported
    expect(csv).not.toContain('device,');
    expect(csv).not.toContain('web_vital,');
    expect(csv).not.toContain('bounce_rate_percent');
  });

  it('includes the CF edge delivery breakdown when it has real data', () => {
    const r = rows(
      buildAnalyticsCsv({
        ...BASE,
        delivery: {
          has_data: true,
          total_requests: 31610,
          by_status_class: [
            { class: '2xx', count: 27588 },
            { class: '5xx', count: 3145 },
          ],
          cache: { hit: 1477, miss: 3145, uncacheable: 26988, hit_ratio_pct: 32 },
          response_bytes: 1165215050,
        },
      }),
    );
    expect(r).toContain('delivery,edge_requests,31610');
    expect(r).toContain('delivery,status_2xx,27588');
    expect(r).toContain('delivery,status_5xx,3145');
    expect(r).toContain('delivery,cache_hit,1477');
    expect(r).toContain('delivery,cache_hit_ratio_pct,32');
    expect(r).toContain('delivery,edge_response_bytes,1165215050');
  });

  it('omits delivery rows when has_data is false or delivery is absent (never fabricated zeros)', () => {
    const empty = buildAnalyticsCsv({
      ...BASE,
      delivery: {
        has_data: false,
        total_requests: 0,
        by_status_class: [],
        cache: { hit: 0, miss: 0, uncacheable: 0, hit_ratio_pct: null },
        response_bytes: 0,
      },
    });
    expect(empty).not.toContain('delivery,');
    expect(buildAnalyticsCsv(BASE)).not.toContain('delivery,'); // absent → no rows
  });

  it('escapes cells that would break the CSV grid', () => {
    const csv = buildAnalyticsCsv({
      ...BASE,
      envelope: { ...BASE.envelope, top_pages: [{ path: '/a,b "c"', views: 1 }] },
    });
    expect(csv).toContain('top_page,"/a,b ""c""",1');
  });

  it('guards formula injection on attacker-controllable cells (referrer from a crafted header)', () => {
    const csv = buildAnalyticsCsv({
      ...BASE,
      envelope: { ...BASE.envelope, top_referrers: [{ referrer: '=cmd', views: 1 }] },
    });
    expect(csv).toContain("referrer,'=cmd,1"); // leading '=' guarded with a ' prefix
  });
});
