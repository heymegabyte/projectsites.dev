/**
 * @module services/build_budget
 *
 * @description
 * Per-tenant TOKEN-BURN METER + BUDGET KILLSWITCH (idea #13).
 *
 * Caps AI spend per org BEFORE an expensive container build runs. Spend is
 * accumulated into the existing `usage_events` table under a dedicated
 * `ai_spend_micro_usd` metric (stored as integer micro-USD so there is no
 * float drift — 1 USD = 1_000_000 micro-USD, mirroring `OVERAGE_MICRO_USD`).
 *
 * @remarks
 * - **Killswitch:** when accumulated spend for the current calendar month
 *   reaches the plan cap, `checkBudget` returns `{ allowed: false }`. The
 *   site-generation workflow throws a friendly `AppError` BEFORE the container
 *   build step, so a runaway org never burns past its cap.
 * - **Caps mirror `build_limits`:** owners of unlimited orgs
 *   (`brian@megabyte.space`) and the `'unlimited'` plan get `Infinity`. The
 *   caller passes the billing plan — this module does not re-resolve it, to
 *   stay pure and off the hot path (same contract as `checkBuildLimit`).
 * - **Best-effort recording:** `recordSpend` never throws; a write failure is
 *   logged so the originating AI phase is never broken by metering.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { dbExecute, dbQuery } from './db.js';
import { isUnlimitedOrgOwner } from './build_limits.js';

/** Metric name used to accumulate AI spend rows in `usage_events`. */
export const AI_SPEND_METRIC = 'ai_spend_micro_usd';

/** 1 USD expressed in micro-USD — keeps accumulation integer-only. */
const MICRO_PER_USD = 1_000_000;

/**
 * Per-plan monthly AI-spend caps in USD. Free tier is intentionally tight so
 * a single runaway build can't drain the platform's AI budget. `unlimited`
 * and whitelisted owners bypass the cap entirely (`Infinity`).
 */
export const PLAN_BUDGET_USD: Record<'free' | 'paid' | 'unlimited', number> = {
  free: 5,
  paid: 100,
  unlimited: Infinity,
};

/** Per-isolate cache of orgs known to have an unlimited budget (lazy). */
const UNLIMITED_ORGS = new Set<string>();

/** Zod schema for a spend record submitted to `recordSpend`. */
export const SpendRecordSchema = z
  .object({
    /** Prompt/input token count for the LLM phase (best-effort). */
    tokensIn: z.number().int().nonnegative().default(0),
    /** Completion/output token count for the LLM phase (best-effort). */
    tokensOut: z.number().int().nonnegative().default(0),
    /** Model identifier the spend is attributed to (free-form). */
    model: z.string().min(1).max(128),
    /** Dollar cost of the phase. Must be finite + non-negative. */
    usd: z.number().nonnegative().finite(),
    /** Optional site the spend belongs to. */
    siteId: z.string().min(1).optional().nullable(),
  })
  .strict();

/** Inferred input type for {@link recordSpend}. */
export type SpendRecord = z.infer<typeof SpendRecordSchema>;

/** Zod schema for the meter snapshot returned by {@link checkBudget}. */
export const BudgetMeterSchema = z
  .object({
    /** Whether another spend-incurring build is permitted. */
    allowed: z.boolean(),
    /** Accumulated spend this calendar month, USD. */
    spentUsd: z.number().nonnegative(),
    /** Plan cap in USD (`Infinity` for unlimited). */
    capUsd: z.number(),
    /** Remaining headroom in USD (`Infinity` for unlimited, clamped ≥0). */
    remainingUsd: z.number(),
    /** Spend as a 0-100 percentage of the cap (`0` for unlimited). */
    pct: z.number().min(0),
  })
  .strict();

/** Inferred meter snapshot type. */
export type BudgetMeter = z.infer<typeof BudgetMeterSchema>;

/** First and last day of the current calendar month (UTC, ISO-8601). */
function currentMonthPeriod(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Normalize a caller-supplied plan string to a known budget tier. */
function resolvePlan(plan: string | null): 'free' | 'paid' | 'unlimited' {
  if (plan === 'unlimited') return 'unlimited';
  if (plan === 'paid') return 'paid';
  return 'free';
}

/**
 * Whether the org has an unlimited AI budget. Mirrors `build_limits`'
 * whitelist: the `'unlimited'` plan OR an owner email of
 * `brian@megabyte.space`. Result cached per-isolate so the membership query
 * stays off the hot path for repeat callers.
 */
async function hasUnlimitedBudget(
  db: D1Database,
  orgId: string,
  plan: 'free' | 'paid' | 'unlimited',
): Promise<boolean> {
  if (plan === 'unlimited' || UNLIMITED_ORGS.has(orgId)) return true;
  // Owner on the unlimited whitelist (shared single-source with build_limits).
  if (await isUnlimitedOrgOwner(db, orgId)) {
    UNLIMITED_ORGS.add(orgId);
    return true;
  }
  return false;
}

/** Sum accumulated AI spend (micro-USD) for an org this calendar month. */
async function monthSpendMicroUsd(
  db: D1Database,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const { start, end } = currentMonthPeriod(now);
  const SQL = `SELECT COALESCE(SUM(value), 0) AS total FROM usage_events
     WHERE org_id = ? AND metric = ? AND ts >= ? AND ts < ?`;
  const params = [orgId, AI_SPEND_METRIC, start, end];
  // FAIL-CLOSED on a sustained D1 error. `dbQuery`/`dbQueryOne` SWALLOW a D1 throw (dbQuery →
  // `{ data: [], error }`; dbQueryOne discards that `error` and returns null), so the OLD
  // `dbQueryOne(...).catch(() => ({ total: 0 }))` was DOUBLY wrong: the `.catch` was DEAD (dbQueryOne
  // never rejects) AND a D1 error read spend as $0 → checkBudget `allowed: true` → the AI-spend
  // KILLSWITCH (its whole job: stop a runaway org draining the platform AI budget) SILENTLY OPENED —
  // the same fail-open cost-cap-bypass class as build_limits AL-784. Use `dbQuery` and inspect
  // `.error` (the ONLY reliable D1-error signal here, since a null/empty result is ambiguous between
  // "no rows" and "error"); retry once (catches the common transient), then on a SUSTAINED error
  // return Infinity so checkBudget denies. (AL-785)
  let result = await dbQuery<{ total: number | null }>(db, SQL, params);
  if (result.error !== null) {
    result = await dbQuery<{ total: number | null }>(db, SQL, params); // one retry
  }
  if (result.error !== null) {
    return Number.POSITIVE_INFINITY; // sustained error → fail closed (deny)
  }
  return result.data[0]?.total ?? 0;
}

/**
 * Check whether the org may run another AI-spend-incurring build without
 * exceeding its monthly budget cap. This is the KILLSWITCH gate — call it
 * BEFORE the expensive container build step.
 *
 * @param db    - D1Database binding.
 * @param orgId - Organization to check.
 * @param plan  - Active billing plan (`'paid'` → $100, `'unlimited'` → ∞,
 *   anything else → free tier $5). `null` defaults to free.
 * @returns A Zod-validated {@link BudgetMeter} snapshot.
 *
 * @example
 * ```ts
 * const meter = await checkBudget(env.DB, orgId, subscription?.plan ?? null);
 * if (!meter.allowed) {
 *   throw new AppError({ code: 'FORBIDDEN', statusCode: 403,
 *     message: `AI budget exhausted ($${meter.spentUsd}/$${meter.capUsd}).` });
 * }
 * ```
 */
export async function checkBudget(
  db: D1Database,
  orgId: string,
  plan: string | null,
  now: Date = new Date(),
): Promise<BudgetMeter> {
  const tier = resolvePlan(plan);

  if (await hasUnlimitedBudget(db, orgId, tier)) {
    return BudgetMeterSchema.parse({
      allowed: true,
      spentUsd: 0,
      capUsd: Infinity,
      remainingUsd: Infinity,
      pct: 0,
    });
  }

  const capUsd = PLAN_BUDGET_USD[tier];
  const rawSpentUsd = (await monthSpendMicroUsd(db, orgId, now)) / MICRO_PER_USD;
  // monthSpendMicroUsd returns Infinity on a sustained D1 error (retry exhausted) → we cannot
  // confirm the org is under budget, so treat spend as AT the cap: DENY, and show a clean
  // "$cap/$cap exhausted" meter rather than "$Infinity". capUsd is always finite here (the
  // unlimited tier returned early above). (AL-785, fail-closed)
  const spentUsd = Number.isFinite(rawSpentUsd) ? rawSpentUsd : capUsd;
  const remainingUsd = Math.max(0, capUsd - spentUsd);
  const pct = capUsd > 0 ? Math.min(100, (spentUsd / capUsd) * 100) : 100;

  return BudgetMeterSchema.parse({
    allowed: spentUsd < capUsd,
    spentUsd,
    capUsd,
    remainingUsd,
    pct,
  });
}

/**
 * Accumulate AI spend for an org. Best-effort — never throws (a metering write
 * failure must never break the originating LLM phase). Validates the input
 * with {@link SpendRecordSchema}; an invalid record is logged + dropped.
 *
 * Spend is stored as integer micro-USD in `usage_events` under the
 * {@link AI_SPEND_METRIC} metric so the monthly SUM stays float-free.
 *
 * @param env  - Worker env (uses `env.DB`).
 * @param orgId - Organization the spend belongs to.
 * @param record - Token counts + model + dollar cost (+ optional siteId).
 *
 * @example
 * ```ts
 * await recordSpend(env, orgId, {
 *   tokensIn: 1200, tokensOut: 800, model: 'claude-opus', usd: 0.42, siteId,
 * });
 * ```
 */
export async function recordSpend(
  env: { DB: D1Database },
  orgId: string,
  record: SpendRecord,
): Promise<void> {
  const parsed = SpendRecordSchema.safeParse(record);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'build_budget',
        feature_slug: 'token_burn_meter',
        message: 'invalid spend record dropped',
        org_id: orgId,
        issues: parsed.error.issues.map((i) => i.message),
      }),
    );
    return;
  }

  const microUsd = Math.round(parsed.data.usd * MICRO_PER_USD);
  if (microUsd <= 0) return;

  // usage_events has NO created_at/updated_at columns — `dbInsert` auto-prepends
  // them, so its INSERT threw `no such column: created_at` every time → swallowed →
  // the AI-spend billing meter recorded NOTHING ($0 forever). Use an explicit
  // dbExecute over the 8 real columns.
  //
  // dbExecute NEVER throws — it swallows the D1 error internally and returns
  // `{ error }`. A bare try/catch here was DEAD CODE for that real failure mode: a
  // dropped spend INSERT (schema drift / D1 outage) silently under-counted the budget
  // meter with only db.ts's generic `d1_exec_error` line — recordSpend's own
  // billing-context warn never fired. Capture the returned `error` (belt-and-suspenders
  // catch for a binding-level throw) and surface the drop with org/model/tokens so a
  // spend-tracking failure is OBSERVABLE. Stays best-effort: never throws (a spend write
  // must not break the LLM call / build).
  let execError: string | null = null;
  try {
    const res = await dbExecute(
      env.DB,
      `INSERT INTO usage_events (id, org_id, site_id, metric, value, ts, billed, stripe_subscription_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        orgId,
        parsed.data.siteId ?? null,
        AI_SPEND_METRIC,
        microUsd,
        new Date().toISOString(),
        0,
        null,
      ],
    );
    execError = res.error;
  } catch (err) {
    execError = err instanceof Error ? err.message : String(err);
  }
  if (execError) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'build_budget',
        feature_slug: 'token_burn_meter',
        message: 'failed to record spend',
        org_id: orgId,
        model: parsed.data.model,
        tokens_in: parsed.data.tokensIn,
        tokens_out: parsed.data.tokensOut,
        micro_usd: microUsd,
        error: execError,
      }),
    );
  }
}
