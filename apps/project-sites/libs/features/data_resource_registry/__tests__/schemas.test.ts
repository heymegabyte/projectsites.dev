/**
 * Unit tests for the Authoritative Resource Registry Zod schemas.
 *
 * Asserts the enums, the record/input/ref/binding shapes, the strict-mode rejection of a
 * client-smuggled CF id, and the discriminated resolved-ref union.
 */
import {
  BindingRecordSchema,
  ProvisioningMethodSchema,
  RecordResourceInputSchema,
  ResolvedResourceRefSchema,
  ResourceConceptSchema,
  ResourceEnvironmentSchema,
  ResourceKindSchema,
  ResourceRecordSchema,
  ResourceRefSchema,
  ResourceTenancySchema,
} from '../schemas.js';

describe('registry enums', () => {
  it('accepts every declared ResourceConcept + rejects unknown', () => {
    for (const c of [
      'account_resource',
      'wfp_namespace',
      'do_namespace',
      'vectorize_namespace',
      'binding',
    ]) {
      expect(ResourceConceptSchema.safeParse(c).success).toBe(true);
    }
    expect(ResourceConceptSchema.safeParse('random_thing').success).toBe(false);
  });

  it('accepts every declared ResourceKind + rejects unknown', () => {
    for (const k of [
      'd1',
      'kv',
      'r2',
      'durable_object',
      'workflow',
      'queue',
      'vectorize',
      'analytics_engine',
      'connection',
    ]) {
      expect(ResourceKindSchema.safeParse(k).success).toBe(true);
    }
    expect(ResourceKindSchema.safeParse('postgres').success).toBe(false);
  });

  it('Environment is exactly preview|production', () => {
    expect(ResourceEnvironmentSchema.safeParse('preview').success).toBe(true);
    expect(ResourceEnvironmentSchema.safeParse('production').success).toBe(true);
    expect(ResourceEnvironmentSchema.safeParse('staging').success).toBe(false);
  });

  it('Tenancy + ProvisioningMethod validate their members', () => {
    expect(ResourceTenancySchema.safeParse('dedicated').success).toBe(true);
    expect(ResourceTenancySchema.safeParse('shared_shim').success).toBe(true);
    expect(ResourceTenancySchema.safeParse('rented').success).toBe(false);
    expect(ProvisioningMethodSchema.safeParse('binding_only').success).toBe(true);
    expect(ProvisioningMethodSchema.safeParse('magic').success).toBe(false);
  });
});

describe('RecordResourceInputSchema', () => {
  it('applies defaults for environment/tenancy/lifecycle/method/policy/protection', () => {
    const parsed = RecordResourceInputSchema.parse({
      orgId: 'org_1',
      siteId: 'site_1',
      resourceConcept: 'account_resource',
      resourceKind: 'd1',
      resourceIdOrName: 'db-uuid-1',
    });
    expect(parsed.environment).toBe('production');
    expect(parsed.tenancy).toBe('dedicated');
    expect(parsed.lifecycleState).toBe('requested');
    expect(parsed.provisioningMethod).toBe('lazy');
    expect(parsed.accessPolicy).toBe('site_scoped');
    expect(parsed.deletionProtected).toBe(true);
  });

  it('rejects unknown keys (a client cannot smuggle cf_account_id / resourceId)', () => {
    const res = RecordResourceInputSchema.safeParse({
      orgId: 'org_1',
      siteId: 'site_1',
      resourceConcept: 'account_resource',
      resourceKind: 'd1',
      cfAccountId: 'attacker-account', // not an allowed input field
    });
    expect(res.success).toBe(false);
  });

  it('requires orgId + siteId', () => {
    expect(
      RecordResourceInputSchema.safeParse({
        resourceConcept: 'account_resource',
        resourceKind: 'd1',
      }).success,
    ).toBe(false);
  });
});

describe('ResourceRefSchema — the non-identifier selector', () => {
  it('accepts a bare { kind } and defaults environment to production', () => {
    const parsed = ResourceRefSchema.parse({ kind: 'kv' });
    expect(parsed.environment).toBe('production');
    expect(parsed.kind).toBe('kv');
  });

  it('accepts a binding-name / vectorize-namespace selector', () => {
    expect(
      ResourceRefSchema.safeParse({ kind: 'kv', bindingName: '__PS_KV' }).success,
    ).toBe(true);
    expect(
      ResourceRefSchema.safeParse({
        kind: 'vectorize',
        vectorizeNamespace: 'site_1',
      }).success,
    ).toBe(true);
  });

  it('REJECTS a client-supplied CF identifier (strict mode)', () => {
    // The whole point of §4: a caller may never name a CF id. `.strict()` rejects these.
    expect(
      ResourceRefSchema.safeParse({ kind: 'd1', resourceId: 'db-uuid-1' }).success,
    ).toBe(false);
    expect(
      ResourceRefSchema.safeParse({ kind: 'd1', databaseId: 'db-uuid-1' }).success,
    ).toBe(false);
    expect(
      ResourceRefSchema.safeParse({ kind: 'd1', accountId: 'acct-x' }).success,
    ).toBe(false);
  });
});

describe('BindingRecordSchema', () => {
  const base = {
    id: 'row_1',
    orgId: 'org_1',
    siteId: 'site_1',
    environment: 'production' as const,
    resourceKind: 'kv' as const,
    tenancy: 'dedicated' as const,
    cfAccountId: 'acct_1',
    lifecycleState: 'active' as const,
    provisioningMethod: 'binding_only' as const,
    accessPolicy: 'site_scoped' as const,
    deletionProtected: 1 as const,
    createdAt: '2026-09-27T00:00:00Z',
    updatedAt: '2026-09-27T00:00:00Z',
  };

  it('requires concept=binding + bindingName + userWorkerScript', () => {
    expect(
      BindingRecordSchema.safeParse({
        ...base,
        resourceConcept: 'binding',
        bindingName: '__PS_KV',
        userWorkerScript: 'site-site_1',
      }).success,
    ).toBe(true);
  });

  it('rejects a binding row missing its bindingName', () => {
    expect(
      BindingRecordSchema.safeParse({
        ...base,
        resourceConcept: 'binding',
        userWorkerScript: 'site-site_1',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-binding concept', () => {
    expect(
      BindingRecordSchema.safeParse({
        ...base,
        resourceConcept: 'account_resource',
        bindingName: '__PS_KV',
        userWorkerScript: 'site-site_1',
      }).success,
    ).toBe(false);
  });
});

describe('ResourceRecordSchema', () => {
  it('parses a full production D1 allocation row', () => {
    const rec = ResourceRecordSchema.parse({
      id: 'row_1',
      orgId: 'org_1',
      siteId: 'site_1',
      environment: 'production',
      resourceConcept: 'account_resource',
      resourceKind: 'd1',
      tenancy: 'dedicated',
      cfAccountId: 'acct_1',
      resourceIdOrName: 'db-uuid-1',
      lifecycleState: 'active',
      provisioningMethod: 'lazy',
      accessPolicy: 'no_direct',
      deletionProtected: 1,
      createdAt: '2026-09-27T00:00:00Z',
      updatedAt: '2026-09-27T00:00:00Z',
    });
    expect(rec.resourceIdOrName).toBe('db-uuid-1');
    expect(rec.accessPolicy).toBe('no_direct');
  });
});

describe('ResolvedResourceRefSchema (discriminated union)', () => {
  it('validates the success arm', () => {
    expect(
      ResolvedResourceRefSchema.safeParse({
        ok: true,
        resourceId: 'db-uuid-1',
        resourceKind: 'd1',
        environment: 'production',
        accountId: 'acct_1',
        registryRowId: 'row_1',
        accessPolicy: 'no_direct',
      }).success,
    ).toBe(true);
  });

  it('validates the failure arm with a typed reason', () => {
    expect(
      ResolvedResourceRefSchema.safeParse({ ok: false, reason: 'not_owned' }).success,
    ).toBe(true);
    expect(
      ResolvedResourceRefSchema.safeParse({ ok: false, reason: 'nope' }).success,
    ).toBe(false);
  });
});
