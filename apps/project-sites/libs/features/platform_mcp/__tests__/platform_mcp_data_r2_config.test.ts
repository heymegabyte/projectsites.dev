/**
 * TDD tests for the two R2-polish MCP tools:
 *   data_r2_bucket_config — read the site bucket's CORS/lifecycle/public-access/custom-domain settings (READ-ONLY,
 *                           honest requiresPlatformAdmin per setting)
 *   data_r2_preview_url   — a short-lived SCOPED preview/download URL for one object (NEVER account credentials)
 *
 * Same pattern as platform_mcp_data_r2.test.ts: no real CF, all external deps mocked, global jest convention
 * (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak)         [org-isolation]
 *   (b) per_site_r2 flag OFF        → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) not-provisioned bucket → honest 'no R2 bucket yet' (never fabricated)
 *   (f) bucket_config surfaces requiresPlatformAdmin honestly + NEVER leaks a credential
 *   (g) preview_url surfaces found/available/approach + NEVER leaks a credential / creds-bearing url
 */
import { Hono } from 'hono';

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockVerify = jest.fn();
jest.mock('../../../../src/services/api_tokens.js', () => ({
  verifyApiToken: (...a: unknown[]) => mockVerify(...a),
  extractBearerToken: (h: string | null) => (h ? h.replace(/^Bearer\s+/i, '') : null),
  hasScope: (token: { scopes?: string }, scope: string) => {
    const scopes: string[] = JSON.parse(token.scopes ?? '[]');
    return scopes.includes(scope);
  },
}));

jest.mock('../../../../src/services/db.js', () => ({
  dbInsert: jest.fn().mockResolvedValue({}),
  dbQuery: jest.fn().mockResolvedValue({ data: [] }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../../../../src/services/billing.js', () => ({
  getOrgEntitlements: jest.fn().mockResolvedValue({ topBarHidden: false }),
}));

jest.mock('../../../../src/services/domains.js', () => ({
  checkCnameTarget: jest.fn().mockResolvedValue(null),
  provisionCustomDomain: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../../src/services/site_data_db.js', () => ({
  resolveSiteDataDb: jest.fn(),
  listSiteTables: jest.fn(),
  isSafeIdent: (s: unknown): s is string =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  SiteDataD1Error: class extends Error {},
  FORBIDDEN_DB_IDS: new Set(['ea3e839a-c641-4861-ae30-dfc63bff8032']),
}));

const mockResolveResourceRef = jest.fn();
jest.mock('../../data_resource_registry/service.js', () => ({
  listResources: jest.fn().mockResolvedValue([]),
  resolveResourceRef: (...a: unknown[]) => mockResolveResourceRef(...a),
  recordResource: jest.fn(),
  getResource: jest.fn(),
}));

// The kv adapter is imported by the service too — stub it so nothing tries a real fetch.
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: { list: jest.fn(), get: jest.fn() },
}));

const mockR2BucketConfig = jest.fn();
const mockR2PreviewUrl = jest.fn();
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: {
    list: jest.fn(),
    get: jest.fn(),
    mutate: jest.fn(),
    bucketConfig: (...a: unknown[]) => mockR2BucketConfig(...a),
    previewUrl: (...a: unknown[]) => mockR2PreviewUrl(...a),
  },
}));

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: jest.fn().mockResolvedValue({ email: 'e', key: 'SUPER-SECRET-ACCOUNT-KEY' }),
  cfAuthHeaders: () => ({}),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { platformMcp } from '../handlers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function app() {
  const a = new Hono();
  a.route('/', platformMcp);
  return a;
}

const rpc = (
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
  env: Record<string, unknown> = {},
) =>
  app().request(
    '/api/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );

/** A token that has ONLY 'data:read' scope. */
const dataReadToken = { org_id: 'org-1', name: 'data-key', scopes: '["data:read"]' };
/** A token with ONLY 'sites:read' — NOT data:read. */
const sitesReadToken = { org_id: 'org-1', name: 'sites-key', scopes: '["sites:read"]' };

/** A resolved R2 scope the registry resolver returns for an OWNED, provisioned site (bucket name = id). */
const resolvedR2 = {
  ok: true,
  resourceId: 'ps-site-abc-123',
  resourceKind: 'r2',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockR2BucketConfig.mockReset();
  mockR2PreviewUrl.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('R2 config tools catalog', () => {
  it('(c) tools/list includes data_r2_bucket_config and data_r2_preview_url', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_r2_bucket_config');
    expect(names).toContain('data_r2_preview_url');
  });
});

// ─── data_r2_bucket_config ────────────────────────────────────────────────────────

describe('data_r2_bucket_config', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_bucket_config', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_r2 flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_bucket_config', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site (org mismatch) returns "Site not found." — no leak', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null); // ownership check fails
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_bucket_config', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    expect(mockR2BucketConfig).not.toHaveBeenCalled();
  });

  it('(e) not-provisioned R2 → honest "no R2 bucket yet" (never fabricated)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_bucket_config', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/R2 bucket yet/i);
    expect(mockR2BucketConfig).not.toHaveBeenCalled();
  });

  it('(f) surfaces requiresPlatformAdmin honestly and NEVER leaks a credential', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2BucketConfig.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: {
        exists: true,
        bucketName: 'ps-site-abc-123',
        settings: [
          { key: 'cors', label: 'CORS rules', requiresPlatformAdmin: false, available: true, value: [] },
          {
            key: 'public_access',
            label: 'Public access (r2.dev managed domain)',
            requiresPlatformAdmin: true,
            reason: 'account-wide',
            available: true,
            value: { enabled: false },
          },
        ],
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_bucket_config', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.exists).toBe(true);
    expect(payload.bucketName).toBe('ps-site-abc-123');
    const publicAccess = payload.settings.find((s: { key: string }) => s.key === 'public_access');
    expect(publicAccess.requiresPlatformAdmin).toBe(true);
    expect(publicAccess.reason).toBeTruthy();
    // Credential-safety: the whole result text must not contain the account key.
    expect(body.result.content[0].text).not.toContain('SUPER-SECRET-ACCOUNT-KEY');
  });
});

// ─── data_r2_preview_url ───────────────────────────────────────────────────────────

describe('data_r2_preview_url', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_preview_url', arguments: { site_id: 'site-1', key: 'k' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_r2 flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_preview_url', arguments: { site_id: 'site-1', key: 'k' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not enabled/i);
  });

  it('(a) foreign site returns "Site not found." — no leak', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce(null);
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_preview_url', arguments: { site_id: 'foreign', key: 'k' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(mockR2PreviewUrl).not.toHaveBeenCalled();
  });

  it('(g) surfaces found/available/approach for a found object and NEVER leaks a credential / creds URL', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2PreviewUrl.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: {
        key: 'doc.pdf',
        found: true,
        contentType: 'application/pdf',
        size: 1024,
        kind: 'pdf',
        available: false,
        approach: 'A short-lived signed R2 URL will be minted server-side — a scoped handle, never a credential.',
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_preview_url', arguments: { site_id: 'site-1', key: 'doc.pdf' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(true);
    expect(payload.available).toBe(false);
    expect(payload.approach).toBeTruthy();
    expect(payload.url).toBeUndefined();
    // Key was forwarded to the adapter.
    expect(mockR2PreviewUrl.mock.calls[0][1].key).toBe('doc.pdf');
    // Credential-safety: no account key, no S3 signature params anywhere in the response.
    const text = body.result.content[0].text;
    expect(text).not.toContain('SUPER-SECRET-ACCOUNT-KEY');
    expect(text).not.toMatch(/X-Amz-(Credential|Signature)/i);
  });

  it('(g) returns found:false for a missing object (honest miss, never a fabricated URL)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedR2);
    mockR2PreviewUrl.mockResolvedValueOnce({
      ok: true,
      correlationId: 'r2-1',
      data: { key: 'missing', found: false, available: false, approach: 'The object does not exist.' },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_r2_preview_url', arguments: { site_id: 'site-1', key: 'missing' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.found).toBe(false);
    expect(payload.url).toBeUndefined();
  });
});
