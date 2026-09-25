/**
 * New vs returning visitors card — the visitor-loyalty block of `/admin/analytics`.
 *
 * Fetches `GET /api/sites/:siteId/analytics/visitors` independently of the main
 * summary load, so it degrades on its own and never complicates the parent fetch.
 *
 * HONESTY: "new" = browser's first-ever visit (no prior session cookie on that
 * device/browser); "returning" = seen before on the SAME browser. A new device or
 * cleared storage looks identical to a new visitor — this is explicitly labelled.
 * Only `new + returning` form the denominator for percentages; `unknownVisits`
 * (visits the server couldn't classify) is shown as a muted footnote, never
 * blended into the percentage. All-zero → explicit honest empty state.
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

/** Shape of `GET /api/sites/:siteId/analytics/visitors`. */
export interface VisitorTypeResponse {
  newVisits: number;
  returningVisits: number;
  unknownVisits: number;
}

@Component({
  selector: 'app-visitor-type-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card vt" data-testid="visitor-type-card" aria-label="New vs returning visitors">
      <div class="vt-kicker">Loyalty</div>
      <h3 class="vt-head">
        <span class="vt-title">New vs returning</span>
        <span
          class="vt-sub"
          data-testid="vt-source"
          title="Visitor type based on a first-party session token set on the first visit — same-browser tracking only."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · first-party cookie</span>
      </h3>

      @if (loading()) {
        <div class="vt-state" data-testid="vt-loading" aria-live="polite">Loading visitor data…</div>
      } @else if (errored()) {
        <div class="vt-state" data-testid="vt-error" aria-live="assertive">
          Visitor-type data is temporarily unavailable. It will reappear on the next refresh.
        </div>
      } @else if (isEmpty()) {
        <p class="vt-empty" data-testid="vt-empty" aria-live="polite">
          No engagement data yet.
        </p>
      } @else {
        <!-- Split bars: new vs returning, denominator = new + returning only -->
        <div class="vt-split" data-testid="vt-split">
          <!-- New -->
          <div class="vt-row" data-testid="vt-row-new">
            <div class="vt-row-head">
              <span class="vt-label">New</span>
              <span class="vt-count" data-testid="vt-count-new">
                {{ newVisits().toLocaleString() }}
                <span class="vt-pct" data-testid="vt-pct-new">· {{ newPct() }}%</span>
              </span>
            </div>
            <div class="vt-bar" aria-hidden="true">
              <div
                class="vt-bar-fill vt-bar-new"
                [style.width.%]="newBarWidth()"
              ></div>
            </div>
          </div>

          <!-- Returning -->
          <div class="vt-row" data-testid="vt-row-returning">
            <div class="vt-row-head">
              <span class="vt-label">Returning</span>
              <span class="vt-count" data-testid="vt-count-returning">
                {{ returningVisits().toLocaleString() }}
                <span class="vt-pct" data-testid="vt-pct-returning">· {{ returningPct() }}%</span>
              </span>
            </div>
            <div class="vt-bar" aria-hidden="true">
              <div
                class="vt-bar-fill vt-bar-returning"
                [style.width.%]="returningBarWidth()"
              ></div>
            </div>
          </div>
        </div>

        @if (unknownVisits() > 0) {
          <p class="vt-unknown" data-testid="vt-unknown">
            ({{ unknownVisits().toLocaleString() }} {{ unknownVisits() === 1 ? 'visit' : 'visits' }} couldn't be classified)
          </p>
        }

        <p class="vt-disclaimer" data-testid="vt-disclaimer">
          New = a browser's first-ever visit; returning = seen before (same browser only — a new device or cleared storage counts as new).
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .card { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .vt-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .vt-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .vt-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .vt-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .vt-state { font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .vt-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .vt-split { display: grid; gap: 0.7rem; }
    .vt-row-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .vt-label { font-size: 0.78rem; color: #fff; }
    .vt-count { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .vt-pct { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-size: 0.9em; font-variant-numeric: tabular-nums; }
    .vt-bar { height: 5px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .vt-bar-fill { height: 100%; border-radius: 999px; min-width: 0; }
    .vt-bar-new { background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .vt-bar-returning { background: linear-gradient(90deg, color-mix(in oklch, #7C3AED 70%, transparent), #7C3AED); }
    .vt-unknown { margin: 0.5rem 0 0; font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .vt-disclaimer { margin: 0.6rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-style: italic; }
  `],
})
export class VisitorTypeCardComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label and the API request. */
  readonly windowDays = input<number>(30);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<VisitorTypeResponse | null>(null);
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
        .get<VisitorTypeResponse>(`/sites/${id}/analytics/visitors`, { days: String(days) })
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

  readonly newVisits = computed(() => this.resp()?.newVisits ?? 0);
  readonly returningVisits = computed(() => this.resp()?.returningVisits ?? 0);
  readonly unknownVisits = computed(() => this.resp()?.unknownVisits ?? 0);

  /**
   * True when all three counts are 0 (or no response) — the honest empty state.
   * A site with data will always have at least one non-zero bucket.
   */
  readonly isEmpty = computed(
    () =>
      !this.loading() &&
      !this.errored() &&
      this.resp() !== null &&
      this.newVisits() === 0 &&
      this.returningVisits() === 0 &&
      this.unknownVisits() === 0,
  );

  /**
   * Denominator for percentage calculations — new + returning ONLY.
   * Unknown visits are excluded so the split sums to 100% across the two known buckets.
   */
  readonly classifiedTotal = computed(() => this.newVisits() + this.returningVisits());

  readonly newPct = computed(() => {
    const t = this.classifiedTotal();
    return t > 0 ? Math.round((this.newVisits() / t) * 100) : 0;
  });

  readonly returningPct = computed(() => {
    const t = this.classifiedTotal();
    return t > 0 ? Math.round((this.returningVisits() / t) * 100) : 0;
  });

  /** Bar widths: each bar is scaled to the LARGER of the two, with a 4% floor. */
  readonly newBarWidth = computed(() => {
    const max = Math.max(this.newVisits(), this.returningVisits());
    return max > 0 ? Math.max(4, Math.round((this.newVisits() / max) * 100)) : 0;
  });

  readonly returningBarWidth = computed(() => {
    const max = Math.max(this.newVisits(), this.returningVisits());
    return max > 0 ? Math.max(4, Math.round((this.returningVisits() / max) * 100)) : 0;
  });
}
