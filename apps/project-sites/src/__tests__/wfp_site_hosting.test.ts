/**
 * Unit tests for `deploySiteToWfp` — WfP Site Hosting Work Unit 2
 * (docs/wfp-site-hosting.md §Work units 2).
 *
 * Under test: build a per-site User Worker from the site's R2 build
 * (`sites/{slug}/{version}/*` + a serving shim), upload it to the WfP dispatch
 * namespace as `site-<id>` (production) | `site-<id>-preview` (preview) carrying
 * its OWN static assets via the assets-upload-session flow, then record the slot
 * in `site_resource_registry`. Security: `assertSiteOwned` gates it (404-on-foreign,
 * no CF calls on rejection). Fail-soft: any WfP miss/error returns `{ok:false}`,
 * never throws into the caller.
 *
 * swc-jest hoists `jest.mock` above imports ONLY when it sees the GLOBAL `jest`
 * (do NOT import `jest` from @jest/globals). From `src/__tests__/`, mock paths use
 * ONE `../` to reach `src/`.
 */

// ─── Mocks (must precede the SUT import) ──────────────────────────────────────
const mockAssertSiteOwned = jest.fn();
jest.mock('../services/site_ownership.js', () => ({
  assertSiteOwned: (...a: unknown[]) => mockAssertSiteOwned(...a),
}));

const mockDbQueryOne = jest.fn();
jest.mock('../services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

const mockRecordResource = jest.fn();
jest.mock('../../libs/features/data_resource_registry/service.js', () => ({
  recordResource: (...a: unknown[]) => mockRecordResource(...a),
}));

import { deploySiteToWfp } from '../services/wfp_site_hosting.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OWNER_ORG = 'org_owner';
const OWNED_SITE = 'abc123de-f012-7abc-9def-0123456789ab';

/** A minimal R2 bucket double: list() returns keys, get() returns a body. */
function fakeBucket(files: Record<string, string>) {
  const keys = Object.keys(files);
  return {
    async list({ prefix, cursor }: { prefix: string; cursor?: string; limit?: number }) {
      const matched = keys.filter((k) => k.startsWith(prefix));
      // single page (cursor undefined path)
      void cursor;
      return {
        objects: matched.map((key) => ({ key })),
        truncated: false,
        cursor: undefined as string | undefined,
      };
    },
    async get(key: string) {
      if (!(key in files)) return null;
      const text = files[key];
      return {
        key,
        async arrayBuffer() {
          return new TextEncoder().encode(text).buffer;
        },
        async text() {
          return text;
        },
      };
    },
  };
}

type TestEnv = {
  DB: unknown;
  SITES_BUCKET: unknown;
  USER_DISPATCH?: unknown;
  WFP_NAMESPACE_NAME?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
};

function envWith(over: Partial<TestEnv> = {}): TestEnv {
  return {
    DB: {},
    SITES_BUCKET: fakeBucket({
      'sites/vitos/v2/index.html': '<!doctype html><h1>Vitos</h1>',
      'sites/vitos/v2/assets/app.abc123.js': 'console.log(1)',
      'sites/vitos/v2/assets/app.def456.css': 'body{color:red}',
    }),
    USER_DISPATCH: {},
    WFP_NAMESPACE_NAME: 'project-sites-endpoints',
    CF_ACCOUNT_ID: 'acct_server',
    CF_API_TOKEN: 'cf_token_secret',
    ...over,
  };
}

/** Site row `dbQueryOne` resolves for the OWNED site. */
const SITE_ROW = { slug: 'vitos', current_build_version: 'v2' };

let fetchMock: jest.Mock;
const origFetch = globalThis.fetch;

beforeEach(() => {
  mockAssertSiteOwned.mockReset().mockResolvedValue(true);
  mockDbQueryOne.mockReset().mockResolvedValue(SITE_ROW);
  mockRecordResource.mockReset().mockResolvedValue({ ok: true, id: 'row_wfp_1' });

  // Every CF REST call succeeds: assets-upload-session → jwt+buckets, asset upload → jwt,
  // script PUT → success. Keyed by URL so order-independence is asserted.
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/assets-upload-session')) {
      return new Response(
        JSON.stringify({ success: true, result: { jwt: 'jwt_start', buckets: [] } }),
        { status: 200 },
      );
    }
    if (url.includes('/workers/assets/upload')) {
      return new Response(JSON.stringify({ success: true, result: { jwt: 'jwt_done' } }), {
        status: 200,
      });
    }
    // script PUT into dispatch namespace
    return new Response(JSON.stringify({ success: true, result: { id: 'script_v1' } }), {
      status: 200,
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('deploySiteToWfp', () => {
  it('rejects a foreign site with a typed error and makes NO Cloudflare call', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);

    const res = await deploySiteToWfp(envWith() as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_owned');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRecordResource).not.toHaveBeenCalled();
  });

  it('fails soft (never throws) when WfP is not configured', async () => {
    const res = await deploySiteToWfp(envWith({ USER_DISPATCH: undefined }) as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('wfp_not_configured');
    expect(mockRecordResource).not.toHaveBeenCalled();
  });

  it('deploys the PRODUCTION slot: uploads assets + script to site-<id>, records the row', async () => {
    const res = await deploySiteToWfp(envWith() as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);

    // Production slot name (no -preview suffix), normalised to WfP charset.
    expect(res.scriptName).toBe('site-abc123de-f012-7abc-9def-0123456789ab');
    expect(res.slot).toBe('production');
    expect(res.version).toBe('v2');
    // Digests are recorded for promotion idempotency.
    expect(typeof res.sourceDigest).toBe('string');
    expect(res.sourceDigest.length).toBeGreaterThan(0);
    expect(typeof res.artifactDigest).toBe('string');
    expect(res.artifactDigest.length).toBeGreaterThan(0);

    // The assets-upload-session was opened against the production script path.
    const sessionCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/assets-upload-session'),
    );
    expect(sessionCall).toBeDefined();
    expect(String(sessionCall![0])).toContain(
      '/dispatch/namespaces/project-sites-endpoints/scripts/site-abc123de-f012-7abc-9def-0123456789ab/assets-upload-session',
    );

    // The script PUT went to the same production slot in the dispatch namespace.
    const putCall = fetchMock.mock.calls.find(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === 'PUT' &&
        String(c[0]).includes('/scripts/site-abc123de-f012-7abc-9def-0123456789ab') &&
        !String(c[0]).includes('assets-upload-session'),
    );
    expect(putCall).toBeDefined();
    // Uses the short-lived Bearer creds server-side, never the global key.
    expect((putCall![1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer cf_token_secret',
    });

    // Recorded the slot in the registry with the WfP concept + slot + script + version + digests.
    expect(mockRecordResource).toHaveBeenCalledTimes(1);
    const recorded = mockRecordResource.mock.calls[0][1] as Record<string, unknown>;
    expect(recorded).toMatchObject({
      orgId: OWNER_ORG,
      siteId: OWNED_SITE,
      environment: 'production',
      resourceConcept: 'wfp_namespace',
      wfpDispatchNamespace: 'project-sites-endpoints',
      userWorkerScript: 'site-abc123de-f012-7abc-9def-0123456789ab',
      deployedVersion: 'v2',
    });
    // Source+artifact digests ride along (usage_json) so a re-deploy is idempotent.
    expect(String(recorded.usageJson)).toContain(res.sourceDigest);
  });

  it('deploys the PREVIEW slot to site-<id>-preview', async () => {
    const res = await deploySiteToWfp(envWith() as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'preview',
      version: 'v2',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.scriptName).toBe('site-abc123de-f012-7abc-9def-0123456789ab-preview');
    expect(res.slot).toBe('preview');

    const putCall = fetchMock.mock.calls.find(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === 'PUT' &&
        String(c[0]).includes('/scripts/site-abc123de-f012-7abc-9def-0123456789ab-preview'),
    );
    expect(putCall).toBeDefined();

    const recorded = mockRecordResource.mock.calls[0][1] as Record<string, unknown>;
    expect(recorded).toMatchObject({ environment: 'preview', userWorkerScript: 'site-abc123de-f012-7abc-9def-0123456789ab-preview' });
  });

  it('falls back to sites.current_build_version when no version is passed', async () => {
    const res = await deploySiteToWfp(envWith() as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.version).toBe('v2');
  });

  it('fails soft when the R2 build for the version is empty (no assets)', async () => {
    const emptyBucket = fakeBucket({}); // list() returns nothing for the prefix
    const res = await deploySiteToWfp(envWith({ SITES_BUCKET: emptyBucket }) as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('empty_build');
    expect(mockRecordResource).not.toHaveBeenCalled();
  });

  it('fails soft (returns the CF error) when the script PUT is rejected', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/assets-upload-session')) {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'j', buckets: [] } }), {
          status: 200,
        });
      }
      // script PUT rejected
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'bad bundle' }] }), {
        status: 400,
      });
    });

    const res = await deploySiteToWfp(envWith() as never, OWNED_SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('bad bundle');
    // A failed upload must NOT record a "live" registry row.
    expect(mockRecordResource).not.toHaveBeenCalled();
  });
});
