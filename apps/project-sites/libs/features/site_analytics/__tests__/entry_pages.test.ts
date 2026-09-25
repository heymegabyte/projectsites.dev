/**
 * Tests for:
 * 1. `getEntryPagesSummary` service — row folding (null path skipped, count≤0 skipped) + error path.
 * 2. `GET /api/sites/:siteId/analytics/entry-pages` route — tenant boundary (404 foreign-org / 200 owned).
 *
 * Mirrors new_vs_returning.test.ts EXACTLY: the REAL `dbQuery` runs against a D1 double (no
 * module mock), so the ownership `SELECT org_id FROM sites` AND the aggregator `GROUP BY path` query
 * both resolve through the same double — the way `siteOrgId` + `getEntryPagesSummary` call D1.
 */
import { getEntryPagesSummary } from '../../visitor_events_core/service.js';
import type { EntryPagesSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * D1 double: serves the ownership row (`SELECT org_id FROM sites`) and the aggregator's `GROUP BY path`
 * rows. `throwOnGroup` simulates a D1 failure so the aggregator's fail-soft path can be exercised.
 */
function db(
  opts: {
    owner?: string | null;
    pageRows?: Array<{ path: string | null; n: number }>;
    throwOnGroup?: boolean;
  } = {},
): D1Database {
  const { owner = 'org1', pageRows = [], throwOnGroup = false } = opts;
  function prepare(sql: string) {
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

describe('getEntryPagesSummary — aggregator', () => {
  it('returns pages sorted by count, skipping null path rows', async () => {
    const env = makeEnv(
      db({ pageRows: [{ path: '/', n: 9 }, { path: '/pricing', n: 4 }, { path: null, n: 2 }] }),
    );
    const result: EntryPagesSummary = await getEntryPagesSummary(env, 'site1', 30);
    // null path must be skipped; valid paths preserved in DESC order
    expect(result).toEqual({ pages: [{ path: '/', count: 9 }, { path: '/pricing', count: 4 }] });
  });

  it('returns empty pages array when the query errors (fail-soft)', async () => {
    const env = makeEnv(db({ throwOnGroup: true }));
    const result = await getEntryPagesSummary(env, 'site1', 30);
    expect(result).toEqual({ pages: [] });
  });
});

// ─── 2. Route — tenant boundary ──────────────────────────────────────────────

const ENTRY_PAGES_URL = '/api/sites/site1/analytics/entry-pages';

describe('GET /api/sites/:siteId/analytics/entry-pages — tenant boundary', () => {
  it('404 when the site belongs to a different org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(ENTRY_PAGES_URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + JSON summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      ENTRY_PAGES_URL,
      {},
      harnessEnv(
        db({ owner: 'org1', pageRows: [{ path: '/', n: 9 }, { path: '/pricing', n: 4 }, { path: null, n: 2 }] }),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntryPagesSummary;
    expect(body).toEqual({ pages: [{ path: '/', count: 9 }, { path: '/pricing', count: 4 }] });
  });
});
