/**
 * @module libs/features/data_resource_registry/backend_inventory
 * @description The READ-ONLY Backend-tab connected-resource INVENTORY (Data & Resource Platform
 * Phase 8b — scheduled tasks + Worker bindings). This is NOT a per-kind CRUD adapter — it is a
 * flat, honest inventory of what a site's compute plane HAS: its scheduled tasks (Cron Triggers),
 * its Worker bindings (service / Secrets Store / AI / Browser Rendering / Images / KV / R2 / D1 /
 * DO / …), and its secret NAMES + last-change metadata — NEVER secret VALUES.
 *
 * Why an inventory, not an adapter (directive): most of these products have NO integrated
 * management API in THIS platform. Fabricating CRUD for them would be dishonest. Instead each
 * binding row carries a `managed` flag + an in-platform `manageRoute` when a real management
 * surface exists (e.g. Connections, the Data tab per-kind surfaces), or an honest
 * `managed:false` + `notAvailableReason` when it does not. A binding a customer can only VIEW
 * (Secrets Store, AI, Browser Rendering, Images) is surfaced as read-only presence + a useful
 * description + a doc link, never a fake editor.
 *
 * SECURITY (SECURITY-INVARIANTS.md):
 *  - INV-2/INV-3: org-scoped + owned-site gate is the CALLER's responsibility (the route / MCP
 *    dispatcher runs `SELECT id FROM sites WHERE id=? AND org_id=? AND deleted_at IS NULL` and
 *    404s-on-foreign BEFORE calling this). This function is the read; it re-takes the owned
 *    `siteId` server-side only.
 *  - INV-1: the caller NEVER supplies a CF id — this reads the site's OWN records (its
 *    `site_functions_schedules`, its WfP script bindings via the registry, its `ai_env_vars`
 *    secret NAMES) keyed on the owned `siteId`.
 *  - INV-6 + the directive's hard rule: **no secret VALUE is ever read or returned.** The secrets
 *    inventory SELECTs `key`, `scope`, `is_secret`, `created_at`, `updated_at` — it NEVER SELECTs
 *    `value_encrypted`. The returned shape has no `value`/`secret`/`ciphertext` field at all, so a
 *    value cannot leak even by accident.
 *
 * All D1 access goes through the repo `dbQuery` helper — never raw `db.prepare` here.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

import type { Env } from '../../../src/types/env.js';
import { dbQuery } from '../../../src/services/db.js';
import {
  ResourceEnvironmentSchema,
  type ResourceEnvironment,
} from './schemas.js';

// ─────────────────────────────────────────────────────────────────────────────
// The inventory shapes (Zod — the boundary contract; types are z.infer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Worker-binding KINDS the Backend tab surfaces. Mirrors the CF metadata binding `type`s a
 * site Worker declares (`wfp_dispatch.ts` `metadata.bindings[]`) PLUS the platform-shared bindings
 * a site's compute reaches. Each maps to a human description + whether THIS platform has an
 * integrated management surface for it.
 */
export const BackendBindingKindSchema = z.enum([
  'service', // a service binding (worker→worker), e.g. __PS_SVC → platform worker
  'secret', // a secret_text binding — NAME only, never the value
  'ai', // Workers AI binding (reached via the metered __PS_SVC shim on a site Worker)
  'browser', // Browser Rendering binding
  'images', // Cloudflare Images binding
  'kv', // a KV namespace binding (site data plane — managed on the Data tab)
  'r2', // an R2 bucket binding (site data plane — managed on the Data tab)
  'd1', // a D1 database binding (site data plane — managed on the Data tab)
  'durable_object', // a Durable Object class binding
  'vectorize', // a Vectorize index binding
  'analytics_engine', // an Analytics Engine dataset binding (observability)
  'queue', // a Queue producer/consumer binding (unsupported on this deployment)
  'plain_text', // a plain_text var (NAME + presence only — not a secret, still no value shown here)
  'wasm', // a wasm_module binding
  'other', // any binding type we don't specifically model
]);
export type BackendBindingKind = z.infer<typeof BackendBindingKindSchema>;

/**
 * ONE Worker-binding inventory row — read-only presence + metadata. NEVER carries a value or a CF
 * id. `manageRoute` is an in-PLATFORM route (Angular admin / editor bridge) when an integrated
 * management surface exists; when it does not, `managed:false` + `notAvailableReason` is the honest
 * answer (the directive: "do NOT build fake CRUD for products whose APIs aren't integrated").
 */
export const BackendBindingSchema = z
  .object({
    kind: BackendBindingKindSchema,
    /** The in-Worker binding symbol (e.g. `__PS_KV`, `AI`, `BROWSER`) — a NAME, never a value. */
    name: z.string().min(1),
    /** A useful human description of what this binding is + how the site reaches it. */
    description: z.string().min(1),
    /** Whether THIS platform has an integrated management surface for this binding. */
    managed: z.boolean(),
    /** In-platform route to manage it (present iff `managed`); never a raw CF dashboard URL. */
    manageRoute: z.string().min(1).nullable(),
    /** Honest reason there is no management API here (present iff NOT `managed`). */
    notAvailableReason: z.string().min(1).nullable(),
    /** An external docs link for the product (Cloudflare docs) — informational only. */
    docsUrl: z.string().url().nullable(),
    /** Whether the binding is scoped to this site (dedicated) or a shared platform object. */
    scope: z.enum(['site', 'shared_platform']),
  })
  .strict();
export type BackendBinding = z.infer<typeof BackendBindingSchema>;

/**
 * ONE scheduled-task (Cron Trigger) inventory row. WfP dispatch-namespace scripts have NO native
 * cron — per-site schedules live in `site_functions_schedules` D1 + the platform `scheduled()`
 * dispatcher (memory `wfp-dispatch-scripts-no-native-cron`). This row surfaces the cron expression
 * a site declared; management is via the site's `functions/_scheduled.*` code, not a CF cron API.
 */
export const BackendScheduleSchema = z
  .object({
    /** The cron expression (5-field) the site declared in `functions/_scheduled.*`. */
    cron: z.string().min(1),
    /** How the schedule runs — always the platform cron dispatcher for WfP (no native cron). */
    dispatchedBy: z.literal('platform_cron_dispatcher'),
    /** Human description of when/how it fires. */
    description: z.string().min(1),
  })
  .strict();
export type BackendSchedule = z.infer<typeof BackendScheduleSchema>;

/**
 * ONE secret-NAME inventory row — NAME + last-change metadata ONLY. ⛔ There is deliberately NO
 * `value` field: the value is AES-GCM at rest and is never read here. `scope` distinguishes an
 * org-wide secret from a site-scoped one; `isSecret=false` rows are plain (non-masked) config
 * whose NAME is still all that is surfaced on this inventory.
 */
export const BackendSecretSchema = z
  .object({
    /** The env-var / secret NAME (the only identifier surfaced). */
    name: z.string().min(1),
    /** org-wide, site-scoped, or bound to an MCP provider. */
    scope: z.enum(['org', 'site', 'mcp']),
    /** Whether it is a masked secret (true) or plain visible config (false). Value is NEVER shown either way. */
    isSecret: z.boolean(),
    /** ISO/epoch last-change timestamp (from `updated_at`) — the "last-change" metadata. */
    lastChangedAt: z.string().nullable(),
    /** ISO/epoch created timestamp. */
    createdAt: z.string().nullable(),
  })
  .strict();
export type BackendSecret = z.infer<typeof BackendSecretSchema>;

/** The full Backend-tab inventory envelope for one `(site, environment)`. */
export const BackendInventorySchema = z
  .object({
    siteId: z.string().min(1),
    environment: ResourceEnvironmentSchema,
    /** Whether the site has a deployed Functions Worker (drives whether bindings/schedules are live). */
    functionsDeployed: z.boolean(),
    schedules: z.array(BackendScheduleSchema),
    bindings: z.array(BackendBindingSchema),
    /** Secret NAMES + last-change only — NEVER values (INV-6). */
    secrets: z.array(BackendSecretSchema),
    /** Counts for a quick summary chip. */
    counts: z
      .object({
        schedules: z.number().int().min(0),
        bindings: z.number().int().min(0),
        secrets: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type BackendInventory = z.infer<typeof BackendInventorySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Static binding catalog — the platform-shared bindings + their honest management story
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The site data-plane bindings the runtime shim injects into a site's WfP Worker
 * (`wfp_dispatch.ts` `buildFunctionsWorkerBindings`): `__PS_KV`, `__PS_R2`, and the metered
 * AI/DATA path via `__PS_SVC`. These are the bindings a customer's Functions actually use. Each
 * points at the integrated management surface in THIS platform when one exists (KV/R2/D1 → the
 * Data tab), or an honest read-only note when it does not (AI/Browser/Images/service).
 *
 * `manageRoute` values are in-PLATFORM routes (the editor Data/Backend tabs), NEVER raw CF
 * dashboard URLs — INV-6 keeps CF ids server-side.
 */
const SHARED_BINDING_CATALOG: readonly BackendBinding[] = [
  {
    kind: 'kv',
    name: '__PS_KV',
    description:
      "The site's KV data plane. Your Functions call env.KV; a trusted runtime shim prefixes site:<id>: so you only ever reach your own keys. Managed on the Data tab (KV).",
    managed: true,
    manageRoute: '/admin/data?tab=kv',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/kv/',
    scope: 'site',
  },
  {
    kind: 'r2',
    name: '__PS_R2',
    description:
      "The site's R2 object store. Your Functions call env.R2; the shim prefixes sites-data/<id>/ so you only reach your own objects. Managed on the Data tab (Storage / R2).",
    managed: true,
    manageRoute: '/admin/data?tab=r2',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/r2/',
    scope: 'site',
  },
  {
    kind: 'd1',
    name: 'DATA',
    description:
      "The site's dedicated D1 database, reached via the metered __PS_SVC service binding (a Worker can't statically bind thousands of per-site D1s). Managed on the Data tab (Tables).",
    managed: true,
    manageRoute: '/admin/data?tab=tables',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/d1/',
    scope: 'site',
  },
  {
    kind: 'ai',
    name: 'AI',
    description:
      'Workers AI, reached through the metered __PS_SVC shim (env.AI) with a signed per-request token — no raw AI binding is exposed to your Worker. Read-only here.',
    managed: false,
    manageRoute: null,
    notAvailableReason:
      'Workers AI is invoked through the platform metered shim; there is no per-site AI management API in this platform.',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    scope: 'shared_platform',
  },
  {
    kind: 'service',
    name: '__PS_SVC',
    description:
      'A service binding (in-process worker→worker) to the platform worker — backs env.AI and env.DATA via signed, metered calls. Presence only; not customer-editable.',
    managed: false,
    manageRoute: null,
    notAvailableReason:
      'The platform service binding is provisioned automatically at deploy; there is nothing to configure.',
    docsUrl: 'https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/',
    scope: 'shared_platform',
  },
  {
    kind: 'browser',
    name: 'BROWSER',
    description:
      'Browser Rendering (headless Chromium) is available to the platform for screenshots + snapshots. Presence/informational only — no per-site Browser Rendering management API here.',
    managed: false,
    manageRoute: null,
    notAvailableReason:
      'Browser Rendering has no integrated per-site management API in this platform (used internally for screenshots).',
    docsUrl: 'https://developers.cloudflare.com/browser-rendering/',
    scope: 'shared_platform',
  },
  {
    kind: 'images',
    name: 'IMAGES',
    description:
      'Cloudflare Images (transform/optimize) — informational only. No per-site Images management API is integrated in this platform yet.',
    managed: false,
    manageRoute: null,
    notAvailableReason:
      'Cloudflare Images has no integrated management API in this platform yet.',
    docsUrl: 'https://developers.cloudflare.com/images/',
    scope: 'shared_platform',
  },
];

/**
 * Bindings that correspond to a per-kind surface already built on the Data/Backend tabs. These are
 * only surfaced when the site actually has a registry row of that kind (so a blank site doesn't
 * show a binding it doesn't have). Keyed by `resource_kind`.
 */
const REGISTRY_KIND_BINDINGS: Readonly<
  Record<string, Omit<BackendBinding, 'name'> & { name: string }>
> = {
  vectorize: {
    kind: 'vectorize',
    name: 'RAG_INDEX',
    description:
      "The site's Vectorize namespace (a partition inside the shared projectsites-rag index). Managed on the Data tab (AI Search).",
    managed: true,
    manageRoute: '/admin/data?tab=vectorize',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/vectorize/',
    scope: 'site',
  },
  workflow: {
    kind: 'service',
    name: 'SITE_WORKFLOW',
    description:
      "The site's workflow runs (the platform workflow binding; runs are scoped to your site). Managed on the Backend tab (Workflows).",
    managed: true,
    manageRoute: '/admin/data?tab=workflows',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/workflows/',
    scope: 'shared_platform',
  },
  durable_object: {
    kind: 'durable_object',
    name: 'SITE_BUILDER',
    description:
      'A Durable Object class binding. Instances are addressed at runtime; arbitrary DO state is not browsable (CF has no enumerate-state API). Managed on the Backend tab (Compute).',
    managed: true,
    manageRoute: '/admin/data?tab=durable-objects',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/durable-objects/',
    scope: 'shared_platform',
  },
  analytics_engine: {
    kind: 'analytics_engine',
    name: 'ANALYTICS',
    description:
      "The Analytics Engine dataset your site's events flow into (shared dataset, site-scoped WHERE). Managed on the Backend tab (Observability).",
    managed: true,
    manageRoute: '/admin/data?tab=observability',
    notAvailableReason: null,
    docsUrl: 'https://developers.cloudflare.com/analytics/analytics-engine/',
    scope: 'shared_platform',
  },
  connection: {
    kind: 'other',
    name: 'connections',
    description:
      "External provider connections (Stripe/HubSpot/GitHub/…) linked to your site. Managed on the Data tab (Connections). Secret values stay encrypted at rest — never shown.",
    managed: true,
    manageRoute: '/admin/data?tab=connections',
    notAvailableReason: null,
    docsUrl: null,
    scope: 'site',
  },
  queue: {
    kind: 'queue',
    name: 'QUEUE',
    description:
      'Cloudflare Queues are not enabled on this deployment (no QUEUE binding). This is a placeholder — never a fake empty queue.',
    managed: false,
    manageRoute: null,
    notAvailableReason:
      'Queues are not enabled on this Cloudflare account (no QUEUE binding); code falls back to Workflows.',
    docsUrl: 'https://developers.cloudflare.com/queues/',
    scope: 'shared_platform',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The inventory reader
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal `sites` shape this reader needs. */
interface SiteDeployRow {
  functions_deployed_at: string | null;
}

/** Raw `site_functions_schedules` row (only the columns we surface). */
interface ScheduleRow {
  cron: string;
}

/**
 * Raw `ai_env_vars` row — NOTE the deliberate ABSENCE of `value_encrypted`. This interface is the
 * SELECT allowlist: value columns are not modelled here so they can never be read into memory.
 */
interface SecretNameRow {
  key: string;
  scope: string;
  is_secret: number;
  created_at: number | string | null;
  updated_at: number | string | null;
}

/** Raw `site_resource_registry` kind row — used to decide which per-kind bindings to include. */
interface RegistryKindRow {
  resource_kind: string;
}

/**
 * Build the READ-ONLY Backend-tab inventory for an OWNED `(site, environment)`: scheduled tasks
 * (Cron Triggers), Worker bindings (with honest managed/not-available per product), and secret
 * NAMES + last-change (NEVER values).
 *
 * The caller MUST have already proven org ownership of `siteId` (the route/MCP dispatcher runs the
 * `WHERE id=? AND org_id=?` gate + 404s-on-foreign). This function re-takes only the owned
 * `siteId` + `orgId` and reads the site's OWN records; it never accepts a CF id.
 *
 * @param env - worker env (DB)
 * @param siteId - the OWNED site (server-side, from the route param)
 * @param orgId - the caller's authed org (scopes the `ai_env_vars` read to org + site)
 * @param environment - 'preview' | 'production'
 * @returns a validated {@link BackendInventory}
 */
export async function getBackendInventory(
  env: Env,
  siteId: string,
  orgId: string,
  environment: ResourceEnvironment = 'production',
): Promise<BackendInventory> {
  const env_ = ResourceEnvironmentSchema.parse(environment);

  // 1. Deployment metadata — is a Functions Worker live for this site?
  const { data: siteRows } = await dbQuery<SiteDeployRow>(
    env.DB,
    'SELECT functions_deployed_at FROM sites WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [siteId],
  );
  const functionsDeployed = !!siteRows[0]?.functions_deployed_at;

  // 2. Scheduled tasks (Cron Triggers) — WfP has no native cron; read the site's own schedule rows.
  const { data: scheduleRows } = await dbQuery<ScheduleRow>(
    env.DB,
    'SELECT cron FROM site_functions_schedules WHERE site_id = ? ORDER BY cron',
    [siteId],
  );
  const schedules: BackendSchedule[] = scheduleRows.map((r) => ({
    cron: r.cron,
    dispatchedBy: 'platform_cron_dispatcher' as const,
    description:
      'Declared in functions/_scheduled.*; the platform cron dispatcher fires it on schedule (Workers-for-Platforms has no native cron).',
  }));

  // 3. Worker bindings — the shared data-plane catalog + any per-kind bindings the site actually has.
  const { data: kindRows } = await dbQuery<RegistryKindRow>(
    env.DB,
    `SELECT DISTINCT resource_kind FROM site_resource_registry
       WHERE site_id = ? AND environment = ? AND deleted_at IS NULL`,
    [siteId, env_],
  );
  const presentKinds = new Set(kindRows.map((r) => r.resource_kind));
  const bindings: BackendBinding[] = [...SHARED_BINDING_CATALOG];
  for (const [kind, binding] of Object.entries(REGISTRY_KIND_BINDINGS)) {
    if (presentKinds.has(kind)) bindings.push(binding);
  }

  // 4. Secret NAMES + last-change ONLY — ⛔ value_encrypted is NEVER selected (INV-6).
  //    Scoped to the caller's org, and to org-wide OR this-site secrets.
  const { data: secretRows } = await dbQuery<SecretNameRow>(
    env.DB,
    `SELECT key, scope, is_secret, created_at, updated_at
       FROM ai_env_vars
       WHERE org_id = ? AND deleted_at IS NULL
         AND (scope = 'org' OR (scope = 'site' AND site_id = ?) OR scope = 'mcp')
       ORDER BY scope, key`,
    [orgId, siteId],
  );
  const secrets: BackendSecret[] = secretRows.map((r) => ({
    name: r.key,
    scope: r.scope === 'site' ? 'site' : r.scope === 'mcp' ? 'mcp' : 'org',
    isSecret: r.is_secret !== 0,
    lastChangedAt: r.updated_at != null ? String(r.updated_at) : null,
    createdAt: r.created_at != null ? String(r.created_at) : null,
  }));

  return BackendInventorySchema.parse({
    siteId,
    environment: env_,
    functionsDeployed,
    schedules,
    bindings,
    secrets,
    counts: {
      schedules: schedules.length,
      bindings: bindings.length,
      secrets: secrets.length,
    },
  });
}
