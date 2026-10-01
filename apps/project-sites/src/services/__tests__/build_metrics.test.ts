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
  CONTAINER_USD_PER_MINUTE,
  modelCostUsd,
  containerCostUsd,
  estimateBuildCostUsd,
} from '../build_pricing.js';
import {
  initBuildMetrics,
  markBuildPhase,
  accumulateBuildModelCall,
  accumulateBuildModelCallFromTrace,
  computePhaseMs,
  finalizeBuildMetrics,
  buildMetricsKey,
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
      expect(modelCostUsd(model, 123_456, 654_321)).toBeCloseTo(
        estimateCostPrecise(model, 123_456, 654_321),
        9,
      );
    }
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
    await accumulateBuildModelCall(env, 's1', { model: 'deepseek-chat', tokensIn: 100, tokensOut: 200 });
    await accumulateBuildModelCall(env, 's1', { model: 'deepseek-chat', tokensIn: 50, tokensOut: 25 });
    const state = JSON.parse(store.get(buildMetricsKey('s1')) as string);
    expect(state.marks.generating).toBe(61_000);
    expect(state.modelCalls['deepseek-chat']).toEqual({ calls: 2, tokens_in: 150, tokens_out: 225 });
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

      await initBuildMetrics(env, { siteId: 's1', buildId: 'wf-1', orgId: 'o1', startedAtMs: 1_000 });
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
      const stored = h.raw
        .prepare('SELECT COUNT(*) AS c FROM build_metrics')
        .get() as { c: number };
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
      const stored = h.raw
        .prepare('SELECT COUNT(*) AS c FROM build_metrics')
        .get() as { c: number };
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
});
