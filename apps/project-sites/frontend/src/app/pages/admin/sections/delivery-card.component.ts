/**
 * Delivery & performance card — the edge-delivery block of `/admin/analytics`.
 *
 * Renders Cloudflare edge metrics for the site's owned hostnames from
 * `envelope.delivery` (the `httpRequestsAdaptiveGroups` aggregation): HTTP status-code
 * classes, cache hit ratio, edge bandwidth, the top error responses, AND the edge
 * connection/content breakdowns (HTTP protocol version, TLS version, response
 * content-type, HTTP method — all from the SAME per-host query, zero extra requests).
 * Focused, standalone, presentational (Angular style guide): signals + `input()` +
 * native control flow, no data fetching of its own.
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

/**
 * Honest short label for the CF adaptive `sampleInterval`. CF only samples busy zones; our probe
 * (2026-09-25) showed real intervals of ~1.9–3.6, so this is NOT always "sampled". `~1` ⇒ effectively
 * full data; higher ⇒ 1-in-N sampled (the counts are already scaled to the estimate — this quantifies
 * the confidence). `null`/absent ⇒ the previous generic "sampled estimate" (CF omitted the interval).
 *
 * @example describeSampling(1.1) // 'full data'
 * @example describeSampling(3.3) // 'sampled ~1:3'
 * @example describeSampling(null) // 'sampled estimate'
 */
export function describeSampling(interval: number | null | undefined): string {
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
    return 'sampled estimate';
  }
  return interval < 1.5 ? 'full data' : `sampled ~1:${Math.round(interval)}`;
}

/** Longer tooltip explaining the sampling label — honest about what the interval means. */
export function describeSamplingTitle(interval: number | null | undefined): string {
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
    return 'Cloudflare adaptive-samples edge metrics on busy zones; the exact ratio was not reported for this window, so treat these as approximate.';
  }
  return interval < 1.5
    ? 'Cloudflare reported little-to-no sampling for this window — these edge counts are effectively the full data.'
    : `Cloudflare adaptive-sampled these edge metrics at about 1 in ${Math.round(interval)} requests; the counts are scaled to the estimate, so treat them as approximate.`;
}

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
      .dl {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .dl-kicker {
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ps-accent, #00e5ff);
        font-weight: 700;
      }
      .dl-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
        margin: 0;
        flex-wrap: wrap;
      }
      .dl-title {
        font-size: 1rem;
        font-weight: 700;
        color: var(--ps-ink, #f4f4ff);
      }
      .dl-src {
        font-size: 0.62rem;
        color: var(--text-secondary, #9aa0b4);
        cursor: help;
      }
      .dl-est {
        color: #f5c451;
        font-style: italic;
      }
      .dl-cap {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .dl-statuses {
        display: grid;
        gap: 0.3rem;
      }
      .dl-status-row {
        display: grid;
        grid-template-columns: 8.5rem 1fr auto;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
      }
      .dl-status-label {
        color: var(--ps-ink, #f4f4ff);
        white-space: nowrap;
      }
      .dl-status-val {
        color: var(--text-secondary, #9aa0b4);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .dl-bar {
        height: 0.5rem;
        background: rgba(255, 255, 255, 0.06);
        border-radius: 999px;
        overflow: hidden;
      }
      .dl-bar-fill {
        display: block;
        height: 100%;
        background: var(--ps-accent, #00e5ff);
        border-radius: 999px;
      }
      .dl-status-row[data-class='4xx'] .dl-bar-fill {
        background: #f5a524;
      }
      .dl-status-row[data-class='5xx'] .dl-bar-fill {
        background: #f5405e;
      }
      .dl-warn {
        margin: 0;
        font-size: 0.72rem;
        color: #ffb4c0;
        background: rgba(245, 64, 94, 0.1);
        border-radius: 6px;
        padding: 0.4rem 0.6rem;
      }
      .dl-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
      }
      .dl-stat-label {
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary, #9aa0b4);
      }
      .dl-stat-val {
        font-size: 1.4rem;
        font-weight: 700;
        color: var(--ps-ink, #f4f4ff);
        font-variant-numeric: tabular-nums;
        margin-top: 0.15rem;
      }
      .dl-muted {
        font-size: 0.85rem;
        font-weight: 400;
        color: var(--text-secondary, #9aa0b4);
      }
      .dl-stat-sub {
        font-size: 0.66rem;
        color: var(--text-secondary, #9aa0b4);
        margin-top: 0.15rem;
      }
      .dl-errors {
        display: grid;
        gap: 0.25rem;
      }
      .dl-error-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .dl-error-list li {
        font-size: 0.72rem;
        padding: 0.15rem 0.45rem;
        background: rgba(255, 255, 255, 0.04);
        border-radius: 4px;
        font-variant-numeric: tabular-nums;
      }
      .dl-error-rows {
        flex-direction: column;
        gap: 0.25rem;
      }
      .dl-error-rows li {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        flex-wrap: wrap;
        width: 100%;
        box-sizing: border-box;
      }
      .dl-error-code {
        color: #f5405e;
        font-weight: 700;
      }
      .dl-error-visits {
        color: var(--ps-ink, #f4f4ff);
        font-weight: 600;
      }
      .dl-error-meta {
        color: var(--text-secondary, #9aa0b4);
        margin-left: auto;
      }
      .dl-edge {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.75rem;
      }
      .dl-edge-group {
        min-width: 0;
      }
      .dl-edge-list {
        list-style: none;
        margin: 0.3rem 0 0;
        padding: 0;
        display: grid;
        gap: 0.25rem;
      }
      .dl-edge-list li {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        font-size: 0.72rem;
      }
      .dl-edge-lbl {
        color: var(--ps-ink, #f4f4ff);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .dl-edge-val {
        color: var(--text-secondary, #9aa0b4);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .dl-bots {
        display: grid;
        gap: 0.15rem;
      }
      .dl-note {
        margin: 0;
        font-size: 0.62rem;
        color: var(--text-secondary, #9aa0b4);
        line-height: 1.4;
      }
      @media (max-width: 480px) {
        .dl-edge {
          grid-template-columns: 1fr;
        }
      }
      .dl-empty {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-secondary, #9aa0b4);
        line-height: 1.5;
      }
      @media (max-width: 480px) {
        .dl-status-row {
          grid-template-columns: 7rem 1fr auto;
        }
        .dl-stats {
          grid-template-columns: 1fr;
        }
      }
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
          >Cloudflare edge · last {{ coveredDays() }} {{ coveredDays() === 1 ? 'day' : 'days' }}
          @if (windowCapped()) {
            <span class="dl-cap" data-testid="an-dl-window-cap">
              (of {{ windowDays() }} requested — CF ~30-day edge cap)</span
            >
          }
          · <span class="dl-est" data-testid="an-dl-sampled" [title]="sampleTitle()">{{ sampleLabel() }}</span></span
        >
      </h3>

      @if (delivery(); as d) {
        @if (d.has_data) {
          <div class="dl-statuses" data-testid="an-dl-statuses">
            @for (s of statusRows(); track s.class) {
              <div class="dl-status-row" [attr.data-class]="s.class">
                <span class="dl-status-label">{{ s.class }} · {{ s.word }}</span>
                <span class="dl-bar" aria-hidden="true"
                  ><span class="dl-bar-fill" [style.width.%]="s.pct"></span
                ></span>
                <span class="dl-status-val">{{ s.pct }}% · {{ fmt(s.count) }}</span>
              </div>
            }
          </div>

          @if (errorPct() !== null && errorPct()! >= 5) {
            <p class="dl-warn" data-testid="an-dl-error-warn" role="status">
              <span aria-hidden="true">⚠</span> {{ errorPct() }}% of edge requests returned 4xx/5xx
              — check the top error responses below.
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
              <div class="dl-stat-sub">
                {{ fmt(d.cache.hit) }} hit · {{ fmt(d.cache.miss) }} miss ·
                {{ fmt(d.cache.uncacheable) }} uncacheable
              </div>
              @if (d.cache.miss_bytes > 0) {
                <div class="dl-stat-sub" data-testid="an-dl-cache-miss-bytes">
                  {{ bytes(d.cache.miss_bytes) }} served on cache misses — cacheable to save
                  bandwidth
                </div>
              }
              @if (d.cache.miss_visits > 0) {
                <div class="dl-stat-sub" data-testid="an-dl-cache-miss-visits">
                  {{ fmt(d.cache.miss_visits) }} real visitors hit cache misses (sampled; not raw
                  requests)
                </div>
              }
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
              <ul class="dl-error-list dl-error-rows">
                @for (e of errorCodes(); track e.status) {
                  <li data-testid="an-dl-error-code">
                    <code class="dl-error-code">{{ e.status }}</code>
                    @if (e.visits > 0) {
                      <span class="dl-error-visits" data-testid="an-dl-error-visits"
                        >{{ fmt(e.visits) }} {{ e.visits === 1 ? 'visitor' : 'visitors' }} hit</span
                      >
                    }
                    <span class="dl-error-meta">{{ fmt(e.count) }} req · {{ bytes(e.bytes) }}</span>
                  </li>
                }
              </ul>
              <p class="dl-note" data-testid="an-dl-error-note">
                “Visitors” ≈ how many real people (not bots or raw requests) hit each error — a
                sampled estimate. Fix the links or pages behind any code with real visitor traffic
                first.
              </p>
            </div>
          }

          @if (edgeGroups().length) {
            <div class="dl-edge" data-testid="an-dl-edge">
              @for (g of edgeGroups(); track g.key) {
                <div class="dl-edge-group" [attr.data-testid]="'an-dl-edge-' + g.key">
                  <div class="dl-stat-label">{{ g.title }}</div>
                  <ul class="dl-edge-list">
                    @for (r of g.rows; track r.label) {
                      <li>
                        <span class="dl-edge-lbl" [attr.title]="r.label">{{ r.label }}</span>
                        <span class="dl-edge-val">{{ r.pct }}% · {{ fmt(r.count) }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>
          }

          @if (verifiedBots().length) {
            <div class="dl-bots" data-testid="an-dl-bots">
              <div class="dl-stat-label">Verified bots · search crawlers &amp; monitors</div>
              <ul class="dl-edge-list">
                @for (b of verifiedBots(); track b.label) {
                  <li>
                    <span class="dl-edge-lbl" [attr.title]="b.label">{{ b.label }}</span>
                    <span class="dl-edge-val">{{ fmt(b.count) }} requests</span>
                  </li>
                }
              </ul>
              <p class="dl-note" data-testid="an-dl-bots-note">
                Cloudflare-<strong>verified</strong> bot traffic (e.g. Googlebot under “Search
                Engine Crawler”) — confirms search engines are reaching your site. Distinct from
                your human audience above; only <strong>named, verified</strong> bots are shown
                (this isn't a bot-management score, which this plan doesn't include).
              </p>
            </div>
          }

          <p class="dl-note" data-testid="an-dl-note">
            Cloudflare edge counts of HTTP requests (not pageviews),
            <strong>adaptive-sampled — approximate, not exact</strong>, and updated on a
            <strong>short delay</strong> (a few minutes behind live). Your audience metrics above
            (page views, visits, conversions) are exact, real-time first-party counts. Cache hit
            ratio is over cacheable requests; connection, TLS, content-type and method are edge
            request shares.
          </p>
        } @else if (d.zone_resolved) {
          <p class="dl-empty" data-testid="an-dl-empty">
            No edge requests recorded in this window yet. Status codes, cache hit-rate, and
            bandwidth appear here once traffic arrives.
          </p>
        } @else {
          <p class="dl-empty" data-testid="an-dl-unavailable">
            Edge delivery metrics aren't available for this site's domains yet — they're served on a
            shared projectsites.dev zone. Connect a custom domain to see status codes, cache
            hit-rate, and bandwidth.
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

  /**
   * The window the CF EDGE data ACTUALLY covers — `delivery.range_days`, which the worker caps at
   * Cloudflare's ~30-day httpRequestsAdaptiveGroups retention. Falls back to the requested window
   * when there's no delivery block. This (not the requested `windowDays`) is the honest label: a
   * 90-day request over CF-capped edge data covers ≤30 days, and the card must not claim 90.
   */
  readonly coveredDays = computed<number>(() => this.delivery()?.range_days ?? this.windowDays());

  /**
   * True when CF's edge window is SHORTER than the requested one (retention cap hit) — the header
   * then shows "(of N requested — CF ~30-day edge cap)" so an owner never reads the requested
   * window as the covered one. First-party audience metrics still honor the full requested window.
   */
  readonly windowCapped = computed<boolean>(() => {
    const r = this.delivery()?.range_days;
    return typeof r === 'number' && r < this.windowDays();
  });

  /** Honest sampling label from CF's reported `sampleInterval` ("full data" / "sampled ~1:N"). */
  sampleLabel(): string {
    return describeSampling(this.delivery()?.sample_interval);
  }
  /** Tooltip explaining the sampling label. */
  sampleTitle(): string {
    return describeSamplingTitle(this.delivery()?.sample_interval);
  }

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

  /**
   * Edge connection/content breakdowns (protocol / TLS / content-type / method) as
   * render-ready groups: each carries its top-4 rows with a share % of the dimension
   * total. Only groups WITH data appear (an unavailable/empty dimension is omitted,
   * never shown as a fabricated 0). Same adaptive-sampled edge source as the card.
   */
  readonly edgeGroups = computed(() => {
    const d = this.delivery();
    if (!d || !d.has_data) return [];
    const mk = (
      key: string,
      title: string,
      rows: { label: string; count: number }[] | undefined,
    ) => {
      const list = (rows ?? []).filter((r) => r.count > 0);
      const total = list.reduce((a, r) => a + r.count, 0);
      return {
        key,
        title,
        rows: list.slice(0, 4).map((r) => ({
          label: r.label,
          count: r.count,
          pct: total > 0 ? Math.round((100 * r.count) / total) : 0,
        })),
      };
    };
    return [
      mk('proto', 'Connection', d.protocols), // HTTP/3, HTTP/2, HTTP/1.1
      mk('tls', 'TLS version', d.tls), // TLSv1.3, TLSv1.2
      mk('content', 'Content served', d.content_types), // js, html, css, img
      mk('method', 'Methods', d.methods), // GET, POST
    ].filter((g) => g.rows.length > 0);
  });

  /**
   * Cloudflare-verified bot traffic by category (top 6, raw request counts). The
   * human/unverified bucket is excluded server-side, so an empty array means the site
   * has genuinely seen no verified bots (the section then hides — never a fabricated 0).
   */
  readonly verifiedBots = computed(() => {
    const d = this.delivery();
    if (!d || !d.has_data) return [];
    return (d.verified_bots ?? []).filter((b) => b.count > 0).slice(0, 6);
  });

  /** Thousands-separated integer. */
  fmt(n: number): string {
    return n.toLocaleString();
  }

  /** Human byte size for a single value (per-status edge bandwidth). */
  bytes(n: number): string {
    return formatBytes(n);
  }
}
