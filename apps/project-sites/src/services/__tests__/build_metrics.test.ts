/**
 * build_metrics + build_pricing unit tests (fire-60 generation speed/cost).
 *
 * Covers: pricing-map math (+ parity lock against external_llm.estimateCostPrecise
 * so the two price tables can never drift silently), phase-ms computation from
 * synthetic marks, replay-safe KV state semantics, and the terminal-row write
 * against REAL SQLite via the d1_sqlite harness (the migration's actual DDL).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MODEL_PRICES_PER_MTOK,
  CONTAINER_ONLY_PRICE_KEYS,
  CONTAINER_USD_PER_MINUTE,
  modelCostUsd,
  containerCostUsd,
  containerLlmCostUsd,
  estimateBuildCostUsd,
} from '../build_pricing.js';
import {
  initBuildMetrics,
  markBuildPhase,
  accumulateBuildModelCall,
  accumulateBuildModelCallFromTrace,
  computePhaseMs,
  finalizeBuildMetrics,
  ingestContainerBuildUsage,
  buildMetricsKey,
  ContainerUsageSchema,
  type BuildMetricsEnv,
} from '../build_metrics.js';
import { estimateCostPrecise } from '../external_llm.js';
import { createD1Sqlite } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

/** Map-backed KV double — enough surface for the metrics state machine. */
function createMockKv(): { kv: Env['CACHE_KV']; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as Env['CACHE_KV'];
  return { kv, store };
}

function envWith(db: unknown, kv: Env['CACHE_KV']): BuildMetricsEnv {
  return { DB: db, CACHE_KV: kv } as unknown as BuildMetricsEnv;
}

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), 'migrations', '0652_build_metrics.sql'),
  'utf8',
);

describe('build_pricing', () => {
  it('prices tokens with longest-substring match (mini never priced as gpt-4o)', () => {
    expect(modelCostUsd('gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15, 6);
    expect(modelCostUsd('gpt-4o', 1_000_000, 0)).toBeCloseTo(2.5, 6);
    expect(modelCostUsd('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(0.27 + 1.1, 6);
  });

  it('prices unknown models at $0 (fail-soft) and Workers AI at $0', () => {
    expect(modelCostUsd('totally-unknown-model', 5_000_000, 5_000_000)).toBe(0);
    expect(modelCostUsd('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 2_000_000, 2_000_000)).toBe(0);
  });

  it('prices container minutes at the documented $0.02/min with no floor', () => {
    expect(CONTAINER_USD_PER_MINUTE).toBe(0.02);
    expect(containerCostUsd(25 * 60_000)).toBeCloseTo(0.5, 6); // ~25-min build ≈ $0.50
    expect(containerCostUsd(0)).toBe(0);
    expect(containerCostUsd(-5)).toBe(0);
  });

  it('estimateBuildCostUsd = Σ model token cost + container cost', () => {
    const usd = estimateBuildCostUsd(
      {
        'deepseek-chat': { calls: 3, tokens_in: 1_000_000, tokens_out: 1_000_000 },
        'gpt-4o': { calls: 1, tokens_in: 100_000, tokens_out: 10_000 },
      },
      25 * 60_000,
    );
    // deepseek 0.27+1.10 · gpt-4o 0.25+0.10 · container 0.50
    expect(usd).toBeCloseTo(1.37 + 0.35 + 0.5, 6);
  });

  it('stays in parity with external_llm.estimateCostPrecise for shared models', () => {
    for (const model of Object.keys(MODEL_PRICES_PER_MTOK)) {
      if (model.startsWith('@cf/')) continue; // Workers AI models live only here
      if (CONTAINER_ONLY_PRICE_KEYS.has(model)) continue; // container-only rows live only here
      expect(modelCostUsd(model, 123_456, 654_321)).toBeCloseTo(
        estimateCostPrecise(model, 123_456, 654_321),
        9,
      );
    }
  });

  it('every CONTAINER_ONLY_PRICE_KEYS entry exists in the price table', () => {
    for (const key of CONTAINER_ONLY_PRICE_KEYS) {
      expect(MODEL_PRICES_PER_MTOK[key]).toBeDefined();
    }
  });
});

describe('containerLlmCostUsd (fire-62 — container Claude Code spend)', () => {
  it('prefers the CLI-reported total_cost_usd when positive (table ignored)', () => {
    const usd = containerLlmCostUsd(1.234567891, {
      'deepseek-chat': { tokens_in: 1_000_000, tokens_out: 1_000_000 },
    });
    expect(usd).toBeCloseTo(1.234568, 6);
  });

  it('falls back to per-model table pricing when total is absent/zero', () => {
    const models = {
      'deepseek-chat': { tokens_in: 1_000_000, tokens_out: 1_000_000 },
      'deepseek-reasoner': { tokens_in: 1_000_000, tokens_out: 0 },
    };
    // deepseek-chat 0.27+1.10 · deepseek-reasoner 0.55 input
    expect(containerLlmCostUsd(null, models)).toBeCloseTo(1.37 + 0.55, 6);
    expect(containerLlmCostUsd(0, models)).toBeCloseTo(1.37 + 0.55, 6);
    expect(containerLlmCostUsd(undefined, models)).toBeCloseTo(1.37 + 0.55, 6);
  });

  it('prices unknown container models at $0 (fail-soft undercount)', () => {
    expect(
      containerLlmCostUsd(null, { 'container:claude-code': { tokens_in: 9e6, tokens_out: 9e6 } }),
    ).toBe(0);
  });
});

describe('ContainerUsageSchema (callback payload contract)', () => {
  it('accepts a full payload and strips unknown keys', () => {
    const parsed = ContainerUsageSchema.safeParse({
      source: 'container_json',
      total_cost_usd: 2.5,
      tokens_in: 100,
      tokens_out: 200,
      cache_read_tokens: 5_000,
      cache_creation_tokens: 300,
      num_turns: 42,
      models: { 'deepseek-chat': { calls: 42, tokens_in: 400, tokens_out: 200 } },
      extraneous: 'dropped',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.models['deepseek-chat'].calls).toBe(42);
      expect('extraneous' in parsed.data).toBe(false);
    }
  });

  it('accepts a minimal payload via defaults', () => {
    const parsed = ContainerUsageSchema.safeParse({ source: 'container_json' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokens_in).toBe(0);
      expect(parsed.data.models).toEqual({});
    }
  });

  it('rejects wrong source, negative and non-integer token counts', () => {
    expect(ContainerUsageSchema.safeParse({ source: 'worker' }).success).toBe(false);
    expect(
      ContainerUsageSchema.safeParse({ source: 'container_json', tokens_in: -1 }).success,
    ).toBe(false);
    expect(
      ContainerUsageSchema.safeParse({ source: 'container_json', tokens_out: 1.5 }).success,
    ).toBe(false);
    expect(ContainerUsageSchema.safeParse('not-an-object').success).toBe(false);
  });
});

describe('ingestContainerBuildUsage (accumulation + idempotency)', () => {
  const USAGE = {
    source: 'container_json',
    total_cost_usd: 3.21,
    tokens_in: 1_000,
    tokens_out: 2_000,
    cache_read_tokens: 50_000,
    cache_creation_tokens: 500,
    num_turns: 7,
    models: { 'deepseek-chat': { calls: 7, tokens_in: 1_500, tokens_out: 2_000 } },
  };

  it('merges container models into state (tagged source) and accumulates cost', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1_000 });
    store.set('job2site:job-9', 's1'); // the SITE_WORKFLOW's jobId→siteId mapping
    await ingestContainerBuildUsage(env, 'job-9', USAGE);
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls['deepseek-chat']).toEqual({
      calls: 7,
      tokens_in: 1_500,
      tokens_out: 2_000,
      source: 'container_json',
    });
    expect(state.containerLlmUsd).toBeCloseTo(3.21, 6);
    expect(state.usageJobIds).toEqual(['job-9']);
  });

  it('is idempotent per jobId (heartbeat re-POSTs no-op) but accumulates across jobIds', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1_000 });
    store.set('job2site:job-a', 's1');
    store.set('job2site:job-b', 's1');
    await ingestContainerBuildUsage(env, 'job-a', USAGE);
    await ingestContainerBuildUsage(env, 'job-a', USAGE); // same terminal heartbeat replayed
    let state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls['deepseek-chat'].calls).toBe(7);
    expect(state.containerLlmUsd).toBeCloseTo(3.21, 6);

    // A retried container step (NEW jobId) genuinely re-spends — accumulate.
    await ingestContainerBuildUsage(env, 'job-b', USAGE);
    state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls['deepseek-chat'].calls).toBe(14);
    expect(state.modelCalls['deepseek-chat'].tokens_in).toBe(3_000);
    expect(state.containerLlmUsd).toBeCloseTo(6.42, 6);
    expect(state.usageJobIds).toEqual(['job-a', 'job-b']);
  });

  it('falls back to a synthetic container:claude-code entry when models is empty', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1_000 });
    await ingestContainerBuildUsage(env, 's1', {
      source: 'container_json',
      total_cost_usd: 0.5,
      tokens_in: 100,
      tokens_out: 40,
      cache_creation_tokens: 25,
      num_turns: 3,
    }); // no job2site row → jobId used as siteId (claim builds)
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls['container:claude-code']).toEqual({
      calls: 3,
      tokens_in: 125, // input + cache_creation (cache reads ride the separate field)
      tokens_out: 40,
      source: 'container_json',
    });
    expect(state.containerLlmUsd).toBeCloseTo(0.5, 6);
  });

  it('never throws: invalid payload / missing state are quiet no-ops', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await expect(ingestContainerBuildUsage(env, 'ghost', USAGE)).resolves.toBeUndefined();
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1 });
    await expect(ingestContainerBuildUsage(env, 's1', { source: 'nope' })).resolves.toBeUndefined();
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls).toEqual({});
    expect(state.containerLlmUsd ?? 0).toBe(0);
  });
});

describe('computePhaseMs', () => {
  it('splits phases at the NEXT recorded mark; last phase runs to end', () => {
    const out = computePhaseMs(
      { collecting: 0, generating: 120_000, publishing: 1_500_000 },
      1_560_000,
    );
    expect(out).toEqual({
      collecting: 120_000, // ends at generating (imaging unrecorded → skipped)
      imaging: 0,
      generating: 1_380_000,
      publishing: 60_000,
    });
  });

  it('attributes everything to the only recorded phase', () => {
    const out = computePhaseMs({ collecting: 1_000 }, 61_000);
    expect(out).toEqual({ collecting: 60_000, imaging: 0, generating: 0, publishing: 0 });
  });

  it('clamps negative spans to 0 and handles empty marks', () => {
    expect(computePhaseMs({ collecting: 5_000 }, 1_000).collecting).toBe(0);
    expect(computePhaseMs({}, 99_999)).toEqual({
      collecting: 0,
      imaging: 0,
      generating: 0,
      publishing: 0,
    });
  });
});

describe('KV state semantics (replay-safe)', () => {
  it('init is first-write-wins per buildId; a new buildId resets state', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', orgId: 'o1', startedAtMs: 1_000 });
    await accumulateBuildModelCall(env, 's1', { model: 'gpt-4o', tokensIn: 10, tokensOut: 20 });

    // Hibernation replay — same instance id: counters survive.
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', orgId: 'o1', startedAtMs: 9_999 });
    let state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.startedAtMs).toBe(1_000);
    expect(state.modelCalls['gpt-4o']).toEqual({ calls: 1, tokens_in: 10, tokens_out: 20 });

    // Fresh build — new instance id: clean slate.
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-2', startedAtMs: 50_000 });
    state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.buildId).toBe('wf-2');
    expect(state.modelCalls).toEqual({});
  });

  it('markBuildPhase is first-write-wins; accumulate merges per model', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1_000 });
    await markBuildPhase(env, 's1', 'generating', 61_000);
    await markBuildPhase(env, 's1', 'generating', 999_999); // replay re-mark — ignored
    await accumulateBuildModelCall(env, 's1', {
      model: 'deepseek-chat',
      tokensIn: 100,
      tokensOut: 200,
    });
    await accumulateBuildModelCall(env, 's1', {
      model: 'deepseek-chat',
      tokensIn: 50,
      tokensOut: 25,
    });
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.marks.generating).toBe(61_000);
    expect(state.modelCalls['deepseek-chat']).toEqual({
      calls: 2,
      tokens_in: 150,
      tokens_out: 225,
    });
  });

  it('accumulate without an in-flight build and zero-token calls are quiet no-ops', async () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    await expect(
      accumulateBuildModelCall(env, 'ghost', { model: 'gpt-4o', tokensIn: 5, tokensOut: 5 }),
    ).resolves.toBeUndefined();
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1 });
    await accumulateBuildModelCall(env, 's1', { model: 'gpt-4o', tokensIn: 0, tokensOut: 0 });
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.modelCalls).toEqual({});
    expect(store.has(buildMetricsKey('ghost'))).toBe(false);
  });

  it('accumulateBuildModelCallFromTrace no-ops without a siteId', () => {
    const { kv, store } = createMockKv();
    const env = envWith({}, kv);
    accumulateBuildModelCallFromTrace(env, undefined, 'gpt-4o', 10, 10);
    accumulateBuildModelCallFromTrace(env, { siteId: undefined }, 'gpt-4o', 10, 10);
    expect(store.size).toBe(0);
  });
});

describe('finalizeBuildMetrics — terminal row against REAL SQLite (migration DDL)', () => {
  it('writes one upserted row; error-then-published overwrites (last outcome wins)', async () => {
    const h = createD1Sqlite();
    const { kv } = createMockKv();
    const env = envWith(h.db, kv);
    try {
      h.exec(MIGRATION_SQL);

      await initBuildMetrics(env, {
        siteId: 's1',
        buildId: 'wf-1',
        orgId: 'o1',
        startedAtMs: 1_000,
      });
      await markBuildPhase(env, 's1', 'generating', 61_000);
      await accumulateBuildModelCall(env, 's1', {
        model: 'deepseek-chat',
        tokensIn: 1_000,
        tokensOut: 2_000,
      });

      // Premature error (e.g. a step retry's first attempt)…
      const errRow = await finalizeBuildMetrics(env, 's1', 'error', { endMs: 100_000 });
      expect(errRow?.outcome).toBe('error');
      expect(errRow?.published_at).toBeNull();

      // …overwritten by the eventual publish.
      await markBuildPhase(env, 's1', 'publishing', 141_000);
      const row = await finalizeBuildMetrics(env, 's1', 'published', {
        containerSeconds: 30,
        endMs: 161_000,
      });
      expect(row).not.toBeNull();
      expect(row?.outcome).toBe('published');
      expect(row?.total_ms).toBe(160_000);
      expect(row?.container_ms).toBe(30_000);
      expect(row?.tokens_in).toBe(1_000);
      expect(row?.tokens_out).toBe(2_000);
      expect(row?.phase_ms).toEqual({
        collecting: 60_000,
        imaging: 0,
        generating: 80_000,
        publishing: 20_000,
      });
      // deepseek (1000·0.27 + 2000·1.10)/1e6 + 30s container at $0.02/min
      expect(row?.est_cost_usd).toBeCloseTo(0.00247 + 0.01, 6);

      // Ground truth: exactly ONE row, outcome published, JSON columns intact.
      const stored = h.raw.prepare('SELECT COUNT(*) AS c FROM build_metrics').get() as {
        c: number;
      };
      expect(stored.c).toBe(1);
      const dbRow = h.raw
        .prepare('SELECT * FROM build_metrics WHERE build_id = ?')
        .get('wf-1') as Record<string, unknown>;
      expect(dbRow.outcome).toBe('published');
      expect(dbRow.site_id).toBe('s1');
      expect(dbRow.org_id).toBe('o1');
      expect(dbRow.published_at).toBe(new Date(161_000).toISOString());
      expect(JSON.parse(dbRow.phase_ms as string).generating).toBe(80_000);
      expect(JSON.parse(dbRow.model_calls as string)['deepseek-chat'].calls).toBe(1);
    } finally {
      h.close();
    }
  });

  it('finalize without in-flight state writes nothing and returns null', async () => {
    const h = createD1Sqlite();
    const { kv } = createMockKv();
    const env = envWith(h.db, kv);
    try {
      h.exec(MIGRATION_SQL);
      const row = await finalizeBuildMetrics(env, 'no-such-site', 'error');
      expect(row).toBeNull();
      const stored = h.raw.prepare('SELECT COUNT(*) AS c FROM build_metrics').get() as {
        c: number;
      };
      expect(stored.c).toBe(0);
    } finally {
      h.close();
    }
  });

  it('never throws when D1 write fails (fail-soft contract)', async () => {
    const { kv } = createMockKv();
    const throwingDb = {
      prepare: () => {
        throw new Error('D1 down');
      },
    };
    const env = envWith(throwingDb, kv);
    await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1 });
    await expect(finalizeBuildMetrics(env, 's1', 'published')).resolves.toBeNull();
  });

  it('folds ingested container usage into tokens, model_calls (tagged) and est_cost_usd', async () => {
    const h = createD1Sqlite();
    const { kv, store } = createMockKv();
    const env = envWith(h.db, kv);
    try {
      h.exec(MIGRATION_SQL);
      await initBuildMetrics(env, {
        siteId: 's1',
        buildId: 'wf-1',
        orgId: 'o1',
        startedAtMs: 1_000,
      });
      // Worker-side LLM call (accumulated as before)…
      await accumulateBuildModelCall(env, 's1', {
        model: 'gpt-4o',
        tokensIn: 100_000,
        tokensOut: 10_000,
      });
      // …plus the container orchestrator's Claude Code spend via the callback.
      store.set('job2site:job-1', 's1');
      await ingestContainerBuildUsage(env, 'job-1', {
        source: 'container_json',
        total_cost_usd: 4.2,
        tokens_in: 900_000,
        tokens_out: 120_000,
        cache_read_tokens: 2_000_000,
        cache_creation_tokens: 100_000,
        num_turns: 33,
        models: { 'deepseek-chat': { calls: 33, tokens_in: 1_000_000, tokens_out: 120_000 } },
      });

      const row = await finalizeBuildMetrics(env, 's1', 'published', {
        containerSeconds: 600, // 10 min container
        endMs: 1_000_000,
      });
      expect(row).not.toBeNull();
      // Totals now include the container's model spend (gp-09 closed).
      expect(row?.tokens_in).toBe(100_000 + 1_000_000);
      expect(row?.tokens_out).toBe(10_000 + 120_000);
      expect(row?.model_calls['deepseek-chat']).toEqual({
        calls: 33,
        tokens_in: 1_000_000,
        tokens_out: 120_000,
        source: 'container_json',
      });
      // est = worker gpt-4o (0.25 + 0.10) + container minutes (10·$0.02) + CLI total 4.2.
      expect(row?.est_cost_usd).toBeCloseTo(0.35 + 0.2 + 4.2, 6);

      // The container-sourced entry is NOT re-priced through the token table
      // (that would double-count against total_cost_usd) — and the D1 JSON
      // carries the provenance tag for usage_source derivation.
      const dbRow = h.raw
        .prepare('SELECT model_calls FROM build_metrics WHERE build_id = ?')
        .get('wf-1') as { model_calls: string };
      expect(JSON.parse(dbRow.model_calls)['deepseek-chat'].source).toBe('container_json');
    } finally {
      h.close();
    }
  });

  it('fallback honesty: no ingested usage (old image) keeps 0s and no container tags', async () => {
    const h = createD1Sqlite();
    const { kv } = createMockKv();
    const env = envWith(h.db, kv);
    try {
      h.exec(MIGRATION_SQL);
      await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', startedAtMs: 1_000 });
      const row = await finalizeBuildMetrics(env, 's1', 'published', {
        containerSeconds: 600,
        endMs: 1_000_000,
      });
      expect(row?.tokens_in).toBe(0);
      expect(row?.tokens_out).toBe(0);
      expect(Object.values(row?.model_calls ?? {}).some((a) => a.source === 'container_json')).toBe(
        false,
      );
      expect(row?.est_cost_usd).toBeCloseTo(0.2, 6); // container minutes only
    } finally {
      h.close();
    }
  });
});
