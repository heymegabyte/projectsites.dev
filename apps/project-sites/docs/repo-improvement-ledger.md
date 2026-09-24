# Repo Improvement Ledger

> Tracking doc for the continuous repo-improvement loop (`bca7f04f`). **Read first
> each cycle; update each cycle.** TESTS ARE PRESERVED (user decision 2026-09-23) —
> never delete test files/folders/specs/CI. This ledger is the source of truth for
> what's been reviewed and what's next.

## Cycle log
- **Cycle 1 — 2026-09-23:** Inventory + created this ledger. Reconciled a **duplicate
  analytics coverage matrix**: removed `apps/project-sites/docs/analytics-coverage-matrix.md`
  (redundant + less accurate — I created it earlier this session; it wrongly called the
  D1 store a "client beacon" and marked device/geo/comparison as gaps). Canonical is
  `docs/analytics-coverage-matrix.md`. Verified the data-section matrix is NOT duplicated.
- **Cycle 2 — 2026-09-23:** Angular style pass — confirmed native control flow is 100%
  complete; migrated the 2 remaining constructor-DI components to `inject()`
  (`before-after-slider`, `grafana-dashboard`) + removed an unused `effect` import.
  Typecheck + 1870 Karma green. Recorded the signal-input migration (46 files) as the
  big remaining Angular item.
- **Cycle 3 — 2026-09-23 (Data + Angular, one slice):** Shipped the owner-facing **Data
  tab** UI — a NEW focused standalone `SiteDataBrowserComponent` (signals + `input()` +
  native control flow, colocated 13-spec Karma file) wired into `site-detail.component.ts`
  as an owner-accessible tab (unlike the super-admin SQL tab). Surfaces the already-DONE
  real endpoints (`/data-overview` picker + `/data-overview/:table` server-paginated,
  sortable grid + per-row JSON detail) — **zero mock behavior**. Added typed
  `getDataOverview`/`browseDataTable` + `DataOverviewTable`/`DataTablePage` to `api.service.ts`;
  updated `data-section-capability-matrix.md` (slice-1 owner UI = DONE). Verified: tsc 0,
  **Karma 1882/1882** (+13), AOT build clean, eslint 0-errors, backtick gate PASS. Exemplar
  of signal-input-first authoring (the NEW component uses `input()`, showing the target the
  46 legacy `@Input()` files migrate toward — those remain the big Angular item).
- **Cycle 4 — 2026-09-23 (Data + de-dup, one slice):** Added **CSV + JSON export of the
  current page** to the owner Data grid (`SiteDataBrowserComponent.exportCsv/exportJson`) +
  a **read-only pill** explaining why the grid isn't editable (the projections omit PKs by
  design; the 5 tables are read-only system/analytics data — edit/delete slice is genuinely
  N/A here, recorded in the matrix slice order). Seeded a shared, tested **`utils/csv-export.ts`**
  (`csvEscape`/`toCsv`/`downloadText`, RFC-4180-safe, 10 specs) — the `toCsv()`/blob-download
  pattern is currently DUPLICATED across `events-table`/`audit`/`forms`/`analytics`/`super-admin`;
  the new component uses the shared util, and those 4-5 should migrate to it (deferred — coherent
  feature-level, no churn this fire). Verified: tsc 0, **Karma 1896/1896** (+14), AOT build clean,
  eslint 0-errors, backtick gate PASS.
- **Cycle 5 — 2026-09-23 (Data, one slice):** Upgraded the owner Data-grid export from current-page
  to **whole-table** — `collectAllRows()` pages the selected table (respecting sort) up to a hard
  **5,000-row cap**, then downloads CSV/JSON; a `db-export-note` honestly states when the cap
  truncated (`"Exported the first 5,000 of N rows"`), an `exporting` signal disables the buttons +
  shows "Exporting…". Bounded (never an unbounded fetch), real endpoints only. `exportCsv/exportJson`
  are now async. +2 export specs (whole-table paging @ offsets 0/100/200; cap+note). Verified: tsc 0,
  **Karma 1898/1898**, AOT build clean, eslint 0-errors, backtick gate PASS.
  - **Deferred (unchanged):** the CSV-primitive de-dup migration of `events-table`/`audit`/`forms`/
    `analytics`/`super-admin` onto `utils/csv-export` — those files are actively edited by other loops
    (analytics/billing), so migrating now risks merge conflicts; safe once they quiesce. Their bespoke
    `toCsv()` headers/formatting stay per-component; only the `esc` primitive + blob-download boilerplate
    should move to `csvEscape`/`downloadText` (output-preserving).
- **Cycle 6 — 2026-09-23 (Analytics + Angular focused-component, one slice):** Completed the CWV arc with a
  NEW focused standalone **`WebVitalsCardComponent`** (signals + `input()` + native control flow, colocated
  10-spec Karma file) rendering the honest LCP/INP/CLS p75 card in `/admin/analytics`. Wired into the 85KB
  `analytics.component.ts` with a MINIMAL edit (import + one `imports[]` entry + one `<app-web-vitals-card>` tag
  bound to `siteTraffic()?.webVitals` + `rangeDays()`; made `rangeDays()` public for the template). Honest: null
  metric → "Measuring…" not 0; rating shown as a WORD (WCAG use-of-color); labelled Chromium-only field data.
  Verified: tsc 0, **Karma 1906/1906** (+10), AOT build exit 0, eslint 0-errors, backtick gate PASS. Exemplar of
  the "focused child component wired into a god-component with a one-line edit" pattern (avoids bloating the 85KB file).
- **Cycle 7 — 2026-09-23 (Data, one slice — built-but-unwired fix):** The SQL console's `/sql/exec` endpoint
  already returned D1 query-cost meta (`rows_read`/`rows_written`/`d1_duration_ms`) but the frontend `SqlResult`
  DROPPED it — a built-but-unwired gap. Wired it through (`SqlResult`/`SqlExecRes` + `sqlResult.set`) and now the
  console **displays** "read N · wrote N · D1 Xms" and shows a ⚠ **expensive-scan warning** (`isExpensiveScan`,
  >10k rows read → "add an index") — the prompt's "make cost visible" + "warn about expensive scans". Honest: cost
  shown only for a REPORTED value (`!= null`), never a fabricated 0. +2 Karma specs (cost surfaced; scan threshold).
  Verified: tsc 0, **Karma 1908/1908**, AOT build exit 0, eslint 0-errors, backtick gate PASS.
- **Cycle 8 — 2026-09-24 (Analytics per-path, worker + frontend):** Added a **per-page CWV drilldown**.
  `getWebVitalsSummary` now buckets LCP by `path` from the SAME query (no extra DB call) and returns
  `webVitals.slowestPages` (top-5 worst-first, past a **5-sample floor** so a p75 isn't ranked off 1–2 hits);
  `WebVitalsCardComponent` renders a "Slowest pages · LCP p75" table (path + p75 + rating word + samples) when
  any page qualifies, hidden otherwise. Schema (`SlowPageSchema` + `slowestPages` on `WebVitalsSchema`, defaulted
  for back-compat) + frontend contract updated. +1 worker service spec (rank + sample-floor) + 2 card specs.
  Verified: tsc 0 (worker + fe), **Jest 12214 pass** / **Karma 1910/1910**, AOT build OK, eslint 0-errors, drift
  0-err, backtick PASS. The CWV analytics area is now fully built out (site + per-page); Security is the next category.
- **Cycle 9 — 2026-09-24 (Data SQL workspace, one slice):** Added **EXPLAIN QUERY PLAN + index guidance** to
  the superadmin SQL console (`site-detail.component.ts`). An "Explain" button posts `EXPLAIN QUERY PLAN <query>`
  (semicolon-stripped) to the existing EXPLAIN-allowlisted `/sql/exec` (EXPLAIN plans but never executes — safe,
  no write-guard needed), renders the plan (`detail` line per step), and a `planHint` computed derives actionable
  guidance — a bare full-table `SCAN` or `USE TEMP B-TREE` sort → "add an index" (warn); an index-covered plan → ✓.
  Pairs with cycle-7's cost/scan warning (cost shows THAT it scanned; EXPLAIN shows WHY). A fresh Run clears a stale
  plan. +3 Karma specs (post shape + plan parse; planHint scan/index/null; error → shared surface). Verified: tsc 0,
  **Karma 1913/1913**, AOT build OK, eslint 0-errors, backtick PASS.
- **Cycle 10 — 2026-09-24 (Analytics conversions-by-kind, worker + Angular focused-component):** Added the
  highest-impact UNIVERSAL outcome metric — **conversions broken down by kind** (calls / directions / form submits).
  `getConversionKinds` groups `conversion` events by `json_extract(metadata,'$.kind')` (both summary paths, mirroring
  the `getWebVitalsSummary` "query-directly" pattern) → `traffic.byConversionKind`; a NEW focused standalone
  `ConversionsCardComponent` (signals + `input()` + native control flow, 5-spec Karma) renders humanized labels + a
  bar breakdown + total, honest "no conversions tracked yet" empty state (kind-less → "other", never dropped). Wired
  into `analytics.component.ts` with a minimal edit (import + `imports[]` + one `<app-conversions-card>` tag). Schema
  (`byConversionKind` on `TrafficSummarySchema`, defaulted) + frontend contract updated. +1 worker service spec.
  Verified: tsc 0 (worker + fe), **Jest 12215 pass** / **Karma 1918/1918**, AOT build OK, eslint 0-err, drift 0-err,
  backtick PASS.
- **Cycle 11 — 2026-09-24 (Data SQL workspace, one slice):** Added **plain-language SQLite/D1 error explanations**
  to the SQL console (`site-detail.component.ts`). `explainSqlError` (pure regex map) turns the common errors —
  no-such-table / column / function, syntax (with the `near "…"`), unrecognized-token, UNIQUE / FK-constraint,
  too-complex — into a friendly line, and the console now shows that ABOVE the RAW error (always retained, in a
  `<code>` block, for debugging). Unknown errors → raw only, never hidden. Completes the SQL-workspace error UX
  alongside cost/scan (cycle 7) + EXPLAIN (cycle 9). +1 Karma spec (all mapped patterns + null for unknown/empty).
  Verified: tsc 0, **Karma 1919/1919**, AOT build OK, eslint 0-errors, backtick PASS.
- **Cycle 12 — 2026-09-24 (Analytics: introspection finding + CSV fix + security hardening + de-dup):** Ran a CF
  GraphQL **introspection probe** — `firewallEventsAdaptiveGroups` returns authz "zone does not have access" → **Security
  is plan-BLOCKED** (recorded in the matrix; removed from buildable-next, ending several fires of deferral). Pivoted to a
  certain universal slice: **fixed + completed the analytics CSV export**. Found two real bugs — a hardcoded
  `source,cloudflare_graphql` (a lie for the subdomain majority whose data is D1) and a scope gap (missed the D1
  device/channel/conversions/CWV breakdowns). Extracted a tested pure **`utils/analytics-csv.ts` `buildAnalyticsCsv`**
  (7 specs) with the accurate source + all breakdowns (CWV/bounce emitted only when measured, never a fake 0), and wired
  `exportCsv` to it + the shared `downloadText`. **Hardened the shared `csvEscape` with a CWE-1236 formula-injection
  guard** (excludes plain numbers) — benefits the owner Data-grid export too (it exports attacker-controllable path/
  referrer) — and **removed the now-dead `csvCell`** from `analytics.component.ts` (repointing its 4 spec tests to
  `csvEscape`, coverage preserved + grown). Verified: tsc 0, **Karma 1927/1927**, AOT build OK, eslint 0-errors, backtick PASS.

## Repository shape
- **Angular app (1):** `apps/project-sites/frontend` — Angular **21.2.14**.
- **Worker (Hono):** `apps/project-sites/src` + `apps/project-sites/libs/features`.
- **Editor (Remix/bolt.diy):** `app/`.
- **Shared:** `packages/shared`.
- **Tests (PRESERVED):** 677 Jest (Worker) + 168 Karma (Angular) + 535 e2e (Playwright).

## Angular style-guide coverage (angular.dev/style-guide, v21) — IN PROGRESS
`apps/project-sites/frontend` (Angular 21.2.14):
- **Native control flow: ✅ COMPLETE** — 0 real `*ngIf`/`*ngFor`/`ngSwitch`/`ngClass`
  (the lone `*ngFor` grep hit is a JSDoc comment in `animations/motion.ts`).
- **DI via `inject()`: ✅** — migrated the 2 constructor-DI component holdouts
  (`before-after-slider`, `grafana-dashboard`; dropped an unused `effect` import too).
  The 3rd `constructor(private…)` hit is a test-mock class (`readiness-badge.component.spec`),
  not Angular DI.
- **Signal inputs: ⏳ the big remaining item** — `@Input()`×46, `@Output()`×9, `@ViewChild`×21
  files still use decorators. Migrate progressively, ONE component per cycle (coherent
  feature-level, not mechanical churn); update its template (`{{ foo() }}`) + spec each time.
- Standalone components: ✅ (no NgModules). Naming/colocation, a11y, focused-components:
  not yet swept.

## Documentation map (canonical per topic)
- **Analytics coverage** → `docs/analytics-coverage-matrix.md` ✅ canonical (dup removed cycle 1)
- **Data-section (Editor)** → `apps/project-sites/docs/data-section-capability-matrix.md` (unique)
- **Architecture** → `docs/ARCHITECTURE.md`
- **Deployment** → `docs/DEPLOYMENT.md`
- **Operations** → `apps/project-sites/docs/OPERATIONS.md`
- **Functions/WfP** → `apps/project-sites/docs/FUNCTIONS-CONVERGENCE.md`
- Remaining docs (AI_INTEGRATION, ai-agent-rules, generated-site-quality, SITE-OPERATIONS,
  SUPER-ADMIN-EXPANSION, product-gap-analysis, …) — **NOT YET REVIEWED.**

## Files reviewed (repo-owned)
- `docs/analytics-coverage-matrix.md` ✅ (verified accurate + canonical)
- Everything else — **NOT YET REVIEWED** (file-by-file review advances across cycles).

## Findings / candidates (ranked)
1. **Angular style-guide review (v21)** — the largest untouched mission area. Start file-by-file
   in `apps/project-sites/frontend`; record coverage above.
2. **CWV is the real analytics gap** (per canonical matrix) — device/geo/channel breakdowns AND
   **period-over-period deltas are ALREADY ✅ live** (server-enriched `visitor_events`). So the
   Analytics loop (`348521da`) should target **Core Web Vitals** (verify beacon injection first),
   NOT comparison deltas — building those would DUPLICATE existing work.
3. **Doc-dedup sweep** — the "discovery agent missed an existing doc" pattern bit twice this
   session (analytics matrix dup + the analytics discovery wrongly reported "no matrix exists").
   Grep for existing docs before creating any new doc.
4. **Empty dir** `docs/deploy` (untracked, empty). `test-results-*/` are generated Playwright
   output — leave (generated cache, per guardrails).

## Unresolved uncertainties
- **4 recurring loops active** (`77da4413` 15m TODOs · `98456b32` 30m Data · `348521da` 30m
  Analytics · `bca7f04f` 30m this). They collide on the half-hour + risk more duplicate docs
  (already caused the analytics-matrix dup). **Recommend consolidating** to fewer loops.
- Canonical analytics matrix names loop `65648642` (not in current CronList — stale ref); the
  active analytics loop is `348521da`.

## Next highest-value action
Migrate ONE component's `@Input()`/`@Output()` → `input()`/`output()` signals per cycle
(46 `@Input()` files remain) — update its template to call the signal (`{{ foo() }}`) + its
spec, keep typecheck + Karma green. Start with a small leaf component. Do NOT build analytics
comparison deltas (already live). Before creating any doc, grep for an existing one.
