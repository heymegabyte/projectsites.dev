import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import {
  ReferrerDomainsComponent,
  type ReferrerDomainsResponse,
} from './referrer-domains.component';
import { ApiService } from '../../../services/api.service';

/**
 * ReferrerDomainsComponent — top EXTERNAL referring domains. Load-bearing invariants:
 * - renders the domain rows + counts from the API response,
 * - honest empty state when there are no external referrers (never fake bars),
 * - `capped` disclosure renders only when the server flagged a long-tail cap,
 * - self-fetches with days + tz; threads the drilldown filter when active,
 * - does NOT fetch without a selected site; error → error state only.
 */

const LIVE: ReferrerDomainsResponse = {
  domains: [
    { label: 'news.ycombinator.com', count: 20 },
    { label: 'reddit.com', count: 8 },
  ],
  capped: false,
};

function render(
  resp: ReferrerDomainsResponse | null,
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
    imports: [ReferrerDomainsComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(ReferrerDomainsComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.componentRef.setInput('activeFilter', activeFilter);
  fixture.detectChanges();
  return { fixture, get };
}

const rowsOf = (fixture: ReturnType<typeof render>['fixture']) =>
  fixture.debugElement.queryAll(By.css('[data-testid="referrer-domains-row"]'));

describe('ReferrerDomainsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the referring-domain rows + counts', () => {
    const { fixture } = render(LIVE);
    const rows = rowsOf(fixture);
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('news.ycombinator.com');
    expect(rows[0].nativeElement.textContent).toContain('20');
  });

  it('shows the honest empty state when there are no external referrers (never fake bars)', () => {
    const { fixture } = render({ domains: [], capped: false });
    expect(fixture.debugElement.query(By.css('[data-testid="rd-empty"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="rd-list"]'))).toBeNull();
  });

  it('hides the long-tail cap note when the server did NOT set capped', () => {
    expect(
      render(LIVE).fixture.debugElement.query(By.css('[data-testid="rd-capped"]')),
    ).toBeNull();
  });

  it('discloses the long-tail cap note when the server set capped', () => {
    const capped = render({ domains: [{ label: 'x.com', count: 3 }], capped: true });
    expect(capped.fixture.debugElement.query(By.css('[data-testid="rd-capped"]'))).toBeTruthy();
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the referrers route with the day window + a tz offset', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith(
      '/sites/site-xyz/analytics/referrers',
      jasmine.objectContaining({ days: '14', tz: jasmine.any(String) }),
    );
  });

  it('threads the active drilldown filter into the request', () => {
    const { get } = render(LIVE, 'site-xyz', 30, false, { dim: 'country', value: 'US' });
    expect(get).toHaveBeenCalledWith(
      '/sites/site-xyz/analytics/referrers',
      jasmine.objectContaining({ filterDim: 'country', filterValue: 'US' }),
    );
  });

  it('shows the error state when the API errors, never fabricated rows', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="rd-error"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="rd-list"]'))).toBeNull();
  });

  it('bar width scales to the top referrer, floored at 4%', () => {
    const c = render(LIVE).fixture.componentInstance;
    expect(c.barWidth(20)).toBe(100);
    expect(c.barWidth(8)).toBe(40);
    expect(c.barWidth(0)).toBe(0);
  });
});
