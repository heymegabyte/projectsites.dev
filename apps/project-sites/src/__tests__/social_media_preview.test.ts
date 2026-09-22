/**
 * `GET /api/social/posts` media-preview enrichment — signed preview URLs minted
 * from the `pulse_posts.media_keys` JSON column.
 *
 * The Pulse Social composer renders `post.media[]` as thumbnails. A bare `<img>`
 * cannot attach the Bearer header the authed `/api/media/assets/:id/raw` route
 * requires, so the list handler must return URLs a plain <img> can load: an R2
 * signed URL (`SITES_BUCKET.createSignedUrl`) when the binding supports it,
 * otherwise the public `/assets/r2/{key}` passthrough the publish workflow uses.
 *
 * Contract asserted here:
 *   - a post with media_keys returns resolved preview URLs (signed, in order)
 *   - `media_keys: null` (and '') returns `[]` — never null, never a throw
 *   - malformed JSON degrades to `[]` rather than a 500
 *   - entries missing `r2_key` are dropped, not surfaced as broken <img> srcs
 *   - a signing failure falls back to the public passthrough (no 500)
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn().mockResolvedValue(true),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { socialRoutes } from '../routes/social.js';
import { dbQuery } from '../services/db.js';

const mDbQuery = dbQuery as unknown as jest.Mock;

// ─── Harness ─────────────────────────────────────────────────────────────────

const AUTH: Partial<Variables> = { userId: 'user-1', orgId: 'org-1', requestId: 'req-1' };

/** A minimal but structurally-real R2 binding exposing `createSignedUrl`. */
function makeBucket(signer?: (key: string, opts: { expiresIn: number }) => Promise<string>) {
  return {
    createSignedUrl: jest.fn(signer ?? (async (key: string) => `https://r2.test/signed/${key}`)),
  };
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: {} as D1Database,
    AI: {},
    ...overrides,
  } as unknown as Env;
}

function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    if (vars.requestId) c.set('requestId', vars.requestId);
    await next();
  });
  app.route('/', socialRoutes);
  return app;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function req(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  path: string,
  env: Env,
): Promise<Response> {
  return app.request(path, { method: 'GET' }, env, makeCtx()) as Promise<Response>;
}

/** Seed the posts SELECT (call 1) + the social_accounts SELECT (call 2). */
function seedRows(rows: Array<Record<string, unknown>>) {
  mDbQuery.mockResolvedValueOnce({ data: rows, error: null });
  mDbQuery.mockResolvedValueOnce({ data: [], error: null });
}

interface MediaItem {
  url: string;
  mime?: string;
  type?: string;
  alt?: string;
}

async function mediaOf(res: Response): Promise<MediaItem[]> {
  const body = (await res.json()) as { data: Array<{ media: MediaItem[] }> };
  return body.data[0].media;
}

beforeEach(() => {
  jest.clearAllMocks();
  mDbQuery.mockResolvedValue({ data: [], error: null });
});

// ─── Media preview resolution ────────────────────────────────────────────────

describe('GET /api/social/posts — media preview URLs', () => {
  it('resolves signed preview URLs from media_keys', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify([
          { r2_key: 'media/org-1/a/one.png', mime: 'image/png', alt: 'one' },
          { r2_key: 'media/org-1/b/two.mp4', mime: 'video/mp4', alt: 'two' },
        ]),
      },
    ]);
    const bucket = makeBucket();
    const res = await req(makeApp(AUTH), '/api/social/posts', makeEnv({ SITES_BUCKET: bucket }));

    expect(res.status).toBe(200);
    const media = await mediaOf(res);
    expect(media).toHaveLength(2);
    expect(media[0].url).toBe('https://r2.test/signed/media/org-1/a/one.png');
    expect(media[1].url).toBe('https://r2.test/signed/media/org-1/b/two.mp4');
    // Order + metadata are preserved so the composer renders the right thumbs.
    expect(media[0].mime).toBe('image/png');
    expect(media[0].alt).toBe('one');
    expect(media[1].type).toBe('video');
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array (not null, not a throw) when media_keys is null', async () => {
    seedRows([
      { id: 'post-1', status: 'draft', account_ids: '[]', hashtags: '[]', media_keys: null },
    ]);
    const res = await req(
      makeApp(AUTH),
      '/api/social/posts',
      makeEnv({ SITES_BUCKET: makeBucket() }),
    );

    expect(res.status).toBe(200);
    const media = await mediaOf(res);
    expect(media).toEqual([]);
  });

  it('returns an empty array when media_keys is an empty string', async () => {
    seedRows([{ id: 'post-1', status: 'draft', account_ids: '[]', hashtags: '[]', media_keys: '' }]);
    const res = await req(
      makeApp(AUTH),
      '/api/social/posts',
      makeEnv({ SITES_BUCKET: makeBucket() }),
    );

    expect(res.status).toBe(200);
    expect(await mediaOf(res)).toEqual([]);
  });

  it('degrades malformed JSON in media_keys to an empty array instead of a 500', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: '{"not":"an array"',
      },
    ]);
    const res = await req(
      makeApp(AUTH),
      '/api/social/posts',
      makeEnv({ SITES_BUCKET: makeBucket() }),
    );

    expect(res.status).toBe(200);
    expect(await mediaOf(res)).toEqual([]);
  });

  it('degrades a non-array JSON payload (object) to an empty array', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify({ r2_key: 'media/org-1/a/one.png' }),
      },
    ]);
    const res = await req(
      makeApp(AUTH),
      '/api/social/posts',
      makeEnv({ SITES_BUCKET: makeBucket() }),
    );

    expect(res.status).toBe(200);
    expect(await mediaOf(res)).toEqual([]);
  });

  it('drops entries missing a usable r2_key rather than emitting a broken URL', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify([
          { mime: 'image/png' },
          null,
          { r2_key: '', mime: 'image/png' },
          { r2_key: 'media/org-1/a/one.png', mime: 'image/png' },
        ]),
      },
    ]);
    const res = await req(
      makeApp(AUTH),
      '/api/social/posts',
      makeEnv({ SITES_BUCKET: makeBucket() }),
    );

    expect(res.status).toBe(200);
    const media = await mediaOf(res);
    expect(media).toHaveLength(1);
    expect(media[0].url).toBe('https://r2.test/signed/media/org-1/a/one.png');
  });

  it('falls back to the public /assets/r2 passthrough when signing throws', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify([{ r2_key: 'media/org-1/a/one.png', mime: 'image/png' }]),
      },
    ]);
    const bucket = makeBucket(async () => {
      throw new Error('signing unavailable');
    });
    const res = await req(makeApp(AUTH), '/api/social/posts', makeEnv({ SITES_BUCKET: bucket }));

    expect(res.status).toBe(200);
    const media = await mediaOf(res);
    expect(media).toHaveLength(1);
    expect(media[0].url).toBe('/assets/r2/media/org-1/a/one.png');
  });

  it('falls back to the public passthrough when the binding has no createSignedUrl', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify([{ r2_key: 'media/org-1/a/one.png', mime: 'image/png' }]),
      },
    ]);
    const res = await req(makeApp(AUTH), '/api/social/posts', makeEnv({ SITES_BUCKET: {} }));

    expect(res.status).toBe(200);
    expect((await mediaOf(res))[0].url).toBe('/assets/r2/media/org-1/a/one.png');
  });

  it('does not break when the R2 binding is absent entirely', async () => {
    seedRows([
      {
        id: 'post-1',
        status: 'draft',
        account_ids: '[]',
        hashtags: '[]',
        media_keys: JSON.stringify([{ r2_key: 'media/org-1/a/one.png', mime: 'image/png' }]),
      },
    ]);
    const res = await req(makeApp(AUTH), '/api/social/posts', makeEnv());

    expect(res.status).toBe(200);
    expect((await mediaOf(res))[0].url).toBe('/assets/r2/media/org-1/a/one.png');
  });
});
