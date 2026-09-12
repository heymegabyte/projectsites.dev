/**
 * @module index
 * @description Main entry point for the Project Sites Cloudflare Worker.
 *
 * Configures global middleware, mounts route modules, handles the
 * catch-all site-serving logic, and exports the Workers fetch/queue/scheduled
 * handlers.
 *
 * ## Middleware Stack (applied to every request)
 *
 * | Order | Middleware          | Purpose                              |
 * | ----- | ------------------- | ------------------------------------ |
 * | 1     | `requestId`         | Generate `X-Request-ID` header       |
 * | 2     | `payloadLimit`      | Reject oversized request bodies      |
 * | 3     | `securityHeaders`   | Set CSP, HSTS, X-Frame-Options       |
 * | 4     | `cors` (API only)   | CORS for `/api/*` endpoints          |
 * | 5     | `errorHandler`      | Catch + format errors as JSON        |
 *
 * ## Routing Priority
 *
 * 1. Health check (`/health`)
 * 2. Search routes (`/api/search/*`, `/api/sites/lookup`, `/api/sites/search`)
 * 3. API routes (`/api/*`) — includes `/api/sites/:id` param routes
 * 4. Webhook routes (`/webhooks/*`)
 * 5. Catch-all: marketing site or subdomain site serving
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Variables } from './types/env.js';
import { requestIdMiddleware } from './middleware/request_id.js';
import { requestLogger } from './lib/log.js';
import { notFoundHtml } from './lib/not_found_page.js';
import { applyMarketingMeta, isKnownMarketingRoute } from './marketing_routes.js';
import { llmLandingPage } from './lib/llm_landing_page.js';
import { renderDocsReferencePage } from './lib/docs_reference_page.js';
import { resolveSystemService, systemServiceLanding } from './lib/system_service_landing.js';
import { errorHandler } from './middleware/error_handler.js';
import { payloadLimitMiddleware } from './middleware/payload_limit.js';
import { securityHeadersMiddleware } from './middleware/security_headers.js';
import { authMiddleware } from './middleware/auth.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { health } from './routes/health.js';
import { platformServiceLanding, resolvePlatformService } from './routes/platform_services.js';
import { api } from './routes/api.js';
// EMBEDDED Better Auth (full-cutover rebuild) — dark behind the `better_auth` flag.
// Lazy-imported at the /api/auth/* handler below: the better-auth npm pkg pulls a
// deep ESM-only dep tree that @swc/jest can't load, so a top-level import here
// crashed every test that imports the worker (`../index`). Dynamic import keeps it
// out of the module graph until the flag is on at runtime.
import { isFlagOn as isFlagOnBetterAuth } from './modules/feature_flags/services.js';
import { search } from './routes/search.js';
import { siteDataApi } from '../libs/features/site_data_api/handlers.js'; // per-site D1 data-table API (GET /api/public-data/:table + GET/PUT/DELETE /api/sites/:siteId/data[/:table[/:rowId]]) — extracted from search.ts (route-decomposition installment 21); MUST mount before search + api
import { containerProxy } from '../libs/features/container_proxy/handlers.js'; // build-container callbacks (PUT /api/container-upload/*, POST /api/container-query, GET /api/container-script — shared-secret auth) — extracted from search.ts (route-decomposition installment 22)
import { contactNewsletter } from '../libs/features/contact_newsletter/handlers.js'; // public form ingest (POST /api/contact-form/:slug + POST /api/newsletter/subscribe) — extracted from search.ts (route-decomposition installment 23)
import { placesSearch } from '../libs/features/places_search/handlers.js'; // public Google Places search (GET /api/search/businesses + GET /api/search/address) — extracted from search.ts (route-decomposition installment 25)
import { mediaAi } from '../libs/features/media_ai/handlers.js'; // AI media pipeline (GET /api/image-proxy + POST /api/ai/{discover-images,discover-videos,edit-image}) — extracted from search.ts (route-decomposition installment 26)
import { siteCreation } from '../libs/features/site_creation/handlers.js'; // AI site-creation cluster (POST /api/sites/{create-from-search,improve-prompt,generate-prompt} + POST /api/ai/categorize) — extracted from search.ts (route-decomposition installment 27)
import { sitePreview } from '../libs/features/site_preview/handlers.js'; // GET /api/sites/:slug/preview — R2 index.html preview serve — extracted from search.ts (route-decomposition installment 28)
import { conversionCheckout } from '../libs/features/conversion_checkout/handlers.js'; // POST /api/conversion/checkout — public Stripe funnel — extracted from search.ts (route-decomposition installment 28)
import { featureE2e } from './routes/feature_e2e.js';
import { visionQa } from './routes/vision_qa.js';
import { browserService } from './routes/browser_service.js'; // browser.projectsites.dev /v1/browser/* (CF-first browser abstraction)
import { createJobsRoutes } from './routes/jobs.js'; // POST /api/jobs dispatch seam (§20 WorkflowRouter)
import { adminLeads } from './routes/admin_leads.js';
import { adminOutbox } from './routes/admin_outbox.js';
import { adminFunnel } from './routes/admin_funnel.js';
import { adminAnalytics } from './routes/admin_analytics.js';
import { maybeCompleteClaimBuild } from './services/claim_build_callback.js';
import { claimRoutes } from './routes/claim.js';
import { siteRollbackRoutes } from './routes/site_rollback.js';
import {
  defaultDashboard,
  filterBySource,
  buildMetric,
} from '../libs/features/marketing_dashboard/service.js';
import { generateProposals, scoreEngagement } from '../libs/features/social_agent/service.js';
import { validateJourney } from '../libs/features/visual_automation/service.js';
import { planLaunch, listApps } from '../libs/features/app_launcher/service.js';
import { webhooks } from './routes/webhooks.js';
import { sesWebhooks } from './routes/ses_webhooks.js';
import { chatwootAgentBot } from './routes/chatwoot_agent_bot.js';
import { assets } from './routes/assets.js';
import { forms } from './routes/forms.js';
import { analyticsRoutes } from './routes/analytics.js';
import { APP_JS } from './generated/app_js.js';
import { aiAdmin } from './routes/ai_admin.js';
import { apiTokensAdmin } from './routes/api_tokens_admin.js'; // account psk_ token CRUD for /admin/api-tokens (flag: public_api)
import { authSessions } from './routes/auth_sessions.js'; // custom-auth Active Sessions for /admin/auth-security (Better Auth is dark)
import { authOrg } from './routes/auth_org.js'; // custom-auth Organization/Team for /admin/team (Better Auth is dark)
import { mcpOauth } from './routes/mcp_oauth.js';
import { envVarsRoutes } from './routes/env_vars.js';
import { docs } from './routes/docs.js';
import { autofill } from './routes/autofill.js';
import { bolt } from './routes/bolt_admin.js';
import { openapiRoutes } from './routes/openapi.js';
import { apps as appsRoutes } from './routes/apps.js';
import { snapshotQuality } from './routes/snapshot_quality.js';
import { dashboard } from './routes/dashboard.js';
import { socialRoutes } from './routes/social.js';
import { socialOauthRoutes } from './routes/social_oauth.js';
import { socialPostRoutes } from './routes/social_posts.js';
import { pulseAnalytics, runHourlyPulseAnalyticsCron } from './routes/pulse_analytics.js';
import { voiceRoutes } from './routes/voice.js';
import { logsRoutes } from './routes/logs.js';
import { voiceWebhookRoutes } from './routes/voice_webhooks.js';
import { livekitWebhookRoutes } from './routes/livekit_webhooks.js';
import { domainPurchase } from './routes/domain_purchase.js';
import { domainStack } from './routes/domain_stack.js';
import { superAdmin } from './routes/super_admin.js';
import { wallet as walletRoutes } from './routes/wallet.js';
import { agency } from './routes/agency.js';
import { billingAddons } from './routes/billing_addons.js';
import { agents } from './routes/agents.js';
import { templates as templatesRoutes } from './routes/templates.js';
import { siteBranchesApp } from './routes/site_branches.js';
import { experiments } from './routes/experiments.js';
import { mediaRoutes } from './routes/media.js';
import { publicRoutes } from './routes/public.js';
import features from './routes/features.js';
import { copilot } from './routes/copilot.js';
import { siteDetailTabs } from './routes/site_detail_tabs.js';
import { siteDna } from './routes/site_dna.js';
import { emailDeliverabilityRoutes } from './routes/email_deliverability.js';
import { reviewPublic } from './routes/review_public.js';
import { reviewLinks } from './routes/review_links.js';
import { webhooksAdmin } from './routes/webhooks_admin.js';
import { integrationHealth } from './routes/integration_health.js';
// ── Marketplace + Creator Economy (IDEAS-50 #39/#40/#41/#42)
// Feature modules (libs/features/*) — ideas #33, #34, #36, #46
import { tokenBurnMeter } from '../libs/features/token_burn_meter/handlers.js'; // #13 per-tenant token-burn meter + budget killswitch (flag: token_burn_meter)
import { siteAnalytics } from '../libs/features/site_analytics/handlers.js'; // owner-facing per-site analytics summary (flag: site_analytics)
import { domains } from '../libs/features/domains/handlers.js'; // domain search/purchase/register/suggest — extracted from api.ts (route-decomposition installment 1)
import { notifications } from '../libs/features/notifications/handlers.js'; // in-app notifications inbox (list/mark-read/read-all) — extracted from api.ts (route-decomposition installment 2)
import { inbox } from '../libs/features/inbox/handlers.js'; // HITL task tray (list/resolve) — extracted from api.ts (route-decomposition installment 3)
import { sheets } from '../libs/features/sheets/handlers.js'; // public Google Sheets proxy (data/meta) — extracted from api.ts (route-decomposition installment 4)
import { billing } from '../libs/features/billing/handlers.js'; // GET-only billing reads (subscription/entitlements/quota/cost-forecast) + billing-admin (connect/usage/spend-alerts) — extracted from api.ts (route-decomposition installments 5 + 7)
import { email } from '../libs/features/email/handlers.js'; // weekly-digest email surface (unsubscribe/digest-trigger) — extracted from api.ts (route-decomposition installment 6)
import { siteVersioning } from '../libs/features/site_versioning/handlers.js'; // site version history: D1 snapshots + R2 git history/diff/commits + revert/restore + snapshot download manifest — extracted from api.ts (route-decomposition installment 9)
import { siteFiles } from '../libs/features/site_files/handlers.js'; // editor R2 file CRUD: list/export/read/write/delete — extracted from api.ts (route-decomposition installment 10)
import { siteUrls } from '../libs/features/site_urls/handlers.js'; // site URL management + multi-URL analytics: list/bind/unbind URLs + aggregated CF analytics — extracted from api.ts (route-decomposition installment 10)
import { siteGithub } from '../libs/features/site_github/handlers.js'; // per-site GitHub OAuth backup: status/connect/callback/backup/disconnect — extracted from api.ts (route-decomposition installment 11)
import { hostnames } from '../libs/features/hostnames/handlers.js'; // custom-hostname lifecycle: owner /api/sites/:siteId/hostnames/* + admin /api/admin/domains/* (verify/health/summary/deprovision) — extracted from api.ts (route-decomposition installment 12)
import { siteBySlug } from '../libs/features/site_by_slug/handlers.js'; // public-by-slug editor reads: /api/sites/by-slug/:slug/{build-context,chat,files,research.json} — extracted from api.ts (route-decomposition installment 13)
import { feedback } from '../libs/features/feedback/handlers.js'; // user feedback: POST/GET /api/feedback (submit rating + list approved testimonials) — extracted from api.ts (route-decomposition installment 13)
import { auditLogs } from '../libs/features/audit_logs/handlers.js'; // audit-log read + editor-error ingest: GET /api/audit-logs + POST /api/audit-logs/editor-error — extracted from api.ts (route-decomposition installment 13)
import { analytics } from '../libs/features/analytics/handlers.js'; // analytics: POST /api/analytics/track + GET /api/analytics/overview (from ai_admin.ts) + GET /api/analytics/:siteId (from api.ts) — extracted route-decomposition installment 14; MUST mount before both api and aiAdmin
import { aiContext } from '../libs/features/ai_context/handlers.js'; // AI context/knowledge management (context files + Google Drive sync) for /api/sites/:siteId/{ai-chat/context-files,ai/context,ai/drive}/* — extracted from ai_admin.ts (route-decomposition installment 16); MUST mount before both api and aiAdmin
import { aiSettings } from '../libs/features/ai_settings/handlers.js'; // per-site AI config + credit cap for /api/sites/:siteId/{ai-settings,ai-settings/improve,credit-cap} — extracted from ai_admin.ts (route-decomposition installment 18); MUST mount before both api and aiAdmin
import { adminAi } from '../libs/features/admin_ai/handlers.js'; // admin AI assistant tools (ai-chat + trace-explain + NL search + 2 SSE streams) for /api/admin/{ai-chat,traces/:traceId/explain,search/ai,ai/stream/palette,ai/stream/chat} — extracted from ai_admin.ts (route-decomposition installment 18); MUST mount before both api and aiAdmin
import { apiKeys } from '../libs/features/api_keys/handlers.js'; // org-scoped programmatic API keys (psk_live_*) for /api/admin/api-keys{,/:id} — extracted from ai_admin.ts (route-decomposition installment 19); MUST mount before both api and aiAdmin
import { siteActivity } from '../libs/features/site_activity/handlers.js'; // per-site read-only activity (contact-form submissions + AI logs) for /api/sites/:siteId/{form-submissions,ai-logs}{,/:id} — extracted from ai_admin.ts (route-decomposition installment 19); MUST mount before both api and aiAdmin
import { mcpConnections } from '../libs/features/mcp_connections/handlers.js'; // per-site MCP connection management (list + disconnect) for /api/sites/:siteId/mcp/connections{,/:id} — extracted from ai_admin.ts (route-decomposition installment 19); MUST mount before both api and aiAdmin
import { siteMcpServer } from '../libs/features/site_mcp_server/handlers.js'; // per-site MCP server admin: token mint/list/revoke + tool registry + 30d usage for /api/sites/:siteId/mcp/{tokens,tokens/:id,tools,tool-usage} (#29 wiring) — MUST mount before both api and aiAdmin
import { orgSecurity } from '../libs/features/org_security/handlers.js'; // org security settings (session TTL/idle/allowlist/2FA in org_security) for /api/admin/security (GET/PUT) — extracted from ai_admin.ts (route-decomposition installment 20); MUST mount before both api and aiAdmin
import { cloudflareSetup } from '../libs/features/cloudflare_setup/handlers.js'; // CF account provisioning (WFP dispatch-namespace status + idempotent auto-setup) for /api/admin/cloudflare/{status,auto-setup} — extracted from ai_admin.ts (route-decomposition installment 20); MUST mount before both api and aiAdmin
import { costForecast } from '../libs/features/cost_forecast/handlers.js'; // AI cost forecaster (#95) for /api/admin/forecast/cost — extracted from ai_admin.ts (route-decomposition installment 20); MUST mount before both api and aiAdmin
import { workflowStatus } from '../libs/features/workflow_status/handlers.js'; // workflow instance .status() proxy (drive-sync/image-generation) for /api/sites/:siteId/workflows/:wfName/:id — extracted from ai_admin.ts (route-decomposition installment 20); MUST mount before both api and aiAdmin
import { visitorEvents } from '../libs/features/visitor_events_core/handlers.js'; // public pageview/event beacon ingest (flag: visitor_events_core)
import { recordPageviewFromRequest } from '../libs/features/visitor_events_core/service.js'; // edge-recorded per-request pageview (no flag — core site analytics)
// IDEAS-50 wave 3 — GEO + reputation + growth
import { abuseTakedown } from '../libs/features/abuse_takedown/handlers.js'; // abuse + takedown intake (flag: abuse_takedown)
import { platformMcp } from '../libs/features/platform_mcp/handlers.js'; // platform MCP server for Claude Code etc. (flag: platform_mcp)
import { oauthProvider } from '../libs/features/mcp_oauth_provider/handlers.js'; // OAuth 2.1 AS for MCP one-click connect (flag: mcp_oauth_provider)
import { prodReadinessScore } from '../libs/features/prod_readiness_score/handlers.js'; // GET /api/sites/:siteId/readiness — 0-100 readiness score (flag: site_doctor — prod_readiness_score was folded into that anchor in migration 0628)
import { onboardingCopilot } from '../libs/features/onboarding_copilot/handlers.js'; // /api/onboarding/{checklist,dismiss} — PLG activation checklist (flag: onboarding_copilot)
import { auditTrailExport } from '../libs/features/audit_trail_export/handlers.js'; // GET /api/audit/export — filterable audit-log JSON/CSV export (flag: audit_trail_export)
import { modelRegistry } from '../libs/features/model_registry/handlers.js'; // GET /v1/models — OpenAI-compatible model/provider alias catalog (flag: model_registry)
// Drift-fix (2026-08-07): 3 complete, flag-REGISTERED feature modules that were built but never mounted — their routes were unreachable (404 even with the flag on). Mounting behind their dark flags resolves the drift-detection "dead feature folder" class + makes them reachable on flag promotion. Prod-unchanged: flags are experimental → isFlagOn false → 404, exactly as now.
// ── Feature modules ──
import { paymentsRail } from '../libs/features/payments_rail/handlers.js'; // unified Square+Stripe seam (flag: payments_rail)
import { creditWalletRollover } from '../libs/features/credit_wallet_rollover/handlers.js'; // wallet rollover+promo (flag: credit_wallet_rollover)
import { referralLoop } from '../libs/features/referral_loop/handlers.js'; // refer-a-friend (flag: referral_loop)
import { siteDoctor } from '../libs/features/site_doctor/handlers.js'; // owner-facing A-F health report (flag: site_doctor)
import { previewShareCard } from '../libs/features/preview_share_card/handlers.js'; // GET /api/sites/:siteId/share-card — owner share messages+links+OG (flag: preview_share_card)
import { promptStudio } from '../libs/features/prompt_studio/handlers.js'; // prompt versioning surface (flag: prompt_studio)
import { aiGatewayGuardrails } from '../libs/features/ai_gateway_guardrails/handlers.js'; // Llama Guard middleware (flag: ai_gateway_guardrails)
import { wireframePlanning } from '../libs/features/wireframe_planning/handlers.js'; // pre-gen wireframe plan (flag: wireframe_planning)
import { cmdkAiActionsRouter } from '../libs/features/cmdk_ai_actions/handlers.js'; // Cmd+K AI actions (flag: cmdk_ai_actions)
import { proxyToContainer } from './services/container_dispatcher.js';
import { resolveAppHost } from './services/app_host_resolver.js';
import { getContentType, resolveSite, serveSiteFromR2 } from './services/site_serving.js';
import { maybeDispatchFunctions } from './services/functions_dispatch.js'; // Stage 3.1: child-host /api/* → site's WfP functions worker (ADR-0035 §30)
import { dbQueryOne, dbUpdate } from './services/db.js';
import { deploySiteFunctions, type FunctionsBuildResult } from './services/functions_deploy.js';
import {
  handleFunctionAiRun,
  handleFunctionDataForms,
  handleFunctionDataSite,
  handleFunctionAuthVerifySession,
  handleFunctionTurnstileVerify,
} from './services/functions/internal.js'; // Stage 4.1(d/e)+4.2(b): env.AI/DATA + ctx auth-helper backends (/api/_ps/*)
import { registerAllPrompts } from './services/ai_workflows.js';
import { DOMAINS, escapeHtml } from '@project-sites/shared';
import { parseEnv } from './lib/env.js';
export { SiteGenerationWorkflow } from './workflows/site-generation.js';
export { DriveSyncWorkflow } from './workflows/drive-sync.js';
export { ImageGenerationWorkflow } from './workflows/image-generation.js';
export { SnapshotQualityWorkflow } from './workflows/snapshot-quality.js';
export { SocialPublishWorkflow } from './workflows/social-publish.js';
export { SiteBuilderContainer } from './container.js';
export { TraceHub, ActivityHub } from './durable_objects/trace_hub.js';
export { AppRuntimeContainer } from './durable_objects/app_runtime.js';
// Pulse Inbox deprecated 2026-05-25 — 410-stub class kept so the existing
// `v_conversation_hub` DO migration tag in Cloudflare's history stays valid.
//
// TODO Wave 3 deletion (safe after 2026-08-01):
//   1. Confirm no live DO instances remain (check CF dashboard → Durable Objects →
//      conversation_hub namespace object count = 0).
//   2. Remove this export line.
//   3. Delete `src/durable_objects/conversation_hub.ts`.
//   4. Remove the `v_conversation_hub` entry from wrangler.toml [[durable_objects.bindings]].
//   Rationale: the 410-stub keeps the Cloudflare Workers migration history valid so
//   redeployment doesn't fail with "unknown class" for the historical DO namespace.
//   Once all instances are drained the stub is safe to remove entirely.
export { ConversationHub } from './durable_objects/conversation_hub.js';
// CollabRoomDO (PartyServer + Yjs) — exported so CF knows the class for the
// COLLAB_ROOM binding. INERT until the wrangler.toml block is uncommented
// (watched one-way-door DO migration). Feature: collab_editing.
export { CollabRoomDO } from './durable_objects/collab_room.js';
export { EventDispatcher } from './durable_objects/event_dispatcher.js';
// Job dispatch seam: createJobsRoutes() (POST /api/jobs) routes via getJobRouter(env)
// to CF Workflows or Hatchet Cloud. No external job-runner container.
// Formbricks REMOVED (2026-06-27): class, container, binding, route, env, and the
// orphaned DO namespace all deleted (exceeds the 4-service max). Nothing remains.
// sign.projectsites.dev — self-hosted Documenso e-signature container (dedicated DO).
export { DocumensoContainer } from './durable_objects/documenso_container.js';
// schedule.projectsites.dev — self-hosted cal.diy scheduling container (dedicated DO).
export { CaldiyContainer } from './durable_objects/caldiy_container.js';
// convert.projectsites.dev — self-hosted Gotenberg Office→PDF container (dedicated DO).
export { GotenbergContainer } from './durable_objects/gotenberg_container.js';
export {
  AnythingLlmContainer,
  AppsmithContainer,
  ArizePhoenixContainer,
  AudiobookshelfContainer,
  BookstackContainer,
  CalComContainer,
  ChromaContainer,
  CodeServerContainer,
  CoquiTtsContainer,
  DirectusContainer,
  DroneCiContainer,
  FlowiseContainer,
  FocalboardContainer,
  ForgejoContainer,
  FreshrssContainer,
  GhostContainer,
  GiteaContainer,
  GrafanaContainer,
  HealthchecksContainer,
  ImmichContainer,
  JellyfinContainer,
  KhojContainer,
  LangflowContainer,
  LangfuseContainer,
  LibrechatContainer,
  LinkwardenContainer,
  ListmonkContainer,
  LitellmContainer,
  LobeChatContainer,
  MattermostContainer,
  MemosContainer,
  MinifluxContainer,
  MorphicContainer,
  N8NContainer,
  NavidromeContainer,
  NextcloudContainer,
  NocodbContainer,
  OpenWebuiContainer,
  OutlineContainer,
  PayloadContainer,
  PerplexicaContainer,
  PlausibleContainer,
  PocketbaseContainer,
  QdrantContainer,
  SearxngContainer,
  StirlingPdfContainer,
  TabbyContainer,
  TeableContainer,
  UmamiContainer,
  UptimeKumaContainer,
  VaultwardenContainer,
  VikunjaContainer,
  WeaviateContainer,
  WhisperAsrContainer,
  WikiJsContainer,
} from './durable_objects/app_runtime_subclasses.js';
export { N8NContainer as N8nContainer } from './durable_objects/app_runtime_subclasses.js';

// Register all prompt definitions at module load
registerAllPrompts();

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Global Middleware ───────────────────────────────────────

// Env validation — runs before any route logic.
// parseEnv throws ZodError on missing required secrets → errorHandler returns 500.
app.use('*', async (c, next) => {
  parseEnv(c.env as unknown as Record<string, unknown>);
  await next();
});

// editor.projectsites.dev → proxy EVERYTHING (incl. /api/*) to the bolt-diy
// Pages app. MUST run before the /api route mounts + authMiddleware below, else
// the worker's own projectsites.dev /api routing pre-empts
// editor.projectsites.dev/api/* and returns the worker's 404 — which crashed
// the bolt editor's /api/models fetch (undefined.length in react-toastify).
// Host-gated: non-editor hosts fall straight through, so projectsites.dev
// routing is completely unaffected. (Was a late fallback after the /api mounts;
// hoisted round 145.)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname !== DOMAINS.BOLT_BASE) return next();
  // Embed-only gate: bolt.diy is an INTERNAL admin tool embedded as an iframe in
  // projectsites.dev/admin — it must not be a publicly-usable destination
  // (AI-credit + WebContainer compute abuse). CF Access can't gate an iframe
  // (its login page sets X-Frame-Options), so we gate here: block a DIRECT
  // top-level navigation (and cross-site top-level loads). The admin iframe
  // (sec-fetch-dest=iframe, same-site), every same-origin sub-request
  // (assets/api/HMR/WebContainer), and old UAs without Sec-Fetch all pass.
  const sfDest = c.req.header('sec-fetch-dest');
  const sfSite = c.req.header('sec-fetch-site');
  if (sfDest === 'document' && (sfSite === 'none' || sfSite === 'cross-site')) {
    return c.html(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProjectSites Editor</title><body style="margin:0;font:16px/1.5 system-ui,sans-serif;background:#0a0a1a;color:#e6e6e6;display:grid;place-items:center;min-height:100vh"><main style="text-align:center;max-width:34rem;padding:2rem"><h1 style="color:#64ffda;font-size:1.6rem;margin:0 0 .5rem">Open the editor from your dashboard</h1><p style="opacity:.8;margin:0 0 1.5rem">The ProjectSites editor runs inside the admin dashboard, not as a standalone page.</p><a href="https://projectsites.dev/admin" style="display:inline-block;padding:.7rem 1.4rem;border-radius:10px;background:#64ffda;color:#0a0a1a;font-weight:600;text-decoration:none">Open the dashboard →</a></main>',
      403,
    );
  }
  const pagesRes = await fetch(`https://bolt-diy-8jf.pages.dev${url.pathname}${url.search}`, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  });
  const res = new Response(pagesRes.body, { status: pagesRes.status, headers: pagesRes.headers });
  // Cross-origin isolation required for SharedArrayBuffer (WebContainers)
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  res.headers.set('Origin-Agent-Cluster', '?1');
  // CORS so the editor can talk to projectsites.dev API
  res.headers.set('Access-Control-Allow-Origin', `https://${DOMAINS.BOLT_BASE}`);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  // CSP that lets bolt.diy embed the WebContainer preview iframe AND lets
  // projectsites.dev/admin embed bolt.diy itself (Pages' default frame-src
  // 'none' + X-Frame-Options: DENY would blank the preview + break the embed).
  res.headers.delete('X-Frame-Options');
  res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // static.cloudflareinsights.com: CF Web Analytics auto-injects its beacon
      // at the edge; without it here the editor logs a CSP violation every load.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https: wss: blob:",
      // Bare https://stackblitz.com is required because app/root.tsx sets
      // WEBCONTAINER_API_IFRAME_URL = "https://stackblitz.com" (no subdomain),
      // which `*.stackblitz.com` does NOT match → framing was blocked.
      "frame-src 'self' blob: https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io https://stackblitz.com https://*.stackblitz.com https://challenges.cloudflare.com",
      "child-src 'self' blob: https://*.webcontainer-api.io https://*.local-credentialless.webcontainer-api.io",
      "worker-src 'self' blob:",
      "frame-ancestors 'self' https://projectsites.dev https://*.projectsites.dev https://bolt-diy-8jf.pages.dev https://bolt.megabyte.space",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https:",
    ].join('; '),
  );
  return res;
});

// storybook.projectsites.dev → proxy to the projectsites-storybook Cloudflare
// Pages project. The worker's `*.projectsites.dev/*` route (wrangler.toml) shadows
// the Pages custom domain (Workers routes win over Pages custom domains), so
// without this the worker tries to resolve "storybook" as a site slug and 404s.
// Same host-gated pattern as the editor proxy above; static Storybook needs no
// CORS/WebContainer/CSP headers, so pass the Pages response through verbatim.
// Host stripped so the pages.dev origin routes by its own hostname (no custom-
// domain redirect loop back to storybook.projectsites.dev).
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname !== 'storybook.projectsites.dev') return next();
  const fwd = new Headers(c.req.raw.headers);
  fwd.delete('host');
  const pagesRes = await fetch(
    `https://projectsites-storybook.pages.dev${url.pathname}${url.search}`,
    {
      method: c.req.method,
      headers: fwd,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: 'manual',
    },
  );
  return new Response(pagesRes.body, { status: pagesRes.status, headers: pagesRes.headers });
});

// Request ID on every request
app.use('*', requestIdMiddleware);

// Structured per-request access log (item #50)
app.use('*', requestLogger);

// Payload size limit
app.use('*', payloadLimitMiddleware);

// Security headers
app.use('*', securityHeadersMiddleware);

// Public forms ingest must accept ANY origin (custom domains post here too).
// Server-side origin allow-list inside the handler is the real security check.
app.use(
  '/api/v1/forms/submit',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Site-Slug'],
    maxAge: 86400,
  }),
);

// Permissive CORS for *.projectsites.dev on ALL routes (sites loaded in iframes, cross-subdomain requests)
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '';
      const allowed = [
        `https://${DOMAINS.SITES_BASE}`,
        `https://${DOMAINS.BOLT_BASE}`,
        'http://localhost:3000',
        'http://localhost:4200',
        'http://localhost:4300',
        'http://localhost:5173',
      ];
      if (allowed.includes(origin)) return origin;
      // Allow any subdomain of projectsites.dev
      if (origin.endsWith(DOMAINS.SITES_SUFFIX)) return origin;
      // Allow any *.projectsites.dev origin (including deeply nested subdomains)
      if (origin.endsWith(`.${DOMAINS.SITES_BASE}`)) return origin;
      return '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
    maxAge: 86400,
  }),
);

// Rate limiting on sensitive endpoints (config + applier in one module)
import { applyRateLimits } from './middleware/rate_limit.js';

// ─── Per-IP rate limits (single source: middleware/rate_limit.ts) ──────
// Every throttled surface (auth, public cost endpoints, bolt-AI, SSE polls)
// is declared in RATE_LIMIT_RULES + applied here in one loop. Add new budgets
// THERE so the limiter config + its test never drift. See applyRateLimits().
applyRateLimits(app);

// Auth middleware for API routes (sets userId/orgId if valid session)
app.use('/api/*', authMiddleware);

// Idempotency-Key dedupe for mutating API requests (after auth so orgId scopes the
// cache). Safe no-op when the header is absent — generalizes the dedupe that until
// now only Stripe webhooks had, so retried POST/PUT/PATCH/DELETE run exactly once.
app.use('/api/*', idempotencyMiddleware);

// EMBEDDED Better Auth (full-cutover rebuild, Phase 1) — DARK behind the `better_auth`
// flag. Registered BEFORE the legacy auth routes so it's a clean same-path cutover:
// flag ON → Better Auth owns /api/auth/* (email+pw, magic link, Google, 2FA, sessions);
// flag OFF → falls through to the legacy magic-link/Google/D1-session auth.
// MUST use app.use (middleware) not app.on (route handler) — app.on blocks sub-app routes.
app.use('/api/auth/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // Always fall through to legacy for these paths
  const legacyPaths = [
    '/api/auth/me',
    '/api/auth/test-login',
    '/api/auth/google',
    '/api/auth/google/callback',
    // Per-site Google DRIVE OAuth callback (routes/api.ts:10049) — the asset-import
    // connect flow (admin → connect Drive → import media into a build). Its handler
    // ONLY 302-redirects (never 404s), so a live 404 here is proof of the BA swallow:
    // without this entry the connect flow silently fails when the flag is on. Distinct
    // from /google/callback (that's LOGIN; this is the Drive-source integration).
    '/api/auth/google-drive/callback',
    '/api/auth/github',
    '/api/auth/github/callback',
    // Legacy magic-link REQUEST + VERIFY (routes/api.ts) — the LIVE passwordless
    // login the sign-in page (POST /api/auth/magic-link) + the emailed link
    // (GET /api/auth/magic-link/verify) actually use. WITHOUT these two the BA
    // handler swallows them when the flag is on and returns its own 404 → the
    // primary passwordless login is BROKEN in prod. Only the `/peek` test seam
    // below had been allowlisted; the real login endpoints were missed.
    '/api/auth/magic-link',
    '/api/auth/magic-link/verify',
    // E2E peek seam — OUR secret-gated route, not a Better Auth one. Without
    // this passthrough the BA handler swallows the path and returns its own
    // 404, killing the real-roundtrip suite whenever the flag is on.
    '/api/auth/magic-link/peek',
    // Custom-auth "Active sessions" for /admin/auth-security — implemented over
    // the legacy D1 `sessions` table (routes/auth_sessions.ts). Must fall through
    // to our handler, not the BA handler (which 401s on a legacy session token).
    '/api/auth/list-sessions',
    '/api/auth/revoke-session',
    '/api/auth/revoke-other-sessions',
    // Custom-auth Team/Organization for /admin/team (routes/auth_org.ts) — over
    // the live memberships/users/team_invites tables, not the BA org plugin.
    '/api/auth/organization/get-full-organization',
    '/api/auth/organization/invite-member',
    '/api/auth/organization/cancel-invitation',
    '/api/auth/organization/remove-member',
  ];
  if (legacyPaths.includes(path)) {
    await next();
    return;
  }

  if (!(await isFlagOnBetterAuth(c.env, 'better_auth'))) {
    await next();
    return;
  }

  const { makeAuth, ensureBetterAuthSchema } = await import('./auth/better-auth.js');
  await ensureBetterAuthSchema(c.env);
  return makeAuth(c.env).handler(c.req.raw);
});

// Global error handler
app.onError(errorHandler);

// Accessible 404 for explicit `c.notFound()` calls (e.g. flag-gated routes
// like /changelog when its flag is off). The catch-all `app.all('*')` already
// serves a branded 404 for unmatched routes, but `c.notFound()` bypasses it and
// would otherwise emit Hono's bare text/plain 404 (no <title>, no <html lang> —
// fails axe document-title + html-has-lang). This gives every notFound a small
// accessible HTML page with a distinguishable (underlined) home link.
app.notFound((c) => c.html(notFoundHtml(), 404));

// ─── Mount Routes ────────────────────────────────────────────

app.route('/', health);
app.route('/api', health); // /api/health alias for external consumers who expect RESTful path
app.route('/', bolt); // Bolt admin: chat-state mirror, transcribe, vision OCR, prompt suggestions
app.route('/', openapiRoutes); // GET /api/openapi.json — Zod-derived OpenAPI 3.1 spec (zod-to-openapi + hono-openapi describeRoute)
app.route('/', siteDataApi); // /api/public-data/:table + /api/sites/:siteId/data[/:table[/:rowId]] — per-site D1 data-table API extracted from search.ts (route-decomposition installment 21); MUST precede search AND api so /api/sites/:siteId/data wins over api's /api/sites/:id
app.route('/', containerProxy); // /api/container-{upload/*,query,script} — build-container shared-secret callbacks extracted from search.ts (route-decomposition installment 22)
app.route('/', contactNewsletter); // /api/contact-form/:slug + /api/newsletter/subscribe — public form ingest extracted from search.ts (route-decomposition installment 23)
app.route('/', placesSearch); // /api/search/{businesses,address} — public Google Places search extracted from search.ts (route-decomposition installment 25)
app.route('/', mediaAi); // /api/image-proxy + /api/ai/{discover-images,discover-videos,edit-image} — AI media pipeline extracted from search.ts (route-decomposition installment 26)
app.route('/', siteCreation); // /api/sites/{create-from-search,improve-prompt,generate-prompt} + /api/ai/categorize — AI site-creation cluster extracted from search.ts (route-decomposition installment 27); MUST precede search+api so /api/sites/create-from-search wins over api's /api/sites/:id
app.route('/', sitePreview); // /api/sites/:slug/preview — R2 index.html preview serve extracted from search.ts (route-decomposition installment 28); precedes api so :slug/preview wins over /api/sites/:id
app.route('/', conversionCheckout); // /api/conversion/checkout — public Stripe funnel extracted from search.ts (route-decomposition installment 28)
app.route('/', search); // Must come before api so /api/sites/search wins over /api/sites/:id
app.route('/', featureE2e); // /api/feature-e2e/:key/run + /runs/:id — Browser Rendering E2E check runner
app.route('/', visionQa); // /api/vision-qa — Browser Rendering screenshot + Workers AI vision critique (flag: editor_vision_qa)
app.route('/', adminLeads); // /api/admin/leads/scan — Super-Admin lead scanner (flag: lead_scanner)
app.route('/', adminOutbox); // /api/admin/outbox — Super-Admin event-bus DLQ observability (read-only)
app.route('/', adminFunnel); // /api/admin/activation-funnel — Super-Admin revenue-funnel rollup (Tinybird, read-only)
app.route('/', adminAnalytics); // /api/admin/analytics/* — Super-Admin events-daily + publishes-by-source + claims-by-source rollups (Tinybird, read-only)
app.route('/', claimRoutes); // /api/claim/:shortlink — claimyour.site funnel: resolve→click→session START→redirect /create
app.route('/', siteRollbackRoutes); // /api/sites/:id/history + /api/sites/:id/rollback — GitHub repo rollback (flag: github_repo_sync)

// ── PostHog same-origin reverse proxy (/ingest/*) ──────────────────────────
// The `/admin` shell ships `COEP: credentialless` so the embedded bolt.diy editor
// can cross-origin-isolate (WebContainer live Preview needs SharedArrayBuffer).
// A document-level COEP blocked PostHog's cross-origin no-cors beacons before
// (4e02d113), so admin PostHog now points at this SAME-ORIGIN path — same-origin
// requests are immune to COEP (and ad-blockers). Static assets (array.js,
// recorder) come from us-assets; events/decide/flags/session-recording from us.i.
app.all('/ingest/*', async (c) => {
  const url = new URL(c.req.url);
  const isStatic = url.pathname.startsWith('/ingest/static/');
  const upstreamHost = isStatic ? 'us-assets.i.posthog.com' : 'us.i.posthog.com';
  const upstream = `https://${upstreamHost}${url.pathname.replace(/^\/ingest/, '')}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set('Host', upstreamHost);
  headers.delete('cookie'); // cookie-free ingestion — distinct_id rides in the body

  const upstreamRes = await fetch(upstream, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'manual',
  });

  const res = new Response(upstreamRes.body, upstreamRes);
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return res;
});

// Marketing Dashboard — widget config + metrics (flag: marketing_dashboard)
app.get('/api/sites/:siteId/dashboard', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'marketing_dashboard', { orgId: orgId, siteId: siteId })))
    return c.notFound();
  // IDOR guard: a foreign org id 404s (never leak another org's site). AL-176.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, orgId, siteId))) return c.notFound();
  const d = defaultDashboard(siteId);
  const filter = c.req.query('sources');
  return c.json({ data: filter ? filterBySource(d, filter.split(',') as any) : d });
});
app.post('/api/sites/:siteId/dashboard/metric', async (c) => {
  const siteId = c.req.param('siteId');
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'marketing_dashboard', { orgId: c.get('orgId'), siteId: siteId })))
    return c.notFound();
  // IDOR guard: a foreign org id 404s (never write to another org's site). AL-176.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), siteId))) return c.notFound();
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    data: buildMetric(body.label, body.current, body.previous, body.source || 'website'),
  });
});

// Social Agent — content proposals + engagement scoring (flag: social_agent)
app.post('/api/sites/:siteId/social/proposals', async (c) => {
  const siteId = c.req.param('siteId');
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (
    !(await isFlagOn(c.env, 'social_publishing_native', { orgId: c.get('orgId'), siteId: siteId }))
  )
    return c.notFound();
  // IDOR guard: a foreign org id 404s (never run site-scoped compute for a site you don't own). AL-177.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), siteId))) return c.notFound();
  const body = await c.req.json().catch(() => ({}));
  // Validate compute inputs at the boundary → 400, never a 500 crash inside the pure
  // generator on an empty/malformed body. fail-fast-build-fail-soft-prod + zod-everywhere. AL-179.
  if (
    typeof body.business !== 'string' ||
    !body.business.trim() ||
    typeof body.sellingPoint !== 'string' ||
    !body.sellingPoint.trim()
  )
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'business and sellingPoint are required non-empty strings',
        },
      },
      400,
    );
  try {
    const count = Math.min(Math.max(1, Number(body.count) || 5), 20);
    return c.json({
      data: generateProposals(
        body.business,
        body.sellingPoint,
        Array.isArray(body.accounts) ? body.accounts : [],
        count,
      ),
    });
  } catch {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'Could not generate proposals from the provided input (check account platforms).',
        },
      },
      400,
    );
  }
});
app.post('/api/sites/:siteId/social/engagement', async (c) => {
  const siteId = c.req.param('siteId');
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (
    !(await isFlagOn(c.env, 'social_publishing_native', { orgId: c.get('orgId'), siteId: siteId }))
  )
    return c.notFound();
  // IDOR guard: a foreign org id 404s (never run site-scoped compute for a site you don't own). AL-177.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), siteId))) return c.notFound();
  const body = await c.req.json().catch(() => ({}));
  const acct = body.account;
  const mx = body.metrics;
  // Boundary validation → 400, never a 500 crash inside scoreEngagement. AL-179.
  if (
    !acct ||
    typeof acct !== 'object' ||
    typeof acct.platform !== 'string' ||
    typeof acct.followers !== 'number' ||
    !mx ||
    typeof mx !== 'object' ||
    ['likes', 'comments', 'shares', 'posts'].some((k) => typeof mx[k] !== 'number')
  )
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'account {platform, followers} and metrics {likes, comments, shares, posts} numbers are required',
        },
      },
      400,
    );
  try {
    return c.json({ data: scoreEngagement(acct, mx) });
  } catch {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Could not score engagement for the provided account platform.',
        },
      },
      400,
    );
  }
});

app.post('/api/sites/:siteId/automation/validate', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (
    !(await isFlagOn(c.env, 'visual_automation', {
      orgId: c.get('orgId'),
      siteId: c.req.param('siteId'),
    }))
  )
    return c.notFound();
  // IDOR guard: a foreign org id 404s (never run site-scoped compute for a site you don't own). AL-177.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), c.req.param('siteId')))) return c.notFound();
  const body = await c.req.json().catch(() => ({}));
  // A journey needs a steps[] array; validateJourney derefs j.steps.length → 500 without it. AL-179.
  if (!body || typeof body !== 'object' || !Array.isArray(body.steps))
    return c.json(
      {
        error: { code: 'VALIDATION_ERROR', message: 'a journey with a steps[] array is required' },
      },
      400,
    );
  try {
    return c.json({ data: validateJourney(body) });
  } catch {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Could not validate the provided journey (check step shapes).',
        },
      },
      400,
    );
  }
});

// App Launcher — catalog + launch planner (flag: app_launcher)
app.get('/api/apps/catalog', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'app_launcher', { orgId: c.get('orgId'), siteId: 'system' })))
    return c.notFound();
  return c.json({ data: listApps() });
});
app.post('/api/apps/launch', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'app_launcher', { orgId: c.get('orgId'), siteId: 'system' })))
    return c.notFound();
  const body = await c.req.json().catch(() => ({}));
  return c.json({ data: planLaunch(body) });
});

// System Status — aggregated integration health (flag: system_status)
app.get('/api/system/status', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'system_status', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleSystemStatus } = await import('../libs/features/system_status/handlers.js');
  return handleSystemStatus(c);
});

app.get('/api/sites/:siteId/annotations', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  // IDOR guard: a foreign org id 404s (never leak another org's annotations). AL-176.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), c.req.param('siteId')))) return c.notFound();
  const { handleListAnnotations } =
    await import('../libs/features/analytics_annotations/handlers.js');
  return handleListAnnotations(c);
});
app.post('/api/sites/:siteId/annotations', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  // IDOR guard: a foreign org id 404s (never write to another org's site). AL-176.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), c.req.param('siteId')))) return c.notFound();
  const { handleCreateAnnotation } =
    await import('../libs/features/analytics_annotations/handlers.js');
  return handleCreateAnnotation(c);
});
app.delete('/api/annotations/:id', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleDeleteAnnotation } =
    await import('../libs/features/analytics_annotations/handlers.js');
  return handleDeleteAnnotation(c);
});

app.post('/api/cmdk', async (c) => {
  // Cmd+K action suggestions — folded under cmdk_ai_actions (was the retired
  // duplicate cmd_k_actions flag). Sibling of /api/cmdk/resolve; one flag now.
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'cmdk_ai_actions', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleCmdK } = await import('../libs/features/cmdk_ai_actions/cmdk_suggest.js');
  return handleCmdK(c);
});

app.get('/api/sites/:siteId/sparkline', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'site_doctor', { orgId: c.get('orgId')! }))) return c.notFound();
  // IDOR guard: a foreign org id 404s (never leak another org's traffic sparkline). AL-176.
  const { assertSiteOwned } = await import('./services/site_ownership.js');
  if (!(await assertSiteOwned(c.env, c.get('orgId'), c.req.param('siteId')))) return c.notFound();
  const { handleSparkline } = await import('../libs/features/site_health_sparklines/handlers.js');
  return handleSparkline(c);
});

app.get('/api/notifications/badge', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleBadge } = await import('../libs/features/notification_badge/handlers.js');
  return handleBadge(c);
});

app.post('/api/batch', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleBatchOps } = await import('../libs/features/batch_operations/handlers.js');
  return handleBatchOps(c);
});

// Site Comparison — side-by-side diff (flag: site_comparison)
app.post('/api/sites/compare', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleSiteCompare } = await import('../libs/features/site_comparison/handlers.js');
  return handleSiteCompare(c);
});

// Site Clone — one-click copy (flag: site_clone)
app.post('/api/sites/clone', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'batch_operations', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleSiteClone } = await import('../libs/features/site_clone/handlers.js');
  return handleSiteClone(c);
});

// Onboarding Progress — org setup completion (flag: onboarding_progress)
app.get('/api/onboarding', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'onboarding_copilot', { orgId: c.get('orgId')! })))
    return c.notFound();
  const { handleOnboardingProgress } =
    await import('../libs/features/onboarding_progress/handlers.js');
  return handleOnboardingProgress(c);
});

// Usage Gauges — per-org usage metrics (flag: usage_gauges)
app.get('/api/usage', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleUsageGauges } = await import('../libs/features/usage_gauges/handlers.js');
  return handleUsageGauges(c);
});

// MRU Cards — recently-active sites for dashboard (flag: mru_cards)
app.get('/api/mru', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleMruCards } = await import('../libs/features/mru_cards/handlers.js');
  return handleMruCards(c);
});

// Activity Feed — org-scoped event timeline (flag: activity_feed)
app.get('/api/activity', async (c) => {
  const { isFlagOn } = await import('./modules/feature_flags/services.js');
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: c.get('orgId')! }))) return c.notFound();
  const { handleActivityFeed } = await import('../libs/features/activity_feed/handlers.js');
  return handleActivityFeed(c);
});

app.route('/', autofill); // POST /api/sites/autofill — must come before api so it wins over /api/sites/:id
app.route('/', assets); // Asset uploads + build-assets listing
app.route('/', forms); // Public form ingest + auth-gated submissions/integrations CRUD
app.route('/', analyticsRoutes); // Unified Analytics ingestion: POST /api/events (202 fast-ack) + /api/analytics-debug (Plane H)
app.route('/', mcpOauth); // MCP OAuth start + callback (MailChimp/Stripe/Resend/HubSpot)
app.route('/', envVarsRoutes); // /api/env-vars — per-org/site/MCP customizable env vars for AI + MCP dispatch
app.route('/', analytics); // /api/analytics/{track,overview,:siteId} — analytics surface extracted from ai_admin.ts + api.ts (route-decomposition installment 14); MUST precede aiAdmin AND api so its /api/analytics/* routes win over both
app.route('/', aiContext); // /api/sites/:siteId/{ai-chat/context-files,ai/context,ai/drive}/* — AI context/knowledge management (context files + Google Drive sync) extracted from ai_admin.ts (route-decomposition installment 16); MUST precede aiAdmin AND api
app.route('/', aiSettings); // /api/sites/:siteId/{ai-settings,ai-settings/improve,credit-cap} — per-site AI config + credit cap extracted from ai_admin.ts (route-decomposition installment 18); MUST precede aiAdmin AND api
app.route('/', adminAi); // /api/admin/{ai-chat,traces/:traceId/explain,search/ai,ai/stream/palette,ai/stream/chat} — admin AI assistant tools (incl. SSE streaming) extracted from ai_admin.ts (route-decomposition installment 18); MUST precede aiAdmin AND api
app.route('/', apiKeys); // /api/admin/api-keys{,/:id} — org-scoped programmatic API keys (psk_live_*) extracted from ai_admin.ts (route-decomposition installment 19); MUST precede aiAdmin AND api
app.route('/', siteActivity); // /api/sites/:siteId/{form-submissions,ai-logs}{,/:id} — per-site read-only activity (Forms inbox + AI logs) extracted from ai_admin.ts (route-decomposition installment 19); MUST precede aiAdmin AND api
app.route('/', mcpConnections); // /api/sites/:siteId/mcp/connections{,/:id} — per-site MCP connection management (list + disconnect) extracted from ai_admin.ts (route-decomposition installment 19); MUST precede aiAdmin AND api
app.route('/', siteMcpServer); // /api/sites/:siteId/mcp/{tokens,tokens/:id,tools,tool-usage} — per-site MCP server admin (token mint/list/revoke + tool registry + usage, #29 wiring); MUST precede aiAdmin AND api
app.route('/', orgSecurity); // /api/admin/security (GET/PUT) — org security settings extracted from ai_admin.ts (route-decomposition installment 20); MUST precede aiAdmin AND api
app.route('/', cloudflareSetup); // /api/admin/cloudflare/{status,auto-setup} — CF account provisioning extracted from ai_admin.ts (route-decomposition installment 20); MUST precede aiAdmin AND api
app.route('/', costForecast); // /api/admin/forecast/cost — AI cost forecaster (#95) extracted from ai_admin.ts (route-decomposition installment 20); MUST precede aiAdmin AND api
app.route('/', workflowStatus); // /api/sites/:siteId/workflows/:wfName/:id — workflow status proxy extracted from ai_admin.ts (route-decomposition installment 20); MUST precede aiAdmin AND api
app.route('/', aiAdmin); // Form submissions, AI logs, chat, endpoints, credits, alerts, team
app.route('/', apiTokensAdmin); // GET/POST/DELETE /api/v1-tokens — account API-token CRUD for /admin/api-tokens (flag: public_api)
app.route('/', authSessions); // GET /api/auth/list-sessions + revoke-session/revoke-other — custom-auth Active Sessions (Better Auth dark). Reached because the /api/auth/* BA middleware next()s when better_auth is off.
app.route('/', authOrg); // /api/auth/organization/* — custom-auth Team (get-full-organization/invite/cancel/remove over memberships+users+team_invites). Same legacyPaths bypass.
app.route('/', docs); // Interactive API explorer (OpenAPI + Angular overview)
app.route('/', appsRoutes); // /admin/apps tab — catalog + per-org app_instances CRUD
app.route('/', snapshotQuality); // /api/sites/:siteId/snapshots/:snapshotId/{capture,metrics,screenshot.png} — must precede `api` so the param order matches first
app.route('/', siteDetailTabs); // /api/sites/:siteId/{logs/tail,snapshots/:id/rollback,sql/exec,integration-providers} — must precede `api` so the param order matches first
app.route('/', siteDna); // /api/site-dna/:siteId/{feedback,preferences,history} — #7 Site DNA Taste Graph
app.route('/', dashboard); // /api/dashboard/chat (SSE) + /api/calendar/* — Perplexity-like dashboard surface
app.route('/', pulseAnalytics); // /api/social/analytics/aggregate — must precede social catch-alls
app.route('/', socialOauthRoutes); // /api/social/:platform/{connect,callback,paste} — Pulse Social OAuth
app.route('/', socialRoutes); // /api/social/{accounts,posts}/* — Pulse Social CRUD; must precede `api`
app.route('/', socialPostRoutes); // /api/social/:siteId/posts/{publish,schedule,generate} — Native Social Tier 1
app.route('/', voiceRoutes); // /api/voice/* — AI Voice + SMS Agent (numbers, vanity, calls, messages, settings)
app.route('/', logsRoutes); // /api/logs/{search,cost-by-route} — Log Explorer over Workers Observability (flag: log_explorer); must precede `api`
app.route('/', voiceWebhookRoutes); // /webhooks/voice/* + /webhooks/sms/* + /internal/voice/* — Twilio webhook + media stream bridge
app.route('/', livekitWebhookRoutes); // /webhooks/livekit — LiveKit Cloud room/egress lifecycle (signed) → D1
app.route('/', domainPurchase); // Wallet-charged /api/domains/purchase + /api/billing/checkout/{wallet,topup} + /api/billing/wallet — must precede `api` so the wallet-aware purchase route wins over the legacy hosted-checkout route
app.route('/', domainStack); // Domain Stack Wizard: POST /api/domains/:hostname/stack + GET /api/domains/:hostname/stack-status (flag: domain_stack_wizard)
app.route('/', superAdmin); // /api/super-admin/* — cost-factor controls + wallet ops + 100-feature ops (is_super_admin=1 guarded)
app.route('/', walletRoutes); // /api/wallet/* — customer-facing wallet read/subscribe/topup (additive aliases over domain_purchase /api/billing/wallet)
app.route('/', agency); // /api/agency/* — white-label / agency surface (Pro-gated, manages child orgs + brand overrides + Stripe Connect)
app.route('/', billingAddons); // /api/billing/addons/*, /api/billing/checkout/topup, /api/billing/usage/*, /api/billing/invoices/*, /api/billing/subscription/cancel, /api/agency/stripe-connect/onboard, /api/affiliates/payouts
app.route('/', agents); // /api/(sites/:siteId/agents|agents/:id)/* — AI Agents (per-site autonomous maintenance, Pro-gated)
app.route('/', templatesRoutes); // /api/templates + /api/sites/:siteId/install-template — templates marketplace
app.route('/', copilot); // /api/sites/:slug/copilot/* + /sites/:slug/copilot.js — Multimodal Copilot (flag: multimodal_copilot)
app.route('/', features); // Feature endpoints (every /api/* path flag-gated via isFlagOn) + public discovery surfaces (llms.txt, /accessibility, /.well-known/mcp, /api/openapi.json).
app.route('/', platformMcp); // GET+POST /api/mcp — platform MCP (flag: platform_mcp).
app.route('/', siteBranchesApp); // /api/sites/:siteId/branches — branch-style site previews (#27)
app.route('/', experiments); // /_ps/{i,c,e,predict} + /api/sites/:siteId/experiments — Thompson-sampling A/B + predictive prerender
app.route('/', mediaRoutes); // /api/media/* — unified media library (uploads, stock, AI gen, send-to-bolt)
app.route('/', publicRoutes); // /changelog.json + /feed.xml + /api/public/{roadmap,integrations} — distribution flywheel surfaces; must precede the catch-all so the marketing worker never tries to resolve a site for these paths

// GET /app.js — the unified client script injected into every served site
// (analytics beacon + form hijack + upgrade bar + Sentry/PostHog stubs). Served
// from a string constant because this Worker does not serve public/ (no
// serveStatic/[assets] binding); 1h edge+browser cache. Must precede the
// site-serving catch-all so a site is never resolved for the /app.js path.
app.get('/app.js', (c) =>
  c.body(APP_JS, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  }),
);
// libs/features/* — viral + billing + audit-chain modules (ideas #33, #34, #36, #46)
app.route('/', tokenBurnMeter); // /api/usage/budget + /api/admin/usage/budget — #13 per-tenant token-burn meter + budget killswitch (flag: token_burn_meter)
app.route('/', siteAnalytics); // /api/sites/:siteId/analytics — owner analytics summary (flag: site_analytics). Must precede `api` so the :siteId/analytics suffix wins.
app.route('/', visitorEvents); // POST /api/v1/events — public beacon ingest (flag: visitor_events_core)
app.route('/', emailDeliverabilityRoutes); // /api/sites/:siteId/deliverability — SPF/DKIM/DMARC score + fixes (flag: email_deliverability_wizard)
app.route('/', reviewPublic); // GET/POST /api/review/:id{,/decision} — public reviewer approve/reject (flag: approval_workflow, scoped to review's org)
app.route('/', reviewLinks); // GET/POST /api/sites/:siteId/review-links — admin create/list review links (flag: approval_workflow, assertSiteOwned)
app.route('/', webhooksAdmin); // /api/sites/:siteId/webhooks — outbound webhook subscription CRUD (flag: outbound_webhooks)
// ── IDEAS-50 wave 3 mounts — must precede `api` so :id/* suffixes + /r/:code + /gallery win
app.route('/', abuseTakedown); // /api/abuse/* — abuse + takedown intake (flag: abuse_takedown)
app.route('/', oauthProvider); // OAuth 2.1 AS: /.well-known/oauth-authorization-server + /oauth/{register,authorize,token} (flag: mcp_oauth_provider)
app.route('/', prodReadinessScore); // GET /api/sites/:siteId/readiness (flag: site_doctor) — must precede `api` (fully shadows the deleted audit-based handler)
app.route('/api/onboarding', onboardingCopilot); // /api/onboarding/{checklist,dismiss} (flag: onboarding_copilot)
app.route('/api/audit/export', auditTrailExport); // GET /api/audit/export (flag: audit_trail_export)
app.route('/', modelRegistry); // GET /v1/models — OpenAI-compatible alias catalog (flag: model_registry) — must precede the site-serving catch-all
app.route('/', browserService); // POST /v1/browser/* — product browser-automation abstraction (browser.projectsites.dev); routes CF→Stagehand→Browserbase-fallback, never Skyvern in product paths — must precede the catch-all
// System-service status page at the bare root `/` — registered BEFORE the
// root-landing handler so platform subdomains return the branded 200 status
// page. Only matches exact path `/`, so `/api/*`, `/v1/*` still route to their
// real handlers.
// Root landing for platform subdomains — consolidated (iter 47) from TWO
// separate `app.get('/')` handlers into one. The 2nd handler was NOT moot: it
// uniquely served the llm/logs/webhooks/links roots (deleting it 404s them —
// prod-verified iter 47). Order: llm gateway → system-service registry
// (api/auth/analytics/notify/…) → platform-service SaaS (logs/webhooks/links) →
// fall through to the marketing/site-serving catch-all. Only matches GET `/`.
app.get('/', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname === `llm.${DOMAINS.SITES_BASE}`) {
    return c.html(llmLandingPage());
  }
  const svc = resolveSystemService(hostname);
  if (svc) {
    return c.html(systemServiceLanding(svc));
  }
  const ps = resolvePlatformService(hostname);
  if (ps) {
    return c.html(platformServiceLanding(ps));
  }
  return next();
});
// createJobsRoutes() is the dispatch seam: POST /api/jobs routes via
// getJobRouter(env) to CF Workflows or Hatchet Cloud (see ADR-0034).
app.route('/', createJobsRoutes()); // POST /api/jobs + GET /api/jobs/:id/status — authed WorkflowRouter dispatch seam (§20); routes to CF Workflows/Hatchet via getJobRouter(env)
// Formbricks REMOVED (2026-06-27): survey.* host route, FormbricksContainer DO
// class, container block, binding, all FORMBRICKS_* env, AND the orphaned DO
// namespace all deleted (exceeds the 4-service max — needs Cube + extra custom
// Hub services). The namespace was removed via the CF API after a binding-free
// deploy, sidestepping the deleted_classes-migration registry corruption.
// sign.projectsites.dev → self-hosted Documenso container (dedicated DO).
// Proxies the FULL host to DOCUMENSO_CONTAINER; degrades to 503 until the watched
// deploy binds it. Must precede the site-serving catch-all.
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `sign.${DOMAINS.SITES_BASE}`) return next();
  const binding = c.env.DOCUMENSO_CONTAINER;
  if (!binding) {
    return c.json({ error: 'Documenso is provisioning; not yet available.' }, 503);
  }
  return binding.get(binding.idFromName('documenso-singleton')).fetch(c.req.raw);
});
// schedule.projectsites.dev → self-hosted cal.diy container (dedicated DO).
// Proxies the FULL host to CALDIY_CONTAINER; degrades to 503 until the watched
// deploy binds it. Must precede the site-serving catch-all.
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `schedule.${DOMAINS.SITES_BASE}`) return next();
  const binding = c.env.CALDIY_CONTAINER;
  if (!binding) {
    return c.json({ error: 'cal.diy is provisioning; not yet available.' }, 503);
  }
  return binding.get(binding.idFromName('caldiy-singleton')).fetch(c.req.raw);
});
// convert.projectsites.dev → self-hosted Gotenberg Office→PDF container (dedicated DO).
// Proxies the FULL host to GOTENBERG_CONTAINER; basic-auth-gated. Documenso reaches it
// here for .docx/.xlsx/.pptx → PDF. Degrades to 503 until the watched deploy binds it.
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `convert.${DOMAINS.SITES_BASE}`) return next();
  const binding = c.env.GOTENBERG_CONTAINER;
  if (!binding) {
    return c.json({ error: 'Gotenberg is provisioning; not yet available.' }, 503);
  }
  return binding.get(binding.idFromName('gotenberg-singleton')).fetch(c.req.raw);
});

// ── Feature-module routes — all flag-gated → 404 when off ──
app.route('/', paymentsRail); // /api/payments/* (flag: payments_rail)
app.route('/', creditWalletRollover); // /api/credits/* (flag: credit_wallet_rollover)
app.route('/', referralLoop); // /api/referrals/* (flag: referral_loop)
app.route('/', siteDoctor); // /api/sites/:siteId/doctor (flag: site_doctor)
app.route('/', previewShareCard); // /api/sites/:siteId/share-card (flag: preview_share_card)
app.route('/', promptStudio); // /api/prompt-studio/* (flag: prompt_studio)
app.route('/', aiGatewayGuardrails); // /api/guardrails/* (flag: ai_gateway_guardrails)
app.route('/', wireframePlanning); // /api/wireframe/* (flag: wireframe_planning)
app.route('/', cmdkAiActionsRouter); // /api/cmdk/resolve (flag: cmdk_ai_actions)
app.route('/', integrationHealth); // GET /api/integrations/:name/health + /api/integrations/health
app.route('/', domains); // /api/domains/* + /api/admin/profile/:site_id/context — extracted from api.ts (route-decomposition installment 1); precedes `api`.
app.route('/', notifications); // /api/notifications + /:id/read + /read-all — extracted from api.ts (route-decomposition installment 2); precedes `api`.
app.route('/', inbox); // /api/inbox/tasks + /:id/resolve — extracted from api.ts (route-decomposition installment 3); precedes `api`.
app.route('/', sheets); // /api/sheets/:sheetId + /meta — extracted from api.ts (route-decomposition installment 4); precedes `api`.
app.route('/', billing); // /api/billing/{subscription,entitlements,quota,cost-forecast} reads + /connect/* + /usage + /usage/this-month + /spend-alerts CRUD — extracted from api.ts (route-decomposition installments 5 + 7); precedes `api`.
app.route('/', email); // /api/email/{unsubscribe,digest/trigger} — weekly-digest email surface extracted from api.ts (route-decomposition installment 6); precedes `api`.
app.route('/', siteVersioning); // /api/sites/:siteId/{snapshots,snapshots/diff,snapshots/revert,snapshots/:id/restore,git/history,git/diff,git/commits/:id} + /api/sites/:id/snapshots/:snapId/download — site version history extracted from api.ts (route-decomposition installment 9); precedes `api`.
app.route('/', siteFiles); // /api/sites/:id/{files,files-export,files/:path{.+}} (GET/PUT/DELETE) — editor R2 file CRUD extracted from api.ts (route-decomposition installment 10); precedes `api`.
app.route('/', siteUrls); // /api/sites/:id/{urls,urls/:urlId,multi-url-analytics} — site URL management + aggregated CF analytics extracted from api.ts (route-decomposition installment 10); precedes `api`.
app.route('/', siteGithub); // /api/sites/:id/github/{status,connect,callback,backup,disconnect} — per-site GitHub OAuth backup extracted from api.ts (route-decomposition installment 11); precedes `api`.
app.route('/', hostnames); // /api/sites/:siteId/hostnames/* (list/provision/primary/reset-primary/delete/unsubscribe) + /api/admin/domains/* (summary/verify/health/deprovision) — custom-hostname lifecycle extracted from api.ts (route-decomposition installment 12); precedes `api`.
app.route('/', siteBySlug); // /api/sites/by-slug/:slug/{build-context,chat,files,research.json} — public-by-slug editor reads extracted from api.ts (route-decomposition installment 13); precedes `api`.
app.route('/', feedback); // /api/feedback (POST submit + GET approved testimonials) — user feedback extracted from api.ts (route-decomposition installment 13); precedes `api`.
app.route('/', auditLogs); // /api/audit-logs (GET org list) + /api/audit-logs/editor-error (POST) — audit-log read + editor-error ingest extracted from api.ts (route-decomposition installment 13); precedes `api`.

app.route('/', api);
app.route('/', webhooks);
app.route('/webhooks/chatwoot', chatwootAgentBot); // /webhooks/chatwoot/agent_bot — Chatwoot AgentBot AI triage
app.route('/', sesWebhooks); // POST /webhooks/ses — SES bounce/complaint → suppression list (§42/ADR-0019)

// ─── Public status page (item #100) ─────────────────────────
// Self-hosted status page served on every hostname so customers can hit
// /status on the marketing root OR their custom-domain.com/status and see
// live dependency health. Polls /health/deep on the same origin every 30s.
app.get('/status', async (c) => {
  const hostname = c.req.header('host') ?? '';
  if (
    hostname === DOMAINS.SITES_BASE ||
    hostname === `www.${DOMAINS.SITES_BASE}` ||
    hostname.startsWith('localhost')
  ) {
    try {
      const r2 = await c.env.SITES_BUCKET.get('marketing/status.html');
      if (r2) {
        return new Response(await r2.text(), {
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' },
        });
      }
    } catch {
      // fall through to inline below
    }
  }
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status · Project Sites</title><meta name="color-scheme" content="dark"><link rel="icon" href="/favicon.ico"><style>:root{--bg:#060610;--accent:#00e5ff;--text:#e2e8f0;--text-muted:#94a3b8;--card:rgba(255,255,255,0.03);--border:rgba(0,229,255,0.18);--green:#22c55e;--amber:#f59e0b;--red:#ef4444}*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}.wrap{max-width:760px;margin:0 auto;padding:56px 24px 80px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--accent);text-transform:uppercase;font-weight:600}h1{font-size:36px;margin:8px 0 6px;font-weight:700}.summary{font-size:16px;color:var(--text-muted);margin-bottom:28px}.live-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);color:var(--green);font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:1px}.live-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.4)}50%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}.status-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}.status-pill[data-state='up']{background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);color:var(--green)}.status-pill[data-state='degraded']{background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);color:var(--amber)}.status-pill[data-state='down']{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:var(--red)}.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin-bottom:14px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.row+.row{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.05)}.row .label{font-weight:600;font-size:15px}.row .sub{font-size:12px;color:var(--text-muted);margin-top:2px}footer{margin-top:36px;font-size:12px;color:var(--text-muted);text-align:center}footer a{color:var(--accent);text-decoration:underline}.hero-status{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}</style></head><body><main class="wrap"><div class="eyebrow">System status</div><h1 id="overall-headline">All systems operational</h1><p class="summary" id="summary-text">Live data refreshed every 30 seconds.</p><div class="hero-status"><span class="live-pill">Live</span><span id="last-checked" style="font-size:12px;color:var(--text-muted)"></span></div><section class="card"><div class="row"><div><div class="label">D1 (database)</div><div class="sub" id="d1-sub">Primary relational store</div></div><span class="status-pill" data-state="up" id="d1-pill">UP</span></div><div class="row"><div><div class="label">KV (cache)</div><div class="sub" id="kv-sub">Host resolution + prompt store</div></div><span class="status-pill" data-state="up" id="kv-pill">UP</span></div><div class="row"><div><div class="label">R2 (object storage)</div><div class="sub" id="r2-sub">Static site bucket</div></div><span class="status-pill" data-state="up" id="r2-pill">UP</span></div><div class="row"><div><div class="label">AI (Workers AI)</div><div class="sub" id="ai-sub">LLM inference binding</div></div><span class="status-pill" data-state="up" id="ai-pill">UP</span></div></section><footer>Powered by Cloudflare Workers · auto-refresh every 30s · <a href="/health/deep">/health/deep JSON</a></footer></main><script>const STATE_LABEL={up:'UP',degraded:'DEGRADED',down:'DOWN'};async function refresh(){try{const res=await fetch('/health/deep',{cache:'no-store'});const data=await res.json();const checks=data.checks||{};const components=['d1','kv','r2','ai'];let worst='up';for(const c of components){const check=checks[c];let state='up';if(!check)state='down';else if(check.status==='error')state='down';else if(check.status==='degraded')state='degraded';const pill=document.getElementById(c+'-pill');if(pill){pill.dataset.state=state;pill.textContent=STATE_LABEL[state]}if(state==='down')worst='down';else if(state==='degraded'&&worst==='up')worst='degraded'}const head=document.getElementById('overall-headline');const summary=document.getElementById('summary-text');if(worst==='up'){head.textContent='All systems operational';summary.textContent='Every monitored dependency is responding within budget.'}else if(worst==='degraded'){head.textContent='Partial degradation';summary.textContent='One or more dependencies are responding slowly.'}else{head.textContent='Active incident';summary.textContent='One or more dependencies are unreachable. We are investigating.'}document.getElementById('last-checked').textContent='Last checked '+new Date().toLocaleTimeString()}catch(err){document.getElementById('overall-headline').textContent='Status unavailable'}}refresh();setInterval(refresh,30000);</script></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' },
  });
});

// Diagnostic: round-trip the container with a static index.html. Proves
// container can boot → write file → upload R2 → return, without Claude Code.
app.post('/api/diag/container-minimal', async (c) => {
  const secret = c.req.header('x-test-secret') || '';
  if (!secret || secret !== (c.env.CF_API_TOKEN || '').slice(0, 12)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (!c.env.SITE_BUILDER) return c.json({ error: 'SITE_BUILDER not configured' }, 500);
  const slug = ((await c.req.json().catch(() => ({}))) as { slug?: string }).slug || 'minimal-test';
  const id = c.env.SITE_BUILDER.idFromName(`${slug}-build-test`);
  const stub = c.env.SITE_BUILDER.get(id);
  const t0 = Date.now();
  const res = await stub.fetch('http://container/build-minimal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      envVars: {
        CF_API_TOKEN: c.env.CF_API_TOKEN || '',
        CF_ACCOUNT_ID: '84fa0d1b16ff8086dd958c468ce7fd59',
        R2_BUCKET_NAME: 'project-sites-production',
        SITE_SLUG: slug,
        SITE_VERSION: `v-${Date.now()}`,
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json({ workerElapsedMs: Date.now() - t0, ...data });
});

// Functions env.AI backend (ADR-0035 §6/§8, Stage 4.1(d)) — the metered
// debit-then-call a site's `functions/` worker reaches via its `env.AI` shim
// (signed per-site token → verify → check credits → Workers AI → debit). Reserved
// under /api/_ps/*; registered before the /api/* dispatch catch-all so it wins.
app.post('/api/_ps/ai/run', handleFunctionAiRun);
// Stage 4.1(e) — env.DATA read backends (signed per-site token; read-only, tenant-scoped).
app.get('/api/_ps/data/forms', handleFunctionDataForms);
app.get('/api/_ps/data/site', handleFunctionDataSite);
// Stage 4.2(b) — opt-in ctx auth-helper backends (signed per-site token).
app.post('/api/_ps/auth/verify-session', handleFunctionAuthVerifySession);
app.post('/api/_ps/turnstile/verify', handleFunctionTurnstileVerify);

// Container→worker build status callback (HMAC-protected, KV-backed).
// Container POSTs status updates here. Worker writes to CACHE_KV at key
// `build:{jobId}` so the workflow can poll KV instead of the container.
// State survives container replacement.
// Free CF-hosted image generation (Cloudflare Workers AI flux) — the BACKUP logo generator
// (AL-398, Brian directive). The container calls this HMAC-signed (same INTERNAL_BUILD_SECRET +
// x-build-sig as the build callback) when the external premium generators are unavailable —
// Ideogram's key was INVALID (401) and OpenAI/Replicate were out of credits, so EVERY delivered
// site was silently falling back to the 737B monogram. `@cf/black-forest-labs/flux-1-schnell` is
// free on the AI binding + always available, so a site now always gets a REAL generated logo.
// env.AI stays worker-side — no Cloudflare creds are ever forwarded into the build container.
app.post('/api/internal/gen-image', async (c) => {
  const secret = c.env.INTERNAL_BUILD_SECRET;
  if (!secret) return c.json({ error: 'not configured' }, 500);
  const gsig = c.req.header('x-build-sig') || '';
  const gbody = await c.req.text();
  const genc = new TextEncoder();
  const gkey = await crypto.subtle.importKey(
    'raw',
    genc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const gExpected = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', gkey, genc.encode(gbody))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (gsig !== gExpected) return c.json({ error: 'invalid signature' }, 401);
  let gp: { prompt?: string; steps?: number };
  try {
    gp = JSON.parse(gbody);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const prompt = typeof gp.prompt === 'string' ? gp.prompt.trim().slice(0, 1500) : '';
  if (!prompt) return c.json({ error: 'missing prompt' }, 400);
  const steps = Math.min(Math.max(Number(gp.steps) || 6, 1), 8);
  try {
    const out = (await c.env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt,
      steps,
    })) as { image?: string };
    if (!out?.image) return c.json({ error: 'no image' }, 502);
    return c.json({ image: out.image }); // base64 PNG/JPEG — container decodes + saves
  } catch (e) {
    return c.json({ error: `gen failed: ${String(e).slice(0, 80)}` }, 502);
  }
});

app.post('/api/internal/build-status', async (c) => {
  const secret = c.env.INTERNAL_BUILD_SECRET;
  if (!secret) return c.json({ error: 'callback not configured' }, 500);
  const sig = c.req.header('x-build-sig') || '';
  const body = await c.req.text();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const expected = Array.from(sigBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (sig !== expected) return c.json({ error: 'invalid signature' }, 401);
  let payload: {
    jobId?: string;
    status?: string;
    step?: string;
    functionsBuild?: FunctionsBuildResult;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const jobId = payload.jobId;
  if (!jobId || typeof jobId !== 'string') return c.json({ error: 'missing jobId' }, 400);
  const record = JSON.stringify({ ...payload, lastUpdate: Date.now() });
  await c.env.CACHE_KV.put(`build:${jobId}`, record, { expirationTtl: 3600 });

  // If this is a claim-originated build that just finished/failed, flip its claim
  // session (building → completed | failed) + email the owner. No-op for normal
  // builds (jobId == siteId has no claim session) and for non-terminal statuses.
  // Best-effort + backgrounded so the email send never slows the callback.
  let ec: ExecutionContext | undefined;
  try {
    ec = c.executionCtx;
  } catch {
    ec = undefined;
  }
  // #24 — claim-build finalize is deploy/claim-critical; a silent `.catch(() => {})`
  // hid failures (a finished build that never flips the claim session / never emails
  // the owner).
  const finalize = maybeCompleteClaimBuild(c.env, jobId, payload.status ?? '').catch((e) => {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'build_status_finalize',
        job_id: jobId,
        status: payload.status ?? null,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
  });
  if (ec) ec.waitUntil(finalize);
  else await finalize;

  // Functions (Stage 2.2a): the container bundles the site's functions/ folder and carries
  // the result here. Deploy (or remove) the site's WfP functions worker — deploySiteFunctions
  // is entitlement-gated + non-throwing; waitUntil'd + fail-soft so it never delays or breaks
  // the callback's {ok:true}. Only present on a terminal, successful build callback.
  const functionsBuild = payload.functionsBuild;
  if (functionsBuild) {
    const deployFns = (async () => {
      try {
        // The callback's jobId is the CONTAINER job id (`job-<ts>-<rand>`), NOT the
        // siteId — so a `WHERE id = jobId` lookup never matched and deploySiteFunctions
        // never ran (root cause of the 2.2a positive-dispatch miss, 2026-08-30). The
        // SITE_WORKFLOW writes a `job2site:{jobId}` → siteId KV mapping at build start;
        // resolve it here, falling back to jobId for claim builds where jobId == siteId.
        const siteId = (await c.env.CACHE_KV.get(`job2site:${jobId}`)) || jobId;
        const site = await dbQueryOne<{ org_id: string }>(
          c.env.DB,
          'SELECT org_id FROM sites WHERE id = ? AND deleted_at IS NULL',
          [siteId],
        );
        if (site?.org_id) {
          await deploySiteFunctions(c.env, {
            siteId,
            orgId: site.org_id,
            build: functionsBuild,
          });
        }
      } catch (e) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'functions_deploy',
            job_id: jobId,
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    })();
    if (ec) ec.waitUntil(deployFns);
    else await deployFns;
  }

  return c.json({ ok: true });
});

/**
 * Render a branded interstitial for `*.app.projectsites.dev` when the
 * underlying container is not in a `running` state. Kept inline because
 * the worker already ships ~80 KB of static HTML for the 404 page and the
 * App-tab shell is small enough to colocate.
 */
function renderAppShellHtml(
  state: 'booting' | 'crashed' | 'stopped' | 'not-found',
  data: { sub: string; slug?: string; err?: string; id?: string },
): string {
  const titles: Record<typeof state, string> = {
    booting: 'Booting your app',
    crashed: 'App crashed',
    stopped: 'App is stopped',
    'not-found': 'App not found',
  };
  // Escape every request/container-derived field — this page is served as HTML
  // and `sub` (from the Host header, NOT DNS-validated at the HTTP layer),
  // `err` (container output), `slug`, and `id` could otherwise reflect markup.
  const safeSub = escapeHtml(data.sub);
  const safeSlug = escapeHtml(data.slug ?? '—');
  const safeErr = escapeHtml(data.err ?? 'Unknown error');
  const safeId = escapeHtml(data.id ?? '');
  const bodies: Record<typeof state, string> = {
    booting: 'Your container is provisioning. This page refreshes automatically every 3 seconds.',
    crashed: `${safeErr} — open the admin to inspect logs and restart.`,
    stopped: 'The container is stopped. Restart it from the admin dashboard.',
    'not-found': `No app instance with subdomain "${safeSub}".`,
  };
  const cta =
    state === 'not-found'
      ? '<a class="btn" href="https://projectsites.dev/admin/apps">Browse apps</a>'
      : `<a class="btn" href="https://projectsites.dev/admin/apps/${safeId}">Open admin</a>`;
  const title = titles[state];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ProjectSites</title><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Fira+Code:wght@400&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:'Space Grotesk',sans-serif;padding:2rem}.box{max-width:560px;text-align:center}h1{font-size:2.2rem;background:linear-gradient(135deg,#00ffc8,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#00ffc8;animation:pulse 1.4s ease-in-out infinite;margin-right:.5rem;vertical-align:middle}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}p{color:#8892a4;font-size:1.05rem;line-height:1.5;margin-bottom:2rem}.btn{display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#00ffc8,#7c3aed);color:#0a0a0f;font-weight:600;border-radius:50px;text-decoration:none}.meta{margin-top:2rem;font-family:'Fira Code',monospace;font-size:.75rem;color:#4a9;background:rgba(0,255,200,.05);border:1px solid rgba(0,255,200,.1);padding:1rem;border-radius:8px;text-align:left}</style></head><body><div class="box"><h1>${state === 'booting' ? '<span class="dot"></span>' : ''}${title}</h1><p>${bodies[state]}</p>${cta}<div class="meta">app: ${safeSlug}<br>subdomain: ${safeSub}<br>state: ${state}</div></div></body></html>`;
}

// ─── appsmith.projectsites.dev — proxy to Railway ────────────
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `appsmith.${DOMAINS.SITES_BASE}`) return next();

  const url = new URL(c.req.url);
  const target = `https://projectsitesdev-production.up.railway.app${url.pathname}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Forwarded-Host', 'appsmith.projectsites.dev');
  headers.set('X-Forwarded-Proto', 'https');
  headers.delete('host');
  headers.set('Host', 'projectsitesdev-production.up.railway.app');

  // Disable CF cache for Appsmith HTML/API/WebSocket paths
  const resp = await fetch(target, {
    method: c.req.method,
    headers,
    body:
      c.req.method !== 'GET' && c.req.method !== 'HEAD'
        ? await c.req.raw.clone().arrayBuffer()
        : undefined,
    redirect: 'manual',
    cf: { cacheTtl: 0 },
  });

  const out = new Response(resp.body, resp);
  out.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  out.headers.set('X-Appsmith-Proxy', 'cf-worker');
  return out;
});

// ─── docs.projectsites.dev — Scalar API Reference ──────────
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `docs.${DOMAINS.SITES_BASE}`) return next();
  return c.html(renderDocsReferencePage());
});

// ─── admin.projectsites.dev — Angular Admin Dashboard SPA ──
// Serves the built Angular admin frontend from R2 at the admin/ prefix.
// Non-file paths (SPA routes) fall back to admin/index.html.
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `admin.${DOMAINS.SITES_BASE}`) return next();

  const url = new URL(c.req.url);
  const path = url.pathname;

  // Determine if this path looks like a file request (has extension)
  const hasExtension = path.includes('.') && !path.endsWith('/');
  const r2Key = hasExtension ? `admin${path}` : 'admin/index.html';

  try {
    const obj = await c.env.SITES_BUCKET.get(r2Key);
    if (obj) {
      const ext = r2Key.split('.').pop()?.toLowerCase() ?? 'html';
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
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
      const mime = mimeTypes[ext] ?? 'application/octet-stream';

      // For index.html, inject runtime env vars. For static assets, cache longer.
      if (r2Key === 'admin/index.html') {
        let html = await obj.text();
        const phKey = c.env.POSTHOG_API_KEY ?? '';
        const sentryDsn = c.env.SENTRY_DSN ?? '';
        const sentryInject = sentryDsn
          ? `<meta name="sentry-dsn" content="${sentryDsn.replace(/"/g, '&quot;')}">\n<script>window.__SENTRY_DSN__="${sentryDsn.replace(/"/g, '\\"')}";</script>`
          : '';
        html = html.replace(
          '</head>',
          `${sentryInject}<meta name="x-posthog-key" content="${phKey}">\n</head>`,
        );
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
            'Cross-Origin-Opener-Policy': 'same-origin',
          },
        });
      }

      return new Response(obj.body, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': `https://${hostname}`,
        },
      });
    }
  } catch {
    // Fall through to 404
  }

  // SPA fallback — if file not found, try index.html for client-side routing
  if (hasExtension) {
    const fallbackObj = await c.env.SITES_BUCKET.get('admin/index.html').catch(() => null);
    if (fallbackObj) {
      const text = await fallbackObj.text();
      return new Response(text, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
      });
    }
  }

  return c.notFound();
});

// ─── support.projectsites.dev — Support Landing Page ─────────
app.all('*', async (c, next) => {
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  if (hostname !== `support.${DOMAINS.SITES_BASE}`) return next();

  const url = new URL(c.req.url);
  const path = url.pathname;

  try {
    // Try to serve a support page from R2 first
    const hasExtension = path.includes('.') && !path.endsWith('/');
    const r2Key = hasExtension ? `support${path}` : 'support/index.html';
    const obj = await c.env.SITES_BUCKET.get(r2Key);
    if (obj) {
      const ext = r2Key.split('.').pop()?.toLowerCase() ?? 'html';
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        png: 'image/png',
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
      };
      if (r2Key === 'support/index.html') {
        return new Response(await obj.text(), {
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
        });
      }
      return new Response(obj.body, {
        headers: {
          'Content-Type': mimeTypes[ext] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
  } catch {
    // Fall through to inline page
  }

  // Inline branded support landing page
  return c.html(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support · ProjectSites</title>
<meta name="description" content="Get help with ProjectSites — AI-generated websites for small business.">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="https://support.projectsites.dev/">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#060610;color:#f4f4ff;font-family:'Space Grotesk',sans-serif;line-height:1.6;padding:40px 20px;
  background-image:radial-gradient(60% 50% at 50% 0%,rgba(0,229,255,.10),transparent 70%)}
.wrap{max-width:640px;width:100%}
.status{display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:#7ee787;margin-bottom:18px}
.dot{width:8px;height:8px;border-radius:50%;background:#7ee787;box-shadow:0 0 10px #7ee787}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:#00e5ff;margin-bottom:12px}
h1{font-size:clamp(1.8rem,5vw,2.8rem);font-weight:700;letter-spacing:-.03em;line-height:1.05;margin-bottom:14px;
  background:linear-gradient(135deg,#fff,rgba(0,229,255,.85));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#94a3b8;font-size:1.05rem;margin-bottom:26px}
.card{background:linear-gradient(145deg,rgba(13,13,40,.55),rgba(8,8,32,.7));border:1px solid rgba(0,229,255,.12);border-radius:16px;padding:18px 20px;margin-bottom:14px}
.card h2{font-size:.72rem;font-family:'JetBrains Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px}
.card p{color:#cbd5e1;font-size:.95rem}
a{color:#00e5ff;text-decoration:none}a:hover{text-decoration:underline}
.foot{margin-top:24px;font-size:.82rem;color:#6b7785;text-align:center}
.btn{display:inline-block;margin-top:12px;padding:12px 28px;background:#00e5ff;color:#060610;font-weight:600;border-radius:50px;text-decoration:none;transition:.2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(0,229,255,.3)}
</style></head><body><div class="wrap">
<div class="status"><span class="dot"></span>Available</div>
<div class="eyebrow">ProjectSites</div>
<h1>Support</h1>
<p class="sub">We are here to help. Reach out and we will get back to you promptly.</p>
<div class="card"><h2>Email</h2><p><a href="mailto:hey@megabyte.space">hey@megabyte.space</a></p></div>
<div class="card"><h2>Knowledge base</h2><p>Documentation and guides for building and managing your site.</p><a class="btn" href="https://docs.projectsites.dev/">Visit docs</a></div>
<div class="card"><h2>Status</h2><p>Check real-time system health for all ProjectSites services.</p><a href="https://projectsites.dev/status" style="color:#00e5ff">System status →</a></div>
<p class="foot">&larr; <a href="https://projectsites.dev/">projectsites.dev</a></p>
</div></body></html>`);
});

// ─── API soft-404 guard ──────────────────────────────────────
// An unmatched /api/* path must return a machine-readable JSON 404 — NEVER
// fall through to the SPA-shell catch-all below (a 200 text/html "response"
// to an API caller is a soft-404: it reads as success to fetch()/SDKs and
// poisons caches). Surfaced by the Pass-10 certification when the health-spec
// API-shape tests entered the executed set. Registered AFTER every /api route
// mount and BEFORE the site-serving catch-all, so only truly-unknown API
// paths land here.
app.all('/api/*', async (c) => {
  // ── Functions dispatch (ADR-0035 §30) ──
  // On a CHILD-SITE host, an unmatched /api/* may be a code-defined endpoint —
  // the site's functions/ worker on WfP (reserved platform routes like
  // /api/contact-form already matched above). This guard fires for /api/* on
  // ALL hosts and precedes the site-serving catch-all, so the dispatch attempt
  // belongs HERE. Skip platform hosts (base/www/localhost) so their unmatched
  // /api/* pays no extra resolve; maybeDispatchFunctions is a no-op (one D1 read)
  // for child sites without a deployed functions worker.
  const hostname = (c.req.header('host') ?? '').toLowerCase();
  const isPlatformHost =
    hostname === DOMAINS.SITES_BASE ||
    hostname === `www.${DOMAINS.SITES_BASE}` ||
    hostname.startsWith('localhost');
  if (!isPlatformHost) {
    const site = await resolveSite(c.env, c.env.DB, hostname);
    if (site) {
      const fnResponse = await maybeDispatchFunctions(
        c.env,
        { siteId: site.site_id, orgId: site.org_id },
        c.req.raw,
        new URL(c.req.url).pathname,
      );
      if (fnResponse) return fnResponse;
    }
  }
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Unknown API route',
        request_id: c.get('requestId') ?? 'unknown',
      },
    },
    404,
  );
});

// ─── Site Serving (catch-all for subdomain routing) ──────────

app.all('*', async (c) => {
  const hostname = c.req.header('host') ?? '';
  const url = new URL(c.req.url);
  const path = url.pathname;

  // Serve the marketing site homepage for the base domain
  if (
    hostname === DOMAINS.SITES_BASE ||
    hostname === `www.${DOMAINS.SITES_BASE}` ||
    hostname.startsWith('localhost')
  ) {
    // /contact redirects to the contact section, which lives on /search
    // (#contact-section is rendered by SearchComponent, not the homepage —
    // redirecting to /#contact-section landed on a non-existent anchor).
    if (path === '/contact') {
      return Response.redirect(`https://${DOMAINS.SITES_BASE}/search#contact-section`, 301);
    }

    // Angular SPA handles all routes — serve index.html for non-file paths
    const hasExtension = path.includes('.') && !path.endsWith('/');
    const marketingPath = hasExtension ? `marketing${path}` : 'marketing/index.html';
    const marketingAsset = await c.env.SITES_BUCKET.get(marketingPath);

    if (marketingAsset) {
      const resolvedPath = marketingAsset.key;
      const ext = resolvedPath.split('.').pop()?.toLowerCase() ?? 'html';

      // For HTML, inject runtime env vars (PostHog key, Stripe publishable
      // key) so the SPA shell can read them from meta tags before first paint.
      if (ext === 'html') {
        let html = await marketingAsset.text();
        const phKey = c.env.POSTHOG_API_KEY ?? 'none';
        const stripePk = c.env.STRIPE_PUBLISHABLE_KEY ?? '';

        // ALL-STAR items #15 + #20 + #21 injection block.
        // #15 Speculation Rules: prerender same-origin nav, prefetch external on hover.
        // #20 Structured-data autopilot: Organization + WebSite emitted on every marketing route.
        // #21 Quotable answer block: 40-60 word AI-search-extractable lead paragraph; visually
        //     hidden but available to crawlers + screen readers (sr-only pattern).
        const speculationRules = `<script type="speculationrules">{"prerender":[{"where":{"and":[{"href_matches":"/*"},{"not":{"href_matches":"/admin/*"}},{"not":{"href_matches":"/api/*"}}]},"eagerness":"moderate"}],"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"conservative"}]}</script>`;
        // Per-route WebPage + BreadcrumbList (was hardcoded to the homepage on
        // EVERY route — inaccurate on /privacy, /blog, etc.). `path` (url.pathname)
        // is the requested route; derive an accurate page url + breadcrumb trail
        // server-side so non-JS crawlers get route-correct structured data. The
        // Angular client re-confirms the same values post-hydration (idempotent).
        const cleanPath = path === '/' ? '/' : path.replace(/\/+$/, '');
        const pageUrl =
          cleanPath === '/' ? 'https://projectsites.dev/' : `https://projectsites.dev${cleanPath}`;
        const seg = cleanPath === '/' ? '' : (cleanPath.split('/').filter(Boolean).pop() ?? '');
        const segName = seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
        const pageName = seg
          ? `${segName} | Project Sites`
          : 'Project Sites — AI Website Builder on Cloudflare';
        const crumbItems = seg
          ? [
              { name: 'Home', item: 'https://projectsites.dev/' },
              { name: segName, item: pageUrl },
            ]
          : [{ name: 'Home', item: 'https://projectsites.dev/' }];
        const jsonLd = `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Organization',
              '@id': 'https://projectsites.dev/#org',
              name: 'Project Sites',
              url: 'https://projectsites.dev/',
              logo: 'https://projectsites.dev/logo.svg',
              email: 'hey@projectsites.dev',
              sameAs: ['https://github.com/HeyMegabyte/projectsites.dev'],
            },
            {
              '@type': 'WebSite',
              '@id': 'https://projectsites.dev/#site',
              url: 'https://projectsites.dev/',
              name: 'Project Sites',
              publisher: { '@id': 'https://projectsites.dev/#org' },
              inLanguage: 'en-US',
              potentialAction: {
                '@type': 'SearchAction',
                target: 'https://projectsites.dev/?q={search_term_string}',
                'query-input': 'required name=search_term_string',
              },
            },
            {
              '@type': 'WebPage',
              '@id': `${pageUrl}#webpage`,
              url: pageUrl,
              name: pageName,
              ...(seg
                ? {}
                : {
                    description:
                      'AI-generated websites for small business in under 15 minutes. Multi-model router, axe-core publish gate, Core Web Vitals publish gate, GEO + AI search built-in.',
                  }),
              isPartOf: { '@id': 'https://projectsites.dev/#site' },
              about: { '@id': 'https://projectsites.dev/#org' },
            },
            {
              '@type': 'BreadcrumbList',
              '@id': `${pageUrl}#breadcrumb`,
              itemListElement: crumbItems.map((crumb, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                name: crumb.name,
                item: crumb.item,
              })),
            },
          ],
        })}</script>`;
        // Off-screen AI-search / SEO lead injected after <body>, BEFORE the Angular
        // <main> — so it's page content outside any landmark (axe `region`, on every
        // route incl /admin) AND a redundant off-screen paragraph for screen-reader
        // users. `aria-hidden="true"` removes it from the a11y tree (SR skips the
        // duplicate, `region` clears) while crawlers/AI still read the DOM text.
        const quotable = `<div data-quotable aria-hidden="true" style="position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Project Sites builds and deploys complete AI-generated websites for small business in under 15 minutes on Cloudflare Workers. The AI gateway routes each prompt to the right model by complexity — instant responses via Workers AI (free), routine generation via DeepSeek, premium reasoning via Anthropic Claude or OpenAI. Every publish runs an axe-core accessibility gate at six viewports and a Lighthouse Core Web Vitals gate, blocking deploys that fail WCAG 2.2 AA or LCP under 2.5 seconds.</div>`;

        html = html.replace(
          '</head>',
          `<meta name="x-posthog-key" content="${phKey}">\n<meta name="x-stripe-pk" content="${stripePk}">\n${speculationRules}\n${jsonLd}\n</head>`,
        );
        html = html.replace('<body>', `<body>\n${quotable}\n`);

        // Per-route <head> meta: the shell hard-codes the HOMEPAGE title/description
        // AND `<link rel=canonical href="https://projectsites.dev/">` on EVERY route,
        // so crawlers saw the homepage canonical for /pricing, /search, /auth/* — which
        // DE-INDEXES them (the client MetaService only fixes this post-hydration, unseen
        // by non-JS bots). Rewrite canonical + og:url to this route's pageUrl (always) +
        // title/description/OG when the route has dedicated copy.
        html = applyMarketingMeta(html, path, pageUrl);

        // Soft-404 guard: an extension-less path served the SPA shell fallback.
        // If it's NOT a known marketing route (e.g. `/garbage9999`), return a real
        // 404 status + noindex so crawlers/AI don't index junk URLs — the SPA still
        // renders its own 404 view. Known routes (incl. every /admin/* + dynamic
        // blog/:slug) stay 200. Real HTML files (hasExtension) are never soft-404'd.
        const isSoft404 = !hasExtension && !isKnownMarketingRoute(path);
        // `/admin/*` embeds the bolt.diy editor iframe, whose live Preview runs
        // `npm` inside a WebContainer — that needs SharedArrayBuffer, which needs the
        // PARENT document (this shell) to be crossOriginIsolated (COOP + COEP). The
        // editor doc setting its OWN COEP is NOT enough; nested isolation requires
        // the embedder too. Marketing routes stay COEP-free so their PostHog/GTM
        // beacons are untouched; on /admin, PostHog rides the same-origin `/ingest`
        // proxy so a `credentialless` COEP cannot block it. (Brian 2026-08-21 —
        // restores the Preview that removing COEP in 4e02d113 broke.)
        const isAdminShell = path === '/admin' || path.startsWith('/admin/');
        return new Response(html, {
          status: isSoft404 ? 404 : 200,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': isSoft404 ? 'no-cache, no-store' : 'public, max-age=60',
            ...(isSoft404 ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
            'Cross-Origin-Opener-Policy': 'same-origin',
            ...(isAdminShell ? { 'Cross-Origin-Embedder-Policy': 'credentialless' } : {}),
            'Origin-Agent-Cluster': '?1',
            // ALL-STAR #15 hint to CDN/CDN-aware clients
            Link: '<https://projectsites.dev/>; rel="prerender"',
          },
        });
      }

      return new Response(marketingAsset.body, {
        // Content-type via the canonical getContentType SSOT — the former inline
        // marketing map had drifted (missing jpeg/gif/webp/woff/ttf/eot/avif/wasm),
        // silently serving those as octet-stream so browsers downloaded them.
        headers: {
          'Content-Type': getContentType(resolvedPath),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Final fallback: return JSON info when no static assets deployed at all
    return c.json(
      {
        name: 'Project Sites',
        tagline: 'Your website\u2014handled. Finally.',
        version: '0.1.0',
        homepage: 'Deploy the marketing site to R2 at marketing/index.html',
      },
      200,
    );
  }

  // template.projectsites.dev → proxy to Cloudflare Pages (gallery of applied examples)
  if (hostname === 'template.projectsites.dev') {
    const pagesUrl = `https://template-projectsites-dev.pages.dev${path}${url.search}`;
    const pagesRes = await fetch(pagesUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    });
    return new Response(pagesRes.body, {
      status: pagesRes.status,
      headers: pagesRes.headers,
    });
  }

  // (editor.projectsites.dev → bolt-diy Pages proxy hoisted to early middleware
  // near the top of the pipeline — see the `app.use('*', ...)` host-gated proxy,
  // round 145 — so editor /api/* paths proxy too instead of being pre-empted by
  // the worker's own /api routing.)

  // ─── Apps tab — *.app.projectsites.dev → AppRuntime container DO ──
  // Hostnames of the form `{subdomain}.app.projectsites.dev` resolve to
  // a row in `app_instances` and proxy the request to its container DO.
  // Match `{subdomain}.app.projectsites.dev`. Wildcard SAN `*.app.projectsites.dev`
  // must be provisioned via CF Advanced Certificate Manager (or a custom-
  // hostname rule) since the existing Universal SSL only covers the
  // single-level `*.projectsites.dev`. Track via RECS.md.
  // Serve an app instance by its subdomain. Used by BOTH the platform suffix
  // (`{sub}.app.projectsites.dev`) AND a custom CNAME resolved via the Phase-1
  // host-map (`app.theirdomain.com` → instance), so the two paths share one body.
  const serveAppBySubdomain = async (sub: string): Promise<Response> => {
    const inst = await dbQueryOne<{
      id: string;
      status: string;
      do_instance_id: string | null;
      last_error: string | null;
      app_slug: string;
    }>(
      c.env.DB,
      `SELECT id, status, do_instance_id, last_error, app_slug FROM app_instances
         WHERE subdomain = ? AND deleted_at IS NULL`,
      [sub],
    );
    if (!inst) {
      return new Response(renderAppShellHtml('not-found', { sub }), {
        status: 404,
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }
    if (inst.status === 'provisioning' || inst.status === 'starting') {
      return new Response(renderAppShellHtml('booting', { sub, slug: inst.app_slug }), {
        status: 202,
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-store',
          Refresh: '3',
        },
      });
    }
    if (inst.status === 'error' || inst.status === 'crashed') {
      return new Response(
        renderAppShellHtml('crashed', {
          sub,
          slug: inst.app_slug,
          err: inst.last_error ?? 'unknown',
          id: inst.id,
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' },
        },
      );
    }
    if (inst.status === 'stopped' || inst.status === 'destroyed') {
      return new Response(
        renderAppShellHtml('stopped', { sub, slug: inst.app_slug, id: inst.id }),
        {
          status: 503,
          headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' },
        },
      );
    }
    return proxyToContainer(c.env, inst.do_instance_id ?? inst.id, c.req.raw, inst.app_slug);
  };

  if (hostname.endsWith('.app.projectsites.dev') && hostname !== '.app.projectsites.dev') {
    return serveAppBySubdomain(hostname.slice(0, -'.app.projectsites.dev'.length));
  }

  // Resolve the site from hostname using D1
  const site = await resolveSite(c.env, c.env.DB, hostname);

  if (!site) {
    // Phase 1b (scale-to-zero routing): a hostname that matched no site may be a
    // custom app CNAME (`app.theirdomain.com → projectsites.dev`). Consult the
    // host-map; if it maps to an instance, serve it. Only runs AFTER resolveSite
    // misses, so normal site traffic pays no extra KV read.
    const appHost = await resolveAppHost(c.env, hostname);
    if (appHost) {
      return serveAppBySubdomain(appHost.subdomain);
    }

    const reqId = c.get('requestId') || 'unknown';
    const errorHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found | ProjectSites</title><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500&family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:'Space Grotesk',sans-serif;overflow:hidden}@keyframes glitch{0%,100%{transform:translate(0)}20%{transform:translate(-2px,2px)}40%{transform:translate(2px,-2px)}60%{transform:translate(-1px,-1px)}80%{transform:translate(1px,1px)}}@keyframes scanline{0%{top:-100%}100%{top:100%}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}@keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}.container{text-align:center;max-width:600px;padding:2rem;position:relative;z-index:1}.bg{position:fixed;inset:0;background:linear-gradient(-45deg,#0a0a0f,#0d1117,#0a1628,#0f0a1e);background-size:400% 400%;animation:gradient 8s ease infinite}.grid{position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,200,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,200,.03) 1px,transparent 1px);background-size:60px 60px}.scanline{position:fixed;width:100%;height:4px;background:linear-gradient(90deg,transparent,rgba(0,255,200,.08),transparent);animation:scanline 4s linear infinite;z-index:0}.code{font-size:8rem;font-weight:700;background:linear-gradient(135deg,#00ffc8,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:float 3s ease-in-out infinite;line-height:1}.msg{font-size:1.5rem;color:#8892a4;margin:1rem 0 2rem;animation:pulse 3s ease-in-out infinite}.btn{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#00ffc8,#00d4ff);color:#0a0a0f;font-weight:600;border-radius:50px;text-decoration:none;transition:all .3s;font-family:inherit}.btn:hover{transform:translateY(-3px);box-shadow:0 8px 30px rgba(0,255,200,.3)}.debug{margin-top:3rem;text-align:left;background:rgba(0,255,200,.04);border:1px solid rgba(0,255,200,.1);border-radius:12px;padding:1.5rem;font-family:'Fira Code',monospace;font-size:.75rem;color:#4a9;line-height:1.8}.debug-title{color:#00ffc8;font-size:.85rem;margin-bottom:.5rem;font-weight:500}.debug span{color:#667}</style></head><body><div class="bg"></div><div class="grid"></div><div class="scanline"></div><div class="container"><div class="code">404</div><p class="msg">This site doesn't exist yet</p><a class="btn" href="https://projectsites.dev/create">Build it with AI</a><div class="debug"><div class="debug-title">// debug info</div><span>hostname:</span> ${hostname}<br><span>request_id:</span> ${reqId}<br><span>timestamp:</span> ${new Date().toISOString()}<br><span>resolved:</span> null<br><span>edge:</span> ${c.req.header('cf-ray') || 'unknown'}<br><span>colo:</span> ${(c.req.raw as any).cf?.colo || 'unknown'}</div></div></body></html>`;
    return new Response(errorHtml, {
      status: 404,
      headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  // (Removed: a dead `?chat` branch that returned raw JSON
  // ("Chat overlay - authentication required") to any visitor who appended
  // `?chat` — an unfinished stub nothing linked to or consumed. Unknown query
  // params now fall through to normal site serving. A real on-site chat overlay,
  // if ever built, belongs behind a feature flag as an injected frontend widget,
  // not a JSON branch on the serving path.)

  // Record an anonymous edge pageview (Cloudflare-native, fire-and-forget) so
  // visitor navigations surface in the per-site analytics dashboard. Never
  // blocks or fails serving — see recordPageviewFromRequest.
  c.executionCtx.waitUntil(
    recordPageviewFromRequest(c.env, { orgId: site.org_id, siteId: site.site_id }, c.req.raw, path),
  );

  // Serve static site from R2 (host passed for the AL-394 edge-cache key: per-host
  // canonical/OG correctness + version-invalidation).
  return serveSiteFromR2(c.env, site, path, hostname);
});

// ─── Queue Consumer ──────────────────────────────────────────

export default {
  fetch: app.fetch,

  /**
   * Queue consumer handler for workflow jobs.
   *
   * Processes queued `generate_site` jobs by running the v2 AI workflow,
   * uploading results to R2, and updating the site record in D1.
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = message.body as Record<string, unknown>;
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'queue',
            message: `Processing job: ${payload.job_name}`,
            site_id: payload.site_id,
          }),
        );

        if (payload.job_name === 'generate_site') {
          const { runSiteGenerationWorkflowV2 } = await import('./services/ai_workflows.js');

          const result = await runSiteGenerationWorkflowV2(env, {
            businessName: String(payload.business_name ?? ''),
            businessAddress: payload.business_address
              ? String(payload.business_address)
              : undefined,
            businessPhone: payload.business_phone ? String(payload.business_phone) : undefined,
            googlePlaceId: payload.google_place_id ? String(payload.google_place_id) : undefined,
            additionalContext: payload.additional_context
              ? String(payload.additional_context)
              : undefined,
          });

          // Upload generated files to R2
          const siteId = String(payload.site_id);
          // Prefer the authoritative slug the producer forwards (from
          // ensureUniqueSlug) so the R2 upload prefix matches what the serving path
          // resolves by the D1 `sites.slug`. Only derive from business_name for
          // legacy messages that predate the `slug` field (else the recomputed slug
          // can miss the unique `-N` suffix → published site 404s).
          const slug = payload.slug
            ? String(payload.slug)
            : String(payload.business_name ?? 'site')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
          const version = new Date().toISOString().replace(/[:.]/g, '-');

          // Upload main page, privacy page, and terms page in parallel
          await Promise.all([
            env.SITES_BUCKET.put(`sites/${slug}/${version}/index.html`, result.html, {
              httpMetadata: { contentType: 'text/html' },
            }),
            env.SITES_BUCKET.put(`sites/${slug}/${version}/privacy.html`, result.privacyHtml, {
              httpMetadata: { contentType: 'text/html' },
            }),
            env.SITES_BUCKET.put(`sites/${slug}/${version}/terms.html`, result.termsHtml, {
              httpMetadata: { contentType: 'text/html' },
            }),
            // Store research data as JSON for future rebuilds
            env.SITES_BUCKET.put(
              `sites/${slug}/${version}/research.json`,
              JSON.stringify(result.research, null, 2),
              { httpMetadata: { contentType: 'application/json' } },
            ),
          ]);

          // Update site record in D1. dbUpdate NEVER throws — it returns {error}.
          // A bare await would ACK the message with the bundle already in R2 but the
          // row still 'generating' (a lying-success the customer sees as "building
          // forever"). Throw on error so the catch below calls message.retry().
          const publishUpdate = await dbUpdate(
            env.DB,
            'sites',
            {
              status: 'published',
              current_build_version: version,
            },
            'id = ?',
            [siteId],
          );
          if (publishUpdate.error) {
            throw new Error(`Failed to flip site ${siteId} to published: ${publishUpdate.error}`);
          }

          console.warn(
            JSON.stringify({
              level: 'info',
              service: 'queue',
              message: `Site generated and published`,
              site_id: siteId,
              slug,
              version,
              quality_score: result.quality.overall,
              pages_uploaded: ['index.html', 'privacy.html', 'terms.html', 'research.json'],
            }),
          );
        }

        message.ack();
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'queue',
            message: err instanceof Error ? err.message : 'Job processing failed',
          }),
        );
        message.retry();
      }
    }
  },

  /**
   * Scheduled handler for periodic tasks (cron triggers).
   *
   * Runs:
   * - Verify pending custom hostnames via Cloudflare API
   * - Log results for observability
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.warn(
      JSON.stringify({
        level: 'info',
        service: 'cron',
        message: 'Scheduled task triggered',
        trigger: _event.cron,
      }),
    );

    // Stage 6.1 — dispatch due Functions crons. WfP dispatch scripts can't
    // self-schedule, so the platform cron reads the site schedules, cron-matches the
    // current UTC minute, and invokes each due site's WfP worker via the reserved
    // /api/_ps/scheduled fetch (a dispatch stub exposes `.fetch()` only). Gated to the
    // every-minute trigger so each schedule fires at most once/min (other crons also
    // run this handler); per-site fail-soft; never throws out of scheduled().
    if (_event.cron === '* * * * *') {
      try {
        const { listActiveFunctionsSchedules } = await import('./services/functions_deploy.js');
        const { cronMatches } = await import('./services/functions/cron_match.js');
        const { siteFunctionsScriptName } = await import('./services/wfp_dispatch.js');
        const { signFunctionToken } = await import('./services/functions/internal.js');
        const now = new Date();
        const schedules = await listActiveFunctionsSchedules(env.DB);
        const dueByCron = new Map<string, string>(); // siteId → the matching cron
        for (const s of schedules) {
          if (!dueByCron.has(s.siteId) && cronMatches(s.cron, now)) dueByCron.set(s.siteId, s.cron);
        }
        const dispatch = (
          env as unknown as {
            USER_DISPATCH?: { get(name: string): { fetch(req: Request): Promise<Response> } };
          }
        ).USER_DISPATCH;
        const secret = (env as unknown as { FUNCTIONS_INTERNAL_SECRET?: string })
          .FUNCTIONS_INTERNAL_SECRET;
        let dispatched = 0;
        if (dispatch) {
          for (const [siteId, cron] of dueByCron) {
            try {
              const token = secret ? await signFunctionToken(secret, siteId) : '';
              const stub = dispatch.get(siteFunctionsScriptName(siteId));
              _ctx.waitUntil(
                stub
                  .fetch(
                    new Request(
                      `https://ps-internal/api/_ps/scheduled?cron=${encodeURIComponent(cron)}`,
                      { headers: token ? { authorization: `Bearer ${token}` } : {} },
                    ),
                  )
                  .then(() => undefined)
                  .catch(() => undefined),
              );
              dispatched++;
            } catch {
              /* per-site fail-soft — one bad script never blocks the others */
            }
          }
        }
        if (dispatched > 0) {
          console.warn(
            JSON.stringify({
              level: 'info',
              service: 'cron',
              message: `Dispatched ${dispatched} functions scheduled handler(s)`,
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'functions scheduled dispatch failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    try {
      const { verifyPendingHostnames } = await import('./services/domains.js');
      const result = await verifyPendingHostnames(env.DB, env);

      console.warn(
        JSON.stringify({
          level: 'info',
          service: 'cron',
          message: 'Hostname verification complete',
          verified: result.verified,
          failed: result.failed,
        }),
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'cron',
          message: 'Hostname verification failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Unstick stalled builds — any in-progress build whose workflow died (no
    // `updated_at` progress in 30 min; the workflow heartbeats every ~30s) is flipped
    // to 'error' so the serve layer stops looping the "Building…" page forever. The
    // status set (incl. `collecting`, which the old inline list MISSED → stranded
    // research-phase builds) + the {error}-observed UPDATE live in the testable SSOT.
    try {
      const { unstickStalledBuilds } = await import('./services/stuck_builds.js');
      const recovered = await unstickStalledBuilds(env);
      if (recovered > 0) {
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: `Unstuck ${recovered} stalled builds`,
          }),
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'cron',
          message: 'Stuck build scanner failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // #27 — abandoned-build recovery nudge. No-op while the `abandoned_build_nudge`
    // flag is off (dark-launch); when enabled, emails owners whose finished build
    // is unclaimed (eligibility + throttle in services/abandoned_builds.ts).
    try {
      const { runAbandonedNudgesForEnv } = await import('./services/abandoned_builds_cron.js');
      const r = await runAbandonedNudgesForEnv(env);
      if (!r.skipped) {
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Abandoned-build nudge sweep complete',
            scanned: r.scanned,
            nudged: r.nudged,
          }),
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'cron',
          message: 'Abandoned-build nudge sweep failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Task-inbox expiry sweep — auto-resolve expired + unresolved AI-elicitation
    // tasks that carry a `default_choice`, stamping the row resolved with
    // `autoDefaulted:true`. The site-generation logo-approval step already
    // self-heals functionally via its own `waitForEvent` timeout; this sweep is
    // the `applyExpiredDefaults` cron those comments reference — it keeps the
    // admin tray + audit trail consistent and stops expired rows accumulating as
    // NULL-resolved. Cheap indexed sweep, no-op when the inbox is empty.
    try {
      const { applyExpiredDefaults } = await import('./services/task_inbox.js');
      const defaulted = await applyExpiredDefaults(env);
      if (defaulted > 0) {
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Task-inbox expired-default sweep complete',
            defaulted,
          }),
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'cron',
          message: 'Task-inbox expired-default sweep failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // AN5 — once daily, roll up yesterday's visitor_events into analytics_daily so
    // owner analytics answers "last N days" in O(days) rows. Idempotent UPSERT, so a
    // missed/replayed day self-heals on the next run. Runs only on the daily 06:00 UTC trigger.
    if (_event.cron === '0 6 * * *') {
      try {
        const { rollupAnalyticsDaily } = await import('./services/analytics_rollup.js');
        const r = await rollupAnalyticsDaily(env);
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Analytics daily rollup complete',
            day: r.day,
            changes: r.changes,
            error: r.error,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Analytics daily rollup failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Every 5 min — drain the event_bus outbox to its backends (Tinybird analytics
    // + Hatchet orchestration). Env-gated adapters no-op when unconfigured, so this
    // is safe on a fresh deploy. Off the hot path (cron only). Idempotent + FIFO
    // with a dead-letter gate (see event_bus.nextOutboxAction). Repurposes the
    // former no-op */5 slot.
    if (_event.cron === '*/5 * * * *') {
      try {
        const { drainOutbox, assessDrainHealth } = await import('./services/outbox_dispatch.js');
        const summary = await drainOutbox(env);
        if (summary.read > 0) {
          // Escalate failures / backlog to warn so they surface above the info noise
          // (events failing dispatch head toward the dead-letter gate silently otherwise).
          const health = assessDrainHealth(summary);
          console.warn(
            JSON.stringify({
              level: health.level,
              service: 'cron',
              message: `Outbox drained — ${health.message}`,
              read: summary.read,
              dispatched: summary.dispatched,
              failed: summary.failed,
            }),
          );
          // Dead-lettering = silent loss of golden-path events from analytics +
          // orchestration. Log failures (not mere backlog, which is
          // transient under load).
          if (health.hasFailures) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                service: 'cron_outbox',
                message: 'Outbox events failing dispatch (heading to dead-letter)',
                read: summary.read,
                dispatched: summary.dispatched,
                failed: summary.failed,
              }),
            );
          }
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Outbox drain failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      // SOCIAL-105 — token refresh backstop: scan social_accounts for tokens
      // expiring within 72h and refresh them before they expire. Flag-gated
      // (no-op when social_publishing_native is off).
      try {
        const { runTokenRefreshCron } = await import('./services/social_token_cron.js');
        const summary = await runTokenRefreshCron(env);
        if (summary.scanned > 0) {
          console.warn(
            JSON.stringify({
              level: 'info',
              service: 'cron',
              message: 'Social token refresh sweep complete',
              ...summary,
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Social token refresh sweep failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      // Stage 4.2c — per-site Functions daily-cap enforcement. SUM today's dispatches
      // per site in Analytics Engine + flip the `fn_overcap:<siteId>` KV flag (TTL →
      // next UTC midnight) for any site over the 100k/day ceiling; the hot-path dispatch
      // reads that flag → 429. Fail-soft (an AE/KV fault just skips this cycle).
      try {
        const { enforceFunctionsDailyCaps } = await import('./services/functions_daily_cap.js');
        const flagged = await enforceFunctionsDailyCaps(env);
        if (flagged > 0) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              service: 'cron',
              message: `Functions daily-cap: flagged ${flagged} site(s) over the daily limit`,
              flagged,
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Functions daily-cap enforcement failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Monday 14:00 UTC (9 AM ET) — weekly summary digest emails (#96).
    // Idempotent per (org, ISO week) — safe to retry/replay.
    if (_event.cron === '0 14 * * 1') {
      try {
        const { sendWeeklyDigestsForAllOrgs } = await import('./services/weekly_digest.js');
        const result = await sendWeeklyDigestsForAllOrgs(env);
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Weekly digest dispatched',
            ...result,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Weekly digest cron failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Daily 06:00 UTC — backfill snapshot quality metrics for any snapshot
    // newer than 7 days that's still missing its metrics row. Caps at 50
    // per run so a backlog never melts Browser Rendering quota.
    if (_event.cron === '0 6 * * *') {
      try {
        const { runSnapshotMetricsBackfillCron } = await import('./workflows/snapshot-quality.js');
        const result = await runSnapshotMetricsBackfillCron(env);
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Snapshot metrics backfill complete',
            ...result,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Snapshot metrics backfill failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      // Table hygiene: prune delivered (dispatched) outbox rows older than 30
      // days so event_bus.outbox_events doesn't grow unbounded. Pending + failed
      // rows are never touched. Own try/catch so a prune failure can't block the
      // snapshot backfill above (or vice-versa).
      try {
        const { pruneDispatchedOutbox } = await import('./services/event_bus.js');
        const { deleted } = await pruneDispatchedOutbox(env, 30);
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Outbox retention prune complete',
            deleted,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Outbox retention prune failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Hourly: re-pull every connected Google Drive folder for AI chat context.
    // Soft-fails per site so one failure cannot block the rest.
    if (_event.cron === '0 * * * *' || _event.cron === '0 0 * * *') {
      try {
        const { syncAllSites } = await import('./services/ai_drive_sync.js');
        const results = await syncAllSites(env, env.DB);
        const summary = results.reduce(
          (acc, r) => {
            acc.total += 1;
            if (r.ok) acc.ok += 1;
            else acc.failed += 1;
            return acc;
          },
          { total: 0, ok: 0, failed: 0 },
        );
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Drive sync complete',
            ...summary,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Drive sync failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Every minute: Pulse Social Auto-Pilot sweep. Picks orgs whose
    // auto-pilot is enabled and past due, generates one draft per target
    // network, and bumps next_run_at by cadence_hours. Drafts only — the
    // user reviews + publishes manually (safety rail). Capped at 10
    // orgs/run so a backlog never burns the LLM budget.
    if (_event.cron === '* * * * *') {
      try {
        const { runAutoPilotIfDue } = await import('./services/social_auto_pilot.js');
        const result = await runAutoPilotIfDue(env, 10);
        if (result.orgs_scanned > 0) {
          console.warn(
            JSON.stringify({
              level: 'info',
              service: 'cron',
              message: 'Pulse Social auto-pilot sweep',
              ...result,
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Pulse Social auto-pilot sweep failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Every minute: Pulse Social due-post sweep. Picks up any post in
    // status='scheduled' with scheduled_at in [NOW-10min, NOW] and fires the
    // SocialPublishWorkflow. The lower bound prevents replays after long
    // worker outages. Capped at 25 posts/run.
    if (_event.cron === '* * * * *') {
      try {
        const { dbQuery, dbUpdate } = await import('./services/db.js');
        const lower = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const upper = new Date().toISOString();
        const { data: due } = await dbQuery<{ id: string }>(
          env.DB,
          `SELECT id FROM pulse_posts
            WHERE deleted_at IS NULL AND status = 'scheduled'
              AND scheduled_at <= ? AND scheduled_at > ?
            ORDER BY scheduled_at ASC LIMIT 25`,
          [upper, lower],
        );
        const wfBinding = (
          env as unknown as {
            SOCIAL_PUBLISH_WORKFLOW?: {
              create: (opts: { id: string; params: { post_id: string } }) => Promise<unknown>;
            };
          }
        ).SOCIAL_PUBLISH_WORKFLOW;
        let fired = 0;
        for (const p of due) {
          // Optimistically flip → publishing so the next sweep skips this row.
          const { changes } = await dbUpdate(
            env.DB,
            'pulse_posts',
            { status: 'publishing' },
            "id = ? AND status = 'scheduled'",
            [p.id],
          );
          if (changes === 0) continue;
          if (wfBinding) {
            await wfBinding
              .create({ id: `social-publish-${p.id}-${Date.now()}`, params: { post_id: p.id } })
              .catch((err: unknown) => {
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    service: 'cron',
                    message: 'social_publish_create_failed',
                    post_id: p.id,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              });
          }
          fired++;
        }
        if (fired > 0) {
          console.warn(
            JSON.stringify({
              level: 'info',
              service: 'cron',
              message: 'Pulse Social due-post sweep',
              fired,
              scanned: due.length,
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Pulse Social sweep failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // Hourly: Pulse Social analytics snapshot pull. For every social_publishes
    // row that succeeded in the last 30 days, hit the platform's metrics
    // endpoint and write a fresh social_analytics_snapshots row. Capped at
    // 200/run so a backlog never melts platform rate limits.
    if (_event.cron === '0 * * * *') {
      try {
        const result = await runHourlyPulseAnalyticsCron(env);
        console.warn(
          JSON.stringify({
            level: 'info',
            service: 'cron',
            message: 'Pulse Social analytics snapshot',
            ...result,
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'error',
            service: 'cron',
            message: 'Pulse Social analytics cron failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  },
};
