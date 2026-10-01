import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { ClaimCancelComponent, ClaimSuccessComponent } from './claim-return.component';

/**
 * Checkout return routes for the paid-claim funnel (claim_flow, fire-61).
 *
 *  - `/admin/claim/success` — celebratory confirm + "what unlocked" list + CTA
 *    into the claimed site's detail. Reads `?site=` + `?session_id=` and stays
 *    graceful when either is missing or malformed (unknown session ≠ error).
 *  - `/admin/claim/cancel` — calm, no-charge retry path back to the site.
 *
 * Both are deep-linkable standalone components (Stripe redirects land cold).
 */
function renderAs<T>(
  component: Type<T>,
  query: Record<string, string>,
): { host: HTMLElement; component: T } {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
      },
    ],
  });
  const fx = TestBed.createComponent(component);
  fx.detectChanges();
  return { host: fx.nativeElement as HTMLElement, component: fx.componentInstance };
}

describe('ClaimSuccessComponent (/admin/claim/success)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('celebrates, lists what unlocked, and CTAs into the claimed site detail', () => {
    const { host } = renderAs(ClaimSuccessComponent, { site: 'site-1', session_id: 'cs_test_abc123' });
    expect(host.querySelector('[data-testid="claim-success"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).withContext('celebratory headline').toContain('yours');
    const unlocks = host.querySelectorAll('[data-testid="claim-unlocks"] li');
    expect(unlocks.length).withContext('a real "what unlocked" list').toBeGreaterThanOrEqual(3);
    const cta = host.querySelector<HTMLAnchorElement>('[data-testid="claim-success-cta"]');
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute('href')).toContain('/admin/sites/site-1');
    // Known session → a quiet receipt reference line.
    expect(host.querySelector('[data-testid="claim-session-ref"]')?.textContent).toContain('cs_test_abc123');
  });

  it('handles an unknown/missing session gracefully — no error, generic reassurance, CTA to all sites', () => {
    const { host } = renderAs(ClaimSuccessComponent, {});
    const cta = host.querySelector<HTMLAnchorElement>('[data-testid="claim-success-cta"]');
    expect(cta?.getAttribute('href')).withContext('no site param → land on the sites grid').toContain('/admin/sites');
    expect(host.querySelector('[data-testid="claim-session-ref"]')).withContext('no fabricated receipt ref').toBeNull();
    expect(host.querySelector('[data-testid="claim-session-unknown"]')).withContext('graceful unknown-session copy').not.toBeNull();
  });

  it('rejects a malformed session_id (treated as unknown, never rendered back)', () => {
    const { host } = renderAs(ClaimSuccessComponent, { site: 'site-1', session_id: '<script>x</script>' });
    expect(host.querySelector('[data-testid="claim-session-ref"]')).withContext('weird session ids are not echoed').toBeNull();
    expect(host.querySelector('[data-testid="claim-session-unknown"]')).not.toBeNull();
  });
});

describe('ClaimCancelComponent (/admin/claim/cancel)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reassures that nothing was charged and offers a calm path back to the site', () => {
    const { host } = renderAs(ClaimCancelComponent, { site: 'site-9' });
    expect(host.querySelector('[data-testid="claim-cancel"]')).not.toBeNull();
    expect(host.textContent).withContext('calm no-charge copy').toContain('No charge');
    const cta = host.querySelector<HTMLAnchorElement>('[data-testid="claim-cancel-cta"]');
    expect(cta?.getAttribute('href')).toContain('/admin/sites/site-9');
  });

  it('falls back to the sites grid when no site param is present', () => {
    const { host } = renderAs(ClaimCancelComponent, {});
    const cta = host.querySelector<HTMLAnchorElement>('[data-testid="claim-cancel-cta"]');
    expect(cta?.getAttribute('href')).toContain('/admin/sites');
  });
});
