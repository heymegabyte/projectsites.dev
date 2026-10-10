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
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/objects             | List objects (prefix+cursor+delimiter) OR whole-bucket search (`?search=`, B11) |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/zip                 | Download the whole bucket as one bounded `.zip` (B7) |
 * | PUT    | /api/sites/:siteId/r2/buckets/:bucket/objects/*          | Upload an object (multipart or base64 JSON) |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/objects/*          | Download an object                          |
 * | DELETE | /api/sites/:siteId/r2/buckets/:bucket/objects/*         | Delete an object                            |
 * | GET    | /api/sites/:siteId/r2/buckets/:bucket/keys                | Per-bucket owner key — masked status        |
 * | POST   | /api/sites/:siteId/r2/buckets/:bucket/keys                | Per-bucket owner key — create (show-once)   |
 * | POST   | /api/sites/:siteId/r2/buckets/:bucket/keys/rotate         | Per-bucket owner key — rotate (show-once)   |
 * | DELETE | /api/sites/:siteId/r2/buckets/:bucket/keys                | Per-bucket owner key — revoke (idempotent)  |
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
  copySiteR2Object,
  createBucketOwnerKey,
  createSiteOwnerKey,
  deleteSiteR2,
  deleteSiteR2Object,
  ensureDefaultSiteR2,
  getBucketOwnerKeyStatus,
  getSiteOwnerKeyStatus,
  getSiteR2Object,
  hasObjectOpsForSite,
  isValidBucketDisplayName,
  listSiteR2Allocations,
  listSiteR2Objects,
  moveSiteR2Prefix,
  promoteSiteR2,
  provisionSiteR2,
  putSiteR2Object,
  renameSiteR2Object,
  resolveSiteR2Allocation,
  revokeBucketOwnerKey,
  revokeSiteOwnerKey,
  rotateBucketOwnerKey,
  rotateSiteOwnerKey,
  searchSiteR2Objects,
  setSiteR2PublicAccess,
  type SiteR2Allocation,
  type SiteR2Failure,
  type SiteR2Result,
  zipSiteR2Bucket,
} from '../../../src/services/site_r2.js';
import {
  CopyObjectBodySchema,
  CreateBucketBodySchema,
  ListObjectsQuerySchema,
  R2_BUCKETS_FLAG as FLAG,
  R2_OWNER_KEY_FLAG,
  SetPublicBodySchema,
  UploadJsonBodySchema,
} from './schemas.js';
import { writeAuditLog } from '../../../src/services/audit.js';
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
    case 'object_not_found':
      // The OBJECT (key) doesn't exist — a client 404, NEVER a 502 (an S3 GET on a missing key returns
      // 404 NoSuchKey; without this it'd fall into the default DATA_STORE_ERROR 502). The ownership gate
      // already ran, so this never leaks cross-site existence.
      return c.json({ error: { code: 'NOT_FOUND', message: message ?? 'File not found' }, ok: false }, 404);
    case 'destination_exists':
      return c.json(
        {
          error: {
            code: 'CONFLICT',
            message: message ?? 'Something with that name already exists here. Choose a different name.',
          },
          ok: false,
        },
        409,
      );
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

/**
 * Extend {@link gate} by resolving ONE of the site's OWN bucket allocations (404 if not the site's).
 * `resolveSiteR2Allocation` is `WHERE site_id = ?`-scoped, so a foreign/other-site bucket resolves to
 * null → 404 (the IDOR guard — you can never act on another site's bucket). `flag` defaults to the
 * bucket-surface flag; the per-bucket owner-KEY routes pass {@link R2_OWNER_KEY_FLAG}.
 */
async function gateAndBucket(
  c: Context<AppContext>,
  siteId: string,
  bucket: string,
  flag: string = FLAG,
): Promise<{ orgId: string; tenantId: string; allocation: SiteR2Allocation } | Response> {
  const g = await gate(c, siteId, flag);
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

// ── Per-BUCKET owner-facing scoped R2 key (B4) ──────────────────────────────────────────────────────
//
// A FINER grain than the site-wide owner key above: the key a SITE OWNER mints scoped to ONE of their
// buckets (not all of them), for use from their OWN tooling (wrangler / aws-cli / SDKs). Same show-once
// secret (never persisted). Every route: auth → `r2_bucket_manager` flag-dark-404 → ownsSiteData IDOR-404
// → resolve the site's OWN bucket (another site's bucket 404s via `gateAndBucket`) → the per-bucket key
// service (which additionally re-verifies the bucket is an owned allocation before any CF mint).

// ── GET /api/sites/:siteId/r2/buckets/:bucket/keys — masked status (NEVER the secret) ───────────────
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/keys', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await getBucketOwnerKeyStatus(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: result.key, ok: true });
});

// ── POST /api/sites/:siteId/r2/buckets/:bucket/keys — create (show-once; idempotent → masked) ───────
r2Buckets.post('/api/sites/:siteId/r2/buckets/:bucket/keys', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await createBucketOwnerKey(
    c.env,
    { actorId: c.get('userId') ?? null, orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  // reused:true → an active key already exists; return its MASKED status (200), no secret.
  // reused:false → a fresh key; return the SHOW-ONCE secret (201). The secret is never retrievable again.
  return c.json({ data: result.key, ok: true }, result.reused ? 200 : 201);
});

// ── POST /api/sites/:siteId/r2/buckets/:bucket/keys/rotate — revoke old + mint new (show-once) ──────
r2Buckets.post('/api/sites/:siteId/r2/buckets/:bucket/keys/rotate', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await rotateBucketOwnerKey(
    c.env,
    { actorId: c.get('userId') ?? null, orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);
  return c.json({ data: result.key, ok: true }, 201);
});

// ── DELETE /api/sites/:siteId/r2/buckets/:bucket/keys — revoke (idempotent) ─────────────────────────
r2Buckets.delete('/api/sites/:siteId/r2/buckets/:bucket/keys', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket, R2_OWNER_KEY_FLAG);
  if (g instanceof Response) return g;
  const result = await revokeBucketOwnerKey(
    c.env,
    { actorId: c.get('userId') ?? null, orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
  );
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

// ── GET …/objects — list (prefix + cursor + delimiter) OR whole-bucket search (`?search=`, B11) ─────
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/objects', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;

  const parsed = ListObjectsQuerySchema.safeParse({
    cursor: c.req.query('cursor'),
    delimiter: c.req.query('delimiter'),
    limit: c.req.query('limit'),
    prefix: c.req.query('prefix'),
    search: c.req.query('search'),
  });
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid query' }, ok: false }, 400);

  const ctx = { orgId: g.orgId, siteId, tenantId: g.tenantId };
  const search = parsed.data.search?.trim();

  // B11 — a non-empty `search` switches to a BOUNDED server-side whole-bucket scan (substring match
  // across EVERY object, not just the loaded page). `prefix` still narrows it. The honest
  // `scannedAll`/`scanned`/`truncated` flags ride back so the UI never over-claims completeness.
  if (search) {
    const found = await searchSiteR2Objects(c.env, ctx, g.allocation.bucketName, {
      prefix: parsed.data.prefix,
      search,
    });
    if (!found.ok) return r2Failure(c, found.reason, found.message);
    return c.json({
      data: {
        objects: found.objects,
        // A whole-bucket search is flat (no folders) and single-shot (no cursor paging); surface the
        // scan limits instead so the UI can show "showing N of all matches / scanned up to X".
        prefixes: [],
        scanned: found.scanned,
        scannedAll: found.scannedAll,
        truncated: found.truncated,
      },
      ok: true,
    });
  }

  const result = await listSiteR2Objects(c.env, ctx, g.allocation.bucketName, {
    cursor: parsed.data.cursor,
    delimiter: parsed.data.delimiter,
    maxKeys: parsed.data.limit,
    prefix: parsed.data.prefix,
  });
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

// ── GET /api/sites/:siteId/r2/buckets/:bucket/zip — download the WHOLE bucket as one .zip (B7) ───────
//
// READ-ONLY: lists + fetches every object and streams back ONE `application/zip` attachment. BOUNDED by an
// object-count + total-uncompressed-bytes cap in the service (the archive is built in Worker memory); when
// a cap trips the service returns `truncated:true` and we surface it in `x-ps-zip-truncated` + the honest
// `x-ps-zip-count` (included) / `x-ps-zip-total` (seen) / `x-ps-zip-bytes` headers so the UI can warn the
// owner the archive is partial. Same gate order as the rest of the surface (isolation BEFORE the op):
// auth → `r2_bucket_manager` dark-404 → ownsSiteData → resolve the OWNED bucket (foreign bucket → 404 via
// gateAndBucket's `WHERE site_id` scope — the IDOR guard). The download filename uses the owner's display
// name (friendlier than the real `ps-site-…` bucket name).
r2Buckets.get('/api/sites/:siteId/r2/buckets/:bucket/zip', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;

  const result = await zipSiteR2Bucket(
    c.env,
    { orgId: g.orgId, siteId, tenantId: g.tenantId },
    g.allocation.bucketName,
  );
  if (!result.ok) return r2Failure(c, result.reason, result.message);

  // Content-Disposition filename from the owner's DISPLAY name (what they typed), sanitized so a quote /
  // backslash can't break the header. Falls back to the service's suggestion, then a constant.
  const dispName = (g.allocation.displayName || bucket || 'bucket').replace(/[^A-Za-z0-9._-]/g, '-');
  const filename = `${dispName || 'bucket'}.zip`;
  return new Response(result.zip, {
    headers: {
      'cache-control': 'private, max-age=0, no-store',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(result.zip.byteLength),
      'content-type': 'application/zip',
      'x-content-type-options': 'nosniff',
      // Honest export accounting — the UI reads these to show "capped at N files / X MB" when truncated.
      'x-ps-zip-bytes': String(result.bytesIncluded),
      'x-ps-zip-count': String(result.includedCount),
      'x-ps-zip-total': String(result.totalCount),
      'x-ps-zip-truncated': String(result.truncated),
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

// ── POST /api/sites/:siteId/r2/buckets/:bucket/objects/copy — copy / move / rename (same- OR cross-bucket) ──
//
// One endpoint for the object ops:
//   • copy    — `deleteSource` falsy, object keys           → S3 CopyObject
//   • rename  — `deleteSource:true`, object keys            → copy + delete source
//   • move    — `deleteSource:true`, a trailing `/` on BOTH keys (prefix move) → list + copy + delete per key
//   • CROSS-bucket — any of the above + `destBucket` (another of the site's bucket display names) → the copy
//     lands in that bucket (S3 CopyObject copies across buckets in one account); a cross-bucket MOVE is
//     copy-to-dest THEN delete-source (no data loss).
// Gate: auth → `r2_bucket_manager` dark-404 → ownsSiteData → resolve the OWNED source bucket (foreign →
// 404 via `resolveSiteR2Allocation`'s `WHERE site_id` scope — the IDOR guard). When `destBucket` is present
// and differs, the DEST bucket is resolved + ownership-checked the SAME way (a foreign dest → 404, never a
// cross-tenant write). A pre-existing destination 409s unless `overwrite:true`. Audit-logs
// `r2.object.{copied,moved,renamed}` with BOTH bucket display names (keys only — never a secret).
r2Buckets.post('/api/sites/:siteId/r2/buckets/:bucket/objects/copy', async (c) => {
  const { siteId, bucket } = c.req.param();
  const g = await gateAndBucket(c, siteId, bucket);
  if (g instanceof Response) return g;

  const parsed = CopyObjectBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid copy request' }, ok: false }, 400);
  const { srcKey, destKey, deleteSource, overwrite, destBucket } = parsed.data;

  const ctx = { orgId: g.orgId, siteId, tenantId: g.tenantId };
  const bucketName = g.allocation.bucketName;

  // CROSS-bucket: resolve the DEST bucket the SAME `WHERE site_id`-scoped way (the dual IDOR guard). A
  // foreign/other-site dest → null → 404 (never a cross-tenant write). A destBucket equal to the path
  // bucket (or absent) stays the same-bucket path — no extra resolve, no behavior change.
  const isCrossBucket = !!destBucket && destBucket !== bucket;
  let destReal: string | undefined;
  let destDisplay: string | undefined;
  if (isCrossBucket) {
    const destAlloc = await resolveSiteR2Allocation(c.env, siteId, destBucket);
    if (!destAlloc)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Destination bucket not found' }, ok: false }, 404);
    destReal = destAlloc.bucketName;
    destDisplay = destAlloc.displayName;
  }
  const opOpts = { destBucket: destReal, overwrite };

  // A prefix move = both keys end in `/` AND deleteSource (renaming a "folder").
  const isPrefixMove = !!deleteSource && srcKey.endsWith('/') && destKey.endsWith('/');

  let action: 'copied' | 'moved' | 'renamed';
  let result: SiteR2Result<{ key?: string; moved?: number }>;
  if (isPrefixMove) {
    action = 'moved';
    result = await moveSiteR2Prefix(c.env, ctx, bucketName, srcKey, destKey, opOpts);
  } else if (deleteSource) {
    // rename vs move: a changed trailing segment (same parent folder) reads as a rename; a changed parent
    // reads as a move. A CROSS-bucket op is ALWAYS a move (it leaves the source bucket). Purely cosmetic
    // for the audit verb — the mechanism (copy+delete) is identical.
    const parent = (k: string) => k.slice(0, k.lastIndexOf('/') + 1);
    action = !isCrossBucket && parent(srcKey) === parent(destKey) ? 'renamed' : 'moved';
    result = await renameSiteR2Object(c.env, ctx, bucketName, srcKey, destKey, opOpts);
  } else {
    action = 'copied';
    result = await copySiteR2Object(c.env, ctx, bucketName, srcKey, destKey, opOpts);
  }

  if (!result.ok) return r2Failure(c, result.reason, result.message);

  await writeAuditLog(c.env.DB, {
    action: `r2.object.${action}`,
    actor_id: c.get('userId') ?? null,
    metadata_json: {
      bucket,
      destKey,
      srcKey,
      ...(destDisplay ? { destBucket: destDisplay } : {}),
      ...(isPrefixMove ? { moved: result.moved } : {}),
    },
    org_id: g.orgId,
    request_id: c.get('requestId') ?? null,
    target_id: siteId,
    target_type: 'site',
  });

  return c.json({
    data: { destBucket: destDisplay, destKey, moved: result.moved, ok: true, srcKey },
    ok: true,
  });
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
