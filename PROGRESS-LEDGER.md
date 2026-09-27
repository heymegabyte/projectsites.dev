# PROGRESS LEDGER

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
