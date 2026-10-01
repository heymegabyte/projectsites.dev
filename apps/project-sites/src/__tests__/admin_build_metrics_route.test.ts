import { Hono } from 'hono';

import { adminBuildMetrics } from '../routes/admin_build_metrics';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { isSuperAdmin } from '../services/sysadmin.js';
import { createD1Sqlite, type D1SqliteHarness } from './helpers/d1_sqlite';

/**
 * Super-Admin build-metrics summary route (fire-61 — generation speed + cost
 * north star). The aggregation runs against a REAL SQLite via the d1_sqlite
 * harness so the percentile SQL (ORDER BY/LIMIT OFFSET) + json_extract phase
 * math execute for real — a mock double can't catch an off-by-one offset or a
 * wrong-filter. The sysadmin check AND the `build_metrics` flag gate are mocked
 * (route-guard contract).
 *
 * Locks:
 *  - 401 unauthenticated / 404 flag-off / 403 non-super-admin / 400 invalid `days`.
 *  - flag gate runs BEFORE super-admin: off → 404 (never 403 — no existence leak).
 *  - Empty-table HONEST shape: builds:0 + null percentiles/costs + [] series
 *    (never fabricated zeros presented as measurements).
 *  - p50/p95 via ORDER BY/LIMIT OFFSET over PUBLISHED builds only.
 *  - phase_p50 from the phase_ms JSON column (0 is honest data, not null).
 *  - cost aggregates over ALL terminal outcomes (failures cost money too).
 *  - series = last 30 builds, chronological (oldest → newest).
 */
jest.mock('../services/sysadmin.js', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));

const mockIsSuperAdmin = isSuperAdmin as jest.MockedFunction<typeof isSuperAdmin>;
const mockIsFlagOn = isFlagOn as jest.MockedFunction<typeof isFlagOn>;

/** Mirrors migrations/0652_build_metrics.sql (columns the endpoint reads). */
const BUILD_METRICS_DDL = `
CREATE TABLE build_metrics (
  build_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  org_id TEXT,
  started_at TEXT NOT NULL,
  published_at TEXT,
  total_ms INTEGER,
  phase_ms TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  model_calls TEXT,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  container_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'error',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

function makeApp(auth: { userId?: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.userId) c.set('userId', auth.userId);
    await next();
  });
  app.route('/', adminBuildMetrics);
  return app;
}

interface SeedRow {
  id: string;
  startedAt: string;
  totalMs: number | null;
  cost: number;
  outcome: 'published' | 'error' | 'halted';
  phase?: Record<string, number> | null;
}

function seed(h: D1SqliteHarness, row: SeedRow): void {
  h.raw
    .prepare(
      `INSERT INTO build_metrics (build_id, site_id, started_at, total_ms, phase_ms, est_cost_usd, outcome)
       VALUES (?, 'site_1', ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.startedAt,
      row.totalMs,
      row.phase ? JSON.stringify(row.phase) : null,
      row.cost,
      row.outcome,
    );
}

/** ISO timestamp `hoursAgo` hours in the past (inside the default 30d window). */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

interface SummaryBody {
  windowDays: number;
  builds: number;
  p50_ms: number | null;
  p95_ms: number | null;
  avg_cost_usd: number | null;
  total_cost_usd: number | null;
  phase_p50: {
    collecting: number | null;
    imaging: number | null;
    generating: number | null;
    publishing: number | null;
  };
  series: { started_at: string; total_ms: number | null; est_cost_usd: number; outcome: string }[];
}

let h: D1SqliteHarness;
const env = () => ({ DB: h.db }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true); // flag ON by default; off-path has its own test
  h = createD1Sqlite();
  h.exec(BUILD_METRICS_DDL);
});

afterEach(() => h.close());

describe('GET /api/admin/build-metrics/summary — guards', () => {
  it('401s when unauthenticated', async () => {
    const res = await makeApp({}).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it('404s when the build_metrics flag is OFF — even for a super-admin (never 403, no existence leak)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    mockIsSuperAdmin.mockResolvedValue(true);
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it('flag gate runs BEFORE the super-admin check — off flag 404s a non-super-admin too (never 403)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await makeApp({ userId: 'u1' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(404);
    // super-admin must not even be consulted when the flag is off (hard 404)
    expect(mockIsSuperAdmin).not.toHaveBeenCalled();
  });

  it('403s when authed, flag ON, but not a super-admin', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await makeApp({ userId: 'u1' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it('400s on an invalid days query', async () => {
    mockIsSuperAdmin.mockResolvedValue(true);
    for (const q of ['days=abc', 'days=0', 'days=999']) {
      const res = await makeApp({ userId: 'admin' }).request(
        `/api/admin/build-metrics/summary?${q}`,
        { method: 'GET' },
        env(),
      );
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /api/admin/build-metrics/summary — empty table (honest shape)', () => {
  it('returns builds:0 with NULL percentiles/costs and an empty series — never fake zeros', async () => {
    mockIsSuperAdmin.mockResolvedValue(true);
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryBody;
    expect(body).toEqual({
      windowDays: 30,
      builds: 0,
      p50_ms: null,
      p95_ms: null,
      avg_cost_usd: null,
      total_cost_usd: null,
      phase_p50: { collecting: null, imaging: null, generating: null, publishing: null },
      series: [],
    });
  });
});

describe('GET /api/admin/build-metrics/summary — seeded aggregation (real SQL)', () => {
  beforeEach(() => {
    mockIsSuperAdmin.mockResolvedValue(true);
    // 10 published builds: total_ms = i minutes; phases scale with i; imaging
    // always 0 (container pipeline) — its p50 must be an HONEST 0, not null.
    for (let i = 1; i <= 10; i++) {
      seed(h, {
        id: `b${i}`,
        startedAt: hoursAgo(30.5 - i), // oldest = b1 (29.5h ago); half-hour offset keeps every row clear of day-window boundaries
        totalMs: i * 60_000,
        cost: 0.5,
        outcome: 'published',
        phase: { collecting: 1_000 * i, imaging: 0, generating: 30_000 * i, publishing: 5_000 * i },
      });
    }
    // Failures/halts count toward builds + cost, but NEVER toward speed percentiles.
    seed(h, { id: 'err1', startedAt: hoursAgo(5), totalMs: 30_000, cost: 2, outcome: 'error' });
    seed(h, { id: 'halt1', startedAt: hoursAgo(4), totalMs: null, cost: 0, outcome: 'halted' });
  });

  it('computes p50/p95 over published builds via ORDER BY/LIMIT OFFSET', async () => {
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryBody;
    expect(body.windowDays).toBe(30);
    expect(body.builds).toBe(12); // all terminal outcomes in window
    // 10 published sorted ASC → p50 offset floor(9*0.5)=4 → 5th value; p95 offset floor(9*0.95)=8 → 9th.
    expect(body.p50_ms).toBe(300_000);
    expect(body.p95_ms).toBe(540_000);
    // Cost spans ALL outcomes: (10 × 0.5 + 2 + 0) / 12.
    expect(body.total_cost_usd).toBe(7);
    expect(body.avg_cost_usd).toBeCloseTo(7 / 12, 4);
  });

  it('computes phase_p50 from the phase_ms JSON (0 is honest data, not null)', async () => {
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    const body = (await res.json()) as SummaryBody;
    expect(body.phase_p50).toEqual({
      collecting: 5_000,
      imaging: 0,
      generating: 150_000,
      publishing: 25_000,
    });
  });

  it('returns the last 30 builds as a chronological series (oldest → newest)', async () => {
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    const body = (await res.json()) as SummaryBody;
    expect(body.series).toHaveLength(12);
    const starts = body.series.map((p) => p.started_at);
    expect([...starts].sort()).toEqual(starts); // ascending
    expect(body.series[0]).toMatchObject({ total_ms: 60_000, outcome: 'published' });
    expect(body.series.at(-1)).toMatchObject({ total_ms: null, outcome: 'halted' });
    expect(body.series.map((p) => p.outcome)).toContain('error');
  });

  it('excludes out-of-window builds from stats while the series keeps the last-30 trail', async () => {
    seed(h, {
      id: 'old1',
      startedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      totalMs: 999_999,
      cost: 9.9,
      outcome: 'published',
    });
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary',
      { method: 'GET' },
      env(),
    );
    const body = (await res.json()) as SummaryBody;
    expect(body.builds).toBe(12); // window stats unchanged
    expect(body.p95_ms).toBe(540_000);
    expect(body.total_cost_usd).toBe(7);
    expect(body.series).toHaveLength(13); // trail is last-30-builds, window-independent
    expect(body.series[0].total_ms).toBe(999_999);
  });

  it('honors a custom ?days window', async () => {
    // Inside 1 day: err1 (5h) + halt1 (4h) + b7..b10 — b_i started (30.5−i)h
    // ago → within 24h only for i ≥ 7 (23.5h, 22.5h, 21.5h, 20.5h).
    const res = await makeApp({ userId: 'admin' }).request(
      '/api/admin/build-metrics/summary?days=1',
      { method: 'GET' },
      env(),
    );
    const body = (await res.json()) as SummaryBody;
    expect(body.windowDays).toBe(1);
    expect(body.builds).toBe(6); // b7..b10 + err1 + halt1
    expect(body.p50_ms).toBe(480_000); // published [420k,480k,540k,600k] → offset floor(3*.5)=1
  });
});
