import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TechBreakdownComponent, type TechCount } from './tech-breakdown.component';

/**
 * TechBreakdownComponent — the device / browser / OS audience split. Every count is a
 * real tracked pageview (from the user-agent enrichment); "unknown" is a real bucket,
 * and a site with no pageviews shows an explicit empty state, never a fabricated 0.
 */
function render(
  devices: TechCount[] = [],
  browsers: TechCount[] = [],
  os: TechCount[] = [],
  windowDays = 30,
) {
  TestBed.configureTestingModule({ imports: [TechBreakdownComponent] });
  const fixture = TestBed.createComponent(TechBreakdownComponent);
  fixture.componentRef.setInput('devices', devices);
  fixture.componentRef.setInput('browsers', browsers);
  fixture.componentRef.setInput('os', os);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return fixture;
}

describe('TechBreakdownComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders all three dimensions when each has data', () => {
    const fixture = render(
      [{ label: 'desktop', count: 40 }, { label: 'mobile', count: 25 }],
      [{ label: 'Chrome', count: 50 }, { label: 'Safari', count: 15 }],
      [{ label: 'Windows', count: 30 }, { label: 'iOS', count: 20 }],
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="an-tech-device"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-tech-browser"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-tech-os"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-tech-device"]')!.textContent).toContain('desktop');
    expect(host.querySelector('[data-testid="an-tech-browser"]')!.textContent).toContain('Chrome');
  });

  it('sorts each dimension by count desc, filters zero counts, and caps at 6', () => {
    const many: TechCount[] = [
      { label: 'a', count: 1 }, { label: 'b', count: 9 }, { label: 'c', count: 3 },
      { label: 'd', count: 7 }, { label: 'e', count: 5 }, { label: 'f', count: 8 },
      { label: 'g', count: 2 }, { label: 'zero', count: 0 },
    ];
    const c = render(many).componentInstance;
    const device = c.groups().find((g) => g.key === 'device')!;
    expect(device.rows.length).toBe(6); // capped (7 non-zero → top 6)
    // desc by count: b(9) f(8) d(7) e(5) c(3) g(2) [a(1) drops off], zero(0) filtered.
    expect(device.rows.map((r) => r.label)).toEqual(['b', 'f', 'd', 'e', 'c', 'g']);
  });

  it('renders ONLY the dimensions that have data (empty ones are omitted, not shown blank)', () => {
    const fixture = render([{ label: 'mobile', count: 5 }], [], []);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="an-tech-device"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="an-tech-browser"]')).toBeNull();
    expect(host.querySelector('[data-testid="an-tech-os"]')).toBeNull();
    // Has SOME data → not the all-empty note.
    expect(host.querySelector('[data-testid="an-tech-empty"]')).toBeNull();
  });

  it('shows the honest empty state when no dimension has data', () => {
    const fixture = render([], [], []);
    expect(fixture.debugElement.query(By.css('[data-testid="an-tech-empty"]'))).toBeTruthy();
    // Also true when every row is zero (never a 0-count breakdown).
    TestBed.resetTestingModule();
    const zero = render([{ label: 'mobile', count: 0 }]);
    expect(zero.debugElement.query(By.css('[data-testid="an-tech-empty"]'))).toBeTruthy();
  });

  it('scales bar width to the group max (min 4% so a small bar stays visible)', () => {
    const c = render().componentInstance;
    expect(c.barWidth(50, 50)).toBe(100);
    expect(c.barWidth(1, 100)).toBe(4); // 1% floors at 4
    expect(c.barWidth(25, 50)).toBe(50);
    expect(c.barWidth(5, 0)).toBe(0); // empty group → 0, never divide-by-zero
  });

  it('pct returns a row share of the FULL dimension total (0 when the total is 0)', () => {
    const c = render().componentInstance;
    expect(c.pct(68, 100)).toBe(68);
    expect(c.pct(1, 3)).toBe(33);
    expect(c.pct(5, 0)).toBe(0); // no total → 0, never divide-by-zero
  });

  it('renders each row share % of the full dimension total (not just the top-6)', () => {
    // 3 devices summing to 100 → mobile is 68% of all device-attributed pageviews.
    const host = render([
      { label: 'mobile', count: 68 },
      { label: 'desktop', count: 30 },
      { label: 'tablet', count: 2 },
    ]).nativeElement as HTMLElement;
    const deviceCol = host.querySelector('[data-testid="an-tech-device"]')!;
    expect(deviceCol.textContent).toContain('68%');
    expect(deviceCol.textContent).toContain('30%');
  });

  it('labels the window + names the source as first-party user-agent (never CWV-style Chromium-only)', () => {
    const fixture = render([{ label: 'mobile', count: 3 }], [], [], 7);
    const src = fixture.debugElement.query(By.css('[data-testid="an-tech-source"]')).nativeElement as HTMLElement;
    expect(src.textContent).toContain('last 7 days');
    expect(src.textContent).toContain("visitor's browser");
  });

  // ── Drilldown filter (AN-FILTER): each row is an accessible toggle button. ──
  it('emits drill {dim,value} when a row button is clicked', () => {
    const fixture = render(
      [{ label: 'desktop', count: 40 }, { label: 'mobile', count: 25 }],
      [{ label: 'Chrome', count: 50 }],
      [],
    );
    const c = fixture.componentInstance;
    let emitted: { dim: string; value: string } | undefined;
    c.drill.subscribe((e) => (emitted = e));
    const host = fixture.nativeElement as HTMLElement;
    const firstDeviceBtn = host.querySelector('[data-testid="an-tech-drill-device"]') as HTMLButtonElement;
    expect(firstDeviceBtn.tagName).toBe('BUTTON'); // a real button, keyboard-operable
    firstDeviceBtn.click();
    expect(emitted).toEqual({ dim: 'device', value: 'desktop' }); // top row by count
  });

  it('marks ONLY the row matching activeFilter aria-pressed=true', () => {
    const fixture = render([{ label: 'desktop', count: 40 }, { label: 'mobile', count: 25 }], [], []);
    fixture.componentRef.setInput('activeFilter', { dim: 'device', value: 'desktop' });
    fixture.detectChanges();
    const btns = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="an-tech-drill-device"]'),
    ) as HTMLButtonElement[];
    const pressed = btns.map((b) => b.getAttribute('aria-pressed'));
    expect(pressed).toContain('true');
    expect(pressed.filter((p) => p === 'true').length).toBe(1); // exactly the matching row
  });

  it('isActive matches only the same dimension AND value', () => {
    const fixture = render([{ label: 'desktop', count: 1 }]);
    fixture.componentRef.setInput('activeFilter', { dim: 'device', value: 'desktop' });
    fixture.detectChanges();
    const c = fixture.componentInstance;
    expect(c.isActive('device', 'desktop')).toBe(true);
    expect(c.isActive('device', 'mobile')).toBe(false); // same dim, different value
    expect(c.isActive('browser', 'desktop')).toBe(false); // same value, different dim
  });
});
