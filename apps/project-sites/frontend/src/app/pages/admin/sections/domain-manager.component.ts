import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

type Availability = 'idle' | 'checking' | 'ok' | 'bad';

/**
 * Reusable URL / domain manager for any resource with a controllable slug on
 * `*.cms.projectsites.dev` / `*.app.projectsites.dev` PLUS custom domains CNAME'd to
 * projectsites.dev.
 *
 * Renders the ACTIVE host inline as a click target (+ a PENDING custom domain in a muted style
 * when one is awaiting DNS). Clicking opens an in-place popover to: rename the platform slug
 * (live green/red availability), and attach a custom domain (live CNAME status → clear
 * instructions + one-click DNS-provider deep links → certificate provisioning once pointed).
 *
 * Backend contract (instance-scoped): `GET /apps/slug-check`, `POST /apps/instances/:id/slug`,
 * `GET /apps/instances/:id/cname-check`, `POST /apps/instances/:id/domains`.
 */
@Component({
  selector: 'app-domain-manager',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <span class="dm-root">
      <button type="button" class="dm-trigger" (click)="toggle($event)"
              [attr.aria-expanded]="open()" [attr.aria-label]="'Manage the URL for this instance'"
              data-testid="domain-manager-trigger">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span class="dm-active" data-testid="domain-manager-active">{{ activeHost() }}</span>
        @if (pending(); as p) {
          <span class="dm-pending" [title]="'Pending DNS: ' + p">→ {{ p }}</span>
        }
        <svg class="dm-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      @if (open()) {
        <div class="dm-pop" role="dialog" aria-label="URL & domains" (click)="$event.stopPropagation()" data-testid="domain-manager-pop">
          <!-- ── Platform subdomain ── -->
          <div class="dm-sec">
            <div class="dm-sec-h">Platform subdomain</div>
            <div class="dm-slug-row">
              <input class="dm-input" [ngModel]="slug()" (ngModelChange)="onSlug($event)"
                     placeholder="my-slug" aria-label="Subdomain" spellcheck="false" autocapitalize="off"
                     [class.dm-input--ok]="slugState() === 'ok'" [class.dm-input--bad]="slugState() === 'bad'"
                     data-testid="domain-manager-slug" />
              <span class="dm-suffix">.{{ suffix() }}</span>
              <span class="dm-badge" [attr.data-state]="slugState()" aria-hidden="true">
                @switch (slugState()) {
                  @case ('checking') { <span class="dm-spin"></span> }
                  @case ('ok') { ✓ }
                  @case ('bad') { ✕ }
                }
              </span>
            </div>
            <div class="dm-help" role="status" aria-live="polite">
              @switch (slugState()) {
                @case ('checking') { Checking availability… }
                @case ('ok') { <span class="dm-ok">✓ {{ slug() }}.{{ suffix() }} is available</span> }
                @case ('bad') { <span class="dm-bad">{{ slugMsg() }}</span> }
                @default { Lowercase letters, digits, dashes. }
              }
            </div>
            <button type="button" class="dm-btn dm-btn--primary" (click)="saveSlug()"
                    [disabled]="slugState() !== 'ok' || busy()" data-testid="domain-manager-save-slug">
              {{ busy() ? 'Saving…' : 'Save subdomain' }}
            </button>
          </div>

          <!-- ── Custom domain ── -->
          <div class="dm-sec">
            <div class="dm-sec-h">Custom domain</div>
            <div class="dm-slug-row">
              <input class="dm-input dm-input--wide" [ngModel]="domain()" (ngModelChange)="onDomain($event)"
                     placeholder="projectsites.megabyte.space" aria-label="Custom domain" spellcheck="false" autocapitalize="off"
                     [class.dm-input--ok]="cnameState() === 'ok'" [class.dm-input--bad]="cnameState() === 'bad'"
                     data-testid="domain-manager-domain" />
              <span class="dm-badge" [attr.data-state]="cnameState()" aria-hidden="true">
                @switch (cnameState()) {
                  @case ('checking') { <span class="dm-spin"></span> }
                  @case ('ok') { ✓ }
                  @case ('bad') { ✕ }
                }
              </span>
            </div>

            @if (domain().length > 3) {
              @switch (cnameState()) {
                @case ('ok') {
                  <div class="dm-help dm-ok">✓ CNAME points to projectsites.dev — ready to attach.</div>
                  <button type="button" class="dm-btn dm-btn--primary" (click)="attach()" [disabled]="busy()"
                          data-testid="domain-manager-attach">
                    {{ busy() ? 'Provisioning…' : 'Attach + issue certificate' }}
                  </button>
                }
                @case ('checking') { <div class="dm-help">Checking DNS…</div> }
                @default {
                  <div class="dm-instructions">
                    <div class="dm-help dm-bad">Not pointed yet. Add this DNS record at your provider:</div>
                    <div class="dm-record">
                      <span class="dm-record-cell"><span class="dm-k">Type</span>CNAME</span>
                      <span class="dm-record-cell"><span class="dm-k">Name</span>{{ recordName() }}</span>
                      <span class="dm-record-cell"><span class="dm-k">Target</span>projectsites.dev
                        <button type="button" class="dm-copy" (click)="copy('projectsites.dev')" aria-label="Copy target">⧉</button>
                      </span>
                    </div>
                    <div class="dm-links">
                      <span class="dm-links-lbl">Open DNS at:</span>
                      <a class="dm-link" [href]="cloudflareLink()" target="_blank" rel="noopener noreferrer">Cloudflare</a>
                      <a class="dm-link" [href]="godaddyLink()" target="_blank" rel="noopener noreferrer">GoDaddy</a>
                      <a class="dm-link" [href]="namecheapLink()" target="_blank" rel="noopener noreferrer">Namecheap</a>
                      <button type="button" class="dm-link dm-link--btn" (click)="recheck()">Re-check</button>
                    </div>
                  </div>
                }
              }
            }
          </div>
        </div>
      }
    </span>
  `,
  styles: [
    `
    :host { display: inline-block; min-width: 0; position: relative; }
    .dm-root { position: relative; display: inline-block; }
    .dm-trigger {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 4px 9px; border-radius: 8px; cursor: pointer;
      background: rgba(0,229,255,0.06); border: 1px solid rgba(0,229,255,0.22);
      color: var(--ps-accent, #00E5FF); font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem; transition: background 140ms ease, border-color 140ms ease;
    }
    .dm-trigger:hover { background: rgba(0,229,255,0.12); border-color: rgba(0,229,255,0.4); }
    .dm-trigger:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .dm-active { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
    .dm-pending { color: #fbbf24; opacity: 0.9; font-style: italic; }
    .dm-caret { opacity: 0.7; flex-shrink: 0; }

    .dm-pop {
      position: absolute; top: calc(100% + 8px); left: 0; z-index: 200;
      width: min(420px, 88vw); display: flex; flex-direction: column; gap: 14px;
      padding: 16px; border-radius: 14px;
      background: var(--ps-surface-2, rgba(12,14,24,0.99));
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 24px 60px -22px rgba(0,0,0,0.8);
      backdrop-filter: blur(10px);
    }
    .dm-sec { display: flex; flex-direction: column; gap: 8px; }
    .dm-sec-h {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem;
      font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .dm-slug-row { display: flex; align-items: center; gap: 6px; }
    .dm-input {
      flex: 0 1 auto; min-width: 0; width: 150px;
      padding: 0.45rem 0.6rem; border-radius: 8px;
      background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.14);
      color: var(--ps-ink, #fff); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.74rem;
    }
    .dm-input--wide { flex: 1; width: auto; }
    .dm-input:focus-visible { outline: none; border-color: color-mix(in oklch, var(--ps-accent,#00E5FF) 55%, transparent); }
    .dm-input--ok { border-color: rgba(52,211,153,0.7); background: rgba(52,211,153,0.07); }
    .dm-input--bad { border-color: rgba(248,113,113,0.7); background: rgba(248,113,113,0.07); }
    .dm-suffix { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.72rem; color: rgba(255,255,255,0.55); white-space: nowrap; }
    .dm-badge { width: 18px; text-align: center; font-weight: 700; }
    .dm-badge[data-state="ok"] { color: #34d399; }
    .dm-badge[data-state="bad"] { color: #f87171; }
    .dm-spin {
      display: inline-block; width: 11px; height: 11px; vertical-align: middle;
      border: 2px solid rgba(0,229,255,0.35); border-top-color: var(--ps-accent, #00E5FF);
      border-radius: 50%; animation: dm-spin 700ms linear infinite;
    }
    @keyframes dm-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .dm-spin { animation: none; } }
    .dm-help { font-size: 0.68rem; color: rgba(255,255,255,0.55); line-height: 1.4; }
    .dm-ok { color: #6ee7b7; }
    .dm-bad { color: #fca5a5; }
    .dm-btn {
      align-self: flex-start; padding: 6px 14px; border-radius: 8px; cursor: pointer;
      font-size: 0.72rem; font-weight: 600; border: 1px solid transparent;
    }
    .dm-btn--primary { background: rgba(0,229,255,0.14); border-color: rgba(0,229,255,0.4); color: var(--ps-accent, #00E5FF); }
    .dm-btn--primary:hover:not(:disabled) { background: rgba(0,229,255,0.24); }
    .dm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .dm-btn:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    .dm-instructions { display: flex; flex-direction: column; gap: 8px; }
    .dm-record {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08);
    }
    .dm-record-cell { display: flex; flex-direction: column; gap: 2px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.68rem; color: #fff; word-break: break-all; }
    .dm-k { font-size: 0.55rem; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.45); }
    .dm-copy { background: none; border: none; color: var(--ps-accent, #00E5FF); cursor: pointer; font-size: 0.8rem; padding: 0 2px; }
    .dm-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .dm-links-lbl { font-size: 0.64rem; color: rgba(255,255,255,0.5); }
    .dm-link {
      font-size: 0.68rem; color: var(--ps-accent, #00E5FF); text-decoration: none;
      padding: 3px 9px; border-radius: 999px; background: rgba(0,229,255,0.08); border: 1px solid rgba(0,229,255,0.24);
      cursor: pointer;
    }
    .dm-link:hover { background: rgba(0,229,255,0.16); }
    .dm-link--btn { font-family: inherit; }
    `,
  ],
})
export class DomainManagerComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly instanceId = input.required<string>();
  readonly appId = input.required<string>();
  /** Current active public host, e.g. `acme.cms.projectsites.dev`. */
  readonly host = input.required<string>();
  /** Zone suffix for the platform subdomain, e.g. `cms.projectsites.dev`. */
  readonly suffix = input<string>('cms.projectsites.dev');
  /** Emits when the URL changed (slug renamed / domain attached) so the parent reloads. */
  readonly changed = output<void>();

  readonly open = signal(false);
  readonly busy = signal(false);
  readonly activeHost = computed(() => this.host());
  /** A custom domain awaiting DNS/cert — shown in a muted "pending" style on the trigger. */
  readonly pending = signal<string | null>(null);

  // Slug editor
  readonly slug = signal('');
  readonly slugState = signal<Availability>('idle');
  readonly slugMsg = signal('');
  private slugTimer: ReturnType<typeof setTimeout> | undefined;

  // Custom domain
  readonly domain = signal('');
  readonly cnameState = signal<Availability>('idle');
  private domainTimer: ReturnType<typeof setTimeout> | undefined;

  readonly recordName = computed(() => {
    const parts = this.domain().split('.');
    return parts.length > 2 ? parts[0] : '@';
  });
  readonly cloudflareLink = computed(() => 'https://dash.cloudflare.com/?to=/:account/:zone/dns/records');
  readonly godaddyLink = computed(
    () => `https://dcc.godaddy.com/control/dnsmanagement?domainName=${encodeURIComponent(this.apex())}`,
  );
  readonly namecheapLink = computed(
    () => `https://ap.www.namecheap.com/domains/domaincontrolpanel/${encodeURIComponent(this.apex())}/advancedns`,
  );

  private apex(): string {
    const p = this.domain().split('.');
    return p.length > 2 ? p.slice(-2).join('.') : this.domain();
  }

  toggle(ev: MouseEvent): void {
    ev.stopPropagation();
    const next = !this.open();
    this.open.set(next);
    if (next && !this.slug()) {
      // Seed the slug from the active host's first label.
      this.slug.set(this.host().split('.')[0] ?? '');
    }
  }

  @HostListener('document:click')
  onDocClick(): void {
    if (this.open()) this.open.set(false);
  }
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open()) this.open.set(false);
  }

  onSlug(v: string): void {
    this.slug.set(v);
    if (this.slugTimer) clearTimeout(this.slugTimer);
    this.slugState.set('checking');
    const val = v.trim().toLowerCase();
    if (val === (this.host().split('.')[0] ?? '')) {
      this.slugState.set('idle');
      return;
    }
    this.slugTimer = setTimeout(() => this.checkSlug(val), 350);
  }

  private checkSlug(val: string): void {
    if (!val || val.length < 2 || val.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(val)) {
      this.slugState.set('bad');
      this.slugMsg.set('Use 2–63 lowercase letters, digits, dashes (no leading/trailing dash).');
      return;
    }
    this.api
      .get<{ available: boolean; valid: boolean }>(
        `/apps/slug-check?app_id=${encodeURIComponent(this.appId())}&subdomain=${encodeURIComponent(val)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (r.valid && r.available) {
            this.slugState.set('ok');
          } else {
            this.slugState.set('bad');
            this.slugMsg.set(!r.available ? 'That subdomain is taken.' : 'Invalid subdomain.');
          }
        },
        error: () => {
          this.slugState.set('bad');
          this.slugMsg.set('Could not check availability.');
        },
      });
  }

  saveSlug(): void {
    if (this.slugState() !== 'ok' || this.busy()) return;
    this.busy.set(true);
    this.api
      .post<{ ok: boolean; host: string }>(`/apps/instances/${this.instanceId()}/slug`, {
        subdomain: this.slug().trim().toLowerCase(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.open.set(false);
          this.slugState.set('idle');
          this.toast.success(`URL updated → ${r.host}`);
          this.changed.emit();
        },
        error: () => this.busy.set(false),
      });
  }

  onDomain(v: string): void {
    this.domain.set(v);
    if (this.domainTimer) clearTimeout(this.domainTimer);
    const val = v.trim().toLowerCase();
    if (val.length < 4 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(val)) {
      this.cnameState.set('idle');
      return;
    }
    this.cnameState.set('checking');
    this.domainTimer = setTimeout(() => this.checkCname(val), 400);
  }

  private checkCname(val: string): void {
    this.api
      .get<{ ok: boolean; target: string | null }>(
        `/apps/instances/${this.instanceId()}/cname-check?domain=${encodeURIComponent(val)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.cnameState.set(r.ok ? 'ok' : 'bad'),
        error: () => this.cnameState.set('bad'),
      });
  }

  recheck(): void {
    const val = this.domain().trim().toLowerCase();
    if (val.length > 3) {
      this.cnameState.set('checking');
      this.checkCname(val);
    }
  }

  attach(): void {
    if (this.cnameState() !== 'ok' || this.busy()) return;
    const domain = this.domain().trim().toLowerCase();
    this.busy.set(true);
    this.api
      .post<{ ok: boolean; ssl_status: string }>(`/apps/instances/${this.instanceId()}/domains`, {
        domain,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.pending.set(domain);
          this.toast.success(`${domain} attached — certificate ${r.ssl_status}. Live shortly.`);
          this.changed.emit();
        },
        error: () => this.busy.set(false),
      });
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(
      () => this.toast.success('Copied'),
      () => undefined,
    );
  }
}
