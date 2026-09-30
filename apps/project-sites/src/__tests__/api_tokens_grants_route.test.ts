/**
 * Route contract for the `ai_api_keys` grant extension of `apiTokensAdmin`
 * (`/api/v1-tokens`) — campaign lane-3 (CAMPAIGN-cf-native-ai §5).
 *
 * POST /api/v1-tokens now accepts an OPTIONAL `grant` body (a mint-time
 * snapshot of CONCRETE ids validated by the shared ai-policy GrantInputSchema)
 * and GET list responses attach a grant SUMMARY (counts, never the full
 * snapshot). Everything is gated on the `ai_api_keys` flag (DARK by default):
 *
 *   - flag OFF + `grant` present  → 400 VALIDATION_ERROR ("not available"),
 *     and NO token is minted (never a token the caller thinks is AI-scoped).
 *   - flag OFF + no `grant`       → the pre-existing token flow, byte-for-byte.
 *   - flag ON  + valid `grant`    → 201; grant persisted via putGrantForToken
 *     against the freshly minted token id; response carries the summary.
 *   - flag ON  + invalid `grant`  → 400 with per-field `issues`; NO token minted.
 *   - flag ON  + GET              → each listed token carries its grant summary.
 *   - flag OFF + GET              → list shape unchanged (no grant key, no reads).
 *   - DELETE                      → revokes the attached grant alongside the token.
 *
 * ts-jest/@swc-jest: GLOBAL `jest` so mocks hoist above the route import.
 * `ai_key_grants` is PARTIALLY mocked — DB-touching fns stubbed, the pure
 * GrantInputSchema/summarizeGrant kept REAL so validation is genuine.
 */
import { Hono } from 'hono';

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(async () => false),
}));
jest.mock('../services/api_tokens.js', () => ({
  listApiTokens: jest.fn(async () => []),
  createApiToken: jest.fn(async () => ({
    token: { id: 'tok-1', org_id: 'org-1', name: 'CI', scopes: ['sites:read'], created_at: 'now' },
    plaintext: 'psk_deadbeef',
  })),
  revokeApiToken: jest.fn(async () => true),
  VALID_SCOPES: ['sites:read', 'sites:write', 'me:read'] as const,
}));
jest.mock('../services/ai_key_grants.js', () => {
  const actual = jest.requireActual('../services/ai_key_grants.js');
  return {
    ...actual,
    putGrantForToken: jest.fn(),
    getGrantForToken: jest.fn(),
    revokeGrant: jest.fn(async () => true),
    listGrantsForOrg: jest.fn(async () => []),
  };
});

import { GrantRecordSchema } from '@project-sites/shared';

import { apiTokensAdmin } from '../routes/api_tokens_admin.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { createApiToken, revokeApiToken } from '../services/api_tokens.js';
import { putGrantForToken, revokeGrant, listGrantsForOrg } from '../services/ai_key_grants.js';

const isFlagOnMock = isFlagOn as jest.Mock;
const createApiTokenMock = createApiToken as jest.Mock;
const revokeApiTokenMock = revokeApiToken as jest.Mock;
const putGrantForTokenMock = putGrantForToken as jest.Mock;
const revokeGrantMock = revokeGrant as jest.Mock;
const listGrantsForOrgMock = listGrantsForOrg as jest.Mock;

const env = { DB: {} } as never;

/** Valid mint-time grant body — CONCRETE ids only. */
const grantBody = {
  siteIds: ['site-aaa'],
  connectionIds: [],
  actionIds: ['workers_ai.text.generate'],
  modelIds: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  expiresAt: '2027-01-01T00:00:00Z',
};

/** The full record the (mocked) service reports back after persisting. */
const persistedGrant = GrantRecordSchema.parse({
  id: '01920000-0000-7000-8000-000000000001',
  principal: { kind: 'api_key', refId: 'tok-1' },
  orgId: 'org-1',
  siteIds: ['site-aaa'],
  connectionIds: [],
  actionIds: ['workers_ai.text.generate'],
  modelIds: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  limits: {},
  approvalPolicy: 'follow_capability',
  revision: 1,
  expiresAt: '2027-01-01T00:00:00Z',
});

function buildApp(orgId: string | undefined = 'org-1', userId: string | undefined = 'user-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (orgId !== undefined && orgId !== '') c.set('orgId' as never, orgId as never);
    if (userId !== undefined && userId !== '') c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', apiTokensAdmin);
  return app;
}

function postTokens(body: unknown) {
  return buildApp().request(
    '/api/v1-tokens',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  isFlagOnMock.mockResolvedValue(false);
  putGrantForTokenMock.mockResolvedValue(persistedGrant);
  revokeGrantMock.mockResolvedValue(true);
  listGrantsForOrgMock.mockResolvedValue([]);
  createApiTokenMock.mockResolvedValue({
    token: { id: 'tok-1', org_id: 'org-1', name: 'CI', scopes: ['sites:read'], created_at: 'now' },
    plaintext: 'psk_deadbeef',
  });
  revokeApiTokenMock.mockResolvedValue(true);
});

describe('POST /api/v1-tokens with `grant` — flag OFF (DARK default)', () => {
  it('rejects the grant with VALIDATION_ERROR "not available" and mints NO token', async () => {
    const res = await postTokens({ name: 'AI key', scopes: ['sites:read'], grant: grantBody });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.message).toMatch(/not available/i);
    expect(createApiTokenMock).not.toHaveBeenCalled();
    expect(putGrantForTokenMock).not.toHaveBeenCalled();
  });

  it('leaves the no-grant token flow unchanged (201, no grant in response)', async () => {
    const res = await postTokens({ name: 'CI', scopes: ['sites:read'] });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.plaintext).toBe('psk_deadbeef');
    expect(json.grant).toBeUndefined();
    expect(putGrantForTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1-tokens with `grant` — flag ON', () => {
  beforeEach(() => {
    isFlagOnMock.mockResolvedValue(true);
  });

  it('persists the grant against the minted token and returns the summary', async () => {
    const res = await postTokens({ name: 'AI key', scopes: ['sites:read'], grant: grantBody });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      grant: { siteCount: number; actionCount: number; revision: number };
      plaintext: string;
    };
    expect(putGrantForTokenMock).toHaveBeenCalledTimes(1);
    const [dbArg, tokenIdArg, orgIdArg, grantArg] = putGrantForTokenMock.mock.calls[0];
    expect(dbArg).toBe((env as { DB: unknown }).DB);
    expect(tokenIdArg).toBe('tok-1');
    expect(orgIdArg).toBe('org-1');
    expect(grantArg).toMatchObject({ siteIds: ['site-aaa'] });
    // Summary = counts, never the full snapshot arrays.
    expect(json.grant).toMatchObject({ siteCount: 1, actionCount: 1, revision: 1 });
    expect(JSON.stringify(json.grant)).not.toContain('site-aaa');
  });

  it('400s with per-field issues on an invalid grant and mints NO token', async () => {
    const res = await postTokens({
      name: 'AI key',
      scopes: ['sites:read'],
      grant: { ...grantBody, siteIds: ['*'], expiresAt: 'whenever' },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { code: string; issues?: Array<{ path: string; message: string }> };
    };
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.issues?.length).toBeGreaterThanOrEqual(1);
    expect(createApiTokenMock).not.toHaveBeenCalled();
    expect(putGrantForTokenMock).not.toHaveBeenCalled();
  });

  it('revokes the just-minted token when grant persistence fails (no orphan token)', async () => {
    putGrantForTokenMock.mockRejectedValue(new Error('D1 down'));
    const res = await postTokens({ name: 'AI key', scopes: ['sites:read'], grant: grantBody });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(revokeApiTokenMock).toHaveBeenCalledWith((env as { DB: unknown }).DB, 'org-1', 'tok-1');
  });
});

describe('GET /api/v1-tokens — grant summaries in list responses', () => {
  const listApiTokensMock = jest.requireMock('../services/api_tokens.js')
    .listApiTokens as jest.Mock;

  beforeEach(() => {
    listApiTokensMock.mockResolvedValue([
      { id: 'tok-1', org_id: 'org-1', name: 'AI key', scopes: ['sites:read'], created_at: 'now' },
      { id: 'tok-2', org_id: 'org-1', name: 'plain', scopes: ['sites:read'], created_at: 'now' },
    ]);
  });

  it('flag ON → tokens with a grant carry the summary; others carry none', async () => {
    isFlagOnMock.mockResolvedValue(true);
    listGrantsForOrgMock.mockResolvedValue([{ tokenId: 'tok-1', grant: persistedGrant }]);

    const res = await buildApp().request('/api/v1-tokens', {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ id: string; grant?: { siteCount: number } }>;
    };
    expect(json.data[0].grant).toMatchObject({ siteCount: 1, revision: 1 });
    expect(json.data[1].grant).toBeUndefined();
    expect(listGrantsForOrgMock).toHaveBeenCalledWith((env as { DB: unknown }).DB, 'org-1');
  });

  it('flag OFF → list shape unchanged and grant store is never read', async () => {
    const res = await buildApp().request('/api/v1-tokens', {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(2);
    expect(json.data.every((t) => !('grant' in t))).toBe(true);
    expect(listGrantsForOrgMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1-tokens/:id — grant lifecycle follows the token', () => {
  it('revokes the attached grant when the token is revoked', async () => {
    const res = await buildApp().request('/api/v1-tokens/tok-1', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(revokeGrantMock).toHaveBeenCalledWith((env as { DB: unknown }).DB, 'org-1', 'tok-1');
  });
});
