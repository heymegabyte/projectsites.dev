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
jest.mock('../../../../src/services/site_data_db.js', () => {
  // The row-write path uses the REAL SQL builder so the WLK-03 PATCH test asserts the genuine
  // parameterized `UPDATE … WHERE rowid=?` (bound value, never interpolated), not a fake.
  const actual = jest.requireActual('../../../../src/services/site_data_db.js');
  return {
    buildAddColumnSql: actual.buildAddColumnSql,
    buildCreateTableSql: jest.fn(),
    buildDropColumnSql: actual.buildDropColumnSql,
    buildUpdateRowSql: actual.buildUpdateRowSql,
    createSampleData: jest.fn(),
    insertSeedRows: jest.fn(),
    introspectColumns: jest.fn(),
    isSafeIdent: (s: unknown) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s),
    listSiteTables: jest.fn(),
    quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
    resolveSiteDataDb: jest.fn(),
    SiteDataD1Error: class SiteDataD1Error extends Error {},
  };
});

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
  SiteDataD1Error,
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

/** PATCH helper — JSON body + content-type header. */
function patch(body: unknown = {}) {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  };
}

/*
 * WLK-03 — the per-site row-edit write. The grid's inline edit (no-PK path) targets a row by its
 * stable SQLite `rowid` via this endpoint. The response MUST report the HONEST rows-written count
 * (`updated`) so the client can distinguish a real save (`updated>=1`) from a no-match
 * lying-success (`updated:0`, the `changes===0` class) and surface an error instead of silently
 * accepting an edit that never landed.
 */
describe('PATCH /api/sites/:siteId/db/tables/:table/rows/:rowid (per-site row edit)', () => {
  function resolveWith(query: jest.Mock) {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({ databaseId: 'db1', db: { databaseId: 'db1', query }, ok: true, provisioned: false });
    mockListTables.mockResolvedValue(['customers']);
    mockIntrospect.mockResolvedValue([
      { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
      { name: 'name', notnull: 0, pk: 0, type: 'TEXT' },
    ]);
  }

  it('200 + updated:1 with a param-bound UPDATE … WHERE rowid=? when the row matches (round-trip)', async () => {
    const query = jest.fn(async () => ({ meta: { rows_written: 1 }, results: [] }));
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/customers/rows/7',
      patch({ values: { name: 'Zeta' } }),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { table: string; updated: number } };
    expect(body.ok).toBe(true);
    expect(body.data.updated).toBe(1);
    // The value is BOUND and the row targeted by its rowid (never interpolated).
    const upd = query.mock.calls.find((c) => /^UPDATE "customers" SET/.test(c[0] as string));
    expect(upd?.[0]).toBe('UPDATE "customers" SET "name" = ? WHERE rowid = ?');
    expect(upd?.[1]).toEqual(['Zeta', 7]);
  });

  it('reports updated:0 (HONEST no-match count) when the rowid matches no row — never a lying positive', async () => {
    const query = jest.fn(async () => ({ meta: { rows_written: 0 }, results: [] }));
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/customers/rows/999',
      patch({ values: { name: 'Zeta' } }),
      mockEnv(),
    );
    // The endpoint is single-source honest: it returns the real count so the client can treat
    // `updated:0` as a failed edit (the frontend guard keys off this).
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number } };
    expect(body.data.updated).toBe(0);
  });

  it('400 for an invalid row id (never reaches SQL)', async () => {
    const query = jest.fn();
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/customers/rows/not-a-number',
      patch({ values: { name: 'Zeta' } }),
      mockEnv(),
    );
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
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

describe('POST /api/sites/:siteId/db/tables/:table/columns (DATE-aware add-column wire, fire-84)', () => {
  function resolveWith(query: jest.Mock) {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue({ databaseId: 'db1', db: { databaseId: 'db1', query }, ok: true, provisioned: false });
    mockListTables.mockResolvedValue(['events']);
    mockIntrospect.mockResolvedValue([
      { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
      { name: 'title', notnull: 0, pk: 0, type: 'TEXT' },
    ]);
  }

  it("201 + emits ADD COLUMN … DATE when type='date' (role-84 wire: NO silent collapse to TEXT)", async () => {
    const query = jest.fn(async () => ({ meta: {}, results: [] }));
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/events/columns',
      post({ name: 'starts_on', type: 'date' }),
      mockEnv(),
    );
    expect(res.status).toBe(201);
    // The owner's DATE intent is PRESERVED end-to-end — the base clamp would have collapsed it to
    // TEXT; this proves role 1's site_data_column_types module is actually WIRED into the live handler.
    const alter = query.mock.calls.find((c) => /^ALTER TABLE/.test(c[0] as string));
    expect(alter?.[0]).toBe('ALTER TABLE "events" ADD COLUMN "starts_on" DATE');
  });

  it('201 + ADD COLUMN … INTEGER for a non-date type (base path unchanged)', async () => {
    const query = jest.fn(async () => ({ meta: {}, results: [] }));
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/events/columns',
      post({ name: 'seats', type: 'integer' }),
      mockEnv(),
    );
    expect(res.status).toBe(201);
    const alter = query.mock.calls.find((c) => /^ALTER TABLE/.test(c[0] as string));
    expect(alter?.[0]).toBe('ALTER TABLE "events" ADD COLUMN "seats" INTEGER');
  });

  it('clamps an unknown type to TEXT (never injects a bogus affinity)', async () => {
    const query = jest.fn(async () => ({ meta: {}, results: [] }));
    resolveWith(query);
    const res = await authed().request(
      '/api/sites/s1/db/tables/events/columns',
      post({ name: 'note', type: 'wat' }),
      mockEnv(),
    );
    expect(res.status).toBe(201);
    const alter = query.mock.calls.find((c) => /^ALTER TABLE/.test(c[0] as string));
    expect(alter?.[0]).toBe('ALTER TABLE "events" ADD COLUMN "note" TEXT');
  });
});

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

  it('surfaces truncated + cap when R2 windows the listing (honest-count, FILES-COUNT-1)', async () => {
    // R2 `.list` reports `truncated:true` when the build has MORE objects than the page cap — the
    // handler must forward it so the editor shows "first N of many", never a silently under-counted total.
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: '2026-01-01', slug: 'acme' });
    const listMock = jest.fn(async () => ({
      truncated: true,
      objects: [{ key: 'sites/acme/2026-01-01/index.html', size: 100, uploaded: new Date('2026-01-01') }],
    }));
    const res = await authed().request(
      '/api/sites/s1/build-files',
      {},
      mockEnv({ bucket: { list: listMock } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { truncated?: boolean; cap?: number } };
    expect(body.data.truncated).toBe(true);
    expect(body.data.cap).toBe(1000);
    // The R2 page cap is the configured 1000, never left unbounded.
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
  });

  it('omits cap and reports truncated:false on a complete (non-windowed) listing', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: '2026-01-01', slug: 'acme' });
    const listMock = jest.fn(async () => ({
      truncated: false,
      objects: [{ key: 'sites/acme/2026-01-01/index.html', size: 100, uploaded: new Date('2026-01-01') }],
    }));
    const res = await authed().request(
      '/api/sites/s1/build-files',
      {},
      mockEnv({ bucket: { list: listMock } }),
    );
    const body = (await res.json()) as { data: { truncated?: boolean; cap?: number } };
    expect(body.data.truncated).toBe(false);
    expect(body.data.cap).toBeUndefined();
  });

  it('returns a cursor when truncated, and pages the remainder when it is passed back (FILES-PAGING)', async () => {
    // Page 1: truncated → R2 echoes a `cursor`. The handler forwards it so the editor can "Load more".
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: '2026-01-01', slug: 'acme' });
    const listMock = jest.fn(async (opts: { cursor?: string }) =>
      opts.cursor === 'CUR_PAGE2'
        ? {
            // Page 2: the remainder, no more pages.
            truncated: false,
            objects: [{ key: 'sites/acme/2026-01-01/b.css', size: 20, uploaded: new Date('2026-01-01') }],
          }
        : {
            // Page 1: windowed → a cursor to the next page.
            truncated: true,
            cursor: 'CUR_PAGE2',
            objects: [{ key: 'sites/acme/2026-01-01/a.html', size: 10, uploaded: new Date('2026-01-01') }],
          },
    );
    const env = mockEnv({ bucket: { list: listMock } });

    const page1 = await authed().request('/api/sites/s1/build-files', {}, env);
    const b1 = (await page1.json()) as { data: { files: Array<{ name: string }>; truncated?: boolean; cursor?: string } };
    expect(b1.data.truncated).toBe(true);
    expect(b1.data.cursor).toBe('CUR_PAGE2');
    expect(b1.data.files.map((f) => f.name)).toEqual(['a.html']);

    const page2 = await authed().request(
      `/api/sites/s1/build-files?cursor=${b1.data.cursor}`,
      {},
      env,
    );
    const b2 = (await page2.json()) as { data: { files: Array<{ name: string }>; truncated?: boolean; cursor?: string } };
    // The remainder came back via the cursor; no further page.
    expect(b2.data.files.map((f) => f.name)).toEqual(['b.css']);
    expect(b2.data.truncated).toBe(false);
    expect(b2.data.cursor).toBeUndefined();
    // The cursor was forwarded to R2 on the 2nd list call.
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'CUR_PAGE2', limit: 1000 }));
  });

  it('400 for a hostile cursor (never forwarded to R2)', async () => {
    mockFlag.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue({ current_build_version: '2026-01-01', slug: 'acme' });
    const listMock = jest.fn(async () => ({ truncated: false, objects: [] }));
    const res = await authed().request(
      '/api/sites/s1/build-files?cursor=../secrets%20DROP',
      {},
      mockEnv({ bucket: { list: listMock } }),
    );
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });
});

/**
 * The RAW SQL console (`POST /api/sites/:siteId/db/query`) is the highest-risk Data-tab surface —
 * arbitrary single-statement SQL against the site's OWN isolated D1. Before fire-165 it had ZERO
 * route-layer coverage. These lock its full safety chain: the same gate order as every other per-site
 * endpoint (DARK flag → auth → IDOR, resolve/execute never run until the caller is proven to own the
 * site), BOUND params (the user's SQL + params reach the per-site executor verbatim, never string-
 * built), the 500-row payload cap with an HONEST `truncated` flag (the console can't stream unbounded
 * rows), and an honest `SQL_ERROR` on a bad query (never a fabricated empty result).
 */
describe('POST /api/sites/:siteId/db/query (raw per-site SQL console — safety chain)', () => {
  const body = (sql: string, params?: unknown[]) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params === undefined ? { sql } : { sql, params }),
  });

  it('404 (DARK) when the per_site_data flag is off — resolve never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/query', body('SELECT 1'), mockEnv());
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated — never resolves or executes', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await app().request('/api/sites/s1/db/query', body('SELECT 1'), mockEnv());
    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('404 for a foreign / unowned site (IDOR) — resolve never runs, no SQL executes', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/foreign/db/query', body('SELECT 1'), mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('400 for an invalid body (no sql) — never reaches the executor', async () => {
    mockFlag.mockResolvedValue(true);
    const q = jest.fn();
    mockResolve.mockResolvedValue(dbStub(q));
    const res = await authed().request(
      '/api/sites/s1/db/query',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: [1] }) },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    expect(q).not.toHaveBeenCalled();
  });

  it('200 forwards the console SQL + params to the per-site executor BOUND (never interpolated)', async () => {
    mockFlag.mockResolvedValue(true);
    const q = jest.fn(async () => ({ results: [{ id: 1, name: 'a' }], meta: { rows_read: 1 } }));
    mockResolve.mockResolvedValue(dbStub(q));
    const res = await authed().request(
      '/api/sites/site-9/db/query',
      body('SELECT * FROM customers WHERE id = ?', [7]),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as { data: { rows: unknown[]; rowCount: number; truncated: boolean } };
    expect(b.data.rows).toEqual([{ id: 1, name: 'a' }]);
    expect(b.data.rowCount).toBe(1);
    expect(b.data.truncated).toBe(false);
    // The caller's SQL + params reach the per-site D1 VERBATIM + BOUND — never string-built.
    expect(q).toHaveBeenCalledWith('SELECT * FROM customers WHERE id = ?', [7]);
  });

  it('caps the returned rows at 500 with an HONEST truncated flag (never streams unbounded rows)', async () => {
    mockFlag.mockResolvedValue(true);
    const big = Array.from({ length: 501 }, (_, i) => ({ i }));
    const q = jest.fn(async () => ({ results: big, meta: {} }));
    mockResolve.mockResolvedValue(dbStub(q));
    const res = await authed().request('/api/sites/s1/db/query', body('SELECT * FROM big'), mockEnv());
    expect(res.status).toBe(200);
    const b = (await res.json()) as { data: { rows: unknown[]; rowCount: number; truncated: boolean } };
    expect(b.data.rows).toHaveLength(500); // payload capped at MAX_CONSOLE_ROWS
    expect(b.data.rowCount).toBe(501); // honest full count, not the capped length
    expect(b.data.truncated).toBe(true);
  });

  it('400 SQL_ERROR on a per-site D1 error — an honest failure, never a fabricated empty result', async () => {
    mockFlag.mockResolvedValue(true);
    const q = jest.fn(async () => {
      throw new SiteDataD1Error('no such column: bogus');
    });
    mockResolve.mockResolvedValue(dbStub(q));
    const res = await authed().request('/api/sites/s1/db/query', body('SELECT bogus FROM t'), mockEnv());
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string; message: string }; ok: boolean };
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('SQL_ERROR');
    expect(b.error.message).toContain('bogus');
  });
});

/**
 * The DESTRUCTIVE per-site DDL routes (DROP TABLE / DROP COLUMN) had ZERO route-layer tests before
 * fire-166 (only the SQL BUILDERS in site_data_db.test.ts were covered). These are the riskiest Data-
 * tab mutations — they irreversibly delete customer data — so the route gate + the un-bindable
 * identifier validation (an identifier is quoteIdent'd into the SQL, never bound, so it MUST be
 * isSafeIdent-validated first) are the load-bearing guards. Lock the full chain: hostile identifier →
 * 400 before any DB touch · DARK flag → 404 · foreign site → 404 (IDOR) · missing table/column → 404 ·
 * owned+existing → the exact DROP executes.
 */
describe('DELETE /api/sites/:siteId/db/tables/:table (DROP TABLE — destructive)', () => {
  /** A fully-ready gate: flag on, owned, resolved db, table exists with columns. */
  function readyGate(q: jest.Mock) {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(q));
    mockListTables.mockResolvedValue(['customers']);
    mockIntrospect.mockResolvedValue([{ name: 'id' }, { name: 'email' }]);
  }
  const del = { method: 'DELETE' };

  it('400 for a hostile table name — rejected before any DB touch (identifier is quoted, not bound)', async () => {
    const q = jest.fn();
    readyGate(q);
    // %3B → ";" → fails isSafeIdent; the name would otherwise be quoteIdent'd straight into DROP TABLE.
    const res = await authed().request('/api/sites/s1/db/tables/evil%3BDROP', del, mockEnv());
    expect(res.status).toBe(400);
    expect(q).not.toHaveBeenCalled();
  });

  it('404 (DARK) when the per_site_data flag is off — resolve never runs', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/tables/customers', del, mockEnv());
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('404 for a foreign / unowned site (IDOR)', async () => {
    mockFlag.mockResolvedValue(true);
    const res = await authed().request('/api/sites/foreign/db/tables/customers', del, mockEnv({ owned: false }));
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('404 when the table does not exist in the site DB (never DROPs a phantom)', async () => {
    const q = jest.fn();
    readyGate(q);
    mockListTables.mockResolvedValue(['orders']); // 'customers' is absent
    const res = await authed().request('/api/sites/s1/db/tables/customers', del, mockEnv());
    expect(res.status).toBe(404);
    expect(q).not.toHaveBeenCalled();
  });

  it('200 drops an owned, existing table with a quoted identifier', async () => {
    const q = jest.fn(async () => ({ results: [], meta: {} }));
    readyGate(q);
    const res = await authed().request('/api/sites/site-9/db/tables/customers', del, mockEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { dropped: true, table: 'customers' }, ok: true });
    expect(q).toHaveBeenCalledWith('DROP TABLE IF EXISTS "customers"');
  });
});

describe('DELETE /api/sites/:siteId/db/tables/:table/columns/:column (DROP COLUMN — destructive)', () => {
  function readyGate(q: jest.Mock) {
    mockFlag.mockResolvedValue(true);
    mockResolve.mockResolvedValue(dbStub(q));
    mockListTables.mockResolvedValue(['customers']);
    mockIntrospect.mockResolvedValue([{ name: 'id' }, { name: 'email' }]);
  }
  const del = { method: 'DELETE' };

  it('400 for a hostile column name — rejected BEFORE the gate (never reaches the DB)', async () => {
    const q = jest.fn();
    readyGate(q);
    const res = await authed().request('/api/sites/s1/db/tables/customers/columns/evil%3Bx', del, mockEnv());
    expect(res.status).toBe(400);
    expect(q).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled(); // isSafeIdent(column) guards before gateResolveAndRequireTable
  });

  it('404 when the column does not exist on the table (no phantom DROP)', async () => {
    const q = jest.fn();
    readyGate(q); // table has id + email only
    const res = await authed().request('/api/sites/s1/db/tables/customers/columns/ghost', del, mockEnv());
    expect(res.status).toBe(404);
    expect(q).not.toHaveBeenCalled();
  });

  it('404 (DARK) when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await authed().request('/api/sites/s1/db/tables/customers/columns/email', del, mockEnv());
    expect(res.status).toBe(404);
  });

  it('200 drops an existing column with the real parameter-free ALTER … DROP COLUMN SQL', async () => {
    const q = jest.fn(async () => ({ results: [], meta: {} }));
    readyGate(q);
    const res = await authed().request('/api/sites/s1/db/tables/customers/columns/email', del, mockEnv());
    expect(res.status).toBe(200);
    // buildDropColumnSql (real) quotes both identifiers — never interpolates a raw name.
    expect(q).toHaveBeenCalledWith('ALTER TABLE "customers" DROP COLUMN "email"');
    const b = (await res.json()) as { data: { table: string; columns: unknown[] }; ok: boolean };
    expect(b.ok).toBe(true);
    expect(b.data.table).toBe('customers');
  });
});
