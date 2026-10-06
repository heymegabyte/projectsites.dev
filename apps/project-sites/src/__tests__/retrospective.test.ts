/**
 * Tests for retrospective service: skip-when-healthy logic, prompt shape,
 * markdown generation. LLM call is mocked.
 */

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  (globalThis as any).crypto = webcrypto;
}

import {
  shouldGenerate,
  renderRetroPrompt,
  buildRetrospective,
} from '../services/retrospective.js';
import type { Env } from '../types/env.js';
import type { BenchmarkResult } from '../services/benchmark.js';

function mockAnthropicFetch(responseText: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).includes('api.anthropic.com')) {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: responseText }],
          usage: { input_tokens: 200, output_tokens: 300 },
        }),
        { status: 200 },
      );
    }
    throw new Error('unexpected fetch ' + String(input));
  }) as typeof fetch;
}

function mockAnthropicError(): typeof fetch {
  return (async () => new Response('invalid api key', { status: 401 })) as typeof fetch;
}

/**
 * DeepSeek is OpenAI-wire-compatible (`/v1/chat/completions`). This mock asserts the
 * retrospective's `tier:'standard'` call lands on the DeepSeek base URL — the
 * policy-compliant cheap rail (`rules/agent-provider-policy.md` + ADR-0057): the
 * per-build self-improvement reflection is INTERNAL dev work and must NOT bill the
 * Anthropic API. `calledHost` lets the test prove which vendor was hit.
 */
function mockDeepSeekFetch(responseText: string, calledHost: { host: string }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.deepseek.com')) {
      calledHost.host = 'deepseek';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responseText } }],
          usage: { total_tokens: 500, prompt_tokens: 200, completion_tokens: 300 },
        }),
        { status: 200 },
      );
    }
    if (url.includes('api.anthropic.com')) {
      calledHost.host = 'anthropic';
      throw new Error('policy violation: retrospective must not call Anthropic');
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

const baseProgrammatic = {
  imageCount: 12,
  imagesMissingAlt: 0,
  h1Count: 1,
  jsonLdBlocks: 4,
  titleLength: 55,
  metaDescriptionLength: 140,
  hasColorScheme: true,
  internalLinks: 5,
  externalLinks: 2,
  bannedWordHits: [],
  score: 1,
};

function makeResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    siteId: 'site-1',
    slug: 'njsk',
    programmatic: { ...baseProgrammatic, ...(overrides.programmatic || {}) },
    psi: null,
    meanScore: 0.95,
    regressedFromPrevious: false,
    ...overrides,
  };
}

describe('shouldGenerate', () => {
  it('skips healthy build with no regression', () => {
    expect(shouldGenerate(makeResult())).toBe(false);
  });

  it('runs when regression detected', () => {
    expect(shouldGenerate(makeResult({ regressedFromPrevious: true }))).toBe(true);
  });

  it('runs when score below 0.85 threshold', () => {
    expect(shouldGenerate(makeResult({ meanScore: 0.8 }))).toBe(true);
  });
});

describe('renderRetroPrompt', () => {
  it('lists current issues + last 10 builds', () => {
    const result = makeResult({
      meanScore: 0.6,
      programmatic: {
        ...baseProgrammatic,
        score: 0.4,
        h1Count: 3,
        jsonLdBlocks: 1,
        bannedWordHits: ['leverage', 'world-class'],
      },
    });
    const priors = [
      {
        id: '1',
        slug: 'a',
        run_at: '2026-04-29 10:00:00',
        mean_score: 0.9,
        score_programmatic: 0.9,
        score_perf: 0.85,
        score_a11y: 0.95,
        score_seo: 0.9,
        programmatic_findings_json: null,
      },
      {
        id: '2',
        slug: 'b',
        run_at: '2026-04-28 10:00:00',
        mean_score: 0.88,
        score_programmatic: 0.88,
        score_perf: 0.8,
        score_a11y: 0.95,
        score_seo: 0.9,
        programmatic_findings_json: null,
      },
    ];
    const prompt = renderRetroPrompt(result, priors);
    expect(prompt).toContain('njsk');
    expect(prompt).toContain('h1Count=3');
    expect(prompt).toContain('jsonLdBlocks=1');
    expect(prompt).toContain('bannedWords: leverage, world-class');
    expect(prompt).toContain('2026-04-29');
    expect(prompt).toContain('2026-04-28');
  });

  it('handles empty history', () => {
    const prompt = renderRetroPrompt(makeResult({ meanScore: 0.5 }), []);
    expect(prompt).toContain('(no history)');
  });
});

describe('buildRetrospective', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubDb = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
          first: async () => null,
        }),
      }),
    },
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
  } as unknown as Env;

  it('returns generated=false when build is healthy', async () => {
    const env = { DB: {} } as unknown as Env;
    const out = await buildRetrospective({ env, current: makeResult() });
    expect(out.generated).toBe(false);
    expect(out.skipReason).toMatch(/Healthy build/);
  });

  it('generates markdown for regressed build', async () => {
    globalThis.fetch = mockAnthropicFetch(
      '**Trigger:** when X / **Mitigation:** do Y / **Confidence:** 0.85',
    );
    const out = await buildRetrospective({
      env: stubDb,
      current: makeResult({ regressedFromPrevious: true, meanScore: 0.7 }),
    });
    expect(out.generated).toBe(true);
    expect(out.filename).toMatch(/\d{4}-\d{2}-\d{2}-njsk\.md$/);
    expect(out.markdown).toContain('# Retrospective: njsk');
    expect(out.markdown).toContain('Pattern Analysis');
    expect(out.markdown).toContain('Trigger:');
  });

  it('falls back to error stub when LLM fails', async () => {
    globalThis.fetch = mockAnthropicError();
    const out = await buildRetrospective({
      env: stubDb,
      current: makeResult({ regressedFromPrevious: true }),
    });
    expect(out.generated).toBe(true);
    expect(out.markdown).toContain('LLM call failed');
  });

  // Provider-policy regression (#23, rules/agent-provider-policy.md + ADR-0057): the
  // per-build retrospective is INTERNAL dev/research orchestration, so its LLM call must
  // ride the cheap policy-compliant rail (DeepSeek via `tier:'standard'`), NEVER the
  // Anthropic API. With a DeepSeek key present (prod config) + the gateway disabled so the
  // direct vendor URL is used, the call MUST hit api.deepseek.com and MUST NOT hit
  // api.anthropic.com. Guards against anyone re-pinning `provider:'anthropic'`.
  it('routes the standard-tier call to DeepSeek, never Anthropic (provider policy)', async () => {
    const calledHost = { host: '' };
    globalThis.fetch = mockDeepSeekFetch('**Trigger:** when X / **Mitigation:** Y', calledHost);
    const deepseekEnv = {
      DB: stubDb.DB,
      // Prod rail: DeepSeek present. ANTHROPIC_API_KEY also present (it is a Worker
      // product secret) — the standard tier must still pick DeepSeek, proving the key's
      // mere presence can't drag an internal call back onto the Anthropic API.
      DEEPSEEK_API_KEY: 'fake-deepseek-key',
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      // Force the direct vendor base URL (skip the AI Gateway rewrite) so the assertion
      // can read the raw provider host.
      AI_GATEWAY_ENABLED: 'false',
    } as unknown as Env;

    const out = await buildRetrospective({
      env: deepseekEnv,
      current: makeResult({ regressedFromPrevious: true, meanScore: 0.7 }),
    });

    expect(out.generated).toBe(true);
    expect(calledHost.host).toBe('deepseek');
    expect(out.markdown).toContain('Trigger:');
  });
});
