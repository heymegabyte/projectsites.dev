/**
 * Unit tests for the OpenAI-powered research pipeline
 * ({@link services/openai_research.ts}).
 *
 * Covers every branch:
 *   - Request build: URL, method, Bearer auth, Content-Type header, model
 *     selection (default `o3-mini` vs `RESEARCH_MODEL` override),
 *     `max_completion_tokens` / `temperature` / `response_format` (jsonMode)
 *     passthrough, system + user message shape.
 *   - Success parse/extraction across all four research steps + the final
 *     expert-prompt step; `extractJson` handling of markdown ```json fences,
 *     bare ```fences, embedded `{...}` substrings, and direct JSON.
 *   - No-key / unconfigured: missing `OPENAI_API_KEY` throws before any fetch.
 *   - Non-200 / API-error: thrown with status + body, analytics error capture.
 *   - Network-throw resilience: fetch rejection bubbles, analytics error capture.
 *   - Empty / malformed response fallback: missing choice content → '' ;
 *     unparseable JSON → throw from extractJson.
 *   - Analytics: success path fires `captureLLMCall` with status 'ok' + token
 *     usage; analytics failure is swallowed (never bubbles into the pipeline).
 *   - Param passthrough: traceContext distinctId/traceId + promptId on captures.
 *
 * Mocks the OpenAI HTTP API via `global.fetch` and stubs `./analytics.js`
 * so no real network or PostHog call is ever made.
 */

import type { Env } from '../types/env.js';

const mockCaptureLLMCall = jest.fn();

jest.mock('../services/analytics.js', () => ({
  captureLLMCall: (...args: unknown[]) => mockCaptureLLMCall(...args),
}));

// researchAndFormulatePrompt now gates a per-business research cache behind the
// dark `research_cache` flag (isFlagOn → reads env.CACHE_KV). These tests exercise
// the RESEARCH pipeline (request shape, parsing, analytics), NOT the cache — so
// pin the flag OFF (its prod default). The cache path has its own coverage in
// research_cache_unit.test.ts. Without this, isFlagOn's env.CACHE_KV.get() threw
// "Cannot read properties of undefined (reading 'get')" before any assertion ran.
jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: async () => false,
}));

// Import AFTER the mocks are registered.
import { researchAndFormulatePrompt, estimateOpenAiCost } from '../services/openai_research.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  mockCaptureLLMCall.mockReset();
  mockCaptureLLMCall.mockResolvedValue(undefined);
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

const keyEnv = (overrides: Partial<Env> = {}): Env =>
  ({ OPENAI_API_KEY: 'sk-test-abc', ...overrides }) as unknown as Env;

const noKeyEnv = (): Env => ({}) as unknown as Env;

/**
 * Build a fake OpenAI Chat Completions response whose first choice message
 * content is the supplied string.
 */
function chatResponse(
  content: string,
  init: { ok?: boolean; status?: number; usage?: Record<string, number> } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: init.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    text: async () => content,
  };
}

const PROFILE = '{"business_type":"salon","description":"A men\'s salon"}';
const BRAND = '{"primary_color":"#112233","font_heading":"Inter"}';
const SELLING = '{"hero_headline":"Best Cuts in Town"}';
const SOCIAL = '{"website_url":"https://example.com"}';
const EXPERT = 'Build a gorgeous website for the salon...';

/**
 * Queue the five fetch responses the full pipeline makes, in order:
 * profile → (brand | sellingPoints | social, parallel) → expertPrompt.
 *
 * researchAndFormulatePrompt awaits profile first, then Promise.all of the
 * next three, then the expert prompt — so the call order is deterministic:
 * profile, brand, selling, social, expert.
 */
function queueFullPipeline(opts?: {
  profile?: string;
  brand?: string;
  selling?: string;
  social?: string;
  expert?: string;
}) {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock
    .mockResolvedValueOnce(chatResponse(opts?.profile ?? PROFILE))
    .mockResolvedValueOnce(chatResponse(opts?.brand ?? BRAND))
    .mockResolvedValueOnce(chatResponse(opts?.selling ?? SELLING))
    .mockResolvedValueOnce(chatResponse(opts?.social ?? SOCIAL))
    .mockResolvedValueOnce(chatResponse(opts?.expert ?? EXPERT));
}

// ─── Happy path: full pipeline ───────────────────────────────

describe('researchAndFormulatePrompt — happy path', () => {
  it('returns the assembled ResearchResult with parsed JSON + expert prompt', async () => {
    queueFullPipeline();

    const result = await researchAndFormulatePrompt(keyEnv(), {
      businessName: "Vito's Mens Salon",
    });

    expect(result.profile).toEqual({
      business_type: 'salon',
      description: "A men's salon",
    });
    expect(result.brand).toEqual({ primary_color: '#112233', font_heading: 'Inter' });
    expect(result.sellingPoints).toEqual({ hero_headline: 'Best Cuts in Town' });
    expect(result.social).toEqual({ website_url: 'https://example.com' });
    expect(result.expertPrompt).toBe(EXPERT);
    expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(5);
  });

  it('builds the OpenAI request with auth, content-type, method and message shape', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' });

    const fetchMock = global.fetch as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0];
    // Routed through gatewayFetch: URL resolves to the direct vendor URL when the
    // gateway is inactive (no CF_ACCOUNT_ID in test env), and headers flow through
    // gatewayFetch's `Headers` normalization — read via `.get()`, not property access.
    expect(url).toBe(OPENAI_URL);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('Authorization')).toBe('Bearer sk-test-abc');
    expect(h.get('Content-Type')).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('o3-mini'); // DEFAULT_MODEL
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('Acme');
    expect(body.max_completion_tokens).toBe(8192); // profile step
    expect(body.temperature).toBe(0.2); // profile step
    expect(body.response_format).toEqual({ type: 'json_object' }); // jsonMode on
  });

  it('honors RESEARCH_MODEL env override for the model field', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv({ RESEARCH_MODEL: 'gpt-4o' } as Partial<Env>), {
      businessName: 'Acme',
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o');
  });

  it('expert-prompt step uses 16000 max tokens and NO json response_format', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' });

    // 5th call (index 4) is formulateExpertPrompt.
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[4][1].body);
    expect(body.max_completion_tokens).toBe(16000);
    expect(body.temperature).toBe(0.4);
    expect(body.response_format).toBeUndefined();
  });

  it('forwards optional business fields into the profile user prompt', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), {
      businessName: 'Acme',
      businessAddress: '1 Main St',
      businessPhone: '555-1212',
      googlePlaceId: 'place-xyz',
      additionalContext: 'family owned',
    });

    const userPrompt = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).messages[1]
      .content;
    expect(userPrompt).toContain('1 Main St');
    expect(userPrompt).toContain('555-1212');
    expect(userPrompt).toContain('place-xyz');
    expect(userPrompt).toContain('family owned');
  });
});

// ─── extractJson branches (exercised through the pipeline) ───

describe('researchAndFormulatePrompt — JSON extraction', () => {
  it('parses a ```json fenced profile body', async () => {
    queueFullPipeline({ profile: '```json\n{"business_type":"cafe"}\n```' });

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Cafe' });
    expect(result.profile).toEqual({ business_type: 'cafe' });
  });

  it('parses a bare ``` fenced profile body (no json hint)', async () => {
    queueFullPipeline({ profile: '```\n{"business_type":"bar"}\n```' });

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Bar' });
    expect(result.profile).toEqual({ business_type: 'bar' });
  });

  it('extracts an embedded {...} substring when surrounded by prose', async () => {
    queueFullPipeline({ profile: 'Here is the data: {"business_type":"gym"} thanks!' });

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Gym' });
    expect(result.profile).toEqual({ business_type: 'gym' });
  });

  it('parses a direct JSON body with no braces context wrapping', async () => {
    queueFullPipeline({ profile: '{"business_type":"shop"}' });

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Shop' });
    expect(result.profile).toEqual({ business_type: 'shop' });
  });

  it('throws when a research body is unparseable JSON', async () => {
    queueFullPipeline({ profile: 'totally not json at all' });

    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Bad' })).rejects.toThrow();
  });

  it('recovers the real object when a non-JSON fenced block precedes it', async () => {
    // The fence regex greedily grabs the FIRST ``` ... ``` (here a non-JSON
    // note). The old extractJson JSON.parse'd that and threw with NO fallback;
    // the widest {...} span still holds the real object further down.
    queueFullPipeline({
      profile: '```\nreasoning: not json\n```\n\nResult: {"business_type":"cafe"}',
    });

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Cafe' });
    expect(result.profile).toEqual({ business_type: 'cafe' });
  });

  it('throws a DIAGNOSABLE error (not a raw SyntaxError) on total parse failure', async () => {
    queueFullPipeline({ profile: 'totally not json at all' });

    // The message must name the failure + carry a snippet so the resulting 500
    // is debuggable — a bare "Unexpected token" SyntaxError is not.
    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Bad' })).rejects.toThrow(
      /unparseable JSON/,
    );
  });
});

// ─── No key / unconfigured ───────────────────────────────────

describe('researchAndFormulatePrompt — missing API key', () => {
  it('throws "OPENAI_API_KEY is not configured" before any fetch', async () => {
    await expect(researchAndFormulatePrompt(noKeyEnv(), { businessName: 'Acme' })).rejects.toThrow(
      'OPENAI_API_KEY is not configured',
    );

    expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
  });
});

// ─── Non-200 API error ───────────────────────────────────────

describe('researchAndFormulatePrompt — non-200 response', () => {
  it('throws with status + body and fires an error analytics capture', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      chatResponse('rate limited', { ok: false, status: 429 }),
    );

    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' })).rejects.toThrow(
      'OpenAI API error 429',
    );

    // The first (and only) call should have produced an error capture.
    const errorCapture = mockCaptureLLMCall.mock.calls.find(
      (c) => (c[1] as { status?: string }).status === 'error',
    );
    expect(errorCapture).toBeDefined();
    expect((errorCapture![1] as { errorMessage: string }).errorMessage).toContain('429');
  });
});

// ─── Network-throw resilience ────────────────────────────────

describe('researchAndFormulatePrompt — network throw', () => {
  it('bubbles the fetch rejection and fires an error analytics capture', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' })).rejects.toThrow(
      'ECONNRESET',
    );

    const errorCapture = mockCaptureLLMCall.mock.calls.find(
      (c) => (c[1] as { status?: string }).status === 'error',
    );
    expect(errorCapture).toBeDefined();
    expect((errorCapture![1] as { errorMessage: string }).errorMessage).toBe('ECONNRESET');
  });
});

// ─── Empty / malformed success body ──────────────────────────

describe('researchAndFormulatePrompt — empty choice content', () => {
  it('throws from extractJson when the choice content is empty string', async () => {
    // Empty content '' → extractJson('') → JSON.parse('') throws.
    (global.fetch as jest.Mock).mockResolvedValueOnce(chatResponse(''));

    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' })).rejects.toThrow();
  });

  it('treats a response with no choices array as empty content', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => '{}',
    });

    // No choices → content '' → extractJson throws.
    await expect(researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' })).rejects.toThrow();
  });
});

// ─── Analytics success capture + swallow ─────────────────────

describe('researchAndFormulatePrompt — analytics', () => {
  it('fires a success capture with token usage + promptId + provider on each step', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' });

    // One success capture per OpenAI call.
    const okCaptures = mockCaptureLLMCall.mock.calls.filter(
      (c) => (c[1] as { status?: string }).status === 'ok',
    );
    expect(okCaptures.length).toBe(5);

    const first = okCaptures[0][1] as {
      provider: string;
      inputTokens: number;
      outputTokens: number;
      promptId: string;
      gatewayUsed: boolean;
    };
    expect(first.provider).toBe('openai');
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(50);
    expect(first.promptId).toBe('openai_research:profile');
    expect(first.gatewayUsed).toBe(false); // no CF_ACCOUNT_ID in keyEnv() → gateway inactive → direct
  });

  it('reports gatewayUsed:true when the AI Gateway is active (was hardcoded false — AL-777)', async () => {
    // isGatewayActive = !!CF_ACCOUNT_ID && AI_GATEWAY_ENABLED !== 'false'. With CF_ACCOUNT_ID set the
    // gateway routes the call, so the success capture must report the REAL routing. RED before the
    // fix: the success capture hardcoded gatewayUsed:false, poisoning gateway-vs-direct analytics.
    queueFullPipeline();
    await researchAndFormulatePrompt(keyEnv({ CF_ACCOUNT_ID: 'acct-123' }), { businessName: 'Acme' });
    const ok = mockCaptureLLMCall.mock.calls.filter((c) => (c[1] as { status?: string }).status === 'ok');
    expect(ok.length).toBe(5);
    expect(ok.every((c) => (c[1] as { gatewayUsed?: boolean }).gatewayUsed === true)).toBe(true);
  });

  it('estimateOpenAiCost prices gpt-4o-mini at the MINI rate, not gpt-4o (AL-777 substring mis-price)', () => {
    // model.includes('gpt-4o') matched gpt-4o-mini → the 16.7×-pricier gpt-4o rate. Most-specific
    // (longest-key) match now resolves each model to its own price.
    const mini = estimateOpenAiCost('gpt-4o-mini', 1_000_000, 1_000_000); // 0.15 + 0.6
    const full = estimateOpenAiCost('gpt-4o', 1_000_000, 1_000_000); // 2.5 + 10
    expect(mini).toBeCloseTo(0.75, 6);
    expect(full).toBeCloseTo(12.5, 6);
    expect(mini).toBeLessThan(full); // mini must NOT be mis-priced up to the gpt-4o rate
    // versioned suffixes still resolve to their base rate
    expect(estimateOpenAiCost('gpt-4o-mini-2024-07-18', 1_000_000, 0)).toBeCloseTo(0.15, 6);
    expect(estimateOpenAiCost('gpt-4o-2024-05-13', 1_000_000, 0)).toBeCloseTo(2.5, 6);
  });

  it('swallows analytics failures — pipeline still resolves', async () => {
    queueFullPipeline();
    mockCaptureLLMCall.mockRejectedValue(new Error('posthog down'));

    const result = await researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' });
    expect(result.expertPrompt).toBe(EXPERT);
  });
});

// ─── traceContext passthrough ────────────────────────────────

describe('researchAndFormulatePrompt — traceContext passthrough', () => {
  it('uses orgId as distinctId and forwards traceId on captures', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), {
      businessName: 'Acme',
      traceContext: { orgId: 'org-7', userId: 'user-1', traceId: 'trace-xyz' } as never,
    });

    const cap = mockCaptureLLMCall.mock.calls[0][1] as {
      distinctId: string;
      traceId: string;
    };
    expect(cap.distinctId).toBe('org-7');
    expect(cap.traceId).toBe('trace-xyz');
  });

  it('falls back to "system" distinctId when no traceContext supplied', async () => {
    queueFullPipeline();

    await researchAndFormulatePrompt(keyEnv(), { businessName: 'Acme' });

    const cap = mockCaptureLLMCall.mock.calls[0][1] as { distinctId: string };
    expect(cap.distinctId).toBe('system');
  });
});
