import { ChangeDetectionStrategy, Component, input, model, output, signal } from '@angular/core';

/**
 * Masked secret / env-var value input with a show/hide (eye) toggle.
 *
 * Masked by default (`type=password`); the eye button swaps to `text` and back. Reused
 * everywhere an env-var value is edited — the deploy panel + the instance page, for both
 * catalog (auto) vars and owner-added custom vars — so masking + reveal behaves identically
 * across all of them.
 *
 * @remarks Value is a two-way `model()` — bind `[value]` + `(valueChange)` (or `[(value)]`).
 * `valueBlur` fires on the field's blur so callers can revert an emptied auto-var to its chip.
 */
@Component({
  selector: 'app-secret-input',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="secret-input">
      <input
        [type]="revealed() ? 'text' : 'password'"
        [value]="value()"
        (input)="value.set($any($event.target).value)"
        (blur)="valueBlur.emit()"
        [attr.placeholder]="placeholder()"
        [attr.aria-label]="ariaLabel()"
        [attr.data-testid]="testid()"
        [disabled]="disabled()"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="off"
        class="secret-input__field" />
      <button
        type="button"
        class="secret-input__toggle"
        (click)="revealed.set(!revealed())"
        [attr.aria-label]="revealed() ? 'Hide value' : 'Show value'"
        [attr.aria-pressed]="revealed()"
        [attr.data-testid]="testid() + '-toggle'">
        @if (revealed()) {
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
        } @else {
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        }
      </button>
    </span>
  `,
  styles: [
    `
    :host { display: block; min-width: 0; width: 100%; }
    .secret-input { display: flex; align-items: stretch; width: 100%; position: relative; }
    .secret-input__field {
      flex: 1; min-width: 0;
      padding: 0.42rem 2.2rem 0.42rem 0.6rem;
      background: rgba(0,0,0,0.32);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: var(--ps-radius-sm, 8px);
      color: var(--ps-ink, #fff);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
    }
    .secret-input__field:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 1px;
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 50%, transparent);
    }
    .secret-input__field:disabled { opacity: 0.6; cursor: not-allowed; }
    .secret-input__field::placeholder { color: rgba(255,255,255,0.34); letter-spacing: normal; }
    .secret-input__toggle {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0; border: none; background: none; cursor: pointer;
      color: rgba(255,255,255,0.5); border-radius: 6px;
    }
    .secret-input__toggle:hover { color: var(--ps-accent, #00E5FF); }
    .secret-input__toggle:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 1px; }
    `,
  ],
})
export class AppSecretInputComponent {
  /** Two-way value model — `[value]` in, `valueChange` out. */
  readonly value = model<string>('');
  readonly placeholder = input<string>('');
  readonly ariaLabel = input<string>('value');
  readonly testid = input<string>('secret');
  readonly disabled = input<boolean>(false);
  /** Emitted on the field's native blur (lets callers revert an emptied auto-var to its chip). */
  readonly valueBlur = output<void>();
  /** Masked by default; the eye toggle flips this. */
  readonly revealed = signal<boolean>(false);
}
