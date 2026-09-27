import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import {
  SessionDurationCardComponent,
  type SessionDurationResponse,
} from './session-duration-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * SessionDurationCardComponent — how long a whole visit lasts (SUM of per-page dwell per tab-session).
 *
 * Load-bearing invariants:
 * - Median headline + avg/longest/sessions secondary stats render from the API response.
 * - The ≥30s/≥1m/≥3m/≥5m distribution renders 4 rows; bar width is a % of all sessions (floor 2%).
 * - `sessions: 0` → honest "Measuring session length…", never a fabricated 0-duration.
 * - The one-line disclaimer (one tab's visit; distinct from time-on-page) is always in the populated state.
 * - Does NOT fetch when there is no selected site; error → error state only, no stats.
 * - `formatMs` renders human durations (Xs / Ym / Ym Zs), null → "—".
 */

const LIVE: SessionDurationResponse = {
  sessions: 40,
  medianMs: 90_000,
  avgMs: 120_000,
  maxMs: 400_000,
  distribution: { s30: 30, s60: 20, s180: 8, s300: 3 },
};

function render(
  resp: SessionDurationResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(
      error ? throwError(() => new Error('network')) : resp === null ? of() : of(resp),
    );
  TestBed.configureTestingModule({
    imports: [SessionDurationCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(SessionDurationCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (
    fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined
  )?.textContent?.trim() ?? '';

describe('SessionDurationCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the median headline + avg/longest/sessions from a mocked response', () => {
    const { fixture } = render(LIVE);
    expect(text(fixture, '[data-testid="sd-median"]')).toBe('1m 30s'); // 90_000ms
    expect(text(fixture, '[data-testid="sd-avg"]')).toBe('2m'); // 120_000ms
    expect(text(fixture, '[data-testid="sd-max"]')).toBe('6m 40s'); // 400_000ms
    expect(text(fixture, '[data-testid="sd-sessions"]')).toBe('40');
  });

  it('renders the four distribution buckets with counts', () => {
    const { fixture } = render(LIVE);
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="sd-bucket"]'));
    expect(rows.length).toBe(4);
    expect(rows[0].nativeElement.textContent).toContain('≥ 30s');
    expect(rows[0].nativeElement.textContent).toContain('30');
    expect(rows[3].nativeElement.textContent).toContain('≥ 5m');
    expect(rows[3].nativeElement.textContent).toContain('3');
  });

  it('shows the honest empty state when there are no sessions (never a fabricated 0)', () => {
    const { fixture } = render({
      sessions: 0,
      medianMs: null,
      avgMs: null,
      maxMs: null,
      distribution: { s30: 0, s60: 0, s180: 0, s300: 0 },
    });
    expect(fixture.debugElement.query(By.css('[data-testid="sd-empty"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="sd-empty"]')).toContain('Measuring session length');
    expect(fixture.debugElement.query(By.css('[data-testid="sd-stats"]'))).toBeNull();
  });

  it('does NOT render the empty state when sessions > 0', () => {
    const { fixture } = render(LIVE);
    expect(fixture.debugElement.query(By.css('[data-testid="sd-empty"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="sd-stats"]'))).toBeTruthy();
  });

  it('bar width is a % of all sessions, floored at 2% for a tiny bucket', () => {
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    expect(c.barPct(20)).toBe(50); // 20/40
    expect(c.barPct(1)).toBe(3); // 1/40 = 2.5 → round 3
    expect(c.barPct(0)).toBe(0); // no fabricated bar
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/session-duration', { days: '14' });
  });

  it('shows the error state when the API errors, never fabricated stats', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="sd-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="sd-stats"]'))).toBeNull();
  });

  it('renders the honest disclaimer (one tab visit; distinct from time-on-page) when populated', () => {
    const disclaimer = text(render(LIVE).fixture, '[data-testid="sd-disclaimer"]');
    expect(disclaimer).toContain("one browser tab's visit");
    expect(disclaimer).toContain('cookieless');
    expect(disclaimer).toContain('time-on-page');
  });

  it('includes the window length in the freshness label', () => {
    expect(text(render(LIVE, 'site-abc', 7).fixture, '[data-testid="sd-source"]')).toContain(
      'last 7 days',
    );
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const src = text(render(LIVE, 'site-abc', 1).fixture, '[data-testid="sd-source"]');
    expect(src).toContain('last 1 day');
    expect(src).not.toContain('days');
  });

  it('formatMs renders human durations; null → em-dash', () => {
    const c = render(LIVE).fixture.componentInstance;
    expect(c.formatMs(45_000)).toBe('45s');
    expect(c.formatMs(60_000)).toBe('1m');
    expect(c.formatMs(150_000)).toBe('2m 30s');
    expect(c.formatMs(null)).toBe('—');
    expect(c.formatMs(-5)).toBe('—');
  });
});
