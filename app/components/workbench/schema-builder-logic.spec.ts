/**
 * @file Unit tests for the pure Schema Builder planners.
 *
 * @remarks
 * Pure-function tests (no React, no bridge, no mocking) — mirrors `schema-ddl.spec.ts`. Covers the happy path
 * (compiled SQL + destructive flags), UNIQUE→index expansion, and the typed {@link SchemaPlanError} paths the
 * component surfaces inline.
 */
import { describe, it, expect } from 'vitest';

import {
  COLUMN_TYPE_OPTIONS,
  draftToColumnSpec,
  isDestructiveDdl,
  planAddColumn,
  planCreateIndex,
  planCreateTable,
  planDropColumn,
  planRenameColumn,
  SchemaPlanError,
  suggestIndexName,
} from './schema-builder-logic';

describe('COLUMN_TYPE_OPTIONS', () => {
  it('lists the four SQLite storage classes', () => {
    expect(COLUMN_TYPE_OPTIONS.map((o) => o.value)).toEqual(['TEXT', 'INTEGER', 'REAL', 'BLOB']);
  });
});

describe('draftToColumnSpec', () => {
  it('trims the name and drops flags that are falsy', () => {
    expect(draftToColumnSpec({ name: '  email ', type: 'TEXT' })).toEqual({ name: 'email', type: 'TEXT' });
  });

  it('carries notNull / primaryKey / a non-empty default', () => {
    expect(
      draftToColumnSpec({ name: 'n', type: 'INTEGER', notNull: true, primaryKey: true, defaultValue: '0' }),
    ).toEqual({
      name: 'n',
      type: 'INTEGER',
      notNull: true,
      primaryKey: true,
      defaultValue: '0',
    });
  });

  it('treats a blank default as no default', () => {
    expect(draftToColumnSpec({ name: 'n', type: 'TEXT', defaultValue: '   ' })).toEqual({ name: 'n', type: 'TEXT' });
  });

  it('throws SchemaPlanError for a missing name', () => {
    expect(() => draftToColumnSpec({ name: '', type: 'TEXT' })).toThrow(SchemaPlanError);
  });
});

describe('suggestIndexName', () => {
  it('joins idx + table + columns', () => {
    expect(suggestIndexName('orders', ['user_id', 'created_at'])).toBe('idx_orders_user_id_created_at');
  });

  it('caps at 63 chars', () => {
    const long = suggestIndexName(
      't',
      Array.from({ length: 40 }, (_, i) => `col_number_${i}`),
    );
    expect(long.length).toBeLessThanOrEqual(63);
  });
});

describe('isDestructiveDdl', () => {
  it('flags DROP', () => {
    expect(isDestructiveDdl('DROP INDEX "x"')).toBe(true);
    expect(isDestructiveDdl('ALTER TABLE "t" DROP COLUMN "c"')).toBe(true);
  });

  it('does not flag CREATE / ADD / RENAME', () => {
    expect(isDestructiveDdl('CREATE TABLE "t" ("a" TEXT)')).toBe(false);
    expect(isDestructiveDdl('ALTER TABLE "t" ADD COLUMN "b" TEXT')).toBe(false);
    expect(isDestructiveDdl('ALTER TABLE "t" RENAME COLUMN "a" TO "b"')).toBe(false);
  });
});

describe('planCreateTable', () => {
  it('compiles a single non-destructive CREATE TABLE', () => {
    const plan = planCreateTable('customers', [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'email', type: 'TEXT', notNull: true },
    ]);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].destructive).toBe(false);
    expect(plan.statements[0].sql).toContain('CREATE TABLE "customers"');
    expect(plan.statements[0].sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(plan.statements[0].sql).toContain('"email" TEXT NOT NULL');
  });

  it('expands a UNIQUE column into a follow-on CREATE UNIQUE INDEX', () => {
    const plan = planCreateTable('users', [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'handle', type: 'TEXT', unique: true },
    ]);
    expect(plan.statements).toHaveLength(2);
    expect(plan.statements[1].sql).toContain('CREATE UNIQUE INDEX');
    expect(plan.statements[1].sql).toContain('"handle"');
    expect(plan.statements[1].destructive).toBe(false);
  });

  it('does not emit a unique index for a PK column (PK is already unique)', () => {
    const plan = planCreateTable('t', [{ name: 'id', type: 'INTEGER', primaryKey: true, unique: true }]);
    expect(plan.statements).toHaveLength(1);
  });

  it('throws for a blank table name', () => {
    expect(() => planCreateTable('', [{ name: 'a', type: 'TEXT' }])).toThrow(SchemaPlanError);
  });

  it('throws for no columns', () => {
    expect(() => planCreateTable('t', [])).toThrow(SchemaPlanError);
  });

  it('throws (as SchemaPlanError) for a duplicate column name', () => {
    expect(() =>
      planCreateTable('t', [
        { name: 'a', type: 'TEXT' },
        { name: 'a', type: 'INTEGER' },
      ]),
    ).toThrow(SchemaPlanError);
  });

  it('throws for an invalid identifier (surfaced from DdlError)', () => {
    expect(() => planCreateTable('t', [{ name: '1bad', type: 'TEXT' }])).toThrow(SchemaPlanError);
  });

  it('requirePk enforces a primary key', () => {
    expect(() => planCreateTable('t', [{ name: 'a', type: 'TEXT' }], { requirePk: true })).toThrow(SchemaPlanError);
    expect(() =>
      planCreateTable('t', [{ name: 'a', type: 'INTEGER', primaryKey: true }], { requirePk: true }),
    ).not.toThrow();
  });
});

describe('planAddColumn', () => {
  it('compiles a single ALTER … ADD COLUMN', () => {
    const plan = planAddColumn('users', { name: 'bio', type: 'TEXT' });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" ADD COLUMN "bio" TEXT');
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('adds a unique index for a unique column', () => {
    const plan = planAddColumn('users', { name: 'slug', type: 'TEXT', unique: true });
    expect(plan.statements).toHaveLength(2);
    expect(plan.statements[1].sql).toContain('CREATE UNIQUE INDEX');
  });
});

describe('planRenameColumn', () => {
  it('compiles a single RENAME COLUMN', () => {
    const plan = planRenameColumn('orders', 'qty', 'quantity');
    expect(plan.statements[0].sql).toBe('ALTER TABLE "orders" RENAME COLUMN "qty" TO "quantity"');
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('throws when from === to', () => {
    expect(() => planRenameColumn('t', 'a', 'a')).toThrow(SchemaPlanError);
  });

  it('throws for a blank name', () => {
    expect(() => planRenameColumn('t', '', 'b')).toThrow(SchemaPlanError);
  });
});

describe('planDropColumn', () => {
  it('compiles a DESTRUCTIVE DROP COLUMN', () => {
    const plan = planDropColumn('sessions', 'legacy_token');
    expect(plan.statements[0].sql).toBe('ALTER TABLE "sessions" DROP COLUMN "legacy_token"');
    expect(plan.statements[0].destructive).toBe(true);
  });

  it('throws for a blank column', () => {
    expect(() => planDropColumn('t', '')).toThrow(SchemaPlanError);
  });
});

describe('planCreateIndex', () => {
  it('compiles a CREATE INDEX with a derived name', () => {
    const plan = planCreateIndex('orders', ['user_id', 'created_at']);
    expect(plan.statements[0].sql).toContain('CREATE INDEX "idx_orders_user_id_created_at"');
    expect(plan.statements[0].destructive).toBe(false);
  });

  it('honors an explicit name + UNIQUE', () => {
    const plan = planCreateIndex('users', ['email'], { name: 'ux_email', unique: true });
    expect(plan.statements[0].sql).toBe('CREATE UNIQUE INDEX "ux_email" ON "users" ("email")');
  });

  it('throws for an empty column list', () => {
    expect(() => planCreateIndex('t', [])).toThrow(SchemaPlanError);
  });
});
