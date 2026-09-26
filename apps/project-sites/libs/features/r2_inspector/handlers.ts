/**
 * @module libs/features/r2_inspector/handlers
 * @description Hono routes for the R2 Object Inspector feature (flag: `r2_inspector`).
 *
 * | Method | Path                                    | Auth        | Purpose                   |
 * | ------ | --------------------------------------- | ----------- | ------------------------- |
 * | GET    | /api/admin/r2/buckets                   | super-admin | List known buckets        |
 * | GET    | /api/admin/r2/:bucket/objects           | super-admin | Prefix-paginated objects  |
 * | GET    | /api/admin/r2/:bucket/object            | super-admin | Object metadata (HEAD)    |
 *
 * Security model (mirrors kv_inspector):
 *   - All endpoints 404 when the `r2_inspector` flag is off (never leak existence).
 *   - All endpoints 404 when the caller is not a platform super-admin.
 *   - `:bucket` is validated against a SERVER-SIDE allowlist — client-supplied names
 *     never reach R2. Unknown buckets → 404.
 *   - READ-ONLY: no put/delete operations exposed.
 *   - The object endpoint returns METADATA ONLY (`head()`), never the body — so a huge
 *     object never loads into the Worker's memory. Body download is a future slice with
 *     size guards + streaming.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSuperAdmin } from '../../../src/services/sysadmin.js';
import {
  R2_BUCKET_ALLOWLIST,
  R2BucketSchema,
  R2ListQuerySchema,
  R2ObjectQuerySchema,
  R2_LIST_MAX,
  type R2BucketBinding,
} from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** Feature flag key — 404 when off so feature existence is never leaked. */
const FLAG_KEY = 'r2_inspector' as const;

export const r2Inspector = new Hono<AppContext>();

// ─── Guards ──────────────────────────────────────────────────────────────────

/** Combined flag+super-admin gate. Returns 404 (not 403) on any failure. */
async function gate(c: Context<AppContext>): Promise<Response | null> {
  const flagOn = await isFlagOn(c.env, FLAG_KEY, {});
  if (!flagOn) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  const superAdmin = await isSuperAdmin(c.env, userId);
  if (!superAdmin) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
  return null; // pass
}

/** Resolve a validated bucket name to the actual R2 bucket on `c.env`. */
function resolveR2(env: Env, bucket: R2BucketBinding): R2Bucket {
  return env[bucket] as R2Bucket;
}

/**
 * Structured operational telemetry for the R2 inspector — the Data-epic's
 * "structured operational telemetry for query failures, freshness, cost" +
 * request-id correlation for Workers Tracing. `console.warn(JSON.stringify(...))`
 * is this repo's structured-log rail (`console.log` is ESLint-blocked). NEVER logs
 * object bodies — only the operation shape, cost (objects/size), outcome, latency.
 */
function logR2(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'r2_inspector',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

/** R2's `uploaded` is a Date; serialize to an ISO string for the JSON response. */
function isoOrNull(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ─── GET /api/admin/r2/buckets ───────────────────────────────────────────────

r2Inspector.get('/api/admin/r2/buckets', async (c) => {
  const block = await gate(c);
  if (block) return block;

  return c.json({ buckets: [...R2_BUCKET_ALLOWLIST] });
});

// ─── GET /api/admin/r2/:bucket/objects ───────────────────────────────────────

r2Inspector.get('/api/admin/r2/:bucket/objects', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const bucketParse = R2BucketSchema.safeParse(c.req.param('bucket'));
  if (!bucketParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown R2 bucket' } }, 404);
  }
  const bucket = bucketParse.data;

  const queryParse = R2ListQuerySchema.safeParse({
    prefix: c.req.query('prefix'),
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit'),
    delimiter: c.req.query('delimiter'),
  });
  if (!queryParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: queryParse.error.flatten(),
        },
      },
      400,
    );
  }
  const { prefix, cursor, limit, delimiter } = queryParse.data;

  const r2 = resolveR2(c.env, bucket);
  const t0 = Date.now();
  const listed = await r2.list({
    prefix,
    cursor,
    limit: Math.min(limit ?? R2_LIST_MAX, R2_LIST_MAX),
    // With a delimiter, R2 returns `delimitedPrefixes` (common prefixes = "folders") + only the objects
    // at THIS level — folder-like navigation without loading the whole bucket into memory.
    ...(delimiter ? { delimiter } : {}),
  });
  const delimitedPrefixes = (listed as { delimitedPrefixes?: string[] }).delimitedPrefixes ?? [];
  logR2(c, {
    route: 'r2/objects',
    bucket,
    outcome: 'ok',
    objects_returned: listed.objects.length,
    truncated: listed.truncated,
    latency_ms: Date.now() - t0,
  });

  return c.json({
    bucket,
    objects: listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: isoOrNull(o.uploaded),
      etag: o.etag,
      contentType: o.httpMetadata?.contentType ?? null,
    })),
    // The "folders" at this level — key-prefixes up to the delimiter, NOT real directories (R2 is flat).
    delimitedPrefixes,
    truncated: listed.truncated,
    cursor: listed.truncated ? (listed as { cursor?: string }).cursor : undefined,
  });
});

// ─── GET /api/admin/r2/:bucket/object ────────────────────────────────────────

r2Inspector.get('/api/admin/r2/:bucket/object', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const bucketParse = R2BucketSchema.safeParse(c.req.param('bucket'));
  if (!bucketParse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown R2 bucket' } }, 404);
  }
  const bucket = bucketParse.data;

  const queryParse = R2ObjectQuerySchema.safeParse({ key: c.req.query('key') });
  if (!queryParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '`key` query param is required',
          details: queryParse.error.flatten(),
        },
      },
      400,
    );
  }
  const { key } = queryParse.data;

  const r2 = resolveR2(c.env, bucket);
  const t0 = Date.now();
  const obj = await r2.head(key);
  logR2(c, {
    route: 'r2/object',
    bucket,
    outcome: obj ? 'ok' : 'miss',
    size: obj?.size ?? 0,
    latency_ms: Date.now() - t0,
  });

  if (!obj) {
    // Honest "not found" (never a fabricated object) — the key doesn't exist.
    return c.json({
      bucket,
      key,
      found: false,
      size: null,
      uploaded: null,
      etag: null,
      contentType: null,
      customMetadata: null,
    });
  }

  return c.json({
    bucket,
    key,
    found: true,
    size: obj.size,
    uploaded: isoOrNull(obj.uploaded),
    etag: obj.etag,
    contentType: obj.httpMetadata?.contentType ?? null,
    customMetadata: obj.customMetadata ?? null,
  });
});
