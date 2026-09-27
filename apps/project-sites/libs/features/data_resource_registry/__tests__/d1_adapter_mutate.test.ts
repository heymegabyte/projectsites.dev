/**
 * TDD tests for the d1 adapter WRITE slice — `mutate({action:'exec', sql, params?, confirm?})`.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter runs SQL through
 * `makeSiteDataExecutor` (the CF REST D1 `/query` bridge) — we mock that + `cfAuthHeaders` (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) a READ-ONLY statement (SELECT/PRAGMA/EXPLAIN/WITH…SELECT/VALUES) runs WITHOUT confirm → effect read_only
 *   (b) a MUTATING statement (INSERT/UPDATE/DELETE-with-WHERE) WITHOUT confirm → confirmation_required, NO query
 *   (c) a MUTATING statement WITH confirm → runs; reports effect + D1's rows_written/changed_db ground truth
 *   (d) a DESTRUCTIVE statement (DROP/TRUNCATE/ALTER/DELETE-without-WHERE) is FLAGGED + notes Time Travel
 *   (e) parameterized params[] are forwarded verbatim to the executor
 *   (f) isolation: the executor is minted for scope.resourceId ONLY; a shared-platform id is refused
 *   (g) an `unknown`/unparseable leading keyword fails CLOSED (treated as mutating → needs confirm)
 *   (h) multi-statement is refused; empty SQL is invalid_sql; unknown action is invalid_action
 *   (i) classifySql unit cases (the honest leading-keyword classifier)
 *   (j) supports declares the `exec` mutation + the `mutate` verb
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

import { classifySql, d1Adapter } from '../adapters/d1.js';
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

/** A D1 `/query` result the mocked executor returns. */
function queryResult(
  results: Record<string, unknown>[],
  meta: Partial<{ rows_read: number; rows_written: number; changed_db: boolean }> = {},
) {
  return { results, meta };
}

beforeEach(() => {
  mockMakeExecutor.mockReset();
  mockQuery.mockReset();
  mockMakeExecutor.mockReturnValue({ query: mockQuery });
});

// ─── (j) supports declaration ────────────────────────────────────────────────────

describe('d1Adapter.supports (write slice)', () => {
  it('(j) declares the exec mutation and the mutate verb', () => {
    expect(d1Adapter.supports.mutations).toEqual(expect.arrayContaining(['exec']));
    expect(d1Adapter.supports.verbs).toContain('mutate');
  });
});

// ─── (i) classifySql — the honest leading-keyword classifier ──────────────────────

describe('classifySql', () => {
  it('(i) classifies read-only statements', () => {
    expect(classifySql('SELECT * FROM customers')).toBe('read_only');
    expect(classifySql('  select 1')).toBe('read_only');
    expect(classifySql('PRAGMA table_info(customers)')).toBe('read_only');
    expect(classifySql('EXPLAIN QUERY PLAN SELECT * FROM t')).toBe('read_only');
    expect(classifySql('EXPLAIN DELETE FROM t')).toBe('read_only'); // EXPLAIN never mutates
    expect(classifySql('VALUES (1),(2)')).toBe('read_only');
    expect(classifySql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read_only');
    expect(classifySql('-- a comment\nSELECT 1')).toBe('read_only');
  });

  it('(i) classifies mutating (non-destructive) statements', () => {
    expect(classifySql('INSERT INTO t (a) VALUES (?)')).toBe('mutating');
    expect(classifySql('UPDATE t SET a = ? WHERE id = ?')).toBe('mutating');
    expect(classifySql('DELETE FROM t WHERE id = ?')).toBe('mutating');
    expect(classifySql('REPLACE INTO t (a) VALUES (1)')).toBe('mutating');
    expect(classifySql('CREATE TABLE t (id INTEGER)')).toBe('mutating');
    expect(classifySql('WITH d AS (SELECT id FROM t) DELETE FROM u WHERE id IN (SELECT id FROM d) AND x=1')).toBe(
      'mutating',
    );
  });

  it('(i) classifies destructive statements', () => {
    expect(classifySql('DROP TABLE customers')).toBe('destructive');
    expect(classifySql('ALTER TABLE t ADD COLUMN c TEXT')).toBe('destructive');
    expect(classifySql('DELETE FROM t')).toBe('destructive'); // no WHERE = whole-table wipe
    expect(classifySql('delete from t')).toBe('destructive');
    expect(classifySql('TRUNCATE t')).toBe('destructive');
  });

  it('(i) an empty / unparseable statement is unknown (fails closed)', () => {
    expect(classifySql('')).toBe('unknown');
    expect(classifySql('   -- only a comment')).toBe('unknown');
    expect(classifySql('FLARB the glorp')).toBe('unknown');
  });
});

// ─── (a) read-only runs without confirm ──────────────────────────────────────────

describe('d1Adapter.mutate exec — read-only', () => {
  it('(a) a SELECT runs WITHOUT confirm and returns effect read_only + rows', async () => {
    mockQuery.mockResolvedValueOnce(queryResult([{ id: 1 }, { id: 2 }], { rows_read: 2 }));
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: 'SELECT * FROM customers' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'exec',
      effect: 'read_only',
      destructive: false,
      rowsRead: 2,
      rowsWritten: 0,
    });
    expect(result.data?.rows).toHaveLength(2);
    // The executor was minted for scope.resourceId ONLY (isolation).
    expect(mockMakeExecutor).toHaveBeenCalledWith(scope.auth, scope.accountId, scope.resourceId);
  });
});

// ─── (b) mutating without confirm is gated ───────────────────────────────────────

describe('d1Adapter.mutate exec — confirm gate', () => {
  it('(b) an INSERT WITHOUT confirm → confirmation_required, reports the kind, NEVER queries', async () => {
    const result = await d1Adapter.mutate(scope, {
      action: 'exec',
      sql: 'INSERT INTO t (a) VALUES (?)',
      params: ['x'],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/mutat/i);
    expect(result.error?.message).toMatch(/confirm:true/i);
    // No query issued — the gate fired before execution.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(c) an UPDATE WITH confirm → runs; reports D1 rows_written / changed_db ground truth', async () => {
    mockQuery.mockResolvedValueOnce(queryResult([], { rows_written: 3, changed_db: true }));
    const result = await d1Adapter.mutate(scope, {
      action: 'exec',
      sql: 'UPDATE t SET a = ? WHERE id = ?',
      params: ['x', 5],
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'exec',
      effect: 'mutating',
      destructive: false,
      rowsWritten: 3,
      changedDb: true,
    });
    // (e) params forwarded verbatim.
    expect(mockQuery).toHaveBeenCalledWith('UPDATE t SET a = ? WHERE id = ?', ['x', 5]);
  });

  it('(g) an UNKNOWN leading keyword fails CLOSED (needs confirm)', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: 'FLARB the glorp' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/could not be verified read-only/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── (d) destructive flag + Time Travel note ─────────────────────────────────────

describe('d1Adapter.mutate exec — destructive', () => {
  it('(d) a DROP WITHOUT confirm → confirmation_required flagged destructive + Time Travel note', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: 'DROP TABLE customers' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/destructive/i);
    expect(result.error?.message).toMatch(/Time Travel/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(d) a DROP WITH confirm → runs and reports destructive:true', async () => {
    mockQuery.mockResolvedValueOnce(queryResult([], { changed_db: true }));
    const result = await d1Adapter.mutate(scope, {
      action: 'exec',
      sql: 'DROP TABLE customers',
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ effect: 'destructive', destructive: true, changedDb: true });
  });

  it('(d) a DELETE WITHOUT a WHERE is destructive (whole-table wipe)', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: 'DELETE FROM t' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/destructive/i);
  });
});

// ─── (f) isolation — shared-platform id refused ──────────────────────────────────

describe('d1Adapter.mutate exec — isolation', () => {
  it('(f) refuses the shared-platform D1 id (FORBIDDEN_DB_IDS) — never mints an executor', async () => {
    const forbiddenScope: ResolvedScope = {
      ...scope,
      resourceId: 'ea3e839a-c641-4861-ae30-dfc63bff8032',
    };
    const result = await d1Adapter.mutate(forbiddenScope, {
      action: 'exec',
      sql: 'SELECT 1',
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    expect(mockMakeExecutor).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── (h) input validation ────────────────────────────────────────────────────────

describe('d1Adapter.mutate exec — input validation', () => {
  it('(h) empty SQL → invalid_sql, no query', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: '   -- comment only ' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_sql');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(h) multiple statements → multi_statement, no query', async () => {
    const result = await d1Adapter.mutate(scope, {
      action: 'exec',
      sql: 'SELECT 1; DROP TABLE t',
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('multi_statement');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(h) a single trailing semicolon is allowed (not multi-statement)', async () => {
    mockQuery.mockResolvedValueOnce(queryResult([{ n: 1 }], { rows_read: 1 }));
    const result = await d1Adapter.mutate(scope, { action: 'exec', sql: 'SELECT 1;' });
    expect(result.ok).toBe(true);
    expect(result.data?.effect).toBe('read_only');
  });

  it('(h) unknown action → invalid_action, no query', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await d1Adapter.mutate(scope, { action: 'nuke', sql: 'SELECT 1' } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('maps a CF query failure to a typed error (never a fake success)', async () => {
    // The adapter's queryError reads `.status` structurally (not instanceof) — a thrown object with a 5xx
    // status maps to a retryable cf_server_error.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const result = await d1Adapter.mutate(scope, {
      action: 'exec',
      sql: 'INSERT INTO t (a) VALUES (1)',
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});
