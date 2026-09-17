import { TestBed, type ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
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
