/**
 * Log Explorer backend — DSL parse + row filter + event map + cost rollup.
 * Locks the pure logic behind `/api/logs/search` + `/api/logs/cost-by-route`
 * (Workers Observability → the admin Log Explorer): DSL AND-semantics, route
 * glob, status/duration comparators, event→row mapping, and the cost-by-route
 * aggregation (with a mocked Observability fetch). Fail-soft on API error.
 */
import type { Env } from '../types/env';
import {
  parseLogQuery,
  rowMatches,
  mapEvent,
  estimateCost,
  parseLogRange,
  costByRoute,
  searchLogs,
  type LogRow,
} from '../services/logs_explorer';

const rowOf = (over: Partial<LogRow> = {}): LogRow => ({
  id: 'x',
  ts: '2026-08-02T00:00:00Z',
  level: 'info',
  request_id: 'r',
  route: '/api/health',
  method: 'GET',
  status: 200,
  duration_ms: 10,
  cost_estimate: 0,
  message: 'http_request',
  meta: {},
  ...over,
});

describe('parseLogRange', () => {
  it('maps known ranges, defaults the rest to 24h', () => {
    expect(parseLogRange('1h')).toBe('1h');
    expect(parseLogRange('30d')).toBe('30d');
    expect(parseLogRange('nonsense')).toBe('24h');
    expect(parseLogRange(undefined)).toBe('24h');
  });
});

describe('parseLogQuery + rowMatches', () => {
  it('empty query matches everything', () => {
    expect(rowMatches(rowOf(), parseLogQuery(''))).toBe(true);
  });

  it('level: filters by exact level', () => {
    const f = parseLogQuery('level:error');
    expect(rowMatches(rowOf({ level: 'error' }), f)).toBe(true);
    expect(rowMatches(rowOf({ level: 'info' }), f)).toBe(false);
  });

  it('route: glob matches a wildcard prefix', () => {
    const f = parseLogQuery('route:/api/sites/*');
    expect(rowMatches(rowOf({ route: '/api/sites/abc/analytics' }), f)).toBe(true);
    expect(rowMatches(rowOf({ route: '/api/health' }), f)).toBe(false);
  });

  it('duration>Ns converts to ms and filters', () => {
    const f = parseLogQuery('duration>2s');
    expect(f.minDurationMs).toBe(2000);
    expect(rowMatches(rowOf({ duration_ms: 2500 }), f)).toBe(true);
    expect(rowMatches(rowOf({ duration_ms: 500 }), f)).toBe(false);
  });

  it('status>=500 filters server errors', () => {
    const f = parseLogQuery('status>=500');
    expect(rowMatches(rowOf({ status: 502 }), f)).toBe(true);
    expect(rowMatches(rowOf({ status: 200 }), f)).toBe(false);
  });

  it('combines constraints with AND + free text', () => {
    const f = parseLogQuery('level:error AND route:/api/* AND timeout');
    expect(
      rowMatches(rowOf({ level: 'error', route: '/api/sites', message: 'gateway timeout' }), f),
    ).toBe(true);
    expect(rowMatches(rowOf({ level: 'error', route: '/api/sites', message: 'ok' }), f)).toBe(
      false,
    ); // no "timeout"
    expect(rowMatches(rowOf({ level: 'info', route: '/api/sites', message: 'timeout' }), f)).toBe(
      false,
    ); // wrong level
  });
});

describe('mapEvent + estimateCost', () => {
  it('maps an http_request event to a LogRow', () => {
    const row = mapEvent(
      {
        ts: '2026-08-02T01:00:00Z',
        level: 'info',
        msg: 'http_request',
        method: 'GET',
        path: '/x',
        status: 200,
        durationMs: 42,
        requestId: 'req-1',
      },
      0,
    );
    expect(row).toMatchObject({
      route: '/x',
      method: 'GET',
      status: 200,
      duration_ms: 42,
      request_id: 'req-1',
      level: 'info',
    });
    expect(row.cost_estimate).toBeGreaterThan(0);
  });

  it('falls back route to service/scope when no path', () => {
    expect(mapEvent({ service: 'auth', level: 'warn', msg: 'x' }, 0).route).toBe('auth');
  });

  it('cost rises with duration', () => {
    expect(estimateCost(1000)).toBeGreaterThan(estimateCost(0));
  });

  // WLK-28: the dominant error-producing path (every thrown AppError, logged by
  // `middleware/error_handler.ts` via a raw `console.warn(JSON.stringify({code,
  // message, request_id, status, url, method}))` — NOT via `createLogger`, so the
  // event has NO `msg`/`path`/`requestId` keys, only `message`/`url`/`request_id`)
  // must still surface a real code + message + route in the mapped LogRow. Before
  // this fix: message fell through to '' (mapEvent only read `src.msg`), route fell
  // through to '—' (mapEvent only read `src.path`/`src.route`/`src.service`/
  // `src.scope`), and `code` had nowhere to go at all — a 500 in Log Explorer
  // rendered as an edge-level empty/generic row even though the worker had logged
  // the real detail.
  it('maps a thrown-AppError console.warn event (message/url/request_id keys, no msg/path) to a real row', () => {
    const row = mapEvent(
      {
        level: 'error',
        code: 'NOT_FOUND',
        message: 'Site not found',
        request_id: 'req-app-err-1',
        status: 404,
        url: '/api/sites/abc123',
        method: 'GET',
      } as unknown as Record<string, unknown>,
      0,
    );
    expect(row.message).toBe('Site not found');
    expect(row.route).toBe('/api/sites/abc123');
    expect(row.code).toBe('NOT_FOUND');
    expect(row.request_id).toBe('req-app-err-1');
    expect(row.status).toBe(404);
  });

  it('createLogger-shape events (msg/path/requestId, no top-level code) map code to null, never crash', () => {
    const row = mapEvent(
      { level: 'info', msg: 'http_request', path: '/api/health', requestId: 'req-2' },
      0,
    );
    expect(row.message).toBe('http_request');
    expect(row.route).toBe('/api/health');
    expect(row.code).toBeNull();
  });
});

// ── Integration: mocked Observability fetch ──────────────────────────────────

function makeEnv(): Env {
  return {
    CF_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_KEY: 'k',
    CLOUDFLARE_EMAIL: 'e@x.com',
  } as unknown as Env;
}
function obsResponse(sources: Array<Record<string, unknown>>) {
  return new Response(
    JSON.stringify({ result: { events: { events: sources.map((s) => ({ source: s })) } } }),
    { status: 200 },
  );
}

describe('searchLogs + costByRoute (mocked Observability)', () => {
  const orig = global.fetch;
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => {
    global.fetch = orig;
    jest.restoreAllMocks();
  });

  it('searchLogs maps + filters events', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      obsResponse([
        {
          eventName: 'http_request',
          method: 'GET',
          path: '/api/health',
          status: 200,
          durationMs: 5,
          level: 'info',
          msg: 'http_request',
        },
        {
          eventName: 'http_request',
          method: 'POST',
          path: '/api/sites/x',
          status: 500,
          durationMs: 30,
          level: 'error',
          msg: 'http_request',
        },
      ]),
    ) as unknown as typeof fetch;
    const res = await searchLogs(makeEnv(), { query: 'level:error', range: '24h', limit: 100 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].route).toBe('/api/sites/x');
    expect(res.next_cursor).toBeNull();
  });

  it('costByRoute rolls up per route with cost shares summing ~100%', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      obsResponse([
        { eventName: 'http_request', method: 'GET', path: '/a', status: 200, durationMs: 10 },
        { eventName: 'http_request', method: 'GET', path: '/a', status: 500, durationMs: 20 },
        { eventName: 'http_request', method: 'GET', path: '/b', status: 200, durationMs: 5 },
      ]),
    ) as unknown as typeof fetch;
    const res = await costByRoute(makeEnv(), '24h');
    const a = res.rows.find((r) => r.route === '/a')!;
    expect(a.request_count).toBe(2);
    expect(a.error_count).toBe(1);
    expect(res.grand_total_cost).toBeGreaterThan(0);
    const pctSum = res.rows.reduce((s, r) => s + r.cost_share_pct, 0);
    expect(Math.round(pctSum)).toBe(100);
  });

  it('fails soft to empty when the API errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const res = await searchLogs(makeEnv(), { query: '', range: '24h', limit: 100 });
    expect(res.items).toEqual([]);
    const cost = await costByRoute(makeEnv(), '24h');
    expect(cost.rows).toEqual([]);
  });

  it('returns empty (no fetch) when CF_ACCOUNT_ID is missing', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await searchLogs(
      { CLOUDFLARE_API_KEY: 'k', CLOUDFLARE_EMAIL: 'e' } as unknown as Env,
      {
        query: '',
        range: '24h',
        limit: 100,
      },
    );
    expect(res.items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
