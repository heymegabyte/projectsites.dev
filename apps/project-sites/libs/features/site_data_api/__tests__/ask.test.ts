/**
 * Route-layer coverage for grounded "Ask your data"
 * `POST /api/sites/:siteId/data-overview/:table/ask`. Proves the full NL→intent→SQL→answer pipeline
 * with a MOCKED AI binding (canned proposed intent) + a mock D1, and — crucially — that the model output
 * is UNTRUSTED: a hostile proposal (selecting a masked column, unknown column) is REJECTED by the
 * server-side compiler before any SQL runs. Auth chain (401 → 404 tenant → 400 unknown table), honest
 * failure modes (AI down → 502, unparseable → 422, unauthorized intent → 400, runtime SQL error → 502).
 *
 * The pure NL helpers (askSystemPrompt, parseProposedIntent) + the compiler are unit-covered in
 * data-overview.test.ts; this file proves the ROUTE wires auth + AI + parse + compile + bind correctly.
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
 * A mock env: `AI.run` returns `{ response }` (the model's proposed intent) or throws; the D1 `.first()`
 * answers the ownsSiteData probe and `.all()` returns the query rows (or throws). Records prepare/bind.
 */
function mockEnv(opts: {
  owned?: boolean;
  aiResponse?: unknown;
  aiThrows?: boolean;
  rows?: Record<string, unknown>[];
  dbThrows?: boolean;
} = {}) {
  const owned = opts.owned ?? true;
  const rows = opts.rows ?? [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const AI = {
    run: async () => {
      if (opts.aiThrows) throw new Error('ai down');

      return { response: opts.aiResponse };
    },
  };
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            first: async () =>
              /FROM sites WHERE id = \? AND org_id = \?/.test(sql) ? (owned ? { ok: 1 } : null) : null,
            all: async () => {
              if (opts.dbThrows && !/FROM sites WHERE id = \?/.test(sql)) throw new Error('runtime sql error');

              return { results: rows, success: true, meta: { rows_read: rows.length } };
            },
          };
        },
      };
    },
  };
  return { env: { AI, DB } as never, calls };
}

const URL = (siteId: string, table: string) => `/api/sites/${siteId}/data-overview/${table}/ask`;
const ask = (question: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question }),
});
const queryCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => !/FROM sites WHERE id = \?/.test(c.sql));

describe('POST /api/sites/:siteId/data-overview/:table/ask (grounded NL→data)', () => {
  it('401 when unauthenticated', async () => {
    const { env } = mockEnv();
    expect((await app().request(URL('s1', 'form_submissions'), ask('how many?'), env)).status).toBe(401);
  });

  it('404 for a site not owned by the caller org (never a 403 leak)', async () => {
    const { env } = mockEnv({ owned: false });
    expect((await authed().request(URL('foreign', 'form_submissions'), ask('how many?'), env)).status).toBe(404);
  });

  it('400 for an unknown table', async () => {
    const { env } = mockEnv();
    expect((await authed().request(URL('s1', 'sqlite_master'), ask('how many?'), env)).status).toBe(400);
  });

  it('400 for an empty question', async () => {
    const { env } = mockEnv();
    expect((await authed().request(URL('s1', 'form_submissions'), ask('   '), env)).status).toBe(400);
  });

  it('200 full pipeline: NL → (mocked) intent → compiled SQL → bound execution → falsifiable answer', async () => {
    const { env, calls } = mockEnv({
      aiResponse: { select: [{ agg: 'count' }], groupBy: 'status' },
      rows: [{ grp: 'open', n: 3 }],
    });
    const res = await authed().request(URL('site-9', 'form_submissions'), ask('how many submissions by status?'), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { question: string; intent: unknown; sql: string; rows: unknown[] } }>();
    expect(body.data.question).toBe('how many submissions by status?');
    expect(body.data.intent).toEqual({ select: [{ agg: 'count' }], groupBy: 'status' });
    expect(body.data.sql).toContain('GROUP BY "status"');
    expect(body.data.rows).toEqual([{ grp: 'open', n: 3 }]);
    const qc = queryCall(calls);
    expect(qc?.params).toEqual(['site-9', 100]); // siteId bound first, then the compiler's limit
  });

  it('SECURITY: a hostile model proposal (select a MASKED column) is REJECTED — no SQL runs', async () => {
    const { env, calls } = mockEnv({ aiResponse: { select: [{ col: 'email' }] } });
    const res = await authed().request(URL('s1', 'form_submissions'), ask('show me every email address'), env);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toContain('masked');
    expect(queryCall(calls)).toBeUndefined(); // the compiler blocked it before any query
  });

  it('SECURITY: a proposal with an unknown column is REJECTED (the model can never widen access)', async () => {
    const { env, calls } = mockEnv({ aiResponse: { select: [{ col: 'ssn' }] } });
    const res = await authed().request(URL('s1', 'form_submissions'), ask('show ssn'), env);
    expect(res.status).toBe(400);
    expect(queryCall(calls)).toBeUndefined();
  });

  it('422 when the model returns something unparseable (no usable query)', async () => {
    const { env, calls } = mockEnv({ aiResponse: { sorry: 'I cannot help' } });
    const res = await authed().request(URL('s1', 'form_submissions'), ask('?'), env);
    expect(res.status).toBe(422);
    expect(queryCall(calls)).toBeUndefined();
  });

  it('502 when the AI is unavailable (honest, never a fabricated answer)', async () => {
    const { env } = mockEnv({ aiThrows: true });
    const res = await authed().request(URL('s1', 'form_submissions'), ask('how many?'), env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('AI_UNAVAILABLE');
  });

  it('502 when the compiled query throws at runtime', async () => {
    const { env } = mockEnv({ aiResponse: { select: [{ col: 'status' }] }, dbThrows: true });
    const res = await authed().request(URL('s1', 'form_submissions'), ask('list statuses'), env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('QUERY_FAILED');
  });
});
