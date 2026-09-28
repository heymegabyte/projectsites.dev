# Promote Workflow — Loop Checkpoint

> Main-only Preview/Promote/Production release model for the ProjectSites editor.
> Full spec = the recurring cron prompt (job `d41a9a63`, every 15m). This file = discovered
> state + ordered slices + verification results. **Re-inspect the repo every fire; never assume
> a prior attempt landed.** Keep this file SMALL; delete it + consolidate into docs when done.

## STATUS: iteration 2 (Slice 1 + Slice 2 LANDED — release workflow underway)

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
3. **Durable Preview model** (worker): per-site working-tree record (main base SHA, monotonic draft
   revision, file manifest/content hashes, save time, preview deploy revision, error) + immutable
   release records (frozen snapshot id, commit SHA, artifact digest, deployment id, actor, ts,
   outcome). R2 payloads + existing D1 for metadata. Migration = additive (no silent redeploy).
4. **Editor Source Control view** beside the file explorer: changed-file count+status (A/M/D/R),
   diffs vs last committed main base, badges/gutter markers, release history, restore-to-Preview,
   "main" indicator + Preview/Production sync status, conflict notices.
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
- Commit SHA: <filled at commit>.
- NEXT UNMET SLICE → **Slice 3: Durable Preview model (worker)** — per-site working-tree record (main
  base SHA, monotonic draft revision, file manifest/content hashes, save time, preview deploy revision,
  error) + immutable release records (frozen snapshot id, commit SHA, artifact digest, deployment id,
  actor, ts, outcome). Additive D1 migration (no silent redeploy).
