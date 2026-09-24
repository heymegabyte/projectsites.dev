/**
 * Route-layer coverage for the Data "Recent activity" endpoint
 * `GET /api/sites/:siteId/data-overview/activity`. Proves: auth (401) → tenant ownership
 * (404) → returns the site's own `site_data.*` mutations mapped to a safe shape, scoped by
 * org + `json_extract($.site_id)` + the action allowlist (never app traffic), and fail-soft
 * (a query error → empty list, never a 500). The raw `metadata_json` is never selected.
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

const AUDIT_ROWS = [
  {
    created_at: '2026-09-24T12:00:00.000Z',
    actor_id: 'u1',
    action: 'site_data.row_deleted',
    target_type: 'form_submissions',
    message: 'Deleted a row from form_submissions',
  },
  {
    created_at: '2026-09-23T09:00:00.000Z',
    actor_id: 'u1',
    action: 'site_data.row_updated',
    target_type: 'form_submissions',
    message: 'Updated status on a form_submissions row',
  },
];

function mockEnv(opts: { owned?: boolean; throwOnActivity?: boolean } = {}) {
  const owned = opts.owned ?? true;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            first: async () => (/FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null),
            all: async () => {
              if (sql.includes('FROM audit_logs')) {
                if (opts.throwOnActivity) throw new Error('audit table missing');
                return { results: AUDIT_ROWS, success: true, meta: {} };
              }
              return { results: [], success: true, meta: {} };
            },
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

const PATH = '/api/sites/site-9/data-activity';
const activityCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.includes('FROM audit_logs'));

describe('GET /api/sites/:siteId/data-overview/activity', () => {
  it('401 when unauthenticated', async () => {
    const res = await app().request(PATH, {}, mockEnv().env);
    expect(res.status).toBe(401);
  });

  it('404 when the site is not owned by the caller org', async () => {
    const { env, calls } = mockEnv({ owned: false });
    const res = await app('org1').request(PATH, {}, env);
    expect(res.status).toBe(404);
    // Never queries the audit log for a foreign site — the ownership gate short-circuits.
    expect(activityCall(calls)).toBeUndefined();
  });

  it('returns the site_data mutations mapped to a safe shape (no raw metadata)', async () => {
    const { env, calls } = mockEnv();
    const res = await app('org1').request(PATH, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { events: Array<{ action: string; table: string; message: string; actor: string | null; at: string }> } };
    expect(body.data.events.length).toBe(2);
    expect(body.data.events[0]).toEqual({
      action: 'site_data.row_deleted',
      table: 'form_submissions',
      message: 'Deleted a row from form_submissions',
      actor: 'u1',
      at: '2026-09-24T12:00:00.000Z',
    });
    // Scoped by org + site (json_extract), filtered to the site_data action allowlist.
    const q = activityCall(calls)!;
    expect(q.sql).toContain("action IN ('site_data.row_deleted', 'site_data.row_updated')");
    expect(q.sql).toContain("json_extract(metadata_json, '$.site_id') = ?");
    // The SELECT list is the safe columns only — metadata_json is filtered ON, never returned.
    expect(q.sql).toContain('SELECT created_at, actor_id, action, target_type, message');
    expect(q.params).toEqual(['org1', 'site-9']);
  });

  it('fail-soft: a query error yields an empty list, never a 500', async () => {
    const { env } = mockEnv({ throwOnActivity: true });
    const res = await app('org1').request(PATH, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { events: unknown[] } };
    expect(body.data.events).toEqual([]);
  });
});
