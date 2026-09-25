/**
 * @file Unit tests for the pure D1 Overview helpers — byte/count formatting (null → "—", never a
 * fabricated 0) and database labelling.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyExportResponse,
  columnNullLabel,
  columnTypeLabel,
  dbLabel,
  filterSchemaObjects,
  formatBytes,
  formatCount,
  isBrowsableObject,
  incomingForeignKeys,
  buildErdModel,
  ERD_NODE_W,
  ERD_NODE_H,
  ERD_GAP_X,
  ERD_GAP_Y,
  ERD_PAD,
  parseCreateTableColumns,
  parseForeignKeys,
  parseIndexColumns,
  schemaCountsLabel,
  timeTravelInfo,
  buildDataInsights,
} from './d1-browser-logic';
import type { D1SchemaObjectSummary } from '~/lib/embed/embedded-mode';

const obj = (name: string, type: D1SchemaObjectSummary['type'] = 'table'): D1SchemaObjectSummary => ({
  type,
  name,
  tableName: name,
  sql: `CREATE ${type.toUpperCase()} ${name} (id TEXT)`,
});

describe('formatBytes', () => {
  it('scales bytes → B/KB/MB/GB (binary)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(33_067_008)).toBe('31.5 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
  });
  it('renders unavailable (null / undefined / non-finite / negative) as "—"', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('formatCount', () => {
  it('formats integers with thousands separators; real 0 stays 0', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(1024)).toBe('1,024');
  });
  it('renders unavailable (null / undefined / non-finite) as "—"', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('dbLabel', () => {
  it('shows the name, falling back to the id when blank', () => {
    expect(dbLabel({ id: 'ea3e', name: 'prod-db' })).toBe('prod-db');
    expect(dbLabel({ id: 'ea3e', name: '   ' })).toBe('ea3e');
    expect(dbLabel({ id: 'ea3e', name: '' })).toBe('ea3e');
  });
});

describe('classifyExportResponse (the export poll-loop decision core)', () => {
  it('done — only when complete AND a signedUrl is present', () => {
    const action = classifyExportResponse({
      ok: true,
      data: { status: 'complete', signedUrl: 'https://cf/dump.sql', filename: 'db.sql', note: '' },
    });
    expect(action.kind).toBe('done');
    expect(action.kind === 'done' && action.data.signedUrl).toBe('https://cf/dump.sql');
  });

  it('NEVER done on a complete WITHOUT a signedUrl (no fabricated download)', () => {
    const action = classifyExportResponse({ ok: true, data: { status: 'complete', note: '' } });
    expect(action.kind).toBe('error');
  });

  it('processing — carries the resume bookmark', () => {
    const action = classifyExportResponse({
      ok: true,
      data: { status: 'processing', bookmark: 'bm-1', note: '' },
    });
    expect(action).toEqual({ kind: 'processing', bookmark: 'bm-1' });
  });

  it('error — surfaces the CF reason; unavailable → honest message', () => {
    expect(classifyExportResponse({ ok: true, data: { status: 'error', reason: 'boom', note: '' } })).toEqual({
      kind: 'error',
      message: 'boom',
    });
    expect(classifyExportResponse({ ok: true, data: { status: 'unavailable', note: '' } })).toEqual({
      kind: 'error',
      message: 'D1 not available',
    });
  });

  it('error — a failed/shapeless bridge response (timeout, no status) never masquerades as success', () => {
    expect(classifyExportResponse({ ok: false, error: 'Request timed out' })).toEqual({
      kind: 'error',
      message: 'Request timed out',
    });
    expect(classifyExportResponse({ ok: true, data: { anything: 1 } as never }).kind).toBe('error');
  });
});

describe('filterSchemaObjects', () => {
  const objects = [obj('users'), obj('orders'), obj('order_items'), obj('active_users', 'view')];
  it('blank query returns the list unchanged', () => {
    expect(filterSchemaObjects(objects, '')).toBe(objects);
    expect(filterSchemaObjects(objects, '   ')).toBe(objects);
  });
  it('case-insensitive substring filter on name', () => {
    expect(filterSchemaObjects(objects, 'ORDER').map((o) => o.name)).toEqual(['orders', 'order_items']);
    expect(filterSchemaObjects(objects, 'users').map((o) => o.name)).toEqual(['users', 'active_users']);
    expect(filterSchemaObjects(objects, 'zzz')).toEqual([]);
  });
});

describe('schemaCountsLabel', () => {
  it('omits zero-count types and pluralises correctly (index → indexes)', () => {
    expect(schemaCountsLabel({ table: 12, view: 3, index: 8, trigger: 0 })).toBe('12 tables · 3 views · 8 indexes');
    expect(schemaCountsLabel({ table: 1, view: 0, index: 0, trigger: 1 })).toBe('1 table · 1 trigger');
  });
  it('undefined / all-zero → empty string', () => {
    expect(schemaCountsLabel(undefined)).toBe('');
    expect(schemaCountsLabel({ table: 0, view: 0, index: 0, trigger: 0 })).toBe('');
  });
});

describe('isBrowsableObject', () => {
  it('only tables and views have inspectable columns', () => {
    expect(isBrowsableObject('table')).toBe(true);
    expect(isBrowsableObject('view')).toBe(true);
    expect(isBrowsableObject('index')).toBe(false);
    expect(isBrowsableObject('trigger')).toBe(false);
  });
});

describe('columnNullLabel / columnTypeLabel', () => {
  it('nullability label', () => {
    expect(columnNullLabel({ notNull: true })).toBe('NOT NULL');
    expect(columnNullLabel({ notNull: false })).toBe('NULL');
  });
  it('empty/untyped column type renders as em-dash, never blank', () => {
    expect(columnTypeLabel('TEXT')).toBe('TEXT');
    expect(columnTypeLabel('')).toBe('—');
    expect(columnTypeLabel('   ')).toBe('—');
  });
});

describe('parseCreateTableColumns (DDL parse — CF /query blocks PRAGMA)', () => {
  it('parses name / type / NOT NULL / inline PK / DEFAULT', () => {
    const cols = parseCreateTableColumns(
      "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT DEFAULT 'active', created_at INTEGER)",
    );
    expect(cols).toEqual([
      { cid: 0, name: 'id', type: 'TEXT', notNull: true, defaultValue: null, pk: 1 },
      { cid: 1, name: 'email', type: 'TEXT', notNull: true, defaultValue: null, pk: 0 },
      { cid: 2, name: 'status', type: 'TEXT', notNull: false, defaultValue: "'active'", pk: 0 },
      { cid: 3, name: 'created_at', type: 'INTEGER', notNull: false, defaultValue: null, pk: 0 },
    ]);
  });

  it('handles a table-level composite PRIMARY KEY (1-based positions) and skips FK/UNIQUE constraints', () => {
    const cols = parseCreateTableColumns(
      'CREATE TABLE m (a TEXT, b TEXT, note TEXT, FOREIGN KEY (a) REFERENCES x(id), UNIQUE (note), PRIMARY KEY (a, b))',
    );
    expect(cols.map((c) => [c.name, c.pk])).toEqual([
      ['a', 1],
      ['b', 2],
      ['note', 0],
    ]);
  });

  it('handles quoted identifiers, [bracket] names, multiline DDL, and a paren in the type', () => {
    const cols = parseCreateTableColumns(
      'CREATE TABLE "my tbl" (\n  "first name" TEXT NOT NULL,\n  [id] INTEGER PRIMARY KEY,\n  amount NUMERIC(10, 2) DEFAULT 0\n)',
    );
    expect(cols).toEqual([
      { cid: 0, name: 'first name', type: 'TEXT', notNull: true, defaultValue: null, pk: 0 },
      { cid: 1, name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, pk: 1 },
      { cid: 2, name: 'amount', type: 'NUMERIC(10, 2)', notNull: false, defaultValue: '0', pk: 0 },
    ]);
  });

  it('does NOT attempt views / virtual tables / null — returns [] so the UI shows raw DDL instead', () => {
    expect(parseCreateTableColumns('CREATE VIEW v AS SELECT id, name FROM users')).toEqual([]);
    expect(parseCreateTableColumns('CREATE VIRTUAL TABLE docs USING fts5(title, body)')).toEqual([]);
    expect(parseCreateTableColumns(null)).toEqual([]);
    expect(parseCreateTableColumns('not even ddl')).toEqual([]);
  });

  it('tolerates an untyped column (renders empty type — never crashes)', () => {
    const cols = parseCreateTableColumns('CREATE TABLE t (anything, id INTEGER PRIMARY KEY)');
    expect(cols[0]).toEqual({ cid: 0, name: 'anything', type: '', notNull: false, defaultValue: null, pk: 0 });
    expect(cols[1].pk).toBe(1);
  });
});

describe('parseForeignKeys (DDL parse — CF /query blocks PRAGMA foreign_key_list)', () => {
  it('parses an inline column-level REFERENCES with a target column', () => {
    expect(parseForeignKeys('CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))')).toEqual([
      { column: 'user_id', refTable: 'users', refColumn: 'id' },
    ]);
  });

  it('parses a table-level FOREIGN KEY, incl. a named CONSTRAINT and an omitted ref column', () => {
    expect(
      parseForeignKeys(
        'CREATE TABLE t (a TEXT, b TEXT, CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES other (x), FOREIGN KEY (b) REFERENCES two)',
      ),
    ).toEqual([
      { column: 'a', refTable: 'other', refColumn: 'x' },
      { column: 'b', refTable: 'two', refColumn: null },
    ]);
  });

  it('pairs a composite FOREIGN KEY by position', () => {
    expect(parseForeignKeys('CREATE TABLE t (a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES o (x, y))')).toEqual([
      { column: 'a', refTable: 'o', refColumn: 'x' },
      { column: 'b', refTable: 'o', refColumn: 'y' },
    ]);
  });

  it('handles quoted / bracket identifiers and returns [] for non-tables or FK-less DDL', () => {
    expect(parseForeignKeys('CREATE TABLE "my t" ("uid" TEXT REFERENCES [users] ([id]))')).toEqual([
      { column: 'uid', refTable: 'users', refColumn: 'id' },
    ]);
    expect(parseForeignKeys('CREATE TABLE t (id TEXT PRIMARY KEY, n INT)')).toEqual([]);
    expect(parseForeignKeys('CREATE VIEW v AS SELECT * FROM t')).toEqual([]);
    expect(parseForeignKeys(null)).toEqual([]);
  });
});

describe('parseIndexColumns (from an index CREATE SQL)', () => {
  it('parses a plain index → columns, unique=false', () => {
    expect(parseIndexColumns('CREATE INDEX idx_email ON users (email)')).toEqual({
      unique: false,
      columns: ['email'],
    });
  });

  it('parses a UNIQUE, multi-column index (quoted names), ignoring ASC/DESC + a partial WHERE', () => {
    expect(parseIndexColumns('CREATE UNIQUE INDEX u ON "t" ("a" ASC, b DESC) WHERE b IS NOT NULL')).toEqual({
      unique: true,
      columns: ['a', 'b'],
    });
  });

  it('null / non-index DDL (no ON clause) → empty', () => {
    expect(parseIndexColumns(null)).toEqual({ unique: false, columns: [] });
    expect(parseIndexColumns('CREATE TABLE t (id TEXT)')).toEqual({ unique: false, columns: [] });
  });
});

describe('timeTravelInfo (Backups & recovery — honest, no fake REST restore)', () => {
  it('interpolates the db name into the wrangler restore command', () => {
    const info = timeTravelInfo('prod-db');
    expect(info.restoreCommand).toBe('wrangler d1 time-travel restore prod-db --timestamp=<ISO-8601>');
  });

  it('falls back to a placeholder for a blank target', () => {
    expect(timeTravelInfo('   ').restoreCommand).toContain('restore <database>');
  });

  it('states the real retention window and the no-REST-API caveat (never promises a one-click restore)', () => {
    const info = timeTravelInfo('db');
    expect(info.retentionNote).toContain('30 days');
    expect(info.retentionNote).toContain('7 days');
    expect(info.caveat).toContain('no REST API');
    expect(info.caveat).toContain('Wrangler CLI');
  });
});

describe('incomingForeignKeys (reverse relationships — "referenced by")', () => {
  const cat: D1SchemaObjectSummary[] = [
    { type: 'table', name: 'users', tableName: 'users', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
    {
      type: 'table',
      name: 'orders',
      tableName: 'orders',
      sql: 'CREATE TABLE orders (id TEXT, user_id TEXT REFERENCES users(id))',
    },
    {
      type: 'table',
      name: 'reviews',
      tableName: 'reviews',
      sql: 'CREATE TABLE reviews (id TEXT, uid TEXT, FOREIGN KEY (uid) REFERENCES users (id))',
    },
    { type: 'index', name: 'ix', tableName: 'orders', sql: 'CREATE INDEX ix ON orders(user_id)' },
  ];

  it('finds every TABLE that references the target (skips indexes + self)', () => {
    expect(incomingForeignKeys(cat, 'users')).toEqual([
      { table: 'orders', column: 'user_id', refColumn: 'id' },
      { table: 'reviews', column: 'uid', refColumn: 'id' },
    ]);
  });

  it('empty when nothing references it', () => {
    expect(incomingForeignKeys(cat, 'orders')).toEqual([]);
  });
});

describe('buildErdModel (schema relationship diagram — zero-dep, deterministic)', () => {
  const cat: D1SchemaObjectSummary[] = [
    { type: 'table', name: 'users', tableName: 'users', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
    {
      type: 'table',
      name: 'orders',
      tableName: 'orders',
      sql: 'CREATE TABLE orders (id TEXT, user_id TEXT REFERENCES users(id))',
    },
    {
      type: 'table',
      name: 'items',
      tableName: 'items',
      sql: 'CREATE TABLE items (id TEXT, order_id TEXT REFERENCES orders(id), parent_id TEXT REFERENCES items(id))',
    },
    { type: 'index', name: 'ix', tableName: 'orders', sql: 'CREATE INDEX ix ON orders(user_id)' },
    { type: 'view', name: 'v', tableName: 'v', sql: 'CREATE VIEW v AS SELECT 1' },
  ];

  it('nodes = TABLES only (views/indexes/triggers excluded), sorted by name for a stable layout', () => {
    const m = buildErdModel(cat);
    expect(m.nodes.map((n) => n.table)).toEqual(['items', 'orders', 'users']);
    expect(m.tableCount).toBe(3);
  });

  it('edges = FKs between EXISTING tables, endpoints pre-resolved at node centers', () => {
    const m = buildErdModel(cat);
    const e = m.edges.find((x) => x.from === 'orders' && x.to === 'users')!;
    expect(e).toMatchObject({ fromCol: 'user_id', toCol: 'id', self: false });

    const orders = m.nodes.find((n) => n.table === 'orders')!;
    const users = m.nodes.find((n) => n.table === 'users')!;
    expect(e.x1).toBe(orders.x + orders.w / 2);
    expect(e.y1).toBe(orders.y + orders.h / 2);
    expect(e.x2).toBe(users.x + users.w / 2);
    expect(e.y2).toBe(users.y + users.h / 2);
  });

  it('flags a self-referencing FK (items.parent_id → items) as self', () => {
    const self = buildErdModel(cat).edges.find((x) => x.from === 'items' && x.to === 'items');
    expect(self?.self).toBe(true);
    expect(self).toMatchObject({ fromCol: 'parent_id', toCol: 'id' });
  });

  it('skips a FK to a non-existent / system table (never a dangling edge)', () => {
    const m = buildErdModel([
      { type: 'table', name: 'a', tableName: 'a', sql: 'CREATE TABLE a (id TEXT, x TEXT REFERENCES ghost(id))' },
    ]);
    expect(m.edges).toEqual([]);
    expect(m.nodes.map((n) => n.table)).toEqual(['a']);
  });

  it('lays tables out in a deterministic grid (ceil(sqrt(n)) columns, name order)', () => {
    const m = buildErdModel(cat); // 3 tables → ceil(sqrt(3)) = 2 cols
    const [items, orders, users] = m.nodes;
    expect(items).toMatchObject({ x: ERD_PAD, y: ERD_PAD });
    expect(orders.x).toBe(ERD_PAD + ERD_NODE_W + ERD_GAP_X); // col 1, row 0
    expect(orders.y).toBe(ERD_PAD);
    expect(users.x).toBe(ERD_PAD); // wraps to col 0, row 1
    expect(users.y).toBe(ERD_PAD + ERD_NODE_H + ERD_GAP_Y);
    expect(m.width).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThan(0);
  });

  it('counts every valid FK edge (orders→users, items→orders, items→items)', () => {
    expect(buildErdModel(cat).edgeCount).toBe(3);
  });

  it('an empty schema (no tables) → empty model, zero canvas', () => {
    const m = buildErdModel([{ type: 'view', name: 'v', tableName: 'v', sql: 'CREATE VIEW v AS SELECT 1' }]);
    expect(m).toMatchObject({ nodes: [], edges: [], width: 0, height: 0, tableCount: 0, edgeCount: 0 });
  });
});

describe('buildDataInsights (D1 overview takeaways — present-data-only, deterministic)', () => {
  it('summarises tables + rows, largest, empty, and structure', () => {
    const out = buildDataInsights({
      tables: [
        { name: 'visitor_events', rows: 12000 },
        { name: 'sites', rows: 431 },
        { name: 'form_submissions', rows: 0 },
      ],
      counts: { table: 3, view: 1, index: 8, trigger: 0 },
      totalRows: 12431,
      capped: false,
    });
    expect(out[0]).toBe('3 tables · 12,431 rows total');
    expect(out).toContain('Largest: visitor_events (12,000 rows)');
    expect(out).toContain('1 empty table (form_submissions)');
    expect(out).toContain('1 view · 8 indexes');
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('pluralises + counts multiple empty tables', () => {
    const out = buildDataInsights({
      tables: [
        { name: 'a', rows: 0 },
        { name: 'b', rows: 0 },
        { name: 'c', rows: 5 },
      ],
      counts: { table: 3, view: 0, index: 0, trigger: 1 },
      totalRows: 5,
      capped: false,
    });
    expect(out[0]).toBe('3 tables · 5 rows total');
    expect(out).toContain('2 empty tables');
    expect(out).toContain('1 trigger');
  });

  it('never emits a largest/structure line for absent data (present-data-only)', () => {
    const out = buildDataInsights({
      tables: [{ name: 'x', rows: 0 }],
      counts: { table: 1, view: 0, index: 0, trigger: 0 },
      totalRows: 0,
      capped: false,
    });
    expect(out).toEqual(['1 table · 0 rows total', '1 empty table (x)']);
    expect(out.some((l) => l.startsWith('Largest'))).toBe(false); // no non-empty table → no "largest"
  });

  it('discloses the 40-table cap; returns [] for an empty/absent database', () => {
    expect(
      buildDataInsights({
        tables: [],
        counts: { table: 41, view: 0, index: 0, trigger: 0 },
        totalRows: 999,
        capped: true,
      })[0],
    ).toContain('(first 40 tables)');
    expect(
      buildDataInsights({
        tables: [],
        counts: { table: 0, view: 0, index: 0, trigger: 0 },
        totalRows: 0,
        capped: false,
      }),
    ).toEqual([]);
    expect(buildDataInsights(null)).toEqual([]);
  });
});
