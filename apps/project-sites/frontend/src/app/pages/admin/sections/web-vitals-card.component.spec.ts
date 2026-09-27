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

  it('shows per-page INP + CLS p75 (the full CWV picture) and "—" when a metric is absent', () => {
    const fixture = render({
      lcp: { p75: 3000, samples: 20 },
      inp: null,
      cls: null,
      slowestPages: [
        { path: '/pricing', lcpP75: 4200, inpP75: 250, clsP75: 0.15, samples: 8 },
        { path: '/', lcpP75: 2100, samples: 12 }, // LCP only — no INP/CLS samples
      ],
    });
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-wv-page"]'));
    const inp1 = rows[0].query(By.css('[data-testid="an-wv-page-inp"]')).nativeElement as HTMLElement;
    const cls1 = rows[0].query(By.css('[data-testid="an-wv-page-cls"]')).nativeElement as HTMLElement;
    expect(inp1.textContent).toContain('250'); // INP p75 (ms)
    expect(cls1.textContent).toContain('0.15'); // CLS p75
    // The page with no INP/CLS samples shows "—", never a fabricated 0.
    const inp2 = rows[1].query(By.css('[data-testid="an-wv-page-inp"]')).nativeElement as HTMLElement;
    expect(inp2.textContent).toContain('—');
  });

  it('shows per-page FCP + TTFB p75 (page-load timing) and "—" when absent', () => {
    const fixture = render({
      lcp: { p75: 3000, samples: 20 },
      inp: null,
      cls: null,
      slowestPages: [
        { path: '/pricing', lcpP75: 4200, fcpP75: 1800, ttfbP75: 650, samples: 8 },
        { path: '/', lcpP75: 2100, samples: 12 }, // LCP only — no FCP/TTFB samples
      ],
    });
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="an-wv-page"]'));
    const fcp1 = rows[0].query(By.css('[data-testid="an-wv-page-fcp"]')).nativeElement as HTMLElement;
    const ttfb1 = rows[0].query(By.css('[data-testid="an-wv-page-ttfb"]')).nativeElement as HTMLElement;
    expect(fcp1.textContent).toContain('1.8'); // 1800ms → "1.8 s" via plFormat
    expect(ttfb1.textContent).toContain('650'); // 650ms → "650 ms"
    // The page with no FCP/TTFB samples shows "—", never a fabricated 0.
    const fcp2 = rows[1].query(By.css('[data-testid="an-wv-page-fcp"]')).nativeElement as HTMLElement;
    const ttfb2 = rows[1].query(By.css('[data-testid="an-wv-page-ttfb"]')).nativeElement as HTMLElement;
    expect(fcp2.textContent).toContain('—');
    expect(ttfb2.textContent).toContain('—');
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

  describe('rating distribution (good/needs/poor spread)', () => {
    it('renders the distribution bar + percentage legend when a metric carries dist', () => {
      const fixture = render({
        lcp: { p75: 3000, samples: 10, dist: { good: 7, needs: 2, poor: 1 } },
        inp: null,
        cls: null,
      });
      const dist = fixture.debugElement.query(By.css('[data-testid="an-wv-lcp-dist"]'));
      expect(dist).withContext('dist bar renders when present').toBeTruthy();
      const el = dist.nativeElement as HTMLElement;
      expect(el.textContent).toContain('70%'); // good
      expect(el.textContent).toContain('20%'); // needs
      expect(el.textContent).toContain('10%'); // poor
      // Exact counts in the accessible label (percentages can round; counts never lie).
      expect(el.getAttribute('aria-label')).toBe('Distribution: 7 good, 2 needs improvement, 1 poor');
    });

    it('does NOT render a distribution bar when the stat omits dist (older payload)', () => {
      const fixture = render({ lcp: { p75: 3000, samples: 10 }, inp: null, cls: null });
      expect(fixture.debugElement.query(By.css('[data-testid="an-wv-lcp-dist"]'))).toBeNull();
    });

    it('pct rounds to a whole percent and never divides by zero', () => {
      const c = render(null).componentInstance;
      expect(c.pct(7, 10)).toBe(70);
      expect(c.pct(1, 3)).toBe(33);
      expect(c.pct(5, 0)).toBe(0); // no samples → 0, never NaN
    });
  });

  describe('page-load speed (TTFB + FCP)', () => {
    it('renders the page-load section with TTFB + FCP values and ratings when samples exist', () => {
      const el = render({
        lcp: null,
        inp: null,
        cls: null,
        ttfb: { p75: 420, samples: 30, dist: { good: 25, needs: 4, poor: 1 } },
        fcp: { p75: 1600, samples: 30, dist: { good: 20, needs: 8, poor: 2 } },
      }).nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="an-wv-pageload"]')).withContext('renders when TTFB/FCP have samples').toBeTruthy();
      expect((el.querySelector('[data-testid="an-wv-ttfb-value"]') as HTMLElement).textContent).toContain('420 ms');
      expect((el.querySelector('[data-testid="an-wv-fcp-value"]') as HTMLElement).textContent).toContain('1.60 s');
      // TTFB 420 ≤ 800 → good (its OWN threshold, not the CWV LCP threshold)
      expect((el.querySelector('[data-testid="an-wv-ttfb"]') as HTMLElement).getAttribute('data-rating')).toBe('good');
      expect((el.querySelector('[data-testid="an-wv-fcp"]') as HTMLElement).getAttribute('data-rating')).toBe('good');
    });

    it('hides the page-load section when TTFB + FCP have no samples (never a fabricated 0)', () => {
      const el = render({ lcp: { p75: 2000, samples: 5 }, inp: null, cls: null }).nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="an-wv-pageload"]')).toBeNull();
    });

    it('plRating uses the page-load thresholds (distinct from CWV) and plFormat renders ms/s', () => {
      const c = render(null).componentInstance;
      expect(c.plRating('ttfb', 700)).toBe('good'); // ≤800
      expect(c.plRating('ttfb', 1200)).toBe('needs'); // ≤1800
      expect(c.plRating('ttfb', 2000)).toBe('poor');
      expect(c.plRating('fcp', 1800)).toBe('good'); // boundary
      expect(c.plRating('fcp', 3500)).toBe('poor');
      expect(c.plFormat(420)).toBe('420 ms');
      expect(c.plFormat(1600)).toBe('1.60 s');
    });
  });
});
