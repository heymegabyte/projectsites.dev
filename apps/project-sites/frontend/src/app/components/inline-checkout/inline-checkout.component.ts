/**
 * @module components/inline-checkout
 *
 * @description
 * Inline 1-click Stripe checkout. Renders the Express Checkout Element
 * (Apple Pay / Google Pay / Link row) at the top and a collapsed Payment
 * Element + Link Authentication accordion below for card fallback.
 *
 * Drop this wherever a 1-click purchase belongs — credit-pack pages,
 * wallet topups, in-context upgrades. No modal needed; the whole surface
 * lives in the page flow.
 *
 * @example
 * ```html
 * <app-inline-checkout
 *   [amountCents]="2500"
 *   description="$25 credits"
 *   [siteId]="site().id"
 *   (succeeded)="onCreditsAdded($event)"
 * />
 * ```
 */
import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
  signal,
  type AfterViewInit,
  type OnDestroy,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { StripeService } from '../../services/stripe.service';
import { ToastService } from '../../services/toast.service';

interface PaymentIntentResponse {
  client_secret: string;
  publishable_key: string;
  payment_intent_id: string;
}

@Component({
  selector: 'app-inline-checkout',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="inline-checkout" data-testid="inline-checkout">
      <header class="inline-checkout__header">
        <span class="inline-checkout__amount">\${{ amountUsd }}</span>
        @if (description) {
          <span class="inline-checkout__desc">{{ description }}</span>
        }
      </header>

      @if (isLocked()) {
        <!-- Precondition not met — show WHY + a one-click upgrade CTA, never a
             Pay button that would fail server-side (fire-69). -->
        <div class="inline-checkout__locked" data-testid="inline-checkout-locked" role="note">
          <p class="inline-checkout__locked-msg">{{ lockedReason }}</p>
          <a
            class="inline-checkout__upgrade"
            data-testid="inline-checkout-upgrade"
            [attr.href]="upgradeHref"
            [attr.aria-label]="upgradeLabel"
            >{{ upgradeLabel }} →</a
          >
        </div>
      } @else {
        @if (loading()) {
          <div class="inline-checkout__loading" data-testid="inline-checkout-loading">
            <span class="inline-checkout__spinner"></span>
            <span>Loading 1-click checkout…</span>
          </div>
        }

        @if (error(); as err) {
          <div class="inline-checkout__error" role="alert" data-testid="inline-checkout-error">
            <span>{{ err }}</span>
            <button type="button" class="inline-checkout__retry" (click)="retry()">Try again</button>
          </div>
        }

        <div #expressHost class="inline-checkout__express" data-testid="inline-checkout-express"></div>

        @if (!loading() && !error()) {
          <div class="inline-checkout__divider"><span>or pay with card</span></div>
        }

        <div #paymentHost class="inline-checkout__payment" data-testid="inline-checkout-payment"></div>

        @if (!loading() && !error()) {
          <button
            type="button"
            class="inline-checkout__pay"
            data-testid="inline-checkout-pay"
            [disabled]="confirming()"
            (click)="payWithCard()"
          >
            {{ confirming() ? 'Processing…' : 'Pay $' + amountUsd }}
          </button>
        }
      }
    </section>
  `,
  styles: [
    `
      .inline-checkout {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px;
        background: var(--ps-bg, #0a0a18);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        border-radius: var(--ps-radius-xl, 22px);
        max-width: 480px;
        margin: 0 auto;
      }
      .inline-checkout__header {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .inline-checkout__amount {
        font-family: 'Space Grotesk', system-ui, sans-serif;
        font-weight: 700;
        font-size: 1.875rem;
        font-variant-numeric: tabular-nums;
        color: var(--ps-ink, #f4f4ff);
      }
      .inline-checkout__desc {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        font-size: 0.875rem;
      }
      .inline-checkout__loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 32px 0;
        color: color-mix(in oklch, var(--ps-ink) 60%, transparent);
        font-size: 0.875rem;
      }
      .inline-checkout__spinner {
        width: 16px;
        height: 16px;
        border: 2px solid color-mix(in oklch, var(--ps-accent) 30%, transparent);
        border-top-color: var(--ps-accent);
        border-radius: 50%;
        animation: inline-checkout-spin 0.7s linear infinite;
      }
      @keyframes inline-checkout-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .inline-checkout__spinner {
          animation-duration: 1.4s;
        }
      }
      .inline-checkout__error {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: color-mix(in oklch, #ff6b8b 12%, transparent);
        border: 1px solid color-mix(in oklch, #ff6b8b 35%, transparent);
        border-radius: 12px;
        color: #ff6b8b;
        font-size: 0.875rem;
      }
      .inline-checkout__retry {
        background: transparent;
        border: 1px solid currentColor;
        color: inherit;
        padding: 4px 10px;
        border-radius: 8px;
        font-size: 0.75rem;
        cursor: pointer;
      }
      .inline-checkout__divider {
        display: flex;
        align-items: center;
        gap: 10px;
        color: color-mix(in oklch, var(--ps-ink) 65%, transparent);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .inline-checkout__divider::before,
      .inline-checkout__divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: color-mix(in oklch, var(--ps-ink) 12%, transparent);
      }
      .inline-checkout__pay {
        margin-top: 4px;
        padding: 14px 18px;
        background: var(--ps-accent, #00e5ff);
        color: #060610;
        border: 0;
        border-radius: 12px;
        font-weight: 700;
        font-size: 1rem;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease;
      }
      .inline-checkout__pay:hover:not(:disabled) {
        transform: translateY(-1px);
      }
      .inline-checkout__pay:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      /* Locked precondition — reason + one-click upgrade CTA (fire-69). */
      .inline-checkout__locked {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 18px;
        border-radius: 14px;
        border: 1px dashed color-mix(in oklch, var(--ps-accent, #00e5ff) 42%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 7%, transparent);
      }
      .inline-checkout__locked-msg {
        margin: 0;
        font-size: 0.9rem;
        line-height: 1.45;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent);
      }
      .inline-checkout__upgrade {
        align-self: flex-start;
        background: var(--ps-accent, #00e5ff);
        color: #060610;
        font-weight: 700;
        font-size: 0.9rem;
        text-decoration: none;
        padding: 10px 16px;
        border-radius: 999px;
        transition: filter 120ms ease;
      }
      .inline-checkout__upgrade:hover {
        filter: brightness(1.08);
      }
      .inline-checkout__upgrade:focus-visible {
        outline: 2px solid var(--ps-ink, #f4f4ff);
        outline-offset: 2px;
      }
    `,
  ],
})
export class InlineCheckoutComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) amountCents!: number;
  @Input() currency = 'usd';
  @Input() description?: string;
  @Input() siteId?: string;
  @Input() saveForFutureUse = true;
  /**
   * When set (a server-side precondition isn't met — seat limit, plan tier,
   * missing config), the checkout shows this reason + a one-click upgrade CTA
   * instead of a Pay button that would fail. A doomed payment control is never
   * rendered (fire-69).
   */
  @Input() lockedReason?: string;
  /** Where the lock CTA routes (default: the billing/upgrade surface). */
  @Input() upgradeHref = '/admin/billing';
  /** Label for the lock CTA. */
  @Input() upgradeLabel = 'Upgrade to unlock';

  @Output() readonly succeeded = new EventEmitter<{ paymentIntentId: string }>();
  @Output() readonly cancelled = new EventEmitter<void>();
  @Output() readonly failed = new EventEmitter<{ message: string }>();

  // `static: false` — the hosts now live inside the `@else` (non-locked) branch,
  // so they aren't in the DOM at construction; they resolve by ngAfterViewInit,
  // which is where mountAll() first reads them. A locked checkout never reads them.
  @ViewChild('expressHost') expressHost!: ElementRef<HTMLElement>;
  @ViewChild('paymentHost') paymentHost!: ElementRef<HTMLElement>;

  private readonly api = inject(ApiService);
  private readonly stripe = inject(StripeService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly confirming = signal(false);
  readonly error = signal<string | null>(null);

  private expressMount: { destroy(): void } | null = null;
  private paymentMount: { confirm: () => Promise<void>; destroy: () => void } | null = null;
  private clientSecret: string | null = null;
  private paymentIntentId: string | null = null;

  get amountUsd(): string {
    return (this.amountCents / 100).toFixed(this.amountCents % 100 ? 2 : 0);
  }

  /** True when a precondition reason is set — show the lock surface, never Stripe. */
  isLocked(): boolean {
    return !!this.lockedReason && this.lockedReason.trim().length > 0;
  }

  async ngAfterViewInit(): Promise<void> {
    await this.mountAll();
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  retry(): void {
    this.error.set(null);
    this.mountAll();
  }

  private async mountAll(): Promise<void> {
    // Locked precondition → never mount a doomed payment field. The template
    // shows the reason + upgrade CTA instead (fire-69).
    if (this.isLocked()) {
      this.teardown();
      this.loading.set(false);
      this.error.set(null);
      return;
    }
    this.loading.set(true);
    this.teardown();
    try {
      const resp = await firstValueFrom(
        this.api.post<{ data: PaymentIntentResponse }>('/billing/payment-intent', {
          amount_cents: this.amountCents,
          currency: this.currency,
          description: this.description,
          site_id: this.siteId,
          save_for_future_use: this.saveForFutureUse,
        }),
      );
      this.clientSecret = resp.data.client_secret;
      this.paymentIntentId = resp.data.payment_intent_id;

      this.expressMount = await this.stripe.mountExpressCheckout(
        this.clientSecret,
        this.expressHost.nativeElement,
        {
          onConfirm: () => this.handleSuccess(),
          onCancel: () => this.cancelled.emit(),
          onError: (err) => this.handleError(err.message),
        },
      );

      this.paymentMount = await this.stripe.mountPaymentElement(
        this.clientSecret,
        this.paymentHost.nativeElement,
        {
          onConfirm: () => this.handleSuccess(),
          onError: (err) => this.handleError(err.message),
          onReady: () => this.loading.set(false),
        },
      );

      // Both mounts return null when Stripe.js can't load (blocked / offline /
      // missing publishable key). Surface that as an error so the user gets a
      // retry affordance instead of an infinite spinner.
      if (!this.expressMount && !this.paymentMount) {
        this.error.set('Could not load Stripe — check your network and try again.');
        this.loading.set(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Checkout failed to load';
      this.error.set(msg);
      this.loading.set(false);
    }
  }

  async payWithCard(): Promise<void> {
    if (!this.paymentMount) return;
    this.confirming.set(true);
    try {
      await this.paymentMount.confirm();
    } finally {
      this.confirming.set(false);
    }
  }

  private handleSuccess(): void {
    if (!this.paymentIntentId) return;
    this.toast.success('Payment confirmed');
    this.succeeded.emit({ paymentIntentId: this.paymentIntentId });
  }

  private handleError(message: string): void {
    this.error.set(message);
    this.failed.emit({ message });
  }

  private teardown(): void {
    try {
      this.expressMount?.destroy?.();
    } catch {
      /* cleanup */
    }
    try {
      this.paymentMount?.destroy?.();
    } catch {
      /* cleanup */
    }
    this.expressMount = null;
    this.paymentMount = null;
  }
}
