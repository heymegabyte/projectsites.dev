# DISCOVERIES — not-yet-scheduled opportunities

> The bench: opportunities surfaced by discovery/audit agents but NOT yet promoted to
> [`./BACKLOG.md`](./BACKLOG.md). Short bullets. When a discovery gets ground-truthed + scoped,
> move it to BACKLOG with full metadata. Cross-links: [`./README.md`](./README.md) ·
> [`./LEDGER.md`](./LEDGER.md). Full CF-native decomposition: `apps/project-sites/_CF_NATIVE_CONVERGENCE.md`.

---

## fire-50 DESIGN Recs (need a design call before coding)

- **Served-time meta-desc validation** — per-route descriptions are client-set (CSR); the build
  validator only measures the shell placeholder. Needs SSG pre-render OR a crawl-time (post-JS)
  validator to check the real served `<meta description>`.
- **Top-bar injected onto error pages** — `buildSiteResponse` renders the unpaid promo bar above
  404/500 pages; gate it off non-content routes.

## CF-native convergence lanes 12-18 (from `_CF_NATIVE_CONVERGENCE.md`)

> The ONE loop advances these RED-first, flag-gated, one slice/lane/fire. F is SERIAL single-owner
> (owns `packages/shared/**` + `migrations/**`, migrations ascending from 0648). No second cron.
> Immutable spec: `docs/_cf-convergence/MANDATE.md`; per-stream evidence: `docs/_cf-convergence/audit-{A..F}.md`.

- **Lane 12 — F (shared contracts + migrations, SERIAL):** F1 `voice_receptionist` flag ✅ (done
  fire-50). Remaining: F3 contract collision hotspots (`webhook.ts`/`media.ts`/`billing.ts`/`api.ts`/
  `base.ts` shared across streams); F4 cross-stream migration plan (voice calls/media/critique, number
  state machine, per-call Stripe ledger, mcp grants + `mcp_resource_tokens`, Traks analytics, short-
  links store, OpenSEO cost ledger).
- **Lane 13 — A (Voice + all-call media):** A0 token-shape ✅. A1 setup/recording/reviews tabs; A2
  voice gallery + real Test Console on the shared AI chat; A3 every-call session + browser-start on
  answer (create `voice_calls` row on ANSWER not END — abandoned calls leave no record today); A4 CDP
  pixel-capture spike vs rrweb; A5 dual-channel Twilio WAV (blocked by ADR-0056 + staging); A6 synced
  audio+video detail; A7 conversations = calls directory + 206 streaming (route exists, bypassed); A8
  timecoded critique → per-site behavior rule; A9 consent policy (spoken-only + unenforced today).
- **Lane 14 — B (Twilio/SMS/Stripe) 🔴:** B0 orphan-number killswitch ✅ (flag `voice_numbers` gates
  purchase). Remaining: B1 number-search polish (truthful "Recommended" label, account-specific fees);
  B2 purchase txn boundary (quote→Stripe auth→state machine→bind VoiceUrl/SmsUrl, subaccount per org);
  B3 pricing model ($0.25/started-min, no lying $0 rental, read `pricing_config`); B4 Stripe rental +
  metered voice + immutable CallSid ledger (`BILLING_PROVIDER=noop` drops all metering today); B5
  SMS/10DLC/TFN compliance (Brand/Campaign, opt-in, STOP/HELP); B6 remaining.
- **Lane 15 — C (Editor Claude-Code + Sandbox + browser):** C1 `/api/sites/:id/workspace`
  501-when-Sandbox-unbound (pin `@cloudflare/sandbox` — ABSENT today); cull/repurpose orphaned
  `ide_sandbox.ts` simulation (→ folded into CAMPAIGN lane 8, BACKLOG) + dead migration 0504; CF Browser Run Live View replaces Browserbase-only;
  never leak master D1/account tokens to the container; typed cards; ideas 1-12.
- **Lane 16 — D (ProjectSites MCP broker) → folded into CAMPAIGN lane 6 (BACKLOG):** D0 audience-bound site-scoped token (wire orphaned
  `mcp_resource_tokens`); one versioned Streamable-HTTP MCP endpoint + OAuth 2.1; recheck policy at
  `tools/call` (reject swapped Site IDs — org-wide 90-day token today, no live IDOR); ideas 1-12.
- **Lane 17 — E (CF-native surfaces + Inspector-removal + Social-10):** Inspector removal (26 files
  / ~4600 LOC full inventory); EmDash catalog · microfeed · Traks analytics · OpenSEO · Slink
  shortlinks · Automations · Email · health tile; Social 10-pass campaign (2649-ln god-component);
  E7 D1-export + E8 shortlinks near-done. Preserve site-scoped R2/D1; AGPL isolation via HTTP boundary;
  no double-count.
- **Lane 18 — Resources cockpit + Advanced console (Brian directive) 🔴:** R1 kill Refresh/Reconcile
  ✅ (ResourceOverviewPanel → 45s visibility-poll). Remaining: R2 promote 9 adapters to tabs; R3 drop
  Site-files/Media tabs (security — deploy-artifact bucket must be hidden); R4 R2 manager; R5 fix dead
  Add; R6 Advanced→tabs; R7 Secrets/Connections/Functions/Schedules; R8 honest-limit tabs.

## Cross-cutting (from convergence §10)

- **Jest → Vitest migration** — kills the `@swc/jest` mock-hoist pitfall (global `jest` required for
  hoisting; `import {jest}` silently no-ops the mock).
- **psnotify deploy `v_psnotify_do`** + fan-out adapters + bell-unify (also in BACKLOG feature lane).

## Site-scoped R2 Bucket Manager (multi-fire, `docs/r2-bucket-manager.md` — TOP PRIORITY)

> Full slice plan + architecture map seeded in the doc. Flag `r2_bucket_manager`. Each fire = ONE
> coherent slice, RED-first + real-R2 E2E. Promote to BACKLOG when picked up.

- Slice 1 ✅ foundation (`site_r2_buckets` catalog + `resolveSiteBuckets` + service-layer protection +
  RED tests). Slices 2-8: bucket-scoped S3 creds (encrypted, reveal-after-reauth) · key rotation ·
  delete + "Empty and delete" (paginated/multipart/recoverable) · Code-panel storage selector · object
  explorer (list/upload/download/preview/edit-conflict/copy/move/delete/metadata) · remove Site-files +
  Media from Resources + route API/MCP through the same authz · E2E A-G + guarded real-CF-R2 staging run
  with disposable prefixed buckets + failure-injection. INVARIANTS: server-side authz recheck every call
  (IDOR-tested); system isogit bucket protected at the SERVICE layer; secrets never in localStorage/logs;
  idempotent/retryable provision+rotate+delete; never delete customer data on UI removal.

## Competitor-driven killer features (brief 07 — the 2026 battleground)

- **Native AEO/GEO layer** (Webflow proves) — auto schema + direct-answer blocks + citation tracking
  across ChatGPT/Perplexity/Gemini/Claude/AI-Overviews + an "AI-search visibility" admin panel. Search
  −25% by 2026. Extends our JSON-LD.
- **Auto-build from Google Business Profile** (Durable proves) — pull hours/photos/reviews/services
  from GBP so the owner types almost nothing; kills empty-prompt→generic-site.
- **Continuous/agentic post-launch optimization** (10Web/Readdy) — a background agent keeps improving
  SEO/CWV/AEO/copy after go-live (fits WfP + Workflows + "self-diagnosing").
- **Business-OS bundle** (Durable proves) — CRM + invoicing + analytics + marketing beside the site;
  our app-catalog is the seed → a "run your business" hub (sell outcomes not pages).
- **Moat:** truly-live finished site + content that beats the source (cited) + AEO-ready by default +
  business-OS + dynamic apps + continuous optimization agent + one CF bill, edge-fast, per-site isolated.
  No single competitor holds all six.

## Site-generation quality gaps (brief 04 / Lane 7 — the CORE product)

- **Competitor-research + ≥15% floor gate into Phase -1** — doctrine mandates OUR build outscore every
  competitor on every dim by ≥15%; the pipeline has NO competitor gate (`snapshot-quality` scores US vs
  our own prior run). Flag `deepcrawl_competitor_research`.
- **Reconcile fast-path vs swarm doctrine** — `container/local-agent.mjs` runs a ~15min minor-
  customization fast-path, NOT the CLAUDE.md 20-30-prompt/7-agent philosophy. Either bounded parallel
  enrich pass or demote the swarm doctrine to the post-publish `snapshot-quality` loop.
- **Automated source-vs-rebuild reconcile** — gate content parity (every source route + image group
  round-trips; 1:N page count; denser copy).
- **Flip `build_validators.ts` report→strict on a FRESH build** — FP exclusions shipped (non-content
  shells + demo assets + sitemap↔SPA reconcile); the 3 live probe sites carry REAL content debt strict
  CORRECTLY catches, so canary strict on a freshly-built site + re-run the FP harness `--slugs` green.
- **First-class required sections** — quotable-answer block + AEO one-sentence answer + `<app-rolling-
  counter>` stat band (GEO/AI-search floor); trust strip from REAL research (self-hiding guard); per-page
  AI podcast (MeloTTS/Piper, extend `page_audio.ts`); typed `SECTION_CATALOG` module (Zod + coverage test,
  today prose-in-prompts); build-time CWV gate; JSON-LD-matches-visible + BreadcrumbList validators.

## Best-practice patterns to adopt (brief 08)

- Re-audit IA around owner JOBS ("get my site live"/"edit copy"/"see who contacted me"/"get paid") vs
  feature-named nav (~45% faster).
- Prefer tool-calling → registered-component GenUI over free-form chat for AI surfaces (never ship
  runtime-LLM markup to owners).
- Reinforce the VERIFIER leg + loop guardrails — MAX_ITERATIONS cap, reflection prompt between retries,
  kill/reassign after ~3 stuck iterations, hard token budget (#1 researched agent failure mode).
- Model per-site agents as DOs (own SQLite, hibernation); route ALL LLM through AI Gateway w/ metadata
  + fallback; audit site-gen Workflow steps for idempotency + cached outputs + `waitForEvent`.

## Standing scope / infra one-offs (from `_LOOP.md` §5)

- Fold migration 0646 apply into the prod pipeline (also in BACKLOG architecture). Cold-provision fix
  ✅ done (`d1_provisioner.ts` + `site_data_db.ts`, idempotent + bounded readiness poll).
- Port the 3 `xit`-skipped boot-veil specs (`editor.component.spec.ts`) to an `admin.component` spec +
  un-skip (the veil moved to `admin.component` on main).
- Provision CF Flagship (`FLAGSHIP_API_TOKEN`/`FLAGSHIP_APP_ID` + `[[flagship]]` binding) + run
  `sync-flags-to-flagship.mjs` — D1 flag engine is the fallback + admin SoT today (Flagship unprovisioned).

## Discovery rotation note (fire-50)

Generated-site PUBLIC RUNTIME is now saturating (5 next-wave tasks + 2 design recs shipped to BACKLOG).
**Next discovery rotation → real-user golden journeys (`e2e/golden-path`) OR the template repo**
(`github.com/HeyMegabyte/template.projectsites.dev`). A fire that appends zero next-wave tasks = the
discovery agent under-scanned → rotate area next fire.

## fire-53 — Deep UI Explorer first live pass (documented-path vs real UI)

- **Deep path CONFIRMED as documented**: Editor › Database › Tables › **Actions menu** →
  **History** opens the Time-Travel OVERLAY (`database-action-overlay`) — History is NOT a
  top-level Database tab. Menu items observed live: New Table · Import · History · Refresh.
- **Actions menu is header-level** (not per-row) — reachable even with 0 tables (blank per-site D1).
- **Editor boot latency**: Database tab becomes visible ~35-60s after /admin/editor mount
  (WebContainer + files handshake) — explorer polls up to 120s before calling BLOCKED.
- **Sub-nav is role=tab FILLED pills** — which is how the brand override's blanket active-tab
  cyan-glow (`!important`) made active labels invisible (fixed fire-53; see LEDGER).
- **Two side-by-side "TABLES (N)" lists render in the Tables view** — master list + pick-a-table
  pane look identical at first glance; queued for intent-verification (visual-intelligence lane).
- **"Loaded 49 files" toast** renders near-illegible (light-on-light) across ≥3 consecutive
  states in the embedded editor — persistent, not a fade artifact; queued with evidence.
- **Vision provider reality**: OpenAI key 429-quota-exhausted; Anthropic key "credit balance too
  low" — both recorded BLOCKED; Workers AI Llama 4 Scout (the product's own VISION_MODEL) via
  AI Gateway is the labeled fallback reviewer until credits return. Scout tends to emit
  positive observations mislabeled as p0 — treat its severity as advisory, confirm in pixels/code.

## fire-55 — cf-native-ai campaign opened

- Spec: `.claude/run-the-loop/CAMPAIGN-cf-native-ai.md` — the lossless condensed canonical (single
  source; never re-derive from code). Source-review baseline commit `29007fdf2`.
- BACKLOG gains `## CAMPAIGN — cf-native-ai`: 11 dependency-chained lanes, 41 first slices. Chain:
  inventory → policy → key-grants/model-routing → protocol adapters → managed execution; OAuth +
  Chat consume the SAME policy/executor; workspace ADR precedes editor migration; LiteLLM proxy
  removal only after verified caller cutover.
- Wave-0 artifacts expected: `docs/_campaign/litellm-inventory.md` + `docs/_campaign/
  foundations-verify.md` + `e2e/ai-api/` RED protocol-conformance specs (§17.1/2 TDD scaffold).
- Folded/referenced: DISCOVERIES Lane 16 (D — MCP broker) → CAMPAIGN lane 6; Lane 15 `ide_sandbox`
  cull → lane 8; BACKLOG App-catalog LiteLLM SSOT line → lane 9 (removal); "Public REST API v1"
  `psk_live_*` keystore is EXTENDED by lane 3 — one token DB, never two.
- Removed AI-endpoints product STAYS removed — no UI-authored per-site endpoints resurrected; Site
  Functions remain code-defined WfP.
