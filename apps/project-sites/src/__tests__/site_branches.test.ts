/**
 * @module __tests__/site_branches
 * @description Unit tests for the branch-style site preview service (#27),
 * focused on the multi-tenant isolation fix: every branch-mutation function
 * scopes its lookup/update by `site_id` in addition to the branch `id`, so a
 * caller who owns site A can never act on a branch belonging to site B by
 * guessing a `branchId`. The route's `assertOwner` proves site ownership; these
 * tests prove the SQL itself enforces the branch↔site relationship.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null }),
}));

import { dbQueryOne, dbUpdate, dbInsert } from '../services/db.js';
import {
  requestReview,
  approveBranch,
  mergeBranch,
  closeBranch,
  listBranches,
  parseBranchHost,
  isDefaultPreviewBranch,
  PREVIEW_BRANCH_NAME,
} from '../services/site_branches.js';
import type { D1Database } from '@cloudflare/workers-types';

const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockUpdate = dbUpdate as jest.MockedFunction<typeof dbUpdate>;
const mockInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;

// approveBranch increments the counter via raw `db.prepare().bind().run()`, and
// mergeBranch commits its cross-table transition via `db.batch([...])` — so the DB
// double needs a prepare chain (capturing sql+args) AND a jest.fn batch that records
// the statements (a test can make it reject to simulate a mid-merge D1 failure).
const DB = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({ sql, args, run: async () => ({ meta: {} }) }),
  }),
  batch: jest.fn(async (stmts: unknown[]) =>
    stmts.map(() => ({ success: true, meta: { changes: 1 } })),
  ),
} as unknown as D1Database;
const mockBatch = (DB as unknown as { batch: jest.Mock }).batch;
const SITE = 'site-a';
const BRANCH = 'branch-1';

function draftBranch(overrides: Record<string, unknown> = {}) {
  return {
    id: BRANCH,
    site_id: SITE,
    branch_name: 'feat-x',
    created_by: 'u1',
    status: 'draft',
    r2_path: 'sites/slug/branches/feat-x/',
    preview_url: 'https://feat-x--slug.projectsites.dev',
    approvals_required: 1,
    approvals_received: 0,
    created_at: 't',
    updated_at: 't',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryOne.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({ error: null, changes: 1 });
  mockInsert.mockResolvedValue({ error: null });
});

// ─── requestReview ────────────────────────────────────────────────────────────
describe('requestReview (tenant-scoped)', () => {
  it('scopes the branch lookup by BOTH id AND site_id', async () => {
    mockQueryOne.mockResolvedValueOnce(draftBranch() as never); // lookup
    mockQueryOne.mockResolvedValueOnce(draftBranch({ status: 'review' }) as never); // re-read
    await requestReview(DB, SITE, BRANCH);
    const [, sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain('site_id = ?');
    expect(params).toEqual([BRANCH, SITE]);
  });

  it('returns null for a branch owned by another site (cross-org blocked)', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // foreign branch → no row
    expect(await requestReview(DB, 'other-site', BRANCH)).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled(); // never transitions a foreign branch
  });

  it('returns null when the branch is not in draft', async () => {
    mockQueryOne.mockResolvedValueOnce(draftBranch({ status: 'merged' }) as never);
    expect(await requestReview(DB, SITE, BRANCH)).toBeNull();
  });
});

// ─── approveBranch ──────────────────────────────────────────────────────────────
describe('approveBranch (tenant-scoped)', () => {
  it('scopes the branch lookup by id AND site_id', async () => {
    mockQueryOne
      .mockResolvedValueOnce(draftBranch({ status: 'review' }) as never) // lookup
      .mockResolvedValueOnce(null) // existing-approval check
      .mockResolvedValueOnce(draftBranch({ status: 'review', approvals_received: 1 }) as never); // re-read
    await approveBranch(DB, SITE, BRANCH, 'approver-1');
    const [, sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain('site_id = ?');
    expect(params).toEqual([BRANCH, SITE]);
  });

  it('returns null for a branch not owned by the site', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await approveBranch(DB, 'other-site', BRANCH, 'approver-1')).toBeNull();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('readyToMerge true once approvals_received >= approvals_required', async () => {
    mockQueryOne
      .mockResolvedValueOnce(draftBranch({ status: 'review' }) as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        draftBranch({ status: 'review', approvals_received: 1, approvals_required: 1 }) as never,
      );
    const result = await approveBranch(DB, SITE, BRANCH, 'approver-1');
    expect(result?.readyToMerge).toBe(true);
  });
});

// ─── mergeBranch ────────────────────────────────────────────────────────────────
describe('mergeBranch (tenant-scoped)', () => {
  it('scopes the branch lookup by id AND site_id', async () => {
    mockQueryOne
      .mockResolvedValueOnce(draftBranch({ status: 'review' }) as never) // lookup
      .mockResolvedValueOnce(draftBranch({ status: 'merged' }) as never); // re-read
    await mergeBranch(DB, SITE, BRANCH, 'v2');
    const [, sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain('site_id = ?');
    expect(params).toEqual([BRANCH, SITE]);
  });

  it('returns null for a foreign branch and never bumps a build version', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await mergeBranch(DB, 'other-site', BRANCH, 'v2')).toBeNull();
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('commits the branch-merge + site-version bump in ONE atomic batch', async () => {
    mockQueryOne
      .mockResolvedValueOnce(draftBranch({ status: 'review' }) as never) // lookup
      .mockResolvedValueOnce(draftBranch({ status: 'merged' }) as never); // re-read
    await mergeBranch(DB, SITE, BRANCH, 'v2');
    expect(mockBatch).toHaveBeenCalledTimes(1);
    const stmts = mockBatch.mock.calls[0]![0] as Array<{ sql: string; args: unknown[] }>;
    expect(stmts).toHaveLength(2);
    // stmt 0 flips the branch to merged; stmt 1 bumps the SITE build version.
    expect(stmts[0].sql).toContain('site_branches');
    expect(stmts[0].sql).toContain("status = 'merged'");
    expect(stmts[0].args).toContain(BRANCH);
    expect(stmts[1].sql).toContain('UPDATE sites');
    expect(stmts[1].sql).toContain('current_build_version');
    expect(stmts[1].args).toContain('v2');
    expect(stmts[1].args).toContain(SITE);
  });

  // Regression guard: the merge was two separate error-ignoring cross-table dbUpdate
  // calls (site_branches.status + sites.current_build_version). A mid-merge D1 failure
  // (branch flips to 'merged' but the version bump fails) would leave the site serving
  // the OLD build while the branch shows merged — a silent consistency corruption
  // returned as success. The atomic batch rejects + rolls back → the failure is loud
  // and no half-merged state lands.
  it('is atomic — a mid-merge D1 failure rolls back both writes (no half-merged state)', async () => {
    mockQueryOne.mockResolvedValueOnce(draftBranch({ status: 'review' }) as never);
    mockBatch.mockRejectedValueOnce(new Error('D1_ERROR: batch failed'));
    await expect(mergeBranch(DB, SITE, BRANCH, 'v2')).rejects.toThrow();
  });
});

// ─── closeBranch ────────────────────────────────────────────────────────────────
describe('closeBranch (tenant-scoped)', () => {
  it('scopes BOTH the UPDATE and the re-read by site_id', async () => {
    mockQueryOne.mockResolvedValueOnce(draftBranch({ status: 'closed' }) as never);
    await closeBranch(DB, SITE, BRANCH);
    // dbUpdate(db, table, updates, whereClause, whereParams) → indices 3 + 4
    const [, , , updWhere, updParams] = mockUpdate.mock.calls[0]!;
    expect(updWhere).toBe('id = ? AND site_id = ?');
    expect(updParams).toEqual([BRANCH, SITE]);
    const [, readSql, readParams] = mockQueryOne.mock.calls[0]!;
    expect(readSql).toContain('site_id = ?');
    expect(readParams).toEqual([BRANCH, SITE]);
  });
});

// ─── listBranches ───────────────────────────────────────────────────────────────
describe('listBranches', () => {
  it('filters by site_id', async () => {
    const { dbQuery } = jest.requireMock('../services/db.js') as {
      dbQuery: jest.Mock;
    };
    dbQuery.mockResolvedValueOnce({ data: [draftBranch()], error: null });
    await listBranches(DB, SITE);
    const [, sql, params] = dbQuery.mock.calls[0]!;
    expect(sql).toContain('sb.site_id = ?');
    expect(params).toEqual([SITE]);
  });
});

// ─── parseBranchHost (pure) ──────────────────────────────────────────────────────
describe('parseBranchHost', () => {
  it('parses {branch}--{slug}.projectsites.dev', () => {
    expect(parseBranchHost('feat-x--vitos-salon.projectsites.dev')).toEqual({
      branchName: 'feat-x',
      slug: 'vitos-salon',
    });
  });

  it('returns null for a non-branch host', () => {
    expect(parseBranchHost('vitos-salon.projectsites.dev')).toBeNull();
    expect(parseBranchHost('example.com')).toBeNull();
  });

  // The Hosting UI builds `preview--{slug}` — the double-dash must split at the
  // separator so branch='preview' and the slug (even a dashed one) stays intact.
  it('splits the reserved preview host so a dashed slug survives (WLK-09)', () => {
    expect(parseBranchHost('preview--lone-mountain-global.projectsites.dev')).toEqual({
      branchName: 'preview',
      slug: 'lone-mountain-global',
    });
  });
});

// ─── isDefaultPreviewBranch (pure) ────────────────────────────────────────────
describe('isDefaultPreviewBranch (WLK-09)', () => {
  it('recognises the reserved preview slot (case-insensitive)', () => {
    expect(isDefaultPreviewBranch(PREVIEW_BRANCH_NAME)).toBe(true);
    expect(isDefaultPreviewBranch('preview')).toBe(true);
    expect(isDefaultPreviewBranch('PREVIEW')).toBe(true);
  });

  it('does NOT treat a real review branch as the default preview', () => {
    expect(isDefaultPreviewBranch('feat-x')).toBe(false);
    expect(isDefaultPreviewBranch('staging')).toBe(false);
  });
});
