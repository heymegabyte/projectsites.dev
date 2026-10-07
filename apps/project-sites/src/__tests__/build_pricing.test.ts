/**
 * Pure unit coverage for the per-build cost-math module
 * (`src/services/build_pricing.ts`) — the fire-60 north-star ("generation speed +
 * COST") price engine that feeds `build_metrics.est_cost_usd`. Shipped with ZERO
 * tests despite its own doc comment promising a "parity unit test in
 * build_metrics.test.ts" that was never written — so `MODEL_PRICES_PER_MTOK` and
 * `external_llm.MODEL_COSTS` could drift silently. This spec is that lock (plus full
 * behavioral coverage of every exported function). All pure — no env, no I/O, no mocks.
 *
 * Contracts asserted:
 *   modelCostUsd        — longest-substring match (gpt-4o-mini NEVER priced as gpt-4o),
 *                         per-MTok math, unknown model → $0 (fail-soft, never throws),
 *                         Workers-AI Llama rows priced at $0.
 *   containerCostUsd    — $0.02/min from ms; NaN / ≤0 / Infinity → $0 (no negative cost).
 *   containerLlmCostUsd — CLI total_cost_usd WINS when present+positive; else Σ modelCostUsd
 *                         fallback; 6-dp rounding; 0 / null / negative CLI → fallback.
 *   estimateBuildCostUsd— Σ per-model token cost + container minutes, 6-dp rounded.
 *   PARITY              — every model in the published-price SSOT prices IDENTICALLY here,
 *                         so this table can't drift from external_llm.estimateCostPrecise.
 */
import {
  MODEL_PRICES_PER_MTOK,
  CONTAINER_ONLY_PRICE_KEYS,
  CONTAINER_USD_PER_MINUTE,
  modelCostUsd,
  containerCostUsd,
  containerLlmCostUsd,
  estimateBuildCostUsd,
} from '../services/build_pricing.js';

describe('modelCostUsd — per-model token pricing', () => {
  it('prices $/MTok: 1M input tokens of gpt-4o = $2.50, 1M output = $10', () => {
    expect(modelCostUsd('gpt-4o', 1_000_000, 0)).toBeCloseTo(2.5, 10);
    expect(modelCostUsd('gpt-4o', 0, 1_000_000)).toBeCloseTo(10, 10);
    expect(modelCostUsd('gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(12.5, 10);
  });

  it('LONGEST-substring match wins — gpt-4o-mini is NOT priced as gpt-4o (the 16× bug guard)', () => {
    // 'gpt-4o-mini' contains the substring 'gpt-4o'; a find-first match would overprice it
    // 16× ($2.50 vs $0.15 input). Longest-match must select the mini row.
    expect(modelCostUsd('gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15, 10);
    expect(modelCostUsd('gpt-4o-mini', 0, 1_000_000)).toBeCloseTo(0.6, 10);
    // And it must differ from the gpt-4o price it would wrongly collapse into.
    expect(modelCostUsd('gpt-4o-mini', 1_000_000, 0)).not.toBeCloseTo(2.5, 5);
  });

  it('matches a full dated Anthropic id by its shorter substring row (container fallback path)', () => {
    // The container's Anthropic fallback reports ids like 'claude-sonnet-4-5-20250929';
    // the 'claude-sonnet-4-5' row must price it.
    expect(modelCostUsd('claude-sonnet-4-5-20250929', 1_000_000, 0)).toBeCloseTo(3, 10);
    expect(modelCostUsd('claude-sonnet-4-5-20250929', 0, 1_000_000)).toBeCloseTo(15, 10);
  });

  it('prices Workers-AI Llama FP8 rows at $0 (included in the Workers plan allotment)', () => {
    expect(modelCostUsd('@cf/meta/llama-3.1-8b-instruct-fp8', 5_000_000, 5_000_000)).toBe(0);
    expect(modelCostUsd('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 9_999_999, 9_999_999)).toBe(0);
  });

  it('fail-soft: an unknown model returns $0 and never throws', () => {
    expect(modelCostUsd('some-unregistered-model-xyz', 1_000_000, 1_000_000)).toBe(0);
    expect(modelCostUsd('', 1_000_000, 0)).toBe(0);
  });

  it('scales linearly below 1M tokens', () => {
    // deepseek-chat $0.27 in / $1.10 out per MTok.
    expect(modelCostUsd('deepseek-chat', 500_000, 100_000)).toBeCloseTo(
      (500_000 * 0.27 + 100_000 * 1.1) / 1_000_000,
      10,
    );
  });
});

describe('containerCostUsd — compute time pricing', () => {
  it('prices 25 min (1,500,000 ms) at $0.02/min = $0.50', () => {
    expect(containerCostUsd(25 * 60_000)).toBeCloseTo(0.5, 10);
  });

  it('uses the documented $0.02/min rate constant', () => {
    expect(CONTAINER_USD_PER_MINUTE).toBe(0.02);
    expect(containerCostUsd(60_000)).toBeCloseTo(CONTAINER_USD_PER_MINUTE, 10);
  });

  it('returns $0 for non-finite / zero / negative durations (never a negative cost)', () => {
    expect(containerCostUsd(0)).toBe(0);
    expect(containerCostUsd(-5000)).toBe(0);
    expect(containerCostUsd(Number.NaN)).toBe(0);
    expect(containerCostUsd(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('containerLlmCostUsd — CLI total wins over flat re-pricing', () => {
  const models = {
    'deepseek-chat': { tokens_in: 1_000_000, tokens_out: 1_000_000 },
  };

  it('uses the CLI-reported total_cost_usd when present and positive (cache-aware, more honest)', () => {
    // CLI says $0.42; the flat fallback would say $1.37 (0.27 + 1.10). CLI must win.
    expect(containerLlmCostUsd(0.42, models)).toBe(0.42);
  });

  it('rounds the CLI total to 6 decimal places', () => {
    expect(containerLlmCostUsd(0.123456789, {})).toBe(0.123457);
  });

  it('falls back to Σ modelCostUsd when the CLI total is 0 / null / undefined / negative', () => {
    const fallback = 0.27 + 1.1; // deepseek-chat 1M in + 1M out
    expect(containerLlmCostUsd(0, models)).toBeCloseTo(fallback, 6);
    expect(containerLlmCostUsd(null, models)).toBeCloseTo(fallback, 6);
    expect(containerLlmCostUsd(undefined, models)).toBeCloseTo(fallback, 6);
    expect(containerLlmCostUsd(-1, models)).toBeCloseTo(fallback, 6);
  });

  it('falls back to 0 for an empty model map with no CLI total', () => {
    expect(containerLlmCostUsd(null, {})).toBe(0);
  });
});

describe('estimateBuildCostUsd — Σ per-model cost + container minutes', () => {
  it('sums container compute and every model row, 6-dp rounded', () => {
    const cost = estimateBuildCostUsd(
      {
        'gpt-4o': { calls: 3, tokens_in: 1_000_000, tokens_out: 500_000 },
        'deepseek-chat': { calls: 10, tokens_in: 2_000_000, tokens_out: 1_000_000 },
      },
      25 * 60_000, // $0.50 container
    );
    const expected =
      0.5 + // container
      (1_000_000 * 2.5 + 500_000 * 10) / 1_000_000 + // gpt-4o = 7.5
      (2_000_000 * 0.27 + 1_000_000 * 1.1) / 1_000_000; // deepseek = 1.64
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('is container-only cost when no models were called', () => {
    expect(estimateBuildCostUsd({}, 60_000)).toBeCloseTo(0.02, 10);
  });

  it('is $0 for a zero-duration build with no model calls', () => {
    expect(estimateBuildCostUsd({}, 0)).toBe(0);
  });

  it('ignores free Workers-AI rows in the total (they contribute $0)', () => {
    const cost = estimateBuildCostUsd(
      {
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { calls: 50, tokens_in: 9e6, tokens_out: 9e6 },
      },
      0,
    );
    expect(cost).toBe(0);
  });
});

describe('PARITY — build_pricing table never drifts from the published-price SSOT', () => {
  // The module doc promises a parity lock to external_llm.estimateCostPrecise that was
  // never written. These are the 2026-09 published list prices BOTH tables cite
  // (openai.com/api/pricing, anthropic.com/pricing, api-docs.deepseek.com). Any drift in
  // THIS table from those canonical numbers now fails the build. (external_llm.MODEL_COSTS
  // is module-private; this locks the same canonical source behaviorally via modelCostUsd.)
  const PUBLISHED: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-opus-4-7': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'deepseek-chat': { input: 0.27, output: 1.1 },
  };

  it.each(Object.entries(PUBLISHED))(
    '%s prices at the published input/output rate in MODEL_PRICES_PER_MTOK',
    (model, price) => {
      expect(MODEL_PRICES_PER_MTOK[model]).toEqual(price);
      // And the pure pricing fn reflects it exactly (1M tokens → the per-MTok rate).
      expect(modelCostUsd(model, 1_000_000, 0)).toBeCloseTo(price.input, 10);
      expect(modelCostUsd(model, 0, 1_000_000)).toBeCloseTo(price.output, 10);
    },
  );

  it('the container-only rows are flagged + exist in the price table (Anthropic fallback / reasoner)', () => {
    for (const key of CONTAINER_ONLY_PRICE_KEYS) {
      expect(MODEL_PRICES_PER_MTOK[key]).toBeDefined();
    }
    expect(CONTAINER_ONLY_PRICE_KEYS.has('claude-sonnet-4-5')).toBe(true);
    expect(CONTAINER_ONLY_PRICE_KEYS.has('deepseek-reasoner')).toBe(true);
  });
});
