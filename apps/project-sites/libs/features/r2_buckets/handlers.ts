/**
 * @module libs/features/r2_buckets/handlers
 *
 * @description
 * Hono routes for the **per-site R2 Buckets** surface — the editor Resources → Buckets tab's view of a
 * customer's OWN Cloudflare R2 buckets. The R2 analog of `site_db_handlers.ts` (per-site D1). An owner
 * creates/lists/deletes their site's OWN buckets and browses/uploads/downloads/deletes objects — NEVER
 * the shared platform bucket, NEVER another site's bucket. Isolation is server-resolved
 * (`resolveSiteR2Allocation` maps a tenant display-name → the site's real bucket; the shared bucket
 * names are FORBIDDEN_BUCKET_NAMES-denylisted).
 *
 * | Method | Path                                                       | Purpose                                     |
 * | ------ | ---------------------------------------------------------- | ------------------------------------------- |
 * | GET    | /api/sites/:siteId/r2/buckets                              | List the site's OWN buckets (lazy default)  |
 * | POST   | /api/sites/:siteId/r2/buckets                              | Create a bucket (returns the address bundle)|
 * | DELETE | /api/sites/:siteId/r2/buckets/:bucket                      | Empty then delete a bucket                  |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/address             | The copyable address bundle                 |
 * | POST   | /api/sites/:siteId/r2/buckets/:bucket/public              | Toggle public access                        |
 * | POST   | /api/sites/:siteId/r2/buckets/:bucket/promote             | Snapshot preview → production               |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/objects             | List objects (prefix + cursor + delimiter)  |
 * | PUT    | /api/sites/:siteId/r2/buckets/:bucket/objects/*          | Upload an object (multipart or base64 JSON) |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/objects/*          | Download an object                          |
 * | DELETE | /api/sites/:siteId/r2/buckets/:bucket/objects/*         | Delete an object                            |
 *
 * Every route: (1) 401 if unauthenticated; (2) **404 (DARK) when `r2_buckets` is off** (never 403, never
 * leak existence); (3) `ownsSiteData` IDOR guard (404 on a foreign/missing site); (4) then resolve the
 * bucket allocation. Object ops need R2 S3 creds — when absent they return a clear, actionable
 * `needs R2 S3 credentials` message (503), never a raw 500; bucket CRUD (REST) works regardless.
 *
 * @packageDocumentation
 */
import { type Context, Hono } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import {
  bucketAddress,
  createSiteOwnerKey,
  deleteSiteR2,
  deleteSiteR2Object,
  ensureDefaultSiteR2,
  getSiteOwnerKeyStatus,
  getSiteR2Object,
  hasObjectOpsForSite,
  isValidBucketDisplayName,
  listSiteR2Allocations,
  listSiteR2Objects,
  promoteSiteR2,
  provisionSiteR2,
  putSiteR2Object,
  resolveSiteR2Allocation,
  revokeSiteOwnerKey,
  rotateSiteOwnerKey,
  setSiteR2PublicAccess,
  type SiteR2Allocation,
  type SiteR2Failure,
} from '../../../src/services/site_r2.js';
import {
  CreateBucketBodySchema,
  ListObjectsQuerySchema,
  R2_BUCKETS_FLAG as FLAG,
  R2_OWNER_KEY_FLAG,
  SetPublicBodySchema,
  UploadJsonBodySchema,
} from './schemas.js';
import { ownsSiteData } from '../site_data_api/handlers.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const r2Buckets = new Hono<AppContext>();

/** Max object upload size (25 MB — mirrors the media upload cap). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Map a per-site R2 failure to an honest HTTP response (never a shared-bucket fallback). */
function r2Failure(c: Context<AppContext>, reason: SiteR2Failure, message?: string) {
  switch (reason) {
    case 'needs_s3_credentials':
      return c.json(
        {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: message ?? 'File storage for this site is still being set up.',
          },
          ok: false,
        },
        503,
      );
    case 'no_cf_credentials':
    case 'no_account_id':
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'Bucket storage is not configured yet.' }, ok: false },
        503,
      );
    case 'forbidden_bucket':
      console.warn(
        JSON.stringify({ level: 'error', msg: 'r2_buckets_isolation_guard_tripped', service: 'r2_buckets' }),
      );
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Storage error.' }, ok: false }, 500);
    case 'not_allocated':
      return c.json({ error: { code: 'NOT_FOUND', message: 'Bucket not found' }, ok: false }, 404);
    default:
      return c.json(
        { error: { code: 'DATA_STORE_ERROR', message: message ?? 'Bucket storage request failed.' }, ok: false },
        502,
      );
  }
}

/**
 * Shared gate: auth → flag-dark-404 → ownership-404 → resolve the site's tenant id (for provisioning).
 * Returns `{ orgId, tenantId }` on success, or a `Response` the caller returns verbatim. `flag` defaults
 * to the bucket-surface flag; the owner-key routes pass {@link R2_OWNER_KEY_FLAG} (the credential flag).
 * The flag check runs BEFORE the ownership check so a dark surface never confirms a site's existence.
 */
async function gate(
  c: Context<AppContext>,
  siteId: string,
  flag: string = FLAG,
): Promise<{ orgId: string; tenantId: string } | Response> {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Must be authenticated' } }, 401);
  if (!(await isFlagOn(c.env, flag, { orgId, siteId })))
    // Message MUST contain the lowercase substring "not enabled" — the admin bridge
    // (embedded-mode.ts) detects the dark-flag 404 by `message.includes('not enabled')`.
    return c.json({ error: { code: 'NOT_FOUND', message: 'This feature is not enabled' } }, 404);
  if (!(await ownsSiteData(c.env.DB, siteId, orgId)))
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);
  return { orgId, tenantId: orgId };
}

/** Extend {@link gate} by resolving ONE of the site's OWN bucket allocations (404 if not the site's). */
async function gateAndBucket(
  c: Context<AppContext>,
  siteId: string,
  bucket: string,
): Promise<{ orgId: string; tenantId: string; allocation: SiteR2Allocation } | Response> {
  const g = await gate(c, siteId);
  if (g instanceof Response) return g;
  const allocation = await resolveSiteR2Allocation(c.env, siteId, bucket);
  if (!allocation) return c.json({ error: { code: 'NOT_FOUND', message: 'Bucket not found' }, ok: false }, 404);
  return { allocation, orgId: g.orgId, tenantId: g.tenantId };
}

/** Serialize an allocation + its address bundle into the API shape the FE consumes. */
function bucketView(c: Context<AppContext>, a: SiteR2Allocation) {
  return {
    address: bucketAddress(c.env, a),
    createdAt: a.createdAt,
    environment: a.environment,
    isDefault: a.isDefault,
    name: a.displayName,
    public: a.publicAccess,
    publicUrl: a.publicAccess ? a.publicBaseUrl : null,
  };
}

// ── GET /api/sites/:siteId/r2/buckets — list (lazy-provision the default) ──────────────────────────
r2Buckets.get('/api/sites/:siteId/r2/buckets', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId);
  if (g instanceof Response) return g;

  // Lazily provision the default "uploads" bucket on first access (idempotent) — the empty state still
  // shows a launchpad, but the site always has at least its default bucket allocation.
  const ensured = await ensureDefaultSiteR2(c.env, siteId, g.tenantId, g.orgId);
  if (!ensured.ok) return r2Failure(c, ensured.reason, ensured.message);

  const allocations = await listSiteR2Allocations(c.env, siteId);
  return c.json({
    data: {
      buckets: allocations.map((a) => bucketView(c, a)),
      objectOpsAvailable: await hasObjectOpsForSite(c.env, { orgId: g.orgId, siteId }),
    },
    ok: true,
  });
});

// ── POST /api/sites/:siteId/r2/buckets — create ───────────────────────────────────────────────────
r2Buckets.post('/api/sites/:siteId/r2/buckets', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId);
  if (g instanceof Response) return g;

  const parsed = CreateBucketBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid bucket name' }, ok: false }, 400);
  if (!isValidBucketDisplayName(parsed.data.name))
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid bucket name' }, ok: false }, 400);

  // 409 when this site already has a bucket by that display name (dup-name conflict).
  const existing = await resolveSiteR2Allocation(c.env, siteId, parsed.data.name.trim());
  if (existing)
    return c.json({ error: { code: 'CONFLICT', message: 'A bucket with that name already exists' }, ok: false }, 409);

  const result = await provisionSiteR2(c.env, {
    displayName: parsed.data.name,
    jurisdiction: parsed.data.jurisdiction ?? null,
    orgId: g.orgId,
    publicAccess: parsed.data.public ?? false,
    siteId,
    tenantId: g.tenantId,
  });
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: bucketView(c, result.allocation), ok: true }, 201);
});

// ── Owner-facing scoped R2 key (B5 slice 4) ─────────────────────────────────────────────────────────
//
// A SEPARATE credential from the Worker's internal object-ops token: the key the SITE OWNER mints to use
// R2 from their OWN tooling (wrangler / aws-cli / SDKs), scoped to ONLY their site's buckets. The Secret
// Access Key is returned ONCE on create/rotate and NEVER persisted. Every route: auth → `r2_bucket_manager`
// flag-dark-404 → ownsSiteData IDOR-404 (via `gate(…, R2_OWNER_KEY_FLAG)`) → the owner-key service.

// ── GET /api/sites/:siteId/r2/keys — masked status (NEVER the secret) ───────────────────────────────
r2Buckets.get('/api/sites/:siteId/r2/keys', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await getSiteOwnerKeyStatus(c.env, { orgId: g.orgId, siteId, tenantId: g.tenantId });
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: result.key, ok: true });
});

// ── POST /api/sites/:siteId/r2/keys — create (show-once secret; idempotent → masked if one exists) ──
r2Buckets.post('/api/sites/:siteId/r2/keys', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await createSiteOwnerKey(c.env, {
    actorId: c.get('userId') ?? null,
    orgId: g.orgId,
    siteId,
    tenantId: g.tenantId,
  });
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  // reused:true → an active key already exists; return its MASKED status (200), no secret.
  // reused:false → a fresh key; return the SHOW-ONCE secret (201). The secret is never retrievable again.
  return c.json({ data: result.key, ok: true }, result.reused ? 200 : 201);
});

// ── POST /api/sites/:siteId/r2/keys/rotate — revoke old + mint new (show-once secret) ───────────────
r2Buckets.post('/api/sites/:siteId/r2/keys/rotate', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await rotateSiteOwnerKey(c.env, {
    actorId: c.get('userId') ?? null,
    orgId: g.orgId,
    siteId,
    tenantId: g.tenantId,
  });
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: result.key, ok: true }, 201);
});

// ── DELETE /api/sites/:siteId/r2/keys — revoke (idempotent) ─────────────────────────────────────────
r2Buckets.delete('/api/sites/:siteId/r2/keys', async (c) => {
  const { siteId } = c.req.param();
  const g = await gate(c, siteId, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await revokeSiteOwnerKey(c.env, {
    actorId: c.get('userId') ?? null,
    orgId: g.orgId,
    siteId,
    tenantId: g.tenantId,
  });
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: { revoked: result.revoked }, ok: true });
});

// ── DELETE /api/sites/:siteId/r2/buckets/:bucket — empty then delete ───────────────────────────────
r2Buckets.delete('/api/sites/:siteId/r2/buckets/:bucket', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;

  const result = await deleteSiteR2(c.env, siteId, g.tenantId, g.allocation, g.orgId);
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: { deleted: true, name: bucket, objectsDeleted: result.objectsDeleted }, ok: true });
});

// ── GET /api/sites/:siteId/r2/buckets/:bucket/address — the copyable address bundle ────────────────
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/address', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  return c.json({ data: bucketAddress(c.env, g.allocation), ok: true });
});

// ── POST /api/sites/:siteId/r2/buckets/:bucket/public — toggle public access ───────────────────────
r2Buckets.post('/api/sites/:siteId/r2/buckets/:bucket/public', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  const parsed = SetPublicBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' }, ok: false }, 400);
  const updated = await setSiteR2PublicAccess(c.env, siteId, g.allocation, parsed.data.public);
  return c.json({ data: bucketView(c, updated), ok: true });
});

// ── POST /api/sites/:siteId/r2/buckets/:bucket/promote — snapshot preview → production ──────────────
r2Buckets.post('/api/sites/:siteId/r2/buckets/:bucket/promote', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  const result = await promoteSiteR2(c.env, siteId, g.tenantId, g.allocation, g.orgId);
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({
    data: { objectsCopied: result.objectsCopied, production: bucketView(c, result.production) },
    ok: true,
  });
});

// ── GET /api/sites/:siteId/r2/buckets/:bucket/objects — list (prefix + cursor + delimiter) ──────────
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/objects', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;

  const parsed = ListObjectsQuerySchema.safeParse({
    cursor: c.req.query('cursor'),
    delimiter: c.req.query('delimiter'),
    limit: c.req.query('limit'),
    prefix: c.req.query('prefix'),
  });
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid query' }, ok: false }, 400);

  const result = await listSiteR2Objects(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
    {
      cursor: parsed.data.cursor,
      delimiter: parsed.data.delimiter,
      maxKeys: parsed.data.limit,
      prefix: parsed.data.prefix,
    },
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({
    data: { cursor: result.cursor, objects: result.objects, prefixes: result.prefixes, truncated: result.truncated },
    ok: true,
  });
});

/** Extract the object key from a wildcard route (`…/objects/*`), URL-decoded + traversal-guarded. */
function objectKeyFromPath(c: Context<AppContext>): string | null {
  // Hono 4.x does NOT expose a trailing `*` capture via param('0') or param('*') — both are undefined.
  // Slice the raw pathname after the FIRST `/objects/` (bucket display names can't contain '/', so the
  // route marker is unambiguous; a key MAY itself contain `/objects/`, which correctly stays in the key).
  const marker = '/objects/';
  const pathname = new URL(c.req.url).pathname;
  const idx = pathname.indexOf(marker);
  if (idx < 0) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(idx + marker.length));
  } catch {
    return null; // malformed percent-encoding
  }
  // Reject traversal / empty (a leading slash is fine — R2 keys can't escape their bucket, but keep it tidy).
  if (!key || key.includes('..') || key.startsWith('/')) return null;
  return key;
}

// ── PUT /api/sites/:siteId/r2/buckets/:bucket/objects/* — upload (multipart or base64 JSON) ─────────
r2Buckets.put('/api/sites/:siteId/r2/buckets/:bucket/objects/*', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  const key = objectKeyFromPath(c);
  if (!key) return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid object key' }, ok: false }, 400);

  const contentTypeHeader = c.req.header('content-type') ?? '';
  let body: ArrayBuffer;
  let contentType: string;

  try {
    if (contentTypeHeader.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      // Duck-typed File check (the Workers `File` global isn't in every tsconfig lib context).
      if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function')
        return c.json({ error: { code: 'BAD_REQUEST', message: 'No file provided' }, ok: false }, 400);
      const blob = file as Blob;
      body = await blob.arrayBuffer();
      contentType = blob.type || 'application/octet-stream';
    } else if (contentTypeHeader.includes('application/json')) {
      const parsed = UploadJsonBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success)
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid upload body' }, ok: false }, 400);
      const decoded = decodeBase64DataUrl(parsed.data.dataUrl);
      if (!decoded) return c.json({ error: { code: 'BAD_REQUEST', message: 'Could not decode file' }, ok: false }, 400);
      body = decoded.bytes;
      contentType = parsed.data.contentType || decoded.mime || 'application/octet-stream';
    } else {
      // Raw body upload — content-type carries the MIME.
      body = await c.req.arrayBuffer();
      contentType = contentTypeHeader || 'application/octet-stream';
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Could not read the upload' }, ok: false }, 400);
  }

  if (body.byteLength === 0)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Empty file' }, ok: false }, 400);
  if (body.byteLength > MAX_UPLOAD_BYTES)
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large (25 MB max).' }, ok: false }, 413);

  const result = await putSiteR2Object(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
    key,
    body,
    contentType,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: { contentType, key: result.key, size: result.size }, ok: true }, 201);
});

// ── GET /api/sites/:siteId/r2/buckets/:bucket/objects/* — download ─────────────────────────────────
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/objects/*', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  const key = objectKeyFromPath(c);
  if (!key) return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid object key' }, ok: false }, 400);

  const result = await getSiteR2Object(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
    key,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  const filename = key.split('/').pop() || 'download';
  return new Response(result.body, {
    headers: {
      'cache-control': 'private, max-age=0',
      'content-disposition': `inline; filename="${filename.replace(/["\\]/g, '')}"`,
      'content-length': String(result.size),
      'content-type': result.contentType,
      'x-content-type-options': 'nosniff',
    },
    status: 200,
  });
});

// ── DELETE /api/sites/:siteId/r2/buckets/:bucket/objects/* — delete one object ──────────────────────
r2Buckets.delete('/api/sites/:siteId/r2/buckets/:bucket/objects/*', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;
  const key = objectKeyFromPath(c);
  if (!key) return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid object key' }, ok: false }, 400);

  const result = await deleteSiteR2Object(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
    key,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: { deleted: true, key }, ok: true });
});

/** Decode a base64 data URL (or bare base64) into bytes + optional MIME. Returns null on garbage. */
function decodeBase64DataUrl(dataUrl: string): { bytes: ArrayBuffer; mime: string } | null {
  try {
    const match = /^data:([^;]*);base64,(.*)$/s.exec(dataUrl);
    const base64 = match ? match[2]! : dataUrl.replace(/^data:[^,]*,/, '');
    const mime = match ? match[1]! : '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes: bytes.buffer, mime };
  } catch {
    return null;
  }
}
