import {
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  input,
} from '@angular/core';

/**
 * Toggles the `is-visible` class on the host element when it enters the viewport.
 * Pairs with the `.ps-reveal` utility in `styles.scss`. Respects `prefers-reduced-motion`
 * by adding the class immediately so content is never hidden from users who opted out.
 */
@Directive({
  selector: '[psReveal]',
  standalone: true,
  host: {
    class: 'ps-reveal',
  },
})
export class RevealOnScrollDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Fraction of the element that must be visible before triggering. 0–1. */
  readonly psRevealThreshold = input(0.15);

  /** Optional pixel offset (rootMargin) before triggering. Negative values delay. */
  readonly psRevealMargin = input('0px 0px -8% 0px');

  /** Only fire once. Set to false for repeating reveals. */
  readonly psRevealOnce = input(true);

  private observer?: IntersectionObserver;

  ngOnInit(): void {
    const el = this.host.nativeElement;

    if (typeof window === 'undefined') {
      el.classList.add('is-visible');
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            if (this.psRevealOnce()) {
              this.observer?.unobserve(entry.target);
            }
          } else if (!this.psRevealOnce()) {
            entry.target.classList.remove('is-visible');
          }
        }
      },
      {
        threshold: this.psRevealThreshold(),
        rootMargin: this.psRevealMargin(),
      }
    );

    this.observer.observe(el);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
