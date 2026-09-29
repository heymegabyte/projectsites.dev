/**
 * Cloudflare Workers for Platforms dispatch helper.
 *
 * For user-defined endpoints with kind='worker': we upload the user's
 * JS/TS/Python code as a user-Worker into our dispatch namespace via the
 * Cloudflare REST API, then dispatch requests via the USER_DISPATCH
 * binding at runtime.
 *
 * If WFP isn't provisioned (no USER_DISPATCH binding or no CF_API_TOKEN),
 * code-kind endpoints return 503 with a clear "not configured" message
 * and the customer is steered toward the AI-prompt kind.
 *
 * Pricing: WFP Paid is $25/mo + per-request fees that pass through.
 * Docs: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
 */
import type { Env } from '../types/env.js';
import { FUNCTIONS_DISPATCH_LIMITS } from './functions_guardrails.js';

export type Language = 'javascript' | 'typescript' | 'python' | 'rust-wasm';

export function isWfpConfigured(env: Env): boolean {
  return (
    !!env.USER_DISPATCH && !!env.WFP_NAMESPACE_NAME && !!env.CF_ACCOUNT_ID && !!env.CF_API_TOKEN
  );
}

export const SUPPORTED_LANGUAGES: { id: Language; label: string; helper: string }[] = [
  {
    id: 'javascript',
    label: 'JavaScript',
    helper: 'export default { fetch(req, env, ctx) { return new Response("hi") } }',
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    helper:
      'export default { async fetch(req: Request): Promise<Response> { return new Response("hi") } }',
  },
  {
    id: 'python',
    label: 'Python (Pyodide)',
    helper:
      'from workers import Response\n\nasync def on_fetch(request, env):\n    return Response("hi")',
  },
  {
    id: 'rust-wasm',
    label: 'Rust → Wasm',
    helper:
      '// Build a workers-rs project then upload the .wasm; see https://github.com/cloudflare/workers-rs',
  },
];

/**
 * Upload (or overwrite) a user-Worker into our dispatch namespace.
 * Returns the script name we picked (deterministic from site + endpoint).
 */
export async function uploadUserWorker(
  env: Env,
  opts: {
    siteId: string;
    endpointSlug: string;
    language: Language;
    code: string;
  },
): Promise<{ ok: true; scriptName: string } | { ok: false; error: string; status?: number }> {
  if (!isWfpConfigured(env)) {
    return { ok: false, error: 'Workers for Platforms not configured on this account' };
  }
  const scriptName = `ai-${opts.siteId.slice(0, 8)}-${opts.endpointSlug}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const namespace = env.WFP_NAMESPACE_NAME!;
  const accountId = env.CF_ACCOUNT_ID!;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;

  // Build multipart body: metadata.json + the script module.
  const form = new FormData();
  const isPython = opts.language === 'python';
  const isWasm = opts.language === 'rust-wasm';
  const mainModule = isPython ? 'worker.py' : 'worker.mjs';
  const metadata = {
    main_module: mainModule,
    ...(isPython ? { compatibility_flags: ['python_workers'] } : {}),
    compatibility_date: '2026-05-01',
    ...(isWasm ? { bindings: [{ type: 'wasm_module', name: 'WASM', part: 'wasm' }] } : {}),
  };
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    mainModule,
    new Blob([opts.code], {
      type: isPython ? 'text/x-python' : 'application/javascript+module',
    }),
    mainModule,
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: body.slice(0, 800), status: res.status };
  }
  return { ok: true, scriptName };
}

export async function deleteUserWorker(env: Env, scriptName: string): Promise<void> {
  if (!isWfpConfigured(env)) return;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.WFP_NAMESPACE_NAME}/scripts/${scriptName}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
  ).catch(() => {});
}

/** Dispatch a request to a user-Worker via the namespace binding. */
export async function dispatchToUserWorker(
  env: Env,
  scriptName: string,
  request: Request,
): Promise<Response> {
  if (!env.USER_DISPATCH) {
    return new Response('USER_DISPATCH binding missing', { status: 503 });
  }
  // Stage 4.2(d) — apply the per-invocation WfP custom limits (CPU + subrequests)
  // at dispatch; Cloudflare enforces them on the user worker (a breach throws
  // inside it, surfaced by the caller's fail-soft dispatch_error path). The installed
  // workers-types type `get()` as 1-2 args, but the runtime accepts a 3rd `options`
  // arg for custom limits — widen the BINDING (not the method, to preserve `this`).
  const dispatch = env.USER_DISPATCH as unknown as {
    get(
      name: string,
      args: Record<string, unknown>,
      options: { limits: { cpuMs: number; subRequests: number } },
    ): { fetch(req: Request): Promise<Response> };
  };
  const stub = dispatch.get(scriptName, {}, { limits: FUNCTIONS_DISPATCH_LIMITS });
  return stub.fetch(request);
}

// ─── Functions on WfP (ADR-0035) — one bundled `functions/` worker per site ───

/** WfP script names cap at 64 chars; `-preview` (8 chars) is reserved so both slots fit. */
const WFP_SCRIPT_NAME_MAX = 64;
const WFP_PREVIEW_SUFFIX = '-preview';

/**
 * Stable, sync 8-hex-char FNV-1a hash — a deterministic collision-resistant suffix for
 * a truncated script name. Not cryptographic; only needs to keep two distinct long site
 * ids from colliding after truncation (crypto.subtle is async + overkill for a name).
 */
function shortHash8(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * WfP script name for a site's bundled `functions/` worker — the SSOT shared by
 * upload (Stage 2.2), the preview slot (Stage 2.3 → `-preview`), and dispatch
 * (Stage 3.1 → `env.USER_DISPATCH.get(name)`). `site-<siteId>` per ADR-0035 §5,
 * normalised to the WfP-legal charset (lowercase alphanumeric + hyphen).
 *
 * The WfP script-name limit is 64 chars. Short ids pass through byte-identical; a long id
 * that would exceed the cap is truncated and given a stable `-<hash8>` suffix (derived from
 * the FULL id) so two distinct long ids can never collide. `-preview` is always reserved
 * within the cap, never truncated away.
 *
 * @example siteFunctionsScriptName('AbC-123')                 // 'site-abc-123'
 * @example siteFunctionsScriptName('abc', { preview: true })  // 'site-abc-preview'
 */
export function siteFunctionsScriptName(siteId: string, opts: { preview?: boolean } = {}): string {
  const normalised = siteId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const suffixLen = opts.preview ? WFP_PREVIEW_SUFFIX.length : 0;
  const budget = WFP_SCRIPT_NAME_MAX - suffixLen; // chars available before the -preview suffix
  let base = `site-${normalised}`;
  if (base.length > budget) {
    const hash = `-${shortHash8(normalised)}`; // 9 chars, derived from the FULL id
    base = `${base.slice(0, budget - hash.length)}${hash}`;
  }
  return opts.preview ? `${base}${WFP_PREVIEW_SUFFIX}` : base;
}

/**
 * Upload (overwrite) a site's bundled `functions/` worker into the dispatch
 * namespace as `site-<siteId>` (or `-preview`). `script` is the single esbuild
 * ESM bundle produced by `scripts/functions-build`. Returns the CF error body +
 * status on a non-2xx (so a bad build is surfaced, never swallowed) and lets a
 * network throw propagate. Entitlement gating (`customEndpoints`) is the
 * caller's responsibility (the publish orchestration).
 *
 * @remarks Impure — issues a Cloudflare REST API PUT.
 */
export async function uploadSiteFunctionsWorker(
  env: Env,
  siteId: string,
  script: string,
  opts: {
    preview?: boolean;
    secretsJson?: string;
    kvNamespaceId?: string;
    r2BucketName?: string;
    fnToken?: string;
    fnService?: string;
  } = {},
): Promise<{ ok: true; scriptName: string } | { ok: false; error: string; status?: number }> {
  if (!isWfpConfigured(env)) {
    return { ok: false, error: 'Workers for Platforms not configured on this account' };
  }
  const scriptName = siteFunctionsScriptName(siteId, opts);
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.WFP_NAMESPACE_NAME}/scripts/${scriptName}`;

  // Stage 4.1 (ADR-0035 §6) — inject the runtime-shim bindings the generated
  // worker's `buildFunctionsEnv` folds into the tenant-scoped `env`:
  //  · `__PS_SITE_ID` (plain_text) — the isolation boundary the KV/R2 shims key on.
  //  · `__PS_SECRETS_JSON` (secret_text) — site+org env-vars → `env.SECRETS`.
  //  · `__PS_KV` (kv_namespace) — the SHARED functions KV namespace; the shim
  //    prefixes `site:<id>:` so a site can only reach its OWN keys (never raw).
  //  · `__PS_R2` (r2_bucket) — the platform R2 bucket; the shim prefixes
  //    `sites-data/<id>/` so a site can only reach its OWN objects (never raw).
  //  · `__PS_FN_TOKEN` (secret_text) + `__PS_SVC` (service binding to the platform
  //    worker) — the `env.AI` shim calls `__PS_SVC.fetch('/api/_ps/ai/run')` with
  //    the signed token (metered debit-then-call; no raw `ai` binding). A SERVICE
  //    binding (in-process worker→worker), NOT a public URL — a WfP user script
  //    fetching the platform's own workers.dev reenters the account and 522s. Also
  //    backs env.DATA next.
  const bindings: Record<string, unknown>[] = [
    { type: 'plain_text', name: '__PS_SITE_ID', text: siteId },
  ];
  if (opts.secretsJson && opts.secretsJson.length > 0) {
    bindings.push({ type: 'secret_text', name: '__PS_SECRETS_JSON', text: opts.secretsJson });
  }
  if (opts.kvNamespaceId) {
    bindings.push({ type: 'kv_namespace', name: '__PS_KV', namespace_id: opts.kvNamespaceId });
  }
  if (opts.r2BucketName) {
    bindings.push({ type: 'r2_bucket', name: '__PS_R2', bucket_name: opts.r2BucketName });
  }
  if (opts.fnToken) {
    bindings.push({ type: 'secret_text', name: '__PS_FN_TOKEN', text: opts.fnToken });
  }
  if (opts.fnService) {
    bindings.push({ type: 'service', name: '__PS_SVC', service: opts.fnService });
  }
  const metadata: Record<string, unknown> = {
    main_module: 'worker.mjs',
    compatibility_date: '2026-05-01',
    bindings,
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'worker.mjs',
    new Blob([script], { type: 'application/javascript+module' }),
    'worker.mjs',
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: body.slice(0, 800), status: res.status };
  }
  return { ok: true, scriptName };
}

/** Delete a site's functions worker (live or `-preview`). Best-effort; never throws. */
export async function deleteSiteFunctionsWorker(
  env: Env,
  siteId: string,
  opts: { preview?: boolean } = {},
): Promise<void> {
  if (!isWfpConfigured(env)) return;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.WFP_NAMESPACE_NAME}/scripts/${siteFunctionsScriptName(siteId, opts)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
  ).catch(() => {});
}
