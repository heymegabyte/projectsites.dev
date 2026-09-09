/**
 * Per-flag detailed explanations + a scannable checklist + smoke-test steps.
 *
 * Surfaced by `GET /api/feature-flags/:key` (spread verbatim by
 * routes/features.ts) and rendered in /admin/feature-flags expanded cards.
 *
 * Each entry has:
 *   - `checklist` — 3-6 short "what this does" checkpoints. The at-a-glance
 *     contract a reader scans BEFORE the prose. Every registry flag MUST carry
 *     one (the /admin/feature-flags detail panel renders it as a ✓ list).
 *   - `explanation` — 100-200 word description of the mechanism + why it matters.
 *   - `smoke_test` — copy-pasteable curl + UI steps to verify once enabled.
 *   - `e2e_tests` — Playwright spec paths (relative to apps/project-sites/).
 *   - `references` — optional doc / research links.
 *
 * "Merged scope" note: per the 2026-06-08 idea-merge wave, several roadmap
 * capabilities fold into an existing flag's scope rather than spawning a new
 * key. Those land as extra checklist checkpoints on the parent flag (e.g.
 * NLWeb /ask under site_mcp_server, behavioral personalization + bandit CRO
 * under visitor_events_core). Genuinely new keys: site_video_gen,
 * editor_vision_qa.
 *
 * Flags without a docs entry fall back to the short registry.ts description.
 */

export interface FlagDocs {
  /** 3-6 short "what this does" checkpoints — rendered as a ✓ list. */
  checklist: string[];
  explanation: string;
  smoke_test: string[];
  /** Playwright spec paths (relative to apps/project-sites/) covering this flag. */
  e2e_tests?: string[];
  /** One captioned screenshot per distinct UI change the flag enables. */
  screenshots?: { url: string; caption: string; alt?: string }[];
  references?: string[];
}

export const FLAG_DOCS: Record<string, FlagDocs> = {
  // ── Restored 2026-08-16 (1:1 with registry.ts): docs for the 4 orphan-gate flags
  // (approval_workflow, github_repo_sync, abandoned_build_nudge, research_cache)
  // re-added after the orphan-gate detector found them gated but absent from the registry.
  abandoned_build_nudge: {
    checklist: [
      'Scheduled recovery nudge for stalled / abandoned builds',
      'Dark-launched cron — default-off is a no-op (zero sends)',
      'One dedup-stamped nudge per abandoned build',
      'Backend cron only — no route surface',
    ],
    explanation:
      'Abandoned-build recovery nudge (#27): a scheduled cron that emails owners whose site build stalled or was abandoned, prompting them to resume. Dark-launched behind this flag — a complete no-op until enabled.',
    smoke_test: [
      'Enable the flag → the next scheduled run emails one nudge per abandoned build',
      'Off → the cron is a no-op (zero sends)',
    ],
  },
  approval_workflow: {
    checklist: [
      'Password-protected client preview + approval share-links',
      'Public /review/:id page for stakeholder approve / reject',
      'GET/POST /api/sites/:siteId/review-links CRUD',
      'Share-link dialog in admin, gated when off',
    ],
    explanation:
      'Client preview + approval share-links for agency sign-off: create a password-protected shareable preview link and let a stakeholder approve or reject the site from a public /review/:id page. Off → review-link routes 404 and the dialog shows a gate notice.',
    smoke_test: [
      'Enable → open the Share-link dialog → create a link → visit /review/:id → approve',
      'Off → /api/sites/:id/review-links 404s and the dialog stays gated',
    ],
  },
  github_repo_sync: {
    checklist: [
      'Mirror a generated site to a GitHub repo',
      'Git-backed site rollback from commit history',
      'Gates a site-generation push step + rollback routes',
      'Requires GitHub credentials when enabled',
    ],
    explanation:
      'GitHub repo sync + git-backed rollback: pushes the generated site to a GitHub repo during generation and enables rolling a site back to a previous commit. Off → the generation push step is skipped and the rollback routes 404.',
    smoke_test: [
      'Enable + configure GitHub creds → generate a site → the repo receives a commit',
      'POST /api/sites/:id/rollback restores a prior commit; Off → rollback 404s',
    ],
  },
  research_cache: {
    checklist: [
      'Per-business research cache (margin + latency lever)',
      'Rebuild of the same business skips all 5 research LLM calls',
      'KV keyed by placeId → name+address, 30-day TTL',
      'v1 namespace for prompt-quality invalidation',
    ],
    explanation:
      'Per-business research cache (#19c margin lever): when on, rebuilding the same business reuses cached research and skips all 5 research LLM calls (~15→5 min build + lower model spend), keyed by stable identity with a 30-day TTL. Off → every rebuild pays full research cost.',
    smoke_test: [
      'Enable → rebuild the same business twice → the 2nd build skips the research LLM calls (faster)',
      'Off → every rebuild runs the full 5-call research pipeline',
    ],
  },
  // ── Restored 2026-08-13 (1:1 with registry.ts): docs for the 33 over-pruned dark-launch flags.
  abuse_takedown: {
    checklist: [
      'Public abuse-report intake for published sites',
      'DMCA / illegal-content takedown workflow',
      'Status pipeline: reported → reviewing → actioned',
      'Hosting-platform legal necessity',
    ],
    explanation:
      'Abuse report intake + content takedown workflow for published sites (DMCA / illegal-content handling). A hosting-platform necessity: a public report form, a review queue, and a takedown action that can unpublish a site.',
    smoke_test: [
      'POST /api/abuse/report {site_id, reason} → 202 + case id',
      'Operator review queue shows the case; actioning it unpublishes the site',
    ],
  },
  activity_feed: {
    checklist: [
      'Unified org event timeline',
      '14 event kinds from audit_logs',
      'Cursor-based pagination',
      'Actor name extraction from metadata',
    ],
    explanation:
      'Unified org-scoped timeline of recent platform events — builds, publishes, deploys, domain changes, billing events, and member changes. Aggregated from the audit_logs table with cursor-based pagination (newest-first). Designed for the admin dashboard live-activity widget.',
    smoke_test: [
      'Enable flag → GET /api/activity → 200 with data[] + cursor + hasMore',
      'Each entry has kind, summary, actorName, targetType, timestamp',
      'Pass ?cursor=<ts> to paginate',
    ],
  },
  ai_gateway_guardrails: {
    checklist: [
      'Llama Guard middleware on /ai/* routes',
      'Blocks prompt-injection / hate / off-brand input + output',
      'Runs before publish',
      'No-redeploy killswitch',
    ],
    explanation:
      'Mounts Llama Guard middleware on the /ai/* routes, blocking prompt-injection, hateful, and off-brand input AND output before it reaches publish, with a no-redeploy killswitch (per rules/ai-agent-security). Every block is logged. When off, the guard is bypassed (the killswitch state) and requests pass through to the model directly.',
    smoke_test: [
      'POST an /ai/* route with an injection payload ("ignore previous instructions…") → blocked, logged',
      'POST a benign prompt → passes through to the model',
      'Flip the killswitch → the guard disables instantly with no redeploy',
    ],
  },
  app_launcher: {
    checklist: [
      'Per-tenant app provisioning planner over the companion-app catalog (Twenty, Listmonk, Chatwoot, Payload, ...)',
      'ON -> GET /api/apps/catalog lists apps; POST /api/apps/launch returns a provisioning plan',
      'OFF (default) -> both routes 404 (no existence leak)',
      'Planner only: hands a plan to the operator, does not itself provision',
    ],
    explanation:
      'Account-level app catalog + launch planner. When ON, an org browses the 11 provisionable companion apps and requests a launch plan; when OFF (default) the /api/apps/* routes 404. Off-vision relative to the core site builder -- it is the Apps expansion surface, not site generation.',
    smoke_test: [
      'Flag ON: GET /api/apps/catalog returns the 11-app catalog',
      'Flag ON: POST /api/apps/launch with an app id returns a structured plan',
      'Flag OFF (default): both routes return 404',
    ],
  },
  audit_trail_export: {
    checklist: [
      'Org-scoped audit-log export for compliance reviews',
      'Filter by action and date range',
      'Download as JSON or CSV',
      'Read-only; never mutates the audit trail',
    ],
    explanation:
      'Lets org admins export the audit trail for compliance reviews — filter by action and date range, then download as JSON or CSV. Strictly read-only over the append-only audit_logs table and scoped to the caller’s org (no cross-tenant rows). When off, the export route 404s.',
    smoke_test: [
      'GET /api/audit/export?format=csv&action=site.publish&from=2026-01-01 → CSV attachment',
      'GET /api/audit/export?format=json → JSON array of audit rows for the org',
      'Disable the flag → the export route 404s',
    ],
  },
  batch_operations: {
    checklist: [
      'Bulk rebuild/snapshot/delete for 1-50 sites',
      'Per-site org-ownership validation',
      'Per-site ok/fail result with message',
      'Returns summary: total/ok/failed counts',
    ],
    explanation:
      'Batch processor for site-level actions — rebuild (queues build workflow_job), snapshot (queues snapshot workflow_job), or delete (soft-deletes site). Each site ID is validated for org ownership before the action. Results are per-site with a summary block for quick status checks.',
    smoke_test: [
      'Enable flag → POST /api/batch {"siteIds":["id1","id2"],"action":"rebuild"} → 200 with per-site results',
      'Unowned site → ok:false, message:"not_found_or_not_owned"',
      'Invalid action → 400 Zod validation error',
    ],
  },

  better_auth: {
    checklist: [
      'CUTOVER flag for the embedded Better Auth rebuild (auth/better-auth.ts)',
      'ON → Better Auth owns /api/auth/* (email+password, magic link, Google, TOTP)',
      'OFF (default) → legacy magic-link/Google/D1-session auth unchanged',
      'MUST stay OFF in prod until the sign-in UI + user-migration backfill land',
    ],
    explanation:
      'Cutover flag for the embedded Better Auth rebuild. When ON, Better Auth owns /api/auth/* and issues its own D1 sessions; when OFF (default) /api/auth/* falls through to the legacy auth. Flipping early would route live sign-in at an unmigrated system — keep OFF in production until the frontend sign-in UI + user-migration backfill ship.',
    smoke_test: [
      'Flag OFF (prod default): existing magic-link + Google sign-in unchanged',
      'Flag ON in a test env: POST /api/auth/sign-up/email creates a user + session',
      'Flag ON: POST /api/auth/sign-in/email returns a Better Auth D1 session',
      'Flip OFF again: legacy auth resumes with no migration needed',
    ],
  },
  cmdk_ai_actions: {
    checklist: [
      'Two Cmd+K action surfaces under one flag (folded the retired cmd_k_actions duplicate)',
      'POST /api/cmdk — NL query ranked against 6 admin verbs, top 20 scored suggestions',
      'POST /api/cmdk/resolve — NL phrase → typed navigation, bulk-mutation, or agent action',
      'Off → both routes 404, Cmd+K stays a plain navigation palette',
    ],
    explanation:
      'The single flag for Cmd+K natural-language actions (the duplicate cmd_k_actions flag was folded in 2026-08-14). POST /api/cmdk scores the org sites against 6 admin verbs (rebuild/snapshot/delete/view/edit/publish) and returns up to 20 ranked suggestions; POST /api/cmdk/resolve maps a typed phrase to a structured navigation, bulk-mutation, or agent action via Workers AI. When off, both routes 404 and Cmd+K stays a plain navigation palette.',
    smoke_test: [
      'Enable flag → POST /api/cmdk {"q":"rebuild njsk"} → 200 with scored suggestions (empty query returns defaults)',
      'Type "publish all draft sites" → POST /api/cmdk/resolve → a typed bulk action',
      'Disable the flag → both /api/cmdk and /api/cmdk/resolve 404',
    ],
  },
  core_admin_detail: {
    checklist: [
      'Admin split-view: sections nav + selected section',
      'Persistent bolt.diy iframe (one WebContainer cold-boot per session)',
      'SPA navigation — no full reload',
      'Always-on sentinel — isFlagOn always true',
    ],
    e2e_tests: [
      'e2e/_fortress/admin-detail/happy-path.spec.ts',
      'e2e/_fortress/admin-detail/adversarial.spec.ts',
    ],
    explanation:
      'Always-on admin site-detail split-view: left rail = sections nav, right = the selected section (sites, media, forms, editor, etc.). isFlagOn always true (sentinel). The persistent bolt.diy iframe lives in the admin shell so WebContainer cold-boot happens once per session.',
    smoke_test: [
      'Open /admin → app-root + sidebar render',
      'Project-select resolves a site → per-site sections load their real data',
      'Navigate sections via routerLink → no full reload (SPA sentinel holds)',
    ],
  },
  // ── Core always-on surfaces + fortress-backed flags ───────────────────────
  core_auth: {
    checklist: [
      'Passwordless magic-link (Amazon SES / SendGrid)',
      'Google OAuth (PKCE)',
      'Session cookies; magic links single-use, 15-min TTL',
      'Always-on sentinel — isFlagOn always true',
    ],
    e2e_tests: ['e2e/_fortress/auth/happy-path.spec.ts', 'e2e/_fortress/auth/adversarial.spec.ts'],
    explanation:
      'Always-on auth surface: passwordless magic-link (Amazon SES/SendGrid) + Google OAuth + session cookies. isFlagOn always returns true (sentinel). Sessions resolve userId/orgId in the auth middleware without rejecting unauthed requests — route guards decide access. Magic links are single-use, 15-min TTL; OAuth uses PKCE state in oauth_states.',
    smoke_test: [
      "Homepage → Sign in → enter email → 'check your inbox' state shows",
      'POST /api/auth/magic-link {email} → 200 + magic_links row created',
      'GET /api/auth/magic-link/verify?token=… → sets session cookie → redirects to /admin',
      'GET /api/auth/me with the cookie → returns {user, org}',
    ],
  },
  core_billing: {
    checklist: [
      'Stripe Checkout + subscriptions + entitlements + billing portal',
      'Donation payouts',
      'Webhook-driven, idempotent',
      'Always-on sentinel — isFlagOn always true',
    ],
    e2e_tests: [
      'e2e/_fortress/billing/happy-path.spec.ts',
      'e2e/_fortress/billing/adversarial.spec.ts',
    ],
    explanation:
      'Always-on Stripe billing surface: checkout, subscriptions, entitlements, billing portal, and donation payouts. isFlagOn always true (sentinel). Webhook-first with idempotent processing; entitlements gate the per-site Features plane.',
    smoke_test: [
      'POST /api/billing/checkout → returns a Stripe Checkout session URL',
      'GET /api/billing/entitlements → plan entitlement set',
      'POST /webhooks/stripe with a valid signature → subscription state updates (duplicate event ignored)',
    ],
  },
  core_feature_flags: {
    checklist: [
      'Lists every registry flag with default state + stage',
      'Search + stage filter + per-flag detail (resolved state + docs + checklist)',
      'Override mutations: global / org / tenant',
      'Always-on sentinel — the control plane can’t be flagged off',
    ],
    e2e_tests: [
      'e2e/_fortress/feature-flags/happy-path.spec.ts',
      'e2e/_fortress/feature-flags/adversarial.spec.ts',
    ],
    explanation:
      "Always-on feature-flags admin UI at /admin/feature-flags: lists every registry flag with default state + stage, search + stage filter, per-flag detail (resolved state + docs + checklist), and override mutations (global/org/tenant). isFlagOn always true (sentinel) — the control plane can't be flagged off.",
    smoke_test: [
      'GET /api/feature-flags → returns the full registry with has_docs',
      "/admin/feature-flags → search 'auth' filters the list; stage pills filter by stage",
      'Click a flag → GET /api/feature-flags/:key → detail shows resolved state + docs (checklist/explanation/smoke_test/e2e_tests)',
      'POST /api/admin/feature-flags/:key/override → flips state; KV cache invalidates immediately',
    ],
  },
  core_site_create: {
    checklist: [
      'Homepage funnel: search → select → sign in → details → build',
      'create-from-search seeds a site row + starts SITE_WORKFLOW',
      'Drives the golden path',
      'Always-on sentinel — isFlagOn always true',
    ],
    e2e_tests: [
      'e2e/_fortress/site-create/happy-path.spec.ts',
      'e2e/_fortress/site-create/adversarial.spec.ts',
    ],
    explanation:
      'Always-on homepage site-creation funnel: search business → select → sign in → provide details/upload → AI build workflow kicks off. isFlagOn always true (sentinel). Drives the golden path; the create-from-search endpoint seeds a site row + starts the SITE_WORKFLOW.',
    smoke_test: [
      'Homepage → search a business name → results render in <1s',
      'Select a result → sign-in gate → details form',
      'POST /api/sites/create-from-search → 200 + site row (status=draft) + workflow_jobs row',
      'Redirect to /waiting → real-time build progress',
    ],
  },
  credit_wallet_rollover: {
    checklist: [
      'AI-credit wallet with monthly rollover',
      'Promo credit grants stack on top',
      'Expiring balances surface urgency in the billing wallet',
      'Read model over the credits ledger',
    ],
    explanation:
      'Extends the AI-credit wallet with rollover — unused monthly credits carry forward, promo grants stack, and expiring balances surface urgency in the billing wallet. Computed over the credits ledger; the wallet UI shows current, rolled-over, promo, and expiring buckets. When off, the wallet shows the flat monthly balance only and the rollover route 404s.',
    smoke_test: [
      'GET /api/billing/wallet → {balance, rolled_over, promo, expiring:[{amount, expires_at}]}',
      'Spend less than the monthly grant → next period’s wallet shows the carried-forward credits',
      'Disable the flag → the rollover fields drop, the route 404s',
    ],
  },
  editor_vision_qa: {
    checklist: [
      'In-editor live AI vision critique while editing (not just post-build)',
      'Browser-Rendering screenshot → vision model scores layout / contrast / brand 0-10',
      'Inline fix suggestions per finding',
      'Distinct from the batch snapshot-quality workflow',
    ],
    explanation:
      'Real-time in-editor AI vision critique (merged from the brand-new set). On demand it screenshots the current editor preview via Cloudflare Browser Rendering, scores layout / contrast / brand 0-10 with a vision model, and surfaces inline fix suggestions — distinct from the post-build snapshot-quality workflow which scores asynchronously after publish.',
    smoke_test: [
      'POST /api/sites/:id/vision-qa {preview_url} → {score, findings[]}',
      'Each finding carries a category (layout/contrast/brand) + a suggested fix',
    ],
  },
  email_deliverability_wizard: {
    checklist: [
      'Checks a sending domain SPF + DKIM + DMARC via DNS-over-HTTPS',
      'Returns a 0-100 deliverability score',
      'Concrete copy-paste DNS fixes',
      'Read-only — persists nothing',
    ],
    e2e_tests: ['e2e/admin/deliverability.spec.ts'],
    explanation:
      'Email Deliverability Wizard (#12): checks a sending domain SPF, DKIM and DMARC via DNS-over-HTTPS and returns a 0-100 score plus concrete DNS fixes. Read-only, persists nothing.',
    smoke_test: [
      'POST /api/email-deliverability {domain} → {score, spf, dkim, dmarc, fixes[]}',
      'A domain missing DMARC → score drops + a fix record appears',
    ],
  },
  lead_scanner: {
    checklist: [
      'POST /api/admin/leads/scan — Places-first, FREE OSM/Nominatim fallback discovery',
      'Keeps the no-website businesses (the scanner’s purpose)',
      'Persists each as a claim-able lead via createLead (place_id-deduped)',
      'Returns a scan summary (scanned / created / skipped / errors) + source + degraded note',
      'Outreach send is a separate, explicitly-enabled step — never auto-sends',
    ],
    explanation:
      'Super-Admin lead scanner. A free-text query (e.g. "roofers newark nj") discovers businesses via Google Places Text Search first; when Places returns nothing (its API key is billing-dead — REQUEST_DENIED), the worker falls back to a FREE chain: parse the category phrase → geocode the place via Nominatim → Overpass query for businesses WITHOUT a website tag (4 mirrors, UA-identified, rate-limit backoff). Results are scored (no-website, signals, priority) and persisted as claim-able leads via createLead — deduped by place_id within the batch and by a unique index across batches. `source` tags provenance (google_places|osm); `degraded` carries an honest failure note instead of a lying "scanned 0". Read-and-create only: it never sends outreach. Live-verified 2026-08-19 via e2e/admin-verify/verify-lead-scanner.mjs (Brooklyn salons 200, Phoenix auto repair 200, Newark restaurants 200 — all no-website, osm-sourced).',
    smoke_test: [
      'POST /api/admin/leads/scan {query:"hair salons in Brooklyn NY"} → 200 {summary.scanned:200, summary.created:200, source:"osm"}',
      'GET /api/admin/leads?onlyNoWebsite=true → the created businesses appear (hasWebsite:false, source:"osm")',
      'Re-run the same query → created stays flat (place_id dedupe), no duplicate leads',
      'POST with a 1-char query → 400 VALIDATION_ERROR',
      'Disable the flag → the route 404s',
    ],
  },
  lead_enrichment_paid: {
    checklist: [
      'POST /api/admin/leads/:id/enrich — deep-discovers website / phone / email / socials for one lead',
      'FREE tier always runs: OSM contact tags (captured at scan) + best-effort homepage + DuckDuckGo parse',
      'PAID tier (this flag ON + LEAD_ENRICHMENT_API_URL/KEY set) merges a paid provider result, highest priority',
      'Flag OFF (default) → free discovery only; the paid provider is never called and never errors',
      'Operator-only (super-admin); enrich endpoint also gated by lead_scanner',
    ],
    explanation:
      'Paid contact-enrichment tier for the Super-Admin Lead Scanner. The enrich endpoint (POST /api/admin/leads/:id/enrich) always runs a FREE discovery pass — OSM contact:* tags already captured at scan time, a best-effort homepage fetch/parse, and a DuckDuckGo lookup for the business’s website + social profiles — then folds the result into the lead (website / phone / email / socials columns + profile_json). When THIS flag is ON and both LEAD_ENRICHMENT_API_URL and LEAD_ENRICHMENT_API_KEY are set, a paid provider is also queried and merged at highest priority. Default OFF keeps the surface free + never spends. Every source is wrapped never-throw, so a blocked search or a down provider degrades to a partial bundle rather than an error. Turning the flag OFF instantly stops all paid lookups with no redeploy.',
    smoke_test: [
      'Flag OFF (default): POST /api/admin/leads/:id/enrich → 200 {contact,updated:true} using free discovery only',
      'The lead row now shows any discovered phone/website/socials in /admin/leads (Contact + Social columns)',
      'Flag ON + no provider secrets: still free-only (paid skipped, no error)',
      'Enrich a non-existent lead id → 404 NOT_FOUND',
      'Non-operator or lead_scanner OFF → 404 (never 403 leak)',
    ],
  },
  marketing_dashboard: {
    checklist: [
      'Widget-based analytics dashboard: 11 default widgets across 6 sources (website/email/social/ads/crm/booking)',
      'ON -> GET /api/sites/:id/dashboard returns widget config + metrics; POST .../metric adds a metric',
      'OFF (default) -> both routes 404',
      'Source filter (?sources=) narrows the returned widgets',
    ],
    explanation:
      'Owner-facing marketing dashboard aggregating widgets across website, email, social, ads, CRM and booking sources. When ON, GET/POST /api/sites/:id/dashboard serve + mutate the widget config; when OFF (default) they 404. The non-website sources make it an SMB-suite surface beyond the core site builder.',
    smoke_test: [
      'Flag ON: GET /api/sites/:id/dashboard returns 11 default widgets',
      'Flag ON: ?sources=website,email filters the widget set',
      'Flag ON: POST /api/sites/:id/dashboard/metric adds a metric',
      'Flag OFF (default): both routes 404',
    ],
  },
  // ── Restored 2026-08-13 (1:1 with registry.ts): docs for the 33 over-pruned dark-launch flags.
  mcp_server: {
    checklist: [
      'Platform MCP discovery at /.well-known/mcp',
      '5 tools: list_sites / create_site / deploy_site / get_site_metrics / regenerate_section',
      'OAuth 2.1 + RFC 8707 resource indicators',
      'Connect from Claude / Cursor / Windsurf',
      'Stable',
    ],
    e2e_tests: ['e2e/mcp/mcp-providers.spec.ts'],
    explanation:
      'Model Context Protocol server discovery at /.well-known/mcp. Lists 5 tools (list_sites, create_site, deploy_site, get_site_metrics, regenerate_section). Claude / Cursor / Windsurf users connect their projectsites account via MCP. OAuth 2.1 + RFC 8707 Resource Indicators at /.well-known/oauth-protected-resource. Stage=stable.',
    smoke_test: [
      'curl https://projectsites.dev/.well-known/mcp → 200 JSON with tools[] array',
      'curl https://projectsites.dev/.well-known/oauth-protected-resource → 200 JSON with resource + authorization_servers + scopes_supported',
    ],
  },
  model_registry: {
    checklist: [
      'OpenAI-compatible GET /v1/models catalog',
      'ProviderCapabilityRegistry + ModelAliasRegistry',
      'Aliases: deepseek / anthropic / openai / gemini / grok / workers-ai',
      'Per-provider availability gating (key present → listed)',
      'Workload-aware AI router (POST /api/router/pick + GET /api/router/stats), same flag',
    ],
    explanation:
      'Serves an OpenAI-compatible GET /v1/models catalog backed by the ProviderCapabilityRegistry + ModelAliasRegistry — the deepseek / anthropic / openai / gemini / grok / workers-ai alias map with per-provider availability gating (a provider only lists its models when its key is configured). This one flag also gates the workload-aware AI router (the standalone ai_auto_router duplicate was folded in 2026-08-14): POST /api/router/pick classifies a prompt and picks the cheapest sufficient model, GET /api/router/stats reports savings vs an always-Opus baseline. When off, /v1/models and both /api/router/* routes 404.',
    smoke_test: [
      'GET /v1/models → {object:"list", data:[{id, owned_by, …}]} for configured providers only',
      'POST /api/router/pick {"prompt":"Add a pricing section"} → {classification, picked_model, estimated_cost_usd, alternatives}',
      'Disable the flag → /v1/models and /api/router/* all 404',
    ],
  },
  onboarding_copilot: {
    checklist: [
      'PLG activation checklist for a new org',
      'Computes next-best actions (create → publish → custom domain)',
      'Per-step completion state + a dismiss control',
      'Drives time-to-first-published-site down',
    ],
    explanation:
      'Product-led-growth activation checklist that computes a new org’s next-best actions — create a site, publish it, add a custom domain — with per-step completion state and a dismiss control. Shortens time-to-first-published-site, the key activation metric. Read-only over existing org state. When off, the route 404s and no checklist renders.',
    smoke_test: [
      'GET /api/onboarding/checklist → {steps:[{id, done, cta_href}], dismissed}',
      'Publish a site → re-fetch → the publish step flips to done',
      'Disable the flag → the checklist route 404s',
    ],
  },
  outbound_webhooks: {
    checklist: [
      'Customers subscribe their own https endpoints to site events',
      'Deliveries HMAC-signed + replay-safe',
      'Retried with backoff',
      'Endpoint secret AES-GCM encrypted at rest',
    ],
    e2e_tests: ['e2e/webhook/webhooks.spec.ts'],
    explanation:
      'Outbound Webhooks (#10): customers subscribe their own https endpoints to site events; deliveries are signed (HMAC, replay-safe) + retried with backoff. Endpoint secret AES-GCM encrypted at rest. CRUD at /api/sites/:siteId/webhooks.',
    smoke_test: [
      'POST /api/sites/:siteId/webhooks {url, events[]} → 201 + signing secret',
      'Trigger a site event → endpoint receives a signed POST; bad sig is rejected',
    ],
  },
  payments_rail: {
    checklist: [
      'Unified payments seam over Square (accept) + Stripe (SaaS/payouts)',
      'One idempotency key, one webhook verifier',
      'Single entitlement-grant path per rules/payments-routing',
      'Provider chosen by money-flow, not per-feature',
    ],
    explanation:
      'A unified payments seam that routes accept-money through Square Web Payments and SaaS billing / payouts through Stripe, behind one idempotency key, one webhook verifier, and a single entitlement-grant path (per rules/payments-routing). Features call the rail, not a provider directly, so the routing decision lives in one place. When off, the rail endpoints 404.',
    smoke_test: [
      'POST /api/payments/intent {amount_cents, purpose} → provider-routed intent + idempotency key',
      'Replay the same idempotency key → the same intent is returned, no double-charge',
      'Disable the flag → the rail routes 404',
    ],
  },
  preview_share_card: {
    checklist: [
      'Honest, slop-free share messages (SMS / WhatsApp / email / copy)',
      'One-tap platform deep-links (SMS, WhatsApp, mailto, X, Facebook), URL-encoded',
      'OG-card params (title / subtitle / host / theme) for the edge renderer',
      'Free-tier owner viral loop — the shared link is the ad',
    ],
    explanation:
      'Owner-driven viral loop. After a build the owner gets pre-written share copy, one-tap platform deep-links, and OG-card params for a branded 1200x630 card, so they share their new site to real customers in seconds. Pure builder over the site slug + business name; XSS-safe substitution; degrades gracefully when a field is missing.',
    smoke_test: [
      'GET /api/sites/:siteId/share-card → {messages, links:{sms,whatsapp,email,x,facebook,copy}, og}',
      'links.copy === https://<slug>.projectsites.dev',
      'Unauth → 401; flag off → 404; not-owned siteId → 404',
      'UI (follow-on): build-complete "Share my preview" button renders the deep-links + OG card',
    ],
  },
  prompt_studio: {
    checklist: [
      'Admin surface over the existing prompt registry',
      'Versioned templates with A/B variants',
      'KV hot-patch without a redeploy',
      'One-click rollback for non-engineers',
    ],
    explanation:
      'An admin surface over the existing prompt registry: versioned templates with A/B variants, KV hot-patching that takes effect without a redeploy, and one-click rollback so non-engineers can tune prompts safely. Reads and writes the same registry the build pipeline consumes. When off, the studio routes 404 and prompts are edited in code only.',
    smoke_test: [
      'GET /api/admin/prompts → versioned templates with active variant',
      'Hot-patch a template via the studio → the next generation uses it with no redeploy; rollback restores the prior version',
      'Disable the flag → the studio routes 404',
    ],
  },
  referral_loop: {
    checklist: [
      'In-product refer-a-friend with tracked codes/links',
      'Attributed signups from a referral code',
      'Credit rewards granted through the wallet on conversion',
      'Per-org referral dashboard',
    ],
    explanation:
      'In-product refer-a-friend: each org gets tracked referral codes and links, signups are attributed to the referrer, and a credit reward is granted through the wallet (credit_wallet_rollover) on a referred conversion. A growth loop with an in-app referral dashboard. When off, the referral routes 404 and no code is issued.',
    smoke_test: [
      'GET /api/referrals/code → the org’s referral code + share link',
      'Sign up via ?ref=CODE then convert → the referrer’s wallet receives the reward credit',
      'Disable the flag → the referral routes 404',
    ],
  },
  site_analytics: {
    checklist: [
      'Owner-facing per-site analytics summary',
      'Aggregates contacts, form submissions, subscribers + donations',
      'Traffic block fed by the visitor-events beacon',
      'When off, /api/sites/:id/analytics returns 404',
    ],
    e2e_tests: ['e2e/admin/analytics.spec.ts'],
    explanation:
      "Owner-facing per-site analytics dashboard. Aggregates the contacts core, form submissions, newsletter subscribers and donations into one summary, plus a traffic block fed by visitor_events_core. Read-only; never exposes another tenant's numbers (site-scoped query). When off the route 404s (never 403 — don't leak existence).",
    smoke_test: [
      'GET /api/sites/:id/analytics → {contacts, submissions, subscribers, donations, traffic}',
      'Submit a form on the published site → counts increment within the refresh window',
      'Disable the flag → the route 404s',
    ],
  },
  site_doctor: {
    checklist: [
      'Owner-facing A–F site health report with a 0-100 score',
      'Prioritized, plain-English one-tap fixes (severity-ranked)',
      'Generous-free lock: free sees the top issue, rest locked behind Pro',
      'Reuses production-readiness signals — no duplicate scoring',
    ],
    explanation:
      'Owner-facing health report card — translates the production-readiness signals (published / custom domain / performance / sitemap) into an A–F grade plus prioritized, plain-English fixes. Free plan unlocks the top issue; the rest carry locked:true (the analytics_pro/paid upsell). Sharp, professional voice; pure scoring + lock core.',
    smoke_test: [
      'GET /api/sites/:siteId/doctor?plan=free → {grade, score, issues:[{locked:false},{locked:true}…], locked_count}',
      'GET …?plan=pro → every issue locked:false, locked_count:0',
      'Unauth → 401; flag off → 404; not-owned siteId → 404',
      'UI: "Site Health" tab (?tab=health) renders the grade + fixes + Unlock-with-Pro on locked rows',
    ],
  },
  social_autopilot: {
    checklist: [
      'KILL-SWITCH (defaults ENABLED) for Pulse Social Auto-Pilot AI cron',
      'Gates POST /api/social/auto-pilot/run-now',
      'Off → 503 FEATURE_DISABLED; manual compose + read-only preview unaffected',
      'Flip the global override off to halt autonomous AI posting without a redeploy',
    ],
    explanation:
      'Operator kill-switch for Pulse Social Auto-Pilot (the AI cron generating + scheduling drafts per network). Defaults ENABLED (rollout 100, stable). An operator flips the global override off to instantly halt all autonomous posting — e.g. the AI is generating off-brand content — with no redeploy. When off, run-now returns 503 FEATURE_DISABLED; manual compose/schedule and the read-only preview are unaffected.',
    smoke_test: [
      'Flag on (default) → POST /api/social/auto-pilot/run-now → 200 (or 409 if no networks)',
      'Set global override enabled=false → same call → 503 FEATURE_DISABLED',
      'Re-enable → 200 again',
    ],
  },
  social_publishing: {
    checklist: [
      'KILL-SWITCH (defaults ENABLED) for Pulse Social publishing',
      'Gates POST /api/social/posts/:id/schedule + /publish-now (SocialPublishWorkflow dispatch)',
      'Off → 503 FEATURE_DISABLED; composing/drafting unaffected',
      'Flip the global override off to halt all publishing without a redeploy',
    ],
    explanation:
      'Operator kill-switch for Pulse Social post publishing. Defaults ENABLED (rollout 100, stable) so live behavior is unchanged; the flag exists so an operator can instantly DISABLE the two publish-dispatch endpoints (schedule + publish-now) — e.g. a publisher is mis-posting or a platform API is down — by flipping the global override off, with no redeploy. When off the endpoints return 503 FEATURE_DISABLED (a known feature being halted — clearer than a 404). Drafting/composing still works.',
    smoke_test: [
      'Flag on (default) → POST /api/social/posts/:id/publish-now → 200, workflow runs',
      'Set global override enabled=false → same call → 503 FEATURE_DISABLED',
      'Re-enable → 200 again (no redeploy)',
    ],
  },

  social_publishing_native: {
    checklist: [
      'Native social posting (instant + scheduled) across 14 platforms on CF primitives',
      'ANCHOR flag: also gates the folded social_agent (content proposals + engagement scoring)',
      'ON -> /api/sites/:id/social/* proposal + publishing surfaces resolve',
      'OFF (default) -> the social surfaces 404',
    ],
    explanation:
      'Native social publishing on CF primitives (D1 + Upstash + Workflows v2 + MCP OAuth). Group ANCHOR flag: the social_agent content-proposal module folds under it, so one flag toggles the whole native-social area. Off-vision relative to the core site builder -- it is the Social expansion.',
    smoke_test: [
      'Flag ON: POST /api/sites/:id/social/proposals returns platform-aware content proposals',
      'Flag ON: the native social publishing surface accepts an instant + a scheduled post',
      'Flag OFF (default): the social surfaces 404',
    ],
  },
  system_status: {
    checklist: [
      '6 integration health targets',
      '5s timeout per probe',
      'Parallel aggregation via Promise.all',
      'Returns overall + per-integration status',
    ],
    explanation:
      'Aggregated health checks for all platform integrations (Listmonk, LiteLLM, Twenty, Payload, Chatwoot). Each probe runs independently with a 5-second timeout. Results are never cached — real-time status strip for the admin top bar.',
    smoke_test: [
      'Enable flag → GET /api/system/status → 200 with overall+integrations array',
      'Each integration has status (healthy/degraded/down/unknown) + latencyMs',
      'Overall is "healthy" when all probes pass',
    ],
  },
  token_burn_meter: {
    checklist: [
      'Live monthly AI-token spend chip in the editor header',
      'Per-model breakdown (Opus / Sonnet / Workers AI / GPT-5)',
      'Month-end projection from current pace',
      'Warns at 80% and 100% of the tier cap',
    ],
    explanation:
      'Live monthly AI-token burn meter shown in the editor header. Tracks per-model spend (Opus / Sonnet / Workers AI / GPT-5), projects the month-end total based on current pace, and warns at 80% / 100% of the customer\'s tier cap. Solves Bolt.new + V0\'s #1 complaint in 2026: token-burn rage ("$1000+ spent fixing issues" — NxCode).',
    smoke_test: [
      'GET /api/usage/burn?org_id=demo-org → returns {used_usd, used_tokens, projected_monthly_usd, by_model, thresholds:[{pct:80}, {pct:100}]}',
      "POST /api/usage/record with body {org_id:'demo-org', model:'claude-sonnet-4-6', input_tokens:1000, output_tokens:500} → returns event id + USD cents",
      'Repeat the POST several times — GET /api/usage/burn should reflect cumulative spend',
      'UI: editor header chip shows live "$X / $Y this month" with projection — click expands per-model breakdown modal',
    ],
  },
  visual_automation: {
    checklist: [
      'Journey validation engine: 7 action types, 6 trigger types, linear journey validation with error reporting',
      'ON -> POST /api/sites/:id/automation/validate checks a journey definition',
      'OFF (default) -> the route 404s',
      'Validation only: reports structural errors + step-delay estimates, does not execute journeys',
    ],
    explanation:
      'Validates visual-automation journey definitions: 7 action types and 6 trigger types, linear-journey structural validation, and step-delay estimation. When ON, POST /api/sites/:id/automation/validate returns validation results; when OFF (default) it 404s. It validates journeys rather than running them.',
    smoke_test: [
      'Flag ON: POST /api/sites/:id/automation/validate with a valid journey returns ok',
      'Flag ON: an invalid journey returns structured validation errors',
      'Flag OFF (default): the route 404s',
    ],
  },
  wireframe_planning: {
    checklist: [
      'Pre-generation sitemap + page-level wireframe plan',
      'Surfaced as an approval gate in /create',
      'Catches IA problems before section generation',
      'Owner edits the plan before building',
    ],
    explanation:
      'Surfaces a sitemap plus page-level wireframe plan as an approval gate in /create BEFORE section generation, so information-architecture problems are caught up front instead of after a full build. The owner reviews and edits the plan, then approves to generate. When off, /create generates directly without the planning gate.',
    smoke_test: [
      'Start a build in /create → the sitemap + wireframe plan renders for approval',
      'Edit the plan and approve → generation follows the approved structure',
      'Disable the flag → /create skips the planning gate and generates directly',
    ],
  },
};

export function getDocs(key: string): FlagDocs | undefined {
  const base = FLAG_DOCS[key];
  if (!base) return undefined;
  // Merge the auto-folded E2E labels + screenshots (defined below) so the spec
  // sheet shows the runnable parallel coverage + captioned UI shots.
  const extra = FLAG_SPEC_EXTRAS[key];
  return extra ? { ...base, ...extra } : base;
}

/**
 * Auto-folded E2E check labels (mirroring the parallel runner's CHECK_REGISTRY) +
 * captioned UI screenshots per flag. Merged over FLAG_DOCS by the worker's
 * GET /api/feature-flags/:key so the spec sheet shows runnable coverage + shots.
 */
export const FLAG_SPEC_EXTRAS: Record<string, Pick<FlagDocs, 'e2e_tests' | 'screenshots'>> = {
  abuse_takedown: {
    e2e_tests: [
      'POST /api/abuse/report returns 404 when flag OFF (expected in prod)',
      'GET /api/abuse/reports (super-admin queue) 404s when OFF',
      'Admin shell renders (operator review-queue host surface)',
    ],
  },
  activity_feed: {
    e2e_tests: [
      'GET /api/activity returns 404 when flag OFF (expected in prod)',
      'GET /api/mru (same flag) 404s when OFF',
      'Admin dashboard renders; recent-activity self-hides when flag off',
    ],
    screenshots: [
      {
        alt: 'Dashboard Recent Activity widget (visible only when flag on + entries exist)',
        caption: 'Dashboard Recent Activity widget (visible only when flag on + entries exist)',
        url: '/assets/flag-shots/activity_feed-1.png',
      },
    ],
  },
  ai_gateway_guardrails: {
    e2e_tests: [
      'POST /api/guardrails/check returns 404 when flag OFF (killswitch/expected)',
      'Route is mounted (not a soft-404 SPA shell)',
      'Admin shell renders (guardrails is backend-only, no UI)',
    ],
  },
  app_launcher: {
    e2e_tests: [
      'Apps admin catalog shell renders (passes today)',
      'Apps catalog endpoint returns catalog when app_launcher ON (default_enabled true)',
      'Apps lifecycle filter control present in section',
      'Feature Flags admin lists app_launcher',
    ],
    screenshots: [
      {
        alt: 'Apps section: catalog grid with search, lifecycle filters, and category menu',
        caption: 'Apps section: catalog grid with search, lifecycle filters, and category menu',
        url: '/assets/flag-shots/app_launcher-1.png',
      },
    ],
  },
  audit_trail_export: {
    e2e_tests: [
      'GET /api/audit/export returns 404 when flag OFF (expected in prod)',
      'CSV export path 404s when OFF (route mounted, not soft-404)',
      'Admin Audit section renders (in-app audit-log host surface)',
    ],
  },
  batch_operations: {
    e2e_tests: [
      'POST /api/batch returns 404 when flag OFF (expected in prod)',
      'POST /api/sites/compare (same flag) 404s when OFF',
      'Admin shell renders (bulk-ops section was removed from nav)',
    ],
  },
  better_auth: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Legacy auth serves while flag OFF — /api/auth/sign-up/email not the live path (expect non-200)',
      'Admin auth-security session UI renders (adjacent surface)',
    ],
  },
  cmdk_ai_actions: {
    e2e_tests: [
      'POST /api/cmdk (suggestions) returns 404 when flag OFF (expected in prod)',
      'POST /api/cmdk/resolve (AI resolve) returns 404 when flag OFF (expected in prod)',
      'Both routes are mounted (not a soft-404 SPA shell)',
      'Command palette opens client-side (does not consume these endpoints)',
    ],
  },
  core_admin_detail: {
    e2e_tests: [
      'Site-detail split view renders',
      'Per-site logs endpoint',
      'Feature-flags API lists the sentinel',
      'Health endpoint (passes today)',
    ],
  },
  core_auth: {
    e2e_tests: [
      'Sign-in page renders',
      'Auth me endpoint responds (unauth ok)',
      'Feature-flags API lists the sentinel',
      'Health endpoint (passes today)',
    ],
  },
  core_billing: {
    e2e_tests: [
      'Entitlements endpoint',
      'Subscription status endpoint',
      'Billing admin page renders',
      'Health endpoint (passes today)',
    ],
  },
  core_feature_flags: {
    e2e_tests: [
      'Feature-flags registry API',
      'Single-flag detail',
      'Feature-flags admin UI renders',
      'Health endpoint (passes today)',
    ],
  },
  core_site_create: {
    e2e_tests: [
      'Homepage renders the funnel',
      'Business search endpoint (public)',
      'Pre-built site search (public)',
      'Health endpoint (passes today)',
    ],
  },
  credit_wallet_rollover: {
    e2e_tests: [
      'credits balance route flag-gated OFF today → 404',
      'admin billing page loads (wallet widget self-hides when flag off)',
      'registry entry present for credit_wallet_rollover',
      'credits apply route flag-gated OFF today → 404',
    ],
  },
  editor_vision_qa: {
    e2e_tests: [
      'Vision-QA endpoint gated — 404 when editor_vision_qa OFF (default)',
      'Feature Flags admin lists editor_vision_qa (passes today)',
      'Editor admin shell reachable (baseline)',
    ],
  },
  email_deliverability_wizard: {
    e2e_tests: [
      'Deliverability admin shell renders (passes today, shows flag-gate notice when off)',
      'Deliverability endpoint gated — 404 when email_deliverability_wizard OFF (default)',
      'Flag-gate notice present in deliverability section when off',
      'Feature Flags admin lists email_deliverability_wizard',
    ],
    screenshots: [
      {
        alt: 'Deliverability wizard section: domain input, check button, and flag-gate notice / score',
        caption:
          'Deliverability wizard section: domain input, check button, and flag-gate notice / score',
        url: '/assets/flag-shots/email_deliverability_wizard-1.png',
      },
    ],
  },
  lead_scanner: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Scan route 404s while flag OFF (default off)',
      'Admin Leads section renders scan form (super-admin)',
      'Leads empty-state / submit control present',
      'Live scan populated (e2e/admin-verify/verify-lead-scanner.mjs — 3 queries, real OSM leads)',
    ],
    screenshots: [
      {
        alt: 'Lead scanner query input + only-no-website toggle + submit',
        caption: 'Lead scanner query input + only-no-website toggle + submit',
        url: '/assets/flag-shots/lead_scanner-1.png',
      },
    ],
  },
  marketing_dashboard: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Dashboard endpoint 404s while flag OFF (default)',
      "Admin shell renders (AI dashboard, not this flag's UI)",
    ],
  },
  mcp_server: {
    e2e_tests: [
      'MCP discovery document (public)',
      'OAuth protected-resource metadata',
      'Platform MCP JSON-RPC endpoint live (flag on)',
      'Health endpoint (passes today)',
    ],
  },
  model_registry: {
    e2e_tests: [
      'GET /v1/models flag-gated OFF today → 404',
      'POST /api/router/pick flag-gated OFF today → 404 (folded ai_auto_router)',
      'GET /api/router/stats flag-gated OFF today → 404',
      'registry entry present for model_registry',
      'worker health responds',
      'unknown /v1 path stays 404 (not SPA soft-200)',
    ],
  },
  onboarding_copilot: {
    e2e_tests: [
      'checklist route flag-gated OFF today → 404',
      'admin dashboard loads (checklist self-hides when flag off)',
      'registry entry present for onboarding_copilot',
      'dismiss route flag-gated OFF today → 404',
    ],
  },
  outbound_webhooks: {
    e2e_tests: [
      'Webhooks Settings tab renders (passes today, flag-gate notice when off)',
      'Webhooks list endpoint gated — 404 when outbound_webhooks OFF (default)',
      'Webhook deliveries endpoint gated — 404 when OFF (default)',
      'Feature Flags admin lists outbound_webhooks',
    ],
    screenshots: [
      {
        alt: 'Webhooks tab under Settings: endpoint URL + events form or flag-gate notice',
        caption: 'Webhooks tab under Settings: endpoint URL + events form or flag-gate notice',
        url: '/assets/flag-shots/outbound_webhooks-1.png',
      },
    ],
  },
  payments_rail: {
    e2e_tests: [
      'POST /api/payments/intent flag-gated OFF today → 404',
      'GET /api/payments/methods flag-gated OFF today → 404',
      'registry entry present for payments_rail',
      'worker health responds',
    ],
  },
  preview_share_card: {
    e2e_tests: [
      'share-card unauth → 401 (flag gate is behind auth check)',
      'registry entry present for preview_share_card',
      'worker health responds',
      'marketing homepage renders',
    ],
  },
  prompt_studio: {
    e2e_tests: [
      'templates route unauth → 401 (flag gate behind auth)',
      'registry entry present for prompt_studio',
      'worker health responds',
      'admin shell loads',
    ],
  },
  referral_loop: {
    e2e_tests: [
      'referral code route flag-gated OFF today → 404',
      'admin dashboard loads (referral card self-hides when flag off)',
      'registry entry present for referral_loop',
      'referral stats route flag-gated OFF today → 404',
    ],
  },
  site_analytics: {
    e2e_tests: [
      'Owner analytics summary endpoint',
      'Daily analytics series',
      'Analytics admin dashboard renders',
      'Health endpoint (passes today)',
    ],
  },
  site_doctor: {
    e2e_tests: [
      'Free-plan doctor report',
      'Pro-plan unlocks all issues',
      'Health sparkline (shared flag)',
      'Health endpoint (passes today)',
    ],
  },
  social_autopilot: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Admin Social auto-pilot prompt control renders',
      'Composer textarea present (manual compose unaffected by kill-switch)',
    ],
    screenshots: [
      {
        alt: 'Auto-Pilot prompt/run control gated by the social_autopilot kill-switch',
        caption: 'Auto-Pilot prompt/run control gated by the social_autopilot kill-switch',
        url: '/assets/flag-shots/social_autopilot-1.png',
      },
    ],
  },
  social_publishing: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Admin Social composer publish hint renders',
      'Composer textarea present (drafting works regardless of kill-switch)',
    ],
    screenshots: [
      {
        alt: 'Publish-now action + hint gated by the social_publishing kill-switch',
        caption: 'Publish-now action + hint gated by the social_publishing kill-switch',
        url: '/assets/flag-shots/social_publishing-1.png',
      },
    ],
  },
  social_publishing_native: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Native publish route 404s while flag OFF (default off in registry note; gate present)',
      'Admin Social composer shell renders',
      'Composer character counter present',
    ],
    screenshots: [
      {
        alt: 'Native social composer textarea + character counter',
        caption: 'Native social composer textarea + character counter',
        url: '/assets/flag-shots/social_publishing_native-1.png',
      },
      {
        alt: 'RSS import → drafts control on the composer',
        caption: 'RSS import → drafts control on the composer',
        url: '/assets/flag-shots/social_publishing_native-2.png',
      },
    ],
  },
  system_status: {
    e2e_tests: [
      'GET /api/system/status returns 404 when flag OFF (expected in prod)',
      'System status route is mounted (not a soft-404 SPA shell)',
      'Admin dashboard shell renders (host surface for the future status strip)',
    ],
  },
  token_burn_meter: {
    e2e_tests: [
      'AI Endpoints admin shell renders (passes today, flag-independent)',
      'Burn endpoint gated — 404 when token_burn_meter OFF (default)',
      'Record endpoint exists and is flag-gated (404 default-off)',
      'Feature Flags admin lists token_burn_meter',
    ],
    screenshots: [
      {
        alt: 'AI Endpoints section showing the token-burn budget meter (spend vs cap)',
        caption: 'AI Endpoints section showing the token-burn budget meter (spend vs cap)',
        url: '/assets/flag-shots/token_burn_meter-1.png',
      },
    ],
  },
  visual_automation: {
    e2e_tests: [
      'Public health endpoint 200 (always passes)',
      'Automation validate route 404s while flag OFF (default)',
      'Admin shell renders (flag has no dedicated UI)',
    ],
  },
  wireframe_planning: {
    e2e_tests: [
      'Feature-flags API lists the flag',
      'Flag detail resolves',
      'Flag appears in admin feature-flags UI',
      'Health endpoint (passes today)',
    ],
  },
};
