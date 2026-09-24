import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { WebVitalsCardComponent, type WebVitalsBlock } from './web-vitals-card.component';

/**
 * WebVitalsCardComponent — the honest CWV p75 card. The load-bearing property is
 * that a metric with no field samples renders "Measuring…" and NEVER a fabricated 0,
 * and that the card is labelled as Chromium-only field data.
 */
function render(webVitals: WebVitalsBlock | null, windowDays = 30) {
  TestBed.configureTestingModule({ imports: [WebVitalsCardComponent] });
  const fixture = TestBed.createComponent(WebVitalsCardComponent);
  fixture.componentRef.setInput('webVitals', webVitals);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return fixture;
}

describe('WebVitalsCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders three metric tiles (LCP / INP / CLS)', () => {
    const fixture = render({ lcp: { p75: 2372, samples: 12 }, inp: null, cls: { p75: 0.05, samples: 12 } });
    for (const key of ['lcp', 'inp', 'cls']) {
      expect(fixture.debugElement.query(By.css(`[data-testid="an-wv-${key}"]`)))
        .withContext(`${key} tile`)
        .toBeTruthy();
    }
  });

  it('renders a measured metric as p75 (seconds) + rating WORD + sample count', () => {
    const fixture = render({ lcp: { p75: 2372, samples: 12 }, inp: null, cls: null });
    const lcp = fixture.debugElement.query(By.css('[data-testid="an-wv-lcp"]')).nativeElement as HTMLElement;
    expect(lcp.textContent).toContain('2.37 s'); // 2372ms → seconds past 1s
    expect(lcp.textContent).toContain('Good'); // 2372 ≤ 2500 → good, shown as a WORD not colour
    expect(lcp.textContent).toContain('p75');
    expect(lcp.textContent).toContain('12 samples');
  });

  it('renders a metric with no samples as "Measuring…", NEVER a fabricated 0', () => {
    const fixture = render({ lcp: null, inp: null, cls: null });
    const inp = fixture.debugElement.query(By.css('[data-testid="an-wv-inp"]')).nativeElement as HTMLElement;
    expect(inp.textContent).toContain('Measuring — no samples yet');
    expect(inp.textContent).toContain('—');
    expect(inp.textContent).not.toContain('0 ms');
    expect(inp.textContent).not.toContain('Good');
  });

  it('shows the honest "no field data yet" note only when EVERY metric is empty', () => {
    const empty = render({ lcp: null, inp: null, cls: null });
    expect(empty.debugElement.query(By.css('[data-testid="an-wv-note"]'))).withContext('all-null → note').toBeTruthy();

    TestBed.resetTestingModule(); // second render in one spec needs a fresh module
    const partial = render({ lcp: { p75: 2000, samples: 3 }, inp: null, cls: null });
    expect(partial.debugElement.query(By.css('[data-testid="an-wv-note"]'))).withContext('some data → no note').toBeNull();
  });

  it('labels the source as Chromium-only field data over the window', () => {
    const fixture = render({ lcp: null, inp: null, cls: null }, 7);
    const src = fixture.debugElement.query(By.css('[data-testid="an-wv-source"]')).nativeElement as HTMLElement;
    expect(src.textContent).toContain('field data');
    expect(src.textContent).toContain('Chrome');
    expect(src.textContent).toContain('last 7 days');
  });

  it('handles a null/undefined webVitals block (all tiles measuring, note shown)', () => {
    const fixture = render(null);
    expect(fixture.componentInstance.hasAnySamples()).toBeFalse();
    expect(fixture.debugElement.query(By.css('[data-testid="an-wv-note"]'))).toBeTruthy();
  });

  it('renders a "slowest pages" drilldown (worst first) when per-path data is present', () => {
    const fixture = render({
      lcp: { p75: 3000, samples: 20 },
      inp: null,
      cls: null,
      slowestPages: [
        { path: '/pricing', lcpP75: 4200, samples: 8 },
        { path: '/', lcpP75: 2100, samples: 12 },
      ],
    });
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-wv-page"]'));
    expect(rows.length).toBe(2);
    const first = rows[0].nativeElement as HTMLElement;
    expect(first.textContent).toContain('/pricing');
    expect(first.textContent).toContain('4.20 s'); // 4200ms → seconds
    expect(first.textContent).toContain('Poor'); // 4200 > 4000 → poor
    expect(first.textContent).toContain('8 samples');
  });

  it('hides the slowest-pages drilldown when no page has enough samples', () => {
    const fixture = render({ lcp: { p75: 3000, samples: 4 }, inp: null, cls: null, slowestPages: [] });
    expect(fixture.debugElement.query(By.css('[data-testid="an-wv-pages"]'))).toBeNull();
  });

  describe('formatValue', () => {
    it('shows CLS unitless, LCP/INP in ms under 1s and seconds at/over 1s', () => {
      const c = render(null).componentInstance;
      expect(c.formatValue('cls', 0.08)).toBe('0.08');
      expect(c.formatValue('cls', 0)).toBe('0.00');
      expect(c.formatValue('inp', 150)).toBe('150 ms');
      expect(c.formatValue('lcp', 800)).toBe('800 ms');
      expect(c.formatValue('lcp', 2372)).toBe('2.37 s');
    });
  });

  describe('rating (Google thresholds)', () => {
    it('classifies each metric by its own good/needs/poor boundaries', () => {
      const c = render(null).componentInstance;
      expect(c.rating('lcp', 2500)).toBe('good');
      expect(c.rating('lcp', 4000)).toBe('needs');
      expect(c.rating('lcp', 4001)).toBe('poor');
      expect(c.rating('inp', 200)).toBe('good');
      expect(c.rating('inp', 500)).toBe('needs');
      expect(c.rating('inp', 501)).toBe('poor');
      expect(c.rating('cls', 0.1)).toBe('good');
      expect(c.rating('cls', 0.25)).toBe('needs');
      expect(c.rating('cls', 0.26)).toBe('poor');
    });
  });
});
