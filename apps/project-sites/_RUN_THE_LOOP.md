# Run The Loop — consolidated work queue

> Single source of truth for the `/run-the-loop` command. Every pending workstream + its
> next unmet unit + authoritative ledger + stop condition. The command reads THIS file,
> advances the next unmet unit of each ACTIVE workstream (fan out), verifies, deploys,
> commits to `main`, and ticks it here. Granular state lives in each workstream's linked
> ledger — this file is the INDEX, never a duplicate (drift-detection: no parallel truths).
>
> Replaces the 5 recurring loop crons (removed 2026-09-28). "Run the loop" is now a
> deliberate, on-demand fire, not a cron.

## How the command uses this
- Pick every workstream marked **ACTIVE**. For each, do its **Next** unit (one slice/fire).
- Fan out one fresh **worktree-isolated** agent per workstream (they touch disjoint subtrees).
- Verify → deploy (verification-loop) → prod-verify → commit+push `main` → tick here + the ledger.
- Move a workstream to **§ Done** only when its **Acceptance** is fully met.

---

## Active workstreams

### 1. Promote-workflow — editor Preview → Promote → Production  · ACTIVE
- **Ledger:** `apps/project-sites/_PROMOTE_WORKFLOW_CHECKPOINT.md`
- **Status:** Slices 1–4 shipped — per-site D1 CRUD · Git tab retired · durable-preview worker model (migration `0646`, `libs/features/durable_preview/`, flag `durable_preview` DARK) · editor Source Control view.
- **Next:** Slice 5 — cyan **Promote** header button (exact label) + freeze-Preview → commit-`main` → deploy-Production transaction; idempotent; commit-ok/deploy-failed + safe-retry states; Production always shows the SHA actually serving.
- **Then:** Slice 6 — final wiring + consolidate the checkpoint into normal docs; remove any dead Git-tab refs.
- **External:** apply migration `0646_durable_preview_model.sql` to prod D1 (additive/idempotent, flag DARK); real-browser header VQA on an `app/` Pages deploy.
- **Acceptance:** one cyan Promote button ships the frozen Preview revision to Production idempotently; Production shows the serving SHA/snapshot; no dead Git-tab refs; checkpoint consolidated into normal docs.
- **Invariants:** save/generate → Preview only (no commit, no Production change); Production only via authorized Promote; editor always presents `main`; promoted bytes come from the frozen Preview revision (compare source+artifact digests); code snapshots ≠ D1/KV/R2/DO snapshots; never force-push `main`.

### 2. WfP site-hosting (flag `site_wfp_hosting`, default OFF)  · ACTIVE
- **Doc:** `apps/project-sites/docs/wfp-site-hosting.md`
- **Status:** Units 1–5 shipped — flag · `deploySiteToWfp` · `serveSiteViaWfpIfPreferred` (dispatch preference, `x-ps-serve: wfp`) · lifecycle wiring · teardown (`teardownSiteWfp` + `clearSiteWfpRegistry`, wired into delete/archive/takedown).
- **Next:** Unit 6 — admin Angular/Spartan Hosting surface: status pill · preview+prod URLs · Publish/Promote action · empty/loading/error/success. Nothing built-but-unwired.
- **Then:** acceptance styled-200-via-dispatch prod-verify — flip flag on for a test site (`4f450690-e622-4c95-a83d-e5516a2c9442`), trigger an in-Worker deploy, WebFetch → assert `x-ps-serve: wfp` + styled 200.
- **External blocker:** `CF_API_TOKEN` `10405` ("Method not allowed for this authentication scheme") on the Static-Assets upload-session — WfP slots deploy only from INSIDE the Worker (Unit 6 admin action / re-publish), not external CF-API. Resolve token scope OR trigger via the in-Worker action Unit 6 adds.
- **Acceptance:** the doc's Acceptance section fully met; `serveSiteFromR2` byte-identical when flag off; fail-soft to R2.

### 3. Editor Database-tab enhancement  · ACTIVE
- **Doc:** `apps/project-sites/docs/database-tab-enhancements.md`
- **Status:** shipped — cell click-to-copy · Actions dropdown · History = "Create snapshot" · advanced cross-table search (`/db/search`) · minute-granular time-travel scrubber.
- **Next:** the 10 progressive gorgeous + functional revisions (one measurable visual+functional upgrade per fire) + the remaining 15 ideas in the doc's priority order: rowid editing → empty-state launchpad → schema rail → result→chart → ⌘K global search → field types → data-profile → ERD → views → query rail → AI-explain → bulk edit → KV → activity.
- **Acceptance:** 10 revisions done + top ideas shipped; each verified live + deployed.

### 4. Admin visual QA (continuous)  · ACTIVE
- **Ledger:** `apps/project-sites/_ADMIN_VQA_LEDGER.md`  · recipe: memory `local-admin-visual-sweep-recipe`
- **Status:** continuous visual + technical + functional scan of the admin dashboard (screenshots + image recognition).
- **Next:** one screenshot-driven sweep → fix/improve/add components (visual + technical + functional); every fire leaves the surface gorgeous-er AND more effortless.
- **Acceptance:** maintenance-only — never terminally "done"; a healthy no-op fire is correct once nothing improves.

### 5. Interconnectedness (no orphan / everything reachable)  · ACTIVE
- **Ledger:** `apps/project-sites/_INTERCONNECTEDNESS_LEDGER.md`  · detector: `scripts/detect-orphans.mjs`
- **Status:** ensure every major code block is represented + reachable in the UI (no built-but-unwired feature).
- **Next:** run the orphan sweep → wire the highest-value orphaned unit into a reachable surface the same fire.
- **Acceptance:** zero orphaned major units; detector green.

---

## Standing scope (address opportunistically, or when a workstream touches it)
- Apply migration `0646` to prod D1 (additive/idempotent, flag DARK) — full-visibility run, not a saturated-context blind apply.
- Cold-provision fix in `src/services/d1_provisioner.ts` — idempotent create + await readiness (brand-new site's first `/db/query` CREATEs currently race).
- Preview loading UX (Msg-3b remainder): mirror the preview-boot message into the editor CHAT + the AI-ensures-boot backend (`app/components/workbench/Preview.tsx`).
- Architecture (root `TODO.md`): editor `app/` → `apps/editor/`; resolve or retire the `apps/web` v2 plan; decide Electron desktop packaging; prune leftover `.claude/worktrees/agent-*`; regenerate lockfile.

## Brian-gated (approval-required — ship the decision-independent slice, never auto-execute)
- **ConversationHub DO deletion** (`apps/project-sites/src/index.ts:217`) — destructive one-way-door DO migration (`deleted_classes`); date guard passed but needs explicit confirmation before executing.

## Deeper machine (reference — not duplicated here)
- `.claude/loop.md` + `apps/project-sites/_APP_COMPLETION.md` — the whole-app Definition of Done + the 6-loop convergence roster. `/run-the-loop` advances the active frontier above; the DoD machine is the exhaustive backstop for total app completion.

---

## Done
_(move workstreams here when Acceptance is fully met — with the closing commit SHA + prod proof)_
