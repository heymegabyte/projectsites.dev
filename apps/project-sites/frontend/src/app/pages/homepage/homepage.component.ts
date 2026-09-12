import {
  Component,
  type OnInit,
  type OnDestroy,
  type AfterViewInit,
  inject,
  signal,
  computed,
  ElementRef,
  ViewChild,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  switchMap,
  forkJoin,
  of,
  takeUntil,
} from 'rxjs';
import { ApiService, type BusinessResult } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { createFunnelNav } from './create-funnel-nav';
import { GeolocationService } from '../../services/geolocation.service';
import { TelemetryService } from '../../services/telemetry.service';
import { MetaService } from '../../services/meta.service';
import { graph, faqPage } from '../../lib/json-ld';
import { RippleDirective } from '../../animations/ripple.directive';
import { RevealDirective } from '../../directives/reveal.directive';
import { RollingCounterComponent } from '../../components/rolling-counter/rolling-counter.component';
import { BeforeAfterSliderComponent } from '../../components/before-after-slider/before-after-slider.component';
import { TrustStripComponent } from '../../components/trust-strip/trust-strip.component';
import { UserMenuComponent } from '../../components/user-menu/user-menu.component';

interface SearchItem {
  type: 'business' | 'prebuilt' | 'custom';
  name: string;
  address: string;
  place_id?: string;
  distance?: string;
  distanceMiles?: number;
  lat?: number;
  lng?: number;
  phone?: string;
  website?: string;
  types?: string[];
  siteId?: string;
  slug?: string;
  status?: string;
}

/**
 * Homepage marketing page for ProjectSites.dev.
 *
 * @remarks
 * Full-viewport dark-themed landing page with hero, social proof, how-it-works,
 * features grid, pricing, FAQ accordion, and footer. All user-facing text uses
 * the ngx-translate pipe for i18n support (EN/ES).
 *
 * @example
 * ```html
 * <app-homepage />
 * ```
 */
@Component({
  selector: 'app-homepage',
  standalone: true,
  imports: [
    FormsModule,
    TranslateModule,
    RouterLink,
    RippleDirective,
    RevealDirective,
    RollingCounterComponent,
    BeforeAfterSliderComponent,
    TrustStripComponent,
    UserMenuComponent,
  ],
  templateUrl: './homepage.component.html',
  styleUrl: './homepage.component.scss',
})
export class HomepageComponent implements OnInit, OnDestroy, AfterViewInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private geo = inject(GeolocationService);
  private router = inject(Router);
  private translate = inject(TranslateService);
  private platformId = inject(PLATFORM_ID);
  private telemetry = inject(TelemetryService);
  private meta = inject(MetaService);

  /** Logged-in state for the nav — switches the homepage menu from
   *  "Sign In / Get Started" (guest) to the account indicator + Dashboard CTA. */
  readonly isAuthed = this.auth.isLoggedIn;

  /** Active account email — shown in the mobile "signed in as" row. */
  userEmail(): string {
    return this.auth.email();
  }

  /**
   * Hero A/B/C variant (Bundle C finish, 2026-05-24).
   * Resolved from PostHog flag `homepage_hero_v2` with deterministic seed-
   * based fallback so SSR + first paint render the same variant the user
   * will see post-hydration. `?debug=ab` query param forces a variant for
   * dev tooling.
   */
  heroVariant = signal<'A' | 'B' | 'C'>('A');

  @ViewChild('heroSearch') heroSearchInput!: ElementRef<HTMLInputElement>;
  @ViewChild('ctaSearch') ctaSearchInput!: ElementRef<HTMLInputElement>;

  heroQuery = '';
  ctaQuery = '';
  results = signal<SearchItem[]>([]);
  loading = signal(false);
  // Business-lookup (Google Places) proxy returned a provider `_error` → surface an
  // honest "temporarily unavailable" nudge instead of a silent empty dropdown, so a
  // degraded lookup never reads as "your business isn't findable" (mirrors search.component).
  searchUnavailable = signal(false);
  heroDropdownOpen = signal(false);
  ctaDropdownOpen = signal(false);
  currentLang = signal('en');
  navScrolled = signal(false);
  mobileMenuOpen = signal(false);
  openFaqIndex = signal<number | null>(null);

  /**
   * WCAG 4.1.3 (Status Messages, AA). The business-search is a live-search whose
   * matches populate a dropdown as the user types. The degraded/unavailable state is
   * already announced (the aria-live nudge), but the SUCCESS path was silent — a
   * screen-reader user got no feedback that N businesses appeared. This drives an
   * always-present role="status" region that announces the result count for whichever
   * search (hero or CTA) is open; empty string while closed so it never over-announces.
   */
  searchStatusMessage = computed(() => {
    if (!this.heroDropdownOpen() && !this.ctaDropdownOpen()) return '';
    const n = this.results().length;
    if (n === 0) return '';
    return `${n} ${n === 1 ? 'result' : 'results'} found. Use Tab to review, Enter to select.`;
  });

  private searchSubject = new Subject<{ query: string; source: 'hero' | 'cta' }>();
  activeSource = signal<'hero' | 'cta'>('hero');
  private destroy$ = new Subject<void>();
  private observer: IntersectionObserver | null = null;

  ngOnInit(): void {
    this.currentLang.set(this.translate.currentLang || this.translate.defaultLang || 'en');
    this.resolveHeroVariant();
    this.injectFaqJsonLd();

    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged((a, b) => a.query === b.query),
        switchMap(({ query, source }) => {
          this.activeSource.set(source);
          if (query.length < 2) {
            this.results.set([]);
            this.searchUnavailable.set(false);
            this.heroDropdownOpen.set(false);
            this.ctaDropdownOpen.set(false);
            return of(null);
          }
          this.loading.set(true);
          const lat = this.geo.lat() ?? undefined;
          const lng = this.geo.lng() ?? undefined;
          return forkJoin({
            businesses: this.api.searchBusinesses(query, lat, lng, { silent: true }),
            sites: this.api.searchSites(query),
          });
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (res) => {
        this.loading.set(false);
        if (!res) return;

        // A provider `_error` on the businesses proxy means the Google lookup is down —
        // show the honest nudge (search.component parity) rather than a blank dropdown.
        this.searchUnavailable.set(res.businesses._error != null);

        const items: SearchItem[] = [];
        const seen = new Set<string>();

        const placeMap = new Map<string, BusinessResult>();
        for (const b of res.businesses.data || []) {
          if (b.place_id) placeMap.set(b.place_id, b);
        }

        for (const s of res.sites.data || []) {
          const key = s.place_id || s.business_name;
          if (!seen.has(key)) {
            seen.add(key);
            const placeData = s.place_id ? placeMap.get(s.place_id) : undefined;
            const item: SearchItem = {
              type: 'prebuilt',
              name: s.business_name,
              address: s.business_address,
              place_id: s.place_id,
              siteId: s.id,
              slug: s.slug,
              status: s.status,
              lat: placeData?.lat,
              lng: placeData?.lng,
              phone: placeData?.phone,
              website: placeData?.website,
              types: placeData?.types,
            };
            if (this.geo.hasLocation() && placeData?.lat && placeData?.lng) {
              const miles = this.geo.distanceMiles(this.geo.lat()!, this.geo.lng()!, placeData.lat, placeData.lng);
              item.distanceMiles = miles;
              item.distance = this.geo.formatDistance(miles);
            }
            items.push(item);
          }
        }

        for (const b of res.businesses.data || []) {
          const key = b.place_id || b.name;
          if (!seen.has(key)) {
            seen.add(key);
            const item: SearchItem = {
              type: 'business',
              name: b.name,
              address: b.address,
              place_id: b.place_id,
              lat: b.lat,
              lng: b.lng,
              phone: b.phone,
              website: b.website,
              types: b.types,
            };
            if (this.geo.hasLocation() && b.lat && b.lng) {
              const miles = this.geo.distanceMiles(this.geo.lat()!, this.geo.lng()!, b.lat, b.lng);
              item.distanceMiles = miles;
              item.distance = this.geo.formatDistance(miles);
            }
            items.push(item);
          }
        }

        items.sort((a, b) => {
          if (a.type === 'prebuilt' && b.type !== 'prebuilt') return -1;
          if (b.type === 'prebuilt' && a.type !== 'prebuilt') return 1;
          return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity);
        });

        items.push({
          type: 'custom',
          name: 'Build a custom website',
          address: 'Enter your business details manually',
        });

        this.results.set(items);
        if (this.activeSource() === 'hero') {
          this.heroDropdownOpen.set(true);
          this.ctaDropdownOpen.set(false);
        } else {
          this.ctaDropdownOpen.set(true);
          this.heroDropdownOpen.set(false);
        }
        },
        error: () => { this.loading.set(false); this.searchUnavailable.set(true); },
      });

    if (isPlatformBrowser(this.platformId)) {
      window.addEventListener('scroll', this.onScroll);
    }
  }

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.initScrollReveal();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (isPlatformBrowser(this.platformId)) {
      window.removeEventListener('scroll', this.onScroll);
    }
    this.observer?.disconnect();
  }

  private onScroll = (): void => {
    this.navScrolled.set(window.scrollY > 40);
  };

  private initScrollReveal(): void {
    const els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).classList.add('revealed');
            this.observer?.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    els.forEach((el) => this.observer?.observe(el));
  }

  onHeroSearch(): void {
    this.searchSubject.next({ query: this.heroQuery, source: 'hero' });
  }

  onCtaSearch(): void {
    this.searchSubject.next({ query: this.ctaQuery, source: 'cta' });
  }

  selectItem(item: SearchItem): void {
    this.heroDropdownOpen.set(false);
    this.ctaDropdownOpen.set(false);

    if (item.type === 'custom') {
      this.auth.setMode('custom');
      this.auth.clearSelectedBusiness();
      // The user already typed a business name in the active search box — carry it
      // forward so /create doesn't ask for it again (redundant-entry, WCAG 3.3.7).
      const typed = (this.activeSource() === 'cta' ? this.ctaQuery : this.heroQuery).trim();
      this.navigateToDetailsOrSignin(typed || undefined);
      return;
    }

    this.auth.setMode('business');
    localStorage.removeItem('ps_create_draft');
    this.auth.setSelectedBusiness({
      name: item.name,
      address: item.address,
      place_id: item.place_id,
      phone: item.phone,
      website: item.website,
      types: item.types,
      lat: item.lat,
      lng: item.lng,
    });

    this.navigateToDetailsOrSignin();
  }

  private navigateToDetailsOrSignin(name?: string): void {
    // Redundant-entry (WCAG 3.3.7): carry the typed business name forward — into
    // /create?name= when signed in, and THROUGH sign-in via a sanitized returnUrl when
    // signed out (post-auth they land on /create and the prefill fires; signin sanitizes
    // returnUrl to internal paths). The decision is a pure, unit-tested helper
    // (create-funnel-nav.ts). Selected real businesses ride setSelectedBusiness.
    const nav = createFunnelNav(name, this.auth.isLoggedIn());
    this.router.navigate([nav.path], nav.queryParams ? { queryParams: nav.queryParams } : {});
  }

  closeHeroDropdown(): void {
    setTimeout(() => this.heroDropdownOpen.set(false), 200);
  }

  closeCtaDropdown(): void {
    setTimeout(() => this.ctaDropdownOpen.set(false), 200);
  }

  toggleFaq(index: number): void {
    this.openFaqIndex.set(this.openFaqIndex() === index ? null : index);
  }

  toggleLang(): void {
    const next = this.currentLang() === 'en' ? 'es' : 'en';
    this.translate.use(next);
    this.currentLang.set(next);
    localStorage.setItem('ps_language', next);
    // Update document lang attribute for accessibility + SEO
    document.documentElement.lang = next;
  }

  /** Respects `prefers-reduced-motion: reduce` per WCAG 2.2 / always.md mandate. */
  private prefersReducedMotion(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  scrollTo(id: string): void {
    this.mobileMenuOpen.set(false);
    const behavior: ScrollBehavior = this.prefersReducedMotion() ? 'auto' : 'smooth';
    document.getElementById(id)?.scrollIntoView({ behavior });
  }

  toggleMobileMenu(): void {
    this.mobileMenuOpen.update((v) => !v);
  }

  goSignin(): void {
    this.mobileMenuOpen.set(false);
    this.telemetry.track('hero.signin_started', { variant: this.heroVariant() });
    this.router.navigate(['/signin']);
  }

  goGetStarted(): void {
    this.mobileMenuOpen.set(false);
    this.telemetry.track('hero.cta_clicked', { variant: this.heroVariant() });
    if (this.heroSearchInput?.nativeElement) {
      this.heroSearchInput.nativeElement.focus();
      const behavior: ScrollBehavior = this.prefersReducedMotion() ? 'auto' : 'smooth';
      window.scrollTo({ top: 0, behavior });
    }
  }

  /** Logged-in nav: jump to the dashboard (replaces "Sign In" for a session). */
  goDashboard(): void {
    this.mobileMenuOpen.set(false);
    this.router.navigate(['/admin']);
  }

  /** Logged-in nav: start a new site build. */
  goNewSite(): void {
    this.mobileMenuOpen.set(false);
    this.router.navigate(['/create']);
  }

  /** Logged-in mobile nav: sign out and stay on the homepage. */
  signOut(): void {
    this.mobileMenuOpen.set(false);
    this.auth.logout();
  }

  /**
   * Resolve the hero A/B/C variant. Priority:
   * 1. `?debug=ab&variant=A|B|C` query string — dev-only override
   * 2. PostHog feature flag `homepage_hero_v2` returning string A/B/C
   * 3. Deterministic seed: `Date.now() % 3` so a single-load anon user
   *    still gets a stable assignment across re-renders within the session
   *
   * Fires `hero.variant_assigned` exactly once per session so we can
   * downstream-attribute hero.cta_clicked / hero.signin_started events.
   */
  /**
   * Inject FAQPage JSON-LD scoped to the homepage only (the FAQ accordion is
   * visible here). Built from the SAME `faq.q1..6`/`faq.a1..6` i18n keys the
   * accordion renders, so the structured data exactly matches the visible Q&A
   * (Google FAQ policy). Replaces the old GLOBAL FAQPage block in index.html,
   * which incorrectly applied to /privacy, /terms, etc.
   */
  private injectFaqJsonLd(): void {
    const keys: string[] = [];
    for (let i = 1; i <= 6; i++) keys.push(`faq.q${i}`, `faq.a${i}`);
    this.translate.get(keys).pipe(takeUntil(this.destroy$)).subscribe((t: Record<string, string>) => {
      const qa: { q: string; a: string }[] = [];
      for (let i = 1; i <= 6; i++) {
        const q = t[`faq.q${i}`];
        const a = t[`faq.a${i}`];
        // Skip any unresolved keys (translation missing → value === key).
        if (q && a && q !== `faq.q${i}` && a !== `faq.a${i}`) qa.push({ q, a });
      }
      if (qa.length) this.meta.setJsonLd(graph([faqPage(qa)]));
    });
  }

  private resolveHeroVariant(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    // ?debug=ab&variant=X — dev tooling override.
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === 'ab') {
      const forced = (params.get('variant') ?? '').toUpperCase();
      if (forced === 'A' || forced === 'B' || forced === 'C') {
        this.heroVariant.set(forced);
        this.telemetry.track('hero.variant_assigned', { variant: forced, source: 'debug' });
        return;
      }
    }

    // PostHog flag — string variant feature flag.
    let resolved: 'A' | 'B' | 'C' = 'A';
    try {
      const ph = (window as unknown as { posthog?: { getFeatureFlag?: (k: string) => unknown } }).posthog;
      const flagValue = ph?.getFeatureFlag?.('homepage_hero_v2');
      if (typeof flagValue === 'string') {
        const v = flagValue.toUpperCase();
        if (v === 'A' || v === 'B' || v === 'C') resolved = v;
      }
    } catch {
      // PostHog not initialized — fall through to seed.
    }

    // No flag resolution — use a stable per-session seed in localStorage.
    if (resolved === 'A') {
      try {
        const stored = localStorage.getItem('ps_hero_variant');
        if (stored === 'A' || stored === 'B' || stored === 'C') {
          resolved = stored;
        } else {
          const seed = ['A', 'B', 'C'][Math.floor(Math.random() * 3)] as 'A' | 'B' | 'C';
          resolved = seed;
          localStorage.setItem('ps_hero_variant', seed);
        }
      } catch {
        // private mode — accept the 'A' control
      }
    }

    this.heroVariant.set(resolved);
    this.telemetry.track('hero.variant_assigned', { variant: resolved, source: 'flag' });
  }

  /**
   * Human-readable A/B headline copy, switched on `heroVariant()`.
   *
   * The B/C variants are ENGLISH conversion-copy experiments. On a non-English
   * locale we ALWAYS return `''` so the template's `@else … | translate` renders
   * the localized control (`hero.title`) — otherwise 2/3 of Spanish visitors (the
   * random B/C seed) get a hardcoded-English hero that never translates. The A/B
   * test only runs for English. (chaos-6 i18n)
   */
  heroHeadline(): string {
    if (this.currentLang() !== 'en') return '';
    const v = this.heroVariant();
    if (v === 'B') return "Tell us your business. We'll build your website.";
    if (v === 'C') return 'Skip the agency. Ship in 4 minutes.';
    return ''; // A — translation pipe handles the control headline
  }

  /** Sub-headline copy paired with each variant (English-only A/B — see {@link heroHeadline}). */
  heroSubheadline(): string {
    if (this.currentLang() !== 'en') return '';
    const v = this.heroVariant();
    if (v === 'B') return 'Search your business, sign in, get a gorgeous AI-generated site — hosted, SSL, live.';
    if (v === 'C') return 'AI builds, optimizes, and ships your business site in the time it takes to drink an espresso.';
    return '';
  }

  /** CTA copy paired with each variant (English-only A/B — see {@link heroHeadline}). */
  heroCta(): string {
    if (this.currentLang() !== 'en') return '';
    const v = this.heroVariant();
    if (v === 'B') return 'Build mine →';
    if (v === 'C') return 'Ship in 4 min →';
    return ''; // A — translation pipe handles the control CTA
  }

  /** True when running in dev-mode A/B debug — used to render the badge. */
  showAbBadge(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    return new URLSearchParams(window.location.search).get('debug') === 'ab';
  }
}
