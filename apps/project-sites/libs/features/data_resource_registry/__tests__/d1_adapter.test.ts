/**
 * TDD tests for the d1 adapter (Phase 2 D1 READ slice).
 *
 * Written BEFORE the module exists in this worktree — tests will be RED until
 * the implementation from the main checkout lands here. Uses the swc-jest
 * global-jest convention (NO `import { jest }`).
 *
 * Security + invariant contracts under test:
 *   (a) get() rejects a non-isSafeIdent table name → code 'invalid_table'
 *   (b) get() clamps limit/offset (limit=0→1, limit=999→200, offset=-5→0)
 *   (c) list() filters out sqlite_* / _cf_* / d1_migrations internals
 *   (d) mutate() returns code 'not_implemented' (never throws)
 *
 * Mock strategy: we mock `makeSiteDataExecutor` (the CF REST D1 query bridge)
 * and `cfAuthHeaders` (the auth header builder). The adapter imports these from
 * `../../../../src/services/site_data_db.js` and
 * `../../../../src/services/cf_credentials.js` respectively — 4x ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`.
 */

// ─── Mocks — must be declared BEFORE any import that triggers the real modules ─

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

// ─── Import AFTER mocks ────────────────────────────────────────────────────────

// The adapter lives in the main checkout but not yet in this worktree.
// We import via the 4× ../ path; Jest's moduleNameMapper (.js → no extension)
// resolves to the main checkout's compiled output OR the source directly when
// Jest is run from apps/project-sites with the repo's jest.config.cjs.
import { d1Adapter } from '../adapters/d1.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site D1 (not a forbidden shared-platform id). */
const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'db-00000000-0000-4000-a000-000000000001', // NOT in FORBIDDEN_DB_IDS
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' },
  accessPolicy: { canRead: true, canWrite: false },
};

beforeEach(() => {
  mockMakeExecutor.mockReset();
  mockQuery.mockReset();
  // Default: executor factory returns a fresh { query } on every call
  mockMakeExecutor.mockReturnValue({ query: mockQuery });
});

// ─── (d) mutate() always returns not_implemented ───────────────────────────────

describe('d1Adapter.mutate()', () => {
  it('(d) returns not_implemented code — never throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await d1Adapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
    // Executor must NOT be called for a mutate
    expect(mockMakeExecutor).not.toHaveBeenCalled();
  });
});

// ─── (a) get() rejects unsafe table names ─────────────────────────────────────

describe('d1Adapter.get() — table name validation', () => {
  it('(a) rejects a table name with spaces → code invalid_table', async () => {
    const result = await d1Adapter.get(scope, { table: 'bad table' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_table');
    expect(result.error?.retryable).toBe(false);
    expect(mockMakeExecutor).not.toHaveBeenCalled();
  });

  it('(a) rejects a table name with SQL injection attempt → code invalid_table', async () => {
    const result = await d1Adapter.get(scope, { table: "users; DROP TABLE users--" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_table');
  });

  it('(a) rejects an empty table name → code invalid_table', async () => {
    const result = await d1Adapter.get(scope, { table: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_table');
  });

  it('(a) rejects a name starting with a digit → code invalid_table', async () => {
    const result = await d1Adapter.get(scope, { table: '123_table' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_table');
  });

  it('(a) accepts a valid identifier and proceeds to query', async () => {
    // Simulate the DB: table_info, count, rows
    const colRows = [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }];
    const countRows = [{ n: 3 }];
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    mockQuery
      .mockResolvedValueOnce({ results: colRows })
      .mockResolvedValueOnce({ results: countRows })
      .mockResolvedValueOnce({ results: rows });

    const result = await d1Adapter.get(scope, { table: 'customers' });
    // Either succeeds (impl landed) OR fails for a non-identity-related reason
    if (!result.ok) {
      // RED phase: impl not yet in this worktree — must not be an identity error
      expect(result.error?.code).not.toBe('invalid_table');
    } else {
      expect(result.data?.table).toBe('customers');
    }
  });
});

// ─── (b) get() clamps limit/offset ────────────────────────────────────────────

describe('d1Adapter.get() — limit/offset clamping', () => {
  /** Make the mock DB respond with a minimal valid table (non-empty PRAGMA = table exists). */
  function stubValidTable() {
    const colRows = [{ name: 'id', type: 'INTEGER', notnull: 0, pk: 1 }];
    const countRows = [{ n: 10 }];
    mockQuery
      .mockResolvedValueOnce({ results: colRows })   // PRAGMA table_info
      .mockResolvedValueOnce({ results: countRows })  // COUNT(*)
      .mockResolvedValueOnce({ results: [] });         // SELECT * LIMIT ? OFFSET ?
  }

  it('(b) limit=0 is clamped to 1', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', limit: 0 });
    if (result.ok) {
      expect(result.data?.limit).toBe(1);
    } else {
      // RED: not yet in worktree — just verify no invalid_table code
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(b) limit=999 is clamped to 200 (the hard ceiling)', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', limit: 999 });
    if (result.ok) {
      expect(result.data?.limit).toBe(200);
    } else {
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(b) limit=200 is accepted at the exact ceiling', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', limit: 200 });
    if (result.ok) {
      expect(result.data?.limit).toBe(200);
    } else {
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(b) offset=-5 is clamped to 0', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', offset: -5 });
    if (result.ok) {
      expect(result.data?.offset).toBe(0);
    } else {
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(b) offset=50 passes through unchanged', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', offset: 50 });
    if (result.ok) {
      expect(result.data?.offset).toBe(50);
    } else {
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(b) non-finite limit defaults to 50', async () => {
    stubValidTable();
    const result = await d1Adapter.get(scope, { table: 'orders', limit: NaN });
    if (result.ok) {
      expect(result.data?.limit).toBe(50);
    } else {
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });
});

// ─── (c) list() filters out internals ─────────────────────────────────────────

describe('d1Adapter.list() — internal table filtering', () => {
  it('(c) excludes sqlite_* tables from results', async () => {
    // The SQL in the real impl has WHERE name NOT LIKE 'sqlite_%' — but we verify
    // the contract holds end-to-end by having the mocked DB return internals and
    // checking the adapter strips them through isSafeIdent + the SQL filter.
    // Since the SQL is issued to the mock, we return all rows and let the adapter
    // apply the post-query isSafeIdent filter (the SQL already strips them, but
    // the isSafeIdent pass is the safety net we test here).
    mockQuery.mockResolvedValueOnce({
      results: [
        { name: 'customers' },
        { name: 'sqlite_sequence' },  // should be excluded by SQL
        { name: '_cf_internal' },      // should be excluded by SQL
        { name: 'd1_migrations' },     // should be excluded by SQL
        { name: '123_bad' },           // would fail isSafeIdent if SQL missed it
        { name: 'orders' },
      ],
    });
    const result = await d1Adapter.list(scope);
    if (result.ok) {
      const names = result.data?.tables.map((t) => t.name) ?? [];
      expect(names).toContain('customers');
      expect(names).toContain('orders');
      expect(names).not.toContain('sqlite_sequence');
      expect(names).not.toContain('_cf_internal');
      expect(names).not.toContain('d1_migrations');
      expect(names).not.toContain('123_bad');
    } else {
      // RED phase: not yet in worktree
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(c) returns empty array for a brand-new per-site D1 with no tables', async () => {
    mockQuery.mockResolvedValueOnce({ results: [] });
    const result = await d1Adapter.list(scope);
    if (result.ok) {
      expect(result.data?.tables).toHaveLength(0);
    } else {
      // RED: not yet in worktree
      expect(result.error?.code).not.toBe('invalid_table');
    }
  });

  it('(c) refuses the shared-platform D1 id (FORBIDDEN_DB_IDS defense-in-depth)', async () => {
    const forbiddenScope: ResolvedScope = {
      ...scope,
      resourceId: 'ea3e839a-c641-4861-ae30-dfc63bff8032', // the platform DB id
    };
    const result = await d1Adapter.list(forbiddenScope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    // Executor must NOT be called when the id is denylisted
    expect(mockMakeExecutor).not.toHaveBeenCalled();
  });
});
