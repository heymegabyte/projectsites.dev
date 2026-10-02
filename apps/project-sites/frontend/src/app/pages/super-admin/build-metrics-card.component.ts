/**
 * @module pages/super-admin/build-metrics-card
 * @description North-star "generation speed + cost" card (fire-75) — the
 * read-only surface that makes the website-generation SPEED + COST baseline
 * VISIBLE to a super-admin. "You can't optimize what you can't see."
 *
 * Reads the worker rollup `GET /api/admin/build-metrics/summary?days=30`
 * (route: `src/routes/admin_build_metrics.ts`) over the always-on fire-and-
 * forget `build_metrics` D1 instrument (migration `0652_build_metrics.sql`).
 * Renders:
 *   - p50 / p95 build wall-clock (PUBLISHED builds only — speed = time-to-live)
 *   - avg $-per-build (spans ALL terminal outcomes — failures cost money too)
 *   - a trailing per-build sparkline (last 30 builds, chronological) — a tiny
 *     zero-dep inline SVG polyline (lighter than echarts for a sparkline; heavy
 *     charting stays lazy-only per the frontend perf doctrine)
 *   - the N most-recent builds (duration · cost · outcome)
 *
 * ## Flag gate (mirrors the worker contract exactly)
 * Gated by the `build_metrics` flag (DARK by default). The worker runs the flag
 * gate BEFORE the super-admin check: off → hard **404** for everyone (existence
 * never leaked). This component mirrors that — `isOn('build_metrics')` resolves
 * false → the card renders **nothing** (`@if (flagOn())`), so a flag-off estate
 * shows no trace of the feature. The endpoint would 404 anyway; gating the fetch
 * on the flag avoids a pointless 404 round-trip and keeps display == store.
 *
 * ## Display reconciles with the store (verify-against-source-of-truth)
 * Every number shown is read verbatim from the summary endpoint, which is a
 * direct `SELECT` over `build_metrics`:
 *   - p50/p95 → `SELECT total_ms … WHERE outcome='published' ORDER BY total_ms
 *     LIMIT 1 OFFSET floor((n-1)·f)` (nearest-rank)
 *   - avg cost → `SELECT AVG(est_cost_usd) FROM build_metrics WHERE started_at >= ?`
 *   - recent → `SELECT started_at,total_ms,est_cost_usd,outcome … ORDER BY
 *     started_at DESC LIMIT 30`
 * No client-side derivation invents data — an empty store yields an honest
 * "no builds recorded yet" empty state, never fabricated zeros.
 *
 * ## Real-time (no manual Refresh button)
 * Visibility-aware poll (120s) — pauses on `document.hidden`, immediate refresh
 * on foreground — per `real-time-data-no-manual-refresh`. Builds are infrequent,
 * so a slow cadence keeps the baseline current without burning requests. No
 * Refresh control.
 *
 * @packageDocumentation
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, interval } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { FeatureFlagService } from '../../services/feature-flag.service';
import { RevealDirective } from '../../directives/reveal.directive';

/** Flag key gating this card + the worker read endpoint (DARK by default). */
const BUILD_METRICS_FLAG = 'build_metrics';
/** North-star target wall-clock (5 min) — the "fast" threshold for colour. */
const TARGET_MS = 5 * 60_000;
/** North-star target $-per-build ($1) — the "cheap" threshold for colour. */
const TARGET_COST_USD = 1;
/** Visibility-aware poll cadence (ms). Builds are infrequent → slow is fine. */
const POLL_MS = 120_000;

/** One build in the trailing series (shape mirrors the worker response). */
interface BuildSeriesPoint {
  started_at: string;
  total_ms: number | null;
  est_cost_usd: number;
  outcome: string;
}

/** The summary response contract (shape mirrors `BuildMetricsSummarySchema`). */
interface BuildMetricsSummary {
  windowDays: number;
  builds: number;
  p50_ms: number | null;
  p95_ms: number | null;
  avg_cost_usd: number | null;
  total_cost_usd: number | null;
  phase_p50: {
    collecting: number | null;
    imaging: number | null;
    generating: number | null;
    publishing: number | null;
  };
  series: BuildSeriesPoint[];
}

@Component({
  selector: 'app-build-metrics-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective],
  template: `
    @if (flagOn()) {
      <div class="sa-card sa-ops-card bm-card" data-testid="sa-build-metrics" appReveal>
        <header class="sa-card-head bm-head">
          <div>
            <h2>Generation speed + cost</h2>
            <p class="muted small">North star: &lt;5 min · ≤$1 per build · last {{ windowDays() }}d</p>
          </div>
          <span class="bm-live" data-testid="sa-build-metrics-live" title="Updates automatically">
            <span class="bm-live-dot" aria-hidden="true"></span> live
          </span>
        </header>

        @if (errored()) {
          <p class="muted small bm-msg" data-testid="sa-build-metrics-error">
            Metrics unavailable right now.
          </p>
        } @else if (summary(); as s) {
          @if (s.builds === 0) {
            <p class="muted small bm-msg" data-testid="sa-build-metrics-empty">
              No builds recorded yet — the speed + cost baseline appears here after the first generation.
            </p>
          } @else {
            <div class="bm-kpis" data-testid="sa-build-metrics-kpis">
              <div class="bm-kpi">
                <span class="bm-kpi-label">p50 wall-clock</span>
                <span class="bm-kpi-val" [class.bm-good]="isFast(s.p50_ms)" data-testid="sa-build-metrics-p50">{{ fmtDuration(s.p50_ms) }}</span>
              </div>
              <div class="bm-kpi">
                <span class="bm-kpi-label">p95 wall-clock</span>
                <span class="bm-kpi-val" [class.bm-good]="isFast(s.p95_ms)" data-testid="sa-build-metrics-p95">{{ fmtDuration(s.p95_ms) }}</span>
              </div>
              <div class="bm-kpi">
                <span class="bm-kpi-label">avg $/build</span>
                <span class="bm-kpi-val" [class.bm-good]="isCheap(s.avg_cost_usd)" data-testid="sa-build-metrics-cost">{{ fmtCost(s.avg_cost_usd) }}</span>
              </div>
              <div class="bm-kpi">
                <span class="bm-kpi-label">builds</span>
                <span class="bm-kpi-val" data-testid="sa-build-metrics-count">{{ s.builds }}</span>
              </div>
            </div>

            @if (hasSparkline()) {
              <div class="bm-spark" data-testid="sa-build-metrics-spark" role="img"
                   [attr.aria-label]="'Build wall-clock trend over the last ' + durationSeries().length + ' builds'">
                <svg viewBox="0 0 100 28" preserveAspectRatio="none" class="bm-spark-svg" aria-hidden="true">
                  <polyline [attr.points]="sparkPoints()" fill="none" stroke="var(--ps-accent, #00e5ff)" stroke-width="1.4" vector-effect="non-scaling-stroke" />
                </svg>
                <span class="bm-spark-cap muted small">wall-clock · last {{ durationSeries().length }} builds</span>
              </div>
            }

            <ul class="bm-recent" data-testid="sa-build-metrics-recent">
              @for (b of recent(); track b.started_at) {
                <li class="bm-recent-row">
                  <span class="bm-recent-dur">{{ fmtDuration(b.total_ms) }}</span>
                  <span class="bm-recent-cost muted">{{ fmtCost(b.est_cost_usd) }}</span>
                  <span class="bm-pill" [attr.data-outcome]="b.outcome">{{ b.outcome }}</span>
                </li>
              }
            </ul>
          }
        } @else {
          <p class="muted small bm-msg" data-testid="sa-build-metrics-loading">Reading build metrics…</p>
        }
      </div>
    }
  `,
  styles: [
    `
      .bm-card { display: flex; flex-direction: column; gap: 0.85rem; }
      .bm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
      .bm-live { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); white-space: nowrap; }
      .bm-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ps-accent, #00e5ff); box-shadow: 0 0 0 0 color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent); animation: bm-pulse 2.4s ease-out infinite; }
      @keyframes bm-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @media (prefers-reduced-motion: reduce) { .bm-live-dot { animation: none; } }
      .bm-msg { margin: 0; }
      .bm-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem 1rem; }
      @media (min-width: 560px) { .bm-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .bm-kpi { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
      .bm-kpi-label { font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ps-ink-dim, rgba(255, 255, 255, 0.55)); }
      .bm-kpi-val { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; line-height: 1.1; }
      .bm-kpi-val.bm-good { color: var(--ps-accent, #00e5ff); }
      .bm-spark { display: flex; flex-direction: column; gap: 0.3rem; }
      .bm-spark-svg { width: 100%; height: 34px; display: block; }
      .bm-spark-cap { font-size: 0.6rem; }
      .bm-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
      .bm-recent-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 0.6rem; font-size: 0.78rem; font-variant-numeric: tabular-nums; padding: 0.15rem 0; border-top: 1px solid color-mix(in oklch, #fff 6%, transparent); }
      .bm-recent-row:first-child { border-top: 0; }
      .bm-recent-dur { color: #fff; font-weight: 600; }
      .bm-pill { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid color-mix(in oklch, #fff 14%, transparent); color: var(--ps-ink-dim, rgba(255, 255, 255, 0.6)); }
      .bm-pill[data-outcome='published'] { color: #34d399; border-color: color-mix(in oklch, #34d399 40%, transparent); }
      .bm-pill[data-outcome='error'] { color: #f87171; border-color: color-mix(in oklch, #f87171 40%, transparent); }
      .bm-pill[data-outcome='halted'] { color: #fbbf24; border-color: color-mix(in oklch, #fbbf24 40%, transparent); }
    `,
  ],
})
export class BuildMetricsCardComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly flags = inject(FeatureFlagService);
  private readonly destroyRef = inject(DestroyRef);

  /** How many recent builds to list. */
  private static readonly RECENT_LIMIT = 6;

  /** True once the `build_metrics` flag resolves on (fail-safe false). */
  readonly flagOn = signal(false);
  /** The latest summary, or null until the first fetch resolves. */
  readonly summary = signal<BuildMetricsSummary | null>(null);
  /** True when the summary fetch failed (shows a calm "unavailable" line). */
  readonly errored = signal(false);

  readonly windowDays = computed(() => this.summary()?.windowDays ?? 30);
  /** Most-recent builds first (endpoint returns chronological → reverse + cap). */
  readonly recent = computed<BuildSeriesPoint[]>(() => {
    const series = this.summary()?.series ?? [];
    return [...series].reverse().slice(0, BuildMetricsCardComponent.RECENT_LIMIT);
  });
  /** Chronological wall-clock values (published builds carry a duration). */
  readonly durationSeries = computed<number[]>(() =>
    (this.summary()?.series ?? [])
      .map((p) => p.total_ms)
      .filter((v): v is number => typeof v === 'number' && v >= 0),
  );
  readonly hasSparkline = computed(() => this.durationSeries().length >= 2);
  /** SVG polyline points (0..100 × 0..28) for the wall-clock sparkline. */
  readonly sparkPoints = computed(() => {
    const vals = this.durationSeries();
    if (vals.length < 2) return '';
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const span = max - min || 1;
    const stepX = 100 / (vals.length - 1);
    return vals
      .map((v, i) => {
        const x = (i * stepX).toFixed(2);
        // Invert Y (SVG origin top-left); 2px top/bottom padding inside 28 height.
        const y = (26 - ((v - min) / span) * 24 + 1).toFixed(2);
        return `${x},${y}`;
      })
      .join(' ');
  });

  private poll?: Subscription;

  ngOnInit(): void {
    this.flags
      .isOn(BUILD_METRICS_FLAG)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((on) => {
        this.flagOn.set(on);
        if (on) this.startLiveRefresh();
        else this.stopPolling();
      });
  }

  /** Visibility-aware poll — pause on hidden, immediate refresh on foreground. */
  private startLiveRefresh(): void {
    if (this.poll) return;
    this.fetch();
    this.poll = interval(POLL_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        this.fetch();
      });
    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (!document.hidden) this.fetch();
      };
      document.addEventListener('visibilitychange', onVisible);
      this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
    }
  }

  private stopPolling(): void {
    this.poll?.unsubscribe();
    this.poll = undefined;
  }

  /** Fetch the summary; the response is displayed verbatim (no derivation). */
  private fetch(): void {
    this.api
      .get<BuildMetricsSummary>('/admin/build-metrics/summary', { days: '30' }, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.summary.set(s);
          this.errored.set(false);
        },
        error: () => this.errored.set(true),
      });
  }

  // ---- formatting (pure, display-only — never invents data) ----

  /** True when a wall-clock value beats the 5-min north-star target. */
  isFast(ms: number | null): boolean {
    return typeof ms === 'number' && ms > 0 && ms <= TARGET_MS;
  }

  /** True when a cost value beats the $1 north-star target. */
  isCheap(usd: number | null): boolean {
    return typeof usd === 'number' && usd <= TARGET_COST_USD;
  }

  /** `168000` → `2m 48s`; null → `—` (honest absence, not a fake 0). */
  fmtDuration(ms: number | null): string {
    if (ms === null || ms === undefined || ms < 0) return '—';
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m <= 0) return `${s}s`;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  /** `0.58` → `$0.58`; null → `—`. Sub-cent shows 3dp so it's never a fake $0.00. */
  fmtCost(usd: number | null): string {
    if (usd === null || usd === undefined) return '—';
    if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
  }
}
