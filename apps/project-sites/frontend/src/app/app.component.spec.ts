import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import { ApiService } from './services/api.service';
import { MetaService } from './services/meta.service';
import { AppShellService } from './services/app-shell.service';
import { TelemetryService } from './services/telemetry.service';
import { TranslateService } from '@ngx-translate/core';

/**
 * Shell contract for AppComponent — the app root that wraps every route. Locks:
 *  - the WCAG 2.4.1 skip-to-content link exists, is the first focusable element,
 *    and targets the #main-content landmark (a regression here silently breaks
 *    keyboard bypass for the whole app)
 *  - the single <main id="main-content" role="main"> landmark is present
 *  - isHeaderlessRoute logic: '/', /admin, /billing, /editor own their chrome
 *
 * ngOnInit is benign under test: AuthService.isLoggedIn()=false short-circuits
 * restoreSession, matchMedia('(hover: hover)') is false in headless so the cursor
 * follower never attaches, and window.location.search is empty so handleAuthCallback
 * is a no-op.
 */
function build(): ComponentFixture<AppComponent> {
  TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { isLoggedIn: () => false, getSelectedBusiness: () => null, getMode: () => 'create', setSession: () => undefined } },
      { provide: ApiService, useValue: { getMe: () => of({ data: null }), post: () => of({}) } },
      { provide: MetaService, useValue: { init: () => undefined } },
      { provide: AppShellService, useValue: { applyLanguage: () => undefined } },
      { provide: TelemetryService, useValue: { init: () => undefined, pageView: () => undefined, track: () => undefined, identify: () => undefined } },
      { provide: TranslateService, useValue: { currentLang: 'en', onLangChange: new Subject() } },
    ],
  });
  const fixture = TestBed.createComponent(AppComponent);
  fixture.detectChanges();
  return fixture;
}

describe('AppComponent (shell a11y + chrome contract)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let host: HTMLElement;

  beforeEach(() => {
    fixture = build();
    host = fixture.nativeElement as HTMLElement;
  });
  afterEach(() => {
    fixture.destroy(); // triggers ngOnDestroy cleanup (cursor listeners etc.)
    TestBed.resetTestingModule();
  });

  it('renders a skip-to-content link as the first element, targeting #main-content', () => {
    const skip = host.querySelector('a.skip-link') as HTMLAnchorElement | null;
    expect(skip).not.toBeNull();
    expect(skip?.getAttribute('href')).toBe('#main-content');
    // It must be the first focusable element in the DOM order (before header).
    const firstAnchor = host.querySelector('a');
    expect(firstAnchor).toBe(skip);
  });

  it('exposes the single <main id="main-content" role="main" tabindex="-1"> landmark', () => {
    const mains = host.querySelectorAll('main');
    expect(mains.length).toBe(1);
    const main = mains[0];
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('role')).toBe('main');
    // tabindex=-1 so the skip-link can MOVE focus here (a <main> isn't natively
    // focusable) — without it the skip link only scrolls, focus falls to body.
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('treats homepage + admin/billing/editor as headerless (their own chrome)', () => {
    const c = fixture.componentInstance as unknown as { isHeaderlessRoute(u: string): boolean };
    expect(c.isHeaderlessRoute('/')).toBe(true);
    expect(c.isHeaderlessRoute('/admin/snapshots')).toBe(true);
    expect(c.isHeaderlessRoute('/billing')).toBe(true);
    expect(c.isHeaderlessRoute('/editor/abc')).toBe(true);
    expect(c.isHeaderlessRoute('/blog')).toBe(false); // marketing route keeps the shared header
  });

  it('route-loading skeleton is OFF by default (homepage-safe) + renders only while a lazy chunk loads (AL-697)', () => {
    const c = fixture.componentInstance as unknown as { routeLoading: { (): boolean; set(v: boolean): void } };
    // DEFAULT: no skeleton — a settled route / the homepage static-hero must NEVER show it (no flash/CLS).
    expect(c.routeLoading()).toBe(false);
    expect(host.querySelector('[data-testid="route-loading"]')).toBeNull();
    // While a lazy chunk downloads → the skeleton renders with the correct a11y contract.
    c.routeLoading.set(true);
    fixture.detectChanges();
    const skel = host.querySelector('[data-testid="route-loading"]');
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute('role')).toBe('status');
    expect(skel?.getAttribute('aria-busy')).toBe('true');
    expect(skel?.getAttribute('aria-live')).toBe('polite');
    // Removed the instant the route settles → the loaded page's layout is untouched (no CLS).
    c.routeLoading.set(false);
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="route-loading"]')).toBeNull();
  });
});

/**
 * restoreSession() is a BACKGROUND session-validation on app init that owns its own outcome
 * (no-op on transient errors — keeps the session; the interceptor owns the 401 clear+redirect).
 * It MUST call getMe with { silent: true } so a transient status-0 blip (or a CF-challenged
 * headless XHR) never fires ApiService's alarming "Can't reach the server" toast on a user who
 * stays logged in. Regression guard for that false-alarm class.
 */
describe('AppComponent — restoreSession validates SILENTLY (no false-alarm toast)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('calls getMe({ silent: true }) on init when logged in', () => {
    const getMe = jasmine.createSpy('getMe').and.returnValue(of({ data: { id: 'u1', email: 'e@x.co', org_id: 'o1' } }));
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isLoggedIn: () => true, getSelectedBusiness: () => null, getMode: () => 'create', setSession: () => undefined } },
        { provide: ApiService, useValue: { getMe, post: () => of({}) } },
        { provide: MetaService, useValue: { init: () => undefined } },
        { provide: AppShellService, useValue: { applyLanguage: () => undefined } },
        { provide: TelemetryService, useValue: { init: () => undefined, pageView: () => undefined, track: () => undefined, identify: () => undefined } },
        { provide: TranslateService, useValue: { currentLang: 'en', onLangChange: new Subject() } },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges(); // ngOnInit → restoreSession (isLoggedIn=true)
    expect(getMe).toHaveBeenCalledWith({ silent: true });
    fixture.destroy();
  });
});

/**
 * handleAuthCallback() is the post-sign-in landing seam: the OAuth/magic-link callback
 * 302s the browser to `<returnUrl>?token=…&email=…&auth_callback=…`. It must (a) establish
 * the session, (b) strip the token from the URL, and (c) land the owner on the returnUrl deep
 * route they were bounced from — NOT dump them on the dashboard to re-navigate. Regression for
 * the bug where it hardcoded `router.navigate(['/admin'])`, defeating the returnUrl round-trip.
 */
describe('AppComponent — handleAuthCallback honors the returnUrl deep-link', () => {
  const originalUrl = window.location.href;

  function boot(startUrl: string, business: unknown = null) {
    const setSession = jasmine.createSpy('setSession');
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isLoggedIn: () => false, getSelectedBusiness: () => business, getMode: () => 'create', setSession } },
        { provide: ApiService, useValue: { getMe: () => of({ data: null }), post: () => of({}) } },
        { provide: MetaService, useValue: { init: () => undefined } },
        { provide: AppShellService, useValue: { applyLanguage: () => undefined } },
        { provide: TelemetryService, useValue: { init: () => undefined, pageView: () => undefined, track: () => undefined, identify: () => undefined } },
        { provide: TranslateService, useValue: { currentLang: 'en', onLangChange: new Subject() } },
      ],
    });
    const router = TestBed.inject(Router);
    const navByUrl = spyOn(router, 'navigateByUrl').and.returnValue(Promise.resolve(true));
    const navigate = spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));
    // Set the landed URL the callback would have produced, THEN boot (ngOnInit → handleAuthCallback).
    window.history.replaceState({}, '', startUrl);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    return { fixture, navByUrl, navigate, setSession };
  }

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl); // restore for sibling specs
    TestBed.resetTestingModule();
  });

  it('lands the owner on the deep returnUrl route (/admin/billing), not the dashboard', () => {
    const { fixture, navByUrl, navigate, setSession } = boot('/admin/billing?token=tok_1&email=o%40x.co&auth_callback=google');
    expect(setSession).toHaveBeenCalledWith('tok_1', 'o@x.co');
    expect(navByUrl).toHaveBeenCalledWith('/admin/billing');
    expect(navigate).not.toHaveBeenCalledWith(['/admin']);
    fixture.destroy();
  });

  it('strips the session token from the URL (never persists in history/referrer)', () => {
    const { fixture } = boot('/admin/billing?token=tok_secret&email=o%40x.co&auth_callback=google');
    expect(window.location.search).not.toContain('token');
    expect(window.location.search).not.toContain('tok_secret');
    fixture.destroy();
  });

  it('falls back to /admin for a bare-homepage landing (no returnUrl, no business)', () => {
    const { fixture, navigate, navByUrl } = boot('/?token=tok_2&email=o%40x.co&auth_callback=google');
    expect(navigate).toHaveBeenCalledWith(['/admin']);
    expect(navByUrl).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
