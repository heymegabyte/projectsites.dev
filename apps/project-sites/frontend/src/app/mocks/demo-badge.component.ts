/**
 * @module mocks/demo-badge
 *
 * @description
 * A small fixed "DEMO · mock data" badge, shown ONLY when mock mode is on
 * ({@link MockModeService.enabled}). It makes a mocked surface impossible to mistake
 * for real (honesty mandate: a mocked surface is a VISIBLE demo, never fake-real).
 * Rendered once in the root `app.component` template so it's present on EVERY route
 * while `?mock=1` is active; it renders NOTHING in the production default (no `?mock=1`).
 *
 * @remarks
 * - Unobtrusive bottom-left pill in brand tokens (`--ps-accent` cyan on the dark bg),
 *   below toasts/overlays, with an `aria-label` + `role="status"` so it's announced
 *   once without stealing focus. The live state label updates with `&state=…`.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MockModeService } from './mock-mode.service';

@Component({
  selector: 'app-demo-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mock.enabled()) {
      <div class="ps-demo-badge" role="status" [attr.aria-label]="mock.badgeLabel() + ' — this surface is showing mock data, not a live backend'" data-testid="demo-badge">
        <span class="ps-demo-badge__dot" aria-hidden="true"></span>
        <span class="ps-demo-badge__text">{{ mock.badgeLabel() }}</span>
      </div>
    }
  `,
  styles: [
    `
      .ps-demo-badge {
        position: fixed;
        left: 16px;
        bottom: 16px;
        /* Below toast (9999) / header / takeover — a demo marker, never on top of real UI. */
        z-index: 9000;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        font:
          600 12px/1 var(--ps-font-mono, ui-monospace, 'JetBrains Mono', monospace);
        letter-spacing: 0.04em;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in srgb, var(--ps-bg, #060610) 82%, transparent);
        border: 1px solid color-mix(in srgb, var(--ps-accent, #00e5ff) 36%, transparent);
        box-shadow:
          0 6px 18px -8px rgba(0, 0, 0, 0.6),
          0 0 0 1px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(6px);
        pointer-events: none;
        user-select: none;
      }
      .ps-demo-badge__dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 8px color-mix(in srgb, var(--ps-accent, #00e5ff) 70%, transparent);
        animation: ps-demo-pulse 1.8s ease-in-out infinite;
      }
      .ps-demo-badge__text {
        white-space: nowrap;
      }
      @media (prefers-reduced-motion: reduce) {
        .ps-demo-badge__dot {
          animation: none;
        }
      }
      @keyframes ps-demo-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.35;
        }
      }
    `,
  ],
})
export class DemoBadgeComponent {
  /** Public so the template can gate on `enabled()` + read `badgeLabel()`. */
  readonly mock = inject(MockModeService);
}
