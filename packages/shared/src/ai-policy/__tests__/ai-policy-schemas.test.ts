/**
 * @module ai-policy/__tests__/ai-policy-schemas
 * @description Schema-boundary tests: capability id grammar, manifest
 * strictness/defaults, concrete-id (no-wildcard) grant snapshots, and the
 * principal schema + fail-closed resolver stub.
 */
import {
  CAPABILITY_ID_PATTERN,
  CapabilityManifestSchema,
  capabilityIdSchema,
  concreteIdSchema,
  parseCapabilityId,
} from '../capability.js';
import { GrantRecordSchema, grantLimitsSchema } from '../grant.js';
import { PrincipalResolutionNotImplementedError, PrincipalSchema, resolvePrincipal } from '../principal.js';

describe('capability id grammar', () => {
  it.each(['notion.page.create', 'projectsites.site.publish', 'workers_ai.text.generate'])(
    'accepts stable provider.resource.action id %s',
    (id) => {
      expect(capabilityIdSchema.parse(id)).toBe(id);
    },
  );

  it('accepts nested resource segments', () => {
    expect(capabilityIdSchema.parse('notion.database.page.create')).toBe('notion.database.page.create');
  });

  it.each([
    'Notion.page.create', // uppercase
    'notion.page', // only two segments
    'notion..create', // empty segment
    'notion.page.create.', // trailing dot
    'notion.page.create page', // whitespace
    'notion.page.*', // wildcard
    'notion.page.créate', // non-ascii
    '', // empty
  ])('rejects malformed id %j', (id) => {
    expect(capabilityIdSchema.safeParse(id).success).toBe(false);
    expect(CAPABILITY_ID_PATTERN.test(id)).toBe(false);
  });

  it('parseCapabilityId splits provider/resource/action (nested resource joins with dots)', () => {
    expect(parseCapabilityId('twilio.sms.send')).toEqual({
      provider: 'twilio',
      resource: 'sms',
      action: 'send',
    });
    expect(parseCapabilityId('notion.database.page.create')).toEqual({
      provider: 'notion',
      resource: 'database.page',
      action: 'create',
    });
    expect(() => parseCapabilityId('bad id')).toThrow();
  });
});

describe('CapabilityManifestSchema', () => {
  const valid = {
    id: 'projectsites.site.publish',
    kind: 'publish',
    description: 'Publish the selected site revision to production.',
    costClass: 'standard',
    idempotency: 'key-required',
    approval: 'required',
  };

  it('parses a valid manifest and defaults resourceRequirements to none/none/none', () => {
    const manifest = CapabilityManifestSchema.parse(valid);
    expect(manifest.resourceRequirements).toEqual({
      site: 'none',
      connection: 'none',
      model: 'none',
    });
  });

  it('rejects unknown keys (strict — typo safety on permission metadata)', () => {
    expect(CapabilityManifestSchema.safeParse({ ...valid, extra_permission: 'all' }).success).toBe(false);
  });

  it('rejects an empty description and invalid enum values', () => {
    expect(CapabilityManifestSchema.safeParse({ ...valid, description: '  ' }).success).toBe(false);
    expect(CapabilityManifestSchema.safeParse({ ...valid, kind: 'admin' }).success).toBe(false);
    expect(CapabilityManifestSchema.safeParse({ ...valid, costClass: 'free' }).success).toBe(false);
    expect(CapabilityManifestSchema.safeParse({ ...valid, approval: 'never' }).success).toBe(false);
  });
});

describe('GrantRecordSchema — concrete snapshots only', () => {
  const validGrant = {
    id: 'grant_01',
    principal: { kind: 'oauth_grant', refId: 'oauthg_01' },
    orgId: 'org_01',
    siteIds: ['site_a', 'site_b'],
    connectionIds: ['conn_1'],
    actionIds: ['notion.page.create'],
    modelIds: ['workers_ai.llama_3_3_70b'],
    revision: 1,
    expiresAt: '2027-01-01T00:00:00Z',
  };

  it('parses a valid record, defaulting limits {} and approvalPolicy follow_capability', () => {
    const grant = GrantRecordSchema.parse(validGrant);
    expect(grant.limits).toEqual({});
    expect(grant.approvalPolicy).toBe('follow_capability');
    expect(grant.revokedAt).toBeUndefined();
  });

  it('rejects wildcard ids in every snapshot array (concrete ids only)', () => {
    expect(GrantRecordSchema.safeParse({ ...validGrant, siteIds: ['*'] }).success).toBe(false);
    expect(GrantRecordSchema.safeParse({ ...validGrant, connectionIds: ['conn_*'] }).success).toBe(false);
    expect(GrantRecordSchema.safeParse({ ...validGrant, actionIds: ['notion.page.*'] }).success).toBe(false);
    expect(GrantRecordSchema.safeParse({ ...validGrant, modelIds: ['*'] }).success).toBe(false);
    expect(concreteIdSchema.safeParse('*').success).toBe(false);
  });

  it('rejects revision < 1, missing expiry, bad principal kind, and unknown keys', () => {
    expect(GrantRecordSchema.safeParse({ ...validGrant, revision: 0 }).success).toBe(false);
    const { expiresAt: _expiresAt, ...noExpiry } = validGrant;
    expect(GrantRecordSchema.safeParse(noExpiry).success).toBe(false);
    expect(
      GrantRecordSchema.safeParse({
        ...validGrant,
        principal: { kind: 'root', refId: 'x' },
      }).success,
    ).toBe(false);
    expect(GrantRecordSchema.safeParse({ ...validGrant, allowAll: true }).success).toBe(false);
  });

  it('grantLimitsSchema rejects non-positive limits', () => {
    expect(grantLimitsSchema.safeParse({ spendCents: 0 }).success).toBe(false);
    expect(grantLimitsSchema.safeParse({ rpm: -1 }).success).toBe(false);
    expect(grantLimitsSchema.safeParse({ concurrency: 1.5 }).success).toBe(false);
    expect(grantLimitsSchema.safeParse({ spendCents: 100, rpm: 5, concurrency: 1 }).success).toBe(true);
  });
});

describe('PrincipalSchema + resolver stub', () => {
  it('parses each of the four principal kinds with their kind-specific fields', () => {
    expect(
      PrincipalSchema.parse({
        kind: 'session',
        refId: 'sess_1',
        orgId: 'org_1',
        userId: 'user_1',
      }).kind,
    ).toBe('session');
    expect(PrincipalSchema.parse({ kind: 'api_key', refId: 'tok_1', orgId: 'org_1' }).kind).toBe('api_key');
    expect(
      PrincipalSchema.parse({
        kind: 'oauth_grant',
        refId: 'oauthg_1',
        orgId: 'org_1',
        clientId: 'client_1',
      }).kind,
    ).toBe('oauth_grant');
    expect(
      PrincipalSchema.parse({
        kind: 'site_agent',
        refId: 'agent_1',
        orgId: 'org_1',
        siteId: 'site_1',
      }).kind,
    ).toBe('site_agent');
  });

  it('rejects a session principal missing userId and a site_agent missing siteId', () => {
    expect(PrincipalSchema.safeParse({ kind: 'session', refId: 'sess_1', orgId: 'org_1' }).success).toBe(false);
    expect(PrincipalSchema.safeParse({ kind: 'site_agent', refId: 'agent_1', orgId: 'org_1' }).success).toBe(false);
  });

  it('resolvePrincipal stub fails CLOSED with NotImplemented (never mints a principal)', async () => {
    await expect(resolvePrincipal({ authorizationHeader: 'Bearer psk_x' })).rejects.toBeInstanceOf(
      PrincipalResolutionNotImplementedError,
    );
  });
});
