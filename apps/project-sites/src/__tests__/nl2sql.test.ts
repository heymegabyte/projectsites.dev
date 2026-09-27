/**
 * Unit tests for the AI SQL assistant — POST /api/sites/:siteId/sql/nl2sql + its pure helpers.
 *
 * Contract:
 *  - Pure: buildNl2SqlMessages grounds on the real DDL + instructs a read-only SELECT;
 *    extractSqlFromAiText strips markdown fences / language hint / trailing semicolon.
 *  - Route: 401 unauth · 403 non-super-admin (AI never called) · 400 empty question ·
 *    404 site-not-in-org (AI never called) · 200 returns extracted SQL + grounds on the
 *    server-fetched schema + audits + NEVER executes · 502 on AI failure (no fabricated SQL).
 *
 * @swc/jest mock hoisting: GLOBAL jest (not imported from @jest/globals).
 */

jest.mock('../services/sysadmin.js', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('../services/audit.js', () => ({ writeAuditLog: jest.fn() }));

import { Hono } from 'hono';
import * as sysadmin from '../services/sysadmin.js';
import * as audit from '../services/audit.js';
import {
  siteDetailTabs,
  buildNl2SqlMessages,
  extractSqlFromAiText,
} from '../routes/site_detail_tabs.js';
import type { Env, Variables } from '../types/env.js';

const mIsSuperAdmin = sysadmin.isSuperAdmin as unknown as jest.Mock;
const mWriteAuditLog = audit.writeAuditLog as unknown as jest.Mock;

function makeD1(
  opts: { siteRow?: Record<string, unknown> | null; masterSql?: string[] } = {},
): D1Database {
  const prepare = jest.fn().mockImplementation((sql: string) => {
    const u = sql.trim().toUpperCase();
    if (u.startsWith('SELECT') && u.includes('FROM SITES WHERE')) {
      // dbQueryOne → dbQuery uses .bind(...).all() and takes results[0].
      const row = opts.siteRow !== undefined ? opts.siteRow : { id: 'site-1' };
      return { bind: () => ({ all: () => Promise.resolve({ results: row ? [row] : [] }) }) };
    }
    if (u.includes('FROM SQLITE_MASTER')) {
      return {
        all: () =>
          Promise.resolve({
            results: (opts.masterSql ?? ['CREATE TABLE users (id TEXT)']).map((s) => ({ sql: s })),
          }),
      };
    }
    return {
      bind: () => ({
        first: () => Promise.resolve(null),
        all: () => Promise.resolve({ results: [] }),
      }),
    };
  });
  return { prepare } as unknown as D1Database;
}

function makeEnv(ai?: jest.Mock, db?: D1Database): Env {
  return {
    ENVIRONMENT: 'test',
    DB: db ?? makeD1(),
    AI: { run: ai ?? jest.fn().mockResolvedValue({ response: 'SELECT id FROM users LIMIT 100' }) },
  } as unknown as Env;
}

function appWith(userId?: string, orgId: string | null = 'org-1') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (orgId) c.set('orgId', orgId);
    if (userId) c.set('userId', userId);
    c.set('requestId', 'r');
    await next();
  });
  app.route('/', siteDetailTabs);
  return app;
}

const URL = '/api/sites/site-1/sql/nl2sql';
function post(app: Hono, body: unknown, env: Env): Promise<Response> {
  return app.request(
    URL,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env as never,
  );
}

describe('nl2sql pure helpers', () => {
  it('buildNl2SqlMessages grounds on the schema + instructs a read-only SELECT', () => {
    const msgs = buildNl2SqlMessages('how many users', 'CREATE TABLE users (id TEXT)');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('read-only');
    expect(msgs[0].content).toContain('NEVER write');
    expect(msgs[1].content).toContain('CREATE TABLE users');
    expect(msgs[1].content).toContain('how many users');
  });

  it('extractSqlFromAiText strips a ```sql fence, a leading hint, and a trailing semicolon', () => {
    expect(extractSqlFromAiText('```sql\nSELECT 1;\n```')).toBe('SELECT 1');
    expect(extractSqlFromAiText('SELECT 1;')).toBe('SELECT 1');
    expect(extractSqlFromAiText('sql\nSELECT 2')).toBe('SELECT 2');
  });
});

describe('POST /api/sites/:siteId/sql/nl2sql — gates + AI grounding', () => {
  beforeEach(() => {
    mIsSuperAdmin.mockReset();
    mWriteAuditLog.mockReset();
    mIsSuperAdmin.mockResolvedValue(true);
  });

  it('401 when unauthenticated', async () => {
    expect((await post(appWith(undefined, null), { question: 'x' }, makeEnv())).status).toBe(401);
  });

  it('403 when NOT super-admin (AI never called)', async () => {
    mIsSuperAdmin.mockResolvedValue(false);
    const ai = jest.fn();
    expect((await post(appWith('u'), { question: 'x' }, makeEnv(ai))).status).toBe(403);
    expect(ai).not.toHaveBeenCalled();
  });

  it('400 on an empty question', async () => {
    expect((await post(appWith('u'), { question: '' }, makeEnv())).status).toBe(400);
  });

  it('404 when the site is not in the org (AI never called)', async () => {
    const ai = jest.fn();
    const res = await post(appWith('u'), { question: 'x' }, makeEnv(ai, makeD1({ siteRow: null })));
    expect(res.status).toBe(404);
    expect(ai).not.toHaveBeenCalled();
  });

  it('200 returns the extracted SQL, grounds on the SERVER-fetched schema, audits, never executes', async () => {
    const ai = jest
      .fn()
      .mockResolvedValue({ response: '```sql\nSELECT id FROM users LIMIT 100;\n```' });
    const env = makeEnv(ai, makeD1({ masterSql: ['CREATE TABLE users (id TEXT, email TEXT)'] }));
    const res = await post(appWith('u'), { question: 'list users' }, env);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; sql: string; model: string };
    expect(b.ok).toBe(true);
    expect(b.sql).toBe('SELECT id FROM users LIMIT 100');
    // grounded on the REAL server-fetched DDL (not a client-supplied schema)
    const inputs = ai.mock.calls[0][1] as { messages: Array<{ content: string }> };
    expect(inputs.messages[1].content).toContain('CREATE TABLE users (id TEXT, email TEXT)');
    expect(mWriteAuditLog).toHaveBeenCalled();
  });

  it('502 when the AI call throws (honest — never a fabricated query)', async () => {
    const ai = jest.fn().mockRejectedValue(new Error('model down'));
    expect((await post(appWith('u'), { question: 'x' }, makeEnv(ai))).status).toBe(502);
  });
});
