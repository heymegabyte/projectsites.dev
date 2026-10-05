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
 * Query root for the rendered create overlay.
 *
 * CREATE-POLISH-1 (commit 6043b166e): `CreateComponent.ngAfterViewInit()` HOISTS its
 * single root `.ps-create-overlay` node out of the component host and appends it to
 * `document.body` — a deliberate, browser-verified fix for the flex paint-order trap
 * that let the admin topbar's avatar paint over the close button. After the first
 * `fx.detectChanges()` the entire rendered template therefore lives under `document.body`,
 * NOT under `fx.nativeElement`. DOM assertions must query from `document` so they inspect
 * the overlay where it actually renders; the node is torn down by the component's
 * `ngOnDestroy` (fired on `TestBed.resetTestingModule()` in each `afterEach`), so no
 * stale overlay leaks between tests. `fx.nativeElement` is retained as a defensive
 * fallback for the (untaken) path where portaling is skipped.
 */
function overlayRoot(fx: ComponentFixture<CreateComponent>): HTMLElement {
  const portaled = document.querySelector<HTMLElement>('.ps-create-overlay');
  return portaled ?? (fx.nativeElement as HTMLElement);
}

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
    const input = overlayRoot(fx).querySelector<HTMLInputElement>('#create-address');
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
    const notice = overlayRoot(fx).querySelector('[data-testid="claim-invalid-notice"]');
    expect(notice).withContext('the friendly invalid-claim notice must render').not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status'); // announced to AT, not an alarming error
    expect((notice?.textContent || '').toLowerCase()).toContain('expired');
    expect((notice?.textContent || '').toLowerCase()).toContain('build your site'); // first-action, owner's words
  });

  it('does NOT show the notice on a normal /create visit (no false alarm)', () => {
    const fx = render({});
    expect(overlayRoot(fx).querySelector('[data-testid="claim-invalid-notice"]')).toBeNull();
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
    const notice = overlayRoot(fx).querySelector('[data-testid="business-search-unavailable"]');
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
    const notice = overlayRoot(fx).querySelector('[data-testid="business-search-unavailable"]');
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
    const notice = overlayRoot(fx).querySelector('[data-testid="address-search-unavailable"]');
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
    const notice = overlayRoot(fx).querySelector('[data-testid="address-search-unavailable"]');
    expect(notice).withContext('no nudge on an honest empty result').toBeNull();
  }));
});

/**
 * ALL inputs OPTIONAL (Brian 2026-10-03 — embarrassingly-easy-to-use + ai-permanence).
 * The submit button must NEVER disable on empty fields; the AI fills whatever the owner
 * leaves blank. The ONLY thing that disables the button is an in-flight build. No
 * "Enter business name and address" aria-label, no required-field guard.
 */
describe('CreateComponent — all inputs optional, submit never blocks on empty fields', () => {
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
    return overlayRoot(fx).querySelector<HTMLButtonElement>('button.w-full');
  }

  it('is ENABLED (and carries no disabled-reason aria-label) with BOTH fields empty', () => {
    const fx = render();
    const btn = submitBtn(fx);
    expect(btn).withContext('the submit button must render').not.toBeNull();
    expect(btn?.disabled)
      .withContext('every input is optional → submit must be clickable even when empty')
      .toBe(false);
    expect(btn?.getAttribute('aria-label'))
      .withContext('no "enter name and address" nag — fields are optional')
      .toBeNull();
  });

  it('stays ENABLED with only the name filled', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = "Vito's Mens Salon";
    fx.detectChanges();
    expect(submitBtn(fx)?.disabled).withContext('address optional → still clickable').toBe(false);
  });

  it('stays ENABLED with only the address filled', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034';
    fx.detectChanges();
    expect(submitBtn(fx)?.disabled).withContext('name optional → still clickable').toBe(false);
  });

  it('never surfaces a required-field error (both getters return null)', () => {
    const fx = render();
    const c = fx.componentInstance;
    // Touch then empty both fields — the old "required on blur" path.
    c.businessName = 'Salon';
    c.onBusinessInput();
    c.businessName = '';
    c.closeBusinessDropdown();
    c.businessAddress = '74 N Beverwyck Rd';
    c.onAddressInput();
    c.businessAddress = '';
    c.closeAddressDropdown();
    fx.detectChanges();
    expect(c.nameError).withContext('name is optional — never errors').toBeNull();
    expect(c.addressError).withContext('address is optional — never errors').toBeNull();
  });
});

/**
 * Inputs are OPTIONAL (Brian 2026-10-03). The former WCAG-3.3.1 "required on blur"
 * behavior is intentionally GONE — no field is required, so blurring an empty field
 * must NOT surface an error or set `aria-invalid`. The AI fills any blank the owner
 * leaves. This block guards against a regression that re-introduces a required nag.
 */
describe('CreateComponent — optional fields never nag on blur-empty', () => {
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

  it('shows NO name error before the field is touched', () => {
    const fx = render();
    expect(fx.componentInstance.nameError).toBeNull();
  });

  it('shows NO name error after a blur-while-empty of a touched field', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessName = 'Salon';
    c.onBusinessInput();
    c.businessName = '';
    c.closeBusinessDropdown();
    fx.detectChanges();
    expect(c.nameError).withContext('name is optional — no required nag on blur').toBeNull();
    const input = overlayRoot(fx).querySelector<HTMLInputElement>('#create-name');
    expect(input?.getAttribute('aria-invalid'))
      .withContext('optional field must not report invalid')
      .toBe('false');
  });

  it('shows NO address error after a blur-while-empty of a touched field', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.businessAddress = '74 N Beverwyck Rd';
    c.onAddressInput();
    c.businessAddress = '';
    c.closeAddressDropdown();
    fx.detectChanges();
    expect(c.addressError).withContext('address is optional — no required nag').toBeNull();
    const input = overlayRoot(fx).querySelector<HTMLInputElement>('#create-address');
    expect(input?.getAttribute('aria-invalid')).toBe('false');
  });

  it('shows NO error on a focus-then-blur-empty (no keystroke)', () => {
    const fx = render();
    const c = fx.componentInstance;
    c.closeBusinessDropdown();
    c.closeAddressDropdown();
    fx.detectChanges();
    expect(c.nameError).toBeNull();
    expect(c.addressError).toBeNull();
  });
});

/**
 * Close button + overlay dismissal (Brian 2026-10-03). The full-screen create overlay
 * carries a white top-right close button (`aria-label="Close"`) that returns to the
 * admin dashboard behind it; Esc does the same. The overlay must also announce itself
 * as a dialog labelled "Create autonomous website".
 */
describe('CreateComponent — full-screen overlay + white close button', () => {
  let router: Router;

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
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    const fx = TestBed.createComponent(CreateComponent);
    fx.detectChanges();
    return fx;
  }

  it('renders a dialog overlay labelled "Create autonomous website" with the bold phrase', () => {
    const fx = render();
    const el = overlayRoot(fx);
    const overlay = el.querySelector<HTMLElement>('.ps-create-overlay') ?? el;
    expect(overlay).withContext('the full-screen overlay must render').not.toBeNull();
    expect(overlay?.getAttribute('role')).toBe('dialog');
    expect(overlay?.getAttribute('aria-label')).toBe('Create autonomous website');
    expect((el.querySelector('.ps-create-canvas-title')?.textContent || '').trim()).toBe(
      'Create autonomous website',
    );
  });

  it('close button carries aria-label="Close" and routes to /admin on click', () => {
    const fx = render();
    const btn = overlayRoot(fx).querySelector<HTMLButtonElement>('.ps-create-close');
    expect(btn).withContext('the white close button must render').not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Close');
    btn?.click();
    expect(router.navigate).withContext('close returns to the dashboard behind').toHaveBeenCalledWith(
      ['/admin'],
    );
  });

  it('Esc dismisses the overlay to /admin', () => {
    const fx = render();
    fx.componentInstance.onEscape();
    expect(router.navigate).toHaveBeenCalledWith(['/admin']);
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
