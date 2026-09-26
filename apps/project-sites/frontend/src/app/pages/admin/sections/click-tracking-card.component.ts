/**
 * Most-clicked buttons card — the UI-interaction block of `/admin/analytics`.
 *
 * Fetches `GET /api/sites/:siteId/analytics/clicks` independently of the main summary load, so it
 * degrades on its own and never complicates the parent fetch.
 *
 * HONESTY: a tracked "interaction" = a click on a button / [role=button] / summary / opt-in
 * [data-ps-track] element, labelled by its text/aria-label. This DELIBERATELY EXCLUDES outbound /
 * tel / mailto / CTA clicks (those are conversions, counted in Traffic & Conversions) and page
 * navigations (those are pageviews) — so a click is never double-counted. `total` is the honest sum
 * across ALL labels (not just the top-10 shown). All-empty → explicit honest empty state (the beacon
 * runs on every page, so "measuring…" — never a fabricated 0).
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

/** Shape of `GET /api/sites/:siteId/analytics/clicks`. */
export interface ClicksResponse {
  total: number;
  byLabel: { label: string; count: number }[];
}

@Component({
  selector: 'app-click-tracking-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card clk" data-testid="click-tracking-card" aria-label="Most-clicked buttons">
      <div class="clk-kicker">Interactions</div>
      <h3 class="clk-head">
        <span class="clk-title">Most-clicked buttons</span>
        <span
          class="clk-sub"
          data-testid="clk-source"
          title="Buttons, toggles + marked elements visitors click. Excludes links, calls + CTAs (those are conversions) and page views."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · cookieless</span>
      </h3>

      @if (loading()) {
        <div class="clk-state" data-testid="clk-loading" aria-live="polite">Loading interaction data…</div>
      } @else if (errored()) {
        <div class="clk-state" data-testid="clk-error" aria-live="assertive">
          Interaction data is temporarily unavailable. It will reappear on the next refresh.
        </div>
      } @else if (isEmpty()) {
        <p class="clk-empty" data-testid="clk-empty" aria-live="polite">
          Measuring… button clicks appear here as visitors interact with the site.
        </p>
      } @else {
        <p class="clk-total" data-testid="clk-total">
          <strong>{{ total().toLocaleString() }}</strong> {{ total() === 1 ? 'interaction' : 'interactions' }} tracked
        </p>
        <ol class="clk-list" data-testid="clk-list">
          @for (row of byLabel(); track row.label) {
            <li class="clk-row" data-testid="click-row">
              <div class="clk-row-head">
                <span class="clk-label" title="{{ row.label }}">{{ row.label }}</span>
                <span class="clk-count" data-testid="clk-count">{{ row.count.toLocaleString() }}</span>
              </div>
              <div class="clk-bar" aria-hidden="true">
                <div class="clk-bar-fill" [style.width.%]="barWidth(row.count)"></div>
              </div>
            </li>
          }
        </ol>

        <p class="clk-disclaimer" data-testid="clk-disclaimer">
          Buttons, toggles + marked elements only — links, calls + CTAs are counted as conversions, and
          page views as traffic (never double-counted). Labelled by button text; cookieless.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .card { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .clk-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .clk-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .clk-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .clk-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .clk-state { font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .clk-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .clk-total { margin: 0 0 0.8rem; font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
    .clk-total strong { color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .clk-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
    .clk-row-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .clk-label { font-size: 0.72rem; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .clk-count { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .clk-bar { height: 5px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .clk-bar-fill { height: 100%; border-radius: 999px; min-width: 0; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .clk-disclaimer { margin: 0.6rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-style: italic; }
  `],
})
export class ClickTrackingCardComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label and the API request. */
  readonly windowDays = input<number>(30);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<ClicksResponse | null>(null);
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
        .get<ClicksResponse>(`/sites/${id}/analytics/clicks`, { days: String(days) })
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

  readonly byLabel = computed(() => this.resp()?.byLabel ?? []);
  readonly total = computed(() => this.resp()?.total ?? 0);

  /** True when the response arrived with no labels — the honest empty state. */
  readonly isEmpty = computed(
    () => !this.loading() && !this.errored() && this.resp() !== null && this.byLabel().length === 0,
  );

  /** The count of the top interaction (first item, already sorted desc). */
  readonly topCount = computed(() => this.byLabel()[0]?.count ?? 0);

  /**
   * Bar width for a given row count, scaled relative to the top interaction (100%).
   * Floor at 4% so a small-count row stays visible.
   */
  barWidth(count: number): number {
    const top = this.topCount();
    return top > 0 ? Math.max(4, Math.round((count / top) * 100)) : 0;
  }
}
