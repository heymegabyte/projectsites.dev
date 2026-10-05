import type { Env } from '../types/env.js';
import {
  DEFAULT_GATEWAY_NAME,
  DEFAULT_CACHE_TTL_SECONDS,
  GatewayCallOptionsSchema,
  isGatewayActive,
  gatewayName,
  gatewayBaseUrl,
  gatewayUrl,
  buildGatewayHeaders,
  gatewayFetch,
  gatewayMetadata,
} from '../services/ai_gateway.js';

const ACCT = '84fa0d1b16ff8086dd958c468ce7fd59';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    CF_ACCOUNT_ID: ACCT,
    AI_GATEWAY_ENABLED: 'true',
    ENVIRONMENT: 'test',
    ...overrides,
  } as unknown as Env;
}

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── isGatewayActive ──────────────────────────────────────────

describe('isGatewayActive', () => {
  it('is active by default when CF_ACCOUNT_ID is set', () => {
    expect(isGatewayActive(makeEnv({ AI_GATEWAY_ENABLED: undefined }))).toBe(true);
  });

  it('is active when AI_GATEWAY_ENABLED is "true"', () => {
    expect(isGatewayActive(makeEnv({ AI_GATEWAY_ENABLED: 'true' }))).toBe(true);
  });

  it('is INACTIVE only when AI_GATEWAY_ENABLED is exactly "false"', () => {
    expect(isGatewayActive(makeEnv({ AI_GATEWAY_ENABLED: 'false' }))).toBe(false);
  });

  it('is inactive when CF_ACCOUNT_ID is absent', () => {
    expect(isGatewayActive(makeEnv({ CF_ACCOUNT_ID: undefined }))).toBe(false);
  });
});

// ─── gatewayName ──────────────────────────────────────────────

describe('gatewayName', () => {
  it('defaults to "projectsites"', () => {
    expect(gatewayName(makeEnv())).toBe(DEFAULT_GATEWAY_NAME);
    expect(gatewayName(makeEnv())).toBe('projectsites');
  });

  it('uses AI_GATEWAY_NAME when set', () => {
    expect(gatewayName(makeEnv({ AI_GATEWAY_NAME: 'custom-gw' }))).toBe('custom-gw');
  });

  it('falls back to default for blank AI_GATEWAY_NAME', () => {
    expect(gatewayName(makeEnv({ AI_GATEWAY_NAME: '   ' }))).toBe('projectsites');
  });
});

// ─── URL construction ─────────────────────────────────────────

describe('gatewayBaseUrl / gatewayUrl', () => {
  it('builds the gateway URL for openai when active', () => {
    expect(gatewayBaseUrl(makeEnv(), 'openai')).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/projectsites/openai`,
    );
  });

  it('builds the gateway URL for anthropic when active', () => {
    expect(gatewayBaseUrl(makeEnv(), 'anthropic')).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/projectsites/anthropic`,
    );
  });

  it('honors a custom gateway name in the URL', () => {
    expect(gatewayBaseUrl(makeEnv({ AI_GATEWAY_NAME: 'gw2' }), 'openai')).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/gw2/openai`,
    );
  });

  it('returns the direct vendor base when inactive', () => {
    const env = makeEnv({ AI_GATEWAY_ENABLED: 'false' });
    expect(gatewayBaseUrl(env, 'openai')).toBe('https://api.openai.com');
    expect(gatewayBaseUrl(env, 'anthropic')).toBe('https://api.anthropic.com');
  });

  it('appends the path suffix in gatewayUrl', () => {
    expect(gatewayUrl(makeEnv(), 'openai', '/v1/chat/completions')).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/projectsites/openai/v1/chat/completions`,
    );
  });
});

// ─── GatewayCallOptionsSchema ─────────────────────────────────

describe('GatewayCallOptionsSchema', () => {
  it('accepts a valid cacheTtl', () => {
    expect(GatewayCallOptionsSchema.parse({ cacheTtl: 3600 }).cacheTtl).toBe(3600);
  });

  it('rejects a negative cacheTtl', () => {
    expect(() => GatewayCallOptionsSchema.parse({ cacheTtl: -1 })).toThrow();
  });

  it('rejects a non-integer cacheTtl', () => {
    expect(() => GatewayCallOptionsSchema.parse({ cacheTtl: 1.5 })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => GatewayCallOptionsSchema.parse({ bogus: true } as never)).toThrow();
  });

  it('accepts metadata with string/number/boolean values', () => {
    const parsed = GatewayCallOptionsSchema.parse({
      metadata: { orgId: 'o_1', n: 2, flag: true },
    });
    expect(parsed.metadata).toEqual({ orgId: 'o_1', n: 2, flag: true });
  });
});

// ─── buildGatewayHeaders ──────────────────────────────────────

describe('buildGatewayHeaders', () => {
  it('injects default cache-ttl header when active and no options', () => {
    const h = buildGatewayHeaders(makeEnv(), { Authorization: 'Bearer x' });
    expect(h.get('cf-aig-cache-ttl')).toBe(String(DEFAULT_CACHE_TTL_SECONDS));
    expect(h.get('Authorization')).toBe('Bearer x');
  });

  it('injects an explicit cache-ttl', () => {
    const h = buildGatewayHeaders(makeEnv(), {}, { cacheTtl: 120 });
    expect(h.get('cf-aig-cache-ttl')).toBe('120');
  });

  it('sets skip-cache and omits ttl when skipCache=true', () => {
    const h = buildGatewayHeaders(makeEnv(), {}, { skipCache: true });
    expect(h.get('cf-aig-skip-cache')).toBe('true');
    expect(h.get('cf-aig-cache-ttl')).toBeNull();
  });

  it('serializes metadata into cf-aig-metadata', () => {
    const h = buildGatewayHeaders(makeEnv(), {}, { metadata: { orgId: 'o_1' } });
    expect(JSON.parse(h.get('cf-aig-metadata')!)).toEqual({ orgId: 'o_1' });
  });

  it('adds NO cf-aig-* headers when the gateway is inactive', () => {
    const h = buildGatewayHeaders(
      makeEnv({ AI_GATEWAY_ENABLED: 'false' }),
      { Authorization: 'Bearer x' },
      { cacheTtl: 999, metadata: { a: 1 } },
    );
    expect(h.get('cf-aig-cache-ttl')).toBeNull();
    expect(h.get('cf-aig-metadata')).toBeNull();
    expect(h.get('Authorization')).toBe('Bearer x');
  });
});

// ─── gatewayFetch — happy path + headers on the wire ──────────

describe('gatewayFetch', () => {
  it('fetches the gateway URL with cache headers and returns gatewayUsed=true', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' },
      { cacheTtl: 3600, metadata: { promptId: 'research_brand' } },
    );

    expect(response.status).toBe(200);
    expect(gatewayUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCT}/projectsites/openai/v1/chat/completions`,
    );
    const headers = init.headers as Headers;
    expect(headers.get('cf-aig-cache-ttl')).toBe('3600');
    expect(JSON.parse(headers.get('cf-aig-metadata')!)).toEqual({ promptId: 'research_brand' });
    expect(headers.get('Authorization')).toBe('Bearer k');
  });

  it('calls the direct vendor URL (no cf-aig headers) when inactive', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const { gatewayUsed } = await gatewayFetch(
      makeEnv({ AI_GATEWAY_ENABLED: 'false' }),
      'anthropic',
      '/v1/messages',
      { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{}' },
    );

    expect(gatewayUsed).toBe(false);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Headers).get('cf-aig-cache-ttl')).toBeNull();
  });

  it('rejects invalid options before any fetch', async () => {
    await expect(
      gatewayFetch(
        makeEnv(),
        'openai',
        '/v1/chat/completions',
        { method: 'POST' },
        {
          cacheTtl: -5,
        },
      ),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── gatewayFetch — fallback on gateway 5xx ───────────────────

describe('gatewayFetch fallback', () => {
  it('falls back to direct vendor URL once on gateway 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('gateway down', { status: 502 }))
      .mockResolvedValueOnce(okResponse());

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call → gateway; second call → direct vendor with fallback marker.
    expect(mockFetch.mock.calls[0][0]).toContain('gateway.ai.cloudflare.com');
    const [directUrl, directInit] = mockFetch.mock.calls[1];
    expect(directUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect((directInit.headers as Headers).get('X-PS-Gateway-Fallback')).toBe('true');
    // Fallback strips cf-aig-* headers.
    expect((directInit.headers as Headers).get('cf-aig-cache-ttl')).toBeNull();
  });

  it('does NOT fall back on a genuine VENDOR 4xx (real vendor error passes through)', async () => {
    // A VENDOR-origin 401 (OpenAI/Anthropic rejecting a bad key) has the vendor's
    // own error shape — NOT the gateway's `code: 2009`. The direct URL would reject
    // it identically, so surface it (no wasted second request).
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }),
        {
          status: 401,
        },
      ),
    );

    const { response, gatewayUsed } = await gatewayFetch(makeEnv(), 'anthropic', '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'bad' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(gatewayUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back when gateway is inactive (no double-call)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('down', { status: 503 }));

    const { gatewayUsed } = await gatewayFetch(
      makeEnv({ AI_GATEWAY_ENABLED: 'false' }),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: {}, body: '{}' },
    );

    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── gatewayFetch — fallback on gateway-ORIGIN auth 401/403 (fire-186) ────────

describe('gatewayFetch gateway-auth fallback', () => {
  /**
   * The Cloudflare AI Gateway in AUTHENTICATED mode rejects every request lacking
   * `cf-aig-authorization` with its OWN 401 (`name:"AiGatewayError"`,
   * `internalCode:2009`). That is NOT a vendor rejection — the gateway never
   * forwarded to the vendor — so the valid vendor key still works against the
   * direct URL.
   *
   * This is the EXACT body prod returned (captured live from POST /api/resolve):
   * `error` is an ARRAY `[{code:2009}]`, and `2009` lives in the top-level
   * `internalCode` + `name:"AiGatewayError"` — NOT a top-level `code`.
   */
  const REAL_GATEWAY_401_BODY = {
    success: false,
    result: [],
    messages: [],
    error: [{ code: 2009, message: 'Unauthorized' }],
    name: 'AiGatewayError',
    httpCode: 401,
    internalCode: 2009,
    message: 'Unauthorized',
    description: 'Unauthorized',
  };
  function gatewayAuth401(): Response {
    return new Response(JSON.stringify(REAL_GATEWAY_401_BODY), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  function gatewayAuth403(): Response {
    return new Response(
      JSON.stringify({ ...REAL_GATEWAY_401_BODY, httpCode: 403, message: 'Forbidden' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  it('(a0) falls back on the EXACT real prod gateway-401 body (error is an ARRAY, code in internalCode)', async () => {
    // This literal body is why the first fix missed: `error:[{code:2009}]` (array,
    // not object) + `internalCode:2009`/`name:"AiGatewayError"` at top level.
    mockFetch.mockResolvedValueOnce(gatewayAuth401()).mockResolvedValueOnce(okResponse());

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer valid-key' }, body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('(a) falls back to the direct vendor URL on a gateway-origin 401 → gatewayUsed=false', async () => {
    mockFetch.mockResolvedValueOnce(gatewayAuth401()).mockResolvedValueOnce(okResponse());

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer valid-key' }, body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect(mockFetch.mock.calls[0][0]).toContain('gateway.ai.cloudflare.com');
    const [directUrl, directInit] = mockFetch.mock.calls[1];
    expect(directUrl).toBe('https://api.openai.com/v1/chat/completions');
    // Reuses the valid vendor auth header against the direct URL.
    expect((directInit.headers as Headers).get('Authorization')).toBe('Bearer valid-key');
    // Marks the fallback + strips cf-aig-* headers.
    expect((directInit.headers as Headers).get('X-PS-Gateway-Fallback')).toBe('true');
    expect((directInit.headers as Headers).get('cf-aig-cache-ttl')).toBeNull();
  });

  it('(b) falls back to the direct vendor URL on a gateway-origin 403 → gatewayUsed=false', async () => {
    mockFetch.mockResolvedValueOnce(gatewayAuth403()).mockResolvedValueOnce(okResponse());

    const { response, gatewayUsed } = await gatewayFetch(makeEnv(), 'anthropic', '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'valid-key' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [directUrl, directInit] = mockFetch.mock.calls[1];
    expect(directUrl).toBe('https://api.anthropic.com/v1/messages');
    expect((directInit.headers as Headers).get('x-api-key')).toBe('valid-key');
  });

  it('(e) surfaces the status when the gateway 401s AND the direct vendor ALSO 401s (no infinite retry)', async () => {
    // Gateway-auth 401 → one fallback to direct → direct ALSO rejects (genuinely bad
    // key). The fallback result is returned verbatim; there is no third attempt.
    mockFetch
      .mockResolvedValueOnce(gatewayAuth401())
      .mockResolvedValueOnce(new Response('bad key', { status: 401 }));

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer bad' }, body: '{}' },
    );

    expect(response.status).toBe(401);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT fall back when gateway is inactive even on a 401 (no double-call)', async () => {
    mockFetch.mockResolvedValueOnce(gatewayAuth401());

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv({ AI_GATEWAY_ENABLED: 'false' }),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' },
    );

    // Gateway inactive → the 401 came straight from the direct vendor; surface it.
    expect(response.status).toBe(401);
    expect(gatewayUsed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT consume the response body of a passed-through gateway 200 (clone-safe)', async () => {
    // The gateway-origin probe clones before reading — a happy-path 200 body must
    // still be readable by the caller.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    );

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' },
    );

    expect(gatewayUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({ hello: 'world' });
  });

  it('(f) does NOT fall back on a genuine vendor 401 (vendor error shape, not code 2009)', async () => {
    // OpenAI's own invalid-key rejection — no gateway `code: 2009`. Surface it
    // directly; the direct URL would reject it identically (no wasted request).
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'invalid_api_key', type: 'invalid_request_error' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer bad' }, body: '{}' },
    );

    expect(response.status).toBe(401);
    expect(gatewayUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('(f) does NOT fall back on a genuine vendor 429 rate-limit (not an auth status)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    const { response, gatewayUsed } = await gatewayFetch(
      makeEnv(),
      'openai',
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer k' },
        body: '{}',
      },
    );

    expect(response.status).toBe(429);
    expect(gatewayUsed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── gatewayMetadata ──────────────────────────────────────────

describe('gatewayMetadata', () => {
  it('returns an empty object for no context', () => {
    expect(gatewayMetadata()).toEqual({});
  });

  it('drops undefined fields', () => {
    expect(gatewayMetadata({ orgId: 'o_1', promptId: undefined })).toEqual({ orgId: 'o_1' });
  });

  it('maps all known trace fields', () => {
    expect(gatewayMetadata({ orgId: 'o', userId: 'u', traceId: 't', promptId: 'p' })).toEqual({
      orgId: 'o',
      userId: 'u',
      traceId: 't',
      promptId: 'p',
    });
  });
});
