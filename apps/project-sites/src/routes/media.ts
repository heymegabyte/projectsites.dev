/**
 * @module routes/media
 * @description HTTP surface for the unified Media library + studio.
 *
 * Mounts under `/api/media/*`. Every route is org-scoped — the caller's
 * `orgId` is sourced from `c.get('orgId')` (populated by `authMiddleware`).
 *
 * | Method | Path                              | Purpose                            |
 * | ------ | --------------------------------- | ---------------------------------- |
 * | GET    | `/api/media/assets`               | List with `kind/source/q` filters  |
 * | GET    | `/api/media/assets/:id`           | Single asset metadata              |
 * | GET    | `/api/media/assets/:id/raw`       | Stream the R2 object               |
 * | POST   | `/api/media/upload`               | Multipart upload (25 MB cap)       |
 * | DELETE | `/api/media/assets/:id`           | Soft delete                        |
 * | POST   | `/api/media/stock/search`         | Federated stock search             |
 * | POST   | `/api/media/stock/save`           | Download a candidate + persist     |
 * | POST   | `/api/media/generate/image`       | DALL·E 3 generation                |
 * | POST   | `/api/media/generate/video`       | Queued Sora/Veo stub               |
 * | POST   | `/api/media/generate/podcast`     | ElevenLabs / OpenAI TTS            |
 * | POST   | `/api/media/send-to-bolt`         | Mint a URL for the bolt iframe     |
 *
 * NOTE: `POST /api/media/upload` accepts payloads up to 25 MB. The
 * global `payloadLimitMiddleware` cap is 256 KB, so the worker entry
 * point must add an exemption for this path (or this route will 413
 * before the handler ever runs).
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { isSafeCrawlUrl } from '../services/outbound_webhooks.js';
import {
  generateImage,
  generatePodcast,
  generateVideo,
  getAsset,
  listAssets,
  mediaUsage,
  saveStockToLibrary,
  searchStock,
  sendToBolt,
  softDeleteAsset,
  uploadAsset,
  type MediaAsset,
  type PodcastScriptLine,
  type StockCandidate,
} from '../services/media.js';

const mediaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Hard cap for the multipart upload endpoint (25 MB). */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * MIME types safe to render inline when streaming a stored asset (raster images +
 * audio/video the browser renders as media). Anything NOT in this set — notably
 * `image/svg+xml`, `text/html`, `application/pdf`, `application/octet-stream` — is
 * served `Content-Disposition: attachment` so a malicious upload can never execute
 * as a document. (`<img>`/`fetch` consumers ignore the disposition, so inline
 * display in the media library is unaffected.)
 */
const INLINE_SAFE_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
]);

/** Extract `orgId` from the Hono context or return a 401 envelope. */
function getOrgScope(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): { orgId: string; userId: string | null } | Response {
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Sign in required',
          request_id: c.get('requestId'),
        },
      },
      401,
    );
  }
  return { orgId, userId: c.get('userId') ?? null };
}

/** Wrap a plain Error into a JSON response with the right status. */
function errorResponse(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  err: unknown,
): Response {
  const message = err instanceof Error ? err.message : String(err);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  if (message.startsWith('MEDIA_NO_TTS_CONFIGURED')) {
    status = 503;
    code = 'TTS_NOT_CONFIGURED';
  } else if (message.startsWith('MEDIA_OPENAI_NOT_CONFIGURED')) {
    status = 503;
    code = 'OPENAI_NOT_CONFIGURED';
  } else if (message.startsWith('MEDIA_ASSET_NOT_FOUND')) {
    status = 404;
    code = 'NOT_FOUND';
  } else if (message.startsWith('MEDIA_STOCK_TOO_LARGE')) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
  } else if (message.startsWith('MEDIA_PODCAST_EMPTY_SCRIPT')) {
    status = 400;
    code = 'BAD_REQUEST';
  } else if (message.startsWith('MEDIA_STOCK_DOWNLOAD_FAILED')) {
    status = 502;
    code = 'STOCK_DOWNLOAD_FAILED';
  } else if (message.startsWith('MEDIA_GENERATION_FAILED')) {
    status = 502;
    code = 'GENERATION_FAILED';
  }
  return c.json(
    { error: { code, message, request_id: c.get('requestId') } },
    status as 400 | 401 | 403 | 404 | 413 | 500 | 502 | 503,
  );
}

// ─── GET /api/media/assets ─────────────────────────────────

mediaRoutes.get('/api/media/assets', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const url = new URL(c.req.url);
  const kind = url.searchParams.get('kind') as MediaAsset['kind'] | null;
  const source = url.searchParams.get('source') as MediaAsset['source'] | null;
  const q = url.searchParams.get('q');
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const offset = Number(url.searchParams.get('offset') ?? '0');

  const assets = await listAssets(c.env, scope.orgId, {
    kind: kind ?? undefined,
    source: source ?? undefined,
    search: q ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return c.json({ ok: true, assets });
});

// ─── GET /api/media/usage ──────────────────────────────────

/**
 * Aggregate media-library usage for the caller's org: total bytes + counts by kind + by source.
 * A ground-truth roll-up straight from `media_assets` (never a client re-scan) — powers the
 * Resources tab's usage header.
 */
mediaRoutes.get('/api/media/usage', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const usage = await mediaUsage(c.env, scope.orgId);
  return c.json({ ok: true, data: usage });
});

// ─── GET /api/media/assets/:id ─────────────────────────────

mediaRoutes.get('/api/media/assets/:id', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const asset = await getAsset(c.env, scope.orgId, c.req.param('id'));
  if (!asset) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Asset not found', request_id: c.get('requestId') } },
      404,
    );
  }
  return c.json({ ok: true, asset });
});

// ─── GET /api/media/assets/:id/raw ─────────────────────────

mediaRoutes.get('/api/media/assets/:id/raw', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const asset = await getAsset(c.env, scope.orgId, c.req.param('id'));
  if (!asset) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Asset not found', request_id: c.get('requestId') } },
      404,
    );
  }

  const obj = await c.env.SITES_BUCKET.get(asset.r2_key);
  if (!obj) {
    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Underlying object missing',
          request_id: c.get('requestId'),
        },
      },
      404,
    );
  }
  // This streams user-uploaded bytes with a caller-supplied MIME (upload trusts
  // `file.type`), so a malicious SVG/HTML upload could execute as script if a
  // rendering context ever navigates to this URL. Ship the standard user-content
  // safety headers: nosniff (no MIME-sniffing a declared image into HTML), a
  // locked-down CSP + `sandbox` (no script even for text/html or image/svg+xml),
  // and force any non-inline-safe type to download rather than render.
  const rawMime = (asset.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const inlineSafe = INLINE_SAFE_TYPES.has(rawMime);
  const safeName =
    (asset.name || 'download').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'download';
  const headers: Record<string, string> = {
    'Content-Type': asset.mime || 'application/octet-stream',
    'Content-Length': String(asset.size_bytes || obj.size),
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inlineSafe ? 'inline' : 'attachment'}; filename="${safeName}"`,
  };
  return new Response(obj.body, { headers });
});

// ─── POST /api/media/upload ────────────────────────────────

mediaRoutes.post('/api/media/upload', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Expected multipart/form-data',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    return errorResponse(c, err);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing "file" field',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }
  const f = file as File;
  if (f.size > UPLOAD_MAX_BYTES) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `File exceeds ${UPLOAD_MAX_BYTES} bytes`,
          request_id: c.get('requestId'),
        },
      },
      413,
    );
  }

  try {
    const bytes = await f.arrayBuffer();
    const asset = await uploadAsset(c.env, {
      orgId: scope.orgId,
      createdBy: scope.userId,
      name: f.name || 'upload',
      mime: f.type || 'application/octet-stream',
      bytes,
    });
    return c.json({ ok: true, asset }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── DELETE /api/media/assets/:id ──────────────────────────

mediaRoutes.delete('/api/media/assets/:id', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  const result = await softDeleteAsset(c.env, scope.orgId, c.req.param('id'));
  if (!result.ok) {
    return c.json(
      {
        error: {
          code: result.error === 'Asset not found' ? 'NOT_FOUND' : 'INTERNAL_ERROR',
          message: result.error ?? 'Delete failed',
          request_id: c.get('requestId'),
        },
      },
      result.error === 'Asset not found' ? 404 : 500,
    );
  }
  return c.json({ ok: true });
});

// ─── POST /api/media/stock/search ──────────────────────────

mediaRoutes.post('/api/media/stock/search', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: { query?: string; sources?: StockCandidate['provider'][]; perPage?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const query = (body.query ?? '').toString().trim();
  if (!query) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'query is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const candidates = await searchStock(c.env, scope.orgId, query, {
      sources: body.sources,
      perPage: body.perPage,
    });
    return c.json({ ok: true, candidates });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── POST /api/media/stock/save ────────────────────────────

mediaRoutes.post('/api/media/stock/save', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: { candidate?: StockCandidate };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body.candidate || !body.candidate.fullUrl) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'candidate is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  // SSRF (gap-audit #1): saveStockToLibrary fetches candidate.fullUrl server-side.
  // Reject internal / private / metadata targets before the fetch — the same guard
  // the build crawler uses. Legit stock URLs (Unsplash/Pexels/Pixabay) always pass.
  if (!isSafeCrawlUrl(body.candidate.fullUrl)) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'candidate URL is not allowed',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const asset = await saveStockToLibrary(c.env, {
      orgId: scope.orgId,
      createdBy: scope.userId,
      candidate: body.candidate,
    });
    return c.json({ ok: true, asset }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── POST /api/media/generate/image ────────────────────────

mediaRoutes.post('/api/media/generate/image', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: {
    prompt?: string;
    size?: '1024x1024' | '1792x1024' | '1024x1792';
    n?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const prompt = (body.prompt ?? '').toString().trim();
  if (!prompt) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'prompt is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const assets = await generateImage(c.env, {
      orgId: scope.orgId,
      createdBy: scope.userId,
      prompt,
      size: body.size,
      n: body.n,
    });
    return c.json({ ok: true, assets }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── POST /api/media/generate/video ────────────────────────

mediaRoutes.post('/api/media/generate/video', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: { prompt?: string; durationSec?: number; model?: 'sora' | 'veo' };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const prompt = (body.prompt ?? '').toString().trim();
  if (!prompt) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'prompt is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const asset = await generateVideo(c.env, {
      orgId: scope.orgId,
      createdBy: scope.userId,
      prompt,
      durationSec: body.durationSec,
      model: body.model,
    });
    return c.json({ ok: true, asset }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── POST /api/media/generate/podcast ──────────────────────

mediaRoutes.post('/api/media/generate/podcast', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: {
    title?: string;
    script?: PodcastScriptLine[];
    voiceProvider?: 'elevenlabs' | 'openai';
  };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const title = (body.title ?? '').toString().trim();
  if (!title) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'title is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }
  if (!Array.isArray(body.script) || body.script.length === 0) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'script (array of {voice, text}) is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const asset = await generatePodcast(c.env, {
      orgId: scope.orgId,
      createdBy: scope.userId,
      title,
      script: body.script,
      voiceProvider: body.voiceProvider,
    });
    return c.json({ ok: true, asset }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ─── POST /api/media/send-to-bolt ──────────────────────────

mediaRoutes.post('/api/media/send-to-bolt', async (c) => {
  const scope = getOrgScope(c);
  if (scope instanceof Response) return scope;

  let body: { assetId?: string; siteSlug?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body.assetId) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'assetId is required',
          request_id: c.get('requestId'),
        },
      },
      400,
    );
  }

  try {
    const { url, asset } = await sendToBolt(c.env, {
      orgId: scope.orgId,
      assetId: body.assetId,
      siteSlug: body.siteSlug,
    });
    return c.json({ ok: true, url, asset });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export { mediaRoutes };
