import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { Router } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { Dialog } from '@angular/cdk/dialog';
import { AdminStateService } from './admin-state.service';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { TelemetryService } from '../../services/telemetry.service';

/**
 * Core contract for AdminStateService — the single state container every admin
 * section shares (provided at AdminComponent level). Locks the high-traffic
 * `selectedSite` derivation (no-id → first site; id → match; stale id → first;
 * empty → null) and the loadData() success/error fan-in (forkJoin populates the
 * signals + clears loading; a failure clears loading + toasts, never hangs).
 */
const site = (id: string): never => ({ id, slug: id, business_name: id, status: 'published' }) as never;

function setup(opts: { sites?: never[]; meFails?: boolean; loadFails?: boolean } = {}): {
  svc: AdminStateService; toastErr: jasmine.Spy; getAnalytics: jasmine.Spy;
} {
  const ok = <T,>(data: T) => of({ data });
  const api = {
    listSites: () => (opts.loadFails ? throwError(() => ({ status: 500 })) : ok(opts.sites ?? [])),
    getDomainSummary: () => ok({ total: 0, active: 0, pending: 0, failed: 0 }),
    getSubscription: () => ok(null),
    getMe: () => (opts.meFails ? throwError(() => ({ status: 500 })) : ok({ org_id: 'org-1', is_super_admin: true })),
    // Kept as a spy to lock the removal of the dead, never-rendered GA4/CF analytics
    // fetch: loadData()/refresh must NEVER call it (it wasted one CF API call per tick).
    getAnalytics: jasmine.createSpy('getAnalytics').and.returnValue(ok(null)),
  };
  const toastErr = jasmine.createSpy('error');
  TestBed.configureTestingModule({
    providers: [
      AdminStateService,
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { isLoggedIn: () => true } },
      { provide: ToastService, useValue: { error: toastErr, success: () => 0, toasts: () => [] } },
      { provide: TelemetryService, useValue: { track: () => undefined } },
      { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
      { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
    ],
  });
  return { svc: TestBed.inject(AdminStateService), toastErr, getAnalytics: api.getAnalytics };
}

describe('AdminStateService (selectedSite + loadData)', () => {
  afterEach(() => {
    // Stop any live-refresh timer a loadData success may have started.
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    TestBed.resetTestingModule();
  });

  it('selectedSite is null when there are no sites', () => {
    const { svc } = setup();
    svc.sites.set([]);
    expect(svc.selectedSite()).toBeNull();
  });

  it('selectedSite defaults to the first site when no id is selected', () => {
    const { svc } = setup();
    svc.sites.set([site('a'), site('b')]);
    svc.selectedSiteId.set(null);
    expect(svc.selectedSite()?.id).toBe('a');
  });

  it('selectedSite resolves the selected id', () => {
    const { svc } = setup();
    svc.sites.set([site('a'), site('b')]);
    svc.selectedSiteId.set('b');
    expect(svc.selectedSite()?.id).toBe('b');
  });

  it('selectedSite falls back to the first site when the selected id is stale', () => {
    const { svc } = setup();
    svc.sites.set([site('a'), site('b')]);
    svc.selectedSiteId.set('ghost');
    expect(svc.selectedSite()?.id).toBe('a');
  });

  it('loadData() populates sites/org/super-admin and clears loading', () => {
    const { svc } = setup({ sites: [site('a'), site('b')] });
    svc.loadData();
    expect(svc.sites().length).toBe(2);
    expect(svc.orgId()).toBe('org-1');
    expect(svc.isSuperAdmin()).toBe(true);
    expect(svc.loading()).toBe(false);
  });

  // Regression: the GA4/CF `getAnalytics` result was fetched into a signal that NO
  // component ever rendered — a dead, recurring CF/GA4 API call per site/tick. loadData
  // (and the live refresh it starts) must never fetch it. Prevents re-introduction.
  it('loadData() does NOT fetch the never-rendered GA4/CF analytics (dead fetch removed)', () => {
    const { svc, getAnalytics } = setup({ sites: [site('a')] });
    svc.loadData();
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it('loadData() tolerates a /me failure (org defaults, dashboard still loads)', () => {
    const { svc } = setup({ sites: [site('a')], meFails: true });
    svc.loadData();
    expect(svc.sites().length).toBe(1); // dashboard loaded despite /me hiccup
    expect(svc.orgId()).toBe('');
    expect(svc.loading()).toBe(false);
  });

  it('loadData() failure clears loading + toasts (never hangs on the spinner)', () => {
    const { svc, toastErr } = setup({ loadFails: true });
    svc.loadData();
    expect(svc.loading()).toBe(false);
    expect(toastErr).toHaveBeenCalled();
  });
});

/**
 * Locks the documented perf invariant: the 30s live-refresh poll PAUSES while
 * the tab is hidden (so a backgrounded admin never burns the API quota) and
 * RESUMES when the tab returns. A regression here (dropping the visibilitychange
 * guard) would silently poll hidden tabs forever — exactly the class of silent
 * perf regression a test must catch.
 */
describe('AdminStateService — visibility-aware live-refresh (hidden tabs do not poll)', () => {
  let hidden = false;
  let origHidden: PropertyDescriptor | undefined;

  function buildWithSpy(): { svc: AdminStateService; listSites: jasmine.Spy } {
    const listSites = jasmine.createSpy('listSites').and.returnValue(of({ data: [site('s1')] }));
    const api = {
      listSites,
      getDomainSummary: () => of({ data: { total: 0, active: 0, pending: 0, failed: 0 } }),
      getSubscription: () => of({ data: null }),
      getMe: () => of({ data: { org_id: 'o', is_super_admin: false } }),
      getAnalytics: () => of({ data: null }),
    };
    TestBed.configureTestingModule({
      providers: [
        AdminStateService,
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, toasts: () => [] } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
      ],
    });
    return { svc: TestBed.inject(AdminStateService), listSites };
  }

  beforeEach(() => {
    hidden = false;
    origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    jasmine.clock().install();
  });

  afterEach(() => {
    jasmine.clock().uninstall();
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    if (origHidden) Object.defineProperty(document, 'hidden', origHidden);
    else Reflect.deleteProperty(document, 'hidden');
    TestBed.resetTestingModule();
  });

  it('does NOT poll while hidden, and resumes polling after the tab returns', () => {
    const { svc, listSites } = buildWithSpy();
    svc.loadData(); // success → starts the 30s live-refresh + visibility listener
    const base = listSites.calls.count(); // 1 (loadData's own fetch)

    // Tab hidden → the visibility handler must stop the timer.
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    jasmine.clock().tick(31_000);
    expect(listSites.calls.count()).withContext('no poll fired while the tab was hidden').toBe(base);

    // Tab visible again → resumes; the 30s interval fires another sites fetch.
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    jasmine.clock().tick(31_000);
    expect(listSites.calls.count()).withContext('polling resumes after the tab returns').toBeGreaterThan(base);
  });
});

/**
 * copyUrl() copies the site's LIVE url (primary hostname → slug.projectsites.dev)
 * to the clipboard. A clipboard rejection (insecure context / denied permission)
 * must surface a friendly error toast — never a silent unhandled rejection (which
 * would also trip the console-error gate).
 */
describe('AdminStateService — copyUrl (clipboard + graceful failure)', () => {
  let writeText: jasmine.Spy;
  let success: jasmine.Spy;
  let error: jasmine.Spy;
  let origClipboard: PropertyDescriptor | undefined;

  function build(): AdminStateService {
    success = jasmine.createSpy('success');
    error = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      providers: [
        AdminStateService,
        { provide: ApiService, useValue: { listSites: () => of({ data: [] }), getDomainSummary: () => of({ data: {} }), getSubscription: () => of({ data: null }), getMe: () => of({ data: {} }), getAnalytics: () => of({ data: null }) } },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: ToastService, useValue: { success, error, toasts: () => [] } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
      ],
    });
    return TestBed.inject(AdminStateService);
  }

  beforeEach(() => {
    origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    writeText = jasmine.createSpy('writeText');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => {
    if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
    else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'clipboard');
    TestBed.resetTestingModule();
  });

  it('copies the live URL and toasts success', async () => {
    writeText.and.returnValue(Promise.resolve());
    const svc = build();
    svc.copyUrl({ id: 's', slug: 'vito', business_name: 'Vito', status: 'published' } as never);
    await Promise.resolve(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('https://vito.projectsites.dev');
    expect(success).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a clipboard rejection surfaces an error toast — no silent unhandled rejection', async () => {
    writeText.and.returnValue(Promise.reject(new Error('denied')));
    const svc = build();
    svc.copyUrl({ id: 's', slug: 'vito', business_name: 'Vito', status: 'published' } as never);
    await Promise.resolve(); await Promise.resolve();
    expect(error).toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });
});

/**
 * External `window.open(url, '_blank')` MUST pass 'noopener,noreferrer' — without
 * it the opened tab gets `window.opener` and can redirect the admin tab to a
 * phishing page (reverse tabnabbing). visitSite (published site, possibly a custom
 * domain) + openBilling (Stripe portal) are fire-and-forget opens, so noopener is safe.
 */
describe('AdminStateService — external opens are reverse-tabnabbing-safe (noopener,noreferrer)', () => {
  let openSpy: jasmine.Spy;

  function build(portalUrl: string | null): AdminStateService {
    const api = {
      listSites: () => of({ data: [] }),
      getDomainSummary: () => of({ data: { total: 0, active: 0, pending: 0, failed: 0 } }),
      getSubscription: () => of({ data: null }),
      getMe: () => of({ data: { org_id: 'o', is_super_admin: true } }),
      getAnalytics: () => of({ data: null }),
      getBillingPortal: () => of({ data: portalUrl ? { portal_url: portalUrl } : {} }),
    };
    TestBed.configureTestingModule({
      providers: [
        AdminStateService,
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, toasts: () => [] } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
      ],
    });
    return TestBed.inject(AdminStateService);
  }

  beforeEach(() => { openSpy = spyOn(window, 'open').and.returnValue(null); });
  afterEach(() => {
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    TestBed.resetTestingModule();
  });

  it('visitSite opens the published site with noopener,noreferrer', () => {
    build(null).visitSite({ id: 's1', slug: 'demo', business_name: 'Demo', status: 'published' } as never);
    expect(openSpy).toHaveBeenCalled();
    const feat = String(openSpy.calls.mostRecent().args[2] ?? '');
    expect(feat).withContext('noopener present').toContain('noopener');
    expect(feat).withContext('noreferrer present').toContain('noreferrer');
  });

  it('openBilling opens the Stripe portal with noopener,noreferrer', () => {
    build('https://billing.stripe.com/p/session/xyz').openBilling();
    expect(openSpy).toHaveBeenCalledWith('https://billing.stripe.com/p/session/xyz', '_blank', 'noopener,noreferrer');
  });
});

/**
 * The upgrade-checkout redirect navigates the admin's OWN tab via location.href.
 * A non-https / non-stripe checkout_url (e.g. a manipulated `javascript:` value)
 * must NEVER reach the redirect — validate the host+scheme, toast on a bad value.
 */
describe('AdminStateService — openCheckout only redirects to an https stripe URL', () => {
  let redirectSpy: jasmine.Spy;
  let toastErr: jasmine.Spy;

  function build(checkoutUrl: string | null): AdminStateService {
    toastErr = jasmine.createSpy('error');
    const api = {
      listSites: () => of({ data: [] }),
      getDomainSummary: () => of({ data: { total: 0, active: 0, pending: 0, failed: 0 } }),
      getSubscription: () => of({ data: null }),
      getMe: () => of({ data: { org_id: 'org-1', is_super_admin: true } }),
      getAnalytics: () => of({ data: null }),
      post: () => of({ data: checkoutUrl ? { checkout_url: checkoutUrl } : {} }),
    };
    TestBed.configureTestingModule({
      providers: [
        AdminStateService,
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: ToastService, useValue: { error: toastErr, success: () => 0, toasts: () => [] } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
      ],
    });
    const svc = TestBed.inject(AdminStateService);
    redirectSpy = spyOn(svc as unknown as { redirectExternal(u: string): void }, 'redirectExternal');
    return svc;
  }

  afterEach(() => {
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    TestBed.resetTestingModule();
  });

  it('redirects to a valid https checkout.stripe.com URL', () => {
    const svc = build('https://checkout.stripe.com/c/pay/cs_test');
    svc.openCheckout();
    expect(redirectSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test');
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('refuses a non-https / non-stripe / javascript: checkout URL and toasts instead', () => {
    for (const bad of ['http://checkout.stripe.com/x', 'https://evil-stripe.com/x', 'https://stripe.com.evil.com/x', 'javascript:alert(1)', 'not a url']) {
      build(bad).openCheckout();
      expect(redirectSpy).withContext(`must not redirect to ${bad}`).not.toHaveBeenCalled();
      expect(toastErr).withContext(`toasts on ${bad}`).toHaveBeenCalled();
      try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
      TestBed.resetTestingModule();
    }
  });

  it('isHttpsStripeUrl accepts stripe hosts, rejects look-alikes', () => {
    const svc = build(null);
    const v = (svc as unknown as { isHttpsStripeUrl(u: string): boolean }).isHttpsStripeUrl.bind(svc);
    expect(v('https://checkout.stripe.com/x')).toBeTrue();
    expect(v('https://billing.stripe.com/x')).toBeTrue();
    expect(v('https://stripe.com/x')).toBeTrue();
    expect(v('https://evil-stripe.com/x')).toBeFalse();
    expect(v('https://stripe.com.evil.com/x')).toBeFalse();
    expect(v('http://checkout.stripe.com/x')).toBeFalse();
  });
});

/**
 * Selected-site persistence (AL-103) — the selection used to be in-memory only, so a
 * hard reload / new tab reset a multi-site operator to the default site. These lock in
 * the localStorage round-trip: persist on select, restore on construction, and a stale
 * id (deleted site) still degrades gracefully via the `selectedSite` computed.
 */
describe('AdminStateService — selected-site persistence (ps_selected_site)', () => {
  const KEY = 'ps_selected_site';
  beforeEach(() => { try { localStorage.removeItem(KEY); } catch { /* private mode */ } });
  afterEach(() => {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    TestBed.resetTestingModule();
  });

  it('selectSite persists the chosen id to localStorage', () => {
    const { svc } = setup();
    svc.selectSite(site('site-b') as never);
    expect(localStorage.getItem(KEY)).toBe('site-b');
  });

  it('restores the persisted id on construction (survives a reload)', () => {
    try { localStorage.setItem(KEY, 'site-b'); } catch { /* */ }
    const { svc } = setup();
    expect(svc.selectedSiteId()).toBe('site-b');
    svc.sites.set([site('site-a'), site('site-b')] as never[]);
    expect(svc.selectedSite()?.id).toBe('site-b');
  });

  it('a stale persisted id (site no longer in the list) falls back to the first site', () => {
    try { localStorage.setItem(KEY, 'deleted-site'); } catch { /* */ }
    const { svc } = setup();
    svc.sites.set([site('site-a'), site('site-b')] as never[]);
    expect(svc.selectedSite()?.id).toBe('site-a');
  });
});

/**
 * Dashboard-load toast hygiene — a single failed initial load must fire exactly ONE
 * truthful, actionable toast, NOT a pile-up. The three reads (+ /me) pass `{ silent: true }`
 * so ApiService's per-request toast ("Can't reach the server") can't double/triple-fire on
 * top of this handler's own "Failed to load dashboard data"; that one toast is armed with a
 * Retry that re-runs loadData(). See [[cf-bot-challenge-opaque-xhr-misleading-toast]] (the
 * double-toast class) — a real transient blip hits real users, not just headless probes.
 */
describe('AdminStateService — dashboard load: silent reads + ONE retry-armed toast', () => {
  interface RetryOpts { action?: { label: string; run: (id: number) => void } }
  function build(fail: boolean): {
    svc: AdminStateService; listSites: jasmine.Spy; domains: jasmine.Spy;
    sub: jasmine.Spy; me: jasmine.Spy; toastErr: jasmine.Spy; dismiss: jasmine.Spy;
  } {
    const listSites = jasmine.createSpy('listSites').and.callFake(() =>
      fail ? throwError(() => ({ status: 0 })) : of({ data: [] }));
    const domains = jasmine.createSpy('getDomainSummary').and.returnValue(of({ data: { total: 0, active: 0, pending: 0, failed: 0 } }));
    const sub = jasmine.createSpy('getSubscription').and.returnValue(of({ data: null }));
    const me = jasmine.createSpy('getMe').and.returnValue(of({ data: { org_id: 'o', is_super_admin: false } }));
    const toastErr = jasmine.createSpy('error');
    const dismiss = jasmine.createSpy('dismiss');
    TestBed.configureTestingModule({
      providers: [
        AdminStateService,
        { provide: ApiService, useValue: { listSites, getDomainSummary: domains, getSubscription: sub, getMe: me, getAnalytics: () => of({ data: null }) } },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: ToastService, useValue: { error: toastErr, success: () => 0, dismiss, toasts: () => [] } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: Router, useValue: { navigate: () => undefined, url: '/admin' } },
        { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
        { provide: Dialog, useValue: { open: () => ({ closed: of(undefined) }) } },
      ],
    });
    return { svc: TestBed.inject(AdminStateService), listSites, domains, sub, me, toastErr, dismiss };
  }
  afterEach(() => {
    try { (TestBed.inject(AdminStateService) as unknown as { stopLiveRefresh(): void }).stopLiveRefresh(); } catch { /* */ }
    TestBed.resetTestingModule();
  });

  it('passes { silent: true } to all four dashboard reads (kills the ApiService double-toast at source)', () => {
    const { svc, listSites, domains, sub, me } = build(false);
    svc.loadData();
    for (const spy of [listSites, domains, sub, me]) {
      expect(spy).toHaveBeenCalledWith({ silent: true });
    }
  });

  it('on load failure fires EXACTLY ONE error toast, armed with a Retry that re-runs loadData', () => {
    const { svc, toastErr, dismiss, listSites } = build(true);
    svc.loadData();
    expect(toastErr).toHaveBeenCalledTimes(1);
    const opts = toastErr.calls.mostRecent().args[1] as RetryOpts | undefined;
    expect(opts?.action?.label).toBe('Retry');
    const before = listSites.calls.count();
    opts?.action?.run(7);
    expect(dismiss).toHaveBeenCalledWith(7);
    expect(listSites.calls.count()).withContext('Retry re-ran the dashboard load').toBeGreaterThan(before);
  });
});
