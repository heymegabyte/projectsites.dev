/**
 * POST /api/admin/d1/:databaseId/profile-table — one-scan column profiling. Locks:
 *   - super-admin + flag gate (non-super / flag-off / unauth → 404; CF never called),
 *   - bad table name → 400,
 *   - unknown table (empty DDL) → 404 (CF profile query never runs),
 *   - happy path → 200 with per-column stats + rowsRead cost, columns from the SERVER-fetched DDL,
 *   - profile query failure → 502.
 */

import { Hono } from 'hono';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));
const mockDbQueryOne = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

import { d1Manager } from '../handlers.js';

const REAL_UUID = 'ea3e839a-c641-4861-ae30-dfc63bff8032';
const PATH = `/api/admin/d1/${REAL_UUID}/profile-table`;
const mockFetch = jest.fn();

type AppEnv = { DB: unknown; CF_ACCOUNT_ID: string; CLOUDFLARE_EMAIL: string; CLOUDFLARE_API_KEY: string };
function makeEnv(): AppEnv {
  return { DB: {}, CF_ACCOUNT_ID: 'acct-123', CLOUDFLARE_EMAIL: 'e@x.com', CLOUDFLARE_API_KEY: 'gk' };
}
function appWith(userId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', d1Manager);
  return app;
}
function post(app: Hono, body: unknown, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(
    PATH,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env as never,
  );
}
/** A CF `/query` response: `result` = [{ results, meta }]. */
function cfQuery(rows: unknown[], meta: Record<string, unknown> = {}): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [{ results: rows, success: true, meta }] }),
  } as unknown as Response);
}

const DDL = 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  // call 1 = DDL fetch, call 2 = the profile aggregate (with rows_read in meta).
  mockFetch
    .mockResolvedValueOnce(cfQuery([{ sql: DDL }]))
    .mockResolvedValueOnce(
      cfQuery(
        [{ c: 100, n0: 100, d0: 100, mn0: 1, mx0: 100, av0: 50.5, n1: 90, d1: 42, mn1: 'a', mx1: 'z' }],
        { rows_read: 100 },
      ),
    );
});

describe('profile-table — gating', () => {
  it('404 when flag off (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await post(appWith('u'), { table: 'users' })).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when NOT super-admin (CF never called)', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await post(appWith('owner'), { table: 'users' })).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('404 when unauthenticated', async () => {
    expect((await post(appWith(), { table: 'users' })).status).toBe(404);
  });
});

describe('profile-table — validation + happy path', () => {
  it('400 on an invalid table identifier', async () => {
    const res = await post(appWith('super'), { table: "x'; DROP TABLE y;--" });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404 when the table does not exist (empty DDL); the profile query never runs', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(cfQuery([])); // sqlite_master finds nothing
    const res = await post(appWith('super'), { table: 'ghost' });
    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the DDL lookup, no profile scan
  });

  it('200 with per-column stats + rowsRead, columns from the server-fetched DDL', async () => {
    const res = await post(appWith('super'), { table: 'users' });
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      rowCount: number;
      rowsRead: number | null;
      columns: { name: string; nullCount: number; distinct: number; avg: number | null }[];
    }>();
    expect(body.ok).toBe(true);
    expect(body.rowCount).toBe(100);
    expect(body.rowsRead).toBe(100); // scan cost surfaced from meta
    expect(body.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(body.columns[0].distinct).toBe(100);
    expect(body.columns[0].avg).toBe(50.5); // numeric col
    expect(body.columns[1].nullCount).toBe(10); // 100 - 90
    expect(body.columns[1].avg).toBeNull(); // text col
    // The profile aggregate is a single scan over the real table (bound identifiers).
    const [, opts] = mockFetch.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(opts.body).sql).toContain('FROM "users"');
    expect(JSON.parse(opts.body).sql).toContain('COUNT(DISTINCT "id")');
  });

  it('502 when the profile query fails', async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(cfQuery([{ sql: DDL }]))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    expect((await post(appWith('super'), { table: 'users' })).status).toBe(502);
  });
});
