/**
 * `GET /api/sites/:siteId/snapshots` surfaces `commit_iso` on every row.
 *
 * The snapshots list carries two timelines: the sparse D1 `site_snapshots`
 * rows (user-named save-points) and the dense R2 git commit chain
 * (`gitHistory`). A snapshot's `build_version` IS the R2 version path, so it is
 * the JOIN KEY against `gitHistory[].buildVersion` — when they match, the git
 * entry's `date` is the authoritative commit timestamp and belongs on the row
 * as `commit_iso`. When there is no match, the row's own `created_at` is the
 * correct fallback (to within seconds for UI-created snapshots, since the push
 * fires right after the D1 insert).
 *
 * Contract under test:
 *   1. `build_version` matches a git entry  → `commit_iso === thatEntry.date`
 *   2. no git entry matches                 → `commit_iso === row.created_at`
 *   3. git history empty OR `getHistory()` throws → rows STILL return, with
 *      `commit_iso === row.created_at` (a broken git store must never 500 the
 *      snapshot list — the D1 rows are the source of truth for the list itself)
 *   4. `git_history` is still returned unchanged alongside the enriched rows.
 *
 * Only boundaries are mocked (db helpers + the git service); the real Hono app
 * + shared errorHandler run, matching the sibling `site_detail_tabs_routes`
 * convention.
 */
jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
}));
jest.mock('../services/git.js', () => ({
  getHistory: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { siteVersioning } from '../../libs/features/site_versioning/handlers.js';
import { dbQuery, dbQueryOne } from '../services/db.js';
import { getHistory } from '../services/git.js';

const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockGetHistory = getHistory as unknown as jest.Mock;

// ─── Boundary harness ─────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    SITES_BUCKET: {} as R2Bucket,
  } as unknown as Env;
}

function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', siteVersioning);
  return app;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

const AUTH: Partial<Variables> = { userId: 'user-1', orgId: 'org-1', requestId: 'req-1' };
const SITE = 'site-1';
const PATH = `/api/sites/${SITE}/snapshots`;

/** The site row `requireOwnedSite` returns (needs `slug` to walk git history). */
const SITE_ROW = { slug: 'acme-coffee' };

/** A D1 snapshot row as selected by the handler. */
function snap(id: string, buildVersion: string, createdAt: string) {
  return {
    id,
    snapshot_name: id,
    build_version: buildVersion,
    description: null,
    created_at: createdAt,
  };
}

/** A git-history entry as returned by `getHistory`. */
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

interface Row {
  id: string;
  build_version: string;
  created_at: string;
  commit_iso: string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQueryOne.mockResolvedValue(SITE_ROW);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/sites/:siteId/snapshots — commit_iso enrichment', () => {
  it('stamps commit_iso from the matching git entry (build_version is the join key)', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z')],
    });
    mockGetHistory.mockResolvedValueOnce([
      commit('2026-06-01T10:00:07Z', 'v1735000000000'), // the real commit moment
      commit('2026-05-31T09:00:00Z', 'v1734000000000'),
    ]);

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: Row[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].commit_iso).toBe('2026-06-01T10:00:07Z');
    // The D1 row's own fields survive untouched.
    expect(json.data[0]).toMatchObject({
      id: 'initial',
      build_version: 'v1735000000000',
      created_at: '2026-06-01T10:00:00Z',
    });
  });

  it('falls back to created_at when no git entry carries that build_version', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [snap('orphan', 'v1735999999999', '2026-06-02T08:30:00Z')],
    });
    mockGetHistory.mockResolvedValueOnce([
      commit('2026-06-01T10:00:07Z', 'v1735000000000'), // different version
      commit('2026-06-01T09:00:00Z'), // no buildVersion at all
    ]);

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    const json = (await res.json()) as { data: Row[] };
    expect(json.data[0].commit_iso).toBe('2026-06-02T08:30:00Z');
  });

  it('still returns every row with created_at fallback when git history is EMPTY', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [
        snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z'),
        snap('v2', 'v1736000000000', '2026-06-03T11:00:00Z'),
      ],
    });
    mockGetHistory.mockResolvedValueOnce([]);

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Row[] };
    expect(json.data.map((r) => r.commit_iso)).toEqual([
      '2026-06-01T10:00:00Z',
      '2026-06-03T11:00:00Z',
    ]);
  });

  it('still returns every row with created_at fallback when getHistory THROWS', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z')],
    });
    mockGetHistory.mockRejectedValueOnce(new Error('R2 unreachable'));

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Row[] };
    expect(json.data[0].commit_iso).toBe('2026-06-01T10:00:00Z');
  });

  it('enriches per-row (mixed match / no-match) and keeps git_history intact', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [
        snap('initial', 'v1735000000000', '2026-06-01T10:00:00Z'),
        snap('orphan', 'v1735999999999', '2026-06-02T08:30:00Z'),
      ],
    });
    const history = [
      commit('2026-06-01T10:00:07Z', 'v1735000000000'),
      commit('2026-06-01T09:00:00Z', 'v1734000000000'),
    ];
    mockGetHistory.mockResolvedValueOnce(history);

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    const json = (await res.json()) as { data: Row[]; git_history: unknown[] };
    expect(json.data[0].commit_iso).toBe('2026-06-01T10:00:07Z'); // matched
    expect(json.data[1].commit_iso).toBe('2026-06-02T08:30:00Z'); // fell back
    // The raw commit trail is still delivered verbatim.
    expect(json.git_history).toEqual(history);
    // Slug from the ownership guard is what walks the git chain.
    expect(mockGetHistory).toHaveBeenCalledWith(expect.anything(), 'acme-coffee');
  });

  it('returns an empty list (not a 500) when the site has no snapshots', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [] });
    mockGetHistory.mockResolvedValueOnce([]);

    const res = await makeApp(AUTH).request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Row[] };
    expect(json.data).toEqual([]);
  });

  it('401s when unauthenticated and never touches the DB or git store', async () => {
    const res = await makeApp().request(PATH, { method: 'GET' }, makeEnv(), makeCtx());
    expect(res.status).toBe(401);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockGetHistory).not.toHaveBeenCalled();
  });
});
