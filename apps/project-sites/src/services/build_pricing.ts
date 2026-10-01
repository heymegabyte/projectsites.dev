/**
 * @module services/build_pricing
 * @description Unit-price constants + pure cost math for per-build generation
 * metrics (fire-60 north star: generation speed + cost). Consumed by
 * {@link services/build_metrics} at finalize time to compute
 * `build_metrics.est_cost_usd`.
 *
 * ## Why its own module (and not external_llm.MODEL_COSTS)
 *
 * `external_llm.ts` imports `build_metrics.ts` (token accumulation hook), and
 * `build_metrics.ts` imports this module — importing `external_llm` from here
 * would create an ESM cycle. This module therefore owns its OWN price table
 * and stays dependency-free (pure constants + math, trivially testable). A
 * parity unit test in `__tests__/build_metrics.test.ts` locks this table to
 * `external_llm.estimateCostPrecise` so the two can never drift silently.
 *
 * @packageDocumentation
 */

/**
 * USD per 1M tokens, `{ input, output }`, keyed by model-substring.
 *
 * Longest-substring match wins (same discipline as
 * `external_llm.estimateCostPrecise` — 'gpt-4o-mini' must not be priced as
 * 'gpt-4o'). Unknown models price at $0 (fail-soft undercount, never a throw).
 *
 * Sources (2026-09 published list prices; keep in sync with
 * `external_llm.MODEL_COSTS` — parity-locked by unit test):
 * - OpenAI gpt-4o $2.50/$10, gpt-4o-mini $0.15/$0.60 (openai.com/api/pricing)
 * - Anthropic fable $10/$50, opus $15/$75, sonnet $3/$15, haiku $1/$5
 *   (anthropic.com/pricing)
 * - DeepSeek deepseek-chat $0.27/$1.10 cache-miss (api-docs.deepseek.com)
 * - Workers AI Llama FP8 models: $0 at platform volume (included in Workers
 *   paid plan allotment — mirrors prompts/observability.ts zero-pricing).
 */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  '@cf/meta/llama-3.1-8b-instruct-fp8': { input: 0, output: 0 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0, output: 0 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/**
 * Container build compute, USD per minute.
 *
 * Source: observed Cloudflare Containers burn documented in
 * `workflows/site-generation.ts` ("Cost: ~$0.02/min. At ~25 min/build,
 * ~$0.50/build" — the standard-instance rate the heartbeat comment records).
 * The per-build `recordSpend` estimate in the same file uses a conservative
 * $0.01/min + $1.00 floor for BILLING; metrics use the raw observed rate with
 * NO floor so the baseline reflects real marginal cost, not billing padding.
 */
export const CONTAINER_USD_PER_MINUTE = 0.02;

/** One aggregated model's usage within a build (shape mirrors build_metrics.model_calls JSON). */
export interface ModelCallAgg {
  /** Number of calls attributed to the model. */
  calls: number;
  /** Prompt/input tokens across those calls. */
  tokens_in: number;
  /** Completion/output tokens across those calls. */
  tokens_out: number;
}

/**
 * Price one model's token usage in USD. Longest-substring match so the most
 * specific price row wins; unmatched models return $0.
 *
 * @example
 * ```ts
 * modelCostUsd('gpt-4o-mini', 1_000_000, 0); // → 0.15
 * ```
 */
export function modelCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const key = Object.keys(MODEL_PRICES_PER_MTOK)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return 0;
  const price = MODEL_PRICES_PER_MTOK[key];
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}

/**
 * Price container build time in USD from milliseconds.
 *
 * @example
 * ```ts
 * containerCostUsd(25 * 60_000); // → 0.5  (25 min at $0.02/min)
 * ```
 */
export function containerCostUsd(containerMs: number): number {
  if (!Number.isFinite(containerMs) || containerMs <= 0) return 0;
  return (containerMs / 60_000) * CONTAINER_USD_PER_MINUTE;
}

/**
 * Total estimated build cost: Σ per-model token cost + container minutes.
 * Pure — the single function `finalizeBuildMetrics` uses for `est_cost_usd`.
 *
 * @param modelCalls  - Aggregated per-model usage map.
 * @param containerMs - Container build duration in ms (0 when unknown).
 * @returns USD, rounded to 6 decimal places (micro-USD precision).
 */
export function estimateBuildCostUsd(
  modelCalls: Record<string, ModelCallAgg>,
  containerMs: number,
): number {
  let usd = containerCostUsd(containerMs);
  for (const [model, agg] of Object.entries(modelCalls)) {
    usd += modelCostUsd(model, agg.tokens_in, agg.tokens_out);
  }
  return Math.round(usd * 1_000_000) / 1_000_000;
}
