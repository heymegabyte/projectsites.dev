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
  approval_workflow: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Client preview + approval share-links — stakeholders review a site and approve/reject via a password-protected shared link (agency sign-off flow).\n\n• GET/POST /api/sites/:siteId/review-links create + list shareable preview links (routes/review_links.ts); public /review/:id page (ReviewComponent) lets a reviewer approve/reject (routes/review_public.ts).\n• Frontend app-share-link-dialog is the "Share link" modal; it shows a flag-gate notice ("Turn on approval_workflow") when off.\n• Off → all review-link routes 404 and the dialog stays gated.',
    key: 'approval_workflow',
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
  research_cache: {
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      'Per-business research cache (#19c margin lever) — when on, rebuilding the same business skips all 5 research LLM calls (~15→5 min build + lower model spend).\n\n• services/openai_research.ts checks isFlagOn(env, "research_cache"); on → reads/writes a KV cache keyed by stable identity (placeId → name+address), 30-day TTL, v1 namespace for prompt-quality invalidation.\n• Off (default) → every rebuild pays full research cost. Enabling is a pure cost/latency win with bounded staleness.\n• Backend-only; no route surface.',
    key: 'research_cache',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
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
    default_enabled: false,
    default_rollout_percent: 0,
    description:
      "OpenAI-compatible GET /v1/models catalog plus the workload-aware AI model router, both gated by this one flag (the standalone ai_auto_router duplicate was folded in 2026-08-14).\n\n• GET /v1/models returns {object:'list', data:[...]} of deepseek/anthropic/openai/gemini/grok/workers-ai aliases; a provider lists only when its key is set.\n• POST /api/router/pick classifies a prompt (simple/complex/creative/free-eligible) and routes to the cheapest sufficient model; GET /api/router/stats reports savings vs an always-Opus baseline.\n• Backend-only alias catalog + router the AI stack reads; no admin UI. Off (default) → all three routes 404.",
    key: 'model_registry',
    owner_email: 'brian@megabyte.space',
    stage: 'experimental',
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

export function getDefaultFlag(key: string): FlagDefinition | undefined {
  return FLAG_REGISTRY[key];
}
