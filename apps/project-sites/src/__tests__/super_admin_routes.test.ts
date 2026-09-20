/**
 * Route coverage for the super-admin surface (`src/routes/super_admin.ts`,
 * convergence r47).
 *
 * Exercises the handlers end-to-end through the real Hono app + the shared
 * {@link errorHandler}, mocking only the boundaries (D1 helpers, wallet
 * service). The security crux is the {@link requireSuperAdmin} middleware: it
 * MUST 401 unauthenticated callers and 403 regular authed users on EVERY
 * route before the handler runs. We assert that gate is enforced across the
 * full method/route matrix, then cover list / mutate / Zod-400 / success /
 * error paths for the privileged handlers.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(async () => ({ error: null, changes: 0 })),
}));

jest.mock('../services/wallet.js', () => ({
  manualAdjustment: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { superAdmin } from '../routes/super_admin.js';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from '../services/db.js';
import { manualAdjustment } from '../services/wallet.js';

const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockDbInsert = dbInsert as unknown as jest.Mock;
const mockDbUpdate = dbUpdate as unknown as jest.Mock;
const mockManualAdjustment = manualAdjustment as unknown as jest.Mock;

// ─── Boundary mocks ──────────────────────────────────────────────────────────

/**
 * A D1 stub whose prepare()/bind()/run()/first()/all() chain is inert. The
 * super-admin write handlers call `c.env.DB.prepare(...).bind(...).run()`
 * directly (outside the mocked db.ts helpers), plus the `audit()` helper does
 * the same — so the chain must resolve without throwing.
 */
function makeDb() {
  const run = jest.fn(async () => ({ success: true, meta: {} }));
  const first = jest.fn(async () => null);
  const all = jest.fn(async () => ({ results: [] }));
  const stmt: Record<string, jest.Mock> = {
    bind: jest.fn(() => stmt),
    run,
    first,
    all,
  };
  const prepare = jest.fn(() => stmt);
  return { prepare, _stmt: stmt, _run: run } as unknown as D1Database & {
    prepare: jest.Mock;
    _stmt: Record<string, jest.Mock>;
    _run: jest.Mock;
  };
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    put: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: jest.fn(async (k: string) => {
      store.delete(k);
    }),
    // invalidateFlagCache() sweeps `flag:<key>:` via list-then-delete.
    list: jest.fn(async () => ({ keys: [] as { name: string }[] })),
    _store: store,
  };
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: makeDb(),
    CACHE_KV: makeKv(),
    ...overrides,
  } as unknown as Env;
}

// ─── App harness ─────────────────────────────────────────────────────────────

/**
 * Build the app with a middleware that seeds the auth context vars the
 * {@link requireSuperAdmin} middleware reads (`userId`). Passing no userId
 * simulates an unauthenticated request.
 */
function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', superAdmin);
  return app;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function req(app: App, method: string, path: string, env: Env, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init, env, makeCtx());
}

const SUPER: Partial<Variables> = { userId: 'admin-1', orgId: 'org-1', requestId: 'req-1' };
const REGULAR: Partial<Variables> = { userId: 'user-9', orgId: 'org-9', requestId: 'req-9' };

/** Make the requireSuperAdmin middleware treat the caller as a super-admin. */
function grantSuperAdmin() {
  mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
    if (/is_super_admin.*FROM\s+users/i.test(sql)) return { is_super_admin: 1 };
    return null;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: every other dbQuery returns an empty list, dbQueryOne null.
  mockDbQuery.mockResolvedValue({ data: [] });
  mockDbQueryOne.mockResolvedValue(null);
  mockDbInsert.mockResolvedValue({ error: null });
  mockDbUpdate.mockResolvedValue({ error: null, changes: 1 });
});

// ─── Representative route matrix (method + path) used by the gate tests ───────

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/super-admin/cost-categories'],
  ['PATCH', '/api/super-admin/cost-categories/ai_generation', { markup_factor: 2 }],
  ['GET', '/api/super-admin/wallets'],
  ['GET', '/api/super-admin/wallets/org-7/transactions'],
  ['GET', '/api/super-admin/stats'],
  ['GET', '/api/super-admin/transactions'],
  ['GET', '/api/super-admin/ops/sites'],
  ['GET', '/api/super-admin/ops/users'],
  [
    'POST',
    '/api/super-admin/manual-adjustment',
    { org_id: 'org-7', amount_cents: 500, reason: 'goodwill credit' },
  ],
  ['GET', '/api/super-admin/whoami'],
  ['POST', '/api/super-admin/pro/grant', { user_id: 'u1', reason: 'comp' }],
  ['POST', '/api/super-admin/pro/revoke', { user_id: 'u1', reason: 'expired' }],
  ['GET', '/api/super-admin/coupons'],
  ['POST', '/api/super-admin/coupons', { code: 'LAUNCH50', kind: 'pct', amount: 50 }],
  ['DELETE', '/api/super-admin/coupons/LAUNCH50'],
  ['POST', '/api/super-admin/refunds', { org_id: 'org-7', amount_cents: 999, reason: 'duplicate' }],
  ['GET', '/api/super-admin/refunds'],
  [
    'POST',
    '/api/super-admin/broadcasts',
    { channel: 'email', segment: {}, body_md: 'hello world' },
  ],
  ['GET', '/api/super-admin/broadcasts'],
  ['GET', '/api/super-admin/announcements'],
  ['POST', '/api/super-admin/announcements', { title: 'Heads up', body_md: 'maintenance soon' }],
  ['GET', '/api/super-admin/feature-flags'],
  ['POST', '/api/super-admin/feature-flags', { key: 'new_flag', enabled_globally: true }],
  ['POST', '/api/super-admin/impersonate', { target_user_id: 'u1', reason: 'support ticket' }],
  ['POST', '/api/super-admin/impersonate/imp-1/end'],
  ['GET', '/api/super-admin/moderation'],
  ['POST', '/api/super-admin/moderation/m-1/resolve', { status: 'resolved' }],
  ['GET', '/api/super-admin/ai-blocklist'],
  ['POST', '/api/super-admin/ai-blocklist', { pattern: 'badword' }],
  ['POST', '/api/super-admin/tags', { org_id: 'org-7', tag: 'vip' }],
  ['DELETE', '/api/super-admin/tags', { org_id: 'org-7', tag: 'vip' }],
  [
    'POST',
    '/api/super-admin/rate-limit-overrides',
    { route_pattern: '/api/x', limit_per_min: 100 },
  ],
  ['GET', '/api/super-admin/audit'],
  ['POST', '/api/super-admin/cache/purge', { key: 'host:foo' }],
];

// ─── Security gate (the crux) ────────────────────────────────────────────────

describe('super-admin gate (requireSuperAdmin)', () => {
  it('rejects EVERY route with 401 when the caller is unauthenticated', async () => {
    for (const [method, path, body] of ROUTES) {
      const env = makeEnv();
      const res = await req(makeApp(), method, path, env, body);
      const json = (await res.json()) as { error?: { code?: string } };
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
      expect(json.error?.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects EVERY route with 403 when a regular authed user calls it', async () => {
    // dbQueryOne returns a user row with is_super_admin = 0.
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin.*FROM\s+users/i.test(sql)) return { is_super_admin: 0 };
      return null;
    });
    for (const [method, path, body] of ROUTES) {
      const env = makeEnv();
      const res = await req(makeApp(REGULAR), method, path, env, body);
      const json = (await res.json()) as { error?: { code?: string } };
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      expect(json.error?.code).toBe('FORBIDDEN');
    }
  });

  it('rejects with 403 when the user row is missing entirely (deleted/unknown)', async () => {
    mockDbQueryOne.mockResolvedValue(null); // no row at all
    const env = makeEnv();
    const res = await req(makeApp(REGULAR), 'GET', '/api/super-admin/stats', env);
    expect(res.status).toBe(403);
  });

  it('does NOT reach any handler logic when the gate rejects', async () => {
    const env = makeEnv();
    await req(makeApp(REGULAR), 'POST', '/api/super-admin/manual-adjustment', env, {
      org_id: 'org-7',
      amount_cents: 500,
      reason: 'should not run',
    });
    expect(mockManualAdjustment).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

// ─── Cost categories ─────────────────────────────────────────────────────────

describe('site operations — ops/sites list (Phase 1)', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists platform-wide sites with total + pagination shape (search + sort + paginate)', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/COUNT\(\*\)/i.test(sql)) return { n: 2 };
      return null;
    });
    mockDbQuery.mockResolvedValue({
      data: [
        {
          id: 's1',
          slug: 'acme',
          business_name: 'Acme',
          status: 'published',
          org_id: 'o1',
          org_name: 'Org1',
          created_at: '2026-09-01',
          updated_at: '2026-09-02',
        },
        {
          id: 's2',
          slug: 'beta',
          business_name: 'Beta',
          status: 'draft',
          org_id: 'o2',
          org_name: 'Org2',
          created_at: '2026-08-01',
          updated_at: '2026-08-02',
        },
      ],
    });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/ops/sites?q=ac&sort=created_at&dir=desc&page=1&limit=50',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: unknown[];
      total: number;
      page: number;
      pages: number;
    };
    expect(json.rows).toHaveLength(2);
    expect(json.total).toBe(2);
    expect(json.page).toBe(1);
    expect(json.pages).toBe(1);
  });

  it('400s on an invalid sort column (enum-guarded — no SQL-injection surface)', async () => {
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/ops/sites?sort=created_at%3BDROP',
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('400s on an out-of-range limit (clamped <= 100)', async () => {
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/ops/sites?limit=9999',
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});

describe('site operations — ops/users list (Phase 1b)', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists platform-wide user accounts with total + pagination shape', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/COUNT\(\*\)/i.test(sql)) return { n: 3 };
      return null;
    });
    mockDbQuery.mockResolvedValue({
      data: [
        { id: 'u1', email: 'a@x.com', display_name: 'Aa', is_super_admin: 0, created_at: '2026-09-01', updated_at: '2026-09-02' },
      ],
    });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/ops/users?q=a&sort=created_at&dir=desc&page=1&limit=50',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: unknown[]; total: number; pages: number };
    expect(json.rows).toHaveLength(1);
    expect(json.total).toBe(3);
    expect(json.pages).toBe(1);
  });

  it('400s on an invalid sort column (enum-guarded — no SQL-injection surface)', async () => {
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/ops/users?sort=email%3BDROP',
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('400s on an out-of-range limit (clamped <= 100)', async () => {
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/ops/users?limit=9999', makeEnv());
    expect(res.status).toBe(400);
  });
});

describe('cost categories', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists every cost row', async () => {
    mockDbQuery.mockResolvedValue({
      data: [{ slug: 'ai_generation', markup_factor: 2, billable: 1 }],
    });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/cost-categories', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { categories: unknown[] };
    expect(json.categories).toHaveLength(1);
  });

  it('PATCH 404s when the slug does not exist', async () => {
    // gate returns super-admin; the existence check returns null.
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      return null; // category lookup → not found
    });
    const res = await req(
      makeApp(SUPER),
      'PATCH',
      '/api/super-admin/cost-categories/nope',
      makeEnv(),
      {
        markup_factor: 2,
      },
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('NOT_FOUND');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('PATCH 400s on empty body (refine: at least one field)', async () => {
    const res = await req(
      makeApp(SUPER),
      'PATCH',
      '/api/super-admin/cost-categories/ai_generation',
      makeEnv(),
      {},
    );
    expect(res.status).toBe(400);
  });

  it('PATCH 400s when markup_factor is out of range', async () => {
    const res = await req(
      makeApp(SUPER),
      'PATCH',
      '/api/super-admin/cost-categories/ai_generation',
      makeEnv(),
      {
        markup_factor: 99, // max is 5
      },
    );
    expect(res.status).toBe(400);
  });

  it('PATCH 200s and updates when the slug exists', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM cost_categories WHERE slug/i.test(sql)) return { slug: 'ai_generation' };
      return null;
    });
    const res = await req(
      makeApp(SUPER),
      'PATCH',
      '/api/super-admin/cost-categories/ai_generation',
      makeEnv(),
      {
        markup_factor: 2.5,
        billable: false,
      },
    );
    expect(res.status).toBe(200);
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    const patchArg = mockDbUpdate.mock.calls[0][2] as Record<string, unknown>;
    expect(patchArg.markup_factor).toBe(2.5);
    expect(patchArg.billable).toBe(0); // boolean coerced to 0/1
    expect(patchArg.updated_by).toBe('admin-1');
  });

  it('PATCH 500s (not a stale-row 200) when the UPDATE fails', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM cost_categories WHERE slug/i.test(sql)) return { slug: 'ai_generation' };
      return null;
    });
    mockDbUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    const res = await req(
      makeApp(SUPER),
      'PATCH',
      '/api/super-admin/cost-categories/ai_generation',
      makeEnv(),
      { markup_factor: 2.5 },
    );
    expect(res.status).toBe(500);
  });
});

// ─── Wallets list + drill-down + stats ───────────────────────────────────────

describe('wallets + stats reads', () => {
  beforeEach(grantSuperAdmin);

  it('GET wallets returns the list', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ org_id: 'org-7', balance_cents: 1000 }] });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/wallets?q=org&status=active&limit=5',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { wallets: unknown[] };
    expect(json.wallets).toHaveLength(1);
  });

  it('GET wallet transactions returns ledger + wallet', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'tx-1', direction: 'debit' }] });
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM wallet_accounts WHERE org_id/i.test(sql)) return { id: 'w-1', balance_cents: 500 };
      return null;
    });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/wallets/org-7/transactions?days=14&direction=debit',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { wallet: unknown; transactions: unknown[] };
    expect(json.transactions).toHaveLength(1);
    expect(json.wallet).toMatchObject({ id: 'w-1' });
  });

  it('GET stats returns aggregates with zero-fallback totals', async () => {
    mockDbQuery.mockResolvedValue({ data: [] });
    // every dbQueryOne in stats (totals, monthlyRevenue, topupsToday) → null
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      return null;
    });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/stats?days=30', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { days: number; totals: Record<string, number> };
    expect(json.days).toBe(30);
    expect(json.totals.total_orgs).toBe(0);
    expect(json.totals.monthly_revenue_cents).toBe(0);
    expect(json.totals.topups_today).toBe(0);
  });

  it('GET transactions feed returns the rows', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'tx-9' }] });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/transactions?days=7&limit=10',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { transactions: unknown[] };
    expect(json.transactions).toHaveLength(1);
  });
});

// ─── Manual adjustment ───────────────────────────────────────────────────────

describe('manual wallet adjustment', () => {
  beforeEach(grantSuperAdmin);

  it('POST 200s and delegates to the wallet service with the actor id', async () => {
    mockManualAdjustment.mockResolvedValue({
      ok: true,
      balance_after: 1500,
      transaction_id: 'tx-1',
    });
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/manual-adjustment', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 500,
      reason: 'goodwill credit',
    });
    expect(res.status).toBe(200);
    expect(mockManualAdjustment).toHaveBeenCalledTimes(1);
    const [, orgId, opts] = mockManualAdjustment.mock.calls[0];
    expect(orgId).toBe('org-7');
    expect(opts).toMatchObject({
      amount_cents: 500,
      reason: 'goodwill credit',
      actor_id: 'admin-1',
    });
  });

  it('POST 400s when amount_cents is zero', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/manual-adjustment', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 0,
      reason: 'nope',
    });
    expect(res.status).toBe(400);
    expect(mockManualAdjustment).not.toHaveBeenCalled();
  });

  it('POST 400s when reason is too short', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/manual-adjustment', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 100,
      reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('propagates a service error to a 500 envelope', async () => {
    mockManualAdjustment.mockRejectedValue(new Error('wallet exploded'));
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/manual-adjustment', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 100,
      reason: 'valid reason',
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('INTERNAL_ERROR');
  });
});

// ─── whoami ──────────────────────────────────────────────────────────────────

describe('whoami', () => {
  it('returns is_super_admin:true once the gate passes', async () => {
    grantSuperAdmin();
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/whoami', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { is_super_admin: boolean; user_id: string };
    expect(json.is_super_admin).toBe(true);
    expect(json.user_id).toBe('admin-1');
  });
});

// ─── Email suppression list (§42/ADR-0019) ───────────────────────────────────

describe('email suppression list', () => {
  it('lists suppressions for a super-admin', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [
        {
          email: 'gone@x.com',
          reason: 'bounce',
          sub_type: 'Permanent',
          source_message_id: 'm1',
          created_at: '2026-06-23',
        },
      ],
    });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/email-suppressions', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[]; count: number };
    expect(json.count).toBe(1);
    expect(json.data).toHaveLength(1);
  });

  it('rejects a non-super-admin (gate) on the list route', async () => {
    mockDbQueryOne.mockResolvedValue(null); // not a super-admin
    const res = await req(
      makeApp(REGULAR),
      'GET',
      '/api/super-admin/email-suppressions',
      makeEnv(),
    );
    expect([401, 403]).toContain(res.status);
  });

  it('un-suppresses an address (lowercased) for a super-admin', async () => {
    grantSuperAdmin();
    const res = await req(
      makeApp(SUPER),
      'DELETE',
      '/api/super-admin/email-suppressions/Gone%40X.com',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { removed: boolean; email: string };
    expect(json.email).toBe('gone@x.com');
    expect(typeof json.removed).toBe('boolean');
  });

  it('rejects a non-super-admin (gate) on the un-suppress route', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    const res = await req(
      makeApp(REGULAR),
      'DELETE',
      '/api/super-admin/email-suppressions/x%40y.com',
      makeEnv(),
    );
    expect([401, 403]).toContain(res.status);
  });
});

// ─── Pro grant / revoke ──────────────────────────────────────────────────────

describe('pro grant / revoke', () => {
  beforeEach(grantSuperAdmin);

  it('grant 200s and writes the update', async () => {
    const env = makeEnv();
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/pro/grant', env, {
      user_id: 'u1',
      reason: 'lifetime',
    });
    expect(res.status).toBe(200);
    expect((env.DB as unknown as { prepare: jest.Mock }).prepare).toHaveBeenCalled();
  });

  it('grant 400s on an invalid reason enum', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/pro/grant', makeEnv(), {
      user_id: 'u1',
      reason: 'because-i-said-so',
    });
    expect(res.status).toBe(400);
  });

  it('revoke 200s', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/pro/revoke', makeEnv(), {
      user_id: 'u1',
      reason: 'expired',
    });
    expect(res.status).toBe(200);
  });
});

// ─── Coupons ─────────────────────────────────────────────────────────────────

describe('coupons', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists coupons', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ code: 'LAUNCH50' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/coupons', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { coupons: unknown[] };
    expect(json.coupons).toHaveLength(1);
  });

  it('POST 201s on a valid coupon', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/coupons', makeEnv(), {
      code: 'LAUNCH50',
      kind: 'pct',
      amount: 50,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('LAUNCH50');
  });

  it('POST 400s when the code violates the regex', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/coupons', makeEnv(), {
      code: 'lower-case-bad', // regex requires [A-Z0-9_-]
      kind: 'pct',
      amount: 50,
    });
    expect(res.status).toBe(400);
  });

  it('DELETE 200s', async () => {
    const res = await req(makeApp(SUPER), 'DELETE', '/api/super-admin/coupons/LAUNCH50', makeEnv());
    expect(res.status).toBe(200);
  });
});

// ─── Refunds ─────────────────────────────────────────────────────────────────

describe('refunds', () => {
  beforeEach(grantSuperAdmin);
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('POST 201s and inserts a pending refund row (no charge id → no Stripe call)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/refunds', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 999,
      reason: 'duplicate',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; status: string };
    expect(json.status).toBe('pending');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockDbInsert.mock.calls[0][1]).toBe('refunds');
  });

  it('POST with stripe_charge_id calls the Stripe Refunds API + records the real refund', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 're_123', status: 'succeeded' }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/refunds',
      makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }),
      { org_id: 'org-7', amount_cents: 500, reason: 'duplicate', stripe_charge_id: 'ch_1' },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { status: string; stripe_refund_id: string };
    expect(json.status).toBe('succeeded');
    expect(json.stripe_refund_id).toBe('re_123');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/refunds',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POST 502s when Stripe rejects the refund', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'No such charge' } }),
    }) as unknown as typeof fetch;
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/refunds',
      makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }),
      { org_id: 'org-7', amount_cents: 500, reason: 'fraudulent', stripe_charge_id: 'ch_bad' },
    );
    expect(res.status).toBe(502);
  });

  it('POST 400s on an invalid reason', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/refunds', makeEnv(), {
      org_id: 'org-7',
      amount_cents: 999,
      reason: 'just-because',
    });
    expect(res.status).toBe(400);
  });

  it('GET lists refunds', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'ref-1' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/refunds', makeEnv());
    expect(res.status).toBe(200);
  });
});

// ─── Broadcasts + announcements ──────────────────────────────────────────────

describe('broadcasts + announcements', () => {
  beforeEach(grantSuperAdmin);

  it('POST broadcast 201s', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/broadcasts', makeEnv(), {
      channel: 'email',
      segment: { plan: 'pro' },
      body_md: 'A meaningful update body.',
    });
    expect(res.status).toBe(201);
    expect(mockDbInsert.mock.calls[0][1]).toBe('broadcasts');
  });

  it('POST broadcast 400s on an invalid channel', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/broadcasts', makeEnv(), {
      channel: 'carrier-pigeon',
      segment: {},
      body_md: 'hello there friend',
    });
    expect(res.status).toBe(400);
  });

  it('POST announcement 201s', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/announcements', makeEnv(), {
      title: 'Scheduled maintenance',
      body_md: 'We will be down briefly.',
    });
    expect(res.status).toBe(201);
    expect(mockDbInsert.mock.calls[0][1]).toBe('announcements');
  });

  it('GET announcements lists', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'ann-1' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/announcements', makeEnv());
    expect(res.status).toBe(200);
  });
});

// ─── Feature flags ───────────────────────────────────────────────────────────

describe('feature flags', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists flags', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ key: 'new_flag' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/feature-flags', makeEnv());
    expect(res.status).toBe(200);
  });

  it('POST writes the GLOBAL flag_overrides row the runtime resolver reads', async () => {
    const env = makeEnv();
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/feature-flags', env, {
      key: 'new_flag',
      enabled_globally: true,
      rollout_pct: 25,
    });
    expect(res.status).toBe(200);
    const prepare = (env.DB as unknown as { prepare: jest.Mock }).prepare;
    // The mutation MUST hit the canonical flag_overrides table at global scope —
    // NOT the orphaned feature_flags table (whose prod schema 500'd the toggle).
    const sqls = prepare.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO flag_overrides/i.test(s) && /'global'/.test(s))).toBe(
      true,
    );
    expect(sqls.some((s) => /INSERT INTO feature_flags\b/i.test(s))).toBe(false);
    // The cache for this key is busted so isFlagOn sees the change immediately.
    expect((env.CACHE_KV as unknown as { list: jest.Mock }).list).toHaveBeenCalled();
  });

  it('POST 400s when rollout_pct exceeds 100', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/feature-flags', makeEnv(), {
      key: 'new_flag',
      rollout_pct: 250,
    });
    expect(res.status).toBe(400);
  });
});

// ─── Impersonation ───────────────────────────────────────────────────────────

describe('impersonation', () => {
  beforeEach(grantSuperAdmin);

  it('POST start 200s and resolves the target org', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM memberships/i.test(sql)) return { org_id: 'org-target' };
      return null;
    });
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/impersonate', makeEnv(), {
      target_user_id: 'u1',
      reason: 'support ticket #42',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      session_id: string;
      target_org_id: string;
      token: string | null;
    };
    expect(json.target_org_id).toBe('org-target');
    expect(json.token).toBeNull(); // no secret configured → token omitted (fail-soft)
    expect(mockDbInsert.mock.calls[0][1]).toBe('impersonation_sessions');
    // The target-org resolution MUST exclude soft-deleted memberships — else a super-admin
    // could be scoped into an org the target user DEPARTED (removal soft-deletes it).
    const memSql = mockDbQueryOne.mock.calls
      .map((call) => String(call[1]))
      .find((s) => /FROM memberships/i.test(s));
    expect(memSql).toMatch(/deleted_at IS NULL/i);
  });

  it('issues a 30-min signed token when IMPERSONATION_JWT_SECRET is set', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM memberships/i.test(sql)) return { org_id: 'org-target' };
      return null;
    });
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/impersonate',
      makeEnv({ IMPERSONATION_JWT_SECRET: 'x'.repeat(40) }),
      { target_user_id: 'u1', reason: 'support ticket #42' },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string; expires_in: number };
    expect(json.token.split('.')).toHaveLength(3); // header.payload.signature
    expect(json.expires_in).toBe(1800);
  });

  it('POST start 400s when reason is too short', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/impersonate', makeEnv(), {
      target_user_id: 'u1',
      reason: 'no',
    });
    expect(res.status).toBe(400);
  });

  it('POST end 200s', async () => {
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/impersonate/imp-1/end',
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });
});

// ─── Ledger-write failure: no lying 2xx when the row silently drops ──────────
// dbInsert returns {error} without throwing; a bare await used to return a
// lying 201/200 while the row dropped. refunds preserves the recoverable
// stripe_refund_id (the Stripe refund already moved money — cannot compensate);
// broadcasts/announcements/impersonation throw so nothing is faked.

describe('ledger-write failure (no lying 2xx)', () => {
  beforeEach(grantSuperAdmin);
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('refund: 500 + preserves stripe_refund_id in the audit when the DB insert fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 're_orphan', status: 'succeeded' }),
    }) as unknown as typeof fetch;
    mockDbInsert.mockResolvedValueOnce({ error: 'db down' }); // refunds insert fails
    const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' });
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/refunds', env, {
      org_id: 'org-7',
      amount_cents: 500,
      reason: 'duplicate',
      stripe_charge_id: 'ch_1',
    });
    expect(res.status).toBe(500); // NOT a lying 201
    // The already-issued Stripe refund id MUST survive in the audit trail so the
    // orphaned refund is recoverable (money is out; the DB row is not).
    const auditedFailure = (
      env.DB as unknown as { _stmt: { bind: jest.Mock } }
    )._stmt.bind.mock.calls.some((args) => (args as unknown[]).includes('refund_record_failed'));
    expect(auditedFailure).toBe(true);
  });

  it('broadcast: 500 when the DB insert fails (not a lying 201)', async () => {
    mockDbInsert.mockResolvedValueOnce({ error: 'db down' });
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/broadcasts', makeEnv(), {
      channel: 'email',
      segment: { plan: 'pro' },
      body_md: 'A meaningful update body.',
    });
    expect(res.status).toBe(500);
  });

  it('announcement: 500 when the DB insert fails (not a lying 201)', async () => {
    mockDbInsert.mockResolvedValueOnce({ error: 'db down' });
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/announcements', makeEnv(), {
      title: 'Scheduled maintenance',
      body_md: 'We will be down briefly.',
    });
    expect(res.status).toBe(500);
  });

  it('impersonate: 500 + NO token issued when the session-record insert fails', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin/i.test(sql)) return { is_super_admin: 1 };
      if (/FROM memberships/i.test(sql)) return { org_id: 'org-target' };
      return null;
    });
    mockDbInsert.mockResolvedValueOnce({ error: 'db down' }); // impersonation_sessions insert fails
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/impersonate',
      // Secret IS set — so if the code did NOT throw it would mint a token + 200.
      // The 500 proves un-auditable impersonation is blocked BEFORE token issue.
      makeEnv({ IMPERSONATION_JWT_SECRET: 'x'.repeat(40) }),
      { target_user_id: 'u1', reason: 'support ticket #42' },
    );
    expect(res.status).toBe(500);
  });
});

// ─── Moderation ──────────────────────────────────────────────────────────────

describe('moderation', () => {
  beforeEach(grantSuperAdmin);

  it('GET lists open reports', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'mod-1', status: 'open' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/moderation', makeEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: unknown[] };
    expect(json.items).toHaveLength(1);
  });

  it('POST resolve 200s', async () => {
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/moderation/m-1/resolve',
      makeEnv(),
      {
        status: 'resolved',
        notes: 'handled',
      },
    );
    expect(res.status).toBe(200);
  });

  it('POST resolve 400s on an invalid status enum', async () => {
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/moderation/m-1/resolve',
      makeEnv(),
      {
        status: 'maybe-later',
      },
    );
    expect(res.status).toBe(400);
  });
});

// ─── AI blocklist + tags + rate limits + audit + cache ───────────────────────

describe('blocklist / tags / rate-limits / audit / cache', () => {
  beforeEach(grantSuperAdmin);

  it('GET ai-blocklist lists patterns', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 1, pattern: 'badword' }] });
    const res = await req(makeApp(SUPER), 'GET', '/api/super-admin/ai-blocklist', makeEnv());
    expect(res.status).toBe(200);
  });

  it('POST ai-blocklist 201s', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/ai-blocklist', makeEnv(), {
      pattern: 'badword',
    });
    expect(res.status).toBe(201);
  });

  it('POST tag 200s', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/tags', makeEnv(), {
      org_id: 'org-7',
      tag: 'vip',
    });
    expect(res.status).toBe(200);
  });

  it('POST tag 400s on an invalid tag format', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/tags', makeEnv(), {
      org_id: 'org-7',
      tag: 'NOT VALID!',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE tag 200s', async () => {
    const res = await req(makeApp(SUPER), 'DELETE', '/api/super-admin/tags', makeEnv(), {
      org_id: 'org-7',
      tag: 'vip',
    });
    expect(res.status).toBe(200);
  });

  it('POST rate-limit-override 201s', async () => {
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/rate-limit-overrides',
      makeEnv(),
      {
        route_pattern: '/api/sites/*',
        limit_per_min: 200,
      },
    );
    expect(res.status).toBe(201);
  });

  it('POST rate-limit-override 400s when limit is below 1', async () => {
    const res = await req(
      makeApp(SUPER),
      'POST',
      '/api/super-admin/rate-limit-overrides',
      makeEnv(),
      {
        route_pattern: '/api/sites/*',
        limit_per_min: 0,
      },
    );
    expect(res.status).toBe(400);
  });

  it('GET audit lists rows', async () => {
    mockDbQuery.mockResolvedValue({ data: [{ id: 'au-1', action: 'pro_grant' }] });
    const res = await req(
      makeApp(SUPER),
      'GET',
      '/api/super-admin/audit?days=14&action=pro_grant',
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { audit: unknown[] };
    expect(json.audit).toHaveLength(1);
  });

  it('POST cache purge 200s for a single key', async () => {
    const env = makeEnv();
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/cache/purge', env, {
      key: 'host:foo',
    });
    expect(res.status).toBe(200);
    expect((env.CACHE_KV as unknown as { delete: jest.Mock }).delete).toHaveBeenCalledWith(
      'host:foo',
    );
  });

  it('POST cache purge 200s for purge-all (best-effort)', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/cache/purge', makeEnv(), {
      all: true,
    });
    expect(res.status).toBe(200);
  });

  it('POST cache purge 400s when neither key nor all is provided', async () => {
    const res = await req(makeApp(SUPER), 'POST', '/api/super-admin/cache/purge', makeEnv(), {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('BAD_REQUEST');
  });
});
