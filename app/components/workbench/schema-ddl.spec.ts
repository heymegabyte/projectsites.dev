/**
 * @file Unit tests for the pure schema-DDL generators.
 *
 * @remarks
 * Tests follow the same pattern as `d1-browser-logic.spec.ts` — import from Vitest,
 * use `describe`/`it`/`expect`, no mocking (pure functions only), cover happy path,
 * error paths, and edge cases.
 */
import { describe, it, expect } from 'vitest';

import {
  DdlError,
  quoteIdent,
  buildCreateTable,
  buildAddColumn,
  buildRenameColumn,
  buildDropColumn,
  buildCreateIndex,
} from './schema-ddl';
import type { ColumnSpec } from './schema-ddl';

// ── quoteIdent ────────────────────────────────────────────────────────────────

describe('quoteIdent', () => {
  it('wraps a plain identifier in double-quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('order_id')).toBe('"order_id"');
  });

  it('doubles embedded double-quotes', () => {
    // A name containing a " should become "" per the SQLite standard.
    expect(quoteIdent('has"quote')).toBe('"has""quote"');
    expect(quoteIdent('a"b"c')).toBe('"a""b""c"');
  });

  it('throws DdlError on empty string', () => {
    expect(() => quoteIdent('')).toThrow(DdlError);
  });

  it('throws DdlError on blank/whitespace-only string', () => {
    expect(() => quoteIdent('   ')).toThrow(DdlError);
  });
});

// ── buildCreateTable — single-column inline PK ────────────────────────────────

describe('buildCreateTable — single PRIMARY KEY (inline)', () => {
  it('emits inline PRIMARY KEY for a single PK column', () => {
    const sql = buildCreateTable({
      name: 'users',
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }],
    });

    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).not.toContain('PRIMARY KEY ('); // no table-level constraint
  });

  it('does not duplicate NOT NULL when primaryKey is set', () => {
    const sql = buildCreateTable({
      name: 'sessions',
      columns: [{ name: 'token', type: 'TEXT', primaryKey: true, notNull: true }],
    });

    // PRIMARY KEY is emitted but NOT NULL must not appear twice.
    expect(sql).toContain('"token" TEXT PRIMARY KEY');
    expect(sql.split('NOT NULL').length - 1).toBe(0);
  });
});

// ── buildCreateTable — composite PK ──────────────────────────────────────────

describe('buildCreateTable — composite PRIMARY KEY (table-level)', () => {
  it('emits a table-level PRIMARY KEY clause for multiple PK columns', () => {
    const sql = buildCreateTable({
      name: 'role_members',
      columns: [
        { name: 'role_id', type: 'TEXT', primaryKey: true },
        { name: 'user_id', type: 'TEXT', primaryKey: true },
      ],
    });

    // No inline PRIMARY KEY on individual columns.
    expect(sql).not.toMatch(/"role_id" TEXT PRIMARY KEY/);
    expect(sql).not.toMatch(/"user_id" TEXT PRIMARY KEY/);

    // Table-level constraint present.
    expect(sql).toContain('PRIMARY KEY ("role_id", "user_id")');
  });
});

// ── buildCreateTable — NOT NULL and DEFAULT ───────────────────────────────────

describe('buildCreateTable — NOT NULL and DEFAULT', () => {
  it('emits NOT NULL on a non-PK column', () => {
    const sql = buildCreateTable({
      name: 'products',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'name', type: 'TEXT', notNull: true },
      ],
    });

    expect(sql).toContain('"name" TEXT NOT NULL');
  });

  it('emits DEFAULT for a numeric default', () => {
    const sql = buildCreateTable({
      name: 'counters',
      columns: [{ name: 'value', type: 'INTEGER', defaultValue: '0' }],
    });

    expect(sql).toContain('"value" INTEGER DEFAULT 0');
  });

  it('wraps a string default in single quotes and escapes inner single-quotes', () => {
    const col: ColumnSpec = { name: 'status', type: 'TEXT', defaultValue: "it's active" };
    const sql = buildCreateTable({ name: 'jobs', columns: [col] });

    expect(sql).toContain(`"status" TEXT DEFAULT 'it''s active'`);
  });

  it('passes through NULL keyword unquoted', () => {
    const sql = buildCreateTable({
      name: 'logs',
      columns: [{ name: 'deleted_at', type: 'TEXT', defaultValue: 'NULL' }],
    });

    expect(sql).toContain('"deleted_at" TEXT DEFAULT NULL');
  });

  it('passes through CURRENT_TIMESTAMP keyword unquoted', () => {
    const sql = buildCreateTable({
      name: 'events',
      columns: [{ name: 'created_at', type: 'TEXT', defaultValue: 'CURRENT_TIMESTAMP' }],
    });

    expect(sql).toContain('"created_at" TEXT DEFAULT CURRENT_TIMESTAMP');
  });
});

// ── buildCreateTable — error paths ───────────────────────────────────────────

describe('buildCreateTable — error paths', () => {
  it('throws DdlError when columns array is empty', () => {
    expect(() => buildCreateTable({ name: 'empty_table', columns: [] })).toThrow(DdlError);
  });

  it('throws DdlError for an invalid table name (spaces)', () => {
    expect(() => buildCreateTable({ name: 'bad table', columns: [{ name: 'id', type: 'TEXT' }] })).toThrow(DdlError);
  });

  it('throws DdlError for an invalid column name (starts with digit)', () => {
    expect(() => buildCreateTable({ name: 'valid', columns: [{ name: '1bad', type: 'TEXT' }] })).toThrow(DdlError);
  });

  it('throws DdlError for duplicate column names (case-insensitive)', () => {
    expect(() =>
      buildCreateTable({
        name: 'dup_test',
        columns: [
          { name: 'email', type: 'TEXT' },
          { name: 'Email', type: 'TEXT' }, // same name, different case
        ],
      }),
    ).toThrow(DdlError);
  });

  it('throws DdlError for a hostile identifier containing SQL metacharacters', () => {
    // A semicolon-injection attempt.
    expect(() =>
      buildCreateTable({
        name: 'safe',
        columns: [{ name: 'col; DROP TABLE safe; --', type: 'TEXT' }],
      }),
    ).toThrow(DdlError);
  });
});

// ── buildAddColumn ────────────────────────────────────────────────────────────

describe('buildAddColumn', () => {
  it('emits a basic ADD COLUMN statement', () => {
    const sql = buildAddColumn('users', { name: 'bio', type: 'TEXT' });
    expect(sql).toBe('ALTER TABLE "users" ADD COLUMN "bio" TEXT');
  });

  it('includes NOT NULL when specified', () => {
    const sql = buildAddColumn('orders', { name: 'qty', type: 'INTEGER', notNull: true });
    expect(sql).toContain('NOT NULL');
  });

  it('includes DEFAULT when specified', () => {
    const sql = buildAddColumn('products', { name: 'stock', type: 'INTEGER', defaultValue: '0' });
    expect(sql).toContain('DEFAULT 0');
    expect(sql).toBe('ALTER TABLE "products" ADD COLUMN "stock" INTEGER DEFAULT 0');
  });

  it('throws DdlError for invalid table name', () => {
    expect(() => buildAddColumn('bad name', { name: 'col', type: 'TEXT' })).toThrow(DdlError);
  });

  it('throws DdlError for invalid column name', () => {
    expect(() => buildAddColumn('t', { name: '', type: 'TEXT' })).toThrow(DdlError);
  });
});

// ── buildRenameColumn ─────────────────────────────────────────────────────────

describe('buildRenameColumn', () => {
  it('emits a RENAME COLUMN statement', () => {
    const sql = buildRenameColumn('orders', 'qty', 'quantity');
    expect(sql).toBe('ALTER TABLE "orders" RENAME COLUMN "qty" TO "quantity"');
  });

  it('throws DdlError for invalid source name', () => {
    expect(() => buildRenameColumn('t', '2bad', 'good')).toThrow(DdlError);
  });

  it('throws DdlError for invalid target name', () => {
    expect(() => buildRenameColumn('t', 'good', '')).toThrow(DdlError);
  });
});

// ── buildDropColumn ───────────────────────────────────────────────────────────

describe('buildDropColumn', () => {
  it('emits a DROP COLUMN statement', () => {
    const sql = buildDropColumn('sessions', 'legacy_token');
    expect(sql).toBe('ALTER TABLE "sessions" DROP COLUMN "legacy_token"');
  });

  it('throws DdlError for invalid column name', () => {
    expect(() => buildDropColumn('t', 'bad-col')).toThrow(DdlError);
  });
});

// ── buildCreateIndex ──────────────────────────────────────────────────────────

describe('buildCreateIndex', () => {
  it('emits a non-unique index', () => {
    const sql = buildCreateIndex({
      name: 'idx_orders_user',
      table: 'orders',
      columns: ['user_id'],
    });

    expect(sql).toBe('CREATE INDEX "idx_orders_user" ON "orders" ("user_id")');
  });

  it('emits a UNIQUE index', () => {
    const sql = buildCreateIndex({
      name: 'idx_users_email',
      table: 'users',
      columns: ['email'],
      unique: true,
    });

    expect(sql).toBe('CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")');
  });

  it('handles a multi-column index', () => {
    const sql = buildCreateIndex({
      name: 'idx_orders_user_created',
      table: 'orders',
      columns: ['user_id', 'created_at'],
    });

    expect(sql).toContain('"user_id", "created_at"');
  });

  it('throws DdlError when column list is empty', () => {
    expect(() => buildCreateIndex({ name: 'idx_empty', table: 'orders', columns: [] })).toThrow(DdlError);
  });

  it('throws DdlError for invalid index name', () => {
    expect(() => buildCreateIndex({ name: 'bad index', table: 'orders', columns: ['id'] })).toThrow(DdlError);
  });
});
