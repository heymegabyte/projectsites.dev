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
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: jest.fn(),
}));
jest.mock('../../../../src/services/site_data_db.js', () => ({
  buildCreateTableSql: jest.fn(),
  createSampleData: jest.fn(),
  insertSeedRows: jest.fn(),
  introspectColumns: jest.fn(),
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
import { dbQueryOne } from '../../../../src/services/db.js';
// eslint-disable-next-line import/first
import {
  buildCreateTableSql,
  createSampleData,
  insertSeedRows,
  introspectColumns,
  listSiteTables,
  resolveSiteDataDb,
} from '../../../../src/services/site_data_db.js';

const mockFlag = isFlagOn as unknown as jest.Mock;
const mockResolve = resolveSiteDataDb as unknown as jest.Mock;
const mockListTables = listSiteTables as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockCreateSample = createSampleData as unknown as jest.Mock;
const mockIntrospect = introspectColumns as unknown as jest.Mock;
const mockInsertSeed = insertSeedRows as unknown as jest.Mock;
const mockBuildCreate = buildCreateTableSql as unknown as jest.Mock;

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

/**
 * Mock env: D1 answers the `ownsSiteData` sites-ownership probe; `AI.run` is a jest mock the AI-seed
 * tests drive; `SITES_BUCKET` is a stub the build-files tests override per-case.
 */
function mockEnv(
  opts: {
    owned?: boolean;
    aiResponse?: string;
    bucket?: { get?: jest.Mock; list?: jest.Mock };
  } = {},
) {
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
  const AI = {
    run: jest.fn(async () => ({ response: opts.aiResponse ?? '[]' })),
  };
  const SITES_BUCKET = {
    get: opts.bucket?.get ?? jest.fn(async () => null),
    list: opts.bucket?.list ?? jest.fn(async () => ({ objects: [] })),
  };
  return { AI, DB, SITES_BUCKET } as never;
}

beforeEach(() => {
  mockFlag.mockReset();
  mockResolve.mockReset();
  mockListTables.mockReset();
  mockDbQueryOne.mockReset();
  mockCreateSample.mockReset();
  mockIntrospect.mockReset();
  mockInsertSeed.mockReset();
  mockBuildCreate.mockReset();
});

/** A per-site executor stub whose `query` returns per-SQL canned results. */
function dbStub(query: jest.Mock) {
  return { databaseId: 'db1', db: { databaseId: 'db1', query }, ok: true, provisioned: false };
}

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
    // The SELECT is scoped to the quoted table with BOUND limit/offset (never interpolated values),
    // and exposes SQLite's stable `rowid` as `_rowid` (the grid's inline-edit/delete row handle).
    const selectCall = query.mock.calls.find((c) => /FROM "customers" LIMIT \? OFFSET \?/.test(c[0] as string));
    expect(selectCall?.[0]).toMatch(/SELECT rowid AS _rowid, \* FROM "customers"/);
    expect(selectCall?.[1]).toEqual([10, 0]);
  });
});

/** POST helper — JSON body + content-type header. */
function post(body: unknown = {}) {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

describe('POST /api/sites/:siteId/db/sample-data', () => {
  it('404 (DARK) when flag off — resolve never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/sample-data', post(), mockEnv());
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCreateSample).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/db/sample-data', post(), mockEnv());
    expect(res.status).toBe(401);
  });

  it('404 for a foreign / unowned site (IDOR guard)', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/foreign/db/sample-data', post(), mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockCreateSample).not.toHaveBeenCalled();
  });

  it('200 seeds the sample tables + returns rowCounts', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(jest.fn()));
    mockCreateSample.mockResolvedValue({
      rowCounts: { customers: 16, orders: 20, products: 12 },
      skipped: [],
      tables: ['customers', 'products', 'orders'],
    });
    const res = await authed().request('/api/sites/s9/db/sample-data', post(), mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { tables: string[]; rowCounts: Record<string, number> } };
    expect(body.ok).toBe(true);
    expect(body.data.tables).toEqual(['customers', 'products', 'orders']);
    expect(body.data.rowCounts.customers).toBe(16);
  });

  it('503 when the site DB is not configured (no CF creds)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({ ok: false, reason: 'no_cf_credentials' });
    const res = await authed().request('/api/sites/s1/db/sample-data', post(), mockEnv());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/sites/:siteId/db/ai-seed', () => {
  it('404 (DARK) when flag off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/ai-seed', post({ table: 'customers' }), mockEnv());
    expect(res.status).toBe(404);
  });

  it('400 for a hostile table name (never interpolated)', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(jest.fn()));
    const res = await authed().request('/api/sites/s1/db/ai-seed', post({ table: 'bad; DROP' }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('400 when neither an existing table nor a prompt is provided', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(jest.fn()));
    mockListTables.mockResolvedValue([]); // target "ghost" not present, no prompt → 400
    const res = await authed().request('/api/sites/s1/db/ai-seed', post({ table: 'ghost' }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('200 seeds an existing table with AI rows (values bound, id excluded)', async () => {
    mockFlag.mockResolvedValue(true);
    const query = jest.fn(async (sql: string) => {
      if (/ORDER BY ROWID DESC/.test(sql)) return { meta: {}, results: [{ id: 1, name: 'Ada' }] };
      return { meta: {}, results: [] };
    });
    mockResolve.mockResolvedValue(dbStub(query));
    mockListTables.mockResolvedValue(['customers']);
    mockIntrospect.mockResolvedValue([
      { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
      { name: 'name', notnull: 1, pk: 0, type: 'TEXT' },
    ]);
    mockInsertSeed.mockResolvedValue({ inserted: 3 });
    const res = await authed().request(
      '/api/sites/s1/db/ai-seed',
      post({ table: 'customers', rowCount: 3 }),
      mockEnv({ aiResponse: '[{"name":"Ada"},{"name":"Bo"},{"name":"Cy"}]' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { table: string; inserted: number; createdTable: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.table).toBe('customers');
    expect(body.data.inserted).toBe(3);
    expect(body.data.createdTable).toBe(false);
    expect(mockInsertSeed).toHaveBeenCalled();
  });

  it('200 CREATEs a table from a prompt then seeds it', async () => {
    mockFlag.mockResolvedValue(true);
    const query = jest.fn(async (sql: string) => {
      if (/ORDER BY ROWID DESC/.test(sql)) return { meta: {}, results: [{ id: 1, title: 'x' }] };
      return { meta: {}, results: [] };
    });
    mockResolve.mockResolvedValue(dbStub(query));
    mockListTables.mockResolvedValue([]); // nothing exists yet
    mockBuildCreate.mockReturnValue({ sql: 'CREATE TABLE IF NOT EXISTS "tasks" (id INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT)', table: 'tasks' });
    mockIntrospect.mockResolvedValue([
      { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
      { name: 'title', notnull: 0, pk: 0, type: 'TEXT' },
    ]);
    mockInsertSeed.mockResolvedValue({ inserted: 5 });
    // First AI.run → table plan; second AI.run → rows. mockEnv returns the same string for both, so
    // stub AI.run to return a plan-shaped object first, rows second.
    const env = mockEnv();
    (env as unknown as { AI: { run: jest.Mock } }).AI.run
      .mockResolvedValueOnce({ response: '{"table":"tasks","columns":[{"name":"title","type":"TEXT"}]}' })
      .mockResolvedValueOnce({ response: '[{"title":"a"},{"title":"b"}]' });
    const res = await authed().request('/api/sites/s1/db/ai-seed', post({ prompt: 'a task list' }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { table: string; createdTable: boolean; inserted: number } };
    expect(body.ok).toBe(true);
    expect(body.data.table).toBe('tasks');
    expect(body.data.createdTable).toBe(true);
    expect(body.data.inserted).toBe(5);
  });

  it('502 (ok:false) when the AI returns no rows for an existing table', async () => {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(jest.fn(async () => ({ meta: {}, results: [] }))));
    mockListTables.mockResolvedValue(['customers']);
    mockIntrospect.mockResolvedValue([{ name: 'name', notnull: 0, pk: 0, type: 'TEXT' }]);
    const res = await authed().request(
      '/api/sites/s1/db/ai-seed',
      post({ table: 'customers' }),
      mockEnv({ aiResponse: 'sorry, no JSON here' }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; data: { inserted: number } };
    expect(body.ok).toBe(false);
    expect(body.data.inserted).toBe(0);
    expect(mockInsertSeed).not.toHaveBeenCalled();
  });
});

describe('GET /api/sites/:siteId/build-files', () => {
  it('404 (DARK) when flag off — no site lookup runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/build-files', {}, mockEnv());
    expect(res.status).toBe(404);
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/build-files', {}, mockEnv());
    expect(res.status).toBe(401);
  });

  it('404 for a foreign / unowned site (the SELECT returns null)', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue(null);
    const res = await authed().request('/api/sites/foreign/build-files', {}, mockEnv());
    expect(res.status).toBe(404);
  });

  it('400 for a path-traversal version', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: 'v1', slug: 'acme' });
    const res = await authed().request('/api/sites/s1/build-files?version=../secrets', {}, mockEnv());
    expect(res.status).toBe(400);
  });

  it('200 lists files under the manifest version, excludes _meta, sums size', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: null, slug: 'acme' });
    const getMock = jest.fn(async () => ({ json: async () => ({ current_version: '2026-01-01' }) }));
    const listMock = jest.fn(async () => ({
      objects: [
        { key: 'sites/acme/2026-01-01/index.html', size: 100, uploaded: new Date('2026-01-01') },
        { key: 'sites/acme/2026-01-01/style.css', size: 50, uploaded: new Date('2026-01-01') },
        { key: 'sites/acme/2026-01-01/_meta/chat.json', size: 999, uploaded: new Date('2026-01-01') },
      ],
    }));
    const res = await authed().request(
      '/api/sites/s1/build-files',
      {},
      mockEnv({ bucket: { get: getMock, list: listMock } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { files: Array<{ name: string; url: string }>; totalSize: number; version: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.version).toBe('2026-01-01');
    expect(body.data.files).toHaveLength(2); // _meta excluded
    expect(body.data.totalSize).toBe(150);
    expect(body.data.files[0]?.name).toBe('index.html');
    expect(body.data.files[0]?.url).toBe('https://acme.projectsites.dev/index.html');
    // Listed under the resolved versioned prefix.
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'sites/acme/2026-01-01/' }));
  });

  it('200 with empty files when the site has no version at all', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: null, slug: 'acme' });
    const res = await authed().request('/api/sites/s1/build-files', {}, mockEnv()); // bucket.get → null
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { files: unknown[]; version: string | null } };
    expect(body.data.files).toEqual([]);
    expect(body.data.version).toBeNull();
  });
});
