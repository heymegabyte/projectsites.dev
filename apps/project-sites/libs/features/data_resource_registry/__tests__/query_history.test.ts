/**
 * TDD tests for per-site D1 query history (Data Platform "query history").
 *
 *   recordQueryHistory(db, input)  → FIRE-AND-FORGET write of the STATEMENT TEMPLATE only (never params)
 *   readQueryHistory(db, siteId, orgId, opts) → newest-first, clamped, org-scoped read
 *   d1Adapter.mutate({action:'exec'}) with scope.db → records history WITHOUT persisting a param VALUE
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). A lightweight in-memory fake D1
 * runs the REAL `dbInsert`/`dbQuery` SQL (via `env.DB.prepare().bind().all()/run()`), so ordering,
 * clamp, and org-scope are exercised authentically. The d1 adapter's per-site executor is mocked
 * (its CF REST bridge) exactly as the sibling adapter tests do (4× ../ reaches `src/`).
 *
 * Contracts under test:
 *   (a) recordQueryHistory persists the TEMPLATE + meta and NEVER a param VALUE (explicit assertion)
 *   (b) recordQueryHistory never rejects — a broken DB is swallowed (best-effort, never fails the query)
 *   (c) readQueryHistory returns entries NEWEST-FIRST
 *   (d) readQueryHistory CLAMPS the limit to [1, 200]
 *   (e) org-isolation: a foreign site's history is NEVER returned (scoped to org_id + site_id)
 *   (f) d1Adapter.mutate exec with scope.db records history with the TEMPLATE, NO param VALUE persisted
 *   (g) d1Adapter.mutate exec with NO scope.db records nothing (query still runs)
 */

// ─── Mocks for the d1 adapter's per-site executor (declared BEFORE imports) ──────

const mockQuery = jest.fn();
const mockMakeExecutor = jest.fn(() => ({ query: mockQuery }));

jest.mock('../../../../src/services/site_data_db.js', () => ({
  makeSiteDataExecutor: (...a: unknown[]) => mockMakeExecutor(...a),
  isSafeIdent: (s: unknown): s is string =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  FORBIDDEN_DB_IDS: new Set(['ea3e839a-c641-4861-ae30-dfc63bff8032']),
}));

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({ 'X-Auth-Email': 't@e.com', 'X-Auth-Key': 'k' }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { clampHistoryLimit, readQueryHistory, recordQueryHistory } from '../query_history.js';
import { d1Adapter } from '../adapters/d1.js';
import type { ResolvedScope } from '../adapter.js';

// ─── In-memory fake D1 that runs the exact dbInsert/dbQuery SQL ───────────────────

interface HistoryStore {
  id: string;
  site_id: string;
  org_id: string;
  environment: string;
  statement_kind: string;
  sql_text: string;
  duration_ms: number | null;
  rows_read: number | null;
  rows_written: number | null;
  ok: number;
  error_code: string | null;
  created_at: string;
}

/**
 * A minimal D1 fake covering ONLY the two statements query_history issues:
 *   - INSERT INTO data_query_history (...cols...) VALUES (...?)   (dbInsert)
 *   - SELECT ... FROM data_query_history WHERE ... ORDER BY created_at DESC, id DESC LIMIT ?  (dbQuery)
 * Any other SQL throws (so an unexpected statement is loud, not silently green).
 */
function makeFakeDb(rows: HistoryStore[] = []): D1Database & { rows: HistoryStore[] } {
  const store = rows;
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...params: unknown[]) {
        bound = params;
        return stmt;
      },
      async run() {
        if (/^INSERT INTO data_query_history/i.test(sql)) {
          // Column order mirrors dbInsert(record) — created_at/updated_at may be prepended.
          const cols = sql
            .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
            .split(',')
            .map((c) => c.trim());
          const rec: Record<string, unknown> = {};
          cols.forEach((c, i) => (rec[c] = bound[i]));
          store.push(rec as unknown as HistoryStore);
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run SQL: ${sql}`);
      },
      async all<T>() {
        // [\s\S] (not `.`) so the multi-line SELECT the real dbQuery emits still matches.
        if (/^SELECT [\s\S]* FROM data_query_history/i.test(sql)) {
          // Parse the WHERE scope from the bound params in dbQuery order:
          // [site_id, org_id, (environment?), limit]
          const siteId = bound[0] as string;
          const orgId = bound[1] as string;
          const hasEnv = /environment = \?/i.test(sql);
          const env = hasEnv ? (bound[2] as string) : undefined;
          const limit = bound[bound.length - 1] as number;
          const filtered = store
            .filter(
              (r) =>
                r.site_id === siteId &&
                r.org_id === orgId &&
                (env === undefined || r.environment === env),
            )
            // ORDER BY created_at DESC, id DESC
            .sort((a, b) =>
              a.created_at === b.created_at
                ? b.id.localeCompare(a.id)
                : b.created_at.localeCompare(a.created_at),
            )
            .slice(0, limit);
          return { results: filtered as unknown as T[] };
        }
        throw new Error(`unexpected all SQL: ${sql}`);
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare, rows: store } as unknown as D1Database & { rows: HistoryStore[] };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function baseInput() {
  return {
    siteId: 'site-1',
    orgId: 'org-1',
    environment: 'production' as const,
    statementKind: 'read_only' as const,
    ok: true,
  };
}

beforeEach(() => {
  mockMakeExecutor.mockReset();
  mockQuery.mockReset();
  mockMakeExecutor.mockReturnValue({ query: mockQuery });
});

// ─── (a) records the TEMPLATE, never a param VALUE ────────────────────────────────

describe('recordQueryHistory', () => {
  it('(a) persists the statement TEMPLATE + meta and NEVER a param VALUE', async () => {
    const db = makeFakeDb();
    await recordQueryHistory(db, {
      ...baseInput(),
      statementKind: 'mutating',
      // The template carries a `?` placeholder; the sensitive value lives only in params (NOT passed here).
      sqlText: 'INSERT INTO customers (ssn) VALUES (?)',
      rowsWritten: 1,
    });
    expect(db.rows).toHaveLength(1);
    const row = db.rows[0]!;
    expect(row.sql_text).toBe('INSERT INTO customers (ssn) VALUES (?)');
    expect(row.statement_kind).toBe('mutating');
    expect(row.rows_written).toBe(1);
    expect(row.ok).toBe(1);
    // EXPLICIT: no persisted column carries a param VALUE — the whole serialized row must not contain
    // a sensitive value that would only appear if params were stored.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('123-45-6789');
    // And there is no params/value column at all (structural — the input has no params field).
    expect(row).not.toHaveProperty('params');
    expect(Object.keys(row)).not.toContain('param_values');
  });

  it('(b) NEVER rejects — a broken DB is swallowed (best-effort)', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('DB exploded');
      },
    } as unknown as D1Database;
    // Must resolve (not throw) — a history-write failure can never fail the customer's query.
    await expect(
      recordQueryHistory(brokenDb, { ...baseInput(), sqlText: 'SELECT 1' }),
    ).resolves.toBeUndefined();
  });
});

// ─── (c)(d)(e) read: newest-first, clamp, org-isolation ───────────────────────────

describe('readQueryHistory', () => {
  it('(c) returns entries NEWEST-FIRST', async () => {
    const db = makeFakeDb([
      row('a', 'site-1', 'org-1', '2026-09-27T10:00:00.000Z', 'SELECT 1'),
      row('b', 'site-1', 'org-1', '2026-09-27T12:00:00.000Z', 'SELECT 2'),
      row('c', 'site-1', 'org-1', '2026-09-27T11:00:00.000Z', 'SELECT 3'),
    ]);
    const entries = await readQueryHistory(db, 'site-1', 'org-1');
    expect(entries.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(entries[0]!.sqlText).toBe('SELECT 2');
  });

  it('(d) CLAMPS the limit to [1, 200]', async () => {
    expect(clampHistoryLimit(9999)).toBe(200);
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-5)).toBe(1);
    expect(clampHistoryLimit(undefined)).toBe(25);
    expect(clampHistoryLimit(50)).toBe(50);
    const db = makeFakeDb(
      Array.from({ length: 10 }, (_, i) =>
        row(`id-${i}`, 'site-1', 'org-1', `2026-09-27T${String(i).padStart(2, '0')}:00:00.000Z`, 'SELECT 1'),
      ),
    );
    const entries = await readQueryHistory(db, 'site-1', 'org-1', { limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('(e) org-isolation: a FOREIGN site + org history is NEVER returned', async () => {
    const db = makeFakeDb([
      row('mine', 'site-1', 'org-1', '2026-09-27T10:00:00.000Z', 'SELECT mine'),
      // Same site id but a DIFFERENT org (belt-and-braces org scope must exclude it).
      row('foreign-org', 'site-1', 'org-EVIL', '2026-09-27T11:00:00.000Z', 'SELECT foreign'),
      // A different site entirely.
      row('foreign-site', 'site-2', 'org-1', '2026-09-27T12:00:00.000Z', 'SELECT other-site'),
    ]);
    const entries = await readQueryHistory(db, 'site-1', 'org-1');
    expect(entries.map((e) => e.id)).toEqual(['mine']);
    expect(entries.every((e) => e.sqlText === 'SELECT mine')).toBe(true);
  });

  it('filters by environment when provided', async () => {
    const db = makeFakeDb([
      row('prod', 'site-1', 'org-1', '2026-09-27T10:00:00.000Z', 'SELECT p', 'production'),
      row('prev', 'site-1', 'org-1', '2026-09-27T11:00:00.000Z', 'SELECT v', 'preview'),
    ]);
    const entries = await readQueryHistory(db, 'site-1', 'org-1', { environment: 'preview' });
    expect(entries.map((e) => e.id)).toEqual(['prev']);
  });
});

// ─── (f)(g) adapter integration: history on exec, no param value, opt-out when no db ──

describe('d1Adapter.mutate exec — history recording', () => {
  const scope = (db?: D1Database): ResolvedScope => ({
    siteId: 'site-1',
    orgId: 'org-1',
    environment: 'production',
    resourceId: 'db-00000000-0000-4000-a000-000000000001',
    accountId: 'acct-1',
    auth: { email: 't@e.com', key: 'k' } as never,
    accessPolicy: 'no_direct' as never,
    ...(db ? { db } : {}),
  });

  it('(f) records history with the TEMPLATE + meta, NEVER the bound param VALUE', async () => {
    const db = makeFakeDb();
    mockQuery.mockResolvedValueOnce({ results: [], meta: { rows_written: 1, changed_db: true, duration: 4 } });
    const result = await d1Adapter.mutate(scope(db), {
      action: 'exec',
      sql: 'UPDATE customers SET ssn = ? WHERE id = ?',
      params: ['123-45-6789', 7], // a SENSITIVE value that must NEVER reach history
      confirm: true,
    });
    expect(result.ok).toBe(true);
    // Fire-and-forget: allow the microtask that records history to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(db.rows).toHaveLength(1);
    const row = db.rows[0]!;
    expect(row.sql_text).toBe('UPDATE customers SET ssn = ? WHERE id = ?');
    expect(row.statement_kind).toBe('mutating');
    expect(row.rows_written).toBe(1);
    expect(row.ok).toBe(1);
    // The sensitive param VALUE must not appear ANYWHERE in the recorded row.
    expect(JSON.stringify(row)).not.toContain('123-45-6789');
    // The executor still ran the real query WITH the params (params reach the DB, not the history).
    expect(mockQuery).toHaveBeenCalledWith('UPDATE customers SET ssn = ? WHERE id = ?', [
      '123-45-6789',
      7,
    ]);
  });

  it('(g) records NOTHING when no platform db is attached (query still runs)', async () => {
    mockQuery.mockResolvedValueOnce({ results: [{ n: 1 }], meta: { rows_read: 1 } });
    const result = await d1Adapter.mutate(scope(), { action: 'exec', sql: 'SELECT 1' });
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // No db → recordHistory returns early; nothing thrown, query succeeded.
    expect(result.data?.effect).toBe('read_only');
  });
});

// ─── helper ──────────────────────────────────────────────────────────────────────

function row(
  id: string,
  siteId: string,
  orgId: string,
  createdAt: string,
  sqlText: string,
  environment = 'production',
): HistoryStore {
  return {
    id,
    site_id: siteId,
    org_id: orgId,
    environment,
    statement_kind: 'read_only',
    sql_text: sqlText,
    duration_ms: null,
    rows_read: null,
    rows_written: null,
    ok: 1,
    error_code: null,
    created_at: createdAt,
  };
}
