/**
 * "Generation speed + cost" dashboard card (fire-61 — north star: generation
 * speed + cost visible at a glance).
 *
 * Super-admin-only (mounted behind the dashboard's `isSysAdmin()` gate; the
 * worker endpoint re-checks authoritatively and the card self-hides on any
 * fetch failure, so a non-operator can never see a broken card).
 *
 * Flag-gated: the `build_metrics` worker endpoint 404s when its flag is OFF
 * (the default — dark). So on init the card resolves `build_metrics` FIRST and
 * only fetches the summary + starts live-refresh when the flag is ON; OFF /
 * unknown / errored → it renders nothing and issues ZERO summary requests, so
 * a dark flag never logs a 404 in the browser console (`{ silent }` suppresses
 * only the toast, not the network-level console error). The self-hide-on-404
 * below is kept as defense-in-depth. Reads
 * `GET /api/admin/build-metrics/summary` — the fire-60 `build_metrics` rollup:
 *
 *  - headline p50 build time vs the <5min target + avg cost vs the ≤$1 target,
 *    each with a delta chip (green when under, amber when over);
 *  - an inline-SVG sparkline of the last ≤30 build durations (no chart dep);
 *  - a per-phase p50 breakdown row (collecting / imaging / generating / publishing);
 *  - an HONEST empty state while zero builds are measured (the table is fresh;
 *    the 2.8min figure is the audit-log-reconstructed baseline, labeled as such).
 *
 * Freshness: visibility-aware 60s auto-refresh mirroring `AdminStateService` —
 * paused while `document.hidden`, immediate refresh on tab-return. No manual
 * refresh control (real-time-data doctrine).
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CmdGlyphComponent } from '../../../../components/cmd-glyph/cmd-glyph.component';
import { ApiService, flagEnabled } from '../../../../services/api.service';

/**
 * The feature flag that gates the `build_metrics` worker endpoint. The server
 * returns 404 when this flag is OFF (dark by default), so the card MUST resolve
 * it to ON before ever calling `/admin/build-metrics/summary` — otherwise the
 * browser logs a network-level 404 on every /admin load (which `{ silent }`
 * only hides from the toast, not from the console).
 */
const BUILD_METRICS_FLAG = 'build_metrics';

/** Per-phase p50 durations (ms); null = not yet measured in-window. */
export interface PhaseP50 {
  collecting: number | null;
  imaging: number | null;
  generating: number | null;
  publishing: number | null;
}

/** One build in the trailing series (chronological, oldest → newest). */
export interface BuildSeriesPoint {
  started_at: string;
  total_ms: number | null;
  est_cost_usd: number;
  outcome: 'published' | 'error' | 'halted';
}

/** Mirror of the worker's BuildMetricsSummarySchema (routes/admin_build_metrics). */
export interface BuildMetricsSummary {
  windowDays: number;
  builds: number;
  p50_ms: number | null;
  p95_ms: number | null;
  avg_cost_usd: number | null;
  total_cost_usd: number | null;
  phase_p50: PhaseP50;
  series: BuildSeriesPoint[];
}

/** One delta chip vs a target. */
interface TargetDelta {
  label: string;
  under: boolean;
}

/** One phase chip in the breakdown row. */
interface PhaseChip {
  key: string;
  label: string;
  value: string;
}

/** North-star delivery target: a published site in under 5 minutes. */
const SPEED_TARGET_MS = 300_000;
/** North-star unit-economics target: ≤ $1 estimated cost per build. */
const COST_TARGET_USD = 1;
/** Refresh cadence — mirrors AdminStateService's analytics tier (60s). */
const REFRESH_MS = 60_000;

/** Human duration: 168000 → "2.8min", 42000 → "42s", 0 → "0s", null → "—". */
function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round((ms / 60_000) * 10) / 10}min`;
}

@Component({
  selector: 'app-generation-metrics-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CmdGlyphComponent],
  template: `
    @if (!hidden() && !failed()) {
      <section class="gen-card" aria-labelledby="gen-h" data-testid="gen-metrics-card">
        <div class="gen-head">
          <h2 class="gen-title" id="gen-h">
            <app-cmd-glyph name="rocket" /> Generation speed + cost
          </h2>
          <span class="gen-live" aria-hidden="true"><span class="gen-live-dot"></span> Live</span>
        </div>

        @if (summary(); as s) {
          @if (s.builds === 0) {
            <p class="gen-empty" data-testid="gen-empty">
              No measured builds yet — baseline p50 2.8min from history. New builds are measured
              automatically and appear here as they publish.
            </p>
          } @else {
            <div class="gen-headline">
              <div class="gen-stat">
                <span class="gen-value" data-testid="gen-p50">{{ formatMs(s.p50_ms) }}</span>
                <span class="gen-label">
                  p50 build time · p95 {{ formatMs(s.p95_ms) }} · {{ s.builds }}
                  {{ s.builds === 1 ? 'build' : 'builds' }} / {{ s.windowDays }}d
                </span>
                @if (speedDelta(); as d) {
                  <span
                    class="gen-chip"
                    [class.ok]="d.under"
                    [class.warn]="!d.under"
                    data-testid="gen-speed-chip"
                    >{{ d.label }}</span
                  >
                }
              </div>

              <div class="gen-stat">
                <span class="gen-value" data-testid="gen-cost">{{
                  formatUsd(s.avg_cost_usd)
                }}</span>
                <span class="gen-label">
                  avg cost / build · {{ formatUsd(s.total_cost_usd) }} total
                </span>
                @if (costDelta(); as d) {
                  <span
                    class="gen-chip"
                    [class.ok]="d.under"
                    [class.warn]="!d.under"
                    data-testid="gen-cost-chip"
                    >{{ d.label }}</span
                  >
                }
              </div>

              @if (sparkPoints(); as pts) {
                <div class="gen-spark-wrap">
                  <svg
                    class="gen-spark"
                    viewBox="0 0 100 28"
                    preserveAspectRatio="none"
                    role="img"
                    [attr.aria-label]="
                      'Build duration trend across the last ' + s.series.length + ' builds'
                    "
                  >
                    <polyline
                      [attr.points]="pts"
                      fill="none"
                      stroke="var(--ps-accent, #00e5ff)"
                      stroke-width="1.6"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </svg>
                  <span class="gen-spark-cap">last {{ s.series.length }} builds</span>
                </div>
              }
            </div>

            <ul class="gen-phases" aria-label="Per-phase p50 durations" data-testid="gen-phases">
              @for (p of phaseChips(); track p.key) {
                <li class="gen-phase">
                  <span class="gen-phase-label">{{ p.label }}</span>
                  <span class="gen-phase-value">{{ p.value }}</span>
                </li>
              }
            </ul>
          }
        } @else if (loading()) {
          <div class="gen-skel" aria-hidden="true" data-testid="gen-skeleton">
            <div class="gen-skel-line" style="width: 9rem"></div>
            <div class="gen-skel-line" style="width: 14rem"></div>
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      .gen-card {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--ps-radius-xl, 22px);
        background:
          linear-gradient(160deg, rgba(0, 229, 255, 0.05), transparent 42%),
          rgba(255, 255, 255, 0.025);
        padding: 18px 20px;
        margin: 14px 0 18px;
      }
      .gen-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .gen-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: var(--ps-ink, #f4f4ff);
        margin: 0;
      }
      .gen-live {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(244, 244, 255, 0.55);
      }
      .gen-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 8px var(--ps-accent, #00e5ff);
        animation: gen-pulse 2.4s ease-in-out infinite;
      }
      @keyframes gen-pulse {
        50% {
          opacity: 0.35;
        }
      }
      .gen-headline {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 22px 34px;
      }
      .gen-stat {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 150px;
      }
      .gen-value {
        font-size: 1.65rem;
        font-weight: 800;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
        color: var(--ps-ink, #f4f4ff);
      }
      .gen-label {
        font-size: 0.72rem;
        color: rgba(244, 244, 255, 0.55);
      }
      .gen-chip {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 600;
        border: 1px solid transparent;
        margin-top: 2px;
      }
      .gen-chip.ok {
        color: #4ade80;
        border-color: rgba(74, 222, 128, 0.35);
        background: rgba(74, 222, 128, 0.08);
      }
      .gen-chip.warn {
        color: #fbbf24;
        border-color: rgba(251, 191, 36, 0.35);
        background: rgba(251, 191, 36, 0.08);
      }
      .gen-spark-wrap {
        flex: 1 1 160px;
        min-width: 140px;
        max-width: 280px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-self: center;
      }
      .gen-spark {
        width: 100%;
        height: 44px;
        display: block;
        opacity: 0.9;
      }
      .gen-spark-cap {
        font-size: 0.66rem;
        text-align: right;
        color: rgba(244, 244, 255, 0.45);
      }
      .gen-phases {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        list-style: none;
        margin: 14px 0 0;
        padding: 0;
      }
      .gen-phase {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 24px;
        padding: 4px 11px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.09);
        background: rgba(255, 255, 255, 0.03);
      }
      .gen-phase-label {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(244, 244, 255, 0.5);
      }
      .gen-phase-value {
        font-size: 0.78rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--ps-accent, #00e5ff);
      }
      .gen-empty {
        margin: 2px 0 0;
        font-size: 0.82rem;
        line-height: 1.5;
        color: rgba(244, 244, 255, 0.6);
      }
      .gen-skel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 6px 0 2px;
      }
      .gen-skel-line {
        height: 14px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.06);
        animation: gen-pulse 1.6s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .gen-live-dot,
        .gen-skel-line {
          animation: none;
        }
      }
    `,
  ],
})
export class GenerationMetricsCardComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly summary = signal<BuildMetricsSummary | null>(null);
  readonly loading = signal(true);
  /** Any fetch failure (403 / network / 500) hides the card entirely. */
  readonly failed = signal(false);
  /**
   * Starts hidden (fail-safe) and flips to visible ONLY after `build_metrics`
   * resolves ON. While hidden the card renders nothing AND never calls the
   * summary endpoint — so a dark flag produces zero console 404s. Unknown /
   * errored flag resolution leaves it hidden.
   */
  readonly hidden = signal(true);

  private alive = true;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Bound handler so removeEventListener works on teardown (AdminStateService pattern). */
  private readonly visibilityHandler = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.stopLiveRefresh();
    } else if (this.alive && !this.hidden() && !this.failed()) {
      // Resume + one immediate fetch so tab-return shows fresh numbers.
      // Never fires while hidden (flag OFF) — the endpoint would 404.
      this.fetchSummary();
      this.startLiveRefresh();
    }
  };

  /** Delta vs the <5min speed target — green when under. */
  readonly speedDelta = computed<TargetDelta | null>(() => {
    const p50 = this.summary()?.p50_ms ?? null;
    if (p50 === null) return null;
    const under = p50 <= SPEED_TARGET_MS;
    return {
      label: `${formatMs(Math.abs(SPEED_TARGET_MS - p50))} ${under ? 'under' : 'over'} 5min target`,
      under,
    };
  });

  /** Delta vs the ≤$1 avg-cost target — green when under. */
  readonly costDelta = computed<TargetDelta | null>(() => {
    const avg = this.summary()?.avg_cost_usd ?? null;
    if (avg === null) return null;
    const under = avg <= COST_TARGET_USD;
    return {
      label: `$${Math.abs(COST_TARGET_USD - avg).toFixed(2)} ${under ? 'under' : 'over'} $1 target`,
      under,
    };
  });

  /**
   * SVG polyline points over the non-null series durations, normalized into a
   * 100×28 viewBox (2px vertical inset). Null when <2 measured points — a
   * one-point "trend" is noise, not signal.
   */
  readonly sparkPoints = computed<string | null>(() => {
    const series = this.summary()?.series ?? [];
    const values = series
      .map((p) => p.total_ms)
      .filter((v): v is number => v !== null && v !== undefined);
    if (values.length < 2) return null;
    const max = Math.max(...values, 1);
    const step = 100 / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(1)},${(26 - (v / max) * 24).toFixed(1)}`)
      .join(' ');
  });

  /** Phase breakdown chips — honest values ("0s" is data; "—" means unmeasured). */
  readonly phaseChips = computed<PhaseChip[]>(() => {
    const p = this.summary()?.phase_p50;
    if (!p) return [];
    return [
      { key: 'collecting', label: 'Collecting', value: formatMs(p.collecting) },
      { key: 'imaging', label: 'Imaging', value: formatMs(p.imaging) },
      { key: 'generating', label: 'Generating', value: formatMs(p.generating) },
      { key: 'publishing', label: 'Publishing', value: formatMs(p.publishing) },
    ];
  });

  ngOnInit(): void {
    // Gate on the flag FIRST — never fetch the dark `build_metrics` endpoint
    // (404 when the flag is OFF, which is the default). Flag ON → reveal +
    // fetch + live-refresh. OFF / unknown / transport error → stay hidden,
    // render nothing, issue zero summary requests (no console 404).
    this.api
      .getFeatureFlag(BUILD_METRICS_FLAG)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (!this.alive) return;
          if (flagEnabled(r)) {
            this.hidden.set(false);
            this.fetchSummary();
            this.startLiveRefresh();
          } else {
            this.hidden.set(true);
            this.loading.set(false);
          }
        },
        error: () => {
          // Resolution failed (incl. 404 for an unregistered flag) → fail safe.
          this.hidden.set(true);
          this.loading.set(false);
        },
      });
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.stopLiveRefresh();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /** Template helpers (pure). */
  formatMs(ms: number | null | undefined): string {
    return formatMs(ms);
  }

  formatUsd(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
  }

  /**
   * `{ silent: true }` — a background operator widget must degrade quietly
   * (self-hide), never fire the global "Can't reach the server" toast.
   */
  private fetchSummary(): void {
    this.api
      .get<BuildMetricsSummary>('/admin/build-metrics/summary', undefined, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.summary.set(s);
          this.loading.set(false);
          this.failed.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.failed.set(true);
          this.stopLiveRefresh();
        },
      });
  }

  private startLiveRefresh(): void {
    this.stopLiveRefresh();
    if (typeof document !== 'undefined') {
      // Idempotent — the browser dedupes identical (element, type, listener) triples.
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.refreshTimer = setInterval(() => {
      if (this.alive && !this.failed()) this.fetchSummary();
    }, REFRESH_MS);
  }

  private stopLiveRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
