/**
 * Page-load waterfall card — first-party PAGE-LOAD BREAKDOWN for `/admin/analytics`.
 * Standalone, presentational (Angular style guide): signals + `input()` + native control
 * flow, no fetching. Reads `traffic.navTiming` (the PerformanceNavigationTiming phase
 * durations beaconed by app.js `nav_timing` on load → `visitor_events`).
 *
 * HONESTY: each phase is a MEDIAN measured INDEPENDENTLY, so the phases do NOT sum exactly to
 * the total — the card shows them as comparable bars (scaled to the largest phase) beside the
 * total headline, never as a strict decomposition that would over-claim precision. A phase of
 * 0 (cached DNS / reused connection) is a REAL value; a `null` total → "measuring…", never a
 * fabricated 0. This is the edge-latency breakdown Cloudflare's plan can't provide.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** The `traffic.navTiming` shape. */
export interface NavTimingBlock {
  samples: number;
  dns: number | null;
  connect: number | null;
  ttfb: number | null;
  transfer: number | null;
  dom: number | null;
  total: number | null;
}

/** One phase row for the waterfall. */
export interface NavPhaseRow {
  key: string;
  label: string;
  ms: number;
  percent: number;
}

/** Phase order + human labels (load order). `total` is the headline, not a bar. */
const PHASES: ReadonlyArray<{ key: keyof NavTimingBlock; label: string }> = [
  { key: 'dns', label: 'DNS lookup' },
  { key: 'connect', label: 'Connect (TCP + TLS)' },
  { key: 'ttfb', label: 'Server wait (TTFB)' },
  { key: 'transfer', label: 'Download' },
  { key: 'dom', label: 'DOM build' },
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-nav-timing-card',
  standalone: true,
  styles: [
    `
    .nt { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .nt-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .nt-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .nt-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .nt-figure { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.2rem; }
    .nt-total { font-size: 1.5rem; font-weight: 700; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .nt-total-lbl { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .nt-samples { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .nt-measuring { font-size: 0.76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .nt-rows { margin: 0.7rem 0 0; display: grid; gap: 0.3rem; }
    .nt-row { display: grid; grid-template-columns: 8.5rem 1fr auto; gap: 0.5rem; align-items: center; font-size: 0.72rem; }
    .nt-row-lbl { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); }
    .nt-bar { height: 0.5rem; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .nt-bar-fill { height: 100%; border-radius: 999px; background: var(--ps-accent, #00e5ff); }
    .nt-row-ms { color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .nt-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    `,
  ],
  template: `
    <section class="nt" data-testid="an-navtiming" aria-label="Page load breakdown">
      <div class="nt-head">
        <span class="nt-title"><span aria-hidden="true">⏬</span> Page load breakdown</span>
        <span class="nt-win">last {{ windowDays() }} days</span>
      </div>

      @if (total() !== null) {
        <div class="nt-figure">
          <span class="nt-total" data-testid="an-navtiming-total">{{ fmt(total()!) }}</span>
          <span class="nt-total-lbl">median total load</span>
        </div>
        <div class="nt-samples">across {{ samples().toLocaleString() }} measured page load{{ samples() === 1 ? '' : 's' }}</div>

        <div class="nt-rows" role="list" aria-label="Load phases">
          @for (p of phases(); track p.key) {
            <div class="nt-row" role="listitem" data-testid="an-navtiming-phase">
              <span class="nt-row-lbl">{{ p.label }}</span>
              <span class="nt-bar"><span class="nt-bar-fill" [style.width.%]="p.percent"></span></span>
              <span class="nt-row-ms">{{ fmt(p.ms) }}</span>
            </div>
          }
        </div>
        <p class="nt-note">
          First-party — where your pages spend their load time, measured in every browser by the
          ProjectSites beacon (Cloudflare's plan has no latency dataset). Each phase is an
          <strong>independent median</strong>, so they don't sum exactly to the total; a 0 is real
          (cached DNS / reused connection).
        </p>
      } @else {
        <p class="nt-measuring" data-testid="an-navtiming-empty" aria-live="polite">
          Measuring — no page-load samples yet.
        </p>
        <p class="nt-note">
          Page-load timing is measured first-party on every page. A real breakdown appears here once
          visitors load your site — never a fabricated 0.
        </p>
      }
    </section>
  `,
})
export class NavTimingCardComponent {
  /** The `traffic.navTiming` block (undefined on older payloads → treated as measuring). */
  readonly navTiming = input<NavTimingBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Median total load in ms, or null when no samples (shows "measuring…"). */
  readonly total = computed<number | null>(() => this.navTiming()?.total ?? null);
  /** Measured page loads behind the medians. */
  readonly samples = computed(() => this.navTiming()?.samples ?? 0);

  /**
   * The phase rows, each bar scaled to the LARGEST phase median (so bars compare phases to each
   * other — NOT a decomposition of the total). A phase with a null median is omitted (never a
   * fabricated 0); a real 0 renders with an empty bar. Empty when there are no phase values.
   */
  readonly phases = computed<NavPhaseRow[]>(() => {
    const b = this.navTiming();
    if (!b) {
      return [];
    }
    const present = PHASES.map((p) => ({ ...p, ms: b[p.key] })).filter(
      (p): p is { key: keyof NavTimingBlock; label: string; ms: number } => typeof p.ms === 'number',
    );
    const max = present.reduce((m, p) => Math.max(m, p.ms), 0);
    return present.map((p) => ({
      key: String(p.key),
      label: p.label,
      ms: p.ms,
      percent: max > 0 ? Math.round((100 * p.ms) / max) : 0,
    }));
  });

  /** Format a ms duration compactly: "820ms" · "1.2s". */
  fmt(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }
}
