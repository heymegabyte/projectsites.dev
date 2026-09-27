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
 * (live green/red availability), attach a custom domain the owner already has (live CNAME status
 * → clear DNS instructions → certificate provisioning once pointed), and BUY a domain registered
 * through us on Cloudflare (search availability → Stripe Checkout → auto-connect).
 *
 * Backend contract (instance-scoped): `GET /apps/slug-check`, `POST /apps/instances/:id/slug`,
 * `GET /apps/instances/:id/domain-status`, `POST /apps/instances/:id/domains`,
 * `GET /apps/instances/:id/domain-availability`, `POST /apps/instances/:id/domains/purchase`.
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

          <!-- ── Connected domains (platform host + custom domains + primary) ── -->
          <div class="dm-sec">
            <div class="dm-sec-h">Connected domains</div>
            <div class="dm-domains">
              @for (d of rows(); track d.domain) {
                <div class="dm-dom" [class.is-primary]="d.primary"
                     [attr.data-testid]="d.isPlatform ? 'domain-manager-platform-row' : 'domain-manager-domain-row'">
                  <div class="dm-dom-head">
                    <span class="dm-dom-name">{{ d.domain }}</span>
                    @if (d.isPlatform) { <span class="dm-dom-badge dm-dom-badge--muted">Default</span> }
                    @if (d.primary) { <span class="dm-dom-badge">Primary</span> }
                    @if (!d.isPlatform) {
                      <button type="button" class="dm-dom-rm" (click)="removeDomain(d.domain)" [disabled]="busy()"
                              [attr.aria-label]="'Detach ' + d.domain">✕</button>
                    }
                  </div>
                  <div class="dm-dom-status">
                    @if (d.isPlatform) {
                      <span class="dm-stat ok" title="Built-in subdomain — always connected">
                        🔒 built-in host — always connected
                      </span>
                    } @else {
                      <span class="dm-stat" [class.ok]="d.pointed" [class.bad]="!d.pointed"
                            [title]="d.pointed ? 'CNAME resolves to projectsites.dev' : 'Add a CNAME → projectsites.dev'">
                        {{ d.pointed ? '✓' : '○' }} CNAME {{ d.pointed ? 'pointed' : 'not pointed' }}
                      </span>
                      <span class="dm-stat" [class.ok]="d.activated" [title]="'Certificate: ' + d.ssl_status">
                        {{ d.activated ? '🔒 activated' : '⏳ ' + (d.ssl_status || 'pending') }}
                      </span>
                    }
                    @if (!d.primary) {
                      <button type="button" class="dm-dom-act" (click)="setPrimary(d.domain)" [disabled]="busy()"
                              [attr.aria-label]="'Make ' + d.domain + ' the primary URL'"
                              data-testid="domain-manager-set-primary">Set primary</button>
                    }
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- ── Custom domain (owner already has one) ── -->
          <div class="dm-sec">
            <div class="dm-sec-h">Add a custom domain</div>
            <div class="dm-slug-row">
              <input class="dm-input dm-input--wide" [ngModel]="domain()" (ngModelChange)="onDomain($event)"
                     (keydown.enter)="onDomainEnter($event)"
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
                  @if (phase() !== 'certifying' && phase() !== 'connected') {
                    <div class="dm-help dm-ok">✓ Pointed to projectsites.dev — ready to connect.</div>
                    <button type="button" class="dm-attach" (click)="attach()" [disabled]="busy()"
                            data-testid="domain-manager-attach">
                      @if (busy()) { <span class="dm-spin"></span> Connecting… }
                      @else { Attach domain — {{ domain() }} }
                    </button>
                  }
                }
                @case ('checking') { <div class="dm-help">Checking DNS…</div> }
                @default {
                  <div class="dm-instructions">
                    <div class="dm-help dm-bad">Not pointed yet — add this DNS record where your domain is managed:</div>
                    @if (isApex()) {
                      <div class="dm-help dm-warn">⚠ Apex domains can't CNAME at most registrars. Use <strong>www.{{ domain() }}</strong>, or a registrar with CNAME flattening / ALIAS.</div>
                    }
                    <div class="dm-record">
                      <span class="dm-record-cell"><span class="dm-k">Type</span>CNAME</span>
                      <span class="dm-record-cell"><span class="dm-k">Name</span>{{ recordName() }}</span>
                      <span class="dm-record-cell"><span class="dm-k">Target</span>projectsites.dev
                        <button type="button" class="dm-copy" (click)="copy('projectsites.dev')" aria-label="Copy target">⧉</button>
                      </span>
                    </div>
                    <div class="dm-links">
                      <button type="button" class="dm-link dm-link--btn" (click)="recheck()">Re-check now</button>
                    </div>
                    <div class="dm-help dm-watching">We're watching your DNS live — this updates the moment it connects.</div>
                  </div>
                }
              }

              <!-- Live connection ladder — auto-updates while we poll DNS + TLS. -->
              @if (watching() && phase()) {
                <div class="dm-ladder" role="status" aria-live="polite" data-testid="domain-manager-ladder">
                  <div class="dm-step" [class.done]="phaseAtLeast('pointed')" [class.active]="phase() === 'awaiting_dns'">
                    <span class="dm-step-ic">@if (phaseAtLeast('pointed')) { ✓ } @else { <span class="dm-spin"></span> }</span>
                    DNS pointed to projectsites.dev
                  </div>
                  <div class="dm-step" [class.done]="phase() === 'connected'" [class.active]="phase() === 'certifying'">
                    <span class="dm-step-ic">@if (phase() === 'connected') { ✓ } @else if (phase() === 'certifying') { <span class="dm-spin"></span> } @else { • }</span>
                    TLS certificate issued
                  </div>
                  <div class="dm-step" [class.done]="phase() === 'connected'" [class.active]="phase() === 'connected'">
                    <span class="dm-step-ic">@if (phase() === 'connected') { ✓ } @else { • }</span>
                    <strong>Connected — live over HTTPS</strong>
                  </div>
                </div>
              }
            }
          </div>

          <!-- ── Buy a domain through us (Cloudflare-native, at cost) ── -->
          <div class="dm-sec">
            <div class="dm-sec-h">Buy a domain</div>
            <div class="dm-help">Registered through us on Cloudflare, at cost — no separate registrar account, connected automatically.</div>
            <div class="dm-slug-row">
              <input class="dm-input dm-input--wide" [ngModel]="buyName()" (ngModelChange)="onBuyName($event)"
                     (keydown.enter)="onBuyEnter($event)"
                     placeholder="mybusiness.com" aria-label="Domain to buy" spellcheck="false" autocapitalize="off"
                     [class.dm-input--ok]="buyState() === 'ok'" [class.dm-input--bad]="buyState() === 'bad'"
                     data-testid="domain-manager-buy-name" />
              <span class="dm-badge" [attr.data-state]="buyState()" aria-hidden="true">
                @switch (buyState()) { @case ('checking') { <span class="dm-spin"></span> } @case ('ok') { ✓ } @case ('bad') { ✕ } }
              </span>
            </div>
            @switch (buyState()) {
              @case ('ok') {
                <div class="dm-help dm-ok">✓ {{ buyName() }} is available</div>
                <button type="button" class="dm-attach" (click)="purchase()" [disabled]="busy()"
                        data-testid="domain-manager-buy">
                  @if (busy()) { <span class="dm-spin"></span> Starting checkout… }
                  @else { Register &amp; connect — {{ buyPriceLabel() }}/yr + $50/mo }
                </button>
                <div class="dm-help">The $50/mo covers your paid, hosted account. You'll pay the domain in Checkout, then it connects automatically.</div>
              }
              @case ('bad') {
                <div class="dm-help dm-bad">{{ buyName() }} is taken.</div>
                @if (buySuggestions().length) {
                  <div class="dm-help">Try one of these instead:</div>
                  <div class="dm-links" data-testid="domain-manager-buy-suggestions">
                    @for (s of buySuggestions(); track s) {
                      <button type="button" class="dm-link dm-link--btn" (click)="pickSuggestion(s)">{{ s }}</button>
                    }
                  </div>
                }
              }
              @case ('checking') { <div class="dm-help">Checking availability…</div> }
              @default { <div class="dm-help">Type the domain you want, e.g. mybusiness.com</div> }
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

    /* Visually-dominant primary action — the obvious next step once a domain is valid. */
    .dm-attach {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      align-self: stretch; width: 100%; min-height: 40px; padding: 10px 18px;
      border-radius: 10px; cursor: pointer;
      font-family: inherit; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.01em;
      color: var(--ps-bg, #060610);
      background: linear-gradient(180deg, #38ecff, var(--ps-accent, #00E5FF));
      border: 1px solid rgba(0,229,255,0.7);
      box-shadow: 0 8px 22px -8px rgba(0,229,255,0.6), inset 0 1px 0 rgba(255,255,255,0.35);
      transition: transform 120ms ease, box-shadow 160ms ease, filter 160ms ease;
    }
    .dm-attach:hover:not(:disabled) { filter: brightness(1.06); box-shadow: 0 12px 28px -8px rgba(0,229,255,0.75); transform: translateY(-1px); }
    .dm-attach:active:not(:disabled) { transform: translateY(0); }
    .dm-attach:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
    .dm-attach:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .dm-attach .dm-spin { border-color: rgba(6,6,16,0.35); border-top-color: var(--ps-bg, #060610); }
    @media (prefers-reduced-motion: reduce) { .dm-attach { transition: none; } .dm-attach:hover:not(:disabled) { transform: none; } }

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
    .dm-warn { color: #fcd34d; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.22); border-radius: 8px; padding: 6px 9px; }
    .dm-watching { color: rgba(0,229,255,0.8); font-style: italic; }
    .dm-ladder {
      display: flex; flex-direction: column; gap: 8px; margin-top: 10px;
      padding: 12px; border-radius: 10px;
      background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.08);
    }
    .dm-step {
      display: flex; align-items: center; gap: 9px;
      font-size: 0.72rem; color: rgba(255,255,255,0.5);
      transition: color 200ms ease;
    }
    .dm-step.active { color: #fff; }
    .dm-step.done { color: #6ee7b7; }
    .dm-step-ic {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex-shrink: 0; font-weight: 700;
    }
    .dm-step.done .dm-step-ic { color: #34d399; }
    .dm-domains { display: flex; flex-direction: column; gap: 6px; }
    .dm-dom {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px; border-radius: 8px;
      background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.08);
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.7rem;
    }
    .dm-dom.is-primary { border-color: rgba(52,211,153,0.4); background: rgba(52,211,153,0.06); }
    .dm-dom-head { display: flex; align-items: center; gap: 8px; }
    .dm-dom-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; }
    .dm-dom-badge { font-size: 0.56rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #6ee7b7; padding: 1px 6px; border-radius: 999px; background: rgba(52,211,153,0.14); }
    .dm-dom-rm { color: rgba(255,255,255,0.4); background: none; border: none; cursor: pointer; font-size: 0.8rem; padding: 0 2px; flex-shrink: 0; }
    .dm-dom-rm:hover:not(:disabled) { color: #fca5a5; }
    .dm-dom-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .dm-stat { display: inline-flex; align-items: center; gap: 4px; font-size: 0.64rem; color: rgba(255,255,255,0.5); }
    .dm-stat.ok { color: #6ee7b7; }
    .dm-stat.bad { color: #fca5a5; }
    .dm-dom-act { font-size: 0.62rem; color: var(--ps-accent, #00E5FF); background: none; border: none; cursor: pointer; white-space: nowrap; margin-left: auto; }
    .dm-dom-act:hover:not(:disabled) { text-decoration: underline; }
    .dm-dom-act:disabled { opacity: 0.5; }
    `,
  ],
})
export class DomainManagerComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => this.stopWatch());
  }

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
  /** Attached custom domains (multi-domain + primary), loaded when the popover opens. */
  readonly domains = signal<
    ReadonlyArray<{
      domain: string;
      primary: boolean;
      pointed: boolean;
      activated: boolean;
      status: string;
      ssl_status: string;
    }>
  >([]);
  /** The trigger surfaces the PRIMARY custom domain when one is set, else the platform host. */
  readonly activeHost = computed(() => this.domains().find((d) => d.primary)?.domain ?? this.host());
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

  // Live connection watch (polls domain-status until the cert is active)
  readonly phase = signal<'' | 'awaiting_dns' | 'pointed' | 'certifying' | 'connected'>('');
  readonly watching = signal(false);
  private pollHandle: ReturnType<typeof setInterval> | undefined;

  // Buy-a-domain (Cloudflare-native, registered through us at cost) flow
  readonly buyName = signal('');
  readonly buyState = signal<Availability>('idle');
  readonly buyPrice = signal<number | null>(null);
  readonly buyCurrency = signal('USD');
  readonly buySuggestions = signal<ReadonlyArray<string>>([]);
  private buyTimer: ReturnType<typeof setTimeout> | undefined;
  /** "$12.00" style label; falls back to a plain word when the registrar omits a price. */
  readonly buyPriceLabel = computed(() => {
    const p = this.buyPrice();
    if (p == null) return 'at cost';
    const cur = this.buyCurrency() || 'USD';
    const sym = cur === 'USD' ? '$' : cur + ' ';
    return `${sym}${p.toFixed(2)}`;
  });

  /** Apex (2-label) domains can't CNAME at most registrars — surface a nudge. */
  readonly isApex = computed(() => this.domain().trim().replace(/\.$/, '').split('.').filter(Boolean).length === 2);
  private readonly PHASE_ORDER = ['awaiting_dns', 'pointed', 'certifying', 'connected'];
  phaseAtLeast(p: string): boolean {
    return this.PHASE_ORDER.indexOf(this.phase()) >= this.PHASE_ORDER.indexOf(p) && this.phase() !== '';
  }

  readonly recordName = computed(() => {
    const parts = this.domain().split('.');
    return parts.length > 2 ? parts[0] : '@';
  });

  toggle(ev: MouseEvent): void {
    ev.stopPropagation();
    const next = !this.open();
    this.open.set(next);
    if (next) {
      if (!this.slug()) this.slug.set(this.host().split('.')[0] ?? '');
      this.loadDomains();
    }
  }

  private loadDomains(): void {
    this.api
      .get<{
        domains: Array<{
          domain: string;
          primary: boolean;
          pointed: boolean;
          activated: boolean;
          status: string;
          ssl_status: string;
        }>;
      }>(
        `/apps/instances/${this.instanceId()}/domains`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.domains.set(r.domains ?? []),
        error: () => undefined,
      });
  }

  setPrimary(domain: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api
      .post(`/apps/instances/${this.instanceId()}/domains/primary`, { domain })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toast.success(`${domain} is now the primary URL`);
          this.loadDomains();
          this.changed.emit();
        },
        error: () => this.busy.set(false),
      });
  }

  removeDomain(domain: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api
      .delete(`/apps/instances/${this.instanceId()}/domains?domain=${encodeURIComponent(domain)}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toast.success(`${domain} detached`);
          this.loadDomains();
          this.changed.emit();
        },
        error: () => this.busy.set(false),
      });
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
      this.stopWatch();
      this.phase.set('');
      return;
    }
    this.cnameState.set('checking');
    // Debounce, then start LIVE watching: the poll drives both the green/red CNAME state and
    // the connection ladder, so pointing the domain lights up here without re-typing.
    this.domainTimer = setTimeout(() => this.startWatch(val), 400);
  }

  /** Begin polling domain-status until the cert is active (live "Connected ✓"). */
  private startWatch(domain: string): void {
    this.stopWatch();
    this.watching.set(true);
    this.pollStatus(domain);
    this.pollHandle = setInterval(() => this.pollStatus(domain), 6000);
  }

  private stopWatch(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = undefined;
    this.watching.set(false);
  }

  private pollStatus(domain: string): void {
    if (this.domain().trim().toLowerCase() !== domain) {
      this.stopWatch();
      return;
    }
    this.api
      .get<{ dnsOk: boolean; connected: boolean; phase: string }>(
        `/apps/instances/${this.instanceId()}/domain-status?domain=${encodeURIComponent(domain)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.cnameState.set(r.dnsOk ? 'ok' : 'bad');
          this.phase.set(
            r.phase as '' | 'awaiting_dns' | 'pointed' | 'certifying' | 'connected',
          );
          if (r.connected) {
            this.stopWatch();
            this.pending.set(null);
            this.toast.success(`${domain} is connected — live over HTTPS.`);
            this.loadDomains();
            this.changed.emit();
          }
        },
        error: () => this.cnameState.set('bad'),
      });
  }

  recheck(): void {
    const val = this.domain().trim().toLowerCase();
    if (val.length > 3) {
      this.cnameState.set('checking');
      this.startWatch(val);
    }
  }

  /** Enter in the custom-domain field attaches the moment it's validated green. */
  onDomainEnter(ev: Event): void {
    if (this.cnameState() === 'ok' && !this.busy()) {
      ev.preventDefault();
      this.attach();
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
        next: () => {
          this.busy.set(false);
          this.pending.set(domain);
          this.toast.success(`${domain} attached — issuing certificate…`);
          this.changed.emit();
          this.loadDomains();
          this.startWatch(domain); // live-poll until the cert goes active → "Connected ✓"
        },
        error: () => this.busy.set(false),
      });
  }

  // ── Buy a domain (registered through us on Cloudflare, at cost) ──
  onBuyName(v: string): void {
    this.buyName.set(v);
    if (this.buyTimer) clearTimeout(this.buyTimer);
    this.buySuggestions.set([]);
    const val = v.trim().toLowerCase();
    if (!/^[a-z0-9-]+\.[a-z]{2,}$/.test(val)) {
      this.buyState.set('idle');
      this.buyPrice.set(null);
      return;
    }
    this.buyState.set('checking');
    this.buyTimer = setTimeout(() => this.checkAvailability(val), 450);
  }

  /** Enter in the buy field starts checkout when the name is available. */
  onBuyEnter(ev: Event): void {
    if (this.buyState() === 'ok' && !this.busy()) {
      ev.preventDefault();
      this.purchase();
    }
  }

  private checkAvailability(val: string): void {
    this.api
      .get<{ available: boolean; price?: number; currency?: string; tld?: string; suggestions?: string[] }>(
        `/apps/instances/${this.instanceId()}/domain-availability?domain=${encodeURIComponent(val)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (this.buyName().trim().toLowerCase() !== val) return; // stale response
          this.buyState.set(r.available ? 'ok' : 'bad');
          this.buyPrice.set(typeof r.price === 'number' ? r.price : null);
          this.buyCurrency.set(r.currency || 'USD');
          this.buySuggestions.set(r.available ? [] : r.suggestions ?? []);
        },
        error: () => {
          this.buyState.set('bad');
          this.buyPrice.set(null);
          this.buySuggestions.set([]);
        },
      });
  }

  /** Click a "taken" suggestion → load it into the field and re-run availability. */
  pickSuggestion(domain: string): void {
    this.onBuyName(domain);
  }

  /** Buy + auto-connect: Stripe Checkout when a checkoutUrl comes back, else a queued toast. */
  purchase(): void {
    if (this.buyState() !== 'ok' || this.busy()) return;
    const domain = this.buyName().trim().toLowerCase();
    this.busy.set(true);
    this.api
      .post<{ checkoutUrl?: string; status?: string }>(
        `/apps/instances/${this.instanceId()}/domains/purchase`,
        { domain },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          if (r?.checkoutUrl) {
            window.location.href = r.checkoutUrl; // → Stripe Checkout
            return;
          }
          if (r?.status === 'queued') {
            this.toast.success("Registration started — we'll email you when it's connected");
            this.loadDomains();
            this.changed.emit();
            return;
          }
          this.toast.success(`Registration started for ${domain}`);
          this.loadDomains();
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
