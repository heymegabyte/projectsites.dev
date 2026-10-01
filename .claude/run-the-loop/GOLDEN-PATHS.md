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
- **Status:** RUNNABLE (reconciler exists; causal loop partially codified). **Binds:** `admin-verify/reconcile-surfaces.mjs` + `admin-analytics-journey.spec.ts`.
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
- **Status:** FUTURE until `webgl-templates` + `resources-truth` land.
- **CAPABILITY GAPS:** full-teardown delete path (verify nothing orphans); per-cycle
  build-cost metering; resources panel ground-truth reconciler; WebGL template gate.
- **Visual evidence:** post-delete 404, build stream, live hero (WebGL), Resources>Advanced
  panel, vision-QA scorecard.
