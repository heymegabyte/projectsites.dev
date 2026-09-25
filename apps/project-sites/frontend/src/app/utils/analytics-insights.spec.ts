import { buildAnalyticsInsights, type AnalyticsInsightsInput } from './analytics-insights';

const BASE: AnalyticsInsightsInput = {
  windowDays: 7,
  pageviews: 120,
  pvDelta: { dir: 'up', label: '18%' },
  topPage: { path: '/pricing', views: 30 },
  byDevice: [
    { label: 'mobile', count: 68 },
    { label: 'desktop', count: 32 },
  ],
  topCountry: { label: 'US', count: 88 },
  topConversionKind: { label: 'call', count: 3 },
  conversionDelta: { dir: 'up', label: 'new' },
  bounceRatePercent: 42,
};

describe('buildAnalyticsInsights', () => {
  it('builds evidence-backed highlights with real numbers + honest comparisons (capped at 5)', () => {
    const ins = buildAnalyticsInsights(BASE);
    expect(ins.length).toBe(5); // 6 candidates → capped at 5
    const text = ins.map((i) => i.text).join(' | ');
    expect(text).toContain('120 page views in the last 7 days, up 18% vs the previous 7 days');
    expect(text).toContain('3 phone calls in the last 7 days — new in the last 7 days');
    expect(text).toContain('Your most-visited page is /pricing (30 views)');
    expect(text).toContain('68% of visitors are on mobile');
    expect(text).toContain('Your top visitor location is US');
  });

  it('emits NOTHING when there is no real data (never a fabricated highlight)', () => {
    expect(
      buildAnalyticsInsights({
        windowDays: 7,
        pageviews: 0,
        topPage: null,
        byDevice: [],
        topCountry: null,
        topConversionKind: null,
        bounceRatePercent: null,
      }),
    ).toEqual([]);
  });

  it('omits the comparison clause when there is no prior period (pvDelta null)', () => {
    const traffic = buildAnalyticsInsights({ ...BASE, pvDelta: null }).find((i) => i.id === 'traffic');
    expect(traffic!.text).toBe('120 page views in the last 7 days.');
    expect(traffic!.text).not.toContain('vs the previous');
  });

  it('only surfaces a device MAJORITY (≥50%) — a plurality below 50% is never claimed', () => {
    const minority = buildAnalyticsInsights({
      ...BASE,
      byDevice: [
        { label: 'mobile', count: 40 },
        { label: 'desktop', count: 35 },
        { label: 'tablet', count: 30 },
      ], // 40/105 = 38% < 50
    });
    expect(minority.find((i) => i.id === 'device')).toBeUndefined();
  });

  it('humanizes conversion kinds (form_submit → form submissions)', () => {
    const t = buildAnalyticsInsights({
      ...BASE,
      topConversionKind: { label: 'form_submit', count: 5 },
      conversionDelta: null,
    }).find((i) => i.id === 'conversions');
    expect(t!.text).toBe('5 form submissions in the last 7 days.');
  });

  it('emits the bounce insight when session-measured and within the top 5', () => {
    const ins = buildAnalyticsInsights({ ...BASE, topConversionKind: null, conversionDelta: null });
    expect(ins.some((i) => i.id === 'bounce' && i.text === '42% of visits saw just one page.')).toBeTrue();
  });

  it('omits bounce when not session-measured (null → no fabricated stickiness)', () => {
    expect(buildAnalyticsInsights({ ...BASE, bounceRatePercent: null }).some((i) => i.id === 'bounce')).toBeFalse();
  });

  it('attaches a drilldown to the filterable insights (device/top-page/country), not the aggregate ones', () => {
    const byId = Object.fromEntries(buildAnalyticsInsights(BASE).map((i) => [i.id, i]));
    expect(byId['device'].drill).toEqual({ dim: 'device', value: 'mobile' });
    expect(byId['top-page'].drill).toEqual({ dim: 'path', value: '/pricing' });
    expect(byId['country'].drill).toEqual({ dim: 'country', value: 'US' });
    // Aggregate insights have nothing single to filter to — no drill.
    expect(byId['traffic'].drill).toBeUndefined();
    expect(byId['conversions'].drill).toBeUndefined();
  });

  it('surfaces a page-speed insight from first-party FCP p75, rated, only when measured', () => {
    const fast = buildAnalyticsInsights({ ...BASE, fcpMs: 1600 }).find((i) => i.id === 'page-speed');
    expect(fast!.text).toBe('Your pages start showing content in 1.6s (fast).'); // ≤1800 → fast
    expect(buildAnalyticsInsights({ ...BASE, fcpMs: 2500 }).find((i) => i.id === 'page-speed')!.text).toContain('(okay)');
    expect(buildAnalyticsInsights({ ...BASE, fcpMs: 3500 }).find((i) => i.id === 'page-speed')!.text).toContain('(slow)');
    // Not measured (null / 0) → NO page-speed insight (never a fabricated speed).
    expect(buildAnalyticsInsights({ ...BASE, fcpMs: null }).some((i) => i.id === 'page-speed')).toBeFalse();
    expect(buildAnalyticsInsights({ ...BASE, fcpMs: 0 }).some((i) => i.id === 'page-speed')).toBeFalse();
  });
});
