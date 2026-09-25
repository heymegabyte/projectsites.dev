/**
 * `app-weekday-breakdown` — "Busiest days": first-party pageviews by day-of-week, bucketed
 * in the OWNER's local timezone SERVER-SIDE (a weekday histogram can't be rotated client-side
 * like hour-of-day, so the server does it tz-correct). Complements the hourly card: hour-of-day
 * answers "when in the day", weekday answers "which day of the week".
 *
 * Fetches `GET /api/sites/:siteId/analytics/weekday?days=&tz=&filterDim=&filterValue=` on its
 * own, so it degrades independently and participates in the drilldown filter (a `country=US`
 * drill re-scopes the weekday chart too). HONESTY: an all-zero window shows an empty state,
 * never fake bars; the `tzApplied` flag drives whether we say "your local time" or "UTC".
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';

/** One `{ weekday, count }` bucket. `weekday` is SQLite `strftime('%w')`: 0 = Sunday … 6 = Saturday. */
export interface WeekdayCount {
  readonly weekday: number;
  readonly count: number;
}

/** Shape of `GET /api/sites/:siteId/analytics/weekday`. */
export interface WeekdayResponse {
  readonly byWeekday: WeekdayCount[];
  readonly tzApplied: boolean;
}

/** 3-letter labels indexed by `strftime('%w')` (0 = Sunday). */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Full names for titles / aria, same 0–6 index. */
export const WEEKDAY_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Densify sparse server buckets into a fixed 7-slot Sun→Sat array (missing weekdays → 0),
 * summing any duplicate/out-of-range-safe rows. Pure — never mutates input.
 *
 * @example densifyWeekdays([{weekday:6,count:12}]) // slot 6 (Sat) = 12, rest 0
 */
export function densifyWeekdays(rows: readonly WeekdayCount[]): WeekdayCount[] {
  const dense: WeekdayCount[] = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));
  for (const r of rows ?? []) {
    if (r == null || r.weekday < 0 || r.weekday > 6) continue;
    dense[r.weekday] = { weekday: r.weekday, count: dense[r.weekday].count + (r.count || 0) };
  }
  return dense;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-weekday-breakdown',
  standalone: true,
  template: `
    <section class="wb" data-testid="an-weekday" aria-labelledby="wb-h">
      <header class="wb-head">
        <h3 class="wb-title" id="wb-h">Busiest days</h3>
        <span class="wb-note" data-testid="an-weekday-note"
          >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · {{ basisLabel() }}</span
        >
      </header>

      @if (loading()) {
        <p class="wb-state" data-testid="an-weekday-loading" aria-live="polite">Loading day-of-week data…</p>
      } @else if (errored()) {
        <p class="wb-state" data-testid="an-weekday-error" aria-live="assertive">
          Day-of-week data is temporarily unavailable. It will reappear on the next refresh.
        </p>
      } @else if (hasData()) {
        <p class="wb-peak" data-testid="an-weekday-peak">
          Busiest: <strong>{{ peakFull() }}</strong> · {{ peak()!.count }}
          {{ peak()!.count === 1 ? 'view' : 'views' }}
        </p>
        <div class="wb-bars" role="img" [attr.aria-label]="ariaLabel()">
          @for (b of dense(); track b.weekday) {
            <div class="wb-col" [attr.data-testid]="'an-weekday-col-' + b.weekday">
              <span
                class="wb-bar"
                [class.wb-bar-peak]="b.weekday === peak()!.weekday"
                [style.height.%]="barPct(b.count)"
                [title]="barTitle(b)"
              ></span>
              <span class="wb-lab" aria-hidden="true">{{ label(b.weekday) }}</span>
            </div>
          }
        </div>
      } @else {
        <p class="wb-empty" data-testid="an-weekday-empty">
          No pageviews yet — your busiest days appear once visitors arrive.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .wb {
        padding: 16px 18px;
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-lg, 16px);
        background: var(--ps-surface-1, rgba(255, 255, 255, 0.02));
      }
      .wb-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 0.6rem;
      }
      .wb-title {
        margin: 0;
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .wb-note {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .wb-peak {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
      }
      .wb-peak strong {
        color: var(--ps-accent, #00e5ff);
      }
      .wb-bars {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        height: 72px;
      }
      .wb-col {
        flex: 1 1 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        height: 100%;
      }
      .wb-bar {
        width: 100%;
        min-height: 2px;
        border-radius: 3px 3px 0 0;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 22%, transparent);
        transition: background var(--ps-dur-fast, 140ms) var(--ps-ease-out, ease);
      }
      .wb-bar-peak {
        background: var(--ps-accent, #00e5ff);
      }
      .wb-lab {
        font-size: 0.58rem;
        font-variant-numeric: tabular-nums;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .wb-state,
      .wb-empty {
        margin: 0;
        font-size: 0.82rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      @media (prefers-reduced-motion: reduce) {
        .wb-bar {
          transition: none;
        }
      }
    `,
  ],
})
export class WeekdayBreakdownComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label + the API request. */
  readonly windowDays = input<number>(30);
  /** Active drilldown filter (from the parent) — re-scopes the chart, mirrors the other cards. */
  readonly activeFilter = input<{ dim: string; value: string } | null>(null);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<WeekdayResponse | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  private reqToken = 0;

  constructor() {
    effect(() => {
      const id = this.siteId();
      const days = this.windowDays();
      const f = this.activeFilter();
      this.resp.set(null);
      this.errored.set(false);
      if (!id) {
        this.loading.set(false);
        return;
      }
      const token = ++this.reqToken;
      this.loading.set(true);
      // east-positive offset (PST = -480), matching the server's tz convention.
      const params: Record<string, string> = {
        days: String(days),
        tz: String(-new Date().getTimezoneOffset()),
      };
      if (f) {
        params['filterDim'] = f.dim;
        params['filterValue'] = f.value;
      }
      this.api
        .get<WeekdayResponse>(`/sites/${id}/analytics/weekday`, params)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            if (token !== this.reqToken) return;
            this.resp.set(r);
            this.loading.set(false);
          },
          error: () => {
            if (token !== this.reqToken) return;
            this.errored.set(true);
            this.loading.set(false);
          },
        });
    });
  }

  /** Dense Sun→Sat 7-slot array (missing weekdays as 0). */
  readonly dense = computed<WeekdayCount[]>(() => densifyWeekdays(this.resp()?.byWeekday ?? []));

  /** True when any weekday has a pageview (else the honest empty state renders). */
  readonly hasData = computed<boolean>(() => this.dense().some((b) => b.count > 0));

  /** The busiest weekday (max count), or null when there's no data. */
  readonly peak = computed<WeekdayCount | null>(() => {
    const rows = this.dense();
    if (!this.hasData()) return null;
    return rows.reduce((best, b) => (b.count > best.count ? b : best), rows[0]);
  });

  private readonly maxCount = computed<number>(() =>
    this.dense().reduce((m, b) => Math.max(m, b.count), 0),
  );

  /** Whether buckets are the owner's LOCAL weekday (server confirmed `tzApplied`) or UTC. */
  readonly localApplied = computed<boolean>(() => this.resp()?.tzApplied === true);

  /** Honest freshness/basis label — never claims local precision the server didn't compute. */
  basisLabel(): string {
    return this.localApplied() ? 'your local time' : 'UTC';
  }

  /** Bar height as a % of the busiest day (floor 2% so a non-zero day is always visible). */
  barPct(count: number): number {
    const max = this.maxCount();
    if (max <= 0 || count <= 0) return 0;
    return Math.max(2, Math.round((count / max) * 100));
  }

  label(weekday: number): string {
    return WEEKDAY_LABELS[weekday] ?? '?';
  }

  peakFull(): string {
    const p = this.peak();
    return p ? (WEEKDAY_FULL[p.weekday] ?? '—') : '—';
  }

  barTitle(b: WeekdayCount): string {
    return `${WEEKDAY_FULL[b.weekday]}: ${b.count} ${b.count === 1 ? 'view' : 'views'}`;
  }

  ariaLabel(): string {
    const p = this.peak();
    const basis = this.localApplied() ? 'local time' : 'UTC';
    return p
      ? `Pageviews by day of week (${basis}). Busiest: ${this.peakFull()} with ${p.count} views.`
      : `Pageviews by day of week (${basis}).`;
  }
}
