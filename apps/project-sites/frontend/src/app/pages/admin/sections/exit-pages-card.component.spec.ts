import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ExitPagesCardComponent, type ExitPagesResponse } from './exit-pages-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * ExitPagesCardComponent — top exit pages (the session's LAST page) list; complement to entry pages.
 *
 * Load-bearing invariants:
 * - Rows are rendered from the API response in order.
 * - Top row bar width is always 100%; others are proportional.
 * - Empty pages array → honest empty state ("No exit-page data yet."), never fabricated rows.
 * - The one-line disclaimer is always present in the populated state.
 * - Does NOT fetch when there is no selected site.
 * - Error → error state only, no rows rendered.
 */

const LIVE: ExitPagesResponse = {
  pages: [
    { path: '/contact', count: 200 },
    { path: '/pricing', count: 100 },
    { path: '/', count: 50 },
  ],
};

function render(
  resp: ExitPagesResponse | null,
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
    imports: [ExitPagesCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(ExitPagesCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (
    fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined
  )?.textContent?.trim() ?? '';

describe('ExitPagesCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders rows from a mocked response', () => {
    const { fixture } = render(LIVE);
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="exit-pages-row"]'));
    expect(rows.length).toBe(3);
    expect(rows[0].nativeElement.textContent).toContain('/contact');
    expect(rows[0].nativeElement.textContent).toContain('200');
    expect(rows[1].nativeElement.textContent).toContain('/pricing');
    expect(rows[2].nativeElement.textContent).toContain('/');
  });

  it('shows the honest empty state when pages is empty', () => {
    const { fixture } = render({ pages: [] });
    expect(fixture.debugElement.query(By.css('[data-testid="xp-empty"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="xp-empty"]')).toContain('No exit-page data yet.');
    expect(fixture.debugElement.query(By.css('[data-testid="xp-list"]'))).toBeNull();
  });

  it('does NOT render the empty state when pages has entries', () => {
    const { fixture } = render(LIVE);
    expect(fixture.debugElement.query(By.css('[data-testid="xp-empty"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="xp-list"]'))).toBeTruthy();
  });

  it('top row bar width is 100%; second is proportional', () => {
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    expect(c.barWidth(200)).toBe(100);
    expect(c.barWidth(100)).toBe(50);
  });

  it('bar width floors at 4% so a tiny-count row stays visible', () => {
    const { fixture } = render({
      pages: [
        { path: '/', count: 1000 },
        { path: '/rare', count: 1 },
      ],
    });
    const c = fixture.componentInstance;
    expect(c.barWidth(1)).toBe(4);
    expect(c.barWidth(1000)).toBe(100);
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/exit-pages', { days: '14' });
  });

  it('shows the error state when the API errors, never fabricated rows', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="xp-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="xp-list"]'))).toBeNull();
  });

  it('renders the honest disclaimer (last page, tab-scoped, cookieless) in the populated state', () => {
    const { fixture } = render(LIVE);
    const disclaimer = text(fixture, '[data-testid="xp-disclaimer"]');
    expect(disclaimer).toContain("session's last page");
    expect(disclaimer).toContain('tab-scoped');
    expect(disclaimer).toContain('cookieless');
  });

  it('includes the window length in the freshness label', () => {
    expect(text(render(LIVE, 'site-abc', 7).fixture, '[data-testid="xp-source"]')).toContain(
      'last 7 days',
    );
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const src = text(render(LIVE, 'site-abc', 1).fixture, '[data-testid="xp-source"]');
    expect(src).toContain('last 1 day');
    expect(src).not.toContain('days');
  });

  it('barWidth returns 0 when topCount is 0 (no divide-by-zero)', () => {
    const c = render({ pages: [] }).fixture.componentInstance;
    expect(c.barWidth(0)).toBe(0);
  });
});
