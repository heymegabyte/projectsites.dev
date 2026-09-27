/**
 * TDD tests for the two Vectorize-slice MCP tools:
 *   data_vectorize_list     — summarise the site's own namespace inside the shared Vectorize index
 *   data_vectorize_describe — describe the index config + namespace + (namespace-scoped) get-by-ids metadata
 *
 * Same pattern as platform_mcp_data_r2.test.ts: no real CF, all external deps mocked, global jest
 * convention (NO `import { jest }` — swc-jest hoists only the global).
 *
 * Security contract under test:
 *   (a) Foreign site (org mismatch) → isError + 'Site not found.' (no leak)
 *   (b) per_site_vectorize flag OFF → isError + dark-mode message
 *   (c) tools/list advertises both tools
 *   (d) Both tools require the 'data:read' scope
 *   (e) not-provisioned namespace → honest 'no Vectorize namespace yet' (never fabricated)
 *   (f) list returns the server-derived namespace + index config (no fabricated vector count)
 *   (g) describe returns id+metadata ONLY (never raw vector values), namespace-scoped
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

// The kv + r2 adapters are imported by the service too — stub so nothing tries a real fetch.
jest.mock('../../data_resource_registry/adapters/kv.js', () => ({
  kvAdapter: { list: jest.fn(), get: jest.fn() },
}));
jest.mock('../../data_resource_registry/adapters/r2.js', () => ({
  r2Adapter: { list: jest.fn(), get: jest.fn() },
}));

const mockVecList = jest.fn();
const mockVecGet = jest.fn();
jest.mock('../../data_resource_registry/adapters/vectorize.js', () => ({
  vectorizeAdapter: {
    list: (...a: unknown[]) => mockVecList(...a),
    get: (...a: unknown[]) => mockVecGet(...a),
  },
}));

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: jest.fn().mockResolvedValue({ email: 'e', key: 'k' }),
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

/** A resolved Vectorize scope the resolver returns for an OWNED site (resourceId = SHARED index name). */
const resolvedVec = {
  ok: true,
  resourceId: 'projectsites-rag',
  resourceKind: 'vectorize',
  environment: 'production',
  accountId: 'acct-1',
  registryRowId: 'row-1',
  accessPolicy: 'site_scoped',
};

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockResolveResourceRef.mockReset();
  mockVecList.mockReset();
  mockVecGet.mockReset();
});

// ─── tools/list ─────────────────────────────────────────────────────────────────

describe('Vectorize tools catalog', () => {
  it('(c) tools/list includes data_vectorize_list and data_vectorize_describe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await rpc('tools/list');
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('data_vectorize_list');
    expect(names).toContain('data_vectorize_describe');
  });
});

// ─── data_vectorize_list ────────────────────────────────────────────────────────

describe('data_vectorize_list', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_vectorize flag OFF returns dark error', async () => {
    // mcp_server flag ON, per_site_vectorize flag OFF.
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_list', arguments: { site_id: 'site-1' } },
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
      { name: 'data_vectorize_list', arguments: { site_id: 'foreign-site' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
    expect(body.result.content[0].text).not.toMatch(/org/i);
    // Adapter never reached for a foreign site.
    expect(mockVecList).not.toHaveBeenCalled();
  });

  it('(e) not-provisioned Vectorize → honest "no Vectorize namespace yet" (never fabricated)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' }); // ownership passes
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Vectorize namespace yet/i);
    expect(mockVecList).not.toHaveBeenCalled();
  });

  it('(f) returns the server-derived namespace + index config (no fabricated vector count)', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedVec);
    mockVecList.mockResolvedValueOnce({
      ok: true,
      correlationId: 'vec-1',
      data: {
        indexName: 'projectsites-rag',
        namespace: 'site-site-1x',
        dimensions: 768,
        metric: 'cosine',
        metadataIndexes: [{ propertyName: 'org_id', type: 'string' }],
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_list', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.indexName).toBe('projectsites-rag');
    expect(payload.namespace).toBe('site-site-1x');
    expect(payload.dimensions).toBe(768);
    expect(payload.metric).toBe('cosine');
    expect(payload.metadataIndexes[0].propertyName).toBe('org_id');
    // No fabricated vector count.
    expect(payload.vectorCount).toBeUndefined();
  });
});

// ─── data_vectorize_describe ─────────────────────────────────────────────────────

describe('data_vectorize_describe', () => {
  it('(d) requires data:read scope — sites:read token gets a scope error', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(sitesReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_describe', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/scope/i);
  });

  it('(b) per_site_vectorize flag OFF returns dark error', async () => {
    mockIsFlagOn.mockImplementation((_env: unknown, key: string) =>
      Promise.resolve(key === 'mcp_server'),
    );
    mockVerify.mockResolvedValue(dataReadToken);
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_describe', arguments: { site_id: 'site-1' } },
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
      { name: 'data_vectorize_describe', arguments: { site_id: 'foreign' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Site not found.');
  });

  it('(g) returns id+metadata ONLY for fetched vectors — never raw values, namespace-scoped', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce(resolvedVec);
    mockVecGet.mockResolvedValueOnce({
      ok: true,
      correlationId: 'vec-1',
      data: {
        indexName: 'projectsites-rag',
        namespace: 'site-site-1x',
        dimensions: 768,
        metric: 'cosine',
        vectors: [{ id: 'v1', metadata: { title: 'Home' }, namespace: 'site-site-1x' }],
        metadataOnly: true,
      },
    });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_describe', arguments: { site_id: 'site-1', ids: ['v1'] } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.vectors[0].id).toBe('v1');
    expect(payload.vectors[0].metadata).toEqual({ title: 'Home' });
    expect(payload.metadataOnly).toBe(true);
    // Never any raw-vector-values field.
    expect(payload.vectors[0].values).toBeUndefined();
    // ids forwarded to the adapter (namespace derivation happens inside the adapter, from siteId).
    expect(mockVecGet.mock.calls[0][1].ids).toEqual(['v1']);
  });

  it('(e) not-provisioned Vectorize → honest "no Vectorize namespace yet"', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockVerify.mockResolvedValue(dataReadToken);
    const { dbQueryOne } = require('../../../../src/services/db.js');
    dbQueryOne.mockResolvedValueOnce({ id: 'site-1' });
    mockResolveResourceRef.mockResolvedValueOnce({ ok: false, reason: 'not_registered' });
    const res = await rpc(
      'tools/call',
      { name: 'data_vectorize_describe', arguments: { site_id: 'site-1' } },
      { authorization: 'Bearer psk_x' },
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Vectorize namespace yet/i);
    expect(mockVecGet).not.toHaveBeenCalled();
  });
});
