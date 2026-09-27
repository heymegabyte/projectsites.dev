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
  query<T = SiteDataRow>(sql: string, params?: readonly unknown[]): Promise<SiteDataQueryResult<T>>;
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

/**
 * Build the executor bound to one database id via the CF REST D1 `/query` API. The **low-level query
 * mechanism** shared by both the resolve-and-provision path here ({@link resolveSiteDataDb}) and the
 * data-resource-registry `d1` adapter, which operates on an ALREADY-RESOLVED scope and so must NOT
 * re-resolve — it builds its own executor from the resolved `{ auth, accountId, resourceId }`. Both
 * therefore execute through the exact same single-statement, 5xx-retrying REST `/query` path.
 *
 * @param auth - CF auth (from `resolveCfCredentials` upstream — never client-supplied)
 * @param account - CF account id (`env.CF_ACCOUNT_ID`)
 * @param databaseId - the ONE per-site database id this executor targets (caller MUST NOT pass a shared id)
 */
export function makeSiteDataExecutor(
  auth: CfAuth,
  account: string,
  databaseId: string,
): SiteDataD1 {
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

  return { databaseId, db: makeSiteDataExecutor(auth, account, databaseId), ok: true, provisioned };
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

/**
 * One column of a per-site table as `PRAGMA table_info` reports it — the shape both the browse
 * surface and the AI-seed introspection path consume.
 */
export interface SiteTableColumn {
  readonly name: string;
  /** SQLite declared type (`TEXT`/`INTEGER`/`REAL`/…); empty string when the table used no type. */
  readonly type: string;
  /** 1 when the column is `NOT NULL`. */
  readonly notnull: number;
  /** 1 when the column is (part of) the primary key. */
  readonly pk: number;
  /** The column's DEFAULT expression as text, or null. */
  readonly dflt_value?: string | null;
}

/**
 * Introspect a table's columns via `pragma_table_info` — the SAME parameterized read the browse
 * route uses. The caller MUST have validated `table` with {@link isSafeIdent} (the name is bound as a
 * VALUE to `pragma_table_info(?)`, so it is safe regardless, but keep the allowlist for the callers
 * that also interpolate the name elsewhere). Returns `[]` for a table with no columns / that vanished.
 */
export async function introspectColumns(db: SiteDataD1, table: string): Promise<SiteTableColumn[]> {
  const { results } = await db.query<SiteTableColumn>(
    `SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info(?)`,
    [table],
  );
  return results ?? [];
}

/**
 * The realistic sample dataset seeded by {@link createSampleData} — three RELATED e-commerce tables
 * (`customers` → `orders` → `products`, with `orders` referencing both) so a blank per-site D1
 * immediately demonstrates joins + typed columns, not a lone toy table. Kept as data (not inline SQL)
 * so the DDL + the row generator can't drift and the row COUNTS are asserted in tests.
 *
 * Each table: a `CREATE TABLE IF NOT EXISTS` with a stable, typed schema; a row generator producing
 * a deterministic-but-realistic spread. All values are inserted PARAMETERIZED (never interpolated).
 */
interface SampleTableSpec {
  readonly name: string;
  readonly createSql: string;
  /** Ordered column names for the INSERT (excludes autoincrement `id`). */
  readonly columns: readonly string[];
  /** Build the value rows (each row an array aligned to {@link columns}). */
  readonly rows: () => unknown[][];
}

const SAMPLE_FIRST_NAMES = [
  'Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Luna', 'Kai', 'Nora', 'Owen',
  'Isla', 'Leo', 'Ruby', 'Milo', 'Iris', 'Finn', 'Elle', 'Jude', 'Wren', 'Cole',
];
const SAMPLE_LAST_NAMES = [
  'Rivera', 'Chen', 'Patel', 'Okafor', 'Nguyen', 'Silva', 'Haddad', 'Kim', 'Rossi', 'Abara',
];
const SAMPLE_PRODUCTS = [
  { category: 'Beverage', name: 'Cold Brew Concentrate', price: 14.0 },
  { category: 'Beverage', name: 'Single-Origin Beans 12oz', price: 18.5 },
  { category: 'Equipment', name: 'Ceramic Pour-Over', price: 32.0 },
  { category: 'Accessory', name: 'Reusable Tumbler', price: 24.0 },
  { category: 'Beverage', name: 'Espresso Blend 1lb', price: 22.0 },
  { category: 'Equipment', name: 'Milk Frother', price: 39.0 },
  { category: 'Accessory', name: 'Barista Apron', price: 28.0 },
  { category: 'Beverage', name: 'Tasting Flight Set', price: 16.0 },
  { category: 'Other', name: 'Gift Card', price: 50.0 },
  { category: 'Equipment', name: 'Travel Grinder', price: 45.0 },
  { category: 'Beverage', name: 'Oat Milk Case', price: 30.0 },
  { category: 'Accessory', name: 'Logo Mug', price: 12.0 },
];

/** Deterministic pseudo-value pickers (seeded by index) — realistic spread, stable across runs. */
function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T;
}

/** The three related sample tables. Row counts land in the 12–20 band the task asks for. */
function sampleTableSpecs(): SampleTableSpec[] {
  const CUSTOMER_COUNT = 16;
  const ORDER_COUNT = 20;
  const now = Date.now();
  const dayMs = 86_400_000;
  return [
    {
      columns: ['name', 'email', 'city', 'lifetime_value', 'created_at'],
      createSql: `CREATE TABLE IF NOT EXISTS "customers" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        city TEXT,
        lifetime_value REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      name: 'customers',
      rows: () =>
        Array.from({ length: CUSTOMER_COUNT }, (_, i) => {
          const first = pick(SAMPLE_FIRST_NAMES, i);
          const last = pick(SAMPLE_LAST_NAMES, i * 3 + 1);
          return [
            `${first} ${last}`,
            `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
            pick(['Portland', 'Austin', 'Denver', 'Miami', 'Seattle'], i),
            Math.round((40 + (i * 37) % 260) * 100) / 100,
            new Date(now - (i * 5 + 3) * dayMs).toISOString(),
          ];
        }),
    },
    {
      columns: ['name', 'category', 'price', 'in_stock'],
      createSql: `CREATE TABLE IF NOT EXISTS "products" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        in_stock INTEGER NOT NULL DEFAULT 1
      )`,
      name: 'products',
      rows: () =>
        SAMPLE_PRODUCTS.map((p, i) => [p.name, p.category, p.price, i % 7 === 0 ? 0 : 1]),
    },
    {
      columns: ['customer_id', 'product_id', 'quantity', 'total', 'status', 'ordered_at'],
      createSql: `CREATE TABLE IF NOT EXISTS "orders" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        total REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        ordered_at TEXT NOT NULL
      )`,
      name: 'orders',
      rows: () =>
        Array.from({ length: ORDER_COUNT }, (_, i) => {
          const product = pick(SAMPLE_PRODUCTS, i * 2 + 1);
          const qty = (i % 3) + 1;
          return [
            (i % CUSTOMER_COUNT) + 1,
            ((i * 2 + 1) % SAMPLE_PRODUCTS.length) + 1,
            qty,
            Math.round(product.price * qty * 100) / 100,
            pick(['paid', 'paid', 'paid', 'refunded', 'pending'], i),
            new Date(now - (i * 2) * dayMs).toISOString(),
          ];
        }),
    },
  ];
}

/** Result of {@link createSampleData}: the tables touched + how many rows each received. */
export interface SampleDataResult {
  readonly tables: string[];
  readonly rowCounts: Record<string, number>;
  /** Tables skipped because they already existed with rows (never clobbered). */
  readonly skipped: string[];
}

/**
 * Seed a blank per-site D1 with the three related sample tables ({@link sampleTableSpecs}).
 * Idempotent + non-destructive: a table that ALREADY has rows is left untouched (reported in
 * `skipped`); a table that is absent or empty is created (`IF NOT EXISTS`) and filled. Every INSERT
 * is a single parameterized statement (the D1 REST `/query` plane is single-statement).
 *
 * @param db - the per-site executor (already resolved + isolated upstream via {@link resolveSiteDataDb})
 * @returns the tables + per-table row counts inserted this call, plus any skipped
 */
export async function createSampleData(db: SiteDataD1): Promise<SampleDataResult> {
  const specs = sampleTableSpecs();
  const rowCounts: Record<string, number> = {};
  const tables: string[] = [];
  const skipped: string[] = [];

  for (const spec of specs) {
    // Create the table if missing (safe no-op when present).
    await db.query(spec.createSql);

    // Never clobber existing customer data — skip a table that already holds rows.
    const existing = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(spec.name)}`,
    );
    if (Number(existing.results[0]?.n ?? 0) > 0) {
      skipped.push(spec.name);
      continue;
    }

    const rows = spec.rows();
    const cols = spec.columns.map(quoteIdent).join(', ');
    const placeholders = spec.columns.map(() => '?').join(', ');
    let inserted = 0;
    for (const row of rows) {
      const res = await db.query(
        `INSERT INTO ${quoteIdent(spec.name)} (${cols}) VALUES (${placeholders})`,
        row,
      );
      inserted += Number(res.meta.rows_written ?? 0) || 1;
    }
    rowCounts[spec.name] = inserted;
    tables.push(spec.name);
  }

  return { rowCounts, skipped, tables };
}

/** Result of an AI seed: the target table, how many rows landed, and a small preview. */
export interface AiSeedResult {
  readonly table: string;
  readonly inserted: number;
  readonly previewRows: SiteDataRow[];
  /** true when THIS call CREATE'd the table from a prompt (vs. seeded an existing one). */
  readonly createdTable: boolean;
}

/** A JSON-serialisable value the AI may return for a cell (guarded before binding). */
type SeedCell = string | number | boolean | null;

/** Coerce one AI-returned cell to a D1-bindable primitive; objects/arrays become JSON text. */
function toBindable(value: unknown): SeedCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * INSERT already-generated rows into an EXISTING table (parameterized). Each `row` is a
 * column→value map; only keys matching a REAL, {@link isSafeIdent}-valid column of `table` are used
 * (an AI hallucinating an extra key can never inject a column), and the primary-key column is
 * dropped so autoincrement stays intact. Returns the count inserted + a preview of what landed.
 *
 * @param db      - per-site executor (resolved + isolated upstream)
 * @param table   - target table (caller validated with {@link isSafeIdent}; confirmed to exist)
 * @param columns - the table's introspected columns (from {@link introspectColumns})
 * @param rows    - AI-generated column→value maps
 */
export async function insertSeedRows(
  db: SiteDataD1,
  table: string,
  columns: SiteTableColumn[],
  rows: Array<Record<string, unknown>>,
): Promise<{ inserted: number }> {
  // Insertable columns = real, safe-named, non-PK (leave autoincrement PKs to SQLite).
  const insertable = columns.filter((c) => isSafeIdent(c.name) && c.pk !== 1).map((c) => c.name);
  const insertableSet = new Set(insertable);
  if (insertable.length === 0) return { inserted: 0 };

  let inserted = 0;
  for (const row of rows) {
    // Only real columns the AI actually provided a value for (order-stable to the table's columns).
    const usedCols = insertable.filter((c) => c in row && insertableSet.has(c));
    if (usedCols.length === 0) continue;
    const values = usedCols.map((c) => toBindable(row[c]));
    const colSql = usedCols.map(quoteIdent).join(', ');
    const placeholders = usedCols.map(() => '?').join(', ');
    const res = await db.query(
      `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES (${placeholders})`,
      values,
    );
    inserted += Number(res.meta.rows_written ?? 0) || 1;
  }
  return { inserted };
}

/** A CREATE-TABLE plan the AI proposes when seeding from a bare prompt (no existing table). */
export interface AiTablePlan {
  readonly table: string;
  /** Ordered column definitions (name + SQLite type + optional NOT NULL). */
  readonly columns: Array<{ name: string; type: string; notnull?: boolean }>;
}

/** Allowed SQLite column types the AI may propose (anything else → TEXT). */
const ALLOWED_COL_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB']);

/**
 * Build a safe `CREATE TABLE` statement from an AI-proposed {@link AiTablePlan}. The table name +
 * every column name MUST pass {@link isSafeIdent} (rejects a hostile identifier); the type is
 * clamped to {@link ALLOWED_COL_TYPES}. Always prepends an `id INTEGER PRIMARY KEY AUTOINCREMENT`.
 * Returns `null` when the plan has no safe columns (caller renders a clean 400).
 */
export function buildCreateTableSql(plan: AiTablePlan): { sql: string; table: string } | null {
  if (!isSafeIdent(plan.table)) return null;
  const cols = plan.columns
    .filter((c) => isSafeIdent(c.name) && c.name.toLowerCase() !== 'id')
    .map((c) => {
      const type = ALLOWED_COL_TYPES.has(String(c.type).toUpperCase())
        ? String(c.type).toUpperCase()
        : 'TEXT';
      return `${quoteIdent(c.name)} ${type}${c.notnull ? ' NOT NULL' : ''}`;
    });
  if (cols.length === 0) return null;
  const sql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(plan.table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols.join(', ')})`;
  return { sql, table: plan.table };
}

/** The re-exported deterministic per-site D1 name (`ps-site-{id}`) — for logging / display. */
export { siteD1Name };
