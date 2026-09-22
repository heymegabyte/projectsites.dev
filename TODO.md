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

## Pending feature items (from `_APP_COMPLETION.md § A` — editor + domains)

- [x] **URL bar link-out (Msg-3a)** — DONE 2026-09-22. Editor preview address bar reveals an
  open-in-new-tab button on hover/focus (`group-hover` + `group-focus-within`, identical styling
  both states); no always-visible home glyph remained. `app/components/workbench/Preview.tsx`.
  Shipped to `bolt-diy` Pages (editor.projectsites.dev); deployed artifact verified.
- [ ] **Editor preview loading UX (Msg-3b)** — while the preview boots, chat shows
  "ProjectSites.dev is using AI to ensure your website is loaded and available for preview" + a
  loading indicator; AI-ensures the preview boots regardless of framework; graceful fallback when
  no preview / undetectable. Cross-component (Chat + Preview boot detection) — its own pass. Not
  started (message string absent from source).
- [ ] **Domain-dropdown overhaul (Msg-1)** — synth an always-present `{slug}.projectsites.dev`
  default row so "No domains assigned" NEVER shows (`domain-picker.component.ts:826` still shows it);
  per-row activate `role=switch` + ⋯ menu (set-primary · auto-re-register · copy · open · remove w/
  DialogShell confirm); merge $17/mo wallet CTA into the compact header; SWR-cache + pre-warm
  AI-picks/refine/Load-More. Stipulations: synthetic default non-removable/non-deactivatable;
  `hostnames.auto_reregister` D1 column + renewal endpoint (own sub-task — reversible D1 migration);
  WCAG-2.2 keyboard menu. LARGE — its own focused pass.

## Removed 2026-09-22 (see README § Roadmap for the parked-initiative notes)

- Deleted non-core side-projects: `apps/chrome-extension`, `apps/desktop` (Tauri),
  `apps/mobile` (Capacitor), `apps/analytics-ingest`, `apps/project-sites/capacitor`,
  `packages/sdk`, `packages/psctl`, `packages/mcp-server`.
- Deleted 2,826 accidentally-committed Playwright trace files (`apps/project-sites/tr-fj*`),
  stale-tracked e2e screenshots, and ~80 root-level QA scratch images + reports.
