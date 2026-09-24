import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * `app-empty-state` — friendly, on-brand "nothing here yet" surface. One of the
 * three Cockpit-v2 state primitives. Per the extra-mile mandate, a "no results"
 * empty state should make the CTA the *first-result action* ("Create your first
 * site"), never a dead-end "No data" line.
 *
 * @remarks
 * - Cockpit-v2 design tokens only (`--ps-*` with safe fallbacks). No hardcoded hex.
 * - `role="status"` so AT announces the empty condition once.
 * - CTA is a real `<button>` with `:focus-visible` ring + ≥24px tap target.
 * - Title uses `text-wrap: balance`, message `text-wrap: pretty`.
 * - Optional `icon` slot (emoji or short glyph); decorative, `aria-hidden`.
 *
 * @example
 * ```html
 * <app-empty-state
 *   icon="🌐"
 *   title="No sites yet"
 *   message="Spin up your first AI-built site to see it here."
 *   ctaLabel="Create your first site"
 *   (ctaClick)="goCreate()" />
 * ```
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-live': 'polite', role: 'status' },
  selector: 'app-empty-state',
  standalone: true,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .es {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        text-align: center;
        padding: 44px 24px;
        border: 1px dashed var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-lg, 16px);
        background: var(--ps-surface-1, rgba(255, 255, 255, 0.02));
      }
      .es-icon {
        font-size: 2rem;
        line-height: 1;
        opacity: 0.9;
        color: var(--ps-accent, #00e5ff);
        filter: drop-shadow(0 0 14px var(--ps-accent-soft, rgba(0, 229, 255, 0.14)));
      }
      .es-icon svg {
        width: 30px;
        height: 30px;
        display: block;
      }
      .es-title {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
        text-wrap: balance;
      }
      .es-msg {
        margin: 0;
        max-width: 42ch;
        font-size: 0.85rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        text-wrap: pretty;
      }
      .es-cta {
        margin-top: 6px;
        min-height: 24px;
        min-width: 24px;
        padding: 9px 18px;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--ps-bg, #060610);
        background: var(--ps-accent, #00e5ff);
        border: 1px solid var(--ps-accent, #00e5ff);
        border-radius: var(--ps-radius-md, 12px);
        cursor: pointer;
        transition:
          transform var(--ps-dur-fast, 140ms) var(--ps-ease-out, ease),
          box-shadow var(--ps-dur-fast, 140ms) var(--ps-ease-out, ease);
      }
      .es-cta:hover {
        transform: translateY(-1px);
        box-shadow: 0 0 24px var(--ps-accent-soft, rgba(0, 229, 255, 0.14));
      }
      .es-cta:focus-visible {
        outline: 3px solid var(--ps-accent, #00e5ff);
        outline-offset: var(--ps-ring-focus-offset, 2px);
      }
      @media (prefers-reduced-motion: reduce) {
        .es-cta {
          transition: none;
        }
        .es-cta:hover {
          transform: none;
        }
      }
    `,
  ],
  template: `
    <div class="es" data-testid="empty-state">
      @if (icon()) {
        <!-- Colorful emoji icons map to monochrome cyan SVGs (cockpit cyan/black
             standard); on-brand mono symbols (⌬ ⚑ ⎇ ↪ ▦) + anything unmapped fall
             through to the @default text glyph. Consumers pass the same icon string. -->
        <div class="es-icon" data-testid="empty-glyph" aria-hidden="true">
          @switch (icon()) {
            @case ('💬') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> }
            @case ('🔗') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> }
            @case ('🔌') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> }
            @case ('📞') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> }
            @case ('🚀') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> }
            @case ('🌐') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> }
            @case ('🔭') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> }
            @case ('⚡') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> }
            @case ('📭') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg> }
            @case ('🔍') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> }
            @case ('✨') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg> }
            @default { {{ icon() }} }
          }
        </div>
      }
      <!-- h2, not h3: this shared empty-state is usually the ONLY content under a
           section's h1 (e.g. /admin/site-features with no features) → h3 would skip
           a level (axe heading-order). h2 never skips from any predecessor (h1→h2 ok,
           h2/h3→h2 ok). Styled by .es-title class, so the tag change is visual-neutral. -->
      <h2 class="es-title" data-testid="empty-title">{{ title() }}</h2>
      @if (message()) {
        <p class="es-msg">{{ message() }}</p>
      }
      @if (ctaLabel()) {
        <button
          type="button"
          class="es-cta"
          data-testid="empty-cta"
          (click)="ctaClick.emit()"
        >
          {{ ctaLabel() }}
        </button>
      }
    </div>
  `,
})
export class EmptyStateComponent {
  /** Optional decorative glyph / emoji shown above the title. */
  readonly icon = input('');

  /** Headline — what's missing. Required for a meaningful empty state. */
  readonly title = input.required<string>();

  /** Supporting one-liner explaining the empty condition. */
  readonly message = input('');

  /** CTA label. When set, renders the first-result action button. */
  readonly ctaLabel = input('');

  /** Fires when the CTA button is activated. */
  readonly ctaClick = output<void>();
}
