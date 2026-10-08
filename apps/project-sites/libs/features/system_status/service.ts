/**
 * System Status service — aggregates health checks from all platform integrations.
 *
 * Each integration gets probed independently with a 5s timeout. Results are
 * never cached (real-time status strip). A single probe failure degrades the
 * integration to "degraded"; multiple failures → "down".
 *
 * @module libs/features/system_status/service
 */
import type { IntegrationStatus, SystemStatusResponse, HealthTarget } from './schemas.js';

/** All known integration health-check endpoints. */
export const INTEGRATION_TARGETS: HealthTarget[] = [
  { name: 'Listmonk', url: 'https://mail.projectsites.dev/api/health', category: 'email' },
  { name: 'LiteLLM', url: 'https://llm.megabyte.space/health', category: 'ai' },
  { name: 'Twenty CRM', url: 'https://crm.projectsites.dev/health', category: 'collab' },
  { name: 'Payload CMS', url: 'https://cms.projectsites.dev/api/health', category: 'infra' },
  { name: 'Chatwoot', url: 'https://chat.projectsites.dev/health', category: 'collab' },
];

/**
 * Probe a single integration health endpoint.
 * Returns status with latency measurement.
 */
async function probeOne(target: HealthTarget, fetchImpl: typeof fetch): Promise<IntegrationStatus> {
  const start = Date.now();
  // `controller` + `timeout` live OUTSIDE the try so the `finally` clears the abort
  // timer on BOTH paths. If `clearTimeout` sits only on the success line, a thrown/
  // rejected fetch (network error / AbortError) skips it and the 5s timer dangles as an
  // active handle until it fires — one per INTEGRATION_TARGET, per call. In the Jest
  // fleet that surfaces as the intermittent "A worker process has failed to exit
  // gracefully … Active timers … ensure .unref() was called" force-exit (the dangling
  // timers are still pending at process exit when this suite's reject-path tests land
  // late in the --runInBand run). Same fix as import_crawler/credit_monitor/external_llm.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    // target.url is ONLY ever a hardcoded platform-infra health endpoint from the
    // INTEGRATION_TARGETS const above — never user-influenced, so there is no SSRF
    // surface. These are first-party hosts (some resolve to private infra), so
    // safeFetch's public-host guard would wrongly block them; a plain fetch is correct.
    // safe-fetch-ok: fixed first-party INTEGRATION_TARGETS host, not user-influenced
    const res = await fetchImpl(target.url, { signal: controller.signal, redirect: 'follow' });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { name: target.name, url: target.url, status: 'healthy', latencyMs };
    }
    return {
      name: target.name,
      url: target.url,
      status: res.status >= 500 ? 'down' : 'degraded',
      latencyMs,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('abort') ? 'degraded' : 'down';
    return { name: target.name, url: target.url, status, latencyMs, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe all integrations in parallel and return an aggregated status.
 *
 * @param fetchImpl - Injectable fetch (defaults to global fetch). Allows
 *   deterministic testing without real network calls.
 */
export async function probeAll(
  fetchImpl: typeof fetch = fetch,
): Promise<SystemStatusResponse> {
  const results = await Promise.all(
    INTEGRATION_TARGETS.map((t) => probeOne(t, fetchImpl)),
  );

  const downCount = results.filter((r) => r.status === 'down').length;
  const degradedCount = results.filter((r) => r.status === 'degraded').length;

  let overall: SystemStatusResponse['overall'];
  if (downCount > 0) overall = 'down';
  else if (degradedCount > 0) overall = 'degraded';
  else overall = 'healthy';

  return {
    overall,
    checkedAt: new Date().toISOString(),
    integrations: results,
  };
}
