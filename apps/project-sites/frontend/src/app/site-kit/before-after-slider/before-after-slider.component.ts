import { Component, Input, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject } from '@angular/core';

@Component({
  selector: 'sk-before-after-slider',
  standalone: true,
  imports: [],
  template: `
    <figure
      style="
        position: relative;
        width: 100%;
        max-width: 800px;
        margin: 0 auto;
        border-radius: var(--ps-radius-xl, 22px);
        overflow: hidden;
        user-select: none;
        touch-action: none;
        aspect-ratio: 16/9;
        background: var(--ps-bg, #060610);
      "
      [attr.aria-label]="ariaLabel"
    >
      <!-- After image (full width underneath) -->
      <img
        [src]="afterSrc"
        [alt]="afterAlt"
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
      />
      <!-- Before image (clipped) -->
      <div
        #clip
        style="position:absolute;inset:0;overflow:hidden;"
        [style.clip-path]="'inset(0 ' + (100 - pct) + '% 0 0)'"
      >
        <img
          [src]="beforeSrc"
          [alt]="beforeAlt"
          style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
        />
      </div>
      <!-- Labels -->
      <span
        style="
          position:absolute;top:12px;left:16px;
          background:rgba(6,6,16,0.75);
          color:var(--ps-ink,#f4f4ff);
          font-size:0.75rem;font-weight:700;
          padding:4px 10px;border-radius:99px;
          backdrop-filter:blur(4px);
        "
        aria-hidden="true"
        >{{ beforeLabel }}</span
      >
      <span
        style="
          position:absolute;top:12px;right:16px;
          background:rgba(6,6,16,0.75);
          color:var(--ps-accent,#00e5ff);
          font-size:0.75rem;font-weight:700;
          padding:4px 10px;border-radius:99px;
          backdrop-filter:blur(4px);
        "
        aria-hidden="true"
        >{{ afterLabel }}</span
      >
      <!-- Divider + handle -->
      <div
        style="
          position:absolute;top:0;bottom:0;
          width:2px;
          background:var(--ps-accent,#00e5ff);
          cursor:ew-resize;
          transform:translateX(-50%);
          box-shadow:0 0 12px rgba(0,229,255,0.5);
        "
        [style.left.%]="pct"
      >
        <div
          role="slider"
          [attr.aria-valuenow]="pct"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-label]="'Before/After divider: ' + pct + '%'"
          tabindex="0"
          style="
            position:absolute;top:50%;left:50%;
            transform:translate(-50%,-50%);
            width:40px;height:40px;
            border-radius:50%;
            background:var(--ps-accent,#00e5ff);
            display:flex;align-items:center;justify-content:center;
            cursor:ew-resize;
            box-shadow:0 2px 12px rgba(0,229,255,0.4);
          "
          (keydown)="onKey($event)"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--ps-bg,#060610)"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
            <polyline
              points="9 18 15 12 9 6"
              style="transform:scaleX(-1);transform-origin:50% 50%"
            />
          </svg>
        </div>
      </div>
      <!-- Drag surface -->
      <div
        style="position:absolute;inset:0;cursor:ew-resize;"
        (pointerdown)="startDrag($event)"
        aria-hidden="true"
      ></div>
    </figure>
  `,
})
export class BeforeAfterSliderComponent implements AfterViewInit, OnDestroy {
  @Input() beforeSrc =
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="%23888"/><text x="400" y="225" text-anchor="middle" dominant-baseline="middle" fill="%23fff" font-size="24" font-family="sans-serif">Before</text></svg>';
  @Input() afterSrc =
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="%2300E5FF"/><text x="400" y="225" text-anchor="middle" dominant-baseline="middle" fill="%23060610" font-size="24" font-family="sans-serif">After</text></svg>';
  @Input() beforeAlt = 'Before';
  @Input() afterAlt = 'After';
  @Input() beforeLabel = 'Before';
  @Input() afterLabel = 'After';
  @Input() initial = 50;
  @Input() ariaLabel = 'Before and after comparison slider';

  pct = 50;
  private dragging = false;
  private hostEl!: HTMLElement;

  private boundMove = this.onMove.bind(this);
  private boundUp = this.stopDrag.bind(this);

  private readonly el = inject(ElementRef);

  ngAfterViewInit(): void {
    this.pct = this.initial;
    this.hostEl = this.el.nativeElement.querySelector('figure') as HTMLElement;
    window.addEventListener('pointermove', this.boundMove);
    window.addEventListener('pointerup', this.boundUp);
  }

  ngOnDestroy(): void {
    window.removeEventListener('pointermove', this.boundMove);
    window.removeEventListener('pointerup', this.boundUp);
  }

  startDrag(e: PointerEvent): void {
    this.dragging = true;
    this.updatePct(e.clientX);
  }

  private onMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.updatePct(e.clientX);
  }

  stopDrag(): void {
    this.dragging = false;
  }

  onKey(e: KeyboardEvent): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.pct = Math.max(0, this.pct - step);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.pct = Math.min(100, this.pct + step);
    }
    if (e.key === 'Home') {
      e.preventDefault();
      this.pct = 0;
    }
    if (e.key === 'End') {
      e.preventDefault();
      this.pct = 100;
    }
  }

  private updatePct(clientX: number): void {
    if (!this.hostEl) return;
    const rect = this.hostEl.getBoundingClientRect();
    const x = clientX - rect.left;
    this.pct = Math.min(100, Math.max(0, Math.round((x / rect.width) * 100)));
  }
}
