/**
 * @file Per-site R2 **object storage plane** — provision + resolve + operate a SITE'S OWN Cloudflare
 * R2 buckets. The R2 analog of `site_data_db.ts` (per-site D1) + `d1_provisioner.ts`.
 *
 * The "Buckets" surface (editor Resources → Buckets) lets an owner manage their site's OWN R2 buckets —
 * NEVER the shared platform bucket (`SITES_BUCKET` = generated-site output + media) and NEVER another
 * site's buckets. That isolation is **structural + defense-in-depth**, exactly like the per-site D1:
 *
 * - Bucket names are **server-derived** (`siteR2BucketName(siteId, slug)` → `ps-site-{siteId}-{slug}`)
 *   and recorded in `site_r2_allocations` for the site the caller already proved they own
 *   (`ownsSiteData` in the route). A client NEVER names a raw bucket — it names an allocation the
 *   server maps to a real bucket (see the `x-org-id-idor-class` incident).
 * - The shared platform bucket names are on a hard denylist ({@link FORBIDDEN_BUCKET_NAMES}); any op that
 *   somehow lands on one fails closed.
 * - **Bucket CRUD** goes through the Cloudflare **R2 REST API**
 *   (`{POST,GET,DELETE} /accounts/{acct}/r2/buckets[/:name]`) with the account global key — a Worker
 *   cannot statically bind thousands of per-site R2 buckets in `wrangler.toml`, so REST is the only
 *   mechanism (same reasoning as the per-site D1 REST plane).
 * - **Object ops** (list/put/get/delete) use the **R2 S3-compatible API** signed with AWS SigV4. R2 has
 *   no REST *object* API — only S3 — so object ops require R2 S3 access keys
 *   (`R2_S3_ACCESS_KEY_ID` + `R2_S3_SECRET_ACCESS_KEY`). When those are absent, object ops return a
 *   typed `needs_s3_credentials` failure the route surfaces as a clear, actionable message (never a raw
 *   500). Bucket CRUD (REST) still works keyless-of-S3, so the golden path degrades gracefully.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';

import { type CfAuth, cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { decrypt, encrypt } from './ai_crypto.js';
import { uuidv7 } from '../lib/uuid.js';
import { dbExecute, dbQuery, dbQueryOne } from './db.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { writeAuditLog } from './audit.js';

/** Flag gating the per-site scoped-token object-ops path (DARK killswitch; see the B5 header above). */
const PER_SITE_OBJECT_OPS_FLAG = 'r2_bucket_manager';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Shared platform R2 bucket names the per-site plane must NEVER touch. `SITES_BUCKET` (generated-site
 * output + per-org media) is all-tenant platform infra; resolving/operating on it from the per-site
 * surface is a hard failure. Kept in sync with `wrangler.toml` `[[r2_buckets]]` `bucket_name` entries.
 */
export const FORBIDDEN_BUCKET_NAMES: ReadonlySet<string> = new Set([
  'project-sites-assets', // SITES_BUCKET (prod) — shared platform R2
  'project-sites-assets-preview', // SITES_BUCKET (preview)
  'project-sites', // legacy shared bucket name
  'project-sites-production', // SITES_BUCKET (prod, wrangler env.production) — shared platform R2
]);

/** One R2 bucket allocation row (per-site, tenant-owned). */
export interface SiteR2Allocation {
  readonly id: string;
  readonly bucketName: string;
  readonly displayName: string;
  readonly environment: 'preview' | 'production';
  readonly isDefault: boolean;
  readonly publicAccess: boolean;
  readonly publicBaseUrl: string | null;
  readonly createdAt: string;
}

/** A single object as R2's S3 `ListObjectsV2` reports it (normalized). */
export interface SiteR2Object {
  readonly key: string;
  readonly size: number;
  readonly uploadedAt: string | null;
  readonly etag?: string;
  readonly contentType?: string | null;
}

/** Typed failure of a per-site R2 operation — honest, never fabricated. */
export type SiteR2Failure =
  | 'no_cf_credentials'
  | 'no_account_id'
  | 'forbidden_bucket'
  | 'not_allocated'
  | 'needs_s3_credentials'
  | 'cf_error'
  | 's3_error';

/** Result wrapper: `ok` + payload, or a typed reason (+ optional CF/S3 status + message). */
export type SiteR2Result<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: SiteR2Failure;
      readonly status?: number;
      readonly message?: string;
    };

// ── Naming ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The deterministic REAL R2 bucket name for a site's tenant-facing bucket. R2 bucket names allow
 * `[a-z0-9-]`, 3–63 chars, no leading/trailing/double dash. A site id + display name are sanitized,
 * prefixed (`ps-site-`), and length-clamped so the real name is unique per site + maps 1:1 (stable →
 * idempotent create + auditable).
 *
 * @example siteR2BucketName('abc-123', 'Uploads') // 'ps-site-abc-123-uploads'
 * @example siteR2BucketName('abc-123', '')        // 'ps-site-abc-123-default'
 */
export function siteR2BucketName(siteId: string, displayName: string): string {
  const site = sanitizeBucketSegment(siteId).slice(0, 24) || 'site';
  const name = sanitizeBucketSegment(displayName).slice(0, 24) || 'default';
  let raw = `ps-site-${site}-${name}`;
  // Collapse doubles + trim edges + clamp to 63 (R2 max); never end on a dash.
  raw = raw
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return raw.length >= 3 ? raw : `${raw}-r2`;
}

/** Lowercase + strip to `[a-z0-9-]` (R2's bucket-name charset). */
function sanitizeBucketSegment(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True when a client-supplied display name is a legal short bucket name (validated at the boundary). */
export function isValidBucketDisplayName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(name.trim());
}

// ── CF R2 REST (bucket CRUD) ──────────────────────────────────────────────────────────────────────

/** A CF R2 REST call with transient-5xx retry (the R2 REST plane intermittently 500s under load). */
async function cfR2Fetch(
  auth: CfAuth,
  account: string,
  path: string,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  json: { success?: boolean; result?: unknown; errors?: unknown };
}> {
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${CF_API_BASE}/accounts/${account}/r2/buckets${path}`, {
      ...init,
      headers: { ...cfAuthHeaders(auth), ...(init?.headers as Record<string, string> | undefined) },
    });
    if (res.status < 500 || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  const r = res as Response;
  const json = (await r.json().catch(() => ({}))) as {
    success?: boolean;
    result?: unknown;
    errors?: unknown;
  };
  return { json, ok: r.ok, status: r.status };
}

/** Resolve server-side CF creds + account, or a typed failure. Shared by every REST + S3 op. */
async function resolveCf(
  env: Env,
  orgId: string | null,
): Promise<{ ok: true; auth: CfAuth; account: string } | { ok: false; reason: SiteR2Failure }> {
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { ok: false, reason: 'no_cf_credentials' };
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { ok: false, reason: 'no_account_id' };
  return { account, auth, ok: true };
}

/** List a site's OWN bucket allocations (from D1, the SSOT for which buckets a site owns). */
export async function listSiteR2Allocations(env: Env, siteId: string): Promise<SiteR2Allocation[]> {
  const { data } = await dbQuery<{
    id: string;
    bucket_name: string;
    display_name: string;
    environment: string;
    is_default: number;
    public_access: number;
    public_base_url: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, bucket_name, display_name, environment, is_default, public_access, public_base_url, created_at
       FROM site_r2_allocations
      WHERE site_id = ? AND status = 'active' AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at ASC`,
    [siteId],
  );
  return data.map((r) => ({
    bucketName: r.bucket_name,
    createdAt: r.created_at,
    displayName: r.display_name,
    environment: r.environment === 'production' ? 'production' : 'preview',
    id: r.id,
    isDefault: r.is_default === 1,
    publicAccess: r.public_access === 1,
    publicBaseUrl: r.public_base_url,
  }));
}

/** Resolve ONE of a site's OWN bucket allocations by its tenant-facing display name (isolation guard). */
export async function resolveSiteR2Allocation(
  env: Env,
  siteId: string,
  displayName: string,
): Promise<SiteR2Allocation | null> {
  const row = await dbQueryOne<{
    id: string;
    bucket_name: string;
    display_name: string;
    environment: string;
    is_default: number;
    public_access: number;
    public_base_url: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, bucket_name, display_name, environment, is_default, public_access, public_base_url, created_at
       FROM site_r2_allocations
      WHERE site_id = ? AND display_name = ? AND status = 'active' AND deleted_at IS NULL`,
    [siteId, displayName],
  );
  if (!row) return null;
  if (FORBIDDEN_BUCKET_NAMES.has(row.bucket_name)) return null; // defense-in-depth
  return {
    bucketName: row.bucket_name,
    createdAt: row.created_at,
    displayName: row.display_name,
    environment: row.environment === 'production' ? 'production' : 'preview',
    id: row.id,
    isDefault: row.is_default === 1,
    publicAccess: row.public_access === 1,
    publicBaseUrl: row.public_base_url,
  };
}

/**
 * Provision (or reuse) a per-site R2 bucket. Idempotent: an existing ACTIVE allocation for the same
 * (site, display name) is reused (never a duplicate on retry). Creates the real bucket via CF R2 REST,
 * then records the allocation. Fails soft + honest — records NOTHING when the create fails.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param input - the owned site + tenant + tenant-facing display name (+ default/public flags)
 */
export async function provisionSiteR2(
  env: Env,
  input: {
    siteId: string;
    tenantId: string;
    displayName: string;
    orgId?: string | null;
    isDefault?: boolean;
    publicAccess?: boolean;
    environment?: 'preview' | 'production';
    jurisdiction?: string | null;
  },
): Promise<SiteR2Result<{ allocation: SiteR2Allocation; reused: boolean }>> {
  const orgId = input.orgId ?? null;
  const displayName = input.displayName.trim();

  // 1. Idempotency — reuse an existing ACTIVE allocation for the same (site, display name).
  const existing = await resolveSiteR2Allocation(env, input.siteId, displayName);
  if (existing) return { allocation: existing, ok: true, reused: true };

  // 2. Server-side creds + account.
  const cf = await resolveCf(env, orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  // 3. Create the real bucket via CF R2 REST.
  const bucketName = siteR2BucketName(input.siteId, displayName);
  if (FORBIDDEN_BUCKET_NAMES.has(bucketName)) return { ok: false, reason: 'forbidden_bucket' };
  const body: Record<string, string> = { name: bucketName };
  // Optional data-residency hint (eu | fedramp) → CF `jurisdiction`.
  if (input.jurisdiction) body.jurisdiction = input.jurisdiction;
  const created = await cfR2Fetch(cf.auth, cf.account, '', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  // 409 = bucket already exists in R2 (an orphaned name from a prior partial provision). Reuse it.
  const alreadyExists =
    !created.json.success &&
    Array.isArray(created.json.errors) &&
    (created.json.errors as Array<{ code?: number; message?: string }>).some(
      (e) => e.code === 10004 || /already exists|already owned/i.test(String(e.message ?? '')),
    );
  if (!created.json.success && !alreadyExists) {
    return {
      message: describeErrors(created.json.errors),
      ok: false,
      reason: 'cf_error',
      status: created.status,
    };
  }

  // 4. Record the allocation.
  const id = uuidv7();
  await dbExecute(
    env.DB,
    `INSERT INTO site_r2_allocations
       (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, public_base_url, jurisdiction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
     ON CONFLICT(bucket_name) DO UPDATE SET
       status = 'active', display_name = excluded.display_name, updated_at = datetime('now')`,
    [
      id,
      input.tenantId,
      input.siteId,
      bucketName,
      displayName,
      input.environment ?? 'preview',
      input.isDefault ? 1 : 0,
      input.publicAccess ? 1 : 0,
      input.publicAccess ? publicBaseUrlFor(bucketName) : null,
      input.jurisdiction ?? null,
    ],
  );

  const allocation = await resolveSiteR2Allocation(env, input.siteId, displayName);
  if (!allocation) return { message: 'allocation not persisted', ok: false, reason: 'cf_error' };
  // A NEW bucket changes the site's token scope → invalidate so the next object op re-mints a token
  // that covers it (otherwise uploads/browse on the new bucket would 403). Best-effort (never throws).
  await invalidateSiteS3Tokens(env, input.siteId, cf.auth, cf.account);
  return { allocation, ok: true, reused: false };
}

/**
 * Lazily provision (or reuse) a site's DEFAULT bucket — the "preview" bucket every site gets on first
 * access to the Buckets tab (mirrors the per-site D1's lazy blank-DB provision). Idempotent.
 */
export async function ensureDefaultSiteR2(
  env: Env,
  siteId: string,
  tenantId: string,
  orgId: string | null,
): Promise<SiteR2Result<{ allocation: SiteR2Allocation; reused: boolean }>> {
  const existing = await dbQueryOne<{ display_name: string }>(
    env.DB,
    `SELECT display_name FROM site_r2_allocations
       WHERE site_id = ? AND is_default = 1 AND status = 'active' AND deleted_at IS NULL`,
    [siteId],
  );
  // B2: new sites seed a "Preview" default (the legacy 'uploads' name is retired via migration 0649).
  // An EXISTING default keeps its stored display_name (migrated rows read back as 'Preview').
  const displayName = existing?.display_name ?? 'Preview';
  return provisionSiteR2(env, { displayName, isDefault: true, orgId, siteId, tenantId });
}

/**
 * Ensure the site's PRODUCTION bucket exists — called from the first production DEPLOY path,
 * NOT lazily on a Buckets-tab view (Brian 2026-10-08: don't materialize the production bucket
 * until the site is actually deployed to production the first time). Idempotent + non-fatal:
 * returns the existing production allocation if present, provisions it otherwise, and NEVER
 * throws into the deploy flow. A site that has never shipped to production simply shows its
 * preview bucket only; once it deploys, the Buckets tab lists preview + production.
 */
export async function ensureProductionSiteR2(
  env: Env,
  siteId: string,
  tenantId: string,
  orgId: string | null,
): Promise<boolean> {
  try {
    const existing = await dbQueryOne<{ id: string }>(
      env.DB,
      `SELECT id FROM site_r2_allocations
         WHERE site_id = ? AND environment = 'production' AND status = 'active' AND deleted_at IS NULL`,
      [siteId],
    );
    if (existing) return true;
    const result = await provisionSiteR2(env, {
      // B2: the production default is named "Production" (legacy lowercase 'production' retired via 0649).
      displayName: 'Production',
      environment: 'production',
      orgId,
      siteId,
      tenantId,
    });
    return result.ok;
  } catch {
    return false;
  }
}

// ── Per-site R2 S3 token (Buckets B5 slice 1 — credential foundation, flag-dark) ───────────────────
//
// R2 has NO REST object API — object ops require R2 S3 access keys. The platform has no account-wide
// `R2_S3_*` env key (and doesn't want one), so object ops are powered by PER-SITE, bucket-SCOPED S3
// tokens: mint once via the CF Create-Token API scoped to the site's OWN buckets, store the secret
// ENCRYPTED, reuse every request. Slice 2 WIRES this into the credential path — `resolveSiteS3Config`
// (below) resolves a site's token and every object op signs with it, gated behind the DARK
// `r2_bucket_manager` flag (reversible killswitch). Global `R2_S3_*` env creds, if ever set, win as an
// escape hatch. `ensureSiteS3Token` is the mint/reuse foundation it builds on.
//
// CF Create-Token endpoint (account-owned token) — LIVE-CONFIRMED (B5 slice 2, 2026-10-10):
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/tokens
//   body: { name, policies: [{ effect:'allow', resources:{ <bucket-resource-key>:'*' }, permission_groups:[...] }] }
// The returned `result.id` IS the S3 Access Key ID; the Secret Access Key is the SHA-256 hex of
// `result.value` (the raw token string). Verified end-to-end against real CF: mint → derive →
// S3 ListObjectsV2 returns 200. Per https://developers.cloudflare.com/r2/api/tokens/.
// Bucket-scoped resource key (one per owned bucket):
//   "com.cloudflare.edge.r2.bucket.{ACCOUNT_ID}_default_{BUCKET_NAME}": "*"  (default = non-jurisdictional)
// R2 object access is TWO separate permission groups — there is NO single "Read and Write" group. We
// grant BOTH so the token can list/get (Read) AND put/delete (Write). Ids confirmed live via
// GET /accounts/{account_id}/tokens/permission_groups (filtered to the R2 groups). (The slice-1
// placeholder `d229766…fff9` was BOGUS — it did not exist, so minting would have failed in prod.)
const R2_OBJECT_READ_PERMISSION_GROUP_ID = '6a018a9f2fc74eb6b293b0c548f38b39'; // Workers R2 Storage Bucket Item Read
const R2_OBJECT_WRITE_PERMISSION_GROUP_ID = '2efd5506f9c8494dacb1fa10a3e7d5b6'; // Workers R2 Storage Bucket Item Write

/** A minted (or reused) per-site R2 S3 token. `secret` is the plaintext Secret Access Key. */
export interface SiteR2S3Token {
  readonly accessKeyId: string;
  readonly secret: string;
  readonly tokenId: string;
}

/** Build the bucket-scoped Access-Policy resource map for the CF Create-Token request. */
function bucketScopeResources(
  account: string,
  bucketNames: readonly string[],
): Record<string, '*'> {
  const resources: Record<string, '*'> = {};
  for (const name of bucketNames) {
    // JURISDICTION is `default` for non-jurisdictional buckets (the only kind the per-site plane mints).
    resources[`com.cloudflare.edge.r2.bucket.${account}_default_${name}`] = '*';
  }
  return resources;
}

/**
 * Ensure a per-site, bucket-SCOPED R2 S3 token exists for a site. Idempotent: an existing ACTIVE row
 * for the site is returned WITHOUT minting a second CF token. Otherwise resolves server-side CF creds,
 * calls the CF Create-Token endpoint scoped to ONLY this site's OWN bucket names, ENCRYPTS the derived
 * Secret Access Key (the Worker reuses it on every object op — stored at rest, NOT show-once), records
 * the row, and returns `{accessKeyId, secret, tokenId}`. Mirrors {@link provisionSiteR2}'s
 * early-return-on-existing + resolveCf + fetch + record shape. Fails soft + honest — records NOTHING
 * when creds are absent or the CF create fails.
 *
 * NOTE: dormant until slice 2 wires object ops onto per-site tokens; the credential path is unchanged.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source + MCP_ENCRYPTION_KEY)
 * @param siteId - the OWNED site (caller must have proven ownership upstream)
 * @param tenantId - the org / tenant the token belongs to
 * @param orgId - org whose stored CF creds to prefer (falls back to worker-bundled)
 */
export async function ensureSiteS3Token(
  env: Env,
  siteId: string,
  tenantId: string,
  orgId: string | null,
): Promise<SiteR2Result<SiteR2S3Token>> {
  // 1. Idempotency — reuse an existing ACTIVE token for this site (never a 2nd CF token on retry).
  const existing = await dbQueryOne<{
    access_key_id: string;
    secret_enc: string;
    cf_token_id: string;
  }>(
    env.DB,
    // kind='internal' ONLY — the Worker's reusable object-ops token. An owner-facing key
    // (kind='owner', slice 4) stores NO secret, so it must never be returned here (its empty
    // `secret_enc` would break object signing). See migration 0661.
    `SELECT access_key_id, secret_enc, cf_token_id
       FROM site_r2_s3_tokens
      WHERE site_id = ? AND kind = 'internal' AND status = 'active' AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [siteId],
  );
  if (existing) {
    let secret = '';
    try {
      secret = await decrypt(env, existing.secret_enc);
    } catch {
      secret = '';
    }
    return {
      accessKeyId: existing.access_key_id,
      ok: true,
      secret,
      tokenId: existing.cf_token_id,
    };
  }

  // 2. Server-side creds + account.
  const cf = await resolveCf(env, orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  // 3. Resolve the site's OWN bucket names → the token scope (never account-wide, never another site's).
  const allocations = await listSiteR2Allocations(env, siteId);
  const bucketNames = allocations
    .map((a) => a.bucketName)
    .filter((n) => !FORBIDDEN_BUCKET_NAMES.has(n));
  const resources = bucketScopeResources(cf.account, bucketNames);

  // 4. Mint the bucket-scoped CF API token.
  const created = await cfCreateToken(cf.auth, cf.account, {
    name: `ps-site-${siteId}-r2-s3`,
    policies: [
      {
        effect: 'allow',
        permission_groups: [
          { id: R2_OBJECT_READ_PERMISSION_GROUP_ID },
          { id: R2_OBJECT_WRITE_PERMISSION_GROUP_ID },
        ],
        resources,
      },
    ],
  });
  if (!created.ok || !created.id || created.value === undefined) {
    return {
      message: created.message ?? 'Cloudflare token create failed',
      ok: false,
      reason: 'cf_error',
      status: created.status,
    };
  }

  // The S3 Secret Access Key is the SHA-256 hex of the raw token `value` (CF docs).
  const secret = await sha256Hex(created.value);
  const secretEnc = await encrypt(env, secret);

  // 5. Record the row (secret stored ENCRYPTED).
  await dbExecute(
    env.DB,
    `INSERT INTO site_r2_s3_tokens
       (id, tenant_id, site_id, access_key_id, secret_enc, cf_token_id, scope_bucket_ids, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', 'active', datetime('now'), datetime('now'))`,
    [uuidv7(), tenantId, siteId, created.id, secretEnc, created.id, JSON.stringify(bucketNames)],
  );

  return { accessKeyId: created.id, ok: true, secret, tokenId: created.id };
}

/** POST the CF Create-Token request; normalizes the result to `{ id, value }` or a typed failure. */
async function cfCreateToken(
  auth: CfAuth,
  account: string,
  body: {
    name: string;
    policies: Array<{
      effect: 'allow';
      resources: Record<string, '*'>;
      permission_groups: Array<{ id: string }>;
    }>;
  },
): Promise<{
  ok: boolean;
  status: number;
  id?: string;
  value?: string;
  message?: string;
}> {
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${CF_API_BASE}/accounts/${account}/tokens`, {
      body: JSON.stringify(body),
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'POST',
    });
    if (res.status < 500 || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  const r = res as Response;
  const json = (await r.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { id?: string; value?: string };
    errors?: unknown;
  };
  if (!json.success) {
    return { message: describeErrors(json.errors), ok: false, status: r.status };
  }
  return { id: json.result?.id, ok: true, status: r.status, value: json.result?.value };
}

/** DELETE a CF API token by id (best-effort revoke at Cloudflare). Returns whether CF acked the delete. */
async function cfDeleteToken(auth: CfAuth, account: string, tokenId: string): Promise<boolean> {
  try {
    const res = await fetch(`${CF_API_BASE}/accounts/${account}/tokens/${tokenId}`, {
      headers: cfAuthHeaders(auth),
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Per-site OWNER-FACING scoped R2 key (Buckets B5 slice 4) ────────────────────────────────────────
//
// SEPARATE from the Worker's INTERNAL object-ops token (ensureSiteS3Token above). This is a key the
// SITE OWNER mints to use R2 from their OWN tooling (wrangler / aws-cli / SDKs). Same CF-token-minting
// pattern (both R2 object Read + Write permission groups, scoped to ONLY the site's OWN buckets via
// {@link bucketScopeResources}) — but a DIFFERENT lifecycle + visibility:
//   • The Secret Access Key is returned ONCE at create/rotate and NEVER persisted (the CF create-token
//     response is the only place it ever exists — we store only accessKeyId + cf_token_id + status +
//     timestamps). `secret_enc` is NOT NULL on the table, so an owner row stores a SENTINEL ' ' there.
//   • Exactly ONE active owner key per site (idempotent create — an existing active key is returned
//     masked, WITHOUT a secret; rotate supersedes + mints fresh; revoke tears down at Cloudflare).
// Rows carry kind='owner' so they never cross the internal object-ops path (which filters kind='internal').

/** Sentinel stored in the NOT-NULL `secret_enc` for owner rows — the real owner secret is NEVER persisted. */
const OWNER_KEY_SECRET_SENTINEL = ' ';

/**
 * Append an `audit_logs` entry for an owner-key lifecycle event (R6 P2 fix — the owner-key
 * create/rotate/revoke paths were previously unaudited). Records the site/org/actor + the
 * `accessKeyId` so an operator can correlate the key at Cloudflare — but NEVER the secret (it's
 * show-once + unrecoverable; writing it anywhere is a leak). `writeAuditLog` is fire-and-forget +
 * never throws, so a failed audit write can't break the key operation it records.
 *
 * @param action - e.g. `r2.owner_key.created` | `r2.owner_key.rotated` | `r2.owner_key.revoked`.
 * @param accessKeyId - the S3 Access Key ID (safe to log); pass null when there's no key (no-op revoke).
 */
async function auditOwnerKey(
  env: Env,
  ctx: SiteR2Context,
  action: 'r2.owner_key.created' | 'r2.owner_key.rotated' | 'r2.owner_key.revoked',
  accessKeyId: string | null,
  message: string,
): Promise<void> {
  await writeAuditLog(env.DB, {
    action,
    actor_id: ctx.actorId ?? null,
    message,
    metadata_json: {
      // accessKeyId is safe to record (it's the non-secret id half); NEVER the secretAccessKey.
      ...(accessKeyId ? { access_key_id: accessKeyId } : {}),
      site_id: ctx.siteId,
    },
    org_id: ctx.orgId ?? ctx.tenantId,
    target_id: ctx.siteId,
    target_type: 'site_r2_owner_key',
  });
}

/** Masked view of a site's owner key — safe to return anywhere (NEVER carries the secret). */
export interface SiteR2OwnerKeyStatus {
  /** `true` when an active owner key exists. */
  readonly exists: boolean;
  /** The S3 Access Key ID, MASKED (`abcd…wxyz`) — enough to recognize, never the full id. */
  readonly accessKeyIdMasked: string | null;
  /** `active` when a key exists; `none` otherwise. */
  readonly status: 'active' | 'none';
  /** ISO creation timestamp of the active key (null when none). */
  readonly createdAt: string | null;
  /** ISO last-rotation timestamp (null if never rotated / no key). */
  readonly rotatedAt: string | null;
}

/** A freshly minted owner key — the ONLY place the plaintext secret is ever returned (show-once). */
export interface SiteR2OwnerKeySecret {
  readonly accessKeyId: string;
  /** The Secret Access Key — returned ONCE, never stored, never retrievable again. */
  readonly secretAccessKey: string;
  readonly status: 'active';
  readonly createdAt: string;
}

/** Mask an access key id to `head…tail` (first 4 + last 4), or a short id verbatim-ish. */
function maskAccessKeyId(id: string): string {
  if (id.length <= 8) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Fetch the site's ACTIVE owner-key row (kind='owner'), or null. */
async function activeOwnerKeyRow(
  env: Env,
  siteId: string,
): Promise<{
  id: string;
  access_key_id: string;
  cf_token_id: string;
  created_at: string;
  rotated_at: string | null;
} | null> {
  return dbQueryOne<{
    id: string;
    access_key_id: string;
    cf_token_id: string;
    created_at: string;
    rotated_at: string | null;
  }>(
    env.DB,
    `SELECT id, access_key_id, cf_token_id, created_at, rotated_at
       FROM site_r2_s3_tokens
      WHERE site_id = ? AND kind = 'owner' AND status = 'active' AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [siteId],
  );
}

/**
 * Return the MASKED status of a site's owner key — never the secret. Used by `GET /r2/keys`. A site with
 * no owner key reads back `{exists:false, status:'none'}` (a calm empty state, not an error).
 */
export async function getSiteOwnerKeyStatus(
  env: Env,
  ctx: SiteR2Context,
): Promise<SiteR2Result<{ key: SiteR2OwnerKeyStatus }>> {
  const row = await activeOwnerKeyRow(env, ctx.siteId);
  if (!row)
    return {
      key: {
        accessKeyIdMasked: null,
        createdAt: null,
        exists: false,
        rotatedAt: null,
        status: 'none',
      },
      ok: true,
    };
  return {
    key: {
      accessKeyIdMasked: maskAccessKeyId(row.access_key_id),
      createdAt: row.created_at,
      exists: true,
      rotatedAt: row.rotated_at,
      status: 'active',
    },
    ok: true,
  };
}

/**
 * Mint a per-site, bucket-SCOPED OWNER R2 S3 key. Idempotent: if an active owner key already exists it is
 * returned MASKED (WITHOUT a secret — the secret is unrecoverable; the owner must rotate to get a fresh
 * one). Otherwise resolves server-side CF creds, calls the CF Create-Token endpoint scoped to ONLY this
 * site's OWN buckets (both R2 object Read + Write groups), and records the row storing ONLY the
 * accessKeyId + cf_token_id (NO secret). Returns the show-once `{accessKeyId, secretAccessKey, …}` on a
 * fresh mint. Fails soft + honest — records NOTHING when creds are absent or the CF create fails.
 */
export async function createSiteOwnerKey(
  env: Env,
  ctx: SiteR2Context,
): Promise<
  SiteR2Result<
    { key: SiteR2OwnerKeySecret; reused: false } | { key: SiteR2OwnerKeyStatus; reused: true }
  >
> {
  // 1. Idempotency — an existing active owner key is returned MASKED (its secret is gone forever).
  const existing = await activeOwnerKeyRow(env, ctx.siteId);
  if (existing) {
    return {
      key: {
        accessKeyIdMasked: maskAccessKeyId(existing.access_key_id),
        createdAt: existing.created_at,
        exists: true,
        rotatedAt: existing.rotated_at,
        status: 'active',
      },
      ok: true,
      reused: true,
    };
  }
  return mintOwnerKey(env, ctx);
}

/**
 * Rotate a site's owner key: REVOKE the old CF token (best-effort — an orphaned bucket-scoped token is
 * harmless), supersede its row, then mint a fresh key + return the new secret ONCE. Works even when no
 * prior key exists (behaves like create). The old key stops working the instant CF revokes it.
 */
export async function rotateSiteOwnerKey(
  env: Env,
  ctx: SiteR2Context,
): Promise<SiteR2Result<{ key: SiteR2OwnerKeySecret }>> {
  const cf = await resolveCf(env, ctx.orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  const prior = await activeOwnerKeyRow(env, ctx.siteId);
  if (prior) {
    await cfDeleteToken(cf.auth, cf.account, prior.cf_token_id); // best-effort revoke at Cloudflare
    await dbExecute(
      env.DB,
      `UPDATE site_r2_s3_tokens
          SET status = 'superseded', updated_at = datetime('now'), deleted_at = datetime('now')
        WHERE id = ? AND site_id = ?`,
      [prior.id, ctx.siteId],
    );
  }
  const minted = await mintOwnerKey(env, ctx, { rotated: true });
  if (!minted.ok) return minted;
  return { key: minted.key, ok: true };
}

/**
 * Revoke a site's owner key: DELETE the CF token at Cloudflare + soft-delete (revoke) the row. Idempotent
 * — revoking when no key exists is a success no-op. After this the key stops working everywhere.
 */
export async function revokeSiteOwnerKey(
  env: Env,
  ctx: SiteR2Context,
): Promise<SiteR2Result<{ revoked: boolean }>> {
  const row = await activeOwnerKeyRow(env, ctx.siteId);
  if (!row) return { ok: true, revoked: false }; // nothing to revoke — idempotent success

  const cf = await resolveCf(env, ctx.orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  await cfDeleteToken(cf.auth, cf.account, row.cf_token_id); // best-effort revoke at Cloudflare
  await dbExecute(
    env.DB,
    `UPDATE site_r2_s3_tokens
        SET status = 'revoked', updated_at = datetime('now'), deleted_at = datetime('now')
      WHERE id = ? AND site_id = ?`,
    [row.id, ctx.siteId],
  );
  // Audit the revoke (R6 P2) — records which accessKeyId was torn down, never a secret.
  await auditOwnerKey(
    env,
    ctx,
    'r2.owner_key.revoked',
    row.access_key_id,
    `Revoked the R2 access key for this site (${maskAccessKeyId(row.access_key_id)})`,
  );
  return { ok: true, revoked: true };
}

/**
 * Shared mint path for {@link createSiteOwnerKey} + {@link rotateSiteOwnerKey}: resolve CF creds + the
 * site's OWN bucket scope, call the CF Create-Token endpoint (both R2 object Read + Write groups),
 * persist ONLY the accessKeyId + cf_token_id (secret NEVER stored — sentinel in `secret_enc`), and
 * return the show-once secret. The Secret Access Key is the SHA-256 hex of the raw CF token `value`.
 */
async function mintOwnerKey(
  env: Env,
  ctx: SiteR2Context,
  opts: { rotated?: boolean } = {},
): Promise<SiteR2Result<{ key: SiteR2OwnerKeySecret; reused: false }>> {
  const cf = await resolveCf(env, ctx.orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  // Scope to ONLY this site's OWN bucket names (never account-wide, never another site's).
  const allocations = await listSiteR2Allocations(env, ctx.siteId);
  const bucketNames = allocations
    .map((a) => a.bucketName)
    .filter((n) => !FORBIDDEN_BUCKET_NAMES.has(n));
  const resources = bucketScopeResources(cf.account, bucketNames);

  const created = await cfCreateToken(cf.auth, cf.account, {
    name: `ps-site-${ctx.siteId}-r2-owner`,
    policies: [
      {
        effect: 'allow',
        permission_groups: [
          { id: R2_OBJECT_READ_PERMISSION_GROUP_ID },
          { id: R2_OBJECT_WRITE_PERMISSION_GROUP_ID },
        ],
        resources,
      },
    ],
  });
  if (!created.ok || !created.id || created.value === undefined) {
    return {
      message: created.message ?? 'Cloudflare token create failed',
      ok: false,
      reason: 'cf_error',
      status: created.status,
    };
  }

  // The S3 Secret Access Key is the SHA-256 hex of the raw token `value` (CF docs). Returned ONCE below;
  // NEVER persisted — the row stores a sentinel in the NOT-NULL `secret_enc`.
  const secret = await sha256Hex(created.value);
  const createdAt = new Date().toISOString();
  await dbExecute(
    env.DB,
    `INSERT INTO site_r2_s3_tokens
       (id, tenant_id, site_id, access_key_id, secret_enc, cf_token_id, scope_bucket_ids, kind, status, created_at, updated_at, rotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 'active', datetime('now'), datetime('now'), ?)`,
    [
      uuidv7(),
      ctx.tenantId,
      ctx.siteId,
      created.id,
      OWNER_KEY_SECRET_SENTINEL,
      created.id,
      JSON.stringify(bucketNames),
      opts.rotated ? createdAt : null,
    ],
  );

  // Audit the lifecycle event (R6 P2) — records the accessKeyId, NEVER the secret. A rotate's fresh
  // mint logs `rotated`; a first create logs `created`. Fire-and-forget (never breaks the mint).
  await auditOwnerKey(
    env,
    ctx,
    opts.rotated ? 'r2.owner_key.rotated' : 'r2.owner_key.created',
    created.id,
    opts.rotated
      ? `Rotated the R2 access key for this site (new key ${maskAccessKeyId(created.id)})`
      : `Created an R2 access key for this site (${maskAccessKeyId(created.id)})`,
  );

  return {
    key: { accessKeyId: created.id, createdAt, secretAccessKey: secret, status: 'active' },
    ok: true,
    reused: false,
  };
}

/**
 * Invalidate (revoke + supersede) a site's active S3 token(s). Called when the site's bucket SET changes
 * (a new bucket is provisioned) so the next {@link ensureSiteS3Token} re-mints a token whose scope covers
 * the CURRENT buckets — a token minted BEFORE a new bucket would 403 on it. Best-effort by design: a
 * failed CF revoke (or a missing table in a narrow test harness) must NEVER fail bucket creation — the
 * orphaned CF token is bucket-scoped + harmless, and the row is superseded regardless. Fully try/caught.
 */
async function invalidateSiteS3Tokens(
  env: Env,
  siteId: string,
  auth: CfAuth,
  account: string,
): Promise<void> {
  try {
    // kind='internal' ONLY — re-scoping the Worker's object-ops token must NOT touch the owner's
    // standalone key (kind='owner', slice 4); the owner rotates/revokes that one explicitly.
    const { data } = await dbQuery<{ cf_token_id: string }>(
      env.DB,
      `SELECT cf_token_id FROM site_r2_s3_tokens WHERE site_id = ? AND kind = 'internal' AND status = 'active' AND deleted_at IS NULL`,
      [siteId],
    );
    if (data.length === 0) return;
    for (const row of data) {
      try {
        await fetch(`${CF_API_BASE}/accounts/${account}/tokens/${row.cf_token_id}`, {
          headers: cfAuthHeaders(auth),
          method: 'DELETE',
        });
      } catch {
        /* orphaned bucket-scoped CF token is harmless; the row is superseded below regardless */
      }
    }
    await dbExecute(
      env.DB,
      `UPDATE site_r2_s3_tokens
          SET status = 'superseded', updated_at = datetime('now'), deleted_at = datetime('now')
        WHERE site_id = ? AND kind = 'internal' AND status = 'active' AND deleted_at IS NULL`,
      [siteId],
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        level: 'warn',
        op: 'invalidateSiteS3Tokens',
        service: 'site_r2',
        siteId,
      }),
    );
  }
}

/**
 * Empty then delete a per-site bucket (CF refuses to delete a non-empty bucket). Deletes every object
 * via the S3 API first (when S3 creds exist), then removes the bucket via REST, then soft-deletes the
 * allocation. Honest: a delete of a NON-empty bucket with no S3 creds returns `needs_s3_credentials`.
 */
export async function deleteSiteR2(
  env: Env,
  siteId: string,
  tenantId: string,
  allocation: SiteR2Allocation,
  orgId: string | null,
): Promise<SiteR2Result<{ deleted: true; objectsDeleted: number }>> {
  if (FORBIDDEN_BUCKET_NAMES.has(allocation.bucketName))
    return { ok: false, reason: 'forbidden_bucket' };
  const cf = await resolveCf(env, orgId);
  if (!cf.ok) return { ok: false, reason: cf.reason };

  // Empty the bucket first (S3). No object creds → we can only delete an already-empty bucket; try REST
  // and surface a clear needs-creds error if CF rejects because it's non-empty.
  let objectsDeleted = 0;
  const resolved = await resolveSiteS3Config(env, { orgId, siteId, tenantId });
  const s3 = resolved.ok ? resolved.s3 : null;
  if (s3) {
    const emptied = await emptyBucketViaS3(s3, allocation.bucketName);
    if (!emptied.ok) return emptied;
    objectsDeleted = emptied.objectsDeleted;
  }

  const del = await cfR2Fetch(cf.auth, cf.account, `/${allocation.bucketName}`, {
    method: 'DELETE',
  });
  if (!del.json.success) {
    // Non-empty + no S3 creds is the common cause — give an actionable reason.
    if (!s3)
      return {
        message:
          'Bucket may still contain objects; R2 S3 credentials are required to empty it first.',
        ok: false,
        reason: 'needs_s3_credentials',
      };
    return {
      message: describeErrors(del.json.errors),
      ok: false,
      reason: 'cf_error',
      status: del.status,
    };
  }

  await dbExecute(
    env.DB,
    `UPDATE site_r2_allocations SET status = 'retired', deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND site_id = ?`,
    [allocation.id, siteId],
  );
  return { deleted: true, objectsDeleted, ok: true };
}

/** Toggle a bucket's public-access flag (records the public base URL when turning it on). */
export async function setSiteR2PublicAccess(
  env: Env,
  siteId: string,
  allocation: SiteR2Allocation,
  makePublic: boolean,
): Promise<SiteR2Allocation> {
  await dbExecute(
    env.DB,
    `UPDATE site_r2_allocations
        SET public_access = ?, public_base_url = ?, updated_at = datetime('now')
      WHERE id = ? AND site_id = ?`,
    [
      makePublic ? 1 : 0,
      makePublic ? publicBaseUrlFor(allocation.bucketName) : null,
      allocation.id,
      siteId,
    ],
  );
  return {
    ...allocation,
    publicAccess: makePublic,
    publicBaseUrl: makePublic ? publicBaseUrlFor(allocation.bucketName) : null,
  };
}

/** The copyable "address bundle" for a bucket — S3 endpoint + binding name + public URL. */
export function bucketAddress(
  env: Env,
  allocation: SiteR2Allocation,
): {
  s3Endpoint: string;
  bucketName: string;
  bindingName: string;
  publicUrl: string | null;
  accountId: string | null;
} {
  const account = env.CF_ACCOUNT_ID ?? null;
  return {
    accountId: account,
    bindingName: bindingNameFor(allocation.displayName),
    bucketName: allocation.bucketName,
    publicUrl: allocation.publicAccess ? allocation.publicBaseUrl : null,
    s3Endpoint: account
      ? `https://${account}.r2.cloudflarestorage.com`
      : 'https://<account-id>.r2.cloudflarestorage.com',
  };
}

/** The `wrangler.toml` binding name an owner would use for this bucket (UPPER_SNAKE of the short name). */
function bindingNameFor(displayName: string): string {
  const base = displayName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'BUCKET'}_R2`;
}

/** The public r2.dev-style base URL for a bucket (the default managed public domain). */
function publicBaseUrlFor(bucketName: string): string {
  return `https://pub-${bucketName}.r2.dev`;
}

/** Compress CF `errors[]` into a short human message (never leaks internals). */
function describeErrors(errors: unknown): string {
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0] as { message?: string };
    if (typeof first?.message === 'string') return first.message;
  }
  return 'Cloudflare R2 request failed';
}

// ── R2 S3 object ops (SigV4) ──────────────────────────────────────────────────────────────────────
//
// R2 has NO REST object API — only the S3-compatible API — so listing/putting/getting/deleting OBJECTS
// requires R2 S3 access keys. We sign requests with AWS SigV4 (region `auto`, service `s3`). When the
// keys are absent, every object op returns `needs_s3_credentials` and the route surfaces an actionable
// message; bucket CRUD (REST, above) still works, so the tab is useful either way.

/** Resolved R2 S3 config, or null when the S3 access keys are not provisioned. */
interface S3Config {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string; // https://{account}.r2.cloudflarestorage.com
}

/** Read the R2 S3 config from env, or null (→ callers return the actionable needs-creds error). */
export function getS3Config(env: Env): S3Config | null {
  const account = env.CF_ACCOUNT_ID;
  const accessKeyId = (env as unknown as { R2_S3_ACCESS_KEY_ID?: string }).R2_S3_ACCESS_KEY_ID;
  const secretAccessKey = (env as unknown as { R2_S3_SECRET_ACCESS_KEY?: string })
    .R2_S3_SECRET_ACCESS_KEY;
  if (!account || !accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, endpoint: `https://${account}.r2.cloudflarestorage.com`, secretAccessKey };
}

/** True when account-wide S3 creds are present (the escape-hatch path). Prefer {@link hasObjectOpsForSite}. */
export function hasObjectOps(env: Env): boolean {
  return getS3Config(env) !== null;
}

/** Site identity needed to resolve a per-site scoped S3 token. `orgId` may be null (→ worker creds). */
export interface SiteR2Context {
  readonly siteId: string;
  readonly tenantId: string;
  readonly orgId: string | null;
  /**
   * The acting user id (`c.get('userId')`), threaded ONLY so the owner-key lifecycle
   * (create/rotate/revoke) can attribute its `audit_logs` entry to a human actor. Optional —
   * object-ops callers (list/put/get/delete) don't pass it and don't audit. Never load-bearing
   * for isolation (that's `orgId` + `ownsSiteData` upstream); a missing actor logs `actor_id: null`.
   */
  readonly actorId?: string | null;
}

/**
 * Resolve the S3 config a site's object ops sign with. Precedence:
 *   1. Account-wide `R2_S3_*` env creds (escape hatch) — win when present.
 *   2. The site's OWN bucket-scoped token (mint/reuse via {@link ensureSiteS3Token}), gated behind the
 *      DARK `r2_bucket_manager` flag so the capability is a reversible killswitch.
 * Returns a typed failure (`needs_s3_credentials` when the flag is off / no creds) that the object ops
 * propagate verbatim — so with the flag off the UI shows the same honest "being set up" state as today.
 */
async function resolveSiteS3Config(
  env: Env,
  ctx: SiteR2Context,
): Promise<SiteR2Result<{ s3: S3Config }>> {
  const global = getS3Config(env);
  if (global) return { ok: true, s3: global };

  const flagOn = await isFlagOn(env, PER_SITE_OBJECT_OPS_FLAG, {
    orgId: ctx.orgId ?? undefined,
    siteId: ctx.siteId,
  });
  if (!flagOn) return { ok: false, reason: 'needs_s3_credentials' };

  const account = env.CF_ACCOUNT_ID;
  if (!account) return { ok: false, reason: 'no_account_id' };

  const token = await ensureSiteS3Token(env, ctx.siteId, ctx.tenantId, ctx.orgId);
  if (!token.ok) return token;
  if (!token.secret) return { ok: false, reason: 'needs_s3_credentials' }; // stored secret failed to decrypt

  return {
    ok: true,
    s3: {
      accessKeyId: token.accessKeyId,
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      secretAccessKey: token.secret,
    },
  };
}

/**
 * True when object ops CAN run for a site WITHOUT minting — for the capability advertisement only.
 * Mirrors {@link resolveSiteS3Config}'s precedence (global creds, else flag-on + mintable CF creds).
 */
export async function hasObjectOpsForSite(
  env: Env,
  ctx: { orgId: string | null; siteId: string },
): Promise<boolean> {
  if (getS3Config(env)) return true;
  if (!env.CF_ACCOUNT_ID) return false;
  const flagOn = await isFlagOn(env, PER_SITE_OBJECT_OPS_FLAG, {
    orgId: ctx.orgId ?? undefined,
    siteId: ctx.siteId,
  });
  if (!flagOn) return false;
  return (await resolveCfCredentials(env, ctx.orgId)) !== null;
}

const S3_REGION = 'auto';
const S3_SERVICE = 's3';

/** SHA-256 hex of a string or bytes (SigV4 payload hash + canonical-request hash). */
async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return hex(digest);
}

/** HMAC-SHA256, returning the raw signature bytes (chained through the SigV4 signing key derivation). */
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
}

/** Lowercase hex of bytes. */
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC3986 encode a URI path segment for S3 canonical requests (keeps `/`, encodes the rest). */
function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

/**
 * Sign + send one S3 request to R2 via SigV4, retrying on a transient 401. A freshly-minted per-site
 * R2 token takes a few seconds to propagate across R2's edge (observed ~2.5s: the first signed request
 * 401s, the next 200s). We retry a 401 up to twice with a short backoff so a site's FIRST object op
 * after provisioning succeeds instead of surfacing a spurious auth error. Steady-state 200s never wait;
 * a genuine 401 (shouldn't occur on our always-RW-scoped tokens) costs the bounded retries then fails
 * honestly. Each retry RE-SIGNS (the `x-amz-date` moves).
 */
async function s3Fetch(
  s3: S3Config,
  method: string,
  path: string,
  opts: {
    query?: Record<string, string>;
    body?: ArrayBuffer | Uint8Array | string;
    contentType?: string;
  } = {},
): Promise<Response> {
  let res = await s3FetchOnce(s3, method, path, opts);
  for (let attempt = 0; attempt < 2 && res.status === 401; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await s3FetchOnce(s3, method, path, opts);
  }
  return res;
}

/** Sign + send ONE S3 request to R2 via SigV4 (no retry). `path` starts with `/` + includes the bucket. */
async function s3FetchOnce(
  s3: S3Config,
  method: string,
  path: string,
  opts: {
    query?: Record<string, string>;
    body?: ArrayBuffer | Uint8Array | string;
    contentType?: string;
  } = {},
): Promise<Response> {
  const url = new URL(s3.endpoint + path);
  const query = opts.query ?? {};
  const sortedQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join('&');
  if (sortedQuery) url.search = sortedQuery;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;

  const bodyBytes: Uint8Array =
    opts.body === undefined
      ? new Uint8Array(0)
      : typeof opts.body === 'string'
        ? new TextEncoder().encode(opts.body)
        : opts.body instanceof Uint8Array
          ? opts.body
          : new Uint8Array(opts.body);
  const payloadHash = await sha256Hex(bodyBytes);

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalUri = encodeS3Path(url.pathname);
  const canonicalRequest = [
    method,
    canonicalUri,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );

  const kDate = await hmac(new TextEncoder().encode(`AWS4${s3.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, S3_REGION);
  const kService = await hmac(kRegion, S3_SERVICE);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    authorization,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) headers['content-type'] = opts.contentType;

  return fetch(url.toString(), {
    body: method === 'GET' || method === 'HEAD' ? undefined : (bodyBytes as BodyInit),
    headers,
    method,
  });
}

/** Minimal XML text extractor for S3 ListObjectsV2 responses (no XML lib in Workers). */
function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}
function xmlFirst(fragment: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(fragment);
  return m ? m[1] : undefined;
}
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * List objects in a bucket (S3 ListObjectsV2). Supports `prefix` + `delimiter` (folder view) + `cursor`
 * (continuation token) + `maxKeys`. Returns objects + common prefixes ("folders") + next cursor.
 */
export async function listSiteR2Objects(
  env: Env,
  ctx: SiteR2Context,
  bucketName: string,
  opts: { prefix?: string; cursor?: string; maxKeys?: number; delimiter?: string } = {},
): Promise<
  SiteR2Result<{ objects: SiteR2Object[]; prefixes: string[]; cursor?: string; truncated: boolean }>
> {
  const resolved = await resolveSiteS3Config(env, ctx);
  if (!resolved.ok) return resolved;
  const s3 = resolved.s3;
  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': String(Math.min(Math.max(opts.maxKeys ?? 100, 1), 1000)),
  };
  if (opts.prefix) query.prefix = opts.prefix;
  if (opts.delimiter) query.delimiter = opts.delimiter;
  if (opts.cursor) query['continuation-token'] = opts.cursor;

  const res = await s3Fetch(s3, 'GET', `/${bucketName}`, { query });
  if (!res.ok)
    return {
      message: `S3 list failed (HTTP ${res.status})`,
      ok: false,
      reason: 's3_error',
      status: res.status,
    };
  const xml = await res.text();

  const objects: SiteR2Object[] = xmlAll(xml, 'Contents')
    .map((frag) => ({
      contentType: null,
      etag: xmlFirst(frag, 'ETag')?.replace(/&quot;|"/g, ''),
      key: xmlUnescape(xmlFirst(frag, 'Key') ?? ''),
      size: Number(xmlFirst(frag, 'Size') ?? 0),
      uploadedAt: xmlFirst(frag, 'LastModified') ?? null,
    }))
    .filter((o) => o.key);
  const prefixes = xmlAll(xml, 'CommonPrefixes')
    .map((frag) => xmlUnescape(xmlFirst(frag, 'Prefix') ?? ''))
    .filter(Boolean);
  const truncated = xmlFirst(xml, 'IsTruncated') === 'true';
  const cursor = truncated ? xmlFirst(xml, 'NextContinuationToken') : undefined;
  return { cursor, objects, ok: true, prefixes, truncated };
}

/** Upload one object (S3 PutObject). `body` is the raw bytes; `contentType` sets the stored MIME. */
export async function putSiteR2Object(
  env: Env,
  ctx: SiteR2Context,
  bucketName: string,
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<SiteR2Result<{ key: string; size: number }>> {
  const resolved = await resolveSiteS3Config(env, ctx);
  if (!resolved.ok) return resolved;
  const s3 = resolved.s3;
  const res = await s3Fetch(s3, 'PUT', `/${bucketName}/${key}`, { body, contentType });
  if (!res.ok)
    return {
      message: `S3 upload failed (HTTP ${res.status})`,
      ok: false,
      reason: 's3_error',
      status: res.status,
    };
  return { key, ok: true, size: body.byteLength };
}

/** Fetch one object's bytes (S3 GetObject) — the route streams these back for download/preview. */
export async function getSiteR2Object(
  env: Env,
  ctx: SiteR2Context,
  bucketName: string,
  key: string,
): Promise<SiteR2Result<{ body: ArrayBuffer; contentType: string; size: number }>> {
  const resolved = await resolveSiteS3Config(env, ctx);
  if (!resolved.ok) return resolved;
  const s3 = resolved.s3;
  const res = await s3Fetch(s3, 'GET', `/${bucketName}/${key}`);
  if (!res.ok)
    return {
      message: `S3 get failed (HTTP ${res.status})`,
      ok: false,
      reason: 's3_error',
      status: res.status,
    };
  const body = await res.arrayBuffer();
  return {
    body,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    ok: true,
    size: body.byteLength,
  };
}

/** Delete one object (S3 DeleteObject). */
export async function deleteSiteR2Object(
  env: Env,
  ctx: SiteR2Context,
  bucketName: string,
  key: string,
): Promise<SiteR2Result<{ deleted: true }>> {
  const resolved = await resolveSiteS3Config(env, ctx);
  if (!resolved.ok) return resolved;
  const s3 = resolved.s3;
  const res = await s3Fetch(s3, 'DELETE', `/${bucketName}/${key}`);
  // S3 DeleteObject returns 204 even for a missing key — that's fine (idempotent).
  if (!res.ok && res.status !== 204)
    return {
      message: `S3 delete failed (HTTP ${res.status})`,
      ok: false,
      reason: 's3_error',
      status: res.status,
    };
  return { deleted: true, ok: true };
}

/** Empty a bucket (list → delete all) via S3 — used before {@link deleteSiteR2}. */
async function emptyBucketViaS3(
  s3: S3Config,
  bucketName: string,
): Promise<SiteR2Result<{ objectsDeleted: number }>> {
  let deleted = 0;
  let cursor: string | undefined;
  // Loop pages until the bucket is empty (bounded — a runaway bucket caps at 100 pages × 1000).
  for (let page = 0; page < 100; page++) {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
    if (cursor) query['continuation-token'] = cursor;
    const listRes = await s3Fetch(s3, 'GET', `/${bucketName}`, { query });
    if (!listRes.ok)
      return {
        message: `S3 list failed (HTTP ${listRes.status})`,
        ok: false,
        reason: 's3_error',
        status: listRes.status,
      };
    const xml = await listRes.text();
    const keys = xmlAll(xml, 'Contents')
      .map((frag) => xmlUnescape(xmlFirst(frag, 'Key') ?? ''))
      .filter(Boolean);
    for (const key of keys) {
      const del = await s3Fetch(
        s3,
        'DELETE',
        `/${bucketName}/${encodeS3Path(key).replace(/^\//, '')}`,
      );
      if (del.ok || del.status === 204) deleted++;
    }
    if (xmlFirst(xml, 'IsTruncated') !== 'true') break;
    cursor = xmlFirst(xml, 'NextContinuationToken');
    if (!cursor) break;
  }
  return { objectsDeleted: deleted, ok: true };
}

/**
 * Snapshot preview → production: copy every object from the site's default (preview) bucket into a
 * production bucket (provisioning it if needed). Object-for-object copy via S3 get→put. Requires S3
 * creds; returns `needs_s3_credentials` otherwise so the UI can explain the Promote precondition.
 */
export async function promoteSiteR2(
  env: Env,
  siteId: string,
  tenantId: string,
  source: SiteR2Allocation,
  orgId: string | null,
): Promise<SiteR2Result<{ production: SiteR2Allocation; objectsCopied: number }>> {
  const ctx: SiteR2Context = { orgId, siteId, tenantId };
  // Precondition only — do NOT mint here (the prod bucket doesn't exist yet; provisioning it below
  // invalidates any stale token so the copy loop re-mints a token scoped to BOTH preview + prod).
  if (!(await hasObjectOpsForSite(env, { orgId, siteId })))
    return { ok: false, reason: 'needs_s3_credentials' };

  const prod = await provisionSiteR2(env, {
    displayName: `${source.displayName}-production`,
    environment: 'production',
    orgId,
    siteId,
    tenantId,
  });
  if (!prod.ok) return prod;

  let copied = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const listed = await listSiteR2Objects(env, ctx, source.bucketName, { cursor, maxKeys: 1000 });
    if (!listed.ok) return listed;
    for (const obj of listed.objects) {
      const got = await getSiteR2Object(env, ctx, source.bucketName, obj.key);
      if (!got.ok) continue;
      const put = await putSiteR2Object(
        env,
        ctx,
        prod.allocation.bucketName,
        obj.key,
        got.body,
        got.contentType,
      );
      if (put.ok) copied++;
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return { objectsCopied: copied, ok: true, production: prod.allocation };
}
