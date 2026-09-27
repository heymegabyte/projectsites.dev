/**
 * Acquisition channels card — the "how visitors arrive" block of `/admin/analytics`.
 *
 * Renders `traffic.byChannel` (direct / organic / social / paid / email / referral / …) — the
 * first-party channel classification recorded on EVERY pageview (`json_extract(metadata,'$.channel')`).
 * Focused, standalone, presentational (signals + `input()` + native control flow, no fetching).
 *
 * DISTINCT from "Campaigns & sources" (utm_source/utm_campaign — only TAGGED marketing visits): this
 * covers ALL visits by broad acquisition channel. Distinct from "Top referrers" (which lists referring
 * hosts) — this is the classified channel.
 *
 * HONESTY: every count is a real tracked pageview (the channel is derived server-side from the
 * referrer + utm on each pageview); an unclassifiable visit buckets as "direct"/"unknown" (a real
 * bucket, never dropped); a site with no pageviews shows an explicit empty state, never a fabricated 0.
 *
 * DRILLDOWN: each row is an accessible toggle button emitting `drill` ({dim:'channel', value}); the
 * value is the RAW stored channel label (the same string the server filters on — no display/stored
 * mismatch, so the filter can never be lying-empty). The row matching the parent `activeFilter` shows
 * `aria-pressed`; clicking it again toggles the filter off.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** One `{ label, count }` channel row, as the server returns it (`label` = the stored channel value). */
export interface ChannelCount {
  label: string;
  count: number;
}

@Component({
  selector: 'app-channel-breakdown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card ch" data-testid="an-channel">
      <div class="ch-kicker">Acquisition</div>
      <h3 class="ch-head">
        <span class="ch-title">Channels</span>
        <span
          class="ch-sub"
          data-testid="an-channel-source"
          title="How visitors arrive — classified per pageview from the referrer + campaign tags. A count of tracked pageviews, never an estimate. Covers every visit (each is assigned one channel)."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · how visitors arrive</span>
      </h3>

      @if (rows().length) {
        <ul class="ch-list">
          @for (r of rows(); track r.label) {
            <li class="ch-row" data-testid="an-channel-row">
              <button
                type="button"
                class="ch-drill"
                [class.is-active]="isActive(r.label)"
                data-testid="an-channel-drill"
                [attr.aria-pressed]="isActive(r.label)"
                [attr.aria-label]="'Filter analytics by channel ' + channelLabel(r.label) + ' — ' + r.count + ' pageviews'"
                (click)="drill.emit({ dim: 'channel', value: r.label })"
              >
                <div class="ch-row-head">
                  <span class="ch-label" [attr.title]="channelLabel(r.label)">{{ channelLabel(r.label) }}</span>
                  <span class="ch-count">{{ r.count }} <span class="ch-pct">· {{ pct(r.count) }}%</span></span>
                </div>
                <div class="ch-bar" aria-hidden="true">
                  <div class="ch-bar-fill" [style.width.%]="barWidth(r.count)"></div>
                </div>
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="ch-empty" data-testid="an-channel-empty">
          No channel data yet. Once your site records pageviews, this shows how visitors arrive
          (direct, organic search, social, referral …) — a real breakdown, never an estimate.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ch-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .ch-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .ch-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .ch-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .ch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
    .ch-drill {
      display: block; width: 100%; text-align: left; background: none; border: 0; font: inherit; color: inherit;
      padding: 0.2rem 0.35rem; margin: -0.2rem -0.35rem; border-radius: 8px; cursor: pointer; transition: background 0.14s ease;
    }
    .ch-drill:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent); }
    .ch-drill:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .ch-drill.is-active { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent); box-shadow: inset 2px 0 0 var(--ps-accent, #00e5ff); }
    .ch-row-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .ch-label { font-size: 0.78rem; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ch-count { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .ch-pct { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-size: 0.9em; font-variant-numeric: tabular-nums; }
    .ch-bar { height: 5px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .ch-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .ch-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class ChannelBreakdownComponent {
  /** `traffic.byChannel` — pageviews by acquisition channel (`label` = the stored channel value). */
  readonly channels = input<ChannelCount[]>([]);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);
  /** The parent's active drilldown filter — a matching row shows `aria-pressed`. */
  readonly activeFilter = input<{ dim: string; value: string } | null>(null);
  /** Emitted when a row is clicked — the parent restricts the summary to `{dim:'channel',value}`. */
  readonly drill = output<{ dim: 'channel'; value: string }>();

  /** Non-zero channel rows, sorted by count desc (top-8; channels are a small closed set). */
  readonly rows = computed<ChannelCount[]>(() =>
    [...this.channels()].filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, 8),
  );

  /** Sum of ALL channel rows (not just the shown top-8) — the honest share denominator. */
  private readonly total = computed(() => this.channels().reduce((s, r) => s + Math.max(0, r.count), 0));

  /** Largest shown count — for bar scaling. */
  private readonly max = computed(() => this.rows().reduce((m, r) => Math.max(m, r.count), 0));

  /** True when the parent filter targets channel = this value (drives `aria-pressed`). */
  isActive(value: string): boolean {
    const f = this.activeFilter();
    return !!f && f.dim === 'channel' && f.value === value;
  }

  /** Bar width as a % of the largest shown count (min 4% so a small bar stays visible). */
  barWidth(count: number): number {
    const m = this.max();
    return m > 0 ? Math.max(4, Math.round((count / m) * 100)) : 0;
  }

  /** Row's share of ALL channel pageviews (all rows, not just the top-8 shown), rounded. */
  pct(count: number): number {
    const t = this.total();
    return t > 0 ? Math.round((count / t) * 100) : 0;
  }

  /** Human display name for a raw channel value (drill still binds the RAW value). */
  channelLabel(raw: string): string {
    const map: Record<string, string> = {
      direct: 'Direct',
      organic: 'Organic search',
      search: 'Organic search',
      social: 'Social',
      paid: 'Paid',
      email: 'Email',
      referral: 'Referral',
      ai: 'AI',
      unknown: 'Unknown',
    };
    const key = (raw ?? '').toLowerCase();
    return map[key] ?? (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Unknown');
  }
}
