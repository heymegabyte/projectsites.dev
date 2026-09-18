/**
 * Reliability boundary: a malformed JSON body must NEVER be an unhandled 500.
 * These `search.ts` handlers read the body with a bare
 * `(await c.req.json()) as {...}` cast — on a malformed body `c.req.json()`
 * threw a SyntaxError that bubbled to the global error handler as
 * INTERNAL_ERROR (500), with Sentry noise.
 *
 * Fix: `.catch(() => ({}))` so a malformed body collapses to `{}` and is then
 * handled exactly like an empty body. The resulting status is each handler's
 * own empty-body semantics:
 *   - create-from-search / edit-image THROW on a missing required field → 400
 *   - categorize / discover-images / discover-videos gracefully degrade to an
 *     empty result → 200
 * The invariant under test for ALL of them: never a 500.
 *
 * (fire-18: corrects the fire-16/17 overclaim that the no-catch class was
 * "fully closed" — that sweep covered only api.ts; search.ts had 5 more.)
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { search } from '../routes/search.js';
// Route-decomposition installment 26: /api/ai/{discover-images,discover-videos,edit-image} moved to media_ai. Mount before search.
import { mediaAi } from '../../libs/features/media_ai/handlers.js';
import { siteCreation } from '../../libs/features/site_creation/handlers.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.onError(errorHandler);
app.use('*', async (c, next) => {
  c.set('orgId', 'org-1');
  c.set('userId', 'user-1');
  c.set('requestId', 'req-1');
  await next();
});
app.route('/', mediaAi);
app.route('/', siteCreation);
app.route('/', search);

// A minimal DB stub returning a clean 0-site count. create-from-search runs
// checkBuildLimit BEFORE parsing the body; as of AL-784 that check FAILS CLOSED on a
// D1 error (a real fix — the old code silently bypassed the cap), so a NULL DB would now
// (correctly) deny → the handler's `!allowed` branch fires `c.executionCtx.waitUntil` and
// the test harness has no executionCtx → 500. Prod always has a working DB (count → allowed),
// so this stub mirrors prod's happy path and lets the request reach the malformed-body →
// 400 path this test actually exercises. `first()` → null keeps plan=free + owner=not-unlimited.
const env = {
  ENVIRONMENT: 'test',
  DB: {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [{ count: 0 }] }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  },
} as unknown as Env;

function postMalformed(path: string) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this-is-not-json',
    },
    env,
  );
}

describe('malformed JSON body is never a 500 on no-catch search.ts handlers', () => {
  // [path, expectedStatus] — expected status is the handler's empty-body
  // behavior (throwers → 400, graceful-degraders → 200). None may 500.
  it.each([
    ['/api/sites/create-from-search', 400],
    ['/api/ai/categorize', 200],
    ['/api/ai/discover-images', 200],
    ['/api/ai/discover-videos', 200],
    ['/api/ai/edit-image', 400],
  ])('handles a malformed body to %s as %i (never 500)', async (path, expected) => {
    const res = await postMalformed(path as string);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(expected as number);
  });
});
