import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { CloudflareRumCardComponent, type CloudflareRumResponse } from './cloudflare-rum-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * CloudflareRumCardComponent — the CF-native RUM card. Load-bearing properties: it labels itself
 * SAMPLED + independent (never summed with first-party), shows server-provided ratings, renders a
 * metric with no samples as "—" (NEVER a fabricated 0), and honours available:false honestly.
 */
const LIVE: CloudflareRumResponse = {
  available: true,
  days: 7,
  host: 'franklin-barbecue.projectsites.dev',
  pageviews: 1837,
  sampled: true,
  webVitals: {
    lcp: { p75: 1988, rating: 'good', samples: 1126 },
    inp: { p75: 48, rating: 'good', samples: 1126 },
    cls: { p75: 0.4, rating: 'poor', samples: 1126 },
  },
  navTiming: {
    ttfb: { p75: 14, rating: 'good', samples: 670 },
    fcp: { p75: 744, rating: 'good', samples: 670 },
    pageLoad: { p75: 2008, rating: null, samples: 670 },
    dns: { p75: 3, rating: null, samples: 670 },
    connect: { p75: 52, rating: null, samples: 670 },
  },
  window: { since: 'S', until: 'U' },
};

function render(resp: CloudflareRumResponse | null, siteId: string | null = 'acme', windowDays = 7) {
  const get = jasmine.createSpy('get').and.returnValue(resp === null ? of() : of(resp));
  TestBed.configureTestingModule({
    imports: [CloudflareRumCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(CloudflareRumCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined)?.textContent ?? '';

describe('CloudflareRumCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is always labelled as sampled Cloudflare Web Analytics (never implies exact)', () => {
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="an-cf-rum-source"]')).toContain('sampled');
    expect(text(fixture, '[data-testid="an-cf-rum-source"]')).toContain('Cloudflare Web Analytics');
  });

  it('renders all three Core Web Vitals + all five Navigation-Timing tiles', () => {
    const { fixture } = render(LIVE);
    for (const k of ['lcp', 'inp', 'cls', 'ttfb', 'fcp', 'pageLoad', 'dns', 'connect']) {
      expect(fixture.debugElement.query(By.css(`[data-testid="an-cf-rum-${k}"]`)))
        .withContext(`${k} tile`)
        .toBeTruthy();
    }
  });

  it('formats timing as ms/s, CLS unitless, and shows the SERVER rating word', () => {
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="an-cf-rum-lcp"]')).toContain('1.99 s'); // 1988ms → seconds
    expect(text(fixture, '[data-testid="an-cf-rum-lcp"]')).toContain('Good');
    expect(text(fixture, '[data-testid="an-cf-rum-ttfb"]')).toContain('14 ms');
    expect(text(fixture, '[data-testid="an-cf-rum-cls"]')).toContain('0.40'); // unitless, 2dp
    expect(text(fixture, '[data-testid="an-cf-rum-cls"]')).toContain('Poor');
  });

  it('shows the host + sampled pageload count', () => {
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="an-cf-rum-host"]')).toContain('franklin-barbecue.projectsites.dev');
    expect(text(fixture, '[data-testid="an-cf-rum-host"]')).toContain('1837');
  });

  it('renders an UNRATED timing metric (pageLoad) with a value but no rating word', () => {
    const { fixture } = render(LIVE);
    const load = text(fixture, '[data-testid="an-cf-rum-pageLoad"]');
    expect(load).toContain('2.01 s'); // 2008ms
    expect(load).not.toContain('Good');
    expect(load).not.toContain('Needs');
    expect(load).not.toContain('Poor');
  });

  it('renders a metric with no samples as "—" + "no samples", NEVER a fabricated 0', () => {
    const empty: CloudflareRumResponse = {
      ...LIVE,
      pageviews: null,
      webVitals: {
        lcp: { p75: null, rating: null, samples: 0 },
        inp: { p75: null, rating: null, samples: 0 },
        cls: { p75: null, rating: null, samples: 0 },
      },
    };
    const { fixture } = render(empty);
    const lcp = text(fixture, '[data-testid="an-cf-rum-lcp"]');
    expect(lcp).toContain('—');
    expect(lcp).toContain('no samples');
    expect(lcp).not.toContain('0 ms');
  });

  it('shows an honest note (with reason) when available:false — never an error, never a 0', () => {
    const { fixture } = render({ available: false, host: 'quiet.projectsites.dev', reason: 'No Cloudflare RUM data for this host yet.' });
    expect(fixture.debugElement.query(By.css('[data-testid="an-cf-rum-unavailable"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="an-cf-rum-unavailable"]')).toContain('No Cloudflare RUM data');
    expect(fixture.debugElement.query(By.css('[data-testid="an-cf-rum-lcp"]'))).toBeFalsy();
  });

  it('does NOT fetch when there is no selected site', () => {
    const { fixture, get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
    expect(fixture.debugElement.query(By.css('[data-testid="an-cf-rum-lcp"]'))).toBeFalsy();
  });

  it('fetches the tenant route with the day window as a param', () => {
    const { get } = render(LIVE, 'site-123', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-123/cloudflare-rum', { days: '14' });
  });
});
