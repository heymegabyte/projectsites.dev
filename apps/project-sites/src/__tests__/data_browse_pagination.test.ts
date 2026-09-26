/**
 * Unit tests for GET /api/sites/:siteId/data-overview/:table pagination
 *
 * Extended from the existing data-overview browse handler to add:
 *   ?limit    — default 25, hard-capped at 100
 *   ?offset   — default 0
 *   ?orderBy  — must be in that table's column allowlist, else fallback to first
 *   ?dir      — asc|desc (default asc)
 *
 * Response shape: { data: rows[], total: number, limit: number, offset: number }
 *
 * Guards:
 *  - cross-org site → 404
 *  - limit > 100 clamped to 100
 *  - offset applied to results
 *  - orderBy not in allowlist falls back safely (no SQL injection)
 *  - total returned from COUNT(*)
 *
 * @swc/jest mock hoisting: GLOBAL jest (not imported from @jest/globals)
 */

import { Hono } from 'hono';
import { siteDataApi, MAX_EXPORT_ROWS } from '../../libs/features/site_data_api/handlers.js';
import type { Env, Variables } from '../types/env.js';

// ─── D1 mock ────────────────────────────────────────────────────────────────

function makeD1(opts: {
  siteOwned?: boolean;
  rows?: Record<string, unknown>[];
  total?: number;
}): D1Database {
  const siteOwned = opts.siteOwned !== false;
  const rows = opts.rows ?? [
    { id: 'r1', event_type: 'pageview', url: '/foo', created_at: '2024-01-01' },
  ];
  const total = opts.total ?? rows.length;

  const prepare = jest.fn().mockImplementation((sql: string) => {
    const upper = sql.trim().toUpperCase();

    // IDOR guard: SELECT 1 FROM sites WHERE id=? AND org_id=?
    if (upper.startsWith('SELECT 1') && upper.includes('FROM SITES')) {
      return {
        bind: () => ({ first: () => Promise.resolve(siteOwned ? { ok: 1 } : null) }),
      };
    }

    // COUNT(*) query for total
    if (upper.includes('COUNT(*)')) {
      return {
        bind: () => ({ first: () => Promise.resolve({ n: total }) }),
      };
    }

    // data browse query
    if (upper.startsWith('SELECT')) {
      return {
        bind: () => ({ all: () => Promise.resolve({ results: rows }) }),
      };
    }

    return {
      bind: () => ({
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve(null),
      }),
    };
  });

  return { prepare } as unknown as D1Database;
}

function makeApp(DB: D1Database) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('orgId', 'org-1');
    c.set('userId', 'user-1');
    c.set('requestId', 'req-1');
    await next();
  });
  app.route('', siteDataApi);
  return app;
}

function req(siteId: string, table: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return new Request(
    `http://localhost/api/sites/${siteId}/data-overview/${table}${qs ? `?${qs}` : ''}`,
  );
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('GET /api/sites/:siteId/data-overview/:table pagination', () => {
  it('404 when site belongs to a different org (IDOR guard)', async () => {
    const DB = makeD1({ siteOwned: false });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events'), {}, {
      DB,
    } as unknown as Env);
    expect(res.status).toBe(404);
  });

  it('returns rows + total + limit + offset in response', async () => {
    const rows = [
      { id: 'r1', event_type: 'pageview', url: '/a', created_at: '2024-01-01' },
      { id: 'r2', event_type: 'pageview', url: '/b', created_at: '2024-01-02' },
    ];
    const DB = makeD1({ rows, total: 10 });
    const res = await makeApp(DB).request(
      req('site-1', 'visitor_events', { limit: '2', offset: '5' }),
      {},
      { DB } as unknown as Env,
    );
    expect(res.status).toBe(200);

    interface PaginatedBody {
      data: { rows: unknown[] };
      total: number;
      limit: number;
      offset: number;
    }
    const body = (await res.json()) as PaginatedBody;
    expect(body.data.rows).toHaveLength(2);
    expect(body.total).toBe(10);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(5);
  });

  it('clamps limit to 100 (never unbounded)', async () => {
    const DB = makeD1({ rows: [], total: 0 });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events', { limit: '9999' }), {}, {
      DB,
    } as unknown as Env);
    expect(res.status).toBe(200);

    interface PaginatedBody {
      limit: number;
    }
    const body = (await res.json()) as PaginatedBody;
    expect(body.limit).toBe(100);
  });

  it('defaults limit to 25 when omitted', async () => {
    const DB = makeD1({ rows: [], total: 0 });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events'), {}, {
      DB,
    } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(25);
  });

  it('offset defaults to 0 when omitted', async () => {
    const DB = makeD1({ rows: [], total: 0 });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events'), {}, {
      DB,
    } as unknown as Env);
    const body = (await res.json()) as { offset: number };
    expect(body.offset).toBe(0);
  });

  it('orderBy not in allowlist falls back safely (no SQL injection, no error)', async () => {
    const DB = makeD1({ rows: [], total: 0 });
    // 'injected_col; DROP TABLE users--' is not in visitor_events allowlist
    const res = await makeApp(DB).request(
      req('site-1', 'visitor_events', { orderBy: 'injected_col; DROP TABLE users--' }),
      {},
      { DB } as unknown as Env,
    );
    // must not 500; must succeed with fallback column order
    expect(res.status).toBe(200);
  });

  it('dir=desc is accepted', async () => {
    const DB = makeD1({ rows: [], total: 0 });
    const res = await makeApp(DB).request(
      req('site-1', 'visitor_events', { orderBy: 'created_at', dir: 'desc' }),
      {},
      { DB } as unknown as Env,
    );
    expect(res.status).toBe(200);
  });

  it('unknown table returns 400 (still protected by allowlist)', async () => {
    const DB = makeD1({});
    const res = await makeApp(DB).request(req('site-1', 'sqlite_master'), {}, {
      DB,
    } as unknown as Env);
    expect(res.status).toBe(400);
  });

  it('count=0 SKIPS the COUNT(*) and returns total null (client reuses its cached total on page-nav)', async () => {
    const DB = makeD1({ rows: [{ id: 'r1' }], total: 10 });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events', { count: '0' }), {}, {
      DB,
    } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number | null };
    expect(body.total).toBeNull(); // not counted this request
    // the COUNT(*) query must NOT have been prepared — that's the whole point (no expensive count/nav)
    const prepareMock = (DB as unknown as { prepare: jest.Mock }).prepare;
    const countPrepared = prepareMock.mock.calls.some((call: unknown[]) =>
      String(call[0]).toUpperCase().includes('COUNT(*)'),
    );
    expect(countPrepared).toBe(false);
  });

  it('default (no count param) STILL runs COUNT(*) → numeric total (backward-compatible)', async () => {
    const DB = makeD1({ rows: [{ id: 'r1' }], total: 7 });
    const res = await makeApp(DB).request(req('site-1', 'visitor_events'), {}, {
      DB,
    } as unknown as Env);
    const body = (await res.json()) as { total: number | null };
    expect(body.total).toBe(7);
    const prepareMock = (DB as unknown as { prepare: jest.Mock }).prepare;
    const countPrepared = prepareMock.mock.calls.some((call: unknown[]) =>
      String(call[0]).toUpperCase().includes('COUNT(*)'),
    );
    expect(countPrepared).toBe(true);
  });
});

describe('GET /api/sites/:siteId/data-overview/:table/export (whole-query export)', () => {
  function exportReq(siteId: string, table: string, params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Request(
      `http://localhost/api/sites/${siteId}/data-overview/${table}/export${qs ? `?${qs}` : ''}`,
    );
  }

  it('404 when the site belongs to a different org (IDOR guard)', async () => {
    const DB = makeD1({ siteOwned: false });
    const res = await makeApp(DB).request(exportReq('site-1', 'visitor_events'), {}, { DB } as unknown as Env);
    expect(res.status).toBe(404);
  });

  it('returns ALL matching rows (not a page) with truncated=false when under the cap', async () => {
    const rows = [
      { id: 'r1', event_type: 'pageview', path: '/a', created_at: '2024-01-01' },
      { id: 'r2', event_type: 'pageview', path: '/b', created_at: '2024-01-02' },
    ];
    const DB = makeD1({ rows });
    const res = await makeApp(DB).request(exportReq('site-1', 'visitor_events'), {}, { DB } as unknown as Env);
    expect(res.status).toBe(200);

    interface ExportBody {
      data: { rows: unknown[]; truncated: boolean; cap: number };
    }
    const body = (await res.json()) as ExportBody;
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.truncated).toBe(false);
    expect(body.data.cap).toBe(MAX_EXPORT_ROWS);

    // The export SQL binds a LIMIT of MAX+1 (the truncation-detection fetch) and NO offset.
    const prepareMock = (DB as unknown as { prepare: jest.Mock }).prepare;
    const exportCall = prepareMock.mock.calls.find((call: unknown[]) => {
      const s = String(call[0]).toUpperCase();
      return s.startsWith('SELECT') && s.includes('LIMIT ?') && !s.includes('OFFSET') && !s.includes('COUNT(*)');
    });
    expect(exportCall).toBeTruthy();
  });

  it('flags truncated=true and slices to the cap when the match set exceeds MAX_EXPORT_ROWS', async () => {
    // The mock returns whatever `rows` we give regardless of LIMIT, so MAX+1 rows simulates overflow.
    const many = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_unused, i) => ({
      id: `r${i}`,
      event_type: 'pageview',
      path: '/p',
      created_at: '2024-01-01',
    }));
    const DB = makeD1({ rows: many });
    const res = await makeApp(DB).request(exportReq('site-1', 'visitor_events'), {}, { DB } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rows: unknown[]; truncated: boolean } };
    expect(body.data.truncated).toBe(true);
    expect(body.data.rows).toHaveLength(MAX_EXPORT_ROWS); // sliced to the cap, not MAX+1
  });
});
