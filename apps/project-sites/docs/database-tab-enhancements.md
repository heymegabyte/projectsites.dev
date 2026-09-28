# Editor › Database tab — 15 UI enhancements / additions (backlog)

> Curated 2026-09-28. Grounded in the REAL Database tab: `app/components/workbench/DatabasePanel.tsx`
> (sub-nav Tables · SQL · KV), `SiteTablesPanel.tsx` (per-site D1 grid), `SqlNavigator.tsx` + shared
> `DataGrid.tsx` (SQL results), `KvManager`, and the overlay panels (`SchemaBuilder`, `ImportPanel`,
> `AiSeedPanel`, `TimeTravelPanel`/History). Tiered by impact/effort. The running admin-visual +
> interconnectedness loops can pull from this; `#3` shipped this turn as the auto-integrate nod.

## A · Grid & Tables (`SiteTablesPanel`)
1. **Rowid inline editing (kill "no primary key = read-only")** — edit/delete ANY row via the `_rowid`
   endpoints already built server-side; the grid still gates edits on a PK. Makes every table editable.
   *HIGH · ~2h · SiteTablesPanel + PS_SITEDB bridge.*
2. **Schema / table browser rail** — a left rail listing every table with row-count + column-count + a
   type glyph; keyboard-navigable; replaces the flat list. Turns "tables" into a real schema browser.
   *HIGH · ~2h.*
3. **Cell quick-actions** — click-to-copy a cell (**SHIPPED this turn in `DataGrid`**), plus expand
   long/JSON values in a popover, "Set NULL", "Copy as JSON"; extend the same to `SiteTablesPanel`.
   *MED · ~1-2h.*
4. **Bulk edit + fill-down** — multi-select cells/rows → set value / clear / fill-down a column.
   *MED · ~2h.*
5. **Rich field-type config** — a column-header menu to set the field type (single-select with color
   chips, checkbox, date picker, rating, URL/email); `field-types.ts` exists — expose the config UI.
   *HIGH · ~3h.*

## B · SQL (`SqlNavigator` + `DataGrid`)
6. **Result → chart** — a "Chart" toggle on the results (bar/line/pie inferred from the columns); a
   `SELECT` becomes an instant visualization. AI-native + gorgeous. *HIGH · ~3h.*
7. **Saved queries + history rail** — a persistent collapsible rail (rename / pin / run) instead of the
   current dropdown; the data already exists in `data-panel-logic`. *MED · ~2h.*
8. **AI "explain this"** — one-click natural-language explanation of a table's schema OR a query + its
   `EXPLAIN` plan (reuses the existing EXPLAIN + Ask-AI). *MED · ~2h.*

## C · New surfaces
9. **ERD / relationships diagram** — a visual graph of tables + foreign-key / linked-record relations;
   a new Database sub-view. The data-platform scope wants linked records. *HIGH · ~4-6h.*
10. **Global data search (⌘K within Database)** — search across every table's DATA + schema; jump to the
    matching row/table. *HIGH · ~3h.*
11. **Airtable-class views (Gallery / Kanban / Calendar)** — saved views per table (e.g. Kanban grouped
    by a select column); the scope names these. Start with Gallery + Kanban. *HIGH · ~6h+.*
12. **Data-profile / insights strip** — per-table auto-profile: null-rate per column, distinct counts,
    min/max, detected types, duplicate-row detector — a lightweight "know your data" panel. *MED · ~3h.*

## D · Trust & polish
13. **KV manager — never a dead paywall** — the KV sub-view dead-ends behind a $10/mo gate with no
    backend; give it a read-only free preview + a live upsell (per the "never a doomed control" bar).
    *MED · ~2h.*
14. **Save / activity affordance** — a subtle "saved ✓ / saving…" indicator + a per-table recent-changes
    log tied to the undo system, so edits feel safe + auditable. *MED · ~2h.*
15. **Empty-state launchpad** — the blank per-site DB → a guided first-run: "Describe your data (AI) ·
    Import CSV · New table · Load sample" as prominent cards with previews (embarrassingly-easy). *HIGH · ~2h.*

## Priority order (recommended build sequence)
1 (rowid editing) → 15 (empty launchpad) → 2 (schema rail) → 6 (result chart) → 10 (⌘K search) →
5 (field types) → 12 (data profile) → 9 (ERD) → 11 (views) → 7 (query rail) → 8 (AI explain) →
4 (bulk edit) → 13 (KV) → 14 (activity) → 3 (cell actions — partly shipped).

## Shipped
- **#3 cell click-to-copy** in `DataGrid.tsx` (SQL results grid): click / Enter / Space copies the cell's
  raw value, shows a transient "Copied" tick, keyboard-accessible + focus-ringed. 2026-09-28.
- **Actions dropdown** — the DatabasePanel `TablesToolbar` row + the SiteTablesPanel Header's "Seed with AI" +
  refresh buttons are replaced by ONE "Actions" dropdown (New Table · Import · History · Refresh) in the
  Tables header. `SiteTablesPanel` Header + `onHistory` prop. 2026-09-28.
- **History = "Create snapshot"** — relabeled Save point → "Create snapshot" (captures the live D1 bookmark),
  copy now explains D1 auto-protects hourly for 30 days + hour-granularity restore. `TimeTravelPanel`. 2026-09-28.

## Brian requests 2026-09-28 (this batch)
- ✅ **History: manual snapshot + auto + 30-day hour restore** — shipped (Create snapshot captures the real
  bookmark; datetime picker already does hour-granularity restore across the 30-day window; auto is inherent to
  D1 Time Travel + now explained).
- ✅ **Actions dropdown (New Table + History)** — shipped; removed the actions row + Seed/refresh buttons.
- ✅ **Remove "Seed with AI" from the Tables toolbar** — shipped.
- ✅ **ADVANCED cross-table content SEARCH — SHIPPED 2026-09-28.** Worker `POST /api/sites/:id/db/search`
  (table-name + text-column content scan, wildcard-escaped LIKE, bounded, returns `{nameMatches, contentMatches:[{table,column,rowid,snippet}], truncated}`; API-verified: `cus`→[customers], `acme`→content hits in
  customers.name + orders.note). `PS_SITEDB_SEARCH` bridge (editor `requestDbSearch` + Angular handler). Frontend:
  `TableListView` "Use AI"/"Create Table" removed → expanding search pill → stylized results ("Tables" name matches
  + a distinct "In content" group with `<mark>`-highlighted snippets). FOLLOW-UP (loop): AI-ranking of results;
  scroll-to-row on open; dedupe the `sitedb-search` test-id vs BrowseView's row filter.
- ⏳ **10 progressive gorgeous+functional revisions of the Database section** — the DB loop (`72a83e2c`, every
  15m) performs these iteratively; each fire = one measurable visual+functional upgrade, verified live + deployed.
