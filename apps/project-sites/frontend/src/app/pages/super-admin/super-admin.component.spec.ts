/**
 * Value-domain coverage (TDD Contract #10) for the super-admin manual wallet
 * adjustment — a MONEY-mutating form. Asserts the FE mirrors the worker's
 * `adjustmentSchema` (non-zero INTEGER cents + reason 3–500 chars) across every
 * value class: valid / invalid / empty / boundary / overlong / unicode / injection.
 *
 * Pure-logic test: the template is overridden so `ngOnInit` never fires (no API
 * calls) — we drive `adjustCents`/`adjustReason` directly and assert
 * `adjustError()` / `adjustValid()`.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SuperAdminComponent } from './super-admin.component';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { AdminStateService } from '../admin/admin-state.service';

/** State mock that keeps the constructor gate effect a no-op (loading never resolves). */
const IDLE_STATE = { loading: () => true, isSuperAdmin: () => false };

function makeComponent(): SuperAdminComponent {
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: {} },
      { provide: ToastService, useValue: { success: () => {}, error: () => {} } },
      { provide: AdminStateService, useValue: IDLE_STATE },
    ],
  });
  // Override the template so no rendering / ngOnInit-triggered API calls run.
  TestBed.overrideComponent(SuperAdminComponent, { set: { template: '<div></div>', imports: [] } });
  return TestBed.createComponent(SuperAdminComponent).componentInstance;
}

describe('SuperAdminComponent — manual-adjustment value domains (TDD #10)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function set(c: SuperAdminComponent, cents: number, reason: string): void {
    c.adjustCents = cents;
    c.adjustReason = reason;
  }

  it('VALID: non-zero integer cents + 3–500 char reason → no error, valid', () => {
    const c = makeComponent();
    set(c, 500, 'manual credit for downtime');
    expect(c.adjustError()).toBeNull();
    expect(c.adjustValid()).toBe(true);
  });

  it('VALID negative (debit): a negative integer is allowed', () => {
    const c = makeComponent();
    set(c, -2500, 'clawback for refund');
    expect(c.adjustError()).toBeNull();
    expect(c.adjustValid()).toBe(true);
  });

  it('EMPTY reason: no error message, but submit is blocked', () => {
    const c = makeComponent();
    set(c, 500, '');
    expect(c.adjustError()).toBeNull(); // empty ≠ "too short" — stay quiet
    expect(c.adjustValid()).toBe(false); // …but not submittable
  });

  it('INVALID zero amount (the default): rejected', () => {
    const c = makeComponent();
    set(c, 0, 'valid reason');
    expect(c.adjustError()).toBe('Amount cannot be zero.');
    expect(c.adjustValid()).toBe(false);
  });

  it('INVALID non-integer cents (5.5): rejected', () => {
    const c = makeComponent();
    set(c, 5.5, 'valid reason');
    expect(c.adjustError()).toBe('Amount must be a whole number of cents.');
    expect(c.adjustValid()).toBe(false);
  });

  it('INVALID NaN amount: rejected', () => {
    const c = makeComponent();
    set(c, Number('not-a-number'), 'valid reason');
    expect(c.adjustError()).toBe('Amount must be a whole number of cents.');
    expect(c.adjustValid()).toBe(false);
  });

  it('BOUNDARY reason length: 2 rejected, 3 ok, 500 ok, 501 rejected', () => {
    const c = makeComponent();
    set(c, 500, 'ab');
    expect(c.adjustError()).toBe('Reason must be at least 3 characters.');
    set(c, 500, 'abc');
    expect(c.adjustError()).toBeNull();
    set(c, 500, 'x'.repeat(500));
    expect(c.adjustError()).toBeNull();
    set(c, 500, 'x'.repeat(501));
    expect(c.adjustError()).toBe('Reason must be 500 characters or fewer.');
    expect(c.adjustValid()).toBe(false);
  });

  it('OVERLONG reason (10k chars): rejected, never submittable', () => {
    const c = makeComponent();
    set(c, 500, 'y'.repeat(10_000));
    expect(c.adjustError()).toBe('Reason must be 500 characters or fewer.');
    expect(c.adjustValid()).toBe(false);
  });

  it('UNICODE reason (valid length): accepted', () => {
    const c = makeComponent();
    set(c, 1200, '日本語の理由 — émojis 🎉 ok');
    expect(c.adjustError()).toBeNull();
    expect(c.adjustValid()).toBe(true);
  });

  it('INJECTION-shaped reason (valid length): accepted as free text (BE parameterizes)', () => {
    const c = makeComponent();
    set(c, 700, `'; DROP TABLE wallets; --`);
    expect(c.adjustError()).toBeNull();
    expect(c.adjustValid()).toBe(true);
  });
});

/**
 * Cost-category mutation request-shape parity (P0.54). The worker
 * `patchCategorySchema` (super_admin.ts) declares `billable: z.boolean()` +
 * `markup_factor: z.number().min(0.5).max(5)`. The FE previously sent `billable`
 * as a raw 0|1 NUMBER → Zod 400 on every toggle (a dead control behind a green
 * render), and sent `markup_factor` with no bound → a 400 with a generic toast.
 * These specs pin the contract: boolean billable + FE-clamped factor.
 */
describe('SuperAdminComponent — cost-category mutations (request-shape parity)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeWithPatch(patch: jasmine.Spy): SuperAdminComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { patch } },
        { provide: ToastService, useValue: { success: () => {}, error: () => {} } },
        { provide: AdminStateService, useValue: IDLE_STATE },
      ],
    });
    TestBed.overrideComponent(SuperAdminComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(SuperAdminComponent).componentInstance;
  }

  it('toggleBillable sends a BOOLEAN billable, never the old number 0|1 (worker Zod is z.boolean())', async () => {
    const patch = jasmine.createSpy('patch').and.returnValue({ toPromise: () => Promise.resolve({}) });
    const c = makeWithPatch(patch);
    await c.toggleBillable({ slug: 'llm_tokens', label: 'LLM', billable: 0 } as never);
    expect(patch).toHaveBeenCalled();
    const body = patch.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(typeof body['billable']).withContext('boolean, not number 0|1').toBe('boolean');
    expect(body['billable']).withContext('billable=0 → enabling → true').toBe(true);
  });

  it('saveFactor BLOCKS an out-of-range markup_factor without hitting the API (0.5–5 clamp)', async () => {
    const patch = jasmine.createSpy('patch').and.returnValue({ toPromise: () => Promise.resolve({}) });
    const c = makeWithPatch(patch);
    await c.saveFactor({ slug: 'x', label: 'X', markup_factor: 9 } as never);
    expect(patch).withContext('9 > 5 → rejected FE-side, no server 400').not.toHaveBeenCalled();
  });

  it('saveFactor sends a valid in-range factor as a number', async () => {
    const patch = jasmine.createSpy('patch').and.returnValue({ toPromise: () => Promise.resolve({}) });
    const c = makeWithPatch(patch);
    await c.saveFactor({ slug: 'x', label: 'X', markup_factor: 2.5 } as never);
    expect(patch).toHaveBeenCalled();
    const body = patch.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(body['markup_factor']).toBe(2.5);
  });
});

/**
 * Load-error feedback contract (surf QA, 2026-08-27). A non-super-admin who
 * navigates to /admin/super-admin gets a clean 403 from every /super-admin/*
 * read. The component OWNS its feedback — it renders the on-page "Restricted"
 * gate — so those reads MUST pass `{ silent: true }` to suppress ApiService's
 * generic error toast, which otherwise (a) double-fires alongside the gate and
 * (b) when a Cloudflare bot-challenge makes the XHR opaque status-0, LIES
 * "Can't reach the server. Check your connection." A genuine non-403 failure
 * still surfaces exactly one explicit, truthful message. Mirrors the
 * silent-load pattern in snapshots / user-settings / domains / apps-instances.
 */
describe('SuperAdminComponent — load error feedback (silent 403 gate, no lying toast)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeWithGet(getSpy: jasmine.Spy, errSpy: jasmine.Spy): SuperAdminComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { get: getSpy } },
        { provide: ToastService, useValue: { success: () => {}, error: errSpy } },
        { provide: AdminStateService, useValue: IDLE_STATE },
      ],
    });
    TestBed.overrideComponent(SuperAdminComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(SuperAdminComponent).componentInstance;
  }

  type Loads = {
    loadStats(): Promise<void>;
    loadCategories(): Promise<void>;
    loadWallets(q: string): Promise<void>;
  };

  it('403 on stats → forbidden set, call is { silent: true }, NO toast (gate is the only feedback)', async () => {
    const err = jasmine.createSpy('error');
    const get = jasmine.createSpy('get').and.returnValue({ toPromise: () => Promise.reject({ status: 403 }) });
    const c = makeWithGet(get, err);
    await (c as unknown as Loads).loadStats();
    expect(get).toHaveBeenCalledWith('/super-admin/stats?days=30', undefined, { silent: true });
    expect(c.forbidden()).toBe(true);
    expect(err).withContext('403 → Restricted gate owns feedback; the generic toast must stay silent').not.toHaveBeenCalled();
  });

  it('non-403 (500) on stats → ONE explicit truthful toast, never generic "Can\'t reach the server"', async () => {
    const err = jasmine.createSpy('error');
    const get = jasmine.createSpy('get').and.returnValue({ toPromise: () => Promise.reject({ status: 500 }) });
    const c = makeWithGet(get, err);
    await (c as unknown as Loads).loadStats();
    expect(c.forbidden()).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith('Could not load super-admin stats — try again');
  });

  it('cost-categories + wallets loads also pass { silent: true } and set the gate on 403', async () => {
    const err = jasmine.createSpy('error');
    const get = jasmine.createSpy('get').and.returnValue({ toPromise: () => Promise.reject({ status: 403 }) });
    const c = makeWithGet(get, err);
    await (c as unknown as Loads).loadCategories();
    await (c as unknown as Loads).loadWallets('');
    expect(get).toHaveBeenCalledWith('/super-admin/cost-categories', undefined, { silent: true });
    expect(get).toHaveBeenCalledWith('/super-admin/wallets?limit=100', undefined, { silent: true });
    expect(c.forbidden()).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('Account Operations (ops/users) load passes { silent: true } + sets the gate on 403', async () => {
    const err = jasmine.createSpy('error');
    const get = jasmine.createSpy('get').and.returnValue({ toPromise: () => Promise.reject({ status: 403 }) });
    const c = makeWithGet(get, err);
    await (c as unknown as { loadUsers(): Promise<void> }).loadUsers();
    expect(get).toHaveBeenCalledWith(
      jasmine.stringMatching(/^\/super-admin\/ops\/users\?/),
      undefined,
      { silent: true },
    );
    expect(c.forbidden()).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('ops/users non-403 (500) → ONE explicit account-load toast, never a lying generic', async () => {
    const err = jasmine.createSpy('error');
    const get = jasmine.createSpy('get').and.returnValue({ toPromise: () => Promise.reject({ status: 500 }) });
    const c = makeWithGet(get, err);
    await (c as unknown as { loadUsers(): Promise<void> }).loadUsers();
    expect(c.forbidden()).toBe(false);
    expect(err).toHaveBeenCalledOnceWith('Could not load accounts — try again');
  });
});

/**
 * Super-admin fetch gate (surf QA, 2026-08-29). A non-super-admin owner who
 * lands on /admin/super-admin must NOT fire the 3 doomed /api/super-admin/*
 * reads (each 403s). The client already knows `is_super_admin` from
 * /api/auth/me (hydrated into AdminStateService), so the component gates
 * loadAll() on that flag in a constructor effect that waits for
 * `state.loading()` to resolve, then shows Restricted directly. Mirrors
 * feature-flags.component's isSuperAdmin() gate. Regression for the "owner
 * fires unauthorized super-admin requests" defect.
 */
describe('SuperAdminComponent — fetch gate (no doomed 403s for non-super-admins)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeGated(opts: { isSuper: boolean; loading: boolean }) {
    const get = jasmine
      .createSpy('get')
      .and.returnValue({ toPromise: () => Promise.resolve({ totals: {}, data: [] }) });
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { get } },
        { provide: ToastService, useValue: { success: () => {}, error: () => {} } },
        {
          provide: AdminStateService,
          useValue: { loading: signal(opts.loading), isSuperAdmin: signal(opts.isSuper) },
        },
      ],
    });
    TestBed.overrideComponent(SuperAdminComponent, { set: { template: '<div></div>', imports: [] } });
    const fixture = TestBed.createComponent(SuperAdminComponent);
    fixture.detectChanges(); // flush the constructor gate effect
    return { fixture, get };
  }

  it('non-super-admin (me resolved) → Restricted, and ZERO /super-admin/* fetches fire', () => {
    const { fixture, get } = makeGated({ isSuper: false, loading: false });
    expect(fixture.componentInstance.forbidden()).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('super-admin (me resolved) → loadAll fires (fetches the operator surfaces)', () => {
    const { get } = makeGated({ isSuper: true, loading: false });
    expect(get).toHaveBeenCalledWith('/super-admin/stats?days=30', undefined, { silent: true });
  });

  it('while /me is still resolving → neither a fetch nor a premature Restricted', () => {
    const { fixture, get } = makeGated({ isSuper: false, loading: true });
    expect(get).not.toHaveBeenCalled();
    expect(fixture.componentInstance.forbidden()).toBe(false);
  });
});
