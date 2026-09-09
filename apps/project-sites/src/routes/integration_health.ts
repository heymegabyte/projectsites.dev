/**
 * @module routes/integration_health
 * @description `GET /api/integrations/:name/health` — per-service health probe.
 *
 * Probes each configured integration (Listmonk, Twenty, Stripe, etc.) and
 * returns health signals using the pure scoring functions from
 * {@link ../services/integration_health.ts}. No auth required — this is a
 * lightweight operational endpoint.
 *
 * Both the per-service endpoint and the `/api/integrations/health` aggregate
 * build their signals through the SINGLE {@link buildSignal} function, so the
 * two can never diverge. (Historically the aggregate had its own degraded
 * switch that fell to a `default: unconfigured` branch and mis-reported live,
 * configured services — deepgram/langfuse/payload — as `unknown`, a
 * display-vs-source-of-truth divergence per rule verify-against-source-of-truth.)
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import {
  scoreConnectionHealth,
  aggregateConnectionHealth,
  type ConnectionSignal,
} from '../services/integration_health.js';
import { listmonkHealth, type ListmonkConfig } from '../services/listmonk_client.js';

const integrationHealth = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Known integration names — kept in lockstep with ADR-0034 live services. */
const KNOWN_INTEGRATIONS = new Set([
  'listmonk', // CF Container — mail.projectsites.dev
  'twenty', // CF Container — crm.projectsites.dev
  'stripe', // Managed SaaS — billing
  'deepgram', // Managed SaaS — STT
  'langfuse', // CF Container — traces.projectsites.dev
  'payload', // CF Container — cms.projectsites.dev
  'resend', // Deprecated → SES (ADR-0019); still config-probed until migration completes
]);

/**
 * Fully-decommissioned integrations — a probe for one of these returns 410 Gone.
 * Currently EMPTY: every prior removal has been fully purged, so a probe for a
 * decommissioned service is simply UNKNOWN now (404). Add an id here to tombstone
 * a FUTURE decommission with an explicit 410 Gone during its sunset window.
 */
const REMOVED_INTEGRATIONS = new Set<string>([]);

/**
 * Per-probe network timeout (ms). A health endpoint must never hang the aggregate
 * (`GET /api/integrations/health`, which the System Services admin page reads) on a
 * single down dependency — bound each LIVE probe (listmonk + twenty) so a hung
 * mail/crm host degrades to `failing` within the budget instead of stalling the
 * whole response. Matches the codebase idiom (cf_registrar / rdap / redis_failover).
 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Patient retry budget (ms) for a probe's SECOND attempt. CF Containers
 * (mail/crm/cms) hibernate after ~30m idle; the first probe hits them cold and
 * its boot can exceed {@link PROBE_TIMEOUT_MS}. The first attempt TRIGGERS the
 * boot; this longer budget lets the retry land after the container has woken,
 * so a healthy-but-sleeping service is never mis-reported as `failing`.
 */
const COLD_START_TIMEOUT_MS = 12_000;

/**
 * Env-var whose presence marks a config-only integration as "configured".
 * listmonk + twenty are probed with a LIVE fetch instead (see {@link buildSignal}).
 */
const CONFIG_ENV_KEY: Readonly<Record<string, string>> = {
  stripe: 'STRIPE_SECRET_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  langfuse: 'LANGFUSE_PUBLIC_KEY',
};

/**
 * Platform services (CF Containers) with a PUBLIC liveness endpoint (no auth) — probed
 * LIVE like listmonk/twenty. Reports `healthy` when the endpoint 200s, `failing` when
 * down, instead of a misleading `unknown` from a config-presence check. Only services
 * whose health path is reachable FROM THE WORKER belong here — NOT `api.projectsites.dev`
 * (its `/api/health` is the main worker's own health → a self-subrequest loop that fails).
 */
const LIVENESS_URL: Readonly<Record<string, string>> = {
  payload: 'https://cms.projectsites.dev/healthz',
};

/**
 * Build a Listmonk config from Worker env vars.
 */
function listmonkCfg(env: Env): ListmonkConfig {
  return {
    baseUrl: env.LISTMONK_API_URL ?? 'https://mail.projectsites.dev',
    apiUser: env.LISTMONK_USERNAME ?? 'projectsites',
    apiToken: env.LISTMONK_PASSWORD ?? '',
  };
}

/**
 * Fetch a liveness endpoint with a single COLD-START retry.
 *
 * CF Containers hibernate after ~30m idle, so the first probe of an idle service
 * hits it cold — the boot can exceed {@link PROBE_TIMEOUT_MS} (timeout) or briefly
 * 502 behind the edge. Either way the first attempt TRIGGERS the boot; one patient
 * retry ({@link COLD_START_TIMEOUT_MS}) then lands on the now-warm container. A
 * genuinely-down service fails BOTH attempts → deterministic `failing`, never masked.
 * (Live-proven 2026-08-08: mail/health + cms/healthz both 200 in <300ms while the
 * aggregate reported them `failing` — the single 4s probe gave up on the cold boot.)
 *
 * @param input - the health URL to probe
 * @param init - optional fetch init (the AbortSignal is supplied here per-attempt)
 * @returns the 2xx Response from either attempt, else the last (non-2xx) Response
 * @throws only when BOTH attempts throw — callers already catch → `failing`
 */
async function fetchWithColdStartRetry(input: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) return res;
    // Non-2xx on the cold hit (e.g. a 502 while the container boots behind the edge)
    // — fall through to one patient retry now that the boot has been triggered.
  } catch {
    // Timeout/network on the cold hit — the attempt started the boot; retry patiently.
  }
  return fetch(input, { ...init, signal: AbortSignal.timeout(COLD_START_TIMEOUT_MS) });
}

/**
 * Probe a PUBLIC liveness endpoint (no auth) and score it. A 200 → healthy; any other
 * outcome (non-2xx, or a thrown/aborted fetch) → failing. Bounded by {@link PROBE_TIMEOUT_MS}
 * plus one {@link COLD_START_TIMEOUT_MS} cold-start retry via {@link fetchWithColdStartRetry}.
 * Used for platform CF Containers that expose a health path (see {@link LIVENESS_URL}).
 *
 * @param provider - integration slug
 * @param url - the service's public health URL
 * @returns a {@link ConnectionSignal} — never throws
 */
async function probeLiveness(provider: string, url: string): Promise<ConnectionSignal> {
  let ok = false;
  try {
    const res = await fetchWithColdStartRetry(url);
    ok = res.ok;
  } catch {
    ok = false;
  }
  return {
    provider,
    lastStatus: ok ? 200 : 503,
    tokenValid: ok,
    lastCallOk: ok,
    daysSinceLastUse: 0,
    isConfigured: true,
  };
}

/**
 * Probe ONE integration and return its health {@link ConnectionSignal}.
 *
 * The single source of truth shared by BOTH the per-service endpoint and the
 * aggregate, so they can never report different statuses for the same service.
 *
 * - `listmonk` / `twenty` / `payload` → LIVE public-liveness probe.
 * - config-only services (stripe, deepgram, langfuse, resend) →
 *   presence of their {@link CONFIG_ENV_KEY} secret marks them configured.
 * - a decommissioned service in {@link REMOVED_INTEGRATIONS} (currently none) →
 *   the literal `'removed'`, which callers render as 410 Gone / `status: 'removed'`.
 *
 * @param name - lowercased integration name (must be in {@link KNOWN_INTEGRATIONS})
 * @param env - Worker env bindings
 * @returns the connection signal, or `'removed'` for decommissioned services
 */
async function buildSignal(name: string, env: Env): Promise<ConnectionSignal | 'removed'> {
  if (REMOVED_INTEGRATIONS.has(name)) return 'removed';

  // Platform CF Containers with a public liveness endpoint → LIVE probe (like listmonk/twenty).
  const livenessUrl = LIVENESS_URL[name];
  if (livenessUrl) return probeLiveness(name, livenessUrl);

  switch (name) {
    case 'listmonk': {
      const cfg = listmonkCfg(env);
      // Bound the probe via listmonkHealth's DI seam — a cold-start-retrying fetch so a
      // hung OR hibernating mail.projectsites.dev can't stall OR falsely-fail the aggregate.
      // listmonkHealth catches a final AbortError and returns { ok: false } → `failing`.
      const result = await listmonkHealth(cfg, (input, init) =>
        fetchWithColdStartRetry(String(input), init),
      );
      return {
        provider: 'listmonk',
        lastStatus: result.ok ? 200 : 503,
        // listmonk is a self-hosted PLATFORM service — its health is the public
        // /health probe, not gated on the admin API token. Present iff baseUrl set;
        // `tokenValid` reflects the live probe (there is no token in a public check).
        tokenValid: result.ok,
        lastCallOk: result.ok,
        daysSinceLastUse: 0,
        isConfigured: Boolean(cfg.baseUrl),
      };
    }
    case 'twenty': {
      const configured = Boolean(env.TWENTY_API_KEY && env.TWENTY_API_URL);
      if (!configured) {
        return {
          provider: 'twenty',
          lastStatus: 0,
          tokenValid: false,
          lastCallOk: false,
          daysSinceLastUse: 0,
          isConfigured: false,
        };
      }
      try {
        // Probe twenty's PUBLIC /healthz liveness endpoint (200, no auth) — NOT the
        // authed /rest/companies, which 403s ("WWW-Authenticate") for the platform
        // probe's token and mis-reported a LIVE twenty CRM as failing. Cold-start retry
        // covers crm.projectsites.dev's ~30m-idle hibernation the same way.
        const res = await fetchWithColdStartRetry(`${env.TWENTY_API_URL}/healthz`);
        return {
          provider: 'twenty',
          lastStatus: res.status,
          tokenValid: true,
          lastCallOk: res.ok,
          daysSinceLastUse: 0,
          isConfigured: true,
        };
      } catch {
        return {
          provider: 'twenty',
          lastStatus: 503,
          tokenValid: true,
          lastCallOk: false,
          daysSinceLastUse: 0,
          isConfigured: true,
        };
      }
    }
    default: {
      // Config-presence probe: the service is "configured" iff its secret is set.
      const key = CONFIG_ENV_KEY[name];
      const configured = key ? Boolean((env as unknown as Record<string, unknown>)[key]) : false;
      return {
        provider: name,
        lastStatus: 0,
        tokenValid: configured,
        lastCallOk: configured,
        daysSinceLastUse: 0,
        isConfigured: configured,
      };
    }
  }
}

/**
 * `GET /api/integrations/:name/health`
 *
 * Probes a named integration and returns health signals. Unknown names
 * return 404; decommissioned services return 410 Gone.
 *
 * Response: `{ integration, status, signals, timestamp }`
 */
integrationHealth.get('/api/integrations/:name/health', async (c) => {
  const name = c.req.param('name').toLowerCase();

  if (!KNOWN_INTEGRATIONS.has(name)) {
    return c.json(
      { error: 'unknown_integration', message: `No health probe defined for '${name}'` },
      404,
    );
  }

  const sig = await buildSignal(name, c.env);

  if (sig === 'removed') {
    return c.json(
      {
        integration: name,
        status: 'removed',
        message: `${name} was decommissioned per ADR-0034 (2026-07-27). See docs/decisions/0034-platform-consolidation-cf-native.md`,
        timestamp: new Date().toISOString(),
      },
      410,
    );
  }

  const signals: ConnectionSignal[] = [sig];
  const aggregate = aggregateConnectionHealth(signals);

  return c.json({
    integration: name,
    status: aggregate.overall,
    signals: signals.map((s) => ({
      provider: s.provider,
      health: scoreConnectionHealth(s),
      configured: s.isConfigured,
    })),
    timestamp: new Date().toISOString(),
  });
});

/**
 * `GET /api/integrations/health` — aggregate health across all known integrations.
 *
 * Returns a rolled-up status for every registered integration in one call.
 * Uses the SAME {@link buildSignal} probe as the per-service endpoint, so a
 * configured live service (deepgram/langfuse/payload) reports its real
 * status here — never a degraded `unknown` from a divergent code path.
 */
integrationHealth.get('/api/integrations/health', async (c) => {
  // Probe every integration CONCURRENTLY. Each live liveness probe (listmonk/twenty/
  // payload) can now spend up to PROBE_TIMEOUT_MS + COLD_START_TIMEOUT_MS on a cold
  // container; a sequential loop would SUM those (~48s worst case) and blow the admin
  // page's own fetch timeout. Promise.all bounds the aggregate to the SLOWEST single
  // probe while preserving order (map keeps index; removed/config-presence resolve
  // instantly, so only the cold live probes cost anything).
  const results = await Promise.all(
    [...KNOWN_INTEGRATIONS].map(async (name) => {
      const sig = await buildSignal(name, c.env);
      return sig === 'removed'
        ? { integration: name, status: 'removed', configured: false }
        : { integration: name, status: scoreConnectionHealth(sig), configured: sig.isConfigured };
    }),
  );

  return c.json({
    integrations: results,
    timestamp: new Date().toISOString(),
  });
});

export { integrationHealth, KNOWN_INTEGRATIONS, buildSignal };
