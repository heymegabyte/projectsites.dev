import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ConciergeCardComponent, type ConciergeResponse } from './concierge-card.component';
import { ApiService } from '../../../services/api.service';

/**
 * ConciergeCardComponent — AI concierge engagement. Load-bearing invariant: the card SELF-HIDES
 * (renders nothing) when there are no opens — during loading, on error, and on a genuine 0 — so the
 * dashboard never shows a permanently-empty card for sites whose visitors don't use the assistant.
 */

const LIVE: ConciergeResponse = {
  opens: 40,
  messages: 92,
  uniqueVisitors: 31,
  messagesPerOpen: 2.3,
};

function render(
  resp: ConciergeResponse | null,
  siteId: string | null = 'site-abc',
  windowDays = 30,
  error = false,
) {
  const get = jasmine
    .createSpy('get')
    .and.returnValue(error ? throwError(() => new Error('x')) : resp === null ? of() : of(resp));
  TestBed.configureTestingModule({
    imports: [ConciergeCardComponent],
    providers: [{ provide: ApiService, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(ConciergeCardComponent);
  fixture.componentRef.setInput('siteId', siteId);
  fixture.componentRef.setInput('windowDays', windowDays);
  fixture.detectChanges();
  return { fixture, get };
}

const text = (fixture: ReturnType<typeof render>['fixture'], sel: string): string =>
  (
    fixture.debugElement.query(By.css(sel))?.nativeElement as HTMLElement | undefined
  )?.textContent?.trim() ?? '';

describe('ConciergeCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders opens/messages/visitors/rate when there is activity', () => {
    const { fixture } = render(LIVE);
    expect(fixture.debugElement.query(By.css('[data-testid="concierge-card"]'))).toBeTruthy();
    expect(text(fixture, '[data-testid="cc-opens"]')).toBe('40');
    expect(text(fixture, '[data-testid="cc-messages"]')).toBe('92');
    expect(text(fixture, '[data-testid="cc-visitors"]')).toBe('31');
    expect(text(fixture, '[data-testid="cc-rate"]')).toBe('2.3');
  });

  it('SELF-HIDES (renders nothing) when opens === 0 — no empty-card clutter', () => {
    const { fixture } = render({ opens: 0, messages: 0, uniqueVisitors: 0, messagesPerOpen: null });
    expect(fixture.debugElement.query(By.css('[data-testid="concierge-card"]'))).toBeNull();
  });

  it('self-hides on an API error (never a fabricated engagement)', () => {
    const { fixture } = render(LIVE, 'site-abc', 30, true);
    expect(fixture.debugElement.query(By.css('[data-testid="concierge-card"]'))).toBeNull();
  });

  it('does NOT fetch when there is no selected site', () => {
    const { get } = render(LIVE, null);
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the correct route with the day window as a query param', () => {
    const { get } = render(LIVE, 'site-xyz', 14);
    expect(get).toHaveBeenCalledWith('/sites/site-xyz/analytics/concierge', { days: '14' });
  });

  it('renders the honest first-party disclaimer + freshness label', () => {
    const { fixture } = render(LIVE, 'site-abc', 7);
    expect(text(fixture, '[data-testid="cc-source"]')).toContain('last 7 days');
    expect(text(fixture, '[data-testid="cc-disclaimer"]')).toContain('first-party');
  });
});
