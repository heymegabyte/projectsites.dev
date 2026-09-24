import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  PLATFORM_ID,
  signal,
} from '@angular/core';

/**
 * `app-error-card` — "errors as UX" surface. One of the three Cockpit-v2 state
 * primitives. Always pairs the failure with a recovery affordance (Retry) and a
 * "what to try" hint, plus a copy-able correlation id for support hand-off.
 *
 * @remarks
 * - Cockpit-v2 design tokens only (`--ps-*` with safe fallbacks). No hardcoded hex.
 * - `role="alert"` so AT announces the failure immediately.
 * - Retry + Copy are real `<button>`s with `:focus-visible` ring + ≥24px targets.
 * - Correlation id rendered in `tabular-nums` so the monospace id never reflows.
 * - Copy uses the async Clipboard API with a graceful no-op fallback; the button
 *   flips to "Copied" for 1.6s as feedback (SSR-safe via PLATFORM_ID guard).
 *
 * @example
 * ```html
 * <app-error-card
 *   title="Couldn't load metrics"
 *   message="The sites heatmap service didn't respond."
 *   [correlationId]="reqId()"
 *   (retry)="reload()" />
 * ```
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-live': 'assertive', role: 'alert' },
  selector: 'app-error-card',
  standalone: true,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        font-variant-numeric: tabular-nums;
      }
      .ec {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px;
        border: 1px solid
          color-mix(in oklch, var(--ps-danger, #ff4d6d) 36%, transparent);
        border-radius: var(--ps-radius-lg, 16px);
        background: color-mix(in oklch, var(--ps-danger, #ff4d6d) 7%, var(--ps-surface-1, rgba(255, 255, 255, 0.02)));
      }
      .ec-top {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .ec-glyph {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-weight: 800;
        font-size: 0.95rem;
        color: var(--ps-bg, #060610);
        background: var(--ps-danger, #ff4d6d);
      }
      .ec-body {
        flex: 1 1 auto;
        min-width: 0;
      }
      .ec-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
        text-wrap: balance;
      }
      .ec-msg {
        margin: 6px 0 0;
        font-size: 0.85rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 72%, transparent);
        text-wrap: pretty;
      }
      .ec-hint {
        margin: 8px 0 0;
        font-size: 0.78rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .ec-cid {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      .ec-cid-label {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        /* 45% failed WCAG AA contrast (small text needs 4.5:1) once the reference
           block actually renders — lift to 78% so it stays a secondary label
           while clearing the threshold. */
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
      }
      .ec-cid-val {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.74rem;
        padding: 3px 8px;
        border-radius: var(--ps-radius-xs, 6px);
        color: var(--ps-ink, #f4f4ff);
        background: var(--ps-surface-2, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        word-break: break-all;
      }
      .ec-copy,
      .ec-retry {
        min-height: 24px;
        min-width: 24px;
        cursor: pointer;
        border-radius: var(--ps-radius-sm, 8px);
        transition: border-color var(--ps-dur-fast, 140ms) var(--ps-ease-out, ease);
      }
      .ec-copy {
        padding: 4px 10px;
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        background: transparent;
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
      }
      .ec-copy:hover {
        border-color: var(--ps-accent, #00e5ff);
      }
      .ec-actions {
        display: flex;
        justify-content: flex-end;
      }
      .ec-retry {
        padding: 9px 18px;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--ps-bg, #060610);
        background: var(--ps-accent, #00e5ff);
        border: 1px solid var(--ps-accent, #00e5ff);
      }
      .ec-retry:hover {
        box-shadow: 0 0 24px var(--ps-accent-soft, rgba(0, 229, 255, 0.14));
      }
      .ec-copy:focus-visible,
      .ec-retry:focus-visible {
        outline: 3px solid var(--ps-accent, #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }
      @media (prefers-reduced-motion: reduce) {
        .ec-copy,
        .ec-retry {
          transition: none;
        }
      }
    `,
  ],
  template: `
    <div class="ec" data-testid="error-card">
      <div class="ec-top">
        <span class="ec-glyph" aria-hidden="true">!</span>
        <div class="ec-body">
          <h3 class="ec-title" data-testid="error-title">{{ title() }}</h3>
          @if (message()) {
            <p class="ec-msg">{{ message() }}</p>
          }
          <p class="ec-hint">{{ displayHint() }}</p>

          @if (correlationId()) {
            <div class="ec-cid">
              <span class="ec-cid-label">Reference</span>
              <code class="ec-cid-val" data-testid="error-correlation">{{ correlationId() }}</code>
              <button
                type="button"
                class="ec-copy"
                data-testid="error-copy"
                [attr.aria-label]="'Copy reference ' + correlationId()"
                (click)="copy()"
              >
                {{ copied() ? 'Copied' : 'Copy' }}
              </button>
            </div>
          }
        </div>
      </div>

      <div class="ec-actions">
        <button
          type="button"
          class="ec-retry"
          data-testid="error-retry"
          (click)="retry.emit()"
        >
          {{ retryLabel() }}
        </button>
      </div>
    </div>
  `,
})
export class ErrorCardComponent {
  private readonly platformId = inject(PLATFORM_ID);

  /** Headline — what failed. Required (the template-compile enforces the binding). */
  readonly title = input.required<string>();

  /** What happened, in plain language. */
  readonly message = input('');

  /**
   * Explicit "what to try next" hint. `undefined` (unbound) → {@link displayHint}
   * derives the wording from whether a reference actually renders (so we never
   * promise "copy the reference below" when no correlationId shows). A bound value
   * is respected verbatim.
   */
  readonly hint = input<string | undefined>(undefined);

  /** Optional correlation / request id surfaced for support hand-off. */
  readonly correlationId = input('');

  /** Retry button label. */
  readonly retryLabel = input('Retry');

  /** Fires when the retry button is activated. */
  readonly retry = output<void>();

  /**
   * The hint to render: the explicit `hint` when bound, else a reactive default
   * that only promises the reference when a `correlationId` is actually shown.
   */
  readonly displayHint = computed(() => {
    const explicit = this.hint();
    if (explicit !== undefined) return explicit;
    return this.correlationId()
      ? 'Try again. If it keeps failing, copy the reference below for support.'
      : 'Try again. If it keeps failing, contact support.';
  });

  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    const cid = this.correlationId();
    if (!cid || !isPlatformBrowser(this.platformId)) return;
    try {
      await navigator.clipboard?.writeText(cid);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard unavailable (insecure context / denied) — no-op, button stays "Copy".
    }
  }
}
