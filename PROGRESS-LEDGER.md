# PROGRESS LEDGER

## 2026-09-27 — Gated per-site GREENFIELD RESET re-applied on the FIRE-7 tip (FIRE 8)

**Re-applied Fire 8 correctly** — the original Fire 8 was built on a stale base (`f8e4170c6`) that
still had the deleted `DataPanel.tsx` and pre-dated Fire 7's bridge; its logic was reused via
`git show` but re-pointed + made additive on the current tip.

**What shipped:**

- **Worker** (`libs/features/data_resource_registry/`): `reset_handlers.ts` (`dataResourceReset` Hono
  app — `POST /api/sites/:siteId/data/reset[/preview]`) + `site_resources.ts` (`resolveSiteResources`
  + `FORBIDDEN_DB_IDS` denylist + `isForbiddenDbId`). Mounted in `src/index.ts` BEFORE `siteDataApi`
  so `/data/reset[/preview]` wins over `/data/:table`. → **Docker worker-deploy** (per-site D1/KV/R2
  wipe via CF REST; not deployed this fire per instruction).
- **Editor**: `GreenfieldReset.tsx` + `DangerZone.tsx` + pure `greenfield-reset-logic.ts` (+ spec).
  **DangerZone mounts in `DatabasePanel.tsx`** (Table-view footer, collapsed-by-default) — NOT the
  deleted `DataPanel.tsx`. Uses the sibling panels' `postToParent` import.
- **Bridge (ADDITIVE)**: `PS_RESET_REQUEST`/`PS_RESET_RESPONSE` added to `embedded-mode.ts` +
  `bolt-embed.service.ts` WITHOUT touching Fire 7's `PS_CODE_*` / `PS_RES_*` (all coexist).
- **Manifest**: extended the EXISTING `feature.manifest.ts` (Resource Registry, flag
  `data_resource_platform`) additively — added the reset `apiRoutes` + `reset_handlers.test.ts` +
  `reset_handlers.ts` schema, NOT a clobbering thinner manifest. Reset gates on its OWN flag
  `per_site_data` (shared with the Tables surface).

**Safety chain (all worker-enforced, none client-trusted):** flag `per_site_data` off→404 →
`assertSiteOwned` foreign→404 → server-resolved per-site ids only, shared platform D1 **denylisted →
409 FORBIDDEN_TARGET with ZERO CF calls** → backup-first (Time-Travel bookmark before any delete;
failed backup → 424 BACKUP_FAILED, no DROP) → preview → type-to-confirm re-checked at worker (409 on
mismatch).

**Pre-existing drift fixed in-turn (was masking these gates; base tip `b12870803` did NOT typecheck):**

- `Workbench.client.tsx` imported the deleted `./DataPanel` + used un-imported `DatabasePanel` /
  `ResourceOverviewPanel`; `WorkbenchViewType` lacked `'database'`/`'resources'` — FIRE 1 mid-refactor
  drift. Fixed: import `DatabasePanel` + `ResourceOverviewPanel`, add the two union members.
- `editor.component.ts:53` had backticks inside a CSS comment in a `styles:` template literal
  (`` `animation: edFade` ``) → `tsc` `',' expected` (the god-tier-engineering Angular-comment-backtick
  class). Fixed to plain quotes. This syntax error had been ABORTING Angular `tsc` early, masking →
- `bolt-embed.service.ts` `PS_RES_*` handlers (FIRE 7) referenced `msg.environment` / `resourceKind` /
  `detailParams` / `input` + a dangling `ResourceOverviewEntry` type never declared on `PsMessage`.
  Added the four optional fields + the permissive `ResourceOverviewEntry` alias.

**Files changed:** `libs/features/data_resource_registry/{reset_handlers.ts,site_resources.ts,
feature.manifest.ts,__tests__/reset_handlers.test.ts}`, `src/index.ts`, `app/components/workbench/
{GreenfieldReset.tsx,DangerZone.tsx,greenfield-reset-logic.ts,greenfield-reset-logic.spec.ts,
DatabasePanel.tsx,Workbench.client.tsx}`, `app/lib/embed/embedded-mode.ts`, `app/lib/stores/
workbench.ts`, `frontend/src/app/services/bolt-embed.service.ts`, `frontend/src/app/pages/admin/
sections/editor.component.ts`, this ledger + `docs/data-resource-platform/CORRECTION-AND-BACKLOG.md`.

**Verification:** editor `tsc --noEmit` exit 0 · worker `npm run typecheck` exit 0 · worker
`npx jest reset_handlers` 11/11 green · Angular `tsc -p tsconfig.app.json` exit 0 ·
`validate:features` PASS (0 errors, 2 pre-existing unrelated warnings). Not deployed (per instruction).

## 2026-09-27 — Remaining orphans resolved (ProblemsTab/LogsTab, mcp_pkce, allowlist cleaned)

**Interconnectedness sweep — every remaining `detect:orphans` finding connected or deleted.**
`node scripts/detect-orphans.mjs` now exits 0 with **0 findings / 0 allowlisted** (empty,
accurate allowlist).

**Per-orphan decision:**

- **ProblemsTab.tsx + LogsTab.tsx → DELETED** (whole `extensions/tabs/` dir). The Problems/Logs
  bottom-panel tabs were **deliberately removed** in `ef9b812a3` ("remove Problems/Logs tabs") +
  `d9a371012` ("finish stripping Problems/Logs extension machinery"); `BottomPanelTabs.tsx` renders
  Terminals only and its own @file comment already says the tabs "were removed". The two component
  files were the leftover of an incomplete strip — nothing imports them (only a JSDoc `@link` in
  `app/routes/api.bolt-tabs.logs.ts`). Live logs are `EventLogsTab` (`@settings/tabs/event-logs`),
  a different surface — not superseded, just retired. Also deleted `extensions/types.ts`
  (`ExtensionTabDescriptor`/`ExtensionTabComponent`) — dead type-only defs for the removed
  tab-registry pattern, referenced by nothing.
- **mcp_pkce.ts → WIRED (DRY, zero behavior change).** `routes/mcp_oauth.ts` `/connect` had an
  inline `codeVerifier` generator (48 random bytes → base64 → strip non-alnum → slice 64) while the
  dedicated RFC-7636 helper module was imported only by its own test. Refactored `mcp_oauth.ts` to
  `import { generateCodeVerifier } from '../services/mcp_pkce.js'` and call it — both emit a valid
  base64url verifier in the spec's [43,128] range; adapters pre-derive the S256 challenge themselves
  (`mcp_client.ts challengeFromVerifier`) or pass the verifier through, so length/format is
  non-load-bearing. `mcp_pkce.test.ts` + all mcp_oauth tests stay green.
- **data-panel-logic.ts "3 dead AskPanel exports" → ALREADY RESOLVED (no-op).** The dead exports
  were removed during the DataPanel-retirement + AskPanel-recycle commits (`bdc5c537a`). At the
  current tip every one of its 162 exports has a live production consumer (SqlNavigator,
  SiteTablesPanel, CellEditor, TypedValueField, field-types); a per-export importer scan found zero
  unused. The detector never flagged it (not in the 3 allowlisted orphans). Nothing to delete.

**Allowlist:** removed all 4 entries — the 3 resolved above **plus the stale `FunctionsPanel.tsx`
entry** (FunctionsPanel was already deleted in `129b5919a`; its allowlist row pointed at a
non-existent file). `allow: []` now, with a `_status` note recording each resolution.

**Files changed:**

- deleted `app/components/workbench/extensions/tabs/ProblemsTab.tsx`
- deleted `app/components/workbench/extensions/tabs/LogsTab.tsx`
- deleted `app/components/workbench/extensions/types.ts`
- `apps/project-sites/src/routes/mcp_oauth.ts` — import + use `generateCodeVerifier` (dedupe inline PKCE)
- `apps/project-sites/scripts/orphans-allowlist.json` — emptied `allow[]` (all 4 baseline orphans resolved)

**Follow-up (out of scope — noted, not touched):** `app/routes/api.bolt-tabs.logs.ts` (+ its spec)
is now a stranded backend — its only client (LogsTab) is gone. It's a Remix file-route (self-registers,
harmless) and the orphan detector doesn't scan `app/routes`, so it's not a gate failure; a later fire
should delete it. Same-class DRY opportunity: `mcp_client.ts challengeFromVerifier` duplicates
`mcp_pkce.codeChallengeS256` — left untouched (out of this fire's allowed-file set).

**Verification:** `detect-orphans` exit 0 (0/0/0). Editor `npx tsc --noEmit` exit 0. Worker
`npm run typecheck` exit 0. Worker Jest `mcp_pkce|mcp_oauth|mcp`: 32 suites / 417 tests green.

## 2026-09-27 — Orphaned FunctionsPanel removed (interconnectedness — deliberate delete)

**Decision: DELETED** (not wired). The orphan detector flagged
`app/components/workbench/FunctionsPanel.tsx` (559 lines, exported, referenced only by its
own spec — never rendered).

**Why delete, not wire:**

- **Explicit Brian directive (2026-09-20)** in memory `editor-functions-data-tabs-are-wanted.md`:
  "REMOVE the Functions tab. This REVERSES the 'NEVER re-delete Functions' stance.
  `FunctionsPanel.tsx` + `functions-panel-logic.ts` (+ its spec) are now DEAD (unimported) —
  delete on the next Bash-enabled fire (`rm` was classifier-gated)." The delete was already
  authorized; it was only blocked by a tooling outage. This fire executes it.
- **Superseded surface.** Functions are now **code-defined** via a `functions/` folder
  (ADR-0035, Workers for Platforms) and scaffolded in-editor through `CreateMenu` ("Add
  Function" + NL intent → `scaffoldForIntent`), not a dashboard panel. `Workbench.client.tsx`
  already dropped the Functions **tab** on 2026-09-20; a persisted `functions` view falls back
  to the Code tab.
- **Truly orphaned cluster.** `FunctionsPanel.tsx` was imported by nothing but its own spec.
  `functions-panel-logic.ts` was imported ONLY by `FunctionsPanel.tsx` + the two specs — so it
  was part of the same dead cluster; deleting the panel alone would have stranded it as two new
  orphans (violating interconnectedness).

**Files changed:**

- deleted `app/components/workbench/FunctionsPanel.tsx`
- deleted `app/components/workbench/FunctionsPanel.spec.ts`
- deleted `app/components/workbench/functions-panel-logic.ts`
- deleted `app/components/workbench/functions-panel-logic.spec.ts`
- `app/components/workbench/Workbench.client.tsx` — tidied 3 stale comments that listed
  "Functions" in the tab strip (Code | Preview | Data now). The load-bearing
  `selectedView === 'code' || selectedView === 'functions'` fallback + the `'functions'`
  `WorkbenchViewType` union member are RETAINED (they protect a mid-session user whose persisted
  view is `functions` from a blank editor body; dropping the union member requires a store-wide
  sweep out of this fire's scope).

**Verification:** `npx tsc --noEmit` exit 0 (0 errors). Workbench Vitest: 12 files / 719 tests
green. Zero code references to the deleted cluster remain (`grep` clean). No orphans-allowlist.json
exists in the repo.
