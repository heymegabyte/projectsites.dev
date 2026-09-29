/**
 * Input-boundary coverage for the POST/PUT handlers OUTSIDE `api.ts` (apps,
 * site_detail_tabs, voice) that read the body with an INLINE
 * `SomeSchema.parse(await c.req.json())` — so a malformed JSON body throws an
 * uncaught SyntaxError at the parse → 500 instead of a clean 4xx.
 *
 * Only the inline-`.parse()` handlers are covered (so `.catch(() => ({}))`
 * provably lands a malformed body on the existing required-field ZodError→400
 * path, never a silent `{}` no-op). The `try { body = await c.req.json() }
 * catch { 400 }`-guarded handlers in bolt_admin/env_vars/media/ai_admin/
 * mcp_site/mcp_oauth/search are already safe and excluded; search's data-write
 * PUT (destructure-no-parse) is excluded as risky.
 *
 * Asserts 4xx-not-500 (the fix is 500→4xx; whether the parse-400 or an
 * auth/membership-4xx fires first, a malformed body must never be a 500).
 */
// apps.ts transitively imports the ESM-only `@cloudflare/containers`; stub it so
// the router loads under Jest (the container path is never hit by a 4xx body-parse).
jest.mock('@cloudflare/containers', () => ({ __esModule: true, Container: class {} }), {
  virtual: true,
});

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { apps } from '../routes/apps.js';
import { siteDetailTabs } from '../routes/site_detail_tabs.js';
import { voiceRoutes } from '../routes/voice.js';

const mockDb = {
  prepare: jest.fn(() => ({
    bind: jest.fn(() => ({
      first: jest.fn().mockResolvedValue(null),
      all: jest.fn().mockResolvedValue({ results: [] }),
      run: jest.fn().mockResolvedValue({}),
    })),
  })),
} as unknown as D1Database;

// Minimal KV stub so the `voice_numbers` killswitch gate on the purchase route
// (`requireOrgFlag` → `resolveFlag` → `env.CACHE_KV.get()`) resolves instead of
// throwing a `TypeError: Cannot read properties of undefined (reading 'get')`.
// That gate was added AFTER this boundary test (commit 65cc02b) and reads KV
// FIRST; without the binding the read throws → the error handler maps it to a
// 500, masking the malformed-body path under test. `get` returns null (cache
// miss → registry default: voice_numbers is default-off → the gate 404s, a clean
// 4xx that lets the boundary assertion pass). Same class as memory `[mockK]`.
const flagKvStub = {
  get: async () => null,
  put: async () => undefined,
  list: async () => ({ keys: [], list_complete: true }),
  delete: async () => undefined,
};

function makeEnv(): Env {
  // TWILIO_* set so the voice handlers' `isTwilioConfigured` gate (which throws
  // a 501 BEFORE the body parse) passes and the malformed body actually reaches
  // the `.parse()` under test.
  return {
    ENVIRONMENT: 'test',
    DB: mockDb,
    CACHE_KV: flagKvStub,
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'tok_test',
  } as unknown as Env;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.onError(errorHandler);
app.use('*', async (c, next) => {
  c.set('orgId', 'org-1');
  c.set('userId', 'user-1');
  c.set('requestId', 'req-1');
  await next();
});
app.route('/', apps);
app.route('/', siteDetailTabs);
app.route('/', voiceRoutes);

function req(method: string, path: string, raw: string) {
  return app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json' }, body: raw },
    makeEnv(),
  );
}

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('routes (non-api.ts) — malformed JSON body → 4xx (not 500)', () => {
  const cases: Array<[string, string]> = [
    ['POST', '/api/apps/instances'],
    ['PATCH', '/api/apps/instances/inst-1/env'],
    ['POST', '/api/sites/site-1/sql/exec'],
    ['POST', '/api/voice/numbers/purchase'],
    ['PUT', '/api/voice/agent-settings'],
    ['POST', '/api/voice/test/sms'],
    ['POST', '/api/voice/test/call-token'],
  ];

  it.each(cases)('%s %s with a malformed body returns a 4xx, never a 500', async (method, path) => {
    const res = await req(method, path, '{ not : valid json');
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
