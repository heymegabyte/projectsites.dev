---
description: One verified fire of the ProjectSites convergence loop. Reads the canonical home under /.claude/run-the-loop/ (README · OPERATING-PRINCIPLES · BACKLOG · LEDGER · DISCOVERIES · ARCHITECTURE), fans out 15 named worktree-isolated roles (+ dynamic roles) under a category budget, runs a convergence + adversarial-review phase, generates LONG 30-50+ action golden-path journeys that build-diagnose-fix-continue, verifies + deploys + prod-verifies, commits to main, advances the BACKLOG frontier, and leaves ≥1 loop self-improvement. Fires when Brian says "run the loop".
argument-hint: "[role/lane name, category, or 'all' (default)]"
---

# Run The Loop

One deliberate fire of the ProjectSites convergence loop. Advance the **frontier** in
`.claude/run-the-loop/BACKLOG.md` by one coherent, verified slice per active workstream (default
`all`; or scope to `$ARGUMENTS`). **One coherent slice per role per fire** — never split a slice
across follow-ups; never start a large pass in a context-saturated session.

**Every fire is a MULTI-PHASE wave, never queue-draining.** A standing roster of 15 named roles
(fan-out) runs in ONE message, followed by a **convergence phase** (normalize) and an
**adversarial-review phase** (hunt regressions). The loop replenishes its own backlog — Product
Discovery + the audit roles GENERATE the next wave — and **every cycle leaves ≥1 improvement to how
future loops operate** (§7). A fire that appends zero next-wave items OR zero loop-improvement means
a role under-delivered.

## 0 — Orient (cheap; NEVER read giant ledgers in the main thread)
- **Canonical home = `.claude/run-the-loop/`.** Read the small operator docs, in order:
  - `README.md` — what the loop is + how to run one fire.
  - `OPERATING-PRINCIPLES.md` — invariants, gates, the 4 canonical answers (§below), the category budget.
  - `BACKLOG.md` — the **frontier** (next unmet unit per workstream + acceptance). This is what you advance.
  - `ARCHITECTURE.md` — the CF-native shape + load-bearing decisions.
  - `DISCOVERIES.md` + `LEDGER.md` — append-only; the main thread does NOT read these wholesale (delegate any deep read to a fresh `Explore` agent, ≤150-line output cap). LEDGER is where completed slices + SHAs land.
  - The retired `_LOOP.md` / `apps/project-sites/_RUN_THE_LOOP.md` are being folded into these — prefer the canonical home; only fall back to a legacy file if the canonical one is absent.
- `git fetch origin main -q && git pull --rebase origin main` — a concurrent session may have progressed work; re-inspect the ACTUAL repo, never assume a prior attempt landed.
- **Context budget (per `monitor-orchestration` § context thrash):** the main thread holds conclusions only. Never ingest `_LOOP_LEDGER.md` / `SCOPE.md` / `DECISIONS.md` / subagent `.output` transcripts — the `guard-oversized-read.py` hook will block oversized reads; heed it. HARD STOP + fresh session on autocompact thrash / "prompt too long" / `subagent_tokens: 0`.

## The 4 canonical answers (BAKED IN — init-gate satisfied 2026-09-29, DO NOT re-ask)
These are settled. Never re-prompt Brian for them; they govern every fire.
1. **Priority journey = the money path** — `search → sign in → AI build → view live → edit → publish`. Every fire keeps this path green + gorgeous + embarrassingly easy first; other work is secondary.
2. **WfP = the DEFAULT serving path** — new sites are born on Workers-for-Platforms preview + prod; serving is WfP unless a slice explicitly proves otherwise. Verify with `x-ps-serve: wfp` + styled 200.
3. **Autonomy = FULL on reversible prod actions** — flag rollout/promotion, `strict` flip, ADDITIVE D1 migrations, and `wrangler deploy` are all standing-authorized (per `brian-preferences` § prod pre-authorized). Ship them the same fire when green; never hold as "committed but dark."
4. **Pause ONLY for destructive/irreversible** — dropping columns/tables, bulk customer mutation, secret rotation, real mass outreach, billing/pricing changes, one-way-door architecture. Everything else is yours to drive to done.

## 1 — Fan out the 15 NAMED ROLES (+ dynamic roles) — EVERY fire, in ONE message
Spawn the roster together in ONE message — fresh, worktree-isolated (mutating) or read-only
(research) — on disjoint subtrees (editor `app/`, worker `apps/project-sites/src`, Angular
`frontend/`, docs). Keep ≥1 coding role active whenever ready work exists. **≤6 concurrent mutating
agents** per `parallel-subagent-economy` (read-only sweeps are free + uncapped; run >6 units as
sequential waves of ≤6). Each role maps to the best-fit specialist per `agent-selection` — NEVER a
bare `general-purpose` when a named specialist fits. Emit the assignment table + rejected-agent note
BEFORE spawning; run the Agent Diversity Review gate before DONE.

**The 15 canonical roles:**
1. **Feature Delivery** — take a READY frontier slice (incl. ones prior fires generated); ONE coherent slice end-to-end (schema + handler + UI + tests + flag + docs). Specialist: `general-purpose`/`migration-agent`/domain builder.
2. **Product Discovery** — reconcile the money path + route/journey coverage; propose platform/journey/screen/component/state improvements; GENERATE next-wave `BACKLOG.md` items. Specialist: `architect`/`content-writer`.
3. **Unit/Integration Testing** — TDD units + integration for shipped + at-risk code; close coverage gaps. Specialist: `test-writer`.
4. **Golden-Path E2E** — the LONG-journey engine (§6): 30-50+ action journeys against PROD, real UI + real backend, build-diagnose-fix-continue. Specialist: `test-writer`/`deploy-verifier`.
5. **UX/Visual** — screenshot the money path @ 6bp, AI-vision ≥8/10, brand tokens, `embarrassingly-easy-to-use` gate. Specialist: `visual-qa`.
6. **Architecture** — drift sweep (`scripts/validate-feature-drift.mjs`, orphans via `scripts/detect-orphans.mjs`), feature-module coherence, one-way-door ADRs. Specialist: `architect`.
7. **Repository Compression** — dead-weight in code: consolidate dupes, thin fat modules (`inverted-abstraction-pyramid`), shrink bundles. Specialist: `code-simplifier`.
8. **Documentation** — keep CLAUDE.md + `docs/` + `README` + `e2e/FEATURES.md` truthful to shipped reality; ADRs for decisions. Specialist: `content-writer`.
9. **Doc Compression** — compress verbose docs losslessly (`instruction-compression-playbook`); retire stale/duplicate docs into the canonical home. Specialist: `content-writer`.
10. **Dead-Code/Hygiene** — `knip`/`ts-prune` + unused deps + `console.log` + resolvable TODOs; verify-then-remove (`knip-unused-not-always-dead`). Specialist: `dead-code-remover`/`code-simplifier`.
11. **Performance** — Lighthouse + CWV (LCP≤2.0s/CLS≤0.05/INP≤100ms), bundle budgets, N+1 waterfalls. Specialist: `performance-profiler`.
12. **Security** — OWASP + IDOR (`assertSiteOwned`), CSP, secrets, supply chain, SSRF. Specialist: `security-reviewer` (Opus-pinned).
13. **Accessibility** — axe 0 @ 6bp + the 8 manual WCAG 2.2 AA criteria. Specialist: `accessibility-auditor`.
14. **Technology Scout** — verify stack currency + surface higher-leverage CF-native primitives / library upgrades (Context7/WebSearch); file adoption slices. Specialist: `dependency-auditor`/`Explore`.
15. **Loop Improvement** — deliver the mandatory ≥1 improvement to how future loops run (§7): sharpen this command, the canonical docs, a gate/script, or a role brief. Specialist: `general-purpose`/`meta-orchestrator`.

**Dynamic role creation** — when a fire surfaces a concern no canonical role owns (a new integration,
a recurring incident class, a migration campaign), MINT a purpose-built role for it that fire: name it,
give it scope + a specialist + acceptance, and record it in `LEDGER.md`. If it recurs, promote it into
this roster via the Loop Improvement role. Roles serve the work — the list is a floor, not a ceiling.

Each brief is self-contained, 150–300 words: its slice · the ONE canonical doc path to read
(`BACKLOG.md` frontier + at most one section) · reuse-not-reimplement pointers · verify gates ·
"commit ONLY your paths, NEVER `git add -A`, rebase if push rejected" · "tick your `BACKLOG.md` line +
append `LEDGER.md`/`DISCOVERIES.md`". Write the primary deliverable FIRST (`agent-resilience-discipline`
Pattern A). Briefs stay tiny with near-zero exploratory reads — project `CLAUDE.md` is large; an agent
told to "go read the app" dies at `subagent_tokens: 0`.

## 2 — Category budget (prevent starvation, NOT rigid quotas)
Across a fire's spawned roles (and across recent fires), keep the mix roughly within these bands.
They exist to stop any category from starving — a fire may deviate for a genuine reason, but the
loop over ~3-5 fires should trend into the bands. Rotate roles fire-to-fire so nothing rots.
- **Product / bug fixes** — 30-45% (Feature Delivery + money-path bug slices lead every fire).
- **Testing / golden paths** — 15-25% (Unit/Integration + the LONG golden-path engine).
- **Architecture** — 10-20% (drift, modules, ADRs, orphans).
- **UX / a11y** — 5-15% (Visual QA + Accessibility).
- **Cleanup** — 5-15% (Repository Compression + Dead-Code/Hygiene + Performance).
- **Docs** — 5-10% (Documentation + Doc Compression).
- **Discovery** — 5-10% (Product Discovery + Technology Scout — the backlog replenishers).
- **Loop-improvement** — 5% (the standing ≥1 improvement, §7).

If a category has starved across the last few fires, the lead over-weights it THIS fire (spawn its
role even if the frontier didn't surface it) until the mix rebalances.

## 3 — Per-role discipline (inside each agent)
- **TDD:** failing test FIRST → implement → green. Bug fix = failing regression first.
- **Reuse, don't reimplement** — existing snapshots, git integration, deploy/dispatch, `wfp_dispatch.ts`, the feature-module + flag machinery, `DialogShellComponent`, `AdminStateService`.
- **Flags:** every new capability behind a default-OFF flag (registry + manifest + docs); server returns 404 when off; UI returns null.
- **IDOR:** `assertSiteOwned` on any new `/api/sites/:siteId/...` handler.
- **Invariants:** honor `OPERATING-PRINCIPLES.md` — WfP-default serving, Promote/Preview-only saves, promoted bytes from the frozen revision, additive-only migrations, never force-push `main`.

## 4 — Convergence phase (AFTER fan-out — normalize before review)
Once the fan-out slices land in the main thread, run ONE convergence agent (or the main thread
itself when lean) to make the merged whole coherent:
- Normalize patterns across the merged slices (shared contracts, naming, error envelopes, brand tokens) so parallel work doesn't drift apart.
- Run the full fast gate suite (typecheck + touched tests + `npm run lint` + `validate:features`) across the union of changes; fix conflicts + lint/type drift in-thread.
- **Update `LEDGER.md`** — one line per advanced slice with the commit SHA + prod proof; tick each advanced `BACKLOG.md` frontier line.
- Fold every role's newly-found, DEDUPLICATED items into `BACKLOG.md` (Product Discovery + Technology Scout + Golden-Path lead the replenish) so the NEXT fire has ready work.

## 5 — Adversarial-review phase (hunt regressions the fan-out introduced)
After convergence, spawn ONE adversarial reviewer whose ONLY job is to try to BREAK the merged
result — the assumption is that parallel slices introduced a regression:
- Re-run the money-path golden journey end-to-end; assert nothing upstream broke (auth, build, view-live, edit, publish).
- Diff-review for: contract drift between slices, a flag left on, an IDOR on a new `:siteId` route, a swallowed error, a soft-404, a lying-empty surface (reconcile display-vs-store per `verify-against-source-of-truth`), a fix inert behind a false precondition.
- Any regression found → fix-forward in the main thread or ONE targeted agent (never re-fan-out for repair). Re-verify before shipping.
- The reviewer is Opus-pinned when the merged change touches auth/payments/security (`parallel-subagent-economy`).

## 6 — ⭐ Golden-Path Engine: LONG build-diagnose-fix journeys (Brian's explicit instruction)
The Golden-Path E2E role does NOT write short happy paths. It generates **LONG journeys of 30-50+ UI
actions that emulate a developer building a real app** — proceeding deep into a flow, hitting an error
mid-journey (~click 30-50), diagnosing + fixing it via TDD, then CONTINUING the journey to completion.
This is the loop's primary way of finding + fixing real defects.

**The engine's per-journey contract:**
- **Start at the homepage**, navigate by UI actions ONLY (clicks/keyboard/real forms) — never `page.goto()` after the initial load. Real UI + real backend, NEVER mocks (`feedback_loop_verifies_real_flows_not_programs`).
- **Go LONG (30-50+ actions):** chain many real steps deep into a flow — don't stop at first success. Assert visible content + console-error-free + axe-clean at each meaningful step; screenshot every step to `e2e/screenshots/{journey}/{step}.png`.
- **Hit an error mid-journey (~click 30-50):** either a naturally-surfacing defect OR a deliberately deep/edge interaction that exposes one. When it fires, PAUSE the journey and switch to TDD repair.
- **Diagnose + fix via TDD (`test-repair-loop`):** reproduce → encode the expected behavior as a failing test → fix the root cause (never suppress) → rerun the test green → verify visually (screenshot/AI-vision) → keep/extend coverage for the class.
- **CONTINUE the journey to completion** after the fix — prove the whole path works end-to-end, not just up to the break.
- **Vary journeys each cycle** — pick a DIFFERENT slice of routes / controls / features / APIs / roles every fire (money path, editor Data/Functions tabs, admin sections, WfP deploy, domain attach, billing, super-admin). Record which journey ran in `LEDGER.md` so the next fire varies.

**≥2 example long journeys (rotate + adapt — these are seeds, not the only two):**

- **Journey A — "Owner builds + ships a site" (money path, ~35-45 actions):**
  homepage → search a business → sign in (mock user) → pick the found business → start AI build → watch
  generation stream → open the editor → Code view: browse files → edit hero copy → Data tab: create a
  table + add a row → Functions tab: add an endpoint → Preview → **error surfaces (~click ~32, e.g. a
  Data-tab per-site D1 read hitting the shared DB, or a Preview iso-git/R2 skew)** → reproduce in a
  failing spec → fix the root cause → rerun green → screenshot the fixed Preview → back to editor →
  Promote/publish → **view live** (assert `x-ps-serve: wfp` + styled 200 + H1) → attach/confirm domain
  → re-verify live. Continue past the break to a published, live site.

- **Journey B — "Admin + super-admin operations" (~30-40 actions):**
  homepage → sign in → admin dashboard → Sites list → open a site → Analytics (reconcile display-vs-store:
  assert the count matches D1 ground truth, catch a lying-empty) → Feature Flags: toggle a flag + dial
  rollout → Domains: attach a hostname → Resources › Advanced: watch the live CF-resource inventory (no
  manual Refresh button — `real-time-data-no-manual-refresh`) → **error surfaces (~click ~34, e.g. a
  flag-off frontend not matching the worker 404, or a settings write landing in the wrong table)** →
  reproduce → failing test → fix → green → visual verify → continue → super-admin: service-status widget →
  billing/credits (Cloudflare unified billing) → confirm the whole operator flow works end-to-end.

## 7 — Loop self-improvement mandate (≥1 EVERY cycle)
Every fire MUST leave the loop measurably better at running future fires — this is non-negotiable and
owned by the Loop Improvement role (but any role may contribute). Pick at least ONE:
- Sharpen THIS command (a clearer phase, a fixed gap a re-prompt revealed, a better role brief).
- Improve a canonical doc (`OPERATING-PRINCIPLES`, `BACKLOG` hygiene, `ARCHITECTURE`, `README`).
- Harden a gate/script (a new drift/orphan/reconcile check, a faster verify, a golden-path helper).
- Retire a recurring shortcoming: append it to `monitor-orchestration.md` § Known shortcomings and add the rule/gate that prevents it (per `prompt-as-training-signal` — a re-prompt on the same surface is a prediction miss; capture it THE SAME FIRE).
- Promote a proven dynamic role into the §1 roster, or rebalance the §2 category budget from observed starvation.
A fire that ships zero loop-improvement under-delivered — surface why in the report and do it next fire first.

## 8 — Verify (green BEFORE commit — verification-loop; no claim without fresh output)
- Worker: `cd apps/project-sites && npx tsc --noEmit && npx jest <touched>` (broaden if fast) + `npm run validate:features`.
- Editor (`app/`): typecheck + `npm test` (Vitest).
- Frontend (`frontend/`): `npx tsc --noEmit -p tsconfig.app.json` + `ng build` for any UI slice.
- Claim ONLY what you ran THIS fire — paste the command output; a prior run or "looks correct" is not evidence.

## 9 — Ship (prod pre-authorized per brian-preferences + verification-loop + canonical answer #3)
- Commit each slice to **`main`** (conventional commit) + push (rebase if rejected). Main-only; delete each worktree + branch the moment its work lands (`main-only-branch` — cleanup is NOT automatic).
- Deploy the changed surface: worker `cd apps/project-sites && npx wrangler deploy --env production` (Docker + creds; `--env production` mandatory) · editor Pages `wrangler pages deploy build/client --project-name=bolt-diy --branch=main --commit-dirty=true` · frontend `npm run deploy:production` (R2). A concurrent dirty tree blocks local wrangler → the push→CI pipeline is the deploy path.
- **Prod-verify the changed routes** (curl / Playwright / WebFetch) — a local pass is NEVER sufficient. Assert the change live: WfP → `x-ps-serve: wfp` + styled 200; Promote → Production serving SHA; DB → styled 200; admin → real-browser click-around. Reconcile data surfaces display-vs-store, never render-alone (`verify-against-source-of-truth`).

## 10 — Reconcile + report
- Tick each advanced frontier line in `BACKLOG.md` + append `LEDGER.md` with the commit SHA + prod proof. Move a workstream to § Done only when Acceptance is fully met.
- **Replenish the backlog:** append the DEDUPLICATED next-wave items (Product Discovery + Technology Scout + Golden-Path findings + the adversarial reviewer's fresh defects) to `BACKLOG.md` so the NEXT fire has ready work. A fire that appends zero next-wave items means a discovery role under-scanned — rotate area next fire.
- **Confirm the ≥1 loop-improvement landed** (§7) and name it in the report.
- Report per `always.md`: Changes · Next unmet unit per workstream · which golden journey ran + what it fixed · external blockers · Recs (only genuine >2h / design-call / destructive-decision items — ship everything else inline).

## Discipline (non-negotiable)
- One coherent slice per role per fire; fan out for independence; the main thread orchestrates + converges + reviews + **deploys once** + verifies — agents never deploy independently.
- **Delegate-when-saturated:** if the main thread is context-heavy, the fresh agents do the heavy pass while the main thread stays lean. **HARD STOP + fresh session** on autocompact thrash / "prompt too long" / `subagent_tokens: 0` — never retry in place.
- **`.gitignore` blocks `*.md`** → `git add -f` for canonical-home / backlog / ledger / doc updates.
- Destructive/irreversible actions (canonical answer #4) → ship the decision-independent slice, never auto-execute the destructive action.
- A workstream is DONE only when Acceptance passes + `LEDGER.md` records it + no dead refs remain.
