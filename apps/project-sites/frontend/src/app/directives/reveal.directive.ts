import {
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  input,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Module-scoped stagger batch. All `[appReveal]` hosts that initialize within
 * the SAME synchronous render pass (i.e. one route's view) share a staggered
 * sequence; a queued microtask resets the counter before the next pass.
 *
 * Why the reset matters: a plain ever-incrementing counter only resets on a full
 * page RELOAD — but this is a SPA, so navigating between admin routes never
 * reloads. The counter would climb unbounded (e.g. 30 after a few routes), and a
 * freshly-mounted header at index 30 would wait `30 × 80ms = 2.4s` at opacity:0
 * before animating in — the "header doesn't show for a few seconds when I exit
 * My Instances" bug. The per-batch reset keeps every route's stagger starting at
 * 0; `revealMaxDelay` is a hard safety cap on top.
 */
let revealOrderIndex = 0;
let revealResetScheduled = false;

function nextRevealIndex(): number {
  const index = revealOrderIndex++;
  if (!revealResetScheduled && typeof queueMicrotask === 'function') {
    revealResetScheduled = true;
    queueMicrotask(() => {
      revealOrderIndex = 0;
      revealResetScheduled = false;
    });
  }
  return index;
}

/**
 * Test-only: reset the module-scoped stagger counter to a clean batch.
 *
 * @remarks
 * The counter is module-global by design (one stagger sequence per synchronous
 * render pass). In a Karma run every spec shares one module instance, so a spec
 * asserting exact stagger indices MUST reset it in `beforeEach` — otherwise a
 * counter left dirty by an earlier spec (whose microtask reset hadn't flushed at
 * the boundary) offsets the indices and the assertion flakes whenever suite
 * ordering shifts. Not used by production code.
 */
export function resetRevealOrderForTest(): void {
  revealOrderIndex = 0;
  revealResetScheduled = false;
}

/**
 * `appReveal` — first-load fade + 16px translateY animation via Web Animations
 * API, staggered by 80ms in document order. Below-the-fold hosts get
 * IntersectionObserver fallback so they animate when scrolled into view.
 *
 * @remarks
 * - Uses the Web Animations API (`Element.animate`) — no CSS keyframes needed.
 * - Above-the-fold (initial viewport) hosts animate immediately, staggered.
 * - Below-the-fold hosts wait until IntersectionObserver fires, then animate.
 * - Respects `prefers-reduced-motion: reduce` → host stays at final state,
 *   no animation. Never hides content from reduced-motion users.
 * - Safe-by-default — no FOUC, no layout shift. The host starts visible at
 *   the final transform; the animation runs forward over 520ms.
 * - SSR-safe via PLATFORM_ID guard.
 *
 * @example
 * ```html
 * <section appReveal>...</section>
 * <div appReveal [revealDelay]="120">Custom additional delay (ms)</div>
 * ```
 */
@Directive({
  selector: '[appReveal]',
  standalone: true,
})
export class RevealDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly platformId = inject(PLATFORM_ID);

  /** Additional delay (ms) on top of the auto document-order stagger. */
  readonly revealDelay = input(0);

  /** Per-host stagger increment (ms). Default 80ms reads as graceful sequence. */
  readonly revealStep = input(80);

  /** Total animation duration (ms). */
  readonly revealDuration = input(520);

  /** Pixel rise applied to the start frame. */
  readonly revealOffset = input(16);

  /** IntersectionObserver threshold for below-the-fold hosts. */
  readonly revealThreshold = input(0.12);

  /** Hard cap (ms) on the computed stagger delay — a safety net so a host can
   *  never sit invisible for "seconds" even in a very large batch. */
  readonly revealMaxDelay = input(480);

  private observer?: IntersectionObserver;
  private animation?: Animation;

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // Final state, no animation. Never hide content from reduced-motion users.
      return;
    }

    const el = this.host.nativeElement;
    const myIndex = nextRevealIndex();
    const computedDelay = Math.min(
      myIndex * this.revealStep() + this.revealDelay(),
      this.revealMaxDelay(),
    );

    // Decide: animate on first paint (in viewport) OR wait for scroll.
    const inViewport = this.isInViewport(el);

    if (inViewport || typeof IntersectionObserver === 'undefined') {
      this.play(computedDelay);
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.observer?.disconnect();
            // Smaller delay once scrolled in — the user is already looking.
            this.play(0);
          }
        }
      },
      { threshold: this.revealThreshold(), rootMargin: '0px 0px -6% 0px' },
    );
    this.observer.observe(el);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.animation?.cancel();
  }

  private play(delay: number): void {
    try {
      this.animation = this.host.nativeElement.animate(
        [
          { opacity: 0, transform: `translate3d(0, ${this.revealOffset()}px, 0)` },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: this.revealDuration(),
          delay,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'backwards',
        },
      );
    } catch {
      // Web Animations API not available — leave host at final state.
    }
  }

  private isInViewport(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.top < vh && rect.bottom > 0;
  }
}
