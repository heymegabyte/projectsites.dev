/**
 * Tests for:
 * 1. `getConciergeEngagementSummary` — folds concierge_open/concierge_message COUNTs into
 *    opens/messages/uniqueVisitors + computes messages-per-open; honest empty (null rate);
 *    fail-soft; the `event_type IN (concierge_*)` query shape.
 * 2. `GET /api/sites/:siteId/analytics/concierge` — tenant boundary (404 foreign / 200 owned).
 *
 * Mirrors exit_pages.test.ts: the REAL `dbQuery` runs against a D1 double (no module mock).
 */
import { getConciergeEngagementSummary } from '../../visitor_events_core/service.js';
import type { ConciergeEngagementSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

function db(
  opts: {
    owner?: string | null;
    rows?: Array<{ event_type: string; n: number; u: number }>;
    throwOnGroup?: boolean;
    sqls?: string[];
  } = {},
): D1Database {
  const { owner = 'org1', rows = [], throwOnGroup = false, sqls = [] } = opts;
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
          return { results: rows as unknown as T[] };
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

describe('getConciergeEngagementSummary — aggregator', () => {
  it('folds opens/messages/uniqueVisitors + computes messages-per-open', async () => {
    const r = await getConciergeEngagementSummary(
      makeEnv(
        db({
          rows: [
            { event_type: 'concierge_open', n: 10, u: 7 },
            { event_type: 'concierge_message', n: 25, u: 6 },
          ],
        }),
      ),
      'site1',
      30,
    );
    expect(r).toEqual({ opens: 10, messages: 25, uniqueVisitors: 7, messagesPerOpen: 2.5 });
  });

  it('honest empty (null messagesPerOpen, never a fabricated 0) when there is no concierge activity', async () => {
    const r = await getConciergeEngagementSummary(makeEnv(db({ rows: [] })), 'site1', 30);
    expect(r).toEqual({ opens: 0, messages: 0, uniqueVisitors: 0, messagesPerOpen: null });
  });

  it('fail-soft empty on a query error', async () => {
    const r = await getConciergeEngagementSummary(makeEnv(db({ throwOnGroup: true })), 'site1', 30);
    expect(r.opens).toBe(0);
    expect(r.messagesPerOpen).toBeNull();
  });

  it('counts ONLY concierge_* events, with a unique-visitor DISTINCT (query shape)', async () => {
    const sqls: string[] = [];
    await getConciergeEngagementSummary(makeEnv(db({ sqls })), 'site1', 30);
    const q = sqls.find((s) => s.includes('GROUP BY'));
    expect(q).toBeDefined();
    expect(q!).toContain("event_type IN ('concierge_open', 'concierge_message')");
    expect(q!).toContain('COUNT(DISTINCT session_id)');
  });
});

const URL = '/api/sites/site1/analytics/concierge';

describe('GET /api/sites/:siteId/analytics/concierge — tenant boundary', () => {
  it('404 when the site belongs to a different org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + the concierge summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      URL,
      {},
      harnessEnv(db({ owner: 'org1', rows: [{ event_type: 'concierge_open', n: 4, u: 3 }] }), true),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as ConciergeEngagementSummary;
    expect(b.opens).toBe(4);
    expect(b.uniqueVisitors).toBe(3);
    expect(b.messagesPerOpen).toBe(0); // opens>0 with 0 messages → 0/4 = 0 (null only when opens === 0)
  });
});
