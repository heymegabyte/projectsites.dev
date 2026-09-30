/**
 * Tests for the Anthropic-compatible public API (model_registry, campaign
 * lane-4, fire-58): POST /v1/messages (non-streamed + synthesized named-event
 * SSE) and POST /v1/messages/count_tokens. Covers: flag-off dark 404,
 * x-api-key auth → Anthropic authentication_error 401, missing
 * anthropic-version → 400 invalid_request_error, body validation, unknown
 * model → 404 not_found_error, the full Message envelope with the fire-57
 * provider usage split (chars/4 estimate fallback when the provider omits it),
 * the streamed event sequence, count_tokens, and 502 api_error on provider
 * failure without leaking internals.
 * Contract: e2e/ai-api/anthropic-compat.e2e.ts (all cases).
 */
import { Hono } from 'hono';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

// Mock ONLY verifyApiToken (needs a real D1); the raw x-api-key value goes to
// it directly (verifyApiToken itself rejects non-psk_ prefixes).
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

import { anthropicCompat } from '../anthropic_handlers.js';

const VALID_KEY = `psk_${'a'.repeat(64)}`;
const VERSION = '2023-06-01';

const LLM_RESULT = {
  output: 'pong indeed, loud  and\nclear.',
  model_used: 'deepseek-chat',
  provider: 'deepseek' as const,
  latency_ms: 42,
  token_count: 123,
  input_tokens: 100,
  output_tokens: 23,
  cost_estimate: 0.0001,
};

// ---------------------------------------------------------------------------
// App factory — mounts anthropicCompat at root (owns /v1/messages*)
// ---------------------------------------------------------------------------
function app(envOverrides: Record<string, unknown> = {}) {
  const a = new Hono();
  a.route('/', anthropicCompat);
  return {
    request: (path: string, init?: RequestInit) =>
      a.request(path, init, envOverrides as never, {
        waitUntil() {},
        passThroughOnException() {},
      } as never),
  };
}

/** POST helper — key + version headers on by default; opts drop them. */
const POST = (
  path: string,
  body: unknown,
  opts: { key?: string | false; version?: false } = {},
) =>
  app().request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.key === false ? {} : { 'x-api-key': opts.key ?? VALID_KEY }),
      ...(opts.version === false ? {} : { 'anthropic-version': VERSION }),
    },
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  model: 'projectsites-fast',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
};

interface AnthropicErrorShape {
  type: string;
  error: { type: string; message: string };
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerifyApiToken.mockReset();
  mockCallExternalLLM.mockReset();
  mockIsFlagOn.mockResolvedValue(true);
  mockVerifyApiToken.mockResolvedValue({
    id: 'tok-1',
    org_id: 'org-1',
    scopes: '["me:read"]',
  });
  mockCallExternalLLM.mockResolvedValue(LLM_RESULT);
});

// ---------------------------------------------------------------------------
// 1. Flag off → dark 404 (before auth)
// ---------------------------------------------------------------------------
describe('POST /v1/messages — flag gate', () => {
  it('404s dark when the model_registry flag is off (never leaks auth state)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await POST('/v1/messages', VALID_BODY);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockVerifyApiToken).not.toHaveBeenCalled();
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. x-api-key auth → Anthropic-shaped 401 authentication_error
// ---------------------------------------------------------------------------
describe('POST /v1/messages — x-api-key auth', () => {
  it('401s with the Anthropic authentication_error envelope when x-api-key is missing', async () => {
    const res = await POST('/v1/messages', VALID_BODY, { key: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('401s when the key is well-formed but revoked/unknown (verifyApiToken → null)', async () => {
    mockVerifyApiToken.mockResolvedValue(null);
    const res = await POST('/v1/messages', VALID_BODY);
    expect(res.status).toBe(401);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.error.type).toBe('authentication_error');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Missing anthropic-version header → 400 invalid_request_error
// ---------------------------------------------------------------------------
describe('POST /v1/messages — anthropic-version header', () => {
  it('400s with invalid_request_error naming the header when anthropic-version is missing', async () => {
    const res = await POST('/v1/messages', VALID_BODY, { version: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('anthropic-version');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Body validation — 400 invalid_request_error
// ---------------------------------------------------------------------------
describe('POST /v1/messages — body validation', () => {
  it('400s when max_tokens is missing', async () => {
    const res = await POST('/v1/messages', {
      model: 'projectsites-fast',
      messages: VALID_BODY.messages,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('400s when messages is empty', async () => {
    const res = await POST('/v1/messages', { ...VALID_BODY, messages: [] });
    expect(res.status).toBe(400);
  });

  it('400s when the body is not valid JSON', async () => {
    const res = await app().request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': VALID_KEY,
        'anthropic-version': VERSION,
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.error.type).toBe('invalid_request_error');
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown model → Anthropic-shaped 404 not_found_error
// ---------------------------------------------------------------------------
describe('POST /v1/messages — model resolution', () => {
  it('404s with not_found_error for an unknown model id', async () => {
    const res = await POST('/v1/messages', { ...VALID_BODY, model: 'claude-999-mega' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('claude-999-mega');
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Happy path — full Anthropic Message envelope
// ---------------------------------------------------------------------------
describe('POST /v1/messages — non-streamed happy path', () => {
  it('200s with the Anthropic Message envelope', async () => {
    const res = await POST('/v1/messages', VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      type: string;
      role: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      stop_sequence: null;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.id.startsWith('msg_')).toBe(true);
    expect(body.id.length).toBeGreaterThan('msg_'.length + 20);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    // model echoes the REQUESTED id, never the resolved upstream model.
    expect(body.model).toBe('projectsites-fast');
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toBe(LLM_RESULT.output);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.stop_sequence).toBeNull();
    // fire-57 split: provider-reported input/output tokens thread through.
    expect(body.usage).toEqual({ input_tokens: 100, output_tokens: 23 });
  });

  it('falls back to a chars/4 estimate (>0 both sides) when the provider omits the split', async () => {
    mockCallExternalLLM.mockResolvedValue({
      ...LLM_RESULT,
      input_tokens: 0,
      output_tokens: 0,
    });
    const res = await POST('/v1/messages', VALID_BODY);
    const body = (await res.json()) as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  });

  it('threads system + messages + max_tokens/temperature into callExternalLLM', async () => {
    await POST('/v1/messages', {
      model: 'projectsites-fast',
      max_tokens: 256,
      temperature: 0.7,
      system: 'You are terse.',
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
        { role: 'user', content: 'Follow-up' },
      ],
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
        traceContext?: { orgId?: string; promptId?: string };
      },
    ];
    expect(options.system).toContain('You are terse.');
    expect(options.user).toContain('First question');
    expect(options.user).toContain('First answer');
    expect(options.user).toContain('Follow-up');
    expect(options.temperature).toBe(0.7);
    expect(options.maxTokens).toBe(256);
    // projectsites-fast routes via the instant tier (same table as chat/completions).
    expect(options.tier).toBe('instant');
    expect(options.traceContext?.orgId).toBe('org-1');
    expect(options.traceContext?.promptId).toBe('anthropic_messages_api');
  });
});

// ---------------------------------------------------------------------------
// 7. Streamed — synthesized named-event SSE
// ---------------------------------------------------------------------------
describe('POST /v1/messages — streamed (synthesized SSE)', () => {
  /** Parse `event:`/`data:` pairs exactly like the prod spec does. */
  async function readNamedSse(res: Response) {
    const text = await res.text();
    const events: Array<{ event: string; data: string }> = [];
    let currentEvent = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
      else if (line.startsWith('data: ')) {
        events.push({ event: currentEvent, data: line.slice(6).trim() });
        currentEvent = '';
      }
    }
    return events;
  }

  it('200s text/event-stream with the Anthropic event sequence', async () => {
    const res = await POST('/v1/messages', { ...VALID_BODY, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

    const events = await readNamedSse(res);
    const names = events.map((e) => e.event);

    // message_start MUST be first and carry a non-empty message.id.
    expect(names[0]).toBe('message_start');
    const start = JSON.parse(events[0].data) as { message?: { id?: string } };
    expect(typeof start.message?.id).toBe('string');
    expect((start.message?.id as string).startsWith('msg_')).toBe(true);

    // At least one content_block_delta; deltas reassemble the exact output.
    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas.length).toBeGreaterThan(0);
    const reassembled = deltas
      .map((e) => (JSON.parse(e.data) as { delta: { text: string } }).delta.text)
      .join('');
    expect(reassembled).toBe(LLM_RESULT.output);

    // Exactly ONE message_stop, and it is the LAST event.
    expect(names.filter((n) => n === 'message_stop')).toHaveLength(1);
    expect(names[names.length - 1]).toBe('message_stop');

    // Every data payload is valid JSON.
    for (const e of events) {
      expect(() => JSON.parse(e.data)).not.toThrow();
    }
  });

  it('emits message_delta with stop_reason end_turn + output token usage before message_stop', async () => {
    const res = await POST('/v1/messages', { ...VALID_BODY, stream: true });
    const events = await readNamedSse(res);
    const names = events.map((e) => e.event);
    const deltaIdx = names.indexOf('message_delta');
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBe(names.length - 2);
    const messageDelta = JSON.parse(events[deltaIdx].data) as {
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    expect(messageDelta.delta.stop_reason).toBe('end_turn');
    expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. count_tokens — { input_tokens } only
// ---------------------------------------------------------------------------
describe('POST /v1/messages/count_tokens', () => {
  const COUNT_BODY = {
    model: 'projectsites-fast',
    messages: [{ role: 'user', content: 'How many tokens is this short message?' }],
  };

  it('200s with a positive input_tokens and NO output_tokens', async () => {
    const res = await POST('/v1/messages/count_tokens', COUNT_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens as number).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('output_tokens');
    // Estimation only — never burns an upstream call.
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('401s without auth', async () => {
    const res = await POST('/v1/messages/count_tokens', COUNT_BODY, { key: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.error.type).toBe('authentication_error');
  });

  it('400s without the anthropic-version header', async () => {
    const res = await POST('/v1/messages/count_tokens', COUNT_BODY, { version: false });
    expect(res.status).toBe(400);
  });

  it('404s not_found_error for an unknown model', async () => {
    const res = await POST('/v1/messages/count_tokens', {
      ...COUNT_BODY,
      model: 'claude-999-mega',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.error.type).toBe('not_found_error');
  });
});

// ---------------------------------------------------------------------------
// 9. Provider failure → 502 api_error, internals never leak
// ---------------------------------------------------------------------------
describe('POST /v1/messages — provider failure', () => {
  it('502s with an Anthropic api_error envelope and never leaks internals', async () => {
    mockCallExternalLLM.mockRejectedValue(
      new Error('DeepSeek API error 500: internal-secret-detail sk-abc123'),
    );
    const res = await POST('/v1/messages', VALID_BODY);
    expect(res.status).toBe(502);
    const body = (await res.json()) as AnthropicErrorShape;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).not.toContain('internal-secret-detail');
    expect(body.error.message).not.toContain('sk-abc123');
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
