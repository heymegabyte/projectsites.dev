/**
 * @module services/site_cost
 * @description Read-only per-site / per-app-instance **cost metering** (Pricing Model Wave 1).
 *
 * Prices the exact metered cost of every asset in a site's (or installed-app instance's) Cloudflare
 * resource footprint by querying the CF GraphQL Analytics API and multiplying each usage attribute by
 * the published marginal unit price, then adds the flat $50/site platform fee. This implements the
 * cost-engine side of `docs/PRICING-MODEL.md` (components #1 Worker/D1/R2, #2 platform fee, #4
 * production R2-snapshot storage, #5 container compute stub). Owner-facing rollup surfaced by
 * `GET /api/sites/:id/cost` + `GET /api/apps/instances/:id/cost` (see `routes/site_cost.ts`).
 *
 * ## Isolation + auth
 *
 * - CF auth reuses the same account-scoped strategy as `cloudflare_analytics.ts` / `cloudflare_rum.ts`
 *   (Bearer `CF_API_TOKEN`, account id `CF_ACCOUNT_ID`, endpoint `.../client/v4/graphql`). Per-org
 *   stored credentials take precedence via {@link resolveCfCredentials}.
 * - A site's D1 database id is **server-resolved** from `site_database_allocations` (the SAME source
 *   `site_data_db.ts` uses) — never client-supplied. An instance's resources come from its
 *   `app_instances` row. The route layer proves ownership BEFORE calling either function.
 *
 * ## Fail-soft contract
 *
 * Every GraphQL call is best-effort: on any error / unavailable dataset the breakdown is returned with
 * `estimated: true` and zeroed usage for that component — this NEVER throws (a cost read must not 500
 * a dashboard). Per the global `fail-fast-build-fail-soft-prod` rule.
 *
 * @remarks NEVER logs the CF token or any secret.
 * @see {@link https://developers.cloudflare.com/analytics/graphql-api/}
 * @packageDocumentation
 */
import { z } from 'zod';

import type { Env } from '../types/env.js';

import { type CfAuth, cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { dbQueryOne } from './db.js';
import { FORBIDDEN_DB_IDS } from './site_data_db.js';
import { siteFunctionsScriptName } from './wfp_dispatch.js';

const CF_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
/** 8s bound per GraphQL call — mirrors `cloudflare_analytics.ts` (a hung egress must not stall the API). */
const CF_GRAPHQL_TIMEOUT_MS = 8000;

// ── Zod contract (component category maps 1:1 to the 10 charge components in PRICING-MODEL.md) ──────

/** Which of the 10 PRICING-MODEL.md charge components a line belongs to. */
export const CostCategorySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
]);

/** One priced usage line (e.g. Worker requests, D1 rows-read, R2 Class-A ops). */
export const CostComponentSchema = z.object({
  /** Stable machine key, e.g. `worker_requests`, `d1_rows_read`, `r2_class_a`. */
  key: z.string(),
  /** Human label for the bill, e.g. "Worker requests". */
  label: z.string(),
  /** The charge component (1-10) this line rolls up under. */
  category: CostCategorySchema,
  /** Metered usage quantity in the line's own unit (requests, ms, GB-mo, …). */
  usage: z.number().nonnegative(),
  /** The unit `usage` is expressed in, e.g. `requests`, `M-CPU-ms`, `GB-mo`, `flat`. */
  unit: z.string(),
  /** USD price per ONE `unit` (the marginal rate; hardcoded default in Wave 1). */
  unitPriceUsd: z.number().nonnegative(),
  /** Extended cost for this line = `usage / unitDivisor × unitPriceUsd`, in USD. */
  costUsd: z.number().nonnegative(),
});

/** Full itemized cost breakdown for one site or one installed-app instance over a period. */
export const SiteCostBreakdownSchema = z.object({
  components: z.array(CostComponentSchema),
  /** The flat $50/site platform fee (#2). Instances carry 0 (they roll up under their owning site). */
  platformFeeUsd: z.number().nonnegative(),
  /** Σ of every component `costUsd` + `platformFeeUsd`. */
  totalUsd: z.number().nonnegative(),
  currency: z.literal('USD'),
  /** The billing window this breakdown covers (ISO timestamps). */
  period: z.object({ from: z.string(), to: z.string() }),
  /** true when ANY usage figure is a best-effort fallback (GraphQL unavailable/errored). */
  estimated: z.boolean(),
});

/** Itemized cost breakdown — the response shape for both cost endpoints. */
export type SiteCostBreakdown = z.infer<typeof SiteCostBreakdownSchema>;
/** One priced usage line. */
export type CostComponent = z.infer<typeof CostComponentSchema>;

/** The billing window a cost query covers. */
export interface CostPeriod {
  /** ISO timestamp — window start (inclusive). */
  readonly from: string;
  /** ISO timestamp — window end (inclusive). */
  readonly to: string;
}

// ── Default unit prices (PRICING-MODEL.md "Unit prices" table — CF published marginal, NO base fee) ──

/**
 * The default marginal unit prices, hardcoded from `docs/PRICING-MODEL.md`.
 *
 * `divisor` normalises raw usage to the price's unit (e.g. Worker requests are priced per MILLION, so
 * `divisor: 1_000_000`). `costUsd = usage / divisor × priceUsd`.
 *
 * // TODO(pricing_engine): source from pricing_config in Wave 2 (Super-admin-editable per-attribute
 * // rates + AI % modifier + per-network per-post). Until then these defaults are the killswitch-safe
 * // floor and MUST stay in sync with the PRICING-MODEL.md table.
 */
export const DEFAULT_UNIT_PRICES = {
  workerRequests: { label: 'Worker requests', unit: 'requests', priceUsd: 0.3, divisor: 1_000_000 },
  workerCpu: { label: 'Worker CPU', unit: 'CPU-ms', priceUsd: 0.02, divisor: 1_000_000 },
  d1RowsRead: { label: 'D1 rows read', unit: 'rows', priceUsd: 0.001, divisor: 1_000_000 },
  d1RowsWritten: { label: 'D1 rows written', unit: 'rows', priceUsd: 1.0, divisor: 1_000_000 },
  d1Storage: { label: 'D1 storage', unit: 'GB-mo', priceUsd: 0.75, divisor: 1 },
  r2StorageStd: { label: 'R2 storage', unit: 'GB-mo', priceUsd: 0.015, divisor: 1 },
  r2ClassA: {
    label: 'R2 Class A (write/list)',
    unit: 'operations',
    priceUsd: 4.5,
    divisor: 1_000_000,
  },
  r2ClassB: { label: 'R2 Class B (read)', unit: 'operations', priceUsd: 0.36, divisor: 1_000_000 },
} as const;

/** The flat per-site platform fee (#2) — covers our absorbed CF base ($5 Workers Paid + $25 WfP). */
export const PLATFORM_FEE_USD = 50;

/**
 * The SHARED R2 bucket holding every site's versioned production snapshots under `sites/{slug}/…`
 * (#4). There is no `SITES_BUCKET_NAME` env var — the binding is `SITES_BUCKET` bound to
 * `project-sites-production` in prod (wrangler.toml). Hardcoded here so the snapshot-storage line can
 * meter it via the CF REST/GraphQL analytics plane (a binding can't be introspected for account-wide
 * storage totals). // TODO(pricing_engine): move to pricing_config / env in Wave 2.
 */
export const SITES_SNAPSHOT_BUCKET = 'project-sites-production';

/** GiB used to convert bytes → GB for storage lines. */
const BYTES_PER_GB = 1_000_000_000;

/** Round to whole cents to avoid floating-point noise. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build one priced component line from a raw usage figure + a {@link DEFAULT_UNIT_PRICES} entry. */
function priceLine(
  key: string,
  category: CostComponent['category'],
  usage: number,
  rate: { label: string; unit: string; priceUsd: number; divisor: number },
): CostComponent {
  const safeUsage = Number.isFinite(usage) && usage > 0 ? usage : 0;
  return {
    key,
    label: rate.label,
    category,
    usage: safeUsage,
    unit: rate.unit,
    unitPriceUsd: rate.priceUsd,
    costUsd: cents((safeUsage / rate.divisor) * rate.priceUsd),
  };
}

/** Default look-back window: the trailing 30 days (a monthly bill). */
function defaultPeriod(): CostPeriod {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// ── CF GraphQL usage probes (each fail-soft: returns zeros on any error) ─────────────────────────────

/** Raw Worker usage over a window (requests + CPU-ms), summed across the script's invocations. */
interface WorkerUsage {
  readonly requests: number;
  readonly cpuMs: number;
  readonly ok: boolean;
}
/** Raw D1 usage over a window for one database id. */
interface D1Usage {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly storageBytes: number;
  readonly ok: boolean;
}
/** Raw R2 usage over a window for one bucket. */
interface R2Usage {
  readonly classA: number;
  readonly classB: number;
  readonly storageBytes: number;
  readonly ok: boolean;
}

/**
 * Issue ONE account-scoped CF GraphQL query and return the parsed JSON, or `null` on any failure.
 * Never throws — the caller treats `null` as "dataset unavailable" and flags the breakdown estimated.
 *
 * @remarks Uses Bearer auth for token creds and the global-key header pair otherwise (per {@link CfAuth}).
 *   The token is sent ONLY in the request header and is NEVER logged.
 */
async function cfGraphql(
  auth: CfAuth,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(CF_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(CF_GRAPHQL_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'site_cost',
          event: 'graphql_http',
          status: res.status,
        }),
      );
      return null;
    }
    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'site_cost',
          event: 'graphql_errors',
          // Log messages only — never the query variables (could carry ids) or auth.
          messages: json.errors.map((e) => e.message).slice(0, 3),
        }),
      );
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'site_cost',
        event: 'graphql_threw',
        message: err instanceof Error ? err.message : 'unknown',
      }),
    );
    return null;
  }
}

/** First `accounts[0]` node from a CF GraphQL `viewer.accounts` response, or `null`. */
function firstAccount(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const viewer = data?.['viewer'] as { accounts?: Array<Record<string, unknown>> } | undefined;
  return viewer?.accounts?.[0] ?? null;
}

/** Sum a numeric field across an adaptive-groups row array (each row `{ sum: { <field>: n } }`). */
function sumField(rows: unknown, path: readonly string[]): number {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    let cur: unknown = row;
    for (const key of path) cur = (cur as Record<string, unknown> | undefined)?.[key];
    total += Number(cur ?? 0) || 0;
  }
  return total;
}

/** Query Worker requests + CPU-ms for one script over the window (`workersInvocationsAdaptive`). */
async function fetchWorkerUsage(
  auth: CfAuth,
  accountTag: string,
  scriptName: string,
  period: CostPeriod,
): Promise<WorkerUsage> {
  const query = /* GraphQL */ `
    query WorkerCost($a: String!, $s: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $a }) {
          workersInvocationsAdaptive(
            limit: 1000
            filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }
          ) {
            sum {
              requests
            }
            quantiles {
              cpuTimeP50
            }
          }
        }
      }
    }
  `;
  const data = await cfGraphql(auth, query, {
    a: accountTag,
    s: scriptName,
    from: period.from,
    to: period.to,
  });
  const account = firstAccount(data);
  if (!account) return { requests: 0, cpuMs: 0, ok: false };
  const rows = account['workersInvocationsAdaptive'];
  const requests = sumField(rows, ['sum', 'requests']);
  // `workersInvocationsAdaptive` reports CPU only as a per-invocation quantile (µs), not a sum. Approximate
  // total CPU-ms = median-per-request × requests (a Wave-1 estimate; refined in Wave 2 pricing_engine).
  const cpuMicrosP50 = Array.isArray(rows)
    ? ((rows[0] as { quantiles?: { cpuTimeP50?: number } } | undefined)?.quantiles?.cpuTimeP50 ?? 0)
    : 0;
  const cpuMs = (Number(cpuMicrosP50) / 1000) * requests;
  return { requests, cpuMs, ok: true };
}

/** Query D1 rows-read/written + storage for one database over the window (`d1AnalyticsAdaptiveGroups`). */
async function fetchD1Usage(
  auth: CfAuth,
  accountTag: string,
  databaseId: string,
  period: CostPeriod,
): Promise<D1Usage> {
  const query = /* GraphQL */ `
    query D1Cost($a: String!, $db: string!, $from: Date!, $to: Date!) {
      viewer {
        accounts(filter: { accountTag: $a }) {
          d1AnalyticsAdaptiveGroups(
            limit: 1000
            filter: { databaseId: $db, date_geq: $from, date_leq: $to }
          ) {
            sum {
              readQueries
              writeQueries
              rowsRead
              rowsWritten
            }
            max {
              databaseSizeBytes
            }
          }
        }
      }
    }
  `;
  // The D1 dataset filters by DATE (not datetime) — slice ISO → YYYY-MM-DD.
  const from = period.from.slice(0, 10);
  const to = period.to.slice(0, 10);
  const data = await cfGraphql(auth, query, { a: accountTag, db: databaseId, from, to });
  const account = firstAccount(data);
  if (!account) return { rowsRead: 0, rowsWritten: 0, storageBytes: 0, ok: false };
  const rows = account['d1AnalyticsAdaptiveGroups'];
  // Storage is a level (bytes at a point), not a sum — take the max observed over the window.
  let storageBytes = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const b =
        Number((row as { max?: { databaseSizeBytes?: number } }).max?.databaseSizeBytes ?? 0) || 0;
      if (b > storageBytes) storageBytes = b;
    }
  }
  return {
    rowsRead: sumField(rows, ['sum', 'rowsRead']),
    rowsWritten: sumField(rows, ['sum', 'rowsWritten']),
    storageBytes,
    ok: true,
  };
}

/** Query R2 Class-A/B operations for one bucket over the window (`r2OperationsAdaptiveGroups`). */
async function fetchR2Operations(
  auth: CfAuth,
  accountTag: string,
  bucketName: string,
  period: CostPeriod,
): Promise<{ classA: number; classB: number; ok: boolean }> {
  const query = /* GraphQL */ `
    query R2Ops($a: String!, $b: string!, $from: Date!, $to: Date!) {
      viewer {
        accounts(filter: { accountTag: $a }) {
          r2OperationsAdaptiveGroups(
            limit: 10000
            filter: { bucketName: $b, date_geq: $from, date_leq: $to }
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
            }
          }
        }
      }
    }
  `;
  const from = period.from.slice(0, 10);
  const to = period.to.slice(0, 10);
  const data = await cfGraphql(auth, query, { a: accountTag, b: bucketName, from, to });
  const account = firstAccount(data);
  if (!account) return { classA: 0, classB: 0, ok: false };
  const rows = account['r2OperationsAdaptiveGroups'];
  // Class A = mutating/list ops (Put/Post/List/Delete/Copy…); Class B = reads (Get/Head). CF groups by
  // `actionType`; bucket each action into A or B by name.
  const CLASS_B = new Set(['GetObject', 'HeadObject', 'ListBuckets', 'HeadBucket']);
  let classA = 0;
  let classB = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const action = String(
        (row as { dimensions?: { actionType?: string } }).dimensions?.actionType ?? '',
      );
      const n = Number((row as { sum?: { requests?: number } }).sum?.requests ?? 0) || 0;
      if (CLASS_B.has(action)) classB += n;
      else classA += n;
    }
  }
  return { classA, classB, ok: true };
}

/** Query R2 stored bytes for one bucket over the window (`r2StorageAdaptiveGroups`). */
async function fetchR2Storage(
  auth: CfAuth,
  accountTag: string,
  bucketName: string,
  period: CostPeriod,
): Promise<{ storageBytes: number; ok: boolean }> {
  const query = /* GraphQL */ `
    query R2Storage($a: String!, $b: string!, $from: Date!, $to: Date!) {
      viewer {
        accounts(filter: { accountTag: $a }) {
          r2StorageAdaptiveGroups(
            limit: 10000
            filter: { bucketName: $b, date_geq: $from, date_leq: $to }
          ) {
            max {
              objectCount
              payloadSize
            }
          }
        }
      }
    }
  `;
  const from = period.from.slice(0, 10);
  const to = period.to.slice(0, 10);
  const data = await cfGraphql(auth, query, { a: accountTag, b: bucketName, from, to });
  const account = firstAccount(data);
  if (!account) return { storageBytes: 0, ok: false };
  const rows = account['r2StorageAdaptiveGroups'];
  let storageBytes = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const b = Number((row as { max?: { payloadSize?: number } }).max?.payloadSize ?? 0) || 0;
      if (b > storageBytes) storageBytes = b;
    }
  }
  return { storageBytes, ok: true };
}

/** GB-months for `bytes` held over the window's day-count (CF prices storage per GB-month). */
function storageGbMonths(bytes: number, period: CostPeriod): number {
  const days = Math.max(1, (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000);
  const gb = bytes / BYTES_PER_GB;
  return gb * (days / 30);
}

// ── The 5-line compute-container stub (#5) — no readily-available dataset in Wave 1 ─────────────────

/**
 * A zero-cost placeholder line for Container compute (#5). CF Containers vCPU-sec/GiB-sec is not
 * exposed via the GraphQL Analytics API in Wave 1, so we emit an honest $0 line rather than block or
 * fabricate. // TODO(pricing_engine): source container compute from the Containers billing dataset in Wave 2.
 */
function containerComputeStub(): CostComponent {
  return {
    key: 'container_compute',
    label: 'Container compute (vCPU-sec + GiB-sec)',
    category: 5,
    usage: 0,
    unit: 'GiB-s',
    unitPriceUsd: 0.0000025,
    costUsd: 0,
  };
}

/** Resolve a site's OWN D1 database id from `site_database_allocations` (never a shared platform id). */
async function resolveSiteDatabaseId(env: Env, siteId: string): Promise<string | null> {
  const row = await dbQueryOne<{ d1_database_id: string | null }>(
    env.DB,
    `SELECT d1_database_id FROM site_database_allocations
       WHERE site_id = ? AND db_plan = 'd1_tenant_db' AND status = 'active' AND d1_database_id IS NOT NULL`,
    [siteId],
  );
  const id = row?.d1_database_id ?? null;
  // Defense-in-depth: a shared-platform id must never be metered as a customer's D1.
  return id && !FORBIDDEN_DB_IDS.has(id) ? id : null;
}

/** Resolve a site's OWN R2 bucket name from `site_database_allocations`, if one is allocated. */
async function resolveSiteBucketName(env: Env, siteId: string): Promise<string | null> {
  const row = await dbQueryOne<{ r2_bucket_name: string | null }>(
    env.DB,
    `SELECT r2_bucket_name FROM site_database_allocations
       WHERE site_id = ? AND r2_bucket_name IS NOT NULL`,
    [siteId],
  );
  return row?.r2_bucket_name ?? null;
}

/**
 * Assemble a full {@link SiteCostBreakdown} from resolved resource handles by pricing each usage
 * probe. Shared by both {@link computeSiteCost} and {@link computeInstanceCost}. Any probe that
 * reports `ok: false` (GraphQL unavailable) marks the whole breakdown `estimated: true`.
 *
 * @param opts.scriptName - the Worker script to meter (Worker requests + CPU), or null to skip
 * @param opts.databaseId - the D1 database id to meter (rows + storage), or null to skip
 * @param opts.bucketName - the R2 bucket to meter (ops + storage), or null to skip
 * @param opts.snapshotBucketName - the SHARED `sites/`-prefix production-snapshot bucket to meter (#4), or null
 * @param opts.platformFeeUsd - the flat platform fee (#2) to include ($50 for a site, 0 for an instance)
 * @param opts.includeContainerStub - whether to append the container-compute stub line (#5)
 */
async function assembleBreakdown(
  env: Env,
  auth: CfAuth,
  accountTag: string,
  period: CostPeriod,
  opts: {
    scriptName: string | null;
    databaseId: string | null;
    bucketName: string | null;
    snapshotBucketName?: string | null;
    platformFeeUsd: number;
    includeContainerStub: boolean;
  },
): Promise<SiteCostBreakdown> {
  const components: CostComponent[] = [];
  let anyProbeFailed = false;

  // Component #1 — Worker requests + CPU.
  if (opts.scriptName) {
    const w = await fetchWorkerUsage(auth, accountTag, opts.scriptName, period);
    anyProbeFailed ||= !w.ok;
    components.push(
      priceLine('worker_requests', 1, w.requests, DEFAULT_UNIT_PRICES.workerRequests),
    );
    components.push(priceLine('worker_cpu', 1, w.cpuMs, DEFAULT_UNIT_PRICES.workerCpu));
  }

  // Component #1 — D1 rows-read/written + storage.
  if (opts.databaseId) {
    const d = await fetchD1Usage(auth, accountTag, opts.databaseId, period);
    anyProbeFailed ||= !d.ok;
    components.push(priceLine('d1_rows_read', 1, d.rowsRead, DEFAULT_UNIT_PRICES.d1RowsRead));
    components.push(
      priceLine('d1_rows_written', 1, d.rowsWritten, DEFAULT_UNIT_PRICES.d1RowsWritten),
    );
    components.push(
      priceLine(
        'd1_storage',
        1,
        storageGbMonths(d.storageBytes, period),
        DEFAULT_UNIT_PRICES.d1Storage,
      ),
    );
  }

  // Component #1 — R2 ops + storage for the site's OWN bucket.
  if (opts.bucketName) {
    const [ops, store] = await Promise.all([
      fetchR2Operations(auth, accountTag, opts.bucketName, period),
      fetchR2Storage(auth, accountTag, opts.bucketName, period),
    ]);
    anyProbeFailed ||= !ops.ok || !store.ok;
    components.push(priceLine('r2_class_a', 1, ops.classA, DEFAULT_UNIT_PRICES.r2ClassA));
    components.push(priceLine('r2_class_b', 1, ops.classB, DEFAULT_UNIT_PRICES.r2ClassB));
    components.push(
      priceLine(
        'r2_storage',
        1,
        storageGbMonths(store.storageBytes, period),
        DEFAULT_UNIT_PRICES.r2StorageStd,
      ),
    );
  }

  // Component #4 — production R2-snapshot storage under the shared `sites/` prefix.
  if (opts.snapshotBucketName) {
    const snap = await fetchR2Storage(auth, accountTag, opts.snapshotBucketName, period);
    anyProbeFailed ||= !snap.ok;
    components.push(
      priceLine('r2_snapshot_storage', 4, storageGbMonths(snap.storageBytes, period), {
        ...DEFAULT_UNIT_PRICES.r2StorageStd,
        label: 'Production snapshot storage (sites/)',
      }),
    );
  }

  // Component #5 — container compute stub (no dataset in Wave 1).
  if (opts.includeContainerStub) components.push(containerComputeStub());

  const componentsTotal = components.reduce((sum, c) => sum + c.costUsd, 0);
  const breakdown: SiteCostBreakdown = {
    components,
    platformFeeUsd: cents(opts.platformFeeUsd),
    totalUsd: cents(componentsTotal + opts.platformFeeUsd),
    currency: 'USD',
    period: { from: period.from, to: period.to },
    estimated: anyProbeFailed,
  };
  // Validate our own output at the boundary; parse throws only on a coding bug (never on live data),
  // so it's safe here — the fail-soft path already guarantees a well-formed object.
  return SiteCostBreakdownSchema.parse(breakdown);
}

/** A fully-estimated empty breakdown — returned when CF auth/account is unavailable (never throws). */
function emptyEstimated(period: CostPeriod, platformFeeUsd: number): SiteCostBreakdown {
  return {
    components: [containerComputeStub()],
    platformFeeUsd: cents(platformFeeUsd),
    totalUsd: cents(platformFeeUsd),
    currency: 'USD',
    period: { from: period.from, to: period.to },
    estimated: true,
  };
}

/**
 * Compute the itemized monthly cost breakdown for one SITE.
 *
 * Meters the site's namespaced resources — its dispatched Worker (`siteFunctionsScriptName`), its OWN
 * per-site D1 (`site_database_allocations.d1_database_id`), its OWN per-site R2 bucket, plus the shared
 * `sites/`-prefix production-snapshot storage (#4) — and adds the flat $50 platform fee (#2). The caller
 * MUST have proven the requester owns `siteId` (route-level `assertSiteOwned`) before calling this.
 *
 * @param env - Worker env (needs `DB`, `CF_ACCOUNT_ID`, CF creds source).
 * @param siteId - the OWNED site id (server-resolved to resources; never a client-supplied CF id).
 * @param period - the billing window; defaults to the trailing 30 days when omitted.
 * @returns a {@link SiteCostBreakdown}; `estimated: true` when any CF probe was unavailable. Never throws.
 * @example
 * const cost = await computeSiteCost(c.env, siteId);
 * // → { components: [...], platformFeeUsd: 50, totalUsd: 51.23, currency: 'USD', period: {...}, estimated: false }
 */
export async function computeSiteCost(
  env: Env,
  siteId: string,
  period: CostPeriod = defaultPeriod(),
): Promise<SiteCostBreakdown> {
  // Org for stored-cred precedence: the site's owning org (falls back to the bundled worker key).
  const site = await dbQueryOne<{ org_id: string | null }>(
    env.DB,
    'SELECT org_id FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  const orgId = site?.org_id ?? null;

  const auth = await resolveCfCredentials(env, orgId);
  const accountTag = env.CF_ACCOUNT_ID;
  if (!auth || !accountTag) return emptyEstimated(period, PLATFORM_FEE_USD);

  const [databaseId, bucketName] = await Promise.all([
    resolveSiteDatabaseId(env, siteId),
    resolveSiteBucketName(env, siteId),
  ]);

  return assembleBreakdown(env, auth, accountTag, period, {
    scriptName: siteFunctionsScriptName(siteId),
    databaseId,
    bucketName,
    // #4 — versioned production snapshots live under `sites/{slug}/…` in the shared sites bucket.
    snapshotBucketName: SITES_SNAPSHOT_BUCKET,
    platformFeeUsd: PLATFORM_FEE_USD,
    includeContainerStub: true,
  });
}

/**
 * Compute the itemized monthly cost breakdown for one installed-app INSTANCE (a sub-site like Payload
 * or Umami, metered the SAME way under its own namespaced resources — PRICING-MODEL.md §"Philosophy").
 *
 * Reads the instance's own resource handles from its `app_instances` row (`worker_script_name`,
 * `d1_database_id`, `r2_bucket_name`) and prices them. An instance carries NO platform fee — it rolls
 * up under its owning site's bill (which already charges the $50). The caller MUST have proven the
 * requester owns the instance's org before calling this.
 *
 * @param env - Worker env (needs `DB`, `CF_ACCOUNT_ID`, CF creds source).
 * @param instanceId - the OWNED app-instance id (server-resolved to resources; never a client CF id).
 * @param period - the billing window; defaults to the trailing 30 days when omitted.
 * @returns a {@link SiteCostBreakdown}; `estimated: true` when any CF probe was unavailable. Never throws.
 * @example
 * const cost = await computeInstanceCost(c.env, instanceId);
 * // → { components: [...], platformFeeUsd: 0, totalUsd: 3.41, currency: 'USD', period: {...}, estimated: false }
 */
export async function computeInstanceCost(
  env: Env,
  instanceId: string,
  period: CostPeriod = defaultPeriod(),
): Promise<SiteCostBreakdown> {
  const instance = await dbQueryOne<{
    org_id: string | null;
    worker_script_name: string | null;
    d1_database_id: string | null;
    r2_bucket_name: string | null;
  }>(
    env.DB,
    `SELECT org_id, worker_script_name, d1_database_id, r2_bucket_name
       FROM app_instances WHERE id = ? AND deleted_at IS NULL`,
    [instanceId],
  );

  const auth = await resolveCfCredentials(env, instance?.org_id ?? null);
  const accountTag = env.CF_ACCOUNT_ID;
  // Instances carry no platform fee (#2 is charged once, on the owning site).
  if (!auth || !accountTag) return emptyEstimated(period, 0);

  const databaseId =
    instance?.d1_database_id && !FORBIDDEN_DB_IDS.has(instance.d1_database_id)
      ? instance.d1_database_id
      : null;

  return assembleBreakdown(env, auth, accountTag, period, {
    scriptName: instance?.worker_script_name ?? null,
    databaseId,
    bucketName: instance?.r2_bucket_name ?? null,
    snapshotBucketName: null,
    platformFeeUsd: 0,
    includeContainerStub: true,
  });
}
