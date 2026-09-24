import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Router } from '@angular/router';
import { DomainPickerComponent } from './domain-picker.component';
import { AdminStateService } from '../../pages/admin/admin-state.service';
import { ApiService } from '../../services/api.service';
import { BillingService } from '../../services/billing.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ToastService } from '../../services/toast.service';
import { DomainSuggestionsCache } from './domain-suggestions-cache.service';

/**
 * Domain-picker labelling contract (2026-06-17):
 *  - the purchase CTA always reads "Buy" (plain, or `Buy · $N/yr` variants) —
 *    never "Register" / "Start wallet" as the lead word;
 *  - the brand-fallback recommendations carry NO "Brand-fit idea — type it to
 *    check availability" reason; the on-row "Recommended" pill conveys that
 *    instead.
 */
describe('DomainPickerComponent (Buy CTA + recommendation labelling)', () => {
  function make(wallet: { has_wallet: boolean; balance_cents: number }): DomainPickerComponent {
    TestBed.resetTestingModule(); // allow multiple make() calls within one spec
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        {
          provide: AdminStateService,
          useValue: { selectedSite: signal({ id: 's1', business_name: 'Acme Co', slug: 'acme' }), sites: signal([]) },
        },
        { provide: ApiService, useValue: { get: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }) } },
        { provide: BillingService, useValue: { walletState: () => wallet } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    return TestBed.createComponent(DomainPickerComponent).componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('labels the purchase button "Buy" when there is no price', () => {
    expect(make({ has_wallet: false, balance_cents: 0 }).registerCtaLabel({ price_usd_yr: undefined } as never)).toBe('Buy');
  });

  it('every priced purchase CTA leads with "Buy" (active / insufficient / no-wallet)', () => {
    expect(make({ has_wallet: true, balance_cents: 9_999_900 }).registerCtaLabel({ price_usd_yr: 12 } as never)).toBe('Buy · $12/yr');
    expect(make({ has_wallet: true, balance_cents: 1 }).registerCtaLabel({ price_usd_yr: 12 } as never).startsWith('Buy ·')).toBeTrue();
    expect(make({ has_wallet: false, balance_cents: 0 }).registerCtaLabel({ price_usd_yr: 12 } as never).startsWith('Buy ·')).toBeTrue();
  });

  it('brand-fallback recommendations carry no "Brand-fit idea / type it" reason', () => {
    const c = make({ has_wallet: false, balance_cents: 0 });
    const fb = (c as unknown as { brandFallbackSuggestions(): { domain: string; reason?: string }[] }).brandFallbackSuggestions();
    expect(fb.length).toBeGreaterThan(0);
    expect(fb.every((s) => !s.reason)).toBeTrue();
    expect(fb.some((s) => (s.reason ?? '').includes('Brand-fit idea'))).toBeFalse();
  });
});

/**
 * Honest unknown-availability badge. `/api/domains/search-enrich` passes RDAP
 * `status:'unknown'` through to the picker (e.g. `.app`, whose RDAP currently
 * fails). The row template previously branched only on 'available'/'taken', so an
 * unknown row rendered with NO dot + NO status badge (ambiguous — reads as an
 * unlabelled recommendable domain). It must show an explicit "couldn't check".
 */
describe('DomainPickerComponent — honest unknown-availability badge', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a "couldn\'t check" badge for a status:"unknown" (RDAP-failed) row, never mislabelled available/taken', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        {
          provide: AdminStateService,
          useValue: { selectedSite: signal({ id: 's1', business_name: 'Acme Co', slug: 'acme' }), sites: signal([]) },
        },
        {
          provide: ApiService,
          useValue: {
            get: () => of({ data: [] }),
            post: () => of({ data: {} }),
            getHostnames: () => of({ data: [] }),
            addHostname: () => of({ data: {} }),
            setPrimaryHostname: () => of({ data: {} }),
            unsubscribeHostname: () => of({ data: {} }),
            searchDomainsEnriched: () => of({ results: [] }),
          },
        },
        {
          provide: BillingService,
          useValue: {
            walletState: () => ({ has_wallet: false, balance_cents: 0 }),
            start: () => undefined,
            stop: () => undefined,
            refreshWallet: () => undefined,
          },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(DomainPickerComponent);
    const c = fixture.componentInstance;
    c.open.set(true);
    c.query.set('testbiz');
    fixture.detectChanges(); // let the open/query effects (hostnames, suggestions) settle first

    // Now inject a single unknown-status live row + clear AI suggestions so the
    // assertions see ONLY this row's badge.
    c.suggestions.set([]);
    c.liveResults.set([
      { domain: 'testbiz.app', tld: 'app', available: false, status: 'unknown', price_usd_yr: 14, can_register_inline: false, fallback_url: null } as never,
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const badge = el.querySelector('[data-testid="domain-status-unknown"]');
    expect(badge).withContext('unknown-status row must render the honest "couldn\'t check" badge').not.toBeNull();
    expect(badge?.textContent ?? '').toContain('couldn');
    // The unknown row itself must not also carry an available/taken badge (mutually
    // exclusive @else-if branches) — assert against the live section's single row.
    const liveSection = Array.from(el.querySelectorAll('.dp-section')).find((s) =>
      s.querySelector('.dp-section-label')?.textContent?.includes('Live availability'),
    );
    expect(liveSection?.querySelector('.dp-status--ok')).withContext('unknown row not "available"').toBeNull();
    expect(liveSection?.querySelector('.dp-status--no')).withContext('unknown row not "taken"').toBeNull();
  });
});

/**
 * Reflow regression (2026-08-26): the picker's width caps MUST stay viewport-relative.
 * The desktop-fixed `max-width: 340px` (trigger) / `280px` (host) forced EVERY /admin
 * page to scroll horizontally ~42px at ≤390px once a real site's long
 * `{slug}.projectsites.dev` host filled the trigger (surfaced on e2e-test-org's
 * brightwater-family-dental-madison-2 site — `selectedSite()` returns `sites[0]`).
 * `min(px, vw)` keeps desktop identical (min() picks the px cap on wide screens)
 * while the trigger shrinks + the host ellipsis-truncates on mobile. This guard runs
 * in CI (Karma/ChromeHeadless) so the fix isn't protected ONLY by the prod-suite
 * admin-reflow.e2e.ts, which is SKIPPED when E2E_API_KEY is unset.
 */
describe('DomainPickerComponent — viewport-relative width caps (reflow guard)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('caps .dp-trigger and .dp-host with a viewport-relative min(), never a fixed px', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        {
          provide: AdminStateService,
          useValue: {
            selectedSite: signal({ id: 's1', business_name: 'Acme Co', slug: 'a-very-long-business-slug-that-would-overflow-mobile' }),
            sites: signal([]),
          },
        },
        { provide: ApiService, useValue: { get: () => of({ suggestions: [] }) } },
        { provide: BillingService, useValue: { walletState: () => ({ has_wallet: false, balance_cents: 0 }), start: () => undefined, stop: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true), navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(DomainPickerComponent);
    fixture.detectChanges(); // inject the component's emulated-encapsulation styles

    // Angular may inject component styles as <style> tags OR via adoptedStyleSheets —
    // scan both so the guard is robust to the injection mechanism.
    const fromTags = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '');
    const fromAdopted = Array.from(document.adoptedStyleSheets ?? []).flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((r) => r.cssText);
      } catch {
        return [];
      }
    });
    const css = [...fromTags, ...fromAdopted].join('\n').replace(/\s+/g, '');

    expect(css.length).withContext('component styles must be present in the DOM').toBeGreaterThan(0);
    expect(css).withContext('.dp-trigger max-width must be viewport-relative min(340px,62vw), not a fixed px cap').toContain('min(340px,62vw)');
    expect(css).withContext('.dp-host max-width must be viewport-relative min(280px,42vw), not a fixed px cap').toContain('min(280px,42vw)');

    // Msg-2 (Brian, 2026-09-20): an UNAVAILABLE domain's price must recede — the
    // .dp-price--muted variant is borderless + struck-through so the eye skips it
    // and lands on the available options. Regression-lock the treatment.
    expect(css).withContext('.dp-price--muted variant must exist').toContain('.dp-price--muted');
    const muted = css.slice(css.indexOf('.dp-price--muted'), css.indexOf('.dp-price--muted') + 240);
    expect(muted).withContext('unavailable price must be struck through').toContain('line-through');
    expect(muted).withContext('unavailable price must be borderless').toContain('border:none');

    // Multi-action rows (Copy · Open · Set-default · Deactivate) must degrade gracefully on
    // mobile — the assigned-row hostname ellipsis-truncates instead of wrapping into a cramped
    // blob. The base sheet has ONE ellipsis rule (.dp-host trigger); this adds a second
    // (.dp-row-main .dp-mono). Assert the VALUE count (robust to Angular's encapsulation attrs).
    const ellipsisRules = (css.match(/text-overflow:ellipsis/g) || []).length;
    expect(ellipsisRules)
      .withContext('assigned-row hostname must add a 2nd ellipsis rule for mobile density')
      .toBeGreaterThanOrEqual(2);
  });
});

/**
 * Msg-1 (Brian, _APP_COMPLETION §A) — every site permanently resolves on its
 * `{slug}.projectsites.dev` subdomain, so the picker ALWAYS shows it: "No domains
 * assigned" must never render and the site is never strandable. The default row is
 * synthesized when the API returns no real row for it, and it is
 * non-removable / non-deactivatable (reverting to it uses the reset-primary endpoint).
 */
describe('DomainPickerComponent — always-present, non-strandable default subdomain', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(
    opts: { hostnames?: Array<{ id: string; hostname: string; status: string; is_primary: boolean }>; site?: Record<string, unknown> } = {},
  ) {
    const hostnames = opts.hostnames ?? [];
    const site = opts.site ?? { id: 's1', slug: 'acme', primary_hostname: null };
    const api: Record<string, unknown> = {
      get: () => of({ data: [] }),
      post: () => of({ data: {} }),
      getHostnames: () => of({ data: hostnames }),
      addHostname: () => of({ data: {} }),
      setPrimaryHostname: () => of(undefined),
      resetPrimaryHostname: () => of(undefined),
      unsubscribeHostname: () => of(undefined),
      searchDomainsEnriched: () => of({ results: [] }),
    };
    const toast: Record<string, unknown> = { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal(site), sites: signal([site]) } },
        { provide: ApiService, useValue: api },
        { provide: BillingService, useValue: { walletState: () => ({ has_wallet: false, balance_cents: 0 }), start: () => undefined, stop: () => undefined, refreshWallet: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: toast },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const c = TestBed.createComponent(DomainPickerComponent).componentInstance;
    c.hostnames.set(hostnames as never);
    return { c, api, toast };
  }

  it('synthesizes the default {slug}.projectsites.dev row when the API returns none — list is never empty', () => {
    const { c } = setup({ hostnames: [] });
    const rows = c.filteredAssigned();
    expect(rows.length).toBe(1);
    expect(rows[0].hostname).toBe('acme.projectsites.dev');
    expect(rows[0].isDefault).toBeTrue();
    expect(rows[0].isActive).withContext('default is active when no custom primary is set').toBeTrue();
  });

  it('does not duplicate the default when the API already returns it — marks that real row isDefault', () => {
    const { c } = setup({ hostnames: [{ id: 'h1', hostname: 'acme.projectsites.dev', status: 'active', is_primary: true }] });
    const rows = c.filteredAssigned();
    expect(rows.filter((r) => r.hostname === 'acme.projectsites.dev').length).toBe(1);
    expect(rows[0].id).toBe('h1');
    expect(rows[0].isDefault).toBeTrue();
  });

  it('prepends the default and keeps it non-active when a custom domain is primary', () => {
    const { c } = setup({
      site: { id: 's1', slug: 'acme', primary_hostname: 'acme.com' },
      hostnames: [{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }],
    });
    const rows = c.filteredAssigned();
    expect(rows[0].hostname).toBe('acme.projectsites.dev');
    expect(rows[0].isDefault).toBeTrue();
    expect(rows[0].isActive).toBeFalse();
    expect(rows.some((r) => r.hostname === 'acme.com' && r.isActive)).toBeTrue();
  });

  it('refuses to deactivate the default subdomain (non-strandable) — toasts, no API call', () => {
    const { c, api, toast } = setup({ hostnames: [] });
    const unsub = spyOn(api as { unsubscribeHostname: () => unknown }, 'unsubscribeHostname');
    const err = spyOn(toast as { error: () => unknown }, 'error');
    c.deactivate(c.filteredAssigned()[0]);
    expect(unsub).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('routes "set as default" on the synthetic row to reset-primary, not setPrimaryHostname(id)', () => {
    const { c, api } = setup({
      site: { id: 's1', slug: 'acme', primary_hostname: 'acme.com' },
      hostnames: [{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }],
    });
    const reset = spyOn(api as { resetPrimaryHostname: (id: string) => unknown }, 'resetPrimaryHostname').and.returnValue(of(undefined));
    const setPrimary = spyOn(api as { setPrimaryHostname: () => unknown }, 'setPrimaryHostname').and.returnValue(of(undefined));
    const def = c.filteredAssigned().find((r) => r.isDefault)!;
    c.setDefault(def);
    expect(reset).toHaveBeenCalledWith('s1');
    expect(setPrimary).not.toHaveBeenCalled();
  });

  it('opens the live domain in a new tab via openHostname', () => {
    const { c } = setup({ hostnames: [{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }] });
    const openSpy = spyOn(window, 'open');
    const row = c.filteredAssigned().find((r) => r.hostname === 'acme.com')!;
    c.openHostname(row);
    expect(openSpy).toHaveBeenCalledWith('https://acme.com', '_blank', 'noopener,noreferrer');
  });

  it('copies the live URL to the clipboard via copyHostname', () => {
    const { c } = setup({ hostnames: [{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }] });
    // Replace the whole clipboard object with a fresh stub (shadow + restore) — spying the
    // shared global writeText collides with other specs ("already been spied upon").
    const writeText = jasmine.createSpy('writeText').and.returnValue(Promise.resolve());
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const row = c.filteredAssigned().find((r) => r.hostname === 'acme.com')!;
      c.copyHostname(row);
      expect(writeText).toHaveBeenCalledWith('https://acme.com');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

describe('DomainPickerComponent — overflow menu (⋯ trigger) ARIA + handler contract', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(hostnames: Array<{ id: string; hostname: string; status: string; is_primary: boolean }> = []) {
    const site = { id: 's1', slug: 'acme', primary_hostname: null };
    const api: Record<string, unknown> = {
      get: () => of({ data: [] }),
      post: () => of({ data: {} }),
      getHostnames: () => of({ data: hostnames }),
      addHostname: () => of({ data: {} }),
      setPrimaryHostname: () => of(undefined),
      resetPrimaryHostname: () => of(undefined),
      unsubscribeHostname: () => of(undefined),
      searchDomainsEnriched: () => of({ results: [] }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal(site), sites: signal([site]) } },
        { provide: ApiService, useValue: api },
        {
          provide: BillingService,
          useValue: { walletState: () => ({ has_wallet: false, balance_cents: 0 }), start: () => undefined, stop: () => undefined, refreshWallet: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(DomainPickerComponent);
    const c = fixture.componentInstance;
    c.hostnames.set(hostnames as never);
    c.open.set(true);
    fixture.detectChanges();
    return { fixture, c, api };
  }

  it('renders one ⋯ trigger button per assigned-domain row with aria-haspopup="menu"', () => {
    const { fixture } = setup([{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }]);
    const el = fixture.nativeElement as HTMLElement;
    const triggers = el.querySelectorAll('button[aria-haspopup="menu"]');
    expect(triggers.length).withContext('one ⋯ trigger per assigned row').toBeGreaterThanOrEqual(1);
  });

  it('trigger aria-label names the domain it controls', () => {
    const { fixture } = setup([{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }]);
    const el = fixture.nativeElement as HTMLElement;
    const trigger = el.querySelector('button[aria-haspopup="menu"][aria-label*="acme.com"]');
    expect(trigger).withContext('trigger must carry aria-label mentioning the hostname').not.toBeNull();
  });

  it('copyHostname handler invokes clipboard.writeText with the https:// URL', () => {
    const { c } = setup([{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }]);
    const writeText = jasmine.createSpy('writeText').and.returnValue(Promise.resolve());
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const row = c.filteredAssigned().find((r) => r.hostname === 'acme.com')!;
      c.copyHostname(row);
      expect(writeText).toHaveBeenCalledWith('https://acme.com');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('openHostname handler calls window.open with the https:// URL', () => {
    const { c } = setup([{ id: 'h1', hostname: 'acme.com', status: 'active', is_primary: true }]);
    const openSpy = spyOn(window, 'open');
    const row = c.filteredAssigned().find((r) => r.hostname === 'acme.com')!;
    c.openHostname(row);
    expect(openSpy).toHaveBeenCalledWith('https://acme.com', '_blank', 'noopener,noreferrer');
  });
});

/**
 * Paid-domain protection (Brian, 2026-09-22): a domain you PAY for (`type: 'custom_cname'`)
 * can NOT be removed — the ⋯ menu offers "Stop / Enable auto-renew" instead of "Deactivate",
 * and `deactivate()` refuses a paid domain. Free subdomains stay deletable.
 */
describe('DomainPickerComponent — paid domains cannot be removed, only auto-renew toggled', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(hostname: {
    id: string;
    hostname: string;
    status: string;
    is_primary: boolean;
    type: string;
    auto_renew: number;
  }) {
    const site = { id: 's1', slug: 'acme', primary_hostname: 'buyme.com' };
    const api: Record<string, unknown> = {
      get: () => of({ data: [] }),
      post: () => of({ data: {} }),
      getHostnames: () => of({ data: [hostname] }),
      addHostname: () => of({ data: {} }),
      setPrimaryHostname: () => of(undefined),
      resetPrimaryHostname: () => of(undefined),
      unsubscribeHostname: () => of(undefined),
      setHostnameAutoRenew: () => of({ data: { hostname: hostname.hostname, auto_renew: 0 } }),
      searchDomainsEnriched: () => of({ results: [] }),
    };
    const toast: Record<string, unknown> = { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal(site), sites: signal([site]) } },
        { provide: ApiService, useValue: api },
        { provide: BillingService, useValue: { walletState: () => ({ has_wallet: false, balance_cents: 0 }), start: () => undefined, stop: () => undefined, refreshWallet: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: toast },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const c = TestBed.createComponent(DomainPickerComponent).componentInstance;
    c.hostnames.set([hostname] as never);
    return { c, api, toast };
  }

  const PAID = { id: 'h1', hostname: 'buyme.com', status: 'active', is_primary: true, type: 'custom_cname', auto_renew: 1 };

  it('toggleAutoRenew on a paid domain calls setHostnameAutoRenew (disable when currently on)', () => {
    const { c, api } = setup(PAID);
    const spy = spyOn(
      api as { setHostnameAutoRenew: (a: string, b: string, e: boolean) => unknown },
      'setHostnameAutoRenew',
    ).and.returnValue(of({ data: { hostname: 'buyme.com', auto_renew: 0 } }));
    const row = c.filteredAssigned().find((r) => r.hostname === 'buyme.com')!;
    c.toggleAutoRenew(row);
    expect(spy).toHaveBeenCalledWith('s1', 'h1', false);
  });

  it('refuses to deactivate a paid domain — toasts, never calls unsubscribeHostname', () => {
    const { c, api, toast } = setup(PAID);
    const unsub = spyOn(api as { unsubscribeHostname: () => unknown }, 'unsubscribeHostname');
    const err = spyOn(toast as { error: () => unknown }, 'error');
    const row = c.filteredAssigned().find((r) => r.hostname === 'buyme.com')!;
    c.deactivate(row);
    expect(unsub).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});

/**
 * AI-suggestions SWR cache + pre-warm (2026-09-22, frontend "Stale-while-revalidate
 * for list pages" doctrine). A re-opened picker must paint its last-known picks
 * INSTANTLY (no skeleton flash) then revalidate silently; trigger hover/focus
 * pre-warms the cache so even the first open is instant.
 */
describe('DomainPickerComponent — AI suggestions SWR cache + pre-warm', () => {
  // The cache now persists to localStorage ("always cached" across reloads), so a
  // prior test's set() would otherwise pre-warm the next test's freshly-hydrated
  // cache and flip an "already warm" no-op assertion. Isolate each test (fix the
  // spec's isolation, not the feature — root-cause-validator-findings).
  beforeEach(() => {
    try {
      localStorage.removeItem('ps.domainSuggestions.v1');
    } catch {
      /* private-mode / SSR — nothing to clear */
    }
  });
  afterEach(() => TestBed.resetTestingModule());

  function setup(suggestions: Array<{ domain: string }>) {
    const site = { id: 's1', business_name: 'Acme Co', slug: 'acme', primary_hostname: null };
    const api: Record<string, unknown> = {
      // The suggest endpoint returns `{ suggestions }`; every other GET is benign.
      get: (path: string) =>
        typeof path === 'string' && path.includes('/domains/suggest') ? of({ suggestions }) : of({ data: [] }),
      post: () => of({ data: {} }),
      getHostnames: () => of({ data: [] }),
      addHostname: () => of({ data: {} }),
      setPrimaryHostname: () => of(undefined),
      resetPrimaryHostname: () => of(undefined),
      unsubscribeHostname: () => of(undefined),
      searchDomainsEnriched: () => of({ results: [] }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DomainPickerComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal(site), sites: signal([site]) } },
        { provide: ApiService, useValue: api },
        {
          provide: BillingService,
          useValue: { walletState: () => ({ has_wallet: false, balance_cents: 0 }), start: () => undefined, stop: () => undefined, refreshWallet: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ToastService, useValue: { info: () => 0, error: () => 0, success: () => 0, warning: () => 0, dismiss: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true), navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const c = TestBed.createComponent(DomainPickerComponent).componentInstance;
    return { c, cache: TestBed.inject(DomainSuggestionsCache) };
  }

  type PrivLoad = { loadAiSuggestions(id: string, opts?: { background?: boolean }): Promise<void> };

  it('a background load caches the picks WITHOUT painting the signal or showing a skeleton', async () => {
    const { c, cache } = setup([{ domain: 'acme.com' }, { domain: 'acme.io' }]);
    await (c as unknown as PrivLoad).loadAiSuggestions('s1', { background: true });
    expect(cache.has('s1')).withContext('background load warms the cache').toBeTrue();
    expect(c.suggestions().length).withContext('background load never paints the visible signal').toBe(0);
    expect(c.suggestionsLoading()).withContext('background load never shows a skeleton').toBeFalse();
  });

  it('prewarm() fires a background load on intent, and no-ops when open or already warm', () => {
    const { c, cache } = setup([{ domain: 'acme.com' }]);
    const load = spyOn(c as unknown as PrivLoad, 'loadAiSuggestions').and.returnValue(Promise.resolve());
    c.prewarm();
    expect(load).withContext('hover/focus intent → background pre-warm').toHaveBeenCalledWith('s1', { background: true });
    // already-open panel → no pre-warm (the open path fetches its own)
    load.calls.reset();
    c.open.set(true);
    c.prewarm();
    expect(load).withContext('open panel does not pre-warm').not.toHaveBeenCalled();
    // warm cache → no redundant pre-warm
    c.open.set(false);
    cache.set('s1', [{ domain: 'x.com' } as never]);
    load.calls.reset();
    c.prewarm();
    expect(load).withContext('warm cache does not re-pre-warm').not.toHaveBeenCalled();
  });

  it('re-open paints cached picks INSTANTLY (no skeleton), then revalidates to fresh (SWR)', async () => {
    const { c, cache } = setup([{ domain: 'acme.com' }, { domain: 'acme.io' }]);
    cache.set('s1', [{ domain: 'cached1.com' } as never, { domain: 'cached2.com' } as never]);
    const p = (c as unknown as PrivLoad).loadAiSuggestions('s1');
    // BEFORE the revalidate settles: the stale cached picks are already painted, no skeleton.
    expect(c.suggestions().map((s) => s.domain)).toEqual(['cached1.com', 'cached2.com']);
    expect(c.suggestionsLoading()).withContext('warm cache never flips the skeleton on').toBeFalse();
    await p;
    // AFTER revalidate: the visible list is replaced with the fresh server picks.
    expect(c.suggestions().map((s) => s.domain)).withContext('revalidate replaces stale with fresh').toEqual(['acme.com', 'acme.io']);
  });

  it('cold load shows the skeleton, then paints AND caches the fetched picks', async () => {
    const { c, cache } = setup([{ domain: 'fresh1.com' }, { domain: 'fresh2.com' }]);
    expect(cache.has('s1')).withContext('cold — nothing cached yet').toBeFalse();
    const p = (c as unknown as PrivLoad).loadAiSuggestions('s1');
    expect(c.suggestionsLoading()).withContext('cold open shows the skeleton while fetching').toBeTrue();
    await p;
    expect(c.suggestionsLoading()).toBeFalse();
    expect(c.suggestions().map((s) => s.domain)).toEqual(['fresh1.com', 'fresh2.com']);
    expect(cache.get('s1')?.map((s) => s.domain)).withContext('fetched picks are cached for the next open').toEqual(['fresh1.com', 'fresh2.com']);
  });
});
