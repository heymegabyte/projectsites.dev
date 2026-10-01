/**
 * Claim checkout return routes (claim_flow, fire-61).
 *
 *  - `ClaimSuccessComponent` — `/admin/claim/success?site=<id>&session_id=<cs_…>`
 *    The celebratory landing after the $29/mo claim checkout completes.
 *    Confirms payment, lists what just unlocked, and CTAs into the claimed
 *    site's detail. The actual plan flip is the Stripe webhook's job
 *    (`checkout.session.completed` → `sites.plan='paid'`), so this surface
 *    promises "under a minute", never pretends to verify the session itself.
 *  - `ClaimCancelComponent` — `/admin/claim/cancel?site=<id>`
 *    The calm, no-charge retry path. Never guilt, never a dead end.
 *
 * Both are standalone, deep-linkable (Stripe redirects land on a cold SPA
 * boot), and graceful about missing/malformed query params: an unknown
 * session renders generic reassurance; a missing site id falls back to the
 * sites grid. The query `session_id` is only echoed when it looks like a
 * real Stripe checkout-session id — anything else is treated as unknown.
 *
 * Flag note: the backend `claim_flow` flag is GLOBALLY dark; these routes are
 * inert chrome until the flag is enabled (they never call the API).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

/** Echo-safe Stripe checkout-session id shape (`cs_…`-style, conservative). */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{8,120}$/;

/** Shared query-param reading for both return surfaces. */
function readReturnParams(route: ActivatedRoute): { siteId: string | null; sessionId: string | null } {
  const qp = route.snapshot.queryParamMap;
  const rawSite = qp.get('site');
  const rawSession = qp.get('session_id');
  return {
    siteId: rawSite && rawSite.trim().length > 0 ? rawSite.trim() : null,
    sessionId: rawSession && SESSION_ID_SHAPE.test(rawSession) ? rawSession : null,
  };
}

const CLAIM_RETURN_STYLES = `
  :host {
    display: block;
    min-height: calc(100vh - 64px);
  }
  .claim-return {
    max-width: 640px;
    margin: 0 auto;
    padding: 48px 20px 96px;
    color: var(--ps-ink, #f4f4ff);
  }
  .card {
    text-align: center;
    padding: 40px 28px 36px;
    background: rgba(8, 8, 32, 0.45);
    border: 1px solid rgba(0, 229, 255, 0.18);
    border-radius: var(--ps-radius-xl, 22px);
    animation: claimIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes claimIn {
    from {
      opacity: 0;
      transform: translateY(14px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 20px;
    margin-bottom: 18px;
    color: var(--ps-success, #4dffb5);
    background: rgba(77, 255, 181, 0.09);
    border: 1px solid rgba(77, 255, 181, 0.28);
  }
  .mark--calm {
    color: var(--ps-accent, #00e5ff);
    background: rgba(0, 229, 255, 0.08);
    border-color: rgba(0, 229, 255, 0.22);
  }
  .mark svg {
    width: 30px;
    height: 30px;
  }
  h1 {
    margin: 0 0 10px;
    font-family: 'Sora', system-ui, sans-serif;
    font-size: clamp(1.45rem, 4.5vw, 1.9rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .sub {
    margin: 0 auto 22px;
    max-width: 440px;
    font-size: 0.95rem;
    line-height: 1.55;
    color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 68%, transparent);
    text-wrap: pretty;
  }
  .unlocks {
    list-style: none;
    margin: 0 auto 26px;
    padding: 18px 20px;
    max-width: 420px;
    text-align: left;
    display: grid;
    gap: 11px;
    background: rgba(0, 229, 255, 0.04);
    border: 1px solid rgba(0, 229, 255, 0.14);
    border-radius: var(--ps-radius-lg, 16px);
  }
  .unlocks li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .unlocks .tick {
    flex-shrink: 0;
    display: inline-flex;
    margin-top: 1px;
    color: var(--ps-success, #4dffb5);
  }
  .unlocks .tick svg {
    width: 16px;
    height: 16px;
  }
  .ctas {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 22px;
    border-radius: 999px;
    font: inherit;
    font-weight: 600;
    font-size: 0.92rem;
    text-decoration: none;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      transform 0.333s ease,
      border-color 0.333s ease,
      box-shadow 0.333s ease;
  }
  .cta-primary {
    background: linear-gradient(135deg, var(--ps-accent, #00e5ff), #50aae3);
    color: #041016;
    box-shadow: 0 16px 40px -22px rgba(0, 229, 255, 0.7);
  }
  .cta-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 22px 52px -20px rgba(0, 229, 255, 0.8);
  }
  .cta-ghost {
    background: rgba(0, 229, 255, 0.05);
    border-color: rgba(0, 229, 255, 0.22);
    color: var(--ps-ink, #f4f4ff);
  }
  .cta-ghost:hover {
    transform: translateY(-1px);
    border-color: rgba(0, 229, 255, 0.5);
  }
  .cta:focus-visible {
    outline: 2px solid var(--ps-accent, #00e5ff);
    outline-offset: 2px;
  }
  .ref {
    margin: 22px 0 0;
    font-size: 0.76rem;
    line-height: 1.5;
    color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 52%, transparent);
    text-wrap: pretty;
  }
  .ref code {
    font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
    font-size: 0.72rem;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    word-break: break-all;
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .cta {
      animation: none !important;
      transition: none !important;
    }
  }
`;

@Component({
  selector: 'app-claim-success',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="claim-return" data-testid="claim-success" aria-labelledby="claim-success-h1">
      <div class="card">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="m8.5 12.5 2.5 2.5 4.5-5.5"></path>
          </svg>
        </span>
        <h1 id="claim-success-h1">It’s official — this site is yours</h1>
        <p class="sub">
          Payment confirmed. We’re switching everything on right now — it usually
          takes under a minute, and you don’t need to do a thing.
        </p>

        <ul class="unlocks" data-testid="claim-unlocks" aria-label="What just unlocked">
          <li>
            <span class="tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5"></path>
              </svg>
            </span>
            The preview banner comes off your site
          </li>
          <li>
            <span class="tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5"></path>
              </svg>
            </span>
            Connect your own domain name
          </li>
          <li>
            <span class="tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5"></path>
              </svg>
            </span>
            Change anything just by asking the AI
          </li>
          <li>
            <span class="tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5"></path>
              </svg>
            </span>
            Messages from your contact form reach you
          </li>
        </ul>

        <div class="ctas">
          <a
            class="cta cta-primary"
            [routerLink]="siteId ? ['/admin/sites', siteId] : ['/admin/sites']"
            data-testid="claim-success-cta"
          >
            {{ siteId ? 'Open your site' : 'Go to your sites' }}
          </a>
          <a class="cta cta-ghost" routerLink="/admin/sites">All sites</a>
        </div>

        @if (sessionId) {
          <p class="ref" data-testid="claim-session-ref">
            Checkout reference: <code>{{ sessionId }}</code> — it’s also on your Stripe receipt email.
          </p>
        } @else {
          <p class="ref" data-testid="claim-session-unknown">
            Landed here by surprise? No worries — if you finished checkout, your
            Stripe receipt email has the details and your site updates on its own.
          </p>
        }
      </div>
    </section>
  `,
  styles: [CLAIM_RETURN_STYLES],
})
export class ClaimSuccessComponent {
  private readonly params = readReturnParams(inject(ActivatedRoute));
  /** Claimed site id from `?site=` — drives the primary CTA target. */
  readonly siteId = this.params.siteId;
  /** Echo-safe checkout-session reference, or null when missing/malformed. */
  readonly sessionId = this.params.sessionId;
}

@Component({
  selector: 'app-claim-cancel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="claim-return" data-testid="claim-cancel" aria-labelledby="claim-cancel-h1">
      <div class="card">
        <span class="mark mark--calm" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v5"></path>
            <path d="M12 16.5h.01"></path>
          </svg>
        </span>
        <h1 id="claim-cancel-h1">No charge — checkout was cancelled</h1>
        <p class="sub">
          Nothing was billed. Your preview site is still live and shareable, and
          you can claim it whenever you’re ready — it takes about a minute.
        </p>
        <div class="ctas">
          <a
            class="cta cta-primary"
            [routerLink]="siteId ? ['/admin/sites', siteId] : ['/admin/sites']"
            data-testid="claim-cancel-cta"
          >
            {{ siteId ? 'Back to your site' : 'Back to your sites' }}
          </a>
          <a class="cta cta-ghost" routerLink="/admin">Dashboard</a>
        </div>
      </div>
    </section>
  `,
  styles: [CLAIM_RETURN_STYLES],
})
export class ClaimCancelComponent {
  /** Site id from `?site=` — routes the retry path back to the site's detail. */
  readonly siteId = readReturnParams(inject(ActivatedRoute)).siteId;
}
