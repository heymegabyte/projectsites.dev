/**
 * Tests for POST /v1/chat/completions with stream:true (model_registry,
 * campaign lane-4, fire-58). The handler SYNTHESIZES an OpenAI-wire SSE stream
 * from the completed non-streamed callExternalLLM result: `data:` lines that
 * all share ONE `chatcmpl-` id, a role-first delta, word-ish content deltas
 * that reassemble EXACTLY, one terminal finish_reason:"stop" chunk, then
 * exactly one `data: [DONE]`. Errors (unknown model, provider failure) stay
 * plain JSON — the stream never starts on a failed request.
 * Contract: e2e/ai-api/openai-compat.e2e.ts §3 (streamed SSE).
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

// Deliberately tricky whitespace (double space + newline) so the reassembly
// assertion proves the word-ish chunking is byte-exact, not merely word-safe.
const LLM_RESULT = {
  output: 'Hello  world,\nthis is a  synthesized stream test.',
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
const POST = (body: unknown, opts: { auth?: boolean } = {}) =>
  app().request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(opts.auth === false ? {} : AUTH),
    },
    body: JSON.stringify(body),
  });

const STREAM_BODY = {
  model: 'projectsites-auto',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
};

interface ChunkShape {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

/** Parse an SSE body into its `data:` payloads exactly like the prod spec does. */
async function readSse(res: Response) {
  const text = await res.text();
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6).trim());
  const doneIndex = dataLines.indexOf('[DONE]');
  const chunks = dataLines
    .slice(0, doneIndex === -1 ? dataLines.length : doneIndex)
    .map((l) => JSON.parse(l) as ChunkShape);
  return { text, dataLines, doneIndex, chunks };
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
// 1. SSE envelope — status, content-type, [DONE] discipline
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions stream:true — SSE envelope', () => {
  it('200s with a text/event-stream content type', async () => {
    const res = await POST(STREAM_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
  });

  it('emits exactly one [DONE], as the LAST data line', async () => {
    const res = await POST(STREAM_BODY);
    const { dataLines, doneIndex } = await readSse(res);
    expect(doneIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBe(dataLines.length - 1);
    expect(dataLines.filter((l) => l === '[DONE]')).toHaveLength(1);
  });

  it('every pre-DONE data line is valid JSON with object "chat.completion.chunk"', async () => {
    const res = await POST(STREAM_BODY);
    const { chunks } = await readSse(res);
    expect(chunks.length).toBeGreaterThan(3); // role + ≥2 content + stop
    for (const chunk of chunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe('projectsites-auto');
      expect(chunk.created).toBeGreaterThan(1_700_000_000);
      expect(chunk.choices).toHaveLength(1);
      expect(chunk.choices[0].index).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Consistent id + role-first delta + terminal stop chunk
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions stream:true — chunk contract', () => {
  it('all chunks share ONE chatcmpl- id', async () => {
    const res = await POST(STREAM_BODY);
    const { chunks } = await readSse(res);
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(1);
    const [id] = ids;
    expect(id.startsWith('chatcmpl-')).toBe(true);
    expect(id.length).toBeGreaterThan('chatcmpl-'.length + 20);
  });

  it('first chunk carries delta:{role:"assistant"} with finish_reason null', async () => {
    const res = await POST(STREAM_BODY);
    const { chunks } = await readSse(res);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks[0].choices[0].delta.content).toBeUndefined();
    expect(chunks[0].choices[0].finish_reason).toBeNull();
  });

  it('content deltas reassemble EXACTLY to the completed output', async () => {
    const res = await POST(STREAM_BODY);
    const { chunks } = await readSse(res);
    const reassembled = chunks
      .map((c) => c.choices[0].delta.content ?? '')
      .join('');
    expect(reassembled).toBe(LLM_RESULT.output);
  });

  it('the LAST chunk is an empty delta with finish_reason "stop"; all earlier are null', async () => {
    const res = await POST(STREAM_BODY);
    const { chunks } = await readSse(res);
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].delta).toEqual({});
    expect(last.choices[0].finish_reason).toBe('stop');
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.choices[0].finish_reason).toBeNull();
    }
  });

  it('routes through callExternalLLM once (tier standard for projectsites-auto)', async () => {
    await POST(STREAM_BODY);
    expect(mockCallExternalLLM).toHaveBeenCalledTimes(1);
    const [, options] = mockCallExternalLLM.mock.calls[0] as [unknown, { tier?: string }];
    expect(options.tier).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// 3. Errors never start the stream — plain JSON envelopes
// ---------------------------------------------------------------------------
describe('POST /v1/chat/completions stream:true — error paths stay JSON', () => {
  it('404s dark when the flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await POST(STREAM_BODY);
    expect(res.status).toBe(404);
    expect(mockCallExternalLLM).not.toHaveBeenCalled();
  });

  it('401s without a valid key', async () => {
    const res = await POST(STREAM_BODY, { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('404s model_not_found JSON for an unknown model (no SSE)', async () => {
    const res = await POST({ ...STREAM_BODY, model: 'gpt-99-ultra' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('502s plain JSON when the provider fails (stream never starts)', async () => {
    mockCallExternalLLM.mockRejectedValue(new Error('OpenAI API error 500: sk-leak'));
    const res = await POST(STREAM_BODY);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('provider_error');
    expect(body.error.message).not.toContain('sk-leak');
  });
});
