import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';

import { AdminSitesComponent } from './sites.component';
import { AdminStateService } from '../admin-state.service';
import { ToastService } from '../../../services/toast.service';
import type { Site } from '../../../services/api.service';

/**
 * Claim-status surfaces on the sites grid (claim_flow, fire-61).
 *
 * The grid reads the EXISTING `sites.plan` field from the live-polled payload:
 *  - `plan === 'paid'`   → "Claimed" chip, no extra affordance.
 *  - any other plan      → "Unclaimed — preview live" chip + ONE primary
 *                          affordance: a "Share preview" button that copies the
 *                          subdomain URL (owner-grade copy, no jargon).
 *  - plan missing        → NO chip (never guess a claim state we don't know).
 *
 * The share button is a SIBLING of the card anchor (never a button nested in a
 * link — invalid interactive nesting), so it needs its own spec coverage.
 */
function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    slug: 'vitos-salon',
    business_name: "Vito's Mens Salon",
    business_address: '74 N Beverwyck Rd',
    status: 'published',
    current_build_version: 3,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    ...overrides,
  } as Site;
}

function stateStub(sites: Site[]): Partial<AdminStateService> {
  return {
    sites: signal(sites),
    loading: signal(false),
    getStatusClass: (status: string) => (status === 'published' ? 'published' : 'draft'),
    getStatusLabel: (status: string) => status,
    isBuilding: () => false,
    formatRelativeTime: () => 'just now',
    newSite: jasmine.createSpy('newSite'),
    loadData: jasmine.createSpy('loadData'),
  } as unknown as Partial<AdminStateService>;
}

/**
 * House clipboard stub (matches `clipboard.spec.ts` + siblings): REPLACE
 * `navigator.clipboard` wholesale via defineProperty. `spyOn(navigator.clipboard,
 * 'writeText')` is order-fragile in the full suite — an earlier suite's
 * replacement object carries a permanent spy → "has already been spied upon".
 */
function stubClipboard(behavior: 'resolve' | 'reject'): jasmine.Spy {
  const writeText =
    behavior === 'resolve'
      ? jasmine.createSpy('writeText').and.resolveTo(undefined)
      : jasmine
          .createSpy('writeText')
          .and.rejectWith(new DOMException('Write permission denied', 'NotAllowedError'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

function render(sites: Site[]): { host: HTMLElement; component: AdminSitesComponent; toast: jasmine.SpyObj<ToastService> } {
  const toast = jasmine.createSpyObj<ToastService>('ToastService', ['success', 'error']);
  TestBed.configureTestingModule({
    imports: [AdminSitesComponent],
    providers: [
      provideRouter([]),
      { provide: AdminStateService, useValue: stateStub(sites) },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fx = TestBed.createComponent(AdminSitesComponent);
  fx.detectChanges();
  return { host: fx.nativeElement as HTMLElement, component: fx.componentInstance, toast };
}

describe('AdminSitesComponent (claim-status chip + share preview)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows a "Claimed" chip for a paid site and NO share-preview button', () => {
    const { host } = render([makeSite({ plan: 'paid' })]);
    const chip = host.querySelector('[data-testid="site-claim-vitos-salon"]');
    expect(chip).withContext('claimed chip renders').not.toBeNull();
    expect(chip?.textContent).toContain('Claimed');
    expect(chip?.textContent).not.toContain('Unclaimed');
    expect(host.querySelector('[data-testid="site-share-vitos-salon"]'))
      .withContext('a claimed site needs no share-preview affordance')
      .toBeNull();
  });

  it('shows "Unclaimed — preview live" + ONE Share-preview button for a free site', () => {
    const { host } = render([makeSite({ plan: 'free' })]);
    const chip = host.querySelector('[data-testid="site-claim-vitos-salon"]');
    expect(chip?.textContent).toContain('Unclaimed — preview live');
    const share = host.querySelector<HTMLButtonElement>('[data-testid="site-share-vitos-salon"]');
    expect(share).withContext('unclaimed sites get the Share-preview affordance').not.toBeNull();
    expect(share?.textContent).toContain('Share preview');
    // Valid HTML: the button must NOT be nested inside the card anchor.
    expect(share?.closest('a')).withContext('button is a sibling of the card link, never nested').toBeNull();
  });

  it('renders NO claim chip and NO share button when the payload has no plan field', () => {
    const { host } = render([makeSite({ plan: undefined })]);
    expect(host.querySelector('[data-testid="site-claim-vitos-salon"]')).toBeNull();
    expect(host.querySelector('[data-testid="site-share-vitos-salon"]')).toBeNull();
  });

  it('Share preview copies the subdomain URL and confirms with an owner-grade toast', async () => {
    const { host, toast } = render([makeSite({ plan: 'free' })]);
    const write = stubClipboard('resolve');
    host.querySelector<HTMLButtonElement>('[data-testid="site-share-vitos-salon"]')?.click();
    expect(write).toHaveBeenCalledWith('https://vitos-salon.projectsites.dev');
    await new Promise((r) => setTimeout(r)); // flush copyToClipboard → toast chain
    expect(toast.success).toHaveBeenCalled();
    const msg = toast.success.calls.mostRecent().args[0];
    expect(msg).withContext('toast speaks owner language').toContain('copied');
  });

  it('Share preview fails soft: a clipboard rejection surfaces the link in an error toast', async () => {
    const { host, toast } = render([makeSite({ plan: 'free' })]);
    stubClipboard('reject');
    host.querySelector<HTMLButtonElement>('[data-testid="site-share-vitos-salon"]')?.click();
    await new Promise((r) => setTimeout(r)); // flush copyToClipboard → toast chain
    expect(toast.error).toHaveBeenCalled();
    expect(String(toast.error.calls.mostRecent().args[0])).toContain('vitos-salon.projectsites.dev');
  });
});
