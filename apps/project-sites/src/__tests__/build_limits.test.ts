/**
 * Unit coverage for services/build_limits — per-org site-build quota.
 *
 * Guards the runaway-cost surface: free=1, paid=50 ($50/mo per site),
 * brian@-owned orgs=Infinity, counts non-deleted `sites` rows (soft-deletes do
 * NOT free a slot).
 *
 * NOTE: `UNLIMITED_ORGS` is a module-level per-isolate cache that persists
 * across tests in this file, so every test uses a DISTINCT orgId to avoid
 * cross-test cache pollution.
 */
jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
}));

import { dbQuery, dbQueryOne } from '../services/db.js';
import {
  checkBuildLimit,
  isUnlimitedOrgOwner,
  resolveActiveOrgPlan,
} from '../services/build_limits.js';

const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;

const db = {} as unknown as D1Database;

/** Owner lookup returns a non-unlimited email (the common path). */
function ordinaryOwner() {
  mockDbQueryOne.mockResolvedValue({ email: 'someone@example.com' } as never);
}
/** Site COUNT(*) helper. */
function siteCount(n: number) {
  mockDbQuery.mockResolvedValue({ data: [{ count: n }], error: null } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkBuildLimit — free tier (plan null / non-paid → limit 1)', () => {
  it('allows the first site when none exist yet', async () => {
    ordinaryOwner();
    siteCount(0);
    const q = await checkBuildLimit(db, 'org-free-under', null);
    expect(q).toEqual({ allowed: true, used: 0, limit: 1, remaining: 1 });
  });

  it('blocks at the free-limit boundary (1 site already used)', async () => {
    ordinaryOwner();
    siteCount(1);
    const q = await checkBuildLimit(db, 'org-free-at', null);
    expect(q.allowed).toBe(false);
    expect(q).toMatchObject({ used: 1, limit: 1, remaining: 0 });
  });

  it('clamps remaining to 0 when over limit (never negative)', async () => {
    ordinaryOwner();
    siteCount(5);
    const q = await checkBuildLimit(db, 'org-free-over', null);
    expect(q.allowed).toBe(false);
    expect(q.remaining).toBe(0);
  });

  it('treats an unknown plan string as free', async () => {
    ordinaryOwner();
    siteCount(0);
    const q = await checkBuildLimit(db, 'org-unknown-plan', 'enterprise-typo');
    expect(q.limit).toBe(1);
    expect(q.allowed).toBe(true);
  });
});

describe('checkBuildLimit — paid tier (limit 50)', () => {
  it('allows up to the paid limit', async () => {
    ordinaryOwner();
    siteCount(49);
    const q = await checkBuildLimit(db, 'org-paid-under', 'paid');
    expect(q).toEqual({ allowed: true, used: 49, limit: 50, remaining: 1 });
  });

  it('blocks at the paid boundary', async () => {
    ordinaryOwner();
    siteCount(50);
    const q = await checkBuildLimit(db, 'org-paid-at', 'paid');
    expect(q.allowed).toBe(false);
    expect(q.remaining).toBe(0);
  });
});

describe('checkBuildLimit — unlimited orgs', () => {
  it('grants Infinity to a brian@megabyte.space-owned org and never counts sites', async () => {
    mockDbQueryOne.mockResolvedValue({ email: 'brian@megabyte.space' } as never);
    const q = await checkBuildLimit(db, 'org-brian-1', 'free');
    expect(q).toEqual({ allowed: true, used: 0, limit: Infinity, remaining: Infinity });
    // unlimited path short-circuits before the COUNT query
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('caches the unlimited org so a later owner-lookup change still returns Infinity', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ email: 'brian@megabyte.space' } as never);
    const first = await checkBuildLimit(db, 'org-brian-cached', 'free');
    expect(first.limit).toBe(Infinity);
    // Second call: owner now resolves to nobody — cache must still grant Infinity.
    mockDbQueryOne.mockResolvedValue(null as never);
    const second = await checkBuildLimit(db, 'org-brian-cached', 'free');
    expect(second.limit).toBe(Infinity);
    expect(second.allowed).toBe(true);
  });
});

describe('resolveActiveOrgPlan — SSOT plan resolver (must include trialing, not active-only)', () => {
  it('returns the plan and gates on status IN (active, trialing)', async () => {
    mockDbQueryOne.mockResolvedValue({ plan: 'paid' } as never);
    const plan = await resolveActiveOrgPlan(db, 'org-active');
    expect(plan).toBe('paid');
    // Regression guard for the drift this helper fixed: a TRIALING subscriber is
    // paid-entitled everywhere else (subscriptionEventType emits subscription.active;
    // the AI spend-cap grants $50) — so the quota gate must NOT silently drop them to
    // the free tier by filtering `status = 'active'` alone.
    const sql = String(mockDbQueryOne.mock.calls[0][1]);
    expect(sql).toContain("status IN ('active', 'trialing')");
  });

  it('returns null when no active/trialing subscription exists (caller → free tier)', async () => {
    mockDbQueryOne.mockResolvedValue(null as never);
    const plan = await resolveActiveOrgPlan(db, 'org-none');
    expect(plan).toBeNull();
  });
});

describe('isUnlimitedOrgOwner — owner lookup excludes soft-deleted rows', () => {
  it('filters deleted_at so a removed owner membership never confers unlimited compute', async () => {
    mockDbQueryOne.mockResolvedValue({ email: 'brian@megabyte.space' } as never);
    const res = await isUnlimitedOrgOwner(db, 'org-softdelete-check');
    expect(res).toBe(true);
    const sql = String(mockDbQueryOne.mock.calls[0][1]);
    expect(sql).toContain('m.deleted_at IS NULL');
    expect(sql).toContain('u.deleted_at IS NULL');
  });

  it('RETRIES once on a transient owner-lookup throw (no false BUILD_LIMIT_REACHED)', async () => {
    // A single D1 blip must NOT strand an unlimited org at the free limit — the old
    // `.catch(() => null)` swallowed the throw and returned false (a false "68 of 1").
    mockDbQueryOne
      .mockRejectedValueOnce(new Error('D1_ERROR: transient') as never)
      .mockResolvedValueOnce({ email: 'e2e@megabyte.space' } as never);
    const res = await isUnlimitedOrgOwner(db, 'org-transient');
    expect(res).toBe(true);
    expect(mockDbQueryOne).toHaveBeenCalledTimes(2); // failed once, retried, succeeded
  });

  it('fails CLOSED (not unlimited) when the owner lookup throws on both attempts', async () => {
    mockDbQueryOne.mockRejectedValue(new Error('D1_ERROR: down') as never);
    const res = await isUnlimitedOrgOwner(db, 'org-down');
    expect(res).toBe(false); // never fail OPEN — an unconfirmed owner is not unlimited
  });
});

describe('checkBuildLimit — edge cases', () => {
  it('falls back to the plan limit when the org has no owner row', async () => {
    mockDbQueryOne.mockResolvedValue(null as never);
    siteCount(2);
    const q = await checkBuildLimit(db, 'org-no-owner', 'paid');
    expect(q.limit).toBe(50);
    expect(q.used).toBe(2);
    expect(q.allowed).toBe(true);
  });

  it('treats a missing COUNT row as used=0', async () => {
    ordinaryOwner();
    mockDbQuery.mockResolvedValue({ data: [], error: null } as never);
    const q = await checkBuildLimit(db, 'org-empty-count', null);
    expect(q.used).toBe(0);
    expect(q.allowed).toBe(true);
    expect(q.remaining).toBe(1);
  });
});

describe('checkBuildLimit — fails CLOSED on a D1 error (AL-784, never bypass the cost cap)', () => {
  it('DENIES on a SUSTAINED D1 error instead of reading the swallowed empty result as used=0', async () => {
    ordinaryOwner();
    // dbQuery SWALLOWS a D1 throw → { data: [], error }. Both attempts fail (sustained outage).
    mockDbQuery.mockResolvedValue({ data: [], error: 'D1_ERROR: connection reset' } as never);
    const q = await checkBuildLimit(db, 'org-d1-error', 'paid');
    // RED before AL-784: `used = []?.count ?? 0 = 0` → allowed=true → the 50-site cap was silently
    // BYPASSED on a read-replica blip. GREEN: deny-on-uncertainty (never fail OPEN on a cost gate).
    expect(q.allowed).toBe(false);
    expect(q.remaining).toBe(0);
    expect(mockDbQuery).toHaveBeenCalledTimes(2); // retried once before giving up
  });

  it('RETRIES once and SUCCEEDS on a single transient blip (no false denial)', async () => {
    ordinaryOwner();
    mockDbQuery
      .mockResolvedValueOnce({ data: [], error: 'D1_ERROR: transient' } as never)
      .mockResolvedValueOnce({ data: [{ count: 3 }], error: null } as never);
    const q = await checkBuildLimit(db, 'org-d1-retry', 'paid');
    expect(q.allowed).toBe(true); // the retry recovered the real count
    expect(q.used).toBe(3);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });
});
