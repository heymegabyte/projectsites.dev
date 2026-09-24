/**
 * Tests for the arbitrary start/end window on GET /api/analytics/:siteId — both the
 * pure `parseCustomWindow` validator and the route wiring. Tenant authz (siteId →
 * site → membership) is UNAFFECTED by the window params: a non-member is still 403'd
 * even with a valid window, and the window only shapes the query time bounds.
 */

import { Hono } from 'hono';

import { analytics, parseCustomWindow } from '../handlers.js';
import type { Env } from '../../../../src/types/env.js';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * SQL-shape-keyed D1 stub. `sites` → an owned site row; `memberships` → present or
 * absent per `member`; everything else (the analytics aggregates + byDay) → empty,
 * captured into `calls` so we can assert the exact window bounds bound to byDay.
 */
function makeEnv(member: boolean, calls: Call[]): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => {
              if (sql.includes('FROM sites WHERE id')) {
                return { results: [{ slug: 'demo', org_id: 'org-a' }] };
              }
              if (sql.includes('FROM memberships')) {
                return { results: member ? [{ id: 'm1' }] : [] };
              }
              return { results: [] as unknown[] };
            },
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

function request(auth: { userId?: string }, env: Env, path: string): Promise<Response> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.userId) c.set('userId', auth.userId);
    await next();
  });
  app.route('/', analytics);
  return app.request(path, { method: 'GET' }, env);
}

describe('parseCustomWindow', () => {
  it('returns no window (and no error) when both start + end are absent', () => {
    expect(parseCustomWindow(undefined, undefined)).toEqual({});
    expect(parseCustomWindow(null, null)).toEqual({});
  });

  it('errors when only one bound is given', () => {
    expect(parseCustomWindow('2026-08-01', undefined).error).toBe('start_and_end_required');
    expect(parseCustomWindow(undefined, '2026-08-15').error).toBe('start_and_end_required');
  });

  it('errors on a malformed date', () => {
    expect(parseCustomWindow('nope', '2026-08-15').error).toBe('invalid_date_format');
    expect(parseCustomWindow('2026-8-1', '2026-08-15').error).toBe('invalid_date_format');
  });

  it('errors when start is after end', () => {
    expect(parseCustomWindow('2026-08-15', '2026-08-01').error).toBe('start_after_end');
  });

  it('builds an end-inclusive window (until = end + 1 day, exclusive)', () => {
    const r = parseCustomWindow('2026-08-01', '2026-08-15');
    expect(r.window).toEqual({ since: '2026-08-01', until: '2026-08-16' });
    expect(r.startDisplay).toBe('2026-08-01');
    expect(r.endDisplay).toBe('2026-08-15');
  });

  it('clamps a span over 90 days by moving start forward, keeping end', () => {
    const r = parseCustomWindow('2026-01-01', '2026-12-31');
    // 90-day inclusive window ending on 2026-12-31 → start = 2026-10-03.
    expect(r.endDisplay).toBe('2026-12-31');
    expect(r.window?.until).toBe('2027-01-01');
    expect(r.startDisplay).toBe('2026-10-03');
  });
});

describe('GET /api/analytics/:siteId — custom window wiring + tenant isolation', () => {
  it('binds the absolute [since, until) window to the daily-series query', async () => {
    const calls: Call[] = [];
    const env = makeEnv(true, calls);
    const res = await request({ userId: 'u1' }, env, '/api/analytics/site_x?start=2026-08-01&end=2026-08-15');
    expect(res.status).toBe(200);
    const byDay = calls.find((c) => c.sql.includes('DATE(created_at) AS day'));
    expect(byDay).toBeDefined();
    expect(byDay!.sql).toContain('created_at >= ? AND created_at < ?');
    expect(byDay!.params).toEqual(['site_x', '2026-08-01', '2026-08-16']);
  });

  it('echoes the exact window served in the response', async () => {
    const env = makeEnv(true, []);
    const res = await request({ userId: 'u1' }, env, '/api/analytics/site_x?start=2026-08-01&end=2026-08-15');
    const body = (await res.json()) as { data: { windowStart: string; windowEnd: string } };
    expect(body.data.windowStart).toBe('2026-08-01');
    expect(body.data.windowEnd).toBe('2026-08-15');
  });

  it('400s a malformed window', async () => {
    const env = makeEnv(true, []);
    const res = await request({ userId: 'u1' }, env, '/api/analytics/site_x?start=nope&end=2026-08-15');
    expect(res.status).toBe(400);
  });

  it('400s a reversed window', async () => {
    const env = makeEnv(true, []);
    const res = await request({ userId: 'u1' }, env, '/api/analytics/site_x?start=2026-08-15&end=2026-08-01');
    expect(res.status).toBe(400);
  });

  it('still 403s a non-member EVEN with a valid window (authz is window-independent)', async () => {
    const env = makeEnv(false, []);
    const res = await request({ userId: 'u_intruder' }, env, '/api/analytics/site_x?start=2026-08-01&end=2026-08-15');
    expect(res.status).toBe(403);
  });

  it('401s an unauthenticated caller', async () => {
    const env = makeEnv(true, []);
    const res = await request({}, env, '/api/analytics/site_x?start=2026-08-01&end=2026-08-15');
    expect(res.status).toBe(401);
  });
});
