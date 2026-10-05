/**
 * Unit tests for the Resolution Engine dual-provider RESEARCH primitive
 * ({@link libs/features/resolution_engine/service.runDualResearch} — WLK-39
 * S6-a). This is the FIRST backend leg of S6: it fans out TWO independent
 * provider research calls IN PARALLEL through the existing AI Gateway (via
 * {@link services/external_llm.callExternalLLM}) and returns BOTH results for
 * a later Claude synthesis step (S6-b — NOT built here).
 *
 * Directive mapping:
 *   - §12-13 "dual heavy research" → two DISTINCT providers (openai + anthropic).
 *   - invariant #7 "independent" → the two calls never share messages; each gets
 *     the SAME prompt but its own isolated callExternalLLM invocation.
 *   - §24 / §76-D "provider outage" → one leg errors/unconfigured ⇒ return the
 *     OTHER + mark the failed `{provider, ok:false, reason}` (NEVER throw); BOTH
 *     fail ⇒ an honest ResolutionEngineError carrying both reasons (502 at the
 *     route layer S6-b adds). No secrets ever appear in a reason/response.
 *
 * Cases: both-ok (two legs, ran in parallel) · one-down (fallback) · both-down
 * (honest aggregate error) · flag-off (disabled → ResolutionEngineDisabledError).
 *
 * Mocks `callExternalLLM` (the Gateway/provider seam) + `isFlagOn` so no real
 * network or D1 call is ever made.
 */

// @swc/jest hoists jest.mock above the imports ONLY when it sees the GLOBAL
// `jest` identifier — do NOT `import { jest } from '@jest/globals'` (that leaves
// the mock below the import → the real module loads first). See apps/project-sites
// CLAUDE.md gotcha #12.
const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

// Full-factory mock — external_llm pulls retry/analytics/metering/gateway; the
// primitive only needs callExternalLLM, so never load the real module here.
const mockCallExternalLLM = jest.fn();
jest.mock('../../../../src/services/external_llm.js', () => ({
  callExternalLLM: (...a: unknown[]) => mockCallExternalLLM(...a),
}));

import type { Env } from '../../../../src/types/env.js';
import {
  runDualResearch,
  ResolutionEngineDisabledError,
  ResolutionEngineError,
  RESOLUTION_ENGINE_FLAG,
} from '../service.js';

/** A fully-configured env (both provider keys present). */
const keyEnv = (overrides: Partial<Env> = {}): Env =>
  ({ OPENAI_API_KEY: 'sk-test-openai', ANTHROPIC_API_KEY: 'sk-test-anthropic', ...overrides }) as unknown as Env;

/** Build a realistic callExternalLLM result for a given provider. */
function llmResult(provider: 'openai' | 'anthropic', output: string) {
  return {
    output,
    model_used: provider === 'openai' ? 'gpt-4o-2024-11-20' : 'claude-fable-5',
    provider,
    latency_ms: 42,
    token_count: 150,
    input_tokens: 100,
    output_tokens: 50,
    cost_estimate: 0.001,
  };
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockCallExternalLLM.mockReset();
  // Default: flag ON (the disabled path has its own test).
  mockIsFlagOn.mockResolvedValue(true);
});

describe('runDualResearch — flag gate', () => {
  it('exports the canonical flag key', () => {
    expect(RESOLUTION_ENGINE_FLAG).toBe('resolution_engine');
  });

  it('throws ResolutionEngineDisabledError when the flag is OFF (never calls a provider)', async () => {
    mockIsFlagOn.mockResolvedValue(false);

    await expect(runDualResearch(keyEnv(), { prompt: 'research acme co' })).rejects.toBeInstanceOf(
      ResolutionEngineDisabledError,
    );
    // No provider call must fire when dark.
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('checks the resolution_engine flag', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) =>
      llmResult(opts.provider as 'openai' | 'anthropic', 'ok'),
    );
    await runDualResearch(keyEnv(), { prompt: 'p' });
    expect(mockIsFlagOn).toHaveBeenCalledWith(expect.anything(), 'resolution_engine', expect.anything());
  });
});

describe('runDualResearch — both legs succeed', () => {
  it('returns BOTH results, each with provider+model+content provenance', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) =>
      llmResult(opts.provider as 'openai' | 'anthropic', `findings from ${opts.provider}`),
    );

    const res = await runDualResearch(keyEnv(), { prompt: 'research acme co' });

    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(2);

    const openai = res.legs.find((l) => l.provider === 'openai');
    const anthropic = res.legs.find((l) => l.provider === 'anthropic');

    expect(openai).toMatchObject({
      provider: 'openai',
      ok: true,
      model: 'gpt-4o-2024-11-20',
      content: 'findings from openai',
    });
    expect(anthropic).toMatchObject({
      provider: 'anthropic',
      ok: true,
      model: 'claude-fable-5',
      content: 'findings from anthropic',
    });
  });

  it('selects TWO DISTINCT providers (openai + anthropic by default)', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) =>
      llmResult(opts.provider as 'openai' | 'anthropic', 'ok'),
    );

    await runDualResearch(keyEnv(), { prompt: 'p' });

    const providersCalled = mockCallExternalLLM.mock.calls.map((c) => (c[1] as { provider: string }).provider);
    expect(new Set(providersCalled)).toEqual(new Set(['openai', 'anthropic']));
    expect(providersCalled).toHaveLength(2);
  });

  it('runs the two legs IN PARALLEL (second starts before first resolves)', async () => {
    let firstResolve!: () => void;
    const firstStarted = { openai: false, anthropic: false };
    let concurrentAtSecondStart = false;

    mockCallExternalLLM.mockImplementation((_env, opts: { provider: 'openai' | 'anthropic' }) => {
      firstStarted[opts.provider] = true;
      if (opts.provider === 'openai') {
        // Gate openai until we observe anthropic has ALSO started — proves overlap.
        return new Promise((resolve) => {
          firstResolve = () => resolve(llmResult('openai', 'ok'));
        });
      }
      // anthropic leg: if openai already started and is STILL pending, they overlap.
      concurrentAtSecondStart = firstStarted.openai;
      firstResolve();
      return Promise.resolve(llmResult('anthropic', 'ok'));
    });

    await runDualResearch(keyEnv(), { prompt: 'p' });
    expect(concurrentAtSecondStart).toBe(true);
  });

  it('feeds each leg the SAME prompt but as INDEPENDENT calls (no shared message history — invariant #7)', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) =>
      llmResult(opts.provider as 'openai' | 'anthropic', 'ok'),
    );

    await runDualResearch(keyEnv(), { prompt: 'unique-prompt-xyz' });

    for (const call of mockCallExternalLLM.mock.calls) {
      const opts = call[1] as { user: string; provider: string };
      // Each leg's user prompt carries the input; neither references the other provider's output.
      expect(opts.user).toContain('unique-prompt-xyz');
    }
    // Two separate invocations — not one call with a merged conversation.
    expect(mockCallExternalLLM).toHaveBeenCalledTimes(2);
  });
});

describe('runDualResearch — one leg down (fallback §24/§76-D)', () => {
  it('returns the OTHER leg and marks the failed one {ok:false, reason} — NEVER throws', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) => {
      if (opts.provider === 'anthropic') throw new Error('Anthropic API error 529: overloaded');
      return llmResult('openai', 'openai findings');
    });

    const res = await runDualResearch(keyEnv(), { prompt: 'p' });

    // Overall still "ok" — at least one leg returned (degraded, not failed).
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(2);

    const openai = res.legs.find((l) => l.provider === 'openai');
    const anthropic = res.legs.find((l) => l.provider === 'anthropic');

    expect(openai).toMatchObject({ provider: 'openai', ok: true, content: 'openai findings' });
    expect(anthropic?.ok).toBe(false);
    expect(anthropic?.provider).toBe('anthropic');
    expect(anthropic && 'reason' in anthropic && anthropic.reason).toMatch(/overloaded/);
    // Failed legs carry no content.
    expect(anthropic && 'content' in anthropic ? (anthropic as { content?: string }).content : undefined).toBeUndefined();
  });

  it('marks a leg down when its provider key is unconfigured (does not throw)', async () => {
    // Anthropic key absent → the primitive must not even attempt it, mark it down.
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) =>
      llmResult(opts.provider as 'openai', 'openai findings'),
    );

    const res = await runDualResearch(keyEnv({ ANTHROPIC_API_KEY: undefined }), { prompt: 'p' });

    expect(res.ok).toBe(true);
    const anthropic = res.legs.find((l) => l.provider === 'anthropic');
    expect(anthropic?.ok).toBe(false);
    expect(anthropic && 'reason' in anthropic && anthropic.reason).toMatch(/configured|unavailable|key/i);
    // The unconfigured provider must NEVER be invoked.
    const providersCalled = mockCallExternalLLM.mock.calls.map((c) => (c[1] as { provider: string }).provider);
    expect(providersCalled).not.toContain('anthropic');
  });

  it('never leaks a secret in a failure reason', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) => {
      if (opts.provider === 'anthropic') throw new Error('boom sk-test-anthropic leaked');
      return llmResult('openai', 'ok');
    });

    const res = await runDualResearch(keyEnv(), { prompt: 'p' });
    const anthropic = res.legs.find((l) => l.provider === 'anthropic');
    const reason = (anthropic && 'reason' in anthropic && anthropic.reason) || '';
    expect(reason).not.toContain('sk-test-anthropic');
  });
});

describe('runDualResearch — both legs down (honest 502)', () => {
  it('throws ResolutionEngineError carrying BOTH reasons when every leg fails', async () => {
    mockCallExternalLLM.mockImplementation(async (_env, opts: { provider: string }) => {
      throw new Error(`${opts.provider} down`);
    });

    const err = await runDualResearch(keyEnv(), { prompt: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(ResolutionEngineError);
    const legs = (err as ResolutionEngineError).legs;
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.ok === false)).toBe(true);
    const reasons = legs.map((l) => ('reason' in l ? l.reason : '')).join(' ');
    expect(reasons).toMatch(/openai down/);
    expect(reasons).toMatch(/anthropic down/);
  });

  it('throws ResolutionEngineError when NEITHER provider is configured', async () => {
    const err = await runDualResearch({} as unknown as Env, { prompt: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(ResolutionEngineError);
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});
