import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { PublicAnalyticsComponent, cwvOverallRating } from './public-analytics.component';
import { ApiService } from '../services/api.service';

const SUMMARY = {
  summary: {
    traffic: { pageviews: 1234, uniqueSessions: 567 }, // real API key (was uniqueVisitors → always 0)
    contacts: { total: 12 },
    formSubmissions: { total: 8 },
    newsletter: { confirmed: 30 },
    donations: { raisedCents: 25000, count: 5 },
  },
  expiresAt: 2_000_000_000_000,
};

function make(opts: { token?: string; get?: jasmine.Spy } = {}) {
  const token = 'token' in opts ? opts.token : 'site_1.123.abc';
  const get = opts.get ?? jasmine.createSpy('get').and.returnValue(of(SUMMARY));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PublicAnalyticsComponent],
    providers: [
      { provide: ApiService, useValue: { get } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(token ? { token } : {}) } },
      },
    ],
  });
  const f = TestBed.createComponent(PublicAnalyticsComponent);
  f.detectChanges();
  return { f, get };
}

describe('PublicAnalyticsComponent (AN48 public read-only view)', () => {
  it('fetches the public endpoint with the route token and renders the aggregate stats', () => {
    const { f, get } = make();
    expect(get).toHaveBeenCalledWith('/public/analytics/site_1.123.abc');
    const stats = f.nativeElement.querySelectorAll('[data-testid="public-analytics-stats"] li');
    expect(stats.length).toBeGreaterThanOrEqual(5);
    expect(f.nativeElement.textContent).toContain('1234');
    expect(f.nativeElement.textContent).toContain('Pageviews');
    expect(f.nativeElement.textContent).toContain('$250'); // donations 25000c → $250
    // The visitors tile reads the REAL `uniqueSessions` key (was `uniqueVisitors` → always
    // a fake 0) and is honestly labelled "Visits" (visitor-days), never "Unique visitors".
    expect(f.nativeElement.textContent).withContext('honest label').toContain('Visits');
    expect(f.nativeElement.textContent).withContext('real value, not a fake 0').toContain('567');
    expect(f.nativeElement.textContent).withContext('no unique-people claim').not.toContain('Unique visitors');
  });

  it('renders first-party engagement + performance when they have real samples (formatted)', () => {
    const rich = {
      summary: {
        ...SUMMARY.summary,
        traffic: {
          pageviews: 1234,
          uniqueSessions: 567,
          engagement: { medianMs: 80000, samples: 340 }, // 1m 20s
          scrollDepth: { medianPercent: 62, samples: 200 },
          navTiming: { total: 820, samples: 120 },
        },
      },
      expiresAt: 2_000_000_000_000,
    };
    const { f } = make({ get: jasmine.createSpy('get').and.returnValue(of(rich)) });
    const text = f.nativeElement.textContent;
    expect(text).toContain('Avg. time on page');
    expect(text).toContain('1m 20s');
    expect(text).toContain('Median scroll depth');
    expect(text).toContain('62%');
    expect(text).toContain('Median page load');
    expect(text).toContain('820ms');
  });

  it('OMITS engagement/scroll/load when there are no samples (never a fabricated 0)', () => {
    const empty = {
      summary: {
        ...SUMMARY.summary,
        traffic: {
          pageviews: 1234,
          uniqueSessions: 567,
          engagement: { medianMs: null, samples: 0 },
          scrollDepth: { medianPercent: null, samples: 0 },
          navTiming: { total: null, samples: 0 },
        },
      },
      expiresAt: 2_000_000_000_000,
    };
    const { f } = make({ get: jasmine.createSpy('get').and.returnValue(of(empty)) });
    const text = f.nativeElement.textContent;
    expect(text).not.toContain('Avg. time on page');
    expect(text).not.toContain('Median scroll depth');
    expect(text).not.toContain('Median page load');
    // the base stats still render
    expect(text).toContain('Pageviews');
  });

  it('shows the friendly expired/invalid message when the endpoint 404s', () => {
    const { f } = make({
      get: jasmine.createSpy('get').and.returnValue(throwError(() => new Error('404'))),
    });
    expect(f.nativeElement.querySelector('[data-testid="public-analytics-error"]')).toBeTruthy();
  });

  it('shows the error state (no fetch) when the token param is missing', () => {
    const { f, get } = make({ token: '' });
    expect(get).not.toHaveBeenCalled();
    expect(f.nativeElement.querySelector('[data-testid="public-analytics-error"]')).toBeTruthy();
  });

  it('renders a "Page speed" verdict from Core Web Vitals when measured', () => {
    const rich = {
      summary: {
        ...SUMMARY.summary,
        traffic: {
          pageviews: 1234,
          uniqueSessions: 567,
          webVitals: {
            lcp: { p75: 1800, samples: 80 }, // good
            inp: { p75: 150, samples: 80 }, // good
            cls: { p75: 0.05, samples: 80 }, // good
          },
        },
      },
      expiresAt: 2_000_000_000_000,
    };
    const { f } = make({ get: jasmine.createSpy('get').and.returnValue(of(rich)) });
    const text = f.nativeElement.textContent;
    expect(text).toContain('Page speed');
    expect(text).toContain('Good');
  });

  it('OMITS "Page speed" when no CWV field samples exist (never a fabricated rating)', () => {
    const empty = {
      summary: {
        ...SUMMARY.summary,
        traffic: { pageviews: 1234, uniqueSessions: 567, webVitals: { lcp: null, inp: null, cls: null } },
      },
      expiresAt: 2_000_000_000_000,
    };
    const { f } = make({ get: jasmine.createSpy('get').and.returnValue(of(empty)) });
    expect(f.nativeElement.textContent).not.toContain('Page speed');
  });
});

describe('cwvOverallRating (public "Page speed" verdict — Google pass model)', () => {
  const stat = (p75: number) => ({ p75, samples: 50 });
  it('Good only when EVERY measured core metric is good', () => {
    expect(cwvOverallRating({ lcp: stat(1800), inp: stat(150), cls: stat(0.05) })).toBe('Good');
  });
  it('Poor when ANY measured metric is poor', () => {
    expect(cwvOverallRating({ lcp: stat(5000), inp: stat(150), cls: stat(0.05) })).toBe('Poor');
  });
  it('Needs improvement when the worst measured metric is "needs" (no poor)', () => {
    expect(cwvOverallRating({ lcp: stat(3000), cls: stat(0.05) })).toBe('Needs improvement');
  });
  it('ignores unmeasured metrics (null / 0 samples) — rates only what has data', () => {
    expect(cwvOverallRating({ lcp: stat(1800), inp: null, cls: { p75: 0.05, samples: 0 } })).toBe('Good');
  });
  it('null when NO core metric has samples, or the block is absent', () => {
    expect(cwvOverallRating({ lcp: null, inp: null, cls: null })).toBeNull();
    expect(cwvOverallRating(undefined)).toBeNull();
  });
  it('uses Google thresholds at the boundaries (LCP ≤2500 good, ≤4000 needs)', () => {
    expect(cwvOverallRating({ lcp: stat(2500) })).toBe('Good');
    expect(cwvOverallRating({ lcp: stat(2501) })).toBe('Needs improvement');
    expect(cwvOverallRating({ lcp: stat(4001) })).toBe('Poor');
  });
});
