# _CF_NATIVE_CONVERGENCE.md — Cloudflare-native convergence run (Voice · Twilio · Sandbox · MCP · Surfaces)

> Living queue for the CF-native convergence mandate. The ONE loop (`/run-the-loop` cron
> `5b233086`, every 15m) reads `_LOOP.md` → this sub-ledger → advances the next unmet slice(s),
> RED-first, verifies, deploys, prod-verifies, commits `main`, ticks here. **No second cron** —
> this run is lanes 12–18 of the single loop. Immutable spec: `docs/_cf-convergence/MANDATE.md`
> (product outcome · architecture contracts · security gates · acceptance matrix · research
> findings · source ledger · improvement charter). Per-stream audit evidence (file:line):
> `docs/_cf-convergence/audit-{A,B,C,D,E,F}.md` (fire-1, 2026-09-28).
>
> Status tags: **⬜todo** · **🔄active** · **🔴danger** (live bug) · **⛔blocked-external** ·
> **🔑Brian-gated** · **✅done** (closing SHA + prod proof).

## 0 · How the loop drives this run

- ~15 min per independently-testable slice. ONE coherent slice per lane per fire. RED-first.
- **Streams A–E fan out one worktree-isolated agent each (disjoint subtrees), ≤6-wide.** Stream F
  (shared contracts + migrations) is SERIAL and single-owner — never parallel-picked.
- **F owns `packages/shared/**` + `migrations/**` EXCLUSIVELY.** A stream requests a contract; F
  lands schema + migration (ascending from **0648**) + `z.infer` type in one serialized change; the
  stream then imports the type. Migration numbers are assigned ONLY by F.
- Every slice: feature-flag default-OFF (server 404 when off, UI null), Zod at boundaries,
  structured logs (`console.warn`), `assertSiteOwned` on every `/api/sites/:siteId` handler.
- **No fake green for mocked external services.** Twilio/Stripe/CF live steps use staging creds or
  mocks; a mocked pass is labelled mocked, never "verified live."
- New ADR/guide `.md` files are staged with `git add -f` (`.gitignore` blocks `*.md`).
- 20–25% of each fire → source-adjacent docs + one hygiene candidate (charter, MANDATE.md §Charter).
- Each fire's ledger shows (1) shipped app behavior/fix, (2) one loop/template/utility improvement
  with before/after evidence, (3) verification + user impact.

## 1 · Dependency graph (what unblocks what)

- **F contracts + migrations** → unblocks every stream's persisted state. Do F's slice for a
  stream the fire BEFORE that stream needs the table.
- **Shared default-AI-chat service** (one streaming server route) → A voice + C editor both consume
  it. Build once (owner: A, reviewed by C). Do NOT double-append transcript; honor AbortSignal.
- **`browser_gateway` CF Browser Run Live View** (replace Browserbase-only assumption) → A (call
  browser) + C (editor browser widget) both consume it.
- **MCP broker authz** (D) → A voice tools + C editor tools + E surface tools all call through it.
- **ADR 0056 (LiveKit → CF-native voice)** gates A4/A5 recording design — write it before A's
  capture slices; migrate live LiveKit behind a reversible flag until CF path passes call+recording.

## 2 · Stream F — shared contracts, migrations, baseline (SERIAL, single-owner)  🔄active

- **Baseline (fire-1):** branch `main`; uncommitted (concurrent sessions, DO NOT clobber):
  `.claude/scheduled_tasks.json`, `app/components/workbench/__tests__/data-grid-features.spec.tsx`,
  untracked `frontend/…/admin/sections/hosting.component.ts` (needs `git add` or its chunk 404s).
- **Next migration number: 0648** (ceiling `0647_site_r2_buckets_catalog.sql`). **Next ADR: 0056.**
- **F1 ⬜ Register `voice_receptionist` flag** — declared in `voice-architecture.md`, absent from the
  72-flag registry → dead/un-toggleable. Add to `modules/feature_flags/registry.ts` + manifest + docs.
- **F2 ⬜ ADR 0056 — LiveKit → Cloudflare-native voice** (dated, supersedes prior LiveKit ADR +
  `PRICING-MODEL.md`; preserve history). Decide: CF Agents voice (withVoice/VoiceClient + Twilio
  adapter) vs keep LiveKit behind reversible flag until CF passes phone-call + recording tests.
- **F3 ⬜ Contract collision hotspots** (`packages/shared/src/schemas/`): `index.ts` (barrel, all),
  `webhook.ts` (A LiveKit + B Twilio/Stripe + D mcp), `media.ts` (A recordings + E assets),
  `billing.ts` (B call cost + E seo cost), `api.ts` (shared error enum), `base.ts` (primitives).
- **F4 ⬜ Cross-stream migration plan** (one owner, ascending from 0648): voice calls/media/critique;
  number-purchase state machine; per-call Stripe ledger; mcp grants + `mcp_resource_tokens` wiring;
  Traks analytics; short-links authoritative store; OpenSEO cost ledger.
- Evidence: `docs/_cf-convergence/audit-F-contracts.md`.

## 3 · Stream A — Voice page + all-call media (A1–A9)  🔄active

Evidence: `docs/_cf-convergence/audit-A-voice.md`. Collision hotspots: `routes/voice.ts` (1076 ln,
every endpoint — split by resource or serialize), `conversations.component.ts` (29K),
`services/voice_agent.ts` (shared with SMS — run full suite on edit).

- **A0 🔴 Test Console token-shape bug** — FE reads `r.data.token`; route returns top-level
  `{token,…}` (`voice.ts:1028` vs `test-console.ts:386`) → every test call fails. RED: assert
  `res.data.token` defined. FIRST SLICE (tiny, high-value).
- **A1 ⬜ Setup/Recording/Reviews tabs + call-detail nav** — keep the 7 existing tabs; add config
  (web voice/PSTN/SMS/consent/voice-model-STT/greeting/interrupt/retention/language/limits/transfer/
  draft-vs-published), one primary action per screen, progressive disclosure.
- **A2 ⬜ Voice gallery + real interactive Test Console** — searchable provider/model/locale voices +
  sample playback; Test Console = mic button + live captions + mute/end + selected voice + **invokes
  the shared default AI chat + allowed tools** (NOT the current Twilio-Client dial / separate path).
  Preview draft settings, no billed fake call. Playwright fake-media + one live staging run.
- **A3 ⬜ Every-call session + browser-start on answer** — create `voice_calls` row on answer (today
  created at call END, `voice_transcript.ts:59` → abandoned calls leave no record); one call-scoped
  timeline id + lifecycle events; read-only Live View to owner (short-lived URLs, never logged/
  persisted); HITL control transfer; encrypted storageState per tenant/site/user/origin; redact
  passwords/tokens in captures.
- **A4 ⬜ Real pixel capture spike (CDP screencast) vs rrweb** — rrweb ≠ video; enable rrweb for DOM
  replay AND measure CDP frame capture; if Browser Run can't capture an autonomous call, CF Container
  Chromium capture is the validated pixel fallback. Recording must NOT require a viewer.
- **A5 ⛔ Dual-channel Twilio Call Recording** — `Start/Recording channels=dual trim=do-not-trim`
  BEFORE Connect/Stream; download authenticated WAV → R2 no-transcode + checksum; reconcile
  CallSid/RecordingSid; verify callback signature. (Blocked by ADR 0056 + live staging.) NOTE:
  LiveKit currently owns the audio (`livekit_webhooks.ts` logs egress, never persists) — A4/A5 need
  the ADR decision first.
- **A6 ⬜ Synced audio+video call detail** — separate media elements, seek/captions/browser+terminal
  events, WebCodecs/ffmpeg.wasm on-demand export; MP4 derivative never replaces canonical WAV;
  measured drift ≤100ms at 0/50/100%.
- **A7 ⬜ Conversations = searchable calls directory + 206 streaming** — the 206 route exists but is
  bypassed (FE `getBlob` buffers whole file, `conversations.ts:586` / `api.service.ts:211`); wire
  `<audio>/<video src>` to `/recordings/:id/stream` (partial 206). Durable processing states;
  dedicated call URL; backfill + honest gaps.
- **A8 ⬜ Timecoded critique → versioned per-site behavior rule** — classify error/desired/scope;
  approved critiques compile to a small deduped clause + retrieval; untrusted (can't override
  safety/consent); never cross-site.
- **A9 ⬜ Consent policy** — spoken-only + unenforced today (`recording_opt_out` never read on call
  path). Jurisdiction-aware disclosure; consent-or-decline; audio-only setting default OFF.

## 4 · Stream B — Twilio numbers, SMS, compliance, Stripe (B1–B6)  🔴active

Evidence: `docs/_cf-convergence/audit-B-twilio.md`. **Solid already:** Stripe + Twilio webhook sig
verification, DB-ownership re-checks on voice reads/mutates (no IDOR), B1 live search largely built.

- **B0 🔴 TOP — orphan-number / no-payment purchase** — `voice.ts:193-261` buys from Twilio BEFORE a
  single `dbInsert`, with NO Stripe quote/charge, NO idempotency key, NO `releaseNumber`
  compensation, inserting `'active'` directly (the schema `pending` state is unused). **Live
  money-loss + double-buy window.** Voice routes have NO `isFlagOn` gate (`src/index.ts:998` — no
  killswitch). FIRST SLICES: (a) register `voice_numbers` flag as killswitch + gate the purchase
  route; (b) RED mock-Twilio test: buy-succeeds-then-D1-fails → fires compensating `releaseNumber`,
  persists no `active` row; (c) add `Idempotency-Key` (= pre-written pending-row id) → double-POST =
  exactly one carrier buy.
- **B1 ⬜ Number search polish** — locality/vanity/capabilities; truthful "Recommended for your site"
  label (never "custom/reserved"); account-specific fees; recheck availability at purchase.
- **B2 ⬜ Purchase txn boundary** — quote → Stripe payment/subscription auth → durable state machine
  (available→payment-pending→provisioning→voice-ready) → bind VoiceUrl/SmsUrl to the site; Twilio
  subaccount per org (grep=0 today); safe release/transfer/port-out.
- **B3 ⬜ Pricing model** — $0.25/started-min (video+recording included) headline; distinguish rental/
  SMS/taxes/premium/outbound/intl; no lying $0 rental. Hardcoded `monthly_cost_cents:100`
  (`voice.ts:233,286`) → read `pricing_config`. Update `docs/PRICING-MODEL.md` + `pricing_config`.
- **B4 ⬜ Stripe rental + metered voice + ledger** — `BILLING_PROVIDER=noop`
  (`billing_provider.ts:214` → all metering silently dropped); recurring rental item + metered price;
  immutable call ledger keyed by CallSid; one meter event w/ durable idempotency; nightly reconcile
  vs Twilio Usage + CF costs; budget/cap + runaway alert.
- **B5 ⬜ SMS/10DLC/TFN compliance** — Brand/Campaign, Messaging Service, opt-in, STOP/HELP, terms/
  privacy URLs; state machine …→A2P-pending→SMS-ready/rejected; outbound AI calling gated
  (consent/DNC/TCPA + own price).
- **B6 ⬜ Full E2E** — search→quote→checkout→provision→answer→two-channel→video→meter→invoice + SMS
  transitions; mocks for destructive purchases; concurrent-tab / lost-webhook / D1-fail-after-buy /
  repeated-callback / cross-tenant tests.

## 5 · Stream C — Editor Claude-Code job + Sandbox + browser widget (ideas 1–12)  🔄active

Evidence: `docs/_cf-convergence/audit-C-sandbox.md`. **Pinned SDKs:** `@cloudflare/sandbox`
**ABSENT** · `@cloudflare/agents` **ABSENT** · `@browserbasehq/stagehand` ^3.7.0 (worker devDep) ·
`@cloudflare/playwright` ^1.3.0 · `@cloudflare/containers` ^0.3.2. Editor = repo-root `app/`.

- **C0 ⬜ Orphan cull/decision** — `ide_sandbox.ts` + test + migration `0504` (tables
  `ide_sandboxes`/`multi_agent_runs`/`progressive_builds`) are a fabricated simulation, routes
  removed, flags absent → delete OR make them the real Sandbox impl for ideas 1/7/11. Wire or drop
  `cli_sandbox_config.ts` (only its test imports it). (interconnectedness)
- **C1 ⬜ Per-site Claude-Code workspace** — `POST /api/sites/:id/workspace`; FIRST SLICE: return
  **501 when Sandbox SDK unbound** (mirror `isWfpConfigured()`→503), RED until the executor lands.
  Pin one Sandbox SDK line; port the CF Claude-Code tutorial to it.
- **C2 ⬜ Split terminal + Browser Run Live View** (multi-tab, post-session replay).
- **C3 ⬜ Server terminal events → R2 + replay tab** (distinct from video).
- **C4 ⬜ Git/R2 snapshot + diff + rollback** — never write Production (`SourceControlPanel` already
  states this); add server snapshot store + rollback-to-commit (preview only).
- **C5 ⬜ Incremental commit-keyed index** (only changed blobs fetched).
- **C6 ⬜ Signed in-chat preview** proxied through ProjectSites auth (preview URLs are bearer-like).
- **C7 ⬜ Sandbox AI code executor** + result cards (real stdout/exit, resource limits).
- **C8 ⬜ One-click tests/typecheck/lint/build/QA cards** with click-through failure context.
- **C9 ⬜ Site-scoped outbound/MCP bridge** — creds server-side (reuse `ai_env_vars` + `mcp_connections`).
- **C10 ⬜ Durable job checkpoints/resume** across container eviction (reuse the site-gen Workflow
  restart pattern); process death visible, never mistaken for success.
- **C11 ⬜ Disposable dependency experiment workspace** (preview diff + approve before merge).
- **C12 ⬜ Per-site concurrency/time/idle/cost budgets** — extend `build_limits.ts` → `workspace_limits`.
- **Browser widget:** replace `browser_gateway.ts:97-104` Browserbase-only Live-View/replay with CF
  Browser Run default; Browserbase = priced fallback only. Lazy-create browser session; assistant-ui
  concepts in the React editor; keep Admin Angular-native; typed cards, no model-generated markup;
  prompt injection = untrusted; never give the container master D1 / account tokens.
- **Ideas 13–15 (evaluate after core):** parallel review agents · notebook/chart analysis · runtime
  marketplace.

## 6 · Stream D — ProjectSites MCP broker (ideas 1–12)  🔄active

Evidence: `docs/_cf-convergence/audit-D-mcp.md`. **No live IDOR** (ownership enforced everywhere,
rechecked at tools/call, 404-not-403; `mcp_connections` per-site). Concern = org-wide token blast.

- **D0 🔴 Org-wide 90-day token** — OAuth AS mints an org-wide `psk_` token
  (`mcp_oauth_provider/handlers.ts:308`), not audience-bound/site-scoped. `mcp_resource_tokens`
  (audience-bound, per-site, RFC-8707, `migrations/0037:249`) is a total ORPHAN. FIRST SLICE:
  `resource_token_audience.test.ts` → exchange issues `aud`-bound site-scoped token (wires the orphan).
- **D1 ⬜ One versioned stateless Streamable-HTTP MCP endpoint + OAuth 2.1** (today `/api/mcp` is
  single-shot JSON-RPC, unversioned; per-site CRUD tools have no live transport — `mcp_site.ts` absent).
- **D2 ⬜ Consent = client/redirect host + multi-select owned Sites + scopes + expiry** (today org-wide,
  generic label — `oauth-consent.component.ts`).
- **D3 ⬜ Site×operation scope matrix** (read/content-write/deploy/data/voice/messages/integrations/
  billing/secrets; risky default-off).
- **D4 ⬜ Logical site → owned WfP resource mapping** (never account-wide CF passthrough).
- **D5 ⬜ Connected-provider registry** (user vs site ownership, upstream scopes, revoke).
- **D6 ⬜ Audience-bound PS tokens ≠ encrypted upstream OAuth tokens** (obtain upstream server-side,
  never forward the PS bearer).
- **D7 ⬜ Curated first-party tools + namespaced allowlisted broker tools.**
- **D8 ⬜ Capability catalog** + bounded provenance-linked summaries (never trusted as instructions).
- **D9 ⬜ Per-call policy intersection** (grant∩site∩RBAC∩entitlement∩ownership∩downstream-scope);
  reject swapped Site IDs; recheck at tools/call.
- **D10 ⬜ Transaction preview + human approval** for delete/deploy/secrets/charges/phone/email/SMS.
- **D11 ⬜ Audit + revocation + anomaly/rate/concurrency/cost controls.**
- **D12 ⬜ Compatibility checks + MCP Inspector + negative tenant tests + per-client docs.**
- Reference `cloudflare/mcp-server-cloudflare` for the resold resources only (never expose wholesale);
  prefer Workers OAuth Provider + stateless handler; do NOT revive deprecated McpAgent.
- **Ideas 13–15 (evaluate):** Code Mode · CF MCP Portal (internal governance) · cross-provider templates.

## 7 · Stream E — CF-native product surfaces (E1–E13)  🔄active

Evidence: `docs/_cf-convergence/audit-E-surfaces.md`. **Near-done, reclassify to verify+wire:** E7 D1
export (`d1_manager POST /api/admin/d1/:id/export`), E8 shortlinks funnel (`routes/claim.ts`;
`claimyour.site` = SEPARATE private repo, audit separately). E6 buckets slice-1 shipped.

- **E1 ⬜ EmDash CMS catalog entry beside Payload** — clone the CF-native Payload provisioner
  wholesale (D1+R2+Worker cascade proven, `apps-catalog.data.ts:452` + `cloudflare_provisioner.ts`);
  KV sessions + Worker-Loader plugins where the account supports; EmDash MCP proxied through PS grants.
- **E2 ⬜ Email sidebar** — agentic-inbox on SES (per-org/Site ACL at EVERY route; no Resend rail).
- **E3 ⬜ Dashboard health widget** — `cf_analytics.ts` writes latency doubles but no uptime/p50/p95
  tile; 24h/7d/30d from Analytics Engine + synthetic checks (UptimeFlare patterns).
- **E4 ⬜ Build/Apps sidebar** — VibeSDK-scoped launch flow (review bindings/costs → provision via
  WfP/CF → signed preview → embedded card); compare VibeSDK vs current editor, don't build a 2nd editor.
- **E5 ⬜ Automations** — React Flow island (not across all Angular); typed triggers/actions →
  Workflows/Queues/DO with versioning/retries/idempotency/dry-run/history.
- **E6 ⬜ Buckets** — Uppy direct-to-R2 signed uploads (multipart/resume); Tiptap headless core for
  rich text only (MIT core, not paid extensions). (See Resources cockpit §8 item 4 for R2 manager.)
- **E7 ✅-ish D1 export** — ships; verify large-DB + SQL import into a test DB; never expose master D1.
- **E8 ⬜ Short links via Slink (MIT, not Sink)** — authoritative D1/DO write + KV redirect cache
  (KV eventually-consistent — read-through until propagation); per-site prefixes; atomic slug claim;
  never let a tenant claim the platform domain. Migrate `claimyour.site` (AGPL Dub fork → Slink-backed
  CF-native) with parity + reversible cutover; preserve AGPL notices.
- **E9 ⬜ Traks analytics (MIT)** — shared account stream/sink/pipeline (CF limit: 20/20/20 + 5MB/s →
  NOT per-site), everything site-scoped; no Traks first-run claim / 2nd tenancy; dual-write + reconcile
  vs current Analytics Engine/PostHog, then cut over, no double-count.
- **E10 ⬜ cloudflare/agents patterns** — port only compatible/licensed/tested pieces; update project
  skills (Browser Run/Stagehand/WebMCP/HITL · Sandbox · Tiptap · voice billing); no giant new CLAUDE.md.
- **E11 ⬜ microfeed (AGPL) publishing app** — separately deployed (D1+R2+Queue+cron+secrets); reuse
  Payload install/quote/provision/rollback; preserve AGPL + offer source.
- **E12 ⬜ OpenSEO (MIT) in build + $10/site add-on** — free local checks always; paid DataForSEO
  audits via brokered Site-scoped MCP; isolate per-Site (Access shares one workspace); disabling stops
  provider calls, keeps free checks.
- **E13 ⬜ OpenSEO metering** — Stripe $10/site recurring + separate DataForSEO usage policy (BYO vs
  managed key + cap); append-only cost ledger at the wrapper (issue #268: cost responses discarded →
  custom metering required); reconcile Stripe meter ↔ ledger ↔ provider.

## 8 · Resources cockpit + Advanced console (Brian directive arc, 2026-09-27/28)  🔴active

Editor Resources panel. Evidence overlaps audit-C + audit-E. Preserve site-scoped
`r2_buckets`/`r2_bucket_manager`/`d1_manager`/`site_data_db`.

- **R1 🔴 Kill manual Refresh + Reconcile in Resources › Advanced** — `ResourceOverviewPanel.tsx:457-458`
  + `ResourcesPanel.tsx` header + `ResourceDetailPanel.tsx:803` violate `real-time-data-no-manual-refresh`
  (Brian NAMES this surface). Replace with visibility-aware live-update (mirror `AdminStateService`
  30/60s, pause on `document.hidden`) + silent auto-reconcile on timer/event. AC: no manual refresh
  control on any resource surface.
- **R2 ⬜ Promote the 9 built adapters to first-class tabs** —
  `data_resource_registry/adapters/{d1,kv,r2,vectorize,workflow,durable_object,queue,connection,analytics_engine}`
  are wired but reachable only via buried "Advanced" (`ResourcesPanel.tsx:573`). Ship order (live
  backends first): Database(D1, `per_site_data` LIVE) → Secrets → Connections → KV(`per_site_kv`) →
  Vectors. AC: each adapter a labeled tab; `scripts/detect-orphans.mjs` green.
- **R3 🔴 Drop "Media library" + "Site files" tabs** (`ResourcesPanel.tsx:736-738`) — "Site files"
  exposes DEPLOY ARTIFACTS (`sites/{slug}/{version}/`) = customer browse/delete of published builds,
  violates SECURITY §Static-Assets-vs-R2; Media already in editor media flows. AC: security fix,
  Buckets/data tabs remain.
- **R4 ⬜ Redesign Buckets (R2) tab** — `R2Browser.tsx` → full S3-style manager: prefix nav, upload/
  download/delete via scoped presigned URLs, size/content-type, empty/loading/error. Manage the DATA
  bucket, NOT the deploy-artifact bucket. Live-verified.
- **R5 ⬜ Fix dead "Add" control** — `ResourceOverviewPanel.tsx:896` fires "coming next" toast (dead
  click); route "Add" into the existing `ResourceDetailPanel` Provision flow (with confirm).
- **R6 ⬜ Restructure Advanced console into tabs** — Bindings (name↔resource attach/detach) ·
  Environments (preview↔prod promote/clone) · Drift/Reconcile (drifted list + heal + history) ·
  Lifecycle (provision/promote/clone/teardown). ~90% built (`EnvAssignmentGrid.tsx`,
  `LifecycleActions.tsx`) but crammed into one scroll.
- **R7 ⬜ New-backend tabs: Secrets/Env · Connections · Functions · Schedules** — Secrets →
  `/api/env-vars/*` (AES-GCM); Connections → health/revoke/reconnect; Functions → WfP `USER_DISPATCH`
  endpoints (routes/logs); Schedules → `site_functions_schedules` (WfP has no native cron). Each
  flag-gated, honest tab-live-or-honest-disabled.
- **R8 ⬜ Honest-limit tabs per CAPABILITY-MATRIX** — Queues (🔴 no binding → honest "not enabled on
  this account"); Durable Objects (ops-only: status-probe/reset, no browse-all-state/list-instances);
  Limits (namespace ≠ quota — never a fake quota pool). AC: each renders truthful state, zero
  lying-empty.

## 9 · Explicit TODO queue (from mandate)

- **Inspector removal** — delete KV Inspector + System Services + every other Inspector tab/route.
  Full inventory (audit-E): **26 files / ~4,600 LOC** — KV/R2/Vectorize/Queues Inspector each 6 files
  (`frontend/…/sections/<x>-inspector.component.ts` + `.spec.ts` + `libs/features/<x>_inspector/{handlers,
  schemas,feature.manifest,__tests__}`), System Services (`system-services.component.ts` + `.spec.ts`
  + `super_admin.ts:621` + 4 e2e). Unlink: `app.routes.ts:246-291,570-580` · `admin-nav.model.ts:131-176`
  · `admin-section-labels.ts:39,45-48` · `command-palette-actions.service.ts:168` · `src/index.ts:145-149,
  1034-1038` · 5 flag rows `registry.ts:503-544`. **PRESERVE** site-scoped `r2_buckets`/`r2_bucket_manager`/
  `d1_manager`/`site_data_db`/editor `BucketsPanel/DatabasePanel/ResourcesPanel`. FIRST SLICE: RED
  `admin-nav.model.spec.ts` asserts no inspector items + `/admin/kv-inspector` 404. Confirm no
  reappear via role/flag/deep-link.
- **Social page — 10 consecutive documented improvement passes** — `social.component.ts` = 2,649 ln /
  131KB god-component, styles 32.86KB (>28KB budget WARN), tabs `compose|drafts|queue|sent|calendar`.
  Establish desktop/tablet/mobile baselines; per pass: screenshot → one concrete defect (formatting/
  hierarchy/spacing/type/responsive/a11y/functional) → fix → re-verify same journey + focused test.
  Number passes 1–10 in a work log; finish with screenshot comparison + keyboard/mobile + one E2E
  publish/schedule. Keep the 10 passes together, not scattered.

## 10 · Cross-cutting hygiene

- **Jest → Vitest migration** — kills the `@swc/jest` mock-hoist footgun (documented in
  `apps/project-sites/CLAUDE.md` gotchas #11/#12). AC: green worker suite on Vitest; no hand-mirror
  mock-hoisting.
- **psnotify** (also `_RUN_THE_LOOP.md` Done log) — first slice landed (`libs/features/psnotify/`, flag
  DARK). `wrangler deploy --env production` to apply `v_psnotify_do`; then email/push fan-out adapters
  + unify the bell feed onto the DO. AC: `/api/notifications` served by the DO, not the D1 stub.

## 11 · Security + product-behavior gates (every slice)

- Every Site selection server-verified vs current membership; cross-site reads/writes/callbacks/number-
  assignments/sandbox-previews/media/cookies/R2/MCP-tools have NEGATIVE tests.
- Signed Live View / tunnel / preview / R2 URLs = credentials (never logged/persisted); Browser Run
  guardrails; Sandbox egress allowlist; per-site encryption + key rotation.
- Exact state + price; no dead-end button; no hidden fees; never pass rrweb off as pixel video.
  External-consequence actions need reviewed detail + explicit runtime click.
- Mask sensitive form/password/PII in recording/replay/transcript; retention/deletion/export/legal-hold;
  audit access to recordings + critique.
- Feature-flag + staged rollout by tenant; backward-compatible API contracts until clients migrate.
- CF-first runtime+storage; Twilio = phone/SMS; Stripe = billing; external LLM/ElevenLabs per AI-Gateway/
  LiteLLM policy.

## 12 · Acceptance matrix → `docs/_cf-convergence/MANDATE.md` §Acceptance

13 real user-journey checks (screenshots + network/logs, not unit tests only). Each stream's final
slice must satisfy its journey there. Sample multiple completed cycles for (1) app increment +
(2) reused loop/template/utility improvement + (3) verification/user-impact.

## 13 · Ledger

**Done** (closing SHA + prod proof):
- **B0 (partial) + A0 + `voice_numbers` killswitch** — `f1296b736` (co-developed with a concurrent
  fire; my slice = the orphan-number compensation). Purchase route gated behind `voice_numbers`
  (default-OFF → 404, no carrier spend); on the ON path a D1-insert failure now fires `releaseNumber()`
  compensation (no orphaned chargeable line); `/voice/test/call-token` wrapped in
  `{data:{token,identity,primary_number}}` (Angular console reads `res.data.token`). `voice.test.ts`
  14/14 + `voice_numbers_flag` 3/3, tsc clean, `validate:features` 0 err. On origin/main. Deploy: dark
  flag → lands on next worker deploy (CI); prod-verify = assert purchase 404s with the flag off.
  Remaining B0 → B2/B3/B4: idempotency-key + pre-buy pending-row + Stripe quote/charge boundary +
  `pricing_config` (kill hardcoded `monthly_cost_cents:100`).

**Blocked-external:** A5 live dual-channel recording (ADR 0056 + staging number) · B6 real staging
number/call · E9 Traks pipeline (CF 20/20/20 beta quota) · E12/E13 DataForSEO funding.

**🔑 Brian-gated:** ADR 0056 LiveKit→CF direction confirm · $0.25 pricing headline + margin sign-off ·
any real number purchase / message send.

## 14 · Fire-2 next-wave (discovery + browser findings — replenish the queue)

- **NOTIF-404 🔴 (browser agent, PROD):** `/api/notifications` returns **404 for UNAUTHENTICATED
  visitors** → a red console error on EVERY public page (`/pricing` repro, signed-out). The
  notification bell/poller must gate on auth + the `psnotify` flag BEFORE calling (client-read-flag
  must match the worker 404, per `flag-off-frontend-must-match-worker-404`). RED: load `/pricing`
  signed-out → 0 console errors. (All other PROD golden-path checks PASSED: homepage + search 200s,
  `/api/health` ok + HSTS/CSP, bogus `/api/*` → clean JSON 404.)
- **Stream C (discovery agent, `audit-C-sandbox.md`):** C1 delete-or-repurpose orphan `ide_sandbox.ts`
  + test + migration `0504` (routes removed `features.ts:630`, flags absent) · C3 `POST
  /api/sites/:id/workspace` → **501 when Sandbox SDK unbound** (mirror `isWfpConfigured()`→503) · C5
  shared streaming AI-chat route (A2+C dependency — one canonical path + AbortSignal) · C4 wire-or-drop
  `cli_sandbox_config.ts` (only its test imports it) · confirm `@cloudflare/sandbox`+`@cloudflare/agents`
  ABSENT before promising a workspace.
- **Loop improvement (this fire):** codified the concurrent-shared-tree protocol — when a concurrent
  fire owns the target file, verify GREEN then commit the coherent bundle (don't leave a RED test in
  the shared tree; don't race a second commit of the same paths). See report + `[[concu]]`/`[[chkog]]`.
