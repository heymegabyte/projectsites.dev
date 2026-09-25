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
    byUtmSource: [{ label: 'instagram', count: 18 }],
    byUtmCampaign: [{ label: 'spring-sale', count: 12 }],
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

  it('emits busiest-hours rows (local HH:00) when hourlyLocal is provided', () => {
    const r = rows(
      buildAnalyticsCsv({
        ...BASE,
        hourlyLocal: [
          { hour: 9, count: 3 },
          { hour: 18, count: 12 },
        ],
      }),
    );
    expect(r).toContain('hour_local,09:00,3');
    expect(r).toContain('hour_local,18:00,12');
  });

  it('omits busiest-hours rows when hourlyLocal is absent (never a fabricated hour)', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r.some((l) => l.startsWith('hour_local,'))).toBeFalse();
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

  it('exports the campaign attribution rows (utm_source + utm_campaign) from tagged visits', () => {
    const r = rows(buildAnalyticsCsv(BASE));
    expect(r).toContain('campaign_source,instagram,18');
    expect(r).toContain('campaign,spring-sale,12');
  });

  it('omits campaign rows when there is no tagged traffic (never a fabricated campaign)', () => {
    const csv = buildAnalyticsCsv({
      ...BASE,
      traffic: { byDevice: [{ label: 'mobile', count: 70 }] }, // no utm breakdowns
    });
    expect(csv).not.toContain('campaign_source,');
    expect(csv).not.toContain('\ncampaign,');
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

  it('includes the edge connection/content + verified-bot breakdowns (mirrors the delivery card)', () => {
    const r = rows(
      buildAnalyticsCsv({
        ...BASE,
        delivery: {
          has_data: true,
          total_requests: 340,
          by_status_class: [{ class: '2xx', count: 315 }],
          cache: { hit: 7, miss: 25, uncacheable: 308, hit_ratio_pct: 22 },
          response_bytes: 1000,
          protocols: [
            { label: 'HTTP/3', count: 147 },
            { label: 'HTTP/2', count: 163 },
          ],
          tls: [{ label: 'TLSv1.3', count: 314 }],
          content_types: [{ label: 'js', count: 160 }],
          methods: [{ label: 'GET', count: 289 }],
          verified_bots: [{ label: 'Search Engine Crawler', count: 23 }],
        },
      }),
    );
    expect(r).toContain('edge_protocol,HTTP/3,147');
    expect(r).toContain('edge_tls,TLSv1.3,314');
    expect(r).toContain('edge_content_type,js,160');
    expect(r).toContain('edge_method,GET,289');
    expect(r).toContain('edge_verified_bot,Search Engine Crawler,23');
  });

  it('exports first-party page-load timing (TTFB + FCP) only when measured (null → omitted)', () => {
    const r = rows(
      buildAnalyticsCsv({
        ...BASE,
        traffic: {
          ...BASE.traffic!,
          webVitals: {
            lcp: { p75: 2372, samples: 12 },
            inp: null,
            cls: null,
            ttfb: { p75: 420, samples: 30 },
            fcp: { p75: 1600, samples: 30 },
          },
        },
      }),
    );
    expect(r).toContain('web_vital,ttfb_p75_ms,420');
    expect(r).toContain('web_vital,fcp_p75_ms,1600');
    // BASE's webVitals has no ttfb/fcp → those rows are omitted (never a fake 0).
    expect(rows(buildAnalyticsCsv(BASE)).some((l) => l.startsWith('web_vital,ttfb'))).toBeFalse();
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
