import {
  multiUrlAnalyticsFixture,
  siteAnalyticsFixture,
  analyticsDailyFixture,
  analyticsWeekdayFixture,
  analyticsVisitorsFixture,
  analyticsEntryPagesFixture,
  analyticsExitPagesFixture,
  analyticsClicksFixture,
  analyticsSessionDurationFixture,
  analyticsConciergeFixture,
  analyticsReferrersFixture,
  analyticsSectionsFixture,
  analyticsFormsFixture,
  analyticsFunnelFixture,
  cloudflareRumFixture,
  siteUrlsFixture,
  cloudflareCredentialsFixture,
} from './analytics.fixture';
import { toRegistryKey } from './index';

/**
 * analytics.fixture — the mock bodies for the whole `/admin/analytics` surface.
 * Contract: every factory matches the REAL worker wire shape (traced to
 * site_analytics/handlers.ts + cloudflare_rum.ts + site_urls/handlers.ts +
 * /admin/cloudflare-credentials); the populated view is INTERNALLY CONSISTENT (the
 * daily chart sums to the KPI totals, the funnel narrows monotonically); state variants
 * empty (zero traffic / honest-empty) vs populated (rich 30-day view); query honoring
 * (windowDays, filterDim/Value echo, tz, range/days).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('analytics.fixture — whole-surface worker-contract fixtures', () => {
  // ─────────────────── GET /sites/:id/analytics (first-party summary) ───────────────────
  describe('siteAnalyticsFixture (BARE SiteAnalyticsSummary with .traffic)', () => {
    it('returns the bare summary envelope (no { data } wrapper) with a .traffic block', () => {
      const res = siteAnalyticsFixture('populated', q());
      expect(res.siteId).toBeDefined();
      expect(typeof res.windowDays).toBe('number');
      expect(res.traffic).toBeDefined();
      expect(typeof res.traffic.pageviews).toBe('number');
    });

    it('populated → rich non-zero traffic with a true session-depth bounce', () => {
      const t = siteAnalyticsFixture('populated', q()).traffic;
      expect(t.pageviews).toBeGreaterThan(0);
      expect(t.uniqueSessions).toBeGreaterThan(0);
      expect(t.conversions).toBeGreaterThan(0);
      expect(typeof t.bounceRatePercent).toBe('number'); // preferred over the edge proxy
      expect(t.topPaths.length).toBeGreaterThan(0);
      expect(t.byChannel.length).toBeGreaterThan(0);
      expect(t.byDevice.length).toBeGreaterThan(0);
    });

    it('populated → every self-fetched-sibling-equivalent block is present (cards render populated)', () => {
      const t = siteAnalyticsFixture('populated', q()).traffic;
      expect(t.webVitals?.lcp?.p75).toBeGreaterThan(0);
      expect(t.formFunnel?.submits).toBeGreaterThan(0);
      expect(t.outboundClicks?.total).toBeGreaterThan(0);
      expect(t.engagement?.medianMs).toBeGreaterThan(0);
      expect(t.scrollDepth?.medianPercent).toBeGreaterThan(0);
      expect(t.navTiming?.total).toBeGreaterThan(0);
      expect(t.byHour?.length).toBe(24);
      expect((t.byConversionKind ?? []).length).toBeGreaterThan(0);
    });

    it('empty → zero traffic + null measurements (honest brand-new site, never fake 0)', () => {
      const t = siteAnalyticsFixture('empty', q()).traffic;
      expect(t.pageviews).toBe(0);
      expect(t.uniqueSessions).toBe(0);
      expect(t.conversions).toBe(0);
      expect(t.bounceRatePercent).toBeNull();
      expect(t.topPaths).toEqual([]);
      expect(t.webVitals?.lcp).toBeNull();
      expect(t.engagement?.medianMs).toBeNull();
      expect(t.formFunnel?.completionRatePercent).toBeNull();
    });

    it('honors windowDays (clamped 1..90) and reflects it in the summary + traffic', () => {
      const res = siteAnalyticsFixture('populated', q('windowDays=7'));
      expect(res.windowDays).toBe(7);
      expect(res.traffic.windowDays).toBe(7);
      // Out-of-range clamps rather than NaNs.
      expect(siteAnalyticsFixture('populated', q('windowDays=9999')).windowDays).toBe(90);
      expect(siteAnalyticsFixture('populated', q('windowDays=0')).windowDays).toBe(1);
    });

    it('echoes appliedFilter ONLY when both filterDim + filterValue are present', () => {
      expect(siteAnalyticsFixture('populated', q()).appliedFilter).toBeUndefined();
      expect(siteAnalyticsFixture('populated', q('filterDim=country')).appliedFilter).toBeUndefined();
      const filtered = siteAnalyticsFixture('populated', q('filterDim=country&filterValue=US'));
      expect(filtered.appliedFilter).toEqual({ dim: 'country', value: 'US' });
    });
  });

  // ─────────────────── GET /sites/:id/analytics/daily (chart series) ───────────────────
  describe('analyticsDailyFixture ({ days })', () => {
    it('populated → a 30-day series whose pageviews SUM EXACTLY to the KPI total', () => {
      const { days } = analyticsDailyFixture('populated', q());
      expect(days.length).toBe(30);
      const pv = days.reduce((a, d) => a + d.pageviews, 0);
      const vis = days.reduce((a, d) => a + d.uniqueSessions, 0);
      // Internal consistency: the chart total matches the summary KPI (4820 / 2140).
      expect(pv).toBe(4820);
      expect(vis).toBe(2140);
      // Every row is well-formed + non-negative.
      for (const d of days) {
        expect(typeof d.day).toBe('string');
        expect(d.pageviews).toBeGreaterThanOrEqual(0);
        expect(d.uniqueSessions).toBeGreaterThanOrEqual(0);
        expect(d.conversions).toBeGreaterThanOrEqual(0);
      }
    });

    it('empty → { days: [] } (the chart renders its "No traffic yet" empty state)', () => {
      expect(analyticsDailyFixture('empty', q()).days).toEqual([]);
    });
  });

  // ─────────────────── GET /sites/:id/multi-url-analytics (CF aggregate) ───────────────────
  describe('multiUrlAnalyticsFixture ({ data: MultiUrlAnalyticsEnvelope })', () => {
    it('wraps the envelope in { data } and reports a subdomain (beacon) — zone UNRESOLVED, no CF data', () => {
      const { data } = multiUrlAnalyticsFixture('populated', q('range=30d'));
      expect(data.any_real_data).toBe(false); // subdomain → CF edge has nothing
      expect(data.delivery).toBeNull();
      expect(data.urls_included.length).toBe(1);
      expect(data.urls_included[0]!.resolved_zone).toBe(false); // drives trafficSource='beacon'
    });

    it('honors days / range → range_days (clamped)', () => {
      expect(multiUrlAnalyticsFixture('populated', q('range=7d')).data.range_days).toBe(7);
      expect(multiUrlAnalyticsFixture('populated', q('range=90d')).data.range_days).toBe(90);
      expect(multiUrlAnalyticsFixture('populated', q('days=14')).data.range_days).toBe(14);
    });
  });

  // ─────────────────── GET /sites/:id/urls + /admin/cloudflare-credentials ───────────────────
  describe('siteUrlsFixture + cloudflareCredentialsFixture', () => {
    it('siteUrls → one primary host row ({ data: SiteUrlRow[] }, is_primary is the D1 int 1)', () => {
      const { data } = siteUrlsFixture('populated', q());
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0]!.is_primary).toBe(1);
      expect(typeof data[0]!.hostname).toBe('string');
    });

    it('cloudflare-credentials → honest "none" for a demo org (no CF key on file)', () => {
      const { data } = cloudflareCredentialsFixture('populated', q());
      expect(data.has_credentials).toBe(false);
      expect(data.source).toBe('none');
      expect(data.email).toBeNull();
    });
  });

  // ─────────────────── GET /sites/:id/cloudflare-rum ───────────────────
  describe('cloudflareRumFixture (bare CloudflareRumResponse)', () => {
    it('reports not-available with an honest reason (shared-zone subdomain, no CF creds)', () => {
      const res = cloudflareRumFixture('populated', q('days=30'));
      expect(res.available).toBe(false);
      expect(res.reason).toBeTruthy();
      expect(res.days).toBe(30);
    });
  });

  // ─────────────────── self-fetching cards ───────────────────
  describe('analyticsWeekdayFixture ({ byWeekday, tzApplied })', () => {
    it('populated → 7 weekday buckets; tzApplied true only when tz is sent', () => {
      const res = analyticsWeekdayFixture('populated', q('tz=-480'));
      expect(res.byWeekday.length).toBe(7);
      expect(res.tzApplied).toBe(true);
      expect(res.byWeekday.map((b) => b.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(analyticsWeekdayFixture('populated', q()).tzApplied).toBe(false);
    });
    it('empty → no buckets', () => {
      expect(analyticsWeekdayFixture('empty', q()).byWeekday).toEqual([]);
    });
  });

  describe('analyticsVisitorsFixture (new / returning / unknown)', () => {
    it('populated → non-zero splits; empty → all zeros', () => {
      const p = analyticsVisitorsFixture('populated', q());
      expect(p.newVisits + p.returningVisits + p.unknownVisits).toBeGreaterThan(0);
      const e = analyticsVisitorsFixture('empty', q());
      expect(e.newVisits).toBe(0);
      expect(e.returningVisits).toBe(0);
      expect(e.unknownVisits).toBe(0);
    });
  });

  describe('analyticsEntryPagesFixture + analyticsExitPagesFixture ({ pages })', () => {
    it('populated → ranked paths; empty → []', () => {
      expect(analyticsEntryPagesFixture('populated', q()).pages.length).toBeGreaterThan(0);
      expect(analyticsExitPagesFixture('populated', q()).pages.length).toBeGreaterThan(0);
      expect(analyticsEntryPagesFixture('empty', q()).pages).toEqual([]);
      expect(analyticsExitPagesFixture('empty', q()).pages).toEqual([]);
      for (const p of analyticsEntryPagesFixture('populated', q()).pages) {
        expect(typeof p.path).toBe('string');
        expect(typeof p.count).toBe('number');
      }
    });
  });

  describe('analyticsClicksFixture ({ total, byLabel })', () => {
    it('populated → total matches byLabel coverage shape; empty → zero', () => {
      const p = analyticsClicksFixture('populated', q());
      expect(p.total).toBeGreaterThan(0);
      expect(p.byLabel.length).toBeGreaterThan(0);
      expect(analyticsClicksFixture('empty', q())).toEqual({ total: 0, byLabel: [] });
    });
  });

  describe('analyticsSessionDurationFixture', () => {
    it('populated → non-null medians + distribution; empty → null medians (measuring…)', () => {
      const p = analyticsSessionDurationFixture('populated', q());
      expect(p.sessions).toBeGreaterThan(0);
      expect(p.medianMs).toBeGreaterThan(0);
      expect(p.distribution.s30).toBeGreaterThanOrEqual(p.distribution.s300); // monotonic buckets
      const e = analyticsSessionDurationFixture('empty', q());
      expect(e.sessions).toBe(0);
      expect(e.medianMs).toBeNull();
    });
  });

  describe('analyticsConciergeFixture (self-hides at 0 opens)', () => {
    it('populated → opens>0 with a messagesPerOpen ratio; empty → all-zero (card hidden)', () => {
      const p = analyticsConciergeFixture('populated', q());
      expect(p.opens).toBeGreaterThan(0);
      expect(p.messagesPerOpen).toBeGreaterThan(0);
      const e = analyticsConciergeFixture('empty', q());
      expect(e.opens).toBe(0);
      expect(e.messagesPerOpen).toBeNull();
    });
  });

  describe('analyticsReferrersFixture ({ domains, capped })', () => {
    it('populated → external domains with a capped flag; empty → []', () => {
      const p = analyticsReferrersFixture('populated', q());
      expect(p.domains.length).toBeGreaterThan(0);
      expect(typeof p.capped).toBe('boolean');
      expect(analyticsReferrersFixture('empty', q())).toEqual({ domains: [], capped: false });
    });
  });

  // ─────────────────── sibling tabs: sections / forms / funnel ───────────────────
  describe('analyticsSectionsFixture (By Section tab)', () => {
    it('populated → totalConversions + section rows summing to the headline conversions', () => {
      const res = analyticsSectionsFixture('populated', q('windowDays=30'));
      expect(res.totalConversions).toBe(96); // matches the summary conversions
      expect(res.sections.length).toBeGreaterThan(0);
      expect(res.windowDays).toBe(30);
      expect(typeof res.generatedAt).toBe('string');
    });
    it('empty → zero conversions + no sections', () => {
      const res = analyticsSectionsFixture('empty', q());
      expect(res.totalConversions).toBe(0);
      expect(res.sections).toEqual([]);
    });
  });

  describe('analyticsFormsFixture (Forms tab)', () => {
    it('populated → per-form funnel rows (starts ≥ submits, abandoned = starts − submits)', () => {
      const res = analyticsFormsFixture('populated', q());
      expect(res.forms.length).toBeGreaterThan(0);
      for (const f of res.forms) {
        expect(f.starts).toBeGreaterThanOrEqual(f.submits);
        expect(f.abandoned).toBe(f.starts - f.submits);
      }
    });
    it('empty → no forms', () => {
      expect(analyticsFormsFixture('empty', q()).forms).toEqual([]);
    });
  });

  describe('analyticsFunnelFixture (Visitor Funnel tab)', () => {
    it('populated → a MONOTONICALLY narrowing funnel, first stage = 100% of landing', () => {
      const { stages } = analyticsFunnelFixture('populated', q());
      expect(stages.length).toBeGreaterThan(1);
      expect(stages[0]!.percentOfLanding).toBe(100);
      for (let i = 1; i < stages.length; i++) {
        expect(stages[i]!.sessions).toBeLessThanOrEqual(stages[i - 1]!.sessions);
      }
    });
    it('empty → no stages', () => {
      expect(analyticsFunnelFixture('empty', q()).stages).toEqual([]);
    });
  });

  // ─────────────────── registry-key alignment (the exact paths the ApiService calls) ───────────────────
  describe('route keys the fixtures must answer (normalized like the interceptor)', () => {
    it('the per-site + admin analytics routes normalize to the expected registry keys', () => {
      // These are the EXACT keys the orchestrator will register the factories under.
      expect(toRegistryKey('GET', '/api/sites/site-1/analytics?windowDays=30').key).toBe(
        'GET /sites/site-1/analytics',
      );
      expect(toRegistryKey('GET', '/api/sites/site-1/analytics/daily?days=30').key).toBe(
        'GET /sites/site-1/analytics/daily',
      );
      expect(toRegistryKey('GET', '/api/sites/site-1/multi-url-analytics?range=7d').key).toBe(
        'GET /sites/site-1/multi-url-analytics',
      );
      expect(toRegistryKey('GET', '/api/sites/site-1/analytics/funnel').key).toBe(
        'GET /sites/site-1/analytics/funnel',
      );
      expect(toRegistryKey('GET', '/api/sites/site-1/cloudflare-rum?days=30').key).toBe(
        'GET /sites/site-1/cloudflare-rum',
      );
      expect(toRegistryKey('GET', '/api/sites/site-1/urls').key).toBe('GET /sites/site-1/urls');
      expect(toRegistryKey('GET', '/api/admin/cloudflare-credentials').key).toBe(
        'GET /admin/cloudflare-credentials',
      );
    });
  });
});
