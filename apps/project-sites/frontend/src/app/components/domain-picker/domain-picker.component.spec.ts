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
  });
});
