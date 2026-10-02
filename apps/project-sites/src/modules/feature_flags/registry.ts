/**
 * Feature-flag registry — single source of truth for every flag key the worker
 * recognises. Each entry is the **default** state when no override exists in
 * `flag_overrides` D1. Per [[feature-flags]] every new feature ships at
 * `enabled=false, rollout_percent=0, stage='experimental'`.
 *
 * Promotion path: experimental → beta (5-25%) → stable (100%). Admin UI at
 * `/admin/feature-flags` flips state per the migration's `flag_overrides`
 * table; the registry below is the floor.
 */

export type FlagStage = 'experimental' | 'beta' | 'stable' | 'deprecated' | 'killswitch';

export interface FlagDefinition {
  key: string;
  description: string;
  default_enabled: boolean;
  default_rollout_percent: number;
  stage: FlagStage;
  owner_email: string;
}

/**
 * Every endpoint added in the 50-feature rollout has one flag here. Naming:
 * lowercase snake_case ≤32 chars. Sub-toggles handled via overrides, never
 * new keys.
 */
export const FLAG_REGISTRY: Record<string, FlagDefinition> = {
  // ── Flags referenced in frontend components but missing from registry ──
  // These were discovered by the convergence loop: the frontend checks these
  // flag keys via app-flag-gate-notice, but the keys never existed in D1.
  // ── Restored 2026-08-13: dark-launch flags for WIRED built-ahead modules that
  // commit 442e1d82 (flag prune) over-removed. All 33 have libs/features/* manifests
  // + are imported in src (index.ts). default_enabled:false → zero runtime change.
  // ── Restored 2026-08-16: 4 MORE over-pruned flags found by the orphan-gate
  // detector (scripts/check-orphan-flag-gates.mjs) — each was gated by a live
  // route/service but absent from this registry, so isFlagOn returned false
  // forever → the feature was PERMANENTLY dead + un-toggleable (masked by graceful
  // "not enabled" UI). Re-added dark (off) → zero runtime change, now toggleable.
  abandoned_build_nudge: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Abandoned-build recovery nudge (#27) — a scheduled cron that emails owners whose site build stalled/was abandoned, prompting them to resume.\n\n• Runs from the Worker scheduled() handler via services/abandoned_builds_cron.ts; dark-launched behind this flag (default-off → the cron is a no-op).\n• When on, finds builds idle past a threshold and sends one recovery nudge per build (dedup-stamped so it never re-nudges).\n• No route surface; backend cron only. Off → zero sends.',
    key: 'abandoned_build_nudge',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  build_metrics: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'North-star generation speed + cost trend card (fire-63). Gates the super-admin read endpoint GET /api/admin/build-metrics/summary — p50/p95 wall_ms + p50/p95 est_cost_usd + per-phase p50 over the last N builds, from the always-on fire-and-forget build_metrics D1 instrument (migration 0652). North star: <5min / ≤$1 per build.\n\n• Gate order: auth (401) → this flag (404, never 403) → super-admin (403). The flag runs BEFORE super-admin so an off flag is a hard 404 for everyone (existence never leaked).\n• On: an authed super-admin GETs the summary and the dashboard "Generation speed + cost" card renders.\n• Off (default, DARK): the endpoint 404s and the card self-hides. Recording keeps running harmlessly (rows accrue for when the card is enabled) — no build is ever affected.\n• Acceptance: flag off → summary 404; flag on + super-admin → 200 with the p50/p95 speed+cost rollup. Owner-only diagnostics; no per-site exposure.',
    key: 'build_metrics',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  claim_flow: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Paid-claim funnel (fire-60): $0 preview → $29/mo claim. A generated site stays viewable FREE on its subdomain; claiming is a $29/mo Stripe subscription unlocking custom domain + edits + AI ops + email.\n\n• On: POST /api/sites/:siteId/claim/checkout (libs/features/claim_flow, assertSiteOwned-guarded) creates a subscription-mode checkout for the "ProjectSites Claim" price — lookup-or-create by lookup_key projectsites_claim_29_monthly, KV-cached, test-mode-only creation; live mode falls back to inline price_data (never a hardcoded price id). The session carries metadata[site_id]+[org_id] so the EXISTING checkout.session.completed webhook marks the site claimed (sites.plan=paid) with zero new webhook code. The served unpaid top-bar swaps to the claim pitch ("This site was built for {business}. Claim it — $29/mo.") via data-claim attrs on the /app.js tag.\n• Off (default, DARK): the route 404s (never 403), zero Stripe traffic, and the generic register bar serves unchanged.\n• Acceptance: flag on → checkout 200 {checkout_url → checkout.stripe.com}; completing it flips sites.plan=paid; custom-domain + AI-ops entitlements pass via resolveActiveOrgPlan (active OR trialing).',
    key: 'claim_flow',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  pricing_engine: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Cost-metering + pricing engine (PRICING-MODEL.md Wave 1). Gates GET /api/sites/:id/cost + GET /api/apps/instances/:id/cost — owner-scoped read-only rollups pricing each site/instance CF resource (Worker requests+CPU, D1 rows+storage, R2 ops+storage incl. sites/ snapshots) at published unit prices + the flat $50/site platform fee. Server-resolves resources from site_database_allocations / app_instances (never client-supplied). Off (default, DARK) then both endpoints 404 (never 403). Wave 2 adds the Super-admin pricing_config table + live wiring.',
    key: 'pricing_engine',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  pricing_config_v2: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Pricing-engine-v2 (PRICING-MODEL.md Wave 2, fire-86). Sources the cost-metering unit prices + the flat per-site platform fee from the super-admin-editable pricing_config D1 table (migration 0655) instead of the hardcoded DEFAULT_UNIT_PRICES + PLATFORM_FEE_USD constants in src/services/site_cost.ts.\n\n• When ON, services/site_cost.ts loads the 9 seeded rows from pricing_config (Zod-validated row shape) and prices every usage line + the $50 platform fee from them; the seed matches the current hardcoded values EXACTLY, so turning the flag on is behavior-identical until a super-admin edits a rate. A missing/invalid row falls back to the hardcoded constant for that key.\n• When OFF (default, DARK) site_cost.ts uses the existing hardcoded constants UNCHANGED — zero DB read, zero behavior change. Backend-only wiring; no route or UI surface in this slice (the super-admin editor UI is a later slice). Owner: pricing engine.\n• Acceptance: flag off → computeSiteCost uses hardcoded unit prices + $50 fee; flag on → the same values are read from pricing_config; editing a pricing_config row + flag on changes the computed cost.',
    key: 'pricing_config_v2',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  approval_workflow: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Client preview + approval share-links — stakeholders review a site and approve/reject via a password-protected shared link (agency sign-off flow).\n\n• GET/POST /api/sites/:siteId/review-links create + list shareable preview links (routes/review_links.ts); public /review/:id page (ReviewComponent) lets a reviewer approve/reject (routes/review_public.ts).\n• Frontend app-share-link-dialog is the "Share link" modal; it shows a flag-gate notice ("Turn on approval_workflow") when off.\n• Off → all review-link routes 404 and the dialog stays gated.',
    key: 'approval_workflow',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  validator_strict: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-org strict build-validation canary — when ON for an org, VALIDATOR_MODE=strict for that org's site builds regardless of the global env, so a validator error FAILS the build (the site stays `error`). DARK — run the false-positive audit before flipping any org.\n\n• Read in the site-generation workflow's validate-build step (workflows/site-generation.ts): the effective mode = isFlagOn(env,'validator_strict',{orgId}) ? 'strict' : resolveValidatorMode(env.VALIDATOR_MODE), then assertBuildStrict(report, mode) AFTER the D1 audit log. The org-flag can only ESCALATE report→strict for the canary org; it never relaxes a globally-strict env.\n• Backend-only; no route surface. Highest false-positive risk on png_too_large + h1_count (dynamic-hydration shells) — audit ~10 known-good published builds before enabling any org.\n• Off (default) → the global report-mode default; zero change, no build ever fails on a validator violation.",
    key: 'validator_strict',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  voice_numbers: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'KILLSWITCH for the Twilio phone-number PURCHASE — the one voice endpoint that spends REAL carrier money. Gates POST /api/voice/numbers/purchase (routes/voice.ts), which buys a live phone number from Twilio and records it in voice_numbers. UN-gated, an orphan / no-payment / accidental buy fires a real carrier charge with no way to stop it without a redeploy — this flag is that stop.\n\n• Off (default, DARK) → the purchase route 404s (never 403 — do not leak existence) and, critically, NO Twilio purchase fires (fail-safe: off = no money spent). The gate runs FIRST, before auth/Twilio-config/DB, so an off flag is a hard 404 for everyone.\n• On → the handler proceeds to its normal path: auth → org-membership of the site → the 3-numbers-per-site cap → Twilio purchase → voice_numbers row → audit log.\n• Reversible instant killswitch: flip off in /admin/feature-flags to halt ALL carrier purchases with no redeploy. Only the purchase leg is gated; listing / releasing / test-SMS / call-token are unaffected.\n• Acceptance: with the flag off, POST /api/voice/numbers/purchase returns 404 and twilio.purchaseNumber is never called; with it on, an authed owner of the target site can buy a number under the 3-per-site cap.',
    key: 'voice_numbers',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  voice_receptionist: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "AI voice receptionist — a per-site AI persona that ANSWERS inbound phone calls, greets the caller in the site's own voice, converses in real time, and routes/handles the call, with the recording + transcript landing in the admin Conversations surface (ADR-0056: Twilio number → Cloudflare-native voice runtime, superseding the LiveKit transport).\n\n• Gates the per-site receptionist surface: the owner-facing config (greeting script, persona/tone, routing/hours) plus the runtime dispatch that answers a call for a site whose flag is ON. When ON, an authed owner of the site sees the receptionist config in the admin and calls to that site's provisioned number are answered by the AI persona; the signed voice-lifecycle webhook persists the recording/transcript to D1.\n• Surfaces touched: the admin receptionist config UI + Conversations, the site's Twilio number → CF-native voice runtime, the signed voice-lifecycle webhook receiver, and the voice tables (0036b_voice.sql). Distinct from voice_numbers (the carrier-purchase killswitch) — this flag gates the RECEPTIONIST behavior, not the number buy.\n• Failure mode when OFF (default, DARK): the feature is dark — the receptionist config routes 404 (never 403, to avoid leaking existence) and the UI renders null; no call is auto-answered by an AI persona and the runtime never dispatches. Off = zero receptionist activity, no regression to number listing/release/test-SMS.\n• Acceptance: with the flag OFF, the receptionist config route 404s and no inbound call is AI-answered; with it ON, an authed owner configures the greeting/persona and a call to that site's number is answered by the persona with the transcript reaching Conversations.",
    key: 'voice_receptionist',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  cinematic_scroll_reveals: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Cinematic scroll-driven section reveals on the marketing homepage — native CSS `animation-timeline: view()` reveals (off the main thread, so they never cost INP) that layer over the JS IntersectionObserver reveal with a smoother, more premium scroll cinematic (the Framer / Awwwards 2026 technique for AI + cinematic web brands).\n\n• CLIENT-ONLY flag (no worker route gate): homepage.component reads it via FeatureFlagService.isOn() and toggles a `.cinematic-scroll` host class; homepage.component.scss enables the native reveal under `@supports (animation-timeline: view())` + `prefers-reduced-motion: no-preference`.\n• Triple-gated progressive enhancement — flag-off / unsupported browser (Firefox) / reduced-motion each fall back to the always-present JS `appReveal` baseline, so it can only ADD polish, never break a reveal or hide content.\n• Off (default) → the homepage renders exactly as today (JS reveal). Fail-safe: a flag/transport error resolves false. No backend surface; marketing-visual only. Acceptance: with the flag on in a scroll-timeline browser, homepage `.reveal` sections carry a computed `animation-timeline: view()` and animate on scroll; reduced-motion shows final state immediately.',
    key: 'cinematic_scroll_reveals',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  github_repo_sync: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'GitHub repo sync + git-backed site rollback — mirrors a generated site to a GitHub repo and enables version rollback from commit history.\n\n• Gates a site-generation step (workflows/site-generation.ts) + services/site_create.ts that push the built site to GitHub, and GET/POST rollback in routes/site_rollback.ts.\n• Off → the generation push step is skipped and the rollback routes 404.\n• Backend + admin snapshots/rollback surface; requires GitHub credentials when enabled.',
    key: 'github_repo_sync',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  data_resource_platform: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Authoritative Resource Registry (Data & Resource Platform §1 — docs/data-resource-platform/DESIGN.md). The server-side SSOT for every Cloudflare resource a site touches: each resource is a ROW the platform owns and resolves server-side from the authed { site_id, environment }.\n\n• libs/features/data_resource_registry: Zod schemas for the registry model + the distinct concepts (ResourceKind, ResourceConcept, preview|production environment, ResourceRecord/BindingRecord), a service (record/list/get + resolveResourceRef), and the typed CF adapter interface. Backed by the site_resource_registry table + additive site_database_allocations columns (migration 0643).\n• The isolation keystone resolveResourceRef maps { kind, environment } → the real CF id from a row the caller OWNS (reuses assertSiteOwned + the FORBIDDEN_DB_IDS denylist); the client NEVER names a CF id. A ref for a foreign site/env is rejected; a resolved shared-platform id fails closed.\n• Off (default, DARK) → gates the future overview/registry surface + parity MCP tools; this fire wires no routes, so nothing 404s yet. Server guard returns 404 (never 403) when off once routes land.',
    key: 'data_resource_platform',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_data: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Per-site data-resource provisioning (Data Platform re-arch, Phase 0c — docs/data-platform-scope.md).\n\n• On site-create (services/site_create.ts) provisions a DEDICATED Cloudflare D1 + KV namespace + R2 bucket for the site IN PARALLEL (Promise.all), each recorded in site_database_allocations. Uses the server-side global key (resolveCfCredentials) + env.CF_ACCOUNT_ID; each provisioner is idempotent (reuses an existing allocation — never a duplicate on retry) + fails soft (never blocks site creation).\n• Off (default, DARK) → no per-site resources are created; sites stay on the shared platform D1/KV/R2. On → new sites get their own resources.\n• Backend-only wiring; the spreadsheet Data UI over per-site resources is later phases.',
    key: 'per_site_data',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  eager_site_d1: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Eager per-site D1 warm-up on site-create (Data Platform, fire-72). The NARROW D1-only sibling of per_site_data: when ON (and per_site_data is OFF), site-create (services/site_create.ts) eagerly calls the SAME idempotent provisionSiteD1 the lazy Data-tab path uses, so a site's FIRST Tables read never pays the cold D1 create + query-plane propagation wait.\n\n• Provisions ONLY the per-site D1 (recorded in site_database_allocations) — NOT KV/R2 (that is per_site_data's broad job). When BOTH flags are on, per_site_data's block wins and this one is skipped, so D1 is provisioned EXACTLY ONCE per create (never double).\n• Fail-soft: a CF/provisioning hiccup NEVER blocks site creation — it falls back to the existing lazy provision on first Data-tab access (provisionSiteD1 is idempotent, so the retry converges on one DB). Runs under ctx.waitUntil, so it never adds latency to the create response.\n• Off (default, DARK) → no eager provisioning; D1 is created lazily on first Data-tab GET exactly as today. Backend-only wiring; no route surface, no UI. Owner: site-create pipeline.\n• Acceptance: flag on + create a site → site_database_allocations gains a d1_tenant_db row for it before any Data-tab access; flag off → no allocation until the first /api/sites/:id/db/tables GET.",
    key: 'eager_site_d1',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  research_cache: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Per-business research cache (#19c margin lever) — when on, rebuilding the same business skips all 5 research LLM calls (~15→5 min build + lower model spend).\n\n• services/openai_research.ts checks isFlagOn(env, "research_cache"); on → reads/writes a KV cache keyed by stable identity (placeId → name+address), 30-day TTL, v1 namespace for prompt-quality invalidation.\n• Off (default) → every rebuild pays full research cost. Enabling is a pure cost/latency win with bounded staleness.\n• Backend-only; no route surface.',
    key: 'research_cache',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  r2_buckets: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Per-site R2 bucket manager — the editor Resources → Buckets tab. Owners manage their site's OWN Cloudflare R2 buckets (the R2 analog of the per-site D1 Tables surface).\n\n• Worker: libs/features/r2_buckets/handlers.ts serves GET/POST /api/sites/:siteId/r2/buckets, DELETE /:bucket, GET /:bucket/address, POST /:bucket/{public,promote}, and list/upload/download/delete under /:bucket/objects[/*]. Bucket CRUD via the CF R2 REST API (server global key + CF_ACCOUNT_ID); object ops via the R2 S3 API (SigV4) when R2_S3_ACCESS_KEY_ID + R2_S3_SECRET_ACCESS_KEY are set, else an actionable 503 needs-creds message.\n• Isolation is server-resolved: real bucket names are site-prefixed (ps-site-{siteId}-{name}) + recorded in site_r2_allocations; ownsSiteData IDOR-guards every route; the shared SITES_BUCKET names are denylisted (FORBIDDEN_BUCKET_NAMES). A client never names a raw bucket.\n• Off (default, DARK) → every route 404s (never 403 / leak) + the FE hides the tab → zero real R2 resources are created. On → sites can create/browse their own buckets + objects.",
    key: 'r2_buckets',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  r2_bucket_manager: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'R2 Bucket Manager — the AUTHORITATIVE, site-scoped catalog + view over ALL of a site\'s R2 surfaces in the editor Resources tab. The layer ON TOP of the per-site custom-bucket plane (r2_buckets flag / site_r2_allocations); it does NOT replace it — it reconciles them into ONE list.\n\n• Worker service: src/services/site_r2_manager.ts — resolveSiteBuckets(env, siteId, orgId) is authoritative + site-scoped (assertSiteOwned-gated, cursor-paginated, structural WHERE site_id=?) and ALWAYS surfaces the protected isogit "Project code · Preview" system bucket as a distinct is_system entry (surfaced, NEVER mutable). assertBucketMutable() HARD-THROWS on config/reset/empty/delete of the system bucket (SERVICE layer, not UI); assertBucketOwnedBySite() HARD-THROWS on a cross-site bucket. Catalog table site_r2_buckets (migration 0647) models a per-bucket credential REFERENCE (via ai_crypto — never the secret) + provisioning state.\n• Slice 1 ships the domain + service foundation + system-bucket protection; create/reset/delete/object-explorer/Code-panel-selector land in later slices. Reuses assertSiteOwned + FORBIDDEN_BUCKET_NAMES + the site_r2 CF-REST/S3 plane.\n• Off (default, DARK) → every route 404s (never 403 / leak) + the FE hides the Manager → zero real R2 resources are created and the already-live r2_buckets surface is unaffected. On → the site sees its authoritative bucket list with the system bucket protected.',
    key: 'r2_bucket_manager',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  site_wfp_hosting: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      'WfP site hosting — every new generated site born on a Cloudflare Workers-for-Platforms dispatch namespace (a PREVIEW slot site-<id>-preview + a PRODUCTION slot site-<id>), so the dispatched per-site Worker becomes the serve substrate instead of the R2-static-direct path (docs/wfp-site-hosting.md).\n\n• ADDITIVE + fail-soft: the serving change is a NEW branch in site_serving.ts — flag ON + a WfP prod script present → dispatchToUserWorker(); ELSE the byte-identical current R2 path. Any WfP miss/error falls back to R2, so a bad dispatch never dark-serves.\n• Reuses the shared namespace project-sites-endpoints (USER_DISPATCH) + wfp_dispatch.ts + the assets-upload-session recipe (the per-site Worker carries its OWN static assets via Workers Static Assets so /assets/* + hashed chunks 200 through dispatch, never a naive 404). The site_resource_registry (migration 0643) records each slot row (wfp_namespace concept, preview|production environment, userWorkerScript, deployedVersion).\n• DEFAULT (beta, on, 100%) — WfP is now the DEFAULT serve POLICY (proven end-to-end fire-50, promoted 2026-09-29). A site WITH a live WfP prod slot serves via dispatch; a site WITHOUT a recorded slot (every existing site until the backfill migration) STILL falls soft to the byte-identical serveSiteFromR2 path, so the immediate blast radius is ~zero. Turning the flag OFF (killswitch) reverts every site to R2 with no redeploy.\n• On → new sites deploy a preview slot after build + a production slot on publish; delete tears both slots + the registry rows down. Backfilling slots for pre-existing sites is a SEPARATE batched migration.',
    key: 'site_wfp_hosting',
    owner_email: 'brian@megabyte.space',
    stage: 'beta',
  },
  abuse_takedown: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Abuse-report intake and content-takedown workflow for published sites (DMCA / illegal-content).\n\n• POST /api/abuse/report is public + rate-limited (20/min); body {site, category, reason, ...} → 202 {id}, 404 if site unknown.\n• GET /api/abuse/reports (super-admin) is the review queue; POST /api/abuse/reports/:id/resolve actions dismiss|takedown.\n• takedown archives the site (sites.status='archived'). Table abuse_reports (migration 0536).\n• Handler abuseTakedown in libs/features/abuse_takedown.",
    key: 'abuse_takedown',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  activity_feed: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Org-scoped event timeline plus several dashboard read-widgets, all gated by this one flag.\n\n• GET /api/activity returns newest-first entries (kind, summary, actorName, timestamp) with cursor pagination from audit_logs.\n• Frontend app-recent-activity renders in the admin dashboard, self-hiding on 404/empty (testid recent-activity).\n• Same flag also gates /api/usage, /api/mru, /api/notifications/badge, /api/sites/:id/annotations (over-broad — 5 surfaces).\n• Server 404s when off.',
    key: 'activity_feed',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  ai_api_keys: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'AI API keys — durable GrantRecords attached to psk_ API tokens (campaign lane-3, CAMPAIGN-cf-native-ai §5): the storage + request surface the Settings "AI API Keys" UI and the /v1 OpenAI/Anthropic-compat executor consume.\n\n• POST /api/v1-tokens accepts an optional `grant` body — a mint-time snapshot of CONCRETE ids (sites/connections/actions/models + limits/approval policy/expiry) validated by the SHARED ai-policy GrantInputSchema and persisted to ai_api_key_grants (migration 0649, one row per token, revision-tracked for effectiveAllow\'s live_state leg). GET list responses attach counts-only grant summaries.\n• Who sees it: org admins on Settings → API Tokens minting AI-scoped keys; later slices add the UI selector + the /v1 executor that authorizes via effectiveAllow.\n• Failure mode when off (default, DARK): a create request carrying `grant` is rejected VALIDATION_ERROR ("not available") and NO token is minted; the no-grant token flow is unchanged byte-for-byte, so existing tokens never silently gain AI/publish/integration access (grants only ever NARROW).\n• Acceptance: flag on → create-with-grant persists a revision-1 GrantRecord + returns the summary; off → grant requests reject and plain tokens still mint.',
    key: 'ai_api_keys',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── 10 experimental features — site-as-MCP, cold-tier, ghost-routes, speed-compare, auto-gen-files, hallucination-guard, visitor-recognition, faq-from-tickets, competitor-monitor
  ai_gateway_guardrails: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Llama Guard content-safety check for AI input/output, with a no-redeploy killswitch.\n\n• POST /api/guardrails/check runs @cf/meta/llama-guard-3-8b to block prompt-injection/hateful/off-brand content; blocks are logged.\n• When off the guard is bypassed (killswitch state) and requests pass to the model directly.\n• Handler aiGatewayGuardrails in libs/features/ai_gateway_guardrails; per rules/ai-agent-security.\n• Backend-only endpoint — no admin UI surface.',
    key: 'ai_gateway_guardrails',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  app_launcher: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Account-level app catalog and launch planner over the companion-app catalog (Twenty, Listmonk, Chatwoot, Payload, and more); planner only, hands a provisioning plan to the operator.\n\n• Worker routes GET /api/apps/catalog (lists apps) and POST /api/apps/launch (returns a structured launch plan), both gated by isFlagOn('app_launcher') at src/index.ts.\n• The /admin/apps section renders the catalog with search, lifecycle filters, and category menu.\n• Off → both /api/apps/* routes 404 (no existence leak).\n• Off-vision relative to the core site builder — it is the Apps expansion surface.",
    key: 'app_launcher',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  audit_trail_export: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Org-scoped, read-only export of the append-only audit trail for compliance reviews.\n\n• GET /api/audit/export filters by action + date range, downloads as JSON or CSV (format=csv → attachment).\n• Read-only over audit_logs, scoped to caller's org_id (no cross-tenant rows); 404s when off.\n• Handler auditTrailExport in libs/features/audit_trail_export, mounted at /api/audit/export.\n• Backend-only: no dedicated export UI yet (audit.component covers the in-app log view).",
    key: 'audit_trail_export',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  batch_operations: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Bulk site-action processor with per-site ownership validation, gating three related endpoints.\n\n• POST /api/batch takes {siteIds[], action} (1-50; rebuild/snapshot/delete), returns per-site ok/fail + total/ok/failed summary.\n• rebuild/snapshot queue workflow_jobs; delete soft-deletes; unowned site → not_found_or_not_owned.\n• Same flag also gates POST /api/sites/compare and /api/sites/clone (over-broad — 3 features).\n• Backend-only: /admin/bulk-ops section was deleted.',
    key: 'batch_operations',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  better_auth: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Cutover flag for the embedded Better Auth rebuild (auth/better-auth.ts). ON = Better Auth owns /api/auth/*; OFF (default) = legacy magic-link/Google/D1-session auth.\n\n• ON routes /api/auth/* through Better Auth (email+password, magic link, Google social, TOTP 2FA) with its own singular user/session/account/verification D1 tables.\n• Checked via isFlagOnBetterAuth in index.ts (route gate) and isFlagOn in middleware/auth.ts (session resolution).\n• MUST stay OFF in production until the sign-in UI + user-migration backfill land — flipping early routes live sign-in at an unmigrated system.\n• Backend cutover flag: no dedicated admin UI (auth-security section manages sessions, not this flag).',
    key: 'better_auth',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  cmdk_ai_actions: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Cmd+K natural-language actions — the single flag for both palette action surfaces (folded in the retired cmd_k_actions duplicate 2026-08-14).\n\n• POST /api/cmdk ranks org sites against 6 admin verbs (rebuild/snapshot/delete/view/edit/publish), returns up to 20 scored suggestions; short queries return default nav.\n• POST /api/cmdk/resolve maps a typed phrase to a structured nav/bulk-mutation/agent action via Workers AI (Zod-validated + JSON fallback).\n• Off (default) → both routes 404 and Cmd+K stays a plain client-side navigation palette.',
    key: 'cmdk_ai_actions',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },

  // ── Feature modules ──
  // Commerce & money rail (payments_rail is foundational — unblocks the rest)

  // Visitor-facing AI + platform AI UX

  core_admin_detail: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Always-on sentinel for the admin site-detail split view: left rail sections nav, right pane the selected section (Logs / Snapshots+Rollback / SQL / Integrations). isFlagOn always true.\n\n• Route: /admin/sites/:id (site-detail.component) with 4 tabs; siteId read from ActivatedRoute.\n• The persistent bolt.diy iframe lives in the admin shell so WebContainer cold-boot happens once per session.\n• Section navigation is SPA (routerLink) — no full reload.\n• Sibling per-site routes: /admin/sites/:id/branches, /admin/sites/:id/mcp-server.\n• Core sentinel — the admin detail plane can't be flagged off.",
    key: 'core_admin_detail',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  // ── Sentinel keys for always-on core surfaces.  isFlagOn always returns true for these.
  //    One key per core surface so duplicate-flagKey check passes in the manifest validator.
  core_auth: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Always-on sentinel for the auth surface: passwordless magic-link (Amazon SES/SendGrid) + Google OAuth + D1 session cookies. isFlagOn always returns true.\n\n• Sessions resolve userId/orgId in auth middleware without rejecting unauthed requests — route guards decide access.\n• Magic links single-use, 15-min TTL; OAuth uses PKCE state in oauth_states.\n• Surface: /signin (Better Auth sign-in UI) + POST /api/auth/magic-link + GET /api/auth/me.\n• Protected 401s bounce to /signin?returnUrl=… via ApiService.\n• Core sentinel — the auth plane can't be flagged off.",
    key: 'core_auth',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  core_billing: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Always-on sentinel for the Stripe billing surface: checkout, subscriptions, entitlements, billing portal and donation payouts. isFlagOn always true.\n\n• Worker: POST /api/billing/checkout returns a Stripe Checkout session URL; GET /api/billing/entitlements returns the plan entitlement set; POST /api/billing/portal opens the billing portal.\n• Webhook-first: POST /webhooks/stripe verifies signature + idempotency; duplicate events ignored.\n• Entitlements gate the per-site Features plane.\n• Admin surface: /admin/billing (billing.component).\n• Core sentinel — the billing plane can't be flagged off.",
    key: 'core_billing',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  core_feature_flags: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Always-on sentinel for the feature-flags admin UI at /admin/feature-flags. isFlagOn always true — the control plane can't be flagged off.\n\n• Lists every registry flag with default state + stage; search + stage-filter pills.\n• Per-flag detail shows resolved state + docs (checklist/explanation/smoke_test/e2e_tests).\n• Override mutations global / org / tenant via POST /api/admin/feature-flags/:key/override; KV cache invalidates immediately.\n• GET /api/feature-flags returns the full registry with has_docs; GET /api/feature-flags/:key returns detail.\n• sysAdminGuard hides it from site owners (operator-only); non-operators bounce to /admin/site-features.",
    key: 'core_feature_flags',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  core_site_create: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Always-on sentinel for the homepage site-creation funnel: search business → select → sign in → provide details/upload → AI build workflow starts. isFlagOn always true.\n\n• Homepage SPA (public/index.html) 4-screen state machine: search → signin → details → waiting.\n• POST /api/sites/create-from-search seeds a site row (status=draft) + starts SITE_WORKFLOW (workflow_jobs row).\n• Search calls /api/search/businesses + /api/sites/search in parallel; 300ms debounce, min 2 chars.\n• Drives the golden path; redirect to /waiting shows real-time build progress.\n• Core sentinel — the create funnel can't be flagged off.",
    key: 'core_site_create',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },

  credit_wallet_rollover: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'AI-credit wallet with monthly rollover, stacking promo grants, and expiring-balance urgency, computed over the credits ledger.\n\n• Handlers mounted in index.ts; isFlagOn-gated — off returns 404.\n• GET /api/credits/balance returns current, rolled-over, promo, expiring buckets; POST /api/credits/apply spends.\n• Admin billing renders <app-credits-widget>, which self-hides on 404. referral_loop grants rewards into this wallet.',
    key: 'credit_wallet_rollover',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── Marketplace + Creator Economy (ideas #39/#40/#41/#42 — 2026-05-28)
  // ── Viral + Billing + Audit-Chain (ideas #33, #34, #36, #46 — 2026-05-28)
  // ── Enterprise wave (Trust Center / Enterprise Plan / Stripe App status / Agent SDK+MCP, 2026-05-28)
  // ── Compliance / safety / revenue (added 2026-06-07 per UNFINISHED_FEATURES §9b)
  // ── Idea-merge wave 2026-06-08: genuinely-new platform flags (the rest of the
  //    30 ideas fold into existing flag scopes as extra checklist checkpoints).
  editor_vision_qa: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Real-time in-editor AI vision critique: screenshots the current editor preview via Cloudflare Browser Rendering, scores layout / contrast / brand 0-10 with a vision model, and returns inline fix suggestions per finding.\n\n• Worker route POST /api/vision-qa gated by isFlagOn('editor_vision_qa') (routes/vision_qa.ts).\n• Response carries {score, findings[]} with each finding categorized (layout/contrast/brand) plus a suggested fix.\n• Distinct from the post-build async snapshot-quality workflow.\n• Backend-only — no dedicated admin section; off (default) → the endpoint 404s.",
    key: 'editor_vision_qa',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── Round-2 top-5 admin upgrades
  // ── 30 advanced features
  // ── IDE + multi-agent + progressive build (3 new flags)
  // ── Content Freshness + pSEO (items #16 + #17) — flag registry restoration after content-pseo agent shipped the impl without registering the flag (caught by validate-feature-manifests 2026-05-28)
  // ── IDEAS-50 wave 3: GEO + reputation + growth (3 + 9 + 10/11/13 + 18 + 32 + 34)
  // ── #29 pSEO v2 (post-March-2026), #30 Integration Directory, #31 Comparison Pages, #32 Vertical Templates, #35 Public Changelog
  // ── Domain & Logs (items #10 + #14)
  // ── #24 Unified Visitor Inbox + #25 Multimodal Site Copilot
  // ── #5+#6+#7+#8 Swarm editor + live stream + Site DNA + section marketplace
  // ── Native editor enforcement (rec #3 from 2026-05-28 close-the-loop) — was localStorage-only; now real server-side flag so killswitch works without redeploy
  // ── AI wave (ideas #1/#23/#24, 2026-05-28)
  email_deliverability_wizard: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Read-only Email Deliverability Wizard: checks a sending domain's SPF, DKIM and DMARC over DNS-over-HTTPS and returns a 0-100 score plus concrete copy-paste DNS fixes. Persists nothing.\n\n• Worker route GET /api/sites/:siteId/deliverability gated by isFlagOn('email_deliverability_wizard') (404 when off).\n• The /admin/deliverability section renders the domain-check form and score UI.\n• When the flag is off the section shows a calm cyan flag-gate notice instead of a red error.\n• e2e/admin/deliverability.spec.ts covers it (green live).",
    key: 'email_deliverability_wizard',
    owner_email: 'brian@megabyte.space',
    stage: 'beta', // beta 2026-07-31: e2e verified — e2e/admin/deliverability.spec.ts (green live),
  },
  // Generation/editing + growth + Cloudflare quick wins
  lead_scanner: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Super-Admin lead scanner: a Google Places text-search query is scored, the no-website businesses are kept and persisted as claim-able leads.\n\n• POST /api/admin/leads/scan runs the scan and returns a summary (scanned / created / skippedHasWebsite / skippedDuplicate / errors); 404s when off (default off), 403 for non-operators.\n• De-dupes by place_id within a batch and via a unique index across batches.\n• Read-and-create only — never auto-sends outreach (send is a separate explicit step).\n• Surfaces at /admin/leads (scan-query input, only-no-website toggle, OSM metro form).',
    key: 'lead_scanner',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  lead_enrichment_paid: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Paid contact-enrichment tier for the Super-Admin Lead Scanner. When ON, POST /api/admin/leads/:id/enrich may call the configured paid provider (LEAD_ENRICHMENT_API_URL + LEAD_ENRICHMENT_API_KEY) to fill website / phone / email / socials for a lead.\n\n• Default OFF → the enrich endpoint runs FREE discovery only (OSM contact tags captured at scan + a best-effort homepage/DuckDuckGo parse); it never calls the paid provider and never errors.\n• ON + both secrets set → the paid provider result is merged (highest priority) into the free bundle.\n• Operator-only: the enrich endpoint is gated by lead_scanner + super-admin; this flag only unlocks the paid spend.\n• Reversible: turn OFF to instantly stop all paid lookups (no redeploy).',
    key: 'lead_enrichment_paid',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  live_build_stream: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "STREAMING BUILD THEATER — pipes the REAL Claude Code build container stdout to the /waiting page's live terminal so the owner watches the AI actually build their site.\n\n• Gates POST /api/internal/build-log (HMAC-signed, x-build-sig + INTERNAL_BUILD_SECRET): the build container streams throttled, bounded, secret-redacted stdout batches; the worker drops Claude Code control-plane + provider-transport NOISE (build_log.ts isBuildLogNoise), writes each real line to audit_logs (action claude.output), and the /waiting terminal renders them via the existing getSiteLogs poll + toBuildLogLine (redacted, noise-filtered, auto-scroll, coloring + heartbeat).\n• Fail-CLOSED: any flag error → the ingest 404s, so a half-wired container can never flood audit_logs. OFF → the container POSTs harmlessly 404 and /waiting shows only the phase-step lines (no regression).\n• Pipe PROVEN end-to-end via ground truth (audit_logs claude.output rows written from live builds through the HMAC ingest); noise-filter added 2026-09-16 after a dead build-LLM balance (402) showed 42/43 streamed lines were control-plane errors. RICH claude-narration theater is gated on the build LLM actually running (DeepSeek balance / BUILD_LLM_PROVIDER).",
    key: 'live_build_stream',
    owner_email: 'brian@megabyte.space',
    stage: 'beta',
  },
  marketing_dashboard: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      'Owner-facing marketing dashboard: widget config + computed metrics aggregated across six sources (website, email, social, ads, CRM, booking).\n\n• GET /api/sites/:siteId/dashboard returns 11 default widgets; 404s when the flag is off (default off).\n• POST /api/sites/:siteId/dashboard/metric computes a metric (label/current/previous/source) with change + trend detection.\n• ?sources=website,email query filters the returned widget set by source.\n• Backend/API-only: no admin section consumes these endpoints yet (the /admin dashboard is the separate AI section-guide).',
    key: 'marketing_dashboard',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── Restored 2026-08-13: dark-launch flags for WIRED built-ahead modules that
  // commit 442e1d82 (flag prune) over-removed. All 1 have libs/features/* manifests
  // + are imported in src (index.ts). default_enabled:false → zero runtime change.
  mcp_server: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Gates the platform Model Context Protocol server so Claude / Cursor / Windsurf users can drive their projectsites account over MCP.\n\n• Worker: libs/features/platform_mcp/handlers.ts (FLAG_KEY='mcp_server') gates GET+POST /api/mcp (JSON-RPC) — 404s when off.\n• Exposes 5 tools: list_sites, create_site, deploy_site, get_site_metrics, regenerate_section.\n• Public discovery at /.well-known/mcp (served ungated in features.ts) + OAuth 2.1 / RFC 8707 resource indicators at /.well-known/oauth-protected-resource.\n• Stage=stable, default_enabled=true / rollout=100.\n• e2e: e2e/mcp/mcp-providers.spec.ts.",
    key: 'mcp_server',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  model_registry: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "OpenAI-compatible GET /v1/models + /v1/models/:id catalog plus the workload-aware AI model router, all gated by this one flag (the standalone ai_auto_router duplicate was folded in 2026-08-14; beta 2026-09-29 for campaign lane-4 §7).\n\n• GET /v1/models (Bearer psk_ API token; 401 OpenAI error envelope otherwise) returns {object:'list', data:[...]} — the 4 virtual service models (projectsites-auto/fast/balanced/premium, always available) plus the 13 deepseek/anthropic/openai/gemini/grok/workers-ai aliases; an alias is _available only when a provider key is set. GET /v1/models/:id looks one up (OpenAI-shaped model_not_found 404 for unknown ids).\n• POST /api/router/pick (authed org; Zod-validated body) classifies a prompt and routes to the cheapest sufficient model; GET /api/router/stats reports savings vs an always-Opus baseline.\n• Backend catalog + router the AI stack reads; no admin UI. Off → all four routes 404 dark.\n• Acceptance: e2e/ai-api/openai-compat.e2e.ts; units libs/features/model_registry/__tests__/.",
    key: 'model_registry',
    owner_email: 'brian@megabyte.space',
    stage: 'beta', // beta 2026-09-29: /v1/models contract green (42 units), reversible via killswitch
  },
  onboarding_copilot: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Product-led-growth activation checklist computing a new org's next-best actions with per-step completion state and a dismiss control.\n\n• Handler mounted at /api/onboarding in index.ts; isFlagOn-gated — off returns 404.\n• GET /api/onboarding/checklist returns {steps:[{id, done, cta_href}], dismissed}; POST /api/onboarding/dismiss hides it.\n• Admin dashboard renders <app-onboarding-checklist>, self-hiding on 404. Read-only over org state.",
    key: 'onboarding_copilot',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  outbound_webhooks: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Outbound webhooks: customers subscribe their own https endpoints to site events; deliveries are HMAC-signed, replay-safe, and retried with backoff, with the endpoint secret AES-GCM encrypted at rest.\n\n• Worker CRUD at /api/sites/:siteId/webhooks (GET/POST/DELETE) plus GET /api/sites/:siteId/webhooks/deliveries, each behind isFlagOn('outbound_webhooks') (404 when off).\n• The Webhooks surface renders as a tab under /admin/settings#webhooks (top-level /admin/webhooks redirects there).\n• Flag off → the tab shows a calm cyan flag-gate notice.\n• e2e/webhook/webhooks.spec.ts covers it (7/7).",
    key: 'outbound_webhooks',
    owner_email: 'brian@megabyte.space',
    stage: 'beta', // beta 2026-07-31: e2e verified — e2e/webhook/webhooks.spec.ts (7/7 live),
  },
  payments_rail: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Unified payments seam routing accept-money through Square and SaaS billing/payouts through Stripe behind one idempotency key.\n\n• Handlers mounted in index.ts; isFlagOn-gated — off returns 404.\n• POST /api/payments/intent returns a provider-routed intent + idempotency key; replay returns the same intent (no double-charge). GET /api/payments/methods lists methods.\n• Features call the rail, not a provider directly. Backend-only; no admin UI.',
    key: 'payments_rail',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  predicted_actions: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Command palette (Cmd+K) "Predicted" group — surfaces the 3-4 actions a user is most likely to want next, ranked by their own recent command-execution frequency (a local-storage tally bumped on every execute), with the current route excluded so it never suggests where you already are.\n\n• CLIENT-ONLY flag (no worker route gate): command-palette.component reads it via FeatureFlagService.isOn() and only renders the Predicted group when on.\n• The palette default alphabetical command list is always present, so flag-off (or any transport error → fail-safe false) simply hides the extra group with zero functional loss.\n• Registering it here makes GET /api/feature-flags/predicted_actions resolve 200-with-false (registry source) instead of 404 — clearing a console error on every homepage load.\n• Off (default) → the palette renders exactly as today (no Predicted group). Acceptance: flag-on + a few executes + reopen Cmd+K → a usage-ranked Predicted group; flag-off → no Predicted group, palette still opens/filters/navigates/closes.',
    key: 'predicted_actions',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  preview_share_card: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Owner-driven viral loop handing the owner pre-written share copy, one-tap deep-links, and OG-card params after a build.\n\n• Handler mounted in index.ts; isFlagOn-gated — off 404, unauth 401, non-owned siteId 404.\n• GET /api/sites/:siteId/share-card returns {messages, links:{sms,whatsapp,email,x,facebook,copy}, og}; links.copy is the site URL.\n• Pure XSS-safe builder over slug + business name. No admin UI yet.',
    key: 'preview_share_card',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  prompt_studio: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Admin surface over the existing prompt registry: versioned templates with A/B variants, KV hot-patch, and one-click rollback.\n\n• Handlers mounted in index.ts; isFlagOn-gated — off 404, unauth 401.\n• GET /api/prompt-studio/templates lists versioned templates; POST /api/prompt-studio/:key/variant sets variant weights (KV hot-patch, no redeploy); POST /api/prompt-studio/:key/rollback restores prior version.\n• Reads/writes the registry the build pipeline consumes. No admin page yet.',
    key: 'prompt_studio',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  lead_notifications: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Lead Notifications: email the site owner the moment a public contact form is submitted, so a new lead is never missed without configuring an integration.\n\n• isFlagOn-gated (dark by default) — off = no owner email fires (current behavior, unchanged). Org-scoped.\n• Fires fire-and-forget in the /api/contact-form/:slug handler AFTER the form_submissions row is persisted (fail-soft: a send failure never affects the visitor 200 or the /admin/forms row). Recipient = ai_site_settings.reply_email ?? the org owner (users⋈memberships role=owner). SES rail (ADR-0019) via notifyNewLead → sendEmail(category:lead_notification); user-supplied lead fields are HTML-escaped in the email body.\n• Embarrassingly-easy: zero owner config — the owner gets the lead in their inbox instead of polling /admin/forms.',
    key: 'lead_notifications',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  scan_profiles: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Scan Profiles: D1-persisted CRUD for the lead scanner\'s editable "what to hunt" config (SCOPE.md:68).\n\n• GET/POST /api/admin/scan-profiles + PATCH/DELETE /api/admin/scan-profiles/:id — auth 401 → this flag (404, never 403) → super-admin 403 → Zod 400.\n• Persists geo bboxes / OSM categories / providers / free-text filters / cadence / per-run lead cap; the cron geo-sweep reads the due profiles and runs each bbox through the lead_scan_orchestrator.\n• Soft-deleted (deleted_at) — never physically removed, so an undo stays possible.\n• Off → every route 404s; the ad-hoc POST /api/admin/leads/scan-osm (lead_scanner flag) still works, so nothing regresses.',
    key: 'scan_profiles',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  prompt_schedule: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Prompt Scheduler: time-windowed activation of a prompt-registry variant for a prompt key.\n\n• isFlagOn-gated — off 404, unauth 401. Org-scoped, Zod-validated.\n• POST /api/prompt-schedules creates a window (prompt_key, variant, activate_at, deactivate_at?); GET lists; GET /active?key= returns the variant active NOW; DELETE soft-deletes (IDOR-safe).\n• Read-time evaluation (no cron): the pipeline calls getActiveVariant(key, now) at prompt-resolve; most-recently-activated window wins on overlap. Off → default variant, unchanged. Enables seasonal/campaign prompts with zero owner config.',
    key: 'prompt_schedule',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  content_import: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Content Import: parse a platform export (WordPress/Squarespace/Wix/Webflow/CSV/RSS) into normalized ContentItem[].\n\n• isFlagOn-gated — off 404, unauth 401. Zod-validated, pure (no writes/state).\n• POST /api/content-import/parse {source, raw} → {source, count, items}. A malformed export → typed 400; raw capped at 200 KB (< the 256 KB body limit).\n• Wraps the already-unit-tested parsers in src/services/content_import.ts (previously reachable by NO route). Off → the route 404s. Seeding parsed items into a build is a follow-on.',
    key: 'content_import',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  scheduled_publish: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Scheduled Site Publishing: schedule a BUILT site to go live at a future datetime — a campaign launch / grand opening with zero babysitting.\n\n• isFlagOn-gated — off 404, unauth 401. Org- + site-scoped, Zod-validated.\n• POST /api/sites/:id/publish-schedule stores a pending schedule ({publish_at, label?}, future-only, one per site — reschedule supersedes); GET lists; DELETE cancels (IDOR-safe). An unbuilt site → 409 (build first).\n• The every-minute cron (scheduled() Stage 6.2) flips DUE sites live (status published) and marks the row fired; a site that lost its build is skipped, never published blank. Off → the routes 404 and the sweep finds no rows — publishing is unchanged.',
    key: 'scheduled_publish',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  psnotify: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'psnotify Notification Inbox (first slice): the in-app bell backbone — a SQLite-backed Durable Object (PsNotifyDO), one instance per user, storing notifications with zero D1 tables.\n\n• isFlagOn-gated — off 404, unauth 401. Caller-scoped: the inbox is resolved by getByName(userId) from the AUTHED session, never a request-supplied id, so a user can only ever read/mutate THEIR own inbox (the psnotify analogue of assertSiteOwned).\n• GET /api/notifications?unreadOnly&limit returns the caller OWN inbox (newest-first) + the unread count; POST /api/notifications/:id/read marks one read (idempotent). notifyUser()/notifyEvent() write into the same per-user DO.\n• Needs a `wrangler deploy --env production` to apply the PsNotifyDO SQLite DO migration (v_psnotify_do) + bind PSNOTIFY_DO. Until then the handlers fail-soft to an empty inbox and the in-app write no-ops (never a 500). Email/push fan-out + bell-feed unification are follow-on slices. Off → the routes 404.',
    key: 'psnotify',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  durable_preview: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Durable Preview model — server-side state for the editor Promote → Production release workflow (main-only). Save/generate mutates a per-site PREVIEW working tree; Production changes only via an authorized Promote (a later slice).\n\n• isFlagOn-gated — off 404, unauth 401. Org- + site-scoped, Zod-validated.\n• POST /api/sites/:id/preview-state upserts the per-site working-tree record (main base SHA, MONOTONIC draft revision, tree digest, preview deploy revision, last error) — Preview ONLY, never a commit/deploy/Production change; GET reads it. GET /api/sites/:id/releases lists the append-only immutable release history (frozen snapshot id, commit SHA, artifact digest, CF deployment id, actor, outcome).\n• Additive tables (site_working_tree + site_releases, migration 0646). Off → the routes 404 and nothing writes; migrating existing sites needs no redeploy.',
    key: 'durable_preview',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // Multi-tenant + agency (items 9-13)
  // CWV (items 14-19, 15 already shipped)
  // GEO (items 20-24, 20-22 already stable)
  // Accessibility (items 25-29, 29 stable)
  // Editor UX (items 30-34)
  // Monetization (items 35-38)
  // Observability (items 39-42)
  // Media gen (items 43-46)
  // Platform extension (items 47-50, 47 + 48-slice + 49-slice already stable)
  referral_loop: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "In-product refer-a-friend: tracked referral codes/links, attributed signups, and credit rewards granted through the wallet on conversion.\n\n• Handlers mounted in index.ts; isFlagOn-gated — off returns 404.\n• GET /api/referral/code returns the org's code + share link; POST /api/referral/track attributes a signup; GET /api/referral/stats powers the dashboard.\n• Rewards granted via credit_wallet_rollover. Admin dashboard renders <app-referral-card>, self-hiding on 404.",
    key: 'referral_loop',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  kv_inspector: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Read-only, super-admin platform debugging tool for the two shared KV namespaces (CACHE_KV = host/analytics cache, PROMPT_STORE = prompt hot-patch).\n\n• Worker: libs/features/kv_inspector/handlers.ts serves GET /api/admin/kv/namespaces, /api/admin/kv/:binding/keys (cursor-paginated, ≤1000), /api/admin/kv/:binding/value (64 KiB cap + truncated flag).\n• :binding validated against a SERVER allowlist (CACHE_KV|PROMPT_STORE) — client-supplied names never reach KV; unknown → 404.\n• Read-only (no write/delete). Super-admin only; flag off → 404 (never leak existence).\n• Admin surface: /admin/kv-inspector (System Administrator). Values are eventually consistent (disclosed in the UI).',
    key: 'kv_inspector',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  d1_manager: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Read-only, super-admin D1 resource-discovery + Overview surface for the Cloudflare account\'s D1 databases.\n\n• Worker: libs/features/d1_manager/handlers.ts serves GET /api/admin/d1/databases (list: id/name/created/version) + /api/admin/d1/:databaseId/overview (metadata: file size, table count, region, read-replication, version) via the Cloudflare D1 REST API.\n• Cloudflare credentials stay SERVER-side (resolveCfCredentials); account id is env.CF_ACCOUNT_ID, never client-supplied. :databaseId is a validated UUID (no REST-path injection); the super-admin gate is the authz boundary (account-wide platform view, not per-tenant).\n• Reads only (no data mutation): list + overview + SQL-DUMP EXPORT. POST /api/admin/d1/:databaseId/export runs CF\'s async polling export → a portable .sql text dump (full, or scoped via dump_options.tables/no_data/no_schema), resumable via the returned bookmark. Export briefly makes the DB unavailable to serve queries (a CF platform behaviour, surfaced honestly in the response note), so it stays super-admin + flag-dark. No write/DDL/Time-Travel restore (the raw SQL console + restore are separate). Super-admin only; flag off → 404 (never leak existence). Honest "not available" (never a fabricated URL/empty list) when creds/API fail.\n• Surfaced in the Editor Data panel D1 Overview strip + /admin/data (System Administrator).',
    key: 'd1_manager',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  r2_inspector: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Read-only, super-admin platform debugging tool for the shared R2 bucket (SITES_BUCKET = generated site output + media).\n\n• Worker: libs/features/r2_inspector/handlers.ts serves GET /api/admin/r2/buckets, /api/admin/r2/:bucket/objects (prefix + cursor-paginated, ≤1000), /api/admin/r2/:bucket/object (metadata via HEAD — never the body).\n• :bucket validated against a SERVER allowlist (SITES_BUCKET) — client-supplied names never reach R2; unknown → 404.\n• Read-only (no put/delete, no body download). Super-admin only; flag off → 404 (never leak existence).\n• Admin surface: /admin/r2-inspector (System Administrator). SITES_BUCKET is SHARED platform infra, not tenant-owned.',
    key: 'r2_inspector',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  vectorize_inspector: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Read-only, super-admin platform debugging tool for the account Cloudflare Vectorize indexes (RAG / embeddings — shared platform infra, not tenant-owned).\n\n• Worker: libs/features/vectorize_inspector/handlers.ts serves GET /api/admin/vectorize/indexes (list) + /api/admin/vectorize/indexes/:name (describe: dimensions, distance metric, description, vector count + last-processed mutation via v2 REST /info).\n• Cloudflare credentials stay SERVER-side (worker global key via resolveCfCredentials); account id is env.CF_ACCOUNT_ID, never client-supplied. :name validated as a slug (no REST-path injection); the super-admin gate is the authz boundary.\n• Read-only (no insert/query/delete). Super-admin only; flag off → 404 (never leak existence). Honest "not available" (never a fabricated empty list) when creds/API fail.\n• Admin surface: /admin/vectorize-inspector (System Administrator).',
    key: 'vectorize_inspector',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  queues_inspector: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Read-only, super-admin platform debugging tool for the account Cloudflare Queues (job / workflow pipelines — shared platform infra, not tenant-owned).\n\n• Worker: libs/features/queues_inspector/handlers.ts serves GET /api/admin/queues (list) + /api/admin/queues/:id (describe: delivery delay, message retention, producers + consumers with worker script/service).\n• Cloudflare credentials stay SERVER-side (worker global key via resolveCfCredentials); account id is env.CF_ACCOUNT_ID, never client-supplied. :id validated as a slug/hex (no REST-path injection); the super-admin gate is the authz boundary.\n• Read-only (no publish/purge/delete). Super-admin only; flag off → 404 (never leak existence). Honest "not available" (never a fabricated empty list) when creds/API fail.\n• Admin surface: /admin/queues-inspector (System Administrator).',
    key: 'queues_inspector',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── Per-site resource-platform gates (Data & Resource Platform — docs/data-resource-platform/).
  //    Registered 2026-09-27 (tracked follow-up in PROGRESS-LEDGER.md): these 8 were runtime gate
  //    CONSTANTS not in FLAG_REGISTRY, so they were dark-by-default AND un-toggleable. Registered
  //    here (default-off, DARK) so a super-admin can promote each per-kind surface independently.
  //    per_site_data (Phase 0c provisioning) + data_resource_platform (registry SSOT) are separate,
  //    already registered above — these gate the per-KIND read/write surfaces + their MCP tools.
  per_site_connections: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Connections surface (Data & Resource Platform — the customer's own external service connections + secrets for THEIR site).\n\n• Gates the site-owned Connections read/write surface + its parity MCP tools (data_connections_*): a site owner lists/creates/rotates the connections + encrypted env vars scoped to their OWN site, resolved server-side from the authed { site_id } — reusing assertSiteOwned so a foreign site's connections are never returned; secret values stay AES-GCM at rest and are never echoed back.\n• Who sees it: a signed-in site owner in the editor Data tab (Connections), plus MCP clients driving the same tools; super-admin can promote per-kind.\n• Failure mode when off (default, DARK): the Connections routes + data_connections_* MCP tools 404 (never 403 — no existence leak); nothing regresses because no surface is wired to it yet.\n• Acceptance: flag on → an owner lists/creates a connection scoped to their site and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_connections',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_durable_objects: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Durable Objects surface (Data & Resource Platform — a site's OWN Durable Object namespaces for stateful/coordination workloads).\n\n• Gates the site-owned Durable Objects read surface + its parity MCP tools (data_do_*): list the DO namespaces bound to the caller's OWN site and describe one (class, script, id-derivation), resolved server-side from the authed { site_id } via resolveResourceRef against a row the caller OWNS — reusing assertSiteOwned + the FORBIDDEN_DB_IDS-style denylist so a foreign or shared-platform DO is never resolved; the client never names a CF id.\n• Who sees it: a signed-in site owner in the editor Data tab (Durable Objects) + MCP clients; super-admin promotes per-kind.\n• Failure mode when off (default, DARK): the DO routes + data_do_* MCP tools 404 (never 403); no surface is wired yet so nothing regresses.\n• Acceptance: flag on → an owner lists their site's DO namespaces and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_durable_objects',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_kv: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site KV surface (Data & Resource Platform — a site's OWN dedicated Cloudflare KV namespace, blank at first, NEVER the shared platform CACHE_KV/PROMPT_STORE).\n\n• Gates the site-owned KV read/write surface + its parity MCP tools (data_kv_list_keys / data_kv_get_value / data_kv_put_value): list keys (cursor-paginated), get a value (size-capped + truncated flag), and put/delete, all resolved server-side to the site's OWN kv_namespace_id from site_database_allocations via resolveResourceRef — reusing assertSiteOwned so a foreign site's KV is never reached and the client never supplies a namespace id.\n• Who sees it: a signed-in site owner in the editor Data tab (KV) + MCP clients; super-admin promotes per-kind.\n• Failure mode when off (default, DARK): the KV routes + data_kv_* MCP tools 404 (never 403); this is distinct from kv_inspector (the SHARED-platform super-admin tool) which is unaffected.\n• Acceptance: flag on → an owner lists/gets/puts keys in their OWN namespace and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_kv',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_observability: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Observability surface (Data & Resource Platform — a site's OWN logs / metrics / traces for its per-site resources, scoped to that one site).\n\n• Gates the site-owned Observability read surface + its parity MCP tools (data_observability_*): query the caller's OWN site's resource logs/metrics (invocations, errors, latency, per-kind usage) over a time window, resolved server-side from the authed { site_id } — reusing assertSiteOwned so a foreign site's telemetry is never returned; read-only, no mutation path.\n• Who sees it: a signed-in site owner in the editor Data tab (Observability) + MCP clients; super-admin promotes per-kind. Distinct from the platform-wide analytics/data-overview surfaces (those read the master D1).\n• Failure mode when off (default, DARK): the observability routes + data_observability_* MCP tools 404 (never 403); no surface is wired yet so nothing regresses.\n• Acceptance: flag on → an owner sees their OWN site's resource metrics and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_observability',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_queues: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Queues surface (Data & Resource Platform — a site's OWN Cloudflare Queues for background/async workloads, distinct from the account-wide queues_inspector).\n\n• Gates the site-owned Queues read/write surface + its parity MCP tools (data_queues_*): list the queues bound to the caller's OWN site, describe one (delivery delay, retention, producers/consumers), and send a message, resolved server-side from the authed { site_id } via resolveResourceRef against a row the caller OWNS — reusing assertSiteOwned so a foreign or shared-platform queue is never resolved and the client never names a CF id.\n• Who sees it: a signed-in site owner in the editor Data tab (Queues) + MCP clients; super-admin promotes per-kind.\n• Failure mode when off (default, DARK): the Queues routes + data_queues_* MCP tools 404 (never 403); the super-admin queues_inspector (shared platform infra) is a separate flag and is unaffected.\n• Acceptance: flag on → an owner lists/sends to their OWN site's queue and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_queues',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_r2: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site R2 surface (Data & Resource Platform — a site's OWN dedicated Cloudflare R2 bucket for object storage, NEVER the shared platform SITES_BUCKET).\n\n• Gates the site-owned R2 object-browser read/write surface + its parity MCP tools (data_r2_list_objects / data_r2_head_object + later get/put/delete): list objects (prefix + continuation), HEAD an object's metadata (no body), and put/delete, all resolved server-side to the site's OWN r2_bucket_name from site_database_allocations via resolveResourceRef — reusing assertSiteOwned so a foreign site's bucket is never reached and the client never supplies a bucket name.\n• Who sees it: a signed-in site owner in the editor Data tab (R2) + MCP clients; super-admin promotes per-kind. Distinct from r2_inspector (the SHARED-platform super-admin tool), which is unaffected.\n• Failure mode when off (default, DARK): the R2 routes + data_r2_* MCP tools 404 (never 403); r2_provisioner exists but stays INERT (honest not_registered).\n• Acceptance: flag on → an owner lists/heads/puts objects in their OWN bucket and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_r2',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_vectorize: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Vectorize surface (Data & Resource Platform — a site's OWN Cloudflare Vectorize index for RAG / embeddings, distinct from the account-wide vectorize_inspector).\n\n• Gates the site-owned Vectorize read/write surface + its parity MCP tools (data_vectorize_*): describe the caller's OWN site's index (dimensions, distance metric, vector count), query by vector, and upsert/delete vectors, resolved server-side from the authed { site_id } via resolveResourceRef against a row the caller OWNS — reusing assertSiteOwned so a foreign or shared-platform index is never resolved and the client never names a CF index name.\n• Who sees it: a signed-in site owner in the editor Data tab (Vectorize) + MCP clients; super-admin promotes per-kind.\n• Failure mode when off (default, DARK): the Vectorize routes + data_vectorize_* MCP tools 404 (never 403); the super-admin vectorize_inspector (shared platform infra) is a separate flag and is unaffected.\n• Acceptance: flag on → an owner describes/queries their OWN index and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_vectorize',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_workflows: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Workflows surface (Data & Resource Platform — a site's OWN Cloudflare Workflows for durable multi-step orchestration, scoped to that one site).\n\n• Gates the site-owned Workflows read/write surface + its parity MCP tools (data_workflows_*): list the workflows bound to the caller's OWN site, describe one + its recent instances (status, steps), and trigger/terminate an instance, resolved server-side from the authed { site_id } via resolveResourceRef against a row the caller OWNS — reusing assertSiteOwned so a foreign or shared-platform workflow is never resolved and the client never names a CF id.\n• Who sees it: a signed-in site owner in the editor Data tab (Workflows) + MCP clients; super-admin promotes per-kind. Distinct from the platform's own SITE_WORKFLOW site-generation pipeline (internal, not this surface).\n• Failure mode when off (default, DARK): the Workflows routes + data_workflows_* MCP tools 404 (never 403); no surface is wired yet so nothing regresses.\n• Acceptance: flag on → an owner lists/triggers their OWN site's workflow and a foreign-site ref is rejected; off → those routes 404.",
    key: 'per_site_workflows',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_bindings: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site Worker-bindings inventory (Data & Resource Platform Phase 8b, Backend tab — a READ-ONLY list of the bindings a site's Worker uses).\n\n• Gates the site-owned Worker-bindings inventory surface + its share of the data_backend_inventory MCP tool: a site owner sees the bindings their compute plane uses (service / Secrets Store / AI / Browser Rendering / Images / KV / R2 / D1 / Durable Objects / Vectorize / Analytics Engine / Queues), each with a useful description + whether THIS platform has an integrated management surface (a manageRoute) or an honest not-available note — resolved server-side from the authed { site_id } reusing the owned-site gate; the client never names a CF id (INV-1).\n• Who sees it: a signed-in site owner in the editor Backend tab (Bindings) + MCP clients; super-admin promotes per-surface.\n• Failure mode when off (default, DARK): the bindings-inventory surface + its MCP output 404 (never 403); the data_backend_inventory tool itself is umbrella-gated on data_resource_platform.\n• Acceptance: flag on → an owner sees their site's bindings (read-only, no values); off → the surface 404s. ⛔ No secret VALUE is ever returned — only names + presence.",
    key: 'per_site_bindings',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  per_site_schedules: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Per-site scheduled-tasks inventory (Data & Resource Platform Phase 8b, Backend tab — the site's Cron Triggers).\n\n• Gates the site-owned scheduled-tasks (Cron Triggers) surface + its share of the data_backend_inventory MCP tool: a site owner sees the cron schedules their site declared in functions/_scheduled.* (Workers-for-Platforms has no native cron, so these live in site_functions_schedules and fire via the platform cron dispatcher), resolved server-side from the authed { site_id } reusing the owned-site gate; the client never names a CF id.\n• Who sees it: a signed-in site owner in the editor Backend tab (Scheduled tasks) + MCP clients; super-admin promotes per-surface.\n• Failure mode when off (default, DARK): the schedules surface + its MCP output 404 (never 403); the data_backend_inventory tool itself is umbrella-gated on data_resource_platform.\n• Acceptance: flag on → an owner sees their site's cron schedules; off → the surface 404s.",
    key: 'per_site_schedules',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  site_analytics: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Owner-facing per-site analytics summary that aggregates a site's contacts, form submissions, newsletter subscribers, donations and traffic into one read-only dashboard.\n\n• Worker: libs/features/site_analytics/handlers.ts mounts GET /api/sites/:siteId/analytics (+ /daily, /sections, /forms, /funnel, /export) and POST /api/sites/:siteId/analytics/share.\n• Traffic block reads visitor_events_core; other tiles read the contacts/submissions/subscribers/donations cores.\n• Admin surface: /admin/analytics (analytics-dashboard.component) with overview + live tabs.\n• Site-scoped query — never exposes another tenant's numbers; when the flag is off the route 404s (never 403).\n• Stage=beta; e2e verified via e2e/admin/analytics.spec.ts.",
    key: 'site_analytics',
    owner_email: 'brian@megabyte.space',
    stage: 'beta', // beta 2026-07-31: e2e verified — e2e/admin/analytics.spec.ts (green live),
  },
  site_doctor: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Owner-facing A–F site health report card that turns production-readiness signals into a prioritized, plain-English list of one-tap fixes with a generous-free lock.\n\n• Worker: libs/features/site_doctor/handlers.ts serves GET /api/sites/:siteId/doctor returning {grade, score, issues[], locked_count}; reuses prod_readiness_score scoring (no duplicate scorer).\n• Free plan (?plan=free) unlocks the top issue; the rest carry locked:true (the paid analytics_pro upsell); ?plan=pro unlocks all.\n• Sibling GET /api/sites/:siteId/sparkline (site_health_sparklines) shares this flag for a 7-day mini traffic trend.\n• Admin surface: site-doctor.component (Site Health tab, ?tab=health) rendering the grade + fixes + Unlock-with-Pro rows.\n• Unauth → 401; flag off → 404; site not owned → 404.',
    key: 'site_doctor',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  social_autopilot: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      'Operator kill-switch for Pulse Social Auto-Pilot — the AI cron that generates and schedules drafts per configured network. Defaults ENABLED (stable, 100%).\n\n• Gates POST /api/social/auto-pilot/run-now; when off returns 503 FEATURE_DISABLED.\n• Flipping the global override off instantly halts all autonomous AI posting with no redeploy.\n• Manual compose/schedule and the read-only auto-pilot preview (GET /api/social/auto-pilot/config) are unaffected when off.\n• Same /admin/social surface; the auto-pilot run/prompt control is the gated action.',
    key: 'social_autopilot',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  social_publishing: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      'Operator kill-switch for Pulse Social post publishing. Defaults ENABLED (stable, 100%) so live behavior is unchanged; flipping the global override off instantly halts publishing with no redeploy.\n\n• Gates POST /api/social/posts/:id/schedule and POST /api/social/posts/:id/publish-now (the SocialPublishWorkflow dispatch).\n• When off, those endpoints return 503 FEATURE_DISABLED (known feature being halted — clearer than 404).\n• Drafting/composing still works when off.\n• Same /admin/social composer; the publish-now control is the gated action.',
    key: 'social_publishing',
    owner_email: 'brian@megabyte.space',
    stage: 'stable',
  },
  social_publishing_native: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Native social media posting (instant + scheduled) across 14 platforms. CF Workflows v2 + Upstash + D1 + Tinybird. Its route checks isFlagOn('social_publishing_native'); the flag was never in FLAG_REGISTRY so resolveFlag short-circuited it dead. Registered 2026-08-13 (default-off = promotable dark-launch).",
    key: 'social_publishing_native',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  system_status: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Aggregated integration-health strip for the admin top bar, probing every platform service in parallel.\n\n• GET /api/system/status runs 5 probes (Listmonk, LiteLLM, Twenty, Payload, Chatwoot), 5s timeout each.\n• Each probe returns healthy/degraded/down/unknown + latencyMs; overall is healthy only when all pass.\n• Never cached — real-time. Handler in libs/features/system_status.\n• Backend-only: no frontend status-strip consumes it yet.',
    key: 'system_status',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  // ── Alias sentinel keys — thin manifest dirs that alias an already-canonical manifest.
  //    Created so that e2e/_fortress/<slug>/ directories have a matching libs/features/<slug>/
  //    and the drift validator's TEST_NOT_LINKED check resolves.
  // Compete-or-die (items 1-8)
  token_burn_meter: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "Live monthly AI-token spend meter surfaced in the editor, tracking per-model burn against the tier cap.\n\n• Worker routes GET /api/usage/burn (used_usd, projected_monthly_usd, by_model, 80%/100% thresholds) and POST /api/usage/record, both behind requireFlag('token_burn_meter').\n• site-generation workflow gates its token accounting on the flag (services/build_budget.ts records feature_slug 'token_burn_meter').\n• Off (default) → both usage endpoints 404 (no existence leak).",
    key: 'token_burn_meter',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
  visual_automation: {
    default_enabled: true,
    default_rollout_percent: 100,
    description:
      "Journey validation engine: 7 action types, 6 trigger types, step delay estimation, linear journey validation with error reporting. Its route checks isFlagOn('visual_automation'); the flag was never in FLAG_REGISTRY so resolveFlag short-circuited it dead. Registered 2026-08-13 (default-off = promotable dark-launch).",
    key: 'visual_automation',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },

  wireframe_planning: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Pre-generation approval gate that surfaces a sitemap plus page-level wireframe plan in /create BEFORE section generation, so information-architecture problems are caught up front.\n\n• Owner reviews and edits the proposed sitemap + wireframe plan, then approves to generate along the approved structure.\n• When off, /create generates directly with no planning gate (safe disabled behavior).\n• Catalogued in libs/features/CATALOG.md; e2e/wireframe_planning/ spec is pending.\n• Stage=experimental (enabled=0, rollout=0), owner brian@megabyte.space.\n• No standalone /api reader found in src — planning gate is part of the /create build flow, not a separate endpoint yet.',
    key: 'wireframe_planning',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
  },
};

export type FlagKey = keyof typeof FLAG_REGISTRY;

export function listFlags(): FlagDefinition[] {
  return Object.values(FLAG_REGISTRY);
}
