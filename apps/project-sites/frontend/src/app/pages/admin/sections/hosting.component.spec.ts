/**
 * PUBLISH-1 — hosting poll-then-reveal (money-path PUBLISH propagation guard).
 *
 * Proves the production URL card gates the live "open" affordance on the Worker's
 * `GET /api/sites/:id/live-check` probe (`ApiService.liveCheck`):
 *   (a) a not-live → live transition flips the card from "finishing deployment…" to
 *       the clickable live link, and stops polling on live:true;
 *   (b) the 404 **sentinel** (`liveCheck` resolves `null` = flag off) keeps the CURRENT
 *       always-shown link — no poll gating, zero regression;
 *   (c) polling stops after 5 attempts when the site never goes live.
 *
 * The probe is driven through a fake `ApiService` (a `Subject` per attempt) + a fake
 * `AdminStateService` exposing the `selectedSite` signal the component reacts to. Timers
 * are driven by the jasmine mock clock so the ~12s interval is deterministic.
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RouterModule } from '@angular/router';
import { Subject, of } from 'rxjs';

import { AdminHostingComponent } from './hosting.component';
import { AdminStateService } from '../admin-state.service';
import { ApiService, type LiveCheckResult, type Site } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    slug: 'vitos',
    business_name: "Vito's Mens Salon",
    business_address: '74 N Beverwyck Rd',
    status: 'published',
    current_build_version: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AdminHostingComponent — PUBLISH-1 poll-then-reveal', () => {
  /** One Subject per liveCheck call so the test resolves each poll attempt by hand. */
  let liveCheckSubjects: Subject<LiveCheckResult | null>[];
  let liveCheckCalls: number;
  const selectedSite = signal<Site | null>(null);

  /** Flag registry: `site_wfp_hosting` ON so the live hosting surface renders. */
  const apiStub = {
    getFeatureFlags: () =>
      of({
        flags: [
          {
            key: 'site_wfp_hosting',
            description: '',
            default_enabled: true,
            default_rollout_percent: 100,
            stage: 'beta',
            owner_email: 'x@y.z',
          },
        ],
        count: 1,
      }),
    liveCheck: (_siteId: string) => {
      liveCheckCalls += 1;
      const s = new Subject<LiveCheckResult | null>();
      liveCheckSubjects.push(s);
      return s.asObservable();
    },
  };

  const stateStub = {
    selectedSite,
    isBuilding: (s: Site) => ['building', 'queued', 'generating', 'uploading', 'collecting'].includes(s.status),
    newSite: () => {},
  };

  const toastStub = { show: () => {}, success: () => {}, error: () => {} };

  type Fixture = ReturnType<(typeof TestBed)['createComponent']>;

  /**
   * Build + settle the component. `loadFlag()` resolves the `site_wfp_hosting` gate via
   * `firstValueFrom` (a microtask), so after the first `detectChanges()` (which also flushes
   * the constructor `effect` → the immediate live probe) we await the microtask queue and
   * re-run change detection — now `flagOn` is true + the live hosting success block renders.
   */
  async function createComponent(): Promise<Fixture> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // RouterModule.forRoot([]) — the template uses RouterLink (crumb + editor CTA).
      // Mirrors the sibling section specs (e.g. site-dna.component.spec) so the root
      // router is set up identically across the admin-sections describes.
      imports: [AdminHostingComponent, RouterModule.forRoot([])],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AdminStateService, useValue: stateStub },
        { provide: ToastService, useValue: toastStub },
      ],
    });
    const fixture = TestBed.createComponent(AdminHostingComponent);
    fixture.detectChanges(); // ngOnInit → loadFlag (async) + constructor effect (immediate probe)
    await Promise.resolve(); // flush firstValueFrom → flagOn settles
    fixture.detectChanges(); // render the live hosting success block
    return fixture;
  }

  function q(fixture: Fixture, testid: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testid}"]`);
  }

  /** Resolve the most recent (pending) liveCheck attempt with a verdict. */
  function resolveLatest(verdict: LiveCheckResult | null): void {
    const s = liveCheckSubjects[liveCheckSubjects.length - 1];
    s.next(verdict);
    s.complete();
  }

  beforeEach(() => {
    jasmine.clock().install();
    liveCheckSubjects = [];
    liveCheckCalls = 0;
    selectedSite.set(makeSite());
  });

  afterEach(() => {
    jasmine.clock().uninstall();
    // Tear down the root-router TestBed so the next describe's router setup starts clean
    // (isolation hygiene — mirrors the sibling section specs; see frontend CLAUDE.md gotcha #9).
    TestBed.resetTestingModule();
  });

  it('(a) flips the production card from "finishing deployment…" to the live link on a not-live → live transition', async () => {
    const fixture = await createComponent();

    // The effect fired an IMMEDIATE first probe for the published site.
    expect(liveCheckCalls).toBe(1);

    // Still-propagating: the Worker reports live:false → "finishing deployment…", NO open link.
    resolveLatest({ live: false, status: 404, url: 'https://vitos.projectsites.dev' });
    fixture.detectChanges();
    expect(q(fixture, 'hosting-pending-production')).toBeTruthy();
    expect(q(fixture, 'hosting-open-production')).toBeFalsy();
    // The polite propagation status is announced while checking.
    expect(q(fixture, 'hosting-live-status')).toBeTruthy();
    // The PREVIEW card is NEVER gated — its link shows throughout.
    expect(q(fixture, 'hosting-open-preview')).toBeTruthy();

    // ~12s later the interval fires the next probe; now it's live (200).
    jasmine.clock().tick(12_000);
    expect(liveCheckCalls).toBe(2);
    resolveLatest({ live: true, status: 200, url: 'https://vitos.projectsites.dev' });
    fixture.detectChanges();

    // Revealed: the open link is back, the pending strip + status are gone.
    const open = q(fixture, 'hosting-open-production');
    expect(open).toBeTruthy();
    expect(open!.getAttribute('href')).toBe('https://vitos.projectsites.dev');
    expect(q(fixture, 'hosting-pending-production')).toBeFalsy();
    expect(q(fixture, 'hosting-live-status')).toBeFalsy();

    // Polling STOPPED on live:true — a further tick issues no new probe.
    jasmine.clock().tick(12_000);
    expect(liveCheckCalls).toBe(2);
  });

  it('(b) the 404 sentinel (flag off) keeps the always-shown link — no poll gating, no further polls', async () => {
    const fixture = await createComponent();
    expect(liveCheckCalls).toBe(1);

    // liveCheck maps a flag-OFF 404 to `null`. The card must keep the current behaviour:
    // the live link is shown and the pending strip never appears.
    resolveLatest(null);
    fixture.detectChanges();

    expect(q(fixture, 'hosting-open-production')).toBeTruthy();
    expect(q(fixture, 'hosting-pending-production')).toBeFalsy();
    expect(q(fixture, 'hosting-live-status')).toBeFalsy();

    // The sentinel froze the feature off — no further polling.
    jasmine.clock().tick(12_000);
    jasmine.clock().tick(12_000);
    expect(liveCheckCalls).toBe(1);
  });

  it('(c) stops polling after 5 attempts when the site never reports live', async () => {
    const fixture = await createComponent();

    // Attempt 1 (immediate) + 4 interval ticks = 5 probes, each still not-live.
    for (let i = 0; i < LIVE_MAX(); i++) {
      resolveLatest({ live: false, status: 0, url: 'https://vitos.projectsites.dev' });
      fixture.detectChanges();
      if (i < LIVE_MAX() - 1) jasmine.clock().tick(12_000);
    }
    expect(liveCheckCalls).toBe(5);

    // Still "finishing deployment…" (never revealed a doomed link).
    expect(q(fixture, 'hosting-pending-production')).toBeTruthy();
    expect(q(fixture, 'hosting-open-production')).toBeFalsy();

    // Capped: further ticks issue NO new probe.
    jasmine.clock().tick(12_000);
    jasmine.clock().tick(12_000);
    expect(liveCheckCalls).toBe(5);
  });

  it('does NOT poll for a non-published (draft) site — the probe only guards a published URL', async () => {
    selectedSite.set(makeSite({ status: 'draft', current_build_version: undefined }));
    await createComponent();
    expect(liveCheckCalls).toBe(0);
  });
});

/** Mirror of the component's `LIVE_POLL_MAX_ATTEMPTS` (kept local so the spec is self-contained). */
function LIVE_MAX(): number {
  return 5;
}
