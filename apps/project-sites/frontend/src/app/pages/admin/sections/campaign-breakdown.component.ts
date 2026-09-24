/**
 * Campaigns & sources card — the marketing-attribution block of `/admin/analytics`.
 *
 * Renders two pageview breakdowns (traffic source + campaign) from
 * `traffic.byUtmSource` / `byUtmCampaign` — the `utm_source` / `utm_campaign` params on
 * TAGGED visits (an ad, email, or social link the owner tagged). Focused, standalone,
 * presentational component (Angular style guide): signals + `input()` + native control
 * flow, no fetching.
 *
 * HONESTY: untagged direct/organic/referral traffic (the majority for most sites) is NOT
 * a "campaign" and is excluded server-side — so this card is empty until the owner tags
 * links, and its empty state explains exactly how to populate it (never a fabricated 0,
 * never a giant "unknown" bucket).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One `{ label, count }` breakdown row, as the server returns it. */
export interface CampaignCount {
  label: string;
  count: number;
}

interface CampaignGroup {
  key: 'source' | 'campaign';
  label: string;
  rows: CampaignCount[];
  max: number;
}

@Component({
  selector: 'app-campaign-breakdown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card cmp" data-testid="an-campaigns">
      <div class="cmp-kicker">Marketing</div>
      <h3 class="cmp-head">
        <span class="cmp-title">Campaigns &amp; sources</span>
        <span
          class="cmp-sub"
          data-testid="an-campaigns-note"
          title="Pageviews from links you tagged with utm_source / utm_campaign (ads, email, social). Untagged direct/organic traffic is not a campaign and is excluded. A count, never an estimate."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · tagged visits only</span>
      </h3>

      @if (hasAny()) {
        <div class="cmp-grid">
          @for (g of groups(); track g.key) {
            @if (g.rows.length) {
              <div class="cmp-col" [attr.data-testid]="'an-campaigns-' + g.key">
                <div class="cmp-col-h">{{ g.label }}</div>
                <ul class="cmp-list">
                  @for (r of g.rows; track r.label) {
                    <li class="cmp-row" [attr.data-testid]="'an-campaigns-row-' + g.key">
                      <div class="cmp-row-head">
                        <span class="cmp-label" [attr.title]="r.label">{{ r.label }}</span>
                        <span class="cmp-count">{{ r.count }}</span>
                      </div>
                      <div class="cmp-bar" aria-hidden="true">
                        <div class="cmp-bar-fill" [style.width.%]="barWidth(r.count, g.max)"></div>
                      </div>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </div>
      } @else {
        <p class="cmp-empty" data-testid="an-campaigns-empty">
          No campaign-tagged visits yet. To see which ads, emails, or posts drive traffic, add
          <code>utm_source</code> and <code>utm_campaign</code> to your links — e.g.
          <code>?utm_source=instagram&amp;utm_campaign=spring-sale</code>. Tagged visits then appear
          here as a real breakdown, never an estimate.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .cmp-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .cmp-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .cmp-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .cmp-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .cmp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }
    @media (max-width: 640px) { .cmp-grid { grid-template-columns: 1fr; } }
    .cmp-col-h { font-size: 0.64rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 58%, transparent); margin-bottom: 0.5rem; }
    .cmp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
    .cmp-row-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .cmp-label { font-size: 0.78rem; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }
    .cmp-count { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .cmp-bar { height: 5px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .cmp-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .cmp-empty { margin: 0; font-size: 0.72rem; line-height: 1.6; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .cmp-empty code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.68rem; padding: 0.05rem 0.3rem; border-radius: 5px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); white-space: nowrap; }
  `],
})
export class CampaignBreakdownComponent {
  /** `traffic.byUtmSource` — tagged pageviews by utm_source (instagram / google / …). */
  readonly sources = input<CampaignCount[]>([]);
  /** `traffic.byUtmCampaign` — tagged pageviews by utm_campaign (the owner's named pushes). */
  readonly campaigns = input<CampaignCount[]>([]);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);

  /** Top non-zero rows for one dimension, sorted by count desc, capped at 6. */
  private top(rows: CampaignCount[]): CampaignCount[] {
    return [...rows]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }

  /** The two dimensions as render-ready groups (top rows + the group's max, for bar scaling). */
  readonly groups = computed<CampaignGroup[]>(() =>
    (
      [
        { key: 'source', label: 'Traffic sources', rows: this.top(this.sources()) },
        { key: 'campaign', label: 'Campaigns', rows: this.top(this.campaigns()) },
      ] as const
    ).map((g) => ({ ...g, max: g.rows.reduce((m, r) => Math.max(m, r.count), 0) })),
  );

  /** True when EITHER dimension has tagged data — else the card shows the honest empty state. */
  readonly hasAny = computed(() => this.groups().some((g) => g.rows.length > 0));

  /** Bar width as a % of the group's largest count (min 4% so a small bar stays visible). */
  barWidth(count: number, max: number): number {
    return max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  }
}
