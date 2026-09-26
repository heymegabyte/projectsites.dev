# Data Platform — Scope & Roadmap (North Star)

> **This is the authoritative scope for the "Data" section re-architecture.** The recurring Data
> loop executes against THIS doc, top-down. Captured from a design session with Brian (2026-09-25,
> 7 question rounds / 27 decisions). Supersedes the incremental `data-section-capability-matrix.md`
> as the PLAN of record for the re-arch; the matrix keeps tracking SHIPPED increments.

## North star (one line)

**The ultimate Cloudflare D1 data-management tool with Airtable-class features (per-site), plus an
auxiliary KV manager — spreadsheet-first, AI-native, SQL completely hidden.** Not a site CMS; a
generic, brilliant data platform each site owns.

## Locked decisions (2026-09-25 design session)

### Architecture & provisioning
- **Per-site resources.** Every site is provisioned with its OWN D1 + KV + R2 under its namespace
  (Workers for Platforms) — NOT today's shared-D1-with-`site_id`.
- **One D1 per site, MANY tables** (grouped into folders for organization). No multi-base layer.
- **Provision on create, IN PARALLEL** with the other site-provisioning tasks (D1 must be one of them).
- **All platform-generated tenant data migrates into the site's own D1** — `form_submissions` (leads)
  + `visitor_events` (analytics) become first-class, owner-editable tables. Ingestion re-points to
  write per-site.
- **Scale = hard D1 limit (~10 GB) + upgrade prompt.** The Neon escape hatch stays MODELLED
  (`db_allocation.ts`) but DORMANT — do not auto-escalate for now.
- **Reuse existing scaffolding:** `src/services/db_allocation.ts` (`chooseDbAllocation` → `d1_tenant_db`),
  `src/services/site_capability_manifest.ts` (per-site db plan), migrations `0572_tenant_db_assignments`
  + `0573_site_database_allocations` (allocation tables + `status` state machine: active | provisioning |
  migrating | retired), and the `upstash_provisioner.ts` pattern for the new D1 provisioner.

### Rollout — greenfield reset (⚠️ GATED destructive step, Phase 0)
- **Remove ALL existing sites + all traces → clean slate.** No migration of old tenant data.
- ⚠️ **BLAST-RADIUS CAVEAT (must be precisely scoped + confirmed before ANY delete):** the shared prod D1
  has **hundreds of tables**, most of which are PLATFORM tables (users, orgs, billing/subscriptions,
  feature_flags, affiliates, agencies, api_tokens, audit_logs, wallets…) — NOT per-site data. "All traces
  of sites" must be defined as **the site-scoped rows/resources ONLY** (site_id-scoped D1 rows across the
  tenant tables + each site's R2 objects + KV keys + deployed WfP worker + hostnames/DNS), and must
  **preserve** the platform tables (auth/billing/flags/agencies) — else the reset wipes the whole product.
  Requires: (1) a full D1 export backup + R2/KV inventory (reversible), (2) an explicit enumerated
  delete-list, (3) a final human "execute" confirm. **Never run from a loop re-prompt.**
- **`brian@megabyte.space`** = the test account + **admin privileges** + **payment bypass** (test paid
  features without paying). This part is non-destructive (auth/entitlement config).
- New sites → per-site D1 (+KV+R2) provisioned in parallel on create.
- ⚠️ "Remove all sites" is destructive/prod: execute **deliberately** — take a backup, confirm the exact
  blast radius, keep it reversible, behind a one-time gated action. First thing in Phase 0. **Never run blind.**

### Plan gating
- **Paid = own DB + full Airtable-class platform.** Free = shared / read-only / limited. (Matches
  `db_allocation` paid → `d1_tenant_db`.)

### Editing UX
- **Spreadsheet-first, FULL parity:** inline typed cell editors, keyboard nav (arrows/Tab/Enter), range
  select + copy/paste to & from Sheets, AutoFill drag, frozen header + pinned columns, column
  resize/reorder/hide, virtualization past ~1k rows, state persistence (column order/width/filters/views).
- **Immediate save + undo** (optimistic; NOT staged-commit).
- **Single-editor + audit log** — no real-time multi-user (no live cursors/presence/comments).

### Field types (Airtable-class)
- Single/multi-select with color chips · file **attachments (→ the site's own R2)** · **full linked records**
  (bidirectional links, lookup + rollup across links, many-to-many via junction, referential display —
  show the linked row's title, not a raw id) · formulas · ratings · dates with formatting · + typed
  primitives (text / number / boolean / date / JSON / NULL).
- **Validation = the field TYPES carry it.** No separate rule layer, no AI data-cleaning.

### Schema builder
- **Full builder:** create tables, add/rename/retype columns, define relations — guided DDL + DDL
  preview + validation + impact summary + explicit confirm + safe **migration plans** (rebuild when
  ALTER can't do it).

### AI copilot (SQL fully hidden from the user)
- **Full copilot:** NL query (read) + NL edits ("archive all spam leads") + AI insights / anomaly
  detection + AI-generated formulas & columns + conversational chat over the data + AI data-cleaning/dedup.
- **AI-first onboarding:** "what do you want to track?" → AI generates the tables/fields/sample rows.
  Templates as fallback.
- **AI-made changes apply IMMEDIATELY + undo** (matching the immediate-save model) — NOT preview-confirm.
  The undo (and the audit log + row history) is the safety net for a wrong NL interpretation.
- The raw SQL console is **retired from the owner UI**; the existing `nl2sql` powers NL→query under the hood.

### Mobile
- **Full responsive touch grid — first-class editing on phones/tablets**, not desktop-only. The spreadsheet,
  inline editors, and core flows work on touch (owners updating data on the go).

### Views, forms, automations, API — CF-native
- **View types:** Grid (default) + Kanban (group-by column) + Calendar (date column) + Gallery (cards) +
  **public Form** (owner builds it → embeds on their site → submissions land as rows in their D1).
- **Automations:** row triggers → email / webhook.
- **Auto REST API** per table (secured, per-table keys + scopes) + shareable read-only view links / embeds.
- **Integration/ecosystem layer designed around Cloudflare + Workers-for-Platforms primitives**
  (dispatch workers, Queues, etc.) — CF-first; pick native integrations that fit CF/WfP.

### Import / export / sync
- **Full:** mapped CSV / Excel / JSON import (header/type mapping, NULL handling, conflict behavior,
  validation, progress, resumable chunks) + **2-way Google Sheets sync** + external API/DB sync
  (scheduled) + pre-built **table templates** (CRM / inventory / events / content calendar) + export /
  portability.

### Backup & recovery
- **Full:** per-site D1 **Time-Travel** (point-in-time) + owner-triggered **snapshots** + **one-click
  restore** + full **per-row change history** (undo across sessions). Confirm + identify exact DB before
  any restore; log the outcome.

### Findability
- **Global search** across every table/row in the base + a **Cmd+K command palette** (jump to any
  table/view/record + run actions: create table, import, ask AI).

### KV (auxiliary)
- **KV editor:** key/value grid, TTL, JSON values, bounded bulk ops, eventual-consistency disclosed.
  The site's own KV namespace.

### R2 / Files — via the EDITOR, not a Data tab
- R2 is **not** a Data-section tab. Instead **wire the editor's existing Files/Code panel to the site's R2**
  — the files shown + edited in the code editor ARE the R2 objects. **Load as fast as possible.** (The
  attachment field type writes to the same R2.)

### Explicitly OUT of the Data section
- Vectorize · Queues · R2-as-a-Data-tab (R2 lives in the editor Files panel instead) · real-time
  multi-user · field-level encryption (permission controls instead) · a separate notification system ·
  multi-base per site · auto-Neon-escalation (modelled but dormant).

## Phased roadmap (the loop ships one verified increment per fire, top-down)

**Phase 0 — Foundation & greenfield reset (gated)**
- 0a. ⚠️ Greenfield reset: remove all sites + traces (backup + confirm + reversible).
- 0b. `brian@megabyte.space` → admin + payment bypass + test account.
- 0c. **Per-site provisioning service** — on site-create, provision D1 (+ KV + R2) IN PARALLEL; record in
  `site_database_allocations`; bind to the site's WfP dispatch worker. Feature-flagged, dark by default.
  - **✅ 0c.1 DONE (2026-09-25):** the **D1 provisioner** — migration `0633` adds `d1_database_id`/`d1_database_name`
    to `site_database_allocations`; `src/services/d1_provisioner.ts` `provisionSiteD1()` creates a dedicated
    D1 via CF REST (`POST /accounts/{CF_ACCOUNT_ID}/d1/database`), server-side creds (`resolveCfCredentials`),
    idempotent (reuse existing active allocation — never a duplicate on retry), honest typed failures
    (no-creds / cf-fail) that record NOTHING. +5 Jest (real-SQLite + mocked CF → zero real resources). INERT
    until 0c.2.
  - **✅ 0c.3 DONE (2026-09-25, multi-agent fan-out):** the **KV + R2 provisioners** — migration `0634` adds
    `kv_namespace_id`/`kv_namespace_name`/`r2_bucket_name`; `src/services/kv_provisioner.ts` `provisionSiteKv()`
    (`POST …/storage/kv/namespaces`) + `src/services/r2_provisioner.ts` `provisionSiteR2()` (`POST …/r2/buckets`,
    bucket names lowercase ≤63). Same safety/idempotency/honest-failure contract as D1. +10 Jest (real-SQLite +
    mocked CF).
  - **✅ 0c.2 DONE (2026-09-25):** the three provisioners are now **wired live but DARK**. New `per_site_data`
    feature flag (registry + docs, `default_enabled:false, rollout:0, stage:'experimental'`); `createSite()`
    calls `provisionSiteD1/Kv/R2` **IN PARALLEL (`Promise.all`)** from a `waitUntil`'d, flag-gated, fail-soft
    block (mirrors the `github_repo_sync` pattern) — so a CF/provisioning hiccup NEVER blocks site creation and
    NO real Cloudflare resource is created until the flag is promoted. +5 Jest (flag ON→all three called with
    `{orgId,siteId,tenantId}` · flag OFF→none · no-execCtx→none · provisioner-throw→creation still returns ·
    anon create→`orgId:null`). Full worker suite 792/12706 green, tsc 0, eslint 0-err.
- 0d. **NEXT** — Re-point ingestion (`form_submissions`, `visitor_events`) to write to the site's own D1.

> **Multi-agent fan-out (2026-09-25)** also landed the PURE FOUNDATIONS for later phases (built by parallel
> agents, folded + verified foreground): **Phase 2** `app/components/workbench/field-types.ts` (Airtable field-type
> registry — 10 kinds, coerce/format, +63 Vitest) + `schema-ddl.ts` (pure DDL generators for create/alter table+
> column+index, identifier-safe, +32 Vitest); **Phase 4** `view-models.ts` (Kanban `groupRowsByColumn` / Calendar
> `bucketRowsByDate` / Gallery `galleryPages`, +22 Vitest). All pure + tested + INERT (wired when those phases' UI ships).

**Phase 1 — Spreadsheet core** (over per-site D1)
- Resource-aware Data shell: **Platform DB (read-only, super-admin)** · **My Site's Data (read/edit)** · **KV**.
  Remove the Vectorize/Queues/R2 tabs.
- Full-parity grid: typed inline editors · keyboard nav · immediate-save + undo · frozen header ·
  filter/sort chips · virtualization · CSV in/out · state persistence.

**Phase 2 — Schema builder + rich fields**
- Full builder (tables/columns/relations, guided DDL + migration plans).
- Rich field types (select, attachments→R2, linked records + lookup/rollup, formulas).

**Phase 3 — AI copilot (SQL hidden)**
- NL query + NL edits + insights + formula-gen + conversational chat + data-cleaning. AI-first onboarding.

**Phase 4 — Views · forms · automations · API**
- Kanban / Calendar / Gallery / public Form; automations (row → email/webhook); auto REST API +
  shareable links; CF-native integrations.

**Phase 5 — Backup · search · governance · import/sync**
- Time-Travel + snapshots + restore + row history; global search + Cmd+K; field + row permissions +
  roles (owner/editor/viewer) + PII masking; full import + 2-way Sheets sync + templates.

**Phase 6 — KV auxiliary + R2-in-editor-Files**
- KV editor; wire the editor Files panel to the site's R2 (fast-loading).

## Reuse / de-risk (do NOT throw the existing engine away)
- **Port, don't rebuild:** the mature `app/components/workbench/d1-browser-logic.ts` (schema parse, FK,
  ERD, insights) + `data-panel-logic.ts` (CRUD builders, `buildCsvImportPlan`, `analyzeRowLimit`, charts,
  `explainPlanHint`) + `nl2sql` become the ENGINE under the new spreadsheet UI.
- **Provisioning** follows `upstash_provisioner.ts`; reuses `db_allocation.ts` + `site_capability_manifest.ts`
  + migrations 0572/0573.
- Every phase behind a feature flag (`enabled=0, rollout=0, stage='experimental'`) per `rules/feature-flags`.

## Supersession
- This doc is the north star. `data-section-capability-matrix.md` keeps tracking shipped increments; new
  work is PLANNED here and reflected there as it lands. When in doubt, this doc wins on direction.

## Combined spec + loop (2026-09-26)
Brian merged the two Data loops into ONE 12-min loop (`347f0e04`) carrying the full "best-possible Data tab"
spec (Airtable record editing × DB-Browser/Beekeeper/DBeaver SQLite tooling × an AI assistant that helps at
every step; D1 = source of truth for schema+records, KV = keys+values). Delivery order (complete slices,
in order): (1) authorized resource discovery + binding reconciliation + empty state + resource creation;
(2) real D1 schema explorer + fast read-only paginated grid; (3) safe single-row + bulk editing + clipboard
+ filters + saved grid views; (4) SQL workspace + schema/migration workflow; (5) grounded "Ask your data"
(typed intent → deterministic parameterized SQL → visible SQL + evidence + eval fixtures); (6) import/export/
recovery + rich non-grid views; (7) KV browser/editor; (8) AI fields + copilots + budgets + optional
semantic search. Governance throughout: one server-side authz check per read/mutation/export/AI-tool-call;
never trust a client D1 id/namespace/binding as authz; parameterized values + quoted schema-validated
identifiers; CF + model creds server-side; AI via CF AI Gateway (current endpoints, not the deprecated
Universal Endpoint), task-aware model routing, per-tenant budget ledger; treat customer data/results/imports
as UNTRUSTED (test cross-tenant + prompt injection).

### Current-state audit (2026-09-26, two read-only scans — what EXISTS today)
- **Editor UI (`app/components/workbench/`):** `DataPanel.tsx` (3316 lines) + `D1Browser.tsx` (read-only
  resource inspector: db list / overview / schema / async SQL-dump export / AI explain / column profile,
  super-admin `PS_D1_REQUEST` → `/api/admin/d1/*`) + `KvBrowser.tsx`. Row CRUD lives in DataPanel's Tables
  tab via `PS_DATA_REQUEST`→`/api/sites/:id/data-overview` + `PS_SQL_REQUEST`→`/api/sites/:id/sql/{exec,
  exec-write,nl2sql,schema,migrations}`. Cell editors: text/number/boolean/null/json only (NO date/select/
  url/email/BLOB). No schema-builder (CREATE/ALTER) UI. **No mock buttons found** — all wired to real APIs.
- **Worker API:** D1 Manager (`libs/features/d1_manager/handlers.ts`) super-admin-gated (404 on fail, account
  from `env.CF_ACCOUNT_ID`, creds via `resolveCfCredentials` — never client). Site data (`libs/features/
  site_data_api` + `src/routes/site_detail_tabs.ts`): `ownsSiteData(db,siteId,orgId)` IDOR guard (org-scoped,
  404 on mismatch), parameterized `.bind()`, identifiers validated `SAFE_IDENT` before PRAGMA interpolation,
  SQL read-allowlist `^(SELECT|EXPLAIN|WITH|PRAGMA)` + write path with PROTECTED_TABLES denylist + destructive
  confirm. KV inspector: server allowlist `['CACHE_KV','PROMPT_STORE']`, super-admin, cursor pagination.
- **Inert tested foundations** (wire as their slice ships): `field-types.ts` (10 Airtable kinds), `schema-ddl.ts`
  (create/alter DDL generators), `view-models.ts` (Kanban/Calendar/Gallery). Per-site D1/KV/R2 provisioners
  (`d1_provisioner.ts` etc.) wired DARK behind `per_site_data` (Phase 0c) — no per-site resources in prod yet.
- **Grid decision (OPEN):** the spec wants RevoGrid Core vs Tabulator evaluated against a real paginated D1
  dev DB (license-checked, no Enterprise-only features). NOT yet done — the current grid is a hand-rolled
  `<table>` in DataPanel. **Next grid fire must run that eval + record the license boundary here BEFORE adopting.**

### ✅ Shipped this fire (2026-09-26) — honest URL/email cell presentation (slice 3, "typed presentation")
`classifyCell` (`data-cell-format.ts`, the pure grid chokepoint) gained `url` + `email` kinds: a whole-string
`http(s)` URL or single email becomes a SAFE clickable link (`href` = the URL / `mailto:<addr>`). XSS-guarded —
only http(s)/mailto are ever emitted; `javascript:`/`data:`/`vbscript:`/`ftp:`/`file:` never match → stay plain
text with no href. Anchored regexes (whole-string only) so prose that merely contains a URL/@ stays text; URL
checked before email so a userinfo URL isn't mis-read. DataPanel grid renders `href` cells as
`<a target=_blank rel="noopener noreferrer nofollow" onClick=stopPropagation>` (never triggers a parent
row/cell handler), else a plain span. HONEST: SQLite stores text; this is a UI interpretation (link affordance),
not a schema-enforced type. +10 Vitest (url/http/email/userinfo-url/XSS-guards ×3/false-positive-guards ×2/
regression). Verified: Vitest 77/77 (data-cell-format) + 369/369 (6 workbench specs), editor tsc 0, eslint 0,
`npm run build` ✓ (client 16.9s + server). Editor auto-deploys via CF Pages on push.
**NEXT slice (per delivery order): the grid eval (RevoGrid Core vs Tabulator against a real paginated D1) + a
server-side keyset-paginated read-only grid path** — the foundation for slices 3-4; record the license boundary
here before adopting. Cheaper adjacent win if grid eval is deferred: wire `field-types.ts` typed EDITORS
(date/select/url) into the row-edit path.
