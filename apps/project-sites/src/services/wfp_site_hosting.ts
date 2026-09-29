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
import {
  deleteSiteFunctionsWorker,
  isWfpConfigured,
  siteFunctionsScriptName,
} from './wfp_dispatch.js';
import {
  clearSiteWfpRegistry,
  recordResource,
} from '../../libs/features/data_resource_registry/service.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Emit a structured warn line for a WfP deploy failure (observability, ADDITIVE ONLY).
 * The fail-soft `{ ok:false }` return value + behaviour is unchanged — this only makes a
 * previously-silent miss greppable. Matches the repo's structured-log shape
 * (`console.warn(JSON.stringify({ level, ... }))`, e.g. `wallet.ts`). `console.warn`
 * (not `console.log`) — `console.log` is ESLint-blocked in this repo.
 */
function logWfpDeployFailure(error: string, siteId: string, slot: WfpSlot): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'wfp_site_hosting',
      msg: 'WfP deploy failed',
      error,
      siteId,
      slot,
    }),
  );
}

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
 * `scriptPath` MUST be the dispatch-namespace-scoped path
 * (`dispatch/namespaces/{ns}/scripts/{script}`) — it is appended directly after
 * `.../workers/`, so passing a bare `scripts/{name}` here targets the WRONG API.
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

  // `scriptPath` is ALREADY the dispatch-namespace-scoped path
  // (`dispatch/namespaces/{ns}/scripts/{script}`) — it sits directly under `.../workers/`,
  // NOT under `.../workers/scripts/` (that hits the standalone-script API → CF 10405).
  const start = await fetch(
    `${CF_BASE}/accounts/${accountId}/workers/${scriptPath}/assets-upload-session`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    },
  );
  const startJson = (await start.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { jwt?: string; buckets?: string[][] };
    errors?: Array<{ code?: number; message?: string }>;
  };
  if (!start.ok || !startJson.success) {
    // Surface the HTTP status + CF error code (e.g. 10405) so a future auth-scheme/URL
    // regression is greppable, not an opaque "failed: []".
    const cfCode = startJson.errors?.[0]?.code;
    return {
      ok: false,
      error:
        `assets-upload-session failed (status ${start.status}, code ${cfCode ?? 'none'}): ` +
        `${JSON.stringify(startJson.errors ?? '')}`.slice(0, 400),
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
  if (!bucket) {
    logWfpDeployFailure('no_sites_bucket', siteId, opts.slot);
    return { ok: false, error: 'no_sites_bucket' };
  }

  // 3. Resolve slug + version from the OWNED site row (version falls back to current build).
  const site = await dbQueryOne<{ slug: string; current_build_version: string | null }>(
    env.DB,
    'SELECT slug, current_build_version FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  if (!site?.slug) {
    logWfpDeployFailure('site_not_found', siteId, opts.slot);
    return { ok: false, error: 'site_not_found' };
  }
  const version = opts.version ?? site.current_build_version ?? '';
  if (!version) {
    logWfpDeployFailure('no_build_version', siteId, opts.slot);
    return { ok: false, error: 'no_build_version' };
  }

  // 4. Load the R2 build; a version with no files can't be hosted.
  let assets: BuiltAsset[];
  try {
    assets = await readBuildAssets(bucket, site.slug, version);
  } catch (err) {
    const error = `r2_read_failed: ${err instanceof Error ? err.message : String(err)}`;
    logWfpDeployFailure(error, siteId, opts.slot);
    return { ok: false, error };
  }
  if (assets.length === 0) {
    logWfpDeployFailure('empty_build', siteId, opts.slot);
    return { ok: false, error: 'empty_build' };
  }

  // 5. Digests — source over the ordered file set; artifact over shim + manifest.
  const ordered = [...assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceDigest = await sha256HexOf(ordered.map((a) => `${a.path}:${a.hash}`).join('\n'));
  const manifestStr = JSON.stringify(ordered.map((a) => [a.path, a.hash]));
  const artifactDigest = await sha256HexOf(`${SERVING_SHIM} ${manifestStr}`);

  // 6. Slot name — reuse the SSOT normaliser (`site-<id>` | `site-<id>-preview`).
  const scriptName = siteFunctionsScriptName(siteId, { preview: opts.slot === 'preview' });
  // The dispatch-namespace-scoped script path — the ONLY correct WfP shape
  // (`dispatch/namespaces/{ns}/scripts/{script}`). It is ALREADY namespace-scoped, so
  // callers append it directly after `.../workers/` — NEVER under `.../workers/scripts/`
  // (that routes to the standalone-script API → CF 10405 "Method not allowed for this
  // authentication scheme"). Matches `wfp_dispatch.ts` + `cloudflare_provisioner.scriptPath`.
  const dispatchScriptPath = `dispatch/namespaces/${namespace}/scripts/${scriptName}`;

  // 7. Upload the static assets onto the script (Workers Static Assets).
  const assetRes = await uploadSiteAssets(accountId, token, dispatchScriptPath, ordered);
  if (!assetRes.ok) {
    logWfpDeployFailure(assetRes.error, siteId, opts.slot);
    return { ok: false, error: assetRes.error, status: assetRes.status };
  }

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
  const putJson = (await put.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: Array<{ code?: number; message?: string }>;
  };
  if (!put.ok || !putJson.success) {
    // Include HTTP status + CF error code (e.g. 10405) so a URL/auth-scheme regression is greppable.
    const cfCode = putJson.errors?.[0]?.code;
    const error =
      `script upload failed (status ${put.status}, code ${cfCode ?? 'none'}): ` +
      `${JSON.stringify(putJson.errors ?? '')}`.slice(0, 400);
    logWfpDeployFailure(error, siteId, opts.slot);
    return { ok: false, error, status: put.status };
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
    const error = `record_failed: ${recorded.error}`;
    logWfpDeployFailure(error, siteId, opts.slot);
    return { ok: false, error };
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

// ─── Work Unit 4 — lifecycle wiring (docs/wfp-site-hosting.md §Work units 4) ───

/** Options for {@link deploySiteWfpSlotsOnLifecycle}. */
export interface DeploySiteWfpSlotsOptions {
  /** The site's owning org (`params.orgId` / `c.get('orgId')`). Undefined → skip. */
  readonly orgId: string | undefined;
  /** Which slot(s) to (re)deploy at this lifecycle point. */
  readonly slots: readonly WfpSlot[];
  /** The just-built/published version (an R2 prefix segment). Omitted → current build. */
  readonly version?: string;
}

/** Summary of a lifecycle deploy — never a throw; every branch resolves. */
export interface DeploySiteWfpSlotsSummary {
  /** Did the flag gate pass so a WfP deploy was actually attempted? */
  readonly attempted: boolean;
  /** Per-slot outcome (present only for attempted slots). */
  readonly results: Partial<Record<WfpSlot, DeploySiteToWfpResult>>;
}

/**
 * Lifecycle hook: give a site its WfP slot(s) at a build/publish milestone —
 * the **preview** slot after `upload-final` (build success) and the **production**
 * slot on publish/promote. This is the Unit-4 wiring: it is the ONLY thing the
 * build/publish path calls, and it is ADDITIVE + FAIL-SOFT by construction.
 *
 * - **Flag-gated FIRST** (`site_wfp_hosting`, per-site scope) so a flag-off site's
 *   build/publish path is byte-identical — one flag read, then it returns
 *   `{ attempted:false }` having made ZERO WfP/CF calls. Only when the flag is ON
 *   does it call {@link deploySiteToWfp} for each requested slot.
 * - **Fail-soft** (doc §Interpretation): a WfP deploy failure NEVER propagates —
 *   this resolves a typed summary (never throws), so a WfP miss can never fail the
 *   build or the publish; R2 remains the served path (Unit-3 falls back to it when
 *   no slot is live). Callers should still `waitUntil`/`void` this off the response
 *   path so WfP latency never delays the user.
 * - **Reuse, not reimplementation** (doc §Reuse): calls {@link deploySiteToWfp}
 *   (Unit 2) + `isFlagOn` (Unit 1) — no dispatch/upload logic is duplicated here.
 *
 * @param env - Worker env (D1 `DB`, `SITES_BUCKET`, WfP creds; flag store).
 * @param siteId - The site reaching this lifecycle milestone.
 * @param opts - `{ orgId, slots, version? }`.
 * @returns A {@link DeploySiteWfpSlotsSummary} — always resolves, never throws.
 *
 * @remarks Impure: reads a flag, and (flag-on) reads R2 + issues CF REST calls per slot.
 * @example
 * // build success — give the preview slot (fire-and-forget, fail-soft):
 * ctx.waitUntil(deploySiteWfpSlotsOnLifecycle(env, siteId, { orgId, slots: ['preview'], version }));
 * // publish — give the production slot:
 * ctx.waitUntil(deploySiteWfpSlotsOnLifecycle(env, siteId, { orgId, slots: ['production'], version }));
 */
export async function deploySiteWfpSlotsOnLifecycle(
  env: Env,
  siteId: string,
  opts: DeploySiteWfpSlotsOptions,
): Promise<DeploySiteWfpSlotsSummary> {
  const summary: DeploySiteWfpSlotsSummary = { attempted: false, results: {} };
  try {
    // Unowned → nothing to scope a flag or an owned deploy to. Skip silently.
    if (!opts.orgId) return summary;

    // Flag gate FIRST — a flag-off build/publish makes ZERO WfP calls (byte-identical).
    const { isFlagOn } = await import('../modules/feature_flags/services.js');
    if (!(await isFlagOn(env, 'site_wfp_hosting', { orgId: opts.orgId, siteId }))) {
      return summary;
    }

    // Flag ON — (re)deploy each requested slot. Dynamic import so the call resolves
    // the (mockable) module export; deploySiteToWfp is itself fail-soft ({ ok:false }),
    // and the per-slot try/catch swallows even an unexpected throw so a build/publish
    // is never failed by a WfP miss.
    const mod = await import('./wfp_site_hosting.js');
    const results: Partial<Record<WfpSlot, DeploySiteToWfpResult>> = {};
    let attempted = false;
    for (const slot of opts.slots) {
      attempted = true;
      try {
        results[slot] = await mod.deploySiteToWfp(env, siteId, {
          orgId: opts.orgId,
          slot,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
        });
      } catch (err) {
        results[slot] = {
          ok: false,
          error: `deploy_threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { attempted, results };
  } catch {
    // Absolute fail-soft: the lifecycle hook must never break the build/publish path.
    return summary;
  }
}

// ─── Work Unit 5 — teardown (docs/wfp-site-hosting.md §Work units 5) ───────────

/** Options for {@link teardownSiteWfp}. */
export interface TeardownSiteWfpOptions {
  /** The site's owning org (`c.get('orgId')` / the resolved owner). Undefined → skip. */
  readonly orgId: string | undefined;
}

/** Summary of a teardown — never a throw; every branch resolves. */
export interface TeardownSiteWfpSummary {
  /** Did the flag gate pass so a teardown was actually attempted? */
  readonly attempted: boolean;
  /** How many dispatch slots were deleted (0 or 2 — production + preview). */
  readonly slotsDeleted: number;
  /** How many registry rows were soft-deleted by the registry-clear. */
  readonly registryCleared: number;
}

/**
 * Teardown hook: on site DELETE or ARCHIVE, remove the site's entire WfP footprint —
 * delete BOTH dispatch slots (production `site-<id>` AND preview `site-<id>-preview`)
 * from the shared `USER_DISPATCH` namespace, and clear its `wfp_namespace` registry rows.
 * This is the Unit-5 wiring the delete/archive paths call; it is ADDITIVE + FAIL-SOFT.
 *
 * - **Flag-gated FIRST** (`site_wfp_hosting`, per-site scope) so a flag-off delete/archive
 *   is byte-identical — one flag read, then it returns `{ attempted:false }` having made
 *   ZERO WfP/registry calls. Only when the flag is ON does it tear the slots + registry down.
 * - **Reuse, not reimplementation** (doc §Reuse): the namespace slot delete goes through
 *   `deleteSiteFunctionsWorker` (best-effort, never-throws) — the SAME helper Functions uses —
 *   and the registry-clear through {@link clearSiteWfpRegistry}. No CF DELETE is reimplemented.
 * - **Idempotent**: `deleteSiteFunctionsWorker` DELETEs an absent slot as a no-op success (CF
 *   404 is swallowed), and `clearSiteWfpRegistry` re-runs to 0 changes — so a re-teardown of an
 *   already-torn-down site is a clean no-op.
 * - **Fail-soft**: a slot-delete throw OR a registry-clear throw is swallowed — this NEVER
 *   throws into the delete/archive path, so a teardown miss can never block a site delete.
 *
 * @param env - Worker env (D1 `DB`, WfP creds; flag store).
 * @param siteId - the site being deleted/archived.
 * @param opts - `{ orgId }`.
 * @returns a {@link TeardownSiteWfpSummary} — always resolves, never throws.
 *
 * @remarks Impure: reads a flag, and (flag-on) issues CF REST DELETEs + one D1 UPDATE.
 * @example
 * // site delete/archive — fire-and-forget, fail-soft:
 * ctx.waitUntil(teardownSiteWfp(env, siteId, { orgId }));
 */
export async function teardownSiteWfp(
  env: Env,
  siteId: string,
  opts: TeardownSiteWfpOptions,
): Promise<TeardownSiteWfpSummary> {
  const summary: TeardownSiteWfpSummary = {
    attempted: false,
    slotsDeleted: 0,
    registryCleared: 0,
  };
  try {
    // Unowned → nothing to scope a flag or an owned teardown to. Skip silently.
    if (!opts.orgId) return summary;

    // Flag gate FIRST — a flag-off delete/archive makes ZERO WfP/registry calls (byte-identical).
    const { isFlagOn } = await import('../modules/feature_flags/services.js');
    if (!(await isFlagOn(env, 'site_wfp_hosting', { orgId: opts.orgId, siteId }))) {
      return summary;
    }

    // Flag ON — delete BOTH dispatch slots + clear the registry. Each step is independently
    // guarded so one failure never strands the others (a slot-delete throw still lets the
    // registry clear run, and vice versa). Nothing here re-throws into the delete/archive path.
    let slotsDeleted = 0;
    for (const preview of [false, true]) {
      try {
        await deleteSiteFunctionsWorker(env, siteId, { preview });
        slotsDeleted += 1;
      } catch {
        // deleteSiteFunctionsWorker is best-effort; swallow even an unexpected throw.
      }
    }

    let registryCleared = 0;
    try {
      const cleared = await clearSiteWfpRegistry(env, siteId);
      registryCleared = cleared.cleared;
    } catch {
      // clearSiteWfpRegistry is fail-soft; swallow even an unexpected throw.
    }

    return { attempted: true, slotsDeleted, registryCleared };
  } catch {
    // Absolute fail-soft: teardown must never break the delete/archive path.
    return summary;
  }
}
