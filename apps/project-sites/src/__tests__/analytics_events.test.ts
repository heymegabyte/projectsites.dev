import {
  IncomingEventSchema,
  toPostHog,
  toGa4,
  toGtm,
  type IncomingEvent,
} from '../services/analytics_events';

const TS = 1_700_000_000_000; // fixed epoch ms

const base: IncomingEvent = {
  eventId: '123e4567-e89b-42d3-a456-426614174000',
  siteId: 'site-1',
  eventType: 'pageview',
  timestamp: TS,
  payload: { page: '/' },
};

describe('IncomingEventSchema', () => {
  it('accepts a valid UUID-keyed pageview', () => {
    expect(IncomingEventSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a 40-char SHA-1 eventId', () => {
    const sha = 'a'.repeat(40);
    expect(IncomingEventSchema.safeParse({ ...base, eventId: sha }).success).toBe(true);
  });

  it('rejects an eventId that is neither a UUID nor 40 chars', () => {
    expect(IncomingEventSchema.safeParse({ ...base, eventId: 'too-short' }).success).toBe(false);
  });

  it('rejects an unknown eventType', () => {
    expect(IncomingEventSchema.safeParse({ ...base, eventType: 'teleport' }).success).toBe(false);
  });

  it('accepts a web_vital CWV sample with {metric,value,href} payload (AN-CWV)', () => {
    const wv = {
      ...base,
      eventType: 'web_vital' as const,
      payload: { metric: 'LCP', value: 2500, href: '/pricing' },
    };
    expect(IncomingEventSchema.safeParse(wv).success).toBe(true);
  });

  it('accepts a js_error site-health event with {message,source,line} payload', () => {
    const err = {
      ...base,
      eventType: 'js_error' as const,
      payload: { message: "Cannot read properties of undefined (reading 'x')", source: '/assets/app.js', line: 42 },
    };
    expect(IncomingEventSchema.safeParse(err).success).toBe(true);
  });

  it('accepts a click-to-call/directions conversion event with kind+section payload (AN18 #60)', () => {
    const conv = {
      ...base,
      eventType: 'conversion' as const,
      payload: { kind: 'call', section: 'services', href: 'tel:+15551234567' },
    };
    const r = IncomingEventSchema.safeParse(conv);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payload).toMatchObject({ kind: 'call', section: 'services' });
  });

  it('rejects a non-positive timestamp', () => {
    expect(IncomingEventSchema.safeParse({ ...base, timestamp: 0 }).success).toBe(false);
  });

  it('rejects a sampleRate above 1', () => {
    expect(IncomingEventSchema.safeParse({ ...base, sampleRate: 1.5 }).success).toBe(false);
  });

  it('rejects a malformed ip', () => {
    expect(IncomingEventSchema.safeParse({ ...base, ip: '999.1.1.1' }).success).toBe(false);
  });
});

describe('toPostHog', () => {
  it('uses userId as distinct_id when present and ISO-formats the timestamp', () => {
    const out = toPostHog({ ...base, userId: 'u9' });
    expect(out.distinct_id).toBe('u9');
    expect(out.event).toBe('pageview');
    expect(out.properties).toMatchObject({ page: '/', siteId: 'site-1' });
    expect(out.timestamp).toBe(new Date(TS).toISOString());
  });

  it('falls back to sessionId then eventId for distinct_id', () => {
    expect(toPostHog({ ...base, sessionId: 's1' }).distinct_id).toBe('s1');
    expect(toPostHog(base).distinct_id).toBe(base.eventId);
  });
});

describe('toGa4', () => {
  it('uses the provided measurement id + gaClientId when set', () => {
    const out = toGa4({ ...base, gaClientId: 'GA1.2.x' }, 'G-ABC123');
    expect(out.measurement_id).toBe('G-ABC123');
    expect(out.client_id).toBe('GA1.2.x');
    expect(out.events[0]).toEqual({ name: 'pageview', params: { page: '/', site_id: 'site-1' } });
  });

  it('falls back to the distinct id for client_id when no gaClientId', () => {
    expect(toGa4({ ...base, userId: 'u9' }, 'G-ABC123').client_id).toBe('u9');
  });
});

describe('toGtm', () => {
  it('produces a dataLayer object with event + site_id + flattened payload', () => {
    expect(toGtm(base)).toEqual({ event: 'pageview', site_id: 'site-1', page: '/' });
  });
});
