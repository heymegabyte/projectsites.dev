---
description: Advance every active ProjectSites workstream by one verified slice — reads root _LOOP.md (master: mission/protocol/lanes/tasks) + apps/project-sites/_RUN_THE_LOOP.md (live queue), fans out fresh worktree-isolated agents, verifies, deploys, prod-verifies, commits to main, ticks the queue. EVERY fire runs a STANDING MULTI-PHASE roster — discovery/audit agents that research + audit the repo and GENERATE the next wave's components/features, plus product/docs, browser/test, misc/integration, and coding agents — so the loop replenishes its own backlog instead of draining a static queue. Fires when Brian says "run the loop".
argument-hint: "[workstream name/number, or 'all' (default)]"
---

# Run The Loop

One deliberate fire of the ProjectSites convergence loop. Advance the **next unmet unit** of each ACTIVE workstream in `apps/project-sites/_RUN_THE_LOOP.md` (default `all`; or just `$ARGUMENTS`). **One coherent slice per workstream per fire** — never split across follow-ups; never start a large pass in a context-saturated session.

**Every fire is a MULTI-PHASE wave, never just queue-draining.** A standing DISCOVERY/AUDIT phase (research + repo + runtime audit that GENERATES the next wave's components/features) runs ALONGSIDE product/docs, browser/test, misc/integration, and coding agents — so the loop continuously replenishes its own backlog. If a fire generates zero new next-wave tasks, the discovery agent under-scanned.

## 0 — Orient (cheap; NEVER read giant ledgers in the main thread)
- Read root **`_LOOP.md`** — the MASTER: prime directive · one-fire protocol · invariants · the 11-lane roster · the task collection by dimension (§4). Then read `apps/project-sites/_RUN_THE_LOOP.md` — the LIVE QUEUE (each workstream's Next unit + ledger + acceptance). `_LOOP.md` is the mission; `_RUN_THE_LOOP.md` is the current state.
- `git fetch origin main -q && git pull --rebase origin main` — a concurrent session may have progressed work; re-inspect the ACTUAL repo, never assume a prior attempt landed.
- Do NOT read `_LOOP_LEDGER.md` / `_APP_COMPLETION.md` / `.claude/loop.md` wholesale in the main thread (context thrash). Delegate any deep inventory read to a fresh `Explore` agent with a ≤150-line output cap; hold conclusions only.

## 1 — Fan out the STANDING MULTI-PHASE ROSTER (EVERY fire, in ONE message)
Every fire spawns these roles together in ONE message — fresh, worktree-isolated (mutating) or read-only (research) — on disjoint subtrees (editor `app/`, worker `apps/project-sites/src`, Angular `frontend`). Keep ≥1 coding agent active whenever ready work exists; ≤6-wide for mutating agents (read-only sweeps are free + uncapped).

- **Discovery / audit (STANDING — ≥1 EVERY fire):** a fresh read-only `Explore`/`general-purpose` agent scans a BOUNDED, previously-uncovered slice of repo + runtime (rotate the area each fire — comments, docs, `TODO`/`FIXME`/`HACK`, partial/unwired UI, drift, orphans via `scripts/detect-orphans.mjs`, real user journeys, competitor gaps) AND **GENERATES the NEXT wave**: deduplicated, evidence-backed new components/features/fixes/misc-tasks APPENDED to `apps/project-sites/_RUN_THE_LOOP.md` (never duplicate an existing queue item or a recurring TODO). This is what keeps the queue from ever running dry.
- **Product / docs:** reconciles requirements, updates the route/journey coverage matrix + `_RUN_THE_LOOP.md`, proposes improvements at platform/journey/screen/component/state levels → also feeds next-wave tasks.
- **Browser / test:** runs the current golden paths against PROD (real UI, real backend — never mocks), captures functional + visual + a11y defects with reproducible steps → files them as NEW queue tasks; expands coverage for anything shipped.
- **Misc / integration:** shared contracts, type errors, CI, a11y, perf, migrations, observability, and small blockers the lead selects.
- **Coding agents:** take as many independent, high-value, READY queued slices as capacity allows — INCLUDING the ones prior fires' discovery agents generated. ONE coherent slice per agent.

Each brief is self-contained, 150–300 words: its unit · the ONE ledger path to read · reuse-not-reimplement pointers · verify gates · "commit ONLY your paths, NEVER `git add -A`, rebase if push rejected" · "update your ledger + tick/append `_RUN_THE_LOOP.md`". Briefs stay tiny with near-zero exploratory reads — project `CLAUDE.md` is large; an agent told to "go read the app" dies at `subagent_tokens: 0`.

## 2 — Per-workstream discipline (inside each agent)
- **TDD:** failing test FIRST → implement → green. Bug fix = failing regression first.
- **Reuse, don't reimplement** — existing snapshots, git integration, deploy/dispatch, `wfp_dispatch.ts`, the feature-module + flag machinery.
- **Flags:** every new capability behind a default-OFF flag (registry + manifest + docs); server returns 404 when off; UI returns null.
- **IDOR:** `assertSiteOwned` on any new `/api/sites/:siteId/...` handler.
- **Invariants:** honor each workstream's invariants from the queue (esp. Promote — Preview-only saves, Production only via authorized Promote, promoted bytes from the frozen revision, never force-push `main`).

## 3 — Verify (green BEFORE commit — verification-loop; no claim without fresh output)
- Worker: `cd apps/project-sites && npx tsc --noEmit && npx jest <touched>` (broaden if fast) + `npm run validate:features`.
- Editor (`app/`): typecheck + `npm test` (Vitest).
- Frontend (`frontend/`): `npx tsc --noEmit -p tsconfig.app.json` + `ng build` for any UI slice.

## 4 — Ship (prod pre-authorized per brian-preferences + verification-loop)
- Commit each slice to **`main`** (conventional commit) + push (rebase if rejected). Main-only; delete each worktree + branch the moment its work lands.
- Deploy the changed surface: worker `npm run deploy:production` (Docker + creds) · editor Pages `wrangler pages deploy build/client --project-name=bolt-diy --branch=main --commit-dirty=true` · frontend `npm run deploy:production` (R2). A concurrent dirty tree blocks local wrangler → the push→CI pipeline is the deploy path.
- **Prod-verify the changed routes** (curl / Playwright / WebFetch) — a local pass is NEVER sufficient. Assert the change live: WfP → `x-ps-serve: wfp` + styled 200; Promote → Production serving SHA; DB → styled 200; admin → real-browser click-around.

## 5 — Reconcile + report
- Tick each advanced unit in `apps/project-sites/_RUN_THE_LOOP.md` + its ledger with the commit SHA + prod proof. Move a workstream to § Done only when Acceptance is fully met.
- **Fold in the discovery output — replenish the queue:** append the discovery/audit + product/docs + browser/test agents' newly-found, DEDUPLICATED tasks (new components/features/fixes/misc) to `apps/project-sites/_RUN_THE_LOOP.md` so the NEXT fire has ready work. The queue must never run dry; a fire that appends zero next-wave tasks means the discovery agent under-scanned that area — rotate to a fresh area next fire.
- Report per `always.md`: Changes · Next unmet unit per workstream · external blockers · Recs (only genuine >2h / design-call / blocked items — ship everything else inline).

## Discipline (non-negotiable)
- One coherent slice per workstream per fire; fan out for independence; the main thread orchestrates + folds + **deploys once** + verifies — agents never deploy independently.
- **Delegate-when-saturated:** if the main thread is context-heavy, the fresh agents do the heavy pass while the main thread stays lean. **HARD STOP + fresh session** on autocompact thrash / "prompt too long" / `subagent_tokens: 0` — never retry in place.
- **`.gitignore` blocks `*.md`** → `git add -f` for queue / ledger / doc updates.
- Brian-gated items (queue § Brian-gated) → ship the decision-independent slice, never auto-execute the destructive action.
- A workstream is DONE only when Acceptance passes + its ledger is consolidated + no dead refs remain.
