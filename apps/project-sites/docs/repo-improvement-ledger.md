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
