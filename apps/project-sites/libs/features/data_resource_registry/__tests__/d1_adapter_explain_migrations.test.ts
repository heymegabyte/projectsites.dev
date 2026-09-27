/**
 * TDD tests for the d1 adapter READ-ONLY polish actions —
 *   mutate({action:'explain', sql, params?})  → EXPLAIN QUERY PLAN for a read statement
 *   mutate({action:'migrations'})             → applied-migration history (d1_migrations)
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter runs SQL through
 * `makeSiteDataExecutor` (the CF REST D1 `/query` bridge) — we mock that + `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   explain
 *     (a) a READ statement (no confirm) → effect read_only + plan rows + duration_ms; runs EXPLAIN QUERY PLAN
 *     (b) a MUTATING/DESTRUCTIVE statement → explain_refused_mutating, NO query (never a write bypass)
 *     (c) an unknown/unparseable leading keyword is ALSO refused (fails closed)
 *     (d) params[] forwarded verbatim to the executor
 *     (e) multi-statement refused; empty SQL invalid_sql
 *     (f) isolation: shared-platform id refused → no executor
 *   migrations
 *     (g) table present → returns applied migrations newest-first + duration_ms
 *     (h) table ABSENT → honest empty { tablePresent:false, migrations:[] } (never an error)
 *     (i) isolation: shared-platform id refused → no executor
 *   supports
 *     (j) declares explain + migrations mutations
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

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
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { d1Adapter } from '../adapters/d1.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'db-00000000-0000-4000-a000-000000000001', // NOT in FORBIDDEN_DB_IDS
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'no_direct' as never,
};

const forbiddenScope: ResolvedScope = {
  ...scope,
  resourceId: 'ea3e839a-c641-4861-ae30-dfc63bff8032',
};

/** A D1 `/query` result the mocked executor returns. */
function queryResult(
  results: Record<string, unknown>[],
  meta: Partial<{ rows_read: number; rows_written: number; changed_db: boolean; duration: number }> = {},
) {
  return { results, meta };
}

beforeEach(() => {
  mockMakeExecutor.mockReset();
  mockQuery.mockReset();
  mockMakeExecutor.mockReturnValue({ query: mockQuery });
});

// ─── (j) supports declaration ────────────────────────────────────────────────────

describe('d1Adapter.supports (read-only polish)', () => {
  it('(j) declares the explain + migrations mutations', () => {
    expect(d1Adapter.supports.mutations).toEqual(expect.arrayContaining(['explain', 'migrations']));
  });
});

// ─── explain ──────────────────────────────────────────────────────────────────

describe('d1Adapter.mutate explain', () => {
  it('(a) a SELECT → effect read_only + plan rows + duration_ms; issues EXPLAIN QUERY PLAN', async () => {
    mockQuery.mockResolvedValueOnce(
      queryResult(
        [
          { id: 2, parent: 0, detail: 'SCAN customers' },
          { id: 4, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
        ],
        { duration: 1.7 },
      ),
    );
    const result = await d1Adapter.mutate(scope, {
      action: 'explain',
      sql: 'SELECT * FROM customers ORDER BY name',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'explain', effect: 'read_only', durationMs: 1.7 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = (result.data as any).plan as Array<{ detail: string }>;
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ id: 2, parent: 0, detail: 'SCAN customers' });
    // The query issued is EXPLAIN QUERY PLAN <sql> against the resolved id ONLY.
    expect(mockQuery).toHaveBeenCalledWith(
      'EXPLAIN QUERY PLAN SELECT * FROM customers ORDER BY name',
      [],
    );
    expect(mockMakeExecutor).toHaveBeenCalledWith(scope.auth, scope.accountId, scope.resourceId);
  });

  it('(b) a MUTATING statement → explain_refused_mutating, NEVER queries (no write bypass)', async () => {
    const result = await d1Adapter.mutate(scope, {
      action: 'explain',
      sql: 'DELETE FROM customers WHERE id = ?',
      params: [5],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('explain_refused_mutating');
    expect(result.error?.message).toMatch(/read/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(b) a DESTRUCTIVE statement → explain_refused_mutating, no query', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'explain', sql: 'DROP TABLE customers' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('explain_refused_mutating');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(c) an UNKNOWN leading keyword is refused (fails closed)', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'explain', sql: 'FLARB the glorp' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('explain_refused_mutating');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(d) params[] are forwarded verbatim to the EXPLAIN query', async () => {
    mockQuery.mockResolvedValueOnce(queryResult([{ id: 0, parent: 0, detail: 'SEARCH t USING INDEX' }]));
    const result = await d1Adapter.mutate(scope, {
      action: 'explain',
      sql: 'SELECT * FROM t WHERE a = ? AND b = ?',
      params: ['x', 9],
    });
    expect(result.ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith('EXPLAIN QUERY PLAN SELECT * FROM t WHERE a = ? AND b = ?', [
      'x',
      9,
    ]);
  });

  it('(e) empty SQL → invalid_sql; multi-statement → multi_statement', async () => {
    const empty = await d1Adapter.mutate(scope, { action: 'explain', sql: '  -- comment only ' });
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe('invalid_sql');

    const multi = await d1Adapter.mutate(scope, {
      action: 'explain',
      sql: 'SELECT 1; SELECT 2',
    });
    expect(multi.ok).toBe(false);
    expect(multi.error?.code).toBe('multi_statement');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(f) refuses the shared-platform id — never mints an executor', async () => {
    const result = await d1Adapter.mutate(forbiddenScope, {
      action: 'explain',
      sql: 'SELECT 1',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    expect(mockMakeExecutor).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('maps a CF query failure to a typed error (never a fake plan)', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const result = await d1Adapter.mutate(scope, { action: 'explain', sql: 'SELECT 1' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── migrations ─────────────────────────────────────────────────────────────────

describe('d1Adapter.mutate migrations', () => {
  it('(g) table present → applied migrations newest-first + duration_ms', async () => {
    mockQuery
      // existence probe: d1_migrations exists
      .mockResolvedValueOnce(queryResult([{ name: 'd1_migrations' }]))
      // the migration rows
      .mockResolvedValueOnce(
        queryResult(
          [
            { id: 2, name: '0002_add_orders.sql', applied_at: '2026-02-01 10:00:00' },
            { id: 1, name: '0001_init.sql', applied_at: '2026-01-01 10:00:00' },
          ],
          { duration: 0.9 },
        ),
      );
    const result = await d1Adapter.mutate(scope, { action: 'migrations' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'migrations', tablePresent: true, durationMs: 0.9 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migrations = (result.data as any).migrations as Array<{ name: string; appliedAt?: string }>;
    expect(migrations).toHaveLength(2);
    expect(migrations[0]).toMatchObject({ id: 2, name: '0002_add_orders.sql', appliedAt: '2026-02-01 10:00:00' });
    expect(mockMakeExecutor).toHaveBeenCalledWith(scope.auth, scope.accountId, scope.resourceId);
  });

  it('(h) table ABSENT → honest empty history (never an error)', async () => {
    // existence probe returns no rows → the table does not exist in this blank per-site D1.
    mockQuery.mockResolvedValueOnce(queryResult([]));
    const result = await d1Adapter.mutate(scope, { action: 'migrations' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'migrations', tablePresent: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.data as any).migrations).toHaveLength(0);
    // Only the existence probe ran — no second query against a non-existent table.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('(i) refuses the shared-platform id — never mints an executor', async () => {
    const result = await d1Adapter.mutate(forbiddenScope, { action: 'migrations' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    expect(mockMakeExecutor).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('maps a CF query failure to a typed error', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }));
    const result = await d1Adapter.mutate(scope, { action: 'migrations' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});
