/**
 * @module services/app_host_resolver
 * @description Phase 1 of the scale-to-zero apps routing architecture
 * (`docs/architecture/scale-to-zero-apps-routing.md`).
 *
 * A KV-backed **host → app-instance** map so the Worker can resolve ANY hostname
 * (the default `{subdomain}.app.projectsites.dev` AND future customer CNAMEs like
 * `app.theirdomain.com`) to the owning `app_instances` row without a per-request
 * D1 query. Mirrors the `host:{hostname}` site-resolution cache in `site_serving`.
 *
 * Phase 1a (this module): the resolver + the map writers, wired on instance
 * create/delete so the map stays in sync. Phase 1b (next): `src/index.ts` reads
 * `resolveAppHost()` on the serving path so custom CNAMEs resolve.
 *
 * Durability: mappings are authoritative (written on create, cleared on delete),
 * so they are stored WITHOUT a TTL — unlike the 60s site cache, this is the
 * source of truth for custom-host → instance, not a cache in front of D1.
 */
import { z } from 'zod';

/** The KV-stored mapping for one app hostname. */
export const AppHostMappingSchema = z
  .object({
    instanceId: z.string().min(1),
    appSlug: z.string().min(1),
    orgId: z.string().min(1),
    subdomain: z.string().min(1),
    /** When set, this host was RENAMED — the serving path 301s to this new host (SEO-safe). */
    redirectTo: z.string().min(1).optional(),
  })
  .strict();

export type AppHostMapping = z.infer<typeof AppHostMappingSchema>;

/** Minimal env surface this service needs. */
type HostResolverEnv = { CACHE_KV: KVNamespace };

const APP_ROOT = '.app.projectsites.dev';

/**
 * The default platform hostname for an app instance.
 * @example defaultAppHostname('acme') // → 'acme.app.projectsites.dev'
 */
export function defaultAppHostname(subdomain: string): string {
  return `${subdomain.toLowerCase()}${APP_ROOT}`;
}

/**
 * KV key for a hostname's app mapping. Hostnames are lower-cased so resolution is
 * case-insensitive (DNS is).
 * @example appHostKey('Acme.App.ProjectSites.dev') // → 'apphost:acme.app.projectsites.dev'
 */
export function appHostKey(hostname: string): string {
  return `apphost:${hostname.toLowerCase()}`;
}

/**
 * Resolve a hostname to its app instance mapping, or `null` when unmapped.
 * Tolerates a malformed/legacy KV value by returning `null` (never throws).
 *
 * @param env - Worker env (needs `CACHE_KV`).
 * @param hostname - The request hostname (any case).
 * @returns The validated {@link AppHostMapping}, or `null`.
 * @example
 * const m = await resolveAppHost(env, 'acme.app.projectsites.dev');
 * if (m) return serveInstance(m.instanceId);
 */
export async function resolveAppHost(
  env: HostResolverEnv,
  hostname: string,
): Promise<AppHostMapping | null> {
  const raw = await env.CACHE_KV.get(appHostKey(hostname), 'json');
  if (!raw) return null;
  const parsed = AppHostMappingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Write/overwrite the mapping for a hostname (idempotent). Validates the mapping
 * before writing so a malformed entry can never land in KV.
 *
 * @throws {AppHostError} When the mapping fails schema validation.
 * @example
 * await setAppHost(env, defaultAppHostname('acme'),
 *   { instanceId, appSlug: 'umami', orgId, subdomain: 'acme' });
 */
export async function setAppHost(
  env: HostResolverEnv,
  hostname: string,
  mapping: AppHostMapping,
): Promise<void> {
  const parsed = AppHostMappingSchema.safeParse(mapping);
  if (!parsed.success) {
    throw new AppHostError(`Invalid app-host mapping for ${hostname}: ${parsed.error.message}`);
  }
  await env.CACHE_KV.put(appHostKey(hostname), JSON.stringify(parsed.data));
}

/**
 * Remove a hostname's mapping (on instance delete / custom-domain detach).
 * Idempotent — clearing an absent key is a no-op.
 */
export async function clearAppHost(env: HostResolverEnv, hostname: string): Promise<void> {
  await env.CACHE_KV.delete(appHostKey(hostname));
}

/** Typed error for invalid host-mapping writes. */
export class AppHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppHostError';
  }
}
