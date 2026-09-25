/**
 * @module __tests__/helpers/d1_sqlite
 * @description A REAL SQLite (Node 22's built-in `node:sqlite`) wrapped in a `D1Database`-compatible
 * facade, so aggregator code that calls `db.prepare(sql).bind(...params).all()` executes its ACTUAL
 * SQL instead of a canned-row double. This lets a test SEED raw rows and reconcile what an aggregator
 * COMPUTES against ground truth (the `verify-against-source-of-truth` discipline) — catching a
 * conflation / wrong-filter / double-count that a mock double (which never runs the SQL) cannot.
 *
 * Scope: a faithful-enough D1 facade for read aggregators + seeding — `prepare().bind().all()/first()/
 * run()`. It is NOT a full D1 emulator (no sessions, batch, or Time Travel). Params bind positionally
 * (`?`), matching the aggregators under test.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../../types/env.js';

export interface D1SqliteHarness {
  /** The D1Database-compatible facade to pass as `env.DB`. */
  readonly db: Env['DB'];
  /** The underlying real SQLite — for `CREATE TABLE` / seeding / ground-truth `SELECT`s in the test. */
  readonly raw: DatabaseSync;
  /** Run raw DDL/SQL directly (schema + seed). */
  exec(sql: string): void;
  /** Close the in-memory DB (call in a `finally`). */
  close(): void;
}

/**
 * Create an in-memory real-SQLite harness with a D1-compatible `db` facade.
 *
 * @example
 *   const h = createD1Sqlite();
 *   try {
 *     h.exec('CREATE TABLE visitor_events(site_id TEXT, event_type TEXT, created_at TEXT)');
 *     const { days } = await getDailySeries({ DB: h.db } as Env, 'site_1', 30);
 *   } finally { h.close(); }
 */
export function createD1Sqlite(): D1SqliteHarness {
  const raw = new DatabaseSync(':memory:');
  const db = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...params: unknown[]) {
          bound = params;
          return api;
        },
        all: async () => ({ results: stmt.all(...(bound as never[])) }),
        first: async () => stmt.get(...(bound as never[])) ?? null,
        run: async () => {
          const r = stmt.run(...(bound as never[]));
          return {
            success: true,
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
          };
        },
      };
      return api;
    },
  } as unknown as Env['DB'];
  return { db, raw, exec: (sql: string) => raw.exec(sql), close: () => raw.close() };
}
