/**
 * Script-errors card — first-party site-HEALTH for `/admin/analytics`. Standalone,
 * presentational (Angular style guide): signals + `input()` + native control flow, no
 * fetching. Reads `traffic.jsErrors` (uncaught JS errors / unhandled rejections captured
 * by the app.js beacon on every published page → `visitor_events`), grouped by message.
 *
 * HONESTY: a clean site shows a green "running clean" state — NOT a hidden/omitted card
 * and never "not measured" (the beacon runs on every page, so 0 is a real 0). When errors
 * exist it lists the top messages with counts + a sample path so the owner can act.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One grouped JS error surfaced in the card. */
export interface ScriptErrorGroup {
  message: string;
  count: number;
  samplePath?: string;
}

/** The `traffic.jsErrors` shape. */
export interface JsErrorsBlock {
  total: number;
  byMessage: ScriptErrorGroup[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-script-errors-card',
  standalone: true,
  styles: [
    `
    .se { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .se-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .se-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .se-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .se-total { font-variant-numeric: tabular-nums; font-weight: 700; }
    .se-total[data-clean='true'] { color: #4dffb5; }
    .se-total[data-clean='false'] { color: #ff9f43; }
    .se-clean { font-size: 0.74rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); display: flex; align-items: center; gap: 0.4rem; }
    .se-clean .dot { color: #4dffb5; }
    .se-list { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
    .se-row { display: grid; grid-template-columns: 1fr auto; gap: 0.3rem 0.6rem; align-items: baseline; padding: 0.35rem 0; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.06)); }
    .se-row:last-child { border-bottom: none; }
    .se-msg { font-family: var(--ps-mono, ui-monospace, monospace); font-size: 0.72rem; color: #ffd8c2; overflow-wrap: anywhere; }
    .se-count { font-variant-numeric: tabular-nums; font-size: 0.72rem; color: #ff9f43; font-weight: 700; white-space: nowrap; }
    .se-path { grid-column: 1 / -1; font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); overflow-wrap: anywhere; }
    .se-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    `,
  ],
  template: `
    <section class="se" data-testid="an-script-errors" aria-label="Script errors">
      <div class="se-head">
        <span class="se-title"><span aria-hidden="true">⚠</span> Script errors</span>
        <span class="se-win">last {{ windowDays() }} days</span>
      </div>

      @if (total() > 0) {
        <div class="se-total" data-clean="false" data-testid="an-script-errors-total" aria-live="polite">
          {{ total() }} error{{ total() === 1 ? '' : 's' }} · {{ groups().length }} distinct
        </div>
        <ul class="se-list">
          @for (g of groups(); track g.message) {
            <li class="se-row" data-testid="an-script-error-row">
              <span class="se-msg">{{ g.message }}</span>
              <span class="se-count">{{ g.count }}×</span>
              @if (g.samplePath) {
                <span class="se-path">on {{ g.samplePath }}</span>
              }
            </li>
          }
        </ul>
        <p class="se-note">
          First-party — uncaught JavaScript errors measured in real visitors' browsers by the
          ProjectSites beacon on every page (Cloudflare's plan has no client-error dataset). Fix
          these to stop breaking the experience for visitors on the affected pages.
        </p>
      } @else {
        <p class="se-clean" data-testid="an-script-errors-clean" aria-live="polite">
          <span class="dot" aria-hidden="true">✓</span> No script errors — your site is running clean.
        </p>
        <p class="se-note">
          First-party JavaScript-error monitoring runs on every page. A real 0 (not "not measured") —
          if a visitor's browser throws an uncaught error, it will appear here.
        </p>
      }
    </section>
  `,
})
export class ScriptErrorsCardComponent {
  /** The `traffic.jsErrors` block (undefined on older payloads → treated as clean). */
  readonly jsErrors = input<JsErrorsBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Total uncaught errors in the window (0 = clean). */
  readonly total = computed(() => this.jsErrors()?.total ?? 0);
  /** The grouped messages (already top-8, worst-first, from the server). */
  readonly groups = computed<ScriptErrorGroup[]>(() => this.jsErrors()?.byMessage ?? []);
}
