# Discovery — orphans + interconnectedness drift (loop fire, 2026-09-29)

> Read-only discovery output for Lane 5 (interconnectedness). Feeds `_RUN_THE_LOOP.md` § 5 +
> § Harvested backlog. Deduplicated against the existing queue. A future fire folds the un-done
> items into the live queue. `[READY]` = wire/cull is <2h + low-risk.

## 6 orphan/drift tasks (wire-or-cull)

1. **[ORPHAN] `GitPanel.tsx` (1134 ln) unwired** — imported nowhere but its test; never rendered in `Workbench.client.tsx`. Evidence: `detect-orphans.mjs` + `app/components/workbench/GitPanel.tsx`. **Action: likely CULL** — `SourceControlPanel.tsx` (bridge-based) IS wired and supersedes it. Verify parity first, then `git rm` GitPanel + its spec. `[READY if cull]`.
2. **[DRIFT · READY] `src/services/ide_sandbox.ts` (585 ln) simulated, never deployed** — 7 exports (spinUpSandbox…), only test mentions; CF Sandbox binding never provisioned; `ide_sandboxes` seeded but no `/api` route consumes it. **Action: CULL** (confirm no handler calls, then `git rm`). Pairs with #6.
3. **[DRIFT · READY] `mcp_resource_tokens` table — no reader** — created in `0037_*.sql`; no grep outside migrations; modern MCP uses `mcp_connections` + `ai_env_vars`. **Action: CULL** via a new drop migration (F-owned — hand to Lane 12/F).
4. **[ORPHAN] unwired Data panels — `ImportPanel` · `AiSeedPanel` · `GreenfieldReset` · `KvManager`** — exported, not rendered (SchemaBuilder/SqlNavigator ARE wired via tab clicks). Evidence: `_RUN_THE_LOOP.md:71` + `app/components/workbench/`. **Action: WIRE** each into a Resources/Database tab or menu (KvManager → the KV surface; GreenfieldReset → Data Phase-0 reset; ImportPanel/AiSeedPanel → Data tab) OR cull if superseded. Ties to Lane 3 Data Platform.
5. **[DRIFT · READY] migration `0504` comment-only, never applied** — only self-referenced; placeholder for `ide_sandboxes`. **Action: CULL** with #2 (F-owned drop/remove).
6. **[AUDIT] editor panel trigger completeness** — confirm EVERY exported `app/components/workbench/*` panel has a visible tab-click / menu / keyboard entry (state is tab-based via `Workbench.client.tsx`; no orphaned `subView===` found, but a full map wasn't finished). **Action:** 30-45min read-only pass mapping exports→triggers; wire any found orphan.

## Closed (no drift)
- Angular admin routes ↔ nav model (`admin-nav.model.ts`) — SSOT, in sync, every `/admin/*` has a nav entry.
- Worker `libs/features/*/handlers` — all mounted via `app.route(...)` in `index.ts`; headless endpoints carry intentional-headless notes.

## Sub-area NOT reached (rotate next fire)
- Full editor-panel export→trigger map (finding #6) — one focused read-only pass closes the orphan loop.
