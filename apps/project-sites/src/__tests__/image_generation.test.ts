/**
 * Unit coverage for services/image_generation.ts — the best-value image path.
 *
 * `callDallE3` (name kept for callers) now generates cheapest-capable-model first:
 * square requests use Flux-1-schnell on Workers AI (`env.AI.run`); wide/tall requests
 * + any Flux miss escalate to OpenAI `gpt-image-1` via the gateway (returns b64_json).
 * Covers: AI-binding Flux success, Flux→OpenAI fallback, wide-hero size mapping,
 * gpt-image-1 request shape, and null/error handling.
 */

import { callDallE3, callFluxSchnell, callOpenAiImage } from '../services/image_generation';
import type { Env } from '../types/env.js';

/** base64('hello') → 5 bytes; used to assert decode-to-ArrayBuffer. */
const B64_HELLO = 'aGVsbG8=';

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    OPENAI_API_KEY: 'sk-test-key',
    SITES_BUCKET: {} as unknown,
    ...overrides,
  } as unknown as Env;
}

/** An env whose Workers-AI binding returns a Flux image. */
function withFlux(
  image: string | null = B64_HELLO,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const run = jest.fn(async () => (image === null ? {} : { image }));
  return { env: makeEnv({ AI: { run } as unknown, ...overrides }), run };
}

/** A gpt-image-1 generations response returning inline b64. */
function stubOpenAiB64(b64 = B64_HELLO) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/images/generations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: b64 }] }),
        text: async () => '',
      } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('image_generation service', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('callFluxSchnell (cheap default)', () => {
    it('returns decoded bytes from Workers AI Flux-1-schnell', async () => {
      const { env, run } = withFlux();
      const result = await callFluxSchnell(env, 'a storefront');
      expect(result).not.toBeNull();
      expect((result as ArrayBuffer).byteLength).toBe(5); // 'hello'
      expect(run).toHaveBeenCalledWith(
        '@cf/black-forest-labs/flux-1-schnell',
        expect.objectContaining({ steps: 8 }),
      );
    });

    it('returns null when there is no AI binding (caller falls back)', async () => {
      expect(await callFluxSchnell(makeEnv(), 'p')).toBeNull();
    });

    it('returns null + warns when the Flux run throws', async () => {
      const env = makeEnv({
        AI: {
          run: jest.fn(async () => {
            throw new Error('AI down');
          }),
        } as unknown,
      });
      expect(await callFluxSchnell(env, 'p')).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Flux-1-schnell failed'),
        expect.any(Error),
      );
    });
  });

  describe('callDallE3 (orchestrator)', () => {
    it('uses Flux for a square request and never calls OpenAI', async () => {
      const fetchMock = stubOpenAiB64();
      global.fetch = fetchMock;
      const { env, run } = withFlux();
      const result = await callDallE3(env, 'p', '1024x1024');
      expect((result as ArrayBuffer).byteLength).toBe(5);
      expect(run).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled(); // premium path untouched when Flux succeeds
    });

    it('falls back to gpt-image-1 when Flux misses on a square request', async () => {
      global.fetch = stubOpenAiB64();
      const { env } = withFlux(null); // Flux returns {} → null → fallback
      const result = await callDallE3(env, 'p', '1024x1024');
      expect((result as ArrayBuffer).byteLength).toBe(5);
    });

    it('routes wide heroes straight to gpt-image-1 with the mapped size (never Flux)', async () => {
      const fetchMock = stubOpenAiB64();
      global.fetch = fetchMock;
      const { env, run } = withFlux();
      const result = await callDallE3(env, 'hero prompt', '1792x1024');
      expect((result as ArrayBuffer).byteLength).toBe(5);
      expect(run).not.toHaveBeenCalled(); // Flux-schnell can't frame wide → skipped
      const body = JSON.parse((fetchMock as jest.Mock).mock.calls[0][1].body as string);
      expect(body.model).toBe('gpt-image-1');
      expect(body.size).toBe('1536x1024'); // 1792x1024 → gpt-image-1's widest
      expect(body.response_format).toBeUndefined(); // gpt-image-1 rejects response_format
      expect(body.prompt).toContain('hero prompt');
    });
  });

  describe('callOpenAiImage (premium escalation)', () => {
    it('returns null + warns when OPENAI_API_KEY is unset', async () => {
      const result = await callOpenAiImage(
        makeEnv({ OPENAI_API_KEY: undefined }),
        'p',
        '1024x1024',
      );
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY not set'));
    });

    it('sends Authorization through the gateway + decodes b64_json', async () => {
      const fetchMock = stubOpenAiB64();
      global.fetch = fetchMock;
      const result = await callOpenAiImage(makeEnv(), 'p', '1024x1024');
      expect((result as ArrayBuffer).byteLength).toBe(5);
      const headers = new Headers((fetchMock as jest.Mock).mock.calls[0][1].headers);
      expect(headers.get('Authorization')).toBe('Bearer sk-test-key');
    });

    it('returns null + warns on a non-200 generations response', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      })) as unknown as typeof fetch;
      const result = await callOpenAiImage(makeEnv(), 'p', '1024x1024');
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('429'));
    });

    it('returns null when the payload has neither b64_json nor url', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{}] }),
      })) as unknown as typeof fetch;
      expect(await callOpenAiImage(makeEnv(), 'p', '1024x1024')).toBeNull();
    });
  });
});
