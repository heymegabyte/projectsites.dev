/**
 * Network-quality card — first-party VISITOR CONNECTION QUALITY for `/admin/analytics`.
 * Standalone, presentational (Angular style guide): signals + `input()` + native control
 * flow, no fetching. Reads `traffic.networkQuality` (the `navigator.connection` estimate
 * beaconed by app.js `network_quality` on load → `visitor_events`).
 *
 * HONESTY: `navigator.connection` is CHROMIUM-ONLY (Chrome / Edge / Android) — Safari/Firefox
 * visitors are NOT in this sample, and the card SAYS so, so the split is never read as "all
 * visitors". Medians are `null` → "measuring…" (never a fabricated 0). The distribution is
 * real counts / total samples; classes with no visits are omitted, never shown as 0.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One connection-class bucket + how many visits were on it. */
export interface NetworkClassStat {
  type: string;
  count: number;
}

/** The `traffic.networkQuality` shape. */
export interface NetworkQualityBlock {
  samples: number;
  byEffectiveType: NetworkClassStat[];
  medianDownlinkMbps: number | null;
  medianRttMs: number | null;
  saveDataPercent: number | null;
  byPage?: NetworkSlowPage[];
}

/** One page whose visitors have a slow median connection (mobile-hostile page). */
export interface NetworkSlowPage {
  path: string;
  medianDownlinkMbps: number;
  medianRttMs: number | null;
  samples: number;
}

/** A distribution rung for the template (class + reach rate). */
export interface NetworkRung {
  type: string;
  label: string;
  count: number;
  percent: number;
}

/** Human labels for the effectiveType classes (the raw values are terse). */
const CLASS_LABELS: Record<string, string> = {
  'slow-2g': 'Slow 2G',
  '2g': '2G',
  '3g': '3G',
  '4g': '4G / fast',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-network-quality-card',
  standalone: true,
  styles: [
    `
    .nq { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .nq-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .nq-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .nq-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .nq-stats { display: flex; flex-wrap: wrap; gap: 0.9rem; margin-bottom: 0.2rem; }
    .nq-stat { display: flex; flex-direction: column; }
    .nq-val { font-size: 1.25rem; font-weight: 700; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .nq-lbl { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .nq-samples { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); margin-top: 0.15rem; }
    .nq-measuring { font-size: 0.76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .nq-dist { margin: 0.7rem 0 0; display: grid; gap: 0.3rem; }
    .nq-rung { display: grid; grid-template-columns: 5rem 1fr auto; gap: 0.5rem; align-items: center; font-size: 0.72rem; }
    .nq-rung-lbl { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); }
    .nq-bar { height: 0.5rem; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .nq-bar-fill { height: 100%; border-radius: 999px; background: var(--ps-accent, #00e5ff); }
    .nq-rung-pct { color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .nq-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .nq-pages { margin: 0.75rem 0 0; padding: 0.7rem 0 0; border-top: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .nq-pages-h { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); margin-bottom: 0.3rem; }
    .nq-page-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
    .nq-page-row { display: flex; justify-content: space-between; gap: 0.6rem; font-size: 0.72rem; }
    .nq-page-path { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .nq-page-ms { color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
    .nq-page-rtt { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    `,
  ],
  template: `
    <section class="nq" data-testid="an-network" aria-label="Visitor connection quality">
      <div class="nq-head">
        <span class="nq-title"><span aria-hidden="true">📶</span> Visitor connection</span>
        <span class="nq-win">last {{ windowDays() }} days</span>
      </div>

      @if (hasData()) {
        <div class="nq-stats">
          @if (medianDownlink() !== null) {
            <div class="nq-stat">
              <span class="nq-val" data-testid="an-network-downlink">{{ medianDownlink() }} Mbps</span>
              <span class="nq-lbl">median downlink</span>
            </div>
          }
          @if (medianRtt() !== null) {
            <div class="nq-stat">
              <span class="nq-val" data-testid="an-network-rtt">{{ medianRtt() }} ms</span>
              <span class="nq-lbl">median round-trip</span>
            </div>
          }
          @if (saveData() !== null) {
            <div class="nq-stat">
              <span class="nq-val" data-testid="an-network-savedata">{{ saveData() }}%</span>
              <span class="nq-lbl">on data-saver</span>
            </div>
          }
        </div>
        <div class="nq-samples">across {{ samples().toLocaleString() }} measured visit{{ samples() === 1 ? '' : 's' }}</div>

        @if (dist().length) {
          <div class="nq-dist" role="list" aria-label="Connection classes">
            @for (r of dist(); track r.type) {
              <div class="nq-rung" role="listitem" data-testid="an-network-rung">
                <span class="nq-rung-lbl">{{ r.label }}</span>
                <span class="nq-bar"><span class="nq-bar-fill" [style.width.%]="r.percent"></span></span>
                <span class="nq-rung-pct" [attr.aria-label]="r.percent + '% of measured visits on ' + r.label + ' (' + r.count + ')'">{{ r.percent }}%</span>
              </div>
            }
          </div>
        }
        @if (slowestPages().length) {
          <div class="nq-pages" data-testid="an-network-pages">
            <div class="nq-pages-h">Pages with the slowest-connection visitors</div>
            <ul class="nq-page-list">
              @for (pg of slowestPages(); track pg.path) {
                <li class="nq-page-row" data-testid="an-network-page">
                  <span class="nq-page-path" [attr.title]="pg.path">{{ pg.path }}</span>
                  <span class="nq-page-ms">
                    {{ pg.medianDownlinkMbps }} Mbps
                    @if (pg.medianRttMs !== null) {
                      <span class="nq-page-rtt" title="Median round-trip time for this page's visitors">· {{ pg.medianRttMs }} ms</span>
                    }
                  </span>
                </li>
              }
            </ul>
          </div>
        }

        <p class="nq-note">
          First-party — the connection your visitors browse on, so you know how light the site
          must stay. <strong>Chromium only</strong> (Chrome, Edge, Android report it; Safari &amp;
          Firefox don't), so this is a sample of visitors, not all. Cloudflare's plan has no
          connection dataset.
        </p>
      } @else {
        <p class="nq-measuring" data-testid="an-network-empty" aria-live="polite">
          Measuring — no connection samples yet.
        </p>
        <p class="nq-note">
          Connection quality is reported first-party by Chromium browsers (Chrome, Edge, Android).
          A real value appears once such visitors browse your site — never a fabricated 0.
        </p>
      }
    </section>
  `,
})
export class NetworkQualityCardComponent {
  /** The `traffic.networkQuality` block (undefined on older payloads → treated as measuring). */
  readonly networkQuality = input<NetworkQualityBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Total measured (Chromium) visits behind the split. */
  readonly samples = computed(() => this.networkQuality()?.samples ?? 0);
  /** True once there's at least one sample (else the card shows "measuring…"). */
  readonly hasData = computed(() => this.samples() > 0);
  readonly medianDownlink = computed<number | null>(() => this.networkQuality()?.medianDownlinkMbps ?? null);
  readonly medianRtt = computed<number | null>(() => this.networkQuality()?.medianRttMs ?? null);
  readonly saveData = computed<number | null>(() => this.networkQuality()?.saveDataPercent ?? null);

  /**
   * The effectiveType distribution as display rungs — each class's share of total samples.
   * Empty when there are no samples (guarded by the template). A 0-sample denominator can't
   * occur here; classes with no visits were already omitted server-side.
   */
  readonly dist = computed<NetworkRung[]>(() => {
    const b = this.networkQuality();
    if (!b || b.samples <= 0) {
      return [];
    }
    return b.byEffectiveType.map((c) => ({
      type: c.type,
      label: CLASS_LABELS[c.type] ?? c.type,
      count: c.count,
      percent: Math.round((100 * c.count) / b.samples),
    }));
  });

  /** Pages whose visitors have the slowest median connection (server-provided, slowest-first). */
  readonly slowestPages = computed<NetworkSlowPage[]>(() => this.networkQuality()?.byPage ?? []);
}
