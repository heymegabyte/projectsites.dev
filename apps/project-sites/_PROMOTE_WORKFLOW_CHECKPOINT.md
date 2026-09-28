# Promote Workflow — Loop Checkpoint

> Main-only Preview/Promote/Production release model for the ProjectSites editor.
> Full spec = the recurring cron prompt (job `d41a9a63`, every 15m). This file = discovered
> state + ordered slices + verification results. **Re-inspect the repo every fire; never assume
> a prior attempt landed.** Keep this file SMALL; delete it + consolidate into docs when done.

## STATUS: iteration 4 (Slice 1 + Slice 2 + Slice 3 + Slice 4 LANDED — release workflow underway)

- **Slice 1 (D1 CRUD backend) — DONE, already committed** (verified 2026-09-28: `clampColumnType`/
  `buildAddColumnSql`/`buildInsertRowSql`/etc. present in `src/services/site_data_db.ts`; the 9 per-site
  routes live in `site_db_handlers.ts`; CLAUDE.md API rows present). The checkpoint was stale — the
  working tree no longer shows those files as modified. No action needed.
- **Slice 2 (retire the `git` workbench TAB) — DONE this fire** (see VERIFICATION LOG). Followed the
  `data`→`database` precedent exactly. IMPORTANT discovery: the `git` tab was NEVER a branch/staging/PR
  surface — it's already `GitPanel`, a read-only published-R2-file + commit-history browser. And the
  **Code-view Project hub** (`ProjectHub.tsx`, committed today `8fdc969f8`) already consolidated deploy +
  snapshots + **git history** (via `PS_CODE_HISTORY` bridge) into the Code left panel. So the git tab was
  redundant. `GitPanel.tsx` + `git-browser-logic.ts` are PRESERVED (spec still green, still importable)
  for the future Source-Control view (Slice 4) — not deleted, per "remove superseded code only after its
  replacement exists" + interconnectedness.

## DISCOVERED (2026-09-27, confirmed via grep — repo `heymegabyte/projectsites.dev`, Zod ^3.24.1)

- **Editor tabs live in `app/components/workbench/Workbench.client.tsx`** (bolt.diy `app/`, React/Remix):
  - `type TopTab = { value: WorkbenchViewType; text; icon }` (line ~49); `TOP_TABS` array (lines ~67-71):
    `code` | `preview` | `database` | `resources` | **`git`** (`{value:'git', text:'Git', icon:'i-ph:git-branch-duotone'}` line ~71).
  - `WorkbenchViewType` + `workbenchStore.currentView` from `~/lib/stores/workbench` (import line ~12).
  - Git panel rendered by `PanelLayer active={selectedView === 'git'}` → `<GitPanel />` (lines ~558-559,
    import line ~18). Git is described as "read-first browser over the site's PUBLISHED R2 build + commit
    history" (comments ~61, ~554) — it's NOT a write/commit surface today.
  - **CORRECTION to the original prompt's mental model:** "Git" is a TOP-LEVEL workbench tab, not a pane
    inside "Data." The **`Data` tab already folded into `Database`** (Brian 2026-09-27 "FIRE 1"); legacy
    `data`/`functions` view values are normalized (`data`→`database`, `functions`→`code`) at lines ~170-181.
    That normalization block is the EXACT precedent to follow when retiring `git` (add `git`→`code`/`database`).
- **Git files (preserve shared logic, don't just delete):** `app/components/workbench/GitPanel.tsx`,
  `GitPanel.spec.tsx`, `git-browser-logic.ts`. The Source Control view must REUSE `git-browser-logic.ts`
  before the `git` tab is removed (prompt: remove superseded code only after its replacement exists).
- The repo is ALREADY refactoring toward this model (the FIRE-1 fold) — build WITH it, not a parallel arch.

## INSPECT each fire (concrete traces STILL needed — use Explore agents when classifier is up)

- **Editor header / Preview address-bar component** (where the cyan `Promote` button mounts) — recent commit
  `219431a74 fix(editor): pin the site's primary URL in the Preview address bar` names it; grep
  `app/components/workbench` + `app/components/**/*eader*` for the URL bar.
- Editor "Git" pane removal is slice-gated (see slices): shared Git services/creds/connections/history PRESERVED.
- Existing Git integration: import/export, GitHub/GitLab connections, tokens, commit/push code, libs.
- Editor header + URL/Preview controls (where the cyan `Promote` button mounts) — likely in `app/`
  components near the persistent `editor.projectsites.dev` iframe (owned by `BoltEmbedService`,
  iframe lives in `AdminComponent` template per root CLAUDE.md).
- Durable file storage / snapshots / revision history / deployments / promote+rollback code in the
  worker (`apps/project-sites/src` + `libs/features/*`).
- Workers-for-Platforms: `USER_DISPATCH` namespace `project-sites-endpoints`, `wfp_dispatch.ts`,
  per-site isolation, Preview vs Production dispatch/routing. R2 layout: `sites/{slug}/{version}/*`
  + `sites/{slug}/_manifest.json` (`current_version`); sites row has `current_build_version`.

## ORDERED SLICES (implement one fully per fire — UI+state+API+tests, then commit+push)

1. ~~Land the uncommitted D1 CRUD backend~~ — DONE (already committed; verified 2026-09-28).
2. ~~**Retire the `git` workbench tab**~~ — DONE 2026-09-28. Removed the `git` TOP_TABS entry + its
   `PanelLayer` + the `GitPanel` import from `Workbench.client.tsx`; added `git`→`code` normalization
   (Code panel now owns a stale `git` view so it never renders blank); updated the `WorkbenchViewType`
   comment. `GitPanel`/`git-browser-logic` PRESERVED (spec green). No route/bookmark redirect needed —
   `git` was a client-only tab value, not a URL; git history stays reachable via the Code-view Project hub.
3. ~~**Durable Preview model** (worker)~~ — DONE 2026-09-28 (see VERIFICATION LOG). New feature module
   `libs/features/durable_preview/` (manifest + schemas + service + handlers + tests) behind flag
   `durable_preview` (DARK). Additive migration `0646_durable_preview_model.sql` creates two tables:
   `site_working_tree` (per-site UNIQUE; base_main_sha · monotonic draft_revision · tree_digest ·
   preview_deploy_revision · last_error) + `site_releases` (append-only immutable; snapshot_id ·
   commit_sha · artifact_digest · deployment_id · actor · draft_revision · outcome · created_at).
   `upsertWorkingTree` (Preview-only — no commit/deploy/Production) + `appendRelease` (append-only) +
   org-scoped readers. Routes: POST/GET `/api/sites/:id/preview-state`, GET `/api/sites/:id/releases`
   (assertSiteOwned + isFlagOn guarded → 404 dark). REMAINING EXTERNAL STEP: apply migration 0646 to
   prod D1 (`wrangler d1 migrations apply project-sites-db-production --remote`) — additive/idempotent,
   safe; the flag stays DARK so nothing reads/writes until enabled.
4. ~~**Editor Source Control view**~~ — DONE 2026-09-28 (see VERIFICATION LOG). New
   `app/components/workbench/SourceControlPanel.tsx` mounted as a 4th tab beside the file explorer
   (Files · Search · Locks · **Source**) in `EditorPanel.tsx`. REUSES the preserved
   `git-browser-logic.ts` (extended with `diffWorkingTree`/`countChanges`/`summarizePreviewSync`/
   status+outcome labels) + GitPanel's branded button/state primitives + bridge pattern. Changed-file
   count+status (A/M/D/R) diffed from the editor's OWN `workbenchStore.files` (Preview) vs the published
   main base (`PS_CODE_TREE_REQUEST`); release history + Preview↔Production sync from the new
   `PS_RELEASES_REQUEST`/`PS_PREVIEW_STATE_REQUEST` bridges (→ durable-preview worker API, parent-session
   bridge like the Database tab); restore-to-Preview fetches the base file (`PS_CODE_FILE_REQUEST`) and
   writes it via `workbenchStore.setVirtualFile` (Preview-only — NEVER commits/deploys/Production). NO
   Promote button (Slice 5). Empty/loading/error/success states; brand-dark cyan, no solid-white buttons.
5. **Cyan `Promote` header button** (exact label) + status progression + no-op/retry states.
6. **Promote transaction** (per-site serialized, idempotent, retryable — existing job system or
   Cloudflare Workflows): 12 steps in the cron spec. Deterministic AI commit-subject + factual
   fallback. Deploy the FROZEN artifact digest to Production; verify + record actual CF deployment id.
7. **GitHub App / server-side short-lived creds**, webhook signature verify, reconcile remote main by
   SHA, never force-push. Internal durable main history when no external provider.
8. **Migration + API/MCP parity**, consistent terminology, boundary tests, real-browser pass.

## INVARIANTS (never violate — see cron spec for full text)
Save≠commit≠deploy · Production only via authorized promotion · promoted bytes = frozen revision
(record+compare digests) · editor always shows main · honest Production SHA + "commit ok/deploy
failed" retry · idempotent promote · edits-during-promote → new draft · .gitignore + secret exclusion
· code snapshot ≠ data snapshot · migrate existing sites without silent redeploy.

## VERIFICATION LOG

### 2026-09-28 — Slice 2: retire the `git` workbench tab
- Files touched:
  - `app/components/workbench/Workbench.client.tsx` — removed `GitPanel` import, removed the
    `{ value: 'git', … }` TOP_TABS entry, removed the `<PanelLayer active={selectedView === 'git'}>` +
    `<GitPanel />` block, added `git`→`code` to the normalization `useEffect`, extended the Code
    `PanelLayer` active predicate to include `selectedView === 'git'`, refreshed comments.
  - `app/lib/stores/workbench.ts` — updated the `WorkbenchViewType` legacy-values comment (added `git`).
  - `apps/project-sites/_PROMOTE_WORKFLOW_CHECKPOINT.md` — this file.
- `npm run typecheck` (editor, repo root `tsc`) → GREEN (no errors).
- `cd apps/project-sites && npx tsc --noEmit` (worker) → GREEN (no output).
- `npx vitest run app/components/workbench/GitPanel.spec.tsx` → GREEN (4/4) — preserved component still works.
- No worker jest touched this slice (change is editor-only).
- Commit SHA: 82f61fb22 (Slice 2, landed on origin).

### 2026-09-28 — Slice 3: Durable Preview model (worker, additive state + API)
- Origin state at start: `8169fc121` (local == origin/main; Slice 2 `82f61fb22` present; newer WfP
  Units 1-4 present). No preview/release/promote migration on origin — clean to add. A concurrent
  session's dirty files (`app/components/workbench/*`, `frontend/*`) were preserved untouched (Slice 3
  is worker-only — no collision).
- New feature module `libs/features/durable_preview/`:
  - `feature.manifest.ts` — flag `durable_preview`, lifecycle alpha, apiRoutes, unitTests (exists on disk).
  - `schemas.ts` — Zod (`.strict()`): WorkingTreeSchema, ReleaseSchema, UpsertWorkingTreeSchema, responses.
  - `service.ts` — `upsertWorkingTree` (Preview-only, monotonic draft_revision, NO commit/deploy/release),
    `appendRelease` (append-only immutable), `getWorkingTree`/`listReleases` (org-scoped). `FLAG_KEY`.
  - `handlers.ts` — Hono sub-app, `guard` (auth+flag→404 dark), `assertSiteOwned` (IDOR→404), zValidator.
  - `__tests__/durable_preview.test.ts` — real-SQLite harness runs the ACTUAL migration DDL.
- `migrations/0646_durable_preview_model.sql` — additive, idempotent (`CREATE TABLE IF NOT EXISTS`):
  `site_working_tree` (per-site UNIQUE working-tree record) + `site_releases` (append-only release log).
- Flag registered: `src/modules/feature_flags/registry.ts` (durable_preview DARK) + `docs.ts`
  (checklist/explanation/smoke_test). Mounted in `src/index.ts` (import + `app.route('/', durablePreview)`).
  FEATURES.md row added.
- VERIFY (all green before commit):
  - `npx tsc --noEmit` → GREEN (exit 0, no output).
  - `npx jest libs/features/durable_preview` → 7/7 PASS (migration creates both tables; upsert writes
    base SHA + draft revision + digest and creates NO release row; monotonic revision on re-save;
    append-release records all immutable fields, append-only newest-first; org-scoped reads; IDOR gate).
  - `npm run validate:features` → PASS (0 violations; 39 manifests, flag cross-check OK).
  - `npx jest durable_preview feature_flags registry flag` → 45 suites / 679 tests PASS
    (incl. flag_route_coherence — new flag+route coherent).
  - `npx jest route_malformed_json_boundary` → 7/7 PASS (full-worker `../index` import loads the mount).
- Commit SHA: <filled at commit>.
- REMAINING EXTERNAL STEP: apply migration 0646 to prod D1
  (`wrangler d1 migrations apply project-sites-db-production --remote`) — additive/idempotent + flag DARK.

### 2026-09-28 — Slice 4: Editor Source Control view (editor `app/`, React)
- Origin state at start: `b478c7ea6` (== origin/main; Slice 3 landed). No Source Control view on origin —
  clean to add. Isolated worktree; only `app/**` + this checkpoint touched (sibling agent owns
  `apps/project-sites/**` concurrently — never staged).
- Files touched (all editor `app/`):
  - `app/components/workbench/git-browser-logic.ts` — EXTENDED the preserved pure module (Slice 2) with the
    Source Control logic: `diffWorkingTree` (Preview vs main base → A/M/D/R change set, rename-collapse,
    path-normalize), `countChanges`, `statusBadge`/`statusLabel`, `summarizePreviewSync` (in_sync/
    preview_ahead/no_release/unknown + deploy-failed flag), `syncLabel`, `releaseOutcomeLabel` + the
    `WorkingFile`/`FileChange`/`PreviewWorkingTree`/`ReleaseRecord`/`SyncSummary` types.
  - `app/components/workbench/git-browser-logic.spec.ts` — +new describe blocks for all the above (RED→GREEN).
  - `app/components/workbench/SourceControlPanel.tsx` — NEW. The view; reuses git-browser-logic + GitPanel's
    Button/IconButton/CenterState/Spinner + the pendingRef/`request()` bridge pattern. Preview from
    `workbenchStore.files` (live, local); base from `PS_CODE_TREE_REQUEST`; history+sync from
    `PS_RELEASES_REQUEST`/`PS_PREVIEW_STATE_REQUEST`; restore via `PS_CODE_FILE_REQUEST` +
    `workbenchStore.setVirtualFile` (Preview-only). NO Promote. Full empty/loading/error/success states.
  - `app/components/workbench/SourceControlPanel.spec.tsx` — NEW. 8 specs (renders status from mocked
    working-tree/diff, renders release history from mocked releases, honest empty states, sync indicator,
    restore targets Preview only + asserts NO commit/deploy/promote/publish message ever sent).
  - `app/lib/embed/embedded-mode.ts` — +`PreviewStateRequest/Response` + `ReleasesRequest/Response` message
    pairs (mirror the durable-preview `{working_tree}` / `{releases,count}` envelopes) wired into both unions.
  - `app/components/workbench/EditorPanel.tsx` — +`Source` tab (trigger + content) beside Files/Search/Locks.
- VERIFY (all green before commit):
  - `npm run typecheck` (editor, repo-root `tsc`) → GREEN (exit 0, no errors).
  - `npx vitest run` git-browser-logic.spec + SourceControlPanel.spec + GitPanel.spec + embedded-mode.spec
    → **61/61 PASS** (logic 36 · SourceControl 8 · GitPanel 4 preserved · embedded-mode 13). RED confirmed
    first (panel spec failed to import the missing module; logic spec drove the pure helpers).
  - `npx eslint` my 2 new files → only the `<style precedence>` `@ts-expect-error` remains (the SAME accepted
    pattern the already-landed GitPanel.tsx ships — editor eslint is dirty repo-wide; typecheck+Vitest is the
    slice DoD per Slice 2/3 convention). All prettier/style auto-fixed.
- Commit SHA: <filled at commit>.
- REMAINING EXTERNAL: real-browser header/VQA pass needs a Pages deploy of `app/` (editor) — the view
  renders only inside the admin iframe (embedded bridge); unit+typecheck cover the logic + wiring.
- NEXT UNMET SLICE → **Slice 5: Cyan `Promote` header button** (exact label) + status progression +
  no-op/retry states. (Then Slice 6: the promote transaction.)
