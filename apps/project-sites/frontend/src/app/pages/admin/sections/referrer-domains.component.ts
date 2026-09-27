/**
 * Top referring domains card — "where off-site traffic comes from" (e.g. news.ycombinator.com,
 * reddit.com), distinct from the coarse channel bucket. Fetches
 * `GET /api/sites/:siteId/analytics/referrers` independently of the main summary load.
 *
 * HONESTY: EXTERNAL referrers only — the site's OWN hosts are excluded server-side, so internal
 * navigation is never miscounted as a referral. Rows are NOT click-to-filter (the drilldown filters
 * on the RAW referrer, not the parsed domain — a domain drill would risk a label≠value lying-empty),
 * but the card re-scopes when another filter is active. `capped` discloses long-tail undercount.
 * All-empty → honest empty state, never a fabricated 0.
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

/** Shape of `GET /api/sites/:siteId/analytics/referrers`. */
export interface ReferrerDomainsResponse {
  domains: { label: string; count: number }[];
  capped: boolean;
}

@Component({
  selector: 'app-referrer-domains',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card rd" data-testid="referrer-domains-card" aria-label="Top referring sites">
      <div class="rd-kicker">Acquisition</div>
      <h3 class="rd-head">
        <span class="rd-title">Top referring sites</span>
        <span
          class="rd-sub"
          data-testid="rd-source"
          title="External sites that sent visitors here (your own domain is excluded). First-party, from the referrer of each visit."
          >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · external only</span
        >
      </h3>

      @if (loading()) {
        <div class="rd-state" data-testid="rd-loading" aria-live="polite">Loading referrer data…</div>
      } @else if (errored()) {
        <div class="rd-state" data-testid="rd-error" aria-live="assertive">
          Referrer data is temporarily unavailable. It will reappear on the next refresh.
        </div>
      } @else if (isEmpty()) {
        <p class="rd-empty" data-testid="rd-empty" aria-live="polite">
          No external referrers tracked yet — visitors are arriving directly or from untracked sources.
        </p>
      } @else {
        <ol class="rd-list" data-testid="rd-list">
          @for (row of domains(); track row.label) {
            <li class="rd-row" data-testid="referrer-domains-row">
              <div class="rd-row-head">
                <span class="rd-domain" title="{{ row.label }}">{{ row.label }}</span>
                <span class="rd-count" data-testid="rd-count">{{ row.count.toLocaleString() }}</span>
              </div>
              <div class="rd-bar" aria-hidden="true">
                <div class="rd-bar-fill" [style.width.%]="barWidth(row.count)"></div>
              </div>
            </li>
          }
        </ol>

        @if (capped()) {
          <p class="rd-note" data-testid="rd-capped">
            Showing the busiest referrers — a very long tail of one-off links may be undercounted.
          </p>
        }
        <p class="rd-disclaimer" data-testid="rd-disclaimer">
          External sites that sent visitors here; your own domain is excluded.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-xl, 16px);
        background: rgba(255, 255, 255, 0.02);
        padding: 0.9rem 1rem;
      }
      .rd-kicker {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .rd-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0.25rem 0 0.9rem;
      }
      .rd-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .rd-sub {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        cursor: help;
      }
      .rd-state,
      .rd-empty {
        margin: 0;
        font-size: 0.72rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .rd-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.7rem;
      }
      .rd-row-head {
        display: flex;
        justify-content: space-between;
        gap: 0.6rem;
        margin-bottom: 0.2rem;
      }
      .rd-domain {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.72rem;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .rd-count {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }
      .rd-bar {
        height: 5px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        overflow: hidden;
      }
      .rd-bar-fill {
        height: 100%;
        border-radius: 999px;
        min-width: 0;
        background: linear-gradient(
          90deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent),
          var(--ps-accent, #00e5ff)
        );
      }
      .rd-note,
      .rd-disclaimer {
        margin: 0.6rem 0 0;
        font-size: 0.62rem;
        line-height: 1.4;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
        font-style: italic;
      }
    `,
  ],
})
export class ReferrerDomainsComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label + the API request. */
  readonly windowDays = input<number>(30);
  /** Active drilldown filter (from the parent) — re-scopes the list; rows are not click-to-filter. */
  readonly activeFilter = input<{ dim: string; value: string } | null>(null);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<ReferrerDomainsResponse | null>(null);
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
      const params: Record<string, string> = {
        days: String(days),
        tz: String(-new Date().getTimezoneOffset()),
      };
      if (f) {
        params['filterDim'] = f.dim;
        params['filterValue'] = f.value;
      }
      this.api
        .get<ReferrerDomainsResponse>(`/sites/${id}/analytics/referrers`, params)
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

  readonly domains = computed(() => this.resp()?.domains ?? []);
  readonly capped = computed(() => this.resp()?.capped === true);

  /** True when there are no external referrers — the honest empty state. */
  readonly isEmpty = computed(
    () => !this.loading() && !this.errored() && this.resp() !== null && this.domains().length === 0,
  );

  private readonly topCount = computed(() => this.domains()[0]?.count ?? 0);

  /** Bar width scaled to the top referrer (100%); floor 4% so a small non-zero row stays visible. */
  barWidth(count: number): number {
    const top = this.topCount();
    if (top <= 0 || count <= 0) return 0;
    return Math.max(4, Math.round((count / top) * 100));
  }
}
