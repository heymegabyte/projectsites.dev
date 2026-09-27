/**
 * Engagement card — first-party TIME-ON-PAGE for `/admin/analytics`. Standalone,
 * presentational (Angular style guide): signals + `input()` + native control flow, no
 * fetching. Reads `traffic.engagement` (dwell measured by the app.js `page_engagement`
 * beacon on every published page → `visitor_events`).
 *
 * HONESTY: the site-wide figure is the MEDIAN dwell (median, not mean — a couple of tabs
 * left open would skew a mean). A `null` median shows "measuring…" — NEVER a fabricated 0
 * (the beacon runs on every page; 0 would be a lie, not "no data"). Per-page rows appear
 * only past a sample floor so a median off 1–2 visits isn't shown as reliable.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One page's median dwell. */
export interface EngagementPageStat {
  path: string;
  medianMs: number;
  samples: number;
}

/** Count of visits whose dwell reached each threshold (monotonic: s10 ≥ s30 ≥ s60 ≥ s180). */
export interface EngagementDistribution {
  s10: number;
  s30: number;
  s60: number;
  s180: number;
}

/** One dwell-distribution rung for the template: its label, count, and % of all visits. */
export interface EngagementRung {
  label: string;
  count: number;
  percent: number;
}

/** The `traffic.engagement` shape. */
export interface EngagementBlock {
  medianMs: number | null;
  samples: number;
  byPage: EngagementPageStat[];
  distribution?: EngagementDistribution;
}

/** Format a ms duration as a compact human dwell: "8s" · "1m 20s" · "3m". */
export function formatDwell(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-engagement-card',
  standalone: true,
  styles: [
    `
    .en { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .en-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .en-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .en-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .en-figure { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.2rem; }
    .en-median { font-size: 1.5rem; font-weight: 700; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .en-median-lbl { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .en-samples { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .en-measuring { font-size: 0.76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .en-pages { margin: 0.6rem 0 0; padding: 0; list-style: none; display: grid; gap: 0.35rem; }
    .en-page-h { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); margin-bottom: 0.1rem; }
    .en-row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.6rem; align-items: baseline; font-size: 0.74rem; padding: 0.2rem 0; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.06)); }
    .en-row:last-child { border-bottom: none; }
    .en-path { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .en-val { color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .en-n { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .en-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .en-dist { margin: 0.6rem 0 0; padding: 0; list-style: none; display: grid; gap: 0.3rem; }
    .en-dist-h { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); margin-bottom: 0.1rem; }
    .en-rung { display: grid; grid-template-columns: 2.6rem 1fr auto; gap: 0.5rem; align-items: center; font-size: 0.72rem; }
    .en-rung-lbl { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .en-rung-bar { height: 6px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .en-rung-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .en-rung-pct { color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    `,
  ],
  template: `
    <section class="en" data-testid="an-engagement" aria-label="Time on page">
      <div class="en-head">
        <span class="en-title"><span aria-hidden="true">⏱</span> Time on page</span>
        <span class="en-win">last {{ windowDays() }} days</span>
      </div>

      @if (median() !== null) {
        <div class="en-figure">
          <span class="en-median" data-testid="an-engagement-median">{{ dwell(median()!) }}</span>
          <span class="en-median-lbl">median dwell</span>
        </div>
        <div class="en-samples">across {{ samples().toLocaleString() }} measured page view{{ samples() === 1 ? '' : 's' }}</div>

        @if (rungs().length) {
          <ul class="en-dist" aria-label="How long visits lasted">
            <li class="en-dist-h">How long visits lasted</li>
            @for (r of rungs(); track r.label) {
              <li class="en-rung" data-testid="an-engagement-rung">
                <span class="en-rung-lbl">{{ r.label }}</span>
                <span class="en-rung-bar" aria-hidden="true"><span class="en-rung-fill" [style.width.%]="r.percent"></span></span>
                <span class="en-rung-pct" [attr.aria-label]="r.percent + '% of visits stayed ' + r.label + ' (' + r.count + ' views)'">{{ r.percent }}%</span>
              </li>
            }
          </ul>
        }

        @if (pages().length) {
          <ul class="en-pages">
            <li class="en-page-h">Most-engaging pages</li>
            @for (p of pages(); track p.path) {
              <li class="en-row" data-testid="an-engagement-row">
                <span class="en-path" [attr.title]="p.path">{{ p.path }}</span>
                <span class="en-val">{{ dwell(p.medianMs) }}</span>
                <span class="en-n">{{ p.samples }}×</span>
              </li>
            }
          </ul>
        }
        <p class="en-note">
          First-party — how long visitors typically stay, measured in every browser by the ProjectSites
          beacon (Cloudflare's plan has no dwell dataset). <strong>Median</strong>, not average, so a few
          long-open tabs don't skew it; bounces (&lt;1s) and abandoned tabs (&gt;30m) are excluded.
        </p>
      } @else {
        <p class="en-measuring" data-testid="an-engagement-empty" aria-live="polite">
          Measuring — no time-on-page samples yet.
        </p>
        <p class="en-note">
          Dwell time is measured first-party on every page. A real value appears here once visitors spend
          time on your site — never a fabricated 0.
        </p>
      }
    </section>
  `,
})
export class EngagementCardComponent {
  /** The `traffic.engagement` block (undefined on older payloads → treated as measuring). */
  readonly engagement = input<EngagementBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Site-wide median dwell in ms, or null when no samples (shows "measuring…"). */
  readonly median = computed<number | null>(() => this.engagement()?.medianMs ?? null);
  /** Total measured page views behind the median. */
  readonly samples = computed(() => this.engagement()?.samples ?? 0);
  /** Per-page medians (already longest-first, floor-gated, from the server). */
  readonly pages = computed<EngagementPageStat[]>(() => this.engagement()?.byPage ?? []);

  /**
   * Dwell-distribution rungs — the % of ALL measured visits that stayed past each threshold.
   * Empty when there's no distribution or no samples (so the block hides rather than showing 0%s).
   */
  readonly rungs = computed<EngagementRung[]>(() => {
    const d = this.engagement()?.distribution;
    const total = this.samples();
    if (!d || total <= 0) return [];
    const rate = (n: number) => Math.round((n / total) * 100);
    return [
      { label: '≥10s', count: d.s10, percent: rate(d.s10) },
      { label: '≥30s', count: d.s30, percent: rate(d.s30) },
      { label: '≥1m', count: d.s60, percent: rate(d.s60) },
      { label: '≥3m', count: d.s180, percent: rate(d.s180) },
    ];
  });

  /** Template helper — format a ms dwell compactly. */
  dwell(ms: number): string {
    return formatDwell(ms);
  }
}
