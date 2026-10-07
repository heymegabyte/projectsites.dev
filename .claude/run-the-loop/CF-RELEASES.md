# Cloudflare Release Scout — state + decisions

Owned by role 14 (Technology Scout), ~every 4 fires. Feeds: developers.cloudflare.com
available-RSS-feeds set (developer platform + product feeds + deprecations). Protocol:
dedupe by GUID → record source + publication date → inspect current docs → evaluate
fit/maturity/limits/cost/migration/security/measurable benefit → DECISION (pilot |
backlog | watch | reject-with-reason). Urgent deprecations jump the cadence. Feed outage
never blocks core verification. Browser API/platform changes also feed role 18's
capability registry.

Feed URLs (verified 2026-09-29): `changelog/rss/{index,developer-platform,workers,workers-for-platforms,d1,r2,kv,durable-objects,queues,workflows,ai-gateway,workers-ai,pages}.xml` + `fundamentals/api/reference/deprecations/index.xml`. No browser-rendering feed (404) — Browser Run items ride the aggregate.

## Seen GUIDs

GUID = `changelog/post/<slug>/` unless noted. Sweep 1 (fire-54, 2026-09-29) — 44 changelog + 10 deprecations:

- dev-platform: 2026-09-29-user-insights-task-analysis · 2026-09-29-concurrent-session-connections · 2026-09-29-remove-disk-to-memory-ratio · 2026-09-29-mesh-workers-vpc-network-logs · 2026-09-28-webmcp-api · 2026-09-28-cloudflare-cli-beta · 2026-09-27-workflow-ctx-exports · 2026-09-25-crawl-event-subscriptions · 2026-09-25-sending-domain-suppressions · 2026-09-25-custom-span-apis · 2026-09-25-release-flows-workers-metrics · 2026-09-24-r2-bandwidth-metrics · 2026-09-24-workflow-exports
- workflows: 2026-09-17-instance-delete · 2026-09-15-instance-event-subscriptions · 2026-09-10-paid-retention-default · 2026-08-04-build-and-deploy-on-push · 2026-07-09-dynamic-retry-delays · 2026-07-07-workflows-billing-updates · 2026-06-16-rollback-options · 2026-06-05-saga-rollbacks
- d1: 2026-09-01-d1-free-tier-limit-enforcement · 2026-06-04-billable-usage-product-sidebar · 2026-06-04-migrations-pattern
- durable-objects: 2026-09-24-durable-object-name-search-limit · 2026-09-17-javascript-rpc-session-spans · 2026-08-28-durable-objects-dynamic-workers-limit · 2026-08-25-durable-object-alarm-abort-no-retry · 2026-08-20-durable-objects-deployments-tab
- queues: 2026-07-15-event-subscriptions · 2026-05-19-event-subscriptions · 2026-04-28-improved-queues-metrics
- workers-ai: 2026-09-17-reject-if-busy · 2026-08-28-glm-5.3-workers-ai · 2026-08-26-glm-5.3-flash-workers-ai · 2026-08-17-qwen-3.8-27b-workers-ai · 2026-08-14-deepseek-v4-workers-ai
- wfp: 2025-12-18-dashboard-improvements · 2025-09-02-increased-static-asset-limits · 2025-06-17-workers-terraform-sdk-api-fixes · 2025-04-15-workers-api-fixes · 2025-04-08-fullstack-on-workers · 2025-02-20-synchronous-uploads · 2025-01-31-workers-platforms-static-assets
- deprecations (`fundamentals/api/reference/deprecations/#<anchor>`): zone-settings-batch-api · foundation-dns-boolean-setting · account-name-65-character-limit · account-roles-api · workers-kv-legacy-namespace-routes · zero-trust-networks-route-endpoints · ampsxg-api-and-rules · legacy-registrar-domain-management-api · gateway-audit-ssh-rules · service-key-authentication

## Decisions

### Sweep 1 — 2026-09-29 (fire-54)

**URGENT deprecations: NONE.** Legacy Registrar API (EOL 2026-09-27) verified NON-impacting — `services/cf_registrar.ts` already uses the NEW endpoints (`POST /registrar/domain-check` + `POST /registrar/registrations`), not the EOL'd `GET/PUT /registrar/domains{,/:name}`. Grep-verified zero usage of: KV legacy `/workers/namespaces` routes (EOL 10-15), `X-Auth-User-Service-Key` (EOL 09-30), zone-settings batch. Fixed stale `env.ts` comment that still cited the dead legacy register endpoint. Remaining 6 deprecations touch products we don't use.

- 2026-09-29 · **Browser Run multi-client sessions** · dev-platform — **PILOT** — attach journey driver + screenshot/console observer to ONE session; kills per-client cold start for Deep UI Explorer + long-trail runs. BACKLOG § cf-releases.
- 2026-09-25 · **Workers tracing custom span APIs** (startSpan/recordException/getActiveSpan/setAttributes) · dev-platform — **PILOT** — instrument site-gen phases + WfP dispatch; structured-tracing doctrine made concrete. BACKLOG § cf-releases.
- 2026-09-17 · **Traces auto-include JS RPC session spans (DO boundary)** · durable-objects — watch — automatic, zero work; verify spans cross into SITE_BUILDER/psnotify DOs during the tracing pilot.
- 2026-09-27/24 · **Workflows in `exports` + `ctx.exports` invocation** · workflows — backlog — drop workflow binding boilerplate next time wrangler.toml is touched; less binding drift.
- 2026-09-15 · **Workflow `.subscribe()` event streaming** · workflows — backlog — replace status polling in the live build stream with real-time instance events.
- 2026-09-17/10 · **Instance batch delete + 7-day default retention (new workflows)** · workflows — backlog — retention hygiene: purge terminal site-gen instances; existing workflows keep 30d, note for new ones.
- 2026-06-16/05 · **Saga rollback handlers + step context** · workflows — backlog — compensating cleanup (R2 partials, D1 status) on failed builds instead of stranded `error` rows.
- 2026-07-09 · **Dynamic retry delay functions** · workflows — watch — adopt opportunistically when next editing pipeline retry logic.
- 2026-07-07 · **Workflows per-step billing (live since ~2026-08-10)** · workflows — watch — fold step-count check into next Cloudflare billing audit.
- 2026-09-25 · **Browser Run crawl events → Queues** · dev-platform/queues — backlog — event-driven source-site crawl progress feeding the live build stream; requires enabling Queues (binding currently optional).
- 2026-09-28 · **WebMCP / document.modelContext in Browser Run (Kitesurf)** · dev-platform — watch — spec still moving; revisit for AI-native generated-site exposure + role 18 capability registry.
- 2026-09-17 · **Workers AI `rejectIfBusy`** · workers-ai — backlog — fail-fast to fallback model in generation path instead of queue-waiting; pairs with provider-scoped LLM fallback.
- 2026-08-14→28 · **New Workers AI models: DeepSeek V4 (1M ctx), Qwen 3.8 27B (vision), GLM-5.3** · workers-ai — watch — candidates for vision-QA + first-pass content on the CF rail; gate any swap behind evals.
- 2026-09-29 · **AI Gateway User Insights task analysis** · dev-platform — watch — dashboard-side cost/model insight; no integration work.
- 2026-09-29 · **Containers: disk no longer tied to memory (≤20GB)** · dev-platform — watch — no observed disk pressure in SITE_BUILDER/app-runtime builds; revisit on disk-bound build failures.
- 2026-09-28 · **Cloudflare CLI `cf` beta** · dev-platform — watch — wrangler stays the rail until `cf` reaches deploy+D1+R2 parity.
- 2026-09-24 · **R2 bandwidth metrics** + 2026-06-04 **budget alerts in product sidebars** · r2/d1 — watch — set budget alerts + read bandwidth during next billing audit; dashboard-only.
- 2026-09-25 · **Releases/gradual deploys overlaid on Workers Metrics** · dev-platform — watch — dashboard QoL for deploy-regression correlation.
- 2026-06-04 · **D1 `migrations_pattern` (nested/Drizzle layouts)** · d1 — watch — our migrations are flat; relevant only if Drizzle-managed migrations land.
- 2026-08-25 · **DO alarm `retryAlarm` abort option** · durable-objects — watch — default retry behavior is what our DOs want.
- 2026-09-01 · **D1 free-tier daily limit enforcement** · d1 — reject — account is Workers Paid; per-site D1s unaffected.
- 2026-09-25 · **Email Service domain-scoped suppressions** + 2026-07-15 **email events → Queues** · dev-platform/queues — reject — SES is the sole email rail (ADR-0019); CF Email Service not in stack.
- 2026-08-28 · **DO Dynamic Workers limit 4→10** · durable-objects — reject — we dispatch via WfP namespace binding, not DO dynamic workers.
- 2025-12-18 · **WfP dashboard improvements** (+ 6 older 2025 WfP items) · wfp — reject — namespaces are API-managed; dashboard QoL only; 2025 items pre-date our WfP adoption and are already absorbed.
- Irrelevant (counted, not listed): 6 items — Mesh/VPC log fields, DO name-search limit, DO deployments tab, Artifacts push-deploy, Artifacts queue events, Queues backlog metrics (product not enabled).

### Standing (pre-sweep)

- 2026-09-29 · **Browser Run CDP endpoint** (product docs, verified at implementation time)
  — `wss://api.cloudflare.com/client/v4/accounts/{acct}/browser-run/devtools/browser` +
  Bearer token with "Browser Run Write" → **PILOT → ADOPTED** same fire: the Deep UI
  Explorer's primary browser (proven session, deep path green). Older Workers-binding
  Browser Rendering remains the Worker-side gateway path.

## Sweep — fire-88 (2026-10-02)
- FEED OUTAGE: developers.cloudflare.com/changelog RSS WAF-blocked the default fetch UA; GitHub API returned stale v1.x data. No new releases captured (honest outage, NOT "0 releases"). Retry next cycle (~fire-92) with a real Chrome UA (fetch-defaults) or CF Browser Run.
- STACK CURRENCY (projectsites.dev): wrangler ^4.44.0 · @cloudflare/workers-types ^4.20251011.0 · @cloudflare/containers ^0.3.2 · @cloudflare/playwright ^1.3.0 — all current; 0 blocking CVEs/deprecations.
- Carry-open (prior sweeps): Browser Run multi-client sessions (PILOT pending in DUX), Workers tracing custom spans (PILOT), Workflow .subscribe() event streaming (BACKLOG), saga rollback handlers (BACKLOG).

## fire-301 scan (2026-10-06)

Last recorded scan: fire-88 (2026-10-02, feed outage — captured nothing). Web fetch of
developers.cloudflare.com/changelog SUCCEEDED this fire (default UA served; no WAF block),
so this sweep covers 2026-10-01 → 2026-10-06 — all genuinely new vs sweep-1 (ended 09-29).

### Stack currency — VERDICT: CURRENT (no upgrade this fire)
- **wrangler** `^4.44.0` (pinned) · installed `npx wrangler` resolves **4.63.0** — v4 major, current; no major behind. OK.
- **@cloudflare/workers-types** `^4.20251011.0` — current (dated build, ~this month). OK.
- **@cloudflare/containers** `^0.3.2` · **@cloudflare/playwright** `^1.3.0` — current, pre-1.0 container lib is latest line. OK.
- **hono** `^4.4.0` · **@hono/zod-validator** `^0.8.0` · **hono-openapi** `^1.3.0` — Hono v4 major, current. OK.
- **@project-sites/shared** `file:../../packages/shared` — local workspace link, no registry version to stale. N/A.
- **No obviously-stale pin → zero backlog upgrade items opened.** 0 blocking CVEs/deprecations touching our pins.

### Undispositioned carry-ins driven to disposition
(prior sweeps left these as PILOT/BACKLOG "pending" — reconfirmed, each gets an explicit line)
- Browser Run **multi-client sessions** — **PILOT (carry, still open)** — remains the right primary for DUX/long-trail; ride role-17 adoption. No new blocker.
- Workers tracing **custom span APIs** — **PILOT (carry, still open)** — instrument site-gen + WfP dispatch when next touching the pipeline; `[obs]` doctrine.
- Workflow **`.subscribe()` event streaming** — **BACKLOG (carry)** — still the clean replacement for live-build-stream polling; unblocked (no Queues dep). Ready when stream work recurs.
- Workflow **saga rollback handlers** — **BACKLOG (carry)** — compensating cleanup for failed builds (R2 partials/D1 `error` rows); `[strnd]`.

### New items dispositioned (2026-10-01 → 10-06)
- 2026-10-06 · **AI Gateway: standardized provider-credential errors (HTTP 401, code `2009`)** · ai-gateway — **BACKLOG** — maps 1:1 to MEMORY `[AIG401]`; make the AIG auth-fallback branch key on 401+2009 deterministically instead of string-sniffing. Small (~0.5d).
- 2026-10-01 · **`@cloudflare/workers-oauth-provider` v1** (split authz/resource API) · workers — **BACKLOG** — our MCP OAuth-first path (`/api/mcp/:provider/connect`, 501 fallback) could adopt the v1 provider to stop hand-rolling token exchange; ties to `MCP OAuth-first` gotcha. Medium (~1-2d, per-provider).
- 2026-10-02 · **Rules `hash_in_range()` GA** (request sampling / % rollout) · rules — **WATCH** — edge-side percentage bucketing; our rollout lives in D1 `feature_flag_overrides` + `isFlagOn`, so only relevant if we ever push a flag decision to the edge WAF layer. Revisit if flag-at-edge is ever wanted.
- 2026-10-01 · **Workers AI Clef decision models (27B + 9B flash, ms-latency)** · workers-ai — **WATCH** — candidate fast-path classifier (vertical classifier `[clsf]` / routing) on the free CF rail; gate any swap behind evals, same as the DeepSeek-V4/Qwen/GLM watch set. No swap now.
- 2026-10-02 · **AI Gateway Web Search API (beta, 3 providers)** · ai-gateway — **WATCH** — could power AI-native generated-site features (live research widgets) through the existing AIG binding; beta + billing unclear, revisit at GA.
- 2026-10-02 · **Workers Observability logs+traces datasets in Custom Dashboards** · analytics/workers — **WATCH** — dashboard-side QoL for the tracing pilot; no integration code. Pairs with the custom-span PILOT.
- 2026-10-01 · **Durable Objects: pending I/O prevents idle eviction** · durable-objects — **WATCH** — automatic, zero work; benefits long-running SITE_BUILDER/psnotify tasks with no connected client. Verify no behavior change during next DO touch.
- 2026-10-01 · **AI Search GA** (hybrid default; billing starts 2026-11-01) · ai-search — **WATCH** — possible managed RAG over site content/docs later; has a cost cliff Nov 1, so note before any pilot.
- 2026-10-02 · **D1 US-jurisdiction DBs** + **KV namespace jurisdictions (eu/us/fedramp) GA** · d1/kv — **WATCH** — data-residency primitive for per-site D1 (`site_database_allocations`) if a customer ever demands US/EU residency; not a need today.
- 2026-10-01 · **Artifacts versioned FS → open beta (Workers deploy integration)** · workers — **WATCH** — potential build-artifact store for generated-site versions vs current R2 `sites/{slug}/{version}/`; R2 path works, revisit only if versioning pain appears.
- 2026-10-01 · **Fundamentals: API-Token-Provisioning role self-serve** · fundamentals — **WATCH** — ops QoL for minting scoped CF tokens (e.g. Browser Run Write); no product code.
- 2026-10-02 · **Rules `coalesce()` (nil fallback)** + 2026-10-01 **Basin (Data Platform rebrand: Pipelines/Catalog/SQL GA)** · rules/basin — **REJECT** — Rules-engine helper + a data-lake product not in our Cloudflare-primitive stack (D1/R2/KV/DO/Workflows/WfP); no money-path tie.
- Skipped as out-of-scope (counted, not dispositioned): DNS record-quota warnings, WAF F5 CVE-2026-94127 + Oct-12 rule merge, Magic Transit/WAN BGP-over-tunnel GA, Access strict-service-token setting, Analytics 30-day retention, Agents-SDK Pi Durable harness (Agents SDK, not our WfP Functions rail), Cloudflare Tunnel `--allowed-mail` — none touch our Worker/WfP/data/AI surfaces.

### NEW next-wave DISCOVERY backlog candidates (CF-native, worth piloting)
1. **AI-Gateway-native LLM auth + fallback hardening** — adopt the new 401/`2009` standardized
   error (10-06) so the generation path's AIG→Workers-AI fallback (`[AIG401]`/`[WAIfb]`) triggers
   on a deterministic contract, not a substring match. Protects the money path (site-gen never
   stalls on a provider-credential hiccup; fails fast to the free CF rail). Effort: **S (~0.5d)**.
2. **MCP connect on `@cloudflare/workers-oauth-provider` v1** — replace the hand-rolled OAuth
   token-exchange behind `/api/mcp/:provider/connect` with the v1 provider's split authz/resource
   API. Money path: more providers connect cleanly on the first try (fewer 501 paste-key
   fallbacks → owners wire integrations → stickier paid sites). Effort: **M (~1-2d, per-provider)**.
3. **Clef-flash vertical classifier on Workers AI** — pilot the 9B Clef decision model as the
   fast-path for the vertical classifier (`[clsf]`) + model-router, behind an eval gate vs the
   current Llama 3.1-8B. Money path: faster, cheaper first-pass classification on the free rail
   shaves site-gen latency (closer to the <15-min delivery promise). Effort: **S-M (~1d + evals)**.
