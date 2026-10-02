import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { AdminLogsDashboardComponent } from './logs-dashboard.component';
import { AdminStateService } from '../admin-state.service';

// Lightweight stubs so the wrapper test never instantiates the heavy real
// Audit / Log Explorer / AI Traces children (which fan out API calls on
// construction). They share the real selectors so the wrapper template resolves.
@Component({ selector: 'app-admin-audit', standalone: true, inputs: ['embedded'], template: '<div data-testid="stub-audit"></div>' })
class StubAuditComponent {}
@Component({ selector: 'app-logs-explorer', standalone: true, template: '<div data-testid="stub-explorer"></div>' })
class StubExplorerComponent {}
@Component({ selector: 'app-admin-ai-logs', standalone: true, template: '<div data-testid="stub-traces"></div>' })
class StubTracesComponent {}

describe('AdminLogsDashboardComponent', () => {
  const qpm = new BehaviorSubject<ParamMap>(convertToParamMap({}));
  const navigate = jasmine.createSpy('navigate');
  // Log Explorer + Traces read CROSS-TENANT Observability → super-admin-only (fire-71).
  const superAdmin = signal(false);

  function make() {
    TestBed.configureTestingModule({
      imports: [AdminLogsDashboardComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { queryParamMap: qpm.asObservable() } },
        { provide: Router, useValue: { navigate } },
        { provide: AdminStateService, useValue: { isSuperAdmin: superAdmin } },
      ],
    });
    TestBed.overrideComponent(AdminLogsDashboardComponent, {
      set: { imports: [StubAuditComponent, StubExplorerComponent, StubTracesComponent] },
    });
    const f = TestBed.createComponent(AdminLogsDashboardComponent);
    f.detectChanges();
    return f;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    qpm.next(convertToParamMap({}));
    navigate.calls.reset();
    superAdmin.set(false);
  });

  it('renders all three tabs for a super-admin', () => {
    superAdmin.set(true);
    const f = make();
    expect(f.nativeElement.querySelector('[data-testid="logs-dashboard"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-audit"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-explorer"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-traces"]')).toBeTruthy();
  });

  it('shows ONLY the Audit Trail tab for a non-super-admin (Explorer + Traces are cross-tenant)', () => {
    superAdmin.set(false);
    const f = make();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-audit"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-explorer"]')).toBeFalsy();
    expect(f.nativeElement.querySelector('[data-testid="logs-tab-traces"]')).toBeFalsy();
  });

  it('renders the owner-facing Audit Trail even when deep-linked ?tab=explorer as a non-super-admin (no doomed control)', () => {
    superAdmin.set(false);
    qpm.next(convertToParamMap({ tab: 'explorer' }));
    const f = make();
    // The tab signal still reflects the URL, but the cross-tenant Explorer view is NOT
    // rendered for a non-super-admin — the owner-safe Audit Trail is shown instead.
    expect(f.nativeElement.querySelector('[data-testid="stub-explorer"]')).toBeFalsy();
    expect(f.nativeElement.querySelector('[data-testid="stub-audit"]')).toBeTruthy();
  });

  it('defaults to the Audit Trail tab when no ?tab is present', () => {
    const f = make();
    expect(f.componentInstance.tab()).toBe('audit');
    expect(f.nativeElement.querySelector('[data-testid="stub-audit"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="stub-traces"]')).toBeFalsy();
  });

  it('lands on Traces when ?tab=traces for a super-admin (legacy /admin/traces + /admin/ai-logs deep links)', () => {
    superAdmin.set(true);
    qpm.next(convertToParamMap({ tab: 'traces' }));
    const f = make();
    expect(f.componentInstance.tab()).toBe('traces');
    expect(f.nativeElement.querySelector('[data-testid="stub-traces"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('[data-testid="stub-audit"]')).toBeFalsy();
  });

  it('lands on Log Explorer when ?tab=explorer for a super-admin', () => {
    superAdmin.set(true);
    qpm.next(convertToParamMap({ tab: 'explorer' }));
    const f = make();
    expect(f.componentInstance.tab()).toBe('explorer');
    expect(f.nativeElement.querySelector('[data-testid="stub-explorer"]')).toBeTruthy();
  });

  it('navigates with merged ?tab=traces when the Traces tab is clicked (super-admin)', () => {
    superAdmin.set(true);
    const f = make();
    f.nativeElement.querySelector('[data-testid="logs-tab-traces"]').click();
    expect(navigate).toHaveBeenCalled();
    const [, extras] = navigate.calls.mostRecent().args;
    expect(extras.queryParams).toEqual({ tab: 'traces' });
    expect(extras.queryParamsHandling).toBe('merge');
  });
});
