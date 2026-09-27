/**
 * AI concierge engagement card — how visitors use the site's optional AI assistant (the app.js
 * universal-runtime FAB): chats opened, messages sent, unique visitors, and messages-per-chat.
 *
 * Fetches `GET /api/sites/:siteId/analytics/concierge` independently of the main summary load.
 *
 * SELF-HIDING: the concierge is OPTIONAL (many sites' visitors never open it), so this card renders
 * NOTHING when there are no opens — during loading, on error, and on a genuine 0. That keeps the
 * dashboard honest (no fabricated engagement) and uncluttered (no permanently-empty card), while a
 * site whose visitors DO use the assistant sees real, first-party engagement.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';

/** Shape of `GET /api/sites/:siteId/analytics/concierge`. */
export interface ConciergeResponse {
  opens: number;
  messages: number;
  uniqueVisitors: number;
  messagesPerOpen: number | null;
}

@Component({
  selector: 'app-concierge-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (show()) {
      <section class="card cc" data-testid="concierge-card" aria-label="AI concierge engagement">
        <div class="cc-kicker">AI concierge</div>
        <h3 class="cc-head">
          <span class="cc-title">Assistant engagement</span>
          <span class="cc-sub" data-testid="cc-source"
            >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · first-party</span
          >
        </h3>

        <div class="cc-stats" data-testid="cc-stats">
          <div class="cc-primary">
            <span class="cc-value" data-testid="cc-opens">{{ opens().toLocaleString() }}</span>
            <span class="cc-plabel">chats opened</span>
          </div>
          <dl class="cc-secondary">
            <div>
              <dt>Messages</dt>
              <dd data-testid="cc-messages">{{ messages().toLocaleString() }}</dd>
            </div>
            <div>
              <dt>Visitors</dt>
              <dd data-testid="cc-visitors">{{ uniqueVisitors().toLocaleString() }}</dd>
            </div>
            <div>
              <dt>Msgs / chat</dt>
              <dd data-testid="cc-rate">{{ rateLabel() }}</dd>
            </div>
          </dl>
        </div>

        <p class="cc-disclaimer" data-testid="cc-disclaimer">
          How visitors use your site's AI assistant (first-party, cookieless). Shown only when
          there's activity.
        </p>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .card {
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-xl, 16px);
        background: rgba(255, 255, 255, 0.02);
        padding: 0.9rem 1rem;
      }
      .cc-kicker {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .cc-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0.25rem 0 0.9rem;
      }
      .cc-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .cc-sub {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .cc-stats {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.6rem 1.4rem;
        margin-bottom: 0.7rem;
      }
      .cc-primary {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
      }
      .cc-value {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 700;
        letter-spacing: -0.03em;
        font-size: 1.8rem;
        line-height: 1;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .cc-plabel {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .cc-secondary {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 1.2rem;
        margin: 0;
      }
      .cc-secondary div {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
      }
      .cc-secondary dt {
        font-size: 0.58rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .cc-secondary dd {
        margin: 0;
        font-size: 0.84rem;
        font-weight: 600;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .cc-disclaimer {
        margin: 0.5rem 0 0;
        font-size: 0.62rem;
        line-height: 1.4;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
        font-style: italic;
      }
    `,
  ],
})
export class ConciergeCardComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label and the API request. */
  readonly windowDays = input<number>(30);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<ConciergeResponse | null>(null);
  private reqToken = 0;

  constructor() {
    effect(() => {
      const id = this.siteId();
      const days = this.windowDays();
      this.resp.set(null);
      if (!id) {
        return;
      }
      const token = ++this.reqToken;
      this.api
        .get<ConciergeResponse>(`/sites/${id}/analytics/concierge`, { days: String(days) })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            if (token === this.reqToken) this.resp.set(r);
          },
          // Self-hiding: on error we simply stay hidden (never a fabricated engagement).
          error: () => {
            if (token === this.reqToken) this.resp.set(null);
          },
        });
    });
  }

  readonly opens = computed(() => this.resp()?.opens ?? 0);
  readonly messages = computed(() => this.resp()?.messages ?? 0);
  readonly uniqueVisitors = computed(() => this.resp()?.uniqueVisitors ?? 0);

  /** The whole card renders ONLY when there is real concierge activity (≥1 open). */
  readonly show = computed(() => this.opens() > 0);

  /** Messages-per-chat, or "—" when null (no opens — though the card is hidden then anyway). */
  readonly rateLabel = computed(() => {
    const r = this.resp()?.messagesPerOpen;
    return r === null || r === undefined ? '—' : String(r);
  });
}
