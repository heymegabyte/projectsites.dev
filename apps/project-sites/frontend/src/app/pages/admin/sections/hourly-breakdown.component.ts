import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One `{ hour, count }` bucket. `hour` is 0–23. */
export interface HourCount {
  readonly hour: number;
  readonly count: number;
}

/**
 * Rotate server UTC hour-of-day buckets to the viewer's LOCAL time, returning a dense
 * 24-slot array (`hour` = local 0–23, missing hours filled with 0). `offsetHours` is the
 * viewer's whole-hour offset east of UTC (e.g. EDT = -4, so `local = (utc - 4) mod 24`).
 * Half-hour zones round to the nearest hour (the card labels this as approximate).
 *
 * @example rotateToLocalHours([{hour:18,count:5}], -4) // → slot 14 (2 PM) has count 5
 */
export function rotateToLocalHours(utc: readonly HourCount[], offsetHours: number): HourCount[] {
  const local: HourCount[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const b of utc) {
    if (b.hour == null || b.hour < 0 || b.hour > 23) continue;
    const lh = (((b.hour + offsetHours) % 24) + 24) % 24;
    local[lh] = { hour: lh, count: local[lh].count + b.count };
  }
  return local;
}

/** Whole-hour offset east of UTC for the current browser (EDT → -4, IST → 6). */
function browserOffsetHours(): number {
  // getTimezoneOffset is minutes WEST of UTC; negate for east-positive, round to the hour.
  return Math.round(-new Date().getTimezoneOffset() / 60);
}

/** Human hour label — `14` → "2 PM", `0` → "12 AM". */
export function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${period}`;
}

/**
 * `app-hourly-breakdown` — "Busiest hours": first-party pageviews by hour-of-day, rotated
 * from the server's UTC buckets to the viewer's local time. Actionable for a local owner
 * ("your peak is 7–9 PM"). Honest: an all-zero window shows an empty state, never fake bars;
 * the local-time basis + half-hour-zone approximation are disclosed.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-hourly-breakdown',
  standalone: true,
  template: `
    <section class="hb" data-testid="an-hourly" aria-labelledby="hb-h">
      <header class="hb-head">
        <h3 class="hb-title" id="hb-h">Busiest hours</h3>
        <span class="hb-note" data-testid="an-hourly-note">last {{ windowDays() }} days · your local time</span>
      </header>

      @if (hasData()) {
        <p class="hb-peak" data-testid="an-hourly-peak">
          Peak: <strong>{{ peakLabel() }}</strong> · {{ peak()!.count }}
          {{ peak()!.count === 1 ? 'view' : 'views' }}
        </p>
        <div class="hb-bars" role="img" [attr.aria-label]="'Pageviews by hour, local time. ' + peakAria()">
          @for (b of local(); track b.hour) {
            <span
              class="hb-bar"
              [class.hb-bar-peak]="b.hour === peak()!.hour"
              [style.height.%]="barPct(b.count)"
              [attr.data-testid]="'an-hourly-bar-' + b.hour"
              [title]="hourTitle(b)"
            ></span>
          }
        </div>
        <div class="hb-axis" aria-hidden="true">
          <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
        </div>
        <p class="hb-fine">Hours are your browser's local time (±30 min for half-hour timezones).</p>
      } @else {
        <p class="hb-empty" data-testid="an-hourly-empty">
          No pageviews yet — your busiest hours appear once visitors arrive.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .hb {
        padding: 16px 18px;
        border: 1px solid var(--ps-hairline, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-lg, 16px);
        background: var(--ps-surface-1, rgba(255, 255, 255, 0.02));
      }
      .hb-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 0.6rem;
      }
      .hb-title {
        margin: 0;
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .hb-note {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .hb-peak {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
      }
      .hb-peak strong {
        color: var(--ps-accent, #00e5ff);
      }
      .hb-bars {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 64px;
      }
      .hb-bar {
        flex: 1 1 0;
        min-height: 2px;
        border-radius: 2px 2px 0 0;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 22%, transparent);
        transition: background var(--ps-dur-fast, 140ms) var(--ps-ease-out, ease);
      }
      .hb-bar-peak {
        background: var(--ps-accent, #00e5ff);
      }
      .hb-axis {
        display: flex;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 0.58rem;
        font-variant-numeric: tabular-nums;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .hb-fine {
        margin: 0.5rem 0 0;
        font-size: 0.6rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .hb-empty {
        margin: 0;
        font-size: 0.82rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      @media (prefers-reduced-motion: reduce) {
        .hb-bar {
          transition: none;
        }
      }
    `,
  ],
})
export class HourlyBreakdownComponent {
  /** Server UTC hour-of-day buckets (0–23). Rotated to local for display. */
  readonly hours = input<readonly HourCount[]>([]);
  /** Window length, for the honest "last N days" label. */
  readonly windowDays = input<number>(30);

  /** UTC buckets rotated to the viewer's local time — a dense 24-slot array. */
  readonly local = computed<HourCount[]>(() => rotateToLocalHours(this.hours(), browserOffsetHours()));

  /** True when any hour has a pageview (else the honest empty state renders). */
  readonly hasData = computed<boolean>(() => this.local().some((b) => b.count > 0));

  /** The busiest local hour (max count), or null when there's no data. */
  readonly peak = computed<HourCount | null>(() => {
    const rows = this.local();
    if (!this.hasData()) return null;
    return rows.reduce((best, b) => (b.count > best.count ? b : best), rows[0]);
  });

  private readonly maxCount = computed<number>(() =>
    this.local().reduce((m, b) => Math.max(m, b.count), 0),
  );

  /** Bar height as a % of the busiest hour (min 2% so a non-zero hour is always visible). */
  barPct(count: number): number {
    const max = this.maxCount();
    if (max <= 0 || count <= 0) return 0;
    return Math.max(2, Math.round((count / max) * 100));
  }

  /** "2 PM–3 PM" range label for the peak hour. */
  peakLabel(): string {
    const p = this.peak();
    if (!p) return '—';
    return `${formatHour(p.hour)}–${formatHour((p.hour + 1) % 24)}`;
  }

  peakAria(): string {
    const p = this.peak();
    return p ? `Busiest at ${this.peakLabel()} with ${p.count} views.` : '';
  }

  hourTitle(b: HourCount): string {
    return `${formatHour(b.hour)}: ${b.count} ${b.count === 1 ? 'view' : 'views'}`;
  }
}
