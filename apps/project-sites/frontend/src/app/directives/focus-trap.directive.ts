/**
 * Focus-trap directive — keyboard accessibility for modal/popover surfaces.
 *
 * @remarks
 * Applies the WCAG 2.4.3 / 2.4.7 / 2.4.11 contract used by every cmd-palette,
 * dialog and popover in the admin: while activated, Tab/Shift-Tab cycle ONLY
 * between focusable descendants of the host element. The previously-focused
 * element is restored on deactivation (Esc, click-outside, route change).
 *
 * Respects `prefers-reduced-motion` — no animated focus transitions, focus
 * snaps instantly. The directive does not touch DOM motion; it just avoids
 * scheduling animation frames.
 *
 * @example
 * ```html
 * <div class="user-pop" [focusTrap]="userMenuOpen()">…</div>
 * ```
 *
 * Toggle the binding to `true` when the surface opens, `false` when it
 * closes. Focus state is fully managed by the directive.
 *
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
 */
import { Directive, ElementRef, effect, inject, input, type OnDestroy } from '@angular/core';

/** Selector for any element that can receive keyboard focus inside the trap. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

@Directive({
  selector: '[focusTrap]',
  standalone: true,
})
export class FocusTrapDirective implements OnDestroy {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private active = false;
  private previouslyFocused: HTMLElement | null = null;
  private keydownHandler = (ev: KeyboardEvent): void => this.onKeydown(ev);

  /**
   * `true` (or a bare `focusTrap` attribute) begins trapping focus inside the host;
   * `false` releases the trap and restores focus to the previously-focused element.
   */
  readonly focusTrap = input<boolean | ''>(false);

  /**
   * Activate / deactivate the trap when the input toggles — the signal-era equivalent
   * of the old `set focusTrap` setter. The `active` guard preserves the exact
   * activate-once / deactivate-once semantics; `activate()` still defers the initial
   * focus via `queueMicrotask`, so the (already async-aware) spec's `detectChanges()` +
   * `await Promise.resolve()` flow is unchanged. Reading `this.active` (a plain field)
   * is untracked, so the effect re-runs only when `focusTrap()` changes.
   */
  private readonly trapEffect = effect(() => {
    const value = this.focusTrap();
    const enabled = value === true || value === '';
    if (enabled && !this.active) {
      this.activate();
    } else if (!enabled && this.active) {
      this.deactivate();
    }
  });

  ngOnDestroy(): void {
    if (this.active) {
      this.deactivate();
    }
  }

  private activate(): void {
    this.active = true;
    this.previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
    document.addEventListener('keydown', this.keydownHandler, true);
    // Defer initial focus so the open-state DOM has fully rendered.
    queueMicrotask(() => {
      if (!this.active) return;
      const focusables = this.getFocusables();
      const first = focusables[0];
      if (first && !this.host.nativeElement.contains(document.activeElement)) {
        first.focus({ preventScroll: this.prefersReducedMotion() });
      }
    });
  }

  private deactivate(): void {
    this.active = false;
    document.removeEventListener('keydown', this.keydownHandler, true);
    const target = this.previouslyFocused;
    this.previouslyFocused = null;
    if (target && typeof target.focus === 'function' && document.contains(target)) {
      target.focus({ preventScroll: this.prefersReducedMotion() });
    }
  }

  private onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const focusables = this.getFocusables();
    if (focusables.length === 0) {
      ev.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const current = document.activeElement as HTMLElement | null;
    // If focus has escaped outside the trap, snap it back to the first item.
    if (!current || !this.host.nativeElement.contains(current)) {
      ev.preventDefault();
      first.focus({ preventScroll: this.prefersReducedMotion() });
      return;
    }
    if (ev.shiftKey && current === first) {
      ev.preventDefault();
      last.focus({ preventScroll: this.prefersReducedMotion() });
      return;
    }
    if (!ev.shiftKey && current === last) {
      ev.preventDefault();
      first.focus({ preventScroll: this.prefersReducedMotion() });
    }
  }

  private getFocusables(): HTMLElement[] {
    const nodes = this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    return Array.from(nodes).filter((el) => {
      // visibility / display:none / hidden attribute excludes from focus
      if (el.hasAttribute('hidden')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
    });
  }

  private prefersReducedMotion(): boolean {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }
}
