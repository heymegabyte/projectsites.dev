/**
 * @module platform/service-registry
 *
 * @description
 * Single source of truth for every system ProjectSites.dev runs or depends on —
 * the typed registry behind the convergence prompt §13 service registry and the
 * admin service catalog (§66). Each entry records what the service IS, where it
 * runs, which package/adapter owns it, its feature flag, its admin/public
 * surface, and its lifecycle status. Kept in lockstep with reality: update an
 * entry whenever a service is added, renamed, migrated, launched, or removed.
 *
 * Consumed by `scripts/check-architecture-fitness.mjs` (referential-integrity +
 * exclude-list cross-check) and unit-tested in `__tests__/architecture_fitness`.
 *
 * @see docs/architecture/service-registry.md
 * @see docs/adr/0019-amazon-ses-plus-listmonk-email.md
 */

/** Lifecycle of a registered service. */
export type ServiceStatus =
  | 'planned'
  | 'provisioned'
  | 'scaffolded'
  | 'integrated'
  | 'production'
  | 'deprecated'
  | 'removed';

/** Where the service executes. */
export type ServiceRuntime =
  | 'cloudflare-worker'
  | 'cloudflare-workflow'
  | 'cloudflare-container'
  | 'cloudflare-managed'
  | 'managed-saas'
  | 'self-hosted-container'
  | 'library'
  | 'removed'
  | 'not-applicable';

/** Coarse domain bucket. */
export type ServiceCategory =
  | 'edge'
  | 'workflow'
  | 'jobs'
  | 'auth'
  | 'authz'
  | 'billing'
  | 'webhooks'
  | 'observability'
  | 'browser'
  | 'ai'
  | 'data'
  | 'cms'
  | 'notifications'
  | 'secrets'
  | 'email'
  | 'lead-engine'
  | 'security'
  | 'docs'
  | 'internal';

/** Who may reach the service. */
export type ServiceAccess =
  | 'public'
  | 'customer-authenticated'
  | 'internal-access'
  | 'service-only';

/** One registered platform service. Shape mirrors convergence §13. */
export interface ServiceRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly domain?: string;
  readonly category: ServiceCategory;
  readonly runtime: ServiceRuntime;
  readonly ownerPackage?: string;
  readonly adapterPackage?: string;
  readonly featureFlag?: string;
  readonly adminSurface?: string;
  readonly publicSurface?: string;
  readonly datastore?: readonly string[];
  readonly secretsNamespace?: string;
  readonly status: ServiceStatus;
  readonly access: ServiceAccess;
  readonly notes?: string;
}

/**
 * The registry. Status reflects the repo as it actually is (not aspiration):
 * `production` = live + load-bearing; `scaffolded` = code present, gated/inert;
 * `planned` = decided, not built; `deprecated` = being migrated out.
 */
export const SERVICE_REGISTRY: readonly ServiceRegistryEntry[] = [
  {
    id: 'edge-api',
    name: 'Hono/Workers API gateway',
    domain: 'projectsites.dev',
    category: 'edge',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites',
    status: 'production',
    access: 'public',
  },
  {
    id: 'site-serving',
    name: 'Generated customer site serving (R2 static-first)',
    domain: '*.projectsites.dev',
    category: 'edge',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites/src/services/site_serving.ts',
    datastore: ['R2', 'KV', 'D1'],
    status: 'production',
    access: 'public',
    notes: 'Static-first; must stay independent of CMS/admin/vendor outages (§56).',
  },
  {
    id: 'site-generation-workflow',
    name: 'AI site generation (Cloudflare Workflow + Container)',
    category: 'workflow',
    runtime: 'cloudflare-workflow',
    ownerPackage: 'apps/project-sites/src/workflows/site-generation.ts',
    datastore: ['D1', 'R2'],
    status: 'production',
    access: 'service-only',
  },
  {
    id: 'drive-sync-workflow',
    name: 'Google Drive ingest (Cloudflare Workflow)',
    category: 'workflow',
    runtime: 'cloudflare-workflow',
    ownerPackage: 'apps/project-sites/src/workflows/drive-sync.ts',
    status: 'production',
    access: 'service-only',
    notes:
      'Resumable Google Drive asset ingest. Binding DRIVE_SYNC_WORKFLOW (class DriveSyncWorkflow).',
  },
  {
    id: 'image-generation-workflow',
    name: 'AI image generation (Cloudflare Workflow)',
    category: 'workflow',
    runtime: 'cloudflare-workflow',
    ownerPackage: 'apps/project-sites/src/workflows/image-generation.ts',
    datastore: ['R2'],
    status: 'production',
    access: 'service-only',
    notes:
      'Resumable DALL·E → Stability fallback image generation. Binding IMAGE_GENERATION_WORKFLOW (class ImageGenerationWorkflow).',
  },
  {
    id: 'snapshot-quality-workflow',
    name: 'Snapshot quality matrix (Cloudflare Workflow)',
    category: 'workflow',
    runtime: 'cloudflare-workflow',
    ownerPackage: 'apps/project-sites/src/workflows/snapshot-quality.ts',
    datastore: ['D1', 'R2'],
    status: 'production',
    access: 'service-only',
    notes:
      'Screenshot + composition + SEO + a11y quality matrix. Binding SNAPSHOT_QUALITY_WORKFLOW (class SnapshotQualityWorkflow).',
  },
  {
    id: 'social-publish-workflow',
    name: 'Social publish fan-out (Cloudflare Workflow)',
    category: 'workflow',
    runtime: 'cloudflare-workflow',
    ownerPackage: 'apps/project-sites/src/workflows/social-publish.ts',
    datastore: ['D1'],
    status: 'production',
    access: 'service-only',
    notes:
      'Per-account fan-out for pulse_posts social publishing. Binding SOCIAL_PUBLISH_WORKFLOW (class SocialPublishWorkflow).',
  },
  {
    id: 'workflow-router',
    name: 'WorkflowRouter — CF-Workflows/Hatchet routing brain (§20)',
    category: 'jobs',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/workflow-router.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'Routing policy + JOB_DEFINITIONS + port + backend adapters (CF Workflows/Hatchet) + getJobRouter(env) factory + POST /api/jobs dispatch route (mounted, tested). Remaining: migrate the claim/billing/domain flows to dispatch through it (their dedicated Workflow classes). ADR-0034.',
  },
  {
    id: 'event-dispatcher',
    name: 'Unified Analytics ingestion dispatcher (Plane H)',
    category: 'observability',
    runtime: 'cloudflare-container',
    ownerPackage: 'apps/project-sites/src/durable_objects/event_dispatcher.ts',
    datastore: ['D1', 'Analytics Engine'],
    status: 'scaffolded',
    access: 'service-only',
    notes: 'Binding gated; /api/events degrades to 202 without it.',
  },
  {
    id: 'data-d1',
    name: 'D1 — platform relational metadata',
    category: 'data',
    runtime: 'cloudflare-managed',
    datastore: ['D1'],
    status: 'production',
    access: 'service-only',
    notes: 'Not a high-volume analytics sink (§26).',
  },
  {
    id: 'storage-r2',
    name: 'R2 — site bundles, assets, artifacts',
    category: 'data',
    runtime: 'cloudflare-managed',
    datastore: ['R2'],
    status: 'production',
    access: 'service-only',
  },
  {
    id: 'analytics-engine',
    name: 'Cloudflare Analytics Engine — high-volume events',
    domain: 'analytics.projectsites.dev',
    category: 'observability',
    runtime: 'cloudflare-managed',
    datastore: ['Analytics Engine'],
    status: 'production',
    access: 'internal-access',
  },
  {
    id: 'billing-stripe',
    name: 'Stripe — the only billing rail',
    domain: 'billing.projectsites.dev',
    category: 'billing',
    runtime: 'managed-saas',
    adapterPackage: 'apps/project-sites/src/services/billing.ts',
    secretsNamespace: '/stripe',
    status: 'production',
    access: 'customer-authenticated',
    notes: 'Polar excluded (§4); Stripe-only per ADR-0002.',
  },
  {
    id: 'ai-gateway',
    name: 'Cloudflare AI Gateway + LiteLLM facade',
    domain: 'llm.projectsites.dev',
    category: 'ai',
    runtime: 'cloudflare-managed',
    adapterPackage: 'apps/project-sites/src/services/external_llm.ts',
    status: 'integrated',
    access: 'service-only',
  },
  {
    id: 'traces-langfuse',
    name: 'Langfuse — LLM tracing (Tinybird-direct, v2)',
    domain: 'traces.projectsites.dev',
    category: 'observability',
    runtime: 'cloudflare-container',
    status: 'planned',
    access: 'internal-access',
  },
  {
    id: 'browser-gateway',
    name: 'Browser Run + Stagehand (Browserbase/Skyvern fallback)',
    domain: 'browser.projectsites.dev',
    category: 'browser',
    runtime: 'cloudflare-managed',
    adapterPackage: 'apps/project-sites/src/services/browser_gateway.ts',
    status: 'production',
    access: 'service-only',
  },
  {
    id: 'observability-posthog',
    name: 'PostHog — product/admin/claim surfaces only',
    category: 'observability',
    runtime: 'managed-saas',
    adapterPackage: 'apps/project-sites/src/services/analytics.ts',
    status: 'production',
    access: 'internal-access',
    notes: 'NEVER added to hosted customer sites (§4/§56).',
  },
  {
    id: 'email-port',
    name: 'Email ports — EmailProvider/MarketingEmailProvider + chooseEmailPath (§42)',
    category: 'email',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/email.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'Port + routing + fakes + AmazonSesEmailProvider + Listmonk adapter all built. All 10 transactional senders migrated onto the seam (SES-primary, progressive degradation by env). Port gained replyTo + headers (one-click List-Unsubscribe). ADR-0019.',
  },
  {
    id: 'email-ses',
    name: 'Amazon SES — transactional email (primary)',
    category: 'email',
    runtime: 'managed-saas',
    adapterPackage: 'apps/project-sites/src/services/ses_email_provider.ts',
    secretsNamespace: '/email',
    status: 'integrated',
    access: 'service-only',
    notes:
      'AmazonSesEmailProvider wired as the PRIMARY transactional rail across all 10 senders (progressive degradation by env, no flag) + the bounce/complaint suppression pipeline (ses_notifications + email_suppressions + /webhooks/ses). Needs AWS_* + SES_FROM_EMAIL prod secrets to go live — see docs/runbooks/email-deliverability-activation.md. Per ADR-0019.',
  },
  {
    id: 'email-listmonk',
    name: 'Listmonk — newsletters/campaigns (SES SMTP relay)',
    domain: 'mail.projectsites.dev',
    category: 'email',
    runtime: 'cloudflare-container',
    adapterPackage: 'apps/project-sites/src/services/listmonk_email_provider.ts',
    secretsNamespace: '/email',
    status: 'integrated',
    access: 'internal-access',
    notes:
      'LIVE + hosted at mail.projectsites.dev (2026-06-25) — CF Workers Container (infra/listmonk, image listmonk/listmonk:v4.1.0) backed by Neon Postgres (projectsites_listmonk DB on the "Listmonk" Neon project); serves the admin/login (200). Reached via an EXPLICIT Workers route mail.projectsites.dev/* → projectsites-listmonk (the custom_domain alone did NOT beat the main worker’s *.projectsites.dev/* wildcard). ListmonkMarketingEmailProvider wraps listmonk_client (upsert/createCampaign/startCampaign/unsubscribe). REMAINING for send: set SES_SMTP_HOST/USER/PASSWORD secrets (the SES relay, ADR-0019) — hosting is live, outbound campaigns dark until those land. Per ADR-0019.',
  },
  {
    id: 'email-suppressions',
    name: 'Email suppression store — bounce/complaint list + event log (§42)',
    category: 'email',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites/src/services/email_suppressions.ts',
    datastore: ['d1:email_suppressions', 'd1:email_events'],
    status: 'integrated',
    access: 'service-only',
    notes:
      'recordSuppressions (idempotent) + isSuppressed (fail-open pre-send check in email-router) + listSuppressions/removeSuppression (super-admin). Migration 0575. Platform-level, no tenant_id (SES reputation is account-wide). ADR-0019.',
  },
  {
    id: 'ses-notifications',
    name: 'SES bounce/complaint parser (§42)',
    category: 'email',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/services/ses_notifications.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'parseSesNotification — pure SNS/SES envelope → SesSuppression[]. Permanent bounce + complaint suppress; transient does NOT. Never throws. ADR-0019.',
  },
  {
    id: 'ses-webhook',
    name: 'SES bounce/complaint ingest — POST /webhooks/ses (§42)',
    domain: 'api.projectsites.dev',
    category: 'webhooks',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites/src/routes/ses_webhooks.ts',
    secretsNamespace: '/webhooks',
    status: 'integrated',
    access: 'service-only',
    notes:
      'HMAC-verified (SES_WEBHOOK_SECRET) via Hookdeck/SNS; SubscriptionConfirmation auto-confirm (SSRF-guarded) → parseSesNotification → recordSuppressions. Needs SES_WEBHOOK_SECRET + the SNS subscription to activate; see docs/runbooks/email-deliverability-activation.md. ADR-0019.',
  },
  {
    id: 'claim-links-dub',
    name: 'claimyour.site claim/referral links — internal (claim_links)',
    domain: 'claimyour.site',
    category: 'edge',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites/src/services/claim_links.ts',
    datastore: ['d1:claim_links'],
    status: 'production',
    access: 'public',
    notes:
      'Internal short-token claim links (generateShortToken → claim_links D1 table) on claimyour.site — NOT the Dub API (no DUB_* usage anywhere in src). Click tracked at the /api/claim redirect (markClaimLinkClicked → site.claim.started attribution emit). Dub-the-SaaS could later add click/sale analytics but is not integrated. §43.',
  },
  {
    id: 'authz-port',
    name: 'AuthorizationProvider port — OpenFGA graph + in-memory model (§29)',
    category: 'authz',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/authorization.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'Port + Fake + DenyAll + OpenFgaAuthorizationProvider (REST adapter) + requireAuthz middleware + getAuthorizationProvider(env) factory, all tested. Relationship bootstrap LIVE: grantSiteOwner fires on site_create (fail-soft, tested). Remaining: extend requireAuthz to more privileged mutation routes (currently org-membership-gated). ADR-0005.',
  },
  {
    id: 'abuse-arcjet',
    name: 'AbuseProvider port — app-aware abuse layer (§48, Arcjet)',
    category: 'security',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/abuse.ts',
    secretsNamespace: '/arcjet',
    status: 'scaffolded',
    access: 'service-only',
    notes:
      'Port + FakeAbuseProvider + AllowAllAbuseProvider + getAbuseProvider(env) factory + requireNotAbusive(kind) middleware, all tested. Sits ABOVE the CF-native rate_limit.ts (tenant/plan/kind-aware decisions). Fail-OPEN: unset ARCJET_KEY → AllowAll (CF limiter is the floor). Remaining: the Workers-compatible ArcjetAbuseProvider adapter + wiring requireNotAbusive onto claim/signup/form/ai-generate routes. §48.',
  },
  {
    id: 'oauth-native',
    name: 'Native OAuth connections — PKCE + paste-key + AES-GCM D1 storage',
    category: 'auth',
    runtime: 'cloudflare-worker',
    domain: 'integrations.projectsites.dev',
    ownerPackage: 'apps/project-sites/src/routes/mcp_oauth.ts',
    datastore: ['D1:mcp_connections'],
    status: 'production',
    access: 'customer-authenticated',
    notes:
      'The canonical OAuth layer — no external token vault. /api/mcp/:provider/connect + /callback + /paste — PKCE state flow + paste-key fallback when client_id unset. AES-GCM encrypted tokens in D1 mcp_connections table. Per-provider native adapters in src/services/oauth/.',
  },
  {
    id: 'auth-better-auth',
    name: 'Better Auth — the ONLY auth system (embedded, ADR-0006)',
    category: 'auth',
    runtime: 'cloudflare-worker',
    adapterPackage: 'apps/project-sites/src/auth/better-auth.ts',
    featureFlag: 'better_auth',
    secretsNamespace: '/better-auth',
    status: 'integrated',
    access: 'public',
    notes:
      'Better Auth EMBEDDED in the main worker on the main D1 (Kysely D1 dialect), owns sessions. Methods: email+password, magic link (via SES/Listmonk email), Google social, TOTP 2FA (passkey + SSO/SAML in later slices). Mounted at /api/auth/* behind the better_auth cutover flag — ON = Better Auth; OFF = legacy magic-link/Google/D1-session auth until frontend + user-migration land. NO Logto, NO WorkOS — Better Auth is the only auth. ADR-0006.',
  },
  {
    id: 'flags-openfeature',
    name: 'OpenFeature evaluation port over the D1 flag engine (§33/ADR-0033)',
    category: 'internal',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/feature-evaluation.ts',
    adapterPackage: 'apps/project-sites/src/middleware/feature-evaluation.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'FeatureEvaluationProvider port (OpenFeature ResolutionDetails contract) + FakeFeatureEvaluationProvider + D1FlagEvaluationProvider + getFeatureEvaluationProvider(env) factory, all tested. Deliberately wraps the EXISTING modules/feature_flags engine (D1 flag_overrides + KV + registry + rollout hashing) rather than adopting the OpenFeature vendor SDK — zero new deps, Workers-native, our D1 store stays source of truth. No env secret (wraps our own engine → always available, no gate). Ships dark: no handler calls it yet; wiring is additive + behavior-neutral. ADR-0033.',
  },
  {
    id: 'api-keys-native',
    name: 'Native API-key port over the D1 api_tokens keystore (§30/ADR-0030)',
    category: 'security',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/api-keys.ts',
    adapterPackage: 'apps/project-sites/src/middleware/api-keys.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'ApiKeyProvider port (create/verify/revoke contract w/ structured KeyVerificationResult) + FakeApiKeyProvider + D1ApiKeyProvider + getApiKeyProvider(env) factory, all tested. Wraps the EXISTING services/api_tokens keystore (psk_<hex>, SHA-256 hash in D1, scopes, expiry, revoke) — edge key-verification is Worker-native, so no external key-management service is hosted. Zero new deps, no env secret (wraps our own keystore → always available, no gate). api_tokens is the live verification path. ADR-0030.',
  },
  {
    id: 'traces-opentelemetry',
    name: 'OpenTelemetry span port + OTLP/HTTP exporter (§35/ADR-0035)',
    category: 'observability',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/tracing.ts',
    adapterPackage: 'apps/project-sites/src/middleware/tracing.ts',
    secretsNamespace: '/otel',
    status: 'scaffolded',
    access: 'service-only',
    notes:
      'Tracer/Span/TracerProvider port (OTel-shaped) + NoopTracerProvider + FakeTracerProvider + OtlpTracerProvider (fetch-based OTLP/HTTP JSON exporter, no @opentelemetry SDK) + getTracerProvider(env) factory, all tested. Deliberately a thin port over the EXISTING observability backbone (CF Workers Tracing [observability] zero-config OTLP + lib/log.ts traceId + Sentry + PostHog) rather than the heavy OTel SDK. Fail-soft export. Ships DARK behind OTEL_EXPORTER_OTLP_ENDPOINT → unset = NoopTracerProvider (zero overhead). Remaining: wire getTracerProvider + waitUntil(flush) into hot handlers (site-serving, workflow steps) to actually emit spans. §35.',
  },
  {
    id: 'crawl-deepcrawl',
    name: 'Crawl + discovery — homegrown, Deepcrawl deferred (§53/ADR-0053)',
    category: 'internal',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/services/import_crawler.ts',
    status: 'integrated',
    access: 'service-only',
    notes:
      'Deepcrawl DEFERRED per ADR-0053 — crawl/discovery is already Worker-native: import_crawler.ts (crawlSiteForImport → typed CrawlReport/InventoryUrl, real-UA fetch per fetch-defaults, robots/sitemap/Wayback inventory, estimateRebuildMinutes) + image discovery + CF Browser Rendering (browser-gateway, production) for JS-rendered crawl/screenshots. Our crawl need is import-scoped (crawl ONE source site to rebuild), not recurring-SEO-audit-scoped. No port built — a CrawlProvider seam over a domain-specific import fn is indirection with one caller. A managed-Deepcrawl adapter slots behind a future CrawlAuditProvider port gated on DEEPCRAWL_API_KEY only if recurring technical-SEO auditing becomes a product feature. §53.',
  },
  {
    id: 'sdk-stainless',
    name: 'Stainless SDK-codegen port over the OpenAPI 3.1 spec (§47/ADR-0047)',
    category: 'docs',
    runtime: 'library',
    ownerPackage: 'apps/project-sites/src/platform/sdk-codegen.ts',
    adapterPackage: 'apps/project-sites/src/middleware/sdk-codegen.ts',
    secretsNamespace: '/stainless',
    status: 'scaffolded',
    access: 'service-only',
    notes:
      'SdkCodegenProvider port + NoopSdkCodegenProvider (dark default) + FakeSdkCodegenProvider + StainlessSdkCodegenProvider (fetch-based POST of the spec) + getSdkCodegenProvider(env) factory, all tested. Genuinely new (no homegrown client SDK today) — feeds the EXISTING generated OpenAPI 3.1 spec (GET /api/admin/docs/openapi.json, from routes/docs.ts) to Stainless. Ships DARK behind STAINLESS_API_KEY → unset = Noop (generate() = skipped). Fail-soft. Remaining: finalize the exact Stainless REST contract + wire a gen:sdk CI step when the key is provisioned (baseUrl/endpoint are config, not code). §47.',
  },
  {
    id: 'outbound-webhooks',
    name: 'Outbound Webhooks — CF-native delivery engine (Svix-pattern)',
    domain: 'webhooks.projectsites.dev',
    category: 'webhooks',
    runtime: 'cloudflare-worker',
    ownerPackage: 'apps/project-sites/libs/features/outbound_webhooks',
    adapterPackage: 'apps/project-sites/src/services/outbound_webhooks.ts',
    featureFlag: 'outbound_webhooks',
    adminSurface: '/admin/webhooks',
    datastore: ['D1'],
    status: 'integrated',
    access: 'customer-authenticated',
    notes:
      'CF-NATIVE — NOT self-hosted Svix. A complete Svix/Stripe-style webhook delivery engine on D1/Workers: signed payloads (t=,v1= HMAC over timestamp+body, replay-safe), exponential backoff + bounded retries (6 attempts), SSRF guard (isSafeWebhookUrl), customer endpoint CRUD (/api/sites/:siteId/webhooks, flag-gated outbound_webhooks), admin UI (/admin/webhooks), D1 tables 0534/0535. A self-hosted Svix Rust container (Neon+Upstash) would be redundant infra — REJECTED per cloudflare-lock-in-is-leverage (same call as Better-Auth-on-D1). webhooks.projectsites.dev is an optional future public-ingress alias over the main worker.',
  },
  {
    id: 'crm-twenty',
    name: 'Twenty — self-hosted CRM',
    domain: 'crm.projectsites.dev',
    category: 'internal',
    runtime: 'cloudflare-container',
    ownerPackage: 'apps/project-sites/infra/twenty',
    datastore: ['Neon:Twenty', 'Upstash:twenty'],
    secretsNamespace: '/twenty',
    status: 'production',
    access: 'internal-access',
    notes:
      'LIVE (2026-06-27) — Twenty CRM (NestJS server + React) on a single CF Workers Container running server + worker in one process; data plane = Neon project "Twenty" (db neondb, schema core) + Upstash Redis. Image PINNED by digest in infra/twenty/Dockerfile (twentycrm/twenty:latest@sha256:62bd82f2… — :latest drifted ahead of the schema; the upstream entrypoint SWALLOWS migration failures → silent 500s on auth, so the pin is load-bearing). brian@megabyte.space logs in → ACTIVE "Megabyte Labs" workspace (28 objects/448 fields). Single-workspace (IS_MULTIWORKSPACE_ENABLED=false; true needs a wildcard cert). Canonical repair = clean `database:init:prod` with LOGGER_IS_BUFFER_ENABLED=false (commands buffer, never hang) — full runbook in infra/twenty/RUNBOOK.md.',
  },
] as const;

/** Vendors the convergence exclude-list (§4) forbids in new architecture. */
export const EXCLUDED_VENDORS: readonly string[] = [
  'resend',
  'postmark',
  'polar',
  'trigger.dev',
  'clay',
  'socket.dev',
  'chainguard',
  'speakeasy',
  'knock',
  'braintrust',
  'aikido',
  'dataforseo',
  'zerobounce',
  'lakera',
  'openfda',
  // NOTE: Hunter.io is on the §4 exclude list but is a LIVE env binding today
  // (HUNTER_API_KEY in src/types/env.ts for lead-engine email discovery). It is
  // intentionally NOT gated here — gating a working integration would be a
  // false positive. Migrate the lead engine off it before adding a hard rule.
] as const;

/** Look up a service by id. */
export function getService(id: string): ServiceRegistryEntry | undefined {
  return SERVICE_REGISTRY.find((s) => s.id === id);
}

/** A referential-integrity problem found in the registry. */
export interface RegistryViolation {
  readonly id: string;
  readonly problem: string;
}

const STATUSES: ReadonlySet<ServiceStatus> = new Set([
  'planned',
  'provisioned',
  'scaffolded',
  'integrated',
  'production',
  'deprecated',
  'removed',
]);

/**
 * Validate registry integrity: unique ids, valid status enum, and that any
 * entry naming an excluded vendor is marked `deprecated`/`removed` (so the
 * registry can never silently bless a forbidden dependency as live).
 *
 * @returns the list of violations (empty = clean).
 * @example validateServiceRegistry(SERVICE_REGISTRY) // → []
 */
export function validateServiceRegistry(
  entries: readonly ServiceRegistryEntry[] = SERVICE_REGISTRY,
): RegistryViolation[] {
  const out: RegistryViolation[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) out.push({ id: e.id, problem: 'duplicate id' });
    seen.add(e.id);
    if (!STATUSES.has(e.status)) out.push({ id: e.id, problem: `invalid status "${e.status}"` });
    // Scan only the load-bearing "this entry USES vendor X" fields — NOT `notes`,
    // which legitimately DISCUSSES exclusions (a notes field may name a forbidden
    // vendor purely to say it is excluded; that must not self-flag).
    const hay = `${e.name} ${e.adapterPackage ?? ''}`.toLowerCase();
    const vendor = EXCLUDED_VENDORS.find((v) => hay.includes(v));
    if (vendor && e.status !== 'deprecated' && e.status !== 'removed') {
      out.push({
        id: e.id,
        problem: `references excluded vendor "${vendor}" but status is "${e.status}" (must be deprecated/removed)`,
      });
    }
  }
  return out;
}
