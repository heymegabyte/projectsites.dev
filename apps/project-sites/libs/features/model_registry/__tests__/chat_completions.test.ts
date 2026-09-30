/**
 * Tests for POST /v1/chat/completions (model_registry feature, campaign lane-4, fire-57).
 * NON-STREAMED only. Covers: flag-off dark 404, 401 missing/invalid key (OpenAI
 * envelope), 400 stream:true (honest stream_not_supported — never fake SSE),
 * 400 invalid body, 404 unknown model + unroutable alias, 200 happy path with
 * the full OpenAI chat.completion envelope, virtual-model → tier/provider
 * routing into callExternalLLM, and 502 provider failure without leaking
 * internals. Contract sibling: model_registry.test.ts (GET /v1/models).
 */
import { Hono } from 'hono';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

// Mock ONLY verifyApiToken (needs a real D1); keep extractBearerToken real so
// the psk_ Bearer parsing path is exercised for real.
const mockVerifyApiToken = jest.fn();
jest.mock('../../../../src/services/api_tokens.js', () => ({
  ...jest.requireActual('../../../../src/services/api_tokens.js'),
  verifyApiToken: (...a: unknown[]) => mockVerifyApiToken(...a),
}));

// Full-factory mock — external_llm pulls retry/analytics/metering/gateway; the
// handler only needs callExternalLLM, so never load the real module here.
const mockCallExternalLLM = jest.fn();
jest.mock('../../../../src/services/external_llm.js', () => ({
  callExternalLLM: (...a: unknown[]) => mockCallExternalLLM(...a),
}));

import { modelRegistry } from '../handlers.js';

/** A syntactically valid psk_ token (64 hex chars) that passes extractBearerToken. */
const VALID_KEY = `psk_${'a'.repeat(64)}`;
const AUTH = { Authorization: `Bearer ${VALID_KEY}` };

const LLM_RESULT = {
  output: 'Hi there! How can I help?',
  model_used: 'deepseek-chat',
  provider: 'deepseek' as const,
  latency_ms: 42,
  token_count: 123,
  input_tokens: 100,
  output_tokens: 23,
  cost_estimate: 0.0001,
};

// ---------------------------------------------------------------------------
// App factory — mounts modelRegistry at root (handler owns /v1/chat/completions)
// ---------------------------------------------------------------------------
function app(envOverrides: Record<string, unknown> = {}) {
  const a = new Hono();
  a.route('/', modelRegistry);
  return {
    request: (path: string, init?: RequestInit) =>
      a.request(path, init, envOverrides as never, {
        waitUntil() {},
        passThroughOnException() {},
      } as never),
  };
}

/** POST /v1/chat/completions with a JSON body; auth on by default. */
const POST = (body: unknown, opts: { auth?: boolean; env?: Record<string, unknown> } = {}) =>
  app(opts.env ?? {}).request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.auth === false ? {} : AUTH),
    },
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  model: 'projectsites-auto',
  messages: [{ role: 'user', content: 'Hello' }],
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerifyApiToken.mockReset();
  mockCallExternalLLM.mockReset();
  // Default: flag on + token valid + provider succeeds — tests override.
  mockIsFlagOn.mockResolvedValue(true);
  mockVerifyApiToken.mockResolvedValue({
    id: 'tok-1',
    org_id: 'org-1',
    scopes: '["me:read"]',
  });
  mockCallExternalLLM.mockResolvedValue(LLM_RESULT);
});

// ---------------------------------------------------------------------------
// 1. Flag off → dark 404 (before auth, before body parse)
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — flag gate', () => {
  it('404s dark when the model_registry flag is off (never leaks auth state)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await POST(VALID_BODY);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockVerifyApiToken).not.toHaveBeenCalled();
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Auth — 401 without a valid psk_ key (OpenAI error envelope)
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — Bearer psk_ auth', () => {
  it('401s with the OpenAI invalid_api_key envelope when Authorization is missing', async () => {
    const res = await POST(VALID_BODY, { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_api_key');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('401s when the token is well-formed but revoked/unknown (verifyApiToken → null)', async () => {
    mockVerifyApiToken.mockResolvedValue(null);
    const res = await POST(VALID_BODY);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. stream:true → honest 400 (never fake SSE)
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — streaming rejected', () => {
  it('400s with stream_not_supported for stream:true', async () => {
    const res = await POST({ ...VALID_BODY, stream: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.message).toBe('Streaming is not yet supported');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('stream_not_supported');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('stream:false is accepted (explicit non-stream)', async () => {
    const res = await POST({ ...VALID_BODY, stream: false });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Body validation — 400 invalid_request_error
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — body validation', () => {
  it('400s when messages is missing', async () => {
    const res = await POST({ model: 'projectsites-auto' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('400s when messages is empty', async () => {
    const res = await POST({ model: 'projectsites-auto', messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('400s when the body is not valid JSON', async () => {
    const res = await app().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown / unroutable model → OpenAI-shaped 404 model_not_found
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — model resolution', () => {
  it('404s with model_not_found for an unknown model id', async () => {
    const res = await POST({ ...VALID_BODY, model: 'gpt-99-ultra' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { message: string; type: string; param: string | null; code: string };
    };
    expect(body.error.message).toContain('gpt-99-ultra');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.param).toBe('model');
    expect(body.error.code).toBe('model_not_found');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('404s model_not_found for a listed alias whose providers this path cannot route (edge-fast)', async () => {
    const res = await POST({ ...VALID_BODY, model: 'edge-fast' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Happy path — full OpenAI chat.completion envelope
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — happy path', () => {
  it('200s with the OpenAI chat.completion envelope', async () => {
    const res = await POST(VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.id.startsWith('chatcmpl-')).toBe(true);
    expect(body.id.length).toBeGreaterThan('chatcmpl-'.length + 20);
    expect(body.object).toBe('chat.completion');
    expect(body.created).toBeGreaterThan(1_700_000_000);
    // model echoes the REQUESTED id, never the resolved upstream model.
    expect(body.model).toBe('projectsites-auto');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe(LLM_RESULT.output);
    expect(body.choices[0].finish_reason).toBe('stop');
    // Provider exposes only a total — split is honestly 0/0.
    expect(body.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 23,
      total_tokens: 123,
    });
  });

  it('threads system + user messages and optional params into callExternalLLM', async () => {
    await POST({
      model: 'projectsites-auto',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hello' },
      ],
      temperature: 0.7,
      max_tokens: 256,
    });
    expect(mockCallExternalLLM).toHaveBeenCalledTimes(1);
    const [, options] = mockCallExternalLLM.mock.calls[0] as [
      unknown,
      {
        system: string;
        user: string;
        temperature?: number;
        maxTokens?: number;
        tier?: string;
        traceContext?: { orgId?: string };
      },
    ];
    expect(options.system).toContain('You are terse.');
    expect(options.user).toContain('Hello');
    expect(options.temperature).toBe(0.7);
    expect(options.maxTokens).toBe(256);
    // Auth token's org threads into observability + metering.
    expect(options.traceContext?.orgId).toBe('org-1');
  });

  it('flattens multi-turn conversations into a role-labelled transcript', async () => {
    await POST({
      model: 'projectsites-auto',
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up' },
      ],
    });
    const [, options] = mockCallExternalLLM.mock.calls[0] as [unknown, { user: string }];
    expect(options.user).toContain('First question');
    expect(options.user).toContain('First answer');
    expect(options.user).toContain('Follow-up');
  });

  it.each([
    ['projectsites-auto', { tier: 'standard' }],
    ['projectsites-fast', { tier: 'instant' }],
    ['projectsites-premium', { tier: 'premium' }],
  ] as const)('%s routes via %j', async (model, expected) => {
    await POST({ ...VALID_BODY, model });
    const [, options] = mockCallExternalLLM.mock.calls[0] as [
      unknown,
      { tier?: string; provider?: string },
    ];
    expect(options.tier).toBe(expected.tier);
    expect(options.provider).toBeUndefined();
  });

  it('projectsites-balanced routes to openai gpt-4o-mini-class', async () => {
    await POST({ ...VALID_BODY, model: 'projectsites-balanced' });
    const [, options] = mockCallExternalLLM.mock.calls[0] as [
      unknown,
      { provider?: string; model?: string },
    ];
    expect(options.provider).toBe('openai');
    expect(options.model).toBe('gpt-4o-mini');
  });

  it('registry aliases route to their first routable provider (claude-architect → anthropic)', async () => {
    const res = await POST({ ...VALID_BODY, model: 'claude-architect' });
    expect(res.status).toBe(200);
    const [, options] = mockCallExternalLLM.mock.calls[0] as [unknown, { provider?: string }];
    expect(options.provider).toBe('anthropic');
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('claude-architect');
  });

  it('deepseek-fast alias routes to deepseek', async () => {
    await POST({ ...VALID_BODY, model: 'deepseek-fast' });
    const [, options] = mockCallExternalLLM.mock.calls[0] as [unknown, { provider?: string }];
    expect(options.provider).toBe('deepseek');
  });
});

// ---------------------------------------------------------------------------
// 7. Provider failure → 502 OpenAI-shape error, internals never leak
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions — provider failure', () => {
  it('502s with an OpenAI api_error envelope and never leaks internals', async () => {
    mockCallExternalLLM.mockRejectedValue(
      new Error('OpenAI API error 500: internal-secret-detail sk-abc123'),
    );
    const res = await POST(VALID_BODY);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.code).toBe('provider_error');
    expect(body.error.message).not.toContain('internal-secret-detail');
    expect(body.error.message).not.toContain('sk-abc123');
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
