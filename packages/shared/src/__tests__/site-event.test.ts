import { SiteEventSchema, siteEventActorSchema } from '../schemas/site-event';

const validEvent = {
  id: '0192f3a1-7a2b-7c4d-8e5f-0123456789ab', // UUIDv7
  type: 'site_published',
  ts: '2026-10-02T12:00:00.000Z',
  org: 'org_123',
  site: 'site_456',
  env: 'production' as const,
  actor: { kind: 'system' as const, id: 'deploy-worker' },
  source: 'site_generation_pipeline',
  correlationId: 'corr_789',
};

describe('siteEventActorSchema', () => {
  it('accepts a valid user actor', () => {
    expect(siteEventActorSchema.parse({ kind: 'user', id: 'user_1' })).toEqual({
      kind: 'user',
      id: 'user_1',
    });
  });

  it('accepts a valid system actor', () => {
    expect(siteEventActorSchema.parse({ kind: 'system', id: 'deploy-worker' })).toEqual({
      kind: 'system',
      id: 'deploy-worker',
    });
  });

  it('accepts a valid agent actor', () => {
    expect(siteEventActorSchema.parse({ kind: 'agent', id: 'orchestrator' })).toEqual({
      kind: 'agent',
      id: 'orchestrator',
    });
  });

  it('rejects an invalid kind', () => {
    expect(() => siteEventActorSchema.parse({ kind: 'robot', id: 'x' })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => siteEventActorSchema.parse({ kind: 'user', id: '' })).toThrow();
  });

  it('rejects unknown fields (.strict())', () => {
    expect(() => siteEventActorSchema.parse({ kind: 'user', id: 'u1', extra: true })).toThrow();
  });
});

describe('SiteEventSchema', () => {
  it('parses a fully-specified valid event', () => {
    const parsed = SiteEventSchema.parse(validEvent);
    expect(parsed.id).toBe(validEvent.id);
    expect(parsed.type).toBe('site_published');
    expect(parsed.org).toBe('org_123');
    expect(parsed.site).toBe('site_456');
    expect(parsed.env).toBe('production');
    expect(parsed.actor).toEqual({ kind: 'system', id: 'deploy-worker' });
    expect(parsed.source).toBe('site_generation_pipeline');
    expect(parsed.correlationId).toBe('corr_789');
  });

  it('accepts a UUIDv7 id (version nibble 7)', () => {
    const parsed = SiteEventSchema.parse(validEvent);
    expect(parsed.id.split('-')[2]?.[0]).toBe('7');
  });

  it('accepts an optional causationId when provided', () => {
    const parsed = SiteEventSchema.parse({ ...validEvent, causationId: 'evt_parent_1' });
    expect(parsed.causationId).toBe('evt_parent_1');
  });

  it('defaults schemaVersion to 1 when omitted', () => {
    const parsed = SiteEventSchema.parse(validEvent);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('defaults privacy to "internal" when omitted', () => {
    const parsed = SiteEventSchema.parse(validEvent);
    expect(parsed.privacy).toBe('internal');
  });

  it('accepts an explicit schemaVersion and privacy override', () => {
    const parsed = SiteEventSchema.parse({ ...validEvent, schemaVersion: 2, privacy: 'sensitive' });
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.privacy).toBe('sensitive');
  });

  it('accepts env "preview"', () => {
    const parsed = SiteEventSchema.parse({ ...validEvent, env: 'preview' });
    expect(parsed.env).toBe('preview');
  });

  it('rejects a bad env value', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, env: 'staging' })).toThrow();
  });

  it('rejects a missing org', () => {
    const { org, ...withoutOrg } = validEvent;
    expect(() => SiteEventSchema.parse(withoutOrg)).toThrow();
  });

  it('rejects an empty org string', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, org: '' })).toThrow();
  });

  it('rejects a missing site', () => {
    const { site, ...withoutSite } = validEvent;
    expect(() => SiteEventSchema.parse(withoutSite)).toThrow();
  });

  it('rejects a non-UUID id', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects a non-ISO ts', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, ts: '10/02/2026' })).toThrow();
  });

  it('rejects an empty type', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, type: '' })).toThrow();
  });

  it('rejects an invalid actor', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, actor: { kind: 'robot', id: 'x' } })).toThrow();
  });

  it('rejects an invalid privacy value', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, privacy: 'top-secret' })).toThrow();
  });

  it('rejects unknown top-level fields (.strict())', () => {
    expect(() => SiteEventSchema.parse({ ...validEvent, unexpectedField: 'oops' })).toThrow();
  });

  it('rejects null/undefined', () => {
    expect(() => SiteEventSchema.parse(null)).toThrow();
    expect(() => SiteEventSchema.parse(undefined)).toThrow();
  });
});
