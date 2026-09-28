/**
 * Unit coverage for `enrichWithCommitIso` — the pure JOIN that stamps
 * `commit_iso` on every `site_snapshots` row for the version-history UI
 * (`frontend/.../sections/snapshots.component.ts`, which reads `commit_iso`
 * with a `created_at` fallback).
 *
 * The sibling `src/__tests__/site_versioning_commit_iso.test.ts` exercises the
 * SAME contract end-to-end through the real Hono route (DB + git mocked). This
 * spec pins the join in ISOLATION so a regression in the pure logic surfaces
 * without booting the HTTP stack — and so the helper stays a safe, reusable
 * primitive for any future surface (batch history, exports).
 *
 * The helper is pure (no I/O), so the two boundary modules `handlers.ts`
 * statically imports are mocked purely to keep the module graph light under
 * jest — the helper itself never calls them.
 */
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
}));
jest.mock('../../../../src/services/site_ownership.js', () => ({
  requireOwnedSite: jest.fn(),
}));
jest.mock('../../../../src/services/audit.js', () => ({
  writeAuditLog: jest.fn(),
  auditSiteLabelDb: jest.fn(),
}));

import { enrichWithCommitIso, type SnapshotRow } from '../handlers.js';

/** A `site_snapshots` row as the list route selects it. */
function snap(id: string, buildVersion: string, createdAt: string): SnapshotRow {
  return {
    id,
    snapshot_name: id,
    build_version: buildVersion,
    description: null,
    created_at: createdAt,
  };
}

/** A `getHistory()` commit summary (only the two join-relevant fields matter). */
function commit(date: string, buildVersion?: string) {
  return {
    sha: `sha-${buildVersion ?? date}`,
    message: `build ${buildVersion ?? date}`,
    date,
    author: 'system',
    fileCount: 3,
    ...(buildVersion ? { buildVersion } : {}),
  };
}

describe('enrichWithCommitIso — build_version → git date join', () => {
  it('stamps commit_iso from the matching git entry (build_version is the join key)', () => {
    const out = enrichWithCommitIso(
      [snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z')],
      [
        commit('2026-06-01T10:00:07Z', 'v1735000000000'), // the real commit moment
        commit('2026-05-31T09:00:00Z', 'v1734000000000'),
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].commit_iso).toBe('2026-06-01T10:00:07Z');
    // Original columns survive untouched.
    expect(out[0]).toMatchObject({
      id: 'initial',
      build_version: 'v1735000000000',
      created_at: '2026-06-01T10:00:00Z',
      description: null,
    });
  });

  it('falls back to created_at when no git entry carries that build_version', () => {
    const out = enrichWithCommitIso(
      [snap('orphan', 'v1735999999999', '2026-06-02T08:30:00Z')],
      [
        commit('2026-06-01T10:00:07Z', 'v1735000000000'), // different version
        commit('2026-06-01T09:00:00Z'), // no buildVersion at all → never matches
      ],
    );
    expect(out[0].commit_iso).toBe('2026-06-02T08:30:00Z');
  });

  it('degrades every row to created_at when git history is EMPTY (broken/empty store)', () => {
    const out = enrichWithCommitIso(
      [
        snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z'),
        snap('v2', 'v1736000000000', '2026-06-03T11:00:00Z'),
      ],
      [],
    );
    expect(out.map((r) => r.commit_iso)).toEqual([
      '2026-06-01T10:00:00Z',
      '2026-06-03T11:00:00Z',
    ]);
  });

  it('enriches per-row (mixed match / no-match) and preserves input order', () => {
    const out = enrichWithCommitIso(
      [
        snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z'),
        snap('orphan', 'v1735999999999', '2026-06-02T08:30:00Z'),
      ],
      [
        commit('2026-06-01T10:00:07Z', 'v1735000000000'),
        commit('2026-06-01T09:00:00Z', 'v1734000000000'),
      ],
    );
    expect(out[0].commit_iso).toBe('2026-06-01T10:00:07Z'); // matched
    expect(out[1].commit_iso).toBe('2026-06-02T08:30:00Z'); // fell back
    expect(out.map((r) => r.id)).toEqual(['initial', 'orphan']); // order kept
  });

  it('uses the FIRST matching commit when several share a build_version (HEAD-first wins)', () => {
    const out = enrichWithCommitIso(
      [snap('dup', 'v1735000000000', '2026-06-01T10:00:00Z')],
      [
        commit('2026-06-01T10:05:00Z', 'v1735000000000'), // HEAD (newer) — wins
        commit('2026-06-01T10:00:07Z', 'v1735000000000'), // older duplicate
      ],
    );
    expect(out[0].commit_iso).toBe('2026-06-01T10:05:00Z');
  });

  it('returns an empty array for an empty row set (never throws)', () => {
    expect(enrichWithCommitIso([], [])).toEqual([]);
    expect(enrichWithCommitIso([], [commit('2026-06-01T10:00:07Z', 'v1')])).toEqual([]);
  });

  it('does not mutate the input rows (returns fresh objects)', () => {
    const rows = [snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z')];
    const out = enrichWithCommitIso(rows, [commit('2026-06-01T10:00:07Z', 'v1735000000000')]);
    expect(rows[0]).not.toHaveProperty('commit_iso'); // source untouched
    expect(out[0]).not.toBe(rows[0]); // fresh object
  });
});
