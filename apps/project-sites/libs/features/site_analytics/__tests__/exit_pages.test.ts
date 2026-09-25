/**
 * Tests for:
 * 1. `getExitPagesSummary` service — row folding (null path skipped, count≤0 skipped) + error path
 *    + the window-function query shape (LAST page_engagement per session `sid`).
 * 2. `GET /api/sites/:siteId/analytics/exit-pages` route — tenant boundary (404 foreign-org / 200 owned).
 *
 * Mirrors entry_pages.test.ts: the REAL `dbQuery` runs against a D1 double (no module mock), so the
 * ownership `SELECT org_id FROM sites` AND the aggregator query both resolve through the same double.
 */
import { getExitPagesSummary } from '../../visitor_events_core/service.js';
import type { ExitPagesSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * D1 double: serves the ownership row (`SELECT org_id FROM sites`) and the aggregator's `GROUP BY`
 * rows, capturing every SQL string. `throwOnGroup` simulates a D1 failure for the fail-soft path.
 */
function db(
  opts: {
    owner?: string | null;
    pageRows?: Array<{ path: string | null; n: number }>;
    throwOnGroup?: boolean;
    sqls?: string[];
  } = {},
): D1Database {
  const { owner = 'org1', pageRows = [], throwOnGroup = false, sqls = [] } = opts;
  function prepare(sql: string) {
    sqls.push(sql);
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (owner ? [{ org_id: owner }] : []) as unknown as T[] };
        }
        if (sql.includes('GROUP BY')) {
          if (throwOnGroup) throw new Error('D1 timeout');
          return { results: pageRows as unknown as T[] };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

function makeEnv(database: D1Database): Env {
  return { DB: database } as unknown as Env;
}

// ─── 1. Aggregator ───────────────────────────────────────────────────────────

describe('getExitPagesSummary — aggregator', () => {
  it('returns pages sorted by count, skipping null path rows', async () => {
    const env = makeEnv(
      db({
        pageRows: [
          { path: '/contact', n: 12 },
          { path: '/', n: 7 },
          { path: null, n: 3 },
        ],
      }),
    );
    const result: ExitPagesSummary = await getExitPagesSummary(env, 'site1', 30);
    expect(result).toEqual({
      pages: [
        { path: '/contact', count: 12 },
        { path: '/', count: 7 },
      ],
    });
  });

  it('picks the LAST page per session — window function partitioned by the sid, page_engagement only', async () => {
    const sqls: string[] = [];
    await getExitPagesSummary(makeEnv(db({ sqls })), 'site1', 30);
    const q = sqls.find((s) => s.includes('ROW_NUMBER'));
    expect(q).toBeDefined();
    // last-per-session: ranked DESC by time, partitioned by the session id, then rn = 1
    expect(q!).toContain("PARTITION BY json_extract(metadata, '$.sid')");
    expect(q!).toContain('ORDER BY created_at DESC');
    expect(q!).toContain('rn = 1');
    expect(q!).toContain("event_type = 'page_engagement'");
    // sessions with no sid (storage unavailable) are excluded, never guessed
    expect(q!).toContain("json_extract(metadata, '$.sid') IS NOT NULL");
  });

  it('returns empty pages array when the query errors (fail-soft)', async () => {
    const env = makeEnv(db({ throwOnGroup: true }));
    const result = await getExitPagesSummary(env, 'site1', 30);
    expect(result).toEqual({ pages: [] });
  });
});

// ─── 2. Route — tenant boundary ──────────────────────────────────────────────

const EXIT_PAGES_URL = '/api/sites/site1/analytics/exit-pages';

describe('GET /api/sites/:siteId/analytics/exit-pages — tenant boundary', () => {
  it('404 when the site belongs to a different org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(EXIT_PAGES_URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + JSON summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      EXIT_PAGES_URL,
      {},
      harnessEnv(
        db({
          owner: 'org1',
          pageRows: [
            { path: '/contact', n: 12 },
            { path: '/', n: 7 },
            { path: null, n: 3 },
          ],
        }),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExitPagesSummary;
    expect(body).toEqual({
      pages: [
        { path: '/contact', count: 12 },
        { path: '/', count: 7 },
      ],
    });
  });
});
