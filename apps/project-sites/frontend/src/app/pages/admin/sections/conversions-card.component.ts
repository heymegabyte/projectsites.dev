/**
 * Conversions card — the "outcomes" block of `/admin/analytics`.
 *
 * Renders conversions broken down by kind (phone calls / directions / form
 * submissions / …) from `traffic.byConversionKind` — the actual business outcomes
 * a small-business owner acts on. Focused, standalone, presentational component
 * (Angular style guide): signals + `input()` + native control flow, no fetching.
 *
 * HONEST: every count is a real tracked `conversion` event — never an estimate. The
 * empty state says "no conversions tracked yet", never a fabricated 0-row breakdown.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { TrendBadge } from './trend-badge.model';

/** One `{ label(kind), count }` conversion-kind row from `traffic.byConversionKind`. */
export interface ConversionKind {
  label: string;
  count: number;
}

/** Human labels for the kinds the site beacon emits; unknown kinds title-case. */
const CONVERSION_LABELS: Record<string, string> = {
  call: 'Phone calls',
  directions: 'Directions',
  form_submit: 'Form submissions',
  form: 'Form submissions',
  email: 'Email clicks',
  mailto: 'Email clicks',
  sms: 'Text messages',
  booking: 'Bookings',
  newsletter: 'Newsletter signups',
  cta: 'CTA clicks',
  chat: 'Chat opens',
  other: 'Other conversions',
};

@Component({
  selector: 'app-conversions-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card conv" data-testid="an-conversions">
      <div class="conv-kicker">Outcomes</div>
      <h3 class="conv-head">
        <span class="conv-title">Conversions</span>
        <span class="conv-sub">last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }}</span>
      </h3>

      @if (items().length) {
        <div class="conv-total" data-testid="an-conv-total">
          <span>{{ total() }} total</span>
          @if (delta(); as d) {
            <span class="trend-chip" data-testid="an-conv-trend"
                  [attr.data-dir]="d.dir" [attr.aria-label]="d.aria" [title]="d.title">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                @if (d.dir === 'up') { <path d="M6 15l6-6 6 6"/> }
                @else if (d.dir === 'down') { <path d="M6 9l6 6 6-6"/> }
                @else { <path d="M5 12h14"/> }
              </svg>
              {{ d.label }}
            </span>
          }
        </div>
        <ul class="conv-list">
          @for (it of items(); track it.raw) {
            <li class="conv-row" data-testid="an-conv-row">
              <div class="conv-row-head">
                <span class="conv-label">{{ it.label }}</span>
                <span class="conv-row-meta">
                  @if (kindDeltas()[it.raw]; as kd) {
                    <span class="trend-chip trend-chip--sm"
                          [attr.data-testid]="'an-conv-kind-trend-' + it.raw"
                          [attr.data-dir]="kd.dir" [attr.aria-label]="it.label + ' ' + kd.aria" [title]="kd.title">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        @if (kd.dir === 'up') { <path d="M6 15l6-6 6 6"/> }
                        @else if (kd.dir === 'down') { <path d="M6 9l6 6 6-6"/> }
                        @else { <path d="M5 12h14"/> }
                      </svg>
                      {{ kd.label }}
                    </span>
                  }
                  <span class="conv-count">{{ it.count }}</span>
                </span>
              </div>
              <div class="conv-bar" aria-hidden="true">
                <div class="conv-bar-fill" [style.width.%]="barWidth(it.count)"></div>
              </div>
            </li>
          }
        </ul>
      } @else {
        <p class="conv-empty" data-testid="an-conv-empty">
          No conversions tracked yet. Phone calls, directions, form submissions, and other
          actions your visitors take appear here — a real count, never an estimate.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .conv-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .conv-head { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.25rem 0 0.4rem; }
    .conv-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .conv-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .conv-total { display: inline-flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; font-size: 0.72rem; font-variant-numeric: tabular-nums; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); margin-bottom: 0.6rem; }
    .trend-chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 7px 1px 5px; border-radius: 999px;
      font-size: 0.64rem; font-weight: 700; line-height: 1.4;
      font-variant-numeric: tabular-nums; border: 1px solid transparent;
    }
    .trend-chip svg { flex-shrink: 0; }
    .trend-chip--sm { padding: 0px 5px 0px 3px; font-size: 0.58rem; font-weight: 700; }
    .conv-row-meta { display: inline-flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
    .trend-chip[data-dir="up"] {
      color: var(--ps-accent, #00E5FF);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 32%, transparent);
    }
    .trend-chip[data-dir="down"] {
      color: rgba(255,255,255,0.62);
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 5%, transparent);
      border-color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
    }
    .trend-chip[data-dir="flat"] {
      color: rgba(255,255,255,0.5);
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
      border-color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
    }
    .conv-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
    .conv-row-head { display: flex; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.2rem; }
    .conv-label { font-size: 0.82rem; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-count { font-size: 0.78rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .conv-bar { height: 6px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .conv-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .conv-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class ConversionsCardComponent {
  /** `traffic.byConversionKind` — one row per conversion kind. */
  readonly rows = input<ConversionKind[]>([]);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);
  /**
   * Period-over-period conversions trend vs the authoritative prior equal-length
   * window (computed by the parent from `traffic.previous.conversions`). `null` when
   * there's nothing to compare — the chip simply doesn't render, never a fake "0%".
   */
  readonly delta = input<TrendBadge | null>(null);
  /**
   * Per-kind period-over-period deltas, keyed by the RAW kind label (`it.raw`) — a small
   * trend chip on each row (calls up, form-submits down). A kind absent here (nothing to
   * compare) simply shows no chip. Computed by the parent from `previous.byConversionKind`.
   */
  readonly kindDeltas = input<Record<string, TrendBadge>>({});

  /** Non-empty rows, humanized + sorted by count desc. */
  readonly items = computed(() =>
    [...this.rows()]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ label: this.humanize(r.label), count: r.count, raw: r.label })),
  );
  readonly total = computed(() => this.items().reduce((sum, r) => sum + r.count, 0));
  private readonly max = computed(() => this.items().reduce((m, r) => Math.max(m, r.count), 0));

  /** Human label for a conversion kind; unknown kinds are title-cased. */
  humanize(kind: string): string {
    const key = (kind || 'other').toLowerCase();
    return (
      CONVERSION_LABELS[key] ??
      key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  /** Bar width as a % of the largest count (min 4% so a small bar is still visible). */
  barWidth(count: number): number {
    const m = this.max();
    return m > 0 ? Math.max(4, Math.round((count / m) * 100)) : 0;
  }
}
