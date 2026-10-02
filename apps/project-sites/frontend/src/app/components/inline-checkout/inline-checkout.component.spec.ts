import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { InlineCheckoutComponent } from './inline-checkout.component';
import { ApiService } from '../../services/api.service';
import { StripeService } from '../../services/stripe.service';
import { ToastService } from '../../services/toast.service';

/**
 * Payment-surface contract for the inline checkout (revenue-critical, untested).
 * Locks: the displayed amount is exact (whole dollars without cents, cents with
 * 2 dp — a wrong figure here is a trust/billing bug); a failure surfaces the
 * message + emits `failed`; and a success NEVER emits/toasts without a real
 * payment-intent id (guard against signalling a payment that didn't happen).
 * overrideComponent strips the template (no detectChanges) so ngAfterViewInit's
 * Stripe.js mount never fires and the pure logic is tested in isolation.
 */
function make(): { c: InlineCheckoutComponent; success: jasmine.Spy } {
  const success = jasmine.createSpy('success');
  TestBed.configureTestingModule({
    imports: [InlineCheckoutComponent],
    providers: [
      { provide: ApiService, useValue: { post: () => of({ data: {} }) } },
      {
        provide: StripeService,
        useValue: {
          mountExpressCheckout: () => Promise.resolve(null),
          mountPaymentElement: () => Promise.resolve(null),
        },
      },
      { provide: ToastService, useValue: { success, error: jasmine.createSpy('error') } },
    ],
  });
  TestBed.overrideComponent(InlineCheckoutComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(InlineCheckoutComponent).componentInstance, success };
}

describe('InlineCheckoutComponent (payment display + emit contract)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('amountUsd shows whole dollars without cents, and cents with 2 decimals', () => {
    const { c } = make();
    c.amountCents = 2500; expect(c.amountUsd).toBe('25');
    c.amountCents = 2550; expect(c.amountUsd).toBe('25.50');
    c.amountCents = 999;  expect(c.amountUsd).toBe('9.99');
    c.amountCents = 100;  expect(c.amountUsd).toBe('1');
    c.amountCents = 105;  expect(c.amountUsd).toBe('1.05');
  });

  it('handleError surfaces the message + emits failed', () => {
    const { c } = make();
    let failed: { message: string } | undefined;
    c.failed.subscribe((e) => (failed = e));
    (c as unknown as { handleError(m: string): void }).handleError('card declined');
    expect(c.error()).toBe('card declined');
    expect(failed).toEqual({ message: 'card declined' });
  });

  it('handleSuccess does NOT emit or toast without a payment-intent (no phantom success)', () => {
    const { c, success } = make();
    let emitted = false;
    c.succeeded.subscribe(() => (emitted = true));
    (c as unknown as { handleSuccess(): void }).handleSuccess();
    expect(emitted).withContext('cannot signal a payment that has no intent').toBeFalse();
    expect(success).not.toHaveBeenCalled();
  });

  it('handleSuccess emits the paymentIntentId + toasts once an intent exists', () => {
    const { c, success } = make();
    let evt: { paymentIntentId: string } | undefined;
    c.succeeded.subscribe((e) => (evt = e));
    (c as unknown as { paymentIntentId: string }).paymentIntentId = 'pi_123';
    (c as unknown as { handleSuccess(): void }).handleSuccess();
    expect(evt).toEqual({ paymentIntentId: 'pi_123' });
    expect(success).toHaveBeenCalled();
  });

  /**
   * fire-69 — no-doomed-control: when a `lockedReason` is supplied (a server-side
   * precondition isn't met — seat limit, plan tier, missing config), the checkout
   * must NOT mount Stripe or show a Pay button that will fail. Instead it shows the
   * reason + a one-click upgrade CTA. `locked` gates both the render and the mount.
   */
  describe('fire-69 — locked precondition shows reason + CTA, never a doomed Pay button', () => {
    it('isLocked reflects a non-empty lockedReason', () => {
      const { c } = make();
      expect(c.isLocked()).withContext('unlocked by default').toBeFalse();
      c.lockedReason = 'Upgrade to Pro to buy more credits';
      expect(c.isLocked()).withContext('locked once a reason is set').toBeTrue();
    });

    it('a locked checkout never attempts a Stripe mount', async () => {
      const mountSpy = jasmine.createSpy('mountPaymentElement').and.resolveTo(null);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [InlineCheckoutComponent],
        providers: [
          { provide: ApiService, useValue: { post: () => of({ data: {} }) } },
          {
            provide: StripeService,
            useValue: {
              mountExpressCheckout: jasmine.createSpy('mx').and.resolveTo(null),
              mountPaymentElement: mountSpy,
            },
          },
          { provide: ToastService, useValue: { success: () => {}, error: () => {} } },
        ],
      });
      TestBed.overrideComponent(InlineCheckoutComponent, { set: { template: '<div></div>', imports: [] } });
      const c = TestBed.createComponent(InlineCheckoutComponent).componentInstance;
      c.amountCents = 2500;
      c.lockedReason = 'Seat limit reached — upgrade to add more';
      await (c as unknown as { mountAll(): Promise<void> }).mountAll();
      expect(mountSpy).withContext('locked surface must not mount a doomed payment field').not.toHaveBeenCalled();
    });
  });
});
