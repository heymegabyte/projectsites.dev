# Editor features — scan + recommendations

Scope: bolt.diy editor (`app/`) embedded at `editor.projectsites.dev` inside the Angular admin. Top-tab strip = **Code | Preview | Database | Resources** (`Workbench.client.tsx` `TOP_TABS`; +leftmost **Chat** tab <1024px). `Functions`/`Git`/`Data` tabs retired → fold to Code/Database. Bottom panel = **Terminal only** (Problems/Logs removed, `extensions/BottomPanelTabs.tsx`). Read-only scan — no source modified.

## Panels/tabs inventory (surface — what it does — top recs)

### Top tabs
- **Code** (`EditorPanel.tsx`) — CodeMirror editor + left rail switching FileTree/Search/Locks/Source Control, with `ProjectHub` command center pinned on top. Recs: [HIGH] add a Cmd+P fuzzy file-opener + Cmd+K command palette (only per-panel controls today); [HIGH] AI inline edit (select code → "edit with AI") + AI hover-explain; [MED] breadcrumb symbol outline; [MED] multi-file tabs (single-file editor now).
- **Preview** (`Preview.tsx`, 51K) — live WebContainer iframe, real public-URL address bar (read-only host + editable path), PortDropdown, ScreenshotSelector, Inspector (click element), Expo QR. Device-frame mode is dead-code (`isDeviceModeOn=false`), fullscreen/new-window removed. Recs: [HIGH] restore responsive breakpoint switcher (device list exists but unrendered — orphaned); [HIGH] Inspector → "edit this element with AI" round-trip to chat; [MED] console/network mirror from iframe; [MED] one-click share preview link.
- **Database** (`DatabasePanel.tsx`) — per-site D1 segmented sub-nav **Tables · SQL · KV**; Tables actions (Import/History/Schema/AI-seed) open as modals. Recs: [HIGH] surface row-count/last-modified per table on the Tables list (Airtable feel); [MED] saved-view filters + column pinning; [MED] KV upsell card → inline "what KV unlocks" preview.
  - **Tables** (`SiteTablesPanel.tsx`, 183K ⚠️huge — split candidate) — read/edit grid over site's OWN D1 via `PS_SITEDB_*`. `DataGrid.tsx` + `CellEditor.tsx` + typed `TypedValueField`. Recs: [HIGH] AI "add column from description"; [MED] inline chart-from-table; [MED] optimistic edits + undo toast.
  - **SQL** (`SqlNavigator.tsx`, 53K) — rich per-site SQL: highlighted `SqlEditor`, schema autocomplete (real cols only), localStorage history + saved queries, `EXPLAIN QUERY PLAN` cost hint, **Ask-AI** grounded NL→SQL (review before run, never auto-run). Recs: [HIGH] add CSV/JSON export of result grid; [MED] query-result → save as view/table; [MED] multi-statement tabs.
  - **KV** (`KvBrowser.tsx`, 36K) — per-site KV browser ($10/mo add-on; honest locked-upsell until unlocked). Recs: [MED] TTL badges + bulk delete; [MED] JSON value pretty-editor.
  - **Import / History / Schema / AI-seed** (`ImportPanel` CSV/JSON→D1, `TimeTravelPanel` D1 time-travel, `SchemaBuilder` guided DDL, `AiSeedPanel` AI sample rows) — all confirm-gated, per-site rail. Recs: [MED] Import: AI column-mapping suggestions; [MED] History: visual diff between restore points.
- **Resources** (`ResourcesPanel.tsx`, 54K) — per-site asset overview: **Media library | Site files | Buckets** + "Advanced" → `ResourceOverviewPanel`→`ResourceDetailPanel` (75K) CF-primitive console; `BucketsPanel` (70K) R2 manager. Recs: [HIGH] media grid → drag-drop upload + AI alt-text; [MED] image transform presets (Cloudinary feel); [MED] per-resource "what uses this" links.

### Bottom panel
- **Terminal** (`terminal/Terminal.tsx` + `TerminalManager`) — xterm.js, multi-terminal, lazy-loaded. Recs: [MED] AI "explain this error" on terminal output; [MED] command palette of common tasks.

### Chat (docked left desktop / tab on mobile)
- **Chat** (`Chat.client.tsx` 46K, `BaseChat.tsx` 29K) — AI build/edit: streaming, model selector, prompt-enhancer (`usePromptEnhancer`), voice (`SpeechRecognition` + `voice-vision.describeImage`), image upload, MCP tools (`MCPTools.tsx`), web search, `PromptSuggestions`, `ToolInvocations`, artifact/file-diff badges. Recs: [HIGH] make chat site-context-aware by default (auto-inject current file/selection/route); [HIGH] surface build/deploy progress inline (currently `SiteImportStatus` only on import); [MED] slash-commands (`/deploy`, `/seed`, `/add-page`); [MED] cost badge always visible.

### Code-view command center
- **ProjectHub** (`ProjectHub.tsx`) — Deploy-to-prod (`PS_DEPLOY_REQUEST` bridge), client-side snapshots (create/restore/delete + Undo), git info (R2 build history + GitHub link). Recs: [HIGH] live deploy status + prod URL after deploy (fire-and-forget today); [MED] one-click rollback to prior snapshot from a timeline; [MED] "publish changes" primary CTA that bundles save+deploy+verify.
- **Source Control** (`SourceControlPanel.tsx` 42K) — preview diff + releases. **Locks** (`LockManager.tsx`) — file locking. **Search** (`Search.tsx`) — project-wide search. Recs: [MED] Search → replace-across-files; [MED] Locks: show who/why inline.

## New editor features to add [prioritized]
1. [HIGH] **Command palette (Cmd+K) + fuzzy file open (Cmd+P)** — one entry to every action/file/route; the single biggest "embarrassingly-easy" + keyboard win, currently absent.
2. [HIGH] **AI inline code edit + explain** — select→edit / hover→explain in CodeMirror; today AI lives only in the chat column. Highest AI-native leverage.
3. [HIGH] **Restore Preview responsive/device switcher** — device list already coded but `isDeviceModeOn=false` (orphaned); wire it back + add 6-breakpoint quick toggle.
4. [HIGH] **Inspector → AI round-trip** — click element in Preview → "change this" prefers a chat/inline patch instead of just reporting `ElementInfo`.
5. [HIGH] **Live build/deploy progress + prod-verify surface** — a persistent status rail (extend `SiteImportStatus`/`PS_GENERATION_STATUS`) so deploy isn't fire-and-forget; show final URL + health.
6. [MED] **Result-grid + table export** (CSV/JSON) across SQL results and Tables — no export path today.
7. [MED] **Media drag-drop upload + AI alt-text** in Resources media library.
8. [MED] **Slash-commands in chat** (`/add-page`, `/deploy`, `/seed`, `/seo`) mapping to bridge actions.
9. [MED] **Env/secrets manager surface** (`EnvAssignmentGrid` exists) promoted to a first-class per-site view.
10. [MED] **AI schema/migration assistant** — describe a data model → SchemaBuilder DDL preview (extends AiSeedPanel pattern).

## Cross-cutting editor recs (bridge, brand override, boot UX, keyboard)
- [HIGH] **Kill manual Refresh/Reconcile buttons** — `Refresh`/`refresh` still present in `BucketsPanel`, `DatabasePanel`, `NamespaceSummary`, `ImportPanel`, `LockManager`, `ProjectHub`, `EnvAssignmentGrid`, `GitPanel`. Violates `real-time-data-no-manual-refresh`; replace with visibility-aware poll / bridge push (`PS_*` events).
- [HIGH] **Boot UX**: `EditorLoadingScreen` + `editor-boot.ts` gate on `editorFilesReady` (30s safety cap). Recs: show real per-step progress (boot→install→dev-server→files) not a generic spinner; brand-locked cinematic loader from frame 1 (no FOUC).
- [HIGH] **Keyboard coverage** — segmented sub-navs have roving-tabindex, but no global shortcuts (save/deploy/switch-tab/open-file). Add a keymap + a "?" cheatsheet overlay.
- [MED] **Bridge** (`app/lib/embed/embedded-mode.ts`, 93K ⚠️huge) — rich `PS_*` protocol (submit/import/files/deploy/data/SQL/NL2SQL/Ask/telemetry/toast). Rec: split by domain (data vs deploy vs chat) for maintainability; document the full message table in a doc.
- [MED] **Blanket brand override** for the embedded editor is required (per memory) — verify `--bolt-elements-*` tokens map to `--ps-*` (`#060610`/`#00e5ff`) inside the iframe so the editor matches admin.
- [MED] **Split oversized components** — `SiteTablesPanel` (183K), `ResourceDetailPanel` (75K), `BucketsPanel` (70K), `SqlNavigator`/`ResourcesPanel` (53–54K) are review/perf hazards; extract logic (pattern already used: `*-logic.ts` siblings) + lazy-load.
- [MED] **Interconnectedness** — `FormBuilder.tsx` (21K) kept importable but is NOT a nav entry (deliberate, per DatabasePanel comment); confirm it's reachable or archive. Preview device-frame markup is orphaned dead-code — wire or remove.
- [MED] **Layout skill is stale** — `.claude/skills/projectsites-editor-layout` still documents the old 4-tab `Code|Preview|Functions|Data`; reality is `Code|Preview|Database|Resources`. Update the skill same-fire (drift).
