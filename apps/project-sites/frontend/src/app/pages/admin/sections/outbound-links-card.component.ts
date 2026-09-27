/**
 * Top-links card — first-party OUTBOUND / CONTACT CLICKS for `/admin/analytics`. Standalone,
 * presentational (Angular style guide): signals + `input()` + native control flow, no fetching.
 * Reads `traffic.outboundClicks` (the click DESTINATIONS beaconed as `conversion` events by
 * app.js → `visitor_events`, server-normalized). The WHICH-LINKS companion to the Conversions
 * card's by-category counts — answers "are visitors tapping my phone number / booking link?".
 *
 * HONESTY: shows real click counts per destination; an empty list is an explicit "no link clicks
 * tracked yet" (never a fabricated 0). The hrefs are the OWNER's own outbound targets (their
 * phone / email / social / booking links), never visitor PII, and were server-normalized (query
 * stripped) before storage.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One clicked outbound/contact link. */
export interface OutboundLinkStat {
  href: string;
  kind: string | null;
  count: number;
}

/** The `traffic.outboundClicks` shape. */
export interface OutboundClicksBlock {
  total: number;
  byLink: OutboundLinkStat[];
}

/** A display row: the link + a human label + an icon for its kind. */
export interface OutboundRow {
  href: string;
  label: string;
  icon: string;
  count: number;
}

/** Phosphor icon per click kind. */
const KIND_ICON: Record<string, string> = {
  call: 'i-ph:phone',
  email: 'i-ph:envelope-simple',
  sms: 'i-ph:chat-circle-text',
  outbound: 'i-ph:arrow-square-out',
  directions: 'i-ph:map-pin',
};

/** Human-readable label for a stored href (strip the scheme; keep it compact). */
export function outboundLinkLabel(href: string): string {
  if (/^tel:/i.test(href)) return href.replace(/^tel:/i, '');
  if (/^mailto:/i.test(href)) return href.replace(/^mailto:/i, '');
  if (/^sms:/i.test(href)) return href.replace(/^sms:/i, '');
  return href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-outbound-links-card',
  standalone: true,
  styles: [
    `
    .ol { border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); border-radius: var(--ps-radius-xl, 16px); background: rgba(255,255,255,0.02); padding: 0.9rem 1rem; }
    .ol-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .ol-title { font-size: 0.8rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 0.4rem; }
    .ol-win { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .ol-total { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); margin-bottom: 0.3rem; }
    .ol-measuring { font-size: 0.76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .ol-rows { margin: 0.4rem 0 0; padding: 0; list-style: none; display: grid; gap: 0.35rem; }
    .ol-row { display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.55rem; align-items: center; font-size: 0.74rem; padding: 0.2rem 0; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.06)); }
    .ol-row:last-child { border-bottom: none; }
    .ol-icon { color: var(--ps-accent, #00e5ff); shrink: 0; }
    .ol-link { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ol-bar { width: 3rem; height: 0.4rem; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .ol-bar-fill { height: 100%; border-radius: 999px; background: var(--ps-accent, #00e5ff); }
    .ol-n { color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ol-note { margin: 0.55rem 0 0; font-size: 0.62rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    `,
  ],
  template: `
    <section class="ol" data-testid="an-outbound" aria-label="Top links clicked">
      <div class="ol-head">
        <span class="ol-title"><span aria-hidden="true">🔗</span> Top links clicked</span>
        <span class="ol-win">last {{ windowDays() }} days</span>
      </div>

      @if (rows().length) {
        <div class="ol-total">{{ total().toLocaleString() }} link click{{ total() === 1 ? '' : 's' }}</div>
        <ul class="ol-rows">
          @for (r of rows(); track r.href) {
            <li class="ol-row" data-testid="an-outbound-row">
              <div class="ol-icon" [class]="r.icon" aria-hidden="true"></div>
              <span class="ol-link" [attr.title]="r.href">{{ r.label }}</span>
              <span class="ol-bar" aria-hidden="true">
                <span class="ol-bar-fill" [style.width.%]="pctOfTop(r.count)"></span>
              </span>
              <span class="ol-n" [attr.aria-label]="r.count + ' clicks to ' + r.label">{{ r.count }}</span>
            </li>
          }
        </ul>
        <p class="ol-note">
          First-party — which of your phone, email, and outbound links visitors actually tap
          (the "which links" companion to Conversions). Destinations are your own links, query
          strings stripped; never a visitor's data.
        </p>
      } @else {
        <p class="ol-measuring" data-testid="an-outbound-empty" aria-live="polite">
          No link clicks tracked yet.
        </p>
        <p class="ol-note">
          Clicks on your phone number, email, and outbound/booking links appear here once visitors
          start tapping them — never a fabricated 0.
        </p>
      }
    </section>
  `,
})
export class OutboundLinksCardComponent {
  /** The `traffic.outboundClicks` block (undefined on older payloads → treated as empty). */
  readonly outboundClicks = input<OutboundClicksBlock | undefined>(undefined);
  /** Window length for the header label. */
  readonly windowDays = input<number>(30);

  /** Total link clicks across ALL destinations (not just the top-8 shown). */
  readonly total = computed(() => this.outboundClicks()?.total ?? 0);

  /** The top links as display rows (icon + humanized label). */
  readonly rows = computed<OutboundRow[]>(() =>
    (this.outboundClicks()?.byLink ?? []).map((l) => ({
      href: l.href,
      label: outboundLinkLabel(l.href),
      icon: (l.kind && KIND_ICON[l.kind]) || 'i-ph:link-simple',
      count: l.count,
    })),
  );

  /** Bar width for a row, scaled to the top (most-clicked) link. */
  pctOfTop(count: number): number {
    const top = this.rows()[0]?.count ?? 0;
    return top > 0 ? Math.round((100 * count) / top) : 0;
  }
}
