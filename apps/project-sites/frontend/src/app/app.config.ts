import {
  type ApplicationConfig,
  APP_INITIALIZER,
  ErrorHandler,
  Injector,
  importProvidersFrom,
  inject,
  isDevMode,
  provideZoneChangeDetection,
} from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  withInMemoryScrolling,
  withPreloading,
  withViewTransitions,
} from '@angular/router';

/**
 * True when a route snapshot resolves under `/admin`. Used to skip the browser
 * view transition for admin section↔section swaps — those use a plain CSS
 * fade-in instead (no snapshot → the outgoing section can't flash, and there's
 * no cross-fade of old→new content).
 */
const isAdminRoute = (snapshot: ActivatedRouteSnapshot): boolean =>
  snapshot.pathFromRoot.some((route) => route.url.some((segment) => segment.path === 'admin'));
import { HoverPreloadingStrategy } from './services/hover-preloading-strategy';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideServiceWorker } from '@angular/service-worker';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { routes } from './app.routes';
import { firstValueFrom } from 'rxjs';
import { GlobalErrorHandler } from './services/error-handler.service';
import { retryInterceptor } from './interceptors/retry.interceptor';
import { loadingInterceptor } from './interceptors/loading.interceptor';
import { SwUpdateService } from './services/sw-update.service';

/** Preload translations before the app renders — prevents flash of raw keys.
 * Priority: localStorage > ?lang= query param > browser language > 'en' */
function initTranslations(translate: TranslateService) {
  return () => {
    translate.setFallbackLang('en');

    const stored = localStorage.getItem('ps_language');
    if (stored === 'en' || stored === 'es') {
      return firstValueFrom(translate.use(stored));
    }

    const urlLang = new URLSearchParams(window.location.search).get('lang');
    if (urlLang === 'en' || urlLang === 'es') {
      localStorage.setItem('ps_language', urlLang);
      return firstValueFrom(translate.use(urlLang));
    }

    const browserLang = translate.getBrowserLang();
    const lang = browserLang === 'es' ? 'es' : 'en';
    return firstValueFrom(translate.use(lang));
  };
}

/**
 * Thin ErrorHandler that forwards to the existing GlobalErrorHandler (toasts +
 * structured logs + section-error-bus). Errors also surface through PostHog +
 * Axiom via the structured logging path — Sentry was removed (see
 * docs/observability/sentry-removed.md).
 *
 * Uses `Injector` to lazily resolve `GlobalErrorHandler` so Angular's full DI
 * tree (ToastService, Router, SectionErrorBus) is available when `handleError`
 * is first called — not during construction.
 */
class CompositeErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);

  /** Lazy-resolved so we don't instantiate GlobalErrorHandler before DI is ready. */
  private get appHandler(): GlobalErrorHandler {
    return this.injector.get(GlobalErrorHandler);
  }

  handleError(error: unknown): void {
    this.appHandler.handleError(error);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    // HoverPreloadingStrategy (Tier 1 #4): only preload lazy chunks when the
    // user hovers over a sidebar link. Saves the initial bundle pressure of
    // PreloadAllModules (which downloaded every section at boot) while keeping
    // the instant-navigation feel — each tab's chunk loads on hover intent.
    // Falls back to idle-preloading the first 2 routes after 2s.
    provideRouter(
      routes,
      withPreloading(HoverPreloadingStrategy),
      withViewTransitions({
        skipInitialTransition: true,
        // Admin section↔section swaps (e.g. Forms→Apps) must NOT run a browser view
        // transition: the snapshot cross-fade left the outgoing section (its images/UI)
        // flashing during the swap. Skipping it swaps the DOM instantly with no snapshot,
        // and a CSS fade-in on the new section (with a short delay, no FOUC) does the
        // transition. Public/marketing routes keep view transitions.
        onViewTransitionCreated: ({ transition, from, to }) => {
          if (isAdminRoute(from) && isAdminRoute(to)) {
            transition.skipTransition();
          }
        },
      }),
      // Lets `routerLink="/" fragment="pricing"` (e.g. the /signin header nav)
      // scroll to the homepage #pricing section after navigation.
      withInMemoryScrolling({ anchorScrolling: 'enabled' }),
    ),
    provideHttpClient(
      withFetch(),
      withInterceptors([retryInterceptor, loadingInterceptor]),
    ),
    provideAnimations(),
    // PrimeNG fully removed from the admin — every component migrated to Spartan
    // (hlmBtn/hlmBadge/hlmInput/hlmCheckbox), DialogShell, TanStack table, and the
    // cockpit ToastService. No providePrimeNG / CockpitPreset needed anymore.
    // CompositeErrorHandler delegates to GlobalErrorHandler (toast + structured
    // logs + section-error-bus). GlobalErrorHandler is registered directly so the
    // lazy injector.get() can resolve it with the full DI tree intact.
    GlobalErrorHandler,
    { provide: ErrorHandler, useClass: CompositeErrorHandler },
    importProvidersFrom(
      TranslateModule.forRoot({
        fallbackLang: 'en',
      }),
    ),
    provideTranslateHttpLoader({ prefix: './assets/i18n/', suffix: '.json' }),
    {
      provide: APP_INITIALIZER,
      useFactory: initTranslations,
      deps: [TranslateService],
      multi: true,
    },
    /**
     * Service worker — turns the admin into a real PWA.
     *
     * - `enabled: !isDevMode()` so the SW only registers in production.
     * - `registrationStrategy: 'registerWhenStable:30000'` waits for app
     *   stability (or 30s) before installing so the first paint is never
     *   blocked.
     * - The SW caches ONLY the shell + static assets (`ngsw-config.json`
     *   assetGroups). Dynamic, auth'd `/api/*` responses are deliberately NOT
     *   in any `dataGroups` — a `freshness` DataGroup with a timeout REJECTS on
     *   slow/failed egress (`ngsw-worker.js DataGroup.safeFetch → Failed to
     *   fetch`), and a rejected `/api/sites` strands the `/admin/editor` shell.
     * - `SwUpdateService` (below) activates a ready update + reloads so a
     *   deployed fix reaches the browser instead of being masked by a stale SW.
     */
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    {
      // Self-heal a stale/broken service worker (see SwUpdateService docstring).
      provide: APP_INITIALIZER,
      useFactory: (sw: SwUpdateService) => (): void => sw.init(),
      deps: [SwUpdateService],
      multi: true,
    },
  ],
};

// Re-export CompositeErrorHandler for tests/inspection. It delegates to
// GlobalErrorHandler (toast + logs + section-error-bus); error reporting now
// flows through PostHog + Axiom structured logs, not Sentry.
export { CompositeErrorHandler };
