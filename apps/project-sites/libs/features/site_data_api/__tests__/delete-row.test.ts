/**
 * Route-layer coverage for the owner row-delete endpoint
 * `DELETE /api/sites/:siteId/data-overview/:table/:rowId`. Proves the safety chain:
 * auth (401) → tenant ownership via ownsSiteData (404, never a 403 leak) → read-only
 * allowlist reject (400) → parameterized, site-double-scoped DELETE (200) → no-row
 * (meta.changes === 0) → 404 (never a silent success). The DELETE's SQL + bound params
 * are asserted so a hostile `:table`/`:rowId` can never be interpolated.
 *
 * Pure-helper coverage (deletableTableName allowlist boundary) lives in data-overview.test.ts.
 */
import { Hono } from 'hono';
import { siteDataApi } from '../handlers';
import { errorHandler } from '../../../../src/middleware/error_handler.js';

function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', siteDataApi);
  return a;
}
const authed = () => app({ orgId: 'org1', userId: 'u1' });

/**
 * A mock D1 that records every prepare/bind and dispatches `.first()` (ownership
 * probe) vs `.run()` (the DELETE + the audit INSERT). `owned` controls the ownsSiteData
 * gate; `changes` is the DELETE's affected-row count.
 */
function mockEnv(opts: { owned?: boolean; changes?: number } = {}) {
  const owned = opts.owned ?? true;
  const changes = opts.changes ?? 1;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            first: async () => (/FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null),
            run: async () => ({ success: true, meta: { changes } }),
            all: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

const DEL = (siteId: string, table: string, rowId: string) =>
  `/api/sites/${siteId}/data-overview/${table}/${rowId}`;
const del = { method: 'DELETE' };
const deleteCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.startsWith('DELETE'));

describe('DELETE /api/sites/:siteId/data-overview/:table/:rowId', () => {
  it('401 when unauthenticated (no orgId)', async () => {
    const { env, calls } = mockEnv();
    const res = await app().request(DEL('s1', 'form_submissions', 'r1'), del, env);
    expect(res.status).toBe(401);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('404 when the site is NOT owned by the caller org (tenant isolation, never a 403 leak)', async () => {
    const { env, calls } = mockEnv({ owned: false });
    const res = await authed().request(DEL('foreign-site', 'form_submissions', 'r1'), del, env);
    expect(res.status).toBe(404);
    // DELETE is never issued for a foreign site — ownership gate short-circuits.
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 for a read-only table (allowlist reject) — no DELETE issued', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(DEL('s1', 'visitor_events', 'r1'), del, env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 for an unknown / hostile table string (never interpolated)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(DEL('s1', 'sqlite_master', 'r1'), del, env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('deletes an owned form_submissions row: 200 + parameterized WHERE id=? AND site_id=?', async () => {
    const { env, calls } = mockEnv({ changes: 1 });
    const res = await authed().request(DEL('site-9', 'form_submissions', 'row-7'), del, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; deleted: boolean } };
    expect(body.data).toEqual({ id: 'row-7', deleted: true });
    const dc = deleteCall(calls);
    // Real table name is a trusted literal; id + site_id are BOUND (never interpolated).
    expect(dc?.sql).toBe('DELETE FROM form_submissions WHERE id = ? AND site_id = ?');
    expect(dc?.params).toEqual(['row-7', 'site-9']);
  });

  it('404 when no row matched (meta.changes === 0) — never a silent success', async () => {
    const { env } = mockEnv({ changes: 0 });
    const res = await authed().request(DEL('s1', 'form_submissions', 'ghost'), del, env);
    expect(res.status).toBe(404);
  });
});
