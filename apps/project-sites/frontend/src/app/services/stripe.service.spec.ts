import { TestBed } from '@angular/core/testing';

import { StripeService } from './stripe.service';

/**
 * Locks the fail-soft contract of the lazy Stripe.js loader (CODE-QUALITY sweep, alongside the
 * `any`→narrow-interface typing of the SDK shims). When no publishable key is configured (no
 * `<meta name="x-stripe-pk">`) or Stripe.js can't load, every mount path must return `null`
 * WITHOUT throwing, and must always clear the `loading` signal — the caller decides the UI.
 * A regression that let one of these throw would crash the billing dialog for every visitor.
 */
describe('StripeService (fail-soft when Stripe unavailable)', () => {
  let svc: StripeService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(StripeService);
    // Guarantee the no-PK path (the Karma DOM has no such meta, but be explicit + isolated).
    document.querySelector('meta[name="x-stripe-pk"]')?.remove();
  });

  it('loadStripe() resolves to null when no publishable key is configured', async () => {
    expect(await svc.loadStripe()).toBeNull();
  });

  it('mountEmbeddedCheckout() fails soft to null (never throws) and clears loading', async () => {
    const host = document.createElement('div');
    const res = await svc.mountEmbeddedCheckout('cs_test_x', host);
    expect(res).toBeNull();
    expect(svc.loading()).toBeFalse();
  });

  it('mountExpressCheckout() fails soft to null and clears loading', async () => {
    const host = document.createElement('div');
    const res = await svc.mountExpressCheckout('cs_test_x', host, { onConfirm: () => undefined });
    expect(res).toBeNull();
    expect(svc.loading()).toBeFalse();
  });

  it('mountPaymentElement() fails soft to null and clears loading', async () => {
    const host = document.createElement('div');
    const res = await svc.mountPaymentElement('cs_test_x', host, { onConfirm: () => undefined });
    expect(res).toBeNull();
    expect(svc.loading()).toBeFalse();
  });
});
