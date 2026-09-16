import { computeChange, defaultDashboard, filterBySource, buildMetric, metricSources, parseMetricSources, METRIC_SOURCES } from '../service.js';

describe('computeChange', () => {
  test('increase → up trend', () => {
    expect(computeChange(120, 100)).toEqual({ changePercent: 20, trend: 'up' });
  });
  test('decrease → down trend', () => {
    expect(computeChange(80, 100)).toEqual({ changePercent: -20, trend: 'down' });
  });
  test('small change → flat', () => {
    expect(computeChange(102, 100).trend).toBe('flat');
  });
  test('zero previous → 100% if current >0', () => {
    expect(computeChange(50, 0).changePercent).toBe(100);
  });
});

describe('defaultDashboard', () => {
  test('returns 11 default widgets in grid layout', () => {
    const d = defaultDashboard('s1');
    expect(d.widgets).toHaveLength(11);
    expect(d.layout).toBe('grid');
    expect(d.siteId).toBe('s1');
  });
});

describe('filterBySource', () => {
  test('filters to website-only widgets', () => {
    const d = defaultDashboard('s1');
    const f = filterBySource(d, ['website']);
    expect(f.widgets.every((w) => w.source === 'website')).toBe(true);
    expect(f.widgetCount).toBeLessThan(d.widgetCount);
  });
  test('re-positions filtered widgets sequentially', () => {
    const d = defaultDashboard('s1');
    const f = filterBySource(d, ['website']);
    expect(f.widgets[0].position).toBe(0);
    expect(f.widgets[1].position).toBe(1);
  });
});

describe('buildMetric', () => {
  test('builds complete metric value', () => {
    const m = buildMetric('Visitors', 1000, 800, 'website');
    expect(m.label).toBe('Visitors');
    expect(m.value).toBe(1000);
    expect(m.previousValue).toBe(800);
    expect(m.changePercent).toBe(25);
    expect(m.trend).toBe('up');
    expect(m.source).toBe('website');
  });
});

describe('metricSources', () => {
  test('returns 6 sources', () => {
    expect(metricSources()).toHaveLength(6);
    expect(metricSources()).toContain('website');
    expect(metricSources()).toContain('crm');
  });
  test('derives from the METRIC_SOURCES SSOT (no hand-maintained duplicate to drift)', () => {
    expect(metricSources()).toEqual([...METRIC_SOURCES]);
  });
});

describe('parseMetricSources (untrusted ?sources= boundary guard)', () => {
  test('keeps valid sources in input order, DROPS unknown tokens (no `as any` smuggling)', () => {
    expect(parseMetricSources('website, email, bogus')).toEqual(['website', 'email']);
  });
  test('empty / all-garbage → [] (a bad ?sources=foo narrows to nothing)', () => {
    expect(parseMetricSources('')).toEqual([]);
    expect(parseMetricSources('foo,bar,,')).toEqual([]);
  });
  test('trims whitespace and de-duplicates', () => {
    expect(parseMetricSources(' crm , crm , social ')).toEqual(['crm', 'social']);
  });
  test('every valid source round-trips', () => {
    expect(parseMetricSources(METRIC_SOURCES.join(','))).toEqual([...METRIC_SOURCES]);
  });
});
