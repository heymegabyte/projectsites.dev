import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { EntryPagesCardComponent, type EntryPagesResponse } from './entry-pages-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * EntryPagesCardComponent — top landing pages (entry-page) list.
 *
 * Load-bearing invariants:
 * - Rows are rendered from the API response in order.
 * - Top row bar width is always 100%; others are proportional.
 * - Empty pages array → honest empty state ("No landing-page data yet."), never fabricated rows.
 * - The one-line disclaimer is always present in the populated state.
 * - Does NOT fetch when there is no selected site.
 * - Error → error state only, no rows rendered.
 */

const LIVE: EntryPagesResponse = {
  pages: [
    { path: '/', count: 200 },
    { path: '/about', count: 100 },
    { path: '/contact', count: 50 },
  ],
};

function render(
  resp: EntryPagesResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(error ? throwError(() => new Error('network')) : resp === null ? of() : of(resp));
  TestBed.configureTestingModule({
    imports: [EntryPagesCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(EntryPagesCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined)?.textContent?.trim() ?? '';

describe('EntryPagesCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders rows from a mocked response', () => {
    const { fixture } = render(LIVE);
    const rows = fixture.debugElement.queryAll(By.css('[data-testid="entry-pages-row"]'));
    expect(rows.length).toBe(3);
    expect(rows[0].nativeElement.textContent).toContain('/');
    expect(rows[0].nativeElement.textContent).toContain('200');
    expect(rows[1].nativeElement.textContent).toContain('/about');
    expect(rows[2].nativeElement.textContent).toContain('/contact');
  });

  it('shows the honest empty state when pages is empty', () => {
    const { fixture } = render({ pages: [] });
    expect(fixture.debugElement.query(By.css('[data-testid="ep-empty"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="ep-empty"]')).toContain('No landing-page data yet.');
    // The list must NOT render in the empty state
    expect(fixture.debugElement.query(By.css('[data-testid="ep-list"]'))).toBeNull();
  });

  it('does NOT render the empty state when pages has entries', () => {
    const { fixture } = render(LIVE);
    expect(fixture.debugElement.query(By.css('[data-testid="ep-empty"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="ep-list"]'))).toBeTruthy();
  });

  it('top row bar width is 100%', () => {
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    // top count = 200; barWidth(200) = round(200/200*100) = 100
    expect(c.barWidth(200)).toBe(100);
  });

  it('second row bar width is proportional to the top count', () => {
    const { fixture } = render(LIVE);
    const c = fixture.componentInstance;
    // barWidth(100) = round(100/200*100) = 50
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
    // barWidth(1) = round(1/1000*100) = 0 → floors to 4
    expect(c.barWidth(1)).toBe(4);
    expect(c.barWidth(1000)).toBe(100);
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/entry-pages', { days: '14' });
  });

  it('shows the error state when the API errors, never fabricated rows', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="ep-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="ep-list"]'))).toBeNull();
  });

  it('renders the honest disclaimer in the populated state', () => {
    const { fixture } = render(LIVE);
    const disclaimer = text(fixture, '[data-testid="ep-disclaimer"]');
    expect(disclaimer).toContain("session's first page");
    expect(disclaimer).toContain('tab-scoped');
    expect(disclaimer).toContain('cookieless');
  });

  it('includes the window length in the freshness label', () => {
    const { fixture } = render(LIVE, 'site-abc', 7);
    expect(text(fixture, '[data-testid="ep-source"]')).toContain('last 7 days');
  });

  it('pluralises "day" correctly for a single-day window', () => {
    const { fixture } = render(LIVE, 'site-abc', 1);
    const src = text(fixture, '[data-testid="ep-source"]');
    expect(src).toContain('last 1 day');
    expect(src).not.toContain('days');
  });

  it('barWidth returns 0 when topCount is 0 (no divide-by-zero)', () => {
    const { fixture } = render({ pages: [] });
    const c = fixture.componentInstance;
    expect(c.barWidth(0)).toBe(0);
  });
});
