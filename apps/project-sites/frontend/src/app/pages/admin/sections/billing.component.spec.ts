import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';
import { AdminBillingComponent } from './billing.component';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { StripeService } from '../../../services/stripe.service';
import { ToastService } from '../../../services/toast.service';
import { TelemetryService } from '../../../services/telemetry.service';
import { ConfirmService } from '../../../services/confirm.service';

/**
 * Guards the Billing section cyan/black cohesion + a11y convergence pass (round 5):
 *  - numeric stats (wallet balance, credits remaining, plan entitlements) render
 *    through `<app-rolling-counter>` — never raw text nodes (brand mandate)
 *  - every section + the header carry the `appReveal` entrance host (8 total)
 *  - the WAI-ARIA tablist contract holds (role=tablist, exactly one selected tab,
 *    panel labelled by its tab)
 *  - the credit caps empty-state exposes role=status for AT announcement
 *
 * `ng test` (Karma) is not runnable in this isolated worktree harness; this spec
 * is also AOT-verified via `npx nx build`. It stubs ApiService so `ngOnInit`'s
 * `loadAll()` + `loadTabData()` resolve synchronously with empty data, and
 * provides a real `sites` signal on the AdminStateService stub.
 */
describe('AdminBillingComponent (cyan/black cohesion + a11y)', () => {
  let fixture: ComponentFixture<AdminBillingComponent>;
  let confirmSpy: jasmine.Spy;
  let delSpy: jasmine.Spy;

  function build(confirmResult = true, failWallet = false, failPayouts = false): void {
    // Every GET the component fires resolves to an empty/zeroed envelope so
    // ngOnInit settles synchronously without touching the network.
    delSpy = jasmine.createSpy('delete').and.returnValue(of({ ok: true }));
    confirmSpy = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    const apiStub = {
      get: (p?: string) =>
        typeof p === 'string' &&
        ((failWallet && p.includes('/wallet')) || (failPayouts && p.includes('/affiliates/payouts')))
          ? throwError(() => ({ status: 500 }))
          : of({ data: {} }),
      post: () => of({ data: {} }),
      put: () => of({ data: {} }),
      delete: delSpy,
      getCostForecast: () =>
        of({
          data: {
            projected_usd: 0,
            current_period_usd: 0,
            rolling_daily_avg: 0,
            days_until_cap_hit: null,
            plan_cap_usd: 0,
            percent_of_cap: 0,
            daily: [],
            breakdown: [], // sparkline path readers do fv.breakdown.length — must be an array
          },
        }),
    };
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: apiStub },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        {
          provide: ToastService,
          useValue: {
            info: () => 0,
            success: () => 0,
            warning: () => 0,
            error: () => 0,
            dismiss: () => undefined,
          },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: confirmSpy } },
      ],
    });
    fixture = TestBed.createComponent(AdminBillingComponent);
    fixture.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('renders the credits-remaining stat through <app-rolling-counter> (numeric stat mandate)', () => {
    build();
    // AI Credits now lives under the Wallet tab — its balance is an
    // <app-rolling-counter>, never a raw text node.
    fixture.componentInstance.setTab('wallet');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('app-rolling-counter').length).toBeGreaterThan(0);
  });

  it('renders the wallet balance through <app-rolling-counter>', () => {
    build();
    fixture.componentInstance.setTab('wallet');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const walletStat = el.querySelector('[data-testid="wallet-balance"]');
    expect(walletStat).toBeTruthy();
    expect(walletStat!.querySelector('app-rolling-counter')).toBeTruthy();
  });

  it('applies the appReveal entrance host on the header + each tab\'s sections', () => {
    build();
    const el: HTMLElement = fixture.nativeElement;
    const cmp = fixture.componentInstance;
    // Sections are now tab-scoped, so reveal hosts are distributed: the default
    // Subscription tab carries header + Plan tiers = 2.
    expect(el.querySelectorAll('[appReveal]').length).toBe(2);
    // The Usage tab owns the five metering/cost section shells (caps + two
    // forecasts + per-site cost + spend alerts) → header + 5 = 6.
    cmp.setTab('usage');
    fixture.detectChanges();
    expect(el.querySelectorAll('[appReveal]').length).toBe(6);
  });

  it('exposes the WAI-ARIA tablist contract with exactly one selected tab', () => {
    build();
    const el: HTMLElement = fixture.nativeElement;
    const tablist = el.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    expect(tablist!.getAttribute('aria-label')).toBe('Billing sections');
    const tabs = el.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(6);
    const selected = Array.from(tabs).filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.length).toBe(1);
    // The active panel is rendered + labelled by its tab.
    expect(selected[0].getAttribute('aria-controls')).toBe('billing-tab-panel-subscription');
    const panel = el.querySelector('[role="tabpanel"]');
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute('aria-labelledby')).toBe('billing-tab-subscription');
  });

  it('switches the active tab + renders its panel on setTab()', () => {
    build();
    const cmp = fixture.componentInstance;
    expect(cmp.activeTab()).toBe('subscription');
    cmp.setTab('wallet');
    fixture.detectChanges();
    expect(cmp.activeTab()).toBe('wallet');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#billing-tab-panel-wallet')).toBeTruthy();
  });

  it('marks the credit-caps empty-state with role=status for AT announcement', () => {
    build();
    // Per-project caps now live under the Usage tab.
    fixture.componentInstance.setTab('usage');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const empty = el.querySelector('[data-testid="billing-caps-empty"]');
    expect(empty).toBeTruthy();
    expect(empty!.getAttribute('role')).toBe('status');
  });

  it('reflects the Stripe subscription status on the badge (trialing → its own styled state, not the slate fallback)', () => {
    build();
    // Stripe passes status through verbatim; a trial must read as active, not neutral.
    fixture.componentInstance.subStatus.set({ status: 'trialing' } as never);
    fixture.detectChanges();
    const badge = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="subscription-status"]');
    expect(badge).withContext('status badge present').toBeTruthy();
    expect(badge!.getAttribute('data-status')).withContext('trialing now has a per-status style hook').toBe('trialing');
    // and a dunning state is targetable too
    fixture.componentInstance.subStatus.set({ status: 'unpaid' } as never);
    fixture.detectChanges();
    expect(badge!.getAttribute('data-status')).toBe('unpaid');
  });

  it('period label is honest: active RENEWS, cancel_at CANCELS, else ends', () => {
    build();
    const cmp = fixture.componentInstance;
    // Active auto-renewing sub renews on that date — "Period ends" would mislead.
    cmp.subStatus.set({ status: 'active', plan: 'paid', current_period_end: '2026-08-24' } as never);
    expect(cmp.periodLabel()).toBe('Renews');
    fixture.detectChanges();
    const label = (fixture.nativeElement as HTMLElement)
      .querySelector('[data-testid="subscription-period-end"]')
      ?.previousElementSibling?.textContent?.trim();
    expect(label).toBe('Renews');
    // A cancel-at-period-end sub genuinely cancels then.
    cmp.subStatus.set({ status: 'active', plan: 'paid', cancel_at: '2026-08-24' } as never);
    expect(cmp.periodLabel()).toBe('Cancels');
    // A non-active sub falls back to the neutral phrasing.
    cmp.subStatus.set({ status: 'canceled', plan: 'free' } as never);
    expect(cmp.periodLabel()).toBe('Period ends');
  });

  it('the affiliate-payouts empty renders the cyan glyph (cohesion with the other billing empties)', () => {
    build();
    const cmp = fixture.componentInstance;
    cmp.affiliatePayouts.set([]);
    cmp.setTab('affiliates');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const empty = el.querySelector('#billing-tab-panel-affiliates [role="status"]');
    expect(empty).withContext('affiliate payouts empty-state present').toBeTruthy();
    expect(empty!.querySelector('.empty-glyph-sm'))
      .withContext('cyan glyph matches the sibling billing empties (caps/costs/alerts/projects)').toBeTruthy();
  });

  // AL-433 (facet-5 error states): a FAILED /affiliates/payouts fetch used to leave the
  // signal [] → the template rendered "No payouts yet" — a LYING-EMPTY (an error masquerading
  // as "you genuinely have none"). The error handler now flags it + the template shows a
  // graceful error+retry state, never the empty state.
  it('a failed payouts fetch shows an error+retry state, NOT the "no payouts" lying-empty (AL-433)', () => {
    build(true, false, true); // failPayouts → /affiliates/payouts 500s
    const cmp = fixture.componentInstance;
    expect(cmp.payoutsError()).withContext('the error handler flags the failure (no silent [])').toBe(true);
    cmp.setTab('affiliates');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="payouts-error"]'))
      .withContext('graceful error+retry state renders on a failed fetch').toBeTruthy();
    expect(el.querySelector('#billing-tab-panel-affiliates .empty-glyph-sm'))
      .withContext('the "No payouts yet" lying-empty must NOT render on an error').toBeFalsy();
    expect(typeof cmp.retryTabData).withContext('a retry affordance exists').toBe('function');
  });

  // ── Destructive action: removing a spend alert is confirmed ───────────────
  const ALERT = { id: 'al1', name: 'Low balance', threshold_credits: 1000, trigger_type: 'balance_below', email: 'me@x.com' } as never;

  it('removeAlert deletes the alert after the operator confirms', async () => {
    build(); // confirm resolves true
    await fixture.componentInstance.removeAlert(ALERT);
    expect(confirmSpy).toHaveBeenCalled();
    expect(delSpy).toHaveBeenCalledWith('/billing/spend-alerts/al1');
  });

  it('removeAlert does NOT delete when the confirm is cancelled', async () => {
    build(false); // operator cancels
    delSpy.calls.reset(); // ignore any delete fired during ngOnInit load
    await fixture.componentInstance.removeAlert(ALERT);
    expect(confirmSpy).toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  // ── saveAlert wires to the worker createSpendAlertSchema (was 400 on every save) ──
  it('saveAlert POSTs { trigger, email, channels } — NOT the old alert_kind/notify_email that 400d', () => {
    build();
    const postSpy = spyOn(TestBed.inject(ApiService), 'post').and.returnValue(of({ data: {} }));
    const c = fixture.componentInstance;
    // A valid draft (select value IS the worker enum; email valid; positive threshold).
    c.alertDraft = {
      name: 'Runaway guard',
      alert_kind: 'balance_below',
      threshold_credits: 500,
      notify_email: 'ops@megabyte.space',
      notify_via_email: true,
      notify_via_slack: false,
    };
    c.saveAlert();
    const call = postSpy.calls.all().find((x) => x.args[0] === '/billing/spend-alerts');
    expect(call).withContext('saveAlert POSTs to /billing/spend-alerts').toBeTruthy();
    const body = call!.args[1] as Record<string, unknown>;
    expect(body['trigger']).withContext('worker enum `trigger`').toBe('balance_below');
    expect(body['email']).withContext('`email` (not notify_email)').toBe('ops@megabyte.space');
    expect(body['channels']).withContext('channels[] built from the toggles').toEqual(['email']);
    expect('alert_kind' in body).withContext('NEVER the old alert_kind key (worker 400d on it)').toBe(false);
    expect('notify_email' in body).withContext('NEVER the old notify_email key').toBe(false);
  });

  // ── upgrade(): valid success_url + cancel_url payload AND consumes the returned
  //    checkout_url. BOTH bugs made "Upgrade to Pro" dead: (1) { plan:'pro' } payload →
  //    createCheckoutSessionSchema ZodError 400; (2) reading r.data?.url dropped the
  //    handler's r.data.checkout_url → "Checkout opened" toast but nothing opened. ──
  it('upgrade POSTs valid success_url + cancel_url and opens the returned checkout_url', () => {
    build();
    const c = fixture.componentInstance;
    // Spy openStripeUrl so consuming the returned url does NOT trigger a real window
    // redirect (Karma full-page reload).
    const openSpy = spyOn(c as unknown as { openStripeUrl(u: string | undefined | null): boolean }, 'openStripeUrl').and.returnValue(true);
    const postSpy = spyOn(TestBed.inject(ApiService), 'post').and.returnValue(of({ data: { checkout_url: 'https://checkout.stripe.com/c/pay/ok' } }));
    c.upgrade();
    const call = postSpy.calls.all().find((x) => x.args[0] === '/billing/checkout');
    expect(call).withContext('upgrade POSTs to /billing/checkout').toBeTruthy();
    const body = call!.args[1] as Record<string, unknown>;
    expect(typeof body['success_url']).withContext('success_url present').toBe('string');
    expect(typeof body['cancel_url']).withContext('cancel_url present').toBe('string');
    expect(() => new URL(body['success_url'] as string)).withContext('success_url valid URL').not.toThrow();
    expect(() => new URL(body['cancel_url'] as string)).withContext('cancel_url valid URL').not.toThrow();
    expect('plan' in body).withContext('NEVER the old { plan } key').toBe(false);
    expect(openSpy).withContext('opens the returned checkout_url (not the dropped r.data.url)').toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/ok');
  });

  // ── manage(): reads portal_url (not the old url key) + sends a return_url ──
  it('manage POSTs /billing/portal with return_url and consumes r.data.portal_url', () => {
    build();
    const c = fixture.componentInstance;
    // safeStripeUrl → null so the success branch does NOT window.location redirect (reload).
    const safeSpy = spyOn(c as unknown as { safeStripeUrl(u: unknown): string | null }, 'safeStripeUrl').and.returnValue(null);
    const postSpy = spyOn(TestBed.inject(ApiService), 'post').and.returnValue(of({ data: { portal_url: 'https://billing.stripe.com/p/session/x' } }));
    c.manage();
    const call = postSpy.calls.all().find((x) => x.args[0] === '/billing/portal');
    expect(call).withContext('manage POSTs to /billing/portal').toBeTruthy();
    expect((call!.args[1] as Record<string, unknown>)['return_url']).withContext('sends a return_url').toEqual(jasmine.any(String));
    expect(safeSpy).withContext('reads r.data.portal_url (old code read r.data.url → dropped)').toHaveBeenCalledWith('https://billing.stripe.com/p/session/x');
  });

  it('saveAlert maps the rate_spike trigger + both channels when slack is on too', () => {
    build();
    const postSpy = spyOn(TestBed.inject(ApiService), 'post').and.returnValue(of({ data: {} }));
    const c = fixture.componentInstance;
    c.alertDraft = {
      name: 'Burn guard',
      alert_kind: 'rate_spike',
      threshold_credits: 2000,
      notify_email: 'ops@megabyte.space',
      notify_via_email: true,
      notify_via_slack: true,
    };
    c.saveAlert();
    const body = postSpy.calls.all().find((x) => x.args[0] === '/billing/spend-alerts')!.args[1] as Record<string, unknown>;
    expect(body['trigger']).toBe('rate_spike');
    expect(body['channels']).toEqual(['email', 'slack']);
  });

  it('an empty/absent subscription does not fabricate a {plan:"—"} — subStatus stays null + card shows "Free"', () => {
    // build()'s stub returns `{ data: {} }` for /billing/subscription (no real sub).
    build(); // ngOnInit → loadTabData
    const c = fixture.componentInstance;
    expect(c.subStatus())
      .withContext('an empty/null subscription must leave subStatus null, not {plan:"—"}')
      .toBeNull();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="subscription-plan"]')?.textContent?.trim())
      .withContext('a free user must see "Free", not an uninformative em-dash')
      .toBe('Free');
    expect(root.querySelector('[data-testid="subscription-period-end"]')?.textContent?.trim())
      .withContext('a free user has no billing cycle → "No renewal", not a bare em-dash')
      .toBe('No renewal');
  });

  it('a PAID subscription shows the friendly "Pro · $50/mo" label, NOT the raw "paid" enum', () => {
    // Regression guard for the raw-enum leak fixed 2026-08-08: the PLAN field read
    // `subStatus()?.plan ?? planLabel()`, so an active PAID org rendered the raw D1 enum
    // "paid" instead of the human planLabel. Every OTHER plan surface (header pill, "Currently
    // on …", the plan cards) already used planLabel — only this box leaked. Assert the label.
    build();
    const c = fixture.componentInstance;
    c.plan.set('paid');
    c.subStatus.set({ status: 'active', plan: 'paid' } as never);
    fixture.detectChanges();
    const txt = (fixture.nativeElement as HTMLElement)
      .querySelector('[data-testid="subscription-plan"]')
      ?.textContent?.trim();
    expect(txt)
      .withContext('the PLAN field shows the friendly planLabel, not the raw enum')
      .toBe('Pro · $50/mo');
    expect(txt).withContext('the raw "paid" enum must never leak into the UI').not.toBe('paid');
  });

  it('a wallet-load failure shows "—" (null), never a fake $0.00 balance', () => {
    build(true, /* failWallet */ true);
    const c = fixture.componentInstance;
    expect(c.walletBalanceCents()).withContext('null, not 0 → renders "—"').toBeNull();
    expect(c.walletError()).toBeTrue();
  });

  it('a successful wallet load sets a real balance + clears the error', () => {
    build(); // empty {data:{}} → balance_cents ?? 0
    const c = fixture.componentInstance;
    expect(c.walletBalanceCents()).withContext('loaded (0 from empty envelope), not null').toBe(0);
    expect(c.walletError()).toBeFalse();
  });
});

/**
 * WCAG 4.1.2 — the per-site spend-cap number inputs (main cost list + caps modal)
 * had no accessible name, so a screen reader announced "spin button, no cap" with
 * no idea which site. Now each carries a dynamic aria-label naming its site.
 */
describe('AdminBillingComponent (per-site cap input accessible names)', () => {
  const apiStub = {
    get: () => of({ data: {} }), post: () => of({ data: {} }), put: () => of({ data: {} }), delete: () => of({ ok: true }),
    getCostForecast: () => of({ data: { projected_usd: 0, current_period_usd: 0, rolling_daily_avg: 0, days_until_cap_hit: null, plan_cap_usd: 0, percent_of_cap: 0, daily: [], breakdown: [] } }),
  };
  function render(sites: { id: string; slug: string; business_name: string | null }[] = []) {
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: apiStub },
        { provide: AdminStateService, useValue: { sites: signal(sites) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0, dismiss: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    const fx = TestBed.createComponent(AdminBillingComponent);
    fx.detectChanges();
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('the cost-list cap input names its site', () => {
    const fx = render();
    fx.componentInstance.setTab('usage'); // caps list lives under the Usage tab
    fx.componentInstance.siteCosts.set([
      { site_id: 'a', slug: 'alpha', business_name: 'Alpha Co', ai_calls: 0, ai_credits: 0, estimated_cost_micro_usd: 0, bandwidth_bytes: 0 } as never,
    ]);
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('input[aria-label="Monthly spend cap for Alpha Co"]')).withContext('cost-list cap input').toBeTruthy();
  });

  it('the caps-modal cap input names its site', () => {
    const fx = render([{ id: 'b', slug: 'beta', business_name: null }]);
    fx.componentInstance.capsModalOpen.set(true);
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="billing-caps-modal-input-b"]') as HTMLElement | null;
    expect(input).withContext('modal cap input renders').toBeTruthy();
    expect(input!.getAttribute('aria-label')).toBe('Monthly spend cap for beta');
  });
});

/**
 * Stripe Connect onboarding is an UPSELL surface (shown on Free with "Requires
 * the Agency-tier add-on"). A failed onboard used to fall through to ApiService's
 * generic getErrorMessage → a 403 became "You don't have permission to do that."
 * — unhelpful + non-actionable. Now the POST is {silent} and the handler surfaces
 * the server's specific message (or a clear upgrade hint).
 */
describe('AdminBillingComponent (Stripe Connect onboard — useful error, not generic 403)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(postSpy: jasmine.Spy, toastErr: jasmine.Spy): AdminBillingComponent {
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: {
          get: () => of({ data: {} }), post: postSpy, put: () => of({ data: {} }), delete: () => of({ ok: true }),
          getCostForecast: () => of({ data: { projected_usd: 0, current_period_usd: 0, rolling_daily_avg: 0, days_until_cap_hit: null, plan_cap_usd: 0, percent_of_cap: 0, daily: [], breakdown: [] } }),
        } },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: toastErr, dismiss: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    return TestBed.createComponent(AdminBillingComponent).componentInstance;
  }

  it('posts {silent} + surfaces the server message on failure (not the generic 403 toast)', () => {
    const toastErr = jasmine.createSpy('error');
    const post = jasmine.createSpy('post').and.returnValue(throwError(() => ({ error: { error: { message: 'Requires the Agency-tier add-on.' } } })));
    const c = setup(post, toastErr);
    c.onboardStripeConnect();
    expect(post).toHaveBeenCalledWith('/agency/stripe-connect/onboard', {}, { silent: true });
    expect(toastErr).toHaveBeenCalledWith('Requires the Agency-tier add-on.');
    expect(c.onboardingConnect()).toBe(false);
  });

  it('falls back to an actionable upgrade hint when the server gives no message', () => {
    const toastErr = jasmine.createSpy('error');
    const post = jasmine.createSpy('post').and.returnValue(throwError(() => ({ status: 403 })));
    const c = setup(post, toastErr);
    c.onboardStripeConnect();
    expect(toastErr.calls.mostRecent().args[0]).withContext('actionable, names the add-on').toContain('Agency');
  });
});

/**
 * Double-toast guard: upgrade() shows its own specific "Could not start checkout"
 * toast.error, so the /billing/checkout POST must pass {silent:true} — otherwise
 * a failure fires the generic ApiService toast on top of the specific one.
 */
/**
 * The embedded checkout uses the REAL Stripe.js flow: openEmbeddedCheckout fetches a
 * Stripe embedded-session `client_secret` from POST /billing/embedded-checkout and opens
 * the panel; an effect then hands the secret to `StripeService.mountEmbeddedCheckout`
 * which mounts Stripe's own secure iframe (the old placeholder iframed checkout.stripe.com
 * directly — Stripe blocks framing, so it never rendered). closeEmbeddedCheckout tears down.
 */
describe('AdminBillingComponent (embedded checkout = real Stripe.js mount)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeC(post: jasmine.Spy, mount?: jasmine.Spy): AdminBillingComponent {
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: { get: () => of({ data: {} }), post, put: () => of({}), delete: () => of({}) } },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0 } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        {
          provide: StripeService,
          useValue: {
            loadStripe: () => Promise.resolve(null),
            mountEmbeddedCheckout: mount ?? (() => Promise.resolve({ unmount: () => 0, destroy: () => 0 })),
          },
        },
      ],
    });
    return TestBed.createComponent(AdminBillingComponent).componentInstance;
  }

  it('openEmbeddedCheckout fetches a client_secret and opens the panel (no placeholder URL)', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { client_secret: 'cs_test_abc' } }));
    const c = makeC(post);
    c.openEmbeddedCheckout();
    expect(post).toHaveBeenCalledWith(
      '/billing/embedded-checkout',
      jasmine.objectContaining({ plan: 'pro', return_url: jasmine.stringMatching(/\/admin\/billing/) }),
    );
    expect(c.embeddedClientSecret()).withContext('secret stored for Stripe.js').toBe('cs_test_abc');
    expect(c.embeddedCheckoutOpen()).withContext('panel opened').toBeTrue();
  });

  it('openEmbeddedCheckout with no client_secret does NOT open the panel', () => {
    const c = makeC(jasmine.createSpy('post').and.returnValue(of({ data: {} })));
    c.openEmbeddedCheckout();
    expect(c.embeddedClientSecret()).toBeNull();
    expect(c.embeddedCheckoutOpen()).toBeFalse();
  });

  it('closeEmbeddedCheckout clears the secret + closes the panel', () => {
    const c = makeC(jasmine.createSpy('post').and.returnValue(of({ data: { client_secret: 'cs_test_abc' } })));
    c.openEmbeddedCheckout();
    c.closeEmbeddedCheckout();
    expect(c.embeddedCheckoutOpen()).toBeFalse();
    expect(c.embeddedClientSecret()).toBeNull();
  });

  // Every Stripe checkout/portal/onboard redirect (window.open _blank + same-tab
  // fallback) routes through openStripeUrl/safeStripeUrl, which validate https + a
  // stripe.com host before navigating — a manipulated `javascript:` / non-stripe
  // URL must never reach window.open or location.href on the money flow.
  it('safeStripeUrl accepts checkout/billing/connect.stripe.com (https), rejects look-alikes', () => {
    const c = makeC(jasmine.createSpy('post').and.returnValue(of({ data: {} })));
    const v = (c as unknown as { safeStripeUrl(u: string | null): string | null }).safeStripeUrl.bind(c);
    expect(v('https://checkout.stripe.com/c/pay/x')).toBe('https://checkout.stripe.com/c/pay/x');
    expect(v('https://billing.stripe.com/p/x')).not.toBeNull();
    expect(v('https://connect.stripe.com/setup/x')).not.toBeNull();
    expect(v('https://stripe.com/x')).not.toBeNull();
    expect(v('https://evil-stripe.com/x')).withContext('hyphen-prefixed look-alike').toBeNull();
    expect(v('https://stripe.com.evil.com/x')).withContext('suffix look-alike').toBeNull();
    expect(v('http://checkout.stripe.com/x')).withContext('non-https').toBeNull();
    expect(v('javascript:alert(1)')).withContext('js scheme').toBeNull();
    expect(v(null)).toBeNull();
  });

  it('openStripeUrl opens a valid stripe URL in a noopener tab + returns true; refuses an invalid one', () => {
    const c = makeC(jasmine.createSpy('post').and.returnValue(of({ data: {} })));
    const openSpy = spyOn(window, 'open').and.returnValue({} as Window);
    const open = (c as unknown as { openStripeUrl(u: string | null): boolean }).openStripeUrl.bind(c);
    expect(open('https://checkout.stripe.com/c/pay/ok')).toBeTrue();
    expect(openSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/ok', '_blank', 'noopener,noreferrer');
    openSpy.calls.reset();
    expect(open('https://evil-stripe.com/x')).withContext('invalid → no navigation').toBeFalse();
    expect(open(null)).withContext('no url → silent false').toBeFalse();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('AdminBillingComponent (upgrade checkout is {silent})', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('upgrade() POSTs /billing/checkout with {silent:true}', () => {
    // Return NO url so the next-handler hits the safe toast.info branch — never
    // window.open / window.location (a location redirect reloads the Karma page).
    const post = jasmine.createSpy('post').and.returnValue(of({ data: {} }));
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: { get: () => of({ data: {} }), post, put: () => of({}), delete: () => of({}) } },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0 } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    const c = TestBed.createComponent(AdminBillingComponent).componentInstance;
    c.upgrade();
    // {silent:true} is the point of this test; the body must carry the schema-required
    // success_url + cancel_url (NOT the old { plan:'pro' } that 400d — this test previously
    // asserted the broken payload, so it stayed green while checkout was dead in prod).
    expect(post).toHaveBeenCalledWith(
      '/billing/checkout',
      jasmine.objectContaining({ success_url: jasmine.any(String), cancel_url: jasmine.any(String) }),
      { silent: true },
    );
  });
});

/**
 * Double-submit guard on the credit-purchase grid. `topup(bundle)` is the primary
 * money-moving action — a rapid double-click (before Angular re-renders the
 * `[disabled]="buying() === key"` state) MUST NOT fire `/billing/credits/topup`
 * twice, or the operator opens two Stripe checkout sessions (or, in the non-stripe
 * `mode`, double-grants credits). The handler must early-return on its own
 * `buying()` busy signal — mirrors the guard already on `topupCustom()`. The guard
 * must also clear on error so a failed attempt stays retryable.
 */
describe('AdminBillingComponent (credit top-up double-submit guard)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(post: jasmine.Spy): AdminBillingComponent {
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: {
          get: () => of({ data: {} }), post, put: () => of({ data: {} }), delete: () => of({ ok: true }),
          getCostForecast: () => of({ data: { projected_usd: 0, current_period_usd: 0, rolling_daily_avg: 0, days_until_cap_hit: null, plan_cap_usd: 0, percent_of_cap: 0, daily: [], breakdown: [] } }),
        } },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0, dismiss: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    return TestBed.createComponent(AdminBillingComponent).componentInstance;
  }

  it('topup() fires /billing/credits/topup at most once when double-clicked', () => {
    // NEVER observable — the request never resolves, so `buying()` stays set and
    // the second call must early-return instead of POSTing again.
    const post = jasmine.createSpy('post').and.returnValue(new Subject());
    const c = setup(post);
    post.calls.reset(); // ignore any POSTs fired during ngOnInit's loadAll
    c.topup('500');
    c.topup('500'); // immediate second click before the first settles
    expect(post).toHaveBeenCalledTimes(1);
    expect(c.buying()).toBe('500');
  });

  it('topup() clears the busy guard on error so the purchase stays retryable', () => {
    const post = jasmine.createSpy('post').and.returnValue(throwError(() => ({ status: 500 })));
    const c = setup(post);
    post.calls.reset();
    c.topup('500');
    expect(c.buying()).withContext('busy guard cleared after a failed top-up').toBeNull();
    // A retry is allowed — the guard no longer blocks the next POST.
    c.topup('500');
    expect(post).toHaveBeenCalledTimes(2);
  });
});

/**
 * Re-scaffolding contract (2026-06-17): the sections that used to render ALWAYS
 * below the tab nav (Plan tiers, AI Credits, per-project caps, both forecasts,
 * per-site cost, spend alerts) are now each scoped to exactly ONE tab, so every
 * tab is a self-contained page and nothing billing-content leaks outside the
 * active tab. Plan → Subscription · AI Credits → Wallet · caps/forecasts/cost/
 * alerts → Usage.
 */
describe('AdminBillingComponent (each section scoped to its owning tab)', () => {
  function mk(): ComponentFixture<AdminBillingComponent> {
    const apiStub = {
      get: () => of({ data: {} }), post: () => of({ data: {} }), put: () => of({ data: {} }), delete: () => of({ ok: true }),
      getCostForecast: () => of({ data: { projected_usd: 0, current_period_usd: 0, rolling_daily_avg: 0, days_until_cap_hit: null, plan_cap_usd: 0, percent_of_cap: 0, daily: [], breakdown: [] } }),
    };
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: ApiService, useValue: apiStub },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0, dismiss: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    const fx = TestBed.createComponent(AdminBillingComponent);
    fx.detectChanges();
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('Plan tiers (#plan) render only under the Subscription tab', () => {
    const fx = mk();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('#plan')).withContext('Plan visible on the default Subscription tab').toBeTruthy();
    fx.componentInstance.setTab('wallet');
    fx.detectChanges();
    expect(el.querySelector('#plan')).withContext('Plan hidden on Wallet').toBeNull();
  });

  it('AI Credits tiles render only under the Wallet tab', () => {
    const fx = mk();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="billing-tier-5000"]')).withContext('AI Credits hidden on the default Subscription tab').toBeNull();
    fx.componentInstance.setTab('wallet');
    fx.detectChanges();
    expect(el.querySelector('[data-testid="billing-tier-5000"]')).withContext('AI Credits visible on Wallet').toBeTruthy();
  });

  it('caps, both forecasts, per-site cost + spend alerts render only under the Usage tab', () => {
    const fx = mk();
    const el = fx.nativeElement as HTMLElement;
    // Hidden on the default Subscription tab.
    expect(el.querySelector('#caps')).withContext('caps hidden off-tab').toBeNull();
    expect(el.querySelector('[data-testid="forecast-card"]')).withContext('30-day forecast hidden off-tab').toBeNull();
    expect(el.querySelector('[data-testid="forecast-v2-card"]')).withContext('rolling forecast hidden off-tab').toBeNull();
    expect(el.querySelector('[data-testid="billing-spend-alert-create"]')).withContext('spend alerts hidden off-tab').toBeNull();
    fx.componentInstance.setTab('usage');
    fx.detectChanges();
    expect(el.querySelector('#caps')).withContext('caps under Usage').toBeTruthy();
    expect(el.querySelector('[data-testid="forecast-card"]')).withContext('30-day forecast under Usage').toBeTruthy();
    expect(el.querySelector('[data-testid="forecast-v2-card"]')).withContext('rolling forecast under Usage').toBeTruthy();
    expect(el.querySelector('[data-testid="billing-costs-empty"]')).withContext('per-site cost under Usage').toBeTruthy();
    expect(el.querySelector('[data-testid="billing-spend-alert-create"]')).withContext('spend alerts under Usage').toBeTruthy();
  });
});

/**
 * Deep-linkable billing tabs — `?tab=usage` opens that tab (bookmarkable/shareable),
 * unknown values fall back to the default, and a tab click reflects in the URL
 * (replaceUrl + merge, SPA no-reload). Mirrors the site-detail tab pattern.
 */
describe('AdminBillingComponent (deep-linkable tabs)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mk(tabParam: string | null): { c: AdminBillingComponent; nav: jasmine.Spy } {
    const nav = jasmine.createSpy('navigate').and.resolveTo(true);
    // Permissive stub: ngOnInit's loadAll/loadTabData call many ApiService methods
    // (getCostForecast, etc.); a Proxy returns a safe observable for ANY method so
    // these deep-link tests focus on tab state, not the data-load shapes.
    const safe = () => of({ data: [], rows: [], ledger: [], subscription: null, plan: 'free', ok: true, entitlements: { sites: 0, storage_gb: 0, seats: 0 } });
    const apiStub = new Proxy({}, { get: () => jasmine.createSpy().and.callFake(safe) });
    TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        { provide: Router, useValue: { navigate: nav } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: (k: string) => (k === 'tab' ? tabParam : null) } } } },
        { provide: ApiService, useValue: apiStub },
        { provide: AdminStateService, useValue: { sites: signal([]) } },
        { provide: ToastService, useValue: { info: () => 0, success: () => 0, warning: () => 0, error: () => 0, dismiss: () => undefined } },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(AdminBillingComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminBillingComponent).componentInstance;
    c.ngOnInit(); // reads ?tab=
    return { c, nav };
  }

  it('opens the tab named in ?tab= (deep-link / bookmark)', () => {
    expect(mk('usage').c.activeTab()).toBe('usage');
  });

  it('ignores an unknown ?tab= value (falls back to the default subscription tab)', () => {
    expect(mk('bogus').c.activeTab()).toBe('subscription');
  });

  it('setTab reflects the tab in the URL (bookmarkable: replaceUrl + merge)', () => {
    const { c, nav } = mk(null);
    c.setTab('affiliates');
    expect(c.activeTab()).toBe('affiliates');
    const opts = nav.calls.mostRecent().args[1] as { queryParams: unknown; replaceUrl: boolean; queryParamsHandling: string };
    expect(opts.queryParams).toEqual({ tab: 'affiliates' });
    expect(opts.replaceUrl).toBeTrue();
    expect(opts.queryParamsHandling).toBe('merge');
  });
});
