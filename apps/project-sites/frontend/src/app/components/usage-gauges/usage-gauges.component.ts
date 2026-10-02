import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';

/** One usage gauge, mirrors the worker `usage_gauges` shape. */
interface UsageGauge {
  metric: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
  pct: number;
}

/** `GET /api/usage` response. */
interface UsageResponse {
  data: UsageGauge[];
  period: string;
}

/**
 * Plan-usage gauges — the client for the `usage_gauges` feature. Shows the org's
 * current-period usage vs plan limits (sites / builds / media / bandwidth) as
 * labelled progress bars on the Billing "Plan & usage" tab.
 *
 * @remarks
 * The API IS the flag gate: `GET /api/usage` returns 404 when the `usage_gauges`
 * flag is off → the widget renders nothing. Over-limit metrics render in the
 * danger tone so an owner sees an overage before the next create 403s.
 *
 * @example
 * <app-usage-gauges />
 */
@Component({
  selector: 'app-usage-gauges',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <!-- Reserve the gauges card's height while /usage fetches, so the Credit wallet +
           Plan card below don't shift when it lands — the largest remaining /admin/billing
           layout-shift contributor (267px). aria-hidden; collapses (honest-empty) when the
           flag is off / no usage. -->
      <div class="card ug ug-skeleton" aria-hidden="true" data-testid="usage-gauges-skeleton">
        <div class="mb-3"><span class="ug-skel ug-skel-title"></span><span class="ug-skel ug-skel-sub"></span></div>
        <ul class="ug-list">
          @for (i of skelRows; track i) {
            <li class="ug-item">
              <div class="ug-row"><span class="ug-skel ug-skel-label"></span><span class="ug-skel ug-skel-val"></span></div>
              <div class="ug-track"></div>
            </li>
          }
        </ul>
      </div>
    } @else if (gauges().length > 0) {
      <div class="card ug" data-testid="usage-gauges">
        <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h3 class="m-0 text-base font-semibold text-white">Plan usage</h3>
            <p class="text-[0.7rem] text-text-secondary m-0 mt-1">Current period — usage against your plan limits.</p>
          </div>
        </div>
        <ul class="ug-list">
          @for (g of gauges(); track g.metric) {
            <li class="ug-item" [attr.data-testid]="'usage-gauge-' + g.metric">
              <div class="ug-row">
                <span class="ug-label">{{ g.label }}</span>
                <span class="ug-val" [class.ug-val--over]="isOver(g)" [attr.data-testid]="'usage-value-' + g.metric">
                  {{ g.used }} / {{ formatLimit(g) }}<span class="ug-unit"> {{ g.unit }}</span>
                </span>
              </div>
              <div class="ug-track" role="progressbar" [attr.aria-valuenow]="g.pct" aria-valuemin="0" aria-valuemax="100" [attr.aria-label]="g.label + ' usage'">
                <span class="ug-fill" [class]="'ug-fill--' + tone(g)" [style.width.%]="clampPct(g.pct)" [attr.data-testid]="'usage-bar-' + g.metric"></span>
              </div>
              @if (isOver(g)) {
                <div class="ug-over-row">
                  <p class="ug-over" [attr.data-testid]="'usage-over-' + g.metric">Over your plan limit — the next {{ g.label.toLowerCase() }} action will be blocked.</p>
                  <a
                    class="ug-upgrade"
                    routerLink="/admin/billing"
                    [attr.data-testid]="'usage-upgrade-' + g.metric"
                    [attr.aria-label]="'Upgrade your plan for more ' + g.label.toLowerCase() + ' headroom'"
                    >Upgrade for more headroom →</a
                  >
                </div>
              }
            </li>
          }
        </ul>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .ug { margin-top: 1rem; }
    .ug-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.9rem; }
    .ug-item { min-width: 0; }
    .ug-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.35rem; }
    .ug-label { font-size: 0.82rem; color: var(--ps-ink, #f4f4ff); font-weight: 600; }
    .ug-val { font-size: 0.8rem; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.7); }
    .ug-val--over { color: #f87171; font-weight: 700; }
    .ug-unit { color: rgba(255,255,255,0.4); }
    .ug-track { height: 8px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
    .ug-fill { display: block; height: 100%; border-radius: 999px; transition: width 0.5s ease; }
    @media (prefers-reduced-motion: reduce) { .ug-fill { transition: none; } }
    .ug-fill--ok { background: #34d399; }
    .ug-fill--warn { background: #fbbf24; }
    .ug-fill--danger { background: #f87171; }
    .ug-over-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin: 0.35rem 0 0; }
    .ug-over { font-size: 0.7rem; color: #f87171; margin: 0; }
    /* One-click fix — never leave an over-limit owner without an action. */
    .ug-upgrade { flex: none; font-size: 0.72rem; font-weight: 700; white-space: nowrap; text-decoration: none;
      color: var(--ps-bg, #060610); background: var(--ps-accent, #00e5ff); padding: 0.2rem 0.6rem; border-radius: 999px;
      transition: filter 0.15s ease; }
    .ug-upgrade:hover { filter: brightness(1.08); }
    .ug-upgrade:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    /* Loading skeleton — reuses .ug / .ug-item / .ug-track so its height matches the real
       gauges card (reserves space → no CLS when /usage lands). */
    .ug-skel { display: inline-block; border-radius: 6px; background: rgba(255,255,255,0.06); animation: ug-pulse 1.4s ease-in-out infinite; }
    .ug-skel-title { width: 6rem; height: 1rem; }
    .ug-skel-sub { display: block; width: 13rem; height: 0.7rem; margin-top: 6px; }
    .ug-skel-label { width: 5rem; height: 0.82rem; }
    .ug-skel-val { width: 3.5rem; height: 0.8rem; }
    @keyframes ug-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.9; } }
    @media (prefers-reduced-motion: reduce) { .ug-skel { animation: none; } }
  `],
})
export class UsageGaugesComponent implements OnInit {
  private readonly api = inject(ApiService);

  private readonly data = signal<UsageGauge[] | null>(null);
  readonly gauges = computed(() => this.data() ?? []);
  /** True until /usage resolves (data still null) — drives the height-reserving skeleton
   *  so the wallet + Plan card below don't shift when the gauges land. (data → [] on
   *  empty/error, so `=== null` cleanly means "still loading".) */
  readonly loading = computed(() => this.data() === null);
  /** Skeleton gauge placeholders — reserves a representative gauges-card height. */
  readonly skelRows = [0, 1, 2, 3];

  ngOnInit(): void {
    // `silent: true` — a 404 (flag off) is expected, never a user-facing toast.
    this.api.get<UsageResponse>('/usage', undefined, { silent: true }).subscribe({
      next: (res) => this.data.set(Array.isArray(res?.data) ? res.data : []),
      error: () => this.data.set([]),
    });
  }

  /** True when usage exceeds a finite limit. */
  isOver(g: UsageGauge): boolean {
    return g.limit > 0 && g.used > g.limit;
  }

  /** Bar tone by fill level / overage. */
  tone(g: UsageGauge): 'ok' | 'warn' | 'danger' {
    if (this.isOver(g) || g.pct >= 100) return 'danger';
    if (g.pct >= 75) return 'warn';
    return 'ok';
  }

  /** Never let the bar overflow its track. */
  clampPct(pct: number): number {
    return Math.max(0, Math.min(100, pct));
  }

  /** Show "∞" for an unlimited (<=0) limit. */
  formatLimit(g: UsageGauge): string {
    return g.limit > 0 ? String(g.limit) : '∞';
  }
}
