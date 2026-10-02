import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { UsageGaugesComponent } from './usage-gauges.component';
import { ApiService } from '../../services/api.service';

/**
 * CLS: the plan-usage gauges card RESERVES its height while `GET /api/usage` is in
 * flight (a skeleton), so it doesn't shove the Credit wallet + Plan card below it down
 * when it lands — the largest remaining /admin/billing layout-shift contributor (267px).
 * `data` becomes `[]` on empty/error (never null after a response), so `data === null`
 * cleanly gates the skeleton with no settled flag needed.
 */
describe('UsageGaugesComponent (loading skeleton reserves height — anti-CLS)', () => {
  const GAUGE = { metric: 'sites', label: 'Sites', used: 3, limit: 10, unit: '', pct: 30 };
  afterEach(() => TestBed.resetTestingModule());

  function withApi(get: () => unknown) {
    TestBed.resetTestingModule();
    // provideRouter so the over-limit upgrade CTA's static `routerLink` resolves a real
    // `href` (static routerLink emits no `ng-reflect-*`; without a Router the href never
    // renders → the fire-69 CTA assertion fell through to '' and failed). Root-cause fix:
    // the test now asserts the real rendered link, not a dev-only reflection attribute.
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get } }, provideRouter([])],
    });
    const fx = TestBed.createComponent(UsageGaugesComponent);
    fx.detectChanges();
    return fx;
  }

  it('shows the skeleton (not the real card) while usage is loading', () => {
    const fx = withApi(() => new Subject()); // never emits → data null → loading
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="usage-gauges-skeleton"]')).withContext('skeleton reserves height').not.toBeNull();
    expect(el.querySelector('[data-testid="usage-gauges"]')).withContext('real card not shown yet').toBeNull();
    expect(fx.componentInstance.loading()).toBeTrue();
  });

  it('swaps skeleton → real gauges card when usage loads', () => {
    const fx = withApi(() => of({ data: [GAUGE], period: 'month' }));
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="usage-gauges-skeleton"]')).withContext('skeleton gone').toBeNull();
    expect(el.querySelector('[data-testid="usage-gauges"]')).withContext('real card shown').not.toBeNull();
    expect(fx.componentInstance.loading()).toBeFalse();
  });

  it('collapses to nothing (honest-empty) when usage loads empty', () => {
    const fx = withApi(() => of({ data: [], period: 'month' }));
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="usage-gauges-skeleton"]')).toBeNull();
    expect(el.querySelector('[data-testid="usage-gauges"]')).toBeNull();
    expect(fx.componentInstance.loading()).withContext('settled, not loading').toBeFalse();
  });

  /**
   * fire-69 — no-dead-control: an over-limit gauge told the owner they were over
   * but gave NO one-click way to fix it. An at-/over-limit metric must pair its
   * reason with a one-click upgrade CTA → /admin/billing. The CTA link is the RED
   * driver (the over-limit row had prose only, no actionable path).
   */
  describe('fire-69 — over-limit rows carry a one-click upgrade CTA', () => {
    const OVER = { metric: 'builds', label: 'Builds', used: 12, limit: 10, unit: '', pct: 120 };

    it('renders an upgrade CTA to /admin/billing on an over-limit gauge', () => {
      const fx = withApi(() => of({ data: [OVER], period: 'month' }));
      const el = fx.nativeElement as HTMLElement;
      const cta = el.querySelector('[data-testid="usage-upgrade-builds"]') as HTMLAnchorElement | null;
      expect(cta).withContext('over-limit gauge offers a one-click fix').not.toBeNull();
      expect(cta?.getAttribute('ng-reflect-router-link') ?? cta?.getAttribute('href') ?? '')
        .toContain('/admin/billing');
    });

    it('shows NO upgrade CTA when the metric is within its limit', () => {
      const fx = withApi(() => of({ data: [GAUGE], period: 'month' }));
      const el = fx.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="usage-upgrade-sites"]'))
        .withContext('within-limit metric needs no upgrade CTA').toBeNull();
    });
  });
});
