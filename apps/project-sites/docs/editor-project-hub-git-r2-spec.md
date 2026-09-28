# Editor "Your project" hub — Git + Snapshot + R2 + Preview (grounded spec)

Status: **SPEC / checkpoint** (2026-09-28). Grounds Brian's directive to unify Git + Snapshot
under the Code-view "Your project" (ProjectHub) button, make Preview branch-aware off R2, and make
Promote/Deploy auto-commit + AI-drive the build. Written after a read-only infra sweep so execution
does not rebuild what exists. Feature-flag: `editor_git_r2_hub` (dark until slices land).

## ⭐ Architecture — TWO layers (corrected 2026-09-28, Brian; NOT an either/or)

- **PREVIEW = an isomorphic-git repository in R2, per site (under the site's namespace).** Real branches;
  the editor commits against it. `dist/` is git-ignored but PRESENT on R2 (built output). The **Preview URL
  serves the selected branch's `dist/` from R2** (main or any branch present).
- **PRODUCTION = immutable timestamped snapshots at `sites/{slug}/{ISO-timestamp}/`**, created ONLY on
  **Promote (Preview → Production)**: auto-commit-if-dirty (AI message) into the isogit repo → snapshot the
  built `dist/` into `sites/{slug}/{ISO}/` → git **tag** linking the timestamped dir ↔ the commit → WfP.
- **isomorphic-git SUPERSEDES the JSON-over-R2 `services/git.ts` for the Preview layer** — migrate
  `GET /api/sites/:id/history` + `PS_CODE_HISTORY` to read the isogit log; do NOT keep two git models.
- Ordered implementation slices live in `apps/project-sites/_LOOP_LEDGER.md` (this arc). Everything else
  below (WfP, branch-aware serving, snapshots, AI rails) is REUSED as-is.

## What ALREADY exists (do NOT rebuild — wire to it)

- **Git-over-R2 per site** — `apps/project-sites/src/services/git.ts`. NOT isomorphic-git (deliberate:
  R2 has no fs). Layout: `sites/{slug}/git/HEAD` (commit id), `sites/{slug}/git/commits/{id}.json`
  (`CommitMetadata`: id, message, timestamp, author, parentId, files[], `buildVersion?`),
  `sites/{slug}/git/trees/{id}/` (full file contents per commit). Published builds:
  `sites/{slug}/{version|ISO-timestamp}/`.
- **History endpoint** — `GET /api/sites/:siteId/history` (`src/routes/site_rollback.ts` →
  `getHistory` in `services/github_repo.js`). Returns `CommitSummary[]` {sha,message,date,author,fileCount,buildVersion?}.
  Flag `github_repo_sync` + IDOR owner check. (Editor's `PS_CODE_HISTORY_REQUEST` maps here.)
- **WfP dispatch** — `src/services/wfp_dispatch.ts`: `uploadSiteFunctionsWorker(env,siteId,code,{preview?})`,
  `siteFunctionsScriptName(siteId,{preview})` → `site-{id}` / `site-{id}-preview`, `dispatchToUserWorker`.
  Lifecycle: `deploySiteWfpSlotsOnLifecycle(env,siteId,{orgId,slots:['preview','production'],version})`.
- **Branch-aware serving** — `src/services/site_serving.ts` `serveSiteViaWfpIfPreferred()` +
  `src/services/site_branches.ts` `parseBranchHost(host)` → `{branch}--{slug}.projectsites.dev` → `-preview` slot,
  fail-soft to R2 `sites/{slug}/{version}/{path}`.
- **Server snapshots** — D1 `site_snapshots` (id, site_id, snapshot_name, build_version, description) +
  `site_releases` (append-only, flag `durable_preview_model`); `buildVersion` links snapshot↔R2 version.
- **AI rails** — `env.AI` (Workers AI), AI Gateway via `services/external_llm.ts`, prompt registry
  `services/ai_workflows.ts`. Reusable to author commit messages + decide build strategy.
- **Editor ProjectHub** — `app/components/workbench/ProjectHub.tsx`: 3 SEPARATE sections today —
  Deploy (`PS_DEPLOY_REQUEST`), Snapshots (client IndexedDB `lib/persistence/projectSnapshots.ts`),
  git-history view (read-only `PS_CODE_HISTORY_REQUEST`). Preview (`Preview.tsx`) = WebContainer baseUrl only.

## Gaps (what's MISSING — the actual build)

1. **Auto-commit on Promote** — Promote does NOT commit uncommitted files, and there is NO
   AI-generated commit message. (Brian assumed this existed; it does not.)
2. **AI commit messages** — no helper turns a diff → message.
3. **Editor git write-path** — no `PS_GIT_COMMIT` / `PS_GIT_RESTORE` / `PS_GIT_LOG` / `PS_GIT_SYNC` /
   `PS_PROMOTE` bridge messages; git is display-only; snapshots are client-only + git-unaware.
4. **Branch-aware Preview selector** — Preview has no branch/version dropdown; can't point the iframe
   at an R2 branch/version.
5. **AI Deploy scan** — Deploy does not AI-scan the project to pick build/deploy strategy or expand
   the WfP namespace with additional items.
6. **R2 ↔ bolt-git sync** — the editor's working files aren't synced into the R2 git layer.

## Designs (concise)

- **dist/ on R2, untracked-in-git** — git tracks SOURCE (`sites/{slug}/git/trees/{id}/`); the served
  build is `sites/{slug}/{ISO-timestamp}/dist/...`. `.gitignore` in the site repo lists `dist/`; the
  version dir is written by Promote, not by a commit.
- **Snapshot == git ref** — "Take a snapshot" creates a git **tag** (lightweight) `snapshot/{ISO}` on the
  current commit AND records `site_snapshots.build_version = {ISO}` so the tag ↔ `sites/{slug}/{ISO}/`
  dir are linked. Retire the client-only IndexedDB store (or keep as offline cache only).
- **Restore-forward (keep history)** — restoring commit C does NOT rewind history; it writes C's tree
  as the working files and the NEXT commit's parent is current HEAD (a new commit that "clobbers to C").
  i.e. `git read-tree C` into worktree, leave HEAD; commit → normal child of HEAD with C's content.
- **Promote = commit-if-dirty (AI msg) → version dist → WfP** — (a) if worktree ≠ HEAD tree, AI-commit
  on current branch; (b) build `dist/`; (c) write `sites/{slug}/{ISO}/`; (d) `deploySiteWfpSlotsOnLifecycle`
  production slot + expand namespace with any new `functions/`.
- **Deploy = AI build scan** — read the project's `package.json`/config, AI-decide build command +
  output dir, run in the container/build path, then Promote-style version + WfP expand.
- **Branch-aware Preview** — Preview URL = `https://{branch}--{slug}.projectsites.dev` (existing
  `parseBranchHost` slot). A branch/version dropdown in the Preview bar switches the iframe src.

## New bridge contract (`app/lib/embed/embedded-mode.ts` + admin `BoltEmbedService`)

- `PS_GIT_LOG_REQUEST {branch?, depth?}` → `PS_GIT_LOG_RESPONSE {commits:[{sha,message,timestamp,author}], branch}`
  (current-branch commit list; editor does live-search client-side).
- `PS_GIT_COMMIT_REQUEST {message?, aiMessage?:true}` → `PS_GIT_COMMIT_RESPONSE {sha, message}`
  (aiMessage → worker authors msg from the diff; commits current worktree on current branch).
- `PS_GIT_RESTORE_REQUEST {sha}` → `PS_GIT_RESTORE_RESPONSE {ok, files}` (restore-forward: writes the
  sha's tree into the worktree; editor re-mounts files; history intact).
- `PS_GIT_SYNC_REQUEST {}` → `PS_GIT_SYNC_RESPONSE {ok, ahead, behind}` (sync bolt worktree ↔ R2 git).
- `PS_BRANCH_LIST_REQUEST` → `PS_BRANCH_LIST_RESPONSE {branches:[{name,isCurrent,version?}]}`;
  `PS_BRANCH_SELECT_REQUEST {name}` (Preview switches to `{name}--{slug}`).
- `PS_PROMOTE_REQUEST {}` → `PS_PROMOTE_RESPONSE {version, sha, url}` (auto-commit-if-dirty + AI msg →
  version dist → WfP production). Extends the existing `PS_DEPLOY_REQUEST`.

## Implementation slices (ordered; each flag-gated, TDD-first, deploy+verify)

1. **Worker AI-commit + git write ops** — `services/git.ts`: `commitWorktree(env,siteId,{message,files})`,
   `restoreTreeForward(env,siteId,sha)`, `aiCommitMessage(env,diff)` (Workers AI). Routes under
   `/api/sites/:siteId/git/*`. Unit tests w/ real-SQLite/R2 mock.
2. **Bridge contract** — add the messages above to `embedded-mode.ts` (types + `requestFromParent`
   helpers) + admin `BoltEmbedService` handlers (authed calls to the slice-1 routes). LAND FIRST after slice 1.
3. **Editor hub merge** — `ProjectHub.tsx`: fold Snapshot + Git into ONE "Source control" section:
   commit list (PS_GIT_LOG) + live-search input + per-commit Restore (PS_GIT_RESTORE, restore-forward)
   + "AI commit" (PS_GIT_COMMIT aiMessage) + "Sync" (PS_GIT_SYNC). Snapshot = tag via PS_GIT_COMMIT + tag.
4. **Promote + AI deploy** — worker: `promoteSite` (commit-if-dirty→version dist→WfP expand) + AI build
   scan; wire `PS_PROMOTE_REQUEST`. Editor Deploy→Production uses it.
5. **Branch-aware Preview** — `Preview.tsx` branch/version dropdown → PS_BRANCH_* → iframe src
   `{branch}--{slug}.projectsites.dev`.

## Verify

Per `verification-loop`: each slice deploys (editor→Pages `bolt-diy`, worker→`wrangler deploy --env production`,
frontend→R2) + prod-verified. Interaction paths (commit/restore/promote) need a files-loaded admin session
(the workbench renders only with files) — real-browser E2E on lone-mountain-global.

## Cross-refs
`memory/domain-url-component-canonical-is-domain-picker`, `every-new-site-born-on-wfp-preview-and-prod`,
`data-platform-session2-resource-git-model`, `interconnectedness-sql-editor-near-miss`,
`editor-code-view-project-hub`, `editor-workbench-renders-only-with-files`.
