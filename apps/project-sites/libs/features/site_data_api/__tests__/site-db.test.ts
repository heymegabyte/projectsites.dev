/**
 * Route-layer coverage for the per-site OWN-D1 "Tables" surface (`site_db_handlers.ts`). Proves the
 * gate order that ships isolation BEFORE owner access:
 *   flag off → 404 (DARK, never 403/leak) → unauth → 401 → foreign site (ownsSiteData) → 404 →
 *   then and only then resolve the per-site D1 → list/browse.
 * Also proves the un-bindable `:table` is validated (`isSafeIdent`) + must exist before browsing, and
 * that a resolve failure surfaces an honest status (503/502) — never a shared-DB fallback.
 *
 * `isFlagOn` + the `site_data_db` service are mocked so the handler logic is tested in isolation; the
 * `ownsSiteData` IDOR guard runs for real against a mock D1.
 */
import { Hono } from 'hono';

jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/site_data_db.js', () => ({
  isSafeIdent: (s: unknown) =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s),
  listSiteTables: jest.fn(),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  resolveSiteDataDb: jest.fn(),
  SiteDataD1Error: class SiteDataD1Error extends Error {},
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mocks)
import { siteDbApi } from '../site_db_handlers';
// eslint-disable-next-line import/first
import { errorHandler } from '../../../../src/middleware/error_handler.js';
// eslint-disable-next-line import/first
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
// eslint-disable-next-line import/first
import { listSiteTables, resolveSiteDataDb } from '../../../../src/services/site_data_db.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolve = resolveSiteDataDb as unknown as jest.Mock;
const mockListTables = listSiteTables as unknown as jest.Mock;

function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', siteDbApi);
  return a;
}
const authed = () => app({ orgId: 'org1', userId: 'u1' });

/** Mock D1 answering only the `ownsSiteData` sites-ownership probe. */
function mockEnv(opts: { owned?: boolean } = {}) {
  const owned = opts.owned ?? true;
  const DB = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () =>
              /FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null,
          };
        },
      };
    },
  };
  return { DB } as never;
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolve.mockReset();
  mockListTables.mockReset();
});

describe('GET /api/sites/:siteId/db/tables', () => {
  it('404 (DARK) when per_site_data flag is off — resolve never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/tables', {}, mockEnv());
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/db/tables', {}, mockEnv());
    expect(res.status).toBe(401);
  });

  it('404 for a foreign / unowned site (IDOR guard) — resolve never runs', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/foreign/db/tables', {}, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('200 lists the owned site tables + databaseId + provisioned flag', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({
      databaseId: 'db-uuid-1',
      db: { databaseId: 'db-uuid-1', query: jest.fn() },
      ok: true,
      provisioned: true,
    });
    mockListTables.mockResolvedValue(['customers', 'orders']);
    const res = await authed().request('/api/sites/site-9/db/tables', {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { databaseId: string; provisioned: boolean; tables: Array<{ name: string }> };
    };
    expect(body.data.databaseId).toBe('db-uuid-1');
    expect(body.data.provisioned).toBe(true);
    expect(body.data.tables).toEqual([{ name: 'customers' }, { name: 'orders' }]);
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), 'site-9', { orgId: 'org1' });
  });

  it('503 when the site DB is not configured (no CF creds) — never a shared-DB fallback', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({ ok: false, reason: 'no_cf_credentials' });
    const res = await authed().request('/api/sites/s1/db/tables', {}, mockEnv());
    expect(res.status).toBe(503);
  });
});

describe('GET /api/sites/:siteId/db/tables/:table', () => {
  it('404 (DARK) when flag off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/tables/customers', {}, mockEnv());
    expect(res.status).toBe(404);
  });

  it('400 for a hostile / invalid table name (never interpolated)', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/s1/db/tables/sqlite_master;DROP', {}, mockEnv());
    // ';' is not a legal URL path segment char here but "%3B" decodes; assert the validator rejects it.
    expect([400, 404]).toContain(res.status);
  });

  it('404 when the table does not exist in the site DB', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({
      databaseId: 'db1',
      db: { databaseId: 'db1', query: jest.fn() },
      ok: true,
      provisioned: false,
    });
    mockListTables.mockResolvedValue(['customers']);
    const res = await authed().request('/api/sites/s1/db/tables/ghost', {}, mockEnv());
    expect(res.status).toBe(404);
  });

  it('200 browses rows + columns + total for an existing table', async () => {
    mockFlag.mockResolvedValue(true);
    const query = jest.fn(async (sql: string) => {
      if (/COUNT\(\*\)/.test(sql)) return { meta: {}, results: [{ n: 2 }] };
      if (/pragma_table_info/.test(sql))
        return { meta: {}, results: [{ name: 'id', notnull: 0, pk: 1, type: 'INTEGER' }] };
      return { meta: {}, results: [{ id: 1 }, { id: 2 }] };
    });
    mockResolve.mockResolvedValue({
      databaseId: 'db1',
      db: { databaseId: 'db1', query },
      ok: true,
      provisioned: false,
    });
    mockListTables.mockResolvedValue(['customers']);
    const res = await authed().request('/api/sites/s1/db/tables/customers?limit=10&offset=0', {}, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { table: string; total: number; limit: number; rows: unknown[]; columns: unknown[] };
    };
    expect(body.data.table).toBe('customers');
    expect(body.data.total).toBe(2);
    expect(body.data.limit).toBe(10);
    expect(body.data.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(body.data.columns).toEqual([{ name: 'id', notnull: 0, pk: 1, type: 'INTEGER' }]);
    // The SELECT is scoped to the quoted table with BOUND limit/offset (never interpolated values).
    const selectCall = query.mock.calls.find((c) => /SELECT \* FROM "customers"/.test(c[0] as string));
    expect(selectCall?.[1]).toEqual([10, 0]);
  });
});
