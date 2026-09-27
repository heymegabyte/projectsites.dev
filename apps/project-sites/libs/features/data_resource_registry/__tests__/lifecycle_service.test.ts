/**
 * TDD tests for lifecycle_service — teardown + environment-assignment (FIRE 5).
 *
 * Uses the REAL-SQLite harness (`createD1Sqlite`) so the service runs its ACTUAL SQL against seeded
 * `site_resource_registry` rows (ground-truth reconciliation, per verify-against-source-of-truth), and
 * mocks only the CF edges (`cf_credentials` + global `fetch`) and the ownership guard. Global-jest
 * convention (NO `import { jest }`).
 *
 * Contracts under test:
 *   (a) teardown of an UNPROTECTED resource → issues the CF DELETE + SOFT-DELETES the registry row (retired)
 *   (b) teardown of a PROTECTED resource → refuses `deletion_protected`, NO CF DELETE, row untouched
 *   (c) teardown of a kind with NO owned row → `not_registered`
 *   (d) teardown treats a CF 404 as idempotent success (already gone) + still soft-deletes the row
 *   (e) listEnvironmentAssignments groups a site's rows into preview/production slots per kind
 */

// ─── Mocks — declared BEFORE the import that triggers the real modules ───────────

const assertSiteOwned = jest.fn(async () => true);
const resolveCfCredentials = jest.fn(async () => ({ kind: 'token', token: 't' }));

jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: (...a: unknown[]) => assertSiteOwned(...a),
}));
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: () => ({ authorization: 'Bearer t' }),
  resolveCfCredentials: (...a: unknown[]) => resolveCfCredentials(...a),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';
import { listEnvironmentAssignments, teardownResource } from '../lifecycle_service.js';

// ─── Registry table (the columns the service reads/writes) ───────────────────────

const REGISTRY_DDL = `
CREATE TABLE site_resource_registry (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  site_id TEXT,
  environment TEXT,
  resource_concept TEXT,
  resource_kind TEXT,
  tenancy TEXT,
  resource_id_or_name TEXT,
  resource_display_name TEXT,
  binding_name TEXT,
  lifecycle_state TEXT,
  deletion_protected INTEGER DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT,
  updated_at TEXT
);`;

function seedRow(h: D1SqliteHarness, over: Record<string, unknown>) {
  const row = {
    binding_name: null,
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    deletion_protected: 0,
    environment: 'production',
    id: 'row-1',
    lifecycle_state: 'active',
    org_id: 'org-1',
    resource_concept: 'account_resource',
    resource_display_name: 'ps-site-abc',
    resource_id_or_name: 'ps-site-abc',
    resource_kind: 'r2',
    site_id: 'site-1',
    tenancy: 'dedicated',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
  const cols = Object.keys(row);
  h.raw
    .prepare(`INSERT INTO site_resource_registry (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...(cols.map((c) => (row as Record<string, unknown>)[c]) as never[]));
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;
let h: D1SqliteHarness;

beforeEach(() => {
  jest.clearAllMocks();
  assertSiteOwned.mockResolvedValue(true);
  resolveCfCredentials.mockResolvedValue({ kind: 'token', token: 't' });
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  h = createD1Sqlite();
  h.exec(REGISTRY_DDL);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.close();
});

function env(): Env {
  return { CF_ACCOUNT_ID: 'acct-1', DB: h.db } as unknown as Env;
}

describe('teardownResource', () => {
  it('deletes the CF resource + soft-deletes (retires) the registry row for an unprotected resource', async () => {
    seedRow(h, { deletion_protected: 0 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await teardownResource(env(), 'site-1', 'org-1', 'production', 'r2');
    expect(res.ok).toBe(true);

    // CF DELETE was issued against the r2 bucket path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/r2/buckets/ps-site-abc');

    // The registry row is soft-deleted + retired (ground truth).
    const row = h.raw.prepare('SELECT deleted_at, lifecycle_state FROM site_resource_registry WHERE id = ?').get('row-1') as {
      deleted_at: string | null;
      lifecycle_state: string;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(row.lifecycle_state).toBe('retired');
  });

  it('refuses a PROTECTED resource — no CF DELETE, row untouched', async () => {
    seedRow(h, { deletion_protected: 1 });
    const res = await teardownResource(env(), 'site-1', 'org-1', 'production', 'r2');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('deletion_protected');
    expect(fetchMock).not.toHaveBeenCalled();
    const row = h.raw.prepare('SELECT deleted_at FROM site_resource_registry WHERE id = ?').get('row-1') as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it('returns not_registered when the kind has no owned row', async () => {
    const res = await teardownResource(env(), 'site-1', 'org-1', 'production', 'kv');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_registered');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a CF 404 as idempotent success + still soft-deletes the row', async () => {
    seedRow(h, { deletion_protected: 0, resource_kind: 'd1', resource_id_or_name: 'db-uuid' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const res = await teardownResource(env(), 'site-1', 'org-1', 'production', 'd1');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deletedCfResource).toBe(false); // 404 → CF resource wasn't there
    const row = h.raw.prepare('SELECT deleted_at FROM site_resource_registry WHERE id = ?').get('row-1') as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('listEnvironmentAssignments', () => {
  it('groups a site rows into preview/production slots per kind', async () => {
    seedRow(h, { id: 'r-kv-prod', resource_kind: 'kv', environment: 'production', resource_display_name: 'kv-prod' });
    seedRow(h, { id: 'r-kv-prev', resource_kind: 'kv', environment: 'preview', resource_display_name: 'kv-prev' });
    seedRow(h, { id: 'r-r2-prod', resource_kind: 'r2', environment: 'production', resource_display_name: 'r2-prod' });

    const grid = await listEnvironmentAssignments(env(), 'site-1', 'org-1');
    const kv = grid.find((g) => g.kind === 'kv');
    const r2 = grid.find((g) => g.kind === 'r2');

    expect(kv?.preview.present).toBe(true);
    expect(kv?.production.present).toBe(true);
    expect(kv?.production.displayName).toBe('kv-prod');

    expect(r2?.production.present).toBe(true);
    expect(r2?.preview.present).toBe(false); // no preview r2 row seeded
  });
});
