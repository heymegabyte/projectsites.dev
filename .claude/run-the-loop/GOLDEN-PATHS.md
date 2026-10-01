# GOLDEN-PATHS.md — Long-Journey Registry (fire-59)

## Purpose

Golden paths are executable product design: long, stateful user journeys written around the INTENDED excellent product, not current limitations. Each path pulls the product toward completion — a step that needs a missing capability records `CAPABILITY GAP: <x>` and stays in the path forever until shipped. Paths are the loop's demand signal; the BACKLOG is the supply.

## How paths run today (tooling bindings)

- **Long-Trail runner** — `apps/project-sites/e2e/long-trail/` (`case-001-money-path.e2e.ts` + `.md` + `checkpoint-case-001.json` + `playwright.longtrail.config.ts` + `screenshots-local/`). Standing case-001 is `phase_c_green`, last_completed_action **37**; resumes **Phase D at action 38** (Bolt editor: Code edit + Preview live-reload + per-site D1 Data tab isolation — needs the editor iframe in the local stack). gp-01/gp-02 are case-001's Phase A-C / Phase D formalized.
- **Deep UI Explorer** — `apps/project-sites/e2e/deep-ui-explorer/{explorer.mjs, vision-review.mjs, coverage-ledger.json}` (loop role 17): crawl-click-screenshot-vision with honest CF-pass/FALLBACK/BLOCKED semantics. gp-07's engine.
- **Journey spec suite** — `apps/project-sites/e2e/*-journey.spec.ts` (64 specs; inventory `e2e/FEATURES.md` + `COVERAGE.yml`, enforced by `npm run validate:e2e-inventory`). Per-surface depth; golden paths chain across them.
- **Ground-truth reconciler** — `apps/project-sites/e2e/admin-verify/` (`reconcile-surfaces.mjs`, `_capture-helpers.mjs`, `_browserbase-creds.mjs`): display-vs-D1 reconciliation. gp-04's engine.
- **Editor inventory** — root `e2e/` (bolt.diy `FEATURES.md` + `specs/*.spec.ts`): editor-native actions gp-02 composes.
- Case docs for new paths follow the long-trail format (`case-001-money-path.md`); checkpoints are durable JSON; prod runs via `playwright.prod.config.ts`, local via the long-trail config.

---

## Registry — 8 golden paths

### gp-01-owner-first-site — "Search box to live site in one sitting"
- **Persona:** Maria, bakery owner, zero technical skill. **Goal:** her business found, site generated, live, shared.
- **Status:** RUNNABLE (= case-001 Phases A-C, GREEN). **Binds:** `long-trail/case-001-money-path.e2e.ts` actions 1-37.
- **Steps (24):** (1-4) `projectsites.dev` → hero search → type business name → real listings render (Places; OSM fallback degrades gracefully) → (5-7) pick listing → "Build my site" → sign-in (email code / OAuth) → (8-9) email verify loop (SES inbox fixture) → session established → (10-15) build kicks off → live build stream renders events (collecting → imaging → generating) → progress is self-updating, no refresh button → completed state → (16-19) preview card → open `{slug}.projectsites.dev` → hero/brand/copy match the real business (no seeded-token slop) → visit 2 inner pages → (20-24) back to admin → dashboard shows the new site → copy-link affordance → share moment (OG card preview) → completion email received.
- **Surfaces:** marketing home, search, auth, build stream, generated site, admin dashboard, email.
- **Visual evidence:** steps 4 (results), 12 (stream mid-flight), 17 (live hero), 23 (share moment).
- **CAPABILITY GAP:** post-publish share moment (one-click copy + rendered OG-card preview) is not a first-class screen.
- **CAPABILITY GAP:** dedupe guard before build (same business re-searched must resume, not duplicate).
- **CAPABILITY GAP (fire-61):** served sites hardwire PROD absolute origins into the client plumbing — `site_serving.ts:1859` injects `<script src="https://projectsites.dev/app.js">`, the unified client's `API` defaults to prod, and the inline tracker beacons prod `/api/events` — so a LOCAL/preview composition leaks real traffic to prod unless shimmed (long-trail Phase E proxies the whole prod origin). Close by injecting `data-api` (+ a same-origin app.js src) derived from the serving host.

### gp-02-editor-database-deep — "Own your data without leaving the editor" (constitution's canonical example)
- **Persona:** Sam, technical-ish owner. **Goal:** inspect + edit the site's OWN database confidently.
- **Status:** PARTIAL (= case-001 Phase D, resumes at action 38). **Binds:** long-trail Phase D + editor `specs/` + Data-tab handlers (`libs/features/site_data_api/`).
- **Steps (26):** (1-4) sign in → pick site → open Editor → bolt iframe boots (persistent across sub-routes, one cold-boot per session) → (5-8) Data tab → tables list reads the site's dedicated per-site D1 (NEVER shared platform DB; lazily provisioned) → blank-DB empty state is a launchpad ("Create your first table" / seed sample) → create or pick table → (9-14) rows grid renders → double-click cell → inline edit → Enter commits (optimistic + background reconcile) → Esc cancels → edited value persists on re-select → (15-19) filter by column value → sort asc/desc → paginate → honest totals (no silent cap) → (20-24) SQL console → run `SELECT` against `db/query` endpoint → results in the shared datagrid → run an `UPDATE` → grid reflects it → (25-26) back to Code tab → editor state intact (no iframe reload).
- **Surfaces:** admin shell, bolt.diy editor iframe, Data tab (tables + grid + SQL console), per-site D1 plane.
- **Visual evidence:** steps 6 (tables/empty-state), 11 (cell mid-edit), 22 (SQL results).
- **CAPABILITY GAP:** editor iframe in the long-trail LOCAL stack (the action-38 blocker — editor.projectsites.dev or local equivalent wired into the harness).
- **CAPABILITY GAP:** blank per-site D1 empty-state launchpad (seed sample table / guided first-table create).
- **CAPABILITY GAP:** keyboard-commit contract for cell edit (Enter/Esc/Tab) asserted end-to-end.

### gp-03-domain-go-live — "Your own domain, no DNS degree required"
- **Persona:** Dana, owns `danaplumbing.com` at a registrar. **Goal:** site answers on her domain with SSL, hand-held the whole way.
- **Status:** PARTIAL (units + endpoints GREEN per FEATURES.md; full real-domain cycle unexercised). **Binds:** `admin-domains-journey.spec.ts`, domain-picker component, `apps_routes` domain endpoints.
- **Steps (20):** (1-4) sign in → site detail → Domains → domain picker (canonical URL component) → (5-8) type domain → availability/ownership detect (RDAP) → owned path: attach → copy-paste-ready CNAME instructions with the exact record → (9-12) live DNS check (CF DoH) polls self-updating → detected → CF custom-hostname created (idempotent — 1406 re-attach safe) → SSL ladder renders dns → cert → connected → (13-16) connected state green → `https://danaplumbing.com` serves the site → old subdomain 301s → canonical/meta switch to the custom hostname → (17-20) set-primary → detach/re-attach safe → unowned path: register via CF-native registrar flow → bought domain auto-attaches.
- **Surfaces:** admin domains, DNS instruction panel, CF custom hostnames, live site on custom domain.
- **Visual evidence:** steps 8 (instructions), 12 (ladder mid-provision), 14 (live on custom domain).
- **CAPABILITY GAP:** sacrificial real test domain wired into the harness for the full DNS→cert→connected cycle.
- **CAPABILITY GAP:** CF-native in-product registrar purchase (no external GoDaddy deep-link as the primary sell).

### gp-04-analytics-truth — "The dashboard never lies" (causal reconciliation)
- **Persona:** owner checking "did anyone visit?". **Goal:** a real visit provably appears; display == authoritative store.
- **Status:** RUNNABLE (reconciler exists; causal loop CODIFIED LOCALLY fire-61 — long-trail Phase E drives visit→`visitor_events` delta→Analytics display (23 views reconciled) + form submit→`form_submissions`/`contacts`→Forms inbox detail, all store-anchored). **Binds:** `admin-verify/reconcile-surfaces.mjs` + `admin-analytics-journey.spec.ts` + `long-trail/case-001-money-path.e2e.ts` Phase E.
- **Steps (18):** (1-3) sign in → note current pageview count for the site → open analytics → (4-8) second browser context (clean, no auth) → visit own published site → browse 3 distinct routes → trigger beacon events → close → (9-12) ground truth: D1 `visitor_events` count incremented by the exact visit set (SELECT as the real org) → (13-16) admin analytics self-updates (visibility-aware poll — NO manual refresh control) → count reflects the visit within the freshness SLA → per-route drill-down lists the exact routes visited → (17-18) divergence classifier: groundTruth>0 && display==0 ⇒ LYING-EMPTY, counts differ ⇒ WRONG-SOURCE — either fails the path.
- **Surfaces:** published site, beacon pipeline, D1 visitor_events, admin analytics (edge vs beacon dual-source).
- **Visual evidence:** steps 3 (before), 15 (after — count moved), 16 (route drill-down).
- **CAPABILITY GAP:** declared freshness SLA ("visits appear within N min") surfaced in-UI and asserted.
- **CAPABILITY GAP:** causal probe as a standing automated check (action→store→display), not a manual reconcile run.

### gp-05-billing-upgrade — "Paying is the easiest thing we sell"
- **Persona:** free-tier owner hitting the top-bar banner. **Goal:** upgrade, feature unlocks instantly, invoice in hand.
- **Status:** PARTIAL (billing journeys GREEN for UI; checkout completion not automated). **Binds:** `admin-billing-journey.spec.ts`, `admin-and-billing.spec.ts`, Stripe webhooks.
- **Steps (21):** (1-4) sign in (free plan) → published site shows unpaid top-bar → admin surfaces the upgrade prompt at the moment of friction → pricing with one obvious plan → (5-9) checkout → Stripe hosted session (test card rail) → complete → return URL lands in admin with success state → (10-14) webhook lands (idempotent on terminal success) → entitlement flips (trialing COUNTS as entitled) → gated features unlock without re-login → top-bar GONE on the live site (causal re-visit) → (15-18) billing shows plan + next renewal → invoice row → invoice PDF/portal opens (keys: portal/checkout response contract) → (19-21) downgrade path visible → cancel keeps access till period end → state honest after webhook races.
- **Surfaces:** generated site (banner), pricing, Stripe checkout, webhooks, entitlements, billing panel.
- **Visual evidence:** steps 2 (banner), 9 (success return), 13 (banner gone), 16 (invoice).
- **CAPABILITY GAP:** automated Stripe test-checkout completion rail (hosted-checkout drive or stripe-cli webhook simulation) usable inside a golden-path run.
- **CAPABILITY GAP:** causal banner-removal assertion wired as one flow (upgrade → site re-fetch → banner absent).

### gp-06-keyboard-only-admin — "The whole cockpit without a mouse"
- **Persona:** power user / motor-impaired user. **Goal:** every admin outcome via keyboard alone.
- **Status:** PARTIAL (a11y spec exists; full traversal not codified). **Binds:** `accessibility.spec.ts` + axe gates + WCAG 2.2 checklist.
- **Steps (28):** (1-4) `/` → Tab reaches skip-link first → skip to content → sign-in entirely by keyboard → (5-10) Tab through admin nav — every section reachable, focus ring always visible, focus NEVER hidden under the sticky topbar (2.4.11) → Enter opens each of 6+ sections → (11-15) open a data table → arrow-key row navigation → Enter opens row detail → row-level menu opens via keyboard (no mousedown-only handlers) → Esc closes → (16-20) open a modal → focus trapped → Tab cycles inside → Esc closes → focus returns to the invoker → (21-24) Cmd+K palette → type-ahead to any section → Enter navigates → (25-28) form fill + submit by keyboard → toast announced (aria-live) → sign out by keyboard → full loop, zero pointer events.
- **Surfaces:** every admin section, modals (DialogShellComponent), palette, tables, forms.
- **Visual evidence:** steps 7 (focus ring on nav), 17 (modal trap), 22 (palette).
- **CAPABILITY GAP:** command palette (Cmd+K) as a first-class, complete admin navigator.
- **CAPABILITY GAP:** keyboard-interaction contract per control (documented + asserted); purge of mousedown-only handlers.

### gp-07-novice-joe-shmoe — "No docs. Click what looks clickable. It just works."
- **Persona:** Joe, 61, plumber, never read a manual. **Goal:** everything that LOOKS interactive IS, and leads somewhere sane.
- **Status:** RUNNABLE (explorer is the engine; dead-control detection partial). **Binds:** `deep-ui-explorer/explorer.mjs` + `vision-review.mjs` + `coverage-ledger.json`.
- **Steps (open-ended, ~40/run):** (1-3) sign in → land on dashboard (Getting-Started hub) → the ONE obvious next action is visually dominant → (4-12) explorer walk: click every affordance that looks clickable (cards, chips, icons, rows) → each click produces an observable change (nav, modal, toast, expand) — a no-op click = DEAD CONTROL, flagged → (13-20) every empty state offers its first action → no jargon (org/manifest/entitlement banned in copy) → no doomed buttons (preconditions gate server-side AND disable with reason) → (21-30) screenshot every new surface → vision rubric ≥8/10 (layout/contrast/brand/no-slop) via the Workers-AI Scout ladder when paid vision is capped → (31-40) coverage ledger appends routes + testids seen → unknown route ⇒ mandatory vision call → BLOCKED/FALLBACK recorded honestly, never greenwashed.
- **Surfaces:** entire admin, rotating per run via ledger-guided frontier.
- **Visual evidence:** every newly-seen surface (explorer's screenshot-per-view is the contract).
- **CAPABILITY GAP:** dead-control detector (click → no observable DOM/route/aria change ⇒ flag) built into explorer.mjs.
- **CAPABILITY GAP:** jargon linter over rendered copy (user-words gate) in the vision pass.

### gp-08-failure-recovery — "When it breaks, the product explains and the user recovers"
- **Persona:** any owner on a bad day. **Goal:** every failure is survivable without support.
- **Status:** FUTURE (envelopes exist; injection + recovery affordances incomplete). **Binds:** RFC7807 error envelopes, build status machine (`error` state), domain attach flow.
- **Steps (22):** (1-5) attach a typo'd domain (`danaplumbing.con`) → validation catches it in-field (not a server 500) → attach an unreachable domain → DNS check fails → error states WHAT failed + the exact fix, in Dana's words → (6-9) correct the domain → flow resumes from where it left off (no restart) → connected → (10-15) force a build failure (injection hook) → site status `error` → admin shows a human explanation + correlationId (never a raw stack) → one-click Retry → retry succeeds → no stranded rows (terminal status + retry affordance always paired) → (16-19) degraded-success build (quality fallback) is FLAGGED to the user, not silently shipped → (20-22) payment failure at checkout → clear recovery path → entitlements never half-applied (idempotent webhook) → user lands whole.
- **Surfaces:** domains, build pipeline, admin site detail, billing, error envelopes.
- **Visual evidence:** steps 4 (human error copy), 12 (error + Retry), 16 (degraded-quality notice).
- **CAPABILITY GAP:** deterministic failure-injection hooks (test-only chaos flag: force build fail / DNS fail / webhook drop).
- **CAPABILITY GAP:** universal Retry affordance on every `error`-status resource (stranded-row class killer).
- **CAPABILITY GAP:** degraded-success disclosure surface (reduced-quality flag shown to the owner).

---

## Backlog journeys (not yet specced — one-liners)

- gp-09 team-collab: invite member → accept → RBAC-limited actions → revoke.
- gp-10 export-import round-trip: site .zip export → import → identical render (manifest + redaction honored).
- gp-11 functions-live: add `functions/` endpoint in editor → WfP dispatch deploy → call it from the live site.
- gp-12 forms-to-lead: visitor submits contact form → admin Forms shows it → owner notified by email.
- gp-13 version-time-travel: edit → preview → promote → rollback via durable preview/branches.
- gp-14 voice-concierge: provision Twilio number → call it → AI answers with site knowledge.
- gp-15 pwa-offline: install generated site as PWA → airplane mode → offline page + recovery.
- gp-16 newsletter-loop: visitor subscribes → Listmonk list grows → campaign sends → inbox receipt.

## CAPABILITY GAP ledger (aggregated — 18)

| # | Gap | Paths | Value |
|---|-----|-------|-------|
| 1 | Stripe test-checkout automation rail | gp-05 | HIGH (money path end-to-end) |
| 2 | Failure-injection hooks + universal Retry on `error` status | gp-08 | HIGH (trust; kills stranded rows) |
| 3 | Editor iframe in long-trail local stack (action-38 blocker) | gp-02 | HIGH (unblocks canonical journey) |
| 4 | Sacrificial real test domain for full DNS→SSL cycle | gp-03 | MED-HIGH |
| 5 | CF-native registrar purchase in-product | gp-03 | MED-HIGH |
| 6 | Per-site D1 empty-state launchpad / sample seed | gp-02 | MED |
| 7 | Causal analytics probe as standing automation + freshness SLA in-UI | gp-04 | MED |
| 8 | Causal banner-removal-after-upgrade assertion | gp-05 | MED |
| 9 | Cmd+K palette as complete admin navigator | gp-06 | MED |
| 10 | Keyboard contract per control; purge mousedown-only handlers | gp-06 | MED |
| 11 | Dead-control detector in explorer | gp-07 | MED |
| 12 | Jargon linter over rendered copy | gp-07 | MED |
| 13 | Post-publish share moment (copy + OG card) | gp-01 | MED |
| 14 | Pre-build dedupe guard (resume, don't duplicate) | gp-01 | MED |
| 15 | Degraded-success disclosure to owner | gp-08 | MED |
| 16 | Keyboard-commit contract for Data-tab cell edit | gp-02 | LOW-MED |
| 17 | Cell-edit/SQL parity assertions in shared datagrid | gp-02 | LOW |
| 18 | Vision-budget rail hardening (Workers-AI Scout primary while paid vision capped) | gp-07 | LOW |

## Rotation policy

- **Every fire advances ≥1 golden path**: either ≥5 new actions verified GREEN on a RUNNABLE/PARTIAL path, or ≥1 CAPABILITY GAP flipped to shipped (then the step loses its GAP tag — steps are never deleted).
- Each advance records **visual evidence** at the path's declared moments (screenshots under the owning harness — `long-trail/screenshots-local/` or the explorer ledger) + updates the path's status line here and its checkpoint JSON.
- The standing Long-Trail lane owns gp-01/gp-02 (case-001 continues from action 38); the Deep UI Explorer lane owns gp-07; other paths rotate through the 15-role roster.
- A path untouched for 5 consecutive fires escalates to a standing lane next fire. New journeys enter via the Backlog list → get a full entry when first picked up.
- Status ratchet: FUTURE → PARTIAL → RUNNABLE only via verified runs; never by edit. Regressions demote the status same-fire and open a LEDGER line.

## gp-09 — destructive-recreate loop (STANDING, Brian 2026-10-01)

- **Persona:** the platform itself proving delivery end-to-end, repeatedly.
- **Fixture:** `lone-mountain-global` — SACRIFICIAL; full delete + regeneration explicitly
  authorized, standing. Never use any other customer slug destructively.
- **Steps:** admin → Sites → lone-mountain-global → Delete (full teardown: R2 version-tree,
  D1 allocation row + database, KV host/manifest keys, WfP dispatch script, hostname rows)
  → verify public 404s + admin list absence → re-create via the NORMAL generation flow
  (search → build; WebGL industry-themed template) → watch build stream → site live →
  Editor → Resources → Advanced → assert truthful inventory: ≥1 R2, 1 D1, + every other
  allocated resource NAMED (0 "unknown" rows) → record wall-clock + $-per-build →
  frontier-vision QA ≥8/10 (Anthropic vision or Unified-Billing OpenAI — never Workers-AI
  for this gate) → public share-link only after hard gates (owner-draft/public-gated).
- **Status:** RUNNABLE (cycle-2 complete 2026-10-01 — slug restored via `preferred_slug`;
  WebGL gate + vision ≥8 gate still open; purge fail-soft defect recorded — see receipts).
- **CAPABILITY GAPS:** ~~full-teardown delete path~~ (SHIPPED cycle-1: `purge_resources` opt-in);
  ~~per-cycle build-cost metering~~ (build_metrics live: total/phase/cost — container-internal
  TOKEN metering still absent, `tokens_in/out=0`); resources panel ground-truth reconciler;
  WebGL template gate (local-service pack carries NO webgl block); create-from-search skips
  EAGER per-site provisioning (D1 appears only after lazy Data-tab access — parity gap vs
  `services/site_create.ts`); logo-gen flake → `/logo-icon.png` 404 ([icn40] class); hero H1
  ships industry-pack default copy ([H1pac] class — "Your community local business" misframes).

### gp-09 cycle-1 receipt (2026-10-01, fire-61 gp-09 operator)

- **Fixture:** `lone-mountain-global` (siteId `4f450690-e622-4c95-a83d-e5516a2c9442`, org-brian-001)
  → destroyed + re-created as slug **`lone-mountain`** (siteId `d31f404b-7389-4f69-bfa2-70f8c8200f5c`).
  AI slug gen is NON-deterministic ("Lone Mountain Global" → `lone-mountain-global`, then
  `lone-mountain`) — fixed same cycle: `preferred_slug` now accepted by create-from-search
  (schema-validated, routed through `ensureUniqueSlug`). **Cycle-2 MUST pass
  `preferred_slug: "lone-mountain-global"` and treat BOTH slugs as the sacrificial lineage.**
- **Timings (wall-clock, measured):** DELETE+full-purge **11s** (15:37:28→:39Z, purge inline in
  response); re-create POST 15:38:15Z → `published` 15:42:57Z = **4m 42s**; delete→live-again
  **5m 29s**. Cycle total incl. verification ~19m.
- **build_metrics row (north-star datapoint #1, measured not reconstructed):** build_id
  `d31f404b-7389-4f69-bfa2-70f8c8200f5c` · total_ms **279,242** · phase_ms collecting 4,507 /
  generating 227,150 / imaging 0 / publishing 47,585 · container_ms 213,000 ·
  **est_cost_usd 0.071** · tokens 0/0 (container-internal tokens unmetered — open gap) ·
  outcome `published`.
- **Teardown verdicts (all CF-side ground-truth verified):** 228 R2 version-tree objects
  deleted (prefix then listed EMPTY) · dedicated D1 `180a0efe…` CF-404 · dedicated KV
  `479f9dd7…` CF-404 · both `ps-site-*` buckets CF-404 · WfP slots 2 deleted · 4 registry rows
  retired · allocation retired · host KV key cleared · slug freed
  (`lone-mountain-global--purged-mupp76c7`) · public URL 404 · admin list empty · resources 404.
- **Rebuild verdicts:** public 200 · exactly 1 H1, zero `{TOKEN}` leftovers, zero doubled
  tokens · authed resources: **4 named rows (d1 + r2 site_files + wfp_worker + routing), 0
  unknowns** (d1 appeared after one Data-tab GET — the lazy-provision path) · console: ONE
  error (`/logo-icon.png` 404, logo-gen flake) on both viewports · WebGL hero ABSENT
  (local-service pack has no webgl block — noted per contract).
- **Vision QA (Anthropic vision, desktop+mobile screenshots):** **7.5/10** — below the ≥8 gate,
  scored honestly. Critique: (1) layout/type polished — gradient display H1, trust chips, Cmd+K,
  dual CTAs, clean mobile stack, no overflow; (2) content misframe — industry-pack hero copy +
  irrelevant stock shop-interior photo read generic for a "Global" trade name; (3) header icon
  404s to text-wordmark fallback (graceful, but off the gorgeous bar).
- **Capability gaps SHIPPED this cycle (TDD, 894 suites / 14,066 tests green):**
  1. `purgeSiteResources` full-teardown service — `src/services/site_purge.ts` (+5-case
     `src/__tests__/site_purge.test.ts`): R2 version-tree, dedicated D1/KV (CF-side
     `ps-site-` name check + FORBIDDEN_DB_IDS denylist, GET-verify-then-DELETE), dedicated
     buckets via guarded `deleteSiteR2`, WfP teardown, registry/allocation/hostname retire,
     host-key clear, slug freeing. Wired as explicit `{ "purge_resources": true }` body opt-in
     on DELETE `/api/sites/:id` (`src/routes/api.ts`) — refuses non-archived rows, never throws,
     response carries the honest per-step summary.
  2. `preferred_slug` on create-from-search (`libs/features/site_creation/{schemas,handlers}.ts`
     + schema tests) — slug determinism for standing fixtures.
  3. Guard fixes: `project-sites-production` added to FORBIDDEN_BUCKET_NAMES (the ACTUAL prod
     shared bucket was missing from the denylist); raw NUL byte in `wfp_site_hosting.ts`
     digest-separator replaced with the backslash-u0000 escape — identical runtime string/digest; file no longer binary-classified (was grep-blind).
- **Deploys:** worker `080e88c8` (purge) → fixture cycle ran → worker `1e718ac2`
  (preferred_slug), both `--env production`, prod-verified.

### gp-09 cycle-2 receipt (2026-10-01, fire-62 gp-09 operator)

- **Fixture:** slug `lone-mountain` (siteId `d31f404b-…`, verified before firing) → destroyed →
  re-created as **`lone-mountain-global`** (siteId `8ebf551b-272d-4abc-a15f-386f69c22ea5`).
  **Canonical slug RESTORED** — `preferred_slug` honored verbatim, no `-N` suffix. Worker live
  `488ea3e4` (16:42Z deploy, bundle-verified to carry purge + preferred_slug).
- **DELETE ANOMALY (new defect class, recorded not patched):** first DELETE 18:16:31Z returned
  200 `deleted:true` in 0.6s but **purge silently SKIPPED** — no `purge` key in response/audit,
  slug not freed. Root-caused by elimination: live bundle has the wiring (grep-verified);
  identical curl shape purged a throwaway draft probe (`gp09-probe-c2`, 18:22:31Z) perfectly;
  middlewares don't consume bodies. Verdict: one-off body loss swallowed by
  `c.req.json().catch(() => ({}))` — **the explicit destructive opt-in silently downgraded to a
  plain archive**. Fail-soft masks intent-loss; handler should echo a `purge_requested`/parse
  honesty field so a lost body is visible. Recovered via shipped path: re-armed row
  (deleted_at=NULL) → re-DELETE 18:23:13Z → full purge in **4.9s**.
- **Teardown verdicts (CF ground truth, 18:24Z):** 68 R2 version-tree objects deleted (prefix
  lists EMPTY) · dedicated D1 `6dda15f1…` CF-404 · KV skipped_absent (never allocated — lazy) ·
  0 dedicated buckets · WfP slots 2 deleted · allocation + 2 registry rows retired · host key
  cleared · slug freed (`lone-mountain--purged-mupv47aq`) · both public URLs 404 · admin list empty.
- **Timings:** delete(effective)+purge **4.9s** (c1: 11s) · create POST 18:23:52Z → `published`
  18:29:20.616Z = **5m26s** (c1: 4m42s, **+16%**) · delete→live-again **6m16s** (c1: 5m29s).
- **build_metrics (north-star datapoint #2):** build_id `8ebf551b…` · total_ms **326,223**
  (c1: 279,242, +16.8%) · phase_ms collecting 5,227 / generating 268,508 / imaging 0 /
  publishing 52,488 · container_ms 227,000 · **est_cost_usd 0.0757** (c1: 0.071, +6.6%) ·
  tokens 0/0 — container-internal metering still absent; **no `usage_source` column exists**.
  Readiness C (72/100), 2 validation errors + 4 warnings (report mode).
- **Rebuild verdicts:** public 200 · exactly 1 H1 · 0 `{TOKEN}` leftovers · **0 console errors
  BOTH viewports** (c1 had the `/logo-icon.png` 404 — did NOT recur; icon + wordmark images
  load) · 18/18 images load after lazy-load settle · no mobile overflow @390 · authed
  resources: **4 named rows (d1 + r2 + wfp_worker + routing), 0 unknowns**; per-site D1
  `9932bc86…` appeared only after one Data-tab GET — eager-provision parity gap persists.
- **WebGL verdict (honest):** hero **ABSENT**. Classified into the generic **local-service**
  pack (category null; pack-default H1 proves it). Only hvac / personal-injury-law / nonprofit
  carry webgl blocks. Live DOM: one hidden 300×150 webgl feature-probe canvas + a 2D
  `ps-particle-field` — no WebGL hero pixels. **CAPABILITY GAP stands: wire webgl blocks into
  remaining vertical.json packs** (local-service first — it's the default sink).
- **Vision QA (Anthropic vision, desktop+mobile): 7/10** (c1: 7.5, **−0.5**). Critique:
  (1) structure polished — gradient display H1, trust chips, Cmd+K, dual CTAs, clean mobile
  stack, 0 errors; (2) brand surface regressed where it should have won — wordmark renders
  near-black-on-dark with a garbled letterspaced "GLOBAL" glyph row (illegible), red eyebrow +
  dim nav links fail AA contrast; (3) content misframe persists — pack-default H1 + irrelevant
  gift-shop stock hero for a "Global" trade name ([H1pac] + stock-relevance classes unchanged).
- **Gaps carried:** webgl pack coverage · container token metering (`tokens 0/0`) ·
  eager per-site D1 provisioning on create · [H1pac] pack-default hero copy · stock-photo
  relevance. **New:** purge opt-in fail-soft (above) · wordmark dark-on-dark legibility.
- **No code edits, no commits, no deploys** (cycle was recoverable via shipped surface; defect
  recorded for the next fire's lane).
