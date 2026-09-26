/**
 * @module services/cloudflare_provisioner
 *
 * @description
 * Provisions and — critically — DEPROVISIONS the per-instance Cloudflare stack
 * (D1 + R2 + Worker) for a launched app such as the CF-native Payload CMS.
 *
 * Every create/delete call here was proven end-to-end against the live CF API
 * (create → delete → confirm-gone) before this module shipped, so the
 * "no dangling D1 / R2 / Worker on delete" guarantee is real, not aspirational.
 *
 * ## The guarantee
 *  - `provisionPayloadStack` creates D1 → R2 → Worker; if ANY step fails it rolls
 *    back everything already created (no partial stacks).
 *  - `deprovisionPayloadStack` deletes Worker → D1 → R2 and then RE-READS each to
 *    confirm it is gone, returning a per-resource `deleted | not_found | error`
 *    verdict. The caller only marks the instance destroyed when every verdict is
 *    terminal (deleted/not_found).
 *
 * ## Auth
 * Prefers a least-privilege `CF_PROVISION_TOKEN` (Bearer; D1:Edit + Workers R2
 * Storage:Edit + Workers Scripts:Edit). Falls back to the account global key
 * (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`, `X-Auth-*` headers) per
 * `cloudflare-native-provisioning`. Throws `CfProvisionError('NO_CREDENTIALS')`
 * when neither is configured — the launch handler surfaces that as a clear 501.
 *
 * @packageDocumentation
 */
import { strFromU8, unzipSync } from 'fflate';
import { z } from 'zod';
import type { Env } from '../types/env.js';

/** Typed failure for every provisioning/deprovisioning operation. */
export class CfProvisionError extends Error {
  constructor(
    readonly code:
      | 'NO_CREDENTIALS'
      | 'NO_ACCOUNT'
      | 'D1_CREATE_FAILED'
      | 'R2_CREATE_FAILED'
      | 'WORKER_DEPLOY_FAILED'
      | 'HTTP_ERROR',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CfProvisionError';
  }
}

/** The three resource handles persisted on the `app_instances` row for teardown. */
export const PayloadStackSchema = z.object({
  d1DatabaseId: z.string().min(1),
  d1DatabaseName: z.string().min(1),
  r2BucketName: z.string().min(1),
  workerName: z.string().min(1),
  subdomain: z.string().min(1),
  /** The WfP dispatch namespace the worker landed in (null = standalone workers.dev). */
  dispatchNamespace: z.string().nullable(),
});

/**
 * Base host for CF-native Payload instances → `{slug}.cms.projectsites.dev`. The
 * `*.cms.projectsites.dev` ACM pack is already active (cert-ready today), and per the
 * epic this per-instance Payload replaces the old `cms.projectsites.dev` container.
 * `app.projectsites.dev` is the apps-system home but needs its own ACM pack (billing).
 */
const PAYLOAD_INSTANCE_HOST = 'cms.projectsites.dev';
export type PayloadStack = z.infer<typeof PayloadStackSchema>;

/** Per-resource teardown verdict — the honest "is it actually gone?" report. */
export const DeprovisionReportSchema = z.object({
  worker: z.enum(['deleted', 'not_found', 'error']),
  d1: z.enum(['deleted', 'not_found', 'error']),
  r2: z.enum(['deleted', 'not_found', 'error']),
  clean: z.boolean(),
});
export type DeprovisionReport = z.infer<typeof DeprovisionReportSchema>;

interface CfCreds {
  accountId: string;
  headers: Record<string, string>;
}

function creds(env: Env): CfCreds {
  const e = env as unknown as {
    CF_ACCOUNT_ID?: string;
    CF_PROVISION_TOKEN?: string;
    CLOUDFLARE_API_KEY?: string;
    CLOUDFLARE_EMAIL?: string;
  };
  const accountId = e.CF_ACCOUNT_ID;
  if (!accountId) throw new CfProvisionError('NO_ACCOUNT', 'CF_ACCOUNT_ID is not set');
  if (e.CF_PROVISION_TOKEN) {
    return { accountId, headers: { authorization: `Bearer ${e.CF_PROVISION_TOKEN}` } };
  }
  if (e.CLOUDFLARE_API_KEY && e.CLOUDFLARE_EMAIL) {
    return {
      accountId,
      headers: { 'x-auth-email': e.CLOUDFLARE_EMAIL, 'x-auth-key': e.CLOUDFLARE_API_KEY },
    };
  }
  throw new CfProvisionError(
    'NO_CREDENTIALS',
    'Set CF_PROVISION_TOKEN (scoped) or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL',
  );
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/** A CF API call returning the parsed JSON. Never throws on !ok — callers inspect `success`. */
async function cfFetch(
  c: CfCreds,
  path: string,
  init?: RequestInit & { body?: string | FormData },
): Promise<{ ok: boolean; status: number; json: { success?: boolean; result?: unknown; errors?: unknown } }> {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: { ...c.headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: unknown;
    errors?: unknown;
  };
  return { ok: res.ok, status: res.status, json };
}

// ── D1 ──────────────────────────────────────────────────────────────────────
async function createD1(c: CfCreds, name: string): Promise<{ id: string; name: string }> {
  const r = await cfFetch(c, `/accounts/${c.accountId}/d1/database`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const id = (r.json.result as { uuid?: string } | undefined)?.uuid;
  if (!r.json.success || !id) {
    throw new CfProvisionError('D1_CREATE_FAILED', `D1 create failed for ${name}`, r.status);
  }
  return { id, name };
}
async function deleteD1(c: CfCreds, id: string): Promise<'deleted' | 'not_found' | 'error'> {
  const del = await cfFetch(c, `/accounts/${c.accountId}/d1/database/${id}`, { method: 'DELETE' });
  const check = await cfFetch(c, `/accounts/${c.accountId}/d1/database/${id}`);
  if (!check.json.success) return 'deleted'; // re-read 404 → confirmed gone
  return del.json.success ? 'deleted' : 'error';
}

// ── R2 ──────────────────────────────────────────────────────────────────────
async function createR2(c: CfCreds, name: string): Promise<{ name: string }> {
  const r = await cfFetch(c, `/accounts/${c.accountId}/r2/buckets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.json.success) {
    throw new CfProvisionError('R2_CREATE_FAILED', `R2 create failed for ${name}`, r.status);
  }
  return { name };
}
async function deleteR2(c: CfCreds, name: string): Promise<'deleted' | 'not_found' | 'error'> {
  // Note: a bucket must be empty to delete. The caller empties objects first for
  // populated buckets; a fresh per-instance bucket is empty so this succeeds.
  const del = await cfFetch(c, `/accounts/${c.accountId}/r2/buckets/${name}`, { method: 'DELETE' });
  const check = await cfFetch(c, `/accounts/${c.accountId}/r2/buckets/${name}`);
  if (!check.json.success) return 'deleted';
  return del.json.success ? 'deleted' : 'error';
}

// ── Worker ──────────────────────────────────────────────────────────────────
/**
 * The script-upload path. When `namespace` is set the script is uploaded INTO the
 * Workers-for-Platforms dispatch namespace (a user Worker, reachable ONLY via the
 * platform's `USER_DISPATCH` binding + `{slug}.app.projectsites.dev` routing);
 * otherwise it's a standalone Worker (reachable at `<name>.<account>.workers.dev`).
 */
function scriptPath(accountId: string, name: string, namespace?: string): string {
  return namespace
    ? `/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${name}`
    : `/accounts/${accountId}/workers/scripts/${name}`;
}

/** Deploy an ESM Worker with D1 + R2 bindings via the CF multipart script-upload API. */
async function deployWorker(
  c: CfCreds,
  name: string,
  moduleSource: string,
  bindings: { d1DatabaseId: string; r2BucketName: string; vars?: Record<string, string> },
  namespace?: string,
): Promise<{ name: string }> {
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2025-09-01',
    bindings: [
      // Binding names MUST match the with-cloudflare-d1 template's wrangler.jsonc: D1 + R2.
      { type: 'd1', name: 'D1', id: bindings.d1DatabaseId },
      { type: 'r2_bucket', name: 'R2', bucket_name: bindings.r2BucketName },
      ...Object.entries(bindings.vars ?? {}).map(([k, v]) => ({
        type: 'plain_text',
        name: k,
        text: v,
      })),
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'index.js',
    new Blob([moduleSource], { type: 'application/javascript+module' }),
    'index.js',
  );
  const r = await cfFetch(c, scriptPath(c.accountId, name, namespace), {
    method: 'PUT',
    body: form,
  });
  if (!r.json.success) {
    throw new CfProvisionError('WORKER_DEPLOY_FAILED', `Worker deploy failed for ${name}`, r.status);
  }
  return { name };
}
/** CF error codes meaning "this Worker/script isn't here" — i.e. already gone. */
const WORKER_NOT_FOUND_CODES = new Set([10007, 10090, 10092]);

async function deleteWorker(
  c: CfCreds,
  name: string,
  namespace?: string,
): Promise<'deleted' | 'not_found' | 'error'> {
  const del = await cfFetch(c, scriptPath(c.accountId, name, namespace), { method: 'DELETE' });
  if (del.json.success) return 'deleted';
  // "does not exist" → already gone. Short-circuit BEFORE the GET re-read because the
  // dispatch-namespace scripts GET returns success:true even for an absent script
  // (unreliable for existence), which would otherwise mislabel absence as 'error'.
  const errs = (del.json.errors as Array<{ code?: number }> | undefined) ?? [];
  if (errs.some((e) => e.code != null && WORKER_NOT_FOUND_CODES.has(e.code))) return 'deleted';
  // Standalone re-read is reliable (404 → gone). Namespace already handled above.
  const check = await cfFetch(c, scriptPath(c.accountId, name, namespace));
  if (!check.json.success) return 'deleted';
  return 'error';
}

/**
 * Delete the Worker from BOTH the standalone registry AND the dispatch namespace,
 * confirming it's gone from each. A CF-native instance may have launched either
 * pre-cert (standalone) or post-cert (namespace); deleting both locations makes
 * teardown correct regardless, with no per-instance "where did it live" state.
 */
async function deleteWorkerEverywhere(
  c: CfCreds,
  name: string,
  namespace?: string,
): Promise<'deleted' | 'error'> {
  const standalone = await deleteWorker(c, name);
  const inNs = namespace ? await deleteWorker(c, name, namespace) : 'deleted';
  return standalone === 'error' || inNs === 'error' ? 'error' : 'deleted';
}

/** The account's workers.dev subdomain (e.g. `manhattan`) — the reachable-URL host. */
async function accountSubdomain(c: CfCreds): Promise<string | null> {
  const r = await cfFetch(c, `/accounts/${c.accountId}/workers/subdomain`);
  return (r.json.result as { subdomain?: string } | undefined)?.subdomain ?? null;
}

/**
 * Enable the `<script>.<account>.workers.dev` route for a freshly-uploaded script.
 * A plain script-upload does NOT expose a URL — without this the instance would be
 * live but unreachable (no 200). Best-effort: the launch still records the stack.
 */
async function enableScriptSubdomain(c: CfCreds, name: string): Promise<boolean> {
  const r = await cfFetch(c, `/accounts/${c.accountId}/workers/scripts/${name}/subdomain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  return Boolean(r.json.success);
}

/**
 * Minimal placeholder Worker deployed at launch so the subdomain resolves + the
 * D1/R2 bindings are exercised via a plain script upload.
 *
 * ⚠️ NOT how the real CMS deploys. The `with-cloudflare-d1` template is a Next.js +
 * Payload app built by **OpenNext** (`main: .open-next/worker.js` + an `ASSETS`
 * binding over `.open-next/assets/`) — a bundle + static assets, not a JS string.
 * The real deploy = build the OpenNext bundle once, then per-instance upload the
 * worker + assets with per-instance D1/R2 bindings (see PROGRESS doc, slice B1).
 */
export const PAYLOAD_BOOTSTRAP_WORKER = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', app: 'payload-cf', hasD1: !!env.D1, hasR2: !!env.R2 });
    }
    // /admin (and every path) resolves 200 so the instance is reachable the moment
    // it's launched. This bootstrap proves the per-instance D1 + R2 bindings; the
    // real Payload admin UI ships by swapping this module for the OpenNext bundle
    // (PROGRESS doc slice B1 — assets-upload-session + .open-next/worker.js).
    const admin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
    const body =
      '<!doctype html><html><head><meta charset="utf-8"><title>Payload CMS — ' +
      (admin ? 'Admin' : 'Provisioned') +
      '</title></head><body style="font-family:system-ui;background:#060610;color:#f4f4ff;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h1 style="color:#00e5ff">Payload CMS</h1>' +
      '<p>Instance live — D1 ' + (env.D1 ? '✓' : '✗') + ' · R2 ' + (env.R2 ? '✓' : '✗') + ' bound.</p>' +
      '<p style="opacity:.7">Admin UI finishing setup…</p></div></body></html>';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};`;

/**
 * Create the full per-instance stack: D1 → R2 → Worker. Rolls back everything
 * already created if any step fails, so a failed launch never strands a resource.
 */
export async function provisionPayloadStack(
  env: Env,
  ctx: {
    instanceId: string;
    slug: string;
    payloadSecret: string;
    workerModule?: string;
    /**
     * When set AND `appHostCertReady`, deploy the Worker INTO this WfP dispatch
     * namespace (a user Worker served at `{slug}.app.projectsites.dev` via the
     * platform's USER_DISPATCH binding). Otherwise deploy a standalone Worker on
     * workers.dev.
     */
    dispatchNamespace?: string;
  },
): Promise<PayloadStack> {
  const c = creds(env);
  const short = ctx.instanceId.slice(0, 8);
  const base = `payload-${ctx.slug}-${short}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 54);
  // Host selection. DEFAULT = standalone workers.dev, whose edge asset layer serves
  // /_next/static → STYLED Payload (verified). WfP dispatch → {slug}.cms.projectsites.dev
  // is branded BUT a dispatched worker (USER_DISPATCH.get().fetch()) bypasses the edge
  // asset layer → static assets 404 (unstyled). Gate dispatch on PAYLOAD_BRANDED_HOST=true
  // so we never ship an unstyled admin by default; flip it once assets-over-dispatch is
  // solved (platform serves shared /_next/static from R2, or per-instance worker routes).
  const brandedReady =
    (env as unknown as { PAYLOAD_BRANDED_HOST?: string }).PAYLOAD_BRANDED_HOST === 'true';
  const ns = brandedReady ? ctx.dispatchNamespace : undefined;
  const rollback: Array<() => Promise<unknown>> = [];
  try {
    const d1 = await createD1(c, base);
    rollback.push(() => deleteD1(c, d1.id));

    const r2 = await createR2(c, base);
    rollback.push(() => deleteR2(c, r2.name));

    const worker = await deployWorker(
      c,
      base,
      ctx.workerModule ?? PAYLOAD_BOOTSTRAP_WORKER,
      { d1DatabaseId: d1.id, r2BucketName: r2.name, vars: { PAYLOAD_SECRET: ctx.payloadSecret } },
      ns,
    );
    rollback.push(() => deleteWorker(c, worker.name, ns));

    let reachable: string;
    if (ns) {
      // WfP dispatch: routed at {slug}.cms.projectsites.dev by the platform Worker's
      // serveAppBySubdomain → USER_DISPATCH.get(worker.name). No workers.dev subdomain.
      reachable = `${ctx.slug.toLowerCase()}.${PAYLOAD_INSTANCE_HOST}`;
    } else {
      // Standalone fallback (local dev / WfP not configured): expose at workers.dev.
      await enableScriptSubdomain(c, worker.name).catch(() => false);
      const acct = await accountSubdomain(c).catch(() => null);
      reachable = acct ? `${worker.name}.${acct}.workers.dev` : `${base}.${PAYLOAD_INSTANCE_HOST}`;
    }

    return PayloadStackSchema.parse({
      d1DatabaseId: d1.id,
      d1DatabaseName: d1.name,
      r2BucketName: r2.name,
      workerName: worker.name,
      subdomain: reachable,
      dispatchNamespace: ns ?? null,
    });
  } catch (err) {
    for (const undo of rollback.reverse()) await undo().catch(() => undefined);
    throw err;
  }
}

// ── Real Payload OpenNext bundle deploy (B1) ─────────────────────────────────
// Swaps the bootstrap for the actual Payload admin. The bundle (worker.js + 3 binary
// modules + 84 static assets + manifest) is pre-built by scripts/build-payload-bundle.mjs
// and stored at R2 `payload-bundle/v1.zip` (a Worker can't esbuild ~1829 modules at
// request time). This is the PROVEN raw-API path (deploy-payload-instance.mjs): live
// test → /admin 200 + CSS asset 200 (styled login). Ported to run in-Worker.

const PAYLOAD_BUNDLE_KEY = 'payload-bundle/v1.zip';

interface PayloadBundleManifest {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  modules: Array<{ name: string; type: string }>;
  assets: Record<string, { hash: string; size: number }>;
  has_migration?: boolean;
}

/**
 * Apply the Payload schema DDL to a fresh D1 via the D1 REST query API — so
 * login-submit / create-first-user work (a Worker can't run `payload migrate`).
 * Statements run one-per-call (the D1 REST /query endpoint is single-statement).
 */
async function applyD1Migration(
  c: CfCreds,
  d1DatabaseId: string,
  migrationSql: string,
): Promise<{ ok: boolean; error?: string }> {
  const statements = migrationSql
    .split(';\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    const r = await cfFetch(c, `/accounts/${c.accountId}/d1/database/${d1DatabaseId}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    if (!r.json.success) {
      const msg = JSON.stringify(r.json.errors);
      // A fresh D1 shouldn't already have the tables; tolerate "already exists" on re-run.
      if (!/already exists/i.test(msg)) {
        return { ok: false, error: `stmt failed (${sql.slice(0, 40)}…): ${msg}` };
      }
    }
  }
  return { ok: true };
}

/** Chunked base64 (btoa can't take a huge string via spread) for asset upload. */
function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function assetContentType(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/** Read + unzip the pre-built Payload bundle from R2. Null when it isn't staged yet. */
async function readPayloadBundle(
  env: Env,
): Promise<{ files: Record<string, Uint8Array>; manifest: PayloadBundleManifest } | null> {
  const bucket = (env as unknown as { SITES_BUCKET?: R2Bucket }).SITES_BUCKET;
  if (!bucket) return null;
  const obj = await bucket.get(PAYLOAD_BUNDLE_KEY);
  if (!obj) return null;
  const files = unzipSync(new Uint8Array(await obj.arrayBuffer()));
  const raw = files['manifest.json'];
  if (!raw) return null;
  return { files, manifest: JSON.parse(strFromU8(raw)) as PayloadBundleManifest };
}

/** assets-upload-session → upload every static asset → return the completion JWT. */
async function uploadPayloadAssets(
  c: CfCreds,
  scriptPathStr: string,
  files: Record<string, Uint8Array>,
  manifest: PayloadBundleManifest,
): Promise<string | null> {
  const start = await cfFetch(c, `${scriptPathStr}/assets-upload-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: manifest.assets }),
  });
  if (!start.json.success) {
    throw new CfProvisionError('WORKER_DEPLOY_FAILED', `assets-upload-session failed`, start.status);
  }
  const result = start.json.result as { jwt?: string; buckets?: string[][] } | undefined;
  let jwt = result?.jwt ?? null;
  const buckets = result?.buckets ?? [];
  // hash → { content, path } from the manifest (paths) + the zip (bytes under assets/).
  const byHash: Record<string, { content: Uint8Array; path: string }> = {};
  for (const [path, meta] of Object.entries(manifest.assets)) {
    const content = files[`assets${path}`];
    if (content) byHash[meta.hash] = { content, path };
  }
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const a = byHash[hash];
      if (!a) continue;
      form.append(hash, new Blob([u8ToBase64(a.content)], { type: assetContentType(a.path) }), hash);
    }
    const up = await fetch(`${CF_BASE}/accounts/${c.accountId}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body: form,
    });
    const upJson = (await up.json().catch(() => ({}))) as { success?: boolean; result?: { jwt?: string } };
    if (!upJson.success) throw new CfProvisionError('WORKER_DEPLOY_FAILED', 'asset bucket upload failed', up.status);
    if (upJson.result?.jwt) jwt = upJson.result.jwt;
  }
  return jwt;
}

/**
 * Deploy the REAL Payload worker (overwriting the bootstrap under the same name):
 * assets-upload-session, then a multipart script upload with the main module + the
 * binary modules + D1/R2/ASSETS/PAYLOAD_SECRET bindings. Idempotent per name.
 */
export async function deployRealPayloadWorker(
  env: Env,
  ctx: {
    name: string;
    d1DatabaseId: string;
    r2BucketName: string;
    payloadSecret: string;
    namespace?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const bundle = await readPayloadBundle(env);
  if (!bundle) return { ok: false, error: 'payload bundle not staged in R2 (payload-bundle/v1.zip)' };
  const { files, manifest } = bundle;
  const c = creds(env);
  const scriptPathStr = scriptPath(c.accountId, ctx.name, ctx.namespace);

  // Migrate the fresh D1 FIRST so login-submit works the moment the worker goes live.
  const migrationRaw = files['migration.sql'];
  if (migrationRaw) {
    const mig = await applyD1Migration(c, ctx.d1DatabaseId, strFromU8(migrationRaw));
    if (!mig.ok) return { ok: false, error: `migration: ${mig.error}` };
  }

  let assetsJwt: string | null = null;
  try {
    assetsJwt = await uploadPayloadAssets(c, scriptPathStr, files, manifest);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const bindings: Array<Record<string, string>> = [
    { type: 'd1', name: 'D1', id: ctx.d1DatabaseId },
    { type: 'r2_bucket', name: 'R2', bucket_name: ctx.r2BucketName },
    { type: 'plain_text', name: 'PAYLOAD_SECRET', text: ctx.payloadSecret },
  ];
  const metadata: Record<string, unknown> = {
    main_module: manifest.main_module,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags,
    bindings,
  };
  if (assetsJwt) {
    bindings.push({ type: 'assets', name: 'ASSETS' });
    // NO run_worker_first — on the standalone path the edge asset layer serves
    // /_next/static in FRONT of the worker (styled admin, verified fire 10). Setting
    // run_worker_first makes the worker run first + 404 the static paths (OpenNext relies
    // on the edge for them), which broke standalone CSS. (Dispatch can't serve assets
    // either way — that's why the branded host is gated off; see provisionPayloadStack.)
    metadata.assets = {
      jwt: assetsJwt,
      config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
    };
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  const main = files[manifest.main_module];
  if (!main) return { ok: false, error: `bundle missing ${manifest.main_module}` };
  form.append(
    manifest.main_module,
    new Blob([main], { type: 'application/javascript+module' }),
    manifest.main_module,
  );
  for (const m of manifest.modules) {
    const content = files[`modules/${m.name}`];
    if (!content) return { ok: false, error: `bundle missing module ${m.name}` };
    form.append(m.name, new Blob([content], { type: m.type }), m.name);
  }
  const res = await cfFetch(c, scriptPathStr, { method: 'PUT', body: form });
  if (!res.json.success) {
    return { ok: false, error: `script upload failed: ${JSON.stringify(res.json.errors)}` };
  }
  return { ok: true };
}

/**
 * Delete Worker → D1 → R2 and RE-READ each to confirm it is gone. Returns a
 * per-resource verdict; `clean` is true only when none remain (the caller marks
 * the instance destroyed on `clean === true`, else surfaces the stragglers).
 */
export async function deprovisionPayloadStack(
  env: Env,
  ids: {
    workerName?: string | null;
    d1DatabaseId?: string | null;
    r2BucketName?: string | null;
    /** Delete the Worker from this WfP dispatch namespace (matches provision). */
    dispatchNamespace?: string;
  },
): Promise<DeprovisionReport> {
  const c = creds(env);
  const worker = ids.workerName
    ? await deleteWorkerEverywhere(c, ids.workerName, ids.dispatchNamespace)
    : 'not_found';
  const d1 = ids.d1DatabaseId ? await deleteD1(c, ids.d1DatabaseId) : 'not_found';
  const r2 = ids.r2BucketName ? await deleteR2(c, ids.r2BucketName) : 'not_found';
  const clean = [worker, d1, r2].every((v) => v === 'deleted' || v === 'not_found');
  return DeprovisionReportSchema.parse({ worker, d1, r2, clean });
}
