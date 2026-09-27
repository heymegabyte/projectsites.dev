/**
 * @file Per-site D1 **data plane** — resolve + execute against a SITE'S OWN Cloudflare D1.
 *
 * The FOUNDATION of the Data Platform re-architecture (`docs/data-platform-scope.md`). The
 * admin/editor "Data" tab reads a customer's OWN database (blank at first) — NEVER the shared
 * platform D1 and NEVER another site's D1. That isolation is the whole point of this module and
 * it is **structural**:
 *
 * - The target database id is **server-resolved** from `site_database_allocations` for the site the
 *   caller already proved they own (`ownsSiteData` in the route) — it is NEVER accepted from the
 *   client (see the `x-org-id-idor-class` incident: client-supplied targets are an IDOR).
 * - The shared platform D1 ids are on a hard denylist ({@link FORBIDDEN_DB_IDS}); a resolve that
 *   somehow lands on one fails closed. Defense-in-depth on top of the structural guarantee that the
 *   shared DB is not a row in `site_database_allocations`.
 * - Execution goes through the Cloudflare **D1 REST query API**
 *   (`POST /accounts/{acct}/d1/database/{id}/query`) bound to exactly ONE database id. A Worker
 *   cannot statically bind thousands of per-site D1s in `wrangler.toml`, so the REST plane is the
 *   only viable mechanism (same pattern as `cloudflare_provisioner.ts`'s `applyD1Migration`).
 *
 * The site D1 is BLANK — none of the platform's tables (users/orgs/sites/billing/form_submissions/
 * visitor_events) live here. Platform per-site data stays in the MASTER D1 (per the 2026-09-26
 * reconciliation) and is surfaced by `site_data_api/handlers.ts`, NOT this module.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';

import { type CfAuth, cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { provisionSiteD1, siteD1Name } from './d1_provisioner.js';
import { dbQueryOne } from './db.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Platform D1 database ids the per-site data plane must NEVER touch. These are the SHARED
 * projectsites.dev databases (all-tenant platform data). Resolving one is a hard failure — the
 * customer-facing Data tab is physically fenced off from them. Kept in sync with `wrangler.toml`
 * `[[d1_databases]]` `database_id` entries + the CLAUDE.md resource-id table.
 */
export const FORBIDDEN_DB_IDS: ReadonlySet<string> = new Set([
  'ea3e839a-c641-4861-ae30-dfc63bff8032', // project-sites-db-production (shared platform D1, prod)
  'f5b59818-c785-4807-8aca-282c9037c58c', // project-sites-db (shared platform D1, default/non-prod)
]);

/** A single row returned by a per-site D1 query. */
export type SiteDataRow = Record<string, unknown>;

/** Result of one D1 REST query: the rows plus D1's execution meta. */
export interface SiteDataQueryResult<T = SiteDataRow> {
  readonly results: T[];
  readonly meta: {
    readonly rows_read?: number;
    readonly rows_written?: number;
    readonly changed_db?: boolean;
    readonly duration?: number;
  };
}

/** Typed failure of a per-site D1 query (CF REST error / network). */
export class SiteDataD1Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SiteDataD1Error';
  }
}

/**
 * A thin executor bound to exactly ONE per-site D1 (by database id) via the CF REST D1 query API.
 * Callers can only run SQL against the database id this executor was minted with — there is no way
 * to redirect it at another database. Read or write; a single parameterized statement per call
 * (the D1 REST `/query` endpoint is single-statement).
 */
export interface SiteDataD1 {
  /** The resolved per-site database id this executor targets (audit / logging). */
  readonly databaseId: string;
  /** Run a single parameterized SQL statement. Throws {@link SiteDataD1Error} on CF error. */
  query<T = SiteDataRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SiteDataQueryResult<T>>;
}

/** Reason a per-site D1 could not be resolved — honest, typed, no fabrication. */
export type ResolveSiteDataDbFailure =
  | 'no_cf_credentials'
  | 'no_account_id'
  | 'provision_failed'
  | 'not_provisioned'
  | 'forbidden_shared_db';

/** Result of {@link resolveSiteDataDb}: an executor on success, a typed reason on failure. */
export type ResolveSiteDataDbResult =
  | {
      readonly ok: true;
      readonly db: SiteDataD1;
      readonly databaseId: string;
      /** true when THIS call freshly created the D1 (false when an existing one was reused). */
      readonly provisioned: boolean;
    }
  | { readonly ok: false; readonly reason: ResolveSiteDataDbFailure; readonly status?: number };

/**
 * A SQLite identifier (table/column) safe to interpolate into DDL/DML. D1's REST `/query` cannot
 * parameterize an identifier, so a table/column name MUST be validated against this allowlist and
 * quoted with {@link quoteIdent} before it touches a SQL string — never interpolated raw.
 *
 * @example isSafeIdent('customers')   // true
 * @example isSafeIdent('1_bad')       // false (leading digit)
 * @example isSafeIdent('drop; --')    // false
 */
export function isSafeIdent(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name);
}

/**
 * Double-quote a validated SQLite identifier for safe interpolation. **Only** call after
 * {@link isSafeIdent} has returned true — this escapes embedded quotes as a belt-and-braces
 * measure but is not a substitute for the allowlist.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build the executor bound to one database id. Internal — reach it via {@link resolveSiteDataDb}. */
function makeExecutor(auth: CfAuth, account: string, databaseId: string): SiteDataD1 {
  return {
    databaseId,
    async query<T = SiteDataRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<SiteDataQueryResult<T>> {
      // Retry transient CF-API 5xx (the D1 REST plane intermittently 500s under load) — mirrors
      // cloudflare_provisioner.ts `cfFetch`. Reads are safe to replay; single-statement writes are
      // idempotent at this layer only when the SQL itself is (callers own that).
      let res: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(`${CF_API_BASE}/accounts/${account}/d1/database/${databaseId}/query`, {
          body: JSON.stringify({ params, sql }),
          headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
          method: 'POST',
        });
        if (res.status < 500 || attempt === 2) break;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      const r = res as Response;
      const json = (await r.json().catch(() => null)) as {
        success?: boolean;
        result?: Array<{ results?: T[]; meta?: SiteDataQueryResult['meta'] }>;
        errors?: unknown;
      } | null;
      if (!r.ok || !json?.success) {
        const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${r.status}`;
        throw new SiteDataD1Error(`per-site D1 query failed: ${detail}`, r.status);
      }
      const first = json.result?.[0];
      return { meta: first?.meta ?? {}, results: (first?.results ?? []) as T[] };
    },
  };
}

/**
 * Resolve (and, by default, lazily provision) the per-site D1 executor for a site.
 *
 * The caller MUST have already verified the requester owns `siteId` (route-level `ownsSiteData`) —
 * this function does not re-check org ownership, it enforces the DATABASE-level isolation: it reads
 * the site's own `d1_database_id` from `site_database_allocations`, creates it on first use, and
 * refuses any id on the shared-platform denylist.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param siteId - the OWNED site whose database to resolve (server-side, never client-supplied)
 * @param opts.orgId - org for stored CF creds + the allocation's tenant (falls back to bundled key)
 * @param opts.autoProvision - when `false`, resolve an existing D1 only (never create). Default true.
 * @returns the executor + database id, or a typed failure reason
 */
export async function resolveSiteDataDb(
  env: Env,
  siteId: string,
  opts: { orgId?: string | null; autoProvision?: boolean } = {},
): Promise<ResolveSiteDataDbResult> {
  const orgId = opts.orgId ?? null;
  const autoProvision = opts.autoProvision !== false;

  // 1. Existing allocation for THIS site (the only source of a per-site database id).
  const existing = await dbQueryOne<{ d1_database_id: string | null }>(
    env.DB,
    `SELECT d1_database_id FROM site_database_allocations
       WHERE site_id = ? AND db_plan = 'd1_tenant_db' AND status = 'active' AND d1_database_id IS NOT NULL`,
    [siteId],
  );
  let databaseId = existing?.d1_database_id ?? null;
  let provisioned = false;

  // 2. Lazy provision on first access — a blank, dedicated D1 for this site.
  if (!databaseId) {
    if (!autoProvision) return { ok: false, reason: 'not_provisioned' };
    const prov = await provisionSiteD1(env, { orgId, siteId, tenantId: orgId ?? siteId });
    if (!prov.ok) {
      return {
        ok: false,
        reason: prov.reason === 'no_account_id' ? 'no_account_id' : 'provision_failed',
        status: prov.status,
      };
    }
    databaseId = prov.databaseId;
    provisioned = !prov.reused;
  }

  // 3. ISOLATION — never a shared platform database, ever. Fail closed.
  if (FORBIDDEN_DB_IDS.has(databaseId)) {
    return { ok: false, reason: 'forbidden_shared_db' };
  }

  // 4. Server-side credentials + account (never client-supplied).
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { ok: false, reason: 'no_cf_credentials' };
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { ok: false, reason: 'no_account_id' };

  return { databaseId, db: makeExecutor(auth, account, databaseId), ok: true, provisioned };
}

/**
 * List the customer-owned tables in a site's D1 — hides SQLite/D1/Cloudflare internals
 * (`sqlite_*`, `_cf_*`, `d1_migrations`) so a blank site D1 reads as an empty table set (the Data
 * tab's "New table / Ask AI" empty state), never a confusing list of plumbing tables.
 *
 * @returns the user table names, sorted
 */
export async function listSiteTables(db: SiteDataD1): Promise<string[]> {
  const { results } = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND name <> 'd1_migrations'
       ORDER BY name`,
  );
  return results.map((r) => r.name).filter(isSafeIdent);
}

/** The re-exported deterministic per-site D1 name (`ps-site-{id}`) — for logging / display. */
export { siteD1Name };
