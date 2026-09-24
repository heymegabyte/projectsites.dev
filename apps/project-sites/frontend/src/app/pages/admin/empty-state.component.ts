/**
 * Reusable pretty empty state.
 *   <app-empty-state
 *     icon="📭"
 *     title="No submissions yet"
 *     body="Drop the app.js snippet on your site and every form submit appears here."
 *     primary="Copy snippet"
 *     (primaryClick)="copy()"
 *   />
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-empty-state',
  standalone: true,
  template: `
    <div class="empty-state-pretty" role="status" aria-live="polite" data-testid="empty-state">
      @if (icon()) {
        <!-- Colorful emoji icons map to monochrome cyan SVGs (cockpit cyan/black
             standard); on-brand mono symbols (⌬ ▦ etc.) + anything unmapped fall
             through to the @default text glyph. Consumers pass the same icon string. -->
        <div class="empty-glyph" aria-hidden="true">
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
            @case ('✨') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg> }
            @case ('🔍') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> }
            @default { <span class="empty-emoji">{{ icon() }}</span> }
          }
        </div>
      }
      <h3 class="glow-h-grad text-xl font-semibold m-0" data-testid="empty-title">{{ title() }}</h3>
      @if (body()) { <p class="text-[0.88rem] text-text-secondary max-w-[480px] mx-auto m-0 leading-relaxed">{{ body() }}</p> }
      @if (primary()) {
        <div class="flex gap-2 justify-center mt-1 flex-wrap">
          <button class="btn-primary" data-testid="empty-cta" (click)="primaryClick.emit()">{{ primary() }}</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* Cyan glyph halo — frames the icon in the cockpit accent (matches the
       components/states kit's accent treatment) so the empty state reads as
       cyan/black, not a bare floating emoji. Shared by all 5 admin consumers. */
    .empty-glyph {
      width: 56px; height: 56px; margin: 0 auto 0.35rem;
      display: flex; align-items: center; justify-content: center;
      border-radius: 16px;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
    }
    .empty-glyph svg { width: 28px; height: 28px; display: block; }
    .empty-emoji { font-size: 1.8rem; line-height: 1; }
  `],
})
export class EmptyStateComponent {
  /** Optional decorative glyph / emoji above the title (maps to a monochrome cyan SVG). */
  readonly icon = input<string>();
  /** Headline — what's missing. */
  readonly title = input('');
  /** Supporting one-liner explaining the empty condition. */
  readonly body = input<string>();
  /** Primary CTA label. When set, renders the first-result action button. */
  readonly primary = input<string>();
  /** Fires when the primary CTA is activated. */
  readonly primaryClick = output<void>();
}
