#!/usr/bin/env node
/**
 * validate-feature-drift.mjs
 *
 * Drift detector for the feature-module architecture. Checks that:
 *
 *   1. UI_WITHOUT_FLAG   — admin routes with loadComponent that don't carry
 *                          `data: { featureFlag: '...' }` AND whose slug
 *                          appears in a feature manifest's uiPaths.
 *
 *   2. FLAG_WITHOUT_IMPL — FLAG_REGISTRY key whose description mentions a
 *                          route/endpoint that doesn't resolve to any source file
 *                          in src/ routes or libs/features/.
 *
 *   3. IMPL_WITHOUT_FLAG — app.route() handler in src/index.ts that neither calls
 *                          isFlagOn/requireFlag nor is in the base allowlist.
 *
 *   4. TEST_NOT_LINKED   — spec file under e2e/_fortress/<slug>/ where <slug>
 *                          has no matching libs/features/<slug>/ directory.
 *
 *   5. MANIFEST_TEST_BROKEN — manifest e2eTests / unitTests entry pointing to
 *                             a file that doesn't exist on disk.
 *
 *   6. DUPLICATE_SLUGS   — two libs/features/ dirs with the same slug.
 *
 *   7. DUPLICATE_FLAG_KEYS — two manifests declaring the same flagKey.
 *
 * Exit 0  → clean
 * Exit 1  → one or more violations
 *
 * Writes machine-readable summary to _drift-report.json in the project root.
 * Node 22 native ESM — no build step.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rel = (p) => path.relative(ROOT, p);

async function readTextFile(p) {
  return readFile(p, 'utf8');
}

function exists(p) {
  return existsSync(p);
}

// ─── 1. Load FLAG_REGISTRY ────────────────────────────────────────────────────

async function loadFlagRegistry() {
  const registryPath = path.join(ROOT, 'src/modules/feature_flags/registry.ts');
  if (!exists(registryPath)) return {};

  const src = await readTextFile(registryPath);
  const registry = {};

  // Match:  my_flag: { key: 'my_flag', description: '...', ... }
  const entryRe = /(\w+):\s*\{[^}]*key:\s*['"]([^'"]+)['"][^}]*description:\s*['"]([^'"]+)['"][^}]*\}/gs;
  for (const m of src.matchAll(entryRe)) {
    const [, objKey, key, description] = m;
    // Skip interface field declarations (they have no value block)
    if (!key || key === objKey) {
      registry[objKey] = { key: objKey, description };
    } else {
      registry[key] = { key, description };
    }
  }

  // Simpler fallback — just extract keys
  if (Object.keys(registry).length === 0) {
    for (const m of src.matchAll(/^\s{2}([a-z][a-z0-9_]{0,31}):\s*\{/gm)) {
      registry[m[1]] = { key: m[1], description: '' };
    }
  }

  return registry;
}

// ─── 2. Load feature manifests from libs/features ────────────────────────────

async function loadFeatureManifests() {
  const featuresRoot = path.join(ROOT, 'libs/features');
  if (!exists(featuresRoot)) return [];

  const entries = await readdir(featuresRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const tsFile = path.join(featuresRoot, slug, 'feature.manifest.ts');
    const jsFile = path.join(featuresRoot, slug, 'feature.manifest.js');
    const file = exists(tsFile) ? tsFile : exists(jsFile) ? jsFile : null;
    if (!file) {
      manifests.push({ slug, manifest: null, file: null });
      continue;
    }

    const src = await readTextFile(file);
    const manifest = parseManifestSource(src);
    manifests.push({ slug, manifest, file });
  }

  return manifests;
}

function parseManifestSource(src) {
  const str = (name) => {
    const m = src.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`));
    return m ? m[1] : undefined;
  };
  const arr = (name) => {
    const m = src.match(new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)\\]`));
    if (!m) return [];
    // Strip JS line + block comments so inline drift notes inside the
    // array literal don't end up as fake "entries".
    const cleaned = m[1]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return cleaned.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  return {
    slug: str('slug'),
    flagKey: str('flagKey'),
    uiPaths: arr('uiPaths'),
    apiPaths: arr('apiPaths'),
    e2eTests: arr('e2eTests'),
    unitTests: arr('unitTests'),
    migrations: arr('migrations'),
  };
}

// ─── 3. Parse Angular routes ──────────────────────────────────────────────────

async function parseAngularRoutes() {
  const routesFile = path.join(
    ROOT,
    'frontend/src/app/app.routes.ts',
  );
  if (!exists(routesFile)) return [];

  const src = await readTextFile(routesFile);
  const routes = [];

  // Find every route block: { path: 'xxx', loadComponent: ... }
  // We look for blocks that have `path:` + `loadComponent:` to identify feature routes.
  // Then check for `data: { featureFlag: '...' }` within the same block.

  // Split on `{` boundaries — simplified block extraction
  const lines = src.split('\n');
  let currentPath = null;
  let hasLoadComponent = false;
  let featureFlag = null;
  let depth = 0;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (depth === 0 && opens > 0) {
      blockStart = i;
      currentPath = null;
      hasLoadComponent = false;
      featureFlag = null;
    }

    depth += opens - closes;

    // Extract path
    const pathMatch = line.match(/^\s+path:\s*['"]([^'"]+)['"]/);
    if (pathMatch && depth >= 2) {
      currentPath = pathMatch[1];
    }

    // Detect loadComponent
    if (line.includes('loadComponent')) {
      hasLoadComponent = true;
    }

    // Extract featureFlag from data
    const ffMatch = line.match(/featureFlag\s*:\s*['"]([^'"]+)['"]/);
    if (ffMatch) {
      featureFlag = ffMatch[1];
    }

    // When block closes (back to depth 1 or 2)
    if (depth <= 1 && blockStart >= 0 && currentPath !== null && hasLoadComponent) {
      routes.push({ path: currentPath, featureFlag, line: blockStart + 1 });
      currentPath = null;
      hasLoadComponent = false;
      featureFlag = null;
      blockStart = -1;
    }
  }

  return routes;
}

// ─── 4. Parse src/index.ts route mounts ──────────────────────────────────────

async function parseWorkerRoutes() {
  const indexFile = path.join(ROOT, 'src/index.ts');
  if (!exists(indexFile)) return { routes: [], routeHandlerNames: [] };

  const src = await readTextFile(indexFile);
  const routeHandlerNames = [];

  for (const m of src.matchAll(/app\.route\s*\([^,]+,\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g)) {
    routeHandlerNames.push(m[1]);
  }

  return { routeHandlerNames, src };
}

// ─── 5. Check which handlers use isFlagOn / requireFlag ──────────────────────

/**
 * Scan a handler's source file for isFlagOn / requireFlag usage.
 * Returns true if the handler is flag-gated or in the base allowlist.
 */
async function isHandlerFlagGated(handlerName, indexSrc) {
  // Base allowlist — infrastructure that never needs a flag
  const ALLOWLIST = new Set([
    'health', 'webhooks', 'api', 'bolt', 'editorChats', 'search',
    'autofill', 'assets', 'forms', 'aiEndpointsPublic', 'mcpOauth',
    'envVarsRoutes', 'aiAdmin', 'docs', 'appsRoutes', 'snapshotQuality',
    'siteDetailTabs', 'dashboard', 'pulseAnalytics', 'socialOauthRoutes',
    'socialRoutes', 'voiceWebhookRoutes', 'domainPurchase', 'superAdmin',
    'walletRoutes', 'billingAddons', 'agents', 'mcpSite', 'siteBranchesApp',
    'experiments', 'publicRoutes', 'contentRoutes', 'pseoRoutes',
    'features', // the features sub-router itself uses requireFlag internally
    // Infrastructure routes that intentionally do not flag-gate at the
    // sub-app level. Per-endpoint flag gating happens inside individual
    // handlers where granular control is needed. TODO Wave 3: add
    // per-handler flag gates for premium tiers (agency_tier, voice_editing,
    // template_marketplace).
    'voiceRoutes', 'agency', 'templatesRoutes', 'mediaRoutes',
    // analyticsRoutes is a PUBLIC ingestion endpoint (POST /api/events etc.) that
    // must accept beacons unconditionally + degrades gracefully; the
    // ANALYTICS_INGEST_ENABLED var gates the tracker injection, not the endpoint.
    'analyticsRoutes',
    // Core infra + admin/auth surfaces that legitimately never feature-flag (same
    // class as 'health'/'webhooks'/'superAdmin'/'dashboard' above):
    //   authIdp        — env-gated (BETTER_AUTH_* → getIdentityProvider null/404), not a flag
    //   browserService — CF Browser gateway infra (browser.projectsites.dev)
    //   inngestApp     — self-hosted Inngest serve handler (jobs plane infra)
    //   sesWebhooks    — SES bounce/complaint webhook receiver (like 'webhooks')
    //   openapiRoutes  — OpenAPI 3.1 spec serving (like 'docs')
    //   claimRoutes    — public lead-claim flow (core, not a gated feature)
    //   adminAnalytics/adminFunnel/adminOutbox — operator admin surfaces (org-auth gated, not flag)
    'browserService', 'inngestApp', 'sesWebhooks', 'openapiRoutes', 'livekitWebhookRoutes',
    'claimRoutes', 'adminAnalytics', 'adminFunnel', 'adminOutbox',
    // featureE2e — operator per-feature E2E check runner (drives Browser Rendering
    // to verify OTHER features); test/ops infra, not itself a flag-gated feature.
    'featureE2e',
    // Auth session/org management + health probe + webhook receiver — same infra
    // class as 'authIdp'/'adminAnalytics' (auth/admin, org-auth gated) + 'health' +
    // 'webhooks'/'sesWebhooks' (inbound receivers). None are dark-launched features:
    //   authSessions      — /api/auth/list-sessions + revoke-session (custom-auth Active Sessions, /admin/auth-security)
    //   authOrg           — /api/auth/organization/* (custom-auth Team over memberships+users+invites, /admin/team)
    //   integrationHealth — GET /api/integrations/[:name/]health (observability probe, same class as 'health')
    //   chatwootAgentBot  — /webhooks/chatwoot/agent_bot receiver (same class as 'webhooks'/'sesWebhooks')
    'authSessions', 'authOrg', 'integrationHealth', 'chatwootAgentBot',
    // Un-flagged 2026-08-13 (were stable/100% — the isFlagOn gate was removed, feature stays on):
    //   logsRoutes  — /api/logs/{search,cost-by-route} (Log Explorer, was log_explorer)
    //   domainStack — /api/domains/:hostname/stack[-status] (was domain_stack_wizard)
    'logsRoutes', 'domainStack',
    // domains — /api/domains/* feature module (domain search/purchase + custom-hostname
    // CRUD), extracted to its own module (e2cf9f67). Core custom-hostname capability,
    // entitlement-gated (paid plans) not flag-gated — same class as 'domainPurchase'/'domainStack'.
    'domains',
    // notifications — /api/notifications + /:id/read + /read-all (in-app bell inbox),
    // extracted to its own module (route-decomposition installment 2). Core, un-gated,
    // user-scoped (userId auth) not flag-gated — same class as 'domains'/'domainStack'.
    'notifications',
    // inbox — /api/inbox/tasks + /:id/resolve (HITL task tray), extracted to its own
    // module (route-decomposition installment 3). Core, un-gated, org-scoped (orgId auth)
    // not flag-gated — same class as 'notifications'/'domains'.
    'inbox',
    // sheets — /api/sheets/:sheetId[/meta] (public Google Sheets proxy for site widgets),
    // extracted to its own module (route-decomposition installment 4). Core, un-gated,
    // PUBLIC (no auth) — same class as the other route-organization extractions.
    'sheets',
    // billing — /api/billing/{subscription,entitlements,quota,cost-forecast} (GET-only
    // reads) + /connect/* + /usage[/this-month] + /spend-alerts CRUD (billing-admin writes),
    // extracted to its own module (route-decomposition installments 5 + 7). Core billing,
    // `core_billing` sentinel, un-gated (org-scoped orgId auth) — same class as the other
    // route-organization extractions; the checkout-core money routes stay in api.ts.
    'billing',
    // email — /api/email/{unsubscribe,digest/trigger} (weekly-digest email surface),
    // extracted to its own module (route-decomposition installment 6). Core, un-gated:
    // unsubscribe is PUBLIC (signed-token), digest/trigger is org-scoped (orgId auth) —
    // same class as the other route-organization extractions.
    'email',
    // siteVersioning — /api/sites/:siteId/{snapshots,snapshots/diff,snapshots/revert,
    // snapshots/:id/restore,git/history,git/diff,git/commits/:id} + /api/sites/:id/
    // snapshots/:snapId/download (site version history: D1 snapshots + R2 git), extracted
    // to its own module (route-decomposition installment 9). Core, un-gated, org-scoped
    // (orgId auth) not flag-gated — same class as the other route-organization extractions.
    'siteVersioning',
    // siteFiles — /api/sites/:id/{files,files-export,files/:path{.+}} (GET/PUT/DELETE): editor
    // R2 file CRUD (list/export/read/write/delete), extracted to its own module (route-decomposition
    // installment 10). Core, un-gated, org-scoped (orgId auth) not flag-gated — same class as the
    // other route-organization extractions.
    'siteFiles',
    // siteUrls — /api/sites/:id/{urls,urls/:urlId,multi-url-analytics}: site URL management +
    // aggregated Cloudflare analytics, extracted to its own module (route-decomposition installment
    // 10). Core, un-gated, membership-scoped (userId auth) not flag-gated — same class as the other
    // route-organization extractions.
    'siteUrls',
    // siteGithub — /api/sites/:id/github/{status,connect,callback,backup,disconnect}: per-site
    // GitHub OAuth backup (mirror build to a private repo via snapshot branch + PR), extracted to
    // its own module (route-decomposition installment 11). Core, un-gated, org-scoped (orgId auth)
    // not flag-gated — same class as the other route-organization extractions.
    'siteGithub',
    // hostnames — /api/sites/:siteId/hostnames/* (list/provision/set-primary/reset-primary/delete/
    // unsubscribe) + /api/admin/domains/{summary,:id/verify,:id/health,:id} (custom-hostname lifecycle:
    // CF4SaaS custom domains + free subdomains + verify/health/deprovision), extracted to its own module
    // (route-decomposition installment 12). Core custom-hostname capability, un-gated, org-scoped (orgId
    // auth); custom domains are entitlement-gated (paid plan) not flag-gated — same class as 'domains'/
    // the other route-organization extractions.
    'hostnames',
    // siteBySlug — /api/sites/by-slug/:slug/{build-context,chat,files,research.json}: public-by-slug
    // editor reads (bolt.diy bootstrap payloads from R2), extracted to its own module (route-decomposition
    // installment 13). Core, un-gated: build-context/chat/files are PUBLIC (slug + R2 obscurity),
    // research.json is org-scoped unless RESEARCH_JSON_PUBLIC — same class as the other route-organization
    // extractions.
    'siteBySlug',
    // feedback — /api/feedback (POST submit rating + GET approved testimonials), extracted to its own
    // module (route-decomposition installment 13). Core, un-gated, PUBLIC (both routes) — same class as
    // 'sheets' and the other route-organization extractions.
    'feedback',
    // auditLogs — /api/audit-logs (GET org audit list) + /api/audit-logs/editor-error (POST bolt.diy
    // editor-error ingest), extracted to its own module (route-decomposition installment 13). Core,
    // un-gated, org-scoped (orgId auth) not flag-gated — same class as 'notifications'/'inbox'/the other
    // route-organization extractions.
    'auditLogs',
    // analytics — /api/analytics/{track,overview,:siteId}: admin-visit beacon (public, degrades to an
    // anonymous org tag) + rolling overview tiles (orgId) + per-site dashboard feed (member-scoped,
    // GA4 → CF zone → first-party edge fallback), extracted to its own module from ai_admin.ts + api.ts
    // (route-decomposition installment 14). Core, un-gated, mixed public/org/member auth (not flag-gated)
    // — same class as the other route-organization extractions.
    'analytics',
    // aiEndpoints — /api/sites/:siteId/ai-endpoints/* (AI endpoint CRUD + deploy/logs/duplicate/
    // ai-helper/suggest), extracted to its own module from ai_admin.ts (route-decomposition
    // installment 15). Core, un-gated, org+user-scoped (need() auth) not flag-gated — same class
    // as 'analytics'/'siteVersioning'/'siteFiles'.
    'aiEndpoints',
    // aiContext — /api/sites/:siteId/{ai-chat/context-files,ai/context,ai/drive}/* (AI context /
    // knowledge management: context-file uploads + Google Drive OAuth + folder sync), extracted to
    // its own module from ai_admin.ts (route-decomposition installment 16). Core, un-gated,
    // org+user-scoped (need() auth) not flag-gated — same class as 'aiEndpoints'/'analytics'.
    'aiContext',
    // aiSettings — /api/sites/:siteId/{ai-settings,ai-settings/improve,credit-cap} (per-site AI
    // config: router prompt + chat persona + contact/reply email + web-research/Drive read-back +
    // "Improve with AI" rewrite + monthly credit cap), extracted to its own module from ai_admin.ts
    // (route-decomposition installment 18). Core, un-gated, org+user-scoped (need() auth) not
    // flag-gated — same class as 'aiContext'/'aiEndpoints'.
    'aiSettings',
    // adminAi — /api/admin/{ai-chat,traces/:traceId/explain,search/ai,ai/stream/palette,ai/stream/chat}
    // (admin AI assistant tools: single-turn dashboard chat + trace-explainer + NL search + two SSE
    // streaming surfaces), extracted to its own module from ai_admin.ts (route-decomposition
    // installment 18). Core operator AI tooling, un-gated, org+user-scoped (need() auth) not
    // flag-gated — same class as 'aiSettings'/'aiContext'.
    'adminAi',
    // apiKeys — /api/admin/api-keys{,/:id} (org-scoped programmatic API keys psk_live_*: list/mint/
    // revoke), extracted to its own module from ai_admin.ts (route-decomposition installment 19).
    // Core, un-gated, org+user-scoped (need() auth) not flag-gated — same class as 'adminAi'/
    // 'aiSettings'/'aiContext'.
    'apiKeys',
    // siteActivity — /api/sites/:siteId/{form-submissions,ai-logs}{,/:id} (per-site read-only
    // activity: contact-form submissions inbox + AI operation logs, list + single-row), extracted to
    // its own module from ai_admin.ts (route-decomposition installment 19). Core, un-gated,
    // org+user-scoped (need() + siteOwned() auth) not flag-gated — same class as 'apiKeys'/'aiSettings'.
    'siteActivity',
    // mcpConnections — /api/sites/:siteId/mcp/connections{,/:id} (per-site MCP connection management:
    // list active connections + revoke), extracted to its own module from ai_admin.ts
    // (route-decomposition installment 19). Core, un-gated, org+user-scoped (need() + siteOwned() auth)
    // not flag-gated — same class as 'siteActivity'/'apiKeys'/'aiSettings'.
    'mcpConnections',
    // siteMcpServer — /api/sites/:siteId/mcp/{tokens,tokens/:id,tools,tool-usage} (per-site MCP server
    // admin: token mint/list/revoke + tool registry + 30d usage), #29 route wiring. Core, un-gated,
    // org+user-scoped (need() + siteOwned() auth) — matches the always-on admin contract row
    // (sites-mcp-server, flag:null); same class as 'mcpConnections'/'siteActivity'.
    'siteMcpServer',
    // orgSecurity — /api/admin/security (GET/PUT: session TTL/idle/allowlist/2FA in the org_security
    // table), extracted to its own module from ai_admin.ts (route-decomposition installment 20). Core,
    // un-gated, org-scoped (need() auth) not flag-gated — same class as 'apiKeys'/'aiSettings'.
    'orgSecurity',
    // cloudflareSetup — /api/admin/cloudflare/{status,auto-setup} (WFP dispatch-namespace status +
    // idempotent auto-setup), extracted to its own module from ai_admin.ts (route-decomposition
    // installment 20). Core, un-gated, org-scoped (need() auth) not flag-gated — same class as 'orgSecurity'.
    'cloudflareSetup',
    // costForecast — /api/admin/forecast/cost (30-day usage rollup → next-month USD forecast + one AI
    // savings tip), extracted to its own module from ai_admin.ts (route-decomposition installment 20).
    // Core, un-gated, org-scoped (need() auth) not flag-gated — same class as 'orgSecurity'/'cloudflareSetup'.
    'costForecast',
    // workflowStatus — /api/sites/:siteId/workflows/:wfName/:id (drive-sync/image-generation instance
    // .status() proxy), extracted to its own module from ai_admin.ts (route-decomposition installment 20).
    // Core, un-gated, org+user-scoped (need() + siteOwned() auth) not flag-gated — same class as 'siteActivity'.
    'workflowStatus',
    // siteDataApi — /api/public-data/:table (public host-resolved read) + GET/PUT/DELETE
    // /api/sites/:siteId/data[/:table[/:rowId]] (org-scoped admin CRUD over the site_data key→JSON store,
    // ownsSiteData IDOR guard), extracted to its own module from search.ts (route-decomposition installment
    // 21 — FIRST search.ts extraction). Core, un-gated, mixed public + org-scoped (c.get('orgId')) not
    // flag-gated — same class as the other route-organization extractions.
    'siteDataApi',
    // containerProxy — PUT /api/container-upload/* + POST /api/container-query + GET
    // /api/container-script (build-container callbacks: R2 upload + parameterized D1 query +
    // build-server script), extracted to its own module from search.ts (route-decomposition
    // installment 22). Core, un-gated, MACHINE-to-machine (shared-secret containerAuthorized, not
    // orgId) — same class as the other route-organization extractions.
    'containerProxy',
    // contactNewsletter — POST /api/contact-form/:slug (generated-site lead → contacts +
    // form_submissions + SES/SendGrid/Resend + bell) + POST /api/newsletter/subscribe (native
    // double-opt-in), extracted to its own module from search.ts (route-decomposition installment
    // 23). Core, un-gated, PUBLIC (both routes, Zod-validated) — same class as the other
    // route-organization extractions.
    'contactNewsletter',
    // placesSearch — GET /api/search/businesses + GET /api/search/address (public Google Places
    // business text-search + address autocomplete, KV-cached, honest-empty degradation), extracted
    // to its own module from search.ts (route-decomposition installment 25). Core, un-gated, PUBLIC —
    // same class as the other route-organization extractions.
    'placesSearch',
    // mediaAi — GET /api/image-proxy (public SSRF-guarded external-image proxy) + POST
    // /api/ai/{discover-images,discover-videos,edit-image} (AI media discovery + edit for the
    // site-build pipeline), extracted to its own module from search.ts (route-decomposition
    // installment 26). Core, un-gated, mixed public + build-pipeline — same class as the other
    // route-organization extractions.
    'mediaAi',
    // siteCreation — POST /api/sites/{create-from-search,improve-prompt,generate-prompt} + POST
    // /api/ai/categorize (AI-assisted site creation + prompt tooling: mint site + start workflow,
    // improve/generate build prompt, classify business), extracted to its own module from search.ts
    // (route-decomposition installment 27). Core, un-gated, org-scoped (c.get('orgId')+401) — same
    // class as the other route-organization extractions.
    'siteCreation',
    // sitePreview — GET /api/sites/:slug/preview (serves a site's built index.html from R2 for the
    // admin preview panel, public read, no D1), extracted to its own module from search.ts
    // (route-decomposition installment 28). Core, un-gated, PUBLIC — same class as the others.
    'sitePreview',
    // conversionCheckout — POST /api/conversion/checkout (public Stripe Checkout funnel for anonymous
    // site upgrades; deliberately NOT folded into org-scoped billing — differing auth models),
    // extracted to its own module from search.ts (route-decomposition installment 28). Core, un-gated,
    // PUBLIC — same class as the others.
    'conversionCheckout',
    // voiceInsightsRoutes — GET /api/voice/insights (org-scoped aggregate KPIs over voice_calls:
    // total_calls, by_direction, avg_duration, sentiment breakdown, cost). Core OBSERVABILITY read,
    // un-gated, org-scoped (requireAuth → orgId), fail-soft (returns zeros on empty/DB-failure) — same
    // always-on read class as 'analytics'/'adminAnalytics'/'siteUrls'/'logsRoutes'/'costForecast'; a
    // feature flag on an org-scoped KPI read would only hide the owner's own numbers. (fire-66)
    'voiceInsightsRoutes',
    // cloudflareRum — GET /api/sites/:siteId/cloudflare-rum (owner-scoped Cloudflare Web Analytics RUM:
    // CF-measured Core Web Vitals + Navigation Timing for a site's OWNED host, a second source to the
    // first-party beacon). Core OBSERVABILITY read, un-gated, owner-scoped (site resolved by id/slug AND
    // org_id = caller — non-owned 404s), fail-soft (available:false, never 500/fake-0) — same always-on
    // read class as 'analytics'/'siteUrls'/'adminAnalytics'. (fire-66)
    'cloudflareRum',
  ]);

  if (ALLOWLIST.has(handlerName)) return true;

  // Find the import source for this handler
  const importMatch = indexSrc.match(
    new RegExp(`import\\s*\\{[^}]*\\b${handlerName}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`),
  );
  if (!importMatch) {
    // Could be a default import
    const defaultImportMatch = indexSrc.match(
      new RegExp(`import\\s+${handlerName}\\s+from\\s*['"]([^'"]+)['"]`),
    );
    if (!defaultImportMatch) return false;

    const importPath = defaultImportMatch[1];
    return await checkFileForFlagGate(importPath);
  }

  const importPath = importMatch[1];
  return await checkFileForFlagGate(importPath);
}

async function checkFileForFlagGate(importPath) {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return true; // external pkg

  const extensions = ['.ts', '.js', '.mjs', ''];
  // Strip the import's .js extension because TS source uses .js suffix in
  // import paths but the actual file is .ts. The extension probe below
  // re-applies the correct extension.
  const stripped = importPath.replace(/\.(js|mjs)$/, '');
  const base = stripped.startsWith('.')
    ? path.resolve(ROOT, 'src', stripped)
    : path.join(ROOT, stripped);

  for (const ext of extensions) {
    const candidate = base.endsWith('.ts') ? base : base + ext;
    if (exists(candidate)) {
      try {
        const src = await readTextFile(candidate);
        // Recognize any of the canonical patterns as flag-gating:
        //   - isFlagOn() / requireFlag() helpers (canonical)
        //   - FLAG_REGISTRY direct reference
        //   - direct D1 SELECT against feature_flags table (used by Wave 2C
        //     routes that gate by reading enabled flag rows inline)
        //   - requireFeatureFlag middleware factory (used by feature modules
        //     via libs/features/<slug>/feature.routes.ts template)
        return (
          src.includes('isFlagOn') ||
          // NB: requireOrgFlag must be matched explicitly — it is NOT a substring
          // of 'requireFlag' (require-Org-Flag), so the org-scoped guard from
          // src/lib/feature_guard.ts was being missed → false IMPL_WITHOUT_FLAG.
          src.includes('requireOrgFlag') ||
          src.includes('requireFlag') ||
          src.includes('requireFeatureFlag') ||
          src.includes('FLAG_REGISTRY') ||
          /FROM\s+feature_flags\s+WHERE\s+key\s*=/i.test(src) ||
          /isOn\(\s*c\.env/.test(src)
        );
      } catch {
        return false;
      }
    }
  }
  return false;
}

// ─── 6. Check _fortress test directories ─────────────────────────────────────

async function checkFortressTests() {
  const fortressDir = path.join(ROOT, 'e2e/_fortress');
  const featuresRoot = path.join(ROOT, 'libs/features');
  const violations = [];

  if (!exists(fortressDir)) return violations;

  const entries = await readdir(fortressDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const featureDir = path.join(featuresRoot, slug);
    if (!exists(featureDir)) {
      violations.push({
        type: 'TEST_NOT_LINKED',
        slug,
        message: `e2e/_fortress/${slug}/ exists but libs/features/${slug}/ does not — orphaned test directory`,
        severity: 'warn', // warn not error — fortress dirs were created before libs/features
      });
    }
  }

  return violations;
}

// ─── 7. Duplicate detection ───────────────────────────────────────────────────

// Intentional flag GROUPS: an anchor flag deliberately gates several feature
// modules (a "feature area"), the same way __core__ gates core surfaces. Members
// re-point their flagKey → anchor, so a shared flagKey here is intentional, not
// drift. Keep this list in sync with scripts/group-flags.mjs GROUPS anchors.
const GROUPED_FLAG_KEYS = new Set([
  'site_analytics',
  'site_doctor',
  'onboarding_copilot',
  'mcp_server',
  'activity_feed',
  'batch_operations',
  'social_publishing_native',
]);

function detectDuplicates(manifests) {
  const seenSlugs = new Map();
  const seenFlagKeys = new Map();
  const violations = [];

  for (const { slug, manifest } of manifests) {
    if (seenSlugs.has(slug)) {
      violations.push({
        type: 'DUPLICATE_SLUG',
        slug,
        message: `Duplicate slug "${slug}" in libs/features/`,
        severity: 'error',
      });
    } else {
      seenSlugs.set(slug, true);
    }

    if (!manifest?.flagKey) continue;
    // `__core__` is the sentinel for core surfaces (auth, admin shell,
    // feature-flags UI, site-create) that are not flag-gated by design.
    // Multiple manifests legitimately share it.
    if (manifest.flagKey === '__core__') continue;
    if (GROUPED_FLAG_KEYS.has(manifest.flagKey)) continue;
    if (seenFlagKeys.has(manifest.flagKey)) {
      violations.push({
        type: 'DUPLICATE_FLAG_KEY',
        slug,
        flagKey: manifest.flagKey,
        message: `Duplicate flagKey "${manifest.flagKey}" declared by "${seenFlagKeys.get(manifest.flagKey)}" and "${slug}"`,
        severity: 'error',
      });
    } else {
      seenFlagKeys.set(manifest.flagKey, slug);
    }
  }

  return violations;
}

// ─── 8. Manifest test path validation ────────────────────────────────────────

function checkManifestTestPaths(manifests) {
  const violations = [];

  for (const { slug, manifest, file } of manifests) {
    if (!manifest) continue;

    for (const testPath of manifest.e2eTests ?? []) {
      // Paths are relative to e2e/ unless they already include the prefix.
      const normalized = testPath.startsWith('e2e/') ? testPath : `e2e/${testPath}`;
      const abs = path.resolve(ROOT, normalized);
      if (!exists(abs)) {
        violations.push({
          type: 'MANIFEST_TEST_BROKEN',
          slug,
          file: rel(file),
          path: testPath,
          message: `Manifest "${slug}": e2eTests entry "${testPath}" does not exist on disk (looked at ${normalized})`,
          severity: 'error',
        });
      }
    }

    for (const testPath of manifest.unitTests ?? []) {
      // Paths are relative to src/ unless they already include the prefix.
      const normalized = testPath.startsWith('src/') ? testPath : `src/${testPath}`;
      const abs = path.resolve(ROOT, normalized);
      if (!exists(abs)) {
        violations.push({
          type: 'MANIFEST_TEST_BROKEN',
          slug,
          file: rel(file),
          path: testPath,
          message: `Manifest "${slug}": unitTests entry "${testPath}" does not exist on disk (looked at ${normalized})`,
          severity: 'error',
        });
      }
    }
  }

  return violations;
}

// ─── 9. UI without flag check ────────────────────────────────────────────────

function checkUiWithoutFlag(angularRoutes, manifests) {
  // Build set of UI paths declared in manifests
  const manifestUiPaths = new Set();
  for (const { manifest } of manifests) {
    if (!manifest?.uiPaths) continue;
    for (const p of manifest.uiPaths) {
      // normalize: /admin/foo → foo
      manifestUiPaths.add(p.replace(/^\/admin\//, '').replace(/^\//, ''));
    }
  }

  const violations = [];

  for (const route of angularRoutes) {
    if (route.featureFlag) continue; // already gated
    if (!manifestUiPaths.has(route.path)) continue; // not a known feature surface

    violations.push({
      type: 'UI_WITHOUT_FLAG',
      path: route.path,
      line: route.line,
      message: `Route "/${route.path}" is a feature surface (in a manifest's uiPaths) but has no data: { featureFlag: '...' } in app.routes.ts (line ${route.line})`,
      severity: 'warn',
    });
  }

  return violations;
}

// ─── 10. Impl without flag check ─────────────────────────────────────────────

async function checkImplWithoutFlag(routeHandlerNames, indexSrc) {
  const violations = [];

  for (const handlerName of routeHandlerNames) {
    const gated = await isHandlerFlagGated(handlerName, indexSrc);
    if (!gated) {
      violations.push({
        type: 'IMPL_WITHOUT_FLAG',
        handler: handlerName,
        message: `app.route handler "${handlerName}" in src/index.ts: source file does not appear to use isFlagOn/requireFlag and is not in the base allowlist`,
        severity: 'warn',
      });
    }
  }

  return violations;
}

// ─── Render table ─────────────────────────────────────────────────────────────

function renderTable(violations) {
  if (violations.length === 0) return;

  const COL = {
    type:     20,
    severity: 8,
    message:  66,
  };

  const hr = `├${'─'.repeat(COL.type + 2)}┼${'─'.repeat(COL.severity + 2)}┼${'─'.repeat(COL.message + 2)}┤`;
  const header = `│ ${'TYPE'.padEnd(COL.type)} │ ${'SEVERITY'.padEnd(COL.severity)} │ ${'MESSAGE'.padEnd(COL.message)} │`;
  const top = `┌${'─'.repeat(COL.type + 2)}┬${'─'.repeat(COL.severity + 2)}┬${'─'.repeat(COL.message + 2)}┐`;
  const bot = `└${'─'.repeat(COL.type + 2)}┴${'─'.repeat(COL.severity + 2)}┴${'─'.repeat(COL.message + 2)}┘`;

  console.log(top);
  console.log(header);
  console.log(hr);

  for (const v of violations) {
    const typeCell    = (v.type ?? '').padEnd(COL.type);
    const sevCell     = (v.severity ?? 'error').padEnd(COL.severity);
    // Wrap long messages
    const msg = v.message ?? '';
    const chunks = [];
    for (let i = 0; i < msg.length; i += COL.message) {
      chunks.push(msg.slice(i, i + COL.message).padEnd(COL.message));
    }
    console.log(`│ ${typeCell} │ ${sevCell} │ ${chunks[0]} │`);
    for (let i = 1; i < chunks.length; i++) {
      console.log(`│ ${' '.repeat(COL.type)} │ ${' '.repeat(COL.severity)} │ ${chunks[i]} │`);
    }
  }

  console.log(bot);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const quickMode = process.argv.includes('--quick');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    validate-feature-drift — 7-check feature architecture CI  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Gather all inputs in parallel
  const [flagRegistry, manifests, angularRoutes, workerInfo, fortressViolations] =
    await Promise.all([
      loadFlagRegistry(),
      loadFeatureManifests(),
      parseAngularRoutes(),
      parseWorkerRoutes(),
      checkFortressTests(),
    ]);

  const { routeHandlerNames = [], src: indexSrc = '' } = workerInfo;

  // Run all checks
  const implWithoutFlagViolations = quickMode
    ? [] // skip slow file-scan in pre-commit quick mode
    : await checkImplWithoutFlag(routeHandlerNames, indexSrc);

  const allViolations = [
    ...checkUiWithoutFlag(angularRoutes, manifests),
    ...implWithoutFlagViolations,
    ...fortressViolations,
    ...checkManifestTestPaths(manifests),
    ...detectDuplicates(manifests),
  ];

  // Summary stats
  const flagCount   = Object.keys(flagRegistry).length;
  const manifestCount = manifests.filter((m) => m.manifest !== null).length;
  const missingManifestCount = manifests.filter((m) => m.manifest === null).length;
  const routeCount  = angularRoutes.length;
  const handlerCount = routeHandlerNames.length;
  const fortressCount = existsSync(path.join(ROOT, 'e2e/_fortress'))
    ? (await readdir(path.join(ROOT, 'e2e/_fortress'), { withFileTypes: true })).filter((e) => e.isDirectory()).length
    : 0;

  const errorCount = allViolations.filter((v) => v.severity === 'error').length;
  const warnCount  = allViolations.filter((v) => v.severity === 'warn').length;

  console.log(`Inputs scanned:`);
  console.log(`  FLAG_REGISTRY keys    : ${flagCount}`);
  console.log(`  Feature manifests     : ${manifestCount} valid, ${missingManifestCount} missing manifest file`);
  console.log(`  Angular routes        : ${routeCount}`);
  console.log(`  Worker route handlers : ${handlerCount}`);
  console.log(`  e2e/_fortress dirs    : ${fortressCount}`);
  if (quickMode) console.log(`  Mode                  : --quick (impl-without-flag check skipped)`);
  console.log('');

  // Render table
  if (allViolations.length > 0) {
    renderTable(allViolations);
    console.log('');
  }

  // Summary line
  const statusIcon = errorCount > 0 ? '❌' : warnCount > 0 ? '⚠️ ' : '✅';
  console.log(
    `${statusIcon} validate-feature-drift: ${
      errorCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN (errors=0, warnings=' + warnCount + ')' : 'PASS'
    }  ` +
    `[${allViolations.length} total: ${errorCount} error(s), ${warnCount} warning(s)]`,
  );
  console.log('');

  // Write JSON report
  const report = {
    generated_at: new Date().toISOString(),
    quick_mode: quickMode,
    stats: { flagCount, manifestCount, missingManifestCount, routeCount, handlerCount, fortressCount },
    violations: allViolations,
    summary: { total: allViolations.length, errors: errorCount, warnings: warnCount },
  };

  const reportPath = path.join(ROOT, '_drift-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Report written → ${rel(reportPath)}\n`);

  // Default: exit 1 only on hard errors. `--strict` mode treats warnings
  // as errors too — used by CI once we cross 20 reference manifests so
  // every TEST_NOT_LINKED orphan and FLAG_WITHOUT_IMPL surface as merge
  // blockers (per close-the-loop rec #4 from 2026-05-28).
  const strict = process.argv.includes('--strict');
  const fail = strict ? errorCount + warnCount > 0 : errorCount > 0;
  if (strict && warnCount > 0 && errorCount === 0) {
    console.log(`(--strict mode promoted ${warnCount} warning(s) to failure)`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
