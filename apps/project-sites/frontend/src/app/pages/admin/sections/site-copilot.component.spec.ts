import { TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of, throwError, NEVER } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { AdminSiteCopilotComponent } from './site-copilot.component';
import { ToastService } from '../../../services/toast.service';

/**
 * Guards the copilot-sessions load-error gating (first coverage): a non-404
 * loadSessions failure used to just stop loading → the "No sessions yet" empty
 * state showed (masquerade). Now a non-404 error sets loadError + a Retry row;
 * a 404 stays the honest flag-disabled state; success/retry clear it.
 * overrideComponent strips the template; loadSessions() is driven directly.
 */
function make(get: jasmine.Spy): AdminSiteCopilotComponent {
  TestBed.configureTestingModule({
    imports: [AdminSiteCopilotComponent],
    providers: [
      { provide: ApiService, useValue: { get, put: () => of({ ok: true }) } },
      { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
    ],
  });
  TestBed.overrideComponent(AdminSiteCopilotComponent, { set: { template: '<div></div>', imports: [] } });
  const c = TestBed.createComponent(AdminSiteCopilotComponent).componentInstance;
  c.siteId = 's1';
  return c;
}

describe('AdminSiteCopilotComponent (sessions load-error gating)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('resolves siteId from the :id route param when not bound via @Input → ngOnInit loads (no perpetual skeleton)', () => {
    // The route is sites/:id/copilot but the component had @Input() siteId with
    // NO route-param fallback + no withComponentInputBinding → siteId stayed ''
    // → ngOnInit early-returned → loading() stuck true forever (stuck skeleton).
    const get = jasmine.createSpy('get').and.returnValue(of({ sessions: [], distribution: [] }));
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        { provide: ApiService, useValue: { get, put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 's-route' } }, parent: { snapshot: { params: {} } } } },
      ],
    });
    TestBed.overrideComponent(AdminSiteCopilotComponent, { set: { template: '<div></div>', imports: [] } });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    fx.detectChanges(); // fires ngOnInit
    expect(fx.componentInstance.siteId).withContext('siteId resolved from the route param').toBe('s-route');
    expect(get).withContext('sessions actually fetched (loadSessions ran)').toHaveBeenCalled();
    expect(fx.componentInstance.loading()).withContext('load resolved — not a perpetual skeleton').toBe(false);
  });

  it('success populates sessions and clears loadError', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ sessions: [{ id: 'a' }], distribution: [] })));
    c.loadSessions();
    expect(c.loadError()).toBeNull();
    expect(c.sessions().length).toBe(1);
    expect(c.loading()).toBe(false);
  });

  // STALE-ROUTE FAKE-EMPTY GUARD: a stale worker route can return a parseable-but-
  // shapeless 200 (SPA/marketing HTML object or `{}`) that ApiService's 2xx→404
  // remap does NOT catch (it only fires on an UNPARSEABLE body). Without an
  // Array.isArray guard, `r.sessions` is undefined → totalSessions() crashes on
  // `.length`, OR a non-array `r.distribution` crashes the @for. Must degrade to
  // the existing error card, never fake-empty/crash. Mirrors webhooks/inbox.
  it('a shapeless 200 ({}) degrades to loadError (not a fake-empty / crash)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({})));
    expect(() => c.loadSessions()).not.toThrow();
    expect(c.loadError()).withContext('shapeless 200 is a retryable error, not "no sessions"').not.toBeNull();
    expect(c.sessions().length).withContext('never leave a non-array in the signal').toBe(0);
    expect(c.distribution().length).toBe(0);
    expect(c.loading()).toBe(false);
  });

  it('a 200 with a non-array sessions/distribution is treated as an error, never iterated', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(
      of({ sessions: 'not-an-array', distribution: 'nope' } as unknown),
    ));
    expect(() => c.loadSessions()).not.toThrow();
    expect(c.loadError()).not.toBeNull();
    expect(c.sessions().length).toBe(0);
    expect(c.distribution().length).toBe(0);
  });

  it('keeps a well-shaped sessions array but coerces a missing distribution to []', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ sessions: [{ id: 'a' }] })));
    c.loadSessions();
    expect(c.loadError()).toBeNull();
    expect(c.sessions().length).toBe(1);
    expect(c.distribution().length).withContext('absent distribution coerces to [] — no @for crash').toBe(0);
  });

  it('a 404 marks the feature flag-disabled WITHOUT a loadError (honest state, not a masquerade)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 404 }))));
    c.loadSessions();
    expect(c.flagEnabled()).toBe(false);
    expect(c.loadError()).toBeNull();
    expect(c.loading()).toBe(false);
  });

  it('a non-404 error sets a persistent loadError (not a fake empty)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    c.loadSessions();
    expect(c.loadError()).toContain('Could not load');
    expect(c.loading()).toBe(false);
  });

  it('retry after an error clears the prior loadError', () => {
    const get = jasmine.createSpy('get').and.returnValues(
      throwError(() => ({ status: 500 })),
      of({ sessions: [], distribution: [] }),
    );
    const c = make(get);
    c.loadSessions();
    expect(c.loadError()).not.toBeNull();
    c.loadSessions();
    expect(c.loadError()).toBeNull();
  });
});

/**
 * toggleEnabled must NOT be a moot mutation when multimodal_copilot is flag-off.
 * The enable toggle sits in the header (always rendered), but when the flag is
 * off (flagEnabled=false → gate notice shown) the per-site config route 404s, so
 * a toggle there is contradictory + dead. The template disables it; the handler
 * also no-ops + reverts the native checkbox defensively.
 */
let toggleToastErr: jasmine.Spy;
function makeToggle(put: jasmine.Spy): AdminSiteCopilotComponent {
  toggleToastErr = jasmine.createSpy('error');
  TestBed.configureTestingModule({
    imports: [AdminSiteCopilotComponent],
    providers: [
      { provide: ApiService, useValue: { get: () => of({ sessions: [], distribution: [] }), put } },
      { provide: ToastService, useValue: { error: toggleToastErr, success: () => 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
    ],
  });
  TestBed.overrideComponent(AdminSiteCopilotComponent, { set: { template: '<div></div>', imports: [] } });
  const c = TestBed.createComponent(AdminSiteCopilotComponent).componentInstance;
  c.siteId = 's1';
  return c;
}

describe('AdminSiteCopilotComponent (enable toggle gated by the feature flag)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('toggleEnabled is a no-op when the flag is off — no PUT to a gated route + reverts the checkbox', () => {
    const put = jasmine.createSpy('put').and.returnValue(of({ ok: true }));
    const c = makeToggle(put);
    c.flagEnabled.set(false);
    c.enabled.set(false);
    const input = { checked: true } as HTMLInputElement; // user just flipped it on
    c.toggleEnabled({ target: input } as unknown as Event);
    expect(put).withContext('no PUT when the feature is flag-disabled').not.toHaveBeenCalled();
    expect(input.checked).withContext('native checkbox reverts to the real state').toBe(false);
  });

  it('toggleEnabled PUTs the config when the flag is on', () => {
    const put = jasmine.createSpy('put').and.returnValue(of({ ok: true }));
    const c = makeToggle(put);
    c.flagEnabled.set(true);
    c.toggleEnabled({ target: { checked: true } as HTMLInputElement } as unknown as Event);
    // Routes through ApiService (bearer + 401-handling) at the de-/api path, silent
    // (the component owns its error toast). Was raw http.put('/api/...') with no auth.
    expect(put).toHaveBeenCalledWith('/sites/s1/copilot/config', { enabled: true }, { silent: true });
    expect(c.enabled()).toBe(true);
  });

  it('a failed toggle PUT surfaces an error toast (no silent failure) + leaves enabled() unchanged', () => {
    const put = jasmine.createSpy('put').and.returnValue(throwError(() => ({ status: 500 })));
    const c = makeToggle(put);
    c.flagEnabled.set(true);
    c.enabled.set(false);
    c.toggleEnabled({ target: { checked: true } as HTMLInputElement } as unknown as Event);
    expect(toggleToastErr).withContext('failed mutation must not fail silently').toHaveBeenCalled();
    expect(c.enabled()).withContext('signal unchanged on failure → [checked] binding reverts the checkbox').toBe(false);
  });
});

/**
 * Flag-gate cohesion (real template): the multimodal_copilot disabled card must
 * point at Feature Flags with the SAME inline, underlined RouterLink the sibling
 * flag-gate cards use (enterprise/trust/stripe/inbox/site-dna) — not a color-only
 * standalone CTA. Guards WCAG 1.4.1 (link affordance beyond color) + SPA nav.
 */
describe('AdminSiteCopilotComponent — flag-gate link cohesion (real template)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders an inline, UNDERLINED, working Feature-Flags RouterLink when the flag is off', () => {
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        // `NEVER` for the sessions `get`: a SUCCESSFUL load calls flagEnabled.set(true) (the component
        // treats a 200 as "flag on"), which clobbered the forced flagEnabled.set(false) whenever the
        // load's subscribe fired AFTER the forced set under Jasmine's random spec order → the gate hid
        // and this flaked at `link === null`. A NEVER observable never emits, so the load NEVER writes
        // flagEnabled: the spec's `set(false)` is the SOLE writer and the gate renders deterministically.
        // Root-cause isolation, not a settle-dance (CLAUDE.md §9); `put` still resolves for the toggle.
        { provide: ApiService, useValue: { get: () => NEVER, put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
      ],
    });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    // ISOLATION (gotcha #9): getComputedStyle reads LIVE CSS (textDecorationLine) off
    // `.flag-gate__link`, which only resolves when the element is attached to the real document.
    // A detached fixture (whenever Karma's execution order shifts this spec) makes the browser
    // skip stylesheet resolution → querySelector can even return null → getComputedStyle(null)
    // throws. Attach to document.body so the assertion is order-independent; detach in afterEach.
    document.body.appendChild(fx.nativeElement);
    fx.componentInstance.flagEnabled.set(false);
    fx.detectChanges();
    const link = (fx.nativeElement as HTMLElement).querySelector(
      '[data-testid="copilot-flag-gate"] a[routerLink="/admin/feature-flags"]',
    ) as HTMLAnchorElement;
    expect(link).withContext('flag-gate links to Feature Flags').toBeTruthy();
    // Shared <app-flag-gate-notice> underlines via `.flag-gate__link` CSS, not the Tailwind class.
    expect(getComputedStyle(link).textDecorationLine).withContext('permanently underlined').toContain('underline');
    expect(link.getAttribute('href')).toBe('/admin/feature-flags');
    fx.nativeElement.remove();
  });

  // The session-count stats ("0 sessions" + intent distribution) must NOT render
  // a definitive count while the sessions table is still loading — otherwise the
  // header asserts "0 sessions" OVER a skeleton-loading table (a contradictory,
  // premature stat). The stats appear only once data genuinely resolves.
  it('hides the session-count stats while loading (no "0 sessions" over a skeleton table)', () => {
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => NEVER, put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        provideRouter([]),
        // A real :id so siteId resolves + loadSessions actually runs (NEVER keeps
        // it genuinely in-flight — this is the REAL loading state, not the old
        // stuck-skeleton-from-empty-siteId bug).
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: 's1' } }, parent: { snapshot: { params: {} } } } },
      ],
    });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    fx.componentInstance.flagEnabled.set(true); // flag on → table renders (not the gate notice)
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(fx.componentInstance.loading()).withContext('sessions fetch in-flight').toBeTrue();
    expect(el.querySelector('.copilot-stats')).withContext('no premature stats over a loading table').toBeNull();
    expect(el.querySelector('.copilot-table[aria-busy="true"]')).withContext('the loading table is the only state shown').not.toBeNull();
  });

  it('the sessions table is a keyboard-scrollable region (WCAG 1.4.10 — wide signal/status values scroll, never clip unreachably)', () => {
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ sessions: [], distribution: [] }), put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
      ],
    });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    fx.componentInstance.flagEnabled.set(true);
    fx.detectChanges();
    const region = (fx.nativeElement as HTMLElement).querySelector('[data-testid="copilot-table-scroll"]') as HTMLElement;
    expect(region).withContext('sessions table wrap present').toBeTruthy();
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).withContext('keyboard-scrollable').toBe('0');
    expect(region.querySelector('table')).withContext('table inside the scroll region').toBeTruthy();
  });

  // TRUNCATE-WITHOUT-TITLE: the embed snippet <code> ellipsis-clips long slugs
  // (white-space:nowrap; text-overflow:ellipsis). Without [attr.title] the full
  // script URL is unreadable on hover → add the full snippet as the title so a
  // truncated value is always recoverable. Also the Copy button needs an
  // accessible name (it toggles "Copy"/"✓ Copied" text — fine — plus aria-label
  // so the action intent is stable for SR users regardless of the copied state).
  it('the truncated embed snippet exposes the full URL via title + the copy button has an accessible name', () => {
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ sessions: [], distribution: [] }), put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
      ],
    });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    fx.componentInstance.flagEnabled.set(true);
    fx.componentInstance.loading.set(false);
    fx.componentInstance.siteSlug.set('vitos-mens-salon');
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    const code = el.querySelector('#copilot-embed-snippet') as HTMLElement;
    expect(code).withContext('embed snippet rendered').toBeTruthy();
    expect(code.getAttribute('title')).withContext('full snippet recoverable on hover').toContain('vitos-mens-salon');
    const copyBtn = el.querySelector('.copilot-copy-btn') as HTMLButtonElement;
    expect((copyBtn.getAttribute('aria-label') ?? '').toLowerCase()).toContain('copy');
  });

  it('shows the session-count stats once the load resolves', () => {
    TestBed.configureTestingModule({
      imports: [AdminSiteCopilotComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ sessions: [], distribution: [] }), put: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { params: {} }, parent: { snapshot: { params: {} } } } },
      ],
    });
    const fx = TestBed.createComponent(AdminSiteCopilotComponent);
    fx.componentInstance.flagEnabled.set(true);
    fx.componentInstance.loading.set(false); // simulate a resolved sessions load
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('.copilot-stats')).withContext('stats render once data loaded').not.toBeNull();
  });
});

describe('AdminSiteCopilotComponent — latency formatting', () => {
  afterEach(() => TestBed.resetTestingModule());

  // Raw "12345ms" reads badly; mirror the ai-logs cockpit pattern
  // (<1000 → "Xms", else "X.Ys") so the Latency column is human + consistent.
  it('formats session latency like the rest of the cockpit', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ sessions: [], distribution: [] })));
    expect(c.formatLatency(340)).toBe('340ms');
    expect(c.formatLatency(999)).toBe('999ms');
    expect(c.formatLatency(1000)).toBe('1.0s');
    expect(c.formatLatency(12345)).toBe('12.3s');
    expect(c.formatLatency(null as unknown as number)).toBe('—');
  });
});
