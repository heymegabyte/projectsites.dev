/**
 * Money-path degradation honesty (fire-57).
 *
 * When the business lookup degrades (Places down → worker `_error` envelope), the homepage
 * banner must reference a control that ACTUALLY EXISTS on the page. The old copy said
 * “choose Build a custom website below” — a dropdown row that is hidden whenever the
 * dropdown is closed (blur / hard-error path), leaving the banner pointing at nothing.
 * The honest escape hatch is the always-visible hero CTA “Claim Your Site”, and tapping it
 * while degraded must REALLY route to the manual-entry create wizard (custom mode), not
 * re-focus the dead search box.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';

import { HomepageComponent } from './homepage.component';
import { DEGRADED_SEARCH_COPY } from './create-funnel-nav';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { GeolocationService } from '../../services/geolocation.service';
import { TelemetryService } from '../../services/telemetry.service';
import { MetaService } from '../../services/meta.service';
import { FeatureFlagService } from '../../services/feature-flag.service';

describe('Homepage degraded-search escape hatch (fire-57)', () => {
  let component: HomepageComponent;
  let routerSpy: jasmine.SpyObj<Router>;
  let authMock: {
    isLoggedIn: () => boolean;
    email: () => string;
    setMode: jasmine.Spy;
    clearSelectedBusiness: jasmine.Spy;
    setSelectedBusiness: jasmine.Spy;
  };

  beforeEach(() => {
    routerSpy = jasmine.createSpyObj<Router>('Router', ['navigate']);
    authMock = {
      isLoggedIn: () => false,
      email: () => '',
      setMode: jasmine.createSpy('setMode'),
      clearSelectedBusiness: jasmine.createSpy('clearSelectedBusiness'),
      setSelectedBusiness: jasmine.createSpy('setSelectedBusiness'),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: {} },
        { provide: AuthService, useValue: authMock },
        { provide: GeolocationService, useValue: {} },
        { provide: Router, useValue: routerSpy },
        { provide: TranslateService, useValue: {} },
        { provide: TelemetryService, useValue: { track: jasmine.createSpy('track') } },
        { provide: MetaService, useValue: {} },
        { provide: FeatureFlagService, useValue: { isOn: () => of(false) } },
      ],
    });
    // Class-only instantiation — the 46KB template (TranslateModule, child components) is
    // exercised by the Playwright suites; this spec pins the copy contract + CTA routing.
    component = TestBed.runInInjectionContext(() => new HomepageComponent());
  });

  it('banner copy references the REAL, always-visible escape hatch (“Claim Your Site”)', () => {
    expect(component.degradedSearchCopy).toBe(DEGRADED_SEARCH_COPY);
    expect(DEGRADED_SEARCH_COPY).toContain('Claim Your Site');
    expect(DEGRADED_SEARCH_COPY).toContain('manually');
    // The old copy named a dropdown row that is invisible whenever the dropdown is closed.
    expect(DEGRADED_SEARCH_COPY).not.toContain('Build a custom website');
  });

  it('degraded + typed query: Claim Your Site routes to manual entry, carrying the name through sign-in', () => {
    component.searchUnavailable.set(true);
    component.heroQuery = 'Vitos Salon';

    component.goGetStarted();

    expect(authMock.setMode).toHaveBeenCalledWith('custom');
    expect(authMock.clearSelectedBusiness).toHaveBeenCalled();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/signin'], {
      queryParams: { returnUrl: '/create?name=Vitos%20Salon' },
    });
  });

  it('degraded + nothing typed: Claim Your Site still enters the manual create funnel', () => {
    component.searchUnavailable.set(true);

    component.goGetStarted();

    expect(authMock.setMode).toHaveBeenCalledWith('custom');
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/signin'], {});
  });

  it('healthy lookup: Claim Your Site keeps its focus-the-search behavior (no navigation)', () => {
    component.searchUnavailable.set(false);

    component.goGetStarted();

    expect(routerSpy.navigate).not.toHaveBeenCalled();
    expect(authMock.setMode).not.toHaveBeenCalled();
  });
});
