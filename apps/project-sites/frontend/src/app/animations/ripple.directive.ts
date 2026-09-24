import {
  Directive,
  ElementRef,
  HostListener,
  OnInit,
  inject,
  input,
} from '@angular/core';

/**
 * Material-style click ripple emitted at the pointer position. Skipped under
 * `prefers-reduced-motion: reduce`. The host element receives `position: relative`
 * and `overflow: hidden` so the ripple is contained.
 */
@Directive({
  selector: '[psRipple]',
  standalone: true,
})
export class RippleDirective implements OnInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly psRippleColor = input('rgba(0, 229, 255, 0.35)');
  readonly psRippleDuration = input(520);

  ngOnInit(): void {
    const el = this.host.nativeElement;
    const computed = getComputedStyle(el);
    if (computed.position === 'static') {
      el.style.position = 'relative';
    }
    el.style.overflow = el.style.overflow || 'hidden';
  }

  @HostListener('pointerdown', ['$event'])
  onPointerDown(event: PointerEvent): void {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const el = this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.6;

    const ripple = document.createElement('span');
    ripple.className = 'ps-ripple-ink';
    ripple.style.cssText = `
      position: absolute;
      pointer-events: none;
      border-radius: 50%;
      width: ${size}px;
      height: ${size}px;
      left: ${event.clientX - rect.left - size / 2}px;
      top: ${event.clientY - rect.top - size / 2}px;
      background: ${this.psRippleColor()};
      transform: scale(0);
      opacity: 0.6;
      animation: psRippleInk ${this.psRippleDuration()}ms cubic-bezier(0.2, 0, 0, 1) forwards;
      will-change: transform, opacity;
      z-index: 0;
    `;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  }
}
