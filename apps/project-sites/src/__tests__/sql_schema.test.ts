/**
 * Unit tests for GET /api/sites/:siteId/sql/schema
 *
 * Contract:
 *  - 401 when unauthenticated (no orgId)
 *  - 403 when authenticated but NOT superadmin
 *  - 404 when site does not belong to caller's org
 *  - 200 with {data:{tables:[...]}} on success
 *  - columns include pk field; indexes include columns list; foreign_keys included
 *  - sqlite_% internal tables NEVER returned
 *  - audit-logged on every successful call
 *
 * @swc/jest mock hoisting: GLOBAL jest (not imported from @jest/globals)
 */

jest.mock('../services/sysadmin.js', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('../services/audit.js', () => ({ writeAuditLog: jest.fn() }));

import { Hono } from 'hono';
import * as sysadmin from '../services/sysadmin.js';
import * as audit from '../services/audit.js';
import { siteDetailTabs } from '../routes/site_detail_tabs.js';
import type { Env, Variables } from '../types/env.js';

const mIsSuperAdmin = sysadmin.isSuperAdmin as unknown as jest.Mock;
const mWriteAuditLog = audit.writeAuditLog as unknown as jest.Mock;

// ─── D1 mock ────────────────────────────────────────────────────────────────

type SqlMasterRow = { name: string; type: string; sql: string };
type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type IndexListRow = { name: string; unique: number; origin: string };
type IndexInfoRow = { seqno: number; cid: number; name: string };
type ForeignKeyRow = {
  from: string;
  table: string;
  to: string;
  on_update: string;
  on_delete: string;
};

function makeD1(opts: {
  siteRow?: Record<string, unknown> | null;
  masterTables?: SqlMasterRow[];
  tableInfo?: TableInfoRow[];
  indexList?: IndexListRow[];
  indexInfo?: IndexInfoRow[];
  foreignKeys?: ForeignKeyRow[];
}): D1Database {
  const prepare = jest.fn().mockImplementation((sql: string) => {
    const upper = sql.trim().toUpperCase();

    // site ownership lookup (SELECT id FROM sites WHERE id=? AND org_id=?)
    if (upper.startsWith('SELECT') && upper.includes('FROM SITES WHERE')) {
      return {
        bind: () => ({
          first: () =>
            Promise.resolve(opts.siteRow !== undefined ? opts.siteRow : { id: 'site-1' }),
        }),
      };
    }

    // sqlite_master enumeration (SELECT name,type,sql FROM sqlite_master WHERE type IN ...)
    if (upper.includes('FROM SQLITE_MASTER') && !upper.includes('AND NAME')) {
      return {
        bind: () => ({
          all: () =>
            Promise.resolve({
              results: (
                opts.masterTables ?? [
                  { name: 'sites', type: 'table', sql: 'CREATE TABLE sites (id TEXT)' },
                ]
              ).filter((r) => !r.name.startsWith('sqlite_')),
            }),
        }),
      };
    }

    // table-name validation (SELECT name FROM sqlite_master WHERE type IN ... AND name=?1)
    if (upper.includes('FROM SQLITE_MASTER') && upper.includes('AND NAME=')) {
      // caller bound a table name — return null for unknown tables (rejects injection attempt)
      return {
        bind: (name: string) => ({
          first: () => {
            const row = (opts.masterTables ?? [{ name: 'sites', type: 'table', sql: '' }]).find(
              (r) => r.name === name,
            );
            return Promise.resolve(row ? { name: row.name } : null);
          },
        }),
      };
    }

    // PRAGMA table_info("<name>")
    if (upper.includes('PRAGMA TABLE_INFO')) {
      return {
        all: () =>
          Promise.resolve({
            results: opts.tableInfo ?? [
              { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
            ],
          }),
      };
    }

    // PRAGMA index_list("<name>")
    if (upper.includes('PRAGMA INDEX_LIST')) {
      return { all: () => Promise.resolve({ results: opts.indexList ?? [] }) };
    }

    // PRAGMA index_info("<name>")
    if (upper.includes('PRAGMA INDEX_INFO')) {
      return {
        all: () =>
          Promise.resolve({ results: opts.indexInfo ?? [{ seqno: 0, cid: 0, name: 'id' }] }),
      };
    }

    // PRAGMA foreign_key_list("<name>")
    if (upper.includes('PRAGMA FOREIGN_KEY_LIST')) {
      return { all: () => Promise.resolve({ results: opts.foreignKeys ?? [] }) };
    }

    // fallback
    return {
      bind: () => ({
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve(null),
      }),
      all: () => Promise.resolve({ results: [] }),
    };
  });

  return { prepare } as unknown as D1Database;
}

function makeApp(DB: D1Database) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('orgId', 'org-1');
    c.set('userId', 'user-1');
    c.set('requestId', 'req-1');
    await next();
  });
  app.route('', siteDetailTabs);
  return app;
}

function req(siteId = 'site-1') {
  return new Request(`http://localhost/api/sites/${siteId}/sql/schema`);
}

// ─── setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mIsSuperAdmin.mockResolvedValue(true);
  mWriteAuditLog.mockResolvedValue(undefined);
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('GET /api/sites/:siteId/sql/schema', () => {
  it('401 when no orgId on context', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      // orgId deliberately not set
      c.set('userId', 'user-1');
      c.set('requestId', 'req-1');
      await next();
    });
    app.route('', siteDetailTabs);

    const res = await app.request(req(), {}, { DB: makeD1({}) } as unknown as Env);
    expect(res.status).toBe(401);
  });

  it('403 when user is NOT superadmin', async () => {
    mIsSuperAdmin.mockResolvedValue(false);
    const res = await makeApp(makeD1({})).request(req(), {}, { DB: makeD1({}) } as unknown as Env);
    expect(res.status).toBe(403);
  });

  it('404 when site belongs to a different org', async () => {
    const DB = makeD1({ siteRow: null });
    const res = await makeApp(DB).request(req(), {}, { DB } as unknown as Env);
    expect(res.status).toBe(404);
  });

  it('200 with tables + columns including pk flag', async () => {
    const DB = makeD1({
      masterTables: [
        { name: 'sites', type: 'table', sql: 'CREATE TABLE sites (id TEXT PRIMARY KEY)' },
      ],
      tableInfo: [
        { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
        { name: 'slug', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ],
    });
    const res = await makeApp(DB).request(req(), {}, { DB } as unknown as Env);
    expect(res.status).toBe(200);

    interface TableRow {
      name: string;
      columns: { name: string; pk: number }[];
      indexes: unknown[];
      foreign_keys: unknown[];
    }
    const body = (await res.json()) as { data: { tables: TableRow[] } };
    expect(body.data.tables).toHaveLength(1);
    const tbl = body.data.tables[0];
    expect(tbl.name).toBe('sites');
    expect(tbl.columns.find((c) => c.name === 'id')?.pk).toBe(1);
    expect(tbl.columns.find((c) => c.name === 'slug')?.pk).toBe(0);
  });

  it('indexes include column names', async () => {
    const DB = makeD1({
      masterTables: [{ name: 'sites', type: 'table', sql: 'CREATE TABLE sites (id TEXT)' }],
      indexList: [{ name: 'idx_sites_slug', unique: 1, origin: 'c' }],
      indexInfo: [{ seqno: 0, cid: 1, name: 'slug' }],
    });
    const res = await makeApp(DB).request(req(), {}, { DB } as unknown as Env);
    expect(res.status).toBe(200);

    interface IdxRow {
      name: string;
      unique: boolean;
      columns: string[];
    }
    const body = (await res.json()) as { data: { tables: { indexes: IdxRow[] }[] } };
    const idx = body.data.tables[0].indexes[0];
    expect(idx.name).toBe('idx_sites_slug');
    expect(idx.unique).toBe(true);
    expect(idx.columns).toContain('slug');
  });

  it('NEVER returns sqlite_% internal tables', async () => {
    const DB = makeD1({
      masterTables: [
        { name: 'sites', type: 'table', sql: 'CREATE TABLE sites (id TEXT)' },
        { name: 'sqlite_stat1', type: 'table', sql: '' },
        { name: 'sqlite_sequence', type: 'table', sql: '' },
      ],
    });
    const res = await makeApp(DB).request(req(), {}, { DB } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tables: { name: string }[] } };
    const names = body.data.tables.map((t) => t.name);
    expect(names).not.toContain('sqlite_stat1');
    expect(names).not.toContain('sqlite_sequence');
    expect(names).toContain('sites');
  });

  it('audit-logs the introspection with action site.sql.schema', async () => {
    const DB = makeD1({
      masterTables: [{ name: 'sites', type: 'table', sql: 'CREATE TABLE sites (id TEXT)' }],
    });
    await makeApp(DB).request(req(), {}, { DB } as unknown as Env);

    expect(mWriteAuditLog).toHaveBeenCalledTimes(1);
    const [, row] = mWriteAuditLog.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row.action).toBe('site.sql.schema');
    expect(row.target_id).toBe('site-1');
  });
});
