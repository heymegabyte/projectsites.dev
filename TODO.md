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
- [x] **Domain-dropdown overhaul (Msg-1) — headline slice DONE 2026-09-22.** The picker now
  synthesizes an always-present `{slug}.projectsites.dev` default row, so "No domains assigned" can
  never render and the site is never strandable; the default is non-removable/non-deactivatable and
  "Set as default" on it routes to the reset-primary endpoint. `domain-picker.component.ts` +
  `api.service.ts` (`resetPrimaryHostname`). 5 Karma specs; 1854 green; deployed to R2 prod.
- [ ] **Domain-dropdown overhaul (Msg-1) — remaining parts.** Per-row activate `role=switch` + ⋯
  menu (set-primary · auto-re-register · **copy ✅ + open ✅ shipped 2026-09-22**, rows now degrade
  gracefully on mobile ✅ · remove w/ DialogShell confirm); merge $17/mo wallet CTA into the compact
  header; SWR-cache + pre-warm AI-picks/refine/Load-More; WCAG-2.2 keyboard menu;
  `hostnames.auto_reregister` D1 column + renewal endpoint (own sub-task — reversible D1 migration).
  ⚠️ The ⋯-overflow-menu consolidation needs a menu/overlay primitive the app lacks (no Spartan/CDK
  menu present) → build/vendor one first; it's a dedicated pass, not an inline slice.

## Source-TODO sweep (2026-09-22) — repository is effectively TODO-clean

Repo-wide comment-marker scan found 5 `TODO/FIXME`, none cleanly completable:

- `app/lib/persistence/useChatHistory.ts:416` (FIXME) — the *intended* navigate fix "breaks the app";
  a deliberate workaround, unsafe to touch blind.
- `apps/project-sites/src/middleware/abuse.ts:36` (arcjet) — fail-OPEN by design (`AllowAllAbuseProvider`);
  blocked on Arcjet shipping a Workers adapter. Not a live gap.
- `apps/project-sites/src/services/media.ts:498` — blocked on Sora/Veo public APIs (external).
- `app/components/editor/codemirror/languages.ts:186` (perf-10) — deferred lazy-syntax perf, low value.
- ⚠️ **`apps/project-sites/src/index.ts:217` — Wave-3 `ConversationHub` DO deletion.** Date guard
  (safe after 2026-08-01) has PASSED. But the action is a **destructive one-way-door DO migration**
  (`deleted_classes = ["ConversationHub"]` + remove export + delete file + drop the `v_conversation_hub`
  wrangler binding) that breaks deploys if done wrong → **needs explicit confirmation** before executing
  (autonomous-engineering approval tier). The safe procedure is documented in the TODO comment itself.

## Removed 2026-09-22 (see README § Roadmap for the parked-initiative notes)

- Deleted non-core side-projects: `apps/chrome-extension`, `apps/desktop` (Tauri),
  `apps/mobile` (Capacitor), `apps/analytics-ingest`, `apps/project-sites/capacitor`,
  `packages/sdk`, `packages/psctl`, `packages/mcp-server`.
- Deleted 2,826 accidentally-committed Playwright trace files (`apps/project-sites/tr-fj*`),
  stale-tracked e2e screenshots, and ~80 root-level QA scratch images + reports.
