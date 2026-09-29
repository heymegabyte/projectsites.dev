/**
 * wfp_dispatch — Workers for Platforms dispatch helper (convergence r33).
 *
 * Locks the user-Worker lifecycle against the Cloudflare dispatch-namespace
 * REST API: the isWfpConfigured guard, uploadUserWorker's request build
 * (URL, Bearer auth, multipart metadata, deterministic script naming),
 * success parse, non-2xx/CF-error handling, network-throw propagation,
 * deleteUserWorker's fire-and-forget resilience, and dispatchToUserWorker's
 * namespace-binding fan-out + missing-binding short-circuit.
 *
 * The CF REST API is mocked via `global.fetch`; the USER_DISPATCH binding is a
 * jest stub. No real I/O. ts-jest global `jest`; casts via `as unknown as jest.Mock`.
 */
import {
  isWfpConfigured,
  uploadUserWorker,
  deleteUserWorker,
  dispatchToUserWorker,
  SUPPORTED_LANGUAGES,
  siteFunctionsScriptName,
  uploadSiteFunctionsWorker,
  deleteSiteFunctionsWorker,
} from '../services/wfp_dispatch.js';
import type { Env } from '../types/env.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Fully-configured WFP Env stub; pass overrides to knock out individual fields. */
function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    USER_DISPATCH: { get: jest.fn() },
    WFP_NAMESPACE_NAME: 'prod-ns',
    CF_ACCOUNT_ID: 'acct-123',
    CF_API_TOKEN: 'cf-token-xyz',
    ...over,
  } as unknown as Env;
}

/** Mock a CF REST response. */
function res(ok: boolean, opts: { status?: number; text?: string } = {}) {
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    text: jest.fn(async () => opts.text ?? ''),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
// isWfpConfigured — every-field-required AND guard
// ────────────────────────────────────────────────────────────
describe('isWfpConfigured', () => {
  it('is true only when all four fields are present', () => {
    expect(isWfpConfigured(makeEnv())).toBe(true);
  });

  it('is false when USER_DISPATCH binding is missing', () => {
    expect(isWfpConfigured(makeEnv({ USER_DISPATCH: undefined }))).toBe(false);
  });

  it('is false when WFP_NAMESPACE_NAME is missing', () => {
    expect(isWfpConfigured(makeEnv({ WFP_NAMESPACE_NAME: undefined }))).toBe(false);
  });

  it('is false when CF_ACCOUNT_ID is missing', () => {
    expect(isWfpConfigured(makeEnv({ CF_ACCOUNT_ID: undefined }))).toBe(false);
  });

  it('is false when CF_API_TOKEN is missing', () => {
    expect(isWfpConfigured(makeEnv({ CF_API_TOKEN: undefined }))).toBe(false);
  });

  it('is false when CF_API_TOKEN is unset but the other three fields are present', () => {
    // The single external gate (discovery-wfp-2026-09-29): binding + namespace + account
    // are all wired, yet an unset token must still fail-soft the whole WfP path.
    const env = makeEnv({ CF_API_TOKEN: undefined });
    expect(env.USER_DISPATCH).toBeTruthy();
    expect(env.WFP_NAMESPACE_NAME).toBeTruthy();
    expect(env.CF_ACCOUNT_ID).toBeTruthy();
    expect(isWfpConfigured(env)).toBe(false);
  });

  it('is false on a totally bare env', () => {
    expect(isWfpConfigured({} as unknown as Env)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// SUPPORTED_LANGUAGES — static catalog contract
// ────────────────────────────────────────────────────────────
describe('SUPPORTED_LANGUAGES', () => {
  it('lists the four supported runtimes with id+label+helper', () => {
    expect(SUPPORTED_LANGUAGES.map((l) => l.id)).toEqual([
      'javascript',
      'typescript',
      'python',
      'rust-wasm',
    ]);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(typeof lang.label).toBe('string');
      expect(lang.label.length).toBeGreaterThan(0);
      expect(typeof lang.helper).toBe('string');
      expect(lang.helper.length).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────
// uploadUserWorker — unconfigured short-circuit (no network)
// ────────────────────────────────────────────────────────────
describe('uploadUserWorker (unconfigured short-circuit)', () => {
  it('returns a not-configured error and never calls fetch when WFP is absent', async () => {
    const env = makeEnv({ CF_API_TOKEN: undefined });
    const out = await uploadUserWorker(env, {
      siteId: 'site-abcdef12',
      endpointSlug: 'hello',
      language: 'javascript',
      code: 'export default {}',
    });
    expect(out).toEqual({
      ok: false,
      error: 'Workers for Platforms not configured on this account',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// uploadUserWorker — request build, auth, naming, success parse
// ────────────────────────────────────────────────────────────
describe('uploadUserWorker (request build + success)', () => {
  it('PUTs to the namespace scripts URL with Bearer auth + multipart FormData', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(true));

    const out = await uploadUserWorker(env, {
      siteId: 'site-abcdef1234567890',
      endpointSlug: 'greet',
      language: 'javascript',
      code: 'export default { fetch() { return new Response("hi") } }',
    });

    expect(out).toEqual({ ok: true, scriptName: 'ai-site-abc-greet' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/dispatch/namespaces/prod-ns/scripts/ai-site-abc-greet',
    );
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token-xyz');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('derives a deterministic, lowercased, sanitized script name from siteId+slug', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValue(res(true));

    const a = await uploadUserWorker(env, {
      siteId: 'AB_CD!EF$1234',
      endpointSlug: 'My Endpoint/2',
      language: 'typescript',
      code: 'x',
    });
    const b = await uploadUserWorker(env, {
      siteId: 'AB_CD!EF$1234',
      endpointSlug: 'My Endpoint/2',
      language: 'typescript',
      code: 'x',
    });
    // siteId.slice(0,8) = "AB_CD!EF" → sanitized; no uppercase, no illegal chars
    if (a.ok && b.ok) {
      expect(a.scriptName).toBe(b.scriptName); // deterministic
      expect(a.scriptName).toMatch(/^[a-z0-9-]+$/);
      expect(a.scriptName.startsWith('ai-')).toBe(true);
    } else {
      throw new Error('expected both uploads to succeed');
    }
  });

  it('builds a JS module body (worker.mjs main_module) for typescript', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(true));
    const form = await captureForm(env, 'typescript', 'const x = 1');
    const metadata = JSON.parse(await blobText(form.get('metadata')));
    expect(metadata.main_module).toBe('worker.mjs');
    expect(metadata.compatibility_date).toBe('2026-05-01');
    expect(metadata.compatibility_flags).toBeUndefined();
    expect(metadata.bindings).toBeUndefined();
    expect(form.get('worker.mjs')).toBeTruthy();
  });

  it('adds python_workers compat flag + worker.py module for python', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(true));
    const form = await captureForm(env, 'python', 'def on_fetch(): pass');
    const metadata = JSON.parse(await blobText(form.get('metadata')));
    expect(metadata.main_module).toBe('worker.py');
    expect(metadata.compatibility_flags).toEqual(['python_workers']);
    expect(form.get('worker.py')).toBeTruthy();
  });

  it('adds a wasm_module binding for rust-wasm', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(true));
    const form = await captureForm(env, 'rust-wasm', '/* wasm */');
    const metadata = JSON.parse(await blobText(form.get('metadata')));
    expect(metadata.bindings).toEqual([{ type: 'wasm_module', name: 'WASM', part: 'wasm' }]);
    expect(metadata.main_module).toBe('worker.mjs'); // non-python uses .mjs
  });
});

/** Run uploadUserWorker and return the FormData body that fetch received. */
async function captureForm(env: Env, language: string, code: string): Promise<FormData> {
  await uploadUserWorker(env, {
    siteId: 'site-1234',
    endpointSlug: 'ep',
    language: language as 'javascript',
    code,
  });
  const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
  return init.body as FormData;
}

/** Read the text of a FormData entry (Blob or string). */
async function blobText(entry: FormDataEntryValue | null): Promise<string> {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  return await entry.text();
}

// ────────────────────────────────────────────────────────────
// uploadUserWorker — failure paths (non-2xx, CF error body, network throw)
// ────────────────────────────────────────────────────────────
describe('uploadUserWorker (failure paths)', () => {
  it('returns ok:false with status + truncated body on a non-2xx CF response', async () => {
    const env = makeEnv();
    const longErr = 'E'.repeat(1200);
    mockFetch.mockResolvedValueOnce(res(false, { status: 400, text: longErr }));

    const out = await uploadUserWorker(env, {
      siteId: 'site-xy',
      endpointSlug: 'bad',
      language: 'javascript',
      code: 'broken',
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.error.length).toBe(800); // truncated to 800 chars
    }
  });

  it('surfaces a CF validation error message verbatim (under the cap)', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(false, { status: 422, text: 'script too large' }));

    const out = await uploadUserWorker(env, {
      siteId: 'site-zz',
      endpointSlug: 'big',
      language: 'javascript',
      code: 'x',
    });
    expect(out).toEqual({ ok: false, error: 'script too large', status: 422 });
  });

  it('propagates a network throw (does not swallow it)', async () => {
    const env = makeEnv();
    mockFetch.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      uploadUserWorker(env, {
        siteId: 'site-nw',
        endpointSlug: 'net',
        language: 'javascript',
        code: 'x',
      }),
    ).rejects.toThrow('connection reset');
  });
});

// ────────────────────────────────────────────────────────────
// deleteUserWorker — DELETE call + fire-and-forget resilience
// ────────────────────────────────────────────────────────────
describe('deleteUserWorker', () => {
  it('issues a DELETE to the namespace script URL with Bearer auth', async () => {
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce(res(true));

    await deleteUserWorker(env, 'ai-site-x-ep');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/dispatch/namespaces/prod-ns/scripts/ai-site-x-ep',
    );
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token-xyz');
  });

  it('short-circuits without calling fetch when WFP is unconfigured', async () => {
    const env = makeEnv({ USER_DISPATCH: undefined });
    await deleteUserWorker(env, 'ai-site-x-ep');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('swallows a network throw (best-effort cleanup never rejects)', async () => {
    const env = makeEnv();
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    await expect(deleteUserWorker(env, 'ai-site-x-ep')).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// dispatchToUserWorker — namespace binding fan-out + missing-binding 503
// ────────────────────────────────────────────────────────────
describe('dispatchToUserWorker', () => {
  it('fetches the script via the USER_DISPATCH namespace binding stub', async () => {
    const stubResponse = new Response('user-worker-output', { status: 201 });
    const stubFetch = jest.fn(async () => stubResponse);
    const get = jest.fn(() => ({ fetch: stubFetch }));
    const env = makeEnv({ USER_DISPATCH: { get } });
    const req = new Request('https://x.test/path');

    const out = await dispatchToUserWorker(env, 'ai-site-x-ep', req);

    // Stage 4.2(d) — dispatched WITH the per-invocation WfP custom limits.
    expect(get).toHaveBeenCalledWith(
      'ai-site-x-ep',
      {},
      { limits: { cpuMs: 50, subRequests: 50 } },
    );
    expect(stubFetch).toHaveBeenCalledWith(req);
    expect(out).toBe(stubResponse);
    expect(await out.text()).toBe('user-worker-output');
  });

  it('returns a 503 when the USER_DISPATCH binding is missing', async () => {
    const env = makeEnv({ USER_DISPATCH: undefined });
    const out = await dispatchToUserWorker(env, 'any', new Request('https://x.test/'));
    expect(out.status).toBe(503);
    expect(await out.text()).toBe('USER_DISPATCH binding missing');
  });
});

// ────────────────────────────────────────────────────────────
// Functions on WfP (ADR-0035): site-<siteId> script name + upload/delete
// ────────────────────────────────────────────────────────────
describe('siteFunctionsScriptName', () => {
  it('derives site-<siteId>, normalized to lowercase + safe chars', () => {
    expect(siteFunctionsScriptName('AbC-123')).toBe('site-abc-123');
    expect(siteFunctionsScriptName('a_b.c')).toBe('site-a-b-c');
  });
  it('appends -preview for the preview slot (Stage 2.3)', () => {
    expect(siteFunctionsScriptName('abc', { preview: true })).toBe('site-abc-preview');
  });

  it('caps the script name at the WfP 64-char limit for a long site id', () => {
    // WfP script names have a 64-char ceiling; a raw `site-<uuid-ish-long-id>` can exceed it.
    const longId = 'a'.repeat(120);
    const name = siteFunctionsScriptName(longId);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9-]+$/); // lowercase alphanumeric + hyphen only
    expect(name.startsWith('site-')).toBe(true);
    // -preview variant also stays within the cap (suffix reserved, not truncated away).
    const preview = siteFunctionsScriptName(longId, { preview: true });
    expect(preview.length).toBeLessThanOrEqual(64);
    expect(preview.endsWith('-preview')).toBe(true);
    expect(preview).toMatch(/^[a-z0-9-]+$/);
  });

  it('is collision-safe — two distinct long ids yield two distinct names', () => {
    // Truncation alone would collide any two ids sharing a long common prefix; a stable
    // hash suffix keeps them distinct even when the readable prefix is identical.
    const a = 'z'.repeat(60) + 'aaaaaaaa';
    const b = 'z'.repeat(60) + 'bbbbbbbb';
    const nameA = siteFunctionsScriptName(a);
    const nameB = siteFunctionsScriptName(b);
    expect(nameA).not.toBe(nameB);
    expect(nameA.length).toBeLessThanOrEqual(64);
    expect(nameB.length).toBeLessThanOrEqual(64);
    // Deterministic: same id → same name (idempotent overwrite target).
    expect(siteFunctionsScriptName(a)).toBe(nameA);
  });
});

describe('uploadSiteFunctionsWorker', () => {
  it('short-circuits (no network) when WfP is unconfigured', async () => {
    const out = await uploadSiteFunctionsWorker(
      makeEnv({ CF_API_TOKEN: undefined }),
      'abc',
      'export default {}',
    );
    expect(out.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('PUTs the bundled ESM to scripts/site-<id> with Bearer auth + multipart FormData', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    const out = await uploadSiteFunctionsWorker(
      makeEnv(),
      'abc-123',
      'export default { async fetch() { return new Response("ok"); } }',
    );
    expect(out).toEqual({ ok: true, scriptName: 'site-abc-123' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/dispatch/namespaces/prod-ns/scripts/site-abc-123',
    );
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token-xyz');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('uploads the -preview script name when preview:true', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    const out = await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}', {
      preview: true,
    });
    expect(out).toEqual({ ok: true, scriptName: 'site-abc-preview' });
    expect((mockFetch.mock.calls[0] as [string])[0]).toContain('/scripts/site-abc-preview');
  });

  it('always injects the __PS_SITE_ID plain_text binding (the KV/R2 isolation boundary)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}');
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect(metadata.bindings).toEqual([{ type: 'plain_text', name: '__PS_SITE_ID', text: 'abc' }]);
  });

  it('adds the __PS_SECRETS_JSON secret_text binding when secretsJson is provided (Stage 4.1a)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    const secretsJson = JSON.stringify({ API_KEY: 'x', TOKEN: 'y' });
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}', { secretsJson });
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect(metadata.bindings).toContainEqual({
      type: 'secret_text',
      name: '__PS_SECRETS_JSON',
      text: secretsJson,
    });
    expect(metadata.bindings).toContainEqual({
      type: 'plain_text',
      name: '__PS_SITE_ID',
      text: 'abc',
    });
  });

  it('adds a __PS_KV kv_namespace binding when kvNamespaceId is provided (Stage 4.1b)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}', {
      kvNamespaceId: 'ns-123',
    });
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect(metadata.bindings).toContainEqual({
      type: 'kv_namespace',
      name: '__PS_KV',
      namespace_id: 'ns-123',
    });
  });

  it('adds a __PS_R2 r2_bucket binding when r2BucketName is provided (Stage 4.1c)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}', {
      r2BucketName: 'bkt-prod',
    });
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect(metadata.bindings).toContainEqual({
      type: 'r2_bucket',
      name: '__PS_R2',
      bucket_name: 'bkt-prod',
    });
  });

  it('adds __PS_FN_TOKEN (secret_text) + __PS_SVC (service binding) when provided (Stage 4.1d)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}', {
      fnToken: 'abc.sig',
      fnService: 'project-sites',
    });
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect(metadata.bindings).toContainEqual({
      type: 'secret_text',
      name: '__PS_FN_TOKEN',
      text: 'abc.sig',
    });
    expect(metadata.bindings).toContainEqual({
      type: 'service',
      name: '__PS_SVC',
      service: 'project-sites',
    });
  });

  it('omits __PS_KV when no kvNamespaceId is provided (only __PS_SITE_ID present)', async () => {
    mockFetch.mockResolvedValueOnce(res(true, { status: 200 }));
    await uploadSiteFunctionsWorker(makeEnv(), 'abc', 'export default {}');
    const init = mockFetch.mock.calls.at(-1)![1] as RequestInit;
    const metadata = JSON.parse(await blobText((init.body as FormData).get('metadata')));
    expect((metadata.bindings as { name: string }[]).some((b) => b.name === '__PS_KV')).toBe(false);
  });

  it('returns the CF error body + status on a non-2xx (bad build surfaced, not swallowed)', async () => {
    mockFetch.mockResolvedValueOnce(res(false, { status: 400, text: 'invalid module' }));
    const out = await uploadSiteFunctionsWorker(makeEnv(), 'x', 's');
    expect(out).toEqual({ ok: false, error: 'invalid module', status: 400 });
  });

  it('propagates a network throw (does not swallow it)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection reset'));
    await expect(uploadSiteFunctionsWorker(makeEnv(), 'x', 's')).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('deleteSiteFunctionsWorker', () => {
  it('issues a DELETE to scripts/site-<id> with Bearer auth', async () => {
    mockFetch.mockResolvedValueOnce(res(true));
    await deleteSiteFunctionsWorker(makeEnv(), 'abc');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/dispatch/namespaces/prod-ns/scripts/site-abc',
    );
    expect(init.method).toBe('DELETE');
  });
  it('is fire-and-forget — no throw when unconfigured or on network error', async () => {
    await expect(
      deleteSiteFunctionsWorker(makeEnv({ CF_API_TOKEN: undefined }), 'x'),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    await expect(deleteSiteFunctionsWorker(makeEnv(), 'x')).resolves.toBeUndefined();
  });
});
