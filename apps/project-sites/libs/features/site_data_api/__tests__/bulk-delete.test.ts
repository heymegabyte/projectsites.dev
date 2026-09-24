/**
 * Route-layer coverage for the owner BULK row-delete endpoint
 * `POST /api/sites/:siteId/data-overview/:table/bulk-delete`. Proves the same safety
 * chain as the single delete — auth (401) → ownsSiteData tenant gate (404, never a 403
 * leak) → read-only allowlist reject (400) → hostile table reject (400) — PLUS the
 * bulk-specific guards: non-empty ids (400), all-invalid ids (400), over-cap (400),
 * dedupe, a parameterized `id IN (?, …) AND site_id = ?` (every id BOUND, never
 * interpolated), and the honest {requested, deleted, skipped} partial-result report.
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

/** Mock D1: `.first()` answers the ownership probe; `.run()` is the DELETE + audit INSERT. */
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
            first: async () =>
              /FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null,
            run: async () => ({ success: true, meta: { changes } }),
            all: async () => ({ results: [], success: true, meta: {} }),
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

const BULK = (siteId: string, table: string) =>
  `/api/sites/${siteId}/data-overview/${table}/bulk-delete`;
const post = (ids: unknown) => ({
  method: 'POST',
  body: JSON.stringify({ ids }),
  headers: { 'content-type': 'application/json' },
});
const deleteCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.startsWith('DELETE'));

describe('POST /api/sites/:siteId/data-overview/:table/bulk-delete', () => {
  it('401 when unauthenticated (no orgId)', async () => {
    const { env, calls } = mockEnv();
    const res = await app().request(BULK('s1', 'form_submissions'), post(['a', 'b']), env);
    expect(res.status).toBe(401);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('404 when the site is NOT owned by the caller org (tenant isolation, never a 403 leak)', async () => {
    const { env, calls } = mockEnv({ owned: false });
    const res = await authed().request(BULK('foreign-site', 'form_submissions'), post(['a']), env);
    expect(res.status).toBe(404);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 for a read-only table (allowlist reject) — no DELETE issued', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(BULK('s1', 'visitor_events'), post(['a']), env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 for a hostile table string (never interpolated)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(BULK('s1', 'sqlite_master'), post(['a']), env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 when the ids array is empty', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(BULK('s1', 'form_submissions'), post([]), env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 when no valid string ids are provided (blank/non-string dropped)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(BULK('s1', 'form_submissions'), post(['', 5, null]), env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('400 when the batch exceeds the 100-row cap — no DELETE issued', async () => {
    const { env, calls } = mockEnv();
    const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const res = await authed().request(BULK('s1', 'form_submissions'), post(many), env);
    expect(res.status).toBe(400);
    expect(deleteCall(calls)).toBeUndefined();
  });

  it('deletes owned rows: 200 + parameterized id IN (?, ?) AND site_id=?, ids+site BOUND', async () => {
    const { env, calls } = mockEnv({ changes: 2 });
    const res = await authed().request(BULK('site-9', 'form_submissions'), post(['r1', 'r2']), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { requested: number; deleted: number; skipped: number } };
    expect(body.data).toEqual({ requested: 2, deleted: 2, skipped: 0 });
    const dc = deleteCall(calls);
    expect(dc?.sql).toBe('DELETE FROM form_submissions WHERE id IN (?, ?) AND site_id = ?');
    expect(dc?.params).toEqual(['r1', 'r2', 'site-9']);
  });

  it('dedupes ids before binding (one placeholder per distinct id)', async () => {
    const { env, calls } = mockEnv({ changes: 2 });
    const res = await authed().request(
      BULK('s1', 'form_submissions'),
      post(['a', 'a', 'b', 'a']),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { requested: number } };
    expect(body.data.requested).toBe(2); // deduped a,b
    const dc = deleteCall(calls);
    expect(dc?.sql).toBe('DELETE FROM form_submissions WHERE id IN (?, ?) AND site_id = ?');
    expect(dc?.params).toEqual(['a', 'b', 's1']);
  });

  it('reports honest partial results when some ids matched no row (deleted < requested)', async () => {
    const { env } = mockEnv({ changes: 1 }); // 3 requested, only 1 actually deleted
    const res = await authed().request(
      BULK('s1', 'form_submissions'),
      post(['r1', 'r2', 'r3']),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { requested: number; deleted: number; skipped: number } };
    expect(body.data).toEqual({ requested: 3, deleted: 1, skipped: 2 });
  });
});
