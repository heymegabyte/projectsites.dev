/**
 * Route-LAYER coverage for routes/social_posts.ts — the publish + schedule
 * handlers persist `body.site_id` into `pulse_posts.site_id` with only an
 * ORG-level auth check. This suite is the IDOR regression: a caller in org-A
 * that sets `body.site_id` to an org-B site MUST get a 404 (never leak
 * existence, never write the foreign id).
 *
 *   POST /api/social/:siteId/posts/publish   cross-org site_id → 404 · owned → 201 · null → 201
 *   POST /api/social/:siteId/posts/schedule  cross-org site_id → 404 · owned → 201 · null → 201
 *
 * Wired through the real `errorHandler` + auth-context injection; the flag
 * check, D1 helpers, and site-ownership guard are mocked at their boundaries.
 */

jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../services/db.js', () => ({ dbInsert: jest.fn(), dbQuery: jest.fn() }));
jest.mock('../services/site_ownership.js', () => ({ assertSiteOwned: jest.fn() }));

import { Hono } from 'hono';
import { socialPostRoutes } from '../routes/social_posts.js';
import { errorHandler } from '../middleware/error_handler.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { dbInsert, dbQuery } from '../services/db.js';
import { assertSiteOwned } from '../services/site_ownership.js';

const mFlag = isFlagOn as jest.MockedFunction<typeof isFlagOn>;
const mInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;
const mQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mOwned = assertSiteOwned as jest.MockedFunction<typeof assertSiteOwned>;

const OWNED_SITE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SITE = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', socialPostRoutes);
  return a;
}
const authed = () => app({ orgId: 'org1', userId: 'u1' });
const env = {} as never;
const jsonReq = (b: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

const publishBody = (siteId?: string) => ({
  content: 'hello world',
  platforms: ['twitter'],
  account_ids: [ACCOUNT_ID],
  ...(siteId === undefined ? {} : { site_id: siteId }),
});
const scheduleBody = (siteId?: string) => ({
  ...publishBody(siteId),
  scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mFlag.mockResolvedValue(true as never);
  // Account lookup resolves to one active twitter account owned by the org.
  mQuery.mockResolvedValue({ data: [{ id: ACCOUNT_ID, platform: 'twitter' }] } as never);
  mInsert.mockResolvedValue({ error: null } as never);
  // Ownership guard: OWNED_SITE belongs to the caller, FOREIGN_SITE does not.
  mOwned.mockImplementation(
    (_env, _orgId, siteId) => Promise.resolve(siteId === OWNED_SITE) as never,
  );
});

describe('POST /api/social/:siteId/posts/publish — cross-tenant site_id IDOR', () => {
  it('404 when body.site_id belongs to another org (no pulse_posts write)', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/publish`,
      jsonReq(publishBody(FOREIGN_SITE)),
      env,
    );
    expect(res.status).toBe(404);
    // The foreign site_id must never be persisted.
    expect(mInsert).not.toHaveBeenCalled();
  });

  it('201 when body.site_id belongs to the caller org', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/publish`,
      jsonReq(publishBody(OWNED_SITE)),
      env,
    );
    expect(res.status).toBe(201);
    expect(mOwned).toHaveBeenCalledWith(env, 'org1', OWNED_SITE);
  });

  it('201 when site_id is omitted (guard is skipped, org-scoped post)', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/publish`,
      jsonReq(publishBody(undefined)),
      env,
    );
    expect(res.status).toBe(201);
    expect(mOwned).not.toHaveBeenCalled();
  });
});

describe('POST /api/social/:siteId/posts/schedule — cross-tenant site_id IDOR', () => {
  it('404 when body.site_id belongs to another org (no pulse_posts write)', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/schedule`,
      jsonReq(scheduleBody(FOREIGN_SITE)),
      env,
    );
    expect(res.status).toBe(404);
    expect(mInsert).not.toHaveBeenCalled();
  });

  it('201 when body.site_id belongs to the caller org', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/schedule`,
      jsonReq(scheduleBody(OWNED_SITE)),
      env,
    );
    expect(res.status).toBe(201);
    expect(mOwned).toHaveBeenCalledWith(env, 'org1', OWNED_SITE);
  });

  it('201 when site_id is omitted (guard is skipped, org-scoped post)', async () => {
    const res = await authed().request(
      `/api/social/${OWNED_SITE}/posts/schedule`,
      jsonReq(scheduleBody(undefined)),
      env,
    );
    expect(res.status).toBe(201);
    expect(mOwned).not.toHaveBeenCalled();
  });
});
