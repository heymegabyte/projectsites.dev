/**
 * @module services/stripe
 *
 * @description
 * Lazy-loader and mount-point manager for Stripe.js. Handles three flows:
 *
 * 1. **Embedded Checkout** (`mountEmbeddedCheckout`) — full Stripe-hosted widget,
 *    used by the legacy `stripe-checkout-dialog.component.ts` for subscription
 *    upgrades. Always includes Link as a payment method.
 * 2. **Express Checkout Element** (`mountExpressCheckout`) — minimal-widget
 *    1-click row showing Link / Apple Pay / Google Pay buttons inline. Used
 *    anywhere we want a payment to "just happen" without showing a card form.
 * 3. **Payment Element + Link Auth** (`mountPaymentElement`) — full inline
 *    payment form with Link Authentication on top (email field) so returning
 *    Link customers see their saved methods immediately.
 *
 * Keeps Stripe.js out of the initial bundle — only fetches `js.stripe.com/v3/`
 * when the user actually opens a checkout flow.
 *
 * @remarks
 * - Publishable key read from `<meta name="x-stripe-pk">` (injected by the
 *   worker per-environment) so the bundle is environment-agnostic.
 * - All errors surface as `null` returns + `console.warn` — caller decides UI.
 * - Mounted elements track `unmount()` callbacks for clean teardown.
 *
 * @example
 * ```ts
 * // 1-click row (Apple Pay / Google Pay / Link)
 * const express = await stripe.mountExpressCheckout(clientSecret, hostEl, {
 *   onConfirm: (event) => navigate('/billing/success'),
 *   onCancel: () => toast.info('Cancelled'),
 * });
 * ```
 */

import { Injectable, signal } from '@angular/core';

declare global {
  interface Window {
    // The Stripe global is loaded from js.stripe.com/v3/. Typed loosely to
    // avoid pulling @stripe/stripe-js types into the bundle.
    Stripe?: (pk: string) => StripeInstance;
  }
}

// Narrow local typings for the SLICE of Stripe.js we actually call — full type safety at every
// call site WITHOUT pulling the heavy @stripe/stripe-js types into the bundle (structural: the
// runtime objects carry more; we declare only what we use). No `any`, no eslint-disables —
// CODE-QUALITY sweep replaced the loose SDK shims with honest shapes matching real usage.

/** A mounted Stripe Element / controller: mount + teardown + event subscription. */
interface StripeElement {
  mount(el: HTMLElement): void;
  unmount(): void;
  destroy(): void;
  on(event: string, handler: (event?: unknown) => void): void;
}

/** The Elements group factory returned by `stripe.elements(...)`. */
interface StripeElements {
  create(type: string, options?: Record<string, unknown>): StripeElement;
}

/** The embedded-checkout controller returned by `initEmbeddedCheckout(...)`. */
interface StripeEmbeddedCheckout {
  mount(el: HTMLElement): void;
  unmount(): void;
  destroy(): void;
}

interface StripeInstance {
  initEmbeddedCheckout(options: { clientSecret: string }): Promise<StripeEmbeddedCheckout>;
  elements(options: Record<string, unknown>): StripeElements;
  confirmPayment(options: Record<string, unknown>): Promise<{ error?: { message: string } }>;
}

interface MountedElement {
  unmount(): void;
  destroy(): void;
}

export interface ExpressCheckoutCallbacks {
  /** Fired when the user taps Apple Pay / Google Pay / Link and the charge confirms. */
  onConfirm: (event: { paymentIntent?: { id: string; status: string } }) => void;
  /** User dismissed the express sheet before completing. */
  onCancel?: () => void;
  /** Fatal Stripe error. */
  onError?: (err: { message: string }) => void;
}

export interface PaymentElementCallbacks extends ExpressCheckoutCallbacks {
  /** Stripe.js loaded successfully and the form is interactive. */
  onReady?: () => void;
}

@Injectable({ providedIn: 'root' })
export class StripeService {
  private stripe: StripeInstance | null = null;
  private loadPromise: Promise<StripeInstance | null> | null = null;

  /** True while Stripe.js is being fetched or a checkout is being initialized. */
  loading = signal(false);

  /** Returns the publishable key from `<meta name="x-stripe-pk">` or null. */
  private getPublishableKey(): string | null {
    const meta = document.querySelector('meta[name="x-stripe-pk"]');
    return meta?.getAttribute('content') || null;
  }

  /**
   * Load Stripe.js (idempotent — concurrent callers share one inflight promise).
   * Caches the instance for the page lifetime.
   *
   * @returns Stripe instance, or `null` if script load failed / no PK configured.
   */
  async loadStripe(): Promise<StripeInstance | null> {
    if (this.stripe) return this.stripe;
    if (this.loadPromise) return this.loadPromise;

    const pk = this.getPublishableKey();
    if (!pk) {
      console.warn('[StripeService] No publishable key in <meta name="x-stripe-pk">');
      return null;
    }

    this.loadPromise = new Promise<StripeInstance | null>((resolve) => {
      if (window.Stripe) {
        this.stripe = window.Stripe(pk);
        resolve(this.stripe);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.onload = () => {
        if (window.Stripe) {
          this.stripe = window.Stripe(pk);
          resolve(this.stripe);
        } else {
          resolve(null);
        }
      };
      script.onerror = () => {
        console.warn('[StripeService] Failed to load Stripe.js');
        resolve(null);
      };
      document.head.appendChild(script);
    });
    return this.loadPromise;
  }

  /**
   * Mount embedded Stripe Checkout (hosted widget). Used by the subscription
   * upgrade dialog. Link is enabled by virtue of the server creating the
   * session with `payment_method_types: ['card', 'link']`.
   */
  async mountEmbeddedCheckout(
    clientSecret: string,
    container: HTMLElement,
  ): Promise<StripeEmbeddedCheckout | null> {
    this.loading.set(true);
    try {
      const stripe = await this.loadStripe();
      if (!stripe) return null;
      const checkout = await stripe.initEmbeddedCheckout({ clientSecret });
      checkout.mount(container);
      return checkout;
    } catch (err) {
      console.warn('[StripeService] Embedded checkout failed:', err);
      return null;
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Mount the **Express Checkout Element** — the minimal-widget 1-click row.
   * Shows Apple Pay / Google Pay / Link buttons. User taps one and the charge
   * completes inline (no redirect, no modal). The element auto-hides if the
   * browser supports no express wallets.
   *
   * Requires a PaymentIntent client_secret created with
   * `automatic_payment_methods: { enabled: true }` so Stripe auto-picks Link.
   *
   * @param clientSecret  PaymentIntent client_secret from worker.
   * @param container     Host element (e.g. div in your dialog).
   * @param callbacks     Event handlers.
   * @returns Mounted element with `.destroy()`; null on failure.
   */
  async mountExpressCheckout(
    clientSecret: string,
    container: HTMLElement,
    callbacks: ExpressCheckoutCallbacks,
  ): Promise<MountedElement | null> {
    this.loading.set(true);
    try {
      const stripe = await this.loadStripe();
      if (!stripe) return null;
      const elements: StripeElements = stripe.elements({
        clientSecret,
        appearance: this.appearance(),
      });
      const ec: StripeElement = elements.create('expressCheckout', {
        buttonHeight: 48,
        buttonTheme: { applePay: 'black', googlePay: 'black', paypal: 'black' },
        paymentMethods: { applePay: 'always', googlePay: 'always', link: 'auto' },
      });
      ec.on('confirm', async () => {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.href },
          redirect: 'if_required',
        });
        if (result.error) {
          callbacks.onError?.({ message: result.error.message });
        } else {
          callbacks.onConfirm({});
        }
      });
      ec.on('cancel', () => callbacks.onCancel?.());
      ec.mount(container);
      // `StripeElement` is a structural superset of `MountedElement` (unmount + destroy) — no cast.
      return ec;
    } catch (err) {
      console.warn('[StripeService] Express checkout failed:', err);
      return null;
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Mount **Link Authentication + Payment Element** — full inline form.
   * Email-first: returning Link users see their saved cards instantly,
   * new users get the card form with Link auto-save toggle.
   */
  async mountPaymentElement(
    clientSecret: string,
    container: HTMLElement,
    callbacks: PaymentElementCallbacks,
  ): Promise<{ confirm: () => Promise<void>; destroy: () => void } | null> {
    this.loading.set(true);
    try {
      const stripe = await this.loadStripe();
      if (!stripe) return null;
      const elements: StripeElements = stripe.elements({
        clientSecret,
        appearance: this.appearance(),
      });
      // Link Auth Element + Payment Element stacked. Link returns matching users instantly.
      const linkAuth: StripeElement = elements.create('linkAuthentication');
      const linkAuthHost = document.createElement('div');
      linkAuthHost.style.marginBottom = '12px';
      container.appendChild(linkAuthHost);
      linkAuth.mount(linkAuthHost);

      const payment: StripeElement = elements.create('payment', {
        layout: { type: 'accordion', defaultCollapsed: false, radios: false, spacedAccordionItems: true },
        wallets: { applePay: 'auto', googlePay: 'auto' },
      });
      const payHost = document.createElement('div');
      container.appendChild(payHost);
      payment.mount(payHost);
      payment.on('ready', () => callbacks.onReady?.());

      return {
        confirm: async () => {
          const result = await stripe.confirmPayment({
            elements,
            confirmParams: { return_url: window.location.href },
            redirect: 'if_required',
          });
          if (result.error) callbacks.onError?.({ message: result.error.message });
          else callbacks.onConfirm({});
        },
        destroy: () => {
          try {
            linkAuth.unmount();
            payment.unmount();
            linkAuthHost.remove();
            payHost.remove();
          } catch {
            /* cleanup errors are non-critical */
          }
        },
      };
    } catch (err) {
      console.warn('[StripeService] Payment element failed:', err);
      return null;
    } finally {
      this.loading.set(false);
    }
  }

  /** Dark-theme Stripe Elements appearance matching our brand tokens. */
  private appearance() {
    return {
      theme: 'night',
      variables: {
        colorPrimary: '#00e5ff',
        colorBackground: '#0a0a18',
        colorText: '#f4f4ff',
        colorDanger: '#ff6b8b',
        fontFamily: '"Space Grotesk", system-ui, sans-serif',
        spacingUnit: '4px',
        borderRadius: '12px',
      },
    } as const;
  }
}
