/**
 * Admin → Social → Connected-accounts panel (LEFT pane of the composer).
 *
 * Presentational split-out of `social.component.ts`'s accounts `<aside>`: renders
 * the per-platform connect/disconnect cards + the inline load-error banner, and
 * emits intent to the parent (which owns the OAuth popup, the `/api/social/accounts`
 * fetch, and the disconnect DELETE). This component holds NO service calls — it is a
 * pure view over the accounts data the parent passes down.
 *
 * INPUTS:
 *   platforms          — the platform catalog (PLATFORMS)
 *   accounts           — current SocialAccount[] (per-platform connection state)
 *   accountsError      — true when the accounts load failed (shows the retry banner)
 *   disconnectingPids  — platform ids with an in-flight disconnect (drives "Disconnecting…")
 * OUTPUTS:
 *   connect / disconnect — PlatformId the parent should connect / disconnect
 *   retry                — the inline error banner's "retry" click
 *
 * Owns the platform TYPES (PlatformId / PlatformDef / SocialAccount) so the parent
 * imports them from HERE (parent → child import only; no cycle). The PLATFORMS
 * catalog stays in the parent and is passed down via the `platforms` input.
 */
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RevealDirective } from '../../../directives/reveal.directive';
import { InlineErrorComponent } from '../../../components/states';
import { IntegrationHelpComponent, type IntegrationHelpRow } from '../../../components/integration-help/integration-help.component';

export type PlatformId =
  | 'twitter'
  | 'linkedin'
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'bluesky'
  | 'reddit'
  | 'mastodon'
  | 'discord'
  | 'slack'
  | 'telegram';

export interface PlatformDef {
  id: PlatformId;
  label: string;
  charLimit: number;
  color: string;
  glyph: string; // inline SVG path data
  /** Connects via a pasted token/app-password (no OAuth popup). The worker's
   *  GET /connect returns a paste_key spec + POST /paste accepts the creds. */
  pasteKey?: boolean;
}

export interface SocialAccount {
  id?: string;
  platform: PlatformId;
  connected: boolean;
  handle?: string;
  avatar_url?: string;
  expires_at?: string;
}

@Component({
  selector: 'app-social-accounts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, RevealDirective, InlineErrorComponent, IntegrationHelpComponent],
  template: `
    <aside class="pane-accounts" appReveal aria-label="Connected accounts">
      <div class="pane-h">Connected accounts</div>
      @if (accountsError) {
        <app-inline-error
          class="block mb-2"
          data-testid="social-accounts-error"
          message="Couldn't load connection states — badges may be out of date."
          (retry)="retry.emit()" />
      }
      <div class="acct-list">
        @for (p of platforms; track p.id) {
          @let acct = accountFor(p.id);
          <article class="acct-card" [class.is-on]="acct?.connected" [style.--brand]="p.color">
            <div class="acct-glyph" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path [attr.d]="p.glyph"/></svg>
            </div>
            <div class="acct-meta">
              <div class="acct-label">{{ p.label }}</div>
              @if (acct?.connected) {
                <div class="acct-handle">{{ acct?.handle || 'connected' }}</div>
              } @else {
                <div class="acct-handle dim">Not connected</div>
              }
            </div>
            <span class="acct-pill" [class.is-on]="acct?.connected">{{ acct?.connected ? 'Live' : 'Off' }}</span>
            @if (acct?.connected) {
              <button class="acct-btn" type="button" (click)="disconnect.emit(p.id)" [disabled]="isDisconnectingAcct(p.id)" [attr.aria-busy]="isDisconnectingAcct(p.id)" [attr.aria-label]="'Disconnect ' + p.label">{{ isDisconnectingAcct(p.id) ? 'Disconnecting…' : 'Disconnect' }}</button>
            } @else {
              <button class="acct-btn primary" type="button" (click)="connect.emit(p.id)" [attr.aria-label]="'Connect ' + p.label">+ Connect</button>
            }
            <app-integration-help class="acct-help" [rows]="socialHelpRows(p)" [subject]="p.label" [testid]="'social-help-' + p.id" />
          </article>
        }
      </div>
    </aside>
  `,
  styles: [
    `
      :host {
        display: contents;
        --brand: var(--ps-accent, #00e5ff);
      }

      .acct-card.is-on { border-color: color-mix(in oklch, var(--brand) 35%, transparent); }
      .acct-card:hover { transform: translateY(-1px); box-shadow: 0 4px 14px color-mix(in oklch, var(--brand) 14%, transparent); }
      /* While accounts reload, dim the cards so the provisional "Off" states read
         as loading (not a definitive "Not connected"). The loading flag lives on
         the parent's .social-wrap host, so match it via :host-context. */
      :host-context(.social-wrap.is-loading) .acct-card { opacity: 0.5; transition: opacity 0.2s ease; }
      .acct-glyph {
        width: 28px; height: 28px; border-radius: 8px;
        background: color-mix(in oklch, var(--brand) 14%, transparent);
        color: var(--brand); display: grid; place-items: center;
      }
      .acct-meta { min-width: 0; grid-column: 2; }
      /* #12 help disclosure spans the whole card as a thin second row. */
      .acct-help { grid-column: 1 / -1; }
      .acct-label { font-size: 0.76rem; font-weight: 600; color: var(--ps-ink, #f4f4ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .acct-handle { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
      .acct-handle.dim { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); }
      .acct-pill {
        grid-row: 1; grid-column: 3; font-size: 0.56rem; font-weight: 700; text-transform: uppercase;
        padding: 2px 7px; border-radius: 999px;
        background: color-mix(in oklch, #ff5470 14%, transparent); color: #ff8a9d;
      }
      .acct-pill.is-on { background: color-mix(in oklch, #34d399 18%, transparent); color: #6ee7b7; }
      .acct-btn {
        grid-column: 1 / -1; padding: 5px 10px; border-radius: 7px; border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        background: transparent; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
        font-size: 0.7rem; cursor: pointer; transition: all 0.16s ease; font-family: inherit; font-weight: 600;
      }
      .acct-btn:hover { color: var(--ps-ink, #f4f4ff); border-color: color-mix(in oklch, var(--brand) 40%, transparent); }
      .acct-btn.primary { background: color-mix(in oklch, var(--brand) 14%, transparent); border-color: color-mix(in oklch, var(--brand) 35%, transparent); color: var(--brand); }

      @media (prefers-reduced-motion: reduce) {
        .acct-card:hover { transform: none; }
      }
    `,
  ],
})
export class SocialAccountsComponent {
  /** Platform catalog — the parent (which owns the PLATFORMS const) always binds this. */
  @Input() platforms: readonly PlatformDef[] = [];
  /** Current per-platform connection state. */
  @Input() accounts: readonly SocialAccount[] = [];
  /** True when the accounts load failed → show the inline retry banner. */
  @Input() accountsError = false;
  /** Platform ids with an in-flight disconnect → drives the "Disconnecting…" state. */
  @Input() disconnectingPids: ReadonlySet<string> = new Set();

  /** Emits the platform the parent should start an OAuth/paste connect for. */
  @Output() readonly connect = new EventEmitter<PlatformId>();
  /** Emits the platform the parent should disconnect. */
  @Output() readonly disconnect = new EventEmitter<PlatformId>();
  /** Emits when the inline accounts-load-error banner's retry is clicked. */
  @Output() readonly retry = new EventEmitter<void>();

  accountFor(pid: PlatformId): SocialAccount | undefined {
    return this.accounts.find((a) => a.platform === pid);
  }

  isDisconnectingAcct(pid: string): boolean {
    return this.disconnectingPids.has(pid);
  }

  /**
   * Accurate-by-construction `?` help rows for a platform connect card (#12) —
   * derived from the platform's own label + pasteKey flag, so it never claims a
   * scope or retention policy we can't honour.
   */
  socialHelpRows(p: PlatformDef): readonly IntegrationHelpRow[] {
    const oauth = !p.pasteKey;
    return [
      { k: 'Account', v: `A ${p.label} account.` },
      {
        k: 'Connect via',
        v: oauth
          ? `Secure OAuth — you approve access on ${p.label}; we never see your password.`
          : `Paste an app password / access token from ${p.label}.`,
      },
      { k: 'Required?', v: `Optional — connect only to publish to ${p.label}.` },
      {
        k: 'Your data',
        v: `Your ${oauth ? 'access token' : 'token'} is encrypted at rest (AES-GCM). Disconnect anytime to remove it.`,
      },
    ];
  }
}
