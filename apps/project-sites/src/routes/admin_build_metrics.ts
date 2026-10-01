/**
 * @module routes/admin_build_metrics
 * @description Super-Admin generation speed + cost rollup (fire-61 — the
 * north-star "speed + cost visible at a glance" surface over the fire-60
 * `build_metrics` instrument).
 *
 * `GET /api/admin/build-metrics/summary?days=1..365` (default 30) returns:
 *
 * ```jsonc
 * {
 *   "windowDays": 30,
 *   "builds": 12,                 // ALL terminal outcomes in window
 *   "p50_ms": 168000,             // speed percentiles: PUBLISHED builds only
 *   "p95_ms": 474000,             //   (error/halted durations aren't generation speed)
 *   "avg_cost_usd": 0.58,         // cost spans ALL outcomes — failures cost money too
 *   "total_cost_usd": 7.02,
 *   "phase_p50": { "collecting": 5000, "imaging": 0, "generating": 150000, "publishing": 25000 },
 *   "series": [ { "started_at": "…", "total_ms": 168000, "est_cost_usd": 0.51, "outcome": "published" } ]
 * }
 * ```
 *
 * ## Design
 * - **Percentiles are plain SQL** — `ORDER BY <expr> ASC LIMIT 1 OFFSET
 *   floor((n-1)·f)` (nearest-rank approximation). D1 has no percentile
 *   aggregate; window functions aren't needed. Phase percentiles read the
 *   `phase_ms` JSON column via `json_extract` (SQLite JSON1, supported by D1).
 * - **Honest empty** — an empty window returns `builds: 0` with NULL
 *   percentiles/costs and `series: []`. Zeros are never fabricated as data.
 * - **Fail LOUD on SQL errors** — a `dbQuery` error (e.g. missing table /
 *   schema drift) THROWS → global error handler 500s. Returning the
 *   honest-empty shape on a swallowed error would be a lying-empty masking
 *   drift (see swallowed-sql-error-masks-schema-drift).
 * - **Series = last {@link SERIES_LIMIT} builds**, window-independent (the
 *   sparkline trail stays meaningful when the window is quiet), returned
 *   chronologically (oldest → newest) ready to plot.
 *
 * Gate (in order): auth required (401) → super-admin (403). No feature flag —
 * operator-only diagnostics, mirroring `admin_funnel` / `admin_outbox`.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';
import { z } from 'zod';

import type { Env, Variables } from '../types/env.js';

import {
  BuildOutcomeSchema,
  BuildPhaseSchema,
  type BuildPhase,
} from '../services/build_metrics.js';
import { dbQuery } from '../services/db.js';
import { isSuperAdmin } from '../services/sysadmin.js';

/** RFC7807-ish error envelope used across the worker. */
function errorBody(code: string, message: string, requestId: string | undefined) {
  return { error: { code, message, request_id: requestId ?? null } };
}

const QuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).strip();

/** Default rollup window when `?days` is omitted. */
const DEFAULT_WINDOW_DAYS = 30;
/** The trailing per-build series length (sparkline source). */
const SERIES_LIMIT = 30;

/** Per-phase p50s; NULL = no published build recorded that phase in-window. */
export const PhaseP50Schema = z.object({
  collecting: z.number().int().nonnegative().nullable(),
  imaging: z.number().int().nonnegative().nullable(),
  generating: z.number().int().nonnegative().nullable(),
  publishing: z.number().int().nonnegative().nullable(),
});

/** One build in the trailing series (chronological, oldest → newest). */
export const BuildSeriesPointSchema = z.object({
  started_at: z.string().min(1),
  total_ms: z.number().int().nonnegative().nullable(),
  est_cost_usd: z.number().nonnegative(),
  outcome: BuildOutcomeSchema,
});

/** The summary response contract (validated before returning — zod-everywhere). */
export const BuildMetricsSummarySchema = z.object({
  windowDays: z.number().int().min(1).max(365),
  builds: z.number().int().nonnegative(),
  p50_ms: z.number().int().nonnegative().nullable(),
  p95_ms: z.number().int().nonnegative().nullable(),
  avg_cost_usd: z.number().nonnegative().nullable(),
  total_cost_usd: z.number().nonnegative().nullable(),
  phase_p50: PhaseP50Schema,
  series: z.array(BuildSeriesPointSchema),
});

/** Inferred summary type (never hand-written). */
export type BuildMetricsSummary = z.infer<typeof BuildMetricsSummarySchema>;

/**
 * Static per-phase SQL expressions over the `phase_ms` JSON column. Keys come
 * from {@link BuildPhaseSchema}; every string is a compile-time literal — no
 * user input ever reaches these fragments.
 */
const PHASE_EXPR: Record<BuildPhase, string> = {
  collecting: "CAST(json_extract(phase_ms, '$.collecting') AS INTEGER)",
  imaging: "CAST(json_extract(phase_ms, '$.imaging') AS INTEGER)",
  generating: "CAST(json_extract(phase_ms, '$.generating') AS INTEGER)",
  publishing: "CAST(json_extract(phase_ms, '$.publishing') AS INTEGER)",
};

/** Round to 4 decimals — strips float noise from SUM/AVG without lying. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Nearest-rank percentile via plain SQL: COUNT the non-null population, then
 * `ORDER BY <expr> ASC LIMIT 1 OFFSET floor((n-1)·fraction)`. D1-safe (no
 * window functions). Returns null for an empty population — honest, never 0.
 *
 * @param db       - D1 handle.
 * @param expr     - SQL value expression (internal literal, never user input).
 * @param where    - WHERE fragment (internal literal).
 * @param params   - Bind params for `where`.
 * @param fraction - 0..1 (0.5 = p50, 0.95 = p95).
 * @throws on any SQL error — schema drift must 500, never read as empty.
 */
async function sqlPercentile(
  db: Env['DB'],
  expr: string,
  where: string,
  params: unknown[],
  fraction: number,
): Promise<number | null> {
  const count = await dbQuery<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM build_metrics WHERE ${where} AND ${expr} IS NOT NULL`,
    params,
  );
  if (count.error) throw new Error(`build_metrics percentile count failed: ${count.error}`);
  const n = Number(count.data[0]?.n ?? 0);
  if (n <= 0) return null;
  const offset = Math.floor((n - 1) * fraction);
  const value = await dbQuery<{ v: number }>(
    db,
    `SELECT ${expr} AS v FROM build_metrics WHERE ${where} AND ${expr} IS NOT NULL
     ORDER BY v ASC LIMIT 1 OFFSET ?`,
    [...params, offset],
  );
  if (value.error) throw new Error(`build_metrics percentile value failed: ${value.error}`);
  const v = value.data[0]?.v;
  return v === undefined || v === null ? null : Math.max(0, Math.round(Number(v)));
}

/**
 * Compute the full summary for the trailing `windowDays` window. Exported for
 * direct unit coverage; the route is a thin auth shell over this.
 */
export async function computeBuildMetricsSummary(
  env: Pick<Env, 'DB'>,
  windowDays: number,
): Promise<BuildMetricsSummary> {
  // started_at is ISO-8601 (writer: build_metrics.finalize) — lexicographic
  // comparison against an ISO cutoff is chronologically correct.
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const agg = await dbQuery<{ builds: number; total_cost: number | null; avg_cost: number | null }>(
    env.DB,
    `SELECT COUNT(*) AS builds, SUM(est_cost_usd) AS total_cost, AVG(est_cost_usd) AS avg_cost
     FROM build_metrics WHERE started_at >= ?`,
    [cutoff],
  );
  if (agg.error) throw new Error(`build_metrics aggregate failed: ${agg.error}`);
  const builds = Number(agg.data[0]?.builds ?? 0);
  const totalCost = agg.data[0]?.total_cost;
  const avgCost = agg.data[0]?.avg_cost;

  // Speed = time-to-live: published builds only (an error that died in 10s or
  // a halt awaiting human approval would corrupt the p50/p95 story).
  const speedWhere = "started_at >= ? AND outcome = 'published'";
  const speedParams: unknown[] = [cutoff];
  const p50 = await sqlPercentile(env.DB, 'total_ms', speedWhere, speedParams, 0.5);
  const p95 = await sqlPercentile(env.DB, 'total_ms', speedWhere, speedParams, 0.95);

  const phases = BuildPhaseSchema.options;
  const phaseValues = await Promise.all(
    phases.map((phase) => sqlPercentile(env.DB, PHASE_EXPR[phase], speedWhere, speedParams, 0.5)),
  );
  const phaseP50 = Object.fromEntries(phases.map((phase, i) => [phase, phaseValues[i]])) as Record<
    BuildPhase,
    number | null
  >;

  const seriesRes = await dbQuery<{
    started_at: string;
    total_ms: number | null;
    est_cost_usd: number;
    outcome: string;
  }>(
    env.DB,
    `SELECT started_at, total_ms, est_cost_usd, outcome FROM build_metrics
     ORDER BY started_at DESC LIMIT ${SERIES_LIMIT}`,
    [],
  );
  if (seriesRes.error) throw new Error(`build_metrics series failed: ${seriesRes.error}`);
  const series = seriesRes.data
    .map((row) => ({
      started_at: String(row.started_at),
      total_ms: row.total_ms === null || row.total_ms === undefined ? null : Number(row.total_ms),
      est_cost_usd: round4(Number(row.est_cost_usd ?? 0)),
      outcome: row.outcome,
    }))
    .reverse(); // DESC fetch → chronological (oldest → newest) for plotting

  return BuildMetricsSummarySchema.parse({
    windowDays,
    builds,
    p50_ms: p50,
    p95_ms: p95,
    avg_cost_usd: avgCost === null || avgCost === undefined ? null : round4(Number(avgCost)),
    total_cost_usd:
      totalCost === null || totalCost === undefined ? null : round4(Number(totalCost)),
    phase_p50: phaseP50,
    series,
  });
}

export const adminBuildMetrics = new Hono<{ Bindings: Env; Variables: Variables }>();

adminBuildMetrics.get('/api/admin/build-metrics/summary', async (c) => {
  const requestId = c.get('requestId');
  const userId = c.get('userId');
  if (!userId) return c.json(errorBody('UNAUTHORIZED', 'Sign in required', requestId), 401);
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(errorBody('FORBIDDEN', 'Super-admin access required', requestId), 403);
  }

  const parsed = QuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid query', requestId), 400);
  }

  const summary = await computeBuildMetricsSummary(c.env, parsed.data.days ?? DEFAULT_WINDOW_DAYS);
  return c.json(summary, 200);
});
