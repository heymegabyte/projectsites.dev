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
- **Cycle 13 — 2026-09-24 (Data, one slice — built-but-unwired fix):** The superadmin schema endpoint
  `GET /api/sites/:siteId/sql/schema` (columns/pk/indexes/FKs/DDL) was **built-but-unwired** — no frontend
  consumer. Shipped the **Schema tab** — a NEW focused standalone **`SiteSchemaBrowserComponent`** (signals +
  `input()` + native control flow + OnPush, colocated 7-spec Karma file): searchable table list → selected
  table's columns (name/type/nullable/default + **PK badge**), indexes, FKs, and copyable CREATE SQL. Wired into
  `site-detail.component.ts` as a superadmin-gated tab beside SQL (`@if (canUseSqlConsole())`), and **extended the
  existing strand-guard effect** so a `?tab=schema` deep-link by a non-superadmin falls back to `logs` (same as
  SQL) instead of a blank panel. Added typed `getSiteSchema` + `SchemaColumn/SchemaIndex/SchemaForeignKey/SchemaTable`
  to `api.service.ts`. Honest: a shapeless 200 → retryable error (never a fake empty schema); **zero mock behavior**,
  real endpoint only. Frontend-only (endpoint already deployed). Verified: tsc 0, **Karma 1934/1934** (+7), AOT
  build exit 0, eslint **0-errors** (new file auto-fixed to 0 warnings), backtick gate PASS. Another exemplar of
  "focused signal-input child wired into `site-detail` with a minimal edit" + a real built-but-unwired closure.
- **Cycle 14 — 2026-09-24 (Data SQL workspace, one slice):** Added **saved queries + reusable snippets + clickable
  history recall** to the superadmin SQL console (the matrix's stated next SQL-workspace item; multi-tab is now the
  only remainder). New `SavedQuery` type + `savedQueries`/`saveName` signals + `saveCurrentQuery`/`loadQuery`/
  `deleteSavedQuery`/`persistSavedQueries` methods, all mirroring the existing `sqlHistory` pattern: user names +
  Saves the current query, it persists per-site (`ps_sql_saved_<siteId>`, dedup-by-name, capped 50, private-mode-safe)
  and restores on site change; a Saved-queries `<details>` renders name-input + Save + a load/delete list. Also made
  **query history clickable-to-recall** (was display-only `<li>` — now a `.sql-recall` button that loads into the editor
  **without auto-running**, so the user reviews before Run) and fixed a latent **stale-on-site-switch** bug in the
  restore effect (history/saved now RESET to default when the target site has no stored value, never leaking the prior
  site's queries). Kept inline in `site-detail` for within-file consistency with history (not a mechanical extraction).
  +6 focused logic specs (save/dedup/no-op/load-no-run/delete/persist+delete round-trip). Verified: tsc 0, **Karma
  1942/1942** (+6), AOT build exit 0, eslint **0-errors**, backtick gate PASS.
- **Cycle 15 — 2026-09-24 (Data SQL workspace, one slice):** Added **SQL result export — Download CSV + Download JSON**
  buttons to the SQL console result grid (the console had only "Copy JSON"; the Data prompt wants "export bounded results
  as CSV or JSON"). New `downloadSqlCsv`/`downloadSqlJson` + a private `sqlExportName` helper, over the **shared
  `toCsv`/`downloadText`** from `utils/csv-export` (formula-injection-safe `csvEscape`) — advancing the CSV-primitive
  consolidation (site-detail now consumes the shared util). Exports the FULL result set (every returned row, not just the
  200-row render cap); the cap hint updated to "Copy/Download exports all rows". +1 focused spec (spies `URL.createObjectURL`,
  asserts both downloads fire with the correct CSV/JSON mime). Verified: tsc 0, **Karma 1953/1953** (+1), AOT build exit 0,
  eslint **0-errors**, backtick gate PASS; prod-verified live (chunk `chunk-CQ72BXPR.js`, buttons + `query-result-` filename
  served). Multi-tab (concurrent editor buffers) remains the only SQL-workspace item left.
- **Cycle 16 — 2026-09-24 (Data browse, worker + frontend):** Added **server-side text search** to the owner Data grid
  (the prompt's "Browse and edit data → search where supported"). Backend: extracted a pure, exported **`buildDataSearch`**
  (parameterized `LIKE` over the non-timestamp safe columns — same allowlist that gates `orderBy`; **STRIPS** `%`/`_`
  from user input per repo convention; 100-char bound) and injected it after `WHERE site_id = ?` on BOTH the browse AND
  count queries so `total` reflects the filtered set; the `:table` handler reads `?search=`. Frontend: `search` signal +
  `setSearch` (trims, resets to page 1, no-ops when unchanged) + a `type="search"` input on the grid toolbar (Enter +
  native-clear via the `search` event); cleared on table switch. Tenant isolation unchanged (still `ownsSiteData` +
  `WHERE site_id = ?` first; search is a bounded parameterized filter, never an identifier). +4 worker specs
  (`buildDataSearch`) + 2 Karma specs (`setSearch` reset/no-op; `selectTable` clears search). Verified: worker tsc 0 +
  23 data tests · frontend tsc 0 · **Karma 1957/1957** (+2) · AOT 0 · eslint 0-errors · worker (`7722b1d3`) + frontend
  deployed · **prod-verified** (unfiltered 1886 → `search='/'` 1686 → no-match 0).
- **Cycle 17 — 2026-09-24 (Angular style: signal-input migration, one component):** Advanced the tracked "big remaining
  Angular item" — migrated **`CmdGlyphComponent`** (`components/cmd-glyph`, a heavily-used leaf: 17 external refs across
  the dashboard + command palette) from `@Input()` to a signal `input()`: `@Input() name = ''` → `readonly name = input('')`,
  template `@switch (name)` → `@switch (name())`, and dropped `Input` from the `@angular/core` import. The existing
  27-glyph spec already used `componentRef.setInput('name', …)` (signal-compatible) so it passed unchanged; static
  (`name="search"`) + bound (`[name]="cmd.glyph"`) parent usages both work with `input()`, so no parent edits. Verified:
  tsc 0 (AOT validates the `name()` template access) · **Karma 1960/1960** · build 0 · eslint 0 · deployed + prod-verified.
  **Finding (recorded, not actioned):** `FlagModeSwitcherComponent` (`feature-flags/mode-switcher`) is **dead** — the 2
  "consumers" import only its `DisclosureMode` **type**, nothing renders `<app-flag-mode-switcher>`. Can't be removed:
  it has a preserved spec (test-preservation mandate overrides dead-code removal). Left in place; noted for a future
  decision (relocate the `DisclosureMode` type, then the component + spec could retire together).
- **Cycle 18 — 2026-09-24 (Angular style: first `@Output()` → `output()` + adjacent flag-404 fix):** Migrated
  **`CommandPaletteComponent`** (`components/command-palette`, the Cmd+K palette) from `@Output()` EventEmitter to signal
  `output()` — its inputs were already `input()`, so this COMPLETES its signal migration: `@Output() closed = new
  EventEmitter<void>()` + `showShortcuts` → `readonly closed = output<void>()` + `readonly showShortcuts = output<void>()`,
  dropped `EventEmitter, Output` from the `@angular/core` import (added `output`). `.emit()` call sites (backdrop, Escape,
  execute) unchanged — `output()` is API-compatible. Added a spec block locking both emitters (Escape → `closed`; execute a
  `showShortcuts` command → both `closed` + `showShortcuts`). Verified: tsc 0 · backtick-gate 0 · **Karma 1967/1967** (2 new) ·
  build 0 · eslint 0 errors · deployed to R2 + **prod-verified by bundle-hash** (`main-V34BD7UW.js` local == served) + a
  **real-browser Cmd+K open→close journey** on prod (palette opens, input focused, role=combobox; Escape closes → `closed`
  fires end-to-end). **Adjacent fix (context-spillover):** the prod journey surfaced a console `404` on
  `GET /api/feature-flags/predicted_actions` every homepage load — the palette reads that CLIENT-ONLY flag via
  `FeatureFlagService.isOn()` (fail-soft to false, so functionally correct) but the flag was never registered, so the endpoint
  404'd (a browser network log JS `catchError` can't suppress). Registered `predicted_actions` in the worker `FLAG_REGISTRY`
  + `FLAG_DOCS` (client-only precedent: `cinematic_scroll_reveals`; no manifest/route needed), so the endpoint now resolves
  **200-with-false**. Worker: 82 feature-flag Jest green + tsc 0; deployed `--env production`; homepage console 404 gone.
- **Cycle 19 — 2026-09-24 (Data section: owner-facing column show/hide):** Shipped **grid column selection** in the
  customer-facing Data tab (`SiteDataBrowserComponent`, `site-data-browser.component.ts`) — the Data-epic's listed
  "column selection" requirement + a real usability win (wide tables like form submissions no longer force horizontal
  scroll). A "Columns" `<details>` disclosure in the toolbar toggles which columns the grid renders; `hiddenColumns`
  signal + `visibleColumns` computed drive the header + body `@for` (detail-view colspan follows). **Honesty guarantee:**
  the row-detail JSON + CSV/JSON exports STILL use the full `columns()` set, so hiding is a view-only scan aid that never
  omits data. Per-(site,table) persisted via localStorage (`ps_datacols_hidden_<siteId>_<table>`, private-mode-safe,
  restored in `selectTable`); **refuses to hide the last visible column** (no dead-end empty grid). Verified: tsc 0 ·
  backtick-gate 0 · **Karma 1974/1974** (+7 specs) · build 0 · eslint 0 errors · deployed to R2 + **prod-verified by
  chunk-hash** (`chunk-XRLNTX2N.js` local == served, `db-cols-menu` marker present). Chose this over the documented
  "multi-tab SQL console" because (a) the SQL console is superadmin-only → lower PRODUCT value, and (b) multi-tab is a
  flagged "risky refactor"; column-selection is customer-facing, in-spec, and low-risk. **Recon correction:** the agent
  wrongly reported EXPLAIN visualization as the gap — verified it's already DONE (`explainSql()` + `planHint()` in
  `site-detail.component.ts`), as are cost metadata + saved/history/starters.
- **Cycle 20 — 2026-09-24 (Data section: owner copy affordances):** Shipped **click-to-copy** in the customer-facing Data
  grid (`SiteDataBrowserComponent`) — the Data-epic's "row detail, copy" requirement + a real "embarrassingly-easy" win
  (grab a lead's email/value in one click). Every non-null cell renders as a click-to-copy `<button class="db-cell-copy">`;
  the row-detail panel gains a "Copy JSON" action; a polite `aria-live` "✓ Copied …" flash confirms (token-guarded ~1.8s, no
  clearTimeout — a set-after-destroy is a harmless signal no-op). `writeClipboard` is an isolated protected method so specs
  spy it without a secure-context clipboard. Read-only (no mutation, no worker change); clipboard fail-soft. Verified: tsc 0 ·
  backtick 0 · **Karma 1984/1984** (+5 specs) · build 0 · eslint 0 errors · deployed R2 + chunk-hash prod-verified
  (`chunk-6GWXJTTF.js`, `db-cell-copy`). Chose copy (safe, in-spec, customer-facing) over row edit/delete (PLANNED but
  destructive + big) and multi-tab SQL (superadmin, lower product value) given deep-session risk discipline.
- **Cycle 21 — 2026-09-24 (repo health: restore main-green + cover the site-features IDOR fix):** Resolved a **7-fire-old
  2-red `main`** (`src/__tests__/features_routes.test.ts` — `/api/site-features` returned 401 vs the tests' expected 200).
  Root-caused via git: the 401 is a **deliberate security fix** (commit `507257430` "🔒 fix(security): scope GET
  /api/site-features to the authed org (IDOR)") — the old `?? c.req.query('org_id')` fallback let an UNAUTHENTICATED caller
  read any org's plan + feature-override state cross-tenant. So the ROUTE is correct; the 2 tests were **stale** (asserting the
  old insecure behavior) and, crucially, the security fix had **zero test coverage**. Updated the 2 tests to the secure
  contract (authed-session org via a new `authed(orgId)` mount helper, never the removed `?org_id` query) + **added a
  regression guard** locking the IDOR fix (unauthed → 401; a client `?org_id` param is ignored → still 401). Test-only change
  (route already correct + deployed) — full worker suite now **12262/12262 green (0 failures)**, tsc 0; prod-verified the live
  contract (`/api/site-features` → 401 unauthed AND with `?org_id`). This clears the standing Rec carried since Cycle-and-fires
  back and makes the security invariant permanent.
- **Cycle 22 — 2026-09-24 (Data section: owner per-column exact filter):** Shipped **per-column filtering** on the
  customer-facing Data grid (`SiteDataBrowserComponent` + `site_data_api/handlers.ts`) — the Data-epic's "filters" requirement.
  A column dropdown + value input add a precise server-side `AND "col" = ?` over the browse + count queries (so `total`
  reflects the filter), complementing the existing OR-of-LIKE search. New pure `buildColumnFilter` mirrors `buildDataSearch`:
  the column MUST be in the safe allowlist (same injection boundary as orderBy/search — a `;DROP`/quoted/unknown column yields
  NO clause), the value is a **bound param** (never concatenated, 200-char cap). Frontend: `filterCol`/`filterVal` signals +
  toolbar controls (value gated on a chosen column) + resets to page 1 + cleared on table switch; `browseDataTable` gained the
  two params. Verified: tsc 0 · backtick 0 · **Karma 1991/1991** (+4) · **Jest 12270/12270** (+4) · build 0 · eslint 0 err ·
  deployed worker + R2 · **prod-verified**: unfiltered 27 → `event_type=pageview` 15 → no-match 0 → non-allowlist column
  IGNORED (27, no injection). Chose this (safe, in-spec, exercises the parameterized-allowlist discipline) over owner row
  edit/delete — still deferred: it's DATA-LOSS-capable + needs a per-table deletable-allowlist + confirm + audit design call,
  which per risk discipline belongs in a FRESH focused session, not a 11-fire-deep marathon.
- **Cycle 23 — 2026-09-24 (Data section: filter-aware export):** Made the owner CSV/JSON export respect the ACTIVE
  search + per-column filter (the loop's "scoped table/result exports") — coherent follow-on to the last two fires' search +
  filter. `collectAllRows` now threads `search`/`filterCol`/`filterVal` into its paged export fetches, so the file is the WHOLE
  MATCHING set (previously it dumped the whole table regardless of the on-screen filter — a real UX-correctness gap). `total`
  is the filtered count → the ≤5k cap + capped note ("N matching rows") stay correct; filtered files are named `-filtered`; the
  export button title/aria now say "filtered rows" vs "whole table" honestly (new `filterActive()` computed). Frontend-only, no
  new endpoint (reuses the prod-verified browse filter). Verified: tsc 0 · backtick 0 · **Karma 1999/1999** (+2) · build 0 ·
  eslint 0 err · deployed R2 + chunk-hash prod-verified (`chunk-EX4OOYLS.js`). Row edit/delete remains the deferred big gap
  (fresh-session, per risk discipline).
- **Cycle 24 — 2026-09-24 (Data section: Overview summary strip):** Added an at-a-glance Overview strip above the table
  picker — "N tables · M records · largest: <table> (K)" — a partial answer to the epic's "database metadata / table count /
  recent activity" Overview. `dataSummary` computed derives count + total records + largest table from the already-fetched
  per-table `row_count` (no extra request); null (hidden) until tables load so it never flashes a misleading "0 records";
  `aria-live` polite. Honest — a sum of real counts, no fabricated size/usage (D1 size/usage/limits still need the blocked D1
  REST API). Frontend-only. Verified: tsc 0 · backtick 0 · **Karma 2002/2002** (+3) · build 0 · eslint 0 err · deployed R2 +
  chunk-hash prod-verified (`chunk-2DWUIDDD.js`). Chose this glanceable, safe, in-spec slice; row edit/delete stays deferred
  (memory: `form_submissions` has NO `deleted_at` → an owner delete is a HARD, irreversible delete → fresh-session per risk
  discipline).
- **Cycle 25 — 2026-09-24 (Analytics: conversions-tile Δ badge):** Extended the authoritative period-over-period trend badge
  from the KPI tiles to the **Conversions card**. New `conversionDelta` computed feeds `deltaBadge(traffic.conversions,
  traffic.previous.conversions, windowDays)` into `ConversionsCardComponent` via a new `delta` input, rendered as a trend chip
  (`[data-testid=an-conv-trend]`) beside the "N total". Compares the authoritative `conversions` scalar across both periods
  (same metric/source, not a re-summed breakdown) — source-consistent with `pvDelta`/`visitorDelta`. Honest: chip hidden
  (`null`) when there's nothing to compare (never a fake "0%"), "new" when the prior period was zero. Extracted the `TrendBadge`
  view-model to a shared `trend-badge.model.ts` (one type for the producer + both consumer cards — removes a would-be duplicate
  per drift-detection). Frontend-only (`previous.conversions` already served by both summary paths). TDD-first: specs (card +
  component) written before impl. Verified: tsc 0 · backtick 0 · **Karma 2008/2008** (+6) · build 0 · eslint 0 err · deployed
  R2 + chunk-hash prod-verified (`chunk-3SPBOWJE.js`, `an-conv-trend` live). Next: remaining server-CSV `downloadText`
  consolidation (`analytics-dashboard` + audit full-trail, consistency-only), then DST-precise tz shift.
- **Cycle 26 — 2026-09-24 (Data: owner row DELETE for form_submissions — the long-deferred mutation path):** Shipped the
  epic's most-requested, repeatedly-deferred capability — an owner deleting their OWN rows — scoped to the one table where
  it's a genuine need + tenant-owned: **Form Submissions** (deleting spam/test leads). NEW `DELETE
  /api/sites/:siteId/data-overview/:table/:rowId`: org auth (401) → `ownsSiteData` tenant gate (404) → `DELETABLE_OVERVIEW_TABLES`
  allowlist resolves a trusted literal table name (hostile `:table` → 400, never reaches SQL — the allowlist is BOTH the boundary
  AND the killswitch) → parameterized double-scope `DELETE … WHERE id=? AND site_id=?` → `meta.changes===0` → 404 (never a silent
  success) → audit-logged (`site_data.row_deleted`). `form_submissions` browse now SELECTs a stable `id` (kept OUT of display
  columns). UI: danger-styled **Delete row** in the row-detail bar (only for a deletable table + stable-`id` row) → `ConfirmService`
  dialog showing the exact statement → refreshes grid + Overview counts. Extracted `deletable` onto `DataOverviewTable` +
  `deleteOverviewRow` on `ApiService`. Docstring/pill reconciled (grid was "read-only"; now form_submissions is deletable, other 4
  stay read-only). HARD delete (`form_submissions` has no `deleted_at`) — confirm required. TDD-first. Verified: worker tsc 0 · fe
  tsc 0 · backtick 0 · **Jest 749 suites / 12280** (+10) · **Karma 2014/2014** (+6) · eslint 0 err · frontend build 0 · **both
  deployed** (R2 `chunk-4SZTTIPL.js` + worker `b9f588b1`) · **prod-verified live NON-DESTRUCTIVELY** (nonexistent rowId): 401
  unauth · 400 read-only-table · 404 no-match · 404 tenant-isolation · `deletable` flag correct per table. Next: row EDIT/ADD
  (typed cells — NULL/number/bool/JSON editors on the now-in-place allowlist + stable-id plumbing).
- **Cycle 27 — 2026-09-24 (Data: owner row EDIT for form_submissions.status — completes browse/delete/edit CRUD):** Added the
  edit path on the Cycle-26 foundation. NEW `PATCH /api/sites/:siteId/data-overview/:table/:rowId` `{column,value}`: auth (401) →
  `ownsSiteData` (404) → `editableTableName` (read-only table → 400) → `editableColumn` (`EDITABLE_OVERVIEW_COLUMNS` per-table
  `{column→{type,options}}` allowlist; non-editable/hostile column → 400, never reaches SQL) → `validateEditableValue` (out-of-enum
  → 400, never written) → parameterized double-scope `UPDATE … SET "col"=? WHERE id=? AND site_id=?` → `meta.changes===0` → 404 →
  audit (`site_data.row_updated`). First editable column: **`form_submissions.status`** (enum mirroring the D1 CHECK — retriage a
  lead). Only SAFE constraint-bounded columns are exposed (never PII/structural). UI: enum `<select>` + Save in the row-detail (only
  for editable tables/columns), Save-enabled only when changed, `ConfirmService` shows the exact UPDATE, reverts draft on cancel;
  `selectTable`/`toggleRow` clear the draft so it never bleeds across rows. Reversible (unlike delete). `editableColumns` added to the
  data-overview response + `DataOverviewTable`; `updateOverviewRow` on `ApiService`. Docstring/matrix reconciled. TDD-first. Verified:
  worker tsc 0 · fe tsc 0 · backtick 0 · **Jest 750 suites / 12294** (+14: 7 route + 7 helper; 1 pre-existing flaky timer-leak test,
  passed on re-run) · **Karma 2021/2021** (+7) · eslint 0 err · frontend build 0 · **both deployed** (R2 `chunk-HSFZLQMS.js` + worker
  `ae2047f3`) · **prod-verified live NON-DESTRUCTIVELY**: 401 · 400 read-only-table · 400 non-editable-column · 400 invalid-enum ·
  404 no-match · 404 tenant · `editableColumns:['status']` for form_submissions only. Next: broaden typed editors (NULL/number/bool/
  JSON) + INSERT (add-row) on the same allowlist.
- **Cycle 28 — 2026-09-24 (Analytics: CWV rating distribution — the good/needs/poor spread behind each p75):** The prompt
  explicitly asks for CWV "distributions"; the card showed only the p75 point. `getWebVitalsSummary`'s `stat()` now classifies
  every real sample against a new server-side `CWV_THRESHOLDS` (Google's official good/needs/poor, mirroring the card's `rating()`)
  into `dist:{good,needs,poor}` on each `WebVitalStat` (`good+needs+poor===samples`). Zod `WebVitalStatSchema` gains an optional
  `dist` (WebVitalDistSchema) — optional for back-compat, always populated live. `WebVitalsCardComponent` renders a 3-segment
  distribution BAR per metric + a %-legend (visual) + an **exact-count aria label** (percentages round to 99–101; counts never lie),
  only when `dist` + samples exist (no fabricated dist). Shows the spread the p75 hides (a "needs" p75 can be mostly-good). Both
  summary paths covered (single `getWebVitalsSummary` change). TDD-first. Verified: worker tsc 0 · fe tsc 0 · backtick 0 · **Jest
  750 suites / 12296** (+2 dist service specs; updated 1 exact-shape assertion to the new contract) · **Karma 2024/2024** (+3) ·
  eslint 0 err · frontend build 0 · **both deployed** (R2 `chunk-ZRYDNZDJ.js` + worker `f55db969`) · **prod-verified live with REAL
  data**: `lcp dist {good:6,needs:1,poor:0}` (=7 samples), `cls {good:4,needs:3,poor:0}`, `inp null` (no samples → no dist). Next:
  conversions-by-kind Δ (needs a server `previous.byConversionKind` increment), then DST-precision, then CSV consolidation (cosmetic).
- **Cycle 29 — 2026-09-24 (Data: Overview "recent activity" per-table freshness):** Answered the epic's Overview "recent
  activity" ask (chose it over the low-value "broaden typed editors" handoff — owners don't add fake leads). Each `OverviewTable`
  gains a `lastActivitySql` (`SELECT MAX(<ts>) AS ts` — same ts column + soft-delete filter as browse); the data-overview handler
  runs it alongside count (Promise.all, fail-soft) → `last_activity` per table. Each table chip shows a compact relative age
  ("just now"/"5m"/"3h"/"2d"/"3w"/"5mo"/"1y"); empty table → null → NO chip (never a fabricated "0"). Timestamps are UTC
  `YYYY-MM-DD HH:MM:SS` (no zone) → new `compactAge`/`fullTimestamp`/`parseUtc` normalize to UTC before diffing (a local parse
  would shift the delta by the tz offset); `now()` isolated for deterministic tests. TDD-first. Verified: worker tsc 0 · fe tsc 0 ·
  backtick 0 · **Jest 751 suites / 12301** (+5) · **Karma 2028/2028** (+4) · eslint 0 err · frontend build 0 · **both deployed**
  (R2 `chunk-6NRHGP4D.js` + worker `dd4eb2d2`). **DEPLOY GOTCHA caught by prod-surface verify:** the FIRST `wrangler deploy`
  reported a new version ID (`50a5f537`) but served STALE code (response lacked `last_activity` — had only Cycle-27 fields); a
  `rm -rf .wrangler/tmp` + redeploy fixed it. Prod-verified live REAL data: visitor_events 37 rows→'2026-09-24 12:54:02', empty
  tables→null. Next Data: broaden typed editors (NULL/number/bool/JSON) IF a genuinely-editable column appears; else the Data
  section has plateaued for the shared-DB tenant model (form_submissions CRUD + browse/export/overview/freshness all done).
- **Cycle 30 — 2026-09-24 (Analytics: conversions-by-kind Δ — per-kind period-over-period on the conversions card):** Shipped
  the Cycle-28 top handoff. Server: refactored `getConversionKinds` onto a shared `conversionKindsForClause` + added
  `getPreviousConversionKinds` (the `previousWindow` predicate); BOTH summary paths (live + rollup) now populate
  `previous.byConversionKind` (Zod `previous` schema gains a `byConversionKind` defaulted `[]` for back-compat). Frontend:
  `conversionKindDeltas` (parent computed, `label → TrendBadge` via the same authoritative `deltaBadge` — source-consistent with
  the total Δ) feeds a new `kindDeltas` input on `ConversionsCardComponent`; each row shows a small `trend-chip--sm`
  (`an-conv-kind-trend-<raw>`) keyed by raw label, aria-prefixed with the humanized label. Honest: a kind absent from the prior
  window → "new"; nothing to compare → no chip. TDD-first. Verified: worker tsc 0 · fe tsc 0 · backtick 0 · **Jest 751 suites /
  12304** (+3: previous-window predicate ×2 + summary wiring) · **Karma 2033/2033** (+5: 3 card + 2 component) · eslint 0 err ·
  frontend build 0 · **both deployed** (R2 `chunk-CE7UTQCN.js` + worker `c782d04e`; proactively cleaned `.wrangler/tmp` per the
  Cycle-29 stale-bundle lesson) · **prod-verified live by SHAPE**: `previous.byConversionKind` present (current `[{call:2}]`, prior
  `[]` — honest empty for this site → the 'call' badge would be "new"). Next Analytics: DST-precise tz shift, or browsers/OS
  breakdown (needs UA at ingest), then CSV consolidation (cosmetic).
- **Cycle 31 — 2026-09-24 (Data: "Recent activity" audit trail — the epic's Activity pillar):** Shipped the Cycle-29 next
  candidate. NEW `GET /api/sites/:siteId/data-activity` reads `audit_logs` filtered to `action IN ('site_data.row_deleted',
  'site_data.row_updated')` + `json_extract(metadata_json,'$.site_id') = ?` (the site_id the delete/edit handlers set) → a safe
  shape (`action`/`table`/`message`/`actor`/`at`); the raw `metadata_json` is NEVER SELECTed (no column-value leak). Org-scoped
  (`ownsSiteData` → 404) + action-allowlisted (app traffic never leaks in) + fail-soft (query error → empty, never 500). UI: a
  collapsible **"Recent activity"** panel at the bottom of the Data browser lists the owner's OWN deletes/edits newest-first with
  a delete/edit icon + safe summary + relative age (reuses Cycle-29 `compactAge`/`fullTimestamp`); loads on init, refreshes after
  each delete/edit, hidden when empty. **ROUTE-SHADOW caught by the failing test:** `/data-overview/activity` was shadowed by the
  `/data-overview/:table` browse route (`:table`="activity" → 400) → moved to a distinct sibling path `/data-activity`
  ([[hono-wildcard-route-shadow]]). Also hit the `.withContext()` Jest pitfall again (Jasmine-only) → plain comment. TDD-first.
  Verified: worker tsc 0 · fe tsc 0 · backtick 0 · **Jest 752 suites / 12308** (+4) · **Karma 2036/2036** (+3) · eslint 0 err ·
  frontend build 0 · **both deployed** (R2 `chunk-6Y4V7JDG.js` + worker `dc2cd7da`; cleaned `.wrangler/tmp` per Cycle-29 lesson) ·
  **prod-verified live**: 401 · 404 tenant · 200 honest-empty (test site has no real site_data mutations — verify-against-source-of-
  truth; mapping-with-data proven by unit tests, no prod rows seeded per guardrail). The Data section's CRUD story is now complete
  (browse · delete · edit · overview · freshness · **activity**). Next Data: broaden typed editors only if a genuinely-editable
  column appears; otherwise the shared-DB tenant model has no more non-blocked owner surface.
- **Cycle 32 — 2026-09-24 (Analytics: device / browser / OS "Devices & platforms" breakdown):** The prompt lists "devices,
  browsers, operating systems"; the ingest ALREADY enriched all three (`enrichVisitor(ua)` → `$.device/$.browser/$.os`), but only
  DEVICE was aggregated — browser/OS were stored, unused (the Cycle-30 "needs UA at ingest" note was wrong). Server: new
  `getDimensionBreakdown(env, siteId, dim, …)` (dim allowlisted to device/browser/os → the interpolated `json_extract($.<dim>)` is
  always a trusted literal); wired `byBrowser` + `byOs` into BOTH summary paths (live + rollup-reads-them-live like CWV/conversions);
  Zod `TrafficSummarySchema` gains `byBrowser`/`byOs` (defaulted []). Frontend: new focused presentational **`TechBreakdownComponent`**
  ("Devices & platforms") renders all three pageview splits (top-6, bar + count) from `siteTraffic()` — honest: "unknown" is a real
  bucket (never dropped), empty dimensions are omitted, all-empty → explicit note; source labeled first-party user-agent (covers
  EVERY visitor, unlike Chromium-only CWV). TDD-first. Verified: worker tsc 0 · fe tsc 0 · backtick 0 · **Jest 752 suites / 12311**
  (+3: dimension GROUP BY + allowlist-reject + byBrowser/byOs wiring) · **Karma 2042/2042** (+6) · eslint 0 err · frontend build 0 ·
  **both deployed** (R2 `chunk-PD6IKD5C.js` + worker `ea41980e`; cleaned `.wrangler/tmp` per Cycle-29 lesson) · **prod-verified live
  REAL data**: device `[desktop:19]`, browser `[Chrome:15, unknown:3, Firefox:1]`, os `[macOS:16, unknown:3]`. Next Analytics: add
  browser/OS to the CSV export (device already there), then DST-precise tz, then CSV consolidation (cosmetic).
- **Cycle 33 — 2026-09-24 (Angular style: signal-input migration of the `states/` family):** Data + Analytics have
  plateaued for non-blocked high-value work, so advanced the ledger's recorded next action — the Angular style-guide
  `@Input()`/`@Output()` → `input()`/`output()` signal migration (newer components already use `input()`; the old
  decorator holdouts were the drift). Migrated the coherent **`components/states/` family**: `empty-state` (4 `@Input`
  + 1 `@Output` → `input()`/`output()`; `title` → `input.required<string>()` — the required binding was already
  template-enforced) and `error-card` (5 `@Input` + 1 `@Output`; the getter/setter `hint` — which derived its default
  from `correlationId` — became an `input<string|undefined>()` + a reactive `displayHint = computed()`, a faithful +
  MORE reactive translation). Behavior-preserving: consumers' `[foo]`/`(bar)` bindings are unchanged; both components'
  existing specs pass against the migrated code. Remaining decorator files: **42 `@Input` / 6 `@Output`** (from ~45/~7).
  Verified: fe tsc (app + spec) 0 · backtick 0 · **Karma 2043/2043** (+1: error-card displayHint reactivity when a
  correlationId arrives after render) · eslint 0 err · frontend build 0 · deployed R2 + chunk-hash prod-verified
  (`chunk-UERS6MFZ.js`, 200 + marker). Frontend-only (no worker deploy). Next: continue the migration one coherent
  component/family per cycle (`calendar-widget`, site-kit primitives), or return to Data/Analytics if a non-blocked gap appears.
- **Cycle 34 — 2026-09-24 (Analytics: CSV export browser/OS parity — the platform trio):** Closed the Cycle-32
  handoff's top item. The "Devices & platforms" card renders **device / browser / OS**, but `buildAnalyticsCsv` only
  exported **device** — an export⇄dashboard gap. Added `byBrowser`/`byOs` to the pure fn's typed input and emits them
  grouped **device → browser → os** (mirroring the card) right after the device rows. Purely additive: the call site
  already passes the full `siteTraffic()` (which carries `byBrowser`/`byOs`), so **no call-site change** — tsc confirms
  structural assignability. Honest omission preserved — browser/os rows are omitted (never a fabricated row) when their
  breakdown is absent, matching the device/CWV/delivery pattern. Verified: fe tsc (app + spec) 0 · **Karma 2045/2045**
  (+2: full-trio grouped-order export + browser/os honest-omission) · frontend build 0 · deployed R2 + chunk-hash
  prod-verified (`chunk-6YFA6GWF.js`, 200 + `browser,`/`os,` markers live + referenced by live `main-WMKZGVGS.js`).
  Frontend-only (no worker deploy). Next: DST-precise IANA-zone timezone shift (currently an honest fixed-offset caveat),
  then the low-value CSV consolidation (audit/analytics-dashboard hand-rolled downloads → `downloadText`).
- **Cycle 35 — 2026-09-24 (Data: schema browser — triggers, completing the SQLite schema tree):** The epic explicitly
  wants the D1 schema browser to show "tables, **views, indexes, triggers**". The endpoint already enumerated
  tables + views (`type IN (table,view)`) and attached indexes/FKs per table — but **triggers were missing**, and the
  platform D1 has 2 real triggers + 6 views. Added `trigger` to the `sqlite_master` enumeration (now `type IN
  (table,view,trigger)`, selecting `tbl_name`); a trigger short-circuits the loop — it carries no columns/indexes/FKs,
  so the 3 PRAGMA round-trips are skipped and it returns just `{name, type:'trigger', create_sql, on_table}`. UI
  (`SiteSchemaBrowserComponent`): triggers list with a type badge (already rendered for non-tables), the detail header
  shows **"trigger on `<table>`"**, and a no-columns note replaces the empty columns grid while the CREATE TRIGGER SQL
  stays copyable. `SchemaTable` gained `on_table?`. Now a complete SQLite schema tree matching DB Browser / Beekeeper /
  SQLiteStudio. Chose this over broadening row-edit to `form_submissions` PII / add-row — editing a visitor's submitted
  email/phone or injecting fake leads would corrupt an immutable submissions log (per memory: "only broaden typed
  editors if a genuinely-editable column appears"). Verified: worker tsc 0 · **Jest 42/42** on the 2 schema suites (+1:
  trigger enumeration + `on_table` + skipped-PRAGMAs) · fe tsc (app + spec) 0 · **Karma 2046/2046** (+1: trigger render —
  on-table label / no-columns note / CREATE TRIGGER shown) · frontend build 0. Deployed **worker** (`--env production`,
  clean `.wrangler/tmp`, version `091c850b`) + **frontend R2**. Prod-verified: frontend `chunk-JYMLJNSR.js` 200 with all
  3 markers + referenced by live `main-WUV44WSB.js`; worker `/sql/schema` live + correctly gated — 401 (no auth), 403
  (non-super-admin E2E key, exact FORBIDDEN body). NOTE the super-admin schema **output** (triggers appearing) can't be
  exercised end-to-end via the E2E test-org (it 403s by design), so trigger correctness rests on the 42 Jest + the Karma
  render test. Next: the schema browser is now epic-complete; remaining Data gaps are credential-blocked (D1 REST
  size/usage/Time-Travel) or product-N/A (KV/R2/DO/Vectorize have no per-tenant data API today).
- **Cycle 36 — 2026-09-24 (Analytics: honest "Visits" label — kill the unique-people conflation):** The prompt's central
  correctness mandate is "do not conflate requests / visits / pageviews / unique people". The primary admin Analytics KPI
  tile labeled `COUNT(DISTINCT session_id)` as **"Unique visitors"** with a **"Distinct IPs"** sub-label — but
  `session_id = SHA-256(ip|ua|YYYY-MM-DD)` is stable **per visitor per UTC day**, so over an N-day window it's distinct
  visitor-DAYS summed (a person on 3 days = 3), which is MORE than unique people and isn't "distinct IPs" (two UAs on one
  IP = 2). Relabeled honestly → **"Visits"** everywhere: tile label + sub-label ("Anonymous visitors, counted once per
  day") + `kpiVisitorsLabel` aria ("312 visits") + `visitorDelta`/`pagesPerVisit` comments; glossary term "Unique
  sessions" → **"Visits"** with a per-day-accurate definition spelling out "MORE than the number of unique people … not
  page views or requests". Backend unchanged (the field was already honestly named `uniqueSessions`); this is a
  frontend+glossary honesty fix. Verified: fe tsc (app + spec) 0 · **Karma 2047/2047** (+1 honesty-lock test: tile reads
  "Visits", never "Unique visitors"/"Distinct IPs"; +glossary assertion) · build 0 · deployed R2 + chunk-hash
  prod-verified (`chunk-W4ACX2ML.js` 200 with the new sub-label, **"Distinct IPs across" gone**, referenced by live
  `main-XYEXBZG2.js`). Frontend-only (no worker deploy). **Next (highest-priority):** the SAME conflation persists on the
  SEPARATE public-analytics surface — `libs/features/analytics/handlers.ts:434` maps `summary.uniqueSessions →
  uniqueVisitors` (feeding `public-analytics.component` + the docs endpoint) while OTHER sources there are genuinely
  unique users (GA4 `totalUsers` @ line 675, CF-zone `unique_visitors`). Relabel per-source (D1=Visits, GA4/CF=unique
  users) — a distinct, careful slice, not a blind rename.
- **Cycle 37 — 2026-09-24 (Data: bulk row selection + bulk delete — the epic's "bulk changes" pillar):** The owner
  could delete `form_submissions` rows only ONE at a time; the epic explicitly wants "bulk selection and bulk changes
  with previews, affected-row limits, confirmations, and clear partial-failure reporting". Shipped it end-to-end.
  **Worker:** new `POST /data-overview/:table/bulk-delete` `{ids[]}` — same safety chain as the single delete (auth 401 →
  `ownsSiteData` 404 → `deletableTableName` trusted-literal, read-only→400) PLUS ids deduped + validated (non-empty
  strings) + capped at **100** (over-cap→400), a parameterized `id IN (?,…) AND site_id = ?` (every id BOUND, never
  interpolated, double-scoped by site), audit-logged (`site_data.rows_bulk_deleted`, added to the `/data-activity`
  filter), returning an honest `{requested, deleted, skipped}` (ids matching no row for this site are skipped, not
  errors). **Frontend:** grid row checkboxes + select-all-on-page header check (deletable tables only, via a leading
  column; detail colspan adjusts) + a danger bulk bar ("N selected · Delete selected · Clear") → `ConfirmService` shows
  count + statement → `bulkDeleteOverviewRows` → toast (honest partial wording) → refresh grid/Overview/activity.
  Selection is a `Set<string>` of ids, CLEARED on every re-fetch (in `loadPage`) so a stale id from another
  page/filter can never be deleted (the epic's "unintended multi-row / stale edit" hazard). `api.service` gained
  `bulkDeleteOverviewRows`. Chose bulk-delete over broadening row-EDIT to PII/add-row (still the wrong direction — an
  immutable submissions log). Verified: worker tsc 0 · **Jest 12322/12322** (full suite; +11 bulk-delete route specs;
  updated the activity filter assertion) · fe tsc (app + spec) 0 · **Karma 2053/2053** (+6 bulk specs) · build 0.
  Deployed **worker** (`--env production`, clean tmp; container rollout timed out once → retried → version
  `42f318df`) + **frontend R2**. Prod-verified NON-DESTRUCTIVELY on the owned test site: 401 (no auth) · 400 (read-only
  table) · 400 (empty ids) · **200 `{requested:1,deleted:0,skipped:1}` via a nonexistent id (deleted nothing real)** ·
  404 (foreign site — tenant isolation); frontend `chunk-GT47FLOG.js` 200 with bulk markers + referenced by live
  `main-HABWKA3B.js`. Next: the owner Data CRUD is now browse/search/filter/sort/export/delete/**bulk-delete**/edit +
  freshness + activity — genuinely complete; remaining Data gaps are credential-blocked (D1 REST size/usage/Time-Travel)
  or product-N/A (no per-tenant KV/R2/DO/Vectorize data API). The super-admin SQL console's syntax-highlighting /
  schema-aware completion / multi-tab is the next non-blocked (but narrower-audience) polish.
- **Cycle 38 — 2026-09-24 (Analytics: public share report — fix lying-empty "Unique visitors: 0" + conflation):**
  Followed the Cycle-36 handoff to the SEPARATE public-analytics surface and found a real customer-facing bug: the
  public share page (`/shared/analytics/:token`, `public-analytics.component`) read `s.traffic?.uniqueVisitors` — but
  the API (`SiteAnalyticsSummary.traffic` = `visitor_events_core` `TrafficSummarySchema`) provides `uniqueSessions`,
  NOT `uniqueVisitors`. So the "Unique visitors" tile ALWAYS rendered **0** (a key-mismatch lying-empty), AND the label
  was the unique-people conflation. The existing spec fixture used the SAME wrong key (`uniqueVisitors: 567`), so the
  mock agreed with the bug → phantom-green. Fixed both: the interface + read now use `uniqueSessions`, the tile is
  labelled **"Visits"** (consistent with the Cycle-36 admin relabel), the spec fixture uses the REAL key, and a
  regression lock asserts the tile shows the real 567 under "Visits" and never "Unique visitors". Pure frontend (the
  backend already provided the right key). Verified: fe tsc (app + spec) 0 · **Karma 2053/2053** · build 0 · deployed
  R2 + chunk-hash prod-verified (`chunk-RUNCFHGD.js` 200 with `uniqueSessions`/`Visits`, no "Unique visitors",
  referenced by live `main-RLEHCBJS.js`). **Next (highest-priority):** the `/api/analytics/:siteId` endpoint
  (`libs/features/analytics/handlers.ts`, consumed live by `admin-state.service.ts:168` → dashboard) returns
  `stats.uniqueVisitors` from THREE sources with different meaning — D1 `uniqueSessions` (line 434 = Visits), CF
  `unique_visitors` (356 = unique users), GA4 `totalUsers` (675 = unique users) — but its consumer labels all three the
  same. Add a per-source visitors label (server sets `visitorsMetric: 'visits'|'unique_users'` by `source`; the
  dashboard renders it) so the D1 fallback reads "Visits" and GA4/CF read "Unique visitors".
- **Cycle 39 — 2026-09-24 (Angular style: `auth-image-src` directive → `input()` + `effect(onCleanup)`, fixing a fetch
  race):** Inventoried the 44 remaining `@Input()`/`@Output()` decorator files. The recorded next candidates (site-kit
  `stats-band`/`logo-cloud`/`trust-badges`) turned out to live in the **entirely UNWIRED `site-kit/*` library** (25+
  components — no importers, selectors, registry, or build includes; only 2 specs; last touched 14h ago by cycle 2's DI
  migration) → low-value churn (and NOT deletable: actively maintained + deleting would orphan its 2 preserved specs).
  Pivoted to a WIRED, spec-covered target that IMPROVES the code: migrated `directives/auth-image-src.directive` from
  `@Input()` + `ngOnChanges` + `ngOnDestroy` to `input()` + a single `effect((onCleanup) => …)`. Beyond the v21 idiom (2
  lifecycle hooks removed), `onCleanup` unsubscribes the prior in-flight fetch on every src change — **fixing a latent
  race** (a slow old thumbnail fetch could resolve late and overwrite a newer src). The only consumer
  (`snapshots.component`) uses the unchanged `[appAuthImageSrc]` template binding — no consumer change. The 5 existing
  specs (drive via host binding + `detectChanges`, never a direct `ngOnChanges` call) validate the migration is
  behavior-preserving; **+1 new spec** locks the race fix. Verified: fe tsc (app + spec) 0 · **Karma 2054/2054** (+1) ·
  build 0 · deployed R2 + chunk-hash prod-verified (`chunk-BU5ZOWHI.js` 200 carrying the directive + referenced by live
  `main-ABRF4FZM.js`; homepage boots 200). Remaining decorator files: **43**. Next: WIRED simple-value-input leaves
  (`calendar-widget`, `pages/admin/empty-state`, `feature-flags/mode-switcher`) — NOT the unwired site-kit primitives;
  `focus-trap`/`reveal` use imperative setter/order-fragile reactivity → migrate carefully/last.
- **Cycle 40 — 2026-09-24 (Analytics: remove a dead, wasteful GA4/CF fetch that no UI rendered):** Traced the Cycle-38
  handoff (per-source `visitorsMetric` label on `/api/analytics/:siteId`) to its consumer and found the premise was
  false: `AdminStateService.loadAnalytics` fetched that GA4→CF→D1 endpoint (`api.service.getAnalytics`, period='7') into
  an `analytics` signal on init + site-switch + **every 60s refresh tick**, but **NO component ever read/rendered that
  signal** (grep-confirmed: 0 template readers of `.analytics()`/`.analyticsLoading()`, no `setAnalyticsPeriod` UI). A
  write-only dead fetch wasting one CF/GA4 API call per site per minute — exactly the "one CF request per widget per
  customer" the doctrine forbids, and the per-source label had no surface to render on. Removed the whole dead chain from
  `admin-state.service`: the `analytics`/`analyticsPeriod`/`analyticsLoading` signals, `loadAnalytics`/`setAnalyticsPeriod`
  methods, their 4 call sites (init/site-load/60s-tick/site-switch), the now-unused `tick` counter + `AnalyticsData` import.
  The live refresh now does only the rendered sites+domains+subscription poll. Updated the spec (dropped the
  `setAnalyticsPeriod` test; **+1 regression test** asserting `loadData()`/refresh never call `getAnalytics`, preventing
  re-introduction). `api.service.getAnalytics` + the `AnalyticsData`/`AnalyticsStats`/… type family + the backend
  `/api/analytics/:siteId` handler are now frontend-orphaned — a candidate for a fuller removal (a bigger, tests-touching
  decision), flagged not done. Verified: fe tsc (app + spec) 0 · **Karma 2054/2054** (−1 dead test, +1 regression) ·
  build 0 · deployed R2; app boots (homepage/admin/main all 200, new `main-A6IFORFK.js`). **Next (highest-priority):**
  decide the orphaned `/api/analytics/:siteId` + `getAnalytics` + `AnalyticsData` family — remove them (with the backend
  endpoint + its Jest tests, a coherent cross-stack cleanup) OR wire the GA4/CF data into a real card if GA4-connected
  sites warrant it (most sites have no GA4 → likely remove). Until then, the main analytics dashboard (visitor_events,
  first-party) is the sole rendered source and is honest.
- **Cycle 41 — 2026-09-24 (Cleanup: remove the frontend-orphaned `getAnalytics` client + `Analytics*` types):** Followed
  the Cycle-40 handoff. After the dead admin-state fetch was removed, `api.service.getAnalytics` had zero real callers and
  the `AnalyticsData`/`AnalyticsStats`/`AnalyticsChartPoint`/`AnalyticsTrafficSource`/`AnalyticsTopPage`/`AnalyticsTopCountry`
  interfaces were used only by each other + `getAnalytics`. Verified safe: no spec tests the REAL method (the
  `analytics.component` "getAnalytics" spy actually mocks `getMultiUrlAnalytics`; the admin-state regression test uses a
  mock spy; `analytics-live` declares its OWN local `AnalyticsDataResponse`), and grep found no import of the types outside
  `api.service`. Removed the method + all 6 interfaces (~65 lines); kept `AnalyticsRange` (separate, used by the multi-URL
  endpoint). No test files touched (the removal breaks nothing — tsc + Karma confirm). Deliberately KEPT the backend
  `/api/analytics/:siteId` handler + its Jest tests — removing them would touch preserved tests (a separate decision);
  it's a documented legacy secondary route with no live consumer. Verified: fe tsc (app + spec) 0 · zero dangling refs ·
  **Karma 2054/2054** · build 0 · deployed R2; app boots (homepage/admin/main all 200, new `main-KKRJBIPD.js`). **Next:**
  the biggest remaining cleanup is the UNWIRED `site-kit/*` library (25+ components) — needs the Brian-gated
  intent decision (unbuilt site-builder vs. orphan) before removal/wiring. Data CRUD stays complete; the SQL-console
  editor UX (syntax highlight / completion / multi-tab) is the next non-blocked Data polish but needs a code-editor lib.
- **Cycle 42 — 2026-09-24 (Analytics: surface campaign attribution — utm_source / utm_campaign, ingested-but-unshown):**
  `enrichVisitor` has captured `utmSource`/`utmMedium`/`utmCampaign` into pageview metadata all along, but NO UI surfaced
  it — the same ingested-but-unsurfaced gap as browser/OS in Cycle 32, and the prompt explicitly lists "campaign
  parameters". Added `getCampaignBreakdown` (CAMPAIGN_DIMENSIONS allowlist → trusted literal; `json_extract($.<dim>)`
  with **`IS NOT NULL`** so the untagged direct/organic MAJORITY is EXCLUDED — a campaign card must never bucket
  untagged traffic as a giant "unknown"; top-20). Wired `byUtmSource` + `byUtmCampaign` into BOTH summary paths (live +
  rollup-reads-live) + `TrafficSummarySchema` (defaulted [] for back-compat). Frontend: a focused
  `CampaignBreakdownComponent` ("Campaigns & sources", mirroring `TechBreakdownComponent`) shows top source + campaign
  with an honest empty state that **TEACHES how to tag links** (`?utm_source=instagram&utm_campaign=spring-sale`) — the
  epic's "insight that explains its evidence"; wired into `analytics.component` + `SiteTrafficSummary`; CSV export gains
  `campaign_source`/`campaign` rows. Tenant isolation unchanged (rides `/api/sites/:siteId/analytics` →
  `resolveOwnedSiteId`; the dim is allowlisted, values bound). Verified: worker tsc 0 · **Jest 12324/12324** (+3:
  getCampaignBreakdown excludes-null / allowlist-reject / summary-wiring) · fe tsc (app + spec) 0 · **Karma 2062/2062**
  (+8: 6 campaign-component + 2 CSV; fixed a testid collision where the header note + source column shared
  `an-campaigns-source` → renamed the note to `an-campaigns-note`) · builds 0. Deployed worker + frontend R2.
  **Deploy note:** `wrangler deploy` hit a TRANSIENT Cloudflare **workflows-API 500** (`workflows.api.error.internal_server`)
  across 3 retries on the idempotent workflow RE-registration step — a CF-side incident unrelated to this change (pure
  D1 + frontend). The worker SCRIPT + bindings uploaded BEFORE that step: **prod-verified live** the traffic summary now
  returns `byUtmSource`/`byUtmCampaign` (`[]` for the untagged test site) + `/health` 200, so the change is fully live;
  the already-registered workflows keep running their prior version. Frontend `chunk-XO67NIOY.js` live + referenced.
  Next: DST-precise IANA timezone (still a documented fixed-offset caveat), or a bot-filtered-count insight.
- **Cycle 43 — 2026-09-24 (Data: schema browser surfaces composite-PRIMARY-KEY order):** The epic's schema browser
  wants "composite keys, WITHOUT ROWID, virtual tables, generated columns". Checked prevalence in the platform D1:
  generated columns = 0, WITHOUT ROWID = 0 (both would be invisible → skipped), 1 virtual table, but **composite PKs
  are used by 8 tables** — and the schema browser collapsed every PK to a bare "PK" badge, so a composite key's column
  ORDER (which the endpoint already returns via `PRAGMA table_info.pk` = the 1-based position) was invisible. Surfaced
  it, pure frontend (no backend/endpoint change — the position was already in the response, the UI had collapsed it to a
  boolean): `SiteSchemaBrowserComponent` now derives `primaryKey` (PK cols sorted by position) + `isCompositePk`; a
  composite PK renders each column's position ("PK 1" / "PK 2") + a "Primary key · (col1, col2) composite, order
  significant" summary section; a single-column PK stays a plain "PK" with no summary (no churn for the common case).
  Verified: fe tsc (app + spec) 0 · **Karma 2064/2064** (+2: composite-PK order+summary / single-PK-stays-plain; fixture
  gained a composite-PK `memberships` table) · build 0 · deployed R2 + chunk-hash prod-verified (`chunk-HPIJAWDB.js` 200
  with the `sb-pk-summary` marker + referenced by live `main-RHKENK36.js`). Super-admin surface, so the E2E key can't
  render it (403) — behavior is locked by Karma against realistic composite + single-PK fixtures. Next: the schema
  browser's remaining epic items are low-value here (generated columns / WITHOUT ROWID = 0 in the platform D1; 1 virtual
  table could get a "virtual" badge but it's niche). The bigger Data gap is the SQL-console editor UX (syntax highlight /
  completion / multi-tab) — needs a code-editor lib (a dependency decision).
- **Cycle 44 — 2026-09-24 (Analytics: VISIBLY surface that the Delivery card is a sampled ESTIMATE):** The prompt's
  central honesty mandate — "surface sampling/estimates in the UI; never imply an estimated metric is exact" — was
  half-met: the Delivery card's CF `httpRequestsAdaptiveGroups` data IS adaptive-sampled, but the "adaptive-sampled"
  caveat lived ONLY in a hover `title` tooltip, so the visible requests/cache/bandwidth numbers read as exact (just like
  the truly-exact first-party audience cards → conflation risk). Made it VISIBLE, pure frontend: the card header now
  shows an italic-amber **"sampled estimate"** tag (`an-dl-sampled`), and the footer note now reads "adaptive-sampled —
  **approximate, not exact**" AND explicitly contrasts "Your audience metrics above (page views, visits, conversions)
  are **exact first-party counts**" — so an owner can't misread the sampled edge counts as exact. No data/tenant change
  (the delivery data + `resolveDeliveryZone` ownership path are unchanged; this is a labeling-honesty fix). Verified: fe
  tsc (app + spec) 0 · **Karma 2065/2065** (+1: asserts the sampled indicator is VISIBLE text, not tooltip-only, + the
  exact-vs-sampled contrast) · build 0 · deployed R2 + chunk-hash prod-verified (`chunk-W7OAXUAS.js` 200 with both
  "sampled estimate" + "approximate, not exact" markers, referenced by live `main-OSENXWN5.js`). **Next:** DST-precise
  IANA timezone (still a fixed-offset caveat — moderate complexity, ~1hr-twice-a-year ROI), or a bot-filtered-count
  insight (needs new instrumentation — bots are currently dropped, not counted). Both are lower-value than shipped work;
  the analytics section is mature + honest (first-party exact, CF-edge now visibly sampled, plan-blocked items absent).
- **Cycle 45 — 2026-09-24 (Data: SQL console runs the SELECTED statement, not always the whole buffer):** The epic's
  D1-console mandate wants a real SQLite manager; a real console runs *what you highlight*, not the entire editor every
  time. `runSql()`/`explainSql()` in `site-detail.component.ts` previously always executed the full `sqlQuery()` buffer,
  so an operator with three statements in the editor couldn't run just one — a footgun (accidental EXPLAIN of the wrong
  statement) and a papercut. Added selection/current-statement execution, pure frontend (super-admin read-only console —
  no backend/endpoint/tenant change; still SELECT/EXPLAIN/WITH/PRAGMA-only, 8 000-char cap, `assertSuperAdmin`): a
  `sqlSelection` signal tracks the textarea's highlighted range (`syncSqlSelection` bound to select/keyup/mouseup),
  `effectiveSql()` returns the trimmed selection when present else the whole buffer, `runSql`/`explainSql` both call it,
  and the Run button label flips to **"Run selection"** with a matching title while text is highlighted; typing
  (`onSqlChange`) or recalling a saved/starter query clears the stale selection so you never run a phantom highlight.
  Verified: fe tsc (app + spec) 0 · **Karma 2070/2070** (+5: selection executes / blank-selection falls back to buffer /
  `hasSqlSelection` non-blank / `syncSqlSelection` reads live textarea range / typing+recall drop stale selection) ·
  build 0 · deployed R2 + chunk-hash prod-verified (`chunk-NZ73IA52.js` 200 with the "Run selection" marker + referenced
  by live `main-ERJDAVC4.js`). Super-admin surface, so the E2E key 403s it — behavior locked by Karma. **Next:** the SQL
  console's remaining epic items (syntax highlighting / schema-aware completion / multi-tab concurrent buffers) all need a
  code-editor lib (CodeMirror 6) — a Brian-gated dependency decision, not a no-dep increment; selection execution is the
  last high-value no-dep SQL-console lever. Data section is otherwise plateaued (credential-blocked D1-REST/KV/R2/DO/
  Vectorize items, or product-N/A).
- **Cycle 46 — 2026-09-24 (Angular: migrate the live admin `empty-state` to signal inputs/outputs + NG8113 dead-import
  sweep):** Advanced the signal-input migration on the highest-value WIRED, spec-covered target. `pages/admin/empty-
  state.component.ts` (imported by 10 admin sections — voice, analytics, apps, apps-instances, domains, domain-stack,
  voice/{numbers,conversations,insights,mcps}) was still decorator-based (`@Input()`/`@Output()`, no `OnPush`).
  Migrated to `input()`/`output()` + `ChangeDetectionStrategy.OnPush`, and **removed the grep-proven-dead
  `secondary`/`secondaryClick` button** (no consumer ever passed it — dead-feature removal per the cleanup mandate).
  Kept the exact used API (icon/title/body/primary/primaryClick), template structure, classes, testids, and styles →
  **render-neutral**: all 10 consumers' `[title]`/`body=`/`primary=`/`(primaryClick)` bindings are unchanged (signal
  input/output binding syntax is identical to decorators). Also swept the 3 compiler-flagged **NG8113** dead imports the
  prod build surfaced (`RouterLink` in integrations + domain-picker, `CharCountComponent` in settings — each verified
  unused in-template before removal; kept `Router` the service + settings' used `RouterLink`); `ng build` now emits 0
  NG8113. Added 2 unit tests (primaryClick emits on CTA click / no CTA when `primary` unset — new coverage of the
  migrated output + conditional-CTA). Verified: fe tsc (app + spec) 0 · **Karma 2072/2072** (+2) · `ng build:prod` 0
  errors + **0 NG8113** · deployed R2 (293 files, CDN purged) + prod-verified: homepage 200, local `main-T62ZB734.js` ==
  live `main-T62ZB734.js` (this build is deployed), empty-state admin chunks (`chunk-4L6W25SG.js`, `chunk-ZJRRYDYD.js`)
  200 with the `empty-state-pretty` marker live. Admin surface is authed so a deep visual re-check needs the E2E key, but
  the change is provably render-neutral (same markup/classes/testids) + behavior locked by Karma. Discovered + logged a
  **duplicate `EmptyStateComponent`** (two components, one selector — see the Angular-coverage note above); consolidation
  needs a visual-design call, so it's a tracked Rec, not this cycle. **Next:** `calendar-widget` signal-input migration
  (its 1 input is a getter/setter with logic → `input()` + `computed`/`effect`), or delete the dead `mode-switcher`.
- **Cycle 47 — 2026-09-24 (Data: SQL console gains positional bind parameters `?N`):** The Data epic's SQL-workspace
  spec explicitly asks for "parameters", and it's the "parameterize values, never concatenate" mandate as a *feature*.
  Full vertical slice, no new dep/credential. **Worker** (`/sql/exec`): `SqlExecSchema` now accepts an optional Zod-typed
  `params[]` (union string/number/bool/null, ≤50); the handler binds them via `.prepare(q).bind(...params).all()` —
  `.bind()` only when params exist (a no-param query keeps its exact path), booleans coerced to 0/1 (no native SQLite
  bool), and the audit metadata logs the param **count**, never the values (the epic's sensitive-parameter redaction).
  **Frontend** (`site-detail.component.ts`): a "Bind params" JSON-array input (`["vitos", 42]` → `?1`, `?2`), a
  `parseSqlParams()` validator, and three client guards that block a doomed POST with an inline reason — invalid JSON,
  >50, and **params-but-no-`?`-placeholder** (the common footgun); `runSql` + `explainSql` both send `{query, params}`
  only when non-empty; `useSqlStarter` clears stale binds (starters are parameterless + auto-run). Verified: worker tsc 0
  · **worker Jest 12329/12329** (+5) · fe tsc (app+spec) 0 · **Karma 2078/2078** (+6) · worker lint 0 errors · `ng
  build:prod` 0 err + 0 NG8113. Deployed BOTH surfaces: worker `wrangler deploy --env production` → version **`e7a61055`
  @ 100%**, `/health` 200 (the CONTAINER app rollout timed out on a CF-side `standard`→`standard-1` instance-type
  migration — that's the site-BUILD container, NOT the API routes; the Worker SCRIPT deployed + serves, verified via the
  deployments list + health); frontend R2 → `main-DAXJOYPN.js` hash-matched, chunk `chunk-BXXDK73H.js` 200 with the
  `sql-params` + `no ? placeholder` guard markers live. Super-admin surface → E2E key 403s it, so the bind path is locked
  by the 39 route Jest tests (bind + boolean-coerce + no-bind-when-empty + >50-reject + count-only-audit). **CF platform
  limitation discovered:** container-app deploys are currently timing out on CF's `standard`→`standard-1` instance
  migration — retry later or it self-heals; does NOT affect Worker-script deploys. **Next:** the SQL console's remaining
  epic items (syntax highlighting / schema-aware completion / multi-tab) still need a code-editor lib (CodeMirror 6 —
  Brian-gated dep); or Analytics: DST-precise IANA timezone bucketing.
- **Cycle 48 — 2026-09-24 (Angular: migrate `calendar-widget` `@Input() set props` → `input()` + `effect()`):** The
  ledger's named next signal-input target. `dashboard/calendar-widget.component.ts` used a decorator SETTER input
  (`@Input() set props(v)`) that conditionally seeds three writable signals — `cursor`, `selectedDayMs`, `view` — which
  are ALSO user-mutable (calendar navigation / day-select), so they can't be `computed`. Migrated to a signal
  `input()` + a `private readonly seedFromProps = effect(...)` that replicates the setter's exact CONDITIONAL override
  (seed cursor+day only for a parseable date — the `Number.isNaN` guard preserved; view only for a valid option). Dropped
  the now-unused `Input` import, added `input`/`effect`. **Render-neutral** for the 1 consumer (`dashboard/widgets.ts`
  binds `[props]="props()"` — signal-input binding syntax is identical to the setter). +2 Karma specs (seeds cursor+view
  from a valid date/view · ignores an unparseable date via the NaN guard but still applies a valid view — both flush the
  effect via `fx.detectChanges()`). Verified: fe tsc (app+spec) 0 · **Karma 2080/2080** (+2) · `ng build:prod` 0 err + 0
  NG8113 · deployed R2 + prod-verified (`main-RAKLPGX5.js` hash-matched live; calendar chunk `chunk-ZRY4Y7NS.js` 200).
  Admin surface behind auth → behavior locked by Karma. **Constraint recorded:** the dead `feature-flags/mode-switcher`
  COMPONENT (the other ledger candidate) can NOT be deleted — its preserved `.spec.ts` pins it (deleting the component
  orphans a preserved spec = compile break); only its `DisclosureMode` type is live. **Next:** `focus-trap`/`reveal`
  directives (imperative setter / order-fragile reactivity → careful), or lift `DisclosureMode` to a shared type file so
  the dead mode-switcher component is import-free (still spec-pinned). Remaining decorator files are mostly the unwired
  `site-kit/*` library (Brian-gated intent call).
- **Cycle 49 — 2026-09-24 (Analytics: verified-plateau — consolidate the last hand-rolled CSV download + reconcile the
  stale coverage matrix):** Inspected the full analytics path and CONFIRMED the customer section is at a genuine no-dep
  plateau — CWV is fully shipped (beacon → `web_vital` ingest → `getWebVitalsSummary` p75+distribution+slowest-pages →
  `<app-web-vitals-card>` with Google-threshold Good/Needs/Poor ratings + histograms + per-page), bot-filtering is
  surfaced (glossary: "automated bots are filtered out"), tz-aware daily bucketing done, and `buildAnalyticsCsv` already
  emits device/browser/OS/CWV. The matrix's two "gap" sections were **stale** (claimed CWV was "the biggest gap / NO
  LCP/INP/CLS data today" — false; and tech-breakdown-in-CSV as #1 — done). Shipped the one remaining tractable code item
  (the matrix's own #3): `analytics-dashboard`'s hand-rolled `new Blob`/`createObjectURL` CSV download → the shared
  `downloadText`, which was itself **hardened with an SSR/non-DOM guard** (`typeof document==='undefined' || URL.
  createObjectURL not a fn → no-op`) so it's now safe for prerender/test too. Removed the duplicate `downloadCsv` method
  (duplicate-impl cleanup). Left `audit`'s full-trail download hand-rolled — it downloads a fetched `res.blob()` (not
  client-built text) with an append-to-DOM anchor, a genuinely different case (blob→text + Firefox risk). Verified: fe
  tsc (app+spec) 0 · **Karma 2081/2081** (+1 SSR-guard test) · `ng build:prod` 0 err + 0 NG8113 · deployed R2 +
  prod-verified (`main-XORNGH7V.js` hash-matched live). Frontend-only (no worker deploy). Reconciled both stale matrix
  sections to match the verified implementation. **Analytics plateau — remaining is plan-blocked (Security/WAF + latency,
  no CF entitlement) or needs plumbing/deps.** **Next (top genuinely-new feature):** hourly "Busiest hours" breakdown —
  blocked on threading `tzOffsetMinutes` through the analytics route + both summary fns (getTrafficSummary doesn't receive
  it today); medium slice + a worker deploy. Then DST-precision (low ROI).
- **Cycle 50 — 2026-09-24 (Analytics: ship the "Busiest hours" hourly breakdown):** The prior cycle's #1 next feature.
  A genuinely-new, actionable insight for a local owner ("your peak is 7–9 PM") from EXISTING `visitor_events` timestamps
  — no new dep/credential/instrumentation. **Solved the tz-plumbing blocker with a LEANER design:** instead of threading
  `tzOffsetMinutes` through the route + both summary fns, the server returns 24 **UTC** hour-of-day pageview buckets and
  the FRONTEND rotates them to the viewer's local time — a pure, tested `rotateToLocalHours`. **Worker:** `getHourlyBreakdown`
  (`strftime('%H', created_at)` over pageviews, `event_type='pageview'` also excludes bots) + `HourCountSchema` +
  `byHour` on `TrafficSummarySchema`, wired LIVE into BOTH summary paths (like CWV/browser/OS — works on live + rollup).
  **Frontend:** new standalone `HourlyBreakdownComponent` (`<app-hourly-breakdown>`, OnPush, `input()`) — 24-bar strip +
  "Peak: 7–9 PM · N views" + honest empty state ("appears once visitors arrive") + a local-time / half-hour-zone caveat;
  `byHour` added to `SiteTrafficSummary`; CSV export gains local `hour_local,HH:00,count` rows. Verified: worker tsc 0 ·
  **worker Jest 67/67 visitor_events_core** (+2: query-shape + row-mapping) · fe tsc (app+spec) 0 · **Karma 2090/2090**
  (+9: rotation/formatHour/component + CSV) · worker lint 0 errors · `ng build:prod` 0 err + 0 NG8113. Deployed BOTH:
  worker version **`f1cd19fc` @ 100%** + `/health` 200 (container-app step errored again on the CF `standard-1` migration
  — SCRIPT deployed + verified by shape), frontend R2 `main-R4ZZN2PS.js` hash-matched + chunk `chunk-6H4RBCJ4.js` 200
  with the "Busiest hours" marker. **End-to-end data-verified (not just render-clean):** the API returns REAL `byHour`
  (`[{hour:0,count:1},…,{hour:12,count:4},{hour:19,count:4},…]`) for the owned test site via the authed E2E owner —
  tenant resolved server-side. **Next:** DST-precision (low ROI) or audit full-trail CSV (cosmetic) — analytics is
  otherwise at a verified plateau (Security/WAF + latency plan-blocked).
- **Cycle 51 — 2026-09-24 (Angular: migrate the two `animations/` directives to signal inputs + add their missing
  specs):** Advanced the signal-input migration on the SAFEST remaining targets. The ledger's named next (`focus-trap`
  setter + `reveal` order-fragile-stagger) are high-risk; an inventory found the two `animations/` directives are
  plain-field `@Input()` (low risk) AND wired (`psRipple` → homepage CTAs + import-from-url; `psReveal` → voice sections)
  AND had NO colocated specs. Migrated both: **`ripple`** (`psRippleColor`/`psRippleDuration` → `input()`; read at
  pointerdown → signal reads the current value, ideal) + **`reveal-on-scroll`** (`psRevealThreshold`/`psRevealMargin`/
  `psRevealOnce` → `input()`; read in ngOnInit for the IntersectionObserver + in its callback). Behavior-preserving —
  consumers bind `[psRippleColor]`/`[psRevealThreshold]` identically for signal inputs, so no consumer changed. **Added
  the two previously-MISSING specs** (net test-coverage gain, per the add-tests mandate): ripple (emits an ink span with
  the bound color/duration on pointerdown; skips under reduced-motion) + reveal-on-scroll (the bound threshold/margin
  reach the observer options — proving the input() migration; reduced-motion adds `is-visible` immediately). Verified: fe
  tsc (app+spec) 0 · **Karma 2094/2094** (+4) · `ng build:prod` 0 err + 0 NG8113 · deployed R2 + prod-verified
  (`main-FE25RZ4O.js` hash-matched live, homepage 200 — the ripple directive runs there). Frontend-only. **Next:** the
  remaining directive migrations are the risky ones — `focus-trap` (a `set focusTrap(value)` setter that imperatively
  activates/deactivates a keydown trap → `input()` + `effect(onCleanup)`, careful) and `reveal` (6 plain-field inputs but
  a module-global stagger counter read only in ngOnInit + a spec that resets it — the inputs migrate cleanly, the counter
  is untouched). Also `animations/ripple`'s sibling `motion.ts`/`directives/*` decorator holdouts + the unwired
  `site-kit/*` (Brian-gated intent call).
- **Cycle 52 — 2026-09-24 (Analytics: disclose edge-delivery DATA LATENCY — the last unaddressed honesty item):** The
  analytics section is at a deep no-dep plateau (delivery card already renders status classes + errors + cache; CWV +
  hourly + campaigns + tech all shipped). The prompt's honesty mandate lists "surface sampling, estimates, **data
  latency**, and source definitions" — sampling/source/retention were disclosed (cycle 44), but **data latency was
  NOT**. The CF-edge delivery data (`httpRequestsAdaptiveGroups`) lags live + is sampled, while first-party
  `visitor_events` is real-time — an owner seeing edge requests that don't match their live pageviews needs that told.
  Added to the delivery card's visible note + tooltip: edge data is "updated on a **short delay** (a few minutes behind
  live)" and first-party audience metrics are "exact, **real-time**" — honest + QUALITATIVE (no invented precision, per
  the never-imply-exact mandate). Fixed the existing spec assertion that broke on the reworded note (`exact first-party`
  → `real-time first-party`) + added a `short delay` latency assertion. Verified: fe tsc (app+spec) 0 · **Karma
  2094/2094** · `ng build:prod` 0 err + 0 NG8113 · deployed R2 + prod-verified (`main-MV67J3LY.js` hash-matched, delivery
  chunk `chunk-DQFYHCSR.js` 200 with the "short delay" marker live). Frontend-only. **Analytics is now at a COMPLETE
  no-dep honesty+coverage plateau** — every prompt coverage item is shipped or plan-blocked (Security/WAF + latency
  percentiles need a CF entitlement) or a large cross-stack feature (drilldown/filter — click a country/device to filter
  the dashboard, the top remaining genuine feature, medium-large: server filter param threaded tenant-safely + all
  breakdown queries + frontend chips + tests + worker deploy). **Next:** drilldown/filter (biggest remaining value), or
  DST-precision (low ROI, needs a tz lib / per-timestamp Intl).
- **Cycle 53 — 2026-09-24 (Data: surface the applied-migration ledger — the epic's "Show migration status"):** Inspected
  the Data section: the SQL result grid already honestly caps ("showing first 200 — Copy/Download exports all"), but the
  epic's "Integrate the migration system · Show migration status" was UNMET — `d1_migrations` was only in the write-console
  denylist, never surfaced. Shipped it end to end. **Worker:** `GET /api/sites/:id/sql/migrations` (super-admin, mirrors
  the schema endpoint) → `SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 500`; full auth chain (401 →
  **403 non-super-admin, ledger never read** → 404 site-not-in-org via `dbQueryOne` → read → audit `site.sql.migrations`);
  **honest** — an absent `d1_migrations` (DB never wrangler-migrated) returns `available:false`, never a fake empty. **Do
  NOT offer drift/pending** — the migration FILES aren't in the running Worker, so applied-vs-pending can't be computed
  without lying; the UI says so. **Frontend:** an "Applied migrations" `<details>` panel in the Schema tab
  (`SiteSchemaBrowserComponent`) — newest-first list (name + applied_at), a count, the honest "ledger not available"
  state, and a 403/network fail-soft to "unavailable" (never an error card). Verified: worker tsc 0 · **worker Jest
  12336/12336** (+5 route: 401/403-no-read/404/list+audit/absent→available:false) · fe tsc (app+spec) 0 · **Karma
  2097/2097** (+3: newest-first / honest-unavailable / 403→unavailable; updated the schema-browser mock to add
  `getSiteMigrations` so ngOnInit's new fetch doesn't break the existing tests) · worker lint 0 errors · build 0 + 0
  NG8113. Deployed BOTH: worker (script uploaded + version live @ health 200; container step errored on the CF `standard-1`
  migration again — routes verified by shape: `/sql/migrations` returns **403** to the E2E non-super-admin, **401** unauth,
  NOT 404 → route live + gated), frontend `main-356GVX7G.js` hash-matched + schema chunk `chunk-ET67LVTG.js` 200 with the
  "Applied migrations" marker. Super-admin surface → the 200-path is locked by Jest (E2E key 403s it). **CF/credential
  blockers (unchanged):** DB size/usage + Time-Travel need D1 REST creds; guided DDL (create/alter table) + full-DB SQL
  export are the remaining big D1 items; KV/R2/DO/Vectorize adapters + syntax-highlight/completion/multi-tab (CodeMirror)
  are credential-/dependency-blocked. **Next:** guided schema DDL (super-admin, CREATE INDEX/VIEW with preview+confirm) is
  the top remaining no-credential D1 item, or the CodeMirror console-UX dependency decision.
- **Cycle 54 — 2026-09-24 (Angular: migrate the heavily-used `reveal` directive to signal inputs):** The ledger's named
  next Angular target, and the most-wired directive (`appReveal` — ~299 usages, on every admin card + marketing section).
  It was flagged "order-fragile" but an inventory showed the RISK is the module-global stagger counter, NOT the inputs:
  all 6 are plain-field `@Input()` read in `ngOnInit`/`play()`. Migrated them to `input()` (`revealDelay`/`revealStep`/
  `revealDuration`/`revealOffset`/`revealThreshold`/`revealMaxDelay`); the stagger counter (`nextRevealIndex()` +
  `resetRevealOrderForTest`) is UNTOUCHED, so the SPA-batch-reset behavior + the order-de-flaking spec setup stay valid.
  Behavior-preserving: consumers bind `[revealDelay]`/`[revealThreshold]` identically for signal inputs. The spec sets
  inputs via HOST-COMPONENT TEMPLATE BINDINGS (not direct field assignment), so its stagger/cap tests stayed valid + I
  added a custom-`[revealMaxDelay]="100"` test proving a NON-default bound value flows through the signal input. Verified:
  fe tsc (app+spec) 0 · **Karma 2098/2098** (+1) · `ng build:prod` 0 err + 0 NG8113 · deployed R2 + prod-verified
  (`main-CYFEVKEP.js` hash-matched, homepage 200 — `appReveal` runs there). Frontend-only. **Next:** `focus-trap` is now
  the LAST risky directive — a `set focusTrap(value)` setter that imperatively activates/deactivates a keydown trap →
  `input()` + `effect(onCleanup)` (careful, a11y-critical, 7 consumers). Then lift `DisclosureMode` to a shared type file
  (decouples feature-flags + site-features from the dead `mode-switcher`), and the Brian-gated `site-kit/*` intent call.
- **Cycle 55 — 2026-09-24 (Analytics: enrich CWV "affected pages" with per-page INP + CLS — was LCP-only):** The prompt
  wants CWV "affected pages" for LCP, INP, AND CLS; the slowest-pages drilldown was **LCP-only** (`SlowPageSchema =
  {path, lcpP75, samples}`), so an owner couldn't see WHICH pages have poor INP (responsiveness) or CLS (layout shift).
  **Worker:** `getWebVitalsSummary` now buckets INP + CLS per `path` too (alongside LCP) and each slowest-page row carries
  `inpP75` + `clsP75` — **present only when the page cleared the same 5-sample floor for that metric, else omitted
  (undefined, never a fabricated 0)** — honest. `SlowPageSchema` gained optional `inpP75`/`clsP75`. **Frontend:** the
  web-vitals-card slowest-pages table (header now "LCP / INP / CLS p75") shows each page's INP + CLS p75 with a rating
  colour + "—" when absent, keeping the LCP word-rating as the WCAG-safe primary. Verified: worker tsc 0 · **worker Jest
  68/68 visitor_events_core** (+1: per-page INP/CLS present + omitted-below-floor; had to drop `.withContext()` — Jasmine-
  only, forbidden in worker Jest) · fe tsc (app+spec) 0 · **Karma 2099/2099** (+1) · worker lint 0 errors · build 0 + 0
  NG8113. Deployed BOTH — the worker deploy **fully succeeded this time** (version `54a6e93f`, the CF `standard-1`
  container migration finally completed), frontend `main-3TO2ZYJ3.js` hash-matched + wv chunk `chunk-MIIHIN7D.js` 200 with
  the "LCP / INP / CLS" marker. **End-to-end data-verified:** the API returns real per-page CWV for the test site —
  `slowestPages[0]` keys `['path','lcpP75','clsP75','samples']` (clsP75 present, **inpP75 honestly omitted** — that page
  has <5 INP samples), tenant resolved server-side. **Next:** drilldown/filter (click a country/device to filter the
  dashboard — the biggest remaining feature, medium-large cross-stack); else analytics is at a deep coverage+honesty
  plateau (Security/WAF + latency percentiles plan-blocked).
- **Cycle 56 — 2026-09-24 (Angular: migrate the LAST risky directive `focus-trap` → signal input + effect):** Completes
  the wired-directive signal-input arc. `focus-trap` used a `set focusTrap(value: boolean|'')` SETTER that imperatively
  activates/deactivates a document keydown trap (WCAG 2.4.3 focus management for every admin modal/popover/cmd-palette).
  The risk was async timing (an `effect()` defers vs the setter's sync activation), but the inspection resolved it: the
  a11y spec sets the input via a `[focusTrap]="open()"` HOST BINDING + `fixture.detectChanges()` (which FLUSHES the
  effect → activates) + `await Promise.resolve()` (for `activate()`'s existing `queueMicrotask` focus deferral) — so the
  effect-driven activation lands before every Tab-dispatch/focus assertion. Migrated to `readonly focusTrap =
  input<boolean|''>()` + a `private effect()` replicating the setter's exact activate-once/deactivate-once logic (the
  `active` plain-field guard is untracked, so the effect re-runs only on `focusTrap()` change). Behavior-preserving:
  7 consumers bind `[focusTrap]="expr"` identically. Verified: fe tsc (app+spec) 0 · **Karma 2099/2099** (the 5
  focus-trap a11y tests — inactive / activate+focus / Tab-wrap fwd / Shift-Tab-wrap / deactivate+restore — all pass with
  the effect, comprehensively exercising both paths) · `ng build:prod` 0 err + 0 NG8113 · deployed R2 + prod-verified
  (`main-QYBIB7XQ.js` hash-matched, homepage 200 — focus-trap runs in the nav). Frontend-only. **Milestone: every WIRED
  directive is now signal-input migrated.** **Next:** lift `DisclosureMode` to a shared type file (decouples feature-flags
  + site-features from the dead `mode-switcher`), then the remaining decorator files are almost all the unwired
  `site-kit/*` library (Brian-gated intent call) + a few dashboard `widgets.ts` holdouts.
- **Cycle 57 — 2026-09-24 (Analytics: share-% on the device/browser/OS breakdown):** Confirmed the section's telemetry is
  present (the CF-GraphQL delivery fetch already `console.warn(JSON.stringify(...))`s failures at every catch) and the
  drilldown/filter is the only remaining feature — but it's medium-large (a tenant-safe filter must thread through
  `currentWindow`/`previousWindow`/`timePredicate` + ~10 breakdown fns since the filter applies to relative windows too,
  so it can't ride the optional `window` object), too large to land *safely* in a deep-session cycle → correctly deferred
  with that plan. Shipped a small complete win instead: the `TechBreakdownComponent` showed **counts only** (bar =
  relative-to-max), no SHARE — an owner couldn't see "mobile is 68% of visitors." Added a **share %** per row (`count ·
  N%`), computed client-side from the **FULL dimension total** (all rows, not just the displayed top-6) so the % is
  honest; `pct(count,total)` guards divide-by-zero → 0. Frontend-only. Verified: fe tsc (app+spec) 0 · **Karma 2101/2101**
  (+2: pct unit + renders-share-of-full-total) · `ng build:prod` 0 err + 0 NG8113 · deployed R2 + prod-verified
  (`main-E5CD72TJ.js` hash-matched, tech chunk `chunk-L62OLD5P.js` 200). **Next (biggest remaining feature):**
  drilldown/filter — extend `currentWindow`/`previousWindow` with an optional allowlisted `{dim,value}` predicate (dim a
  trusted literal, value bound), thread a tenant-safe filter param through the route + `getTrafficSummary` (force the live
  path when filtered) + comprehensive cross-tenant + allowlist-rejection tests, then clickable breakdown rows + a filter
  chip. Land the tenant-safe server core FIRST. Else analytics is at a deep coverage+honesty plateau.
- **Cycle 58 — 2026-09-24 (Angular: lift `DisclosureMode` to a shared type file — decouple the 2 LIVE consumers from the
  dead `mode-switcher`):** Executed the consolidation move the prior four cycles kept naming as "next". `feature-flags/
  mode-switcher.component.ts` is a DEAD component (`app-flag-mode-switcher` never rendered) that nonetheless EXPORTED the
  `DisclosureMode` type imported by `feature-flags` + `site-features` (both LIVE) — so two live control-plane layers
  depended on a dead component's file for a type. Created `feature-flags/disclosure-mode.ts` holding just
  `export type DisclosureMode = 'simple'|'advanced'|'expert';`; `mode-switcher` now IMPORTS the type (no longer exports
  it); both consumers AND the mode-switcher spec now import from the new file (the spec imported the type too — split its
  one `{ Component, type DisclosureMode }` import into value-from-component + type-from-new-file, caught by spec-tsc).
  Type-only relocation → identical emitted JS, zero runtime change. Decorator count UNCHANGED at **37** (mode-switcher
  keeps its `@Input`/`@Output` — this decouples the TYPE, not the decorators; the dead component + its preserved spec
  stay). Verified: fe tsc (app 0 · spec 0) · **Karma 2101/2101** · `ng build:prod` 0 err. Frontend-only; type-erased →
  the built bundle is byte-identical to live. **Next:** the Brian-gated `site-kit/*` intent call (25+ unwired components =
  most of the remaining 37 decorator files), or the analytics drilldown/filter tenant-safe server core (Cycle 57's
  deferred feature).
- **Cycle 59 — 2026-09-24 (parallel-agent fan-out: docs drift + Angular cohort shipped; Data KV/CSV in-flight):** Ran a
  5-agent read-only discovery swarm (Data UI / Data API / CF-clients / Angular / docs) then a 4-agent worktree
  implementation wave. Guard `guard-fat-agent.py` blocked `general-purpose` (fat tool surface dies in this MCP-heavy
  session) → re-issued as narrow `test-writer`/`code-simplifier`. **Landed:** (1) **docs drift** —
  AI_INTEGRATION/PROMPTS/SUBDOMAINS/generated-site-quality reconciled (model-routing cost table + quota-fallback note;
  Plane status PLANNED→CONFIG; TODO→timeline) (commit `0c68a14f7`); (2) **Angular signal-input cohort** — 4 WIRED
  spec-covered components (rolling-counter ~7 + before-after-slider ~6 `@Input`; agent-message + shortcuts-overlay
  `@Output`) decorator→signal, behavior-preserving, app-tsc + spec-tsc clean, Karma 2101/2101, deployed R2 + prod-verified
  (`main-QSZXZPTD.js` hash-matched, home 200) (commit `9e7118941`). **In-flight / failed:** the heavy Data vertical slices
  did NOT converge as background narrow agents (budget-starved mid-slice — see memory
  `heavy-vertical-slices-dont-converge-in-background-narrow-agents`). KV inspector worker files
  (handlers/schemas/manifest/test) were written + are preserved in worktree `agent-a23297e2e91bc743d` (backend wiring +
  frontend PENDING); the CSV-import agent produced 0 files (abandoned). **Next:** finish these FOREGROUND — (a) wire +
  flag + frontend the KV inspector from the salvaged worker files; (b) implement CSV/JSON row import directly (super-admin,
  schema-validated parameterized batch INSERT + dry-run). Verified Data reality: ONE shared multi-tenant D1 (no per-site
  DBs); 14/16 `data-section-capability-matrix.md` rows already DONE.
- **Cycle 60 — 2026-09-24 (Data: complete the KV Inspector vertical slice — frontend, FOREGROUND):** Finished the KV
  inspector (backend shipped cycle 59 / `4ad7d8794`). A salvaged background-agent frontend draft targeted a HALLUCINATED
  contract (`/super-admin/kv/*` with `{bindings}`/`{data.keys}` wrappers) that would NEVER work against the real backend —
  REWROTE it correctly against `/api/admin/kv/{namespaces,:binding/keys,:binding/value}` (`{namespaces:string[]}`,
  `{keys:[{name}],list_complete,cursor}`, `{value,metadata,truncated,ttl}`). Binding picker → prefix search →
  cursor-paginated key list → value+metadata+TTL panel; read-only, accessible, honest states + eventually-consistent note.
  Route `/admin/kv-inspector` behind sysAdminGuard; backend stays super-admin + `kv_inspector`-flag-dark (404). **`ng build`
  caught an NG8008 (EmptyStateComponent's required `title`) that app-tsc + spec-tsc + Karma ALL passed clean** → memory
  `ng-build-catches-template-errors-tsc-karma-miss`; the build-broken commit was fix-forwarded. Verified: app-tsc +
  spec-tsc clean · Karma **2113/2113** (+12 real-contract specs, incl. the read-only-`event.target` fix) · `ng build:prod`
  0 err · deployed R2 · prod-verified (home 200, `main-O7FWEV6A.js` hash-matched, KV chunk `chunk-QO2S2V6P.js` 200, backend
  404-dark). Commits `a00e1143e` + `78472c67c`. **KV Inspector = DONE (backend + frontend).** **Next (FOREGROUND per the
  thrice-confirmed lesson — NOT background agents):** CSV/JSON row import · analytics filter UI · the 4-component Angular
  signal-input batch (audit/site-copilot/deliverability/site-dna) — one coherent slice at a time.

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
- **Signal inputs/outputs: ⏳ in progress** — **33** decorator files remain (was 37 — cycle 59 migrated 4 wired components: rolling-counter, before-after-slider, agent-message, shortcuts-overlay); **all WIRED directives are now
  signal-input migrated** — `focus-trap` was the last. Migrating a coherent unit per
  cycle, preferring WIRED, spec-covered targets that IMPROVE the code over churn. ✅ done: `cmd-glyph` (cycle 17);
  `command-palette` (`@Output()`→`output()`, cycle 18); the `states/` family — `empty-state` + `error-card` (cycle 33);
  **`directives/auth-image-src` — `@Input()`+`ngOnChanges`+`ngOnDestroy` → `input()`+`effect(onCleanup)`, which also
  fixed a latent in-flight-fetch race (cycle 39)**; **`pages/admin/empty-state` — 5 `@Input`+2 `@Output` → `input()`/
  `output()` + `OnPush`, and dropped the grep-proven-dead `secondary`/`secondaryClick` button (no consumer ever passed
  it); render-neutral for all 10 consumers (cycle 46)**; **`dashboard/calendar-widget` — `@Input() set props` (a setter
  that conditionally seeds `cursor`/`selectedDayMs`/`view`) → `input()` + a faithful conditional-override `effect()`;
  render-neutral for its 1 consumer (`[props]="props()"` unchanged), cycle 48**; **`animations/ripple` (2 inputs) +
  `animations/reveal-on-scroll` (3 inputs) — plain-field `@Input()` → `input()`; behavior-preserving (event-time +
  ngOnInit reads), + added their previously-MISSING specs (net coverage gain), cycle 51**; **`directives/reveal` (the
  heavily-used `appReveal`, 6 plain-field inputs → `input()`; read in ngOnInit/`play()`, the module-global stagger counter
  UNTOUCHED; spec uses host bindings so it stayed valid + gained a custom-`revealMaxDelay` test, cycle 54)**;
  **`directives/focus-trap` — the LAST risky one: `set focusTrap(value)` setter → `input()` + `effect()` that
  activates/deactivates the keydown trap on toggle; the `active` guard preserves activate-once/deactivate-once, and
  `activate()`'s existing `queueMicrotask` deferral means the (already async-aware) 5-test a11y spec — `[focusTrap]` host
  binding + `detectChanges()` (flushes the effect) + `await` — stayed valid unchanged; cycle 56**. Newer components (`conversions-card`,
  `web-vitals-card`, `tech-breakdown`, `trend-badge`) already ship `input()`/`output()`. ⚠️ **`site-kit/*` (25+
  components, most of the remaining decorator files) is an UNWIRED library** — no importers/selectors/registry/build-
  includes (only 2 specs); migrating it is low-value churn, and it can't be deleted (actively maintained + tests-
  preserved). **Resolve its intent (unbuilt site-builder feature vs. orphan) before investing** — a Brian-gated call.
  `feature-flags/mode-switcher` — the COMPONENT (`FlagModeSwitcherComponent`, selector `app-flag-mode-switcher`) is
  **DEAD** (never rendered; only its exported `DisclosureMode` *type* is used, by feature-flags + site-features), BUT it
  **can't be deleted** — `mode-switcher.component.spec.ts` exists and the tests-preserved mandate pins it alive (deleting
  the component would orphan a preserved spec = compile break). Consolidation move **✅ done (cycle 58)**: `DisclosureMode`
  now lives in `feature-flags/disclosure-mode.ts`; the 2 live consumers + the mode-switcher spec all import from there, so
  NO live code depends on the dead component's file (it + its preserved spec stay, now import-free from consumers).
  `focus-trap`/`reveal` (imperative-setter / order-fragile reactivity) were the carefully-migrated ones → both done
  (cycles 56/54).
- **NG8113 dead-import sweep: ✅ (cycle 46)** — the Angular template compiler flagged 3 unused directive/component
  imports; all removed (compiler-proven dead, zero runtime change): `RouterLink` in `integrations` + `domain-picker`
  (kept `Router` the service in domain-picker), `CharCountComponent` in `settings` (kept its used `RouterLink`). `ng
  build` now emits 0 NG8113 warnings. Re-run this grep-of-the-build each cycle to keep it at 0.
- ⚠️ **DUPLICATE `EmptyStateComponent` (tracked drift, needs a design call):** TWO standalone components share the
  selector `app-empty-state` AND the class name `EmptyStateComponent` — `pages/admin/empty-state.component.ts` (10
  consumers; `body`/`primary` API; cyan-halo "pretty" style; now signal-based after cycle 46) and
  `components/states/empty-state.component.ts` (4 consumers: feature-flags/site-features/site-branches/webhooks;
  `message`/`ctaLabel` API; dashed-card style; signal-based since cycle 33). No runtime collision (standalone selector
  resolution is per-component-imports), but it's a real duplicate. Consolidation would change 10 admin sections' empty-
  state **visual style** (halo → dashed card) → a design decision, NOT a silent refactor. Rec: pick one canonical style +
  a superset API (1 CTA is enough — `secondary` is dead), then repoint + delete the loser in a dedicated visual-QA'd arc.
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
Migrate ONE coherent, **WIRED, spec-covered** `@Input()`/`@Output()` → `input()`/`output()` unit per
cycle (**43 decorator files remain**; auth-image-src done cycle 39). Prefer wired leaves that IMPROVE the
code over churn: `calendar-widget` (1 input), `pages/admin/empty-state`, `feature-flags/mode-switcher`.
**Do NOT migrate the unwired `site-kit/*` library** (~25 files, low-value churn) — first resolve its intent
(unbuilt site-builder feature vs. orphan; Brian-gated). `focus-trap`/`reveal` use imperative
setter/order-fragile reactivity → migrate carefully/last. Do NOT build analytics comparison deltas (already
live). Before creating any doc, grep for an existing one.
