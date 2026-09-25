import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { AnalyticsGlossaryComponent } from './analytics-glossary.component';

function setup() {
  TestBed.configureTestingModule({ imports: [AnalyticsGlossaryComponent] });
  const fixture = TestBed.createComponent(AnalyticsGlossaryComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('AnalyticsGlossaryComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders an accessible disclosure with a definition per key metric', () => {
    const { fixture, el } = setup();
    expect(el.querySelector('details[data-testid="an-glossary"]')).toBeTruthy();
    expect((el.querySelector('summary') as HTMLElement).textContent).toContain(
      'How these metrics are measured',
    );
    const items = fixture.debugElement.queryAll(By.css('[data-testid="an-glossary-item"]'));
    expect(items.length).toBeGreaterThanOrEqual(7);
    // Every item pairs a <dt> term with a <dd> definition (real definition list semantics).
    for (const it of items) {
      expect(it.query(By.css('dt'))).toBeTruthy();
      expect(
        (it.query(By.css('dd')).nativeElement as HTMLElement).textContent?.trim().length,
      ).toBeGreaterThan(20);
    }
  });

  it('states the honest source distinction on each metric (first-party / edge / real-user)', () => {
    const { el } = setup();
    const srcs = Array.from(el.querySelectorAll('.ag-src')).map((s) => s.textContent?.trim());
    expect(srcs).toContain('ProjectSites (first-party)');
    expect(srcs).toContain('Cloudflare edge');
    expect(srcs).toContain('Real-user (browser)');
  });

  it('explicitly explains requests vs page views (never conflated) and CWV honesty', () => {
    const { el } = setup();
    const text = el.textContent ?? '';
    expect(text)
      .withContext('requests≠pageviews distinction is spelled out')
      .toContain('One page view is many requests');
    expect(text).withContext('CWV honesty: never a fake 0').toContain('never a fabricated 0');
    expect(text).withContext('CWV is Chromium-only field data').toContain('Chromium-only');
    expect(text).withContext('edge data is sampled, not exact').toContain('adaptive-sampled');
    // Visits is honestly defined as browsing sessions (per-tab), NOT whole-range unique people.
    expect(text).withContext('defines the Visits metric').toContain('Visits');
    expect(text)
      .withContext('visits ≠ unique people (honest disambiguation)')
      .toContain('unique people');
  });

  it('confirms the RUM source is the first-party beacon, NOT the Cloudflare Web Analytics beacon', () => {
    const { el } = setup();
    const text = el.textContent ?? '';
    // The prompt's explicit ask: a CNAME alone doesn't establish browser-measured metrics
    // are collected — so the owner must know WHICH beacon measures their RUM.
    expect(text).withContext('names our first-party beacon (app.js)').toContain('app.js');
    expect(text)
      .withContext('explicitly disclaims the Cloudflare Web Analytics beacon')
      .toContain('Cloudflare Web Analytics beacon');
    // The shipped page-load metrics (FCP/TTFB) are a distinct, every-browser entry.
    expect(text)
      .withContext('page-load speed entry present')
      .toContain('Page load speed (FCP · TTFB)');
    expect(text)
      .withContext('page-load timing is every-browser, unlike Chromium-only CWV')
      .toContain('Navigation Timing');
  });
});
