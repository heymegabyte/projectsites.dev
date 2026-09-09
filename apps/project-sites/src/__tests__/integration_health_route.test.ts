/**
 * @module __tests__/integration_health_route
 * @description Regression tests for the integration-health probes.
 *
 * Guards the display-vs-source-of-truth bug fixed 2026-08-08: the aggregate
 * `GET /api/integrations/health` had its OWN degraded switch that fell to a
 * `default: unconfigured` branch, so live configured services (deepgram,
 * langfuse, payload) reported `unknown` in the aggregate while the per-service
 * endpoint reported them configured. Both now share `buildSignal`, so the two
 * can never diverge. These tests assert that invariant directly.
 */

// listmonk + twenty do LIVE fetches — mock the listmonk client + global fetch so
// the tests are hermetic and focus on the config-only aggregate regression.
jest.mock('../services/listmonk_client.js', () => ({
  listmonkHealth: jest.fn(async () => ({ ok: true })),
}));

import { integrationHealth, buildSignal } from '../routes/integration_health.js';
import type { Env } from '../types/env.js';

/** A mock env with every config-only integration secret PRESENT. */
function configuredEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    LISTMONK_PASSWORD: 'lm-token',
    LISTMONK_API_URL: 'https://mail.example.test',
    LISTMONK_USERNAME: 'projectsites',
    TWENTY_API_KEY: 'tw-key',
    TWENTY_API_URL: 'https://crm.example.test',
    STRIPE_SECRET_KEY: 'sk_test_x',
    DEEPGRAM_API_KEY: 'dg_x',
    LAGO_API_KEY: 'lago_x',
    LANGFUSE_PUBLIC_KEY: 'pk_x',
    PAYLOAD_API_URL: 'https://cms.example.test',
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  // twenty + listmonk do LIVE liveness probes (`${TWENTY_API_URL}/healthz`,
  // `${LISTMONK_API_URL}/health`) — return a 200 so the config-only aggregate is hermetic.
  global.fetch = jest.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

describe('buildSignal — config-only services reflect their secret presence', () => {
  // resend was REMOVED as a tracked integration (Brian directive 2026-09-09 — SES is
  // THE provider); it is no longer in CONFIG_ENV_KEY, so it's excluded here.
  for (const [name, envKey] of [
    ['stripe', 'STRIPE_SECRET_KEY'],
    ['deepgram', 'DEEPGRAM_API_KEY'],
    ['langfuse', 'LANGFUSE_PUBLIC_KEY'],
  ] as const) {
    it(`${name}: configured when ${envKey} is set, not-configured when unset`, async () => {
      const on = await buildSignal(name, configuredEnv());
      expect(on).not.toBe('removed');
      if (on !== 'removed') expect(on.isConfigured).toBe(true);

      const off = await buildSignal(name, configuredEnv({ [envKey]: undefined }));
      expect(off).not.toBe('removed');
      if (off !== 'removed') expect(off.isConfigured).toBe(false);
    });
  }

  it('fully-purged services are no longer tombstoned (REMOVED facility empty)', async () => {
    // nango/inngest/postiz/lago/unkey were fully purged — a probe for one is now
    // UNKNOWN (404 at the route), never the 'removed' 410 sentinel. No live
    // integration is a tombstone.
    for (const name of ['nango', 'inngest', 'postiz', 'lago', 'unkey']) {
      expect(await buildSignal(name, configuredEnv())).not.toBe('removed');
    }
  });

  it('payload is LIVE-probed (public liveness), not config-presence', async () => {
    // payload (cms.projectsites.dev) is a CF Container with a public /healthz reachable from
    // the Worker → probed live, so it reports healthy + configured regardless of any secret.
    const on = await buildSignal('payload', configuredEnv());
    expect(on).not.toBe('removed');
    if (on !== 'removed') {
      expect(on.isConfigured).toBe(true);
      expect(on.lastCallOk).toBe(true); // beforeEach stubs fetch → 200
    }
    // still configured even with NO admin secret — liveness is not gated on config
    const off = await buildSignal('payload', configuredEnv({ PAYLOAD_API_URL: undefined }));
    expect(off).not.toBe('removed');
    if (off !== 'removed') expect(off.isConfigured).toBe(true);
  });
});

describe('buildSignal — cold-start retry for hibernating CF containers', () => {
  // CF Containers (mail/crm/cms) hibernate after ~30m idle. The FIRST liveness probe
  // hits them COLD and the container boot can exceed PROBE_TIMEOUT_MS, so a
  // healthy-but-sleeping service was mis-reported as `failing` — a lying-status false
  // alarm (the reverse of the authed-endpoint-403 lying-status the earlier arc killed).
  // The probe now retries ONCE: the first attempt triggers the boot, the patient retry
  // lands warm. Live-proven 2026-08-08 (mail/health + cms/healthz both 200 in <300ms
  // yet the aggregate showed them `failing` until warmed).
  it('payload: 1st probe fails (cold boot), 2nd succeeds → healthy, not a false failing', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('The operation was aborted due to timeout');
      return new Response('{"status":"ok","db":"up"}', { status: 200 });
    }) as unknown as typeof fetch;

    const sig = await buildSignal('payload', configuredEnv());
    expect(sig).not.toBe('removed');
    if (sig !== 'removed') {
      expect(sig.lastCallOk).toBe(true); // the retry caught the cold-start → healthy
      expect(sig.isConfigured).toBe(true);
    }
    expect(calls).toBe(2); // proves it retried rather than giving up on the cold hit
  });

  it('payload: BOTH probes fail → failing (the retry never MASKS a genuine outage)', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const sig = await buildSignal('payload', configuredEnv());
    expect(sig).not.toBe('removed');
    if (sig !== 'removed') expect(sig.lastCallOk).toBe(false); // deterministic honest failing
  });

  it('twenty: cold 502 on 1st probe, 200 on retry → healthy (non-2xx cold hit also retries)', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      // A container booting behind the CF edge can 502 before it is ready — the retry
      // must fire on a non-2xx cold hit too, not only on a thrown/aborted timeout.
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const sig = await buildSignal('twenty', configuredEnv());
    expect(sig).not.toBe('removed');
    if (sig !== 'removed') expect(sig.lastCallOk).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('GET /api/integrations/health — aggregate reflects real per-service status', () => {
  it('configured live services are NOT reported as unknown (the regression)', async () => {
    const res = await integrationHealth.request('/api/integrations/health', {}, configuredEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: Array<{ integration: string; status: string; configured: boolean }>;
    };
    const byName = new Map(body.integrations.map((i) => [i.integration, i]));

    for (const name of ['deepgram', 'langfuse', 'payload', 'stripe']) {
      const row = byName.get(name);
      expect(row).toBeDefined();
      // The bug: these read `unknown` (unconfigured default branch). Now configured.
      expect(row?.configured).toBe(true);
      expect(row?.status).not.toBe('unknown');
    }

    // Fully-purged services (nango/inngest/postiz/lago/unkey) are absent from
    // the aggregate entirely — they are no longer known integrations.
    expect(byName.has('nango')).toBe(false);
    expect(byName.has('unkey')).toBe(false);
  });

  it('aggregate status AGREES with the per-service endpoint (anti-drift)', async () => {
    const env = configuredEnv();
    const agg = (await (
      await integrationHealth.request('/api/integrations/health', {}, env)
    ).json()) as { integrations: Array<{ integration: string; status: string }> };
    const aggByName = new Map(agg.integrations.map((i) => [i.integration, i.status]));

    for (const name of ['deepgram', 'langfuse', 'payload', 'stripe']) {
      const perRes = await integrationHealth.request(`/api/integrations/${name}/health`, {}, env);
      expect(perRes.status).toBe(200);
      const per = (await perRes.json()) as { status: string };
      expect(per.status).toBe(aggByName.get(name));
    }
  });

  it('per-service endpoint returns 404 for a fully-purged service', async () => {
    // nango/inngest/postiz/lago/unkey were fully removed — a probe for one is
    // UNKNOWN now (404), not the transitional 410 Gone tombstone.
    const res = await integrationHealth.request(
      '/api/integrations/nango/health',
      {},
      configuredEnv(),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_integration');
  });
});
