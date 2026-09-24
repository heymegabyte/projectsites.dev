import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  PLATFORM_ID,
  ViewChild,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Before/after image comparison slider.
 *
 * @remarks
 * - Pointer (mouse + touch + pen) drag on the divider OR anywhere on the surface.
 * - Keyboard: Left/Right arrow ±2%, Shift+Arrow ±10%, Home/End to ends.
 * - Touch-friendly — `touch-action: none` on the surface so vertical scroll
 *   doesn't conflict with horizontal drag.
 * - ARIA: role="slider", aria-valuenow/min/max, aria-label.
 * - Respects `prefers-reduced-motion` → no transition on the clip-path.
 *
 * @example
 * ```html
 * <app-before-after-slider
 *   beforeSrc="/images/generic.png"
 *   afterSrc="/images/projectsites.png"
 *   beforeLabel="Generic competitor"
 *   afterLabel="Built with projectsites.dev"
 * />
 * ```
 */
@Component({
  selector: 'app-before-after-slider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure
      #surface
      class="bas-surface"
      (pointerdown)="onPointerDown($event)"
      (pointermove)="onPointerMove($event)"
      (pointerup)="onPointerUp($event)"
      (pointercancel)="onPointerUp($event)"
    >
      <img
        class="bas-img bas-img--after"
        [src]="afterSrc()"
        [alt]="afterLabel()"
        draggable="false"
      />
      <img
        class="bas-img bas-img--before"
        [src]="beforeSrc()"
        [alt]="beforeLabel()"
        [style.clip-path]="'inset(0 ' + (100 - position()) + '% 0 0)'"
        draggable="false"
      />

      <span class="bas-tag bas-tag--before" aria-hidden="true">{{ beforeLabel() }}</span>
      <span class="bas-tag bas-tag--after" aria-hidden="true">{{ afterLabel() }}</span>

      <div
        #handle
        class="bas-divider"
        [style.left.%]="position()"
        role="slider"
        tabindex="0"
        [attr.aria-label]="ariaLabel()"
        aria-valuemin="0"
        aria-valuemax="100"
        [attr.aria-valuenow]="position()"
        [attr.aria-valuetext]="position() + ' percent revealed'"
        (keydown)="onKeydown($event)"
        (pointerdown)="onHandlePointerDown($event)"
      >
        <span class="bas-grab" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>
    </figure>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        --bas-accent: var(--ps-accent, #00e5ff);
      }
      .bas-surface {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 10;
        overflow: hidden;
        border-radius: 18px;
        margin: 0;
        cursor: ew-resize;
        touch-action: none;
        user-select: none;
        background: var(--ps-bg, #060610);
        box-shadow:
          0 24px 64px -16px rgba(0, 0, 0, 0.6),
          inset 0 0 0 1px rgba(255, 255, 255, 0.06);
      }
      .bas-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
      }
      .bas-img--before {
        will-change: clip-path;
        transition: clip-path 80ms linear;
      }
      .bas-tag {
        position: absolute;
        top: 14px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--ps-ink, #f4f4ff);
        background: rgba(6, 6, 16, 0.78);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        pointer-events: none;
        z-index: 2;
      }
      .bas-tag--before {
        left: 14px;
      }
      .bas-tag--after {
        right: 14px;
        border-color: color-mix(in oklch, var(--bas-accent) 35%, transparent);
        color: var(--bas-accent);
      }
      .bas-divider {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--bas-accent);
        box-shadow:
          0 0 12px color-mix(in oklch, var(--bas-accent) 60%, transparent),
          0 0 32px color-mix(in oklch, var(--bas-accent) 25%, transparent);
        transform: translateX(-1px);
        z-index: 3;
        cursor: ew-resize;
        outline: none;
      }
      .bas-divider:focus-visible {
        box-shadow:
          0 0 0 3px color-mix(in oklch, var(--bas-accent) 45%, transparent),
          0 0 24px color-mix(in oklch, var(--bas-accent) 60%, transparent);
      }
      .bas-grab {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        border-radius: 999px;
        background: rgba(6, 6, 16, 0.82);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border: 1.5px solid var(--bas-accent);
        color: var(--bas-accent);
        box-shadow:
          0 8px 24px rgba(0, 0, 0, 0.5),
          0 0 32px color-mix(in oklch, var(--bas-accent) 30%, transparent);
        transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .bas-divider:hover .bas-grab,
      .bas-divider:focus-visible .bas-grab {
        transform: translate(-50%, -50%) scale(1.08);
      }

      @media (prefers-reduced-motion: reduce) {
        .bas-img--before,
        .bas-grab {
          transition: none !important;
        }
      }
    `,
  ],
})
export class BeforeAfterSliderComponent {
  private readonly platformId = inject(PLATFORM_ID);

  /** URL of the "before" image (revealed on the left). */
  readonly beforeSrc = input.required<string>();

  /** URL of the "after" image (revealed on the right). */
  readonly afterSrc = input.required<string>();

  readonly beforeLabel = input('Before');
  readonly afterLabel = input('After');
  readonly ariaLabel = input('Reveal slider — drag to compare before and after');

  /** Initial divider position, 0-100. */
  readonly initial = input(50);

  @ViewChild('surface', { static: true }) private surfaceRef!: ElementRef<HTMLElement>;

  readonly position = signal<number>(50);
  private dragging = false;

  constructor() {
    // React to initial position input via effect().
    // When [initial] changes, clamp and update position.
    effect(() => {
      const val = this.initial();
      this.position.set(this.clamp(val));
    });
  }

  onHandlePointerDown(event: PointerEvent): void {
    this.dragging = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  onPointerDown(event: PointerEvent): void {
    this.dragging = true;
    this.surfaceRef.nativeElement.setPointerCapture?.(event.pointerId);
    this.updateFromEvent(event);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    this.updateFromEvent(event);
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.surfaceRef.nativeElement.releasePointerCapture?.(event.pointerId);
    } catch {
      /* no-op — pointer may have been captured by the handle child */
    }
  }

  onKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 2;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = this.position() - step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = this.position() + step;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 100;
        break;
      case 'PageDown':
        next = this.position() - 10;
        break;
      case 'PageUp':
        next = this.position() + 10;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.position.set(this.clamp(next));
  }

  @HostListener('window:pointerup')
  onWindowUp(): void {
    this.dragging = false;
  }

  private updateFromEvent(event: PointerEvent): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const rect = this.surfaceRef.nativeElement.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    this.position.set(this.clamp(pct));
  }

  private clamp(v: number): number {
    if (Number.isNaN(v)) return 50;
    if (v < 0) return 0;
    if (v > 100) return 100;
    return Math.round(v * 10) / 10;
  }
}
