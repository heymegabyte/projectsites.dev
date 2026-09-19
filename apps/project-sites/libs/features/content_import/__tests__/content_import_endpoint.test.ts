/**
 * Route-layer coverage for the content_import wiring — the pure parsers in
 * src/services/content_import.ts are already unit-tested; this proves the NEW flag-gated
 * endpoint that finally makes them reachable: auth (401) → flag (404 dark) → Zod (400) →
 * parse (200) / typed parse-error (400, never a 500). @swc/jest needs the GLOBAL jest for
 * mock hoisting; a jest.mock inside libs/features/<slug>/__tests__/ needs FOUR `../` to src/.
 */
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));

import { Hono } from 'hono';
import { contentImport } from '../handlers';
import { errorHandler } from '../../../../src/middleware/error_handler.js';
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';

const mFlag = isFlagOn as jest.MockedFunction<typeof isFlagOn>;

function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', contentImport);
  return a;
}
const authed = () => app({ orgId: 'org1', userId: 'u1' });
const env = {} as never;
const post = (b: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

const SQ_VALID =
  '[{"title":"Hello","body":"<p>World</p>","slug":"hello","publishOn":"2026-01-15"}]';
const PATH = '/api/content-import/parse';

beforeEach(() => {
  jest.clearAllMocks();
  mFlag.mockResolvedValue(true);
});

describe('POST /api/content-import/parse', () => {
  it('flag OFF → 404 (dark, never 403)', async () => {
    mFlag.mockResolvedValue(false);
    const res = await authed().request(PATH, post({ source: 'squarespace', raw: SQ_VALID }), env);
    expect(res.status).toBe(404);
  });

  it('unauthenticated → 401', async () => {
    const res = await app().request(PATH, post({ source: 'squarespace', raw: SQ_VALID }), env);
    expect(res.status).toBe(401);
  });

  it('valid export → 200 with normalized items + count', async () => {
    const res = await authed().request(PATH, post({ source: 'squarespace', raw: SQ_VALID }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { source: string; count: number; items: { title: string; slug: string }[] };
    };
    expect(body.data.source).toBe('squarespace');
    expect(body.data.count).toBe(1);
    expect(body.data.items[0]?.title).toBe('Hello');
  });

  it('malformed export → 400 CONTENT_IMPORT_PARSE_ERROR (typed, never a 500)', async () => {
    const res = await authed().request(
      PATH,
      post({ source: 'squarespace', raw: '{"not":"an array"}' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONTENT_IMPORT_PARSE_ERROR');
  });

  it('unknown source → 400 (Zod rejects at the boundary)', async () => {
    const res = await authed().request(PATH, post({ source: 'notion', raw: SQ_VALID }), env);
    expect(res.status).toBe(400);
  });

  it('empty raw → 400 (Zod min length)', async () => {
    const res = await authed().request(PATH, post({ source: 'squarespace', raw: '' }), env);
    expect(res.status).toBe(400);
  });
});
