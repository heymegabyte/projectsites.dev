/**
 * @module services/build_metrics
 * @description Per-build generation METRICS instrument (fire-60 north star:
 * website generation SPEED + COST). Stamps phase timestamps + accumulates
 * Worker-side model-call token counters during a site-generation workflow run,
 * then writes ONE `build_metrics` D1 row at the terminal outcome
 * (`published | error | halted`).
 *
 * ## Design
 *
 * - **Fire-and-forget safe.** Every function catches + warn-logs; a metrics
 *   failure can NEVER block or fail a build (same contract as
 *   `build_events.ts` / `build_budget.recordSpend`).
 * - **Replay-safe.** Cloudflare Workflows re-execute `run()` top-to-bottom on
 *   every hibernation wake (only `step.do` results are memoized), so in-flight
 *   state lives in KV keyed by site, `init` is first-write-wins per `buildId`
 *   (= the replay-stable `event.instanceId`), and `markBuildPhase` is
 *   first-write-wins per phase. Step RETRIES re-accumulate token counters —
 *   correct, since a retried LLM call genuinely re-spends tokens.
 * - **Terminal upsert.** `finalizeBuildMetrics` is an idempotent upsert keyed
 *   by `build_id`: a premature `error` row from a retried step is overwritten
 *   by the eventual `published` finalize (last outcome wins).
 * - **Cost model.** `est_cost_usd` = Σ per-model token cost + container
 *   minutes, from {@link services/build_pricing}. Container-internal
 *   Claude/DeepSeek tokens are not yet surfaced by the container (elapsed
 *   seconds only) — container minutes carry that share of the cost.
 *
 * Storage: KV `build-metrics:site:{siteId}` (24h TTL) while in flight;
 * D1 `build_metrics` (migration `0652_build_metrics.sql`) at terminal.
 * Baseline reader: `scripts/gen-baseline.mjs`.
 *
 * @example
 * ```ts
 * await initBuildMetrics(env, { siteId, buildId: event.instanceId, orgId,
 *   startedAtMs: new Date(event.timestamp).getTime() });
 * await markBuildPhase(env, siteId, 'generating');
 * await finalizeBuildMetrics(env, siteId, 'published', { containerSeconds: 1500 });
 * ```
 *
 * @packageDocumentation
 */

import { z } from 'zod';

import type { Env } from '../types/env.js';

import { estimateBuildCostUsd, type ModelCallAgg } from './build_pricing.js';
import { dbExecute } from './db.js';

/** Minimal env surface — keeps the module trivially testable with harness doubles. */
export type BuildMetricsEnv = Pick<Env, 'DB' | 'CACHE_KV'>;

/** Build phases mirroring the site status machine (imaging rides inside the container build → 0ms). */
export const BuildPhaseSchema = z.enum(['collecting', 'imaging', 'generating', 'publishing']);
/** One of the four instrumented build phases. */
export type BuildPhase = z.infer<typeof BuildPhaseSchema>;

/** Phase order — drives `computePhaseMs` (a phase ends when the next RECORDED one starts). */
const PHASE_ORDER: readonly BuildPhase[] = ['collecting', 'imaging', 'generating', 'publishing'];

/** Terminal outcomes a build row can record. */
export const BuildOutcomeSchema = z.enum(['published', 'error', 'halted']);
/** Terminal build outcome. */
export type BuildOutcome = z.infer<typeof BuildOutcomeSchema>;

/** Aggregated usage for one model within a build. */
export const ModelCallAggSchema = z.object({
  calls: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
});

/** In-flight KV state for one build (schema-validated on every read). */
export const BuildMetricsStateSchema = z.object({
  /** Replay-stable run id (Workflow `event.instanceId`). */
  buildId: z.string().min(1),
  /** Container build duration in ms when known. */
  containerMs: z.number().int().nonnegative().default(0),
  /** First-write-wins phase start stamps, epoch ms. */
  marks: z.record(BuildPhaseSchema, z.number().int().positive()).default({}),
  /** Per-model aggregated token usage. */
  modelCalls: z.record(z.string(), ModelCallAggSchema).default({}),
  orgId: z.string().min(1).nullable().default(null),
  siteId: z.string().min(1),
  /** Epoch ms the run started (Workflow `event.timestamp` — replay-stable). */
  startedAtMs: z.number().int().positive(),
});

/** Inferred in-flight state type. */
export type BuildMetricsState = z.infer<typeof BuildMetricsStateSchema>;

/** The terminal D1 row (validated before write). */
export const BuildMetricsRowSchema = z.object({
  build_id: z.string().min(1),
  container_ms: z.number().int().nonnegative(),
  est_cost_usd: z.number().nonnegative(),
  model_calls: z.record(z.string(), ModelCallAggSchema),
  org_id: z.string().nullable(),
  outcome: BuildOutcomeSchema,
  phase_ms: z.record(BuildPhaseSchema, z.number().int().nonnegative()),
  published_at: z.string().nullable(),
  site_id: z.string().min(1),
  started_at: z.string().min(1),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  total_ms: z.number().int().nonnegative(),
});

/** Inferred terminal-row type. */
export type BuildMetricsRow = z.infer<typeof BuildMetricsRowSchema>;

/** In-flight KV state TTL — builds are short-lived; mirror build_events' 24h. */
const STATE_TTL_SECONDS = 24 * 60 * 60;

/** KV key holding the in-flight metrics state for a site's active build. */
export function buildMetricsKey(siteId: string): string {
  return `build-metrics:site:${siteId}`;
}

/** Structured warn — metrics must be observable but never throw. */
function warn(message: string, extra: Record<string, unknown> = {}): void {
  console.warn(
    JSON.stringify({ level: 'warn', message, service: 'build_metrics', ...extra }),
  );
}

/** Read + validate in-flight state; null when absent/corrupt (fail-soft). */
async function readState(env: BuildMetricsEnv, siteId: string): Promise<BuildMetricsState | null> {
  try {
    const raw = await env.CACHE_KV.get(buildMetricsKey(siteId));
    if (!raw) return null;
    const parsed = BuildMetricsStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    warn('failed to read metrics state', {
      error: err instanceof Error ? err.message : String(err),
      siteId,
    });
    return null;
  }
}

/** Persist in-flight state (fail-soft). */
async function writeState(env: BuildMetricsEnv, state: BuildMetricsState): Promise<void> {
  try {
    await env.CACHE_KV.put(buildMetricsKey(state.siteId), JSON.stringify(state), {
      expirationTtl: STATE_TTL_SECONDS,
    });
  } catch (err) {
    warn('failed to write metrics state', {
      buildId: state.buildId,
      error: err instanceof Error ? err.message : String(err),
      siteId: state.siteId,
    });
  }
}

/**
 * Start (or replay-resume) metrics for a build. First-write-wins per
 * `buildId`: a hibernation replay with the same instance id keeps the existing
 * marks/counters; a NEW build id replaces the previous build's state. Stamps
 * the `collecting` phase at `startedAtMs`.
 *
 * @param env  - Worker env (`DB` + `CACHE_KV`).
 * @param opts - `siteId` + replay-stable `buildId` (+ optional orgId/startedAtMs).
 */
export async function initBuildMetrics(
  env: BuildMetricsEnv,
  opts: { siteId: string; buildId: string; orgId?: string | null; startedAtMs?: number },
): Promise<void> {
  try {
    const existing = await readState(env, opts.siteId);
    if (existing && existing.buildId === opts.buildId) return; // replay — keep state
    const startedAtMs = opts.startedAtMs ?? Date.now();
    await writeState(env, {
      buildId: opts.buildId,
      containerMs: 0,
      marks: { collecting: startedAtMs },
      modelCalls: {},
      orgId: opts.orgId ?? null,
      siteId: opts.siteId,
      startedAtMs,
    });
  } catch (err) {
    warn('initBuildMetrics failed', {
      buildId: opts.buildId,
      error: err instanceof Error ? err.message : String(err),
      siteId: opts.siteId,
    });
  }
}

/**
 * Stamp a phase start (first-write-wins — replay/retry re-marks are no-ops).
 * Quiet no-op when no build is in flight for the site.
 */
export async function markBuildPhase(
  env: BuildMetricsEnv,
  siteId: string,
  phase: BuildPhase,
  atMs: number = Date.now(),
): Promise<void> {
  try {
    const state = await readState(env, siteId);
    if (!state || state.marks[phase] !== undefined) return;
    state.marks[phase] = atMs;
    await writeState(env, state);
  } catch (err) {
    warn('markBuildPhase failed', {
      error: err instanceof Error ? err.message : String(err),
      phase,
      siteId,
    });
  }
}

/**
 * Accumulate one model call's token usage into the in-flight build. Quiet
 * no-op when no build is in flight (LLM traffic outside builds) or when both
 * token counts are 0. Read-modify-write on KV — best-effort by design; the
 * build path makes few, serial Worker-side LLM calls.
 */
export async function accumulateBuildModelCall(
  env: BuildMetricsEnv,
  siteId: string,
  call: { model: string; tokensIn: number; tokensOut: number },
): Promise<void> {
  try {
    const tokensIn = Math.max(0, Math.floor(call.tokensIn) || 0);
    const tokensOut = Math.max(0, Math.floor(call.tokensOut) || 0);
    if (tokensIn <= 0 && tokensOut <= 0) return;
    const state = await readState(env, siteId);
    if (!state) return;
    const agg = state.modelCalls[call.model] ?? { calls: 0, tokens_in: 0, tokens_out: 0 };
    state.modelCalls[call.model] = {
      calls: agg.calls + 1,
      tokens_in: agg.tokens_in + tokensIn,
      tokens_out: agg.tokens_out + tokensOut,
    };
    await writeState(env, state);
  } catch (err) {
    warn('accumulateBuildModelCall failed', {
      error: err instanceof Error ? err.message : String(err),
      model: call.model,
      siteId,
    });
  }
}

/**
 * Structural adapter for the AI client (`external_llm.ts`): accumulate from a
 * trace context when it names a site; void no-op otherwise. Keeps the client
 * edit to one fire-and-forget line per success path.
 */
export function accumulateBuildModelCallFromTrace(
  env: BuildMetricsEnv,
  trace: { siteId?: string } | undefined,
  model: string,
  tokensIn: number,
  tokensOut: number,
): void {
  const siteId = trace?.siteId;
  if (!siteId) return;
  void accumulateBuildModelCall(env, siteId, { model, tokensIn, tokensOut }).catch(() => {});
}

/**
 * Compute per-phase durations from first-write-wins start marks. A recorded
 * phase runs until the NEXT recorded phase's mark (in canonical order), the
 * last recorded phase until `endMs`. Unrecorded phases are 0 (e.g. `imaging`
 * in the container pipeline). Negative spans clamp to 0. Pure + exported for
 * unit tests.
 */
export function computePhaseMs(
  marks: Partial<Record<BuildPhase, number>>,
  endMs: number,
): Record<BuildPhase, number> {
  const out: Record<BuildPhase, number> = {
    collecting: 0,
    generating: 0,
    imaging: 0,
    publishing: 0,
  };
  const recorded = PHASE_ORDER.filter((p) => typeof marks[p] === 'number');
  for (let i = 0; i < recorded.length; i++) {
    const phase = recorded[i];
    const start = marks[phase] as number;
    const next = i + 1 < recorded.length ? (marks[recorded[i + 1]] as number) : endMs;
    out[phase] = Math.max(0, Math.round(next - start));
  }
  return out;
}

/**
 * Write the terminal `build_metrics` row for the site's in-flight build.
 * Idempotent upsert on `build_id` — last outcome wins (a step-retry's
 * premature `error` is overwritten by the eventual `published`). Never throws;
 * returns the row written or `null` when no state existed / validation failed.
 *
 * @param env     - Worker env (`DB` + `CACHE_KV`).
 * @param siteId  - Site whose active build is terminating.
 * @param outcome - `published` | `error` | `halted`.
 * @param opts    - Optional `containerSeconds` (from the container's final
 *   status) and `endMs` (test injection; defaults to now).
 */
export async function finalizeBuildMetrics(
  env: BuildMetricsEnv,
  siteId: string,
  outcome: BuildOutcome,
  opts: { containerSeconds?: number; endMs?: number } = {},
): Promise<BuildMetricsRow | null> {
  try {
    const state = await readState(env, siteId);
    if (!state) {
      warn('finalize without in-flight state — row skipped', { outcome, siteId });
      return null;
    }
    const endMs = opts.endMs ?? Date.now();
    const containerMs =
      opts.containerSeconds !== undefined && opts.containerSeconds > 0
        ? Math.round(opts.containerSeconds * 1000)
        : state.containerMs;
    const phaseMs = computePhaseMs(state.marks, endMs);
    let tokensIn = 0;
    let tokensOut = 0;
    for (const agg of Object.values(state.modelCalls)) {
      tokensIn += agg.tokens_in;
      tokensOut += agg.tokens_out;
    }
    const row = BuildMetricsRowSchema.safeParse({
      build_id: state.buildId,
      container_ms: containerMs,
      est_cost_usd: estimateBuildCostUsd(state.modelCalls as Record<string, ModelCallAgg>, containerMs),
      model_calls: state.modelCalls,
      org_id: state.orgId,
      outcome,
      phase_ms: phaseMs,
      published_at: outcome === 'published' ? new Date(endMs).toISOString() : null,
      site_id: state.siteId,
      started_at: new Date(state.startedAtMs).toISOString(),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      total_ms: Math.max(0, Math.round(endMs - state.startedAtMs)),
    });
    if (!row.success) {
      warn('finalize row failed validation — dropped', {
        issues: row.error.issues.map((i) => i.message),
        outcome,
        siteId,
      });
      return null;
    }
    const r = row.data;
    const res = await dbExecute(
      env.DB,
      `INSERT INTO build_metrics (
         build_id, site_id, org_id, started_at, published_at, total_ms, phase_ms,
         tokens_in, tokens_out, model_calls, est_cost_usd, container_ms, outcome,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(build_id) DO UPDATE SET
         published_at = excluded.published_at,
         total_ms = excluded.total_ms,
         phase_ms = excluded.phase_ms,
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         model_calls = excluded.model_calls,
         est_cost_usd = excluded.est_cost_usd,
         container_ms = excluded.container_ms,
         outcome = excluded.outcome,
         updated_at = datetime('now')`,
      [
        r.build_id,
        r.site_id,
        r.org_id,
        r.started_at,
        r.published_at,
        r.total_ms,
        JSON.stringify(r.phase_ms),
        r.tokens_in,
        r.tokens_out,
        JSON.stringify(r.model_calls),
        r.est_cost_usd,
        r.container_ms,
        r.outcome,
      ],
    );
    if (res.error) {
      warn('finalize row write failed', { buildId: r.build_id, error: res.error, siteId });
      return null;
    }
    return r;
  } catch (err) {
    warn('finalizeBuildMetrics failed', {
      error: err instanceof Error ? err.message : String(err),
      outcome,
      siteId,
    });
    return null;
  }
}
