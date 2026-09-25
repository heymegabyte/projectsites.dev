import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { AdminActivationFunnelComponent } from './activation-funnel.component';
import { AdminStateService } from '../admin-state.service';
import {
  ActivationAnalyticsService,
  type ActivationFunnelResponse,
} from '../../../services/activation-analytics.service';

function resp(over: Partial<ActivationFunnelResponse> = {}): ActivationFunnelResponse {
  return {
    stages: [],
    conversion: {
      steps: [
        { stage: 'lead.discovered', label: 'Discovered', ordinal: 0, sites: 100, fromPrevPct: null, fromTopPct: 100 },
        { stage: 'subscription.active', label: 'Converted', ordinal: 3, sites: 12, fromPrevPct: 40, fromTopPct: 12 },
      ],
      topSites: 100,
      bottomSites: 12,
      overallPct: 12,
    },
    degraded: false,
    count: 4,
    ...over,
  };
}

function setup(value = of(resp()), claimsRows: unknown[] = [], publishesRows: unknown[] = [], superAdmin = true) {
  const getActivationFunnel = jasmine.createSpy('getActivationFunnel').and.returnValue(value);
  const getClaimsBySource = jasmine
    .createSpy('getClaimsBySource')
    .and.returnValue(of({ rows: claimsRows, degraded: false, count: claimsRows.length }));
  const getPublishesBySource = jasmine
    .createSpy('getPublishesBySource')
    .and.returnValue(of({ rows: publishesRows, degraded: false, count: publishesRows.length }));
  // The funnel gates its `/api/admin/*` fetches on the resolved super-admin flag; mock the shell
  // state (loading already settled) so the effect decides synchronously on first CD.
  const state = { loading: signal(false), isSuperAdmin: signal(superAdmin) };
  TestBed.configureTestingModule({
    imports: [AdminActivationFunnelComponent],
    providers: [
      {
        provide: ActivationAnalyticsService,
        useValue: { getActivationFunnel, getClaimsBySource, getPublishesBySource },
      },
      { provide: AdminStateService, useValue: state },
      // The template's `[routerLink]` (visitor-tab link) needs the router context — provide it so
      // RouterLink resolves ActivatedRoute (else NG0201 in the non-super-admin render).
      provideRouter([]),
    ],
  });
  const fixture: ComponentFixture<AdminActivationFunnelComponent> =
    TestBed.createComponent(AdminActivationFunnelComponent);
  fixture.detectChanges(); // CD flushes the super-admin effect → load (when authorized)
  return { fixture, getActivationFunnel, getClaimsBySource, getPublishesBySource };
}

function text(fixture: ComponentFixture<unknown>, sel: string): string | null {
  return fixture.nativeElement.querySelector(sel)?.textContent?.trim() ?? null;
}

describe('AdminActivationFunnelComponent', () => {
  it('loads the funnel on init and renders the overall conversion', () => {
    const { fixture, getActivationFunnel } = setup();
    expect(getActivationFunnel).toHaveBeenCalledWith({ days: 30 });
    expect(text(fixture, '[data-testid="funnel-overall"]')).toContain('12% overall');
  });

  it('renders a bar per conversion step with the prev-rate label', () => {
    const { fixture } = setup();
    const bars = fixture.nativeElement.querySelectorAll('[data-testid="funnel-bars"] > div');
    expect(bars.length).toBe(2);
    const html = fixture.nativeElement.querySelector('[data-testid="funnel-bars"]').textContent;
    expect(html).toContain('Discovered');
    expect(html).toContain('Converted');
    expect(html).toContain('40% of prev'); // the converted step's drop-off
  });

  it('shows the provisioning note when degraded', () => {
    const { fixture } = setup(of(resp({ degraded: true })));
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-degraded"]')).not.toBeNull();
  });

  it('does NOT show the provisioning note when not degraded', () => {
    const { fixture } = setup();
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-degraded"]')).toBeNull();
  });

  it('renders an error card with Retry on load failure', () => {
    const { fixture } = setup(throwError(() => new Error('boom')));
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-error"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-bars"]')).toBeNull();
  });

  it('renders the top acquisition channels aggregated by source + campaign', () => {
    const { fixture, getClaimsBySource } = setup(of(resp()), [
      { tenant_id: 't1', day: '2026-06-19', source: 'twitter', campaign: 'spring', claims: 3 },
      { tenant_id: 't1', day: '2026-06-20', source: 'twitter', campaign: 'spring', claims: 2 },
      { tenant_id: 't1', day: '2026-06-20', source: 'newsletter', campaign: '(none)', claims: 1 },
    ]);
    expect(getClaimsBySource).toHaveBeenCalledWith({ days: 30 });
    const section = fixture.nativeElement.querySelector('[data-testid="funnel-channels"]');
    expect(section).not.toBeNull();
    const text = section.textContent;
    expect(text).toContain('twitter');
    expect(text).toContain('5 claims'); // 3 + 2 aggregated across days
    expect(text).toContain('newsletter');
  });

  it('hides the channels section when there are no claims', () => {
    const { fixture } = setup(of(resp()), []);
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-channels"]')).toBeNull();
  });

  it('renders the delivery mix aggregated by source', () => {
    const { fixture, getPublishesBySource } = setup(of(resp()), [], [
      { tenant_id: 't1', day: '2026-06-19', source: 'bolt-embedded', publishes: 4 },
      { tenant_id: 't1', day: '2026-06-20', source: 'bolt-embedded', publishes: 3 },
      { tenant_id: 't1', day: '2026-06-20', source: 'claim', publishes: 2 },
    ]);
    expect(getPublishesBySource).toHaveBeenCalledWith({ days: 30 });
    const section = fixture.nativeElement.querySelector('[data-testid="funnel-delivery"]');
    expect(section).not.toBeNull();
    const text = section.textContent;
    expect(text).toContain('bolt-embedded');
    expect(text).toContain('7 publishes'); // 4 + 3 aggregated
    expect(text).toContain('claim');
  });

  it('hides the delivery-mix section when there are no publishes', () => {
    const { fixture } = setup(of(resp()), [], []);
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-delivery"]')).toBeNull();
  });

  it('for a NON-super-admin: shows the admin-only state + fires NO /api/admin/* fetches (no 403 console errors)', () => {
    const { fixture, getActivationFunnel, getClaimsBySource, getPublishesBySource } = setup(of(resp()), [], [], false);
    // Honest gated state instead of a misleading "Couldn't load — Retry" error card.
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-admin-only"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-error"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="funnel-bars"]')).toBeNull();
    // The whole point: the admin-only endpoints are NEVER called → no 403s in the console.
    expect(getActivationFunnel).not.toHaveBeenCalled();
    expect(getClaimsBySource).not.toHaveBeenCalled();
    expect(getPublishesBySource).not.toHaveBeenCalled();
  });
});
