import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import {
  WeekdayBreakdownComponent,
  densifyWeekdays,
  type WeekdayResponse,
} from './weekday-breakdown.component';
import { ApiService } from '../../../services/api.service';

/**
 * WeekdayBreakdownComponent — pageviews by day-of-week (0=Sun…6=Sat), bucketed owner-local
 * SERVER-SIDE. Load-bearing invariants:
 * - Busiest-day headline + 7 bars render from the API response; peak highlighted.
 * - All-zero window → honest empty state, never fake bars.
 * - `tzApplied:false` → "UTC" basis label (never claims local precision the server didn't compute).
 * - Self-fetches with days + tz; threads the drilldown filter when active.
 * - Does NOT fetch without a selected site; error → error state only.
 */

const LIVE: WeekdayResponse = {
  byWeekday: [
    { weekday: 0, count: 5 },
    { weekday: 3, count: 12 },
    { weekday: 6, count: 20 }, // Saturday busiest
  ],
  tzApplied: true,
};

function render(
  resp: WeekdayResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
  activeFilter: { dim: string; value: string } | null = null,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(
      error ? throwError(() => new Error('network')) : resp === null ? of() : of(resp),
    );
  TestBed.configureTestingModule({
    imports: [WeekdayBreakdownComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(WeekdayBreakdownComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.componentRef.setInput('activeFilter', activeFilter);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (
    fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined
  )?.textContent?.trim() ?? '';

describe('densifyWeekdays', () => {
  it('produces a dense 7-slot Sun→Sat array, missing weekdays as 0', () => {
    const out = densifyWeekdays([{ weekday: 6, count: 12 }]);
    expect(out.length).toBe(7);
    expect(out[6]).toEqual({ weekday: 6, count: 12 });
    expect(out[0]).toEqual({ weekday: 0, count: 0 });
  });
  it('sums duplicates and drops out-of-range weekdays (never a fabricated bucket)', () => {
    const out = densifyWeekdays([
      { weekday: 2, count: 3 },
      { weekday: 2, count: 4 },
      { weekday: 9, count: 99 },
    ]);
    expect(out[2].count).toBe(7);
    expect(out.every((b) => b.weekday >= 0 && b.weekday <= 6)).toBe(true);
  });
});

describe('WeekdayBreakdownComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the busiest-day headline + 7 bars from a mocked response', () => {
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="an-weekday-peak"]')).toContain('Saturday');
    expect(text(fixture, '[data-testid="an-weekday-peak"]')).toContain('20');
    expect(fixture.debugElement.queryAll(By.css('.wb-col')).length).toBe(7);
  });

  it('shows the honest empty state when every weekday is zero (never fake bars)', () => {
    const { fixture } = render({ byWeekday: [], tzApplied: true });
    expect(fixture.debugElement.query(By.css('[data-testid="an-weekday-empty"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('.wb-bars'))).toBeNull();
  });

  it('labels the basis UTC when the server did NOT apply a tz offset (honest)', () => {
    const utc = render({ byWeekday: [{ weekday: 1, count: 4 }], tzApplied: false });
    expect(text(utc.fixture, '[data-testid="an-weekday-note"]')).toContain('UTC');
  });

  it('labels the basis "your local time" when the server applied a tz offset', () => {
    const local = render(LIVE);
    expect(text(local.fixture, '[data-testid="an-weekday-note"]')).toContain('your local time');
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the weekday route with the day window + a tz offset', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith(
      '/sites/site-xyz/analytics/weekday',
      jasmine.objectContaining({ days: '14', tz: jasmine.any(String) }),
    );
  });

  it('threads the active drilldown filter into the request', () => {
    const { get } = render(LIVE, 'site-xyz', 30, false, { dim: 'country', value: 'US' });
    expect(get).toHaveBeenCalledWith(
      '/sites/site-xyz/analytics/weekday',
      jasmine.objectContaining({ filterDim: 'country', filterValue: 'US' }),
    );
  });

  it('shows the error state when the API errors, never fabricated bars', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="an-weekday-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('.wb-bars'))).toBeNull();
  });

  it('bar height is a % of the busiest day, floored at 2% for a tiny non-zero day', () => {
    const c = render(LIVE).fixture.componentInstance;
    expect(c.barPct(20)).toBe(100); // the peak
    expect(c.barPct(1)).toBe(5); // 1/20 = 5%
    expect(c.barPct(0)).toBe(0); // no fabricated bar
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const note = text(render(LIVE, 'site-abc', 1).fixture, '[data-testid="an-weekday-note"]');
    expect(note).toContain('last 1 day');
    expect(note).not.toContain('days');
  });
});
