/**
 * D1 data-insights — pure row-count query builder/parser + the GET /insights handler (super-admin,
 * per-table row counts in one bounded round-trip + structural counts).
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
import { buildRowCountQuery, parseRowCounts, INSIGHTS_TABLE_CAP } from '../insights.js';

// ─── Pure module ──────────────────────────────────────────────────────────────
describe('buildRowCountQuery / parseRowCounts', () => {
  it('emits one COUNT(*) scalar subquery per table, quoted', () => {
    const { sql, used } = buildRowCountQuery(['users', 'orders']);
    expect(used).toEqual(['users', 'orders']);
    expect(sql).toBe(
      'SELECT (SELECT COUNT(*) FROM "users") AS "c0", (SELECT COUNT(*) FROM "orders") AS "c1"',
    );
  });
  it('returns sql:null for no tables (structure-only insights)', () => {
    expect(buildRowCountQuery([])).toEqual({ sql: null, used: [] });
  });
  it('caps the counted tables + quotes a hostile name safely', () => {
    const many = Array.from({ length: INSIGHTS_TABLE_CAP + 3 }, (_, i) => `t${i}`);
    expect(buildRowCountQuery(many).used).toHaveLength(INSIGHTS_TABLE_CAP);
    expect(buildRowCountQuery(['a") FROM x;--']).sql).toContain('"a"") FROM x;--"');
  });
  it('parseRowCounts aligns c{i} → {name,rows}; empty table = 0 (legit)', () => {
    expect(parseRowCounts({ c0: 12, c1: 0 }, ['a', 'b'])).toEqual([
      { name: 'a', rows: 12 },
      { name: 'b', rows: 0 },
    ]);
    expect(parseRowCounts(undefined, ['a'])).toEqual([{ name: 'a', rows: 0 }]);
  });
});

// ─── Handler ────────────────────────────────────────────────────────────────
const REAL_UUID = 'ea3e839a-c641-4861-ae30-dfc63bff8032';
const PATH = `/api/admin/d1/${REAL_UUID}/insights`;
const mockFetch = jest.fn();
type AppEnv = { DB: unknown; CF_ACCOUNT_ID: string; CLOUDFLARE_EMAIL: string; CLOUDFLARE_API_KEY: string };
function makeEnv(): AppEnv {
  return { DB: {}, CF_ACCOUNT_ID: 'acct', CLOUDFLARE_EMAIL: 'e@x.com', CLOUDFLARE_API_KEY: 'gk' };
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
const get = (app: Hono, env = makeEnv()) => app.request(PATH, {}, env as never);
function cfQuery(rows: unknown[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [{ results: rows, success: true }] }),
  } as unknown as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

describe('GET /api/admin/d1/:databaseId/insights', () => {
  it('404 when flag off / not super-admin (CF never called)', async () => {
    mockIsFlagOn.mockResolvedValueOnce(false);
    expect((await get(appWith('u'))).status).toBe(404);
    mockDbQueryOne.mockResolvedValueOnce({ is_super_admin: 0 });
    expect((await get(appWith('owner'))).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns per-table row counts + structural counts + total', async () => {
    // call 1 = catalog; call 2 = the row-count query
    mockFetch
      .mockResolvedValueOnce(
        cfQuery([
          { type: 'table', name: 'users' },
          { type: 'table', name: 'orders' },
          { type: 'view', name: 'v1' },
          { type: 'index', name: 'idx_users' },
        ]),
      )
      .mockResolvedValueOnce(cfQuery([{ c0: 100, c1: 0 }]));
    const res = await get(appWith('super'));
    expect(res.status).toBe(200);
    const body = await res.json<{
      found: boolean;
      tables: { name: string; rows: number }[];
      counts: { table: number; view: number; index: number; trigger: number };
      totalRows: number;
      capped: boolean;
    }>();
    expect(body.found).toBe(true);
    expect(body.tables).toEqual([
      { name: 'users', rows: 100 },
      { name: 'orders', rows: 0 }, // empty table surfaced honestly
    ]);
    expect(body.counts).toEqual({ table: 2, view: 1, index: 1, trigger: 0 });
    expect(body.totalRows).toBe(100);
    expect(body.capped).toBe(false);
    // The row-count query used the SERVER catalog's quoted table names.
    const [, opts] = mockFetch.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(opts.body).sql).toContain('(SELECT COUNT(*) FROM "users")');
  });

  it('an empty database (no tables) → structural-only, no row-count query fired', async () => {
    mockFetch.mockResolvedValueOnce(cfQuery([])); // empty catalog
    const res = await get(appWith('super'));
    expect(res.status).toBe(200);
    const body = await res.json<{ tables: unknown[]; totalRows: number }>();
    expect(body.tables).toEqual([]);
    expect(body.totalRows).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the catalog, no count query
  });
});
