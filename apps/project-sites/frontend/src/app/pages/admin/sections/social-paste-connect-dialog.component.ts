import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { HlmInputDirective } from '../../../ui';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

/**
 * The paste-key connect dialog — extracted from the social god component
 * (split slice 3). Owns the Bluesky / Mastodon / Telegram / Discord
 * token-paste forms:
 *
 * - The worker's per-platform PasteSchema bounds are mirrored EXACTLY
 *   (FE↔BE parity per zod-everywhere) — an invalid body never leaves
 *   the browser.
 * - Mastodon's instance_url uses the shared public-https guard
 *   (server-fetched URL — SSRF-adjacent).
 * - `connected` emits after a successful POST so the PARENT reloads
 *   its accounts list.
 *
 * Also restores the `.ap-dlg-*` + `.paste-*` styling: slice 2 moved that
 * CSS family into the Auto-Pilot dialog child while THIS dialog still
 * lived in the parent — Angular's emulated encapsulation orphaned its
 * styles (live visual regression 2026-08-20). The CSS is colocated here
 * so each dialog owns its own copy of the shared family.
 */

/** Shared public-https guard — the parent delegates its RSS validator here too. */
export function isValidPublicHttpsUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.hostname.endsWith('.');
  } catch {
    return false;
  }
}

/** The paste form fields (only the open platform's subset is shown/sent). */
interface PasteFields {
  identifier: string;
  app_password: string;
  instance_url: string;
  access_token: string;
  chat_id: string;
  channel_id: string;
  display_name: string;
}

@Component({
  selector: 'app-social-paste-connect-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DialogShellComponent, HlmInputDirective],
  template: `
    <app-dialog-shell (closed)="closed.emit()">
      <span dialogTitle>Connect {{ platformLabel() || platform() }}</span>
      <span dialogBadge class="ap-dlg-badge">Paste key</span>

      <div class="ap-dlg-body">
        @switch (platform()) {
          @case ('bluesky') {
            <p class="ap-dlg-blurb">Create an app password at Settings → App Passwords, then paste it below.</p>
            <div>
              <label class="ap-dlg-lbl" for="paste-bsky-id">Handle or email</label>
              <input hlmInput id="paste-bsky-id" class="w-full" type="text" [(ngModel)]="f.identifier" maxlength="120" placeholder="you.bsky.social" autocomplete="off" autocapitalize="off" spellcheck="false"
                     [attr.aria-invalid]="bskyIdInvalid() || null" [attr.aria-describedby]="bskyIdInvalid() ? 'paste-bsky-id-err' : null" />
              @if (bskyIdInvalid()) {
                <p class="paste-err" id="paste-bsky-id-err" role="alert">Handle or email must be 2–120 characters.</p>
              }
            </div>
            <div>
              <label class="ap-dlg-lbl" for="paste-bsky-pw">App password</label>
              <input hlmInput id="paste-bsky-pw" class="w-full" type="password" [(ngModel)]="f.app_password" maxlength="120" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="off"
                     [attr.aria-invalid]="bskyPwInvalid() || null" [attr.aria-describedby]="bskyPwInvalid() ? 'paste-bsky-pw-err' : null" />
              @if (bskyPwInvalid()) {
                <p class="paste-err" id="paste-bsky-pw-err" role="alert">App password must be 8–120 characters.</p>
              }
            </div>
          }
          @case ('mastodon') {
            <p class="ap-dlg-blurb">Create an application in your instance’s Preferences → Development, then paste its access token.</p>
            <div>
              <label class="ap-dlg-lbl" for="paste-masto-url">Instance URL</label>
              <input hlmInput id="paste-masto-url" class="w-full" type="url" [(ngModel)]="f.instance_url" placeholder="https://mastodon.social" autocomplete="off" autocapitalize="off" spellcheck="false"
                     [attr.aria-invalid]="mastoUrlInvalid() || null" [attr.aria-describedby]="mastoUrlInvalid() ? 'paste-masto-url-err' : null" />
              @if (mastoUrlInvalid()) {
                <p class="paste-err" id="paste-masto-url-err" role="alert">Enter the instance’s full https URL (e.g. https://mastodon.social).</p>
              }
            </div>
            <div>
              <label class="ap-dlg-lbl" for="paste-masto-tok">Access token</label>
              <input hlmInput id="paste-masto-tok" class="w-full" type="password" [(ngModel)]="f.access_token" maxlength="500" placeholder="Your application access token" autocomplete="off"
                     [attr.aria-invalid]="mastoTokInvalid() || null" [attr.aria-describedby]="mastoTokInvalid() ? 'paste-masto-tok-err' : null" />
              @if (mastoTokInvalid()) {
                <p class="paste-err" id="paste-masto-tok-err" role="alert">Access token must be 20–500 characters.</p>
              }
            </div>
          }
          @case ('telegram') {
            <p class="ap-dlg-blurb">Add your bot to the channel as an admin, then paste the channel’s chat ID.</p>
            <div>
              <label class="ap-dlg-lbl" for="paste-tg-chat">Chat ID</label>
              <input hlmInput id="paste-tg-chat" class="w-full" type="text" [(ngModel)]="f.chat_id" maxlength="80" placeholder="@yourchannel or -100123456789" autocomplete="off" autocapitalize="off" spellcheck="false"
                     [attr.aria-invalid]="tgChatInvalid() || null" [attr.aria-describedby]="tgChatInvalid() ? 'paste-tg-chat-err' : null" />
              @if (tgChatInvalid()) {
                <p class="paste-err" id="paste-tg-chat-err" role="alert">Chat ID must be 80 characters or fewer.</p>
              }
            </div>
            <div>
              <label class="ap-dlg-lbl" for="paste-tg-name">Display name <span class="paste-opt">(optional)</span></label>
              <input hlmInput id="paste-tg-name" class="w-full" type="text" [(ngModel)]="f.display_name" maxlength="120" placeholder="My Channel" autocomplete="off" />
            </div>
          }
          @case ('discord') {
            <p class="ap-dlg-blurb">Enable the channel webhook for your server, then paste the channel ID.</p>
            <div>
              <label class="ap-dlg-lbl" for="paste-dc-chan">Channel ID</label>
              <input hlmInput id="paste-dc-chan" class="w-full" type="text" [(ngModel)]="f.channel_id" maxlength="40" placeholder="123456789012345678" autocomplete="off" autocapitalize="off" spellcheck="false"
                     [attr.aria-invalid]="dcChanInvalid() || null" [attr.aria-describedby]="dcChanInvalid() ? 'paste-dc-chan-err' : null" />
              @if (dcChanInvalid()) {
                <p class="paste-err" id="paste-dc-chan-err" role="alert">Channel ID must be 5–40 characters.</p>
              }
            </div>
            <div>
              <label class="ap-dlg-lbl" for="paste-dc-name">Display name <span class="paste-opt">(optional)</span></label>
              <input hlmInput id="paste-dc-name" class="w-full" type="text" [(ngModel)]="f.display_name" maxlength="120" placeholder="My Server" autocomplete="off" />
            </div>
          }
        }

        @if (error(); as pe) {
          <div class="paste-err" role="alert">{{ pe }}</div>
        }
      </div>

      <div dialogFooter class="ap-dlg-footer">
        <button type="button" class="ap-dlg-btn ghost" (click)="closed.emit()">Cancel</button>
        <button
          type="button"
          class="ap-dlg-btn primary"
          (click)="submit()"
          [disabled]="submitting() || !pasteValid()"
          data-testid="social-paste-submit">
          {{ submitting() ? 'Connecting…' : 'Connect' }}
        </button>
      </div>
    </app-dialog-shell>
  `,
  styles: [
    `
      .ap-dlg-badge {
        padding: 2px 10px; border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        color: var(--ps-accent, #00e5ff);
        font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.08em; text-transform: uppercase;
      }
      .ap-dlg-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }
      .ap-dlg-blurb { margin: 0; font-size: 0.82rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
      .ap-dlg-lbl {
        font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
      }
      .paste-opt { font-weight: 500; text-transform: none; letter-spacing: 0; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610)); }
      .paste-err {
        margin: 0; font-size: 0.68rem; color: #ffb454;
      }
      .ap-dlg-footer { display: flex; justify-content: flex-end; gap: 10px; }
      .ap-dlg-btn {
        border-radius: 10px; padding: 8px 16px; font-size: 0.78rem; font-weight: 600;
        cursor: pointer; font-family: inherit;
        transition: border-color 160ms ease, color 160ms ease, background 160ms ease;
      }
      .ap-dlg-btn.ghost {
        background: transparent; border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 16%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
      }
      .ap-dlg-btn.ghost:hover { color: var(--ps-ink, #f4f4ff); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); }
      .ap-dlg-btn.primary {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: var(--ps-accent, #00e5ff);
      }
      .ap-dlg-btn.primary:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent); }
      .ap-dlg-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    `,
  ],
})
export class SocialPasteConnectDialogComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** The platform being connected (null = closed — the parent @if gates mount). */
  readonly platform = input.required<string | null>();
  /** Resolved display label for the title. */
  readonly platformLabel = input<string>('');

  /** User cancelled / backdrop closed. */
  readonly closed = output<void>();
  /** Connect succeeded — the parent reloads its accounts list. */
  readonly connected = output<void>();

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  /** Per-platform form fields (only the relevant ones are shown/sent). */
  f: PasteFields = {
    identifier: '',
    app_password: '',
    instance_url: '',
    access_token: '',
    chat_id: '',
    channel_id: '',
    display_name: '',
  };

  /**
   * Build the worker's per-platform paste body ({@link PasteSchema}); null if
   * invalid/unsupported. Mirrors the worker Zod bounds EXACTLY
   * (`src/routes/social_oauth.ts` PasteSchema): bluesky identifier 2–120 /
   * app_password 8–120, mastodon access_token 20–500, telegram chat_id 1–80,
   * discord channel_id 5–40, display_name ≤120.
   */
  private pasteBody(pid: string): Record<string, unknown> | null {
    const inRange = (s: string, min: number, max: number): boolean =>
      s.length >= min && s.length <= max;
    const name = this.f.display_name.trim();
    const nameOk = name.length <= 120;
    switch (pid) {
      case 'bluesky': {
        const id = this.f.identifier.trim();
        const pw = this.f.app_password.trim();
        return inRange(id, 2, 120) && inRange(pw, 8, 120)
          ? { kind: 'bluesky', identifier: id, app_password: pw }
          : null;
      }
      case 'mastodon': {
        const url = this.f.instance_url.trim();
        const tok = this.f.access_token.trim();
        return isValidPublicHttpsUrl(url) && inRange(tok, 20, 500)
          ? { kind: 'mastodon', instance_url: url, access_token: tok }
          : null;
      }
      case 'telegram': {
        const chat = this.f.chat_id.trim();
        return inRange(chat, 1, 80) && nameOk
          ? { kind: 'telegram', chat_id: chat, ...(name ? { display_name: name } : {}) }
          : null;
      }
      case 'discord': {
        const chan = this.f.channel_id.trim();
        return inRange(chan, 5, 40) && nameOk
          ? { kind: 'discord', channel_id: chan, ...(name ? { display_name: name } : {}) }
          : null;
      }
      default:
        return null;
    }
  }

  submit(): void {
    const pid = this.platform();
    if (!pid || this.submitting()) return;
    const body = this.pasteBody(pid);
    if (!body) {
      this.error.set('Fill in the required fields above.');
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    this.api.post(`/social/${pid}/paste`, body, { silent: true }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.toast.success(`Connected ${this.platformLabel() || pid}`);
        this.connected.emit();
      },
      error: (err: { error?: { error?: { message?: string } } }) => {
        this.submitting.set(false);
        this.error.set(
          err?.error?.error?.message ?? `Couldn't connect ${this.platformLabel() || pid} — check the values and retry.`,
        );
      },
    });
  }

  /** Mastodon paste: inline-hint gate — a non-empty instance URL that isn't a valid public https URL. */
  mastoUrlInvalid(): boolean {
    const v = this.f.instance_url.trim();
    return v.length > 0 && !isValidPublicHttpsUrl(v);
  }

  /** Bluesky identifier (handle/email): BE `z.string().min(2).max(120)`. */
  bskyIdInvalid(): boolean {
    const v = this.f.identifier.trim();
    return v.length > 0 && (v.length < 2 || v.length > 120);
  }

  /** Bluesky app password: BE `z.string().min(8).max(120)`. */
  bskyPwInvalid(): boolean {
    const v = this.f.app_password.trim();
    return v.length > 0 && (v.length < 8 || v.length > 120);
  }

  /** Mastodon access token: BE `z.string().min(20).max(500)`. */
  mastoTokInvalid(): boolean {
    const v = this.f.access_token.trim();
    return v.length > 0 && (v.length < 20 || v.length > 500);
  }

  /** Telegram chat_id: BE `z.string().min(1).max(80)` — only overlong (>80) trips the hint. */
  tgChatInvalid(): boolean {
    return this.f.chat_id.trim().length > 80;
  }

  /** Discord channel_id: BE `z.string().min(5).max(40)`. */
  dcChanInvalid(): boolean {
    const v = this.f.channel_id.trim();
    return v.length > 0 && (v.length < 5 || v.length > 40);
  }

  /** Submit-gate: the open platform's required fields all satisfy the BE Zod bounds. */
  pasteValid(): boolean {
    const pid = this.platform();
    return pid !== null && this.pasteBody(pid) !== null;
  }
}
