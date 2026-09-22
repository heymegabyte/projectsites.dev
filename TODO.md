# TODO — Repository Organization Roadmap

Lightweight roadmap (per `todos-are-roadmap`). Priority-ordered. Structural decisions
follow published conventions per the global rule `style-guide-driven-decisions`.

## Architecture / layout

- [ ] **Relocate the editor `app/` → `apps/editor/`** so every deployable app lives under
  `apps/` (standard monorepo layout — Nx / Turborepo / pnpm-workspaces). Root then holds only
  workspace config + shared tooling. Touches root `wrangler.toml`, `vite.config.ts`,
  `vite-electron.config.ts`, `functions/`, `load-context.ts`, `electron/`, and the CF Pages
  `bolt-diy` build settings — do it as a discrete pass with an editor build + Pages deploy
  verification, not inline with other work.
- [ ] **Resolve the v2 Angular migration** — `.cleanup-allowlist` references `apps/web/*` as
  "target state after Phase 8", but `apps/web` does not exist. Either scaffold it or retire the
  plan (drop the `apps/web` allowlist lines + the `resurrection-guard` v2 references).
- [ ] **Decide the editor's Electron desktop packaging** — root `electron/`,
  `electron-builder.yml`, `vite-electron.config.ts`, `notarize.cjs`, and `.github/workflows/electron.yml`
  are inherited from bolt.diy; ProjectSites delivers via web (CF Pages). Keep only if desktop
  distribution is a real goal; otherwise remove and note here.
- [ ] **Reclaim leftover worktrees** — 68 `.claude/worktrees/agent-*` dirs remain (agent infra,
  untouched by this cleanup). Prune via `git worktree prune` + `worktree-pool.sh status`.
- [ ] **Regenerate the lockfile** — `pnpm-lock.yaml` / `package-lock.json` still list the removed
  workspace members. Run `npm install --legacy-peer-deps` (NOT pnpm — electron-builder) to
  reconcile before the next dependency change.

## Removed 2026-09-22 (see README § Roadmap for the parked-initiative notes)

- Deleted non-core side-projects: `apps/chrome-extension`, `apps/desktop` (Tauri),
  `apps/mobile` (Capacitor), `apps/analytics-ingest`, `apps/project-sites/capacitor`,
  `packages/sdk`, `packages/psctl`, `packages/mcp-server`.
- Deleted 2,826 accidentally-committed Playwright trace files (`apps/project-sites/tr-fj*`),
  stale-tracked e2e screenshots, and ~80 root-level QA scratch images + reports.
