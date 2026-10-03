/**
 * GET /api/sites/:siteId/automations — RES-AUTO slice 1 (the Automations panel's
 * read-only discovery endpoint). Lists a site's workflow/automation instances
 * (its `workflow_jobs` rows) shaped for a UI list, for the OWNING org only.
 *
 * Contract this suite locks:
 *   - Flag `site_automations` OFF → 404 (never 403 — existence never leaked).
 *   - Authenticated + owned + flag on → 200 with `{ data: Automation[] }`, each
 *     item `{ id, type, status, created_at, finished_at }` sourced from the real
 *     `workflow_jobs` rows (display reconciles with the store — honest-empty when
 *     the store has none).
 *   - Cross-org / missing site → 404 (IDOR guard via assertSiteOwned).
 *   - Unauthenticated → 401.
 *
 * Mocks `isFlagOn` + `assertSiteOwned` at the module boundary (4-level `../` to
 * reach src/, global `jest` for @swc hoisting — per apps/project-sites/CLAUDE.md
 * gotchas 11+12). D1 is stubbed at `env.DB` so the handler's real `dbQuery`
 * SELECT runs against captured rows.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { siteAutomations } from '../../libs/features/site_automations/handlers.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { assertSiteOwned } from '../services/site_ownership.js';

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../services/site_ownership.js', () => ({
  assertSiteOwned: jest.fn(),
}));

const mockIsFlagOn = isFlagOn as jest.Mock;
const mockAssertSiteOwned = assertSiteOwned as jest.Mock;

interface JobRow {
  id: string;
  job_name: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/** Minimal D1 stub: prepare().bind().all() → { results }. Captures bind params. */
function makeDbStub(rows: JobRow[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  };
  return { db: db as unknown as Env['DB'], calls };
}

function makeApp(vars: Partial<Variables>, env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.orgId) c.set('orgId', vars.orgId);
    c.set('requestId', vars.requestId ?? 'test-req');
    await next();
  });
  app.route('/', siteAutomations);
  return (path: string) => app.request(path, {}, env as Env);
}

const jobRow = (id: string, status = 'success'): JobRow => ({
  id,
  job_name: 'site-generation',
  status,
  created_at: '2026-10-02T00:00:00.000Z',
  completed_at: status === 'success' ? '2026-10-02T00:05:00.000Z' : null,
});

describe('GET /api/sites/:siteId/automations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
  });

  it('404s when the flag is OFF (never leaks existence)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { db } = makeDbStub([jobRow('j1')]);
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/automations');
    expect(res.status).toBe(404);
    // Ownership + store are never touched once the flag gate rejects.
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });

  it('requires authentication (401 with no org)', async () => {
    const { db } = makeDbStub([]);
    const req = makeApp({}, { DB: db });
    const res = await req('/api/sites/site-1/automations');
    expect(res.status).toBe(401);
  });

  it('404s for a cross-org / missing site (IDOR guard)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const { db } = makeDbStub([jobRow('j1')]);
    const req = makeApp({ orgId: 'intruder' }, { DB: db });
    const res = await req('/api/sites/site-1/automations');
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
  });

  it('returns the owner workflow_jobs rows shaped for a UI list', async () => {
    const { db, calls } = makeDbStub([jobRow('j1', 'success'), jobRow('j2', 'running')]);
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/automations');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{
        id: string;
        type: string;
        status: string;
        created_at: string;
        finished_at: string | null;
      }>;
    };
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      id: 'j1',
      type: 'site-generation',
      status: 'success',
      created_at: '2026-10-02T00:00:00.000Z',
      finished_at: '2026-10-02T00:05:00.000Z',
    });
    expect(data[1]).toEqual({
      id: 'j2',
      type: 'site-generation',
      status: 'running',
      created_at: '2026-10-02T00:00:00.000Z',
      finished_at: null,
    });
    // Store query is scoped to the site (display reconciles with the store).
    expect(calls[0].sql).toMatch(/FROM workflow_jobs/i);
    expect(calls[0].params).toContain('site-1');
  });

  it('honest-empty: 200 + [] when the site has no automations', async () => {
    const { db } = makeDbStub([]);
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/automations');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });
});
