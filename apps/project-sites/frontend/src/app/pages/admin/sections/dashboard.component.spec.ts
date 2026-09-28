import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AdminDashboardComponent } from './dashboard.component';
import { AdminStateService } from '../admin-state.service';
import { AuthService } from '../../../services/auth.service';

/**
 * The `/admin` index is the Getting Started hub (it replaced the former AI chat
 * dashboard). These tests lock its data contract + gating logic:
 *   - every section card links to a real `/admin/*` (or top-level) route,
 *   - the site-count / has-sites computeds track AdminStateService.sites,
 *   - the Feature Flags discovery card is gated to operator emails only.
 *
 * Logic-level (overrideComponent strips the heavy template DI graph); the
 * template's routerLink/aria bindings are AOT-verified by `ng build`.
 */
function make(email: string, sites: number): AdminDashboardComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AdminDashboardComponent],
    providers: [
      {
        provide: AdminStateService,
        useValue: { sites: signal(Array.from({ length: sites }, (_, i) => ({ id: `s${i}` }))) },
      },
      { provide: AuthService, useValue: { email: signal(email) } },
    ],
  });
  TestBed.overrideComponent(AdminDashboardComponent, { set: { template: '<div></div>', imports: [] } });
  return TestBed.createComponent(AdminDashboardComponent).componentInstance;
}

describe('AdminDashboardComponent (Getting Started hub)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('exposes section groups, each card linking to a real route with a glyph', () => {
    const c = make('owner@example.com', 0);
    expect(c.groups.length).toBeGreaterThan(0);
    const cards = c.groups.flatMap((g) => g.cards);
    expect(cards.length).toBeGreaterThanOrEqual(12);
    for (const card of cards) {
      expect(card.link.startsWith('/')).withContext(`${card.label} link is absolute`).toBe(true);
      expect(card.label.length).toBeGreaterThan(0);
      expect(card.desc.length).toBeGreaterThan(0);
      expect(card.glyph.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate section links', () => {
    const c = make('owner@example.com', 0);
    const links = c.groups.flatMap((g) => g.cards.map((card) => card.link));
    expect(new Set(links).size).withContext('every section card is unique').toBe(links.length);
  });

  it('ships tips with text + glyphs', () => {
    const c = make('owner@example.com', 0);
    expect(c.tips.length).toBeGreaterThan(0);
    for (const tip of c.tips) {
      expect(tip.text.length).toBeGreaterThan(0);
      expect(tip.glyph.length).toBeGreaterThan(0);
    }
  });

  it('tracks the site count + has-sites state from AdminStateService', () => {
    expect(make('owner@example.com', 0).hasSites()).toBe(false);
    const c = make('owner@example.com', 3);
    expect(c.siteCount()).toBe(3);
    expect(c.hasSites()).toBe(true);
  });

  it('gates the Feature Flags card to operator emails only', () => {
    expect(make('owner@example.com', 1).isSysAdmin()).toBe(false);
    expect(make('brian@megabyte.space', 1).isSysAdmin()).toBe(true);
  });

  // ccLoading() drives the command-center skeleton that reserves the Site-status + CWV
  // space, so those async sections don't shove the section-guide groups down when they
  // pop in — the residual dashboard CLS after the async sections were reserved. It
  // MUST span BOTH the sites fetch (isLoading) AND the separately-timed CWV metrics fetch.
  it('ccLoading() spans BOTH the sites and the (later) CWV-metrics fetch (anti-CLS reserve)', () => {
    TestBed.resetTestingModule();
    const loading = signal(true);
    TestBed.configureTestingModule({
      imports: [AdminDashboardComponent],
      providers: [
        { provide: AdminStateService, useValue: { sites: signal([]), loading } },
        { provide: AuthService, useValue: { email: signal('owner@example.com') } },
      ],
    });
    TestBed.overrideComponent(AdminDashboardComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminDashboardComponent).componentInstance;
    expect(c.ccLoading()).withContext('reserved while sites load').toBe(true);
    loading.set(false);
    expect(c.ccLoading()).withContext('sites done, no metrics in flight → released').toBe(false);
    c.metricsLoading.set(true);
    expect(c.ccLoading()).withContext('still reserved while the CWV metrics fetch runs').toBe(true);
    c.metricsLoading.set(false);
    expect(c.ccLoading()).withContext('released once BOTH resolve').toBe(false);
  });
});

/**
 * P4 command-center: the site-status summary buckets the already-loaded sites
 * via AdminStateService.getStatusClass and surfaces only non-zero buckets,
 * `error` (needs attention) first. Real data only — no fetch.
 */
describe('AdminDashboardComponent (site-status command-center strip)', () => {
  const STATUS_MAP: Record<string, string> = {
    published: 'published', building: 'building', queued: 'building',
    collecting: 'building', generating: 'building', uploading: 'building',
    error: 'error', failed: 'error', draft: 'draft',
  };
  function buildFromSites(
    sites: { status: string; current_build_version?: string | null }[],
  ): AdminDashboardComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminDashboardComponent],
      providers: [
        {
          provide: AdminStateService,
          useValue: {
            sites: signal(sites.map((s, i) => ({ id: `s${i}`, ...s }))),
            getStatusClass: (s: string) => STATUS_MAP[s] ?? 'draft',
          },
        },
        { provide: AuthService, useValue: { email: signal('owner@example.com') } },
      ],
    });
    TestBed.overrideComponent(AdminDashboardComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminDashboardComponent).componentInstance;
  }
  // A real "Live" site HAS a build — attach one to every published fixture so the
  // status-class assertions reflect genuinely-serving sites (a published site with
  // NO build serves a 503 and is asserted separately below).
  function buildWith(statuses: string[]): AdminDashboardComponent {
    return buildFromSites(
      statuses.map((status) => ({
        status,
        current_build_version: status === 'published' ? 'v1' : null,
      })),
    );
  }
  afterEach(() => TestBed.resetTestingModule());

  it('buckets sites by status class and counts them', () => {
    const c = buildWith(['published', 'published', 'generating', 'draft', 'error']);
    const byKey = Object.fromEntries(c.siteStatusSummary().map((b) => [b.key, b.count]));
    expect(byKey).toEqual({ error: 1, published: 2, building: 1, draft: 1 });
  });

  it('omits zero-count buckets', () => {
    const c = buildWith(['published', 'published']);
    expect(c.siteStatusSummary().map((b) => b.key)).toEqual(['published']);
  });

  // Each tile links to the FIRST matching site's detail (/admin/sites/:id) — the
  // "metric→record" drill-in. Without a siteId every tile would 404 at the
  // non-existent /admin/sites list route. Fixtures get ids s0..sN in order.
  it('carries the first matching site id per bucket for the /admin/sites/:id drill-in', () => {
    // s0,s1=published(v1) · s2=generating · s3=draft · s4=error
    const c = buildWith(['published', 'published', 'generating', 'draft', 'error']);
    const byKey = Object.fromEntries(c.siteStatusSummary().map((b) => [b.key, b.siteId]));
    expect(byKey).toEqual({ error: 's4', published: 's0', building: 's2', draft: 's3' });
  });

  it('surfaces "Needs attention" (error) first', () => {
    const c = buildWith(['published', 'failed']);
    expect(c.siteStatusSummary()[0].key).toBe('error');
    expect(c.siteStatusSummary()[0].label).toBe('Needs attention');
  });

  it('is empty when there are no sites', () => {
    expect(buildWith([]).siteStatusSummary()).toEqual([]);
  });

  // A `published` site with NO build serves the branded 503 ("the last build
  // didn't finish") on its subdomain — it is NOT live/serving. It must count as
  // "Needs attention", never "Live", or the dashboard lies about site health.
  // (Reconciled live 2026-08-17: e2e-test-org's acme-bakery + green-thumb are
  // published/null-build → 503, yet were shown as "2 Live · published + serving".)
  it('counts a published-but-unbuilt site as Needs attention, not Live', () => {
    const c = buildFromSites([
      { status: 'published', current_build_version: 'v3' }, // real Live site
      { status: 'published', current_build_version: null }, // 503 stub — needs attention
      { status: 'published', current_build_version: null }, // 503 stub — needs attention
      { status: 'draft', current_build_version: null },
    ]);
    const byKey = Object.fromEntries(c.siteStatusSummary().map((b) => [b.key, b.count]));
    expect(byKey).toEqual({ published: 1, error: 2, draft: 1 });
  });
});
