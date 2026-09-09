/**
 * Unit tests for integration health endpoints.
 *
 * Tests the route handler logic by calling the Hono app directly with
 * a minimal mocked Env binding.
 */
import { Hono } from 'hono';
import { integrationHealth, KNOWN_INTEGRATIONS } from '../routes/integration_health';
import type { Env, Variables } from '../types/env';

/** Build a minimal mock Env with the fields the health route reads. */
function mockEnv(overrides: Partial<Env> = {}): Env {
  return {
    LISTMONK_BASE_URL: 'https://mail.projectsites.dev',
    LISTMONK_API_USER: 'projectsites',
    LISTMONK_API_KEY: 'test-key',
    TWENTY_API_URL: 'https://crm.projectsites.dev',
    TWENTY_API_KEY: 'test-jwt',
    STRIPE_SECRET_KEY: 'sk_test_...',
    DEEPGRAM_API_KEY: 'dg_test_...',
    ...overrides,
  } as unknown as Env;
}

// Stub global fetch so integration probes never hit the real network. `buildSignal`
// does a LIVE fetch for `listmonk` (via listmonkHealth) and `twenty`, so the aggregate
// `GET /api/integrations/health` would otherwise probe mail.projectsites.dev +
// crm.projectsites.dev on every run — ~756ms locally, >5000ms under CI egress → the
// `marks listmonk as unknown` test flaked on Jest's 5s timeout (reddened Project Sites
// CI/CD). Unit tests must mock external deps (CLAUDE.md PART 10.2). A 200/ok stub keeps
// every assertion valid (they check unconfigured→unknown + response shape, not live status).
let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
  } as unknown as Response);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/integrations/:name/health', () => {
  it('rejects unknown integration with 404', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/foobar/health');
    const res = await app.fetch(req, mockEnv());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('unknown_integration');
  });

  it('returns health for listmonk', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/listmonk/health');
    const res = await app.fetch(req, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.integration).toBe('listmonk');
    expect(body.status).toBeDefined();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(body.timestamp).toBeDefined();
  });

  it('returns unknown status for unconfigured integration', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/twenty/health');
    const res = await app.fetch(req, mockEnv({ TWENTY_API_KEY: '' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.signals[0].configured).toBe(false);
    expect(body.signals[0].health).toBe('unknown');
  });
});

describe('GET /api/integrations/health', () => {
  it('returns all known integrations', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/health');
    const env = mockEnv({
      TWENTY_API_KEY: '',
      DEEPGRAM_API_KEY: '',
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.length).toBe(KNOWN_INTEGRATIONS.size);
    // Each entry has the expected shape
    for (const entry of body.integrations) {
      expect(entry).toHaveProperty('integration');
      expect(entry).toHaveProperty('status');
      expect(entry).toHaveProperty('configured');
    }
    expect(body.timestamp).toBeDefined();
  });

  it('probes listmonk /health regardless of admin API key (public liveness → healthy)', async () => {
    // listmonk is a platform service — health is the public /health endpoint, not gated
    // on the admin token. baseUrl is always defaulted, so it's probed + (stub 200)
    // reports healthy even with no admin key set.
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/health');
    const env = mockEnv({ LISTMONK_API_KEY: '' });
    const res = await app.fetch(req, env);
    const body = (await res.json()) as any;
    const lm = body.integrations.find((i: any) => i.integration === 'listmonk');
    expect(lm.status).toBe('healthy');
    expect(lm.configured).toBe(true);
  });

  it('degrades gracefully when a live probe times out (bounded, never hangs the aggregate)', async () => {
    // Simulate a hung/aborted probe: the timeout-wrapped fetch rejects like AbortSignal.timeout.
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.route('/', integrationHealth);
    const req = new Request('https://projectsites.dev/api/integrations/health');
    // twenty is configured (mockEnv default) → a LIVE probe that now times out.
    const res = await app.fetch(req, mockEnv());
    expect(res.status).toBe(200); // aggregate resolves — a probe failure never throws/hangs
    const body = (await res.json()) as any;
    const twenty = body.integrations.find((i: any) => i.integration === 'twenty');
    expect(twenty.configured).toBe(true);
    // configured + probe failed → scored 'failing' (degraded signal), never a crash
    expect(twenty.status).not.toBe('healthy');
    // the live probe was invoked with an abort signal (timeout wired)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/healthz'),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
