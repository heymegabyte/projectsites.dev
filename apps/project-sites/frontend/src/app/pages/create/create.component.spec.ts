import { TestBed, type ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { CreateComponent } from './create.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { GeolocationService } from '../../services/geolocation.service';
import { ToastService } from '../../services/toast.service';
import { TelemetryService } from '../../services/telemetry.service';

/**
 * Create-wizard input constraints. The `#create-address` field must enforce the
 * SAME client-side cap as the Settings page business-address input
 * (`maxlength="500"` in `admin/sections/settings.component.ts`) so the server
 * limit is never the only guard against oversized paste-ins.
 */
describe('CreateComponent — address input constraints', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(false),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('caps the business address input at the 500 char settings limit', () => {
    const fx = render();
    const input = (fx.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '#create-address',
    );
    expect(input).withContext('the #create-address input must render').not.toBeNull();
    expect(input?.getAttribute('maxlength'))
      .withContext('mirrors the 500-char address cap on the Settings page')
      .toBe('500');
  });
});

describe('CreateComponent — invalid claim-link notice (AL-700)', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(queryParams: Record<string, string>): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy().and.returnValue(false),
      getAutoCreate: jasmine.createSpy().and.returnValue(false),
      setAutoCreate: jasmine.createSpy(),
      getPendingBuild: jasmine.createSpy().and.returnValue(false),
      setPendingBuild: jasmine.createSpy(),
      getSelectedBusiness: jasmine.createSpy().and.returnValue(null),
      getMode: jasmine.createSpy().and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows a FRIENDLY notice (not a dead-end) when redirected from an invalid claim link', () => {
    // The worker 302s an expired/invalid claim link → /create?claim_invalid=1 instead of raw JSON.
    const fx = render({ claim_invalid: '1' });
    const notice = (fx.nativeElement as HTMLElement).querySelector('[data-testid="claim-invalid-notice"]');
    expect(notice).withContext('the friendly invalid-claim notice must render').not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status'); // announced to AT, not an alarming error
    expect((notice?.textContent || '').toLowerCase()).toContain('expired');
    expect((notice?.textContent || '').toLowerCase()).toContain('build your site'); // first-action, owner's words
  });

  it('does NOT show the notice on a normal /create visit (no false alarm)', () => {
    const fx = render({});
    expect(
      (fx.nativeElement as HTMLElement).querySelector('[data-testid="claim-invalid-notice"]'),
    ).toBeNull();
  });
});

/**
 * Search-honesty nudge. When the worker's `/api/search/businesses` proxy returns a
 * provider `_error` (billing off → `SEARCH_PROVIDER_UNAVAILABLE`, key unset →
 * `SEARCH_PROVIDER_NOT_CONFIGURED`), the wizard must tell the guest "enter your
 * details manually" instead of silently rendering a no-results dropdown that reads
 * as "no such business". An honest empty result (real 0 matches, no `_error`) must
 * NOT trip the notice.
 */
describe('CreateComponent — search-unavailable nudge', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(searchReturn: unknown): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine
        .createSpy('searchBusinesses')
        .and.returnValue(of(searchReturn)),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(false),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows the manual-entry notice when the business search returns a provider _error', fakeAsync(() => {
    const fx = render({
      data: [],
      _error: { code: 'SEARCH_PROVIDER_UNAVAILABLE', status: 503, message: 'down' },
    });
    const c = fx.componentInstance;
    c.businessName = 'Vito';
    c.onBusinessInput();
    tick(350); // clear the 300ms debounce
    fx.detectChanges();
    expect(c.searchUnavailable()).withContext('provider _error must set the signal').toBe(true);
    const notice = (fx.nativeElement as HTMLElement).querySelector(
      '[data-testid="business-search-unavailable"]',
    );
    expect(notice)
      .withContext('the "enter manually" nudge must render on provider error')
      .not.toBeNull();
  }));

  it('does NOT show the notice on an honest empty result', fakeAsync(() => {
    const fx = render({ data: [] });
    const c = fx.componentInstance;
    c.businessName = 'Vito';
    c.onBusinessInput();
    tick(350);
    fx.detectChanges();
    expect(c.searchUnavailable()).withContext('no _error means honest-empty').toBe(false);
    const notice = (fx.nativeElement as HTMLElement).querySelector(
      '[data-testid="business-search-unavailable"]',
    );
    expect(notice).withContext('no nudge on an honest empty result').toBeNull();
  }));
});

/**
 * Address-search honesty nudge — the parallel of the business one. The worker's
 * `/api/search/address` proxy degrades the SAME way (Google Places down →
 * `{ data: [], _error }`). Without surfacing `_error`, the address autocomplete
 * renders a silent empty dropdown that reads as "no such address". The nudge tells
 * the guest to type the full address manually. An honest 0-match (no `_error`) must
 * NOT trip it.
 */
describe('CreateComponent — address-search-unavailable nudge', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function renderAddr(addrReturn: unknown): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of(addrReturn)),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(false),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows the address nudge when the address search returns a provider _error', fakeAsync(() => {
    const fx = renderAddr({
      data: [],
      _error: { code: 'SEARCH_PROVIDER_UNAVAILABLE', status: 503, message: 'down' },
    });
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck';
    c.onAddressInput();
    tick(350); // clear the 300ms debounce
    fx.detectChanges();
    expect(c.addressUnavailable()).withContext('provider _error must set the signal').toBe(true);
    const notice = (fx.nativeElement as HTMLElement).querySelector(
      '[data-testid="address-search-unavailable"]',
    );
    expect(notice)
      .withContext('the address "type it manually" nudge must render on provider error')
      .not.toBeNull();
  }));

  it('does NOT show the address nudge on an honest empty result', fakeAsync(() => {
    const fx = renderAddr({ data: [] });
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck';
    c.onAddressInput();
    tick(350);
    fx.detectChanges();
    expect(c.addressUnavailable()).withContext('no _error means honest-empty').toBe(false);
    const notice = (fx.nativeElement as HTMLElement).querySelector(
      '[data-testid="address-search-unavailable"]',
    );
    expect(notice).withContext('no nudge on an honest empty result').toBeNull();
  }));
});

/**
 * Submit-button gating (conversion-path a11y). `submitBuild()` early-returns with an
 * error toast when name OR address is empty — a "doomed click". The button must be
 * DISABLED until BOTH required fields are filled (never present a control that will
 * fail), and carry an aria-label explaining WHY it is disabled. Once both are filled
 * the button enables.
 */
describe('CreateComponent — submit button gates on required fields', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(false),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  /** The full-width primary submit button is the only `button.w-full` in the form. */
  function submitBtn(fx: ComponentFixture<CreateComponent>): HTMLButtonElement | null {
    return (fx.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.w-full');
  }

  it('is DISABLED with an explanatory aria-label when both fields are empty', () => {
    const fx = render();
    const btn = submitBtn(fx);
    expect(btn).withContext('the submit button must render').not.toBeNull();
    expect(btn?.disabled).withContext('empty name + address → doomed click, must disable').toBe(
      true,
    );
    expect(btn?.getAttribute('aria-label'))
      .withContext('disabled reason announced to AT')
      .toBe('Enter business name and address to continue');
  });

  it('stays DISABLED when only the name is filled (address still required)', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = "Vito's Mens Salon";
    fx.detectChanges();
    expect(submitBtn(fx)?.disabled).withContext('address still empty → still doomed').toBe(true);
  });

  it('stays DISABLED when only the address is filled (name still required)', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034';
    fx.detectChanges();
    expect(submitBtn(fx)?.disabled).withContext('name still empty → still doomed').toBe(true);
  });

  it('ENABLES (aria-label cleared) once both name and address are filled', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = "Vito's Mens Salon";
    c.businessAddress = '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034';
    fx.detectChanges();
    const btn = submitBtn(fx);
    expect(btn?.disabled).withContext('both required fields present → clickable').toBe(false);
    expect(btn?.getAttribute('aria-label'))
      .withContext('no disabled reason once enabled')
      .toBeNull();
  });
});

/**
 * Inline required-field error on blur (embarrassingly-easy + WCAG 3.3.1 Error
 * Identification). A keyboard/AT user who types a required field then clears it
 * and tabs away must be TOLD why — the inline error + `aria-invalid` must fire on
 * a blur-while-empty of a touched field, NOT only after a submit attempt. Before
 * this fix the error gated purely on `attempted()` (set only on submit-click), so
 * emptying a field left the "Create site" button disabled with ZERO inline
 * feedback — and, because the button is disabled, the click that would set
 * `attempted` never happens (a catch-22 that strands the user with no guidance).
 */
describe('CreateComponent — inline required-field error on blur (WCAG 3.3.1)', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(): ComponentFixture<CreateComponent> {
    const api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(false),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined },
        },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows NO name error before the field is touched (no premature alarm)', () => {
    const fx = render();
    const c = fx.componentInstance;
    expect(c.nameError).withContext('untouched empty field must not shout').toBeNull();
  });

  it('surfaces the name error after a blur-while-empty of a touched field (no submit needed)', () => {
    const fx = render();
    const c = fx.componentInstance;
    // User types a name (touches the field) then clears it and tabs away (blur).
    c.businessName = 'Salon';
    c.onBusinessInput();
    c.businessName = '';
    c.closeBusinessDropdown();
    fx.detectChanges();
    expect(c.attempted())
      .withContext('no submit attempt happened — this is a pure blur path')
      .toBe(false);
    expect(c.nameError)
      .withContext('a touched-then-emptied required field must explain itself on blur')
      .toContain('required');
    const input = (fx.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#create-name');
    expect(input?.getAttribute('aria-invalid'))
      .withContext('AT must hear the field is invalid')
      .toBe('true');
    const err = (fx.nativeElement as HTMLElement).querySelector('#create-name-error');
    expect((err?.textContent || '').trim().length)
      .withContext('the inline error <p> must render visible text, not empty whitespace')
      .toBeGreaterThan(0);
  });

  it('surfaces the address error after a blur-while-empty of a touched field', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck Rd';
    c.onAddressInput();
    c.businessAddress = '';
    c.closeAddressDropdown();
    fx.detectChanges();
    expect(c.addressError)
      .withContext('a touched-then-emptied address must explain itself on blur')
      .toContain('required');
  });

  it('clears the name error the moment a valid value is typed back', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = 'Salon';
    c.onBusinessInput();
    c.businessName = '';
    c.closeBusinessDropdown();
    fx.detectChanges();
    expect(c.nameError).withContext('error present while empty').toContain('required');
    // Type a real value back in.
    c.businessName = 'Vito Salon';
    c.onBusinessInput();
    fx.detectChanges();
    expect(c.nameError).withContext('error clears once the field is valid again').toBeNull();
  });

  // ── Focus-then-blur-empty (fire-52) ──────────────────────────────────────────
  // The most common keyboard/AT pattern is: TAB into a required field, TAB out
  // without typing anything. The original fire-51 fix only marked a field "touched"
  // on TYPING (onBusinessInput / onAddressInput) or on a query-param prefill, so a
  // visit-then-leave (focus → blur, zero keystrokes) surfaced NO error and left the
  // Create-site button disabled with no explanation — the exact WCAG 3.3.1 catch-22
  // the fix was meant to kill, still live for the focus-only path. A blur IS a visit:
  // leaving a required field empty must explain itself whether or not a key was pressed.
  // Caught by the fire-52 golden-path prod journey (address focus→Tab surfaced nothing).

  it('surfaces the name error on a focus-then-blur-empty (no keystroke, no submit)', () => {
    const fx = render();
    const c = fx.componentInstance;
    // User TABS into the empty name field and TABS out — never types. The template's
    // (focus) handler does not mark the field touched, so this is the pure focus→blur path.
    c.closeBusinessDropdown();
    fx.detectChanges();
    expect(c.attempted())
      .withContext('no submit happened — pure focus→blur path')
      .toBe(false);
    expect(c.nameError)
      .withContext('leaving a required field empty on blur must explain itself, even with no keystroke')
      .toContain('required');
    const input = (fx.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#create-name');
    expect(input?.getAttribute('aria-invalid'))
      .withContext('AT must hear the field is invalid after a focus→blur')
      .toBe('true');
  });

  it('surfaces the address error on a focus-then-blur-empty (no keystroke)', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.closeAddressDropdown();
    fx.detectChanges();
    expect(c.addressError)
      .withContext('address blurred-while-empty after a bare focus must explain itself')
      .toContain('required');
    const input = (fx.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '#create-address',
    );
    expect(input?.getAttribute('aria-invalid'))
      .withContext('AT must hear the address field is invalid after a focus→blur')
      .toBe('true');
  });
});

/**
 * Over-limit → Upgrade CTA (money-path · embarrassingly-easy · action-button-must-
 * gate-on-server-precondition). When site-create hits the per-plan cap the worker
 * returns 403 `{ error: { code: 'BUILD_LIMIT_REACHED', message } }` (api.ts:1096). The
 * create flow must NOT dead-end that with a generic error toast — a doomed outcome
 * must offer the FIX inline: an action-armed toast ("Upgrade") that routes to the
 * authed billing surface. A NON-limit failure stays a plain toast (no false CTA).
 */
describe('CreateComponent — over-limit surfaces an Upgrade CTA (BUILD_LIMIT_REACHED)', () => {
  let api: {
    searchBusinesses: jasmine.Spy;
    searchAddress: jasmine.Spy;
    createSiteFromSearch: jasmine.Spy;
  };
  let toast: { error: jasmine.Spy; success: jasmine.Spy; info: jasmine.Spy; dismiss: jasmine.Spy };
  let router: Router;

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  function limitError() {
    return throwError(() => ({
      status: 403,
      error: {
        error: {
          code: 'BUILD_LIMIT_REACHED',
          message:
            "You've used 1 of 1 sites. Free accounts include 1 site — add more for $50/month per site.",
        },
      },
    }));
  }

  function render(): ComponentFixture<CreateComponent> {
    api = {
      searchBusinesses: jasmine.createSpy('searchBusinesses').and.returnValue(of({ data: [] })),
      searchAddress: jasmine.createSpy('searchAddress').and.returnValue(of({ data: [] })),
      createSiteFromSearch: jasmine
        .createSpy('createSiteFromSearch')
        .and.returnValue(limitError()),
    };
    const auth = {
      isLoggedIn: jasmine.createSpy('isLoggedIn').and.returnValue(true),
      getAutoCreate: jasmine.createSpy('getAutoCreate').and.returnValue(false),
      setAutoCreate: jasmine.createSpy('setAutoCreate'),
      getPendingBuild: jasmine.createSpy('getPendingBuild').and.returnValue(false),
      setPendingBuild: jasmine.createSpy('setPendingBuild'),
      getSelectedBusiness: jasmine.createSpy('getSelectedBusiness').and.returnValue(null),
      getMode: jasmine.createSpy('getMode').and.returnValue('build'),
      clearSelectedBusiness: jasmine.createSpy('clearSelectedBusiness'),
    };
    toast = {
      error: jasmine.createSpy('error').and.returnValue(1),
      success: jasmine.createSpy('success'),
      info: jasmine.createSpy('info'),
      dismiss: jasmine.createSpy('dismiss'),
    };
    TestBed.configureTestingModule({
      imports: [CreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: GeolocationService, useValue: { lat: () => null, lng: () => null } },
        { provide: ToastService, useValue: toast },
        { provide: TelemetryService, useValue: { track: () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParams: {}, queryParamMap: { get: () => null } } },
        },
      ],
    });
    router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  type CreatePrivate = { createSiteWithUploadId: (uploadId?: string) => void };

  it('offers an "Upgrade" action that routes to /admin/billing instead of a dead toast', fakeAsync(() => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = "Vito's Mens Salon";
    c.businessAddress = '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034';
    (c as unknown as CreatePrivate).createSiteWithUploadId();
    tick();

    expect(toast.error).withContext('an error toast is shown').toHaveBeenCalled();
    const opts = toast.error.calls.mostRecent().args[1] as
      | { action?: { label: string; run: (id: number) => void } }
      | undefined;
    expect(opts?.action?.label)
      .withContext('over-limit must offer an inline Upgrade action, never a dead toast')
      .toBe('Upgrade');

    opts?.action?.run(1);
    expect(router.navigateByUrl)
      .withContext('the Upgrade action routes to the authed billing surface')
      .toHaveBeenCalledWith('/admin/billing');
  }));

  it('keeps a plain error toast (no action) for a NON-limit failure', fakeAsync(() => {
    const fx = render();
    api.createSiteFromSearch.and.returnValue(
      throwError(() => ({ status: 500, error: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } })),
    );
    const c = fx.componentInstance;
    c.businessName = 'X';
    c.businessAddress = 'Y';
    (c as unknown as CreatePrivate).createSiteWithUploadId();
    tick();

    const opts = toast.error.calls.mostRecent().args[1] as { action?: unknown } | undefined;
    expect(opts?.action)
      .withContext('a generic failure stays a plain toast — no false Upgrade CTA')
      .toBeUndefined();
  }));
});
