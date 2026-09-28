# _LOOP.md — ProjectSites.dev Master Convergence Loop

> THE single master entry point for ProjectSites multi-agent convergence loops. Brian says **"run the loop"** / `/run-the-loop` (command: `.claude/commands/run-the-loop.md`); a fire reads THIS file to know the mission, protocol, lanes, and task collection. It UNIFIES the scattered loop docs — it does NOT duplicate their granular state; it POINTS to them as sub-ledgers (§7). Product: ProjectSites.dev — **"we don't sell websites, we deliver them."** A business owner searches their business → signs in → gets an AI-generated, hosted, SSL'd, live site in <15min. Surfaces: Angular Spartan admin dashboard · bolt.diy in-browser editor · app catalog (deployable OSS apps/containers) · per-site D1/R2 · Workers-for-Platforms hosting · generated `{slug}.projectsites.dev` sites. Cloudflare-native. AI is the primary developer + a permanent product foundation.

## 0 · Prime Directive

- **The PRIMARY deliverable of EVERY fire is a COMPLETE, REAL, end-to-end USER JOURNEY, proven working on PROD** — never a detector, a smoke check, or a mocked interaction. (Brian, said ≥3×.)
- Real journey = homepage → real E2E sign-in → navigate by CLICKING the actual UI → create → configure → edit → SAVE → navigate away → return → HARD-REFRESH → verify PERSISTENCE → verify the cross-feature effect → clean up. A full story a paying customer lives, against the REAL backend.
- **Detectors (`check-*.mjs`) + unit tests are a BYPRODUCT, never the goal** — ship one ONLY after a real journey caught a real bug and you want to stop its class regressing. A fire whose main output is a new detector or a mocked assertion is a FAILURE MODE.
- **"Ensure full flows happen" = COMPLETE the flow.** A journey with a gap/dead-end/stub → BUILD the missing product until it completes for real. Completing beats gating.
- **The money path is the first target:** `/create` a real test business → it BUILDS for real → view the generated site → editor change a requirement → the live site updates → publish. Real auth, real build, real edit, real publish — reconciled against the source of truth.
- **Every fire leaves the whole app closer to `_APP_COMPLETION.md` DONE** (§ A admin · § B flows · § C generated-site quality · § D marketing/SEO · § E editor). Terminal target is the whole app, verified through real journeys.
- **Every fire is gorgeous-er AND more effortless** — beauty + embarrassing-ease, both, always (never "functional but plain", never a surface an owner would need help with).

## 1 · How to run one fire (protocol)

1. **Orient (cheap).** Read THIS file + the ONE lane you're advancing. Do NOT main-thread-read ledgers/`_LOOP_LEDGER.md`/`SCOPE.md`/`progress.md` — delegate any inventory read to a fresh `Explore` agent (≤150-line cap); hold conclusions only. HARD STOP on autocompact thrash / "prompt too long" / `subagent_tokens:0` → checkpoint to `progress.md`, continue in a FRESH session.
2. **Fan out.** FIRST tool-call message emits parallel `Agent` spawns — one fresh worktree-isolated agent per ACTIVE lane with disjoint subtrees, ≤6-wide for mutating work (read-only sweeps are free + uncapped). Each agent: 100-300 word self-contained brief (role · scope · exact paths · non-goals · ≤200-word output), primary-deliverable written FIRST. One coherent slice per lane. Never bare `general-purpose` when a specialist fits.
3. **TDD-first.** Failing Playwright journey/spec BEFORE implementation → watch RED → implement → GREEN. Bug fix = failing regression first. No feature without ≥1 test; no fix without ≥1 regression.
4. **Verify (self, per agent).** `npm run check` (typecheck+lint+test) + `npm run validate:features` where touched; Angular touch → `ng build` (catches NG template errors tsc/karma miss). Verify Angular deploy by hash, not grep.
5. **Deploy (main thread, ONCE).** Fold agent outputs → single build → `cd apps/project-sites && npx wrangler deploy --env production` (`--env production` MANDATORY or every `/api/*` 500s). Frontend R2 deploy has no Docker dep; container/DO builds need Docker running. Auth: `CLOUDFLARE_API_KEY` (get-secret) + `CLOUDFLARE_EMAIL=blzalewski@gmail.com`. NEVER modify already-set CF secrets.
6. **Prod-verify (REQUIRED — a local pass is NEVER sufficient).** curl/Playwright the changed routes on PROD: assert new content/headers/JSON-LD/status live, 0 console errors, axe-clean. Reconcile display-vs-store for data surfaces (`verify-against-source-of-truth`). Verification-before-completion: no completion claim without FRESH command-output evidence this turn.
7. **Commit main + push (same turn, autonomous).** Straight to `main` (no dev/feature branches); `git add -f` (`.gitignore` blocks `*.md`); conventional-commit + gitmoji IS the PR description; `git push` immediately. NEVER force-push main. Merge every worktree to main + delete the worktree AND its branch the same fire (stranding is a known incident class).
8. **Reconcile + tick.** Update the lane's sub-ledger + `_RUN_THE_LOOP.md` (move a unit to Done only when Acceptance is met, with closing SHA + prod proof). Report per the `always.md` end-of-response block.

## 2 · Non-negotiable invariants + discipline

- **main-only, auto-push same turn.** No dev/release/feature branches; worktrees for isolation; merge + delete every round; never force-push main.
- **Prod is pre-authorized.** Gates green → deploy → prod-verify. Never hold committed-but-dark work "awaiting authorization." Only genuinely destructive/irreversible prod actions (drop tables, bulk customer mutation, secret rotation, mass outreach) pause for Brian.
- **ONE coherent slice per lane per fire.** Never split a multi-faceted brief into one-section-per-turn.
- **FAN OUT by default** (monitor-orchestration): parallel agents in ONE message; ≤6-wide mutating; read-only sweeps free; worktree-isolation when mutating shared files; main thread orchestrates + folds + deploys once + verifies, never implements when saturated.
- **Delegate when saturated; HARD-STOP → fresh session** on autocompact thrash / "prompt too long" / `subagent_tokens:0`. Main thread never ingests giant files or ledgers.
- **TDD-first, REAL journeys.** Failing test first; NEVER mocked/smoke as the deliverable; homepage-start, navigate by UI actions only (no `page.goto()` after load), deterministic, parallel-safe, `data-testid`/role selectors, 6 breakpoints.
- **Interconnectedness — no orphan code.** Every built unit is reachable in the UI (import→render / route / nav / registration); built-but-unwired = not done; wire adjacent orphans while in-context (`scripts/detect-orphans.mjs`).
- **gorgeous-by-default AND embarrassingly-easy-to-use** every UX fire — more beautiful AND more effortless; AI does the work, the user confirms; ≤3 steps to any outcome; one primary action per screen; empty states are launchpads; never a dead/doomed control; real-time data (no manual Refresh/Reconcile buttons); undo on every mutation.
- **Feature flags default-OFF.** Every non-trivial feature `enabled=0, rollout=0, stage='experimental'`; server guard returns **404** when off (never 403); UI returns `null`; new flag → registry + manifest + docs (3 places).
- **Zod at every boundary** (env, API in/out, params, forms, webhooks, queues, DO msgs, AI outputs, tool in/out); infer types, never duplicate.
- **`assertSiteOwned` on EVERY `/api/sites/:siteId` handler** (IDOR); new site-id handler needs the guard + a CI gate row.
- **Verification-before-completion + auto-integrate-recs.** No completion claim without fresh command-output evidence; anything <2h with no design call → SHIP inline, never Rec.
- **Brian-gated + blocked-user items are NEVER auto-executed** (§6) — ship the decision-independent slice, surface the exact unblock command.
- **Brand:** black `#060610` + cyan `#00E5FF` (`--ps-accent`), cinematic; hard-coded brand colors are flagged; one `DialogShellComponent` primitive for every admin modal.

## 3 · The lanes (multi-agent roster)

Each lane = one fresh worktree-isolated agent per fire (disjoint subtrees), up to the 6-wide ceiling; remaining lanes run the next wave. Lanes 1-6 are the standing `_RUN_THE_LOOP.md` workstreams (fan-out first); lanes 7-11 are the dimension backlogs (§4) + the whole-app DoD roster. `.claude/loop.md` roster (ADMIN INTEGRITY 30m · ADMIN COMPLETENESS 2h · ADMIN QUALITY daily · FULL JOURNEY 8h · FULL-FLOW E2E 6h · GENERATED-SITE QUALITY 12h) is the exhaustive DoD backstop underneath these.

| # | Lane | Mission | Ledger | Next unit | Acceptance | Cadence |
|---|------|---------|--------|-----------|------------|---------|
| 1 | **Promote-workflow** | editor Preview → Promote → Production | `_PROMOTE_WORKFLOW_CHECKPOINT.md` | Slice 5: cyan **Promote** header button + status progression + no-op/retry states | promoted bytes = frozen Preview revision; editor always presents `main`; never force-push | every fire |
| 2 | **WfP hosting** (`site_wfp_hosting` OFF) | serve sites via Workers-for-Platforms dispatch | `docs/wfp-site-hosting.md` | Unit 6: admin Angular/Spartan Hosting surface (status pill · preview+prod URLs · Publish/Promote · 4 states) | styled-200-via-dispatch prod-verify (`x-ps-serve: wfp`); byte-identical R2 when flag off; fail-soft to R2 | every fire (external gate: provision `[[dispatch_namespaces]]`) |
| 3 | **Editor Data Platform** | Database tab → Airtable-class per-site D1 | `docs/database-tab-enhancements.md` · `docs/data-platform-scope.md` · `docs/data-section-capability-matrix.md` | next of the 10 progressive gorgeous+functional revisions (rowid inline edit → schema rail → bulk fill-down → …) | 10 revisions done + top ideas shipped; each verified live | every fire |
| 4 | **Admin screens + visual-QA** | drain 25-route inventory; 8-dim score; fix/improve/add each fire | `_ADMIN_VQA_LEDGER.md` · memory `local-admin-visual-sweep-recipe` | inspect next unvisited route live; fix findings + add components | maintenance-only; healthy no-op when nothing improves | continuous |
| 5 | **Interconnectedness** | no orphan / everything reachable | `_INTERCONNECTEDNESS_LEDGER.md` · `scripts/detect-orphans.mjs` | run orphan sweep → wire highest-value orphaned unit into a reachable surface same fire | zero orphaned major units; detector green | continuous |
| 6 | **App-completion journeys** | whole-app DoD via REAL multi-step journeys | `_APP_COMPLETION.md` (+ `.claude/loop.md`) | § B.2 golden journey create→build→publish→view→analytics + admin propagation | each journey proven E2E on PROD + durable probe in `e2e/admin-verify/run-all.mjs` | batch after 1-5 |
| 7 | **Site-generation quality** | generated sites BEAT the source (the CORE product) | `_LOOP_LEDGER.md` · `src/services/build_validators.ts` | competitor-research + ≥15% floor gate into site-gen Phase -1; flip validators `report→strict` | published-site scorecard ≥ threshold; source-vs-rebuild parity | batch after 1-5 |
| 8 | **Editor features** | bolt.diy editor Code/Preview/Database/Resources + Chat | brief 02 · `.claude/skills/projectsites-editor-layout` | Cmd+K palette + Cmd+P fuzzy-open; AI inline edit/explain | every editor change lands through a reviewable gate; keyboard-complete | as scheduled |
| 9 | **App catalog** | deployable OSS apps → cf-native north star | brief 03 · `docs/CONTAINER_MANIFEST.md` | close catalog↔`supported`↔infra drift; surface best ~10 wired-but-uncatalogued DO classes | one SSOT: card ⇔ `supported` ⇔ `[[containers]]` ⇔ live subdomain | as scheduled |
| 10 | **Notifications + comms** | psnotify DO unified center, real-time | brief 05 · `src/services/psnotify.ts` (STUB) | ship `libs/features/psnotify/` DO inbox + fan-out; unify bell onto it | worker-fired notif == what the bell shows; real-time push | as scheduled |
| 11 | **Backend platform** | routes/features/services + CF-native leverage | brief 06 | promote `public_api` to beta (REST API v1 behind `psk_live_*` tokens) | flag→beta with Zod + tests + prod-verify | as scheduled |

## 4 · Task collection by dimension

Curated best-of each brief — every `[HIGH]` preserved, `[MED]` clustered. Concrete pointers kept. `docs/_loop-scan/0N-*.md` = full per-dimension list.

### 4.1 Admin dashboard screens (brief 01)

- **[HIGH] Operator cockpit home** — replace the section-catalog `/admin` (`dashboard.component.ts`, 1619 ln) with live KPI tiles (sites live · builds in-flight · leads today · MRR · error rate) + an ACTIONABLE "needs attention" queue (one-click fix/retry per row). Real-time via `AdminStateService`.
- **[HIGH] Real sites grid `/admin/sites`** — replace the redirect-to-dashboard with a filterable/sortable/searchable card grid (thumbnail · status dot · domain · last-build · readiness grade). Live status dot, no refresh.
- **[HIGH] Global Cmd+K deep-actions** — palette is nav-only; add verbs (create site · deploy · rollback · invite teammate · toggle flag) + fuzzy jump to any setting (Linear model).
- **[HIGH] Real-time everywhere / kill Refresh buttons** — audit every data surface (apps instances, domains DNS/SSL, logs, analytics, inspectors) for manual Refresh/Reconcile; replace with visibility-aware poll / SSE (`real-time-data-no-manual-refresh`).
- **[HIGH] Empty states as launchpads** — wire `mini-empty` into voice, forms, leads, apps, domains, site-features (every empty state = the one button that creates the first result).
- **[HIGH] God-component split (perf + a11y)** — `analytics` 134K, `billing` 138K/2790ln, `social` 131K, `snapshots` 109K, `settings`/`site-data-browser` ~88K → lazy `@defer` per tab; each folded tab needs its own single `<h1>` (axe-blind H1 gaps).
- **[HIGH] Entitlement/seat/flag-locked controls show reason + upgrade CTA** — never a dead button (billing, site-features `37K`, team); `action-button-must-gate-on-server-precondition`.
- **[HIGH] Analytics reconcile** — verify displayed counts vs D1 `visitor_events` (prior lying-empty incident); date-range + compare-to-prior across cards.
- **[HIGH] Domains attach happy-path** (`domains.component.ts` 47K + `domain-manager` 38K) — re-prompted thrice historically → real-browser-verified path + inline real-time DNS→SSL status; one-click "buy + attach + verify" express.
- **[MED cluster]** Unified Notifications center `/admin/notifications` (full psnotify inbox beyond the bell) · AI "next best action" strip · Site Doctor per-site health rollup + one-click fixes · onboarding checklist widget · visual snapshot diff (`snapshots-diff`) · keyboard nav ↑↓enter on every list · undo on every mutation · consistent section chrome (H1 + breadcrumb + project pill) · brand-token audit (`_polish.scss`) · forms inbox bulk actions + reply-via-email · voice/apps/leads/deliverability real-time + empty-state provision.

### 4.2 Editor features (brief 02)

- **[HIGH] Command palette (Cmd+K) + fuzzy file open (Cmd+P)** — absent today; biggest embarrassingly-easy + keyboard win. One entry to every action/file/route.
- **[HIGH] AI inline code edit + explain** in CodeMirror (`EditorPanel.tsx`) — select→edit / hover→explain; today AI lives only in the chat column. Highest AI-native leverage.
- **[HIGH] Restore Preview responsive/device switcher** (`Preview.tsx`) — device list coded but `isDeviceModeOn=false` (orphaned); wire back + 6-breakpoint quick toggle.
- **[HIGH] Inspector → AI round-trip** — click element in Preview → "change this" as a chat/inline patch, not just `ElementInfo`.
- **[HIGH] Live build/deploy progress + prod-verify rail** — extend `SiteImportStatus`/`PS_GENERATION_STATUS`; deploy isn't fire-and-forget (`ProjectHub.tsx`); show final URL + health.
- **[HIGH] Kill manual Refresh/Reconcile** in `BucketsPanel`, `DatabasePanel`, `NamespaceSummary`, `ImportPanel`, `LockManager`, `ProjectHub`, `EnvAssignmentGrid`, `GitPanel` — visibility-aware poll / `PS_*` bridge push.
- **[HIGH] Boot UX** — `EditorLoadingScreen`/`editor-boot.ts` show real per-step progress (boot→install→dev-server→files), brand-locked cinematic loader opaque from frame 1 (no FOUC).
- **[HIGH] Chat site-context-aware by default** (`Chat.client.tsx`) — auto-inject current file/selection/route.
- **[HIGH] Database Tables list surfaces row-count/last-modified** (`SiteTablesPanel.tsx`, 183K ⚠split) — Airtable feel; AI "add column from description".
- **[MED cluster]** Result-grid + table CSV/JSON export (SQL + Tables — no export path) · media drag-drop upload + AI alt-text (Resources) · chat slash-commands (`/add-page` `/deploy` `/seed` `/seo`) · env/secrets first-class per-site view (`EnvAssignmentGrid`) · AI schema/migration assistant (extends `AiSeedPanel`) · keyboard keymap + `?` cheatsheet · split oversized (`SiteTablesPanel` 183K, `ResourceDetailPanel` 75K, `BucketsPanel` 70K, `embedded-mode.ts` 93K) · blanket brand override maps `--bolt-elements-*`→`--ps-*` · **update stale `projectsites-editor-layout` skill** (still says `Code|Preview|Functions|Data`; reality `Code|Preview|Database|Resources`) · confirm `FormBuilder.tsx` reachable or archive (orphan).

### 4.3 App catalog (brief 03)

- **[HIGH] cf-native is the north star** — every container app that CAN run on Workers+D1+R2 migrates off CFC (Payload proves it: own D1+R2+Worker, no cold-boot, no Neon burn). Container-only for genuine long-lived processes (Ghost, Chatwoot, n8n). Convert **Umami → cf-native** (D1 + Analytics Engine).
- **[HIGH] Make Payload the template** every new catalog member copies.
- **[HIGH] Surface ~10 wired-but-uncatalogued DO classes** (~47 exist: ghost, cal, nocodb, teable, plausible, uptime-kuma, directus, chatwoot…) — built-but-unwired (interconnectedness).
- **[HIGH] Kill container-centric copy leak** — gate Dockerfile/Port/RAM/"booting container" UI on `image?.startsWith('cf-native:')`; grep the whole apps section every cf-native add.
- **[HIGH] Close catalog↔`supported`↔infra drift** — LiteLLM live at `llm.megabyte.space` but `supported:false`; one SSOT reconcile.
- **[HIGH] New members** — Cal.com (#1 SMB ask; `cal` DO wired) · NocoDB/Teable over the site's per-site D1 (no new Postgres) · Ghost blog/newsletter · Chatwoot helpdesk (`support.projectsites.dev`).
- **[MED cluster]** real logos + 2-3 screenshots per card (emoji reads cheap) · zero-config auto-wire every `auto:'secret'`/`postgres_url`/`public_url` at deploy (Listmonk SES, Open WebUI LiteLLM) · real-time instance status (no Refresh) · **never reduce DO subclasses** (deploy-break 10064 — only ADD) · Stirling PDF cheapest quick win to flag supported · pick ONE flagship chat app (Open WebUI vs Lobe).

### 4.4 Generated-site product + pipeline (brief 04)

- **[HIGH] Flip `build_validators.ts` `report → strict`** for the proven template — 31 validators exist but don't block; a thin/broken build ships.
- **[HIGH] Reconcile fast-path vs swarm doctrine** — `container/local-agent.mjs` runs a ~15min MINOR-CUSTOMIZATION fast-path (no fan-out, no audit swarm), NOT the CLAUDE.md "20-30 prompt / 7-agent" philosophy. Either run a bounded parallel enrich pass or demote the swarm doctrine to the post-publish `snapshot-quality` loop.
- **[HIGH] Add a competitor-research + ≥15% floor gate** — doctrine mandates OUR build outscore every competitor on every dim by ≥15%, but the pipeline has NO competitor gate; `snapshot-quality` scores US vs our own prior run. Add source+competitor scoring feeding a hard floor; flag `deepcrawl_competitor_research`.
- **[HIGH] Automated source-vs-rebuild reconcile** — "BEAT the source" is prose; gate content parity (every source route + image group round-trips; 1:N page count; denser copy).
- **[HIGH] Quotable-answer block + AEO one-sentence answer + `<app-rolling-counter>` stat band** as first-class required sections (GEO/AI-search floor).
- **[HIGH] Trust strip / proof band** sourced from REAL research data with a self-hiding guard (no datum → render nothing) — memory flags hardcoded/lying proof-stats.
- **[HIGH] Per-page AI podcast** (3-min, MeloTTS/Piper self-hosted) — extend `page_audio.ts` summary→narrative episode per route; AI-narrated 404.
- **[MED cluster]** typed `SECTION_CATALOG` module (name·vertical·required-data + Zod + coverage test — today prose-in-prompts) · JSON-LD-matches-visible-content + BreadcrumbList-presence (≥2-deep) validators · build-time CWV gate (hero `fetchpriority`+dims, no-decorative-hero-video — TTFR) · maximalist gaps (before/after slider, bento, timeline/process, calculator, resource library, glossary, press strip, local sticky bar) · AI-native (multimodal contact form, behavioral hero swap, GPT POI map, per-visitor PDF, voice tour) · View Transitions + scroll-driven baseline · published-site scorecard (readiness grade + meanScore) surfaced in admin + block promotion below threshold · OG branded-card check + FAQPage-only-when-real enforcement.

### 4.5 Notifications + comms (brief 05)

- **[HIGH] Ship the psnotify DO — the #1 gap.** `src/services/psnotify.ts` is a STUB (`console.warn` + `{success:true}`); no `libs/features/psnotify/` DO. Build the DO inbox + fan-out to in-app/email/SES/web-push adapters so `notifyUser` actually lights the bell.
- **[HIGH] Unify the bell feed onto psnotify** — point `/notifications` at the DO inbox; retire the `audit_logs`-derived `activity_feed` so worker-fired == user-seen (producer↔consumer drift today).
- **[HIGH] Real-time delivery, kill the 60s poll** — DO WebSocket/SSE push to `notification-bell.component.ts`.
- **[HIGH] Server-persist preferences + enforce them** — move prefs off `localStorage` to D1; gate every send through `resolvePrefs`/`routeNotification` (declared, not enforced).
- **[HIGH] New notification types** — build-progress stream (generating→imaging→published, not just terminal email) · domain/DNS lifecycle (pending→dns→ssl→live + expiry) · billing lifecycle (trial-ending, card-expiring, payment-failed+retry-date) · security/account (new-device, role change, API-key created).
- **[MED cluster]** wire web-push (PWA installed) + optional SMS (Twilio voice present) · expand outbound-webhook allowlist beyond 6 events (`subscription.*`, `invoice.*`, `lead.discovered`, `ai.*`) · gorgeous full-page `/admin/notifications` center (filter/mark-all/bulk) · per-notification `action_url` deep-links everywhere · digest tiers + List-Unsubscribe + one-click unsub · enforce copy formula (<15 words, actor-action-object, owner words) · batching/digest windowing (highest fatigue-reduction lever) · degraded-quality generation flag to user.

### 4.6 Backend platform (brief 06)

- **[HIGH] Public REST API v1** — promote `public_api` to beta. `psk_live_*` keystore + OpenAPI 3.1 + scoped tokens ship DARK; expose `GET/POST /api/v1/sites`, `/v1/sites/:id/deploy`, `/v1/sites/:id/db/*`, `/v1/media`, `/v1/forms/submissions` behind the token middleware. The "deliver websites programmatically" wedge.
- **[HIGH] Per-site Functions GA + local dev** — WfP dispatch + `functions/` convention built (ADR-0035); add typed request/response contract, `wrangler dev`-parity runner, per-function logs/metrics in the editor, cold-start/cost guards.
- **[HIGH] Platform MCP as a first-class product** — publish a documented MCP catalog (create-site, deploy, query-db, list-media, submit-form) + `.well-known/mcp` discovery so external agents drive the platform.
- **[HIGH] Enable Analytics Engine ingest** — `ANALYTICS_INGEST_ENABLED="false"`; the CF-native metrics backend the doctrine mandates isn't writing. Enable + verify per-subdomain RUM/event sampling; reconcile display-vs-store.
- **[HIGH] IDOR gates into visible CI** — `.github/workflows/` has ONLY `build-container.yml`; the IDOR + feature-architecture gates run via `npm run`/predeploy, not a GH job. Add `feature-architecture.yml` + IDOR-gate workflow so drift blocks on push.
- **[HIGH] Feature-module drift** — 89 feature dirs, ~20 with valid `feature.manifest.ts`; `api_keys`/`audit_logs` are handlers-only. Add "handlers.ts dir MUST have a manifest" check + backfill; verify entitlement gate is fail-closed on transient + `active`-vs-`trialing`.
- **[MED cluster]** wire `idempotency` middleware onto all money/site-mutation POSTs (`/billing/*`, `/domains/purchase`, `/sites/:id/deploy`) · outbound-webhooks GA (svix-style delivery) · analytics/usage export API · unify per-site D1/KV/R2/Vectorize into one `/api/v1/sites/:id/resources/*` contract · Zod on the 23 `req.json().catch(()=>({}))` cast routes (per-feature on promotion, never blind mass-retrofit) · route-order assertion test · activate Better Auth behind a rollout flag · provision CF Flagship + `sync-flags-to-flagship.mjs` · add Vectorize (semantic site search / "sites like mine" / concierge grounding — the missing D1+Vectorize+DO leg) · per-route CPU/cost budget + `cost-estimator`.

### 4.7 Competitor-driven killer features (brief 07)

- **[HIGH] Native AEO/GEO layer** (Webflow proves) — auto schema + direct-answer blocks + citation tracking across ChatGPT/Perplexity/Gemini/Claude/AI-Overviews + an "AI-search visibility" admin panel. THE 2026 battleground (search −25% by 2026). Extends our JSON-LD.
- **[HIGH] Auto-build from Google Business Profile** (Durable proves) — pull hours/photos/reviews/services from GBP so the owner types almost nothing; deepens "search your business → done"; kills the empty-prompt→generic-site problem.
- **[HIGH] Continuous/agentic post-launch optimization** (10Web/Readdy) — a background agent that keeps improving SEO/CWV/AEO/copy after go-live (fits WfP + Workflows + "self-diagnosing"); reframes site as a growing asset.
- **[HIGH] Business-OS bundle** (Durable proves) — CRM + invoicing + analytics + marketing beside the site; our app-catalog is the seed → a "run your business" hub (sell outcomes not pages).
- **[MED cluster]** brand-voice engine (Squarespace) applied to ALL generated + future copy · "3 demo styles to pick" at first result (Hocoos) · own-your-code/GitHub export (Lovable — aligns w/ deliverable-portability) · advertise a CWV/Lighthouse guarantee (10Web 90+, we already gate) · real-browser self-test + auto-heal made visible to the owner (Replit) · voice/image input (Hostinger) · dynamic apps not brochureware (per-site D1 + Functions) · sub-60s FIRST PREVIEW (<15min publish) · ask ≤3 questions · free preview BEFORE signup/pay · post-build visibility/health score + fixes.
- **Moat:** truly-live finished site (not editor + 80% to finish) · content that beats the source, cited · AEO-ready by default · business-OS + dynamic apps · continuous optimization agent · one CF bill, edge-fast, per-site isolated. No single competitor holds all six.

### 4.8 Best-practice patterns to adopt (brief 08)

- **[HIGH] Cmd+K palette where EVERY admin action is reachable** (Linear gold standard; command palette is baseline, not luxury; ~+25% power-user completion).
- **[HIGH] Re-audit IA around owner JOBS** ("get my site live" / "edit copy" / "see who contacted me" / "get paid") vs feature-named nav (task-first IA ~45% faster).
- **[HIGH] Every editor change lands through a reviewable gate** (snapshot/PR-like diff-review before publish) — Code Project hub is the canonical entry.
- **[HIGH] Prefer tool-calling → registered-component GenUI** over free-form chat for AI surfaces (site-gen results, data insights, concierge return a preview card / chart / editable form). NEVER ship runtime-LLM markup (pattern 3) to owners.
- **[HIGH] Inline/no-chat AI beats a bolted-on sidebar** — edit-in-place, insight panels in analytics, prefill in create (AI-permanence + embarrassingly-easy).
- **[HIGH] Reinforce the VERIFIER leg + loop guardrails** — gate DONE on executed tests + prod-E2E asserting real content, never self-report (#1 researched failure mode); add MAX_ITERATIONS cap, reflection prompt between retries, kill/reassign after ~3 stuck iterations, hard token budget.
- **[HIGH] Keep CLAUDE.md/AGENTS.md HUMAN-curated** — LLM-generated context files give ~0 benefit, can cut success ~3% + raise cost ~20%.
- **[MED cluster]** Data tab feels like Airtable (inline edit/filter/sort/type-aware) not a SQL dump · agentic data workflows ("when a form arrives, do X") onto Functions/WfP · granular per-category × per-channel notification prefs + quiet hours + digests · role/stage-adaptive default views · add Vectorize (semantic leg) · route ALL LLM through AI Gateway w/ metadata + fallback · audit site-gen Workflow steps for idempotency + cached outputs + `waitForEvent` for "build needs input" · model per-site agents as DOs (own SQLite, hibernation) · prefer topology routing over peer debate; note Agent SDK one-level-deep subagent limit.

## 5 · Standing scope / infra / architecture

- **Migration 0646** — apply to prod D1 (additive/idempotent, DARK) in a full-visibility run (`durable_preview`).
- **Cold-provision fix** — `src/services/d1_provisioner.ts`: idempotent create + await readiness (new-site first `/db/query` CREATEs race).
- **Editor `app/` → `apps/editor/`** — discrete relocation pass: root `wrangler.toml`, vite configs, `functions/`, `electron/`, CF Pages `bolt-diy` settings; editor build + Pages deploy verify.
- **Lockfile regen** — `npm install --legacy-peer-deps` (removed workspace members still listed; `pnpm install` FAILS on electron-builder SSH dep).
- **Worktree prune** — ~68 leftover `.claude/worktrees/agent-*` (`git worktree prune`); explicit `git worktree remove` + `git branch -D` per fire (stranding incident class).
- **Resolve/retire** `apps/web` v2 Angular plan (`.cleanup-allowlist` references a non-existent dir); decide Electron desktop packaging (remove unless a real goal).
- **Preview loading UX** (Msg-3b remainder) — mirror preview-boot message into editor CHAT + wire signal to BaseChat + AI-ensures-boot backend (`Preview.tsx`).
- **Source TODOs** — `useChatHistory.ts:416` FIXME navigate-fn rerenders `<Chat/>` (needs real fix, test-first); deferred-lowvalue `@deprecated` shims (`external_llm.ts:193`, `smtp_config.ts:19`, `browser_gateway.ts:44`); blocked-external `abuse.ts:36` arcjet adapter, `media.ts:557` Sora/Veo public API.
- **CF resource IDs** — Account `84fa0d1b16ff8086dd958c468ce7fd59` · Zone projectsites.dev `9ceaa211750dd31899fd5d1bf8d1ec46` · Pages bolt-diy `76c34b4f-1bd1-410c-af32-74fd8ee3b23f` · D1 prod `ea3e839a-c641-4861-ae30-dfc63bff8032`. WfP test site `4f450690-e622-4c95-a83d-e5516a2c9442`.
- **Removed — never reintroduce:** Supabase · phone-OTP (Twilio VOICE kept) · Lago/Unkey/Nango/Inngest/Novu (psnotify replaces Novu) · AI Agents (`ai_endpoints`/dispatcher — replaced by code-defined Functions on WfP) · **Resend send rail** (SES sole, SendGrid break-glass; per-site Resend MCP is a separate customer feature, kept).

## 6 · Brian-gated (approval-required) + Blocked-user (NEVER auto-execute)

Ship the decision-independent slice; surface the exact unblock. Never auto-run.

**Brian-gated (approval-required):**
- **ConversationHub DO deletion** (`src/index.ts:250`) — destructive one-way-door DO migration (`deleted_classes`); DEFERRED indefinitely; needs explicit confirm + correct tag (procedure in source comment).
- **GPT-4o vision → Workers-AI swap** per callsite (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- **Backend-complete → decide frontend render** for 4 surfaces (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- **Geo-sweep + admin form + `/admin` persistence** (`_LOOP_LEDGER.md` NEEDS-BRIAN).

**Blocked-user (awaiting a credential/decision only Brian can provide):**
- **LinkedIn OAuth** creds · **Reddit OAuth** creds (blocked 4+ days).
- **Stripe `STRIPE_PRICE_ID_MONTHLY_WALLET`** — landed; needs integration wiring.
- **DeepSeek $5 top-up** — unblocks bespoke build-LLM copy + build-LLM-gated cohort rebuilds.

## 7 · Sub-ledgers (source-of-truth pointers)

Granular state lives HERE, not duplicated above. Delegate reads to a fresh Explore agent (main thread never ingests them).

- **`apps/project-sites/_RUN_THE_LOOP.md`** — the live queue: 7 workstreams + harvested backlog + Brian-gated + blocked-user + Done log. The command advances the frontier here.
- **`.claude/loop.md`** — the 6-loop whole-app-DoD roster + PRIME DIRECTIVE + perfect-repository dimensions + E2E/TDD doctrine (the exhaustive backstop machine).
- **`apps/project-sites/_APP_COMPLETION.md`** — whole-app Definition of Done: § A admin · § B full flows · § C generated-site quality · § D marketing/SEO · § E editor + progress + gap-implementation log.
- **`apps/project-sites/_LOOP_CHARTER.md`** — SSOT charter every `/loop` fire obeys (real-journey · progressive-enhance · faster-pace).
- **Per-workstream checkpoints/ledgers** — `_PROMOTE_WORKFLOW_CHECKPOINT.md` · `_ADMIN_VQA_LEDGER.md` · `_INTERCONNECTEDNESS_LEDGER.md` · `_LOOP_LEDGER.md` (2.3MB — NEVER main-thread-read) · `docs/wfp-site-hosting.md` · `docs/data-platform-scope.md` · `docs/database-tab-enhancements.md` · `docs/data-section-capability-matrix.md` · `docs/FUNCTIONS-CONVERGENCE.md` · `docs/decisions/0035-custom-code-endpoints-wfp.md`.
- **`docs/_loop-scan/01..08`** — the full per-dimension scans (admin · editor · app-catalog · generated-site · notifications · backend · competitors · patterns) distilled into §4.
- **Command:** `.claude/commands/run-the-loop.md` — what "run the loop" invokes.
