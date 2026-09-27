import { Component, type OnInit, type OnDestroy, HostListener, inject, signal, effect } from '@angular/core';
import {
  RouterOutlet,
  Router,
  ActivatedRoute,
  NavigationEnd,
  NavigationStart,
  NavigationCancel,
  NavigationError,
  RouteConfigLoadStart,
} from '@angular/router';
import { filter } from 'rxjs';
import { HeaderComponent } from './components/header/header.component';
import { ToastComponent } from './components/toast/toast.component';
import { NetworkStatusBannerComponent } from './components/network-status/network-status-banner.component';
import { BgOrbsComponent } from './components/bg-orbs/bg-orbs.component';
import { EasterEggsComponent } from './components/easter-eggs/easter-eggs.component';
import { CommandPaletteComponent } from './components/command-palette/command-palette.component';
import { ShortcutsOverlayComponent } from './components/shortcuts-overlay/shortcuts-overlay.component';
import { InstallPromptComponent } from './components/install-prompt/install-prompt.component';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from './services/auth.service';
import { ApiService } from './services/api.service';
import { MetaService } from './services/meta.service';
import { AppShellService, type AppLanguage } from './services/app-shell.service';
import { TelemetryService } from './services/telemetry.service';
import { BoltEmbedService } from './services/bolt-embed.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, HeaderComponent, ToastComponent, NetworkStatusBannerComponent, BgOrbsComponent, EasterEggsComponent, CommandPaletteComponent, ShortcutsOverlayComponent, InstallPromptComponent],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <app-network-status-banner />
    <!-- No role="banner" here: HeaderComponent's inner <header role="banner"> IS the banner
         landmark. Putting it on the host too created TWO nested banner landmarks (axe
         landmark-no-duplicate-banner / -is-top-level / -unique) on /search + /create. -->
    @if (showHeader()) { <app-header /> }
    <app-bg-orbs />
    <!-- Easter eggs (Konami code / holiday hero variants / style-remix) are pure
         delight — 538 lines with no critical path. Defer off the initial bundle
         and attach during browser idle (well before any user could trigger a
         Konami sequence). Trims the eager weight without risking any gated UX. -->
    @defer (on idle) {
      <app-easter-eggs />
    }
    <app-toast />
    <!-- A2HS install prompt (#25) — pure enhancement, no critical path.
         Deferred off the initial bundle; only renders when genuinely
         installable and not previously dismissed. -->
    @defer (on idle) {
      <app-install-prompt />
    }
    @if (showCommandPalette() && !inAdmin()) {
      <app-command-palette
        (closed)="showCommandPalette.set(false)"
        (showShortcuts)="onPaletteShowShortcuts()"
      />
    }
    @if (showShortcuts()) {
      <app-shortcuts-overlay (closed)="showShortcuts.set(false)" />
    }
    <!-- tabindex="-1" lets the skip-link MOVE focus here (a <main> isn't natively
         focusable) so the next Tab resumes inside the content, not from the top
         — completes WCAG 2.4.1 Bypass Blocks. -->
    <main id="main-content" role="main" tabindex="-1" class="app" [class.no-pad]="!showHeader()">
      @if (routeLoading()) {
        <!-- Instant loading affordance while a lazy route chunk downloads (AL-697) — a cold
             deep-link to /create (funnel destination) / editor / admin no longer shows a
             ~3.3s dead-blank. Removed the instant the route hydrates (no CLS on the real page). -->
        <div class="route-skeleton" role="status" aria-live="polite" aria-busy="true"
             data-testid="route-loading">
          <span class="route-skeleton__spinner" aria-hidden="true"></span>
          <span class="route-skeleton__label">Loading…</span>
          <div class="route-skeleton__bars" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
        </div>
      }
      <router-outlet />
    </main>
    <!-- TOP-LEVEL editor loading veil — rendered at the app ROOT with MAXIMUM z-index so
         nothing (the admin shell, tab strip, or the bolt.diy iframe) can EVER overlap it.
         Shows only on the editor route; opacity-toggled to fade out the instant the bolt
         editor reports loaded via postMessage (bolt.editorReady). pointer-events:none —
         purely visual, never blocks the cursor. Sized (veilRect) to the editor content area. -->
    @if (isEditorRoute()) {
      <div
        class="app-editor-veil"
        [class.app-editor-veil--gone]="bolt.editorReady()"
        [style.top.px]="veilRect()?.top"
        [style.left.px]="veilRect()?.left"
        [style.width.px]="veilRect()?.width"
        [style.height.px]="veilRect()?.height"
        role="status"
        aria-live="polite"
        [attr.aria-busy]="!bolt.editorReady()"
      >
        <div class="app-editor-veil__aurora" aria-hidden="true"></div>
        <div class="app-editor-veil__card">
          <div class="app-editor-veil__mark" aria-hidden="true">
            <span class="app-editor-veil__ring"></span>
            <span class="app-editor-veil__core"></span>
            <svg class="app-editor-veil__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2 4.5 13.2a.6.6 0 0 0 .48.96H11l-1 7.84 8.5-11.2a.6.6 0 0 0-.48-.96H12l1-7.84Z"/>
            </svg>
          </div>
          <div class="app-editor-veil__headline">Booting your AI editor</div>
          <div class="app-editor-veil__sub">{{ bolt.loadingStage() }}<span class="app-editor-veil__dots"><i></i><i></i><i></i></span></div>
          <div class="app-editor-veil__footnote">First visit only — subsequent opens are instant.</div>
        </div>
      </div>
    }
  `,
  styles: [`
    .app {
      min-height: 100vh;
      padding-top: 64px;
      position: relative;
    }
    .app.no-pad {
      padding-top: 0;
    }
    /* Route-loading skeleton (AL-697) — a loading veil while a lazy chunk downloads.
       It MUST be an ABSOLUTE OVERLAY (inset:0 inside the position:relative .app), NOT an
       in-flow block: the skeleton arms on EVERY lazy RouteConfigLoadStart — including admin
       section↔section swaps and the admin→default-section redirect, which fire AFTER the page
       has already painted. As an in-flow element its 520px min-height inserted ABOVE the live
       router-outlet and shoved the mounted page down 520px → a catastrophic ~0.44 CLS on every
       admin route (AL-722). As an overlay it occupies zero layout space, so it can never push
       content on cold OR warm navigations. Brand veil; reduced-motion disables the animations. */
    .route-skeleton {
      position: absolute;
      inset: 0;
      z-index: 5; /* above the outlet it veils; below header(10000)/toast(9999)/takeover(100000) */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      padding: 2rem;
      color: #00e5ff;
      background: color-mix(in srgb, var(--ps-bg, #060610) 88%, transparent);
      backdrop-filter: blur(2px);
    }
    .route-skeleton__spinner {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 3px solid rgba(0, 229, 255, 0.18);
      border-top-color: #00e5ff;
      animation: route-skeleton-spin 0.8s linear infinite;
    }
    .route-skeleton__label {
      font-size: 0.85rem;
      letter-spacing: 0.02em;
      color: rgba(244, 244, 255, 0.7);
    }
    .route-skeleton__bars {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      width: min(440px, 82vw);
      margin-top: 0.5rem;
    }
    .route-skeleton__bars span {
      height: 14px;
      border-radius: 7px;
      background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(0,229,255,0.10), rgba(255,255,255,0.04));
      background-size: 200% 100%;
      animation: route-skeleton-shimmer 1.4s ease-in-out infinite;
    }
    .route-skeleton__bars span:nth-child(2) { width: 88%; }
    .route-skeleton__bars span:nth-child(3) { width: 64%; }
    @keyframes route-skeleton-spin { to { transform: rotate(360deg); } }
    @keyframes route-skeleton-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .route-skeleton__spinner { animation-duration: 1.6s; }
      .route-skeleton__bars span { animation: none; }
    }
    /* The skip-link target receives focus programmatically (never via Tab — it's
       tabindex=-1), so the region outline would just be visual noise. */
    #main-content:focus { outline: none; }

    /* ── Top-level editor loading veil (Brian 2026-09-27) ──────────────────────────
       At the app ROOT with MAX z-index + position:fixed so nothing overlaps it;
       pointer-events:none (purely visual). Fades out when the bolt editor postMessages
       loaded (bolt.editorReady → .app-editor-veil--gone). Keeps the status messages. */
    .app-editor-veil {
      position: fixed;
      /* Sized in JS (veilRect) to the editor CONTENT AREA — below the top navbar, right of
         the side nav (it mirrors the bolt iframe's slot). These full-viewport values are the
         FALLBACK used only until the iframe slot is measurable (safe: covers everything). */
      top: 0;
      left: 0;
      width: 100vw;
      height: 100dvh;
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      background: #060610;
      pointer-events: none;
      opacity: 1;
      will-change: opacity;
      transition: opacity 520ms cubic-bezier(0.7, 0, 0.84, 0);
    }
    .app-editor-veil--gone { opacity: 0; }
    .app-editor-veil__aurora {
      position: absolute; inset: -25%;
      background:
        radial-gradient(38% 34% at 22% 28%, rgba(0,229,255,0.18), transparent 60%),
        radial-gradient(34% 30% at 78% 30%, rgba(124,58,237,0.20), transparent 62%),
        radial-gradient(46% 40% at 50% 88%, rgba(0,229,255,0.10), transparent 66%);
      filter: blur(26px) saturate(1.15);
      animation: appVeilDrift 14s cubic-bezier(0.4,0,0.2,1) infinite;
    }
    .app-editor-veil__card {
      position: relative; display: flex; flex-direction: column; align-items: center; gap: 0.7rem;
      padding: 2.1rem 2.6rem 1.8rem; border-radius: 24px;
      background: linear-gradient(180deg, rgba(14,14,40,0.62), rgba(6,6,16,0.62));
      border: 1px solid rgba(0,229,255,0.12);
      box-shadow: 0 30px 80px -32px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05);
      backdrop-filter: blur(14px) saturate(1.1); -webkit-backdrop-filter: blur(14px) saturate(1.1);
      text-align: center;
    }
    .app-editor-veil__mark { position: relative; width: 76px; height: 76px; margin-bottom: 0.2rem; }
    .app-editor-veil__ring {
      position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 0deg, rgba(0,229,255,0.95) 130deg, rgba(124,58,237,0.95) 250deg, transparent 360deg);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
      animation: appVeilSpin 2.4s linear infinite;
    }
    .app-editor-veil__core {
      position: absolute; inset: 13px; border-radius: 50%;
      background: radial-gradient(circle at 34% 28%, rgba(0,229,255,0.34), rgba(124,58,237,0.16) 68%, transparent 82%);
      animation: appVeilBreathe 3s cubic-bezier(0.4,0,0.2,1) infinite;
    }
    .app-editor-veil__glyph {
      position: absolute; inset: 0; margin: auto; width: 30px; height: 30px; color: #00E5FF;
      filter: drop-shadow(0 0 9px rgba(0,229,255,0.55));
      animation: appVeilBreathe 3s cubic-bezier(0.4,0,0.2,1) infinite;
    }
    .app-editor-veil__headline { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; font-size: 1.08rem; color: #f4f4ff; letter-spacing: -0.02em; }
    .app-editor-veil__sub { display: inline-flex; align-items: baseline; font-size: 0.78rem; color: rgba(244,244,255,0.66); font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .app-editor-veil__dots { display: inline-flex; margin-left: 1px; }
    .app-editor-veil__dots i { width: 3px; height: 3px; margin-left: 2px; border-radius: 50%; background: rgba(0,229,255,0.85); align-self: center; animation: appVeilDot 1.2s cubic-bezier(0.4,0,0.2,1) infinite; }
    .app-editor-veil__dots i:nth-child(2) { animation-delay: 0.16s; }
    .app-editor-veil__dots i:nth-child(3) { animation-delay: 0.32s; }
    .app-editor-veil__footnote { font-size: 0.7rem; color: rgba(244,244,255,0.4); margin-top: 0.5rem; }
    @keyframes appVeilSpin { to { transform: rotate(360deg); } }
    @keyframes appVeilBreathe { 0%,100% { transform: scale(0.94); opacity: 0.85; } 50% { transform: scale(1.06); opacity: 1; } }
    @keyframes appVeilDrift { 0%,100% { transform: translate3d(0,0,0) scale(1); } 33% { transform: translate3d(3%,-2%,0) scale(1.06); } 66% { transform: translate3d(-3%,2%,0) scale(1.03); } }
    @keyframes appVeilDot { 0%,100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
    @media (prefers-reduced-motion: reduce) {
      .app-editor-veil, .app-editor-veil__aurora, .app-editor-veil__core, .app-editor-veil__glyph, .app-editor-veil__dots i { animation: none; }
      .app-editor-veil__ring { animation-duration: 4s; }
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private meta = inject(MetaService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private translate = inject(TranslateService);
  private appShell = inject(AppShellService);
  private telemetry = inject(TelemetryService);
  /**
   * Root singleton (providedIn:'root'). Its `editorReady` signal is flipped by the bolt.diy
   * editor's postMessage (PS_APP_RUNNING / PS_BOLT_FILES_LOADED, via BoltEmbedService's window
   * listener) and `loadingStage` carries the status text. The TOP-LEVEL editor veil below reads
   * both — it lives at the app root with maximum z-index so nothing (iframe, shell, toast) can
   * ever overlap it, and fades out the instant the editor reports loaded.
   */
  bolt = inject(BoltEmbedService);

  showHeader = signal(true);
  showCommandPalette = signal(false);
  showShortcuts = signal(false);
  inAdmin = signal(false);
  /** True on `/admin/editor*` — gates the top-level editor loading veil (rendered at the app
   * root, max z-index) so it shows only while the editor is the active surface. */
  isEditorRoute = signal(false);
  /**
   * The measured rect of the editor CONTENT AREA — the bolt iframe's slot, i.e. everywhere
   * BELOW the top navbar and RIGHT OF the side nav. The top-level veil is sized to this so it
   * covers only the editor surface, never the chrome. `null` → the veil falls back to
   * full-viewport (safe). Kept as viewport px because the veil is `position: fixed`.
   */
  protected veilRect = signal<{ top: number; left: number; width: number; height: number } | null>(null);
  private veilResizeObs?: ResizeObserver;
  /**
   * While on the editor route, keep the veil sized to the bolt iframe's slot. Re-measures on
   * show, on window resize, and whenever the iframe reflows (the sidebar collapse/expand +
   * full-width toggle resize the content column → the iframe → this observer). The iframe's
   * `getBoundingClientRect()` already yields {top: topbar-height, left: sidebar-width, …}, so
   * matching it excludes the top navbar + side nav exactly. Cleans up its listeners on re-run.
   */
  private readonly _veilRectSync = effect((onCleanup) => {
    const on = this.isEditorRoute();
    this.veilResizeObs?.disconnect();
    this.veilResizeObs = undefined;
    if (!on || typeof document === 'undefined') {
      this.veilRect.set(null);
      return;
    }
    const measure = (): void => {
      const frame = document.querySelector('.bolt-frame') as HTMLElement | null;
      const r = frame?.getBoundingClientRect();
      if (r && r.width > 8 && r.height > 8 && r.top < window.innerHeight) {
        this.veilRect.set({
          top: Math.max(0, Math.round(r.top)),
          left: Math.max(0, Math.round(r.left)),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      } else {
        this.veilRect.set(null); // iframe not laid out yet → full-viewport fallback
      }
    };
    measure();
    requestAnimationFrame(measure);
    const settleTimer = setTimeout(measure, 150);
    window.addEventListener('resize', measure);
    const frame = document.querySelector('.bolt-frame');
    if (frame && typeof ResizeObserver !== 'undefined') {
      this.veilResizeObs = new ResizeObserver(measure);
      this.veilResizeObs.observe(frame);
    }
    onCleanup(() => {
      clearTimeout(settleTimer);
      window.removeEventListener('resize', measure);
      this.veilResizeObs?.disconnect();
      this.veilResizeObs = undefined;
    });
  });
  /** True while a LAZY route chunk is downloading (a cold deep-link to a heavy route like
   * `/create` takes ~3s to hydrate) — drives an instant loading skeleton so the funnel
   * destination never shows a dead-blank. NEVER set for the homepage (`/`) so its delicate
   * static-hero LCP optimization is untouched (AL-697). */
  routeLoading = signal(false);
  /** The URL of the in-flight navigation, captured on NavigationStart — lets `routeLoading`
   * exclude the homepage before the (homepage-lazy) RouteConfigLoadStart would otherwise fire. */
  private pendingNavUrl = '';
  /** Timer that arms the lazy-route skeleton ONLY if the chunk load outlasts the delay.
   * After `PreloadAllModules` most navigations resolve in a few ms, so arming the skeleton
   * instantly made it FLASH in-and-out between page changes. A short delay lets a fast/cached
   * nav settle first (clearing the timer) → no skeleton, no flash; only a genuinely slow cold
   * load (~3s `/create`/editor chunk) ever shows it. Cleared on every nav settle. */
  private routeLoadingTimer?: ReturnType<typeof setTimeout>;
  private readonly ROUTE_SKELETON_DELAY_MS = 160;

  private cursorFollowerEl?: HTMLElement;
  private cursorAnimationId?: number;
  private cursorListeners: { type: string; handler: EventListener }[] = [];

  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    // Cmd+K / Ctrl+K — toggle command palette EXCEPT inside /admin,
    // which mounts its own richer palette. Two palettes opening at once was
    // a real bug (#4 in the Part 1 brief).
    if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
      if (this.router.url.startsWith('/admin')) return; // let admin's palette handle it
      event.preventDefault();
      this.showCommandPalette.update(v => !v);
      this.showShortcuts.set(false);
      return;
    }
    // '?' — show shortcuts overlay (only when not typing in an input/textarea).
    // Same /admin skip as Cmd+K above: the admin shell mounts its own overlay
    // and BOTH opening stacked was a real bug (caught by ADV-OL-05/06 —
    // pressing ? inside /admin rendered two identical modals).
    if (event.key === '?' && !this.isInputFocused()) {
      if (this.router.url.startsWith('/admin')) return; // admin shell owns ? there
      this.showShortcuts.update(v => !v);
      this.showCommandPalette.set(false);
      return;
    }
    // '/' — focus the first visible search input (only when not typing)
    if (event.key === '/' && !this.isInputFocused()) {
      event.preventDefault();
      const search = document.querySelector<HTMLInputElement>('input[type="text"][placeholder*="earch"]');
      if (search) search.focus();
    }
  }

  /** Show shortcuts from the command palette action */
  onPaletteShowShortcuts(): void {
    this.showCommandPalette.set(false);
    this.showShortcuts.set(true);
  }

  private isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
  }

  ngOnInit(): void {
    this.meta.init();
    this.telemetry.init();
    this.applyStoredTheme();
    this.cleanupLegacyOnboardingKeys();
    this.handleAuthCallback();
    this.restoreSession();
    this.trackRoute();
    this.wireTelemetryPageViews();
    this.wireRouteLoading();
    this.initCursorFollower();
    this.wireLanguage();
  }

  /**
   * Fire a `$pageview` (PostHog) + `page_view` (GA4) + Sentry breadcrumb on
   * every successful navigation. SPA pageviews are NOT captured by the GA4
   * gtag.js auto-send because the URL only changes via History API — we
   * surface them explicitly so funnel reports stay accurate.
   */
  private wireTelemetryPageViews(): void {
    // Initial pageview (Router.events doesn't fire for the first paint).
    this.telemetry.pageView(this.router.url, document.title);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.telemetry.pageView(e.urlAfterRedirects, document.title);
      });
  }

  /**
   * Show an instant loading skeleton while a LAZY route chunk downloads (AL-697). A cold
   * deep-link to a heavy route — `/create` (the acquisition funnel's destination), `/admin`,
   * an editor route — takes ~3s to download+hydrate its chunk, during which the router-outlet
   * is EMPTY: a prospect faced a ~3.3s dead-blank. `RouteConfigLoadStart` fires exactly when a
   * lazy chunk begins loading; we surface a branded skeleton until the navigation settles.
   *
   * The homepage (`/`) is EXCLUDED: it renders its own static-hero markup from `index.html`'s
   * `<app-root>` (a deliberate FCP/LCP optimization) — a skeleton over it would flash + break the
   * no-CLS hydration swap. We capture the in-flight URL on `NavigationStart` and only arm the
   * skeleton when it is NOT the homepage. Root component (never destroyed) → no unsubscribe needed.
   *
   * CRITICAL (AL-722): arm ONLY during an ACTIVE navigation. `app.config` enables
   * `withPreloading(PreloadAllModules)`, so after the first navigation the router downloads EVERY
   * remaining lazy chunk in the background — each emitting `RouteConfigLoadStart` with NO active
   * navigation and NO following `NavigationEnd`. Arming on those latched `routeLoading` ON forever:
   * the skeleton stuck on every admin route → a ~0.44 CLS (in-flow block shoving the page down
   * 520px) AND `[aria-busy=true]` never clearing (a lying-loading veil). `router.getCurrentNavigation()`
   * is non-null during any real nav (including the initial cold load — robust against the subscription
   * racing the initial `NavigationStart`) and null during background preloads, so it's the correct gate.
   */
  private wireRouteLoading(): void {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.pendingNavUrl = e.url;
      } else if (e instanceof RouteConfigLoadStart) {
        // Ignore preload-triggered chunk loads — only a real in-flight navigation arms the skeleton.
        if (!this.router.getCurrentNavigation()) return;
        // A lazy chunk is loading. Arm the skeleton unless this navigation targets the homepage.
        // On a COLD DIRECT load the NavigationStart may precede our subscription, so fall back to
        // the real browser path (`/create` immediately) — NOT router.url (still `/` until nav settles).
        const url = this.pendingNavUrl || (typeof location !== 'undefined' ? location.pathname : '');
        if (url && url !== '/' && !url.startsWith('/?') && !url.startsWith('/#')) {
          // DELAY arming: a fast/cached nav (the common case post-PreloadAllModules) settles
          // before the timer fires, so the skeleton never flashes between page changes. Only a
          // slow cold chunk (>160ms) surfaces it. The timer is cleared on nav settle below.
          if (this.routeLoadingTimer) clearTimeout(this.routeLoadingTimer);
          this.routeLoadingTimer = setTimeout(() => this.routeLoading.set(true), this.ROUTE_SKELETON_DELAY_MS);
        }
      } else if (
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError
      ) {
        if (this.routeLoadingTimer) {
          clearTimeout(this.routeLoadingTimer);
          this.routeLoadingTimer = undefined;
        }
        this.routeLoading.set(false);
      }
    });
  }

  /**
   * Keep `<html lang>` in sync with `TranslateService.currentLang` for WCAG
   * 3.1.1 Language of Page. Stamps the initial value and re-applies on every
   * change. Falls back to `'en'` when the translate service has not yet
   * resolved a language.
   */
  private wireLanguage(): void {
    const initial = (this.translate.currentLang as AppLanguage | undefined) ?? 'en';
    this.appShell.applyLanguage(initial === 'es' ? 'es' : 'en');
    this.translate.onLangChange.subscribe((evt: { lang: string }) => {
      const next: AppLanguage = evt.lang === 'es' ? 'es' : 'en';
      this.appShell.applyLanguage(next);
    });
  }

  /** Reads the persisted theme (dark|light|system), density (compact|comfortable|spacious),
   * and high-contrast flag from localStorage and stamps the matching `data-*`
   * attributes on `<html>` at app boot. Without this, /admin/user → Appearance
   * settings would only apply after the user clicks a swatch — refresh or first
   * load would always be dark + comfortable + normal-contrast. */
  private applyStoredTheme(): void {
    const html = document.documentElement;
    try {
      const t = (localStorage.getItem('ps_theme') as 'dark' | 'light' | 'system') || 'dark';
      html.setAttribute('data-theme', t);
    } catch {
      html.setAttribute('data-theme', 'dark');
    }
    try {
      const d = (localStorage.getItem('ps_density') as 'compact' | 'comfortable' | 'spacious') || 'comfortable';
      html.setAttribute('data-density', d);
    } catch { html.setAttribute('data-density', 'comfortable'); }
    try {
      html.setAttribute('data-contrast', localStorage.getItem('ps_contrast') === 'high' ? 'high' : 'normal');
    } catch { html.setAttribute('data-contrast', 'normal'); }
  }

  private cleanupLegacyOnboardingKeys(): void {
    try {
      localStorage.removeItem('ps_onboarding');
      localStorage.removeItem('ps_onboarding_seen');
    } catch {
      // ignore — private mode / quota
    }
  }

  private isHeaderlessRoute(url: string): boolean {
    const path = url.split('?')[0];
    // Homepage has its own nav; admin/billing/editor have their own chrome
    if (path === '/' || path === '') return true;
    return ['/admin', '/billing', '/editor'].some(r => path.startsWith(r));
  }

  private trackRoute(): void {
    // Set initial value
    this.showHeader.set(!this.isHeaderlessRoute(this.router.url));
    this.inAdmin.set(this.router.url.startsWith('/admin'));
    this.isEditorRoute.set(this.router.url.split('?')[0].startsWith('/admin/editor'));
    // Listen for route changes
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(e => {
        this.showHeader.set(!this.isHeaderlessRoute(e.urlAfterRedirects));
        this.inAdmin.set(e.urlAfterRedirects.startsWith('/admin'));
        this.isEditorRoute.set(e.urlAfterRedirects.split('?')[0].startsWith('/admin/editor'));
        // Closing the global palette when entering /admin prevents the
        // double-palette regression even if a user toggled it elsewhere.
        if (e.urlAfterRedirects.startsWith('/admin')) this.showCommandPalette.set(false);
      });
  }

  ngOnDestroy(): void {
    // Clean up cursor follower
    for (const { type, handler } of this.cursorListeners) {
      if (type === 'message-cursor') {
        window.removeEventListener('message', handler);
      } else {
        document.removeEventListener(type, handler);
      }
    }
    this.cursorListeners = [];
    if (this.cursorAnimationId != null) {
      cancelAnimationFrame(this.cursorAnimationId);
    }
    this.cursorFollowerEl?.remove();
  }

  private addDocListener(type: string, handler: EventListener): void {
    document.addEventListener(type, handler);
    this.cursorListeners.push({ type, handler });
  }

  private initCursorFollower(): void {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Honor the per-user opt-out from /admin/user → Appearance → Cursor follower.
    try { if (localStorage.getItem('ps_cursor') === 'off') return; } catch { /* */ }

    const follower = document.createElement('div');
    follower.className = 'cursor-follower';
    document.body.appendChild(follower);
    this.cursorFollowerEl = follower;

    let mouseX = 0;
    let mouseY = 0;
    let followerX = 0;
    let followerY = 0;

    this.addDocListener('mousemove', (e) => {
      const me = e as MouseEvent;
      mouseX = me.clientX;
      mouseY = me.clientY;
      if (!follower.classList.contains('visible')) {
        follower.classList.add('visible');
      }
    });

    this.addDocListener('mouseleave', () => {
      follower.classList.remove('visible');
    });

    // Cross-iframe cursor sync — the bolt.diy editor at
    // editor.projectsites.dev postMessages its cursor coords on every
    // mousemove (offset by the iframe's bounding rect, computed by the
    // parent on receipt). This keeps the follower glued to the user even
    // while they're inside the embedded IDE — the iframe normally swallows
    // mouseevents from the parent. Type discriminator: PS_CURSOR.
    const iframeMessageHandler = (ev: MessageEvent) => {
      if (ev.origin !== 'https://editor.projectsites.dev' &&
          ev.origin !== 'http://localhost:5173') return;
      const data = ev.data as { type?: string; x?: number; y?: number; hover?: boolean };
      if (!data || data.type !== 'PS_CURSOR') return;
      // The iframe sends viewport-relative coords (its own viewport). We
      // translate by the iframe's offset in our viewport.
      const iframe = document.querySelector('.bolt-frame') as HTMLIFrameElement | null;
      if (!iframe) return;
      const rect = iframe.getBoundingClientRect();
      mouseX = rect.left + (data.x ?? 0);
      mouseY = rect.top + (data.y ?? 0);
      if (!follower.classList.contains('visible')) follower.classList.add('visible');
      follower.classList.toggle('hover', !!data.hover);
    };
    window.addEventListener('message', iframeMessageHandler);
    this.cursorListeners.push({ type: 'message-cursor', handler: iframeMessageHandler as EventListener });

    const interactiveSelector = 'a, button, input, textarea, select, [data-tooltip], .search-result, .address-option';
    this.addDocListener('mouseover', (e) => {
      if ((e.target as HTMLElement).closest(interactiveSelector)) {
        follower.classList.add('hover');
      }
    });
    this.addDocListener('mouseout', (e) => {
      if ((e.target as HTMLElement).closest(interactiveSelector)) {
        follower.classList.remove('hover');
      }
    });

    this.addDocListener('click', (e) => {
      const me = e as MouseEvent;
      const ripple = document.createElement('div');
      ripple.className = 'click-ripple';
      ripple.style.left = me.clientX + 'px';
      ripple.style.top = me.clientY + 'px';
      ripple.style.width = '80px';
      ripple.style.height = '80px';
      document.body.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });

    const animate = () => {
      followerX += (mouseX - followerX) * 0.15;
      followerY += (mouseY - followerY) * 0.15;
      follower.style.left = followerX + 'px';
      follower.style.top = followerY + 'px';
      this.cursorAnimationId = requestAnimationFrame(animate);
    };
    this.cursorAnimationId = requestAnimationFrame(animate);
  }

  private handleAuthCallback(): void {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const email = params.get('email');
    // auth_callback is informational (which provider). token+email is sufficient
    // to establish a session — the earlier requirement caused Google/GitHub OAuth
    // logins to silently drop the session because those callbacks shipped
    // token+email without the marker. Magic-link still ships it, so we keep
    // reading it for analytics + URL cleanup but don't gate session creation on it.
    const authCallback = params.get('auth_callback');

    if (token && email) {
      this.auth.setSession(token, email);
      // Clean the sensitive params out of the URL FIRST — the session token must never
      // persist in history / referrer / a subsequent analytics $pageview.
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      url.searchParams.delete('email');
      url.searchParams.delete('auth_callback');
      window.history.replaceState({}, '', url.toString());

      // Destination priority — honor the returnUrl round-trip:
      //  1. The deep app route the server already landed us on (returnUrl honored
      //     server-side — e.g. /admin/billing when the owner clicked "Billing" while
      //     logged out and the 401-guard bounced them to /signin?returnUrl=/admin/billing).
      //     STAY there. Dumping them on the dashboard to re-navigate is exactly the friction
      //     the returnUrl exists to remove (embarrassingly-easy). Safe against the guard: the
      //     router runs non-blocking initial navigation, so setSession() above lands BEFORE the
      //     guard resolves and this navigate cancels+restarts the pending nav with the session set.
      //  2. A pending create flow (business selected pre-signin) → /create.
      //  3. Otherwise the dashboard.
      const landed = url.pathname;
      const isDeepAppRoute =
        landed !== '/' &&
        landed !== '/signin' &&
        (landed.startsWith('/admin') ||
          landed.startsWith('/create') ||
          landed.startsWith('/waiting'));
      const business = this.auth.getSelectedBusiness();
      let destination: string;
      if (isDeepAppRoute) {
        destination = landed + url.search;
        this.router.navigateByUrl(destination);
      } else if (business) {
        destination = '/create';
        this.router.navigate(['/create']);
      } else {
        destination = '/admin';
        this.router.navigate(['/admin']);
      }
      // Telemetry: this is the moment a session lands — fires GA4 `signup`
      // via the conversion-alias inside TelemetryService. `returned_to` lets us see
      // whether the returnUrl round-trip actually deep-links owners or dumps them on /admin.
      this.telemetry.track('auth.signin.succeeded', {
        provider: authCallback ?? 'email',
        had_selected_business: !!business,
        returned_to: destination,
      });
      // Best-effort analytics — never blocks the session.
      if (authCallback) {
        this.api.post('/analytics/track', { event: 'auth.callback', provider: authCallback })
          .subscribe({ error: () => undefined });
      }
    }
  }

  /**
   * Async session validation. Only clears the local session on a definitive
   * 401 (the auth interceptor already handles redirect). Transient errors
   * (network blip, 5xx, timeout) MUST NOT log the user out — that was the
   * "forced re-sign-in on every refresh" bug.
   */
  private restoreSession(): void {
    if (!this.auth.isLoggedIn()) return;
    // `{ silent: true }` — this is a BACKGROUND session-validation that OWNS its outcome:
    // it intentionally no-ops on transient errors (keeps the session) and the interceptor
    // owns the 401 (clear + conditional redirect, which still runs under silent). Without
    // silent, a transient status-0 blip on app-init fired ApiService's alarming "Can't reach
    // the server. Check your connection." toast even though the user stays logged in and the
    // next request Just Works — a false alarm on every /admin load whose /auth/me got a blip
    // (or a CF-challenged headless XHR). See [[cf-bot-challenge-opaque-xhr-misleading-toast]].
    this.api.getMe({ silent: true }).subscribe({
      next: (res) => {
        // Attach identity to PostHog + GA4 so subsequent events are
        // user-scoped. User identity is attached via PostHog identify().
        // — don't double-attach here.
        const user = res?.data;
        if (user?.id) {
          this.telemetry.identify(user.id, {
            email: user.email,
            org_id: user.org_id,
          });
        }
      },
      error: (err: { status?: number }) => {
        // The api.service interceptor already clears + redirects on 401.
        // Anything else (0 = offline, 5xx, timeout) is transient — keep the
        // session so a refresh once connectivity returns Just Works.
        if (err?.status !== 401) {
          // Intentional no-op — leave the local token in place.
        }
      },
    });
  }
}
