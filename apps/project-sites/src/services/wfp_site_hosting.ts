/**
 * @module services/wfp_site_hosting
 * @description WfP Site Hosting — Work Unit 2 (docs/wfp-site-hosting.md).
 *
 * `deploySiteToWfp` builds a per-site **User Worker** from a site's R2 build
 * (`sites/{slug}/{version}/*`) plus a tiny serving shim, uploads it to the shared
 * Workers-for-Platforms dispatch namespace as `site-<id>` (production) |
 * `site-<id>-preview` (preview) carrying the site's OWN static assets via the
 * **Workers Static Assets** upload-session flow, then records the slot in
 * `site_resource_registry`. The dispatched worker serves its assets from the
 * script's `ASSETS` binding — a dispatch worker BYPASSES the edge static-assets
 * layer, so the assets MUST ride on the script or `/assets/*` 404s (doc §Load-bearing).
 *
 * Reuse, not reimplementation (doc §Reuse): `siteFunctionsScriptName` (slot naming) +
 * `dispatchToUserWorker` from `wfp_dispatch.ts`, the assets-upload-session recipe proven
 * in `cloudflare_provisioner.deployRealPayloadWorker`, `assertSiteOwned` (isolation),
 * `recordResource` (registry row), R2 `sites/{slug}/{version}/*` + `sites.current_build_version`.
 *
 * Security: `assertSiteOwned` gates the site (404-on-foreign — NO CF call on rejection).
 * Short-lived Bearer creds only (`env.CF_API_TOKEN`); never in bundles / logs / AI prompts /
 * `VITE_*`. Fail-soft: every WfP miss/error returns a typed `{ ok:false }` — this function
 * NEVER throws into the serving hot path.
 *
 * Behind the default-OFF `site_wfp_hosting` flag: the CALLER (lifecycle wiring, Unit 4)
 * gates the invocation; this service is additive and unreferenced until then.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import { dbQueryOne } from './db.js';
import { assertSiteOwned } from './site_ownership.js';
import { isWfpConfigured, siteFunctionsScriptName } from './wfp_dispatch.js';
import { recordResource } from '../../libs/features/data_resource_registry/service.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/** Which slot to deploy — the two isolated environments every site is born with. */
export type WfpSlot = 'preview' | 'production';

/** Options for {@link deploySiteToWfp}. */
export interface DeploySiteToWfpOptions {
  /** The caller's authed org id (`c.get('orgId')`). Undefined → not owned → rejected. */
  readonly orgId: string | undefined;
  /** Which slot to write: `production` → `site-<id>`; `preview` → `site-<id>-preview`. */
  readonly slot: WfpSlot;
  /**
   * The build version to serve (an R2 prefix segment under `sites/{slug}/`). Omitted →
   * the site's `current_build_version`.
   */
  readonly version?: string;
}

/** Success shape — carries the slot identity + both digests for promotion idempotency. */
export interface DeploySiteToWfpSuccess {
  readonly ok: true;
  /** The WfP script name written (`site-<id>` | `site-<id>-preview`). */
  readonly scriptName: string;
  readonly slot: WfpSlot;
  /** The resolved build version served by this slot. */
  readonly version: string;
  /** The `site_resource_registry.id` of the recorded slot row. */
  readonly registryRowId: string;
  /** Digest over the ordered R2 source file set (`sha256(path:hash\n…)`). */
  readonly sourceDigest: string;
  /** Digest over the built artifact (serving shim + assets manifest). */
  readonly artifactDigest: string;
  /** Count of static assets uploaded onto the script. */
  readonly assetCount: number;
}

/** Failure shape — a typed reason; NEVER a throw (fail-soft to R2 is the caller's job). */
export interface DeploySiteToWfpFailure {
  readonly ok: false;
  readonly error: string;
  /** HTTP status from the failing CF call, when the failure was a REST rejection. */
  readonly status?: number;
}

export type DeploySiteToWfpResult = DeploySiteToWfpSuccess | DeploySiteToWfpFailure;

/** SHA-256 hex of bytes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of a string. */
function sha256HexOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** Chunked base64 (btoa can't take a huge string via spread). */
function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** Content-type for a static asset served by the Workers Static Assets layer. */
function assetContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.avif')) return 'image/avif';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.xml')) return 'application/xml';
  return 'application/octet-stream';
}

/** One built asset: its site-root path (`/index.html`), bytes, and content hash. */
interface BuiltAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
}

/**
 * Enumerate every object under `sites/{slug}/{version}/` and load it into a
 * `{ path, bytes, hash }` set keyed by the site-root path. Paginates R2 `list`.
 */
async function readBuildAssets(
  bucket: R2Bucket,
  slug: string,
  version: string,
): Promise<BuiltAsset[]> {
  const prefix = `sites/${slug}/${version}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const assets: BuiltAsset[] = [];
  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const path = `/${key.slice(prefix.length)}`; // site-root path
    assets.push({ path, bytes, hash: await sha256Hex(bytes) });
  }
  return assets;
}

/**
 * The per-site serving shim — a WfP dispatch worker that serves its OWN static
 * assets from the script's `ASSETS` binding (SPA-style HTML fallback to
 * `/index.html` so client-routed paths render). Kept tiny + dependency-free so the
 * artifact digest is stable across builds of the same asset set.
 */
const SERVING_SHIM = `export default {
  async fetch(request, env) {
    if (!env.ASSETS) return new Response('assets binding missing', { status: 500 });
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;
    // SPA fallback: unknown non-asset path -> index.html
    const url = new URL(request.url);
    if (request.method === 'GET' && !url.pathname.includes('.')) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    return res;
  },
};
`;

/**
 * Open an assets-upload-session for `scriptPath`, upload every static asset, and
 * return the completion JWT (`null` when the account already has all buckets).
 *
 * Mirrors `cloudflare_provisioner.uploadPayloadAssets` (doc §Reuse) but sources the
 * manifest + bytes from the site's R2 build instead of the Payload bundle zip.
 */
async function uploadSiteAssets(
  accountId: string,
  token: string,
  scriptPath: string,
  assets: BuiltAsset[],
): Promise<{ ok: true; jwt: string | null } | { ok: false; error: string; status?: number }> {
  // manifest: path -> { hash, size }
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of assets) manifest[a.path] = { hash: a.hash, size: a.bytes.length };

  const start = await fetch(
    `${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptPath}/assets-upload-session`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    },
  );
  const startJson = (await start.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { jwt?: string; buckets?: string[][] };
    errors?: unknown;
  };
  if (!start.ok || !startJson.success) {
    return {
      ok: false,
      error: `assets-upload-session failed: ${JSON.stringify(startJson.errors ?? '')}`.slice(
        0,
        400,
      ),
      status: start.status,
    };
  }
  let jwt = startJson.result?.jwt ?? null;
  const buckets = startJson.result?.buckets ?? [];

  // hash -> asset, for the bucket uploads CF asks for.
  const byHash: Record<string, BuiltAsset> = {};
  for (const a of assets) byHash[a.hash] = a;

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const a = byHash[hash];
      if (!a) continue;
      form.append(hash, new Blob([u8ToBase64(a.bytes)], { type: assetContentType(a.path) }), hash);
    }
    const up = await fetch(`${CF_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body: form,
    });
    const upJson = (await up.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { jwt?: string };
    };
    if (!up.ok || !upJson.success) {
      return { ok: false, error: 'asset bucket upload failed', status: up.status };
    }
    if (upJson.result?.jwt) jwt = upJson.result.jwt;
  }
  return { ok: true, jwt };
}

/**
 * Build a per-site User Worker from a site's R2 build + the serving shim, upload it
 * to the WfP dispatch namespace as `site-<id>` (production) | `site-<id>-preview`
 * (preview) with its OWN static assets, and record the slot in `site_resource_registry`.
 *
 * Idempotent: the same asset set + shim re-uploads to the same script name (overwrite);
 * the returned `sourceDigest`/`artifactDigest` let a promotion skip a no-op redeploy.
 *
 * @param env - Worker env (D1 `DB`, `SITES_BUCKET`, WfP creds).
 * @param siteId - The site to deploy (server-side; the caller proved auth).
 * @param opts - `{ orgId, slot, version? }`.
 * @returns A typed {@link DeploySiteToWfpResult} — never throws (fail-soft).
 *
 * @remarks Impure: reads R2, issues Cloudflare REST calls, writes one D1 row.
 * @example
 * const r = await deploySiteToWfp(env, siteId, { orgId, slot: 'preview' });
 * if (r.ok) console.log(r.scriptName, r.version);
 */
export async function deploySiteToWfp(
  env: Env,
  siteId: string,
  opts: DeploySiteToWfpOptions,
): Promise<DeploySiteToWfpResult> {
  // 1. ISOLATION — reject a foreign/missing site BEFORE any CF call (404-on-foreign).
  if (!(await assertSiteOwned(env, opts.orgId, siteId))) {
    return { ok: false, error: 'not_owned' };
  }

  // 2. WfP must be configured (binding + namespace + account + token). Fail soft otherwise.
  if (!isWfpConfigured(env)) {
    return { ok: false, error: 'wfp_not_configured' };
  }
  const accountId = env.CF_ACCOUNT_ID!;
  const token = env.CF_API_TOKEN!;
  const namespace = env.WFP_NAMESPACE_NAME!;
  const bucket = env.SITES_BUCKET;
  if (!bucket) return { ok: false, error: 'no_sites_bucket' };

  // 3. Resolve slug + version from the OWNED site row (version falls back to current build).
  const site = await dbQueryOne<{ slug: string; current_build_version: string | null }>(
    env.DB,
    'SELECT slug, current_build_version FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  if (!site?.slug) return { ok: false, error: 'site_not_found' };
  const version = opts.version ?? site.current_build_version ?? '';
  if (!version) return { ok: false, error: 'no_build_version' };

  // 4. Load the R2 build; a version with no files can't be hosted.
  let assets: BuiltAsset[];
  try {
    assets = await readBuildAssets(bucket, site.slug, version);
  } catch (err) {
    return {
      ok: false,
      error: `r2_read_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (assets.length === 0) return { ok: false, error: 'empty_build' };

  // 5. Digests — source over the ordered file set; artifact over shim + manifest.
  const ordered = [...assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceDigest = await sha256HexOf(ordered.map((a) => `${a.path}:${a.hash}`).join('\n'));
  const manifestStr = JSON.stringify(ordered.map((a) => [a.path, a.hash]));
  const artifactDigest = await sha256HexOf(`${SERVING_SHIM} ${manifestStr}`);

  // 6. Slot name — reuse the SSOT normaliser (`site-<id>` | `site-<id>-preview`).
  const scriptName = siteFunctionsScriptName(siteId, { preview: opts.slot === 'preview' });
  const scriptPath = `${namespace}/scripts/${scriptName}`; // dispatch namespace scoping
  // The assets/session/script endpoints live under the dispatch namespace path.
  const dispatchScriptPath = `dispatch/namespaces/${scriptPath}`;

  // 7. Upload the static assets onto the script (Workers Static Assets).
  const assetRes = await uploadSiteAssets(accountId, token, dispatchScriptPath, ordered);
  if (!assetRes.ok) return { ok: false, error: assetRes.error, status: assetRes.status };

  // 8. Multipart script upload: the serving shim + the ASSETS binding + a digest tag.
  const metadata: Record<string, unknown> = {
    main_module: 'worker.mjs',
    compatibility_date: '2026-05-01',
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: '__PS_SITE_ID', text: siteId },
      { type: 'plain_text', name: '__PS_ARTIFACT_DIGEST', text: artifactDigest },
    ],
    assets: assetRes.jwt
      ? {
          jwt: assetRes.jwt,
          config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
        }
      : { config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'worker.mjs',
    new Blob([SERVING_SHIM], { type: 'application/javascript+module' }),
    'worker.mjs',
  );

  const put = await fetch(`${CF_BASE}/accounts/${accountId}/workers/${dispatchScriptPath}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const putJson = (await put.json().catch(() => ({}))) as { success?: boolean; errors?: unknown };
  if (!put.ok || !putJson.success) {
    return {
      ok: false,
      error: `script upload failed: ${JSON.stringify(putJson.errors ?? '')}`.slice(0, 400),
      status: put.status,
    };
  }

  // 9. RECORD the slot in the authoritative registry (WfP concept, slot env, script, version).
  //    Digests ride in usage_json so a promotion can compare-and-skip a no-op redeploy.
  const recorded = await recordResource(env, {
    orgId: opts.orgId!,
    siteId,
    environment: opts.slot,
    resourceConcept: 'wfp_namespace',
    // A dispatched WfP script is compute-on-a-worker, not a store; `durable_object` is the
    // legal kind whose semantics ("compute, addressed at runtime, state NOT browsable") fit,
    // and the reconciler's IMPLEMENTED_ADAPTERS (d1/kv/r2 only) skip it — no drift sweep on it.
    resourceKind: 'durable_object',
    tenancy: 'dedicated',
    wfpDispatchNamespace: namespace,
    userWorkerScript: scriptName,
    resourceDisplayName: `${site.slug} (${opts.slot})`,
    lifecycleState: 'active',
    provisioningMethod: 'eager',
    accessPolicy: 'site_scoped',
    deletionProtected: true,
    deployedVersion: version,
    usageJson: JSON.stringify({ sourceDigest, artifactDigest, assetCount: ordered.length }),
  });
  if (!recorded.ok) {
    // The script + assets are LIVE; the row write failed. Report a recoverable partial
    // (a re-run overwrites the same script + retries the record) — never a silent half-deploy.
    return { ok: false, error: `record_failed: ${recorded.error}` };
  }

  return {
    ok: true,
    scriptName,
    slot: opts.slot,
    version,
    registryRowId: recorded.id,
    sourceDigest,
    artifactDigest,
    assetCount: ordered.length,
  };
}
