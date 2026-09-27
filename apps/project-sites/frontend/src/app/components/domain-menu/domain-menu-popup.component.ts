import {
  Component,
  computed,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomainMenuService } from './domain-menu.service';
import { Router } from '@angular/router';
import type { Observable } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../services/confirm.service';
import { AdminStateService } from '../../pages/admin/admin-state.service';
import { FocusTrapDirective } from '../../directives/focus-trap.directive';
import {
  buildDomainMenu,
  type DomainMenuModel,
  type DomainMenuRow,
  type HostnameRecord,
} from '../../shared/domain-menu.model';

/**
 * The URL / DOMAIN menu popup — the rendered surface for the (previously orphaned) `buildDomainMenu`
 * model. Shows the site's live URL, the synthesized `{slug}.projectsites.dev` default row, every
 * custom hostname (set-primary / unsubscribe / remove), an attach-a-domain field, and a
 * "Connect a custom domain — $N/mo" CTA that routes to the full purchase flow.
 *
 * @remarks Reads the current site from {@link AdminStateService}; fetches hostnames off
 * `GET /api/sites/:siteId/hostnames`; every mutating action re-fetches on success. Opened by
 * {@link DomainMenuService} (flipped by the editor Preview URL-bar button through the PS bridge, or
 * any admin trigger). Purely additive — no existing surface changed.
 */
@Component({
  selector: 'app-domain-menu-popup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, FocusTrapDirective],
  template: `
    @if (svc.isOpen()) {
      <div class="dm-backdrop" (click)="close()" data-testid="domain-menu-backdrop"></div>
      <div
        class="dm-pop"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'Domain settings for ' + (slug() || 'this site')"
        [focusTrap]="true"
        data-testid="domain-menu-popup"
      >
        <header class="dm-head">
          <div class="dm-head-main">
            <span class="dm-kicker">Site URL &amp; domains</span>
            <a class="dm-primary" [href]="model().primaryUrl" target="_blank" rel="noopener noreferrer">
              {{ primaryHost() }}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
            </a>
          </div>
          <button type="button" class="dm-x" (click)="close()" aria-label="Close domain settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </header>

        @if (loading()) {
          <div class="dm-note" role="status" aria-live="polite">Loading domains…</div>
        } @else {
          <ul class="dm-rows">
            @for (row of model().rows; track row.key) {
              @if (row.kind !== 'cta') {
                <li class="dm-row" [class.is-primary]="row.isPrimary" [attr.data-kind]="row.kind">
                  <span class="dm-glyph" aria-hidden="true">
                    @if (row.homeGlyph) {
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21V12h6v9"/></svg>
                    } @else {
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
                    }
                  </span>
                  <span class="dm-host">
                    @if (row.url) {
                      <a [href]="row.url" target="_blank" rel="noopener noreferrer" class="dm-host-link">{{ row.label }}</a>
                    } @else {
                      {{ row.label }}
                    }
                    @if (row.status && row.status !== 'active') {
                      <span class="dm-status" [attr.data-status]="row.status">{{ row.status }}</span>
                    }
                  </span>
                  @if (row.isPrimary) {
                    <span class="dm-badge" aria-label="Primary domain">Primary</span>
                  }
                  @if (row.actions.length) {
                    <span class="dm-acts">
                      @if (hasAction(row, 'set_primary')) {
                        <button type="button" class="dm-act" [disabled]="busy()" (click)="setPrimary(row)" title="Make primary">Set primary</button>
                      }
                      @if (hasAction(row, 'unsubscribe')) {
                        <button type="button" class="dm-act" [disabled]="busy()" (click)="unsubscribe(row)" title="Cancel this domain's subscription">Unsubscribe</button>
                      }
                      @if (hasAction(row, 'remove')) {
                        <button type="button" class="dm-act dm-act--danger" [disabled]="busy()" (click)="remove(row)" title="Detach this domain">Remove</button>
                      }
                    </span>
                  }
                </li>
              }
            }
          </ul>

          <!-- Attach an existing custom domain (creates a pending hostname). -->
          <form class="dm-attach" (ngSubmit)="attach()">
            <label class="dm-attach-label" for="dm-attach-input">Attach a domain you already own</label>
            <div class="dm-attach-row">
              <input
                id="dm-attach-input"
                class="dm-input"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="yourdomain.com"
                [(ngModel)]="attachHost"
                name="attachHost"
                [disabled]="busy()"
                data-testid="domain-menu-attach-input"
              />
              <button type="submit" class="dm-attach-btn" [disabled]="busy() || !attachValid()">
                <span class="dm-attach-btn-label">{{ busy() ? 'Working…' : 'Attach' }}</span>
              </button>
            </div>
          </form>

          <!-- Buy + register a brand-new domain — routes to the full search/purchase flow. -->
          <button type="button" class="dm-cta" (click)="buyDomain()" data-testid="domain-menu-buy">
            <span class="dm-cta-glyph" aria-hidden="true">＋</span>
            <span class="dm-cta-main">
              <span class="dm-cta-title">Buy &amp; register a new domain</span>
              <span class="dm-cta-sub">Search availability · from ~$17/mo, SSL + DNS handled for you</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .dm-backdrop {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(3, 5, 12, 0.5);
      backdrop-filter: blur(2px);
    }
    .dm-pop {
      position: fixed; z-index: 100001;
      top: 78px; left: 50%; transform: translateX(-50%);
      width: min(460px, calc(100vw - 24px));
      max-height: calc(100dvh - 110px); overflow: auto;
      display: flex; flex-direction: column; gap: 12px;
      padding: 1rem 1.1rem 1.15rem;
      background: linear-gradient(180deg, rgba(14,14,40,0.98), rgba(6,6,16,0.98));
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
      border-radius: var(--ps-radius-xl, 20px);
      box-shadow: 0 30px 80px -28px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,229,255,0.08);
      color: var(--ps-ink, #f4f4ff);
    }
    .dm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .dm-head-main { min-width: 0; }
    .dm-kicker {
      display: block;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase;
      color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .dm-primary {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 3px;
      font-family: 'Sora', system-ui, sans-serif; font-weight: 700; font-size: 0.95rem;
      color: var(--ps-ink, #fff); text-decoration: none; word-break: break-all;
    }
    .dm-primary:hover { color: var(--ps-accent, #00E5FF); }
    .dm-x {
      flex-shrink: 0; width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; color: rgba(255,255,255,0.7); cursor: pointer;
    }
    .dm-x:hover { background: rgba(255,255,255,0.09); color: #fff; }
    .dm-note { font-size: 0.8rem; color: rgba(255,255,255,0.6); padding: 8px 2px; }

    .dm-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .dm-row {
      display: flex; align-items: center; gap: 9px;
      padding: 0.55rem 0.65rem;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
    }
    .dm-row.is-primary { border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 34%, transparent); background: color-mix(in oklch, var(--ps-accent, #00E5FF) 6%, transparent); }
    .dm-glyph { flex-shrink: 0; color: var(--ps-accent, #00E5FF); display: inline-flex; }
    .dm-host { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.74rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-host-link { color: var(--ps-ink, #f4f4ff); text-decoration: none; overflow: hidden; text-overflow: ellipsis; }
    .dm-host-link:hover { color: var(--ps-accent, #00E5FF); text-decoration: underline; }
    .dm-status {
      font-size: 0.56rem; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 1px 6px; border-radius: 999px;
      background: rgba(251,191,36,0.14); color: #fbbf24; border: 1px solid rgba(251,191,36,0.3);
    }
    .dm-badge {
      flex-shrink: 0; font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 2px 8px; border-radius: 999px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 16%, transparent);
      color: var(--ps-accent, #00E5FF); border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
    }
    .dm-acts { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; }
    .dm-act {
      padding: 3px 8px; border-radius: 7px; cursor: pointer;
      font-family: 'Sora', system-ui, sans-serif; font-size: 0.64rem; font-weight: 600;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.8);
    }
    .dm-act:hover:not(:disabled) { background: rgba(0,229,255,0.12); color: var(--ps-accent, #00E5FF); border-color: rgba(0,229,255,0.35); }
    .dm-act:disabled { opacity: 0.5; cursor: progress; }
    .dm-act--danger:hover:not(:disabled) { background: rgba(248,113,113,0.14); color: #fca5a5; border-color: rgba(248,113,113,0.4); }

    .dm-attach { display: flex; flex-direction: column; gap: 5px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.06); }
    .dm-attach-label { font-size: 0.66rem; color: rgba(255,255,255,0.55); }
    .dm-attach-row { display: flex; gap: 6px; }
    .dm-input {
      flex: 1; min-width: 0; padding: 0.45rem 0.6rem;
      background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      color: var(--ps-ink, #f4f4ff); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.74rem;
    }
    .dm-input:focus { outline: none; border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 55%, transparent); }
    .dm-attach-btn {
      flex-shrink: 0; padding: 0 0.9rem; border-radius: 8px; cursor: pointer;
      background: rgba(0,229,255,0.14); color: var(--ps-accent, #00E5FF);
      border: 1px solid rgba(0,229,255,0.4); font-family: 'Sora', system-ui, sans-serif; font-size: 0.72rem; font-weight: 600;
    }
    .dm-attach-btn:hover:not(:disabled) { background: rgba(0,229,255,0.22); }
    .dm-attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .dm-attach-btn-label { display: inline-block; min-width: 8ch; text-align: center; }

    .dm-cta {
      display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 0.6rem 0.7rem; border-radius: 12px; cursor: pointer;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent);
      border: 1px dashed color-mix(in oklch, var(--ps-accent, #00E5FF) 38%, transparent);
      color: var(--ps-ink, #f4f4ff);
    }
    .dm-cta:hover { background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent); }
    .dm-cta-glyph { flex-shrink: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent); color: var(--ps-accent, #00E5FF); font-size: 1rem; font-weight: 700; }
    .dm-cta-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .dm-cta-title { font-family: 'Sora', system-ui, sans-serif; font-size: 0.8rem; font-weight: 700; }
    .dm-cta-sub { font-size: 0.64rem; color: rgba(255,255,255,0.55); }
    @media (prefers-reduced-motion: reduce) { .dm-backdrop { backdrop-filter: none; } }
  `],
})
export class DomainMenuPopupComponent {
  protected svc = inject(DomainMenuService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);
  private state = inject(AdminStateService);
  private router = inject(Router);

  private hostnames = signal<readonly HostnameRecord[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected attachHost = '';

  /** Current site slug from the admin's selected site. */
  protected slug = computed(() => this.state.selectedSite()?.slug ?? '');
  private siteId = computed(() => this.state.selectedSite()?.id ?? '');

  /** The rendered domain menu model (pure `buildDomainMenu` — the previously-orphan brain). */
  protected model = computed<DomainMenuModel>(() =>
    buildDomainMenu(this.slug(), this.hostnames()),
  );
  protected primaryHost = computed(() => this.model().primaryUrl.replace(/^https?:\/\//, ''));

  // Fetch fresh hostnames each time the popup OPENS (mount is persistent), and when the
  // selected site changes while open. Guard skips the close transition.
  private readonly _openEffect = effect(() => {
    if (this.svc.isOpen() && this.siteId()) this.load();
  });

  /** Re-fetch when opened. Called by the mount's open flow; safe to call repeatedly. */
  load(): void {
    const id = this.siteId();
    if (!id) return;
    this.loading.set(true);
    this.api.get<{ hostnames?: HostnameRecord[] }>(`/sites/${id}/hostnames`, undefined, { silent: true }).subscribe({
      next: (r) => {
        this.hostnames.set(Array.isArray(r?.hostnames) ? r.hostnames : []);
        this.loading.set(false);
      },
      error: () => {
        this.hostnames.set([]);
        this.loading.set(false);
      },
    });
  }

  close(): void {
    this.svc.close();
  }

  hasAction(row: DomainMenuRow, action: string): boolean {
    return row.actions.includes(action as DomainMenuRow['actions'][number]);
  }

  protected attachValid(): boolean {
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(this.attachHost.trim());
  }

  setPrimary(row: DomainMenuRow): void {
    if (row.kind === 'default') {
      this.run(this.api.post(`/sites/${this.siteId()}/hostnames/reset-primary`, {}), 'Primary domain updated');
    } else {
      this.run(this.api.put(`/sites/${this.siteId()}/hostnames/${row.key}/primary`, {}), 'Primary domain updated');
    }
  }

  async unsubscribe(row: DomainMenuRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Unsubscribe domain',
      message: `Cancel the subscription for "${row.label}"? It stays attached until the period ends.`,
      confirmLabel: 'Unsubscribe',
      danger: false,
    });
    if (!ok) return;
    this.run(this.api.post(`/sites/${this.siteId()}/hostnames/${row.key}/unsubscribe`, {}), `Unsubscribed ${row.label}`);
  }

  async remove(row: DomainMenuRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Remove domain',
      message: `Detach "${row.label}" from this site? Visitors using it will no longer reach your site.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.run(this.api.delete(`/sites/${this.siteId()}/hostnames/${row.key}`), `Removed ${row.label}`);
  }

  attach(): void {
    const host = this.attachHost.trim().toLowerCase();
    if (!this.attachValid() || this.busy()) return;
    this.run(this.api.post(`/sites/${this.siteId()}/hostnames`, { hostname: host }), `Attaching ${host}…`, () => {
      this.attachHost = '';
    });
  }

  /** Route to the full domains manager (search + buy + register) and close the popup. */
  buyDomain(): void {
    this.close();
    this.router.navigate(['/admin/domains'], { queryParams: { buy: 1 } });
  }

  /** Shared mutating-action runner: guards, toasts, re-fetches the list on success. */
  private run(obs: Observable<unknown>, okMsg: string, onOk?: () => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    obs.subscribe({
      next: () => {
        this.busy.set(false);
        this.toast.success(okMsg);
        onOk?.();
        this.load();
      },
      error: () => {
        this.busy.set(false);
        // ApiService surfaces the failure toast.
      },
    });
  }
}
