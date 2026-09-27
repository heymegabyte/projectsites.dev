/**
 * Unit coverage for the per-site D1 data plane (`services/site_data_db.ts`) — the tenant-isolation
 * FOUNDATION of the Data Platform re-arch. Proves:
 *  1. identifier allowlist (`isSafeIdent` / `quoteIdent`) — the only defense for the un-bindable
 *     table name in a D1 REST query;
 *  2. the resolver REFUSES the shared platform DB ids (`forbidden_shared_db`) even when an
 *     allocation row points at one, and does so WITHOUT issuing any CF call (fails closed);
 *  3. an existing allocation resolves to a REST executor scoped to THAT database id;
 *  4. the executor POSTs to the correct CF D1 `/query` URL + `{sql,params}` body and surfaces CF
 *     errors as `SiteDataD1Error`;
 *  5. lazy provisioning on first access (no allocation yet) + honest failure propagation;
 *  6. `listSiteTables` hides SQLite/D1 internals + drops any unsafe identifier.
 *
 * `d1_provisioner` is mocked so the lazy path never hits the real CF create API; `global.fetch` is
 * mocked for the executor. Uses the real-SQLite harness for `env.DB` (the allocation lookup runs its
 * ACTUAL SQL) per the `verify-against-source-of-truth` discipline.
 */
import { createD1Sqlite } from './helpers/d1_sqlite.js';
import {
  buildCreateTableSql,
  createSampleData,
  FORBIDDEN_DB_IDS,
  insertSeedRows,
  introspectColumns,
  isSafeIdent,
  listSiteTables,
  quoteIdent,
  resolveSiteDataDb,
  SiteDataD1Error,
  type SiteDataD1,
  type SiteTableColumn,
} from '../services/site_data_db.js';

jest.mock('../services/d1_provisioner.js', () => ({
  provisionSiteD1: jest.fn(),
  siteD1Name: (id: string) => `ps-site-${id}`,
}));
// eslint-disable-next-line import/first -- must import AFTER jest.mock (swc hoists the mock)
import { provisionSiteD1 } from '../services/d1_provisioner.js';
const mockProvision = provisionSiteD1 as unknown as jest.Mock;

const ALLOC_DDL = `CREATE TABLE site_database_allocations (
  tenant_id TEXT, site_id TEXT PRIMARY KEY, db_plan TEXT, region TEXT,
  status TEXT, d1_database_id TEXT, d1_database_name TEXT, created_at TEXT, updated_at TEXT
)`;

function envWith(db: unknown, extra: Record<string, unknown> = {}): never {
  return { CF_ACCOUNT_ID: 'acct-123', CF_API_TOKEN: 'tok-abc', DB: db, ...extra } as never;
}

/** A canned successful CF D1 /query fetch response. */
function fetchOk(results: unknown[], meta: Record<string, unknown> = {}) {
  return {
    json: async () => ({ result: [{ meta, results }], success: true }),
    ok: true,
    status: 200,
  } as unknown as Response;
}

beforeEach(() => {
  mockProvision.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
});

describe('isSafeIdent / quoteIdent', () => {
  it.each(['customers', '_x', 'A1_b', 'orders_2024'])('accepts %s', (s) => {
    expect(isSafeIdent(s)).toBe(true);
  });
  it.each(['1x', 'a-b', 'drop; --', 'a b', '', 'a'.repeat(64), 'tbl;DROP'])('rejects %s', (s) => {
    expect(isSafeIdent(s)).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isSafeIdent(undefined)).toBe(false);
    expect(isSafeIdent(5 as never)).toBe(false);
    expect(isSafeIdent(null)).toBe(false);
  });
  it('quotes + escapes embedded double-quotes', () => {
    expect(quoteIdent('customers')).toBe('"customers"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('resolveSiteDataDb — isolation (the security boundary)', () => {
  it('REFUSES a shared platform DB id (forbidden_shared_db) and issues NO CF call', async () => {
    const sharedId = [...FORBIDDEN_DB_IDS][0];
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(
        `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id)
         VALUES ('t','s1','d1_tenant_db','active','${sharedId}')`,
      );
      const res = await resolveSiteDataDb(envWith(h.db), 's1', { orgId: null });
      expect(res).toEqual({ ok: false, reason: 'forbidden_shared_db' });
      expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
      expect(mockProvision).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('resolves an EXISTING per-site allocation to an executor scoped to that id (no provision)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(
        `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id)
         VALUES ('t','s1','d1_tenant_db','active','db-uuid-1')`,
      );
      const res = await resolveSiteDataDb(envWith(h.db), 's1', { orgId: null });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.databaseId).toBe('db-uuid-1');
      expect(res.provisioned).toBe(false);
      expect(res.db.databaseId).toBe('db-uuid-1');
      expect(mockProvision).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('lazily PROVISIONS a blank D1 on first access (no allocation yet)', async () => {
    mockProvision.mockResolvedValue({
      databaseId: 'fresh-db',
      databaseName: 'ps-site-s2',
      ok: true,
      reused: false,
    });
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL); // empty — no row for s2
      const res = await resolveSiteDataDb(envWith(h.db), 's2', { orgId: null });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.databaseId).toBe('fresh-db');
      expect(res.provisioned).toBe(true);
      expect(mockProvision).toHaveBeenCalledWith(expect.anything(), {
        orgId: null,
        siteId: 's2',
        tenantId: 's2',
      });
    } finally {
      h.close();
    }
  });

  it('propagates a provision failure as a typed reason', async () => {
    mockProvision.mockResolvedValue({ ok: false, reason: 'cf_create_failed', status: 500 });
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      const res = await resolveSiteDataDb(envWith(h.db), 's3', { orgId: null });
      expect(res).toEqual({ ok: false, reason: 'provision_failed', status: 500 });
    } finally {
      h.close();
    }
  });

  it('does NOT provision when autoProvision:false and no allocation exists', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      const res = await resolveSiteDataDb(envWith(h.db), 's4', {
        autoProvision: false,
        orgId: null,
      });
      expect(res).toEqual({ ok: false, reason: 'not_provisioned' });
      expect(mockProvision).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('fails closed with no_account_id when CF_ACCOUNT_ID is unset', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(
        `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id)
         VALUES ('t','s5','d1_tenant_db','active','db-uuid-5')`,
      );
      const env = { CF_API_TOKEN: 'tok', DB: h.db } as never; // no CF_ACCOUNT_ID
      const res = await resolveSiteDataDb(env, 's5', { orgId: null });
      expect(res).toEqual({ ok: false, reason: 'no_account_id' });
    } finally {
      h.close();
    }
  });
});

describe('SiteDataD1 executor — CF REST /query plane', () => {
  async function executorFor(): Promise<SiteDataD1> {
    const h = createD1Sqlite();
    h.exec(ALLOC_DDL);
    h.exec(
      `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id)
       VALUES ('t','s1','d1_tenant_db','active','db-uuid-1')`,
    );
    const res = await resolveSiteDataDb(envWith(h.db), 's1', { orgId: null });
    h.close();
    if (!res.ok) throw new Error('resolve failed in setup');
    return res.db;
  }

  it('POSTs to the correct database /query URL with {sql,params} and returns rows+meta', async () => {
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    fetchMock.mockResolvedValue(fetchOk([{ id: 1 }], { rows_read: 1 }));
    const db = await executorFor();
    const out = await db.query('SELECT * FROM "t" WHERE id = ?', [1]);
    expect(out.results).toEqual([{ id: 1 }]);
    expect(out.meta).toEqual({ rows_read: 1 });
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-uuid-1/query',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      params: [1],
      sql: 'SELECT * FROM "t" WHERE id = ?',
    });
  });

  it('throws SiteDataD1Error on a CF error (success:false)', async () => {
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    fetchMock.mockResolvedValue({
      json: async () => ({ errors: [{ message: 'boom' }], success: false }),
      ok: true,
      status: 200,
    } as unknown as Response);
    const db = await executorFor();
    await expect(db.query('SELECT 1')).rejects.toBeInstanceOf(SiteDataD1Error);
  });
});

describe('listSiteTables', () => {
  it('drops SQLite/D1 internals + any unsafe identifier, returns owner tables', async () => {
    const fake: SiteDataD1 = {
      databaseId: 'db-uuid-1',
      query: (async () => ({
        meta: {},
        results: [{ name: 'customers' }, { name: 'bad name' }, { name: 'orders' }],
      })) as SiteDataD1['query'],
    };
    expect(await listSiteTables(fake)).toEqual(['customers', 'orders']);
  });
});

/** Record every (sql, params) a helper issues; drive canned per-SQL results. */
function recordingDb(handler: (sql: string, params?: readonly unknown[]) => unknown = () => ({})): {
  db: SiteDataD1;
  calls: Array<{ sql: string; params?: readonly unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const db: SiteDataD1 = {
    databaseId: 'db-x',
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      const r = handler(sql, params) as { results?: unknown[]; meta?: Record<string, unknown> };
      return { meta: r?.meta ?? {}, results: r?.results ?? [] };
    }) as SiteDataD1['query'],
  };
  return { calls, db };
}

describe('buildCreateTableSql', () => {
  it('builds a safe CREATE with an autoincrement id + clamped types', () => {
    const built = buildCreateTableSql({
      columns: [
        { name: 'title', type: 'TEXT', notnull: true },
        { name: 'qty', type: 'INTEGER' },
        { name: 'weird', type: 'HACK' }, // unknown type → TEXT
      ],
      table: 'tasks',
    });
    expect(built).not.toBeNull();
    expect(built!.table).toBe('tasks');
    expect(built!.sql).toContain('CREATE TABLE IF NOT EXISTS "tasks"');
    expect(built!.sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(built!.sql).toContain('"title" TEXT NOT NULL');
    expect(built!.sql).toContain('"qty" INTEGER');
    expect(built!.sql).toContain('"weird" TEXT'); // clamped
  });

  it('rejects a hostile table name', () => {
    expect(
      buildCreateTableSql({ columns: [{ name: 'a', type: 'TEXT' }], table: 'bad; DROP' }),
    ).toBeNull();
  });

  it('drops a user-supplied id column + hostile column names; null when nothing safe remains', () => {
    const built = buildCreateTableSql({
      columns: [
        { name: 'id', type: 'INTEGER' }, // dropped (id is auto)
        { name: 'name', type: 'TEXT' },
      ],
      table: 'people',
    });
    // Only the auto id + "name" survive.
    expect(built!.sql).toContain('"name" TEXT');
    expect((built!.sql.match(/id INTEGER PRIMARY KEY AUTOINCREMENT/g) ?? []).length).toBe(1);

    expect(
      buildCreateTableSql({ columns: [{ name: 'bad name', type: 'TEXT' }], table: 't' }),
    ).toBeNull();
  });
});

describe('introspectColumns', () => {
  it('binds the table name as a VALUE to pragma_table_info', async () => {
    const { db, calls } = recordingDb(() => ({
      results: [{ name: 'id', notnull: 0, pk: 1, type: 'INTEGER' }],
    }));
    const cols = await introspectColumns(db, 'customers');
    expect(cols).toEqual([{ name: 'id', notnull: 0, pk: 1, type: 'INTEGER' }]);
    expect(calls[0]?.params).toEqual(['customers']); // bound, never interpolated
    expect(calls[0]?.sql).toContain('pragma_table_info(?)');
  });
});

describe('insertSeedRows', () => {
  const cols: SiteTableColumn[] = [
    { name: 'id', notnull: 0, pk: 1, type: 'INTEGER' },
    { name: 'name', notnull: 1, pk: 0, type: 'TEXT' },
    { name: 'age', notnull: 0, pk: 0, type: 'INTEGER' },
  ];

  it('inserts non-PK columns parameterized; ignores hallucinated keys + the PK', async () => {
    const { db, calls } = recordingDb(() => ({ meta: { rows_written: 1 } }));
    const out = await insertSeedRows(db, 'people', cols, [
      { age: 30, id: 999, injected: 'x', name: 'Ada' }, // id + injected ignored
      { name: 'Bo', age: 5 },
    ]);
    expect(out.inserted).toBe(2);
    // Every INSERT binds VALUES (never interpolates them) and never touches id/injected.
    for (const call of calls) {
      expect(call.sql).toMatch(/INSERT INTO "people"/);
      expect(call.sql).not.toContain('injected');
      expect(call.sql).not.toMatch(/\(\s*"?id"?/);
      expect(Array.isArray(call.params)).toBe(true);
    }
    expect(calls[0]?.params).toEqual(['Ada', 30]); // order follows the table's insertable columns
  });

  it('serialises object/array cells to JSON text before binding', async () => {
    const { db, calls } = recordingDb(() => ({ meta: { rows_written: 1 } }));
    await insertSeedRows(db, 'people', cols, [{ name: { nested: true }, age: [1, 2] }]);
    expect(calls[0]?.params).toEqual([JSON.stringify({ nested: true }), JSON.stringify([1, 2])]);
  });

  it('returns 0 when the table has no insertable (non-PK) columns', async () => {
    const { db } = recordingDb();
    const out = await insertSeedRows(
      db,
      't',
      [{ name: 'id', notnull: 0, pk: 1, type: 'INTEGER' }],
      [{ id: 1 }],
    );
    expect(out.inserted).toBe(0);
  });
});

describe('createSampleData', () => {
  it('creates + seeds the three related tables when the DB is blank', async () => {
    const { db, calls } = recordingDb((sql) => {
      if (/COUNT\(\*\)/.test(sql)) return { results: [{ n: 0 }] }; // every table empty
      if (/^INSERT INTO/.test(sql)) return { meta: { rows_written: 1 } };
      return {};
    });
    const res = await createSampleData(db);
    expect(res.tables.sort()).toEqual(['customers', 'orders', 'products']);
    expect(res.skipped).toEqual([]);
    // Row counts land in the promised 12–20 band.
    for (const t of res.tables) {
      expect(res.rowCounts[t]).toBeGreaterThanOrEqual(12);
      expect(res.rowCounts[t]).toBeLessThanOrEqual(20);
    }
    // Each table got a CREATE TABLE IF NOT EXISTS.
    expect(calls.filter((c) => /CREATE TABLE IF NOT EXISTS/.test(c.sql))).toHaveLength(3);
    // Every INSERT is parameterized.
    for (const c of calls.filter((c) => /^INSERT INTO/.test(c.sql))) {
      expect(Array.isArray(c.params)).toBe(true);
      expect(c.sql).toMatch(/VALUES \(\?(?:, \?)*\)/);
    }
  });

  it('SKIPS a table that already has rows (never clobbers)', async () => {
    const { db } = recordingDb((sql) => {
      if (/COUNT\(\*\) AS n FROM "customers"/.test(sql)) return { results: [{ n: 5 }] }; // customers has data
      if (/COUNT\(\*\)/.test(sql)) return { results: [{ n: 0 }] };
      if (/^INSERT INTO/.test(sql)) return { meta: { rows_written: 1 } };
      return {};
    });
    const res = await createSampleData(db);
    expect(res.skipped).toContain('customers');
    expect(res.tables).not.toContain('customers');
    expect(res.rowCounts['customers']).toBeUndefined();
  });
});
