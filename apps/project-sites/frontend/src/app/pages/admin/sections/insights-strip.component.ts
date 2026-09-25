/**
 * Highlights strip — the owner-friendly "so what" at the top of `/admin/analytics`.
 *
 * Renders the deterministic, evidence-backed insights from `buildAnalyticsInsights`
 * (traffic trend, conversions, top page, device majority, top location, stickiness).
 * Focused, standalone, presentational (Angular style guide): signals + `input()` +
 * native control flow, no data of its own. Hides entirely when there are no insights
 * (a fresh site legitimately has none — never a fabricated highlight).
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { AnalyticsInsight } from '../../../utils/analytics-insights';

@Component({
  selector: 'app-insights-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (insights().length) {
      <section class="ins card" data-testid="an-insights" aria-label="Highlights">
        <div class="ins-kicker">Highlights</div>
        <ul class="ins-list">
          @for (i of insights(); track i.id) {
            <li class="ins-item" [attr.data-testid]="'an-insight-' + i.id">
              <svg class="ins-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 18h6" /><path d="M10 22h4" />
                <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z" />
              </svg>
              <span>{{ i.text }}</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [
    `
    :host { display: block; }
    .ins { display: grid; gap: 0.4rem; }
    .ins-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .ins-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
    .ins-item { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.82rem; line-height: 1.4; color: var(--ps-ink, #f4f4ff); }
    .ins-ic { flex-shrink: 0; margin-top: 0.15rem; color: var(--ps-accent, #00e5ff); }
    @media (min-width: 720px) { .ins-list { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem 1.25rem; } }
    `,
  ],
})
export class InsightsStripComponent {
  /** The evidence-backed highlights to render; `[]` (or none) hides the strip. */
  readonly insights = input<AnalyticsInsight[]>([]);
}
