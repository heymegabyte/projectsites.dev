/**
 * Unit coverage for services/external_llm.ts (convergence r16).
 *
 * Covers provider/model routing, per-provider request build + auth headers,
 * success parsing + token/usage/cache/citation capture, unconfigured-key
 * handling, non-200 + network-throw + fallback, and prompt/param passthrough.
 *
 * Dependencies are mocked so the suite is hermetic + fast:
 * - `./ai_gateway.js` `gatewayFetch` → the single network seam every provider
 *   call goes through (we assert URL suffix + headers on the wire).
 * - `./retry.js` `withRetry` → passthrough (no real backoff timers); the real
 *   `classifyError` is preserved so error-category mapping is genuinely tested.
 * - `./analytics.js` `captureLLMCall` → spy (assert telemetry status/fields).
 */

import type { Env } from '../types/env.js';

// ── Module mocks (declared before importing the SUT) ───────────────────────────
jest.mock('../services/ai_gateway.js', () => {
  const actual = jest.requireActual('../services/ai_gateway.js');
  return {
    ...actual,
    gatewayFetch: jest.fn(),
    gatewayMetadata: jest.fn(() => ({})),
  };
});

jest.mock('../services/retry.js', () => {
  const actual = jest.requireActual('../services/retry.js');
  return {
    ...actual,
    // Passthrough — invoke the fn once, surface its rejection, no backoff sleep.
    withRetry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

jest.mock('../services/analytics.js', () => ({
  captureLLMCall: jest.fn(async () => undefined),
}));

import { gatewayFetch } from '../services/ai_gateway.js';
import { captureLLMCall } from '../services/analytics.js';
import type * as ExternalLLM from '../services/external_llm.js';

const mockGatewayFetch = gatewayFetch as unknown as jest.Mock;
const mockCaptureLLM = captureLLMCall as unknown as jest.Mock;

// The SUT keeps a MODULE-LEVEL circuit-breaker state object. To keep each test
// hermetic (a prior error-path test must not leave a provider's circuit open),
// re-require the module fresh per test via jest.resetModules(). The jest.mock
// factories above survive resetModules, so the mocked deps stay wired.
let sut: typeof ExternalLLM;
function loadSut(): typeof ExternalLLM {
  let mod!: typeof ExternalLLM;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../services/external_llm.js') as typeof ExternalLLM;
  });
  return mod;
}
const callExternalLLM: typeof ExternalLLM.callExternalLLM = (...a) => sut.callExternalLLM(...a);
const callExternalLLMWithVision: typeof ExternalLLM.callExternalLLMWithVision = (...a) =>
  sut.callExternalLLMWithVision(...a);
const aiGatewayUrl: typeof ExternalLLM.aiGatewayUrl = (...a) => sut.aiGatewayUrl(...a);
const uploadDocToOpenAI: typeof ExternalLLM.uploadDocToOpenAI = (...a) =>
  sut.uploadDocToOpenAI(...a);

const ACCT = '84fa0d1b16ff8086dd958c468ce7fd59';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    OPENAI_API_KEY: 'sk-openai-test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CF_ACCOUNT_ID: ACCT,
    AI_GATEWAY_ENABLED: 'false',
    ENVIRONMENT: 'test',
    ...overrides,
  } as unknown as Env;
}

/** Build an `[Response, gatewayUsed]` tuple result for the mocked gatewayFetch. */
function gwOk(bodyObj: unknown, gatewayUsed = false): { response: Response; gatewayUsed: boolean } {
  return {
    response: new Response(JSON.stringify(bodyObj), { status: 200 }),
    gatewayUsed,
  };
}

function gwErr(
  status: number,
  body = 'boom',
  gatewayUsed = false,
): { response: Response; gatewayUsed: boolean } {
  return { response: new Response(body, { status }), gatewayUsed };
}

/** Canonical OpenAI chat-completions success body. */
function openAIBody(content = 'openai-says-hi') {
  return {
    choices: [{ message: { content } }],
    usage: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
  };
}

/** Canonical Anthropic messages success body. */
function anthropicBody(text = 'claude-says-hi', extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 200, output_tokens: 80, ...(extra ?? {}) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Fresh SUT instance → fresh circuit-breaker state, no cross-test bleed.
  sut = loadSut();
});

// ─── chooseProvider / routing (via callExternalLLM) ────────────────────────────

describe('provider routing', () => {
  it('uses OpenAI as primary by default (auto)', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u' });
    expect(res.provider).toBe('openai');
    expect(mockGatewayFetch).toHaveBeenCalledTimes(1);
    expect(mockGatewayFetch.mock.calls[0][1]).toBe('openai');
    expect(mockGatewayFetch.mock.calls[0][2]).toBe('/v1/chat/completions');
  });

  it('honors explicit provider=anthropic', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'anthropic' });
    expect(res.provider).toBe('anthropic');
    expect(mockGatewayFetch.mock.calls[0][1]).toBe('anthropic');
    expect(mockGatewayFetch.mock.calls[0][2]).toBe('/v1/messages');
  });

  it('honors explicit provider=openai', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'openai' });
    expect(res.provider).toBe('openai');
  });

  it('routes provider=deepseek to the DeepSeek base URL + key, NOT OpenAI (regression)', async () => {
    // Bug: callOpenAI hardcoded provider='openai' into gatewayFetch, so a DeepSeek
    // call POSTed the DeepSeek key to OpenAI's URL → 401 → silent fallback to
    // premium OpenAI (the whole cost-tier was dead). gatewayFetch resolves the base
    // URL from its provider arg, so that arg MUST be 'deepseek'.
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody('ds-hi')));
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-ds-test' });
    const res = await callExternalLLM(env, { system: 's', user: 'u', provider: 'deepseek' });
    expect(res.provider).toBe('deepseek');
    expect(mockGatewayFetch.mock.calls[0][1]).toBe('deepseek'); // → api.deepseek.com
    expect(mockGatewayFetch.mock.calls[0][2]).toBe('/v1/chat/completions'); // OpenAI-wire-compatible
    const init = mockGatewayFetch.mock.calls[0][3] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ds-test');
  });

  it('the standard tier resolves to DeepSeek and routes there when DEEPSEEK_API_KEY is set', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody('ds-hi')));
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-ds-test' });
    const res = await callExternalLLM(env, { system: 's', user: 'u', tier: 'standard' });
    expect(res.provider).toBe('deepseek');
    expect(mockGatewayFetch.mock.calls[0][1]).toBe('deepseek');
  });

  it('falls back to anthropic when only ANTHROPIC_API_KEY is set', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    const env = makeEnv({ OPENAI_API_KEY: undefined });
    const res = await callExternalLLM(env, { system: 's', user: 'u' });
    expect(res.provider).toBe('anthropic');
  });

  it('uses the default model per provider when none supplied', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u' });
    expect(res.model_used).toBe('gpt-4o-2024-11-20');
  });

  it('uses a caller model override', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', model: 'gpt-4o-mini' });
    expect(res.model_used).toBe('gpt-4o-mini');
  });

  it('falls back to the OpenAI DEFAULT model, NOT the caller cross-vendor model, when the primary is unavailable', async () => {
    // Regression: provider:'anthropic' + a claude model, but ANTHROPIC_API_KEY absent
    // → the loop skips anthropic and falls to OpenAI. The OpenAI request MUST carry
    // the OpenAI default model, never the caller's `claude-*` (OpenAI 404s it — the
    // auto-pilot preview + cron 502'd "model `claude-sonnet-4-6` does not exist").
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    const env = makeEnv({ ANTHROPIC_API_KEY: undefined });
    const res = await callExternalLLM(env, {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(res.provider).toBe('openai');
    expect(res.model_used).toBe('gpt-4o-2024-11-20');
    // OpenAI fallback must NOT receive the claude model (Jest expect takes 1 arg).
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o-2024-11-20');
  });
});

// ─── OpenAI request build + auth header + param passthrough ────────────────────

describe('OpenAI request build', () => {
  it('sends Bearer auth + system/user messages + temperature + max_completion_tokens', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), {
      system: 'sys-prompt',
      user: 'user-prompt',
      temperature: 0.7,
      maxTokens: 4096,
      provider: 'openai',
    });
    const init = mockGatewayFetch.mock.calls[0][3] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-test');
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'user-prompt' },
    ]);
    expect(body.temperature).toBe(0.7);
    expect(body.max_completion_tokens).toBe(4096);
  });

  it('defaults temperature to 0.3 and max_completion_tokens to 8192', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'openai' });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.temperature).toBe(0.3);
    expect(body.max_completion_tokens).toBe(8192);
  });

  it('sets response_format json_schema when jsonSchema is supplied', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      jsonSchema: { name: 'plan', schema: { type: 'object' } },
    });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('plan');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('sets response_format json_object when jsonMode is set without jsonSchema', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      jsonMode: true,
    });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('parses content + total/input/output tokens from the OpenAI response', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody('hello world')));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'openai' });
    expect(res.output).toBe('hello world');
    expect(res.token_count).toBe(150);
    // gpt-4o-2024-11-20 includes 'gpt-4o' cost key → 100*2.5 + 50*10 per 1M.
    expect(res.cost_estimate).toBeCloseTo((100 * 2.5 + 50 * 10) / 1_000_000, 10);
  });

  it('returns empty output when OpenAI choices are missing', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk({ choices: [], usage: { total_tokens: 0 } }));
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'openai' });
    expect(res.output).toBe('');
  });
});

// ─── Anthropic request build + headers + caching + structured outputs ──────────

describe('Anthropic request build', () => {
  it('sends x-api-key + anthropic-version headers + plain string system for short prompts', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    await callExternalLLM(makeEnv(), { system: 'short', user: 'u', provider: 'anthropic' });
    const init = mockGatewayFetch.mock.calls[0][3] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('short');
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
  });

  it('wraps a long system prompt in cache_control ephemeral blocks', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    const longSystem = 'x'.repeat(1025);
    await callExternalLLM(makeEnv(), { system: longSystem, user: 'u', provider: 'anthropic' });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toBe(longSystem);
  });

  it('attaches output_schema + structured-outputs beta header when responseSchema is set', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      responseSchema: { type: 'object' },
    });
    const init = mockGatewayFetch.mock.calls[0][3] as RequestInit;
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe(
      'structured-outputs-2025-11-13',
    );
    const body = JSON.parse(init.body as string);
    expect(body.output_schema).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('joins multiple text blocks and reports input+output token sum', async () => {
    mockGatewayFetch.mockResolvedValueOnce(
      gwOk({
        content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }],
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    );
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'anthropic' });
    expect(res.output).toBe('ab');
    expect(res.token_count).toBe(280);
  });

  it('reports cache_hit=true when cache_read_input_tokens > 0', async () => {
    mockGatewayFetch.mockResolvedValueOnce(
      gwOk(anthropicBody('hi', { cache_read_input_tokens: 50 })),
    );
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'anthropic' });
    expect(res.cache_hit).toBe(true);
  });

  it('builds document blocks + citations when documents are supplied', async () => {
    mockGatewayFetch.mockResolvedValueOnce(
      gwOk({
        content: [
          {
            type: 'text',
            text: 'grounded',
            citations: [
              {
                type: 'char_location',
                document_index: 0,
                document_title: 'Doc A',
                cited_text: 'quote',
                start_char_index: 1,
                end_char_index: 6,
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const res = await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      documents: [{ title: 'Doc A', kind: 'text', data: 'source text' }],
    });
    // Request body carries a document content block with citations enabled.
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    const firstMsg = body.messages[0];
    expect(firstMsg.content[0].type).toBe('document');
    expect(firstMsg.content[0].citations).toEqual({ enabled: true });
    expect(firstMsg.content[0].source).toEqual({
      type: 'text',
      media_type: 'text/plain',
      data: 'source text',
    });
    // Response surfaces the parsed citation on the result.
    expect(res.citations).toHaveLength(1);
    expect(res.citations![0]).toMatchObject({
      documentIndex: 0,
      documentTitle: 'Doc A',
      citedText: 'quote',
      startCharIndex: 1,
      endCharIndex: 6,
    });
  });

  it('uses base64/pdf source for pdf documents', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      documents: [{ kind: 'pdf', data: 'YmFzZTY0' }],
    });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.messages[0].content[0].source).toEqual({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'YmFzZTY0',
    });
  });

  it('does NOT build document blocks when responseSchema is also set (mutually exclusive)', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      responseSchema: { type: 'object' },
      documents: [{ kind: 'text', data: 'x' }],
    });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
  });
});

// ─── Unconfigured-key handling ─────────────────────────────────────────────────

describe('unconfigured keys', () => {
  it('throws when neither provider key is set', async () => {
    const env = makeEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
    await expect(callExternalLLM(env, { system: 's', user: 'u' })).rejects.toThrow(
      /No usable LLM provider/,
    );
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });
});

// ─── Error + fallback paths ────────────────────────────────────────────────────

describe('error + fallback', () => {
  it('throws the fallback vendor API error text when BOTH providers fail', async () => {
    // primary=openai fails (no rethrow), fallback=anthropic fails → its error rethrows.
    mockGatewayFetch
      .mockResolvedValueOnce(gwErr(500, 'openai down'))
      .mockResolvedValueOnce(gwErr(429, 'rate limited'));
    await expect(callExternalLLM(makeEnv(), { system: 's', user: 'u' })).rejects.toThrow(
      /Anthropic API error 429/,
    );
    expect(mockGatewayFetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts both providers to "No usable LLM provider" when primary fails and fallback has no key', async () => {
    // provider=openai → primary=openai (fails), fallback=anthropic (no key → skip),
    // loop ends without a rethrow because openai !== fallback.
    mockGatewayFetch.mockResolvedValueOnce(gwErr(500, 'openai down'));
    const env = makeEnv({ ANTHROPIC_API_KEY: undefined });
    await expect(
      callExternalLLM(env, { system: 's', user: 'u', provider: 'openai' }),
    ).rejects.toThrow(/No usable LLM provider/);
  });

  it('falls back from a failing OpenAI to Anthropic and returns the Anthropic result', async () => {
    mockGatewayFetch
      .mockResolvedValueOnce(gwErr(500, 'openai down')) // primary openai fails
      .mockResolvedValueOnce(gwOk(anthropicBody('fallback-ok'))); // fallback anthropic ok
    const res = await callExternalLLM(makeEnv(), { system: 's', user: 'u' });
    expect(res.provider).toBe('anthropic');
    expect(res.output).toBe('fallback-ok');
    expect(mockGatewayFetch).toHaveBeenCalledTimes(2);
  });

  it('rethrows the fallback network throw after both providers fail', async () => {
    // primary openai throws (no rethrow), fallback anthropic throws → rethrows.
    mockGatewayFetch
      .mockRejectedValueOnce(new Error('openai net'))
      .mockRejectedValueOnce(new Error('network boom'));
    await expect(callExternalLLM(makeEnv(), { system: 's', user: 'u' })).rejects.toThrow(
      /network boom/,
    );
  });

  it('captures an error telemetry status when a provider fails', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwErr(500, 'down'));
    // openai-only path → its failure still emits an 'error' status capture before
    // the loop ends (the rethrow happens only on the fallback slot, but telemetry
    // fires per-attempt).
    const env = makeEnv({ ANTHROPIC_API_KEY: undefined });
    await expect(
      callExternalLLM(env, { system: 's', user: 'u', provider: 'openai' }),
    ).rejects.toThrow(/No usable LLM provider/);
    const statuses = mockCaptureLLM.mock.calls.map((c) => c[1].status);
    expect(statuses).toContain('error');
  });
});

// ─── Telemetry capture on success ──────────────────────────────────────────────

describe('telemetry capture', () => {
  it('captures an ok status with token + trace fields on success', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      traceContext: { orgId: 'o_1', userId: 'u_2', traceId: 't_3', promptId: 'research_brand' },
    });
    const okCall = mockCaptureLLM.mock.calls.find((c) => c[1].status === 'ok');
    expect(okCall).toBeDefined();
    expect(okCall![1].distinctId).toBe('o_1'); // orgId preferred
    expect(okCall![1].traceId).toBe('t_3');
    expect(okCall![1].promptId).toBe('research_brand');
    expect(okCall![1].inputTokens).toBe(100);
    expect(okCall![1].outputTokens).toBe(50);
  });

  it('falls back to userId then system for distinctId', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      traceContext: { userId: 'u_only' },
    });
    const okCall = mockCaptureLLM.mock.calls.find((c) => c[1].status === 'ok');
    expect(okCall![1].distinctId).toBe('u_only');
  });

  it('uses "system" distinctId when no trace context is provided', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLM(makeEnv(), { system: 's', user: 'u', provider: 'openai' });
    const okCall = mockCaptureLLM.mock.calls.find((c) => c[1].status === 'ok');
    expect(okCall![1].distinctId).toBe('system');
  });
});

// ─── Vision calls ──────────────────────────────────────────────────────────────

describe('callExternalLLMWithVision', () => {
  it('delegates to the plain text call when no image is provided', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody('text-only')));
    const res = await callExternalLLMWithVision(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
    });
    expect(res.output).toBe('text-only');
    // No image → behaves identically to callExternalLLM (chat completions).
    expect(mockGatewayFetch.mock.calls[0][2]).toBe('/v1/chat/completions');
  });

  it('builds an OpenAI image_url message from imageUrl', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody('saw-image')));
    const res = await callExternalLLMWithVision(makeEnv(), {
      system: 's',
      user: 'describe',
      provider: 'openai',
      imageUrl: 'https://example.com/shot.png',
    });
    expect(res.output).toBe('saw-image');
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user');
    const imgPart = userMsg.content.find((p: { type: string }) => p.type === 'image_url');
    expect(imgPart.image_url.url).toBe('https://example.com/shot.png');
    expect(imgPart.image_url.detail).toBe('high');
  });

  it('builds an OpenAI data URL message from imageBase64', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLMWithVision(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      imageBase64: 'AAAA',
    });
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user');
    const imgPart = userMsg.content.find((p: { type: string }) => p.type === 'image_url');
    expect(imgPart.image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('builds an Anthropic base64 image message from imageBase64', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody('claude-vision')));
    const res = await callExternalLLMWithVision(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'anthropic',
      imageBase64: 'QkFTRTY0',
    });
    expect(res.provider).toBe('anthropic');
    expect(res.output).toBe('claude-vision');
    const body = JSON.parse((mockGatewayFetch.mock.calls[0][3] as RequestInit).body as string);
    const imgBlock = body.messages[0].content.find((p: { type: string }) => p.type === 'image');
    expect(imgBlock.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QkFTRTY0' });
  });

  it('bounds the Anthropic imageUrl download with an AbortSignal (timeout — never a bare hang) [AL-748]', async () => {
    // The Anthropic-vision path fetches imageUrl via global.fetch to base64 it. A bare fetch()
    // has no timeout on Workers → a slow/dead image host would hang the whole vision call
    // indefinitely (withRetry bounds retry COUNT, not per-attempt duration). This asserts the
    // download carries the same AbortController signal every LLM call in the file uses. RED
    // before the fix (bare fetch, no signal).
    mockGatewayFetch.mockResolvedValueOnce(gwOk(anthropicBody('claude-saw-url-image')));
    const imgFetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }));
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = imgFetch;
    try {
      const res = await callExternalLLMWithVision(makeEnv(), {
        system: 's',
        user: 'describe',
        provider: 'anthropic',
        imageUrl: 'https://example.com/shot.png',
      });
      expect(res.provider).toBe('anthropic');
      expect(res.output).toBe('claude-saw-url-image');
      expect(imgFetch).toHaveBeenCalledTimes(1);
      const [url, init] = imgFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://example.com/shot.png');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });

  it('throws when no vision provider key is configured', async () => {
    const env = makeEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
    await expect(
      callExternalLLMWithVision(env, { system: 's', user: 'u', imageBase64: 'AAAA' }),
    ).rejects.toThrow(/No LLM vision provider available/);
  });

  it('tags the vision telemetry promptId with a :vision suffix', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk(openAIBody()));
    await callExternalLLMWithVision(makeEnv(), {
      system: 's',
      user: 'u',
      provider: 'openai',
      imageBase64: 'AAAA',
      traceContext: { promptId: 'brand' },
    });
    const okCall = mockCaptureLLM.mock.calls.find((c) => c[1].status === 'ok');
    expect(okCall![1].promptId).toBe('brand:vision');
  });
});

// ─── aiGatewayUrl shim ─────────────────────────────────────────────────────────

describe('aiGatewayUrl', () => {
  it('returns the direct vendor base when the gateway is inactive', () => {
    const env = makeEnv({ AI_GATEWAY_ENABLED: 'false' });
    expect(aiGatewayUrl(env, 'openai')).toBe('https://api.openai.com');
    expect(aiGatewayUrl(env, 'anthropic')).toBe('https://api.anthropic.com');
  });

  it('returns the gateway URL when active', () => {
    const env = makeEnv({ AI_GATEWAY_ENABLED: 'true' });
    expect(aiGatewayUrl(env, 'openai')).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/projectsites/openai`,
    );
  });
});

// ─── uploadDocToOpenAI ─────────────────────────────────────────────────────────

describe('uploadDocToOpenAI', () => {
  // This helper routes the OpenAI Files API call through gatewayFetch (mocked).
  it('throws when OPENAI_API_KEY is missing', async () => {
    const env = makeEnv({ OPENAI_API_KEY: undefined });
    await expect(
      uploadDocToOpenAI(env, {
        name: 'a.pdf',
        bytes: new Uint8Array([1, 2]),
        mime: 'application/pdf',
      }),
    ).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });

  it('posts multipart form data with Bearer auth and returns the file id', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwOk({ id: 'file_abc123' }));
    const id = await uploadDocToOpenAI(makeEnv(), {
      name: 'report.pdf',
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'application/pdf',
    });
    expect(id).toBe('file_abc123');
    const [, provider, path, init] = mockGatewayFetch.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      RequestInit,
    ];
    expect(provider).toBe('openai');
    expect(path).toBe('/v1/files');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-test');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('throws the API error text on a non-2xx upload', async () => {
    mockGatewayFetch.mockResolvedValueOnce(gwErr(400, 'bad file'));
    await expect(
      uploadDocToOpenAI(makeEnv(), {
        name: 'a.pdf',
        bytes: new Uint8Array([1]),
        mime: 'application/pdf',
      }),
    ).rejects.toThrow(/OpenAI Files API error 400: bad file/);
  });
});

describe('estimateCostPrecise — cost-table accuracy (LLM Observability)', () => {
  it('prices gpt-4o-mini as MINI, not gpt-4o (longest-match, not find-first)', () => {
    // 'gpt-4o-mini' CONTAINS 'gpt-4o' — the old find-first picked 'gpt-4o' and priced
    // mini 16× too high ($2.50 vs $0.15 input). Longest-match resolves the mini row.
    expect(sut.estimateCostPrecise('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.15 + 0.6, 6);
  });

  it('prices the anthropic default (claude-fable-5) instead of returning $0', () => {
    expect(sut.estimateCostPrecise('claude-fable-5', 1_000_000, 1_000_000)).toBeCloseTo(10 + 50, 6);
  });

  it('prices the deepseek default (deepseek-chat) instead of returning $0', () => {
    expect(sut.estimateCostPrecise('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(
      0.27 + 1.1,
      6,
    );
  });

  it('DRIFT GUARD: every DEFAULT_MODELS model resolves to a non-zero cost', () => {
    // A DEFAULT model with no MODEL_COSTS row silently reports $0 — undercounting the
    // highest-volume providers in observability. This locks the write→cost invariant.
    for (const model of Object.values(sut.DEFAULT_MODELS_EXPORT)) {
      // A DEFAULT model resolving to $0 means it has no MODEL_COSTS row.
      const cost = sut.estimateCostPrecise(model, 1000, 1000);
      expect({ model, priced: cost > 0 }).toEqual({ model, priced: true });
    }
  });

  it('returns 0 for a genuinely unknown model (no false pricing)', () => {
    expect(sut.estimateCostPrecise('some-unknown-model-xyz', 1000, 1000)).toBe(0);
  });
});
