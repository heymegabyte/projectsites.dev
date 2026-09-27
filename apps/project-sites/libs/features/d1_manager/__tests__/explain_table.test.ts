/**
 * POST /api/admin/d1/:databaseId/explain-table — "Explain this table" (Workers-AI plain-English
 * summary of a table's schema). Locks:
 *   - super-admin + flag gate (non-super / flag-off → 404; AI + CF never called),
 *   - bad table name → 400 (identifier-validated, bound as a param — never interpolated),
 *   - unknown table (empty DDL) → 404,
 *   - happy path → 200 {ok, summary, model}, AND the model is grounded on the SERVER-FETCHED DDL,
 *   - AI failure → 502 (honest, never a fabricated summary),
 *   - the pure helpers (buildExplainTableMessages / extractSummary).
 */

import { Hono } from 'hono';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));
const mockDbQueryOne = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

import {
  d1Manager,
  buildExplainTableMessages,
  extractSummary,
  EXPLAIN_MODEL,
} from '../handlers.js';

const REAL_UUID = 'ea3e839a-c641-4861-ae30-dfc63bff8032';
const mockFetch = jest.fn();
const mockAiRun = jest.fn();

type AppEnv = {
  DB: unknown;
  AI: { run: (m: string, i: unknown) => Promise<unknown> };
  CF_ACCOUNT_ID: string;
  CLOUDFLARE_EMAIL: string;
  CLOUDFLARE_API_KEY: string;
};

function makeEnv(): AppEnv {
  return {
    DB: {},
    AI: { run: (m: string, i: unknown) => mockAiRun(m, i) },
    CF_ACCOUNT_ID: 'acct-123',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gk',
  };
}

function appWith(userId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', d1Manager);
  return app;
}

function post(app: Hono, path: string, body: unknown, env: AppEnv = makeEnv()): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env as never,
  );
}

/** A CF `/query` OK response: `result` is an ARRAY of per-statement `{ results }`. */
function cfQueryResp(rows: unknown[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [{ results: rows, success: true, meta: {} }] }),
  } as unknown as Response);
}

const DDL = 'CREATE TABLE visitor_events (id INTEGER PRIMARY KEY, site_id TEXT REFERENCES sites(id))';
const PATH = `/api/admin/d1/${REAL_UUID}/explain-table`;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockDbQueryOne.mockResolvedValue({ is_super_admin: 1, email: 'brian@megabyte.space' });
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockResolvedValue(cfQueryResp([{ sql: DDL }]));
  mockAiRun.mockResolvedValue({ response: 'Stores one row per page view, linked to a site.' });
});

describe('explain-table — gating (never leak existence; AI + CF never called)', () => {
  it('404 when flag off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await post(appWith('u'), PATH, { table: 'visitor_events' })).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAiRun).not.toHaveBeenCalled();
  });
  it('404 when unauthenticated', async () => {
    expect((await post(appWith(), PATH, { table: 'visitor_events' })).status).toBe(404);
    expect(mockAiRun).not.toHaveBeenCalled();
  });
  it('404 when NOT super-admin', async () => {
    mockDbQueryOne.mockResolvedValue({ is_super_admin: 0 });
    expect((await post(appWith('owner'), PATH, { table: 'visitor_events' })).status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAiRun).not.toHaveBeenCalled();
  });
});

describe('explain-table — validation + happy path', () => {
  it('400 on an invalid table identifier (bound as a param, never interpolated)', async () => {
    const res = await post(appWith('super'), PATH, { table: "x'; DROP TABLE y;--" });
    expect(res.status).toBe(400);
    expect(mockAiRun).not.toHaveBeenCalled();
  });

  it('404 when the table does not exist (empty DDL — never invents a summary)', async () => {
    mockFetch.mockResolvedValue(cfQueryResp([])); // no such row in sqlite_master
    const res = await post(appWith('super'), PATH, { table: 'ghost' });
    expect(res.status).toBe(404);
    expect(mockAiRun).not.toHaveBeenCalled();
  });

  it('200 with the summary + model, grounded on the SERVER-FETCHED DDL', async () => {
    const res = await post(appWith('super'), PATH, { table: 'visitor_events' });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; summary: string; model: string }>();
    expect(body.ok).toBe(true);
    expect(body.summary).toContain('page view');
    expect(body.model).toBe(EXPLAIN_MODEL);
    // The AI was grounded on the DDL the SERVER fetched (never a client-supplied schema).
    const [, inputs] = mockAiRun.mock.calls[0] as [
      string,
      { messages: { role: string; content: string }[] },
    ];
    const userMsg = inputs.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain(DDL);
    // The table name was BOUND as a param to the sqlite_master lookup (never concatenated).
    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body).params).toEqual(['visitor_events']);
  });

  it('502 when the AI call throws (honest — never a fabricated summary)', async () => {
    mockAiRun.mockRejectedValue(new Error('ai down'));
    const res = await post(appWith('super'), PATH, { table: 'visitor_events' });
    expect(res.status).toBe(502);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
  });

  it('502 when the model returns an empty string', async () => {
    mockAiRun.mockResolvedValue({ response: '' });
    expect((await post(appWith('super'), PATH, { table: 'visitor_events' })).status).toBe(502);
  });
});

describe('pure helpers', () => {
  it('buildExplainTableMessages embeds the table + DDL and forbids inventing columns', () => {
    const msgs = buildExplainTableMessages('users', 'CREATE TABLE users(id)');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content.toLowerCase()).toContain('do not invent');
    expect(msgs[1].content).toContain('users');
    expect(msgs[1].content).toContain('CREATE TABLE users(id)');
  });

  it('extractSummary strips code fences + bullets and bounds length', () => {
    expect(extractSummary('```\nHello world\n```')).toBe('Hello world');
    expect(extractSummary('- one\n- two')).toBe('one\ntwo');
    expect(extractSummary('x'.repeat(2000)).length).toBe(1200);
  });
});
