# Data Platform — FIRE 7: Per-site Code / Git Browser (first pass)

> Branch `feat/apps-deploy-panel`. Editor-only + Angular-admin bridge change (NO worker code touched →
> no Docker worker-deploy required). The named ledgers (`CORRECTION-AND-BACKLOG.md`,
> `PROGRESS-LEDGER.md`) don't exist on this branch line; this focused note is the shipped-vs-deferred
> record for the fire.

## Code-storage investigation (what determined scope)

- A site's CODE lives in R2 at `sites/{slug}/[{version}/]{file}` (the published build), NOT in a
  general-purpose git-over-R2 filesystem. `isomorphic-git` is a dependency but is used by the editor's
  own `app/lib/hooks/useGit.ts` (WebContainer git), not for per-site source.
- The worker ALREADY exposes the two rails this fire needs — both org-scoped via `requireOwnedSite`
  (404, never 403, on cross-org) and both mounted in `src/index.ts`:
  - `libs/features/site_files/handlers.ts` — `GET /api/sites/:id/files` (file tree, cap 500) +
    `GET /api/sites/:id/files/:path{.+}` (one file's text, sanitized + prefix-guarded).
  - `libs/features/site_versioning/handlers.ts` — `GET /api/sites/:id/git/history?depth=N` (the R2
    git commit timeline via `services/git.ts`; honest `[]` for sites with no committed builds) +
    `git/diff` + `git/commits/:id` + `snapshots/revert`.
- `services/git.ts` is a JSON-snapshot "git" over R2 (`sites/{slug}/git/{HEAD,commits,trees}`), NOT
  real isomorphic-git — full snapshots per commit, populated by the build/GitHub-sync path.
- **Conclusion:** the read rails exist; scope the first pass to READ over them, add no new worker code.

## Shipped (read-first, honest)

- **File browser** — a nested folder/file tree (built client-side from the flat R2 key list) with a
  syntax-labelled read-only viewer (`<pre>` + language chip) over `sites/{slug}/{version}/`. Binary
  assets (image/font/media) render an honest placeholder, never garbled bytes.
- **Version history** — a read-only commit timeline from `git/history`, newest-first, with an honest
  "No version history yet" empty state for sites with no committed builds.
- **Where** — a new **Git** tab in the editor workbench (`app/components/workbench/GitPanel.tsx`),
  additive tab registration in `Workbench.client.tsx`.
- **Per-site isolation** — server-resolved: the embedded editor has no cross-origin session, so it
  posts `PS_CODE_*` bridge messages to the admin, which calls the org-scoped worker endpoints with the
  bearer. The panel never sees a slug/id it could tamper with (mirrors the `PS_DATA` bridge exactly).

## Deferred (honest "coming soon", never a dead control)

- **Diff between commits** — `git/diff` exists, but the diff VIEWER UI + wiring is deferred.
- **Restore a version** — `snapshots/revert` exists but is a MUTATING, one-way-door action; deferred
  until it can ship confirm-gated. The History tab's "Compare" button flashes a "coming next" note.
- **Inline editing from this panel** — the viewer's "Edit" button flashes "coming next" (the live
  `Code` tab remains the edit surface).
- **Inline image preview** — deferred (needs a short-lived signed raw URL over the bridge to stay
  per-site-scoped per SECURITY-INVARIANTS; no direct cross-origin fetch). Shows a placeholder for now.

## Files

- New: `app/components/workbench/git-browser-logic.ts` (+ `.spec.ts`, 24 tests) — pure tree/lang/binary
  /format helpers. `app/components/workbench/GitPanel.tsx` (+ `.spec.tsx`, 4 tests).
- Modified (additive): `app/lib/embed/embedded-mode.ts` (3 `PS_CODE_*` request/response pairs + unions),
  `app/lib/stores/workbench.ts` (`WorkbenchViewType` += `'git'`), `Workbench.client.tsx` (tab + panel),
  `apps/project-sites/frontend/src/app/services/bolt-embed.service.ts` (3 bridge handler cases +
  `PsMessage.path`/`.depth`).

## Verification

- Editor `npx tsc --noEmit` → 0 errors. Editor Vitest (both new specs) → 28/28 green. Editor ESLint on
  all touched files → 0 errors. Angular `tsc -p tsconfig.app.json` → 0 errors. Angular ESLint on
  `bolt-embed.service.ts` → 0 errors (pre-existing `perfectionist/sort-objects` warnings only, kept
  consistent with the sibling PS_DATA/PS_SQL handlers).
- No worker `src/`|`libs/` `.ts` touched → no Docker build / worker deploy in scope for this fire.
