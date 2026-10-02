import {
  signedPayloadBase,
  buildSignatureHeader,
  nextRetryDelayMs,
  isDeliverySuccess,
  shouldRetry,
  validateEndpointInput,
  maskSecret,
  isSafeWebhookUrl,
  isSafeCrawlUrl,
  isSafePublicHost,
  planDeliveries,
  attemptDelivery,
  recordDelivery,
  listDeliveries,
  createWebhookEndpoint,
  listWebhookEndpoints,
  deleteWebhookEndpoint,
  MAX_DELIVERY_ATTEMPTS,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
} from '../services/outbound_webhooks.js';
import type { Env } from '../types/env.js';

/** Mock env with a valid 32-byte AES key so ai_crypto.encrypt round-trips, + a mock D1. */
function mockEnv(
  rows: Record<string, unknown>[],
  changes: number,
  captured: unknown[][] = [],
): Env {
  return {
    MCP_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString('base64'),
    DB: {
      prepare: (_sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({ results: rows }),
          run: async () => {
            captured.push(args);
            return { meta: { changes } };
          },
        }),
      }),
    },
  } as unknown as Env;
}

describe('outbound_webhooks signed payload', () => {
  it('binds the timestamp into the signed material (replay-safety)', () => {
    expect(signedPayloadBase('1700000000', '{"a":1}')).toBe('1700000000.{"a":1}');
  });

  it('formats the signature header Svix/Stripe-style', () => {
    expect(buildSignatureHeader('1700000000', 'abc123')).toBe('t=1700000000,v1=abc123');
  });
});

describe('outbound_webhooks retry schedule', () => {
  it('doubles the delay each attempt', () => {
    expect(nextRetryDelayMs(1)).toBe(BASE_RETRY_DELAY_MS);
    expect(nextRetryDelayMs(2)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(nextRetryDelayMs(3)).toBe(BASE_RETRY_DELAY_MS * 4);
    expect(nextRetryDelayMs(4)).toBe(BASE_RETRY_DELAY_MS * 8);
  });

  it('caps the delay at MAX_RETRY_DELAY_MS', () => {
    expect(nextRetryDelayMs(50)).toBe(MAX_RETRY_DELAY_MS);
  });
});

describe('outbound_webhooks delivery outcome', () => {
  it('treats 2xx as success', () => {
    expect(isDeliverySuccess(200)).toBe(true);
    expect(isDeliverySuccess(204)).toBe(true);
    expect(isDeliverySuccess(299)).toBe(true);
    expect(isDeliverySuccess(300)).toBe(false);
    expect(isDeliverySuccess(500)).toBe(false);
  });
});

describe('outbound_webhooks shouldRetry', () => {
  it('retries transient failures (network, 429, 5xx) within the attempt budget', () => {
    expect(shouldRetry(1, 0)).toBe(true); // network error
    expect(shouldRetry(1, 429)).toBe(true); // rate limited
    expect(shouldRetry(1, 500)).toBe(true);
    expect(shouldRetry(1, 503)).toBe(true);
  });

  it('never retries a delivered (2xx) response', () => {
    expect(shouldRetry(1, 200)).toBe(false);
    expect(shouldRetry(1, 204)).toBe(false);
  });

  it('never retries a permanent (non-429) 4xx', () => {
    expect(shouldRetry(1, 400)).toBe(false);
    expect(shouldRetry(1, 401)).toBe(false);
    expect(shouldRetry(1, 404)).toBe(false);
  });

  it('stops once the attempt budget is exhausted', () => {
    expect(shouldRetry(MAX_DELIVERY_ATTEMPTS, 500)).toBe(false);
    expect(shouldRetry(MAX_DELIVERY_ATTEMPTS - 1, 500)).toBe(true);
  });
});

describe('validateEndpointInput', () => {
  it('accepts an https url subscribed to allowlisted events', () => {
    expect(validateEndpointInput('https://hooks.example.com/x', ['site.published'])).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects a non-https url', () => {
    const r = validateEndpointInput('http://hooks.example.com', ['site.published']);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('https'))).toBe(true);
  });

  it('rejects an invalid url', () => {
    expect(validateEndpointInput('not a url', ['site.published']).ok).toBe(false);
  });

  it('requires at least one event and rejects unknown ones', () => {
    expect(validateEndpointInput('https://x.com', []).ok).toBe(false);
    const r = validateEndpointInput('https://x.com', ['site.published', 'bogus.event']);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Unknown event'))).toBe(true);
  });
});

describe('maskSecret', () => {
  it('shows only the last 4 chars', () => {
    expect(maskSecret('whsec_abcd1234')).toBe('••••1234');
    expect(maskSecret('xy')).toBe('••••');
  });
});

describe('isSafeWebhookUrl (SSRF guard)', () => {
  it('allows a public https host', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/x')).toBe(true);
    expect(isSafeWebhookUrl('https://172.15.0.1/x')).toBe(true); // just outside the private 172.16-31 range
  });

  it('rejects non-https', () => {
    expect(isSafeWebhookUrl('http://hooks.example.com')).toBe(false);
  });

  it('rejects localhost + .local + .localhost', () => {
    expect(isSafeWebhookUrl('https://localhost/x')).toBe(false);
    expect(isSafeWebhookUrl('https://printer.local/x')).toBe(false);
    expect(isSafeWebhookUrl('https://api.localhost/x')).toBe(false);
  });

  it('rejects private + reserved IPv4 literals', () => {
    for (const h of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(isSafeWebhookUrl(`https://${h}/x`)).toBe(false);
    }
  });

  it('rejects the cloud metadata endpoint', () => {
    expect(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('rejects IPv6 loopback / link-local / ULA', () => {
    expect(isSafeWebhookUrl('https://[::1]/x')).toBe(false);
    expect(isSafeWebhookUrl('https://[fe80::1]/x')).toBe(false);
    expect(isSafeWebhookUrl('https://[fd00::1]/x')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 (SSRF bypass of the dotted-quad checks)', () => {
    // [::ffff:127.0.0.1] normalizes to ::ffff:7f00:1 → would reach loopback;
    // [::ffff:169.254.169.254] → cloud metadata. Both must be rejected.
    expect(isSafeWebhookUrl('https://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isSafeWebhookUrl('https://[::ffff:10.0.0.1]/x')).toBe(false);
    expect(isSafeWebhookUrl('https://[::ffff:169.254.169.254]/latest/meta-data')).toBe(false);
    expect(isSafeWebhookUrl('https://[::]/x')).toBe(false); // unspecified address
  });

  it('rejects an invalid url', () => {
    expect(isSafeWebhookUrl('not a url')).toBe(false);
  });

  it('does NOT reject a public host merely because it starts with fc/fd (not an IPv6 literal)', () => {
    // The ULA prefix check must only fire on IPv6 literals (contain ':'), never
    // on a dotted hostname like fcbarcelona.com — that was an over-broad reject.
    expect(isSafeWebhookUrl('https://fcbarcelona.com/x')).toBe(true);
    expect(isSafeWebhookUrl('https://fd-store.example.com/x')).toBe(true);
  });
});

describe('isSafeCrawlUrl (SSRF guard for the build crawler — #31)', () => {
  it('allows BOTH http and https public hosts (legacy source sites are often http)', () => {
    expect(isSafeCrawlUrl('https://example.com/')).toBe(true);
    expect(isSafeCrawlUrl('http://example.com/about')).toBe(true); // http allowed (unlike webhook guard)
    expect(isSafeCrawlUrl('http://172.15.0.1/x')).toBe(true); // just outside private 172.16-31
  });

  it('rejects non-http(s) schemes', () => {
    expect(isSafeCrawlUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeCrawlUrl('ftp://example.com/x')).toBe(false);
    expect(isSafeCrawlUrl('gopher://example.com/x')).toBe(false);
    expect(isSafeCrawlUrl('data:text/html,hi')).toBe(false);
  });

  it('rejects internal / private / metadata targets over http too', () => {
    for (const u of [
      'http://localhost/x',
      'http://printer.local/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data', // cloud metadata, the classic crawler SSRF
      'http://[::1]/x',
      'http://[::ffff:169.254.169.254]/x',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      expect(isSafeCrawlUrl(u)).toBe(false);
    }
  });

  it('rejects an invalid url', () => {
    expect(isSafeCrawlUrl('not a url')).toBe(false);
    expect(isSafeCrawlUrl('')).toBe(false);
  });
});

describe('isSafePublicHost (shared host blocklist)', () => {
  it('passes public hosts, blocks internal ones', () => {
    expect(isSafePublicHost('example.com')).toBe(true);
    expect(isSafePublicHost('172.15.0.1')).toBe(true);
    expect(isSafePublicHost('localhost')).toBe(false);
    expect(isSafePublicHost('169.254.169.254')).toBe(false);
    expect(isSafePublicHost('[::1]')).toBe(false); // brackets stripped
    expect(isSafePublicHost('')).toBe(false);
  });
});

describe('createWebhookEndpoint', () => {
  it('encrypts the secret and inserts; returns the plaintext secret once', async () => {
    const captured: unknown[][] = [];
    const res = await createWebhookEndpoint(
      mockEnv([], 1, captured),
      'o1',
      's1',
      'https://hooks.example.com/x',
      ['site.published'],
    );
    expect(res.ok).toBe(true);
    expect(res.secret).toMatch(/^whsec_/);
    // bind: [id, site_id, org_id, url, secret_encrypted, event_types]
    expect(captured[0]?.[2]).toBe('o1');
    expect(captured[0]?.[3]).toBe('https://hooks.example.com/x');
    expect(captured[0]?.[4]).not.toBe(res.secret); // stored value is the AES blob, not the plaintext
    expect(JSON.parse(captured[0]?.[5] as string)).toEqual(['site.published']);
  });

  it('rejects an invalid subscription without inserting', async () => {
    const captured: unknown[][] = [];
    const res = await createWebhookEndpoint(
      mockEnv([], 1, captured),
      'o1',
      's1',
      'http://insecure',
      ['site.published'],
    );
    expect(res.ok).toBe(false);
    expect(captured.length).toBe(0);
  });
});

describe('listWebhookEndpoints', () => {
  it('parses event_types and never returns a secret', async () => {
    const env = mockEnv(
      [{ id: 'e1', url: 'https://x.com', event_types: '["form.submitted"]', enabled: 1 }],
      0,
    );
    const list = await listWebhookEndpoints(env, 'o1', 's1');
    expect(list).toEqual([
      { id: 'e1', url: 'https://x.com', eventTypes: ['form.submitted'], enabled: true },
    ]);
    expect(JSON.stringify(list)).not.toContain('secret');
  });
});

describe('deleteWebhookEndpoint', () => {
  it('reports ok/not-ok by rows changed', async () => {
    expect(await deleteWebhookEndpoint(mockEnv([], 1), 'o1', 's1', 'e1')).toEqual({ ok: true });
    expect(await deleteWebhookEndpoint(mockEnv([], 0), 'o1', 's1', 'missing')).toEqual({
      ok: false,
    });
  });
});

describe('planDeliveries', () => {
  const TS = '1700000000';
  const ev = { type: 'site.published', payload: { siteId: 's1' } };
  const base = (
    over: Partial<{ id: string; url: string; eventTypes: string[]; enabled: boolean }> = {},
  ) => ({
    id: 'e1',
    url: 'https://hooks.example.com/x',
    eventTypes: ['site.published'],
    enabled: true,
    ...over,
  });

  it('plans a delivery for an enabled, subscribed, safe endpoint', () => {
    const plan = planDeliveries(ev, [base()], TS);
    expect(plan.deliveries.length).toBe(1);
    const d = plan.deliveries[0]!;
    expect(d.endpointId).toBe('e1');
    expect(d.timestamp).toBe(TS);
    expect(d.signatureBase).toBe(signedPayloadBase(TS, d.body));
    expect(JSON.parse(d.body)).toEqual({
      type: 'site.published',
      payload: { siteId: 's1' },
      timestamp: TS,
    });
  });

  it('skips disabled / not-subscribed / unsafe-url endpoints with reasons', () => {
    const plan = planDeliveries(
      ev,
      [
        base({ id: 'off', enabled: false }),
        base({ id: 'other', eventTypes: ['form.submitted'] }),
        base({ id: 'ssrf', url: 'https://127.0.0.1/x' }),
        base({ id: 'ok' }),
      ],
      TS,
    );
    expect(plan.deliveries.map((d) => d.endpointId)).toEqual(['ok']);
    expect(plan.skipped).toEqual([
      { endpointId: 'off', reason: 'disabled' },
      { endpointId: 'other', reason: 'not_subscribed' },
      { endpointId: 'ssrf', reason: 'unsafe_url' },
    ]);
  });
});

describe('attemptDelivery', () => {
  const delivery = {
    endpointId: 'e1',
    url: 'https://hooks.example.com/x',
    body: '{"type":"site.published"}',
    timestamp: '1700000000',
    signatureBase: '1700000000.{"type":"site.published"}',
  };

  it('POSTs the signed payload and maps a 2xx to ok', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;

    const res = await attemptDelivery(fetchFn, delivery, 'sigabc');
    expect(res).toEqual({ statusCode: 200, ok: true });
    const [url, init] = calls[0]!;
    expect(url).toBe(delivery.url);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(delivery.body);
    expect((init.headers as Record<string, string>)['webhook-signature']).toBe(
      't=1700000000,v1=sigabc',
    );
    expect((init.headers as Record<string, string>)['webhook-timestamp']).toBe('1700000000');
  });

  it('maps a 5xx to not-ok', async () => {
    const fetchFn = (async () => ({ status: 503 }) as Response) as unknown as typeof fetch;
    expect((await attemptDelivery(fetchFn, delivery, 'x')).ok).toBe(false);
  });

  it('refuses an unsafe url at fetch time without calling fetch', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    const res = await attemptDelivery(fetchFn, { ...delivery, url: 'https://127.0.0.1/x' }, 'x');
    expect(res).toEqual({ statusCode: 0, ok: false, error: 'unsafe_url' });
    expect(called).toBe(false);
  });

  it('maps a thrown fetch to a network_error', async () => {
    const fetchFn = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await attemptDelivery(fetchFn, delivery, 'x')).toEqual({
      statusCode: 0,
      ok: false,
      error: 'network_error',
    });
  });

  // CWE-918 blind-SSRF via redirect: a registered (safe) https endpoint that 302-redirects
  // to an internal host must NOT cause the Worker to POST there. The seed-URL check passes;
  // the protection must re-validate on EVERY redirect hop (safeFetch, redirect:'manual').
  it('fails CLOSED when a safe endpoint 302-redirects to cloud metadata (169.254.169.254)', async () => {
    const posted: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      posted.push(url);
      // The registered (safe) URL answers with a 302 Location to the metadata host.
      if (url === delivery.url) {
        return {
          status: 302,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) },
        } as unknown as Response;
      }
      // If the guard were broken we'd reach here and happily "deliver" a 2xx.
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await attemptDelivery(fetchFn, delivery, 'sig');
    // Must be a blocked/unsafe outcome — NEVER a delivered 2xx.
    expect(res.ok).toBe(false);
    expect(res.statusCode).not.toBeGreaterThanOrEqual(200);
    expect(res.error).toBe('unsafe_url');
    // No POST ever reached the metadata host.
    expect(posted).not.toContain('http://169.254.169.254/latest/meta-data');
  });

  it('fails CLOSED when a safe endpoint 302-redirects to an RFC1918 host (10.0.0.5)', async () => {
    const posted: string[] = [];
    const fetchFn = (async (url: string) => {
      posted.push(url);
      if (url === delivery.url) {
        return {
          status: 302,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'http://10.0.0.5:6379/' : null) },
        } as unknown as Response;
      }
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await attemptDelivery(fetchFn, delivery, 'sig');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unsafe_url');
    expect(posted).not.toContain('http://10.0.0.5:6379/');
  });
});

describe('recordDelivery + listDeliveries', () => {
  it('inserts a delivery row mapping ok->1 and undefined error->null', async () => {
    const captured: unknown[][] = [];
    await recordDelivery(mockEnv([], 1, captured), {
      endpointId: 'e1',
      siteId: 's1',
      eventType: 'site.published',
      statusCode: 200,
      ok: true,
      attempt: 1,
    });
    // bind: [id, endpoint_id, site_id, event_type, status_code, ok, attempt, error]
    expect(captured[0]?.[1]).toBe('e1');
    expect(captured[0]?.[2]).toBe('s1');
    expect(captured[0]?.[5]).toBe(1); // ok -> 1
    expect(captured[0]?.[7]).toBeNull(); // no error
  });

  it('lists deliveries mapping ok 1->true (newest first per the query)', async () => {
    const env = mockEnv(
      [
        {
          id: 'd1',
          endpoint_id: 'e1',
          event_type: 'site.published',
          status_code: 503,
          ok: 0,
          attempt: 2,
          error: 'network_error',
          created_at: '2026-06-02T00:00:00Z',
        },
      ],
      0,
    );
    const list = await listDeliveries(env, 's1');
    expect(list.length).toBe(1);
    expect(list[0]).toEqual({
      id: 'd1',
      endpointId: 'e1',
      eventType: 'site.published',
      statusCode: 503,
      ok: false,
      attempt: 2,
      error: 'network_error',
      createdAt: '2026-06-02T00:00:00Z',
    });
  });
});
