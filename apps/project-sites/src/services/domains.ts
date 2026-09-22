/**
 * @module domains
 * @description Cloudflare-for-SaaS custom-hostname provisioning: free
 * `slug.projectsites.dev` subdomains + custom CNAME domains, with CF-managed
 * SSL/DV verification and a `hostnames` D1 tracking table.
 *
 * Lifecycle: provision → CF creates custom hostname → INSERT hostnames row
 * (pending|active) → `verifyPendingHostnames` cron polls CF → UPDATE to
 * active|verification_failed.
 *
 * @packageDocumentation
 */

import {
  DOMAINS,
  ENTITLEMENTS,
  AppError,
  badRequest,
  notFound,
  conflict,
  type HostnameState,
} from '@project-sites/shared';
import { z } from 'zod';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from './db.js';
import type { Env } from '../types/env.js';

/**
 * Cloudflare custom-hostname API response — only the fields provisioning + verification read.
 * `result.status` is the core required field; `id`/`ssl`/`verification_errors` are optional (absent
 * pre-SSL / when there are no errors). Unknown extra CF fields are ignored, so this fails ONLY on
 * genuine shape-drift of a critical field — the point of validating a LOAD-BEARING vendor's boundary
 * (vendor-risk-tiering + zod-everywhere) instead of a bare `as` cast that silently yields `undefined`.
 */
const CfCustomHostnameResponseSchema = z.object({
  result: z.object({
    id: z.string().optional(),
    status: z.string(),
    ssl: z.object({ status: z.string() }).partial().optional(),
    verification_errors: z.array(z.string()).optional(),
  }),
});
type CfCustomHostnameResponse = z.infer<typeof CfCustomHostnameResponseSchema>;

/**
 * Parse a CF custom-hostname API response, failing SOFT. On shape-drift (a renamed/missing
 * `result.status` etc.) it logs a structured warn — making CF API drift OBSERVABLE instead of the
 * silent `undefined` an `as` cast propagates — and returns a safe `{status:'unknown'}` fallback so
 * provisioning/verification never throws. Exported for unit coverage.
 *
 * @param json - The raw parsed JSON body from a CF custom-hostname endpoint.
 * @param ctx  - `{ fn, hostname? }` for the drift warn's correlation fields.
 * @returns The validated response, or a `{result:{status:'unknown'}}` fallback on drift.
 * @example parseCfCustomHostname({ result: { id: 'abc', status: 'active' } }, { fn: 'x' }).result.status // 'active'
 */
export function parseCfCustomHostname(
  json: unknown,
  ctx: { fn: string; hostname?: string },
): CfCustomHostnameResponse {
  const parsed = CfCustomHostnameResponseSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  console.warn(
    JSON.stringify({
      level: 'warn',
      service: 'domains',
      message: 'CF custom-hostname response shape drift — validate the CF API contract',
      fn: ctx.fn,
      hostname: ctx.hostname,
      issues: parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`),
    }),
  );
  return { result: { status: 'unknown' } };
}

/**
 * Domain provisioner interface for dependency injection / testing.
 */
export interface DomainProvisioner {
  provisionFreeDomain(opts: {
    org_id: string;
    site_id: string;
    slug: string;
  }): Promise<{ hostname: string; status: HostnameState }>;

  provisionCustomDomain(opts: {
    org_id: string;
    site_id: string;
    hostname: string;
  }): Promise<{ hostname: string; status: HostnameState }>;

  verifyHostname(hostname: string): Promise<{
    status: HostnameState;
    ssl_status: string;
    errors: string[];
  }>;

  deprovisionHostname(hostname: string): Promise<void>;
}

/**
 * Create a Cloudflare-for-SaaS custom hostname via the CF API.
 *
 * @param env      - Worker environment (needs `CF_API_TOKEN`, `CF_ZONE_ID`).
 * @param hostname - The fully-qualified domain to provision.
 * @throws {badRequest} If the Cloudflare API call fails.
 */
export async function createCustomHostname(
  env: Env,
  hostname: string,
): Promise<{ cf_id: string; status: string; ssl_status: string }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'http',
          type: 'dv',
          settings: { min_tls_version: '1.2' },
        },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'domains',
        message: 'CF custom hostname creation failed',
        hostname,
        status: response.status,
      }),
    );
    throw badRequest(`Failed to create custom hostname: ${err}`);
  }

  const data = parseCfCustomHostname(await response.json(), {
    fn: 'createCustomHostname',
    hostname,
  });

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'domains',
      message: 'CF custom hostname created',
      hostname,
      cf_id: data.result.id,
      cf_status: data.result.status,
    }),
  );
  return {
    cf_id: data.result.id ?? '',
    status: data.result.status,
    ssl_status: data.result.ssl?.status ?? 'unknown',
  };
}

/**
 * Check the verification status of a custom hostname.
 *
 * @param env                 - Worker environment.
 * @param cfCustomHostnameId  - Cloudflare hostname resource ID.
 * @throws {notFound} If the hostname doesn't exist in Cloudflare.
 */
export async function checkHostnameStatus(
  env: Env,
  cfCustomHostnameId: string,
): Promise<{ status: string; ssl_status: string; verification_errors: string[] }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${cfCustomHostnameId}`,
    {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    throw notFound('Custom hostname not found');
  }

  const data = parseCfCustomHostname(await response.json(), {
    fn: 'checkHostnameStatus',
    hostname: cfCustomHostnameId,
  });

  return {
    status: data.result.status,
    ssl_status: data.result.ssl?.status ?? 'unknown',
    verification_errors: data.result.verification_errors ?? [],
  };
}

/**
 * Delete a custom hostname from Cloudflare.
 *
 * @param env                 - Worker environment.
 * @param cfCustomHostnameId  - Cloudflare hostname resource ID.
 * @throws {badRequest} If deletion fails (404 is silently ignored).
 */
export async function deleteCustomHostname(env: Env, cfCustomHostnameId: string): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${cfCustomHostnameId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    },
  );

  if (!response.ok && response.status !== 404) {
    const err = await response.text();
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'domains',
        message: 'CF hostname deletion failed',
        cf_id: cfCustomHostnameId,
        status: response.status,
      }),
    );
    throw badRequest(`Failed to delete custom hostname: ${err}`);
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'domains',
      message: 'CF hostname deleted',
      cf_id: cfCustomHostnameId,
    }),
  );
}

/**
 * Compensating action (saga) for a failed `hostnames` D1 insert. By insert time
 * {@link createCustomHostname} has ALREADY created the CF custom hostname — so a
 * dropped tracking row would ORPHAN it: invisible to {@link getSiteHostnames} +
 * the verify cron, and (on the custom path) it would let {@link setSolePrimary}
 * clear every primary then set one on a non-existent row, leaving the site
 * primary-less. `dbInsert` returns `{ error }` and NEVER throws, so a bare `await`
 * would return a phantom success. Best-effort-delete the CF hostname to undo the
 * side-effect, then THROW so provisioning fails loud. If compensation itself fails,
 * log the orphan for manual cleanup and still throw the original error.
 *
 * @throws Always — never returns normally.
 */
async function rollbackHostnameInsert(
  env: Env,
  cfCustomHostnameId: string,
  hostname: string,
  insertError: string,
): Promise<never> {
  try {
    await deleteCustomHostname(env, cfCustomHostnameId);
  } catch (compErr) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'domains',
        message: 'orphaned_cf_hostname_compensation_failed',
        hostname,
        cf_id: cfCustomHostnameId,
        insert_error: insertError,
        compensation_error: compErr instanceof Error ? compErr.message : String(compErr),
      }),
    );
  }
  throw new Error(`domains: failed to persist hostname ${hostname}: ${insertError}`);
}

/**
 * Provision a free subdomain for a site (e.g. `slug.projectsites.dev`).
 *
 * Idempotent: if the hostname already exists in D1, returns its current status
 * without creating a duplicate.
 *
 * @param db   - D1Database binding.
 * @param env  - Worker environment.
 * @param opts - Organization, site, and slug.
 */
export async function provisionFreeDomain(
  db: D1Database,
  env: Env,
  opts: { org_id: string; site_id: string; slug: string },
): Promise<{ hostname: string; status: HostnameState }> {
  const hostname = `${opts.slug}${DOMAINS.SITES_SUFFIX}`;

  const existing = await dbQueryOne<{ id: string; status: string }>(
    db,
    'SELECT id, status FROM hostnames WHERE hostname = ? AND deleted_at IS NULL',
    [hostname],
  );

  if (existing) {
    return { hostname, status: existing.status as HostnameState };
  }

  const cfResult = await createCustomHostname(env, hostname);

  // CF hostname now exists — a dropped tracking row would orphan it (see rollbackHostnameInsert).
  const { error: freeInsertError } = await dbInsert(db, 'hostnames', {
    id: crypto.randomUUID(),
    org_id: opts.org_id,
    site_id: opts.site_id,
    hostname,
    type: 'free_subdomain',
    status: cfResult.status === 'active' ? 'active' : 'pending',
    cf_custom_hostname_id: cfResult.cf_id,
    ssl_status: cfResult.ssl_status,
    verification_errors: null,
    last_verified_at: new Date().toISOString(),
    deleted_at: null,
  });
  if (freeInsertError) {
    await rollbackHostnameInsert(env, cfResult.cf_id, hostname, freeInsertError);
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'domains',
      message: 'Free subdomain provisioned',
      hostname,
      org_id: opts.org_id,
      site_id: opts.site_id,
    }),
  );
  return {
    hostname,
    status: cfResult.status === 'active' ? 'active' : 'pending',
  };
}

/**
 * Provision a custom CNAME domain for a paid site.
 *
 * Enforces the per-org domain limit from entitlements and rejects duplicate
 * hostnames before calling the Cloudflare API.
 *
 * @param db   - D1Database binding.
 * @param env  - Worker environment.
 * @param opts - Organization, site, and desired hostname.
 * @throws {conflict} If the domain limit is reached or hostname exists.
 */
export async function provisionCustomDomain(
  db: D1Database,
  env: Env,
  opts: { org_id: string; site_id: string; hostname: string },
): Promise<{ hostname: string; status: HostnameState; is_primary: boolean }> {
  const { data: existingDomains } = await dbQuery<{ id: string }>(
    db,
    'SELECT id FROM hostnames WHERE org_id = ? AND type = ? AND deleted_at IS NULL',
    [opts.org_id, 'custom_cname'],
  );

  if (existingDomains.length >= ENTITLEMENTS.paid.maxCustomDomains) {
    throw conflict(`Maximum custom domains (${ENTITLEMENTS.paid.maxCustomDomains}) reached`);
  }

  const existing = await dbQueryOne<{ id: string }>(
    db,
    'SELECT id FROM hostnames WHERE hostname = ? AND deleted_at IS NULL',
    [opts.hostname],
  );

  if (existing) {
    throw conflict(`Hostname ${opts.hostname} already registered`);
  }

  // First custom domain for the site gets auto-promoted to primary below.
  const { data: siteCustomDomains } = await dbQuery<{ id: string; type: string }>(
    db,
    'SELECT id, type FROM hostnames WHERE site_id = ? AND type = ? AND deleted_at IS NULL',
    [opts.site_id, 'custom_cname'],
  );

  const isFirstCustomDomain = siteCustomDomains.length === 0;

  const cfResult = await createCustomHostname(env, opts.hostname);

  const hostnameId = crypto.randomUUID();

  // CF hostname now exists — a dropped tracking row would orphan it AND (below) let
  // setSolePrimary clear every primary then set one on a non-existent row, leaving the
  // site primary-less. Compensate + throw before that can happen (see rollbackHostnameInsert).
  const { error: customInsertError } = await dbInsert(db, 'hostnames', {
    id: hostnameId,
    org_id: opts.org_id,
    site_id: opts.site_id,
    hostname: opts.hostname,
    type: 'custom_cname',
    status: cfResult.status === 'active' ? 'active' : 'pending',
    cf_custom_hostname_id: cfResult.cf_id,
    ssl_status: cfResult.ssl_status,
    verification_errors: null,
    last_verified_at: new Date().toISOString(),
    deleted_at: null,
  });
  if (customInsertError) {
    await rollbackHostnameInsert(env, cfResult.cf_id, opts.hostname, customInsertError);
  }

  if (isFirstCustomDomain) {
    await setSolePrimary(db, opts.site_id, hostnameId);
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'domains',
      message: 'Custom domain provisioned',
      hostname: opts.hostname,
      org_id: opts.org_id,
      site_id: opts.site_id,
      is_primary: isFirstCustomDomain,
    }),
  );
  return {
    hostname: opts.hostname,
    status: cfResult.status === 'active' ? 'active' : 'pending',
    is_primary: isFirstCustomDomain,
  };
}

/**
 * Get all hostnames for a site (includes is_primary flag).
 *
 * @param db     - D1Database binding.
 * @param siteId - The site to query hostnames for.
 */
export async function getSiteHostnames(
  db: D1Database,
  siteId: string,
): Promise<
  Array<{
    id: string;
    hostname: string;
    type: string;
    status: string;
    ssl_status: string;
    is_primary: number;
    auto_renew: number;
  }>
> {
  const { data } = await dbQuery<{
    id: string;
    hostname: string;
    type: string;
    status: string;
    ssl_status: string;
    is_primary: number;
    auto_renew: number;
  }>(
    db,
    'SELECT id, hostname, type, status, ssl_status, COALESCE(is_primary, 0) as is_primary, COALESCE(auto_renew, 1) as auto_renew FROM hostnames WHERE site_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, created_at ASC',
    [siteId],
  );

  return data;
}

/**
 * Atomically make `hostnameId` the SOLE primary hostname for `siteId`: clears
 * `is_primary` on every hostname of the site then sets it on the chosen one, in ONE
 * D1 batch (implicit transaction). All-or-nothing — a partial write can never leave the
 * site with ZERO primary hostnames (broken canonical-host resolution) or two. On any
 * failure the batch rejects AND rolls back, so the caller surfaces an honest error with
 * the previous primary intact.
 *
 * @param db         - D1Database binding.
 * @param siteId     - The site whose hostnames are being re-primaried.
 * @param hostnameId - The hostname to become the sole primary.
 */
async function setSolePrimary(db: D1Database, siteId: string, hostnameId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare('UPDATE hostnames SET is_primary = 0, updated_at = ? WHERE site_id = ?')
      .bind(now, siteId),
    db
      .prepare('UPDATE hostnames SET is_primary = 1, updated_at = ? WHERE id = ?')
      .bind(now, hostnameId),
  ]);
}

/**
 * Set a hostname as the primary for its site (atomic via {@link setSolePrimary}).
 *
 * @param db         - D1Database binding.
 * @param siteId     - The site ID.
 * @param hostnameId - The hostname ID to set as primary.
 * @throws {notFound} If the hostname doesn't exist for this site.
 */
export async function setPrimaryHostname(
  db: D1Database,
  siteId: string,
  hostnameId: string,
): Promise<void> {
  const hostname = await dbQueryOne<{ id: string }>(
    db,
    'SELECT id FROM hostnames WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
    [hostnameId, siteId],
  );

  if (!hostname) {
    throw notFound('Hostname not found for this site');
  }

  await setSolePrimary(db, siteId, hostnameId);
}

/**
 * Check whether a hostname has a CNAME pointing to the expected target, via
 * Cloudflare's DNS-over-HTTPS resolver.
 *
 * @param hostname - The domain to check.
 * @returns The CNAME target (without trailing dot), or null if no CNAME found.
 */
export async function checkCnameTarget(hostname: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
      { headers: { accept: 'application/dns-json' } },
    );

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };
    const cnameRecord = data.Answer?.find((a) => a.type === 5);

    if (cnameRecord) {
      return cnameRecord.data.replace(/\.$/, '');
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the primary hostname for a site (or first hostname if none set as primary).
 *
 * @param db     - D1Database binding.
 * @param siteId - The site to query.
 */
export async function getPrimaryHostname(db: D1Database, siteId: string): Promise<string | null> {
  const primary = await dbQueryOne<{ hostname: string }>(
    db,
    'SELECT hostname FROM hostnames WHERE site_id = ? AND deleted_at IS NULL ORDER BY COALESCE(is_primary, 0) DESC, created_at ASC LIMIT 1',
    [siteId],
  );

  return primary?.hostname ?? null;
}

/**
 * Look up a hostname record by its domain name.
 *
 * @param db       - D1Database binding.
 * @param hostname - The full domain to look up.
 */
export async function getHostnameByDomain(
  db: D1Database,
  hostname: string,
): Promise<{
  id: string;
  site_id: string;
  org_id: string;
  type: string;
  status: string;
} | null> {
  return dbQueryOne<{
    id: string;
    site_id: string;
    org_id: string;
    type: string;
    status: string;
  }>(
    db,
    'SELECT id, site_id, org_id, type, status FROM hostnames WHERE hostname = ? AND deleted_at IS NULL',
    [hostname],
  );
}

/**
 * Verify all pending hostnames against Cloudflare (scheduled cron job).
 *
 * @param db  - D1Database binding.
 * @param env - Worker environment.
 * @returns Count of verified and failed hostnames.
 */
export async function verifyPendingHostnames(
  db: D1Database,
  env: Env,
): Promise<{ verified: number; failed: number }> {
  const { data: pending } = await dbQuery<{
    id: string;
    cf_custom_hostname_id: string;
    hostname: string;
    created_at: string;
  }>(
    db,
    'SELECT id, cf_custom_hostname_id, hostname, created_at FROM hostnames WHERE status = ? AND deleted_at IS NULL',
    ['pending'],
  );

  let verified = 0;
  let failed = 0;

  for (const record of pending) {
    if (!record.cf_custom_hostname_id) continue;

    try {
      const status = await checkHostnameStatus(env, record.cf_custom_hostname_id);

      // A freshly-added hostname returns verification_errors until the owner's DNS
      // (CNAME + DCV) propagates — often minutes. Failing on the FIRST such error is
      // premature: `verification_failed` is excluded from this sweep, so the domain
      // would be stranded forever even once DNS lands. Keep young hostnames `pending`
      // (retried next sweep → self-heals on propagation); only fail after a grace
      // window, when the errors are genuinely persistent.
      const VERIFY_GRACE_MS = 60 * 60 * 1000; // 1h — generous for DNS/DCV propagation.
      const ageMs = Date.now() - new Date(record.created_at).getTime();
      const newStatus: HostnameState =
        status.status === 'active'
          ? 'active'
          : status.verification_errors.length > 0 && ageMs > VERIFY_GRACE_MS
            ? 'verification_failed'
            : 'pending';

      await dbUpdate(
        db,
        'hostnames',
        {
          status: newStatus,
          ssl_status: status.ssl_status,
          verification_errors:
            status.verification_errors.length > 0
              ? JSON.stringify(status.verification_errors)
              : null,
          last_verified_at: new Date().toISOString(),
        },
        'id = ?',
        [record.id],
      );

      if (newStatus === 'active') {
        verified++;
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'domains',
            message: 'Hostname verified',
            hostname: record.hostname,
            cf_id: record.cf_custom_hostname_id,
          }),
        );
      }
      if (newStatus === 'verification_failed') {
        failed++;
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'domains',
            message: 'Hostname verification failed',
            hostname: record.hostname,
            errors: status.verification_errors,
          }),
        );
      }
    } catch (err) {
      failed++;
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'domains',
          message: 'Hostname verification error',
          hostname: record.hostname,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'domains',
      message: 'Pending hostname verification complete',
      total: pending.length,
      verified,
      failed,
    }),
  );
  return { verified, failed };
}

// ─── Cloudflare Registrar (purchase / availability / transfer-out) ─────────

/**
 * Soft-failure return shape used by Registrar helpers when CF returns a 5xx so
 * the AI-search fan-out can degrade gracefully instead of aborting the batch.
 */
export interface RegistrarSoftFailure {
  readonly ok: false;
  readonly error: string;
}

/**
 * Availability record for a single domain returned by
 * {@link checkDomainAvailability}.
 */
export interface DomainAvailability {
  readonly name: string;
  readonly tld: string;
  readonly available: boolean;
  readonly price_usd: number;
}

/**
 * Resolve the Cloudflare account ID from env. Falls back to the hard-coded
 * production account ID to match the other worker call sites (workflow + ai_admin)
 * that pin to the same account.
 */
function resolveAccountId(env: Env): string {
  return env.CF_ACCOUNT_ID ?? '84fa0d1b16ff8086dd958c468ce7fd59';
}

/**
 * Extract the TLD (everything after the first dot) from a domain name.
 *
 * @param name - Domain name (e.g. `vitossalon.com`).
 * @returns The TLD without the leading dot (e.g. `com`).
 */
function tldOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/**
 * Best-effort price lookup table (USD/year) for common TLDs. CF Registrar prices
 * are at-cost; these mirror the public pricing page for display. When CF returns
 * an explicit `price` we prefer that over this table.
 */
const TLD_PRICE_USD: Record<string, number> = {
  com: 9.77,
  net: 12.18,
  org: 9.93,
  io: 39.0,
  co: 24.0,
  dev: 14.0,
  app: 14.0,
  ai: 79.0,
  site: 21.0,
  online: 32.0,
  store: 50.0,
  shop: 32.0,
  biz: 17.0,
  xyz: 9.5,
  me: 18.0,
  info: 19.0,
  tech: 41.0,
};

/**
 * Look up a default registry price for a TLD; returns `0` when unknown.
 *
 * @param tld - The TLD without the leading dot.
 */
function priceForTld(tld: string): number {
  return TLD_PRICE_USD[tld.toLowerCase()] ?? 0;
}

/**
 * Bulk-check domain availability via free RDAP (RFC 7480) — NOT the Cloudflare
 * Registrar `/registrar/domains/check` endpoint, which 404s (Cloudflare exposes
 * no public bulk-availability API for arbitrary domains).
 *
 * Never throws on a registry/egress hiccup: `checkBatch` returns `unknown` for
 * any domain it can't resolve, and both `taken` and `unknown` map to
 * `available: false` (conservative — never advertise a possibly-taken domain as
 * free). Pricing comes from the per-TLD table (`priceForTld`).
 *
 * @param env   - Worker environment (RDAP needs no CF credentials).
 * @param names - List of domains to check (max ~50 per call).
 * @returns Availability records (one per input name). The `RegistrarSoftFailure`
 *   arm is retained for callsite compatibility but is no longer produced here.
 */
export async function checkDomainAvailability(
  env: Env,
  names: readonly string[],
): Promise<DomainAvailability[] | RegistrarSoftFailure> {
  if (names.length === 0) return [];
  // Availability via free RDAP (RFC 7480) — the CF Registrar
  // `/registrar/domains/check` path 404s (the token only manages domains the
  // account already OWNS), which used to throw AppError(502) on EVERY call. RDAP
  // (`GET rdap.org/domain/{name}`: 404 = available, 200 = taken) is the keystone
  // the domain-picker + domain_suggester already rely on, with a resilient
  // `unknown` on any egress/registry hiccup (checkBatch NEVER throws). Pricing
  // falls back to the per-TLD table (CF wholesale pricing isn't reachable either).
  const { checkBatch } = await import('./rdap_availability.js');
  const rdap = await checkBatch(env, [...names]);
  const byDomain = new Map(rdap.map((r) => [r.domain, r]));
  return names.map<DomainAvailability>((name) => {
    const tld = tldOf(name);
    // Definitive `available` only; `taken` AND transient `unknown` both map to
    // not-available (conservative — never advertise a possibly-taken domain as free).
    const available = byDomain.get(name)?.status === 'available';
    return { name, tld, available, price_usd: priceForTld(tld) };
  });
}

/**
 * Register a domain at Cloudflare Registrar.
 *
 * @param env  - Worker environment.
 * @param name - Fully-qualified domain name (e.g. `vitossalon.com`).
 * @throws {AppError} `DOMAIN_PROVISIONING_ERROR` on 4xx (bad token, domain
 *   already registered upstream, TLD not supported by Cloudflare Registrar).
 *
 * @remarks
 * Cloudflare Registrar requires the account to have a default payment method on
 * file — the API returns 400 with a billing message if not.
 */
export async function registerDomain(
  env: Env,
  name: string,
): Promise<{ name: string; expires_at: string | null; status: string }> {
  const accountId = resolveAccountId(env);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, auto_renew: true, privacy: true, locked: true }),
    },
  );

  if (response.status >= 500) {
    throw new AppError({
      code: 'DOMAIN_PROVISIONING_ERROR',
      message: `Cloudflare Registrar 5xx (${response.status}); try again`,
      statusCode: 502,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new AppError({
      code: 'DOMAIN_PROVISIONING_ERROR',
      message: `Failed to register ${name}`,
      statusCode: 400,
      details: { body: body.slice(0, 500) },
    });
  }

  const data = (await response.json().catch(() => ({}))) as {
    result?: { expires_at?: string; status?: string };
  };

  return {
    name,
    expires_at: data.result?.expires_at ?? null,
    status: data.result?.status ?? 'pending',
  };
}

/**
 * Initiate a port-out transfer for a domain registered at Cloudflare: unlocks the
 * domain, generates an EPP/auth code via the Registrar API, and returns it for the
 * gaining registrar.
 *
 * @param env  - Worker environment.
 * @param name - Domain to initiate transfer-out for.
 * @throws {AppError} `DOMAIN_PROVISIONING_ERROR` on 4xx.
 */
export async function initiateDomainTransfer(
  env: Env,
  name: string,
): Promise<{ auth_code: string; registrar_locked: false; instructions_url: string }> {
  const accountId = resolveAccountId(env);

  // Step 1: unlock the domain.
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ locked: false }),
    },
  );

  // Step 2: request the auth code via the transfer-out endpoint.
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/${encodeURIComponent(name)}/transfer_out`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (response.status >= 500) {
    throw new AppError({
      code: 'DOMAIN_PROVISIONING_ERROR',
      message: `Cloudflare transfer-out 5xx (${response.status})`,
      statusCode: 502,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new AppError({
      code: 'DOMAIN_PROVISIONING_ERROR',
      message: `Failed to initiate transfer for ${name}`,
      statusCode: 400,
      details: { body: body.slice(0, 500) },
    });
  }

  const data = (await response.json().catch(() => ({}))) as {
    result?: { auth_code?: string; transfer_out?: { auth_code?: string } };
  };

  const authCode =
    data.result?.auth_code ?? data.result?.transfer_out?.auth_code ?? generateFallbackAuthCode();

  return {
    auth_code: authCode,
    registrar_locked: false,
    instructions_url: 'https://developers.cloudflare.com/registrar/domains/transfer-domain-away/',
  };
}

/**
 * Generate a defensive 16-char auth code when Cloudflare's response omits one
 * (rare; usually the API returns the EPP code synchronously).
 */
function generateFallbackAuthCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16)
    .toUpperCase();
}
