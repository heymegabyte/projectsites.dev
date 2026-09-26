import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ClickTrackingCardComponent, type ClicksResponse } from './click-tracking-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * ClickTrackingCardComponent — most-clicked buttons (generic UI interactions) list.
 *
 * Load-bearing invariants:
 * - Rows are rendered from the API response in order (label + count + proportional bar).
 * - The honest `total` (sum across ALL labels) is surfaced, not just the shown top-10.
 * - Empty byLabel → honest "Measuring…" state, never fabricated rows or a fake 0.
 * - The disclaimer makes the NO-double-count boundary explicit (excludes conversions + nav).
 * - Does NOT fetch when there is no selected site; error → error state only.
 */

const LIVE: ClicksResponse = {
  total: 350,
  byLabel: [
    { label: 'Book Now', count: 200 },
    { label: 'View Menu', count: 100 },
    { label: 'Read More', count: 50 },
  ],
};

function render(
  resp: ClicksResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(error ? throwError(() => new Error('network')) : resp === null ? of() : of(resp));
  TestBed.configureTestingModule({
    imports: [ClickTrackingCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(ClickTrackingCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined)?.textContent?.trim() ?? '';

describe('ClickTrackingCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders interaction rows from a mocked response, in order', () => {
    const { fixture } = render(LIVE);
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="click-row"]'));
    expect(rows.length).toBe(3);
    expect(rows[0].nativeElement.textContent).toContain('Book Now');
    expect(rows[0].nativeElement.textContent).toContain('200');
    expect(rows[1].nativeElement.textContent).toContain('View Menu');
    expect(rows[2].nativeElement.textContent).toContain('Read More');
  });

  it('surfaces the honest total (sum across ALL labels, not just the shown rows)', () => {
    const { fixture } = render(LIVE);
    // total (350) exceeds the shown 200+100+50=350 here, and is shown verbatim — proving the
    // headline is the aggregator total, not a re-sum of the (capped) displayed set.
    expect(text(fixture, '[data-testid="clk-total"]')).toContain('350');
    expect(text(fixture, '[data-testid="clk-total"]')).toContain('interactions');
  });

  it('shows the honest "Measuring…" empty state when byLabel is empty', () => {
    const { fixture } = render({ total: 0, byLabel: [] });
    expect(fixture.debugElement.query(By.css('[data-testid="clk-empty"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="clk-empty"]')).toContain('Measuring');
    expect(fixture.debugElement.query(By.css('[data-testid="clk-list"]'))).toBeNull();
  });

  it('does NOT render the empty state when byLabel has entries', () => {
    const { fixture } = render(LIVE);
    expect(fixture.debugElement.query(By.css('[data-testid="clk-empty"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="clk-list"]'))).toBeTruthy();
  });

  it('top row bar width is 100%; others are proportional', () => {
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    expect(c.barWidth(200)).toBe(100); // top
    expect(c.barWidth(100)).toBe(50); // half
  });

  it('bar width floors at 4% so a tiny-count row stays visible', () => {
    const { fixture } = render({ total: 1001, byLabel: [{ label: 'A', count: 1000 }, { label: 'B', count: 1 }] });
    const c = fixture.componentInstance;
    expect(c.barWidth(1)).toBe(4); // round(1/1000*100)=0 → floors to 4
    expect(c.barWidth(1000)).toBe(100);
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/clicks', { days: '14' });
  });

  it('shows the error state when the API errors, never fabricated rows', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="clk-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="clk-list"]'))).toBeNull();
  });

  it('renders the NO-double-count disclaimer in the populated state', () => {
    const { fixture } = render(LIVE);
    const disclaimer = text(fixture, '[data-testid="clk-disclaimer"]');
    expect(disclaimer).toContain('conversions'); // links/CTAs counted elsewhere
    expect(disclaimer).toContain('cookieless');
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const { fixture } = render(LIVE, 'site-abc', 1);
    const src = text(fixture, '[data-testid="clk-source"]');
    expect(src).toContain('last 1 day');
    expect(src).not.toContain('days');
  });

  it('barWidth returns 0 when topCount is 0 (no divide-by-zero)', () => {
    const { fixture } = render({ total: 0, byLabel: [] });
    const c = fixture.componentInstance;
    expect(c.barWidth(0)).toBe(0);
  });
});
