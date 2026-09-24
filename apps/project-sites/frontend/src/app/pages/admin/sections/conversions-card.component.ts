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
        <div class="conv-total" data-testid="an-conv-total">{{ total() }} total</div>
        <ul class="conv-list">
          @for (it of items(); track it.raw) {
            <li class="conv-row" data-testid="an-conv-row">
              <div class="conv-row-head">
                <span class="conv-label">{{ it.label }}</span>
                <span class="conv-count">{{ it.count }}</span>
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
    .conv-total { font-size: 0.72rem; font-variant-numeric: tabular-nums; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); margin-bottom: 0.6rem; }
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
