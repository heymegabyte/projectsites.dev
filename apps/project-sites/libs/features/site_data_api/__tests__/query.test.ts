/**
 * Route-layer coverage for the grounded "Ask your data" EXECUTOR
 * `POST /api/sites/:siteId/data-overview/:table/query`. Proves the safety chain:
 * auth (401) → tenant ownership via ownsSiteData (404, never a 403 leak) → unknown-table
 * reject (400) → invalid-intent reject with the compiler's typed reason (400, nothing reaches
 * the DB) → masked-column (email) reject (400) → BOUND execution (siteId + compiler params) for a
 * valid intent (200, executed SQL echoed) → runtime SQL error → 502 (never a fabricated empty result).
 *
 * The pure compiler (compileQueryIntent) is exhaustively covered in data-overview.test.ts; this file
 * proves the ROUTE wires auth + ownership + compile + bind correctly and never interpolates.
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
 * A mock D1: `.first()` answers the ownsSiteData probe (`FROM sites WHERE id = ? AND org_id = ?`);
 * `.all()` returns the configured query rows (or throws when `throwOnQuery`). Records every prepare/bind.
 */
function mockEnv(opts: { owned?: boolean; rows?: Record<string, unknown>[]; throwOnQuery?: boolean } = {}) {
  const owned = opts.owned ?? true;
  const rows = opts.rows ?? [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            first: async () =>
              /FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null,
            all: async () => {
              if (opts.throwOnQuery && !/FROM sites WHERE id = \?/.test(sql)) {
                throw new Error('no such function: SUM on text');
              }

              return { results: rows, success: true, meta: { rows_read: rows.length } };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as never, calls };
}

const URL = (siteId: string, table: string) => `/api/sites/${siteId}/data-overview/${table}/query`;
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
/** The executed query call = the prepare that is NOT the ownership probe. */
const queryCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => !/FROM sites WHERE id = \?/.test(c.sql));

describe('POST /api/sites/:siteId/data-overview/:table/query (grounded intent executor)', () => {
  it('401 when unauthenticated (no orgId) — nothing prepared', async () => {
    const { env, calls } = mockEnv();
    const res = await app().request(URL('s1', 'form_submissions'), post({ select: [{ col: 'status' }] }), env);
    expect(res.status).toBe(401);
    expect(queryCall(calls)).toBeUndefined();
  });

  it('404 when the site is NOT owned by the caller org (tenant isolation, never a 403 leak)', async () => {
    const { env, calls } = mockEnv({ owned: false });
    const res = await authed().request(URL('foreign', 'form_submissions'), post({ select: [{ col: 'status' }] }), env);
    expect(res.status).toBe(404);
    expect(queryCall(calls)).toBeUndefined();
  });

  it('400 for an unknown / hostile table (never reaches compile or SQL)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(URL('s1', 'sqlite_master'), post({ select: [{ col: 'name' }] }), env);
    expect(res.status).toBe(400);
    expect(queryCall(calls)).toBeUndefined();
  });

  it('400 with the compiler reason for an unknown column (nothing reaches the DB)', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(URL('s1', 'form_submissions'), post({ select: [{ col: 'evil; DROP' }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe('unknown column: evil; DROP');
    expect(queryCall(calls)).toBeUndefined();
  });

  it('400 for a masked column (email) in select — PII never queried', async () => {
    const { env, calls } = mockEnv();
    const res = await authed().request(URL('s1', 'form_submissions'), post({ select: [{ col: 'email' }] }), env);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toContain('masked');
    expect(queryCall(calls)).toBeUndefined();
  });

  it('200 executes a valid projection: BOUND siteId + limit; echoes the SQL', async () => {
    const { env, calls } = mockEnv({ rows: [{ status: 'open', created_at: '2026-01-01' }] });
    const res = await authed().request(
      URL('site-9', 'form_submissions'),
      post({ select: [{ col: 'status' }, { col: 'created_at' }], limit: 25 }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { sql: string; rows: unknown[]; rowsRead: number } }>();
    expect(body.data.sql).toBe('SELECT "status", "created_at" FROM form_submissions WHERE site_id = ? LIMIT ?');
    expect(body.data.rows).toHaveLength(1);
    const qc = queryCall(calls);
    expect(qc?.params).toEqual(['site-9', 25]); // siteId bound first, then the compiler's params (limit)
  });

  it('200 executes an aggregate count + groupBy', async () => {
    const { env, calls } = mockEnv({ rows: [{ grp: 'open', n: 3 }] });
    const res = await authed().request(
      URL('s1', 'form_submissions'),
      post({ select: [{ agg: 'count' }], groupBy: 'status' }),
      env,
    );
    expect(res.status).toBe(200);
    const qc = queryCall(calls);
    expect(qc?.sql).toContain('GROUP BY "status"');
    expect(qc?.sql).toContain('ORDER BY n DESC');
    expect(qc?.params).toEqual(['s1', 100]); // default limit
  });

  it('502 when the query throws at runtime (honest failure, never a fake empty result)', async () => {
    const { env } = mockEnv({ throwOnQuery: true });
    const res = await authed().request(
      URL('s1', 'form_submissions'),
      post({ select: [{ agg: 'sum', col: 'created_at' }] }),
      env,
    );
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('QUERY_FAILED');
  });

  it('400 for a missing / non-JSON body', async () => {
    const { env } = mockEnv();
    const res = await authed().request(URL('s1', 'form_submissions'), { method: 'POST' }, env);
    expect(res.status).toBe(400);
  });
});
