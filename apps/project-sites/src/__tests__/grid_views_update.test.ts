/**
 * Route tests for PUT /api/sites/:siteId/grid-views/:viewId — updating a saved view in place
 * (name + whole query + render type/config). Guards:
 *  - cross-org site → 404 (IDOR: ownsSiteData)
 *  - missing name → 400
 *  - a foreign/unknown view id (UPDATE affects 0 rows) → 404 (never a silent success)
 *  - success → 200 + the re-serialized view
 *
 * @swc/jest mock hoisting: GLOBAL jest (not imported from @jest/globals).
 */

import { Hono } from 'hono';
import { siteDataApi } from '../../libs/features/site_data_api/handlers.js';
import type { Env, Variables } from '../types/env.js';

function makeD1(opts: { siteOwned?: boolean; changes?: number; row?: Record<string, unknown> | null }): D1Database {
  const siteOwned = opts.siteOwned !== false;
  const changes = opts.changes ?? 1;
  const row =
    opts.row === undefined
      ? {
          id: 'v1',
          table_key: 'form_submissions',
          name: 'Renamed',
          filters_json: '[{"col":"status","op":"eq","val":"new"}]',
          combinator: 'AND',
          sort_col: 'created_at',
          sort_dir: 'desc',
          search: '',
          type: 'gallery',
          config_json: '{"titleField":"email"}',
          updated_at: '2026-09-26T00:00:00Z',
        }
      : opts.row;

  const prepare = jest.fn().mockImplementation((sql: string) => {
    const u = sql.trim().toUpperCase();
    if (u.startsWith('SELECT 1') && u.includes('FROM SITES')) {
      return { bind: () => ({ first: () => Promise.resolve(siteOwned ? { ok: 1 } : null) }) };
    }
    if (u.startsWith('UPDATE EDITOR_GRID_VIEWS')) {
      return { bind: () => ({ run: () => Promise.resolve({ meta: { changes } }) }) };
    }
    if (u.startsWith('SELECT') && u.includes('EDITOR_GRID_VIEWS')) {
      return { bind: () => ({ first: () => Promise.resolve(row) }) };
    }
    return {
      bind: () => ({
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({ meta: { changes: 0 } }),
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
    await next();
  });
  app.route('', siteDataApi);
  return app;
}

function putReq(siteId: string, viewId: string, body: unknown) {
  return new Request(`http://localhost/api/sites/${siteId}/grid-views/${viewId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/sites/:siteId/grid-views/:viewId', () => {
  it('404 when the site belongs to a different org (IDOR guard)', async () => {
    const DB = makeD1({ siteOwned: false });
    const res = await makeApp(DB).request(putReq('site-1', 'v1', { name: 'x' }), {}, { DB } as unknown as Env);
    expect(res.status).toBe(404);
  });

  it('400 when the name is missing/blank', async () => {
    const DB = makeD1({});
    const res = await makeApp(DB).request(putReq('site-1', 'v1', { name: '   ' }), {}, { DB } as unknown as Env);
    expect(res.status).toBe(400);
  });

  it('404 when the UPDATE affects 0 rows (foreign/unknown view id — never a silent success)', async () => {
    const DB = makeD1({ changes: 0 });
    const res = await makeApp(DB).request(
      putReq('site-1', 'nope', { name: 'x', filters: [], combinator: 'AND' }),
      {},
      { DB } as unknown as Env,
    );
    expect(res.status).toBe(404);
  });

  it('200 + returns the re-serialized view on success (type/config/filters round-trip)', async () => {
    const DB = makeD1({ changes: 1 });
    const res = await makeApp(DB).request(
      putReq('site-1', 'v1', {
        name: 'Renamed',
        filters: [{ col: 'status', op: 'eq', val: 'new' }],
        combinator: 'AND',
        sortCol: 'created_at',
        sortDir: 'desc',
        type: 'gallery',
        config: { titleField: 'email' },
      }),
      {},
      { DB } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { view: { name: string; type: string; config: { titleField?: string } } } };
    expect(body.data.view.name).toBe('Renamed');
    expect(body.data.view.type).toBe('gallery');
    expect(body.data.view.config).toEqual({ titleField: 'email' });
  });
});
