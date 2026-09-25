import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { VisitorTypeCardComponent, type VisitorTypeResponse } from './visitor-type-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * VisitorTypeCardComponent — the new-vs-returning loyalty split.
 *
 * Load-bearing invariants:
 * - Percentages use `new + returning` as denominator (unknown excluded).
 * - Unknown footnote visible ONLY when `unknownVisits > 0`.
 * - All-zero → honest empty state ("No engagement data yet."), never fabricated 0s.
 * - The one-line disclaimer is always present in the populated state.
 * - Does NOT fetch when there is no selected site.
 * - Bar widths scale to the LARGER of the two buckets (4% floor).
 */

const LIVE: VisitorTypeResponse = {
  newVisits: 120,
  returningVisits: 30,
  unknownVisits: 5,
};

function render(
  resp: VisitorTypeResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(error ? throwError(() => new Error('network')) : resp === null ? of() : of(resp));
  TestBed.configureTestingModule({
    imports: [VisitorTypeCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(VisitorTypeCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined)?.textContent?.trim() ?? '';

describe('VisitorTypeCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders new and returning counts from the mocked response', () => {
    const { fixture } = render(LIVE);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="vt-count-new"]')!.textContent).toContain('120');
    expect(host.querySelector('[data-testid="vt-count-returning"]')!.textContent).toContain('30');
  });

  it('computes percentage denominator as new + returning (excludes unknown)', () => {
    // 120 new + 30 returning = 150 denominator (unknown 5 excluded)
    // new: round(120/150*100) = 80%, returning: round(30/150*100) = 20%
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="vt-pct-new"]')).toContain('80%');
    expect(text(fixture, '[data-testid="vt-pct-returning"]')).toContain('20%');
  });

  it('pct sums to 100 for a 50/50 split', () => {
    const { fixture } = render({ newVisits: 50, returningVisits: 50, unknownVisits: 0 });
    const c = fixture.componentInstance;
    expect(c.newPct()).toBe(50);
    expect(c.returningPct()).toBe(50);
    expect(c.newPct() + c.returningPct()).toBe(100);
  });

  it('shows the unknown footnote only when unknownVisits > 0', () => {
    const { fixture: withUnknown } = render(LIVE); // unknownVisits: 5
    expect(withUnknown.debugElement.query(By.css('[data-testid="vt-unknown"]'))).toBeTruthy();
    expect(text(withUnknown, '[data-testid="vt-unknown"]')).toContain("5 visits couldn't be classified");

    TestBed.resetTestingModule();

    const { fixture: noUnknown } = render({ newVisits: 10, returningVisits: 5, unknownVisits: 0 });
    expect(noUnknown.debugElement.query(By.css('[data-testid="vt-unknown"]'))).toBeNull();
  });

  it('shows the honest empty state when all three counts are 0', () => {
    const { fixture } = render({ newVisits: 0, returningVisits: 0, unknownVisits: 0 });
    expect(fixture.debugElement.query(By.css('[data-testid="vt-empty"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="vt-empty"]')).toContain('No engagement data yet.');
    // The split must NOT render in the empty state
    expect(fixture.debugElement.query(By.css('[data-testid="vt-split"]'))).toBeNull();
  });

  it('does NOT render the empty state when any count is non-zero', () => {
    const { fixture } = render({ newVisits: 1, returningVisits: 0, unknownVisits: 0 });
    expect(fixture.debugElement.query(By.css('[data-testid="vt-empty"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="vt-split"]'))).toBeTruthy();
  });

  it('renders the honest one-line disclaimer in the populated state', () => {
    const { fixture } = render(LIVE);
    const disclaimer = text(fixture, '[data-testid="vt-disclaimer"]');
    expect(disclaimer).toContain("New = a browser's first-ever visit");
    expect(disclaimer).toContain('same browser only');
    expect(disclaimer).toContain('cleared storage counts as new');
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/visitors', { days: '14' });
  });

  it('shows the error state when the API errors, never a fabricated split', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="vt-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="vt-split"]'))).toBeNull();
  });

  it('bar widths scale to the LARGER bucket (100% on the larger, proportional on the smaller)', () => {
    // newVisits=120, returningVisits=30 → max=120
    // newBarWidth = round(120/120*100) = 100
    // returningBarWidth = max(4, round(30/120*100)) = 25
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    expect(c.newBarWidth()).toBe(100);
    expect(c.returningBarWidth()).toBe(25);
  });

  it('bar width floors at 4% so a tiny bar stays visible', () => {
    const { fixture } = render({ newVisits: 1000, returningVisits: 1, unknownVisits: 0 });
    const c = fixture.componentInstance;
    // returningBarWidth = round(1/1000 * 100) = 0 → floors to 4
    expect(c.returningBarWidth()).toBe(4);
    expect(c.newBarWidth()).toBe(100);
  });

  it('pct returns 0 when classified total is 0 (no divide-by-zero)', () => {
    const { fixture } = render({ newVisits: 0, returningVisits: 0, unknownVisits: 3 });
    const c = fixture.componentInstance;
    expect(c.newPct()).toBe(0);
    expect(c.returningPct()).toBe(0);
  });

  it('includes the window length in the freshness label', () => {
    const { fixture } = render(LIVE, 'site-abc', 7);
    expect(text(fixture, '[data-testid="vt-source"]')).toContain('last 7 days');
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const { fixture } = render(LIVE, 'site-abc', 1);
    const src = text(fixture, '[data-testid="vt-source"]');
    expect(src).toContain('last 1 day');
    expect(src).not.toContain('days');
  });
});
