/**
 * Route tests for `POST /api/super-admin/wfp/backfill` — the CROSS-ORG WfP slot
 * backfill (money-path, fire-55). Fire-51 proved the per-org mechanism
 * (scripts/backfill-wfp-slots.mjs → /api/diag/wfp-deploy, org-scoped by
 * assertSiteOwned); this endpoint closes the full-sweep gap from INSIDE the
 * Worker as super-admin.
 *
 * Mocks only the boundaries (db helpers + the deploy service) and drives the
 * REAL superAdmin Hono router + errorHandler, mirroring
 * super_admin_routes.test.ts. Asserts:
 *  - gate-denied: 401 unauthenticated / 403 regular authed user
 *  - dryRun DEFAULTS TRUE ({} body): lists planned ensures, ZERO deploy calls
 *  - batch + cursor: limit caps the page, full page → nextCursor, cursor resumes
 *  - cross-org: each site's OWN org_id is passed to deploySiteToWfp
 *  - idempotent skip: fully-slotted site → skipped counted, never an error
 *  - failure isolation: one failing site lands in failed[], batch continues
 *  - .strict() body: unknown keys + out-of-range limit → 400
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(async () => ({ error: null, changes: 0 })),
}));

jest.mock('../services/wfp_site_hosting.js', () => ({
  deploySiteToWfp: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { superAdmin } from '../routes/super_admin.js';
import { dbQuery, dbQueryOne } from '../services/db.js';
import { deploySiteToWfp } from '../services/wfp_site_hosting.js';

const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockDeploy = deploySiteToWfp as unknown as jest.Mock;

const PATH = '/api/super-admin/wfp/backfill';

// ─── Boundary stubs (mirrors super_admin_routes.test.ts) ─────────────────────

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

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: makeDb(),
    ...overrides,
  } as unknown as Env;
}

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

function req(app: App, env: Env, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return app.request(PATH, init, env, makeCtx());
}

const SUPER: Partial<Variables> = { userId: 'admin-1', orgId: 'org-admin', requestId: 'req-1' };
const REGULAR: Partial<Variables> = { userId: 'user-9', orgId: 'org-9', requestId: 'req-9' };

/** Make requireSuperAdmin treat the caller as a super-admin. */
function grantSuperAdmin() {
  mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
    if (/is_super_admin.*FROM\s+users/i.test(sql)) return { is_super_admin: 1 };
    return null;
  });
}

/** A candidate row as the selection query returns it. */
function site(
  id: string,
  orgId: string,
  slug: string,
  hasPreview: 0 | 1,
  hasProduction: 0 | 1,
): Record<string, unknown> {
  return { id, org_id: orgId, slug, has_preview: hasPreview, has_production: hasProduction };
}

interface Envelope {
  dryRun: boolean;
  processed: number;
  ensured: number;
  skipped: number;
  failed: Array<{ siteId: string; error: string }>;
  planned: Array<{ siteId: string; slug: string; slots: string[] }>;
  nextCursor: string | null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ data: [], error: null });
  mockDbQueryOne.mockResolvedValue(null);
  mockDeploy.mockResolvedValue({ ok: true, assetCount: 1, version: 'v1' });
});

// ─── Gate (the crux — privesc prevention) ────────────────────────────────────

describe('POST /api/super-admin/wfp/backfill — gate', () => {
  it('401s an unauthenticated caller', async () => {
    const res = await req(makeApp(), makeEnv(), {});
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('UNAUTHORIZED');
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('403s a regular authed (non-super-admin) user', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (/is_super_admin.*FROM\s+users/i.test(sql)) return { is_super_admin: 0 };
      return null;
    });
    const res = await req(makeApp(REGULAR), makeEnv(), {});
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe('FORBIDDEN');
    expect(mockDeploy).not.toHaveBeenCalled();
  });
});

// ─── dryRun default (safe by default) ────────────────────────────────────────

describe('dryRun defaults TRUE', () => {
  it('an empty {} body plans the ensures WITHOUT calling the deploy service', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [site('s1', 'o1', 'alpha', 0, 0), site('s2', 'o2', 'beta', 1, 0)],
      error: null,
    });
    const res = await req(makeApp(SUPER), makeEnv(), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as Envelope;
    expect(json.dryRun).toBe(true);
    expect(json.processed).toBe(2);
    expect(json.ensured).toBe(2); // would-be-ensured
    expect(json.skipped).toBe(0);
    expect(json.failed).toEqual([]);
    expect(json.planned).toEqual([
      { siteId: 's1', slug: 'alpha', slots: ['preview', 'production'] },
      { siteId: 's2', slug: 'beta', slots: ['production'] },
    ]);
    expect(mockDeploy).not.toHaveBeenCalled();
  });
});

// ─── Live run: cross-org ensure of exactly the MISSING slots ─────────────────

describe('live run (dryRun: false)', () => {
  it('ensures each missing slot with the SITE OWN org_id (cross-org)', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [site('s1', 'o1', 'alpha', 0, 0), site('s2', 'o2', 'beta', 1, 0)],
      error: null,
    });
    const env = makeEnv();
    const res = await req(makeApp(SUPER), env, { dryRun: false });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Envelope;
    expect(json.dryRun).toBe(false);
    expect(json.processed).toBe(2);
    expect(json.ensured).toBe(2);
    expect(json.failed).toEqual([]);
    // Exactly the missing slots, each carrying its OWN site's org id (never the caller's).
    expect(mockDeploy.mock.calls.map((c: unknown[]) => [c[1], c[2]])).toEqual([
      ['s1', { orgId: 'o1', slot: 'preview' }],
      ['s1', { orgId: 'o1', slot: 'production' }],
      ['s2', { orgId: 'o2', slot: 'production' }],
    ]);
    // The run is audit-logged (super_admin_audit INSERT through env.DB.prepare).
    const db = env.DB as unknown as { prepare: jest.Mock };
    const auditSql = db.prepare.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(auditSql).toContain('super_admin_audit');
  });

  it('counts an already-fully-provisioned site as skipped, never an error', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [site('s1', 'o1', 'alpha', 1, 1), site('s2', 'o2', 'beta', 0, 1)],
      error: null,
    });
    const res = await req(makeApp(SUPER), makeEnv(), { dryRun: false });
    const json = (await res.json()) as Envelope;
    expect(json.processed).toBe(2);
    expect(json.skipped).toBe(1);
    expect(json.ensured).toBe(1);
    expect(json.failed).toEqual([]);
    // Only s2's missing preview slot is deployed; s1 is untouched.
    expect(mockDeploy.mock.calls.map((c: unknown[]) => [c[1], c[2]])).toEqual([
      ['s2', { orgId: 'o2', slot: 'preview' }],
    ]);
  });

  it('isolates a per-site failure: failed[] records it, the batch continues', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [
        site('s1', 'o1', 'alpha', 1, 0),
        site('s2', 'o2', 'beta', 1, 0),
        site('s3', 'o3', 'gamma', 1, 0),
      ],
      error: null,
    });
    mockDeploy.mockImplementation(async (_env: unknown, siteId: string) =>
      siteId === 's2'
        ? { ok: false, error: 'empty_build' }
        : { ok: true, assetCount: 1, version: 'v1' },
    );
    const res = await req(makeApp(SUPER), makeEnv(), { dryRun: false });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Envelope;
    expect(json.processed).toBe(3);
    expect(json.ensured).toBe(2);
    expect(json.failed).toEqual([{ siteId: 's2', error: 'production: empty_build' }]);
    // s3 still ran after s2 failed — isolation proven.
    expect(mockDeploy.mock.calls.map((c: unknown[]) => c[1])).toEqual(['s1', 's2', 's3']);
  });

  it('fails closed when the site-selection query errors (no lying-empty success)', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({ data: [], error: 'D1_ERROR: no such table' });
    const res = await req(makeApp(SUPER), makeEnv(), { dryRun: false });
    expect(res.status).toBe(500);
    expect(mockDeploy).not.toHaveBeenCalled();
  });
});

// ─── Batch + cursor ──────────────────────────────────────────────────────────

describe('batch + cursor', () => {
  it('a FULL page returns nextCursor = last site id; limit rides into the query', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [site('s1', 'o1', 'alpha', 0, 0), site('s2', 'o2', 'beta', 0, 0)],
      error: null,
    });
    const res = await req(makeApp(SUPER), makeEnv(), { limit: 2 });
    const json = (await res.json()) as Envelope;
    expect(json.nextCursor).toBe('s2');
    const [, , params] = mockDbQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(params).toContain(2); // the limit bound
  });

  it('a PARTIAL page returns nextCursor null', async () => {
    grantSuperAdmin();
    mockDbQuery.mockResolvedValue({
      data: [site('s1', 'o1', 'alpha', 0, 0)],
      error: null,
    });
    const res = await req(makeApp(SUPER), makeEnv(), { limit: 2 });
    const json = (await res.json()) as Envelope;
    expect(json.nextCursor).toBeNull();
  });

  it('cursor resumes AFTER the given site id (keyset)', async () => {
    grantSuperAdmin();
    const res = await req(makeApp(SUPER), makeEnv(), { cursor: 's2' });
    expect(res.status).toBe(200);
    const [, sql, params] = mockDbQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('s.id > ?');
    expect(params).toContain('s2');
  });

  it('orgId narrows the sweep to one org', async () => {
    grantSuperAdmin();
    const res = await req(makeApp(SUPER), makeEnv(), { orgId: 'o42' });
    expect(res.status).toBe(200);
    const [, sql, params] = mockDbQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('s.org_id = ?');
    expect(params).toContain('o42');
  });
});

// ─── Zod .strict() body ──────────────────────────────────────────────────────

describe('body validation (.strict())', () => {
  it('400s an unknown key', async () => {
    grantSuperAdmin();
    const res = await req(makeApp(SUPER), makeEnv(), { dryRun: false, nope: 1 });
    expect(res.status).toBe(400);
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('400s a limit above the 100 cap', async () => {
    grantSuperAdmin();
    const res = await req(makeApp(SUPER), makeEnv(), { limit: 500 });
    expect(res.status).toBe(400);
    expect(mockDeploy).not.toHaveBeenCalled();
  });
});
