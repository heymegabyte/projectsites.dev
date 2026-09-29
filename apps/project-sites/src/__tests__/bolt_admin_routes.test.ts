/**
 * Route coverage for the bolt.diy editor-side admin endpoints (convergence r45).
 *
 * Exercises `src/routes/bolt_admin.ts` end-to-end through the real Hono app,
 * mocking only the boundaries (Workers AI, KV, D1). The bolt routes run the
 * two-tier auth contract (`boltAuthDenial`, fire-56) and hand-roll their own
 * validation, so these tests assert that exact contract:
 *
 *   - PRODUCTION: authenticated principal only (session userId or the
 *     `PS_BOLT_SERVICE_TOKEN` machine Bearer) — the `X-Bolt-Origin-Check`
 *     marker and spoofed Origins 401; browser surfaces additionally accept a
 *     trusted Origin on the projectsites.dev zone (never workers.dev)
 *   - DEV (`ENVIRONMENT !== 'production'`, incl. this suite's 'test'): the
 *     legacy allowances (trusted Origin, marker header) still work, else 403
 *   - per-handler validation (slug, JSON, chat_id, data-url, form, audio)
 *   - success + the AI/D1-error fallbacks
 *
 * Each handler is registered at BOTH `/admin-api/...` and `/api/bolt/...`; the
 * tests hit the production-callable `/api/bolt/...` prefix and additionally
 * confirm the legacy prefix still resolves.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { bolt } from '../routes/bolt_admin.js';

jest.mock('../services/ai_gateway.js', () => ({
  gatewayFetch: jest.fn(),
  DIRECT_BASE_URLS_EXPORT: {},
}));

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn(async () => undefined),
}));

// ─── Boundary mocks ──────────────────────────────────────────────────────────

/** In-memory KV mock (suggest-prompts cache). */
function makeKv(initial: Record<string, string> = {}, opts: { throws?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: jest.fn(async (k: string) => {
      if (opts.throws) throw new Error('KV down');
      const v = store.get(k);
      return v === undefined ? null : JSON.parse(v);
    }),
    put: jest.fn(async (k: string, v: string) => {
      if (opts.throws) throw new Error('KV down');
      store.set(k, v);
    }),
    _store: store,
  };
}

/** D1 mock whose prepared statements resolve (or throw on `.run()`). */
function makeDb(opts: { throws?: boolean } = {}) {
  const run = jest.fn(async () => {
    if (opts.throws) throw new Error('D1 write failed');
    return { success: true };
  });
  const stmt = {
    bind: jest.fn(() => stmt),
    run,
  };
  return {
    prepare: jest.fn(() => stmt),
    _run: run,
    _stmt: stmt,
  };
}

/** Workers-AI mock returning a fixed result object (or throwing). */
function makeAi(result: unknown, opts: { throws?: boolean } = {}) {
  return {
    run: jest.fn(async () => {
      if (opts.throws) throw new Error('AI gateway 503');
      return result;
    }),
  };
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: makeDb(),
    CACHE_KV: makeKv(),
    AI: makeAi({}),
    ...overrides,
  } as unknown as Env;
}

// ─── App harness ─────────────────────────────────────────────────────────────

/**
 * Build the app, optionally seeding the `userId` var (real session) the
 * soft-auth check reads. Passing no vars + no trusted header simulates an
 * unauthorised cross-origin caller.
 */
function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', bolt);
  return app;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

/** POST a JSON body to a path with arbitrary headers. */
function postJson(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  path: string,
  body: unknown,
  env: Env,
  headers: Record<string, string> = {},
) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
    makeCtx(),
  );
}

/** Auth signal: trusted iframe origin (no session). */
const IFRAME_HEADER = { 'X-Bolt-Origin-Check': 'bolt-iframe' };
const SESSION: Partial<Variables> = { userId: 'user-1', orgId: 'org-1', requestId: 'req-1' };

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Soft-auth contract (shared across every handler) ─────────────────────────

describe('bolt_admin soft-auth gate', () => {
  it('returns 403 when no session, no trusted origin, and no bolt header', async () => {
    const env = makeEnv();
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('forbidden');
    // Short-circuits before touching the model.
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('rejects an untrusted Origin header', async () => {
    const env = makeEnv();
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      { Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('accepts a valid session userId', async () => {
    const env = makeEnv({ CACHE_KV: makeKv(), AI: makeAi({ response: '{"suggestions":[]}' }) });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('accepts a trusted Origin header', async () => {
    const env = makeEnv({ CACHE_KV: makeKv(), AI: makeAi({ response: '{"suggestions":[]}' }) });
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      { Origin: 'https://editor.projectsites.dev' },
    );
    expect(res.status).toBe(200);
  });

  it('accepts the X-Bolt-Origin-Check iframe header', async () => {
    const env = makeEnv({ CACHE_KV: makeKv(), AI: makeAi({ response: '{"suggestions":[]}' }) });
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      IFRAME_HEADER,
    );
    expect(res.status).toBe(200);
  });
});

// ─── chat-state mirror ────────────────────────────────────────────────────────

describe('POST /api/bolt/sites/by-slug/:slug/chat-state', () => {
  const PATH = (slug: string) => `/api/bolt/sites/by-slug/${slug}/chat-state`;

  it('returns 400 on an over-long slug', async () => {
    const env = makeEnv();
    const slug = 'x'.repeat(129);
    const res = await postJson(makeApp(), PATH(slug), { chat_id: 'c1' }, env, IFRAME_HEADER);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_slug');
  });

  it('returns 400 when the body is not valid JSON', async () => {
    const env = makeEnv();
    const res = await makeApp().request(
      PATH('vitos'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...IFRAME_HEADER },
        body: 'not-json',
      },
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_json');
  });

  it('returns 400 when chat_id is missing', async () => {
    const env = makeEnv();
    const res = await postJson(makeApp(), PATH('vitos'), { message_count: 3 }, env, IFRAME_HEADER);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('chat_id_required');
  });

  it('persists the mirror and returns ok on a valid body', async () => {
    const db = makeDb();
    const env = makeEnv({ DB: db });
    const res = await postJson(
      makeApp(SESSION),
      PATH('vitos'),
      {
        chat_id: 'chat-9',
        message_count: 12,
        last_message_id: 'm-12',
        updated_at: '2026-06-03T00:00:00.000Z',
        tail: [{ id: 'm-12', role: 'assistant', excerpt: 'done' }],
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    // CREATE TABLE + UPSERT both prepared; the upsert bound the slug + chat_id.
    expect(db.prepare).toHaveBeenCalledTimes(2);
    expect(db._stmt.bind).toHaveBeenCalledWith(
      'vitos',
      'chat-9',
      12,
      'm-12',
      '2026-06-03T00:00:00.000Z',
      expect.any(String),
    );
  });

  it('returns 500 when the D1 write throws', async () => {
    const env = makeEnv({ DB: makeDb({ throws: true }) });
    const res = await postJson(makeApp(SESSION), PATH('vitos'), { chat_id: 'chat-9' }, env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error?: string }).error).toBe('persist_failed');
  });

  it('also resolves at the legacy /admin-api prefix', async () => {
    const env = makeEnv({ DB: makeDb() });
    const res = await postJson(
      makeApp(SESSION),
      '/admin-api/sites/by-slug/vitos/chat-state',
      { chat_id: 'chat-1' },
      env,
    );
    expect(res.status).toBe(200);
  });
});

// ─── transcribe (Whisper) ──────────────────────────────────────────────────────

describe('POST /api/bolt/transcribe', () => {
  /** POST a multipart form with an optional audio File. */
  function postForm(
    app: Hono<{ Bindings: Env; Variables: Variables }>,
    env: Env,
    audio: File | null,
    headers: Record<string, string> = IFRAME_HEADER,
  ) {
    const form = new FormData();
    if (audio) form.set('audio', audio);
    return app.request(
      '/api/bolt/transcribe',
      { method: 'POST', headers, body: form },
      env,
      makeCtx(),
    );
  }

  it('returns 403 without an auth signal', async () => {
    const env = makeEnv();
    const file = new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' });
    const res = await postForm(makeApp(), env, file, {});
    expect(res.status).toBe(403);
  });

  it('returns 400 when no audio field is present', async () => {
    const env = makeEnv();
    const res = await postForm(makeApp(), env, null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('audio_required');
  });

  it('returns 413 when the audio exceeds 20MB', async () => {
    const env = makeEnv();
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.webm', {
      type: 'audio/webm',
    });
    const res = await postForm(makeApp(), env, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error?: string }).error).toBe('audio_too_large');
  });

  it('returns trimmed text + durationMs on success', async () => {
    const env = makeEnv({ AI: makeAi({ text: '  hello world  ' }) });
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.webm', { type: 'audio/webm' });
    const res = await postForm(makeApp(SESSION), env, file, {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text?: string; durationMs?: number };
    expect(json.text).toBe('hello world');
    expect(typeof json.durationMs).toBe('number');
    expect((env.AI as unknown as { run: jest.Mock }).run).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when the model throws', async () => {
    const env = makeEnv({ AI: makeAi(null, { throws: true }) });
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.webm', { type: 'audio/webm' });
    const res = await postForm(makeApp(SESSION), env, file, {});
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error?: string }).error).toBe('transcribe_failed');
  });
});

// ─── vision-ocr ─────────────────────────────────────────────────────────────

describe('POST /api/bolt/vision-ocr', () => {
  const PATH = '/api/bolt/vision-ocr';
  // 1x1 transparent PNG.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await makeApp().request(
      PATH,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...IFRAME_HEADER },
        body: '{bad',
      },
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_json');
  });

  it('returns 400 when the data URL is not a base64 image', async () => {
    const env = makeEnv();
    const res = await postJson(
      makeApp(),
      PATH,
      { image_data_url: 'https://x.png' },
      env,
      IFRAME_HEADER,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_data_url');
  });

  it('splits caption from OCR text on success', async () => {
    const env = makeEnv({
      AI: makeAi({ description: 'A red sign.\nOCR: STOP' }),
    });
    const res = await postJson(makeApp(SESSION), PATH, { image_data_url: PNG }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { caption?: string; ocrText?: string };
    expect(json.caption).toBe('A red sign.');
    expect(json.ocrText).toBe('STOP');
  });

  it('returns the full text as caption when no OCR marker is present', async () => {
    const env = makeEnv({ AI: makeAi({ response: 'Just a caption with no marker' }) });
    const res = await postJson(makeApp(SESSION), PATH, { image_data_url: PNG }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { caption?: string; ocrText?: string };
    expect(json.caption).toBe('Just a caption with no marker');
    expect(json.ocrText).toBe('');
  });

  it('returns 502 when the vision model throws', async () => {
    const env = makeEnv({ AI: makeAi(null, { throws: true }) });
    const res = await postJson(makeApp(SESSION), PATH, { image_data_url: PNG }, env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error?: string }).error).toBe('vision_failed');
  });
});

// ─── suggest-prompts ───────────────────────────────────────────────────────────

describe('POST /api/bolt/chat/suggest-prompts', () => {
  const PATH = '/api/bolt/chat/suggest-prompts';

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await makeApp().request(
      PATH,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...IFRAME_HEADER },
        body: 'nope',
      },
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_json');
  });

  it('returns empty suggestions for an empty tail without calling AI', async () => {
    const env = makeEnv();
    const res = await postJson(makeApp(SESSION), PATH, { tail: [] }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestions?: unknown[] }).suggestions).toEqual([]);
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('returns the cached payload on a KV hit (no AI call)', async () => {
    const cached = { suggestions: [{ label: 'Cached', prompt: 'do the cached thing' }] };
    // Make get() always return the cached value regardless of key.
    const kv = makeKv();
    kv.get = jest.fn(async () => cached) as unknown as typeof kv.get;
    const env = makeEnv({ CACHE_KV: kv });
    const res = await postJson(
      makeApp(SESSION),
      PATH,
      { tail: [{ role: 'user', content: 'help' }] },
      env,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual(cached);
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('parses model JSON, caps at 3, and writes the cache on a miss', async () => {
    const modelOut = JSON.stringify({
      suggestions: [
        { label: 'Add tests', prompt: 'Write unit tests for the parser.' },
        { label: 'Fix bug', prompt: 'Fix the off-by-one in pagination.' },
        { label: 'Refactor', prompt: 'Extract the helper into its own module.' },
        { label: 'Extra', prompt: 'This fourth one must be dropped.' },
      ],
    });
    const kv = makeKv();
    const env = makeEnv({
      CACHE_KV: kv,
      AI: makeAi({ response: '```json\n' + modelOut + '\n```' }),
    });
    const res = await postJson(
      makeApp(SESSION),
      PATH,
      { tail: [{ role: 'user', content: 'what next?' }] },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { suggestions: Array<{ label: string; prompt: string }> };
    expect(json.suggestions).toHaveLength(3);
    expect(json.suggestions[0].label).toBe('Add tests');
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('returns empty suggestions when the model emits unparseable text', async () => {
    const env = makeEnv({ AI: makeAi({ response: 'the model wrote prose, no json here' }) });
    const res = await postJson(
      makeApp(SESSION),
      PATH,
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestions?: unknown[] }).suggestions).toEqual([]);
  });

  it('returns empty suggestions (never crashes) when the model throws', async () => {
    const env = makeEnv({ AI: makeAi(null, { throws: true }) });
    const res = await postJson(
      makeApp(SESSION),
      PATH,
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestions?: unknown[] }).suggestions).toEqual([]);
  });

  it('still serves from AI when the KV cache read throws (fail-open)', async () => {
    const env = makeEnv({
      CACHE_KV: makeKv({}, { throws: true }),
      AI: makeAi({ response: '{"suggestions":[{"label":"Go","prompt":"go on"}]}' }),
    });
    const res = await postJson(
      makeApp(SESSION),
      PATH,
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { suggestions: unknown[] };
    expect(json.suggestions).toHaveLength(1);
  });
});

// ─── POST /api/bolt/chat — the editor's custom AI (tier routing + AI Gateway) ───

import { gatewayFetch } from '../services/ai_gateway.js';
import { writeAuditLog } from '../services/audit.js';
const mockGatewayFetch = gatewayFetch as unknown as jest.Mock;
const mockWriteAuditLog = writeAuditLog as unknown as jest.Mock;

describe('bolt custom-AI chat endpoint — edge-first routing', () => {
  beforeEach(() => {
    mockGatewayFetch.mockReset();
    mockWriteAuditLog.mockReset();
  });

  it('403s without a session, trusted origin, or bolt header', async () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      env,
    );
    expect(res.status).toBe(403);
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('400s when messages are missing/empty', async () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(makeApp(SESSION), '/api/bolt/chat', { messages: [] }, env);
    expect(res.status).toBe(400);
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('INSTANT tier: short Q&A answers via Workers AI at the edge — gateway NEVER called', async () => {
    const chunks = ['PONG'];
    const aiStream = new ReadableStream<string>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', AI: makeAi(aiStream) });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'what is 2+2?' }], stream: true },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-edge-tier')).toBe('instant');
    expect(res.headers.get('x-ai-gateway')).toBeNull();
    const text = await res.text();
    expect(text).toContain('PONG');
    expect(text).toContain('data: [DONE]');
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('writes a fire-and-forget bolt.ai.answered audit entry (palette parity)', async () => {
    const aiStream = new ReadableStream<string>({
      start(c) {
        c.enqueue('PONG');
        c.close();
      },
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', AI: makeAi(aiStream) });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'what is 2+2?' }], stream: true },
      env,
    );

    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockWriteAuditLog.mock.calls[0][1];
    expect(entry.action).toBe('bolt.ai.answered');
    expect(entry.org_id).toBe('org-1');
    expect(entry.actor_id).toBe('user-1');
    expect(entry.message).toContain('what is 2+2?');
    expect(entry.target_type).toBe('bolt_ai');
    expect((entry.metadata_json as Record<string, unknown>).query_length).toBe(12);
  });

  it('does NOT audit the header-only M2M path (no session org — FK-safe skip)', async () => {
    const aiStream = new ReadableStream<string>({
      start(c) {
        c.enqueue('PONG');
        c.close();
      },
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', AI: makeAi(aiStream) });
    // No SESSION vars — only the bolt iframe header (the fork's server-side path).
    const res = await postJson(
      makeApp(),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      env,
      IFRAME_HEADER,
    );

    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it('INSTANT tier: Workers AI chunks that are ALREADY OpenAI-SSE pass through verbatim (no double-wrapping — the live double-encode regression)', async () => {
    // Workers AI sometimes returns OpenAI-format SSE frames directly; wrapping
    // them again produced nested data: frames that crashed AI SDK clients and
    // bounced the editor to its landing screen (live incident).
    const chunks = [
      'data: {"choices":[{"delta":{"content":"PO"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"NG"}}]}\n\ndata: [DONE]\n\n',
    ];
    const aiStream = new ReadableStream<string>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', AI: makeAi(aiStream) });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      env,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('{"choices":[{"delta":{"content":"PO"}}]');
    expect(text).toContain('{"choices":[{"delta":{"content":"NG"}}]');
    // The regression signature: NO nested data: inside a delta content string.
    expect(text).not.toContain('\\"choices\\"');
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('STANDARD tier: build/code intent streams via DeepSeek through the AI Gateway', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response(
        'data: {"choices":[{"delta":{"content":"PONG"}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
      gatewayUsed: true,
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      {
        messages: [{ role: 'user', content: 'build a hero section with tailwind css' }],
        stream: true,
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-edge-tier')).toBe('standard');
    expect(res.headers.get('x-ai-gateway')).toBe('1');
    const text = await res.text();
    expect(text).toContain('PONG');

    expect(mockGatewayFetch).toHaveBeenCalledTimes(1);
    const [callEnv, callProvider, callPath, callInit] = mockGatewayFetch.mock.calls[0];
    expect(callProvider).toBe('deepseek');
    expect(callPath).toBe('/v1/chat/completions');
    expect(String(callInit.body)).toContain('"stream":true');
    // The provider's Authorization MUST ride in init.headers — gatewayFetch adds
    // only cf-aig-* cache headers; omitting it 401s the gateway (live incident).
    const authHdr = (callInit.headers as Record<string, string>)['Authorization'] ?? '';
    expect(authHdr).toBe('Bearer sk-test');
  });

  it('PREMIUM tier: reasoning intent streams the premium model via the gateway', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('data: {"choices":[{"delta":{"content":"X"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      }),
      gatewayUsed: true,
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      {
        messages: [
          {
            role: 'user',
            content: 'Analyze the architecture trade-offs step by step and propose a plan',
          },
        ],
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-edge-tier')).toBe('premium');
    // Premium ladder (Fable → OpenAI → Kimi → DeepSeek) is KEY-GATED per
    // chooseProviderForTier: only DEEPSEEK_API_KEY is set in this env, so the
    // ladder falls through to deepseek-reasoner.
    const [callEnv, callProvider, callPath, callInit] = mockGatewayFetch.mock.calls[0];
    expect(callProvider).toBe('deepseek');
    expect(String(callInit.body)).toContain('deepseek-reasoner');
  });

  it('PREMIUM tier: an OpenAI key rung serves gpt-4o via the gateway (ladder rung 2)', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('data: {"choices":[{"delta":{"content":"X"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      }),
      gatewayUsed: true,
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-deepseek', OPENAI_API_KEY: 'sk-openai' });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      {
        messages: [
          {
            role: 'user',
            content: 'Analyze the architecture trade-offs step by step and propose a plan',
          },
        ],
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-edge-tier')).toBe('premium');
    // OPENAI_API_KEY set → the ladder stops at OpenAI before reaching DeepSeek.
    const [callEnv, callProvider, callPath, callInit] = mockGatewayFetch.mock.calls[0];
    expect(callProvider).toBe('openai');
    expect(String(callInit.body)).toContain('gpt-4o');
  });

  it('MODEL HINT: a claude-opus-4-6 chip request routes premium (gpt-4o via gateway) regardless of text', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('data: {"choices":[{"delta":{"content":"Y"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      }),
      gatewayUsed: true,
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-4-6' },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-edge-tier')).toBe('premium');
    expect(mockGatewayFetch).toHaveBeenCalledTimes(1);
  });

  it('NON-STREAMING (stream:false) returns chat.completion JSON — the llmcall generateText shape', async () => {
    const aiStream = new ReadableStream<string>({
      start(c) {
        c.enqueue('PONG');
        c.close();
      },
    });
    // Workers AI non-streaming run() returns {response} — mock that shape.
    const ai = { run: jest.fn(async () => ({ response: 'PONG-CHECK' })) };
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', AI: ai });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'hi' }], stream: false },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    expect(json.choices?.[0]?.message?.content).toBe('PONG-CHECK');
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('502s when the upstream provider fails (honest error, never a silent hang)', async () => {
    mockGatewayFetch.mockResolvedValue({
      response: new Response('upstream exploded', { status: 500 }),
      gatewayUsed: true,
    });
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    const res = await postJson(
      makeApp(SESSION),
      '/api/bolt/chat',
      { messages: [{ role: 'user', content: 'build a page' }] },
      env,
    );
    expect(res.status).toBe(502);
  });
});

// ─── PRODUCTION auth gate (fire-56) — principal-only, marker/Origin never grant ───
//
// In production the bolt endpoints require an AUTHENTICATED PRINCIPAL: a session
// userId (set by the global auth middleware) or the PS_BOLT_SERVICE_TOKEN machine
// principal (the editor fork's server-side chat fetch sends it as its Bearer).
// The `X-Bolt-Origin-Check` marker and a spoofed Origin header are NEVER auth in
// production — any curl can set both. The browser-called surfaces (suggest-prompts,
// chat-state, vision-ocr, transcribe) additionally accept a REAL browser Origin,
// but ONLY when the request arrived on the projectsites.dev zone (Bot-Fight-Mode
// screened) — never via the WAF-less workers.dev host.

describe('bolt production auth gate (fire-56)', () => {
  const CHAT_BODY = { messages: [{ role: 'user', content: 'what is 2+2?' }], stream: true };

  /** Instant-tier Workers-AI stream so an ALLOWED chat call 200s without the gateway. */
  function instantAi() {
    const aiStream = new ReadableStream<string>({
      start(c) {
        c.enqueue('PONG');
        c.close();
      },
    });
    return makeAi(aiStream);
  }

  function prodEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
    return makeEnv({
      ENVIRONMENT: 'production',
      DEEPSEEK_API_KEY: 'sk-test',
      AI: instantAi(),
      ...overrides,
    });
  }

  beforeEach(() => {
    mockGatewayFetch.mockReset();
  });

  it('chat: 401s in production on the bare X-Bolt-Origin-Check marker (no inference)', async () => {
    const env = prodEnv();
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, IFRAME_HEADER);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe('unauthorized');
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
    expect(mockGatewayFetch).not.toHaveBeenCalled();
  });

  it('chat: 401s in production on a spoofed trusted Origin (curl can set Origin)', async () => {
    const env = prodEnv();
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, {
      Origin: 'https://editor.projectsites.dev',
    });
    expect(res.status).toBe(401);
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('chat: allows an authenticated session userId in production', async () => {
    const env = prodEnv();
    const res = await postJson(makeApp(SESSION), '/api/bolt/chat', CHAT_BODY, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('PONG');
  });

  it('chat: allows the PS_BOLT_SERVICE_TOKEN machine principal (the fork server-side Bearer)', async () => {
    const env = prodEnv({ PS_BOLT_SERVICE_TOKEN: 'svc-secret-1' });
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, {
      Authorization: 'Bearer svc-secret-1',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('PONG');
    // Machine principal has no org → the audit write is skipped (FK-safe).
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it('chat: 401s a WRONG service-token Bearer in production', async () => {
    const env = prodEnv({ PS_BOLT_SERVICE_TOKEN: 'svc-secret-1' });
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, {
      Authorization: 'Bearer not-the-secret',
    });
    expect(res.status).toBe(401);
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('chat: 401s the marker even when PS_BOLT_SERVICE_TOKEN is unset (no fail-open)', async () => {
    const env = prodEnv({ PS_BOLT_SERVICE_TOKEN: undefined });
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, IFRAME_HEADER);
    expect(res.status).toBe(401);
  });

  it('chat: keeps the dev-mode marker allowance OUTSIDE production (local editor dev)', async () => {
    const env = makeEnv({
      ENVIRONMENT: 'development',
      DEEPSEEK_API_KEY: 'sk-test',
      AI: instantAi(),
    });
    const res = await postJson(makeApp(), '/api/bolt/chat', CHAT_BODY, env, IFRAME_HEADER);
    expect(res.status).toBe(200);
  });

  it('suggest-prompts: keeps working in production from the real iframe (trusted Origin on the projectsites.dev zone)', async () => {
    const env = prodEnv({ AI: makeAi({ response: '{"suggestions":[]}' }) });
    const res = await postJson(
      makeApp(),
      'https://projectsites.dev/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      { Origin: 'https://editor.projectsites.dev' },
    );
    expect(res.status).toBe(200);
  });

  it('suggest-prompts: 401s in production on the bare marker (no Origin)', async () => {
    const env = prodEnv();
    const res = await postJson(
      makeApp(),
      'https://projectsites.dev/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      IFRAME_HEADER,
    );
    expect(res.status).toBe(401);
    expect((env.AI as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('suggest-prompts: 401s a trusted Origin arriving via the WAF-less workers.dev host', async () => {
    const env = prodEnv();
    const res = await postJson(
      makeApp(),
      'https://project-sites.manhattan.workers.dev/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      { Origin: 'https://editor.projectsites.dev' },
    );
    expect(res.status).toBe(401);
  });

  it('suggest-prompts: 401s a localhost Origin in production (dev origins never graduate)', async () => {
    const env = prodEnv();
    const res = await postJson(
      makeApp(),
      'https://projectsites.dev/api/bolt/chat/suggest-prompts',
      { tail: [{ role: 'user', content: 'hi' }] },
      env,
      { Origin: 'http://localhost:5173' },
    );
    expect(res.status).toBe(401);
  });
});
