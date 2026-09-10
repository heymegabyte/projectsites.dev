import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  Injector,
  type OnDestroy,
  type OnInit,
  type QueryList,
  signal,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { filter, Subscription } from 'rxjs';

import { AiChatWidgetComponent } from '../../components/ai-chat-widget/ai-chat-widget.component';
import { DomainPickerComponent } from '../../components/domain-picker/domain-picker.component';
import { GlobalDropZoneComponent } from '../../components/global-drop-zone/global-drop-zone.component';
import { NavIconComponent } from '../../components/nav-icon/nav-icon.component';
import { SectionErrorBoundaryComponent } from '../../components/section-error-boundary/section-error-boundary.component';
import { ShareLinkDialogComponent } from '../../components/share-link-dialog/share-link-dialog.component';
import { ShortcutsOverlayComponent } from '../../components/shortcuts-overlay/shortcuts-overlay.component';
import { TaskTrayComponent } from '../../components/task-tray/task-tray.component';
import { FocusTrapDirective } from '../../directives/focus-trap.directive';
import { ApiService, type Site } from '../../services/api.service';
import { type AppLanguage, AppShellService } from '../../services/app-shell.service';
import { AuthService } from '../../services/auth.service';
import { BoltEmbedService } from '../../services/bolt-embed.service';
import { HoverPreloadingStrategy } from '../../services/hover-preloading-strategy';
import { NavigationModeService } from '../../services/navigation-mode.service';
import { ShareLinkService } from '../../services/share-link.service';
import { ToastService } from '../../services/toast.service';
import { provideHlmTooltip } from '../../ui';
import { isEditorPath } from './admin-route.util';
import { adminSectionLabelFromPath, isSiteDetailPath } from './admin-section-labels';
import { AdminStateService } from './admin-state.service';
import { CommandPaletteComponent } from './command-palette.component';
import {
  ADMIN_NAV_GROUPS,
  type AdminNavItem,
  navItemTestId,
  visibleNavGroups,
} from './navigation/admin-nav.model';
import { isSysAdminEmail } from './sys-admin';

interface Notification {
  id: string;
  title: string;
  time: string;
  kind: 'info' | 'warn' | 'ok';
  read: boolean;
  ts?: number;
  href?: string;
}

/**
 * `g`-chord navigation targets — each MUST match the route the shortcuts-overlay
 * advertises for that letter (the overlay is the user-facing source of truth).
 * `e` → `/admin/editor` (NOT `/admin`): the editor moved off the index route, and
 * the cheat-sheet says "Go to Editor", so this map went stale and `g e` was
 * silently landing on the Dashboard. Exported so the contract is unit-tested
 * without instantiating the heavy admin shell.
 */
export const G_CHORD_ROUTES: Readonly<Record<string, string>> = {
  a: '/admin/analytics',
  b: '/admin/billing',
  c: '/admin/ai-chat',
  d: '/admin/domains',
  e: '/admin/editor',
  f: '/admin/forms',
  l: '/admin/traces',
  s: '/admin/snapshots',
  u: '/admin/user',
  v: '/admin/voice',
};

@Component({
  // Activates the black+cyan compact cockpit token layer (_cockpit.scss) for
  // the entire admin subtree ONLY — the marketing surface keeps its own theme.
  // Tokens cascade to all 54 sections + overlays via the shared --ps-* remap.
  host: { 'data-cockpit': 'v2' },
  imports: [
    FormsModule,
    RouterModule,
    CommandPaletteComponent,
    ShortcutsOverlayComponent,
    AiChatWidgetComponent,
    SectionErrorBoundaryComponent,
    FocusTrapDirective,
    DomainPickerComponent,
    GlobalDropZoneComponent,
    TaskTrayComponent,
    ShareLinkDialogComponent,
    NavIconComponent,
    ...BrnTooltipImports,
  ],
  providers: [AdminStateService, provideHlmTooltip()],
  selector: 'app-admin',
  standalone: true,
  styleUrl: './admin.component.scss',
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnInit, OnDestroy {
  // AfterViewInit is declared via the hook below; no need for a separate
  // import since Angular only checks for the named method on the class.
  state = inject(AdminStateService);
  auth = inject(AuthService);
  /**
   * True when the signed-in identity is a platform Feature Flags — gates
   * the operator-only LAYER 1 "Feature Flags" nav item (platform-ops feature
   * flags). Normal site owners only see LAYER 2 "Features" (site-features).
   * Reactive to the auth session signal; mirrors {@link sysAdminGuard}.
   */
  isSysAdmin = computed(() => isSysAdminEmail(this.auth.email()));
  router = inject(Router);
  /** Centralised responsive navigation mode + mobile-drawer state (CDK-driven). */
  nav = inject(NavigationModeService);
  bolt = inject(BoltEmbedService);
  private hoverPreloader = inject(HoverPreloadingStrategy);
  private toast = inject(ToastService);
  private api = inject(ApiService);
  private titleService = inject(Title);
  private metaService = inject(Meta);
  private translate = inject(TranslateService);
  private appShell = inject(AppShellService);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  // Setter-based ViewChild — the iframe is materialized LAZILY by
  // `@if (bolt.iframeUrl())` in the template, so it does NOT exist at
  // ngAfterViewInit (no site selected yet). The old one-time
  // `ngAfterViewInit { registerIframe(ref ?? null) }` permanently nulled the
  // service's iframeEl; every later Save & Deploy toasted "Editor not ready"
  // and the PS_REQUEST_FILES bridge never fired (journey 2026-08-19 — the
  // editor loaded files but publishing was dead). The setter re-registers on
  // EVERY query-result change: null→element (site selected → iframe mounts)
  // and element→null (teardown / sign-out).
  @ViewChild('boltFrame')
  set boltFrameRef(ref: ElementRef<HTMLIFrameElement> | undefined) {
    this.bolt.registerIframe(ref?.nativeElement ?? null);
  }
  @ViewChild('siteSearchInput') private siteSearchInputRef?: ElementRef<HTMLInputElement>;
  @ViewChildren('siteOption') private siteOptionRefs?: QueryList<ElementRef<HTMLButtonElement>>;
  // The sticky admin topbar WRAPS to 2 rows on mobile (~115px vs 62px desktop),
  // but `--ps-admin-topbar-h` was a hardcoded 62px — so the sticky section-search
  // (dashboard) + the editor frame offset landed UNDER the wrapped topbar on mobile
  // (WCAG 2.4.11 Focus Not Obscured AA failure, caught @390 by focus-not-obscured.mjs,
  // AL-251). Measure the topbar's REAL height and publish it into the var so every
  // consumer follows any wrap/height change. Set on the host (`:host` owns the var).
  @ViewChild('adminTopbar') private adminTopbarRef?: ElementRef<HTMLElement>;
  private topbarResizeObs?: ResizeObserver;
  private injector = inject(Injector);

  /** Track favicon URLs that failed to load so we can fall back to the monogram tile. */
  faviconFailed = signal<Set<string>>(new Set());

  /** Active UI language — used by the avatar-menu toggle to render the chip. */
  currentLang = signal<AppLanguage>(
    ((): AppLanguage => {
      try {
        const stored = localStorage.getItem('ps_language');
        return stored === 'es' ? 'es' : 'en';
      } catch {
        return 'en';
      }
    })(),
  );

  siteDropdownOpen = signal(false);
  siteSearchQuery = signal('');
  /**
   * Full-width mode. In `expanded` mode this collapses the labelled 272px
   * sidebar to the SAME 72px icon rail used automatically at tablet widths, so
   * a desktop user can reclaim horizontal space. No-op in `compact` (already a
   * rail) and `mobile` (a drawer). Toggled by ⌘B and the `g w` chord.
   */
  fullWidth = signal(false);

  /** The nav model filtered for the current viewer (operator-only items gated). */
  readonly navGroups = computed(() => visibleNavGroups(ADMIN_NAV_GROUPS, this.isSysAdmin()));
  /**
   * True ⇒ render the 72px icon-only rail (tooltips enabled). Automatic at
   * tablet widths (`compact`) OR when a desktop user collapses the sidebar
   * (`expanded` + {@link fullWidth}). Mobile is a drawer, never a rail.
   */
  readonly railCollapsed = computed(
    () => this.nav.isCompact() || (this.nav.isExpanded() && this.fullWidth()),
  );
  /** `data-testid` for a nav item (explicit `testid` or the `nav-<id>` default). */
  navTestId(item: AdminNavItem): string {
    return navItemTestId(item);
  }
  /** Previous route path — powers the "Jump back" floating button (Tier 1 #6). */
  previousRoute = signal<{ label: string; url: string } | null>(null);
  isEditorRoute = signal(false);
  currentSection = signal('Editor');
  /** Full current admin URL — feeds the real-name title/announcer (P2). */
  readonly currentUrl = signal('');

  /**
   * Document title with REAL site name on site-detail routes (P2 — breadcrumbs
   * with real names / WCAG 2.4.2). `/admin/sites/:id*` → "Branches · Vito's Mens
   * Salon · ProjectSites"; everywhere else → "<Section> · ProjectSites". Computed
   * (not imperative) so a hard-refresh that loads `selectedSite` AFTER the nav
   * still upgrades the title once the site resolves.
   */
  readonly documentTitle = computed(() => {
    const section = this.currentSection();
    const site = this.state.selectedSite();
    if (isSiteDetailPath(this.currentUrl()) && site?.business_name) {
      return `${section} · ${site.business_name} · ProjectSites`;
    }
    return `${section} · ProjectSites`;
  });
  private readonly _titleEffect = effect(() => this.titleService.setTitle(this.documentTitle()));

  /**
   * SPA route announcer text. SR users get NO signal that the section changed on
   * client-side navigation (document-title changes are unreliably announced); a
   * visually-hidden aria-live region bound to this announces "<Section> section"
   * on every nav. Derived from the existing currentSection so it stays in lockstep
   * with the visible breadcrumb + title without a second source of truth.
   */
  readonly routeAnnouncement = computed(() => {
    const s = this.currentSection();
    if (!s) return '';
    const site = this.state.selectedSite();
    if (isSiteDetailPath(this.currentUrl()) && site?.business_name) {
      return `${s} for ${site.business_name} section`;
    }
    return `${s} section`;
  });

  // User menu + notifications + palette.
  userMenuOpen = signal(false);
  notifOpen = signal(false);
  /** Navbar "Site actions" dropdown (Preview · Save & Deploy · Review links). */
  siteActionsOpen = signal(false);
  notifications = signal<Notification[]>([]);
  unreadCount = computed(() => this.notifications().filter((n) => !n.read).length);

  @ViewChild('palette') palette?: CommandPaletteComponent;

  /**
   * Visibility of the global keyboard-shortcuts overlay. Conditional-mount
   * pattern (matches `AppComponent`) — flipping to `true` mounts the
   * overlay, which is internally `open=true` by default. The overlay emits
   * `(closed)` when the user presses Esc, clicks the backdrop, or hits the
   * X button.
   */
  shortcutsOpen = signal(false);

  // Theme toggle — persisted to localStorage, sets data-theme on <html>.
  theme = signal<'dark' | 'light' | 'system'>(
    ((): 'dark' | 'light' | 'system' => {
      try {
        return (localStorage.getItem('ps_theme') as 'dark' | 'light' | 'system') || 'dark';
      } catch {
        return 'dark';
      }
    })(),
  );

  private routerSub?: Subscription;

  // ── Share-link dialog ──
  /** Inline-rendered "Share link" modal open state (replaces the old /admin/review-links page). */
  shareLinkOpen = signal(false);
  private shareLink = inject(ShareLinkService);
  /** Any surface (navbar Actions menu, Cmd+K palette) can request the dialog via ShareLinkService. */
  private shareLinkSub = this.shareLink.open$.subscribe(() => this.openShareLink());

  /** Open the Share-link dialog (closes the Site-actions dropdown first). */
  openShareLink(): void {
    this.siteActionsOpen.set(false);
    if (this.state.selectedSite()) this.shareLinkOpen.set(true);
  }
  closeShareLink(): void {
    this.shareLinkOpen.set(false);
  }

  private updateRouteState(url: string): void {
    // `/admin` is the DASHBOARD, not the editor — only `/admin/editor[/...]`
    // lifts the persistent bolt iframe into place. See isEditorPath().
    this.isEditorRoute.set(isEditorPath(url));
    // Selecting a destination closes the mobile overlay drawer so the user sees
    // the section, not the nav covering it. `closeDrawer()` is safe in every
    // mode (it just clears the signal) — no `window.innerWidth` check, the
    // CDK-backed service owns the breakpoint.
    this.nav.closeDrawer();
    // Capture previous route BEFORE updating, for the jump-back button (Tier 1 #6).
    const prevUrl = this.currentUrl();
    const prevLabel = this.currentSection();
    if (prevUrl && prevUrl !== url && prevLabel !== 'Dashboard') {
      this.previousRoute.set({ label: prevLabel, url: prevUrl });
    }
    // Resolve from the FULL path, not the last segment — a param route
    // (`/admin/sites/:id`) or sub-path (`/admin/snapshots/diff`) would otherwise
    // mislabel to "Dashboard" (the last segment is a param value / unmapped tail).
    const section = adminSectionLabelFromPath(url);
    this.currentSection.set(section);
    this.currentUrl.set(url);
    // Per-route meta swap — the description changes here; the document TITLE is
    // owned by the reactive `_titleEffect` (so it can fold in the real site name
    // once `selectedSite` resolves on a hard refresh). The shell (sidebar +
    // topbar) is never touched — each tab stays a distinct, bookmark-correct view.
    this.metaService.updateTag({
      content: `${section} — your ProjectSites admin dashboard.`,
      name: 'description',
    });
    // Fire-and-forget route telemetry. { silent: true } so a 404/transient
    // failure never surfaces ApiService's generic "resource wasn't found" error
    // toast — this posts on EVERY admin route nav, so without it a single
    // telemetry hiccup would spam the toast across the whole admin.
    this.api
      .post(
        '/analytics/track',
        {
          route: url.split('?')[0],
          site_id: this.state.selectedSite()?.id ?? null,
        },
        { silent: true },
      )
      .subscribe({ error: () => {} });
  }

  ngOnInit(): void {
    this.applyTheme(this.theme());
    this.updateRouteState(this.router.url);
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.updateRouteState(e.urlAfterRedirects));

    if (!this.auth.isLoggedIn()) {
      this.state.loading.set(false);
      return;
    }
    this.state.loadData();
    this.state.startPolling();
    this.seedNotifications();
    // NOTE: we deliberately do NOT prewarm the bolt.diy editor here anymore.
    // Prewarming booted a full Node-in-browser WebContainer + Vite dev server on
    // EVERY admin route (dashboard, feature-flags, …) — spamming the console with
    // bolt/LLMManager/webcontainer logs and lagging the whole admin — and its
    // `<link rel="prefetch">` to editor.projectsites.dev failed CORS anyway. The
    // editor now boots lazily on first /admin/editor visit (see bootEffect) and
    // stays warm thereafter.
  }

  ngAfterViewInit(): void {
    // The bolt iframe registers itself via the `boltFrameRef` setter on every
    // materialization change (see the setter's doc comment — the lazy
    // `@if (bolt.iframeUrl())` mount means ngAfterViewInit runs BEFORE the
    // iframe exists; a registerIframe(null) here permanently nulled the
    // service's element and killed Save & Deploy). Keep the hook for other
    // view-child work; do NOT re-register the iframe here.

    // Publish the topbar's REAL rendered height into --ps-admin-topbar-h so the
    // sticky section-search + editor-frame offsets track the mobile 2-row wrap
    // (fixes WCAG 2.4.11 Focus Not Obscured AA @390 — AL-251). Direct style write,
    // no change detection needed (zoneless-safe); ResizeObserver guarded for SSR.
    const topbar = this.adminTopbarRef?.nativeElement;
    if (topbar && typeof ResizeObserver !== 'undefined') {
      const syncTopbarHeight = () => {
        const h = Math.round(topbar.getBoundingClientRect().height);
        if (h > 0) this.el.nativeElement.style.setProperty('--ps-admin-topbar-h', `${h}px`);
      };
      syncTopbarHeight();
      this.topbarResizeObs = new ResizeObserver(syncTopbarHeight);
      this.topbarResizeObs.observe(topbar);
    }
  }

  /**
   * Effect: boot the bolt.diy iframe ONLY when the user is actually on the
   * editor route. Booting it on every admin route ran a heavyweight
   * WebContainer (Node + Vite + 22 LLM providers) in the background on the
   * dashboard / feature-flags / etc. — the source of the console spam + lag.
   * Once booted it stays loaded (persistent iframe) so returning to the editor
   * is instant; non-editor routes never pay the cost until you open the editor.
   */
  private bootEffect = effect(() => {
    const site = this.state.selectedSite();
    if (this.isEditorRoute()) {
      this.bolt.bootForSite(site ?? null);
    }
  });

  /**
   * Lock background scroll while the mobile overlay drawer is open so the page
   * behind it can't scroll under the finger. Cleared on close / when leaving
   * mobile mode. Guarded for non-browser rendering.
   */
  private readonly _drawerScrollLock = effect(() => {
    if (typeof document === 'undefined') return;
    const locked = this.nav.isMobile() && this.nav.drawerOpen();
    document.body.classList.toggle('drawer-scroll-lock', locked);
  });

  ngOnDestroy(): void {
    this.routerSub?.unsubscribe();
    this.shareLinkSub?.unsubscribe();
    this.state.stopPolling();
    this.bolt.teardown();
    this.topbarResizeObs?.disconnect();
    if (typeof document !== 'undefined') document.body.classList.remove('drawer-scroll-lock');
  }

  // ── Editor save ─────────────────────────────────────

  saveEditor(): void {
    this.bolt.saveAndDeploy();
  }

  // ── Sidebar ─────────────────────────────────────────

  toggleSiteDropdown(event: MouseEvent): void {
    event.stopPropagation();
    const willOpen = !this.siteDropdownOpen();
    this.siteDropdownOpen.set(willOpen);
    if (!willOpen) {
      this.siteSearchQuery.set('');
      return;
    }
    // Auto-focus the search input on open — no extra click required. Use
    // afterNextRender so the @if-mounted input is present in the DOM.
    afterNextRender(
      {
        read: () => {
          requestAnimationFrame(() => {
            this.siteSearchInputRef?.nativeElement.focus({ preventScroll: true });
          });
        },
      },
      { injector: this.injector },
    );
  }

  get filteredSites(): Site[] {
    const q = this.siteSearchQuery().toLowerCase().trim();
    if (!q) return this.state.sites();
    return this.state
      .sites()
      .filter(
        (s) =>
          (s.business_name || '').toLowerCase().includes(q) ||
          (s.slug || '').toLowerCase().includes(q),
      );
  }

  closeSiteDropdown(): void {
    this.siteDropdownOpen.set(false);
  }

  /**
   * ⌘B / the mobile hamburger. Behaviour is mode-aware:
   * - `mobile`   → open/close the overlay drawer.
   * - `expanded` → collapse to / expand from the 72px icon rail (full-width).
   * - `compact`  → no-op (it's already an icon rail).
   */
  toggleSidebar(): void {
    if (this.nav.isMobile()) {
      this.nav.toggleDrawer();
      return;
    }
    if (this.nav.isExpanded()) {
      this.toggleFullWidth();
    }
  }

  /** Selecting a nav destination closes the mobile overlay drawer. */
  onNavItemClick(): void {
    this.nav.closeDrawer();
  }

  closeDropdowns(): void {
    this.siteDropdownOpen.set(false);
    this.siteSearchQuery.set('');
    this.userMenuOpen.set(false);
    this.notifOpen.set(false);
    this.siteActionsOpen.set(false);
  }

  selectSite(site: Site): void {
    this.state.selectSite(site);
    this.siteDropdownOpen.set(false);
    this.siteSearchQuery.set('');
  }

  /**
   * Resolve a favicon URL for a site. Sites don't carry a self-hosted
   * `favicon_url` on the API model yet, so we render the monogram tile for
   * every site — NO external favicon fetch.
   *
   * Why not Google's S2 service: `s2/favicons?domain=X` 302-redirects to
   * `t3.gstatic.com/faviconV2?client=SOCIAL&url=X`, which returns **404 for any
   * domain gstatic hasn't cached** — including real custom domains (e.g.
   * `megabytespace.com`) AND every `*.projectsites.dev` subdomain. That 404 logs
   * a console error on EVERY admin page (failing the console-error gate) and the
   * image element falls back to the monogram anyway. Rendering the monogram directly is
   * deterministic, network-free, and clean. (A prior fix guarded only the
   * `*.projectsites.dev` case; the custom-domain 404 slipped through — surfaced by
   * the Browserbase System Services verify 2026-08-08, board had mis-closed it.)
   * The real enhancement is a self-hosted per-site `favicon_url` (built asset) or
   * a worker proxy that guarantees a 200 fallback — tracked, not this fire.
   */
  siteFaviconUrl(_site: Site): string {
    return '';
  }

  /** First letter of business name, fallback "?". Used by the monogram tile. */
  siteMonogram(site: Site | null | undefined): string {
    const name = (site?.business_name || '').trim();
    if (name) return name.charAt(0).toUpperCase();
    const slug = (site?.slug || '').trim();
    return slug ? slug.charAt(0).toUpperCase() : '?';
  }

  /** True when the upstream favicon for this site failed to load. */
  isFaviconFailed(site: Site): boolean {
    return this.faviconFailed().has(site.id);
  }

  /** Mark a favicon as broken so the template swaps to the monogram tile. */
  onFaviconError(site: Site): void {
    if (this.faviconFailed().has(site.id)) return;
    const next = new Set(this.faviconFailed());
    next.add(site.id);
    this.faviconFailed.set(next);
  }

  /**
   * Enter inside the search input. With a typed query:
   *   • Matches → select the first (top-ranked) match and close dropdown.
   *   • No matches → jump to /create with `?name=<query>` pre-filled so the
   *     user lands on the create wizard with their typed name already in
   *     the business-name field.
   * Empty query falls through (no-op).
   */
  onSiteSearchEnter(ev: Event): void {
    const event = ev as KeyboardEvent;
    event.preventDefault();
    const query = this.siteSearchQuery().trim();
    if (!query) return;
    const top = this.filteredSites[0];
    if (top) {
      this.selectSite(top);
      return;
    }
    // No match — go create a new site with the typed name pre-filled.
    this.siteDropdownOpen.set(false);
    this.siteSearchQuery.set('');
    this.router.navigate(['/create'], { queryParams: { name: query } });
  }

  /**
   * Arrow-key navigation through the site option list. Up/Down move focus,
   * Home/End jump to first/last, Esc closes the dropdown and re-focuses the
   * trigger button via blur. Called from both the search input and the
   * option buttons.
   */
  onSiteListKeydown(ev: KeyboardEvent): void {
    const opts = this.siteOptionRefs?.toArray() ?? [];
    if (!opts.length && ev.key !== 'Escape') return;
    const active = document.activeElement as HTMLElement | null;
    const idx = opts.findIndex((r) => r.nativeElement === active);
    let next = -1;
    switch (ev.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(opts.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        if (idx <= 0) {
          // Bounce focus back to search input from the top of the list.
          ev.preventDefault();
          this.siteSearchInputRef?.nativeElement.focus();
          return;
        }
        next = idx - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = opts.length - 1;
        break;
      case 'Escape':
        ev.preventDefault();
        this.siteDropdownOpen.set(false);
        this.siteSearchQuery.set('');
        return;
      default:
        return;
    }
    if (next >= 0 && opts[next]) {
      ev.preventDefault();
      opts[next].nativeElement.focus();
    }
  }

  // ── Palette ─────────────────────────────────────────

  openPalette(): void {
    this.palette?.openIt();
  }

  openShortcuts(): void {
    this.shortcutsOpen.set(true);
    this.userMenuOpen.set(false);
  }

  /**
   * Flip the active UI language between English and Spanish, push the change
   * through `TranslateService` so all `| translate` bindings refresh, stamp
   * `<html lang>` for screen readers, and persist to localStorage so the
   * choice survives reload (consumed by `app.config.ts initTranslations`).
   */
  toggleLanguage(): void {
    const next: AppLanguage = this.currentLang() === 'en' ? 'es' : 'en';
    this.currentLang.set(next);
    this.translate.use(next).subscribe({
      error: () => undefined,
      next: () => undefined,
    });
    this.appShell.applyLanguage(next);
    this.userMenuOpen.set(false);
    this.toast.info(next === 'es' ? 'Idioma: Español' : 'Language: English');
  }

  toggleTheme(): void {
    const order: ('dark' | 'light' | 'system')[] = ['dark', 'system', 'light'];
    const next = order[(order.indexOf(this.theme()) + 1) % order.length]!;
    this.theme.set(next);
    this.applyTheme(next);
    try {
      localStorage.setItem('ps_theme', next);
    } catch {
      /* ignore */
    }
    this.toast.info(`Theme: ${next}`);
  }
  private applyTheme(t: 'dark' | 'light' | 'system'): void {
    document.documentElement.setAttribute('data-theme', t);
  }

  // ── User menu ───────────────────────────────────────

  /**
   * Up-to-two-character monogram for the avatar. Preference order:
   *   1. First+last initial when `auth.user.name` has 2+ tokens ("Brian Zalewski" → "BZ").
   *   2. First letter of the single-token name ("Brian" → "B").
   *   3. First letter of the email ("hey@megabyte.space" → "H").
   *   4. "?" when nothing is known.
   */
  userInitials(): string {
    const name = this.userName().trim();
    if (name) {
      const tokens = name.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length >= 2) {
        return (tokens[0]!.charAt(0) + tokens[tokens.length - 1]!.charAt(0)).toUpperCase();
      }
      if (tokens.length === 1) return tokens[0]!.charAt(0).toUpperCase();
    }
    const email = this.userEmail().trim();
    if (email) return email.charAt(0).toUpperCase();
    return '?';
  }
  /** Back-compat alias — older templates/tests may still reference `userInitial()`. */
  userInitial(): string {
    return this.userInitials();
  }
  userEmail(): string {
    return (this.auth as unknown as { user?: { email?: string } }).user?.email ?? '';
  }
  userName(): string {
    return (this.auth as unknown as { user?: { name?: string } }).user?.name ?? '';
  }
  planLabel(): string {
    return 'Free';
  }
  toggleUserMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    this.userMenuOpen.update((v) => !v);
    this.notifOpen.set(false);
    this.siteActionsOpen.set(false);
  }

  // ── Notifications ───────────────────────────────────

  toggleNotifications(ev: MouseEvent): void {
    ev.stopPropagation();
    this.notifOpen.update((v) => !v);
    this.userMenuOpen.set(false);
    this.siteActionsOpen.set(false);
  }

  // ── Site actions dropdown (Preview · Save & Deploy · Review links) ──

  toggleSiteActions(ev: MouseEvent): void {
    ev.stopPropagation();
    this.siteActionsOpen.update((v) => !v);
    this.notifOpen.set(false);
    this.userMenuOpen.set(false);
  }
  closeSiteActions(): void {
    this.siteActionsOpen.set(false);
  }
  /** Preview the live site in a new tab, then close the menu. */
  previewSite(site: Site): void {
    this.state.visitSite(site);
    this.siteActionsOpen.set(false);
  }
  /** Copy the site's live URL to the clipboard (toast + graceful failure), then close. */
  copySiteUrl(site: Site): void {
    this.state.copyUrl(site);
    this.siteActionsOpen.set(false);
  }
  /** Save & deploy from the menu (no-ops off the editor route), then close. */
  deployFromMenu(): void {
    if (!this.isEditorRoute() || this.bolt.saving()) return;
    this.saveEditor();
    this.siteActionsOpen.set(false);
  }

  /** Close the avatar-wrap popovers on any outside click (the toggles + pop
   *  contents stopPropagation, so only genuine outside clicks reach here). */
  @HostListener('document:click')
  onDocumentClick(): void {
    this.siteActionsOpen.set(false);
    this.notifOpen.set(false);
    this.userMenuOpen.set(false);
  }
  markAllRead(): void {
    const ids = this.notifications().map((n) => n.id);
    this.notifications.update((ns) => ns.map((n) => ({ ...n, read: true })));
    try {
      localStorage.setItem('ps_notif_read', JSON.stringify(ids));
    } catch {
      /* */
    }
  }
  openNotification(n: Notification): void {
    this.notifications.update((ns) => ns.map((m) => (m.id === n.id ? { ...m, read: true } : m)));
    try {
      const prev = JSON.parse(localStorage.getItem('ps_notif_read') ?? '[]') as string[];
      if (!prev.includes(n.id))
        localStorage.setItem('ps_notif_read', JSON.stringify([...prev, n.id]));
    } catch {
      /* */
    }
    if (n.href) {
      this.router.navigateByUrl(n.href);
      this.notifOpen.set(false);
    }
  }
  groupedNotifications(): { label: string; items: Notification[] }[] {
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const groups = {
      Earlier: [] as Notification[],
      'This week': [] as Notification[],
      Today: [] as Notification[],
    };
    for (const n of this.notifications()) {
      const ts = n.ts ?? now;
      if (ts >= dayStart.getTime()) groups['Today'].push(n);
      else if (now - ts < 1000 * 60 * 60 * 24 * 7) groups['This week'].push(n);
      else groups['Earlier'].push(n);
    }
    return (['Today', 'This week', 'Earlier'] as const)
      .filter((k) => groups[k].length)
      .map((label) => ({ items: groups[label], label }));
  }
  private seedNotifications(): void {
    let readIds: string[] = [];
    try {
      readIds = JSON.parse(localStorage.getItem('ps_notif_read') ?? '[]') as string[];
    } catch {
      /* */
    }
    const seeded: Notification[] = [
      {
        id: 'welcome',
        kind: 'info',
        read: readIds.includes('welcome'),
        time: 'just now',
        title: 'Welcome — press ⌘K to find anything.',
        ts: Date.now(),
      },
    ];
    this.notifications.set(seeded);
    // Pull recent audit log entries as notifications (last 5). Background,
    // best-effort: pass { silent: true } so an audit fetch failure (404 / no
    // data / transient) degrades to the seeded feed instead of firing
    // ApiService's generic "resource wasn't found" error toast on every admin
    // page load. The error handler below is already silent — but without this
    // opt the generic toast fires anyway.
    this.api
      .get<{
        data: { id: string; action: string; target_type: string; created_at: string }[];
      }>('/audit/rows?limit=5', undefined, { silent: true })
      .subscribe({
        error: () => {
          /* no audit available — silent */
        },
        next: (r) => {
          const now = Date.now();
          const items: Notification[] = (r.data ?? []).map((row) => {
            const t = new Date(row.created_at).getTime();
            return {
              href: '/admin/audit',
              id: `audit-${row.id}`,
              kind: row.action.includes('delete')
                ? 'warn'
                : row.action.includes('error')
                  ? 'warn'
                  : 'info',
              read: readIds.includes(`audit-${row.id}`),
              time: this.relativeTime(now - t),
              title: this.humanizeAction(row.action) + this.targetSuffix(row.target_type),
              ts: t,
            };
          });
          if (items.length) this.notifications.update((cur) => [...items, ...cur]);
        },
      });
  }
  /**
   * Build the "· {site}" suffix for a notification title. When the audit row's
   * `target_type` is the literal word "site" (the most common case), swap in
   * the currently-selected site's business_name or `{slug}.projectsites.dev`
   * so the operator sees which site the event belongs to instead of the
   * generic word. For non-site targets (org, billing, hostname…), keep the
   * raw target_type as the descriptor.
   */
  private targetSuffix(targetType: string | null): string {
    if (!targetType) return '';
    if (targetType.toLowerCase() === 'site') {
      const site = this.state.selectedSite();
      const label =
        site?.business_name?.trim() || (site?.slug ? `${site.slug}.projectsites.dev` : '');
      return label ? ` · ${label}` : '';
    }
    return ` · ${targetType}`;
  }
  private humanizeAction(a: string): string {
    return a.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  private relativeTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // Global keyboard shortcuts (must mirror the shortcuts-overlay cheat-sheet):
  //   ?     → open shortcuts cheat-sheet
  //   /     → focus sidebar search
  //   ⌘.    → toggle theme
  //   ⌘B    → toggle sidebar
  //   ⌘S    → save & deploy (editor route only)
  //   g <e/s/a/f/l/c/b/v/d/u/w> → navigate per G_CHORD_ROUTES (w → full-width toggle)
  private gPressedAt = 0;
  @HostListener('document:keydown', ['$event'])
  onGlobalKey(ev: KeyboardEvent): void {
    const inField = (ev.target as HTMLElement | null)?.matches(
      'input, textarea, [contenteditable]',
    );
    if (ev.key === 'Escape') {
      // Mobile drawer first — FocusTrapDirective restores focus to the hamburger.
      if (this.nav.isMobile() && this.nav.drawerOpen()) {
        ev.preventDefault();
        this.nav.closeDrawer();
        return;
      }
      if (this.siteActionsOpen() || this.notifOpen() || this.userMenuOpen()) {
        this.siteActionsOpen.set(false);
        this.notifOpen.set(false);
        this.userMenuOpen.set(false);
        return;
      }
    }
    if (ev.key === '?' && !inField) {
      ev.preventDefault();
      this.shortcutsOpen.set(true);
      return;
    }
    if (ev.key === '/' && !inField) {
      ev.preventDefault();
      (
        document.querySelector('input[placeholder*="Search sites" i]') as HTMLInputElement | null
      )?.focus();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === '.') {
      ev.preventDefault();
      this.toggleTheme();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      this.toggleSidebar();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's' && this.isEditorRoute()) {
      ev.preventDefault();
      this.saveEditor();
      return;
    }
    if (!inField && !ev.metaKey && !ev.ctrlKey) {
      if (ev.key === 'g') {
        this.gPressedAt = Date.now();
        return;
      }
      if (Date.now() - this.gPressedAt < 900) {
        if (ev.key.toLowerCase() === 'w') {
          ev.preventDefault();
          this.toggleFullWidth();
          this.gPressedAt = 0;
          return;
        }
        const path = G_CHORD_ROUTES[ev.key.toLowerCase()];
        if (path) {
          ev.preventDefault();
          this.router.navigateByUrl(path);
          this.gPressedAt = 0;
        }
      }
    }
  }

  /** Toggle full-width mode — sidebar collapses to icon rail. */
  toggleFullWidth(): void {
    this.fullWidth.update((v) => !v);
  }

  /**
   * Tier 1 #4: Trigger route preloading on sidebar link hover.
   * Event delegation on the sidebar `<nav>` element — checks the closest
   * `<a>` with a `routerLink` attribute and queues it for background download.
   */
  onSidebarNavHover(ev: MouseEvent): void {
    const target = (ev.target as HTMLElement | null)?.closest(
      'a[routerlink]',
    ) as HTMLAnchorElement | null;
    if (!target) return;
    const path = target.getAttribute('routerlink') ?? '';
    this.hoverPreloader.preloadRoute(path);
  }

  // ═══════════════════════════════════════════════
  // Tier 1 #2: Sidebar live-count badges
  // ═══════════════════════════════════════════════
  /** Number of sites in the current org. */
  readonly siteCount = computed(() => this.state.sites().length);
  /** True when there are sites — controls badge visibility. */
  readonly hasSites = computed(() => this.siteCount() > 0);
}
