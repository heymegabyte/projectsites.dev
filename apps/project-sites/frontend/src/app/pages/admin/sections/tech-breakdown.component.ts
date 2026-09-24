/**
 * Devices & platforms card — the audience-technology block of `/admin/analytics`.
 *
 * Renders three pageview breakdowns (device / browser / operating system) from
 * `traffic.byDevice` / `byBrowser` / `byOs` — all derived from the SAME first-party
 * user-agent enrichment recorded on every pageview beacon. Focused, standalone,
 * presentational component (Angular style guide): signals + `input()` + native control
 * flow, no fetching.
 *
 * HONESTY: unlike Core Web Vitals (Chromium-only), the user-agent is sent by EVERY
 * browser, so this covers all recorded pageviews. Every count is a real tracked
 * pageview; an unclassified UA buckets as "unknown" (a real bucket, never dropped),
 * and a site with no pageviews shows an explicit empty state, never a fabricated 0.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One `{ label, count }` breakdown row (device/browser/os), as the server returns it. */
export interface TechCount {
  label: string;
  count: number;
}

interface TechGroup {
  key: 'device' | 'browser' | 'os';
  label: string;
  rows: TechCount[];
  max: number;
}

@Component({
  selector: 'app-tech-breakdown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card tech" data-testid="an-tech">
      <div class="tech-kicker">Audience</div>
      <h3 class="tech-head">
        <span class="tech-title">Devices &amp; platforms</span>
        <span
          class="tech-sub"
          data-testid="an-tech-source"
          title="Pageviews split by the User-Agent your visitors' browsers send — covers every visitor (unlike Core Web Vitals, which are Chrome/Edge-only). A count, never an estimate."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · from the visitor's browser</span>
      </h3>

      @if (hasAny()) {
        <div class="tech-grid">
          @for (g of groups(); track g.key) {
            @if (g.rows.length) {
              <div class="tech-col" [attr.data-testid]="'an-tech-' + g.key">
                <div class="tech-col-h">{{ g.label }}</div>
                <ul class="tech-list">
                  @for (r of g.rows; track r.label) {
                    <li class="tech-row" [attr.data-testid]="'an-tech-row-' + g.key">
                      <div class="tech-row-head">
                        <span class="tech-label" [attr.title]="r.label">{{ r.label }}</span>
                        <span class="tech-count">{{ r.count }}</span>
                      </div>
                      <div class="tech-bar" aria-hidden="true">
                        <div class="tech-bar-fill" [style.width.%]="barWidth(r.count, g.max)"></div>
                      </div>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </div>
      } @else {
        <p class="tech-empty" data-testid="an-tech-empty">
          No visitor technology data yet. Device, browser, and operating-system splits appear here
          once your site records pageviews — a real breakdown from each visitor's browser, never an estimate.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .tech-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .tech-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .tech-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .tech-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .tech-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    @media (max-width: 640px) { .tech-grid { grid-template-columns: 1fr; } }
    .tech-col-h { font-size: 0.64rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 58%, transparent); margin-bottom: 0.5rem; }
    .tech-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
    .tech-row-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .tech-label { font-size: 0.78rem; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }
    .tech-count { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .tech-bar { height: 5px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .tech-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .tech-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class TechBreakdownComponent {
  /** `traffic.byDevice` — pageviews by device (mobile / desktop / tablet). */
  readonly devices = input<TechCount[]>([]);
  /** `traffic.byBrowser` — pageviews by browser (Chrome / Safari / …). */
  readonly browsers = input<TechCount[]>([]);
  /** `traffic.byOs` — pageviews by operating system (iOS / Windows / …). */
  readonly os = input<TechCount[]>([]);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);

  /** Top non-zero rows for one dimension, sorted by count desc, capped at 6. */
  private top(rows: TechCount[]): TechCount[] {
    return [...rows]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }

  /** The three dimensions as render-ready groups (top rows + the group's max, for bar scaling). */
  readonly groups = computed<TechGroup[]>(() =>
    (
      [
        { key: 'device', label: 'Devices', rows: this.top(this.devices()) },
        { key: 'browser', label: 'Browsers', rows: this.top(this.browsers()) },
        { key: 'os', label: 'Operating systems', rows: this.top(this.os()) },
      ] as const
    ).map((g) => ({ ...g, max: g.rows.reduce((m, r) => Math.max(m, r.count), 0) })),
  );

  /** True when ANY dimension has data — else the card shows the honest empty state. */
  readonly hasAny = computed(() => this.groups().some((g) => g.rows.length > 0));

  /** Bar width as a % of the group's largest count (min 4% so a small bar stays visible). */
  barWidth(count: number, max: number): number {
    return max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  }
}
