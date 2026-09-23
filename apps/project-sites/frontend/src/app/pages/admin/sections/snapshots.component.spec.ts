import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError, Subject, type Observable } from 'rxjs';
import { Router, provideRouter } from '@angular/router';
import { AdminSnapshotsComponent } from './snapshots.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { TelemetryService } from '../../../services/telemetry.service';
import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { AdminStateService } from '../admin-state.service';

/**
 * First coverage for the Snapshots list (untested) + the load-error gating added this round.
 * loadSnapshots used to be silent on error → the empty list fell through to "No snapshots yet"
 * (a masquerade — the operator could think their snapshots were lost). Now a failure sets a
 * persistent snapshotsError + Retry card; success/retry clear it. Driven via the public
 * retryLoadSnapshots(); the list URL is separated from the fire-and-forget metrics batch.
 */
function make(listObs: Observable<unknown>, site: { id: string } | null = { id: 's1' }): AdminSnapshotsComponent {
  const get = jasmine.createSpy('get').and.callFake((url: string) =>
    url.endsWith('/snapshots') ? listObs : of({ data: {} }), // metrics-batch + others are harmless
  );
  TestBed.configureTestingModule({
    imports: [AdminSnapshotsComponent],
    providers: [
      { provide: ApiService, useValue: { get, post: () => of({}), delete: () => of({}) } },
      { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
      { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
      { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
      { provide: AdminStateService, useValue: { selectedSite: signal(site) } },
    ],
  });
  TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
  return TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
}

describe('AdminSnapshotsComponent (list load-error gating)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('success populates snapshots and leaves snapshotsError null', () => {
    const c = make(of({ data: [{ id: 'snap1' }] }));
    c.retryLoadSnapshots();
    expect(c.snapshots().length).toBe(1);
    expect(c.snapshotsError()).toBeNull();
    expect(c.loadingSnapshots()).toBe(false);
  });

  it('a load error sets a persistent snapshotsError (not a fake "No snapshots yet")', () => {
    const c = make(throwError(() => ({ status: 500 })));
    c.retryLoadSnapshots();
    expect(c.snapshotsError()).toContain('Could not load');
    expect(c.snapshots().length).toBe(0);
    expect(c.loadingSnapshots()).toBe(false);
  });

  it('retry after an error clears the prior snapshotsError', () => {
    const get = jasmine.createSpy('get').and.returnValues(throwError(() => ({ status: 500 })), of({ data: [] }));
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get, post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
    c.retryLoadSnapshots();
    expect(c.snapshotsError()).not.toBeNull();
    c.retryLoadSnapshots();
    expect(c.snapshotsError()).toBeNull();
  });

  it('retryLoadSnapshots is a no-op with no selected site (no fetch)', () => {
    const c = make(of({ data: [] }), null);
    c.retryLoadSnapshots();
    expect(c.snapshots().length).toBe(0);
    expect(c.loadingSnapshots()).toBe(false);
  });
});

/**
 * Reverting a snapshot OVERWRITES the live production site — the single most
 * destructive admin action (more than deleting a backup). Like delete, it MUST
 * be confirmed first: fire-on-click with no guard would let a future backend
 * ship turn a single misclick into a live-site rollback. Mirror confirmDelete.
 */
describe('AdminSnapshotsComponent (destructive revert is confirm-guarded)', () => {
  function makeRevert(confirmResult: boolean): {
    c: AdminSnapshotsComponent;
    confirm: jasmine.Spy;
    revert: jasmine.Spy;
  } {
    const confirm = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    const revert = jasmine.createSpy('revertSnapshot').and.returnValue(of({ ok: true }));
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        {
          provide: ApiService,
          useValue: { get: () => of({ data: [] }), post: () => of({}), delete: () => of({}), revertSnapshot: revert },
        },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }), loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminSnapshotsComponent).componentInstance, confirm, revert };
  }
  const snap = { id: 'snap9', snapshot_name: 'v3 launch' } as never;
  afterEach(() => TestBed.resetTestingModule());

  it('asks for confirmation BEFORE reverting the live site', async () => {
    const { c, confirm, revert } = makeRevert(true);
    await c.revertToSnapshot(snap);
    expect(confirm).toHaveBeenCalled();
    expect(revert).toHaveBeenCalledWith('s1', 'snap9');
  });

  it('does NOT revert when the operator cancels the confirm', async () => {
    const { c, confirm, revert } = makeRevert(false);
    await c.revertToSnapshot(snap);
    expect(confirm).toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(c.reverting()).toBe(false);
  });

  // Revert OVERWRITES the live site — a double-trigger must never fire two
  // reverts. The guard is claimed BEFORE the confirm so a 2nd invocation can't
  // even open a 2nd dialog while the first revert is in flight.
  it('does NOT double-revert while a revert is in flight (no double overwrite)', async () => {
    const confirm = jasmine.createSpy('confirm').and.resolveTo(true);
    const revert = jasmine.createSpy('revertSnapshot').and.returnValue(new Subject()); // stays pending
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}), delete: () => of({}), revertSnapshot: revert } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }), loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
    await c.revertToSnapshot(snap);
    await c.revertToSnapshot(snap);
    expect(revert).withContext('a second revert while one is in flight must not fire').toHaveBeenCalledTimes(1);
  });

  it('clears the revert guard on error so a failed revert stays retryable', async () => {
    const confirm = jasmine.createSpy('confirm').and.resolveTo(true);
    const revert = jasmine.createSpy('revertSnapshot').and.returnValues(throwError(() => ({ status: 500 })), of({ ok: true }));
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}), delete: () => of({}), revertSnapshot: revert } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }), loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
    await c.revertToSnapshot(snap);
    expect(c.reverting()).withContext('guard clears after a failed revert').toBe(false);
    await c.revertToSnapshot(snap);
    expect(revert).toHaveBeenCalledTimes(2);
  });
});

/**
 * Double-toast guard: each snapshots mutation surfaces its OWN specific
 * toast.error in the error branch, so the ApiService call must be {silent:true}
 * — else the generic "Can't reach the server" toast double-fires on failure.
 */
describe('AdminSnapshotsComponent — mutations pass {silent:true} (no generic double-toast)', () => {
  let post: jasmine.Spy, del: jasmine.Spy, get: jasmine.Spy;
  function buildSpies(): AdminSnapshotsComponent {
    post = jasmine.createSpy('post').and.returnValue(of({ data: { commit_sha: 'abc', html_url: 'h' } }));
    del = jasmine.createSpy('delete').and.returnValue(of({}));
    get = jasmine.createSpy('get').and.returnValue(of({ data: [] }));
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get, post, delete: del } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('pushToGithub → backup POST is {silent}', () => {
    const c = buildSpies();
    c.ghStatus.set({ connected: true } as never); // pushToGithub guards on a connected repo
    c.pushToGithub(true);
    expect(post).toHaveBeenCalledWith('/sites/s1/github/backup', {}, { silent: true });
  });

  it('unlinkGithub → disconnect POST is {silent} (after confirm)', async () => {
    const c = buildSpies();
    await c.unlinkGithub();
    expect(post).toHaveBeenCalledWith('/sites/s1/github/disconnect', {}, { silent: true });
  });

  it('captureMetrics → capture POST is {silent}', () => {
    const c = buildSpies();
    c.captureMetrics({ id: 'snap9' } as never);
    expect(post).toHaveBeenCalledWith('/sites/s1/snapshots/snap9/capture', {}, { silent: true });
  });

  it('deleteSnapshot → DELETE is {silent}', () => {
    const c = buildSpies();
    c.deleteSnapshot('snap9');
    expect(del).toHaveBeenCalledWith('/sites/s1/snapshots/snap9', { silent: true });
  });

  it('linkGithub → OAuth-URL GET is {silent} (its own error toast is the sole message)', () => {
    const c = buildSpies();
    c.linkGithub();
    expect(get).toHaveBeenCalledWith(
      '/sites/s1/github/connect',
      { return_url: '/admin/snapshots' },
      { silent: true },
    );
  });
});

describe('AdminSnapshotsComponent (⋯ popover Esc dismiss)', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('Esc closes the open ⋯ popover (keyboard dismiss)', () => {
    const c = make(of({ data: [] }));
    c.moreOpenId.set('snap-1');
    expect(c.moreOpenId()).toBe('snap-1');
    c.onEscapeCloseMore();
    expect(c.moreOpenId()).toBeNull();
  });
});

/**
 * Quality-metrics batch response-shape (P0.54). The worker (snapshot_quality.ts)
 * returns `{ data: Array<SnapshotMetrics & { snapshot_id }> }` — an ARRAY of
 * enriched rows. The old FE `Object.entries(data)`'d it and keyed the cache by
 * array INDEX ("0","1"), so `metricsBySnapshotId().get(snap.id)` always missed →
 * the Quality chips NEVER populated (a green render hiding a dead surface). These
 * pin: an array keys by row.snapshot_id; a non-array response populates nothing.
 */
describe('AdminSnapshotsComponent — quality-metrics batch keys by snapshot_id', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeMetrics(metricsObs: Observable<unknown>): AdminSnapshotsComponent {
    const get = jasmine.createSpy('get').and.callFake((url: string) => {
      if (url.endsWith('/snapshots/metrics')) return metricsObs;
      if (url.endsWith('/snapshots')) return of({ data: [{ id: 'snapA' }, { id: 'snapB' }] });
      return of({ data: [] });
    });
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get, post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
  }

  it('an ARRAY of rows keys the cache by row.snapshot_id (never by array index)', () => {
    const c = makeMetrics(
      of({
        data: [
          { snapshot_id: 'snapA', lh_performance: 90 },
          { snapshot_id: 'snapB', lh_performance: 70 },
        ],
      }),
    );
    c.retryLoadSnapshots();
    expect(c.metricsBySnapshotId().get('snapA')?.lh_performance).toBe(90);
    expect(c.metricsBySnapshotId().get('snapB')?.lh_performance).toBe(70);
    expect(c.metricsBySnapshotId().has('0')).withContext('never keyed by array index').toBe(false);
  });

  it('carries the AI vision critique (vision_notes + vision_overall) through to the metrics cache', () => {
    // The snapshot-quality workflow stores a holistic score + written critique
    // (vision_overall / vision_notes) alongside the 6-axis radar blob. Both ride
    // the batch SELECT m.* → this pins that they reach the render layer that now
    // surfaces the critique beside the radar (were computed+stored but invisible).
    const c = makeMetrics(
      of({
        data: [
          {
            snapshot_id: 'snapA',
            lh_performance: 88,
            vision_overall: 9,
            vision_notes: 'Confident hero, strong type hierarchy, cohesive palette.',
            vision_model: 'llama-4-scout',
          },
        ],
      }),
    );
    c.retryLoadSnapshots();
    const m = c.metricsBySnapshotId().get('snapA');
    expect(m?.vision_overall).withContext('holistic score reaches the render layer').toBe(9);
    expect(m?.vision_notes).withContext('written critique reaches the render layer').toContain('hero');
  });

  it('a non-array (legacy Record) response populates nothing — no fake index keys, no crash', () => {
    const c = makeMetrics(of({ data: { snapA: { lh_performance: 90 } } as never }));
    c.retryLoadSnapshots();
    expect(c.metricsBySnapshotId().size).toBe(0);
  });
});

describe('AdminSnapshotsComponent (⋯ more-actions hover title)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the icon-only ⋯ more button carries a hover title (not just aria-label)', () => {
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'acme' }) } },
      ],
    });
    const fx = TestBed.createComponent(AdminSnapshotsComponent);
    fx.detectChanges();
    fx.componentInstance.snapshots.set([{ id: 'snap9', snapshot_name: 'v3 launch' }] as never);
    fx.componentInstance.loadingSnapshots.set(false);
    fx.detectChanges();
    const more = (fx.nativeElement as HTMLElement).querySelector('[data-testid="snapshot-more-snap9"]');
    expect(more).withContext('the ⋯ trigger renders').not.toBeNull();
    expect(more?.getAttribute('title')).toBe('More actions for snapshot v3 launch');
  });
});

/**
 * Build-state gate — the create-snapshot action must be OFF for a site with no
 * published build. POST /sites/:id/snapshots 400s ("Site has no published
 * version to snapshot") when current_build_version is null, so an enabled
 * button would dead-end. siteBuildable() mirrors that exact server precondition
 * and canCreate() folds it in. Regression for the chaos-4 "publish first" gate.
 */
describe('AdminSnapshotsComponent (create gated on a published build)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeWithSite(
    site: { id: string; current_build_version?: number } | null,
  ): AdminSnapshotsComponent {
    TestBed.configureTestingModule({
      imports: [AdminSnapshotsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: {} }), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: TelemetryService, useValue: { track: () => undefined, capture: () => undefined } },
        { provide: BoltEmbedService, useValue: { openSnapshot: () => undefined } },
        { provide: AdminStateService, useValue: { selectedSite: signal(site) } },
      ],
    });
    TestBed.overrideComponent(AdminSnapshotsComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminSnapshotsComponent).componentInstance;
  }

  it('siteBuildable() is false when the selected site has no current_build_version', () => {
    expect(makeWithSite({ id: 's1' }).siteBuildable()).toBe(false);
  });

  it('siteBuildable() is false when there is no selected site', () => {
    expect(makeWithSite(null).siteBuildable()).toBe(false);
  });

  it('siteBuildable() is true once the site has a published build version', () => {
    expect(makeWithSite({ id: 's1', current_build_version: 3 }).siteBuildable()).toBe(true);
  });

  it('canCreate() stays false on an unbuilt site even with a valid name (no 400 dead-end)', () => {
    const c = makeWithSite({ id: 's1' });
    c.newSnapshotName = 'v2-redesign';
    expect(c.nameError()).withContext('name itself is valid').toBeNull();
    expect(c.canCreate()).withContext('the build gate blocks submit').toBe(false);
  });

  it('canCreate() is true on a built site with a valid name', () => {
    const c = makeWithSite({ id: 's1', current_build_version: 1 });
    c.newSnapshotName = 'v2-redesign';
    expect(c.canCreate()).toBe(true);
  });
});
