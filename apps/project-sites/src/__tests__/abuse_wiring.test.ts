/**
 * §48 WIRING half — `requireNotAbusive(kind)` must actually be mounted on the
 * claim / form / ai-generate routes (the middleware + providers were already
 * tested in `abuse.test.ts`; this suite proves the WIRING).
 *
 * The wiring is a NO-OP in the default configuration: with `ARCJET_KEY` unset,
 * `getAbuseProvider` returns `AllowAllAbuseProvider` (fail-OPEN), so every wired
 * route must still return its normal success shape untouched.
 *
 * Two assertions per wired route:
 *  1. the request reaches the real handler (the middleware called `next()`), and
 *  2. the abuse provider actually RAN for that route (it was invoked with the
 *     route's `kind` + path) — otherwise "it passed" proves nothing about wiring.
 */
const decideSpy = jest.fn(async () => ({ allow: true }));

// Mock the PORT, not the middleware module. `requireNotAbusive` is spread in
// verbatim from `...actual`, so its default second parameter
// `(c) => getAbuseProvider(c.env)` stays bound to the REAL module's lexical
// `getAbuseProvider` — overriding that export on a spread copy is structurally
// unreachable, which is why the first cut of this spec saw the real AllowAll
// provider run (200 with decideSpy never recording). Patching the provider CLASS
// instead keeps the real middleware + the real factory on the call path (which is
// exactly what "prove the wiring" means) while the instance the real factory
// constructs reports through the spy.
jest.mock('../platform/abuse.js', () => {
  const actual = jest.requireActual('../platform/abuse.js');
  return {
    ...actual,
    AllowAllAbuseProvider: class {
      decide = decideSpy;
    },
  };
});

jest.mock('../services/email_suppressions.js', () => ({
  isSuppressed: jest.fn(async () => false),
  recordSuppressions: jest.fn(async () => ({ suppressed: 0 })),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { contactNewsletter } from '../../libs/features/contact_newsletter/handlers.js';

const SITE_ROW = {
  id: 'site-1',
  org_id: 'org-1',
  business_name: 'Newark Soup Kitchen',
  contact_email: 'owner@nsk.org',
};

function makeDb() {
  return {
    prepare: jest.fn(() => ({
      bind: jest.fn(() => ({
        all: jest.fn().mockResolvedValue({ results: [SITE_ROW] }),
        first: jest.fn().mockResolvedValue(SITE_ROW),
        run: jest.fn().mockResolvedValue({ success: true, meta: {} }),
      })),
    })),
  } as unknown as D1Database;
}

function makeEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    DB: makeDb(),
    SENDGRID_API_KEY: 'sg_test_x',
  } as unknown as Env;
}

beforeEach(() => {
  decideSpy.mockClear();
});

describe('§48 — requireNotAbusive is wired onto the public form route', () => {
  it('runs the abuse provider, then lets the real handler answer (no-op fail-open)', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', contactNewsletter);

    const res = await app.request(
      '/api/contact-form/newark-soup-kitchen',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Ada',
          email: 'ada@example.com',
          message: 'Hello, I would like to volunteer this weekend.',
        }),
      },
      makeEnv(),
    );

    // (1) the real handler answered — the middleware called next().
    expect(res.status).toBe(200);

    // (2) the middleware actually RAN for this route, with the route's kind.
    expect(decideSpy).toHaveBeenCalled();
    const arg = decideSpy.mock.calls[0]?.[0] as { kind: string; path: string };
    expect(arg.kind).toBe('form');
    expect(arg.path).toBe('/api/contact-form/newark-soup-kitchen');
  });

  it('429s before the handler when the provider blocks (proves the gate is live)', async () => {
    decideSpy.mockResolvedValueOnce({ allow: false, reason: 'bot', retryAfterSec: 30 } as never);

    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.onError(errorHandler);
    app.route('/', contactNewsletter);

    const res = await app.request(
      '/api/contact-form/newark-soup-kitchen',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Ada',
          email: 'ada@example.com',
          message: 'Hello, I would like to volunteer this weekend.',
        }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
  });
});
