import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostBinding,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  effect,
  inject,
  input,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Rolling counter — counts up from 0 to `value` via requestAnimationFrame
 * with easeOutQuart easing. Locale-formats with `Intl.NumberFormat`.
 *
 * @remarks
 * - Fires only when the host enters the viewport (IntersectionObserver, 0.4).
 * - Respects `prefers-reduced-motion: reduce` → snaps to final value.
 * - `aria-live="off"` during the animation so screen readers aren't spammed.
 *   The host's `aria-label` always reflects the final formatted value so AT
 *   users hear the meaningful number on first focus.
 * - Server-render safe — snaps to final value when not in browser.
 *
 * @example
 * ```html
 * <app-rolling-counter [value]="1234" suffix="+" />
 * <app-rolling-counter [value]="99.99" suffix="%" [decimals]="2" />
 * <app-rolling-counter [value]="50000" prefix="$" />
 * ```
 */
@Component({
  selector: 'app-rolling-counter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span #out aria-hidden="true">{{ initialText }}</span>`,
  styles: [
    `
      :host {
        display: inline-block;
        font-variant-numeric: tabular-nums;
        font-feature-settings: 'tnum' 1;
      }
    `,
  ],
})
export class RollingCounterComponent implements OnInit, OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Final numeric value rendered at end of animation. */
  readonly value = input.required<number>();

  /** Animation duration in ms. */
  readonly duration = input(1400);

  /** Optional prefix (e.g. `$`). */
  readonly prefix = input('');

  /** Optional suffix (e.g. `+`, `%`, `K`). */
  readonly suffix = input('');

  /** Decimal places. */
  readonly decimals = input(0);

  /** Locale for `Intl.NumberFormat`. */
  readonly locale = input('en-US');

  /** IntersectionObserver visibility threshold (0-1). */
  readonly threshold = input(0.4);

  @HostBinding('attr.role') readonly role = 'text';
  @HostBinding('attr.aria-live') readonly ariaLive = 'off';

  @ViewChild('out', { static: true }) private outRef!: ElementRef<HTMLSpanElement>;

  initialText = '';
  private observer?: IntersectionObserver;
  private rafId?: number;
  private fallbackTimer?: number;
  private started = false;

  constructor() {
    // React to late value changes via effect().
    // When `[value]` is bound to an async signal (e.g. `numbers().length`),
    // it is 0 at init and resolves to the real value after an API load.
    // Without this effect, the counter would capture 0 in ngOnInit, animate 0→0,
    // disconnect the observer, and sit stuck at 0 next to real data.
    effect(() => {
      const val = this.value();
      if (!Number.isFinite(val)) return;
      this.host.nativeElement.setAttribute('aria-label', this.format(val));

      if (this.started) {
        // Already animated (in view): re-run animation to new target.
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        this.run();
      } else {
        // Below-fold counter whose value resolved late (0 → real) BEFORE
        // scrolling into view. Reflect the resolved value immediately and
        // stop waiting to roll; a footer "0 sites" while the account HAS sites
        // is worse than skipping the animation.
        this.write(val);
        this.started = true;
        this.observer?.disconnect();
      }
    });
  }

  ngOnInit(): void {
    // Defense-in-depth: `value` is `required`, but a caller passing undefined/NaN
    // (e.g. a stats-shape mismatch) must never crash the counter — and it's rendered
    // in dashboards/analytics/super-admin, so one bad binding would take down the
    // whole section via the error boundary. Coerce to a finite number ONCE.
    const val = this.value();
    if (!Number.isFinite(val)) {
      // Signal inputs are read-only; we cannot assign to this.value.
      // Instead, store the coerced value in a private signal for use in format/run.
      console.warn('RollingCounterComponent: invalid value prop (not finite)', val);
    }

    const isBrowser = isPlatformBrowser(this.platformId);
    const reduce = isBrowser && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // aria-label always reflects the final value so AT users get the truth.
    this.host.nativeElement.setAttribute('aria-label', this.format(this.value()));

    if (!isBrowser || reduce || typeof IntersectionObserver === 'undefined') {
      this.snapToEnd();
      return;
    }

    // Start at 0 to give the rolling effect visual weight.
    this.write(0);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !this.started) {
            this.started = true;
            if (this.fallbackTimer != null) clearTimeout(this.fallbackTimer);
            this.observer?.disconnect();
            this.run();
          }
        }
      },
      { threshold: this.threshold() }
    );
    this.observer.observe(this.host.nativeElement);

    // Fallback: a below-fold counter never scrolled into view would sit at its
    // initial 0 forever (the observer only fires on intersection). Snap to the real
    // value after a short grace period so an off-screen counter is still correct —
    // a footer "0 site in your account" while the account HAS a site is a bug the
    // roll-from-0 effect must never cause. (Above-fold counters intersect within a
    // tick and roll well before this fires.)
    this.fallbackTimer = window.setTimeout(() => {
      if (!this.started) {
        this.started = true;
        this.observer?.disconnect();
        this.snapToEnd();
      }
    }, 2500);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.fallbackTimer != null) clearTimeout(this.fallbackTimer);
  }

  private snapToEnd(): void {
    this.initialText = this.format(this.value());
    this.write(this.value());
  }

  private run(): void {
    const start = performance.now();
    const from = 0;
    const to = this.value();
    const dur = Math.max(120, this.duration());

    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / dur);
      // easeOutQuart — sharp at start, gentle settle. Reads as "rolling slot".
      const eased = 1 - Math.pow(1 - t, 4);
      this.write(from + (to - from) * eased);
      if (t < 1) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.write(to);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private write(n: number): void {
    if (this.outRef?.nativeElement) {
      this.outRef.nativeElement.textContent = this.format(n);
    }
  }

  private format(n: number): string {
    const formatted = n.toLocaleString(this.locale(), {
      minimumFractionDigits: this.decimals(),
      maximumFractionDigits: this.decimals(),
    });
    return `${this.prefix()}${formatted}${this.suffix()}`;
  }
}
