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
    @if (showHeader()) { <app-header /> }
    <app-bg-orbs />
    @defer (on idle) {
      <app-easter-eggs />
    }
    <app-toast />
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
    <main id="main-content" role="main" tabindex="-1" class="app" [class.no-pad]="!showHeader()">
      @if (routeLoading()) {
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
    <!-- TOP-LEVEL editor loading veil — app ROOT, MAX z-index so nothing (shell, tab strip,
         iframe) overlaps it. Shows only on the editor route; sized (veilRect) to the content
         pane (below top navbar, right of side nav); fades in on mount, fades out when the bolt
         editor postMessages loaded (bolt.editorReady). pointer-events:none — purely visual. -->
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
    .route-skeleton {
      position: absolute;
      inset: 0;
      z-index: 5;
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
    #main-content:focus { outline: none; }

    /* Top-level editor loading veil — sized (JS veilRect) to the content pane: below the top
       navbar, right of the side nav. Full-viewport is only the pre-measure fallback. */
    .app-editor-veil {
      position: fixed;
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
    /* Fade IN on mount (eases from transparent, not a hard cut). */
    @starting-style {
      .app-editor-veil { opacity: 0; }
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
  bolt = inject(BoltEmbedService);

  showHeader = signal(true);
  showCommandPalette = signal(false);
  showShortcuts = signal(false);
  inAdmin = signal(false);
  /** True on `/admin/editor*` — gates the top-level editor loading veil. */
  isEditorRoute = signal(false);
  /**
   * The editor content-pane rect — everywhere BELOW the top navbar and RIGHT OF the side nav.
   * Measured from the CHROME (.admin-sidebar right edge + .admin-topbar bottom), NOT the iframe:
   * the bolt iframe is left:0/width:100% and merely underlaps the sticky sidebar, so its rect is
   * full-width. `null` → full-viewport fallback. Viewport px (veil is position:fixed).
   */
  protected veilRect = signal<{ top: number; left: number; width: number; height: number } | null>(null);
  /**
   * While on the editor route, keep the veil sized to the content pane. Per-frame poll (the
   * shell/iframe mount + the sidebar reflow happen over several frames), stopping once the editor
   * reports ready (veil fading). Measures the CHROME so the veil excludes the side nav + top navbar.
   */
  private readonly _veilRectSync = effect((onCleanup) => {
    const on = this.isEditorRoute();
    if (!on || typeof document === 'undefined') {
      this.veilRect.set(null);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sr = (document.querySelector('.admin-sidebar') as HTMLElement | null)?.getBoundingClientRect();
      const tr = (document.querySelector('.admin-topbar') as HTMLElement | null)?.getBoundingClientRect();
      // left = side-nav right edge (0 when it's the off-screen mobile drawer or absent);
      // top  = top-navbar bottom edge. Guarded so a huge/negative rect never mis-sizes the veil.
      const left = sr && sr.right > 0 && sr.right < vw * 0.6 ? Math.round(sr.right) : 0;
      const top = tr && tr.bottom > 0 && tr.bottom < vh * 0.6 ? Math.round(tr.bottom) : 0;
      if (sr || tr) {
        const next = { top, left, width: Math.max(0, vw - left), height: Math.max(0, vh - top) };
        const cur = this.veilRect();
        if (!cur || cur.top !== next.top || cur.left !== next.left || cur.width !== next.width || cur.height !== next.height) {
          this.veilRect.set(next);
        }
      }
      if (!this.bolt.editorReady()) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });
  routeLoading = signal(false);
  private pendingNavUrl = '';
  private routeLoadingTimer?: ReturnType<typeof setTimeout>;
  private readonly ROUTE_SKELETON_DELAY_MS = 160;

  private cursorFollowerEl?: HTMLElement;
  private cursorAnimationId?: number;
  private cursorListeners: { type: string; handler: EventListener }[] = [];

  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
      if (this.router.url.startsWith('/admin')) return;
      event.preventDefault();
      this.showCommandPalette.update(v => !v);
      this.showShortcuts.set(false);
      return;
    }
    if (event.key === '?' && !this.isInputFocused()) {
      if (this.router.url.startsWith('/admin')) return;
      this.showShortcuts.update(v => !v);
      this.showCommandPalette.set(false);
      return;
    }
    if (event.key === '/' && !this.isInputFocused()) {
      event.preventDefault();
      const search = document.querySelector<HTMLInputElement>('input[type="text"][placeholder*="earch"]');
      if (search) search.focus();
    }
  }

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

  private wireTelemetryPageViews(): void {
    this.telemetry.pageView(this.router.url, document.title);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.telemetry.pageView(e.urlAfterRedirects, document.title);
      });
  }

  private wireRouteLoading(): void {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.pendingNavUrl = e.url;
      } else if (e instanceof RouteConfigLoadStart) {
        if (!this.router.getCurrentNavigation()) return;
        const url = this.pendingNavUrl || (typeof location !== 'undefined' ? location.pathname : '');
        if (url && url !== '/' && !url.startsWith('/?') && !url.startsWith('/#')) {
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

  private wireLanguage(): void {
    const initial = (this.translate.currentLang as AppLanguage | undefined) ?? 'en';
    this.appShell.applyLanguage(initial === 'es' ? 'es' : 'en');
    this.translate.onLangChange.subscribe((evt: { lang: string }) => {
      const next: AppLanguage = evt.lang === 'es' ? 'es' : 'en';
      this.appShell.applyLanguage(next);
    });
  }

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
      // ignore
    }
  }

  private isHeaderlessRoute(url: string): boolean {
    const path = url.split('?')[0];
    if (path === '/' || path === '') return true;
    return ['/admin', '/billing', '/editor'].some(r => path.startsWith(r));
  }

  private trackRoute(): void {
    this.showHeader.set(!this.isHeaderlessRoute(this.router.url));
    this.inAdmin.set(this.router.url.startsWith('/admin'));
    this.isEditorRoute.set(this.router.url.split('?')[0].startsWith('/admin/editor'));
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(e => {
        this.showHeader.set(!this.isHeaderlessRoute(e.urlAfterRedirects));
        this.inAdmin.set(e.urlAfterRedirects.startsWith('/admin'));
        this.isEditorRoute.set(e.urlAfterRedirects.split('?')[0].startsWith('/admin/editor'));
        if (e.urlAfterRedirects.startsWith('/admin')) this.showCommandPalette.set(false);
      });
  }

  ngOnDestroy(): void {
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

    const iframeMessageHandler = (ev: MessageEvent) => {
      if (ev.origin !== 'https://editor.projectsites.dev' &&
          ev.origin !== 'http://localhost:5173') return;
      const data = ev.data as { type?: string; x?: number; y?: number; hover?: boolean };
      if (!data || data.type !== 'PS_CURSOR') return;
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
    const authCallback = params.get('auth_callback');

    if (token && email) {
      this.auth.setSession(token, email);
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      url.searchParams.delete('email');
      url.searchParams.delete('auth_callback');
      window.history.replaceState({}, '', url.toString());

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
      this.telemetry.track('auth.signin.succeeded', {
        provider: authCallback ?? 'email',
        had_selected_business: !!business,
        returned_to: destination,
      });
      if (authCallback) {
        this.api.post('/analytics/track', { event: 'auth.callback', provider: authCallback })
          .subscribe({ error: () => undefined });
      }
    }
  }

  private restoreSession(): void {
    if (!this.auth.isLoggedIn()) return;
    this.api.getMe({ silent: true }).subscribe({
      next: (res) => {
        const user = res?.data;
        if (user?.id) {
          this.telemetry.identify(user.id, {
            email: user.email,
            org_id: user.org_id,
          });
        }
      },
      error: (err: { status?: number }) => {
        if (err?.status !== 401) {
          // Intentional no-op — leave the local token in place.
        }
      },
    });
  }
}
