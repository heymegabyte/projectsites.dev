/**
 * Tests for the model_registry feature module.
 * Covers: service unit tests, flag-off 404, Bearer psk_ auth (401 OpenAI error
 * envelope when missing/invalid), flag-on full list (13 aliases + 4 virtual
 * service models), GET /v1/models/:id lookup (200 known incl. virtual,
 * OpenAI-shaped 404 unknown), availability logic per-alias, provider env-key
 * checks. Campaign lane-4 (fire-56): the /v1/models contract mirrors
 * e2e/ai-api/openai-compat.e2e.ts.
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

import {
  MODEL_ALIASES,
  PROVIDERS,
  VIRTUAL_SERVICE_MODELS,
  VIRTUAL_MODEL_CREATED,
  aliasAvailable,
  providerAvailable,
  FLAG_KEY,
} from '../service.js';
import { modelRegistry } from '../handlers.js';

const VIRTUAL_IDS = [
  'projectsites-auto',
  'projectsites-fast',
  'projectsites-balanced',
  'projectsites-premium',
] as const;

/** A syntactically valid psk_ token (64 hex chars) that passes extractBearerToken. */
const VALID_KEY = `psk_${'a'.repeat(64)}`;
const AUTH = { Authorization: `Bearer ${VALID_KEY}` };

// ---------------------------------------------------------------------------
// App factory — mounts modelRegistry at root (the handler owns the /v1/models path)
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

/** Authed GET (default) — the happy-path caller with a valid Bearer psk_ token. */
const GET = (envOverrides: Record<string, unknown> = {}, path = '/v1/models') =>
  app(envOverrides).request(path, { method: 'GET', headers: AUTH });

/** Unauthed GET — no Authorization header at all. */
const GET_NO_AUTH = (path = '/v1/models') => app().request(path, { method: 'GET' });

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerifyApiToken.mockReset();
  // Default: flag on + token valid — individual tests override.
  mockIsFlagOn.mockResolvedValue(true);
  mockVerifyApiToken.mockResolvedValue({
    id: 'tok-1',
    org_id: 'org-1',
    scopes: '["me:read"]',
  });
});

// ---------------------------------------------------------------------------
// 1. Service unit tests — providerAvailable
// ---------------------------------------------------------------------------
describe('providerAvailable()', () => {
  it('returns false for unknown provider id', () => {
    expect(providerAvailable({}, 'nonexistent')).toBe(false);
  });

  it('returns false for deepseek when DEEPSEEK_API_KEY is missing', () => {
    expect(providerAvailable({}, 'deepseek')).toBe(false);
  });

  it('returns true for deepseek when DEEPSEEK_API_KEY is set', () => {
    expect(providerAvailable({ DEEPSEEK_API_KEY: 'sk-xxx' }, 'deepseek')).toBe(true);
  });

  it('returns false for anthropic when ANTHROPIC_API_KEY is missing', () => {
    expect(providerAvailable({}, 'anthropic')).toBe(false);
  });

  it('returns true for anthropic when ANTHROPIC_API_KEY is set', () => {
    expect(providerAvailable({ ANTHROPIC_API_KEY: 'sk-ant-xxx' }, 'anthropic')).toBe(true);
  });

  it('returns false for workers-ai when AI binding is absent', () => {
    expect(providerAvailable({}, 'workers-ai')).toBe(false);
  });

  it('returns true for workers-ai when AI binding is present', () => {
    expect(providerAvailable({ AI: {} }, 'workers-ai')).toBe(true);
  });

  it('returns false for ollama when OLLAMA_BASE_URL is missing', () => {
    expect(providerAvailable({}, 'ollama')).toBe(false);
  });

  it('returns true for ollama when OLLAMA_BASE_URL is set', () => {
    expect(providerAvailable({ OLLAMA_BASE_URL: 'http://localhost:11434' }, 'ollama')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Service unit tests — aliasAvailable
// ---------------------------------------------------------------------------
describe('aliasAvailable()', () => {
  const edgeFast = MODEL_ALIASES.find((a) => a.id === 'edge-fast')!;
  const premiumQuorum = MODEL_ALIASES.find((a) => a.id === 'premium-quorum')!;
  const deepseekFast = MODEL_ALIASES.find((a) => a.id === 'deepseek-fast')!;
  const claudeArchitect = MODEL_ALIASES.find((a) => a.id === 'claude-architect')!;

  it('edge-fast is unavailable when AI binding is absent', () => {
    expect(aliasAvailable({}, edgeFast)).toBe(false);
  });

  it('edge-fast is available when AI binding is present', () => {
    expect(aliasAvailable({ AI: {} }, edgeFast)).toBe(true);
  });

  it('premium-quorum is unavailable when no provider key is set', () => {
    expect(aliasAvailable({}, premiumQuorum)).toBe(false);
  });

  it('premium-quorum is available when anthropic key is set', () => {
    expect(aliasAvailable({ ANTHROPIC_API_KEY: 'x' }, premiumQuorum)).toBe(true);
  });

  it('premium-quorum is available when only deepseek key is set', () => {
    expect(aliasAvailable({ DEEPSEEK_API_KEY: 'x' }, premiumQuorum)).toBe(true);
  });

  it('deepseek-fast is available when DEEPSEEK_API_KEY set', () => {
    expect(aliasAvailable({ DEEPSEEK_API_KEY: 'x' }, deepseekFast)).toBe(true);
  });

  it('claude-architect is unavailable without ANTHROPIC_API_KEY', () => {
    expect(aliasAvailable({}, claudeArchitect)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Flag off → 404 (dark — never leak, regardless of auth)
// ---------------------------------------------------------------------------
describe('GET /v1/models — flag gate', () => {
  it('returns 404 when the model_registry flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/models/:id also 404s dark when the flag is off (never leaks auth state)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await GET({}, '/v1/models/projectsites-auto');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockVerifyApiToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Bearer psk_ auth — 401 OpenAI error envelope (campaign lane-4 contract)
// ---------------------------------------------------------------------------
describe('GET /v1/models — Bearer psk_ auth', () => {
  it('401s with an OpenAI error envelope when Authorization is missing', async () => {
    const res = await GET_NO_AUTH();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('401s when the Bearer token is not a well-formed psk_ token', async () => {
    const res = await app().request('/v1/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer psk_totally_invalid_key_xxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message.length).toBeGreaterThan(0);
    // Malformed token never reaches the DB.
    expect(mockVerifyApiToken).not.toHaveBeenCalled();
  });

  it('401s when the token is well-formed but revoked/unknown (verifyApiToken → null)', async () => {
    mockVerifyApiToken.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('GET /v1/models/:id enforces the same 401', async () => {
    const res = await GET_NO_AUTH('/v1/models/projectsites-fast');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Flag on → full list (13 aliases + 4 virtual service models)
// ---------------------------------------------------------------------------
describe('GET /v1/models — flag on, no env keys', () => {
  it('returns 200 with object:list', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe('list');
  });

  it('data includes all 13 alias ids AND the 4 virtual service models (17 total)', async () => {
    const res = await GET();
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((d) => d.id);
    for (const vid of VIRTUAL_IDS) {
      expect(ids).toContain(vid);
    }
    expect(ids).toContain('deepseek-fast');
    expect(ids).toContain('deepseek-code');
    expect(ids).toContain('premium-quorum');
    expect(ids).toContain('grok-live-business');
    expect(ids).toContain('gemini-grounded');
    expect(ids).toContain('edge-fast');
    expect(ids).toContain('claude-architect');
    expect(ids).toHaveLength(17);
  });

  it('each entry has object:model and required fields', async () => {
    const res = await GET();
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    for (const entry of body.data) {
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('projectsites');
      expect(typeof entry.created).toBe('number');
      expect(typeof entry._available).toBe('boolean');
      expect(Array.isArray(entry._providers)).toBe(true);
      expect(typeof entry._tier).toBe('string');
    }
  });

  it('virtual service models carry the created epoch, service tier, and are always available', async () => {
    const res = await GET();
    const body = (await res.json()) as {
      data: Array<{ id: string; created: number; _tier: string; _available: boolean }>;
    };
    for (const vid of VIRTUAL_IDS) {
      const entry = body.data.find((d) => d.id === vid)!;
      expect(entry).toBeDefined();
      expect(entry.created).toBe(VIRTUAL_MODEL_CREATED);
      expect(entry.created).toBeGreaterThan(0);
      expect(entry._tier).toBe('service');
      expect(entry._available).toBe(true);
    }
  });

  it('alias entries keep created:0 (unchanged pre-existing contract)', async () => {
    const res = await GET();
    const body = (await res.json()) as { data: Array<{ id: string; created: number }> };
    const alias = body.data.find((d) => d.id === 'edge-fast')!;
    expect(alias.created).toBe(0);
  });

  it('premium aliases are _available:false with no env keys', async () => {
    const res = await GET(); // env = {}
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const premiumQuorum = body.data.find((d) => d.id === 'premium-quorum')!;
    expect(premiumQuorum._available).toBe(false);
    const claudeArchitect = body.data.find((d) => d.id === 'claude-architect')!;
    expect(claudeArchitect._available).toBe(false);
  });

  it('edge aliases reflect AI binding absence', async () => {
    const res = await GET(); // no AI binding
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const edgeFast = body.data.find((d) => d.id === 'edge-fast')!;
    expect(edgeFast._available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. GET /v1/models/:id — lookup (200 known incl. virtual, OpenAI-shaped 404)
// ---------------------------------------------------------------------------
describe('GET /v1/models/:id', () => {
  it('returns 200 with the OpenAI model shape for every virtual id', async () => {
    for (const vid of VIRTUAL_IDS) {
      const res = await GET({}, `/v1/models/${vid}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        object: string;
        created: number;
        owned_by: string;
      };
      expect(body.id).toBe(vid);
      expect(body.object).toBe('model');
      expect(body.created).toBe(VIRTUAL_MODEL_CREATED);
      expect(body.owned_by).toBe('projectsites');
    }
  });

  it('returns 200 for a real registry alias with availability metadata', async () => {
    const res = await GET({ DEEPSEEK_API_KEY: 'sk-x' }, '/v1/models/deepseek-fast');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      owned_by: string;
      _available: boolean;
    };
    expect(body.id).toBe('deepseek-fast');
    expect(body.object).toBe('model');
    expect(body.owned_by).toBe('projectsites');
    expect(body._available).toBe(true);
  });

  it('returns an OpenAI-shaped 404 error for an unknown model id', async () => {
    const res = await GET({}, '/v1/models/gpt-does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { message: string; type: string; param: string | null; code: string };
    };
    expect(body.error.message).toContain('gpt-does-not-exist');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.param).toBe('model');
    expect(body.error.code).toBe('model_not_found');
  });
});

// ---------------------------------------------------------------------------
// 7. Availability reflected correctly when env keys provided
// ---------------------------------------------------------------------------
describe('GET /v1/models — with provider env keys', () => {
  it('deepseek-fast is _available:true when DEEPSEEK_API_KEY set', async () => {
    const res = await GET({ DEEPSEEK_API_KEY: 'sk-deepseek-test' });
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const entry = body.data.find((d) => d.id === 'deepseek-fast')!;
    expect(entry._available).toBe(true);
  });

  it('edge-fast is _available:true when AI binding present', async () => {
    const res = await GET({ AI: { run: () => {} } });
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const entry = body.data.find((d) => d.id === 'edge-fast')!;
    expect(entry._available).toBe(true);
  });

  it('premium-quorum is _available:true when only OPENAI_API_KEY set', async () => {
    const res = await GET({ OPENAI_API_KEY: 'sk-openai-test' });
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const entry = body.data.find((d) => d.id === 'premium-quorum')!;
    expect(entry._available).toBe(true);
  });

  it('grok-live-business is _available:true when XAI_API_KEY set', async () => {
    const res = await GET({ XAI_API_KEY: 'sk-xai-test' });
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const entry = body.data.find((d) => d.id === 'grok-live-business')!;
    expect(entry._available).toBe(true);
  });

  it('claude-architect is _available:true when ANTHROPIC_API_KEY set', async () => {
    const res = await GET({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const body = (await res.json()) as { data: Array<{ id: string; _available: boolean }> };
    const entry = body.data.find((d) => d.id === 'claude-architect')!;
    expect(entry._available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Registry integrity
// ---------------------------------------------------------------------------
describe('Registry integrity', () => {
  it('exports the correct FLAG_KEY', () => {
    expect(FLAG_KEY).toBe('model_registry');
  });

  it('PROVIDERS has exactly 8 entries with unique ids', () => {
    expect(PROVIDERS).toHaveLength(8);
    const ids = new Set(PROVIDERS.map((p) => p.id));
    expect(ids.size).toBe(8);
  });

  it('MODEL_ALIASES has exactly 13 entries with unique ids', () => {
    expect(MODEL_ALIASES).toHaveLength(13);
    const ids = new Set(MODEL_ALIASES.map((a) => a.id));
    expect(ids.size).toBe(13);
  });

  it('VIRTUAL_SERVICE_MODELS has exactly the 4 campaign ids, unique, no alias collision', () => {
    expect(VIRTUAL_SERVICE_MODELS.map((v) => v.id)).toEqual([...VIRTUAL_IDS]);
    const aliasIds = new Set(MODEL_ALIASES.map((a) => a.id));
    for (const v of VIRTUAL_SERVICE_MODELS) {
      expect(aliasIds.has(v.id)).toBe(false);
    }
  });

  it('every alias.providers entry maps to a known provider id', () => {
    const providerIds = new Set(PROVIDERS.map((p) => p.id));
    for (const alias of MODEL_ALIASES) {
      for (const pid of alias.providers) {
        expect(providerIds.has(pid)).toBe(true);
      }
    }
  });
});
