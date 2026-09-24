/**
 * Analytics glossary — an accessible "How these metrics are measured" disclosure for
 * `/admin/analytics`. Focused, standalone, presentational (Angular style guide): a
 * static, data-driven definition list, no inputs, no data fetching.
 *
 * WHY (the prompt's spine): a site owner must know WHAT each number means, WHERE it
 * comes from (first-party ProjectSites vs Cloudflare edge), and its CAVEAT (bots
 * filtered, Chromium-only field data, adaptive sampling, ~30-day edge retention) — and
 * must never conflate HTTP requests with page views. Definitions are honest about the
 * measurement source + limits; nothing here implies a metric is exact when it's sampled.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

interface MetricDef {
  term: string;
  /** Plain-language definition — a busy, non-technical owner must understand it. */
  def: string;
  /** Where the number comes from (the honest source distinction). */
  source: 'ProjectSites (first-party)' | 'Cloudflare edge' | 'Real-user (browser)';
}

/** Ordered so the most-used audience metrics come first, then RUX, then edge delivery. */
const DEFS: readonly MetricDef[] = [
  {
    def: 'Each time a page on your site is served. Recorded first-party on every page load (server-side) — automated bots are filtered out, so this reflects real visitors.',
    source: 'ProjectSites (first-party)',
    term: 'Page views',
  },
  {
    def: 'Anonymous visitors counted once per day, summed over the range. Someone returning on another day — or on a second device — counts again, so this is MORE than the number of unique people, and it is not the same as page views or requests.',
    source: 'ProjectSites (first-party)',
    term: 'Visits',
  },
  {
    def: 'Share of sessions that viewed exactly one page before leaving, computed from real first-party session depth (not an edge estimate).',
    source: 'ProjectSites (first-party)',
    term: 'Bounce rate',
  },
  {
    def: 'Visitor actions counted as goals — phone calls, directions, form submissions — captured by the on-site beacon and grouped by kind.',
    source: 'ProjectSites (first-party)',
    term: 'Conversions',
  },
  {
    def: 'Aggregated first-party from recorded page views: geography from the edge request location, device/browser and channel from the user agent and referrer.',
    source: 'ProjectSites (first-party)',
    term: 'Top pages · referrers · geography · device · channel',
  },
  {
    def: 'Real page-load experience measured in visitors’ own browsers. p75 is the value 75% of samples are at or below. These are Chromium-only browser APIs, so samples come from Chrome/Edge visitors — shown only when real field samples exist, never a fabricated 0.',
    source: 'Real-user (browser)',
    term: 'Core Web Vitals (LCP · INP · CLS)',
  },
  {
    def: 'HTTP requests served at Cloudflare’s edge — status-code mix, cache hit ratio (over cacheable requests), and bytes served. Cloudflare adaptive-sampled with ~30-day retention.',
    source: 'Cloudflare edge',
    term: 'Edge delivery (status codes · cache · bandwidth)',
  },
  {
    def: 'A page view is one page load; a request is any HTTP call (the HTML, plus every image, script, and font). One page view is many requests — the two are never mixed.',
    source: 'Cloudflare edge',
    term: 'Requests vs. page views',
  },
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-analytics-glossary',
  standalone: true,
  styles: [
    `
    .ag { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; background: rgba(255,255,255,0.02); }
    .ag-summary { cursor: pointer; padding: 0.6rem 0.9rem; font-size: 0.8rem; font-weight: 600; color: var(--ps-ink, #f4f4ff); list-style: revert; }
    .ag-summary:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; border-radius: 8px; }
    .ag-list { margin: 0; padding: 0 0.9rem 0.6rem; display: grid; gap: 0.6rem; }
    .ag-item { display: grid; gap: 0.15rem; }
    .ag-term { margin: 0; font-size: 0.76rem; font-weight: 600; color: var(--ps-ink, #f4f4ff); display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; }
    .ag-src { font-size: 0.6rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary, #9aa0b4); border: 1px solid rgba(255,255,255,0.14); border-radius: 999px; padding: 0.05rem 0.4rem; }
    .ag-src[data-src='Real-user (browser)'] { color: var(--ps-accent, #00e5ff); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent); }
    .ag-def { margin: 0; font-size: 0.72rem; line-height: 1.45; color: var(--text-secondary, #9aa0b4); }
    .ag-note { margin: 0 0.9rem 0.7rem; font-size: 0.64rem; line-height: 1.4; color: var(--text-secondary, #9aa0b4); }
    `,
  ],
  template: `
    <details class="ag" data-testid="an-glossary">
      <summary class="ag-summary">How these metrics are measured</summary>
      <dl class="ag-list">
        @for (d of defs; track d.term) {
          <div class="ag-item" data-testid="an-glossary-item">
            <dt class="ag-term">
              {{ d.term }}
              <span class="ag-src" [attr.data-src]="d.source">{{ d.source }}</span>
            </dt>
            <dd class="ag-def">{{ d.def }}</dd>
          </div>
        }
      </dl>
      <p class="ag-note">
        Times are shown in your browser’s local zone; daily buckets are aggregated by UTC day.
        &ldquo;First-party&rdquo; means ProjectSites measured it on your site; &ldquo;Cloudflare edge&rdquo;
        is sampled request data available for custom domains.
      </p>
    </details>
  `,
})
export class AnalyticsGlossaryComponent {
  readonly defs = DEFS;
}
