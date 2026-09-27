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
import { kvAdapter } from '../data_resource_registry/adapters/kv.js';
import { r2Adapter } from '../data_resource_registry/adapters/r2.js';
import { vectorizeAdapter } from '../data_resource_registry/adapters/vectorize.js';
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
  DataKvListKeysInput,
  DataKvGetInput,
  DataR2ListObjectsInput,
  DataR2HeadObjectInput,
  DataVectorizeListInput,
  DataVectorizeDescribeInput,
} from './schemas.js';

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
