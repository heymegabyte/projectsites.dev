/**
 * Scroll-depth card — first-party CONTENT CONSUMPTION for `/admin/analytics`. Standalone,
 * presentational (Angular style guide): signals + `input()` + native control flow, no
 * fetching. Reads `traffic.scrollDepth` (max page-height % each visit reached, measured by
 * the app.js `scroll_depth` beacon on every published page → `visitor_events`).
 *
 * HONESTY: the headline is the MEDIAN max-depth (median, not mean). A `null` median shows
 * "measuring…" — NEVER a fabricated 0 (the beacon fires on every scrollable page; 0 would be
 * a lie, not "no data"). The reach funnel (how many visits got ≥25/50/75/100% deep) is
 * derived from real counts / total samples; per-page rows appear only past a sample floor.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One page's scroll-depth story — how far visitors typically get, and how many finish. */
export interface ScrollPageStat {
  path: string;
  medianPercent: number;
  samples: number;
  completionPercent: number;
}

/** The `traffic.scrollDepth` shape. */
export interface ScrollDepthBlock {
  samples: number;
  medianPercent: number | null;
  reach: { p25: number; p50: number; p75: number; p100: number };
  byPage: ScrollPageStat[];
}

/** One rung of the reach funnel for the template. */
export interface ReachRung {
  label: string;
  count: number;
  percent: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-scroll-depth-card',
  standalone: true,
  styles: [
    `
    .sd { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .sd-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .sd-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .sd-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .sd-figure { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.2rem; }
    .sd-median { font-size: 1.5rem; font-weight: 700; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .sd-median-lbl { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .sd-samples { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .sd-measuring { font-size: 0.76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .sd-funnel { margin: 0.7rem 0 0; display: grid; gap: 0.3rem; }
    .sd-rung { display: grid; grid-template-columns: 3.2rem 1fr auto; gap: 0.5rem; align-items: center; font-size: 0.72rem; }
    .sd-rung-lbl { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); font-variant-numeric: tabular-nums; }
    .sd-bar { height: 0.5rem; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .sd-bar-fill { height: 100%; border-radius: 999px; background: var(--ps-accent, #00e5ff); }
    .sd-rung-pct { color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sd-pages { margin: 0.7rem 0 0; padding: 0; list-style: none; display: grid; gap: 0.35rem; }
    .sd-page-h { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); margin-bottom: 0.1rem; }
    .sd-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 0.6rem; align-items: baseline; font-size: 0.74rem; padding: 0.2rem 0; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.06)); }
    .sd-row:last-child { border-bottom: none; }
    .sd-path { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-val { color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sd-done { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sd-n { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sd-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    `,
  ],
  template: `
    <section class="sd" data-testid="an-scroll-depth" aria-label="Scroll depth">
      <div class="sd-head">
        <span class="sd-title"><span aria-hidden="true">📜</span> Scroll depth</span>
        <span class="sd-win">last {{ windowDays() }} days</span>
      </div>

      @if (median() !== null) {
        <div class="sd-figure">
          <span class="sd-median" data-testid="an-scroll-median">{{ median() }}%</span>
          <span class="sd-median-lbl">median depth reached</span>
        </div>
        <div class="sd-samples">across {{ samples().toLocaleString() }} measured page view{{ samples() === 1 ? '' : 's' }}</div>

        <div class="sd-funnel" role="list" aria-label="Reach funnel">
          @for (r of funnel(); track r.label) {
            <div class="sd-rung" role="listitem" data-testid="an-scroll-rung">
              <span class="sd-rung-lbl">{{ r.label }}</span>
              <span class="sd-bar"><span class="sd-bar-fill" [style.width.%]="r.percent"></span></span>
              <span class="sd-rung-pct" [attr.aria-label]="r.percent + '% reached ' + r.label + ' (' + r.count + ' views)'">{{ r.percent }}%</span>
            </div>
          }
        </div>

        @if (pages().length) {
          <ul class="sd-pages">
            <li class="sd-page-h">Most-read pages</li>
            @for (p of pages(); track p.path) {
              <li class="sd-row" data-testid="an-scroll-row">
                <span class="sd-path" [attr.title]="p.path">{{ p.path }}</span>
                <span class="sd-val">{{ p.medianPercent }}%</span>
                <span class="sd-done" [attr.title]="p.completionPercent + '% reached the bottom'">{{ p.completionPercent }}% ✓</span>
                <span class="sd-n">{{ p.samples }}×</span>
              </li>
            }
          </ul>
        }
        <p class="sd-note">
          First-party — how far visitors get through your pages, measured in every browser by the
          ProjectSites beacon (Cloudflare's plan has no scroll dataset). <strong>Median</strong> of each
          visit's deepest point; a page that fits the screen counts as 100% (fully seen). The
          <strong>✓</strong> column is the share who reached the very bottom.
        </p>
      } @else {
        <p class="sd-measuring" data-testid="an-scroll-empty" aria-live="polite">
          Measuring — no scroll-depth samples yet.
        </p>
        <p class="sd-note">
          Scroll depth is measured first-party on every page. A real value appears here once visitors
          browse your site — never a fabricated 0.
        </p>
      }
    </section>
  `,
})
export class ScrollDepthCardComponent {
  /** The `traffic.scrollDepth` block (undefined on older payloads → treated as measuring). */
  readonly scrollDepth = input<ScrollDepthBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Site-wide median max-depth (0–100), or null when no samples (shows "measuring…"). */
  readonly median = computed<number | null>(() => this.scrollDepth()?.medianPercent ?? null);
  /** Total measured page views behind the median. */
  readonly samples = computed(() => this.scrollDepth()?.samples ?? 0);
  /** Per-page medians (already deepest-first, floor-gated, from the server). */
  readonly pages = computed<ScrollPageStat[]>(() => this.scrollDepth()?.byPage ?? []);

  /**
   * The reach funnel as display rungs — each depth milestone's reach RATE (count / total
   * samples). Empty when there are no samples (the template only renders it past the median
   * guard anyway). Percent is rounded; a 0-sample denominator can't occur here.
   */
  readonly funnel = computed<ReachRung[]>(() => {
    const b = this.scrollDepth();
    if (!b || b.samples <= 0) {
      return [];
    }
    const rate = (count: number): number => Math.round((100 * count) / b.samples);
    return [
      { label: '25%', count: b.reach.p25, percent: rate(b.reach.p25) },
      { label: '50%', count: b.reach.p50, percent: rate(b.reach.p50) },
      { label: '75%', count: b.reach.p75, percent: rate(b.reach.p75) },
      { label: '100%', count: b.reach.p100, percent: rate(b.reach.p100) },
    ];
  });
}
