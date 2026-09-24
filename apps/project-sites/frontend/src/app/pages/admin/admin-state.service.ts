import { Injectable, inject, signal, computed } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin, interval, takeWhile, switchMap, of, catchError } from 'rxjs';
import { ApiService, type Site, type DomainSummary, type SubscriptionInfo } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { TelemetryService } from '../../services/telemetry.service';

/**
 * localStorage key for the operator's last-selected site. The selection used to be
 * an in-memory signal only, so a hard reload / new tab / bookmarked `/admin/*` URL
 * reset a multi-site operator back to the default site (`sites[0]`) — losing context.
 * Persisting it (mirrors `ps_session` / `ps_create_draft`) keeps the chosen site across
 * reloads; a stale id (site deleted) degrades gracefully via the `selectedSite` computed
 * (`?? sites[0]`). SSR / private-mode / quota-safe (guarded).
 */
const SELECTED_SITE_KEY = 'ps_selected_site';

/** Read the persisted selected-site id (null if unset / unavailable). */
function readPersistedSelectedSite(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(SELECTED_SITE_KEY) : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, when null) the selected-site id. Never throws. */
function persistSelectedSite(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(SELECTED_SITE_KEY, id);
    else localStorage.removeItem(SELECTED_SITE_KEY);
  } catch {
    /* private mode / quota exceeded — selection just falls back to in-memory */
  }
}

/**
 * Shared state service for the admin dashboard shell and child components.
 * Provided at the AdminComponent level so all children share the same instance.
 *
 * @remarks Holds sites, selected site, subscription, domain summary, and loading state.
 * @example
 * ```ts
 * const state = inject(AdminStateService);
 * const site = state.selectedSite();
 * ```
 */
@Injectable()
export class AdminStateService {
  private api = inject(ApiService);
  auth = inject(AuthService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  private dialog = inject(Dialog);
  private telemetry = inject(TelemetryService);

  sites = signal<Site[]>([]);
  /**
   * The caller's org id, hydrated once from `/api/auth/me` during {@link loadData}.
   * Org-scoped sections (e.g. API Tokens, which gates the worker's `/api/v1-tokens`
   * route on the `x-org-id` header) read this. Empty until the first load resolves —
   * guard org-scoped calls on a non-empty value.
   */
  orgId = signal<string>('');
  /** The caller's org display NAME (from `/api/auth/me`) — labels org-scoped surfaces
   *  (e.g. the audit "Org:" chip) with the real org instead of a hardcoded fallback.
   *  Empty until the first load resolves; consumers fall back to {@link orgId}. */
  orgName = signal<string>('');
  /** Platform super-admin flag (from /api/auth/me) — gates super-admin-only fetches. */
  isSuperAdmin = signal<boolean>(false);
  selectedSiteId = signal<string | null>(readPersistedSelectedSite());
  domainSummary = signal<DomainSummary>({ total: 0, active: 0, pending: 0, failed: 0 });
  subscription = signal<SubscriptionInfo | null>(null);
  loading = signal(true);

  private alive = true;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Bound handler so removeEventListener works on teardown. */
  private readonly visibilityHandler = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.stopLiveRefresh();
    } else if (this.alive && this.sites().length > 0) {
      // Resume + fire one immediate refresh so the user sees fresh data on tab-return.
      this.startLiveRefresh();
    }
  };

  selectedSite = computed<Site | null>(() => {
    const id = this.selectedSiteId();
    const sites = this.sites();
    if (!id) return sites[0] ?? null;
    return sites.find(s => s.id === id) ?? sites[0] ?? null;
  });

  loadData(): void {
    this.loading.set(true);
    this.telemetry.track('admin.refresh', { trigger: 'load_data' });
    // `{ silent: true }` on the three reads: this handler renders its OWN truthful error
    // toast below (with a Retry action), so ApiService's generic per-request toast must NOT
    // also fire — else one failed load double/triple-toasts ("Can't reach the server" ×N +
    // "Failed to load dashboard data"). Established silent-when-component-owns-error pattern
    // (super-admin / snapshots / domains). See [[cf-bot-challenge-opaque-xhr-misleading-toast]].
    forkJoin({
      sites: this.api.listSites({ silent: true }),
      domains: this.api.getDomainSummary({ silent: true }),
      sub: this.api.getSubscription({ silent: true }),
      // org id powers org-scoped sections (API Tokens). Caught so a /me hiccup
      // never blocks the whole dashboard load.
      me: this.api
        .getMe({ silent: true })
        .pipe(
          catchError(() =>
            of({
              data: { org_id: '' } as {
                org_id?: string;
                org_name?: string | null;
                is_super_admin?: boolean;
              },
            }),
          ),
        ),
    }).subscribe({
      next: (res) => {
        this.sites.set(res.sites.data || []);
        this.domainSummary.set(res.domains.data || { total: 0, active: 0, pending: 0, failed: 0 });
        this.subscription.set(res.sub.data || null);
        this.orgId.set(res.me?.data?.org_id ?? '');
        this.orgName.set(res.me?.data?.org_name ?? '');
        this.isSuperAdmin.set(!!res.me?.data?.is_super_admin);
        this.loading.set(false);
        // Start live refresh (sites + domains + subscription every 30s)
        this.startLiveRefresh();
      },
      error: () => {
        this.loading.set(false);
        // ONE truthful, actionable toast — armed with a Retry that re-runs the load
        // (the failure is usually a transient blip; a one-click retry beats a page reload).
        this.toast.error('Failed to load dashboard data', {
          action: {
            label: 'Retry',
            run: (id) => {
              this.toast.dismiss(id);
              this.loadData();
            },
          },
        });
      },
    });
  }


  /**
   * Start live data refresh for the dashboard. Sites + domains + subscription
   * every 30s. The interval is paused automatically when the tab becomes hidden
   * via {@link visibilityHandler} and resumed when it returns to the foreground
   * (with an immediate refresh to give the user fresh numbers on tab-return).
   */
  private startLiveRefresh(): void {
    this.stopLiveRefresh();
    if (typeof document !== 'undefined') {
      // Idempotent — Browser dedupes identical (element, type, listener) triples.
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.refreshTimer = setInterval(() => {
      if (!this.alive) return;
      forkJoin({
        sites: this.api.listSites(),
        domains: this.api.getDomainSummary(),
        sub: this.api.getSubscription(),
      }).pipe(catchError(() => of(null))).subscribe((res) => {
        if (res) {
          this.sites.set(res.sites.data || []);
          this.domainSummary.set(res.domains.data || { total: 0, active: 0, pending: 0, failed: 0 });
          this.subscription.set(res.sub.data || null);
        }
      });
    }, 30_000);
  }

  /** Stop live refresh timer. */
  private stopLiveRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startPolling(): void {
    interval(5000)
      .pipe(
        takeWhile(() => this.alive && this.sites().some(s =>
          ['building', 'queued', 'generating', 'uploading', 'collecting'].includes(s.status)
        )),
        switchMap(() => this.api.listSites())
      )
      .subscribe({
        next: (res) => this.sites.set(res.data || []),
        error: () => { /* silent — poll failures are non-critical */ },
      });
  }

  stopPolling(): void {
    this.alive = false;
    this.stopLiveRefresh();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  selectSite(site: Site): void {
    this.selectedSiteId.set(site.id);
    persistSelectedSite(site.id);
    this.telemetry.track('admin.site.selected', {
      site_id: site.id,
      status: site.status,
      plan: site.plan,
    });
  }

  deleteSite(site: Site, cancelSub: boolean): void {
    this.api.deleteSiteWithOptions(site.id, cancelSub).subscribe({
      next: () => {
        this.sites.update(sites => sites.filter(s => s.id !== site.id));
        this.toast.success('Site deleted');
        this.telemetry.track('admin.site.deleted', {
          site_id: site.id,
          cancel_subscription: cancelSub,
        });
        if (this.selectedSiteId() === site.id) {
          this.selectedSiteId.set(null);
          persistSelectedSite(null);
        }
      },
      error: () => this.toast.error('Failed to delete site'),
    });
  }

  // ── Utility methods ──────────────────────────────────

  getStatusClass(status: string): string {
    const map: Record<string, string> = {
      published: 'published', building: 'building', queued: 'building',
      collecting: 'building', generating: 'building', uploading: 'building',
      error: 'error', failed: 'error', draft: 'draft',
    };
    return map[status] || 'draft';
  }

  getStatusTextClass(status: string): string {
    const cls = this.getStatusClass(status);
    const map: Record<string, string> = {
      published: 'text-green-500',
      building: 'text-amber-400 animate-pulse',
      error: 'text-red-500',
      draft: 'text-text-secondary',
    };
    return map[cls] || 'text-text-secondary';
  }

  getStatusLabel(status: string): string {
    const map: Record<string, string> = {
      published: 'Live', building: 'Building', queued: 'Queued',
      collecting: 'Researching', generating: 'Generating', uploading: 'Uploading',
      error: 'Error', failed: 'Failed', draft: 'Draft',
    };
    return map[status] || status;
  }

  getSiteUrl(site: Site): string {
    if (site.primary_hostname) return `https://${site.primary_hostname}`;
    return `https://${site.slug}.projectsites.dev`;
  }

  getSafeSiteUrl(site: Site): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.getSiteUrl(site));
  }

  getScreenshotUrl(site: Site): string {
    const siteUrl = this.getSiteUrl(site);
    return `/api/image-proxy?url=${encodeURIComponent(`https://image.thum.io/get/width/800/crop/500/wait/3/noanimate/${siteUrl}`)}`;
  }

  isBuilding(site: Site): boolean {
    return ['building', 'queued', 'generating', 'uploading', 'collecting'].includes(site.status);
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  signOut(): void {
    this.telemetry.track('auth.signout');
    this.telemetry.reset();
    // Revoke the cookie-backed Better Auth session too — clearing only the
    // local ps_session leaves a live server session behind, and the /signin
    // BA-cookie bridge would silently re-authenticate on the next visit.
    // Fire-and-forget: local sign-out must never block on the network.
    void fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);
    this.auth.clearSession();
    this.router.navigate(['/']);
  }

  newSite(): void {
    this.auth.clearSelectedBusiness();
    this.auth.setPendingBuild(false);
    this.router.navigate(['/create']);
  }

  visitSite(site: Site): void {
    // noopener,noreferrer: the opened tab must not get window.opener (reverse-tabnabbing).
    window.open(this.getSiteUrl(site), '_blank', 'noopener,noreferrer');
  }

  copyUrl(site: Site): void {
    navigator.clipboard
      .writeText(this.getSiteUrl(site))
      .then(() => this.toast.success('URL copied to clipboard'))
      // Insecure context / denied permission → friendly toast, never a silent
      // unhandled rejection (which would also trip the console-error gate).
      .catch(() => this.toast.error('Could not copy — copy the URL from the address bar'));
  }

  openCheckout(): void {
    const site = this.selectedSite();
    const returnUrl = window.location.href;
    this.api.getMe().subscribe({
      next: (me) => {
        const body: Record<string, unknown> = {
          org_id: me.data.org_id,
          success_url: returnUrl,
          cancel_url: returnUrl,
        };
        if (site) body['site_id'] = site.id;
        this.api.post<{ data: { checkout_url?: string } }>('/billing/checkout', body).subscribe({
          next: (res) => {
            const url = res.data?.checkout_url;
            if (url && this.isHttpsStripeUrl(url)) {
              this.redirectExternal(url);
            } else {
              this.toast.error(url ? 'Received an invalid checkout URL — please retry.' : 'Stripe did not return a checkout URL');
            }
          },
          error: (err) => {
            const msg = err?.error?.error?.message || 'Failed to start checkout';
            this.toast.error(msg);
          },
        });
      },
      error: () => this.toast.error('Failed to start checkout'),
    });
  }

  /** Validate a Stripe redirect URL before navigating — a non-https or non-stripe
   *  checkout URL (e.g. a manipulated/`javascript:` value) must never reach
   *  `location.href`, which executes/redirects in the admin's own tab. */
  private isHttpsStripeUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && /(^|\.)stripe\.com$/.test(u.hostname);
    } catch { return false; }
  }

  /** Seam for the full-page checkout redirect — overridable in tests so the runner doesn't navigate away. */
  protected redirectExternal(url: string): void { window.location.href = url; }

  openDeleteConfirm(site: Site): void {
    import('../../components/delete-confirm/delete-confirm-dialog.component').then(m => {
      const ref = this.dialog.open(m.DeleteConfirmDialogComponent, {
        data: { siteId: site.id, siteName: site.business_name, hasPaidPlan: site.plan === 'paid' },
        panelClass: 'cdk-overlay-transparent',
      });
      ref.closed.subscribe(result => {
        if (result) {
          this.sites.update(sites => sites.filter(s => s.id !== site.id));
          if (this.selectedSiteId() === site.id) {
            this.selectedSiteId.set(null);
            persistSelectedSite(null);
          }
        }
      });
    });
  }

  openBilling(): void {
    this.api.getBillingPortal(window.location.href).subscribe({
      next: (res) => {
        if (res.data?.portal_url) window.open(res.data.portal_url, '_blank', 'noopener,noreferrer');
      },
      error: () => this.toast.error('Failed to open billing portal'),
    });
  }

  goToWaiting(site: Site): void {
    this.router.navigate(['/waiting'], { queryParams: { id: site.id, slug: site.slug } });
  }

  onScreenshotError(event: Event): void {
    const img = event.target as HTMLImageElement;
    img.style.display = 'none';
    const parent = img.parentElement;
    if (parent && !parent.querySelector('.screenshot-fallback')) {
      const div = document.createElement('div');
      div.className = 'site-card-preview-placeholder screenshot-fallback';
      div.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg><span>Preview</span>';
      parent.appendChild(div);
    }
  }
}
