/**
 * Cloudflare RUM card — the CF-native performance block of `/admin/analytics`.
 *
 * Renders Cloudflare Web Analytics RUM for the selected site's owned host: CF-measured Core Web
 * Vitals (LCP/INP/CLS) + Navigation Timing (TTFB/FCP/page-load/DNS/connect), fetched from
 * `GET /api/sites/:siteId/cloudflare-rum`. This is an INDEPENDENT second source to the first-party
 * `app.js` beacon (the `<app-web-vitals-card>` above) — a cross-check, NEVER summed with it. CF
 * auto-injects its beacon at the zone level, so this works for every `*.projectsites.dev` subdomain.
 *
 * Unlike the sibling web-vitals card this one FETCHES its own data (a distinct endpoint, one call
 * per host) so it never complicates the main summary load and degrades independently.
 *
 * HONESTY (load-bearing): RUM is adaptive-SAMPLED — always labelled "sampled". The server already
 * converted µs→ms, rated each metric against Google's bands, and returned `null` (with a sample
 * count) for any metric with no data — a metric with no samples renders "—" + "no samples", NEVER a
 * fabricated 0. `available:false` (no data / no creds) shows an honest note, never an error.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';

/** One RUM metric: server-computed p75 (ms for timing, unitless for CLS) + rating + sample count. */
export interface CfRumMetric {
  p75: number | null;
  rating: 'good' | 'needs' | 'poor' | null;
  samples: number;
}

/** The `/cloudflare-rum` response envelope (available, or an honest available:false). */
export interface CloudflareRumResponse {
  available: boolean;
  days?: number;
  host?: string;
  pageviews?: number | null;
  sampled?: boolean;
  webVitals?: { lcp: CfRumMetric; inp: CfRumMetric; cls: CfRumMetric };
  navTiming?: { ttfb: CfRumMetric; fcp: CfRumMetric; pageLoad: CfRumMetric; dns: CfRumMetric; connect: CfRumMetric };
  window?: { since: string; until: string };
  reason?: string;
}

/** A display tile — a metric with its label, unit hint, and whether it carries a Google rating. */
interface RumTile {
  key: string;
  label: string;
  metric: CfRumMetric | null;
  /** 'cls' = unitless 2-decimals; 'ms' = timing; rated tiles show the rating dot. */
  unit: 'ms' | 'cls';
  rated: boolean;
}

@Component({
  selector: 'app-cloudflare-rum-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card cr" data-testid="an-cf-rum">
      <div class="cr-kicker">Cloudflare RUM</div>
      <h3 class="cr-head">
        <span class="cr-title">Cloudflare performance</span>
        <span
          class="cr-src"
          data-testid="an-cf-rum-source"
          title="Real-user metrics measured by Cloudflare's own Web Analytics beacon (auto-injected at the zone), independent of the ProjectSites first-party beacon. Adaptive-sampled — approximate, not exact."
        >Cloudflare Web Analytics · sampled · last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }}</span>
      </h3>

      @if (loading()) {
        <div class="cr-state" data-testid="an-cf-rum-loading">Loading Cloudflare RUM…</div>
      } @else if (errored()) {
        <div class="cr-state" data-testid="an-cf-rum-error">
          Cloudflare RUM is temporarily unavailable. It’ll reappear on the next refresh.
        </div>
      } @else if (!available()) {
        <div class="cr-state" data-testid="an-cf-rum-unavailable">
          {{ reason() || 'No Cloudflare RUM data for this site yet — a fresh or low-traffic site legitimately has none, and is never shown as a zero.' }}
        </div>
      } @else {
        @if (host(); as h) {
          <div class="cr-host" data-testid="an-cf-rum-host">
            {{ h }}@if (pageviews() != null) { <span class="cr-pv">· {{ pageviews() }} sampled pageloads</span> }
          </div>
        }

        <div class="cr-sub">Core Web Vitals</div>
        <div class="cr-grid">
          @for (t of vitalsTiles(); track t.key) {
            <div class="cr-tile" [attr.data-testid]="'an-cf-rum-' + t.key" [attr.data-rating]="t.metric?.rating ?? 'none'">
              <div class="cr-metric">{{ t.label }}</div>
              @if (t.metric?.p75 != null) {
                <div class="cr-value" [attr.data-testid]="'an-cf-rum-' + t.key + '-value'">{{ format(t) }}</div>
                @if (t.metric?.rating; as r) {
                  <div class="cr-rating" [attr.data-rating]="r"><span class="cr-dot" aria-hidden="true"></span>{{ ratingLabel(r) }} · p75</div>
                }
                <div class="cr-samples">{{ t.metric?.samples }} {{ t.metric?.samples === 1 ? 'sample' : 'samples' }}</div>
              } @else {
                <div class="cr-value cr-empty">—</div>
                <div class="cr-measuring">no samples yet</div>
              }
            </div>
          }
        </div>

        <div class="cr-sub">Navigation timing</div>
        <div class="cr-grid cr-grid-nav">
          @for (t of navTiles(); track t.key) {
            <div class="cr-tile" [attr.data-testid]="'an-cf-rum-' + t.key" [attr.data-rating]="t.metric?.rating ?? 'none'">
              <div class="cr-metric" [attr.title]="navTitle(t.key)">{{ t.label }}</div>
              @if (t.metric?.p75 != null) {
                <div class="cr-value" [attr.data-testid]="'an-cf-rum-' + t.key + '-value'">{{ format(t) }}</div>
                @if (t.rated && t.metric?.rating; as r) {
                  <div class="cr-rating" [attr.data-rating]="r"><span class="cr-dot" aria-hidden="true"></span>{{ ratingLabel(r) }} · p75</div>
                } @else {
                  <div class="cr-rating cr-unrated">p75</div>
                }
                <div class="cr-samples">{{ t.metric?.samples }} {{ t.metric?.samples === 1 ? 'sample' : 'samples' }}</div>
              } @else {
                <div class="cr-value cr-empty">—</div>
                <div class="cr-measuring">no samples yet</div>
              }
            </div>
          }
        </div>

        <p class="cr-note" data-testid="an-cf-rum-note">
          Measured by Cloudflare independently of the first-party beacon above — a cross-check, not a
          replacement. TTFB here is client-measured (the edge-latency dataset isn’t on this plan).
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .cr-kicker { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85; }
    .cr-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.7rem; }
    .cr-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .cr-src { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .cr-host { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); margin-bottom: 0.6rem; font-variant-numeric: tabular-nums; }
    .cr-pv { opacity: 0.75; }
    .cr-sub { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); margin: 0.5rem 0 0.35rem; }
    .cr-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; }
    .cr-grid-nav { grid-template-columns: repeat(5, 1fr); }
    @media (max-width: 720px) { .cr-grid-nav { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 560px) { .cr-grid, .cr-grid-nav { grid-template-columns: 1fr; } }
    .cr-tile { padding: 0.6rem 0.7rem; border-radius: var(--ps-radius-md, 12px); background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent); border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .cr-metric { font-size: 0.64rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .cr-value { font-size: 1.3rem; font-weight: 700; line-height: 1.1; margin-top: 0.2rem; color: #fff; font-variant-numeric: tabular-nums; }
    .cr-empty { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 40%, transparent); }
    .cr-rating { display: inline-flex; align-items: center; gap: 5px; margin-top: 0.3rem; font-size: 0.68rem; font-weight: 600; }
    .cr-unrated { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-weight: 500; }
    .cr-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .cr-rating[data-rating='good'] { color: #4dffb5; }
    .cr-rating[data-rating='needs'] { color: #ffd166; }
    .cr-rating[data-rating='poor'] { color: #ff7e8a; }
    .cr-samples { margin-top: 0.15rem; font-size: 0.6rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-variant-numeric: tabular-nums; }
    .cr-measuring { margin-top: 0.3rem; font-size: 0.66rem; font-style: italic; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .cr-state { padding: 0.9rem 0; font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .cr-note { margin: 0.75rem 0 0; font-size: 0.66rem; line-height: 1.45; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class CloudflareRumCardComponent {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  /** The selected site's id (from `state.selectedSite()?.id`); null → nothing to fetch. */
  readonly siteId = input<string | null>(null);
  /** Window length in days (from the dashboard range), bounded 1..30 server-side. */
  readonly windowDays = input<number>(7);

  private readonly resp = signal<CloudflareRumResponse | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  /** Monotonic request token so a stale response for a prior site can't overwrite the current one. */
  private reqToken = 0;

  constructor() {
    // Refetch whenever the site or window changes. One request per host (all datasets batched
    // server-side). A stale response (site switched mid-flight) is dropped via the token guard.
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
        .get<CloudflareRumResponse>(`/sites/${id}/cloudflare-rum`, { days: String(days) })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            if (token !== this.reqToken) {
              return; // a newer request superseded this one
            }
            this.resp.set(r);
            this.loading.set(false);
          },
          error: () => {
            if (token !== this.reqToken) {
              return;
            }
            this.errored.set(true);
            this.loading.set(false);
          },
        });
    });
  }

  readonly available = computed(() => this.resp()?.available === true);
  readonly host = computed(() => this.resp()?.host ?? null);
  readonly pageviews = computed(() => this.resp()?.pageviews ?? null);
  readonly reason = computed(() => this.resp()?.reason ?? '');

  readonly vitalsTiles = computed<RumTile[]>(() => {
    const wv = this.resp()?.webVitals;
    return [
      { key: 'lcp', label: 'LCP', metric: wv?.lcp ?? null, unit: 'ms', rated: true },
      { key: 'inp', label: 'INP', metric: wv?.inp ?? null, unit: 'ms', rated: true },
      { key: 'cls', label: 'CLS', metric: wv?.cls ?? null, unit: 'cls', rated: true },
    ];
  });

  readonly navTiles = computed<RumTile[]>(() => {
    const nt = this.resp()?.navTiming;
    return [
      { key: 'ttfb', label: 'TTFB', metric: nt?.ttfb ?? null, unit: 'ms', rated: true },
      { key: 'fcp', label: 'FCP', metric: nt?.fcp ?? null, unit: 'ms', rated: true },
      { key: 'pageLoad', label: 'Load', metric: nt?.pageLoad ?? null, unit: 'ms', rated: false },
      { key: 'dns', label: 'DNS', metric: nt?.dns ?? null, unit: 'ms', rated: false },
      { key: 'connect', label: 'Connect', metric: nt?.connect ?? null, unit: 'ms', rated: false },
    ];
  });

  /** Format a tile's p75: CLS unitless (2 dp), timing in ms (or s past 1000ms). */
  format(t: RumTile): string {
    const v = t.metric?.p75;
    if (v == null) {
      return '—';
    }
    if (t.unit === 'cls') {
      return v.toFixed(2);
    }
    return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  }

  /** Word label for a rating (WCAG — never colour alone). */
  ratingLabel(r: 'good' | 'needs' | 'poor'): string {
    return r === 'good' ? 'Good' : r === 'needs' ? 'Needs work' : 'Poor';
  }

  /** Plain-language tooltip for a Navigation-Timing metric. */
  navTitle(key: string): string {
    const map: Record<string, string> = {
      ttfb: 'Time to First Byte — how quickly the server started responding (client-measured).',
      fcp: 'First Contentful Paint — when the first content appeared.',
      pageLoad: 'Full page load time (no Google rating band).',
      dns: 'DNS lookup time (no Google rating band).',
      connect: 'Connection setup time (no Google rating band).',
    };
    return map[key] ?? '';
  }
}
