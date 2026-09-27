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
  DataKvListKeysInput,
  DataKvGetInput,
  DataKvPutInput,
  DataKvDeleteInput,
  DataR2ListObjectsInput,
  DataR2HeadObjectInput,
  DataR2PutObjectInput,
  DataR2DeleteObjectInput,
  DataVectorizeListInput,
  DataVectorizeDescribeInput,
  DataConnectionsListInput,
  DataConnectionDescribeInput,
  DataWorkflowsListInput,
  DataWorkflowGetInstanceInput,
  DataDurableObjectsListInput,
  DataDurableObjectDescribeInput,
  DataQueuesListInput,
  DataQueueDescribeInput,
  DataAnalyticsListInput,
  DataAnalyticsQuerySummaryInput,
  DataBackendInventoryInput,
} from './schemas.js';
import { getBackendInventory } from '../data_resource_registry/backend_inventory.js';

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
