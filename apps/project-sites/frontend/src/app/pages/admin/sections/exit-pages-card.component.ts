/**
 * Top exit pages card — the exit-page block of `/admin/analytics`, the complement to the entry
 * (landing) pages card.
 *
 * Fetches `GET /api/sites/:siteId/analytics/exit-pages` independently of the main summary load,
 * so it degrades on its own and never complicates the parent fetch.
 *
 * HONESTY: "exit page" = the LAST page recorded in a session (tab-scoped, cookieless — the last
 * `page_engagement` before the tab/session ends, grouped by the session id). A multi-tab session or
 * a direct API poll can shift counts. This is explicitly labelled. All-empty → honest empty state.
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

/** Shape of `GET /api/sites/:siteId/analytics/exit-pages`. */
export interface ExitPagesResponse {
  pages: { path: string; count: number }[];
}

@Component({
  selector: 'app-exit-pages-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card xp" data-testid="exit-pages-card" aria-label="Top exit pages">
      <div class="xp-kicker">Exit</div>
      <h3 class="xp-head">
        <span class="xp-title">Top exit pages</span>
        <span
          class="xp-sub"
          data-testid="xp-source"
          title="Where visitors leave from (a session's last page; tab-scoped, cookieless)."
          >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · tab-scoped,
          cookieless</span
        >
      </h3>

      @if (loading()) {
        <div class="xp-state" data-testid="xp-loading" aria-live="polite">
          Loading exit-page data…
        </div>
      } @else if (errored()) {
        <div class="xp-state" data-testid="xp-error" aria-live="assertive">
          Exit-page data is temporarily unavailable. It will reappear on the next refresh.
        </div>
      } @else if (isEmpty()) {
        <p class="xp-empty" data-testid="xp-empty" aria-live="polite">No exit-page data yet.</p>
      } @else {
        <ol class="xp-list" data-testid="xp-list">
          @for (row of pages(); track row.path) {
            <li class="xp-row" data-testid="exit-pages-row">
              <div class="xp-row-head">
                <span class="xp-path" title="{{ row.path }}">{{ row.path }}</span>
                <span class="xp-count" data-testid="xp-count">{{
                  row.count.toLocaleString()
                }}</span>
              </div>
              <div class="xp-bar" aria-hidden="true">
                <div class="xp-bar-fill" [style.width.%]="barWidth(row.count)"></div>
              </div>
            </li>
          }
        </ol>

        <p class="xp-disclaimer" data-testid="xp-disclaimer">
          Where visitors leave from (a session's last page; tab-scoped, cookieless).
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
      .xp-kicker {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .xp-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0.25rem 0 0.9rem;
      }
      .xp-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .xp-sub {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        cursor: help;
      }
      .xp-state {
        font-size: 0.72rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .xp-empty {
        margin: 0;
        font-size: 0.72rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .xp-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.7rem;
      }
      .xp-row-head {
        display: flex;
        justify-content: space-between;
        gap: 0.6rem;
        margin-bottom: 0.2rem;
      }
      .xp-path {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.72rem;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .xp-count {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }
      .xp-bar {
        height: 5px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        overflow: hidden;
      }
      .xp-bar-fill {
        height: 100%;
        border-radius: 999px;
        min-width: 0;
        background: linear-gradient(
          90deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent),
          var(--ps-accent, #00e5ff)
        );
      }
      .xp-disclaimer {
        margin: 0.6rem 0 0;
        font-size: 0.62rem;
        line-height: 1.4;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
        font-style: italic;
      }
    `,
  ],
})
export class ExitPagesCardComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label and the API request. */
  readonly windowDays = input<number>(30);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<ExitPagesResponse | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  /** Monotonic token — drops stale in-flight responses when the site switches. */
  private reqToken = 0;

  constructor() {
    effect(() => {
      const id = this.siteId();
      const days = this.windowDays();
      this.resp.set(null);
      this.errored.set(false);
      if (!id) {
        this.loading.set(false);
        return;
      }
      const token = ++this.reqToken;
      this.loading.set(true);
      this.api
        .get<ExitPagesResponse>(`/sites/${id}/analytics/exit-pages`, { days: String(days) })
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

  readonly pages = computed(() => this.resp()?.pages ?? []);

  /** True when the pages array is empty (or no response) — the honest empty state. */
  readonly isEmpty = computed(
    () => !this.loading() && !this.errored() && this.resp() !== null && this.pages().length === 0,
  );

  /** The count of the top exit page (first item, already sorted desc). */
  readonly topCount = computed(() => this.pages()[0]?.count ?? 0);

  /**
   * Bar width for a given row count, scaled relative to the top exit page (100%).
   * Floor at 4% so a small-count row stays visible.
   */
  barWidth(count: number): number {
    const top = this.topCount();
    return top > 0 ? Math.max(4, Math.round((count / top) * 100)) : 0;
  }
}
