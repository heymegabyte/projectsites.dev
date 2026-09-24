/**
 * Route-layer coverage for the owner row-edit endpoint
 * `PATCH /api/sites/:siteId/data-overview/:table/:rowId`. Proves the safety chain:
 * auth (401) → tenant ownership (404, never 403) → read-only table (400) → non-editable
 * column (400, hostile column never reaches SQL) → out-of-enum value (400, never written) →
 * parameterized site-double-scoped UPDATE (200) → no-row (404). The UPDATE's SQL + bound
 * params are asserted so neither table nor column nor value is ever interpolated.
 *
 * Pure-helper coverage (editable allowlist + enum validation) lives in data-overview.test.ts.
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

const PATCH = (siteId: string, table: string, rowId: string) =>
  `/api/sites/${siteId}/data-overview/${table}/${rowId}`;
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const updateCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.startsWith('UPDATE'));

describe('PATCH /api/sites/:siteId/data-overview/:table/:rowId', () => {
  it('401 when unauthenticated (no orgId)', async () => {
    const { env, calls } = mockEnv();
    const res = await app().request(PATCH('s1', 'form_submissions', 'r1'), patch({ column: 'status', value: 'forwarded' }), env);
    expect(res.status).toBe(401);
    expect(updateCall(calls)).toBeUndefined();
  });

  it('404 when the site is NOT owned by the caller org (tenant isolation)', async () => {
    const { env, calls } = mockEnv({ owned: false });
    const res = await authed().request(PATCH('foreign', 'form_submissions', 'r1'), patch({ column: 'status', value: 'forwarded' }), env);
    expect(res.status).toBe(404);
    expect(updateCall(calls)).toBeUndefined();
  });

  it('400 for a read-only table — no UPDATE issued', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(PATCH('s1', 'visitor_events', 'r1'), patch({ column: 'status', value: 'forwarded' }), env);
    expect(res.status).toBe(400);
    expect(updateCall(calls)).toBeUndefined();
  });

  it('400 for a non-editable column (PII/structural/hostile) — no UPDATE issued', async () => {
    const { env, calls } = mockEnv();
    for (const column of ['email', 'payload', 'id', 'form_name', 'status; DROP TABLE x']) {
      const res = await authed().request(PATCH('s1', 'form_submissions', 'r1'), patch({ column, value: 'x' }), env);
      expect(res.status).toBe(400);
    }
    expect(updateCall(calls)).toBeUndefined();
  });

  it('400 for an out-of-enum value — no UPDATE issued (never written)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(PATCH('s1', 'form_submissions', 'r1'), patch({ column: 'status', value: 'deleted' }), env);
    expect(res.status).toBe(400);
    expect(updateCall(calls)).toBeUndefined();
  });

  it('updates status: 200 + parameterized UPDATE … SET "status"=? WHERE id=? AND site_id=?', async () => {
    const { env, calls } = mockEnv({ changes: 1 });
    const res = await authed().request(PATCH('site-9', 'form_submissions', 'row-7'), patch({ column: 'status', value: 'forwarded' }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; column: string; value: string; updated: boolean } };
    expect(body.data).toEqual({ id: 'row-7', column: 'status', value: 'forwarded', updated: true });
    const uc = updateCall(calls);
    // Table + column are trusted allowlist literals; value + id + site_id are BOUND.
    expect(uc?.sql).toBe('UPDATE form_submissions SET "status" = ? WHERE id = ? AND site_id = ?');
    expect(uc?.params).toEqual(['forwarded', 'row-7', 'site-9']);
  });

  it('404 when no row matched (meta.changes === 0) — never a silent success', async () => {
    const { env } = mockEnv({ changes: 0 });
    const res = await authed().request(PATCH('s1', 'form_submissions', 'ghost'), patch({ column: 'status', value: 'forwarded' }), env);
    expect(res.status).toBe(404);
  });
});
