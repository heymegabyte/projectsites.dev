/**
 * @module libs/features/data_resource_registry/owner_inventory
 * @description The TRUTHFUL per-site resource inventory the editor's Resources → Advanced panel
 * renders — owner-grade typed rows enumerated from the AUTHORITATIVE stores, never a raw registry
 * dump and NEVER a "unknown" row.
 *
 * Root cause this module retires (fire-60, lone-mountain-global): the GET
 * `/api/sites/:siteId/resources` handler returned the Zod-parsed camelCase `ResourceRecord[]`
 * (`resourceKind`, `lifecycleState`, …) while the editor's wire contract
 * (`ResourceOverviewEntry`, `app/lib/embed/embedded-mode.ts`) reads snake_case
 * (`resource_kind`, `lifecycle_state`, …). The Angular bridge relays verbatim, so every key the
 * editor read was `undefined` → every per-kind tile counted **0** while the real rows fell into
 * the catch-all with an "Unknown" lifecycle chip — the classic response-key-mismatch LYING-EMPTY
 * class (display ≠ store while both sides are individually "fine").
 *
 * This module is the single wire-shaping + enumeration boundary:
 *
 *  1. **Registry rows** ({@link listResources}) are mapped to the snake_case wire shape with an
 *     owner-grade `owner_label` from a TOTAL per-kind map — a row can never surface untyped.
 *     Platform-shared rows are EXCLUDED (tenancy `shared_platform`, or an id on the kind's
 *     {@link forbiddenIdsForKind} denylist) — the master platform D1/KV must never appear as
 *     "the site's".
 *  2. **Live allocations** ({@link resolveSiteResources} over `site_database_allocations`) are
 *     merged in, so the inventory is truthful even when the registry was never reconcile-seeded
 *     (the original "EMPTY until a reconcile" design gap).
 *  3. **Authoritative serving resources** are enumerated directly (production env): the site's R2
 *     version tree in the shared bucket (`sites/{slug}/{version}/` → "Your site files"), the
 *     default-subdomain routing entry, and any custom hostnames ("Your domain") from D1.
 *
 * Honest empty: a site with no allocation, no registry row, no build and no hostnames yields `[]`
 * — the panel's empty state is then TRULY zero (a new unbuilt site), never a lie.
 *
 * Read-only: one `sites` read, one `hostnames` read, one bounded R2 `list` (limit 1) — no CF
 * mutation, no resource creation. All failures degrade by omission (fail-soft), never a throw
 * into the route.
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne } from '../../../src/services/db.js';

import { forbiddenIdsForKind, listResources } from './service.js';
import { resolveSiteResources } from './site_resources.js';
import type { ResourceEnvironment, ResourceRecord } from './schemas.js';

/**
 * One owner-grade inventory row as the editor wire contract consumes it (snake_case — this IS the
 * `ResourceOverviewEntry` shape in `app/lib/embed/embedded-mode.ts`, plus the owner-grade
 * additions `display_name` / `owner_label` / `detail`). `resource_kind` is a WIRE kind: the
 * registry kind verbatim, except the WfP slot row (concept `wfp_namespace`, stored under the
 * `durable_object` kind) which surfaces as `wfp_worker`, and the two virtual serving kinds
 * `hostname` / `routing`. NEVER `"unknown"` — the label map below is total.
 */
export interface OwnerResourceEntry {
  readonly id: string;
  readonly resource_kind: string;
  readonly resource_concept: string;
  readonly environment: string;
  readonly tenancy: string;
  readonly lifecycle_state: string;
  readonly drift_code?: string;
  readonly binding_name?: string;
  readonly last_sync_at?: string;
  /** Owner-facing NAME of this specific resource (what it is called). */
  readonly display_name: string;
  /** Owner-grade TYPE label ("Your site database") — total map, never "unknown". */
  readonly owner_label: string;
  /** Advanced detail (CF id / script / prefix) — rendered behind a disclosure, never headline. */
  readonly detail?: string;
}

/**
 * Owner-grade label per WIRE kind. TOTAL over every kind this module can emit — a lookup miss
 * falls back to "Platform resource" (still a labeled type, never "unknown"), but the test suite
 * asserts every emitted kind has an explicit entry.
 */
export const OWNER_LABELS: Readonly<Record<string, string>> = {
  analytics_engine: 'Site analytics',
  connection: 'Connected service',
  d1: 'Your site database',
  durable_object: 'Compute instance',
  hostname: 'Your domain',
  kv: 'Your site key-value store',
  queue: 'Message queue',
  r2: 'Your site storage',
  routing: 'Routing entry',
  vectorize: 'Search index',
  wfp_worker: 'Your site worker',
  workflow: 'Background workflow',
};

/** The fallback owner label — a LABELED type for any future kind, never "unknown". */
const FALLBACK_OWNER_LABEL = 'Platform resource';

/** Stable wire ordering: stores → compute → serving glue. Unknown kinds sort last, alphabetically. */
const WIRE_KIND_ORDER: readonly string[] = [
  'd1',
  'kv',
  'r2',
  'wfp_worker',
  'durable_object',
  'workflow',
  'queue',
  'vectorize',
  'analytics_engine',
  'connection',
  'hostname',
  'routing',
];

/** Resolve the owner label for a wire kind (total — never undefined, never "unknown"). */
export function ownerLabelFor(wireKind: string): string {
  return OWNER_LABELS[wireKind] ?? FALLBACK_OWNER_LABEL;
}

/**
 * True when a registry row must be EXCLUDED from the owner inventory: platform-shared rows
 * (recorded only for denylisting) and any row whose resolved id sits on the kind's
 * shared-platform denylist. The platform master D1/KV is never "the site's".
 */
function isPlatformShared(row: ResourceRecord): boolean {
  if (row.tenancy === 'shared_platform') return true;
  if (row.resourceIdOrName && forbiddenIdsForKind(row.resourceKind).has(row.resourceIdOrName)) {
    return true;
  }
  return false;
}

/** Map a registry row to its owner-grade wire entry (the camelCase→snake_case boundary). */
function toWireEntry(row: ResourceRecord): OwnerResourceEntry {
  // The WfP slot row is stored under the `durable_object` kind (the closest legal registry kind)
  // with concept `wfp_namespace` — on the WIRE it is the owner's SITE WORKER, its own type.
  const isWfpSlot = row.resourceConcept === 'wfp_namespace';
  const wireKind = isWfpSlot ? 'wfp_worker' : row.resourceKind;

  const detailParts: string[] = [];
  if (row.resourceIdOrName) detailParts.push(`id: ${row.resourceIdOrName}`);
  if (row.userWorkerScript) detailParts.push(`script: ${row.userWorkerScript}`);
  if (row.wfpDispatchNamespace) detailParts.push(`namespace: ${row.wfpDispatchNamespace}`);
  if (row.deployedVersion) detailParts.push(`version: ${row.deployedVersion}`);

  return {
    id: row.id,
    resource_kind: wireKind,
    resource_concept: row.resourceConcept,
    environment: row.environment,
    tenancy: row.tenancy,
    lifecycle_state: row.lifecycleState,
    ...(row.driftCode ? { drift_code: row.driftCode } : {}),
    ...(row.bindingName ? { binding_name: row.bindingName } : {}),
    ...(row.lastSyncAt ? { last_sync_at: row.lastSyncAt } : {}),
    display_name:
      row.resourceDisplayName ??
      row.userWorkerScript ??
      row.resourceIdOrName ??
      ownerLabelFor(wireKind),
    owner_label: ownerLabelFor(wireKind),
    ...(detailParts.length > 0 ? { detail: detailParts.join(' · ') } : {}),
  };
}

/** Build a synthetic (allocation-derived) wire entry for an allocation the registry lacks. */
function allocationEntry(
  kind: 'd1' | 'kv' | 'r2',
  environment: ResourceEnvironment,
  idOrName: string,
  displayName: string | null,
): OwnerResourceEntry {
  return {
    id: `alloc-${kind}-${environment}`,
    resource_kind: kind,
    resource_concept: 'account_resource',
    environment,
    tenancy: 'dedicated',
    lifecycle_state: 'active',
    display_name: displayName ?? idOrName,
    owner_label: ownerLabelFor(kind),
    detail: `id: ${idOrName}`,
  };
}

/** The `sites` columns the serving enumeration needs. */
interface SiteRow {
  slug: string | null;
  current_build_version: string | null;
}

/** The `hostnames` columns the serving enumeration needs. */
interface HostnameRow {
  id: string;
  hostname: string;
  status: string | null;
}

/**
 * Enumerate the owner-grade resource inventory for one `(site, environment)` from the
 * AUTHORITATIVE stores. The caller (route) has already run the full 5-step gate (auth → flag →
 * ownership → operands) — this is the trusted read body. See the module doc for the three
 * enumeration layers. Returns rows sorted by {@link WIRE_KIND_ORDER}.
 *
 * @param env - worker env (`DB` + `SITES_BUCKET`).
 * @param siteId - the OWNED site (server-side route param — never a client CF id).
 * @param environment - 'preview' | 'production'.
 * @returns owner-grade wire entries — `[]` ONLY for a truly blank site (honest empty).
 */
export async function enumerateOwnerResources(
  env: Env,
  siteId: string,
  environment: ResourceEnvironment,
): Promise<OwnerResourceEntry[]> {
  // ── 1. Registry rows (minus platform-shared) → wire shape ──────────────────────────────────
  const registryRows = await listResources(env, siteId, environment);
  const entries: OwnerResourceEntry[] = registryRows
    .filter((row) => !isPlatformShared(row))
    .map(toWireEntry);

  // ── 2. Live allocation merge — truthful WITHOUT a prior reconcile ──────────────────────────
  // `site_database_allocations` is the authoritative allocation store; a site whose registry was
  // never seeded still OWNS these. `resolveSiteResources` already refuses a forbidden platform
  // D1 id (fail-closed) — on that reason we surface nothing rather than a platform id.
  try {
    const alloc = await resolveSiteResources(env, siteId);
    if (alloc.ok) {
      const have = new Set(
        entries
          .filter((e) => e.resource_concept === 'account_resource')
          .map((e) => `${e.resource_kind}`),
      );
      const { d1DatabaseId, d1DatabaseName, kvNamespaceId, kvNamespaceName, r2BucketName } =
        alloc.resources;
      if (d1DatabaseId && !have.has('d1') && !forbiddenIdsForKind('d1').has(d1DatabaseId)) {
        entries.push(allocationEntry('d1', environment, d1DatabaseId, d1DatabaseName));
      }
      if (kvNamespaceId && !have.has('kv')) {
        entries.push(allocationEntry('kv', environment, kvNamespaceId, kvNamespaceName));
      }
      if (r2BucketName && !have.has('r2')) {
        entries.push(allocationEntry('r2', environment, r2BucketName, r2BucketName));
      }
    }
  } catch {
    // Allocation read failure degrades by omission — the registry layer already rendered.
  }

  // ── 3. Authoritative serving resources (production serving concerns) ───────────────────────
  if (environment === 'production') {
    const site = await dbQueryOne<SiteRow>(
      env.DB,
      `SELECT slug, current_build_version FROM sites WHERE id = ? AND deleted_at IS NULL`,
      [siteId],
    );

    // Your site files — the R2 version tree in the SHARED bucket (`sites/{slug}/{version}/`).
    // This is the store that provably holds the site's generated build even when NO dedicated
    // per-site bucket exists; confirmed with a bounded list (limit 1), never fabricated.
    if (site?.slug && site.current_build_version) {
      const prefix = `sites/${site.slug}/${site.current_build_version}/`;
      try {
        const listed = await env.SITES_BUCKET.list({ limit: 1, prefix });
        if (listed.objects.length > 0) {
          entries.push({
            id: 'site-files-production',
            resource_kind: 'r2',
            resource_concept: 'site_files',
            environment,
            tenancy: 'shared_shim',
            lifecycle_state: 'active',
            display_name: `${site.slug} build ${site.current_build_version}`,
            owner_label: 'Your site files',
            detail: `prefix: ${prefix}`,
          });
        }
      } catch {
        // R2 unavailable → omit the row (fail-soft) rather than claim or deny.
      }
    }

    // Routing entry — the default subdomain every live site serves on (authoritative: `sites.slug`;
    // the KV `host:{hostname}` keys are only a 60s cache of this truth).
    if (site?.slug) {
      entries.push({
        id: 'routing-subdomain',
        resource_kind: 'routing',
        resource_concept: 'host_route',
        environment,
        tenancy: 'shared_shim',
        lifecycle_state: 'active',
        display_name: `${site.slug}.projectsites.dev`,
        owner_label: ownerLabelFor('routing'),
        detail: `Serves your site at https://${site.slug}.projectsites.dev`,
      });
    }

    // Your domain — custom hostnames from the authoritative D1 `hostnames` table.
    try {
      const { data: hostRows } = await dbQuery<HostnameRow>(
        env.DB,
        `SELECT id, hostname, status FROM hostnames WHERE site_id = ? AND deleted_at IS NULL`,
        [siteId],
      );
      for (const h of hostRows) {
        entries.push({
          id: `hostname-${h.id}`,
          resource_kind: 'hostname',
          resource_concept: 'custom_hostname',
          environment,
          tenancy: 'dedicated',
          lifecycle_state: h.status === 'active' ? 'active' : 'provisioning',
          display_name: h.hostname,
          owner_label: ownerLabelFor('hostname'),
          detail: `status: ${h.status ?? 'pending'}`,
        });
      }
    } catch {
      // Hostname read failure degrades by omission.
    }
  }

  return sortByWireKind(entries);
}

/** Sort wire entries by the stable {@link WIRE_KIND_ORDER}, then concept, then id. */
function sortByWireKind(entries: OwnerResourceEntry[]): OwnerResourceEntry[] {
  const rank = (k: string): number => {
    const i = WIRE_KIND_ORDER.indexOf(k);
    return i === -1 ? WIRE_KIND_ORDER.length : i;
  };
  return [...entries].sort(
    (a, b) =>
      rank(a.resource_kind) - rank(b.resource_kind) ||
      a.resource_concept.localeCompare(b.resource_concept) ||
      a.id.localeCompare(b.id),
  );
}
