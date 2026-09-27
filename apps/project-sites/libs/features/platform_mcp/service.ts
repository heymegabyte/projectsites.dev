/**
 * @module libs/features/platform_mcp/service
 * @description Business logic for the platform MCP server — the tool catalog and
 * the dispatcher. Tools are scoped to ONE org (the authenticated API token's
 * org) so a Claude-Code/Cursor/any-MCP-client user only ever sees + acts on
 * their own sites. Auth is enforced in handlers.ts (verifyApiToken → orgId);
 * this layer trusts the orgId it is handed and scope-gates each tool.
 *
 * @remarks v1 ships the READ tools (genuinely useful + safe for an external
 * agent): whoami, list_sites, get_site, get_build_status. The WRITE tools
 * (deploy_site, create_site) are specified in README.md + ROADMAP and wired in
 * the next slice — advertised there, NOT here, so we never return a fake
 * success from an unwired tool.
 */
import { DOMAINS } from '@project-sites/shared';
import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne, dbExecute, dbInsert } from '../../../src/services/db.js';
import type { ApiTokenRow } from '../../../src/services/api_tokens.js';
import { hasScope } from '../../../src/services/api_tokens.js';
import { provisionCustomDomain, checkCnameTarget } from '../../../src/services/domains.js';
import { getOrgEntitlements } from '../../../src/services/billing.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import {
  isSafeIdent,
  listSiteTables,
  quoteIdent,
  resolveSiteDataDb,
  SiteDataD1Error,
} from '../../../src/services/site_data_db.js';
import { listResources, resolveResourceRef } from '../data_resource_registry/service.js';
import { d1Adapter } from '../data_resource_registry/adapters/d1.js';
import { readQueryHistory } from '../data_resource_registry/query_history.js';
import { kvAdapter } from '../data_resource_registry/adapters/kv.js';
import { r2Adapter } from '../data_resource_registry/adapters/r2.js';
import { vectorizeAdapter } from '../data_resource_registry/adapters/vectorize.js';
import { connectionAdapter } from '../data_resource_registry/adapters/connection.js';
import { workflowAdapter } from '../data_resource_registry/adapters/workflow.js';
import { durableObjectAdapter } from '../data_resource_registry/adapters/durable_object.js';
import { queueAdapter } from '../data_resource_registry/adapters/queue.js';
import { analyticsEngineAdapter } from '../data_resource_registry/adapters/analytics_engine.js';
import { resolveCfCredentials } from '../../../src/services/cf_credentials.js';
import {
  ListSitesInput,
  GetSiteInput,
  BuildStatusInput,
  DeploySiteInput,
  TailLogsInput,
  SetDomainInput,
  DataListResourcesInput,
  DataReconcileResourcesInput,
  DataListTablesInput,
  DataReadTableInput,
  DataD1ExecInput,
  DataD1ExplainInput,
  DataD1MigrationsInput,
  DataD1QueryHistoryInput,
  DataD1TimeTravelInfoInput,
  DataD1RestoreInput,
  DataKvListKeysInput,
  DataKvGetInput,
  DataKvPutInput,
  DataKvDeleteInput,
  DataKvBulkGetInput,
  DataKvBulkDeleteInput,
  DataR2ListObjectsInput,
  DataR2HeadObjectInput,
  DataR2PutObjectInput,
  DataR2DeleteObjectInput,
  DataR2MultipartCreateInput,
  DataR2MultipartCompleteInput,
  DataR2MultipartAbortInput,
  DataR2BucketConfigInput,
  DataR2PreviewUrlInput,
  DataVectorizeListInput,
  DataVectorizeDescribeInput,
  DataVectorizeUpsertInput,
  DataVectorizeDeleteInput,
  DataConnectionsListInput,
  DataConnectionDescribeInput,
  DataWorkflowsListInput,
  DataWorkflowGetInstanceInput,
  DataWorkflowStartInput,
  DataWorkflowControlInput,
  DataDurableObjectsListInput,
  DataDurableObjectDescribeInput,
  DataDurableObjectManageInput,
  DataQueuesListInput,
  DataQueueDescribeInput,
  DataQueueSendInput,
  DataAnalyticsListInput,
  DataAnalyticsQuerySummaryInput,
  DataBackendInventoryInput,
  DataProvisionResourceInput,
} from './schemas.js';
import { getBackendInventory } from '../data_resource_registry/backend_inventory.js';
import { provisionResource } from '../data_resource_registry/service.js';

/** Flag gating the Data & Resource Platform MCP tools (registry read surface). */
const DATA_RESOURCE_FLAG = 'data_resource_platform';

/**
 * Flag gating the per-site D1 READ tools — the SAME flag the `/api/sites/:id/db/tables` endpoint
 * uses (`site_db_handlers.ts`). DARK → the tools err (mirroring the endpoint's 404), never leak.
 */
const PER_SITE_DATA_FLAG = 'per_site_data';

/**
 * Flag gating the per-site KV READ tools — the reserved `per_site_kv` flag (CAPABILITY-MATRIX.md /
 * SECURITY-INVARIANTS.md INV-10). DARK → the tools err (mirroring the Data-tab KV surface's 404),
 * never leak. Per-site KV provisioning is backend-ready but INERT, so a blank site resolves no
 * namespace → the tools honestly report the namespace is not provisioned.
 */
const PER_SITE_KV_FLAG = 'per_site_kv';

/**
 * Flag gating the per-site R2 READ tools — the reserved `per_site_r2` flag (CAPABILITY-MATRIX.md /
 * SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the Data-tab R2 surface's 404), never leak.
 * Per-site R2 provisioning is backend-ready (`r2_provisioner.ts`) but INERT, so a blank site resolves no
 * bucket → the tools honestly report the bucket is not provisioned. Mirrors `PER_SITE_KV_FLAG` exactly —
 * both are runtime gate CONSTANTS (referenced via the constant, so the orphan-flag-gate checker, which
 * only scans literal `isFlagOn(env,'x')` strings, does not require a registry row).
 */
const PER_SITE_R2_FLAG = 'per_site_r2';

/**
 * Flag gating the per-site Vectorize READ tools — the reserved `per_site_vectorize` flag
 * (CAPABILITY-MATRIX.md / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the Data-tab Vectorize
 * surface's 404), never leak. Per-site Vectorize is a metadata NAMESPACE inside the SHARED index (not a
 * dedicated index — namespace ≠ quota); per-site Vectorize provisioning is NOT wired yet (the reconciler
 * records no vectorize allocation source), so a blank site resolves no `vectorize` registry row → the tools
 * honestly report the namespace is not provisioned. Mirrors `PER_SITE_R2_FLAG` exactly — a runtime gate
 * CONSTANT (referenced via the constant, so the orphan-flag-gate checker, which only scans literal
 * `isFlagOn(env,'x')` strings, does not require a registry row).
 */
const PER_SITE_VECTORIZE_FLAG = 'per_site_vectorize';

/**
 * Flag gating the per-site Connections READ tools — the reserved `per_site_connections` flag
 * (CAPABILITY-MATRIX.md / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the Data-tab Connections
 * surface's 404), never leak. A connection is NOT a CF account object (it lives in `mcp_connections`); a
 * blank site simply has no connection rows → the tools honestly report zero connections. Mirrors
 * `PER_SITE_R2_FLAG` exactly — a runtime gate CONSTANT (referenced via the constant, so the
 * orphan-flag-gate checker, which only scans literal `isFlagOn(env,'x')` strings, does not require a
 * registry row). ⛔ These tools NEVER return a secret/token/connection-string — only id/name/type/
 * masked-host/status.
 */
const PER_SITE_CONNECTIONS_FLAG = 'per_site_connections';

/**
 * Flag gating the per-site Workflows READ tools — the reserved `per_site_workflows` flag
 * (CAPABILITY-MATRIX.md § Workflows / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the Backend-tab
 * Workflows surface's 404), never leak. Workflows are `shared_platform` (code-deployed definitions), NOT
 * per-site — there is no CF API to create a per-site workflow definition; per-site workflow provisioning is
 * NOT wired (the reconciler records no workflow allocation source), so a blank site resolves no `workflow`
 * registry row → the tools honestly report the workflow is not provisioned. Mirrors `PER_SITE_R2_FLAG`
 * exactly — a runtime gate CONSTANT (referenced via the constant, so the orphan-flag-gate checker, which only
 * scans literal `isFlagOn(env,'x')` strings, does not require a registry row). The tools NEVER optimistically
 * claim a run finished — they surface the ACTUAL CF instance status.
 */
const PER_SITE_WORKFLOWS_FLAG = 'per_site_workflows';

/**
 * Flag gating the per-site Durable Objects READ tools — the reserved `per_site_durable_objects` flag
 * (CAPABILITY-MATRIX.md § Durable Objects / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the
 * Backend-tab Durable Objects surface's 404), never leak. Only `SITE_BUILDER` is bound; there is NO per-site
 * DO namespace (the reconciler records no durable_object allocation source), so a blank site resolves no
 * `durable_object` registry row → the tools honestly report it is not provisioned. Mirrors
 * `PER_SITE_R2_FLAG` exactly — a runtime gate CONSTANT (referenced via the constant, so the orphan-flag-gate
 * checker, which only scans literal `isFlagOn(env,'x')` strings, does not require a registry row). ⛔ These
 * tools list NAMESPACES (classes), NEVER instances (CF cannot enumerate them), and `describe` returns
 * identity metadata ONLY — never a DO's private storage or in-memory state (no CF API can read it).
 */
const PER_SITE_DURABLE_OBJECTS_FLAG = 'per_site_durable_objects';

/**
 * Flag gating the per-site Queues READ tools — the reserved `per_site_queues` flag (CAPABILITY-MATRIX.md
 * § Queues / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the Backend-tab Queues surface's 404),
 * never leak. Queues are UNSUPPORTED on this deployment — there is NO `QUEUE` binding (the code falls back to
 * Workflows), and `queue` is in `UNSUPPORTED_KINDS` so `resolveResourceRef` returns `unsupported_kind`; a
 * blank site records no queue allocation source, so it resolves no `queue` registry row → the tools honestly
 * report Queues are not available / the queue is not provisioned. Mirrors `PER_SITE_R2_FLAG` exactly — a
 * runtime gate CONSTANT (referenced via the constant, so the orphan-flag-gate checker, which only scans
 * literal `isFlagOn(env,'x')` strings, does not require a registry row). ⛔ These tools surface CONFIG +
 * METRICS only (consumers/delivery-retry/DLQ/backlog/paused), NEVER a message body or a "history" (peek ≠
 * history, HARD FACT #1); the future pull verb LEASES + needs ack (HARD FACT #2) — never a browse. A caller
 * can NEVER peek/ack/purge another site's messages — it only ever addresses the ONE server-resolved queue.
 */
const PER_SITE_QUEUES_FLAG = 'per_site_queues';

/**
 * Flag gating the per-site Observability (Analytics Engine) READ tools — the reserved `per_site_observability`
 * flag (CAPABILITY-MATRIX.md § Analytics Engine / SECURITY-INVARIANTS.md). DARK → the tools err (mirroring the
 * Backend-tab Observability surface's 404), never leak. Analytics Engine INGEST is DISABLED on this deployment
 * (`ANALYTICS_INGEST_ENABLED="false"`) so the tools honestly report `available:false` (no events ingested yet),
 * NEVER a fabricated event stream; the dataset is `shared_platform` (one shared `projectsites_admin_v1`, NOT
 * per-site) and the reconciler records no analytics_engine allocation source, so a blank site resolves no
 * `analytics_engine` registry row → Observability is a cross-cutting Worker-level section (not a per-store row).
 * Mirrors `PER_SITE_QUEUES_FLAG` exactly — a runtime gate CONSTANT (referenced via the constant, so the
 * orphan-flag-gate checker, which only scans literal `isFlagOn(env,'x')` strings, does not require a registry
 * row). ⛔ The summary query is SERVER-BUILT + site-scoped (`WHERE blob3 = <siteId>`) — a caller supplies ONLY
 * site_id + an optional window, NEVER a raw query, so one site can never read another's analytics.
 */
const PER_SITE_OBSERVABILITY_FLAG = 'per_site_observability';

/** Mirrors DOMAINS.SITES_SUFFIX — the public site subdomain suffix. */
const SITES_SUFFIX = '.projectsites.dev';

/** Content-type by extension (mirrors the /api/publish/bolt handler). */
const MIME: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  xml: 'application/xml',
  txt: 'text/plain',
  webmanifest: 'application/manifest+json',
};

/**
 * Publish a set of files to a site: write each to R2 under
 * `sites/{slug}/{version}/`, update `_manifest.json` so serving points at the new
 * version, bust the KV host cache. Mirrors the proven `/api/publish/bolt` path
 * (kept colocated so deploy_site reuses it without touching the hot route).
 */
async function publishSiteFiles(
  env: Env,
  slug: string,
  files: Array<{ path: string; content: string }>,
): Promise<{ url: string; version: string; files: number }> {
  const version = new Date().toISOString().replace(/[:.]/g, '-');
  const puts: Promise<unknown>[] = files.map((f) => {
    // Defense-in-depth: callers validate via DeploySiteInput, but never let a
    // path escape the site/version prefix even if a future caller forgets to.
    const rel = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg.length === 0)) {
      throw new Error(`Unsafe file path rejected: ${f.path}`);
    }
    const ext = rel.split('.').pop()?.toLowerCase() ?? '';
    return env.SITES_BUCKET.put(`sites/${slug}/${version}/${rel}`, f.content, {
      httpMetadata: { contentType: MIME[ext] ?? 'application/octet-stream' },
    });
  });
  puts.push(
    env.SITES_BUCKET.put(
      `sites/${slug}/_manifest.json`,
      JSON.stringify({
        current_version: version,
        slug,
        updated_at: new Date().toISOString(),
        source: 'platform_mcp',
      }),
      { httpMetadata: { contentType: 'application/json' } },
    ),
  );
  await Promise.all(puts);
  await env.CACHE_KV.delete(`host:${slug}${SITES_SUFFIX}`);
  return { url: `https://${slug}${SITES_SUFFIX}`, version, files: files.length };
}

/** Flag key gating the whole platform MCP surface. */
export const FLAG_KEY = 'mcp_server';

/** MCP content-block result (text). */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const err = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * The advertised tool catalog (`tools/list`). Only IMPLEMENTED tools are listed
 * so an agent never calls a tool that can't run. `requiredScope` is checked in
 * dispatch before the handler runs.
 */
export const PLATFORM_MCP_TOOLS = [
  {
    name: 'whoami',
    description:
      'Return the org + token identity (scopes) the connected API key resolves to. Use first to confirm the connection.',
    requiredScope: 'sites:read' as const,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_sites',
    description:
      'List the websites in your projectsites.dev account (id, slug, name, status, hostname).',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 100, default: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_site',
    description: 'Get one site by id: status, primary hostname, plan, last build.',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string' } },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_build_status',
    description:
      'Get the AI build/workflow status + step for a site (poll while a generation runs).',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string' } },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_audit_log',
    description:
      'Recent audit-log actions for a site (deploys, edits, config changes) — inspect what happened.',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_site',
    description:
      'Deploy files to one of your sites from your editor: writes them to R2, points the site at the new version, busts cache, returns the live URL AND a stable version-pinned preview_url. files = [{path, content}] (the built dist of your app).',
    requiredScope: 'sites:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        files: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['site_id', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_site',
    description:
      'Create a new empty site in your account (draft). Returns site_id + slug + URL; then deploy_site with your built files to publish.',
    requiredScope: 'sites:write' as const,
    inputSchema: {
      type: 'object',
      properties: { business_name: { type: 'string' }, slug: { type: 'string' } },
      required: ['business_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_snapshots',
    description: 'List saved snapshots for a site (id, name, build version, description, date).',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string' } },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_research',
    description:
      'Return the AI research data collected for a site (business profile, brand, selling points).',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string' } },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tail_logs',
    description:
      'Return recent build/workflow log entries for a site (newest-first) to debug deploys.',
    requiredScope: 'sites:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_domain',
    description:
      'Connect a custom domain (hostname) to one of your sites. Requires a paid plan + a DNS CNAME from the hostname to projectsites.dev set BEFOREHAND. Returns provisioning status + SSL state.',
    requiredScope: 'sites:write' as const,
    inputSchema: {
      type: 'object',
      properties: { site_id: { type: 'string' }, hostname: { type: 'string' } },
      required: ['site_id', 'hostname'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_list_resources',
    description:
      "List the Cloudflare resources (D1, KV, R2, Durable Objects, Workflows, Vectorize, Analytics Engine, connections) allocated to one of your sites — from the authoritative registry, per environment. Honestly empty until the registry is reconciled. You name only the site_id + environment, never a Cloudflare id.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_reconcile_resources',
    description:
      "Reconcile the resource registry for one of your sites and report drift per resource kind (missing-on-CF, id mismatch, binding mismatch, orphan-on-CF). Returns each kind's registered count, last-sync time, and any drift codes. Scoped to the site_id you own + environment.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_list_tables',
    description:
      "List the tables in one of your sites' OWN dedicated database (the same per-site D1 the editor's Data tab shows). Blank until you create tables. You name only the site_id (+ optional environment) — never a database id; the database is resolved server-side and is isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_read_table',
    description:
      "Read rows from one table in your site's OWN database (paginated: limit 1-200, offset). Returns the column schema, the rows, and the total row count. Scoped to the site_id you own; the database is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        table: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'number', minimum: 0, default: 0 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'table'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_exec',
    description:
      "Run ONE PARAMETERIZED SQL statement against your site's OWN dedicated database (the same per-site D1 the editor's Data tab manages). Pass positional params for bound VALUES (?) — identifiers (table/column names) can't be parameterized, so name them directly in the sql. Returns { effect, destructive, rows, rowsRead, rowsWritten, changedDb }. ⚠️ The statement is CLASSIFIED honestly by its leading keyword: a data-MUTATING statement (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE) — or one whose effect can't be verified read-only — REQUIRES confirm:true; without it you get an error REPORTING the detected kind and NOTHING runs (a plain SELECT/PRAGMA/EXPLAIN needs no confirm). A DESTRUCTIVE statement (DROP/TRUNCATE/ALTER/DELETE-without-WHERE) is additionally flagged and the error notes D1 Time Travel (30-day point-in-time recovery) as the rollback path. This is best-effort classification, NOT a sandbox — D1's rowsWritten is the ground truth of what changed. Only ONE statement per call. You name only the site_id + sql (+ optional params/confirm/environment) — never a database id; the database is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        sql: { type: 'string', maxLength: 100000 },
        params: { type: 'array', maxItems: 100 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_explain',
    description:
      "Get the QUERY PLAN for a read statement against your site's OWN dedicated database — run EXPLAIN QUERY PLAN <sql> to see how D1/SQLite will execute it (index use, scans, joins). Pass positional params for bound VALUES (?) — identifiers can't be parameterized. Returns { effect, plan:[{id,parent,detail}], duration_ms }. ⚠️ READ-ONLY: this ONLY explains a read (SELECT / WITH…SELECT / VALUES) statement — a data-mutating statement (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/…) is REFUSED with an error and NOTHING runs (use data_d1_exec to run a write). No confirm needed. You name only the site_id + sql (+ optional params/environment) — never a database id; the database is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        sql: { type: 'string', maxLength: 100000 },
        params: { type: 'array', maxItems: 100 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_migrations',
    description:
      "List the applied database migrations for your site's OWN dedicated database (read from the d1_migrations table). Returns { table_present, migrations:[{id,name,applied_at}], duration_ms }, newest-first. A brand-new site database that was never migrated has no d1_migrations table → an honest table_present:false with an empty list (never an error, never a fabricated history). READ-ONLY, no confirm. You name only the site_id (+ optional environment) — never a database id; the database is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_query_history',
    description:
      "List the RECENT query history for your site's OWN dedicated database — every data_d1_exec / data_d1_explain run records its STATEMENT TEMPLATE (the SQL with its ? placeholders) plus the effect (read_only/mutating/destructive/unknown), timing, rows read/written, and ok/error. ⚠️ Bound parameter VALUES are NEVER stored — only the template — so nothing sensitive (PII, secrets) is retained. Optionally filter by environment and pass a limit (clamped to 1-200, default 25). Returns { entries:[{id,statement_kind,sql_text,duration_ms,rows_read,rows_written,ok,error_code,created_at}], count }, newest-first. Honestly empty until you run a query. READ-ONLY, no confirm. You name only the site_id (+ optional limit/environment) — never a database id; the history is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 200, default: 25 },
        environment: { type: 'string', enum: ['preview', 'production'] },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_time_travel_info',
    description:
      "Read the current Time Travel backup bookmark for your site's OWN dedicated database, plus the point-in-time-recovery window (30 days on the paid plan). D1 Time Travel continuously backs up the database — no snapshots to configure. Optionally pass an ISO 8601 timestamp to get the nearest bookmark AT OR BEFORE that instant (the exact point data_d1_restore would restore to). Returns { available, bookmark, as_of, retention_days, duration_ms }. READ-ONLY, no confirm. You name only the site_id (+ optional timestamp/environment) — never a database id; the database is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        timestamp: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_d1_restore',
    description:
      "Restore your site's OWN dedicated database to an earlier point in time via D1 Time Travel. ⚠️ DESTRUCTIVE + WHOLE-DATABASE: EVERY table is reverted to the target and any changes made after it are permanently lost — this requires confirm:true, and without it you get a warning REPORTING that it is a whole-database restore within the 30-day recovery window and NOTHING runs. Provide EXACTLY ONE target: a bookmark (from data_d1_time_travel_info) OR an ISO 8601 timestamp (not both, not neither). Returns { restored, bookmark, previous_bookmark, message } — previous_bookmark is the undo handle (restore to it to reverse this restore). You name only the site_id + target (+ confirm/environment) — never a database id; the database is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        bookmark: { type: 'string' },
        timestamp: { type: 'string' },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_list_keys',
    description:
      "List keys in one of your sites' OWN dedicated KV namespace (the same per-site KV the editor's Data tab shows). Cursor-paginated: pass the returned cursor for the next page; list_complete tells you when there are no more (no fake total). Optional prefix filter. You name only the site_id (+ optional environment) — never a KV namespace id; the namespace is resolved server-side and isolated to your site. Honest 'not provisioned' until your site has a KV namespace.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        prefix: { type: 'string', maxLength: 512 },
        cursor: { type: 'string', maxLength: 2048 },
        limit: { type: 'number', minimum: 1, maximum: 1000, default: 100 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_get',
    description:
      "Read one key's value + metadata from your site's OWN KV namespace. Returns { found, value, metadata }; a missing key is an honest found:false (KV is eventually-consistent — a just-written key can 404 briefly). Scoped to the site_id you own; the namespace is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 512 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_put',
    description:
      "Write ONE key's value to your site's OWN dedicated KV namespace (optional expiration_ttl in seconds — CF minimum 60 — and an optional metadata object). Returns { key, overwritten, expirationTtl?, metadataStored }. ⚠️ DESTRUCTIVE OVERWRITE GUARD: writing over an EXISTING key overwrites its current value, so it REQUIRES confirm:true — without confirm on an existing key you get an error that REPORTS the key + that it already exists and NOTHING is written (a brand-new key needs no confirm). You name only the site_id + key + value (+ optional environment) — never a KV namespace id; the namespace is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 512 },
        value: { type: 'string' },
        expiration_ttl: { type: 'number', minimum: 60 },
        metadata: { type: 'object' },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_delete',
    description:
      "Delete ONE key from your site's OWN dedicated KV namespace. Returns { key, existed }. ⚠️ DESTRUCTIVE: this permanently removes the key's value, so it REQUIRES confirm:true — without confirm you get an error that REPORTS the key + whether it currently exists and NOTHING is deleted. Delete is idempotent: removing an already-absent key is an honest existed:false success. You name only the site_id + key (+ optional environment) — never a KV namespace id; the namespace is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 512 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_bulk_get',
    description:
      "Read MANY keys' values at once from your site's OWN dedicated KV namespace (batched companion of data_kv_get). Pass a keys[] array; returns { values:[{key,found,value?}], found, missing, clamped_off }. Each requested key gets an honest result — a missing key is found:false (never an error). The list is CLAMPED to the CF bulk cap of 10,000 keys (a read is non-destructive); clamped_off reports how many past the cap were dropped. You name only the site_id + keys (+ optional environment) — never a KV namespace id; the namespace is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string', maxLength: 512 }, minItems: 1 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_kv_bulk_delete',
    description:
      "Delete MANY keys at once from your site's OWN dedicated KV namespace in one bulk request (batched companion of data_kv_delete). Pass a keys[] array; returns { requested }. ⚠️ DESTRUCTIVE: this permanently removes those keys' values, so it REQUIRES confirm:true — without confirm you get an error that REPORTS the COUNT that would be removed and NOTHING is deleted. Over the CF bulk cap of 10,000 keys is REJECTED (never silently truncated — split into smaller batches). You name only the site_id + keys (+ optional environment) — never a KV namespace id; the namespace is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string', maxLength: 512 }, minItems: 1 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_list_objects',
    description:
      "List objects in one of your sites' OWN dedicated R2 bucket (the same per-site R2 the editor's Data tab shows — your object store, NOT the platform's deployed-site static assets). Continuation-token paginated: pass the returned cursor for the next page; truncated tells you when there are more (no fake total). Optional prefix filter. You name only the site_id (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site. Honest 'not provisioned' until your site has an R2 bucket.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        prefix: { type: 'string', maxLength: 1024 },
        cursor: { type: 'string', maxLength: 4096 },
        limit: { type: 'number', minimum: 1, maximum: 1000, default: 100 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_head_object',
    description:
      "Read ONE object's METADATA (size, etag, content-type, uploaded time, http + custom metadata) from your site's OWN R2 bucket. Returns { found, size, etag, contentType, ... } — metadata ONLY, never the object bytes (a large download uses a signed URL, a later capability). A missing object is an honest found:false. Scoped to the site_id you own; the bucket is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_put_object',
    description:
      "Write ONE SMALL object's bytes to your site's OWN dedicated R2 bucket (your object store, NOT the platform's deployed-site static assets), with an optional content_type + http_metadata + custom_metadata. Returns { key, overwritten, contentType, metadataStored }. ⚠️ DESTRUCTIVE OVERWRITE GUARD: writing over an EXISTING object overwrites it, so it REQUIRES confirm:true — without confirm on an existing key you get an error that REPORTS the key + that it already exists and NOTHING is written (a brand-new object needs no confirm). ⛔ LARGE / multipart objects are NOT accepted inline — a body over the inline cap is rejected with a note that a short-lived SCOPED (signed) upload URL is required (a later capability); this tool never embeds large bytes. You name only the site_id + key + body (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        body: { type: 'string' },
        content_type: { type: 'string', maxLength: 256 },
        http_metadata: { type: 'object' },
        custom_metadata: { type: 'object' },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_delete_object',
    description:
      "Delete ONE object from your site's OWN dedicated R2 bucket. Returns { key, existed }. ⚠️ DESTRUCTIVE: this permanently removes the object, so it REQUIRES confirm:true — without confirm you get an error that REPORTS the key + whether it currently exists and NOTHING is deleted. Delete is idempotent: removing an already-absent object is an honest existed:false success. You name only the site_id + key (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_multipart_create',
    description:
      "BEGIN a multipart upload for ONE LARGE object in your site's OWN dedicated R2 bucket (for objects too big for data_r2_put_object's inline cap). Returns { upload_id, partTransport, limits } — thread the upload_id through part uploads + data_r2_multipart_complete. ⛔ LARGE PART BYTES ARE NEVER CARRIED IN THIS OR ANY MCP TOOL: parts transfer through a SERVER-SIDE proxy (the Worker relays one part at a time under a scoped, single-bucket token); this tool returns only the transfer HANDLE + the part-size/count limits (min 5 MiB non-final part, max 5 GiB/part, max 10000 parts). Honest boundary: until the per-site multipart transport is wired you get a clear multipart_not_available error (never a fabricated upload_id, never a credential). You name only the site_id + key (+ optional content_type/http_metadata/custom_metadata/environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site. (Your OWN R2 bucket, NOT the platform's deployed-site static assets.)",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        content_type: { type: 'string', maxLength: 256 },
        http_metadata: { type: 'object' },
        custom_metadata: { type: 'object' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_multipart_complete',
    description:
      "ASSEMBLE the uploaded parts into the FINAL object for an in-flight multipart upload in your site's OWN R2 bucket. Pass the upload_id + the collected parts:[{ part_number, etag }] (the small handles each part upload returned — NEVER object bytes). Returns { key, overwritten, etag?, partCount }. ⚠️ OVERWRITE is destructive: if an object already EXISTS at key, completion overwrites it, so it REQUIRES confirm:true — without confirm on an existing key you get an error that REPORTS the key + that it exists and NOTHING is assembled (a brand-new key needs no confirm). parts[] must be non-empty, at most 10000, and STRICTLY ASCENDING by part_number. Honest boundary: until the transport is wired you get a clear multipart_not_available error. You name only the site_id + key + upload_id + parts (+ optional confirm/environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        upload_id: { type: 'string' },
        parts: {
          type: 'array',
          minItems: 1,
          maxItems: 10000,
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer', minimum: 1, maximum: 10000 },
              etag: { type: 'string' },
            },
            required: ['part_number', 'etag'],
            additionalProperties: false,
          },
        },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key', 'upload_id', 'parts'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_multipart_abort',
    description:
      "CANCEL an in-flight multipart upload + discard its uploaded parts in your site's OWN R2 bucket. Pass the upload_id. Returns { key, upload_id, aborted }. IDEMPOTENT cleanup: aborting an already-gone or unknown upload is an honest success (no live object is touched, so no confirm is needed). Honest boundary: until the transport is wired you get a clear multipart_not_available error. You name only the site_id + key + upload_id (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        upload_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key', 'upload_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_bucket_config',
    description:
      "READ the configuration of your site's OWN dedicated R2 bucket: CORS rules, object-lifecycle rules, public-access, and custom-domain settings. Returns { exists, bucketName, settings:[{ key, label, requiresPlatformAdmin, reason?, available, value? }] }. READ-ONLY + HONEST: CORS + lifecycle are owner-readable (requiresPlatformAdmin:false); public-access (the r2.dev public exposure) + custom domains are platform-administered (DNS/zone + account-wide toggle) and are reported with requiresPlatformAdmin:true + a reason — NEVER a fake control you could click that wouldn't take effect. A setting whose read fails transiently is available:false (not 'off'). You name only the site_id (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site. Honest 'not provisioned' until your site has an R2 bucket. (This is your OWN R2 bucket, NOT the platform's deployed-site static assets.)",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_r2_preview_url',
    description:
      "Get a SHORT-LIVED SCOPED preview/download URL for ONE object in your site's OWN R2 bucket. Returns { key, found, contentType?, size?, kind?, available, url?, expiresInSeconds?, approach? }. CREDENTIAL-SAFE: the response NEVER contains account credentials — only a scoped, time-boxed, single-object handle when signed-URL minting is wired, or an honest available:false + approach (a server-minted signed R2 URL for common image/text/json/pdf types, or a streamed scoped proxy for large/binary) when it is not. A missing object is an honest found:false, never a fabricated URL. You name only the site_id + key (+ optional environment) — never an R2 bucket name; the bucket is resolved server-side and isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        key: { type: 'string', maxLength: 1024 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_vectorize_list',
    description:
      "Summarise your site's OWN vector namespace inside the shared Vectorize index (the same per-site Vectorize the editor's Data tab shows). Returns the index name, dimensions, distance metric, its configured metadata (filterable) fields, AND your site's server-derived namespace. Per-site isolation is a NAMESPACE partition inside one shared index — not a dedicated index (there is no per-site index, and a namespace is not its own quota). You name only the site_id (+ optional environment) — never a Cloudflare index name and never a namespace; both are resolved/derived server-side and isolated to your site. Honest 'not provisioned' until your site has a Vectorize namespace.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_vectorize_describe',
    description:
      "Describe your site's Vectorize index config (dimensions, metric, metadata indexes) + your site's namespace, and OPTIONALLY fetch specific vectors' id + METADATA by id (namespace-scoped — a vector outside your namespace is never returned). Returns { indexName, namespace, dimensions, metric, vectors:[{id, metadata}] } — id + metadata ONLY, never the raw vector values. Pass ids:[] (or omit) to describe only. Scoped to the site_id you own; the index + namespace are server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string', maxLength: 512 }, maxItems: 1000 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_vectorize_upsert',
    description:
      "Write (insert-or-overwrite) vectors into your site's OWN namespace inside the shared Vectorize index (the same per-site Vectorize the editor's Data tab manages). vectors = [{ id, values:[…floats], metadata? }]. Returns { namespace, count, mutationId? }. ⛔ ISOLATION: every vector is FORCE-SCOPED to your site's server-derived namespace — you can NOT set a namespace, and any namespace you try to attach is stripped and overwritten, so a vector can NEVER land in another site's partition. Upsert replaces a same-id vector in full (no merge). ⏳ Vectorize writes are ASYNC — the mutationId confirms acceptance; vectors become queryable a few seconds later (never claimed instantly). You name only the site_id + vectors (+ optional environment) — never a Cloudflare index name and never a namespace; both are resolved/derived server-side and isolated to your site. Honest 'not provisioned' until your site has a Vectorize namespace.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        vectors: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 512 },
              values: { type: 'array', items: { type: 'number' }, minItems: 1 },
              metadata: { type: 'object' },
            },
            required: ['id', 'values'],
            additionalProperties: false,
          },
        },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'vectors'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_vectorize_delete',
    description:
      "Delete vectors BY ID from your site's OWN namespace inside the shared Vectorize index. ids = [\"…\"]. Returns { namespace, deleted, skipped, mutationId? }. ⚠️ DESTRUCTIVE: this permanently removes the vectors, so it REQUIRES confirm:true — without confirm you get an error REPORTING how many of your requested ids are in YOUR namespace and would be removed, and NOTHING is deleted. ⛔ ISOLATION: only ids confirmed to live in your site's namespace are ever deleted — a foreign id (even if you guess another site's vector id) is NEVER deleted (Cloudflare's delete-by-ids has no namespace filter, so the platform confirms namespace membership first). skipped = requested ids that weren't in your namespace. ⏳ Vectorize deletes are ASYNC — the mutationId confirms acceptance; removal reflects a few seconds later. You name only the site_id + ids (+ optional environment) — never a Cloudflare index name and never a namespace; both are resolved/derived server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string', maxLength: 512 }, minItems: 1, maxItems: 1000 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_connections_list',
    description:
      "List your site's OWN outbound connections to EXTERNAL providers (Hyperdrive / external database + OAuth/paste-key integrations like Stripe, HubSpot, GitHub, Slack — the same connections the editor's Data tab shows). Returns each connection's { id, name, type, maskedHost, status, connectedAt } — id, provider/engine type, a MASKED host, and health/status ONLY. NEVER a password, token, or connection string (those are encrypted at rest and never returned). Scoped to the site_id you own. Honest empty (count 0) until your site has a connection.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_connection_describe',
    description:
      "Read ONE connection's metadata (id, name, type, MASKED host, status, timestamps) from your site's OWN connections. Returns { found, connection:{ id, name, type, maskedHost, status, ... }, secretsRedacted:true } — metadata ONLY, NEVER a password, token, or connection string. A missing connection is an honest found:false. Scoped to the site_id you own; a connection outside your site is never returned even if its id is guessed.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        id: { type: 'string', maxLength: 256 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_workflows_list',
    description:
      "List the RUN INSTANCES of your site's workflow (the same per-site Workflows the editor's Backend tab shows). Returns each run's { id, status, createdOn, modifiedOn } newest-first + a pagination cursor (no fake total). Status is the ACTUAL Cloudflare status (queued/running/paused/errored/terminated/complete) — never an optimistic guess that a run finished. You name only the site_id (+ optional environment) — never a Cloudflare workflow name and never an account id; the workflow is resolved server-side and isolated to your site. Workflows are platform-owned definitions (there is no per-site workflow-definition API); honest 'not provisioned' until your site has a workflow.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        cursor: { type: 'string', maxLength: 4096 },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 25 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_workflow_get_instance',
    description:
      "Read ONE workflow run instance's status + STEPS from your site's workflow. Returns { found, workflowName, instanceId, status, steps:[{name, type, status, start, end, outputPreview, errorPreview}], outputSanitized:true }. The status is the ACTUAL Cloudflare status — never optimistically claimed complete. Step output/error are SANITIZED — secret-shaped keys are redacted and long payloads truncated, so a credential or PII in a step's output is NEVER dumped. A missing instance is an honest found:false. Scoped to the site_id you own; the workflow is server-resolved, and an instance outside your site's workflow is never returned even if its id is guessed.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        id: { type: 'string', maxLength: 256 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_workflow_start',
    description:
      "Start a NEW run instance of your site's workflow (the same per-site Workflows the editor's Backend tab shows), optionally with a params object passed to the run. Returns { workflowName, instanceId, status, created:true }. The status is the ACTUAL Cloudflare status of the fresh run (queued/running) — never an optimistic claim that it finished. Starting a run CREATES state (it does not change or discard an existing run), so NO confirm is needed. You name only the site_id (+ optional params/environment) — never a Cloudflare workflow name and never an account id; the workflow is resolved server-side and isolated to your site. Honest 'not provisioned' until your site has a workflow.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        params: { type: 'object' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_workflow_control',
    description:
      "Control ONE run instance of your site's workflow: op = pause | resume | restart | terminate. Returns { workflowName, instanceId, status, action } — the status is the ACTUAL Cloudflare status AFTER the op (running ≠ complete), never optimistic. ⚠️ restart RE-RUNS the run from the beginning — any side effect it already performed (emails, charges, writes) can HAPPEN AGAIN and its prior step outputs are discarded — and terminate is DESTRUCTIVE + IRREVERSIBLE (the run is stopped and its in-flight state discarded; it cannot be resumed): BOTH require confirm:true, and without confirm you get an error WARNING about the replay/discard and NOTHING runs. pause/resume are reversible and need no confirm. You name only the site_id + instanceId + op (+ optional confirm/environment) — never a Cloudflare workflow name and never an account id; the workflow is resolved server-side and the instance is bound under it, so you can never act on another site's run even if you guess its id.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        instanceId: { type: 'string' },
        op: { type: 'string', enum: ['pause', 'resume', 'restart', 'terminate'] },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'instanceId', 'op'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_durable_objects_list',
    description:
      "List your site's OWN Durable Object CLASS namespaces (the same per-site Durable Objects the editor's Backend tab shows). Returns each namespace's { id, className, scriptName, useSqlite } + instancesEnumerable:false. ⛔ This lists NAMESPACES (classes), NEVER instances — Cloudflare has NO API to enumerate Durable Object instances or browse their state; that is a structural fact, not a missing feature. You name only the site_id (+ optional environment) — never a Cloudflare namespace id and never an account id; the namespace is resolved server-side and isolated to your site. Honest 'not provisioned' until your site has a Durable Object namespace.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_durable_object_describe',
    description:
      "Describe the derivable METADATA of a NAMED Durable Object id within your site's namespace. Returns { objectId, namespaceId, hexId, stateBrowsable:false } — the id, its namespace, and its hex form ONLY. ⛔ NEVER the object's private storage or in-memory state — no Cloudflare API can read a Durable Object's state, so this surfaces WHICH object you addressed, never its data (stateBrowsable is always false). Pass an object id you already know. Scoped to the site_id you own; the namespace is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        id: { type: 'string', maxLength: 256 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_durable_object_manage',
    description:
      "Run a NARROW, platform-defined MANAGEMENT op against a KNOWN Durable Object instance in your site's namespace: action = status_probe (read-only, invoke the managed class's explicitly-exposed status endpoint) | reset (state-changing, clear the instance's transient state/alarm). Returns { action, objectId, namespaceId, available, stateBrowsable:false }. ⛔ THE ISOLATION RULE: action is a FIXED allowlist — this is NEVER an arbitrary method call into your Durable Object code, and there is NO method/args passthrough; the platform decides what a managed class exposes. ⚠️ reset is STATE-CHANGING → requires confirm:true (without it you get a confirmation error and NOTHING runs); status_probe needs no confirm. You name only the site_id + action + object_id (an id you already know) (+ optional confirm/environment) — never a Cloudflare namespace id and never an account id; the namespace is server-resolved and the object is bound under it, so you can never reach another site's object even if you guess its id. ⛔ Only SITE_BUILDER is bound + Cloudflare exposes no arbitrary-instance API → honest 'not available' (available:false, nothing called into customer code), never a fabricated result and never the object's state.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        action: { type: 'string', enum: ['status_probe', 'reset'] },
        object_id: { type: 'string', maxLength: 256 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'action', 'object_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_queues_list',
    description:
      "List your site's OWN Queue(s) + their consumers, delivery/retry settings, dead-letter queue, backlog/oldest-message metrics, and paused state (the same per-site Queues the editor's Backend tab shows). Returns each queue's CONFIG + METRICS + available (is Queues enabled on the account) + pullLeasesAndNeedsAck:true. ⛔ Returns CONFIG + METRICS ONLY — NEVER a message body or a 'history': a queue peek shows the CURRENT head, not a durable log (Cloudflare has no message-history API), and the pull consumer LEASES messages + needs ack (reading leases; unacked messages redeliver) — this read never leases. You name only the site_id (+ optional environment) — never a Cloudflare queue id and never an account id; the queue is resolved server-side and isolated to your site (you can never see another site's messages). Queues are NOT enabled on this deployment (no QUEUE binding) → honest 'not available / not provisioned' until Queues are enabled and your site has a queue.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_queue_describe',
    description:
      "Describe ONE of your site's queues: its config + metrics (name, paused, consumers, delivery/retry settings, dead-letter queue, backlog/oldest-message estimates). Returns { queueId, found, available, queue, messageHistoryAvailable:false }. ⛔ Returns CONFIG + METRICS ONLY — NEVER a message body or a 'history' (a peek shows the CURRENT head, not a durable log; Cloudflare has no message-history API, so messageHistoryAvailable is always false). The optional id is only an echo — the ONLY queue read is your site's server-resolved queue; a mismatching id can never widen to another queue. A missing queue is an honest found:false. Scoped to the site_id you own; the queue is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        id: { type: 'string', maxLength: 256 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_queue_send',
    description:
      "PRODUCE (send) one or more messages onto your site's OWN Queue (the same per-site Queue the editor's Backend tab shows). messages = [\"…\"] (1-100 non-empty strings — JSON-encode structured payloads before sending). Returns { queueId, action:'send', accepted }. ✅ PRODUCER-ONLY + NON-DESTRUCTIVE: sending APPENDS messages, so NO confirm is required (an optional confirm is accepted). ⛔ This is NOT peek/pull/ack/purge — reading a queue LEASES messages + needs ack, and purge is destructive; those are SEPARATE guarded ops, not this tool. You name only the site_id + messages (+ optional confirm/environment) — never a Cloudflare queue id and never an account id; the queue is resolved server-side and isolated to your site, so you can NEVER send to another site's queue. ⛔ Queues are NOT enabled on this deployment (no QUEUE binding) → honest 'not available' (nothing sent), never a fabricated send success. Honest 'not provisioned' until Queues are enabled and your site has a queue.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        messages: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'messages'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_analytics_list',
    description:
      "Summarise your site's Observability: the Analytics Engine dataset(s) your site's events flow into + the custom-event dimensions the platform records (event, route, site_id, org_id, user-agent class, referrer, country, count, latency). Returns { datasets:[{ name, dimensions }], count, available }. ⛔ Analytics Engine ingest is DISABLED on this deployment (no events are being written yet) → available:false, an honest 'no data ingested yet' (never a fabricated event stream). The dataset is shared across the platform (not per-site); your data is isolated by a server-built WHERE on your site — you never see another site's events. You name only the site_id (+ optional environment) — never a Cloudflare dataset name and never an account id.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_analytics_query_summary',
    description:
      "Read a SITE-SCOPED recent event-count summary for your site from Analytics Engine: the total estimated events over a trailing window + a per-event breakdown. Returns { datasetName, windowDays, available, totalEvents, events:[{ event, count }], sampled:true }. ⛔ You supply ONLY the site_id + an optional window_days (1-90, clamped; default 30) — NEVER a SQL query, a dataset name, or an account id. The query is SERVER-BUILT with a mandatory filter on YOUR site, so you can never read another site's analytics. Counts are SAMPLED estimates (SUM of sample intervals), never exact. Ingest is DISABLED on this deployment → an honest zero summary (available:false) without querying, never a fabricated count. Scoped to the site_id you own; the dataset is server-resolved, never named by you.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        window_days: { type: 'number', minimum: 1, maximum: 90, default: 30 },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_backend_inventory',
    description:
      "Inventory your site's Backend/compute plane (READ-ONLY): its scheduled tasks (Cron Triggers), its Worker bindings (service, Secrets Store, AI, Browser Rendering, Images, KV, R2, D1, Durable Objects, Vectorize, Analytics Engine, Queues), and its secret NAMES + last-change metadata. Returns { functionsDeployed, schedules:[{cron,…}], bindings:[{kind,name,description,managed,manageRoute,notAvailableReason,docsUrl,scope}], secrets:[{name,scope,isSecret,lastChangedAt,createdAt}], counts }. ⛔ Returns secret NAMES + metadata ONLY — NEVER a secret VALUE (values are AES-GCM at rest and are never read). Each binding says whether THIS platform has an integrated management surface (managed:true + an in-platform manageRoute) or not (managed:false + an honest notAvailableReason) — no fake CRUD for un-integrated products. You name ONLY the site_id (+ optional environment) — never a Cloudflare id and never an account id; the inventory reads your site's OWN records and is isolated to your site.",
    requiredScope: 'data:read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'data_provision_resource',
    description:
      "PROVISION a per-site DEDICATED Cloudflare resource for one of your sites — turn 'not provisioned' into a live, isolated D1 database, KV namespace, or R2 bucket. kind = 'd1' | 'kv' | 'r2'. Returns { kind, resourceId, registryRowId, created, displayName }. ⚠️ This creates REAL, BILLABLE Cloudflare infrastructure, so it REQUIRES confirm:true — without confirm you get a confirmation error and NOTHING is created. ✅ IDEMPOTENT: if your site already has that resource, the existing one is returned and nothing new is created (never a duplicate). Before creating, the platform checks the REAL Cloudflare account capacity — if the account is at its quota for that kind you get an honest 'quota reached' error (a shared resource is NEVER substituted silently). If the resource is created but recording it fails, you get a recoverable partial-state error (re-run to finish — it reuses the created resource). You name only the site_id + kind (+ optional environment) — never a Cloudflare id; the id is generated server-side and isolated to your site.",
    requiredScope: 'data:write' as const,
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        kind: { type: 'string', enum: ['d1', 'kv', 'r2'] },
        confirm: { type: 'boolean' },
        environment: { type: 'string', enum: ['preview', 'production'], default: 'production' },
      },
      required: ['site_id', 'kind'],
      additionalProperties: false,
    },
  },
] as const;

/** Slugify a name the same way the create-from-search handler does. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 63);
}

/**
 * Dispatch a `tools/call`. `token` is the verified API-token row (carries org_id
 * + scopes). Validates args with Zod, scope-gates, runs the org-scoped query.
 *
 * @throws never — all failures become an `isError` ToolResult so JSON-RPC stays 200.
 */
export async function dispatchPlatformTool(
  env: Env,
  token: ApiTokenRow,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const db = env.DB;
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return err(`Unknown tool: ${name}. Call tools/list for the catalog.`);
  if (!hasScope(token, tool.requiredScope)) {
    return err(`This API token lacks the '${tool.requiredScope}' scope required by '${name}'.`);
  }
  const orgId = token.org_id;

  switch (name) {
    case 'whoami':
      return ok({
        org_id: orgId,
        token_name: token.name,
        scopes: JSON.parse(token.scopes ?? '[]'),
        server: 'projectsites.dev platform MCP',
      });

    case 'list_sites': {
      const { limit } = ListSitesInput.parse(args);
      const { data } = await dbQuery<{
        id: string;
        slug: string;
        business_name: string | null;
        status: string;
        primary_hostname: string | null;
      }>(
        db,
        // `primary_hostname` is NOT a sites column — resolve the primary custom
        // hostname from the hostnames table via a correlated subquery (null when
        // the site is still on its {slug}.projectsites.dev default). The old
        // SELECT of it threw `no such column` → swallowed → list_sites returned
        // ZERO sites for every MCP client.
        `SELECT s.id, s.slug, s.business_name, s.status,
                (SELECT h.hostname FROM hostnames h
                   WHERE h.site_id = s.id AND h.is_primary = 1 AND h.deleted_at IS NULL
                   LIMIT 1) AS primary_hostname
           FROM sites s WHERE s.org_id = ? AND s.deleted_at IS NULL
           ORDER BY s.updated_at DESC LIMIT ?`,
        [orgId, limit],
      );
      return ok({ count: data.length, sites: data });
    }

    case 'get_site': {
      const { site_id } = GetSiteInput.parse(args);
      const row = await dbQueryOne<{
        id: string;
        slug: string;
        business_name: string | null;
        status: string;
        plan: string | null;
        primary_hostname: string | null;
        updated_at: string;
      }>(
        db,
        // `primary_hostname` is resolved from hostnames (see list_sites); `plan`
        // IS a real sites column. The old SELECT of primary_hostname threw
        // `no such column` → swallowed → get_site returned "Site not found" for
        // every real site.
        `SELECT s.id, s.slug, s.business_name, s.status, s.plan, s.updated_at,
                (SELECT h.hostname FROM hostnames h
                   WHERE h.site_id = s.id AND h.is_primary = 1 AND h.deleted_at IS NULL
                   LIMIT 1) AS primary_hostname
           FROM sites s WHERE s.id = ? AND s.org_id = ? AND s.deleted_at IS NULL`,
        [site_id, orgId],
      );
      // 404-on-missing-or-foreign (never leak another org's site existence).
      return row ? ok(row) : err('Site not found.');
    }

    case 'get_build_status': {
      const { site_id } = BuildStatusInput.parse(args);
      const owned = await dbQueryOne<{ id: string; status: string }>(
        db,
        `SELECT id, status FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // workflow_jobs has NO `step` column (real cols: job_name, status, attempt,
      // started_at, completed_at, error_message, updated_at …). Selecting `step`
      // threw `no such column` → swallowed → the build-status tool returned
      // {status:'none'} for every site. Drop it.
      const job = await dbQueryOne<{ status: string; updated_at: string }>(
        db,
        `SELECT status, updated_at FROM workflow_jobs
           WHERE site_id = ? ORDER BY updated_at DESC LIMIT 1`,
        [site_id],
      );
      return ok({ site_id, site_status: owned.status, build: job ?? { status: 'none' } });
    }

    case 'get_audit_log': {
      const site_id = String(args.site_id ?? '');
      if (!site_id) return err('site_id is required.');
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // audit_logs has NO `site_id` column — site scoping is target_type/target_id.
      // The old `WHERE site_id = ?` threw `no such column` → swallowed → the
      // audit-log tool returned zero entries for every site (despite 1,129 real
      // rows for this org). Filter on target_type='site' AND target_id instead.
      const { data } = await dbQuery<{ action: string; created_at: string }>(
        db,
        `SELECT action, created_at FROM audit_logs
           WHERE org_id = ? AND target_type = 'site' AND target_id = ? ORDER BY created_at DESC LIMIT ?`,
        [orgId, site_id, limit],
      );
      return ok({ site_id, count: data.length, entries: data });
    }

    case 'deploy_site': {
      const parsed = DeploySiteInput.safeParse(args);
      if (!parsed.success) {
        // First human-readable issue (path traversal / size / shape) — never raw Zod.
        return err(parsed.error.issues[0]?.message ?? 'Invalid deploy_site arguments.');
      }
      const { site_id, files } = parsed.data;
      const site = await dbQueryOne<{ id: string; slug: string }>(
        db,
        `SELECT id, slug FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!site) return err('Site not found.');
      const result = await publishSiteFiles(env, site.slug, files);
      const { error: statusError } = await dbExecute(
        db,
        // Set `current_build_version` (the version publishSiteFiles just wrote)
        // ALONGSIDE status — a published row with a NULL build version is the
        // "lying-published" 503 class. This keeps D1 the authoritative build
        // indicator (mirrors the normal site-generation publish) so search /
        // dashboard / readiness / onboarding all classify this MCP-deployed site
        // as genuinely live, not "unbuilt".
        `UPDATE sites SET status = 'published', current_build_version = ?, updated_at = datetime('now') WHERE id = ?`,
        [result.version, site_id],
      );
      if (statusError) {
        // publishSiteFiles already succeeded (the files ARE live); only the status
        // marker failed. Surface the drift (never a silent swallow) but don't fail the
        // deploy that already happened — the next publish re-sets status. Mirrors the
        // snapshot insert's `{ error }` handling below.
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'platform_mcp',
            message: 'publish_status_update_failed',
            site_id,
            error: statusError,
          }),
        );
      }
      // Version-pin this deploy as a snapshot so the agent gets a STABLE preview URL
      // (served via the existing {slug}-{snapshot} host path, unaffected by later
      // deploys). Dash-free short name keeps the snapshot host a single clean label.
      // Skip the preview only if the composed host would exceed the 63-char DNS label.
      const previewName = `d${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const previewLabel = `${site.slug}-${previewName}`;
      let preview_url: string | undefined;
      if (previewLabel.length <= 63) {
        const snap = await dbInsert(db, 'site_snapshots', {
          id: crypto.randomUUID(),
          site_id,
          snapshot_name: previewName,
          build_version: result.version,
          description: 'Deploy preview (platform MCP)',
          deleted_at: null,
        });
        if (!snap.error) preview_url = `https://${previewLabel}${SITES_SUFFIX}`;
      }
      return ok({
        deployed: files.length,
        site_id,
        ...result,
        live_url: result.url,
        ...(preview_url ? { preview_url } : {}),
      });
    }

    case 'create_site': {
      const business_name = String(args.business_name ?? '').trim();
      if (!business_name) return err('business_name is required.');
      const base =
        slugify(typeof args.slug === 'string' && args.slug ? args.slug : business_name) || 'site';
      let slug = base;
      const taken = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE slug = ? AND deleted_at IS NULL`,
        [slug],
      );
      if (taken) slug = `${base.substring(0, 58)}-${crypto.randomUUID().slice(0, 4)}`;
      const id = crypto.randomUUID();
      const res = await dbInsert(db, 'sites', {
        id,
        org_id: orgId,
        slug,
        business_name,
        business_phone: null,
        business_email: null,
        business_address: null,
        google_place_id: null,
        bolt_chat_id: null,
        current_build_version: null,
        status: 'draft',
        lighthouse_score: null,
        lighthouse_last_run: null,
        deleted_at: null,
      });
      if (res.error) return err(`Failed to create site: ${res.error}`);
      return ok({
        site_id: id,
        slug,
        status: 'draft',
        url: `https://${slug}${SITES_SUFFIX}`,
        next: 'Use deploy_site with your built files to publish.',
      });
    }

    case 'list_snapshots': {
      const { site_id } = GetSiteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const { data } = await dbQuery<{
        id: string;
        snapshot_name: string;
        build_version: string;
        description: string | null;
        created_at: string;
      }>(
        db,
        `SELECT id, snapshot_name, build_version, description, created_at FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
        [site_id],
      );
      return ok({ site_id, count: data.length, snapshots: data });
    }

    case 'get_research': {
      const { site_id } = GetSiteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const { data } = await dbQuery<{
        task_name: string;
        parsed_output: string;
        raw_output: string;
      }>(
        db,
        `SELECT task_name, parsed_output, raw_output FROM research_data WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
        [site_id],
      );
      const research: Record<string, unknown> = {};
      for (const row of data) {
        if (row.task_name in research) continue; // first-write-wins (newest first)
        const raw = row.parsed_output || row.raw_output;
        try {
          research[row.task_name] = JSON.parse(raw);
        } catch {
          research[row.task_name] = raw;
        }
      }
      return ok({ site_id, tasks: data.map((r) => r.task_name), research });
    }

    case 'tail_logs': {
      const { site_id, limit } = TailLogsInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // workflow_jobs has no `step` column (see get_build_status). Drop it so
      // tail_logs stops silently returning zero entries.
      const { data } = await dbQuery<{ status: string; updated_at: string }>(
        db,
        `SELECT status, updated_at FROM workflow_jobs
           WHERE site_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
        [site_id, limit],
      );
      return ok({ site_id, count: data.length, entries: data });
    }

    case 'set_domain': {
      const { site_id, hostname } = SetDomainInput.parse(args);
      const site = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!site) return err('Site not found.');
      // Custom domains are a paid capability (same gate as POST /hostnames).
      const entitlements = await getOrgEntitlements(db, orgId);
      if (!entitlements.topBarHidden) {
        return err(
          'Custom domains require a paid plan. Upgrade at https://projectsites.dev/admin/billing, then retry.',
        );
      }
      // The customer must point DNS at us first — verify the CNAME before provisioning.
      const cnameTarget = await checkCnameTarget(hostname);
      if (!cnameTarget || cnameTarget !== DOMAINS.SITES_BASE) {
        return err(
          `Before connecting ${hostname}, add a DNS CNAME record: ${hostname} → ${DOMAINS.SITES_BASE}. ` +
            `Then call set_domain again.`,
        );
      }
      try {
        const result = await provisionCustomDomain(db, env, { org_id: orgId, site_id, hostname });
        return ok({
          hostname: result.hostname,
          status: result.status,
          is_primary: result.is_primary,
          dns: `CNAME ${hostname} → ${DOMAINS.SITES_BASE}`,
          next:
            result.status === 'active'
              ? `Live at https://${hostname}`
              : 'SSL is provisioning — usually active within minutes; poll get_site for the primary hostname.',
        });
      } catch (e) {
        // provisionCustomDomain throws user-safe conflicts (domain cap / already registered).
        return err(e instanceof Error ? e.message : 'Failed to connect the domain.');
      }
    }

    case 'data_list_resources': {
      // Flag-gated (dark → err, mirroring the 404 the per-site-data routes return).
      if (!(await isFlagOn(env, DATA_RESOURCE_FLAG, {}))) {
        return err('The data resource platform is not enabled for this account.');
      }
      const { site_id, environment } = DataListResourcesInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF id —
      // the caller named only site_id; the site must belong to THIS org.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // Real registry read for the OWNED site + env — honestly empty until reconcile seeds it.
      const resources = await listResources(env, site_id, environment);
      return ok({ site_id, environment, count: resources.length, resources });
    }

    case 'data_reconcile_resources': {
      if (!(await isFlagOn(env, DATA_RESOURCE_FLAG, {}))) {
        return err('The data resource platform is not enabled for this account.');
      }
      const { site_id, environment } = DataReconcileResourcesInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // Reconcile = read the authoritative registry rows and summarise drift PER KIND from
      // what the registry actually stores (driftCode/driftDetail/lastSyncAt/lifecycleState).
      // No CF id is ever named or fabricated; an empty table yields an honest empty summary.
      const resources = await listResources(env, site_id, environment);
      const byKind: Record<
        string,
        {
          kind: string;
          registered: number;
          last_sync_at: string | null;
          drift: Array<{
            registry_row_id: string;
            concept: string;
            lifecycle_state: string;
            drift_code: string;
            drift_detail: string | null;
          }>;
        }
      > = {};
      for (const r of resources) {
        const entry = (byKind[r.resourceKind] ??= {
          kind: r.resourceKind,
          registered: 0,
          last_sync_at: null,
          drift: [],
        });
        entry.registered += 1;
        // Track the most-recent sync timestamp seen for this kind.
        if (r.lastSyncAt && (!entry.last_sync_at || r.lastSyncAt > entry.last_sync_at)) {
          entry.last_sync_at = r.lastSyncAt;
        }
        if (r.driftCode) {
          entry.drift.push({
            registry_row_id: r.id,
            concept: r.resourceConcept,
            lifecycle_state: r.lifecycleState,
            drift_code: r.driftCode,
            drift_detail: r.driftDetail ?? null,
          });
        }
      }
      const kinds = Object.values(byKind);
      const totalDrift = kinds.reduce((n, k) => n + k.drift.length, 0);
      return ok({
        site_id,
        environment,
        reconciled: resources.length,
        drift_count: totalDrift,
        kinds,
      });
    }

    case 'data_list_tables': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, environment } = DataListTablesInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id —
      // the caller named only site_id; resolveSiteDataDb server-resolves + isolates the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      try {
        const tables = await listSiteTables(resolved.db);
        return ok({
          site_id,
          environment,
          databaseId: resolved.databaseId,
          provisioned: resolved.provisioned,
          count: tables.length,
          tables: tables.map((tableName) => ({ name: tableName })),
        });
      } catch (e) {
        if (e instanceof SiteDataD1Error) return err('Could not read site tables.');
        throw e;
      }
    }

    case 'data_read_table': {
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, table, limit: rawLimit, offset: rawOffset, environment } =
        DataReadTableInput.parse(args);
      // CLAMP (never reject) to the SAME bounds the /api/sites/:id/db/tables/:table endpoint uses:
      // limit ∈ [1, 200] default 50; offset ≥ 0 default 0. An over-limit request SUCCEEDS clamped.
      const limit = Math.max(1, Math.min(200, Math.trunc(rawLimit ?? 50)));
      const offset = Math.max(0, Math.trunc(rawOffset ?? 0));
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // D1 REST cannot bind an identifier — validate the table name against the allowlist first.
      if (!isSafeIdent(table)) return err('Invalid table name.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      try {
        // Confirm the table exists in THIS site's DB (clean err instead of a raw SQL error).
        // Guard against a non-array result (never `.includes` on undefined) so a resolver quirk
        // becomes a clean err() envelope, not an uncaught throw that drops the MCP content[].
        const tables = await listSiteTables(resolved.db);
        if (!Array.isArray(tables) || !tables.includes(table)) return err('Table not found.');
        const q = quoteIdent(table);
        // Same query the /api/sites/:id/db/tables/:table endpoint runs: count + rows + column schema.
        const [countRes, rowsRes, colRes] = await Promise.all([
          resolved.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q}`),
          resolved.db.query(`SELECT * FROM ${q} LIMIT ? OFFSET ?`, [limit, offset]),
          resolved.db.query<{ name: string; type: string; notnull: number; pk: number }>(
            `SELECT name, type, "notnull", pk FROM pragma_table_info(?)`,
            [table],
          ),
        ]);
        const total = Number(countRes.results[0]?.n ?? 0);
        return ok({
          site_id,
          environment,
          table,
          columns: colRes.results,
          limit,
          offset,
          total,
          rows: rowsRes.results,
        });
      } catch (e) {
        if (e instanceof SiteDataD1Error) return err('Could not read table rows.');
        throw e;
      }
    }

    case 'data_d1_exec': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, sql, params, confirm, environment } = DataD1ExecInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — the caller
      // named only site_id; resolveSiteDataDb server-resolves + isolates + denylists the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      // Build the resolved scope the d1 adapter's mutate consumes. resolveSiteDataDb already isolated the
      // databaseId (provision + FORBIDDEN_DB_IDS denylist); we attach server-side auth + account for the
      // adapter's own executor — the CF credentials NEVER reach the client (INV-6).
      const auth = await resolveCfCredentials(env, orgId);
      const accountId = env.CF_ACCOUNT_ID;
      if (!auth || !accountId) return err('Could not open the site database.');
      // The adapter enforces the SQL classification + destructive/mutating confirm gate: a mutating
      // statement without confirm:true returns a `confirmation_required` error that REPORTS the detected
      // kind (nothing runs); a destructive one adds the Time-Travel recovery note.
      const result = await d1Adapter.mutate(
        {
          // Per-site D1 is reachable only via REST / service binding (INV-8) — no_direct.
          accessPolicy: 'no_direct',
          accountId,
          auth,
          // Platform DB (env.DB) attached so the adapter can FIRE-AND-FORGET record query history to
          // the SHARED platform D1 (org+site-scoped) — NEVER the per-site D1, NEVER param VALUES.
          db,
          environment,
          orgId,
          resourceId: resolved.databaseId,
          siteId: site_id,
        },
        { action: 'exec', confirm, params, sql },
      );
      if (!result.ok) {
        // Surface the confirm-required report (or a CF/SQL failure) as an isError result — never a silent write.
        return err(result.error?.message ?? 'Could not execute the SQL statement.');
      }
      const data = result.data as
        | {
            effect?: string;
            destructive?: boolean;
            rows?: unknown[];
            rowsRead?: number;
            rowsWritten?: number;
            changedDb?: boolean;
          }
        | undefined;
      return ok({
        site_id,
        environment,
        databaseId: resolved.databaseId,
        action: 'exec',
        effect: data?.effect ?? 'unknown',
        destructive: data?.destructive ?? false,
        rows: data?.rows ?? [],
        rows_read: data?.rowsRead ?? 0,
        rows_written: data?.rowsWritten ?? 0,
        changed_db: data?.changedDb ?? false,
      });
    }

    case 'data_d1_explain': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, sql, params, environment } = DataD1ExplainInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — the caller
      // named only site_id; resolveSiteDataDb server-resolves + isolates + denylists the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      const auth = await resolveCfCredentials(env, orgId);
      const accountId = env.CF_ACCOUNT_ID;
      if (!auth || !accountId) return err('Could not open the site database.');
      // The adapter REFUSES to explain a mutating statement (explain_refused_mutating) — surfaced as isError.
      const result = await d1Adapter.mutate(
        {
          accessPolicy: 'no_direct',
          accountId,
          auth,
          // Platform DB attached for FIRE-AND-FORGET query-history recording (shared platform D1,
          // org+site-scoped) — NEVER the per-site D1, NEVER param VALUES.
          db,
          environment,
          orgId,
          resourceId: resolved.databaseId,
          siteId: site_id,
        },
        { action: 'explain', params, sql },
      );
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not explain the SQL statement.');
      }
      const data = result.data as
        | { effect?: string; plan?: unknown[]; durationMs?: number }
        | undefined;
      return ok({
        site_id,
        environment,
        databaseId: resolved.databaseId,
        action: 'explain',
        effect: data?.effect ?? 'read_only',
        plan: data?.plan ?? [],
        duration_ms: data?.durationMs,
      });
    }

    case 'data_d1_migrations': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, environment } = DataD1MigrationsInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — the caller
      // named only site_id; resolveSiteDataDb server-resolves + isolates + denylists the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      const auth = await resolveCfCredentials(env, orgId);
      const accountId = env.CF_ACCOUNT_ID;
      if (!auth || !accountId) return err('Could not open the site database.');
      // A blank per-site D1 with no d1_migrations table returns an HONEST empty history (never an error).
      const result = await d1Adapter.mutate(
        {
          accessPolicy: 'no_direct',
          accountId,
          auth,
          environment,
          orgId,
          resourceId: resolved.databaseId,
          siteId: site_id,
        },
        { action: 'migrations' },
      );
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not read the migration history.');
      }
      const data = result.data as
        | { tablePresent?: boolean; migrations?: unknown[]; durationMs?: number }
        | undefined;
      return ok({
        site_id,
        environment,
        databaseId: resolved.databaseId,
        action: 'migrations',
        table_present: data?.tablePresent ?? false,
        count: data?.migrations?.length ?? 0,
        migrations: data?.migrations ?? [],
        duration_ms: data?.durationMs,
      });
    }

    case 'data_d1_query_history': {
      // Flag-gated on the SAME flag the db/tables surface uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, limit, environment } = DataD1QueryHistoryInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — history
      // lives in the SHARED platform D1 (`db` = env.DB), and readQueryHistory ALSO scopes to org_id
      // (belt-and-braces) so a foreign site's history can never be returned.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // Read recent history from the platform D1 (newest-first, clamped). Honestly empty until a query
      // has been run. This NEVER exposes bound parameter VALUES — only the statement templates.
      const entries = await readQueryHistory(db, site_id, orgId, {
        ...(environment ? { environment } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
      return ok({
        site_id,
        ...(environment ? { environment } : {}),
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          environment: e.environment,
          statement_kind: e.statementKind,
          sql_text: e.sqlText,
          duration_ms: e.durationMs,
          rows_read: e.rowsRead,
          rows_written: e.rowsWritten,
          ok: e.ok,
          error_code: e.errorCode,
          created_at: e.createdAt,
        })),
      });
    }

    case 'data_d1_time_travel_info': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, timestamp, environment } = DataD1TimeTravelInfoInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — the caller
      // named only site_id; resolveSiteDataDb server-resolves + isolates + denylists the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      const auth = await resolveCfCredentials(env, orgId);
      const accountId = env.CF_ACCOUNT_ID;
      if (!auth || !accountId) return err('Could not open the site database.');
      // Real CF REST Time Travel read (GET …/time_travel/bookmark) — never a fabricated bookmark.
      const result = await d1Adapter.mutate(
        {
          accessPolicy: 'no_direct',
          accountId,
          auth,
          environment,
          orgId,
          resourceId: resolved.databaseId,
          siteId: site_id,
        },
        { action: 'time_travel_info', timestamp },
      );
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not read the Time Travel bookmark.');
      }
      const data = result.data as
        | { available?: boolean; bookmark?: string; asOf?: string; retentionDays?: number; durationMs?: number }
        | undefined;
      return ok({
        site_id,
        environment,
        databaseId: resolved.databaseId,
        action: 'time_travel_info',
        available: data?.available ?? true,
        bookmark: data?.bookmark,
        as_of: data?.asOf,
        retention_days: data?.retentionDays ?? 30,
        duration_ms: data?.durationMs,
      });
    }

    case 'data_d1_restore': {
      // Flag-gated on the SAME flag the db/tables endpoint uses (dark → err, mirroring its 404).
      if (!(await isFlagOn(env, PER_SITE_DATA_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site data is not enabled for this account.');
      }
      const { site_id, bookmark, timestamp, confirm, environment } = DataD1RestoreInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF/db id — the caller
      // named only site_id; resolveSiteDataDb server-resolves + isolates + denylists the database.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const resolved = await resolveSiteDataDb(env, site_id, { orgId });
      if (!resolved || !resolved.ok) return err('Could not open the site database.');
      const auth = await resolveCfCredentials(env, orgId);
      const accountId = env.CF_ACCOUNT_ID;
      if (!auth || !accountId) return err('Could not open the site database.');
      // The adapter gates on confirm:true (whole-DB warning) + requires exactly one target — surfaced as isError.
      // A real CF REST restore (POST …/time_travel/restore) runs only when both guards pass.
      const result = await d1Adapter.mutate(
        {
          accessPolicy: 'no_direct',
          accountId,
          auth,
          environment,
          orgId,
          resourceId: resolved.databaseId,
          siteId: site_id,
        },
        { action: 'restore', bookmark, timestamp, confirm },
      );
      if (!result.ok) {
        // Surface the confirm-required / invalid-target warning (or a CF failure) — never a silent restore.
        return err(result.error?.message ?? 'Could not restore the site database.');
      }
      const data = result.data as
        | { restored?: boolean; bookmark?: string; previousBookmark?: string; message?: string }
        | undefined;
      return ok({
        site_id,
        environment,
        databaseId: resolved.databaseId,
        action: 'restore',
        restored: data?.restored ?? false,
        bookmark: data?.bookmark,
        previous_bookmark: data?.previousBookmark,
        message: data?.message,
      });
    }

    case 'data_kv_list_keys': {
      // Flag-gated on the reserved per_site_kv flag (dark → err, mirroring the Data-tab KV 404).
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, prefix, cursor, limit, environment } = DataKvListKeysInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF namespace id —
      // the caller named only site_id; the namespace is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // CLAMP (never reject) to the SAME [1, 1000] bound CF KV pages at; the adapter clamps too.
      const result = await kvAdapter.list(scoped.scope, {
        cursor,
        limit: typeof limit === 'number' ? Math.max(1, Math.min(1000, Math.trunc(limit))) : undefined,
        prefix,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not list KV keys.');
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        count: result.data?.keys.length ?? 0,
        list_complete: result.data?.listComplete ?? true,
        cursor: result.data?.cursor,
        keys: result.data?.keys ?? [],
      });
    }

    case 'data_kv_get': {
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, key, environment } = DataKvGetInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      const result = await kvAdapter.get(scoped.scope, { key });
      if (!result.ok) return err(result.error?.message ?? 'Could not read the KV value.');
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        key,
        found: result.data?.found ?? false,
        value: result.data?.value,
        metadata: result.data?.metadata,
        ...(result.data?.truncated ? { truncated: true } : {}),
      });
    }

    case 'data_kv_put': {
      // Flag-gated on the reserved per_site_kv flag (dark → err, mirroring the Data-tab KV 404).
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, key, value, expiration_ttl, metadata, confirm, environment } =
        DataKvPutInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF namespace id —
      // the caller named only site_id; the namespace is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive-OVERWRITE gate: an existing key needs confirm:true, else it
      // returns a `confirmation_required` error that REPORTS the key + that it exists (nothing written).
      const result = await kvAdapter.mutate(scoped.scope, {
        action: 'put',
        confirm,
        expirationTtl: expiration_ttl,
        key,
        metadata,
        value,
      });
      if (!result.ok) {
        // Surface the confirm-required report (or a CF failure) as an isError result — never a silent write.
        return err(result.error?.message ?? 'Could not write the KV value.');
      }
      const data = result.data as { overwritten?: boolean; metadataStored?: boolean } | undefined;
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        key,
        action: 'put',
        overwritten: data?.overwritten ?? false,
        metadata_stored: data?.metadataStored ?? false,
        ...(expiration_ttl !== undefined ? { expiration_ttl } : {}),
      });
    }

    case 'data_kv_delete': {
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, key, confirm, environment } = DataKvDeleteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive-DELETE gate: no confirm:true → a `confirmation_required`
      // error that REPORTS the key + whether it exists (nothing deleted).
      const result = await kvAdapter.mutate(scoped.scope, { action: 'delete', confirm, key });
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not delete the KV key.');
      }
      const data = result.data as { existed?: boolean } | undefined;
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        key,
        action: 'delete',
        existed: data?.existed ?? false,
      });
    }

    case 'data_kv_bulk_get': {
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, keys, environment } = DataKvBulkGetInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF namespace id —
      // the caller named only site_id; the namespace is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter CLAMPS the keys[] to the CF bulk cap (a read is non-destructive) and reports clampedOff.
      const result = await kvAdapter.bulkGet(scoped.scope, { keys });
      if (!result.ok) return err(result.error?.message ?? 'Could not bulk-read KV values.');
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        found: result.data?.found ?? 0,
        missing: result.data?.missing ?? 0,
        clamped_off: result.data?.clampedOff ?? 0,
        values: result.data?.values ?? [],
      });
    }

    case 'data_kv_bulk_delete': {
      // Flag-gated on the reserved per_site_kv flag (dark → err, mirroring the Data-tab KV 404).
      if (!(await isFlagOn(env, PER_SITE_KV_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site KV is not enabled for this account.');
      }
      const { site_id, keys, confirm, environment } = DataKvBulkDeleteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveKvScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive gate: no confirm:true → a `confirmation_required` error that
      // REPORTS the count that WOULD be removed (nothing deleted); over the 10k cap → `bulk_limit_exceeded`.
      const result = await kvAdapter.mutate(scoped.scope, { action: 'bulk_delete', confirm, keys });
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not bulk-delete the KV keys.');
      }
      const data = result.data as { requested?: number } | undefined;
      return ok({
        site_id,
        environment,
        namespaceId: scoped.scope.resourceId,
        action: 'bulk_delete',
        requested: data?.requested ?? 0,
      });
    }

    case 'data_r2_list_objects': {
      // Flag-gated on the reserved per_site_r2 flag (dark → err, mirroring the Data-tab R2 404).
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, prefix, cursor, limit, environment } = DataR2ListObjectsInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF bucket name —
      // the caller named only site_id; the bucket is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // CLAMP (never reject) to the SAME [1, 1000] bound R2 pages at; the adapter clamps too.
      const result = await r2Adapter.list(scoped.scope, {
        cursor,
        limit: typeof limit === 'number' ? Math.max(1, Math.min(1000, Math.trunc(limit))) : undefined,
        prefix,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not list R2 objects.');
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        count: result.data?.objects.length ?? 0,
        truncated: result.data?.truncated ?? false,
        cursor: result.data?.cursor,
        objects: result.data?.objects ?? [],
      });
    }

    case 'data_r2_head_object': {
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, environment } = DataR2HeadObjectInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // METADATA ONLY — the adapter never returns object bytes; a large download is a later signed-URL pass.
      const result = await r2Adapter.get(scoped.scope, { key });
      if (!result.ok) return err(result.error?.message ?? 'Could not read the R2 object metadata.');
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        found: result.data?.found ?? false,
        size: result.data?.size,
        etag: result.data?.etag,
        contentType: result.data?.contentType,
        uploaded: result.data?.uploaded,
        httpMetadata: result.data?.httpMetadata,
        customMetadata: result.data?.customMetadata,
        metadataOnly: true,
      });
    }

    case 'data_r2_put_object': {
      // Flag-gated on the reserved per_site_r2 flag (dark → err, mirroring the Data-tab R2 404).
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, body, content_type, http_metadata, custom_metadata, confirm, environment } =
        DataR2PutObjectInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF bucket name —
      // the caller named only site_id; the bucket is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive-OVERWRITE gate (existing object needs confirm:true) AND the
      // large-object guard (a body over the inline cap → object_too_large, never embedded, use a signed URL).
      const result = await r2Adapter.mutate(scoped.scope, {
        action: 'put',
        body,
        confirm,
        contentType: content_type,
        customMetadata: custom_metadata,
        httpMetadata: http_metadata,
        key,
      });
      if (!result.ok) {
        // Surface the confirm-required report / object_too_large / CF failure as isError — never a silent write.
        return err(result.error?.message ?? 'Could not write the R2 object.');
      }
      const data = result.data as { overwritten?: boolean; contentType?: string; metadataStored?: boolean } | undefined;
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        action: 'put',
        overwritten: data?.overwritten ?? false,
        content_type: data?.contentType,
        metadata_stored: data?.metadataStored ?? false,
      });
    }

    case 'data_r2_delete_object': {
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, confirm, environment } = DataR2DeleteObjectInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive-DELETE gate: no confirm:true → a `confirmation_required`
      // error that REPORTS the key + whether it exists (nothing deleted).
      const result = await r2Adapter.mutate(scoped.scope, { action: 'delete', confirm, key });
      if (!result.ok) {
        return err(result.error?.message ?? 'Could not delete the R2 object.');
      }
      const data = result.data as { existed?: boolean } | undefined;
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        action: 'delete',
        existed: data?.existed ?? false,
      });
    }

    case 'data_r2_multipart_create': {
      // Flag-gated on the reserved per_site_r2 flag (dark → err, mirroring the Data-tab R2 404).
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, content_type, http_metadata, custom_metadata, environment } =
        DataR2MultipartCreateInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF bucket name —
      // the caller named only site_id; the bucket is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter validates the key + returns { uploadId, partTransport, limits } when wired, or an
      // honest multipart_not_available (never a fabricated uploadId, never a credential — INV-6). LARGE
      // PART BYTES are NEVER carried in this MCP argument: create returns only the transfer handle.
      const result = await r2Adapter.mutate(scoped.scope, {
        action: 'create_multipart_upload',
        contentType: content_type,
        customMetadata: custom_metadata,
        httpMetadata: http_metadata,
        key,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not begin the multipart upload.');
      const data = result.data as
        | { uploadId?: string; partTransport?: string; limits?: unknown }
        | undefined;
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        action: 'create_multipart_upload',
        upload_id: data?.uploadId,
        partTransport: data?.partTransport,
        limits: data?.limits,
      });
    }

    case 'data_r2_multipart_complete': {
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, upload_id, parts, confirm, environment } =
        DataR2MultipartCompleteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces the destructive-OVERWRITE gate (existing object → confirm:true) + validates the
      // parts[] (non-empty, ≤10000, strictly ascending) BEFORE the honest multipart_not_available. The MCP
      // parts carry only { part_number, etag } handles — never object bytes.
      const result = await r2Adapter.mutate(scoped.scope, {
        action: 'complete_multipart_upload',
        confirm,
        key,
        parts: parts.map((p) => ({ etag: p.etag, partNumber: p.part_number })),
        uploadId: upload_id,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not complete the multipart upload.');
      const data = result.data as
        | { overwritten?: boolean; etag?: string; partCount?: number }
        | undefined;
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        action: 'complete_multipart_upload',
        overwritten: data?.overwritten ?? false,
        etag: data?.etag,
        partCount: data?.partCount,
      });
    }

    case 'data_r2_multipart_abort': {
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, upload_id, environment } = DataR2MultipartAbortInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // Idempotent cleanup (no confirm — no live object touched). Honest multipart_not_available until wired.
      const result = await r2Adapter.mutate(scoped.scope, {
        action: 'abort_multipart_upload',
        key,
        uploadId: upload_id,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not abort the multipart upload.');
      const data = result.data as { aborted?: boolean } | undefined;
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        upload_id,
        action: 'abort_multipart_upload',
        aborted: data?.aborted ?? true,
      });
    }

    case 'data_r2_bucket_config': {
      // Flag-gated on the reserved per_site_r2 flag (dark → err, mirroring the Data-tab R2 404).
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, environment } = DataR2BucketConfigInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF bucket name —
      // the caller named only site_id; the bucket is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // READ-ONLY. The adapter reports each setting's requiresPlatformAdmin honestly (CORS/lifecycle owner-
      // readable; public-access + custom-domains platform-administered) — never a fake control. No creds returned.
      const result = await r2Adapter.bucketConfig(scoped.scope);
      if (!result.ok) return err(result.error?.message ?? 'Could not read the R2 bucket configuration.');
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        exists: result.data?.exists ?? false,
        settings: result.data?.settings ?? [],
      });
    }

    case 'data_r2_preview_url': {
      // Flag-gated on the reserved per_site_r2 flag (dark → err, mirroring the Data-tab R2 404).
      if (!(await isFlagOn(env, PER_SITE_R2_FLAG, { orgId, siteId: String(args.site_id ?? '') }))) {
        return err('Per-site R2 is not enabled for this account.');
      }
      const { site_id, key, environment } = DataR2PreviewUrlInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveR2Scope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // CREDENTIAL-SAFE (INV-6): the adapter returns a SCOPED short-lived handle when wired, or an honest
      // available:false + approach — NEVER an account credential, NEVER a fabricated creds-bearing URL.
      const result = await r2Adapter.previewUrl(scoped.scope, { key });
      if (!result.ok) return err(result.error?.message ?? 'Could not build a preview URL.');
      return ok({
        site_id,
        environment,
        bucketName: scoped.scope.resourceId,
        key,
        found: result.data?.found ?? false,
        contentType: result.data?.contentType,
        size: result.data?.size,
        kind: result.data?.kind,
        available: result.data?.available ?? false,
        url: result.data?.url,
        expiresInSeconds: result.data?.expiresInSeconds,
        approach: result.data?.approach,
      });
    }

    case 'data_vectorize_list': {
      // Flag-gated on the reserved per_site_vectorize flag (dark → err, mirroring the Data-tab Vectorize 404).
      if (
        !(await isFlagOn(env, PER_SITE_VECTORIZE_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Vectorize is not enabled for this account.');
      }
      const { site_id, environment } = DataVectorizeListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF index name/namespace —
      // the caller named only site_id; the index is server-resolved from the registry, the namespace derived.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveVectorizeScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      const result = await vectorizeAdapter.list(scoped.scope);
      if (!result.ok) return err(result.error?.message ?? 'Could not read the Vectorize namespace.');
      return ok({
        site_id,
        environment,
        indexName: result.data?.indexName,
        namespace: result.data?.namespace,
        dimensions: result.data?.dimensions,
        metric: result.data?.metric,
        metadataIndexes: result.data?.metadataIndexes ?? [],
      });
    }

    case 'data_vectorize_describe': {
      if (
        !(await isFlagOn(env, PER_SITE_VECTORIZE_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Vectorize is not enabled for this account.');
      }
      const { site_id, ids, environment } = DataVectorizeDescribeInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveVectorizeScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // NAMESPACE-SCOPED get-by-ids — the adapter derives the namespace from siteId + filters CF's result to
      // it, so a foreign vector is never returned. METADATA ONLY — the adapter never returns raw vector values.
      const result = await vectorizeAdapter.get(scoped.scope, { ids });
      if (!result.ok) return err(result.error?.message ?? 'Could not describe the Vectorize index.');
      return ok({
        site_id,
        environment,
        indexName: result.data?.indexName,
        namespace: result.data?.namespace,
        dimensions: result.data?.dimensions,
        metric: result.data?.metric,
        count: result.data?.vectors.length ?? 0,
        vectors: result.data?.vectors ?? [],
        metadataOnly: true,
      });
    }

    case 'data_vectorize_upsert': {
      // Flag-gated on the reserved per_site_vectorize flag (dark → err, mirroring the Data-tab Vectorize 404).
      if (
        !(await isFlagOn(env, PER_SITE_VECTORIZE_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Vectorize is not enabled for this account.');
      }
      const { site_id, vectors, environment } = DataVectorizeUpsertInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF index name/namespace —
      // the caller named only site_id + vectors; the index is server-resolved, the namespace server-derived
      // and FORCED onto every vector by the adapter (a caller can never target a foreign partition).
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveVectorizeScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      const result = await vectorizeAdapter.mutate(scoped.scope, {
        action: 'upsert',
        vectors: vectors.map((v) => ({ id: v.id, values: v.values, metadata: v.metadata })),
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not upsert the vectors.');
      const data = result.data as { namespace?: string; count?: number; mutationId?: string } | undefined;
      return ok({
        site_id,
        environment,
        indexName: scoped.scope.resourceId,
        namespace: data?.namespace,
        action: 'upsert',
        count: data?.count ?? 0,
        ...(data?.mutationId ? { mutationId: data.mutationId } : {}),
      });
    }

    case 'data_vectorize_delete': {
      if (
        !(await isFlagOn(env, PER_SITE_VECTORIZE_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Vectorize is not enabled for this account.');
      }
      const { site_id, ids, confirm, environment } = DataVectorizeDeleteInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveVectorizeScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter enforces BOTH the namespace-isolation (only in-namespace ids are deleted; a foreign id is
      // never sent to CF) AND the destructive gate: no confirm:true → a `confirmation_required` error that
      // REPORTS the in-namespace id count that would be removed (nothing deleted).
      const result = await vectorizeAdapter.mutate(scoped.scope, { action: 'delete', confirm, ids });
      if (!result.ok) return err(result.error?.message ?? 'Could not delete the vectors.');
      const data = result.data as
        | { namespace?: string; deleted?: number; skipped?: number; mutationId?: string }
        | undefined;
      return ok({
        site_id,
        environment,
        indexName: scoped.scope.resourceId,
        namespace: data?.namespace,
        action: 'delete',
        deleted: data?.deleted ?? 0,
        skipped: data?.skipped ?? 0,
        ...(data?.mutationId ? { mutationId: data.mutationId } : {}),
      });
    }

    case 'data_connections_list': {
      // Flag-gated on the reserved per_site_connections flag (dark → err, mirroring the Data-tab 404).
      if (
        !(await isFlagOn(env, PER_SITE_CONNECTIONS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site connections are not enabled for this account.');
      }
      const { site_id, environment } = DataConnectionsListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. A connection is NOT a CF object —
      // no resolveResourceRef; the adapter reads mcp_connections via env.DB, filtered to the OWNED site id.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // The site id IS the scope's resourceId for connections; env.DB is attached server-side.
      const result = await connectionAdapter.list({
        accessPolicy: 'read_only',
        accountId: env.CF_ACCOUNT_ID ?? '',
        auth: undefined as never,
        db,
        environment,
        orgId,
        resourceId: site_id,
        siteId: site_id,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not read the site connections.');
      // ⛔ Only secret-free fields cross the boundary — the adapter never surfaces a secret column.
      return ok({
        site_id,
        environment,
        count: result.data?.count ?? 0,
        connections: result.data?.connections ?? [],
      });
    }

    case 'data_connection_describe': {
      if (
        !(await isFlagOn(env, PER_SITE_CONNECTIONS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site connections are not enabled for this account.');
      }
      const { site_id, id, environment } = DataConnectionDescribeInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // The adapter binds BOTH the owned site id AND the connection id, so a foreign connection is never
      // returned even if its id is guessed. METADATA ONLY — never a token/password/connection-string.
      const result = await connectionAdapter.get(
        {
          accessPolicy: 'read_only',
          accountId: env.CF_ACCOUNT_ID ?? '',
          auth: undefined as never,
          db,
          environment,
          orgId,
          resourceId: site_id,
          siteId: site_id,
        },
        { id },
      );
      if (!result.ok) return err(result.error?.message ?? 'Could not read the connection.');
      return ok({
        site_id,
        environment,
        found: result.data?.found ?? false,
        connection: result.data?.connection,
        secretsRedacted: true,
      });
    }

    case 'data_workflows_list': {
      // Flag-gated on the reserved per_site_workflows flag (dark → err, mirroring the Backend-tab Workflows 404).
      if (
        !(await isFlagOn(env, PER_SITE_WORKFLOWS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Workflows are not enabled for this account.');
      }
      const { site_id, cursor, limit, environment } = DataWorkflowsListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF workflow name/account —
      // the caller named only site_id; the workflow name is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveWorkflowScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // CLAMP (never reject) to the SAME [1, 100] bound CF pages at; the adapter clamps too.
      const result = await workflowAdapter.list(scoped.scope, {
        cursor,
        limit: typeof limit === 'number' ? Math.max(1, Math.min(100, Math.trunc(limit))) : undefined,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not list workflow runs.');
      return ok({
        site_id,
        environment,
        workflowName: result.data?.workflowName,
        count: result.data?.instances.length ?? 0,
        cursor: result.data?.cursor,
        instances: result.data?.instances ?? [],
      });
    }

    case 'data_workflow_get_instance': {
      if (
        !(await isFlagOn(env, PER_SITE_WORKFLOWS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Workflows are not enabled for this account.');
      }
      const { site_id, id, environment } = DataWorkflowGetInstanceInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveWorkflowScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter binds BOTH the resolved workflow name AND the instance id, so a foreign instance is never
      // returned. Status is the ACTUAL CF status (never optimistic); steps are SANITIZED (secrets redacted).
      const result = await workflowAdapter.get(scoped.scope, { id });
      if (!result.ok) return err(result.error?.message ?? 'Could not read the workflow run.');
      return ok({
        site_id,
        environment,
        workflowName: result.data?.workflowName,
        instanceId: result.data?.instanceId,
        found: result.data?.found ?? false,
        status: result.data?.status,
        createdOn: result.data?.createdOn,
        modifiedOn: result.data?.modifiedOn,
        steps: result.data?.steps ?? [],
        outputSanitized: true,
      });
    }

    case 'data_workflow_start': {
      // Flag-gated on the reserved per_site_workflows flag (dark → err, mirroring the Backend-tab Workflows 404).
      if (
        !(await isFlagOn(env, PER_SITE_WORKFLOWS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Workflows are not enabled for this account.');
      }
      const { site_id, params, environment } = DataWorkflowStartInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF workflow name/account —
      // the caller named only site_id; the workflow name is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveWorkflowScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // start CREATES a new run instance — no confirm (it doesn't change/discard an existing run). The adapter
      // returns the ACTUAL CF instance id + status (queued/running — never an optimistic complete).
      const result = await workflowAdapter.mutate(scoped.scope, {
        action: 'start',
        ...(params ? { params } : {}),
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not start the workflow run.');
      return ok({
        site_id,
        environment,
        workflowName: result.data?.workflowName,
        instanceId: result.data?.instanceId,
        status: result.data?.status,
        action: 'start',
        created: result.data?.created ?? false,
      });
    }

    case 'data_workflow_control': {
      if (
        !(await isFlagOn(env, PER_SITE_WORKFLOWS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Workflows are not enabled for this account.');
      }
      const { site_id, instanceId, op, confirm, environment } = DataWorkflowControlInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveWorkflowScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The adapter binds the op to BOTH the resolved workflow name AND the instance id (foreign instance
      // impossible), owns the destructive gate (restart/terminate need confirm:true → a confirmation_required
      // error that WARNS about the replay/discard when confirm is absent), and returns the ACTUAL CF status.
      const result = await workflowAdapter.mutate(scoped.scope, { action: op, instanceId, confirm });
      if (!result.ok) return err(result.error?.message ?? `Could not ${op} the workflow run.`);
      return ok({
        site_id,
        environment,
        workflowName: result.data?.workflowName,
        instanceId: result.data?.instanceId,
        status: result.data?.status,
        action: op,
      });
    }

    case 'data_durable_objects_list': {
      // Flag-gated on the reserved per_site_durable_objects flag (dark → err, mirroring the Backend-tab DO 404).
      if (
        !(await isFlagOn(env, PER_SITE_DURABLE_OBJECTS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Durable Objects are not enabled for this account.');
      }
      const { site_id, environment } = DataDurableObjectsListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF namespace id/account —
      // the caller named only site_id; the DO namespace id is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveDurableObjectScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ Lists NAMESPACES (classes), NEVER instances — CF cannot enumerate DO instances.
      const result = await durableObjectAdapter.list(scoped.scope);
      if (!result.ok) return err(result.error?.message ?? 'Could not list Durable Object namespaces.');
      return ok({
        site_id,
        environment,
        count: result.data?.namespaces.length ?? 0,
        namespaces: result.data?.namespaces ?? [],
        instancesEnumerable: false,
      });
    }

    case 'data_durable_object_describe': {
      if (
        !(await isFlagOn(env, PER_SITE_DURABLE_OBJECTS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Durable Objects are not enabled for this account.');
      }
      const { site_id, id, environment } = DataDurableObjectDescribeInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveDurableObjectScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ Returns identity metadata ONLY — the object's private storage / in-memory state is NEVER read
      // (no CF API can). stateBrowsable is permanently false.
      const result = await durableObjectAdapter.get(scoped.scope, { id });
      if (!result.ok) return err(result.error?.message ?? 'Could not describe the Durable Object.');
      return ok({
        site_id,
        environment,
        objectId: result.data?.objectId,
        namespaceId: result.data?.namespaceId,
        hexId: result.data?.hexId,
        stateBrowsable: false,
      });
    }

    case 'data_durable_object_manage': {
      // Flag-gated on the reserved per_site_durable_objects flag (dark → err, mirroring the Backend-tab DO 404).
      if (
        !(await isFlagOn(env, PER_SITE_DURABLE_OBJECTS_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Durable Objects are not enabled for this account.');
      }
      const { site_id, action, object_id, confirm, environment } = DataDurableObjectManageInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveDurableObjectScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ NARROW management ONLY: `action` is the CLOSED enum the adapter enforces — NEVER an arbitrary method
      // into customer code. The adapter binds the op to the resolved namespace + the named instance (foreign
      // object impossible), owns the destructive gate (reset needs confirm:true → a confirmation_required error
      // when absent), and honestly reports available:false (nothing called) on this no-per-site-DO deployment.
      const result = await durableObjectAdapter.mutate(scoped.scope, {
        action,
        confirm,
        objectId: object_id,
      });
      if (!result.ok) return err(result.error?.message ?? 'Could not run the Durable Object management op.');
      return ok({
        site_id,
        environment,
        action: result.data?.action,
        objectId: result.data?.objectId,
        namespaceId: result.data?.namespaceId,
        available: result.data?.available ?? false,
        stateBrowsable: false,
      });
    }

    case 'data_queues_list': {
      // Flag-gated on the reserved per_site_queues flag (dark → err, mirroring the Backend-tab Queues 404).
      if (
        !(await isFlagOn(env, PER_SITE_QUEUES_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Queues are not enabled for this account.');
      }
      const { site_id, environment } = DataQueuesListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF queue id/account —
      // the caller named only site_id; the queue id is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveQueueScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ CONFIG + METRICS only — NEVER a message body or a "history" (peek ≠ history; pull = leases + ack).
      const result = await queueAdapter.list(scoped.scope);
      if (!result.ok) return err(result.error?.message ?? 'Could not list Queues.');
      return ok({
        site_id,
        environment,
        count: result.data?.queues.length ?? 0,
        available: result.data?.available ?? false,
        queues: result.data?.queues ?? [],
        pullLeasesAndNeedsAck: true,
      });
    }

    case 'data_queue_describe': {
      if (
        !(await isFlagOn(env, PER_SITE_QUEUES_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Queues are not enabled for this account.');
      }
      const { site_id, id, environment } = DataQueueDescribeInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveQueueScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // The optional id is only an echo — the ONLY queue addressed is the scope's resolved queue, so a
      // foreign queue is never read. ⛔ CONFIG + METRICS only — never a message body or a "history".
      const result = await queueAdapter.get(scoped.scope, { id });
      if (!result.ok) return err(result.error?.message ?? 'Could not describe the queue.');
      return ok({
        site_id,
        environment,
        queueId: result.data?.queueId,
        found: result.data?.found ?? false,
        available: result.data?.available ?? false,
        queue: result.data?.queue,
        messageHistoryAvailable: false,
      });
    }

    case 'data_queue_send': {
      // Flag-gated on the reserved per_site_queues flag (dark → err, mirroring the Backend-tab Queues 404).
      if (
        !(await isFlagOn(env, PER_SITE_QUEUES_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site Queues are not enabled for this account.');
      }
      const { site_id, messages, confirm, environment } = DataQueueSendInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF queue id/account —
      // the caller named only site_id; the queue id is server-resolved from the registry, so a site can
      // never send to another site's queue.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveQueueScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ✅ PRODUCER-ONLY + non-destructive — send APPENDS, so no confirm is required (an optional confirm is
      // forwarded but the adapter never blocks on it). ⛔ NOT peek/pull/ack/purge (separate guarded/leasing ops).
      // The adapter validates the batch, binds to the ONE resolved queue, and returns an honest not_available
      // (nothing sent) when Queues are disabled on this deployment — never a fabricated success.
      const result = await queueAdapter.mutate(scoped.scope, { action: 'send', confirm, messages });
      if (!result.ok) return err(result.error?.message ?? 'Could not send to the queue.');
      return ok({
        site_id,
        environment,
        queueId: result.data?.queueId,
        action: 'send',
        accepted: result.data?.accepted ?? 0,
      });
    }

    case 'data_analytics_list': {
      // Flag-gated on the reserved per_site_observability flag (dark → err, mirroring the Backend-tab
      // Observability 404).
      if (
        !(await isFlagOn(env, PER_SITE_OBSERVABILITY_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site observability is not enabled for this account.');
      }
      const { site_id, environment } = DataAnalyticsListInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF dataset/account —
      // the caller named only site_id; the dataset is server-resolved from the registry.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveAnalyticsScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ available:false when ingest is disabled (the reality today) — an honest 'no data ingested yet'.
      const result = await analyticsEngineAdapter.list(scoped.scope);
      if (!result.ok) return err(result.error?.message ?? 'Could not list Analytics datasets.');
      return ok({
        site_id,
        environment,
        count: result.data?.count ?? 0,
        available: result.data?.available ?? false,
        datasets: result.data?.datasets ?? [],
      });
    }

    case 'data_analytics_query_summary': {
      if (
        !(await isFlagOn(env, PER_SITE_OBSERVABILITY_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('Per-site observability is not enabled for this account.');
      }
      const { site_id, window_days, environment } = DataAnalyticsQuerySummaryInput.parse(args);
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      const scoped = await resolveAnalyticsScope(env, site_id, orgId, environment);
      if (!scoped.ok) return err(scoped.message);
      // ⛔ The AE SQL query is SERVER-BUILT + site-scoped (WHERE blob3 = <siteId>) inside the adapter — the
      // caller supplies ONLY the window (clamped in the adapter to [1, 90]), NEVER a raw query/dataset, so one
      // site can never read another's analytics. Counts are SAMPLED; ingest-disabled → an honest zero summary.
      const result = await analyticsEngineAdapter.get(scoped.scope, { windowDays: window_days });
      if (!result.ok) return err(result.error?.message ?? 'Could not read the analytics summary.');
      return ok({
        site_id,
        environment,
        datasetName: result.data?.datasetName,
        windowDays: result.data?.windowDays,
        available: result.data?.available ?? false,
        totalEvents: result.data?.totalEvents ?? 0,
        events: result.data?.events ?? [],
        sampled: true,
      });
    }

    case 'data_backend_inventory': {
      // Flag-gated on the umbrella data_resource_platform flag (this is the cross-cutting Backend-tab
      // inventory, not a per-kind surface). DARK → err (mirroring the Backend-tab 404), never leak.
      if (
        !(await isFlagOn(env, DATA_RESOURCE_FLAG, {
          orgId,
          siteId: String(args.site_id ?? ''),
        }))
      ) {
        return err('The Data & Resource platform is not enabled for this account.');
      }
      const { site_id, environment } = DataBackendInventoryInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF id/account — the
      // caller named only site_id; the inventory reads the site's OWN records keyed on the owned siteId.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // ⛔ Secret NAMES + last-change ONLY — the reader never SELECTs value_encrypted; no value can leak.
      const inv = await getBackendInventory(env, site_id, orgId, environment);
      return ok(inv);
    }

    case 'data_provision_resource': {
      // Flag-gated on the umbrella data_resource_platform flag (dark → err, mirroring the Data-tab 404).
      if (
        !(await isFlagOn(env, DATA_RESOURCE_FLAG, { orgId, siteId: String(args.site_id ?? '') }))
      ) {
        return err('The Data & Resource platform is not enabled for this account.');
      }
      const { site_id, kind, confirm, environment } = DataProvisionResourceInput.parse(args);
      // Ownership + isolation: org-scope via token.org_id, 404-on-foreign. NEVER a CF id — the caller
      // named only site_id + kind; the resource id is GENERATED server-side + isolated to the owned site.
      const owned = await dbQueryOne<{ id: string }>(
        db,
        `SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [site_id, orgId],
      );
      if (!owned) return err('Site not found.');
      // provisionResource owns the whole flow: idempotent (existing → reuse, create nothing) → REAL
      // account quota check (at cap → honest err, never a silent shared substitution) → the (previously
      // inert) provisioner → registry record → RECOVERABLE partial on a half-provision. confirm:true is
      // REQUIRED (billable infra). Ownership already proven above → pass an always-true guard (it still
      // re-scopes every read on site+org).
      const result = await provisionResource(env, site_id, kind, {
        confirm,
        environment,
        orgId,
        ownsSite: async () => true,
      });
      if (result.ok) {
        return ok({
          site_id,
          environment,
          kind,
          resourceId: result.resourceId,
          registryRowId: result.registryRowId,
          created: result.created,
          displayName: result.displayName,
        });
      }
      // Honest, typed refusal (confirm/quota/partial/etc.) — a record_failed names the created id so the
      // partial state is recoverable; a foreign site is 404-on-foreign (never leak existence).
      switch (result.reason) {
        case 'confirmation_required':
          return err(
            `Provisioning a dedicated ${kind.toUpperCase()} resource creates real, billable Cloudflare infrastructure. Re-run with confirm:true to create it.`,
          );
        case 'quota_at_cap':
          return err(
            `The Cloudflare account ${kind.toUpperCase()} quota has been reached — cannot provision a new dedicated ${kind.toUpperCase()} resource. (A shared resource is never substituted silently.)`,
          );
        case 'quota_check_failed':
          return err('Could not verify Cloudflare account capacity; provisioning was not attempted. Try again shortly.');
        case 'record_failed':
          return err(
            `The ${kind.toUpperCase()} resource was CREATED (id/name: ${result.resourceId}) but recording it failed — recoverable: re-run data_provision_resource to finish (it reuses the created resource). Detail: ${result.detail}`,
          );
        case 'not_owned':
          return err('Site not found.');
        default:
          return err(`Could not provision the dedicated ${kind.toUpperCase()} resource.`);
      }
    }

    default:
      return err(`Tool '${name}' is advertised but not yet wired.`);
  }
}

/**
 * Resolve a site's OWN dedicated KV namespace into a {@link ResolvedScope} for the kv adapter, SERVER-SIDE.
 * The caller already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this maps the
 * OWNED `(site, environment, kind='kv')` to its registry-recorded CF namespace id via `resolveResourceRef`
 * (the same resolver the routes use — no CF id is ever accepted from the client), then attaches server-side
 * credentials + account. An honest failure (per-site KV is INERT until provisioned, so a blank site has no
 * `kv` registry row) returns a typed, user-safe message — NEVER a fabricated namespace.
 */
async function resolveKvScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does
  // not re-query (it still re-scopes the registry lookup on siteId + orgId + kind='kv').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'kv' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // not_registered = per-site KV not provisioned yet (backend-ready but INERT). Honest, not a leak.
    if (resolved.reason === 'not_registered') {
      return { message: 'This site does not have a KV namespace yet.', ok: false };
    }
    return { message: 'Could not open the site KV namespace.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site KV namespace.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * Resolve a site's OWN dedicated R2 bucket into a {@link ResolvedScope} for the r2 adapter, SERVER-SIDE.
 * The caller already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this maps the
 * OWNED `(site, environment, kind='r2')` to its registry-recorded CF bucket name via `resolveResourceRef`
 * (the same resolver the routes use — no CF bucket name is ever accepted from the client), then attaches
 * server-side credentials + account. The account-wide R2 credentials NEVER reach the client. An honest
 * failure (per-site R2 is INERT until provisioned, so a blank site has no `r2` registry row) returns a
 * typed, user-safe message — NEVER a fabricated bucket. Mirrors {@link resolveKvScope} exactly.
 */
async function resolveR2Scope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does
  // not re-query (it still re-scopes the registry lookup on siteId + orgId + kind='r2').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'r2' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // not_registered = per-site R2 not provisioned yet (backend-ready but INERT). Honest, not a leak.
    if (resolved.reason === 'not_registered') {
      return { message: 'This site does not have an R2 bucket yet.', ok: false };
    }
    return { message: 'Could not open the site R2 bucket.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site R2 bucket.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * Resolve a site's Vectorize scope into a {@link ResolvedScope} for the vectorize adapter, SERVER-SIDE. The
 * caller already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this maps the OWNED
 * `(site, environment, kind='vectorize')` to its registry-recorded CF index NAME via `resolveResourceRef` (the
 * same resolver the routes use — no CF index name is ever accepted from the client). Per-site isolation is a
 * NAMESPACE partition inside that SHARED index (namespace ≠ quota) — the adapter DERIVES the site's namespace
 * from `scope.siteId` (never caller-supplied), so `resourceId` here is the shared index name only. The
 * account-wide CF credentials NEVER reach the client. An honest failure (per-site Vectorize provisioning is
 * NOT wired yet — the reconciler records no vectorize allocation source, so a blank site has no `vectorize`
 * registry row) returns a typed, user-safe message — NEVER a fabricated index/namespace. Mirrors
 * {@link resolveR2Scope} exactly.
 */
async function resolveVectorizeScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does not
  // re-query (it still re-scopes the registry lookup on siteId + orgId + kind='vectorize').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'vectorize' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // not_registered = per-site Vectorize not provisioned yet (namespace provisioning not wired). Honest.
    if (resolved.reason === 'not_registered') {
      return { message: 'This site does not have a Vectorize namespace yet.', ok: false };
    }
    return { message: 'Could not open the site Vectorize index.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site Vectorize index.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      // The SHARED index name (server-resolved). The adapter derives the site's namespace from siteId.
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * Resolve a site's Workflow scope into a {@link ResolvedScope} for the workflow adapter, SERVER-SIDE. The
 * caller already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this maps the OWNED
 * `(site, environment, kind='workflow')` to its registry-recorded CF workflow NAME via `resolveResourceRef`
 * (the same resolver the routes use — no CF workflow name is ever accepted from the client), then attaches
 * server-side credentials + account. The CF Workflows instances API is account-level for that name, but the
 * name itself is resolved from the OWNED site's row — a caller can address no other workflow. The account-wide
 * CF credentials NEVER reach the client. An honest failure (per-site Workflow provisioning is NOT wired — the
 * reconciler records no workflow allocation source, so a blank site has no `workflow` registry row) returns a
 * typed, user-safe message — NEVER a fabricated workflow. Mirrors {@link resolveVectorizeScope} exactly.
 */
async function resolveWorkflowScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does not
  // re-query (it still re-scopes the registry lookup on siteId + orgId + kind='workflow').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'workflow' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // not_registered = per-site Workflow not provisioned yet (definitions are code-deployed, not per-site). Honest.
    if (resolved.reason === 'not_registered') {
      return { message: 'This site does not have a workflow yet.', ok: false };
    }
    return { message: 'Could not open the site workflow.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site workflow.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      // The workflow NAME (server-resolved). The adapter binds instance ops to this name.
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * Resolve a site's OWN Durable Object CLASS namespace into a {@link ResolvedScope} for the durable_object
 * adapter, SERVER-SIDE. The caller already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?`
 * gate); this maps the OWNED `(site, environment, kind='durable_object')` to its registry-recorded CF
 * namespace id via `resolveResourceRef` (the same resolver the routes use — no CF id is ever accepted from
 * the client), then attaches server-side credentials + account. Only `SITE_BUILDER` is bound; there is NO
 * per-site DO namespace (the reconciler records no durable_object allocation source), so a blank site has no
 * `durable_object` registry row → an honest failure returns a typed, user-safe message — NEVER a fabricated
 * namespace, and NEVER any object state.
 */
async function resolveDurableObjectScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does not
  // re-query (it still re-scopes the registry lookup on siteId + orgId + kind='durable_object').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'durable_object' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // not_registered = no per-site DO namespace (only SITE_BUILDER is bound; none is per-site). Honest.
    if (resolved.reason === 'not_registered') {
      return { message: 'This site does not have a Durable Object namespace yet.', ok: false };
    }
    return { message: 'Could not open the site Durable Object namespace.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site Durable Object namespace.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      // The DO NAMESPACE id (server-resolved). The adapter filters/addresses ops to this namespace only.
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * Resolve a site's OWN Queue into a {@link ResolvedScope} for the queue adapter, SERVER-SIDE. The caller
 * already proved org ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this maps the OWNED
 * `(site, environment, kind='queue')` to its registry-recorded CF queue id via `resolveResourceRef` (the
 * same resolver the routes use — no CF queue id is ever accepted from the client), then attaches server-side
 * credentials + account. The adapter binds every read to this ONE queue id, so a caller can NEVER
 * peek/ack/purge another site's messages. Queues are UNSUPPORTED on this deployment — there is NO `QUEUE`
 * binding and `queue` ∈ `UNSUPPORTED_KINDS`, so `resolveResourceRef` returns `unsupported_kind`; a blank
 * site records no queue allocation source, so it has no `queue` registry row → an honest failure returns a
 * typed, user-safe message — NEVER a fabricated queue, and NEVER a message body. Mirrors
 * {@link resolveDurableObjectScope} exactly.
 */
async function resolveQueueScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  // The ownership gate already passed in the dispatcher; pass an always-true guard so the resolver does not
  // re-query (it still re-scopes the registry lookup on siteId + orgId + kind='queue').
  const resolved = await resolveResourceRef(
    env,
    siteId,
    { environment, kind: 'queue' },
    { orgId, ownsSite: async () => true },
  );
  if (!resolved.ok) {
    // unsupported_kind = Queues not enabled on this deployment (no QUEUE binding); not_registered = no
    // per-site queue. Both are honest "not available", NEVER a fake empty queue.
    if (resolved.reason === 'unsupported_kind' || resolved.reason === 'not_registered') {
      return { message: 'This site does not have a queue yet.', ok: false };
    }
    return { message: 'Could not open the site queue.', ok: false };
  }
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Could not open the site queue.', ok: false };
  return {
    ok: true,
    scope: {
      accessPolicy: resolved.accessPolicy,
      accountId: resolved.accountId,
      auth,
      environment,
      orgId,
      // The queue id (server-resolved). The adapter binds every read to this ONE queue — no cross-site access.
      resourceId: resolved.resourceId,
      siteId,
    },
  };
}

/**
 * The shared platform Analytics Engine dataset name (mirrors `cf_analytics.ts`). Observability is a
 * `shared_platform`, cross-cutting Worker-level concern — there is NO per-site AE dataset, so this is NOT
 * resolved from a per-site registry row (a blank site has no `analytics_engine` allocation). Per-site
 * isolation is the adapter's SERVER-BUILT `WHERE blob3 = <siteId>`, never a separate dataset.
 */
const ANALYTICS_DATASET = 'projectsites_admin_v1';

/**
 * Resolve the site's Observability surface into a {@link ResolvedScope} for the analytics_engine adapter,
 * SERVER-SIDE. Unlike the per-store scopes, this does NOT call `resolveResourceRef` — Analytics Engine is a
 * `shared_platform` dataset (one shared {@link ANALYTICS_DATASET}, NOT per-site), surfaced as a cross-cutting
 * Worker-level section, so there is no per-site registry row to resolve. The caller already proved org
 * ownership (the dispatcher's `WHERE id=? AND org_id=?` gate); this attaches server-side credentials + account
 * + the shared dataset name, and — CRITICALLY — the ingest-enabled state (`env.ANALYTICS_INGEST_ENABLED`) the
 * adapter uses to honestly report `available:false` when ingest is off (the reality today). The adapter builds
 * every AE SQL query with a mandatory `WHERE blob3 = siteId`, so isolation is structural (a caller supplies no
 * dataset, no account, no query). An account/credentials gap returns a typed, user-safe message — NEVER a
 * fabricated summary.
 */
async function resolveAnalyticsScope(
  env: Env,
  siteId: string,
  orgId: string,
  environment: 'preview' | 'production',
): Promise<
  | { ok: true; scope: import('../data_resource_registry/adapter.js').ResolvedScope }
  | { ok: false; message: string }
> {
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { message: 'Observability is not available for this account.', ok: false };
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { message: 'Observability is not available for this account.', ok: false };
  return {
    ok: true,
    scope: {
      // Read-only observability surface — no mutation path.
      accessPolicy: 'read_only',
      accountId: account,
      auth,
      environment,
      // Server-read ingest state — the adapter reports available:false (honest 'no data ingested yet') when off.
      ingestEnabled: env.ANALYTICS_INGEST_ENABLED === 'true',
      orgId,
      // The shared platform dataset name (NOT per-site). The adapter scopes every query to `siteId` via a
      // server-built WHERE — a caller can never read another site's analytics.
      resourceId: ANALYTICS_DATASET,
      siteId,
    },
  };
}
