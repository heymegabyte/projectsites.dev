/**
 * Route-layer coverage for the `last_activity` freshness field on
 * `GET /api/sites/:siteId/data-overview`. Proves: auth (401) → tenant ownership
 * (404) → each table carries a `last_activity` (the MAX(ts) result) alongside its
 * row_count, and an empty table (MAX → null) reports `null`, never a fabricated 0/now.
 */
import { Hono } from 'hono';
import { siteDataApi } from '../handlers';
import { errorHandler } from '../../../../src/middleware/error_handler.js';

function app(orgId?: string) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (orgId) c.set('orgId' as never, orgId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', siteDataApi);
  return a;
}

/**
 * Mock D1: ownership probe true/false; COUNT(*) → {n:7}; MAX(ts) → the given ts (or a
 * per-table override so we can test a null/empty table). Dispatches by SQL shape.
 */
function mockEnv(opts: { owned?: boolean; ts?: string | null; tsByTable?: Record<string, string | null> } = {}) {
  const owned = opts.owned ?? true;
  const DB = {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            first: async () => {
              if (/FROM sites WHERE id = \? AND org_id = \?/.test(sql)) return owned ? { ok: 1 } : null;
              if (sql.includes('COUNT(*)')) return { n: 7 };
              if (sql.includes('MAX(')) {
                // The table name is a trusted literal in the SQL (siteId is the bound param).
                const key = sql.match(/FROM (\w+)/)?.[1] ?? '';
                const ts = opts.tsByTable && key in opts.tsByTable ? opts.tsByTable[key] : (opts.ts ?? '2026-09-24 12:00:00');
                return { ts };
              }
              return null;
            },
            run: async () => ({ success: true, meta: { changes: 0 } }),
            all: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
  };
  return { env: { DB } as never };
}

const PATH = '/api/sites/site-1/data-overview';

describe('GET /api/sites/:siteId/data-overview — last_activity freshness', () => {
  it('401 when unauthenticated', async () => {
    const res = await app().request(PATH, {}, mockEnv().env);
    expect(res.status).toBe(401);
  });

  it('404 when the site is not owned by the caller org', async () => {
    const res = await app('org1').request(PATH, {}, mockEnv({ owned: false }).env);
    expect(res.status).toBe(404);
  });

  it('returns last_activity (the MAX(ts) result) alongside row_count for every table', async () => {
    const res = await app('org1').request(PATH, {}, mockEnv({ ts: '2026-09-24 12:00:00' }).env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tables: Array<{ key: string; row_count: number; last_activity: string | null }> } };
    expect(body.data.tables.length).toBeGreaterThan(0);
    for (const t of body.data.tables) {
      expect(t.row_count).toBe(7);
      expect(t.last_activity).toBe('2026-09-24 12:00:00');
    }
  });

  it('reports null last_activity for an empty table (MAX → null) — never a fabricated timestamp', async () => {
    const res = await app('org1').request(
      PATH,
      {},
      mockEnv({ ts: '2026-09-24 12:00:00', tsByTable: { form_submissions: null } }).env,
    );
    const body = (await res.json()) as { data: { tables: Array<{ key: string; last_activity: string | null }> } };
    const fs = body.data.tables.find((t) => t.key === 'form_submissions');
    expect(fs?.last_activity).toBeNull();
    // Other tables still carry their timestamp.
    const ve = body.data.tables.find((t) => t.key === 'visitor_events');
    expect(ve?.last_activity).toBe('2026-09-24 12:00:00');
  });
});
