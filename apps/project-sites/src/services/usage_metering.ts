/**
 * @module services/usage_metering
 * @description Usage metering pipeline (item #99).
 *
 * Records metered usage into `usage_events` and forwards it to the active
 * billing provider (Stripe Billing Meters) through the `meter*` wrappers below.
 *
 * | Metric              | Source                                                |
 * | ------------------- | ----------------------------------------------------- |
 * | `ai_calls`          | every `env.AI.run` invocation                         |
 * | `bytes_egress`      | sum of response body bytes from `/api/sites/{id}/serve` |
 * | `image_generations` | every successful DALL·E / Stability / Ideogram call   |
 *
 * @packageDocumentation
 */

import { dbInsert, dbQuery, dbQueryOne } from './db.js';
import { resolveActiveOrgPlan } from './build_limits.js';
import { USAGE_TIERS, USAGE_METRICS, OVERAGE_MICRO_USD } from '../constants/pricing.js';
import type { UsageTier, UsageMetric } from '../constants/pricing.js';
import type { Env } from '../types/env.js';

/** First and last day of the current calendar month (UTC, ISO-8601). */
export function currentMonthPeriod(now: Date = new Date()): {
  period_start: string;
  period_end: string;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { period_start: start.toISOString(), period_end: end.toISOString() };
}

/**
 * Record a metered usage event.
 *
 * Never throws — write failures are logged so we don't break the originating
 * request flow.
 *
 * @example
 * ```ts
 * await recordUsage(env, env.DB, {
 *   orgId, metric: 'ai_calls', value: 1, siteId,
 * });
 * ```
 */
export async function recordUsage(
  _env: Env,
  db: D1Database,
  opts: { orgId: string; metric: UsageMetric; value: number; siteId?: string | null },
): Promise<void> {
  if (opts.value <= 0) return;
  const warn = (error: string): void =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'failed to record usage',
        org_id: opts.orgId,
        metric: opts.metric,
        error,
      }),
    );
  try {
    // `dbInsert` returns `{ error }` and NEVER throws on a D1 failure — capturing that
    // error is the ONLY way the drop is observable. A bare `await dbInsert(...)` silently
    // drops the event AND logs nothing (the JSDoc "failures are logged" was false: the
    // catch below only fires on a genuine JS throw, which this insert never produces).
    // Fire-and-forget by design — log the drop, never break the originating request.
    const { error } = await dbInsert(db, 'usage_events', {
      id: crypto.randomUUID(),
      org_id: opts.orgId,
      site_id: opts.siteId ?? null,
      metric: opts.metric,
      value: Math.floor(opts.value),
      ts: new Date().toISOString(),
      billed: 0,
      stripe_subscription_item_id: null,
    });
    if (error) warn(error);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sum usage for an org across the current calendar month, broken down by
 * metric. Used by `/api/billing/usage/this-month`.
 *
 * @example
 * ```ts
 * const { ai_calls, bytes_egress_mb, image_generations } =
 *   await getMonthUsage(env.DB, orgId);
 * ```
 */
export async function getMonthUsage(
  db: D1Database,
  orgId: string,
  now: Date = new Date(),
): Promise<{
  ai_calls: number;
  bytes_egress: number;
  bytes_egress_mb: number;
  image_generations: number;
  period_start: string;
  period_end: string;
}> {
  const { period_start, period_end } = currentMonthPeriod(now);
  const out: Record<UsageMetric, number> = {
    ai_calls: 0,
    bytes_egress: 0,
    image_generations: 0,
  };
  for (const metric of USAGE_METRICS) {
    const row = await dbQueryOne<{ total: number | null }>(
      db,
      `SELECT COALESCE(SUM(value), 0) AS total FROM usage_events
       WHERE org_id = ? AND metric = ? AND ts >= ? AND ts < ?`,
      [orgId, metric, period_start, period_end],
    );
    out[metric] = row?.total ?? 0;
  }
  return {
    ai_calls: out.ai_calls,
    bytes_egress: out.bytes_egress,
    bytes_egress_mb: Math.round(out.bytes_egress / (1024 * 1024)),
    image_generations: out.image_generations,
    period_start,
    period_end,
  };
}

/**
 * Resolve the active tier for an org. Free is the default; orgs on a paid
 * subscription get `pro`. `scale` is reserved for orgs with the higher
 * Stripe price id baked into their subscription metadata.
 */
export async function getOrgTier(db: D1Database, orgId: string): Promise<UsageTier> {
  // Route through the SSOT plan resolver (`status IN ('active','trialing')`) so a
  // TRIALING paid sub gets the pro tier — the old `status === 'active'` gate
  // excluded trialing (trialing-drift class). past_due/canceled resolve to null → free.
  const plan = await resolveActiveOrgPlan(db, orgId);
  if (plan !== 'paid') return 'free';
  // Future: differentiate scale via subscription_item lookup. Default to pro.
  return 'pro';
}

/**
 * Compute overage in micro-USD for an org's current month, against the
 * tier inclusions. Returned as an integer (no float drift).
 *
 * @example
 * ```ts
 * const overage = await computeOverageMicroUsd(env.DB, orgId);
 * if (overage.total_micro_usd > 0) showUpgradeCta();
 * ```
 */
export async function computeOverageMicroUsd(
  db: D1Database,
  orgId: string,
  tier: UsageTier,
  now: Date = new Date(),
): Promise<{
  ai_calls_overage: number;
  bytes_egress_overage: number;
  image_generations_overage: number;
  total_micro_usd: number;
}> {
  const usage = await getMonthUsage(db, orgId, now);
  const inclusions = USAGE_TIERS[tier];
  const aiOver = Math.max(0, usage.ai_calls - inclusions.ai_calls);
  const egOver = Math.max(0, usage.bytes_egress - inclusions.bytes_egress);
  const imgOver = Math.max(0, usage.image_generations - inclusions.image_generations);
  // Egress is billed per GB; round UP to the nearest GB for billing parity.
  const egGbOver = Math.ceil(egOver / (1024 * 1024 * 1024));
  const totalMicroUsd =
    aiOver * OVERAGE_MICRO_USD.ai_calls +
    egGbOver * OVERAGE_MICRO_USD.bytes_egress_per_gb +
    imgOver * OVERAGE_MICRO_USD.image_generations;
  return {
    ai_calls_overage: aiOver,
    bytes_egress_overage: egOver,
    image_generations_overage: imgOver,
    total_micro_usd: totalMicroUsd,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// StripeMetersProvider bridge (post-OpenMeter removal, 2026-06-29)
// ═══════════════════════════════════════════════════════════════════════════

import { createBillingProvider, type UsageMetric as BillingMetric } from './billing_provider.js';

/**
 * Record AI token usage through the billing provider (noop — billing is Stripe; no per-token billing provider).
 *
 * Call AFTER an LLM response with actual token counts (NOT estimated).
 * One event per AI call, with separate input + output token quantities.
 *
 * Never throws — metering failures log and continue.
 * Cost: ~$0.000015/input-token + $0.00006/output-token. At 1M tokens/day → ~$75/day.
 * Latency: <1ms (async, fire-and-forget via `void`).
 */
export async function meterAiTokens(
  env: Env,
  opts: {
    orgId: string;
    siteId?: string | null;
    inputTokens: number;
    outputTokens: number;
    model?: string;
    feature?: string;
  },
): Promise<void> {
  if (opts.inputTokens <= 0 && opts.outputTokens <= 0) return;
  try {
    const provider = await createBillingProvider(env);
    const now = new Date().toISOString();
    const base = {
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.orgId,
      orgId: opts.orgId,
      siteId: opts.siteId ?? undefined,
      unit: 'token' as const,
      source: 'ai_gateway',
      occurredAt: now,
      metadata: {
        model: opts.model,
        feature: opts.feature,
      },
    };

    const events: Parameters<typeof provider.recordUsageBatch>[0] = [];
    if (opts.inputTokens > 0) {
      events.push({
        ...base,
        id: crypto.randomUUID(),
        metric: 'ai_input_tokens' as BillingMetric,
        quantity: opts.inputTokens,
      });
    }
    if (opts.outputTokens > 0) {
      events.push({
        ...base,
        id: crypto.randomUUID(),
        metric: 'ai_output_tokens' as BillingMetric,
        quantity: opts.outputTokens,
      });
    }
    await provider.recordUsageBatch(events);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'meterAiTokens failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Record browser automation minutes.
 *
 * Call AFTER a browser job completes with the actual duration in minutes.
 */
export async function meterBrowserMinutes(
  env: Env,
  opts: { orgId: string; siteId?: string | null; minutes: number; purpose?: string },
): Promise<void> {
  if (opts.minutes <= 0) return;
  try {
    const provider = await createBillingProvider(env);
    await provider.recordUsage({
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.orgId,
      orgId: opts.orgId,
      siteId: opts.siteId ?? undefined,
      metric: 'browser_automation_minutes',
      quantity: Math.ceil(opts.minutes),
      unit: 'minute',
      source: 'browser_gateway',
      occurredAt: new Date().toISOString(),
      metadata: opts.purpose ? { purpose: opts.purpose } : undefined,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'meterBrowserMinutes failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Record email send usage.
 *
 * Call AFTER a successful email send (SES/Listmonk).
 */
export async function meterEmailSend(
  env: Env,
  opts: { orgId: string; count?: number; campaignId?: string },
): Promise<void> {
  const count = opts.count ?? 1;
  if (count <= 0) return;
  try {
    const provider = await createBillingProvider(env);
    await provider.recordUsage({
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.orgId,
      orgId: opts.orgId,
      metric: 'email_sends',
      quantity: count,
      unit: 'event',
      source: 'listmonk',
      occurredAt: new Date().toISOString(),
      metadata: opts.campaignId ? { campaign_id: opts.campaignId } : undefined,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'meterEmailSend failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Record build compute minutes through the billing provider.
 *
 * Call from site-generation workflow after build completion with elapsed wall-clock minutes.
 * ~$0.02/min estimate. Cost: <1ms (async, fire-and-forget via `void`).
 * Metronome-compatible: same bridge works regardless of active provider.
 */
export async function meterBuildComputeMinutes(
  env: Env,
  opts: { orgId: string; siteId?: string | null; minutes: number; buildVersion?: string },
): Promise<void> {
  if (opts.minutes <= 0) return;
  try {
    const provider = await createBillingProvider(env);
    await provider.recordUsage({
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.orgId,
      orgId: opts.orgId,
      siteId: opts.siteId ?? undefined,
      metric: 'build_compute_minutes',
      quantity: Math.ceil(opts.minutes),
      unit: 'minute',
      source: 'site_generation',
      occurredAt: new Date().toISOString(),
      metadata: opts.buildVersion ? { build_version: opts.buildVersion } : undefined,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'meterBuildComputeMinutes failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Re-export the static price table so route code uses one source of truth. */
export { USAGE_TIERS } from '../constants/pricing.js';

/**
 * Convenience: usage + tier + caps + overage rolled into one payload for the
 * admin /admin/billing usage panel.
 */
export async function getUsagePanelPayload(
  db: D1Database,
  orgId: string,
  now: Date = new Date(),
): Promise<{
  tier: UsageTier;
  tier_label: string;
  inclusions: { ai_calls: number; bytes_egress: number; image_generations: number };
  usage: Awaited<ReturnType<typeof getMonthUsage>>;
  overage: Awaited<ReturnType<typeof computeOverageMicroUsd>>;
  near_limit: boolean;
}> {
  const tier = await getOrgTier(db, orgId);
  const usage = await getMonthUsage(db, orgId, now);
  const overage = await computeOverageMicroUsd(db, orgId, tier, now);
  const inclusions = USAGE_TIERS[tier];
  const nearLimit =
    usage.ai_calls / inclusions.ai_calls >= 0.8 ||
    usage.bytes_egress / inclusions.bytes_egress >= 0.8 ||
    usage.image_generations / inclusions.image_generations >= 0.8;
  return {
    tier,
    tier_label: inclusions.label,
    inclusions: {
      ai_calls: inclusions.ai_calls,
      bytes_egress: inclusions.bytes_egress,
      image_generations: inclusions.image_generations,
    },
    usage,
    overage,
    near_limit: nearLimit,
  };
}

/**
 * Record a site visit (page view) through the billing provider.
 * Cost: ~$0.00001/visit (effectively free). Call from site_serving on every page serve.
 * No org lookup needed — just counts the visit for analytics.
 */
export async function meterSiteVisit(
  env: Env,
  opts: { siteId: string; slug: string; count?: number },
): Promise<void> {
  try {
    const provider = await createBillingProvider(env);
    await provider.recordUsage({
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.siteId, // site-level, no org context needed on hot path
      siteId: opts.siteId,
      metric: 'site_visits',
      quantity: opts.count ?? 1,
      unit: 'event',
      source: 'site_serving',
      occurredAt: new Date().toISOString(),
      metadata: { slug: opts.slug },
    });
  } catch (err) {
    // Silently ignore — hot path must never block on metering
  }
}

/**
 * Record a form submission through the billing provider. Free tier — metered for analytics.
 * Cost: $0 (free metric). Call from form handlers after successful submission.
 */
export async function meterFormSubmission(
  env: Env,
  opts: { orgId: string; siteId?: string | null; count?: number },
): Promise<void> {
  try {
    const provider = await createBillingProvider(env);
    await provider.recordUsage({
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      customerId: opts.orgId,
      orgId: opts.orgId,
      siteId: opts.siteId ?? undefined,
      metric: 'form_submissions',
      quantity: opts.count ?? 1,
      unit: 'event',
      source: 'form_router',
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'usage_metering',
        message: 'meterFormSubmission failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Aggregate usage daily for cron — used to populate billing rollups. */
export async function aggregateNightly(db: D1Database): Promise<{ rows: number }> {
  // The views (v_usage_daily_*) make read queries cheap. This function is a
  // placeholder for future materialization into a physical aggregate table.
  // For now we just touch the views to validate they exist.
  const result = await dbQuery<{ total: number | null }>(
    db,
    'SELECT COUNT(*) AS total FROM v_usage_daily_ai_calls',
    [],
  );
  return { rows: result.data[0]?.total ?? 0 };
}
