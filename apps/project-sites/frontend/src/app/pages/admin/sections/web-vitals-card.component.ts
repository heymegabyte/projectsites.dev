/**
 * Web Vitals card — the real-user-experience block of `/admin/analytics`.
 *
 * Renders the field-measured Core Web Vitals p75 (LCP/INP/CLS) from
 * `traffic.webVitals` (the `getWebVitalsSummary` aggregation over the `web_vital`
 * beacon rows). Focused, standalone, presentational component (Angular style
 * guide): signals + `input()` + native control flow, no data fetching of its own.
 *
 * HONESTY (the load-bearing property): a metric with no field samples renders
 * "Measuring — no samples yet", NEVER a fabricated 0. LCP/CLS/INP are Chromium-only
 * APIs, so the card is explicitly labelled "field data · Chrome" — it never implies
 * coverage of every visitor. Rating uses Google's thresholds and shows the WORD
 * (Good / Needs work / Poor), not colour alone (WCAG use-of-color).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { WebVitalStat } from '../../../services/api.service';

/** The `traffic.webVitals` shape — each metric is a p75+samples stat or null. */
export interface WebVitalsBlock {
  lcp: WebVitalStat | null;
  inp: WebVitalStat | null;
  cls: WebVitalStat | null;
}

type MetricKey = 'lcp' | 'inp' | 'cls';
type Rating = 'good' | 'needs' | 'poor';
interface MetricTile {
  key: MetricKey;
  label: string;
  stat: WebVitalStat | null;
}

@Component({
  selector: 'app-web-vitals-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card wv" data-testid="an-web-vitals">
      <div class="wv-kicker">Real-user experience</div>
      <h3 class="wv-head">
        <span class="wv-title">Core Web Vitals</span>
        <span
          class="wv-src"
          data-testid="an-wv-source"
          title="Field data measured in real visitors' browsers via the first-party RUM beacon. LCP / CLS / INP are Chromium-only APIs, so samples come from Chrome / Edge visitors — this is not every visitor."
        >field data · Chrome · last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }}</span>
      </h3>

      <div class="wv-grid">
        @for (m of metrics(); track m.key) {
          <div
            class="wv-tile"
            [attr.data-testid]="'an-wv-' + m.key"
            [attr.data-rating]="m.stat ? rating(m.key, m.stat.p75) : 'none'"
          >
            <div class="wv-metric" [attr.title]="definition(m.key)">{{ m.label }}</div>
            @if (m.stat; as s) {
              <div class="wv-value" [attr.data-testid]="'an-wv-' + m.key + '-value'">
                {{ formatValue(m.key, s.p75) }}
              </div>
              <div class="wv-rating" [attr.data-rating]="rating(m.key, s.p75)">
                <span class="wv-dot" aria-hidden="true"></span>{{ ratingLabel(rating(m.key, s.p75)) }} · p75
              </div>
              <div class="wv-samples">{{ s.samples }} {{ s.samples === 1 ? 'sample' : 'samples' }}</div>
            } @else {
              <div class="wv-value wv-empty">—</div>
              <div class="wv-measuring" [attr.data-testid]="'an-wv-' + m.key + '-empty'">
                Measuring — no samples yet
              </div>
            }
          </div>
        }
      </div>

      @if (!hasAnySamples()) {
        <p class="wv-note" data-testid="an-wv-note">
          No field data yet. Core Web Vitals appear here once real visitors on Chrome / Edge load
          your site — a fresh or low-traffic site legitimately has none, and is never shown as a zero.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .wv-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .wv-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .wv-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .wv-src { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .wv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; }
    @media (max-width: 560px) { .wv-grid { grid-template-columns: 1fr; } }
    .wv-tile {
      padding: 0.7rem 0.8rem; border-radius: var(--ps-radius-md, 12px);
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
      border: 1px solid var(--ps-edge, rgba(255,255,255,0.08));
    }
    .wv-metric { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); cursor: help; }
    .wv-value { font-size: 1.5rem; font-weight: 700; line-height: 1.1; margin-top: 0.2rem; color: #fff; font-variant-numeric: tabular-nums; }
    .wv-empty { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 40%, transparent); }
    .wv-rating { display: inline-flex; align-items: center; gap: 5px; margin-top: 0.3rem; font-size: 0.7rem; font-weight: 600; }
    .wv-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .wv-rating[data-rating='good'] { color: #4dffb5; }
    .wv-rating[data-rating='needs'] { color: #ffd166; }
    .wv-rating[data-rating='poor'] { color: #ff7e8a; }
    .wv-measuring { margin-top: 0.3rem; font-size: 0.68rem; font-style: italic; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .wv-samples { margin-top: 0.15rem; font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-variant-numeric: tabular-nums; }
    .wv-note { margin: 0.75rem 0 0; font-size: 0.68rem; line-height: 1.45; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class WebVitalsCardComponent {
  /** The `traffic.webVitals` block; null/undefined until a site + samples resolve. */
  readonly webVitals = input<WebVitalsBlock | null>(null);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);

  /** The three metrics as display tiles, in the conventional LCP → INP → CLS order. */
  readonly metrics = computed<MetricTile[]>(() => {
    const wv = this.webVitals();
    return [
      { key: 'lcp', label: 'LCP', stat: wv?.lcp ?? null },
      { key: 'inp', label: 'INP', stat: wv?.inp ?? null },
      { key: 'cls', label: 'CLS', stat: wv?.cls ?? null },
    ];
  });

  /** True when ANY metric has field samples — else the card shows the "no data" note. */
  readonly hasAnySamples = computed(() => this.metrics().some((m) => m.stat != null));

  /**
   * Format a p75 for display. CLS is unitless (2 decimals); LCP/INP are ms, shown
   * in seconds once past 1s (matching how CrUX/PageSpeed present them).
   */
  formatValue(key: MetricKey, p75: number): string {
    if (key === 'cls') return p75.toFixed(2);
    return p75 >= 1000 ? `${(p75 / 1000).toFixed(2)} s` : `${Math.round(p75)} ms`;
  }

  /** Google's official CWV rating thresholds (good ≤ / needs-improvement ≤ / poor >). */
  rating(key: MetricKey, p75: number): Rating {
    const [good, needs] = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] }[key];
    if (p75 <= good) return 'good';
    if (p75 <= needs) return 'needs';
    return 'poor';
  }

  /** Word label for a rating (WCAG — never rely on colour alone). */
  ratingLabel(r: Rating): string {
    return r === 'good' ? 'Good' : r === 'needs' ? 'Needs work' : 'Poor';
  }

  /** Plain-language definition per metric (tooltip + screen-reader title). */
  definition(key: MetricKey): string {
    return {
      lcp: 'Largest Contentful Paint — when the largest content element finishes rendering.',
      inp: 'Interaction to Next Paint — how quickly the page responds to a user interaction.',
      cls: 'Cumulative Layout Shift — how much the layout moves unexpectedly (unitless).',
    }[key];
  }
}
