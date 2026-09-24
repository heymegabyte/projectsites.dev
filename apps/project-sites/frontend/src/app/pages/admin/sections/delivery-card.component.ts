/**
 * Delivery & performance card — the edge-delivery block of `/admin/analytics`.
 *
 * Renders Cloudflare edge metrics for the site's owned hostnames from
 * `envelope.delivery` (the `httpRequestsAdaptiveGroups` status/cache/bandwidth
 * aggregation): HTTP status-code classes, cache hit ratio, edge bandwidth, and the
 * top error responses. Focused, standalone, presentational (Angular style guide):
 * signals + `input()` + native control flow, no data fetching of its own.
 *
 * HONESTY (load-bearing): this is a DISTINCT source from the first-party audience
 * metrics — it counts HTTP REQUESTS at the edge, not pageviews. `delivery === null`
 * (no CF credentials) and `has_data === false` (credentials but no edge traffic yet)
 * render explicit states, never zeros-as-measured. A `null` cache hit ratio (no
 * cacheable requests) shows "no cacheable requests", never a fabricated 0%. Status
 * classes carry a WORD (success / server error…), not colour alone (WCAG use-of-color).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { DeliverySummary } from '../../../services/api.service';

/** Plain-language word per status class (meaning must not be colour-only). */
const STATUS_WORD: Record<string, string> = {
  '2xx': 'success',
  '3xx': 'redirect',
  '4xx': 'client error',
  '5xx': 'server error',
  other: 'other',
};

/** Human-readable byte size (edge bandwidth) — B / KB / MB / GB, 1 decimal. */
function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-delivery-card',
  standalone: true,
  styles: [
    `
    .dl { display: flex; flex-direction: column; gap: 0.75rem; }
    .dl-kicker { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ps-accent, #00e5ff); font-weight: 700; }
    .dl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin: 0; flex-wrap: wrap; }
    .dl-title { font-size: 1rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); }
    .dl-src { font-size: 0.62rem; color: var(--text-secondary, #9aa0b4); cursor: help; }
    .dl-est { color: #f5c451; font-style: italic; }
    .dl-statuses { display: grid; gap: 0.3rem; }
    .dl-status-row { display: grid; grid-template-columns: 8.5rem 1fr auto; align-items: center; gap: 0.5rem; font-size: 0.75rem; }
    .dl-status-label { color: var(--ps-ink, #f4f4ff); white-space: nowrap; }
    .dl-status-val { color: var(--text-secondary, #9aa0b4); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dl-bar { height: 0.5rem; background: rgba(255,255,255,0.06); border-radius: 999px; overflow: hidden; }
    .dl-bar-fill { display: block; height: 100%; background: var(--ps-accent, #00e5ff); border-radius: 999px; }
    .dl-status-row[data-class='4xx'] .dl-bar-fill { background: #f5a524; }
    .dl-status-row[data-class='5xx'] .dl-bar-fill { background: #f5405e; }
    .dl-warn { margin: 0; font-size: 0.72rem; color: #ffb4c0; background: rgba(245,64,94,0.1); border-radius: 6px; padding: 0.4rem 0.6rem; }
    .dl-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .dl-stat-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary, #9aa0b4); }
    .dl-stat-val { font-size: 1.4rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); font-variant-numeric: tabular-nums; margin-top: 0.15rem; }
    .dl-muted { font-size: 0.85rem; font-weight: 400; color: var(--text-secondary, #9aa0b4); }
    .dl-stat-sub { font-size: 0.66rem; color: var(--text-secondary, #9aa0b4); margin-top: 0.15rem; }
    .dl-errors { display: grid; gap: 0.25rem; }
    .dl-error-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .dl-error-list li { font-size: 0.72rem; padding: 0.15rem 0.45rem; background: rgba(255,255,255,0.04); border-radius: 4px; font-variant-numeric: tabular-nums; }
    .dl-note { margin: 0; font-size: 0.62rem; color: var(--text-secondary, #9aa0b4); line-height: 1.4; }
    .dl-empty { margin: 0; font-size: 0.78rem; color: var(--text-secondary, #9aa0b4); line-height: 1.5; }
    @media (max-width: 480px) { .dl-status-row { grid-template-columns: 7rem 1fr auto; } .dl-stats { grid-template-columns: 1fr; } }
    `,
  ],
  template: `
    <section class="card dl" data-testid="an-delivery">
      <div class="dl-kicker">Delivery &amp; performance</div>
      <h3 class="dl-head">
        <span class="dl-title">Edge delivery</span>
        <span
          class="dl-src"
          data-testid="an-dl-source"
          title="Cloudflare edge metrics (httpRequestsAdaptiveGroups) for this site's domains — HTTP requests served at the edge, cache result, and bandwidth. This counts requests, NOT pageviews (see the audience cards for first-party pageviews). ~30-day retention, adaptive-sampled, and updated a few minutes behind live (first-party audience metrics are real-time)."
          >Cloudflare edge · last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · <span class="dl-est" data-testid="an-dl-sampled">sampled estimate</span></span
        >
      </h3>

      @if (delivery(); as d) {
        @if (d.has_data) {
          <div class="dl-statuses" data-testid="an-dl-statuses">
            @for (s of statusRows(); track s.class) {
              <div class="dl-status-row" [attr.data-class]="s.class">
                <span class="dl-status-label">{{ s.class }} · {{ s.word }}</span>
                <span class="dl-bar" aria-hidden="true"><span class="dl-bar-fill" [style.width.%]="s.pct"></span></span>
                <span class="dl-status-val">{{ s.pct }}% · {{ fmt(s.count) }}</span>
              </div>
            }
          </div>

          @if (errorPct() !== null && errorPct()! >= 5) {
            <p class="dl-warn" data-testid="an-dl-error-warn" role="status">
              <span aria-hidden="true">⚠</span> {{ errorPct() }}% of edge requests returned 4xx/5xx — check the top error responses below.
            </p>
          }

          <div class="dl-stats">
            <div class="dl-stat">
              <div class="dl-stat-label">Cache hit ratio</div>
              <div class="dl-stat-val" data-testid="an-dl-cache">
                @if (d.cache.hit_ratio_pct !== null) {
                  {{ d.cache.hit_ratio_pct }}%
                } @else {
                  <span class="dl-muted">no cacheable requests</span>
                }
              </div>
              <div class="dl-stat-sub">{{ fmt(d.cache.hit) }} hit · {{ fmt(d.cache.miss) }} miss · {{ fmt(d.cache.uncacheable) }} uncacheable</div>
            </div>
            <div class="dl-stat">
              <div class="dl-stat-label">Edge bandwidth</div>
              <div class="dl-stat-val" data-testid="an-dl-bytes">{{ bytesLabel() }}</div>
              <div class="dl-stat-sub">{{ fmt(d.total_requests) }} requests</div>
            </div>
          </div>

          @if (errorCodes().length) {
            <div class="dl-errors">
              <div class="dl-stat-label">Top error responses</div>
              <ul class="dl-error-list">
                @for (e of errorCodes(); track e.status) {
                  <li data-testid="an-dl-error-code"><code>{{ e.status }}</code> · {{ fmt(e.count) }}</li>
                }
              </ul>
            </div>
          }

          <p class="dl-note" data-testid="an-dl-note">Cloudflare edge counts of HTTP requests (not pageviews), <strong>adaptive-sampled — approximate, not exact</strong>, and updated on a <strong>short delay</strong> (a few minutes behind live). Your audience metrics above (page views, visits, conversions) are exact, real-time first-party counts. Cache hit ratio is over cacheable requests.</p>
        } @else if (d.zone_resolved) {
          <p class="dl-empty" data-testid="an-dl-empty">
            No edge requests recorded in this window yet. Status codes, cache hit-rate, and bandwidth appear here once traffic arrives.
          </p>
        } @else {
          <p class="dl-empty" data-testid="an-dl-unavailable">
            Edge delivery metrics aren't available for this site's domains yet — they're served on a shared projectsites.dev zone. Connect a custom domain to see status codes, cache hit-rate, and bandwidth.
          </p>
        }
      } @else {
        <p class="dl-empty" data-testid="an-dl-unavailable">
          Cloudflare edge delivery metrics aren't available for this site yet.
        </p>
      }
    </section>
  `,
})
export class DeliveryCardComponent {
  /** The `envelope.delivery` block, or `null` when no CF credentials resolved. */
  readonly delivery = input<DeliverySummary | null>(null);
  /** The selected window, for the source label. */
  readonly windowDays = input<number>(7);

  /** Status classes with computed % of total + a plain-language word. */
  readonly statusRows = computed(() => {
    const d = this.delivery();
    if (!d || !d.has_data) return [];
    const total = d.total_requests || 1;
    return d.by_status_class.map((s) => ({
      class: s.class,
      count: s.count,
      pct: Math.round((100 * s.count) / total),
      word: STATUS_WORD[s.class] ?? s.class,
    }));
  });

  /** Share of edge requests that were 4xx/5xx, or null when there's no data. */
  readonly errorPct = computed<number | null>(() => {
    const d = this.delivery();
    if (!d || !d.has_data || !d.total_requests) return null;
    const errs = d.by_status_class
      .filter((s) => s.class === '4xx' || s.class === '5xx')
      .reduce((a, s) => a + s.count, 0);
    return Math.round((100 * errs) / d.total_requests);
  });

  /** Individual 4xx/5xx status codes (top 6) for the "top error responses" list. */
  readonly errorCodes = computed(() => {
    const d = this.delivery();
    if (!d) return [];
    return d.top_statuses.filter((s) => s.status >= 400).slice(0, 6);
  });

  /** Formatted edge bandwidth. */
  readonly bytesLabel = computed<string>(() => {
    const d = this.delivery();
    return d ? formatBytes(d.response_bytes) : '—';
  });

  /** Thousands-separated integer. */
  fmt(n: number): string {
    return n.toLocaleString();
  }
}
