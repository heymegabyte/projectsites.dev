---
description: One verified fire of the ProjectSites convergence loop. Claims the fire-lease mutex (overlapping scheduled fires coalesce, never collide), reads the canonical home under /.claude/run-the-loop/ (README · OPERATING-PRINCIPLES · BACKLOG · LEDGER · DISCOVERIES · ARCHITECTURE), fans out the named worktree-isolated roster (15 rotating + 2 STANDING — Long-Trail TDD §1.16 + Deep UI Explorer/Visual Intelligence §1.17 — + the every-2-fires Template Evolution lane §1.18 + dynamic roles) under a category budget, runs a convergence + adversarial-review phase, generates LONG 30-50+ action golden-path journeys that build-diagnose-fix-continue, verifies + deploys + prod-verifies, commits to main, advances the BACKLOG frontier, and leaves ≥1 loop self-improvement. Fires when Brian says "run the loop".
argument-hint: "[role/lane name, category, or 'all' (default)]"
---

# Run The Loop

> **🔁 SELF-ARMING SCHEDULER (Brian directive 2026-10-01 — do this FIRST, every invocation).**
> `/run-the-loop` means CONTINUOUS operation, not one fire. **Scheduler of record = macOS
> launchd**: `~/Library/LaunchAgents/space.megabyte.projectsites.run-the-loop.plist` runs
> headless `claude -p "/run-the-loop"` every 900s (log: `.claude/run-the-loop/cron-runs.log`;
> verify: `launchctl list | grep run-the-loop`; re-load: `launchctl bootstrap gui/501 <plist>`).
> The in-session harness cron is BELT-AND-SUSPENDERS ONLY — it silently skipped 7 straight
> ticks on 2026-10-01 (12:34–2:04 PM) while armed+durable; never rely on it alone.
> Per invocation: (1) `CronList` — if no recurring
> `/run-the-loop` job exists, `CronCreate` cron `4,19,34,49 * * * *` (15-min cadence),
> `durable: true` (harness auto-expires recurring jobs after ~7 days — this self-arm step IS
> the re-arm); (2) then run ONE fire per this file. Overlapping ticks coalesce via the fire
> lease (exit 3 = a live fire holds it → end the tick silently). Never end an invocation
> with no armed cron.

> **⚖️ GOVERNED BY `.claude/run-the-loop/CONSTITUTION.md` (fire-59, 2026-09-30).**
> The Autonomous Visual Product Organization constitution supersedes this file wherever they
> conflict: optimize VERIFIED HUMAN DELIGHT × CAPABILITY × COMPLETENESS × BUSINESS VALUE ×
> LEARNING RATE; run the constitution's 15-minute-heartbeat stages (ORIENT → LOOK → EXPERIENCE →
> MEASURE → RESEARCH → IMAGINE → PRIORITIZE → PLAN → FAN OUT → BUILD → RENDER → ITERATE VISUALLY →
> TEST → EXPLORE → EVALUATE → REPAIR → SIMPLIFY → VERIFY → LEARN → META-IMPROVE → COMPRESS → HAND
> OFF); visual inspection IS implementation; every cycle touches reality AND learns. What REMAINS
> binding from this file: the fire-lease mutex (§0), worker-vs-lead failure taxonomy, worktree
> isolation, category budgets, deploy + prod-verify gates, LEDGER close-out. Standing artifacts
> live beside the constitution: `GENOME.md` · `GOLDEN-PATHS.md` · `VISUAL-COVERAGE.md` ·
> `BROWSER-OPERATING-LAYER.md`.

One deliberate fire of the ProjectSites convergence loop. Advance the **frontier** in
`.claude/run-the-loop/BACKLOG.md` by one coherent, verified slice per active workstream (default
`all`; or scope to `$ARGUMENTS`). **One coherent slice per role per fire** — never split a slice
across follow-ups; never start a large pass in a context-saturated session.

**Every fire is a MULTI-PHASE wave, never queue-draining.** A roster of 15 rotating named roles
plus 1 STANDING role — the **Long-Trail TDD case-owner** (§1.16), which runs EVERY cycle and grinds
ONE checkpointed long browser case to completion — (fan-out) runs in ONE message, followed by a
**convergence phase** (normalize) and an
**adversarial-review phase** (hunt regressions). The loop replenishes its own backlog — Product
Discovery + the audit roles GENERATE the next wave — and **every cycle leaves ≥1 improvement to how
future loops operate** (§7). A fire that appends zero next-wave items OR zero loop-improvement means
a role under-delivered.

## 0 — Orient (cheap; NEVER read giant ledgers in the main thread)
- **Claim the fire lease FIRST — fires are mutually exclusive.** `node scripts/loop-fire-lock.mjs claim fire-<n>-<slug>` — exit 3 = a LIVE fire holds the lease → COALESCE: end this tick immediately (the running fire is already advancing the same backlog); a STALE lease (heartbeat >20 min — the prior lead died) is auto-reclaimed. Refresh with `heartbeat` after each phase; `release` in §10. This is what stops the 15-min scheduler from stacking overlapping browser sessions + conflicting commits.
- **Paths: see OPERATING-PRINCIPLES § Canonical paths** — the do-not-hunt cheatsheet (fire lock, allowlist, explorer, checkpoint, deploy, prod D1). Don't re-discover a file path.
- **Canonical home = `.claude/run-the-loop/`.** Read the small operator docs, in order:
  - `README.md` — what the loop is + how to run one fire.
  - `OPERATING-PRINCIPLES.md` — invariants, gates, the 4 canonical answers (§below), the category budget.
  - `BACKLOG.md` — the **frontier** (next unmet unit per workstream + acceptance). This is what you advance.
  - `ARCHITECTURE.md` — the CF-native shape + load-bearing decisions.
  - `DISCOVERIES.md` + `LEDGER.md` — append-only; the main thread does NOT read these wholesale (delegate any deep read to a fresh `Explore` agent, ≤150-line output cap). LEDGER is where completed slices + SHAs land.
  - The retired `_LOOP.md` / `apps/project-sites/_RUN_THE_LOOP.md` are being folded into these — prefer the canonical home; only fall back to a legacy file if the canonical one is absent.
- `git fetch origin main -q && git pull --rebase origin main` — a concurrent session may have progressed work; re-inspect the ACTUAL repo, never assume a prior attempt landed.
- **Context budget (per `monitor-orchestration` § context thrash):** the main thread holds conclusions only. Never ingest `_LOOP_LEDGER.md` / `SCOPE.md` / `DECISIONS.md` / subagent `.output` transcripts — the `guard-oversized-read.py` hook will block oversized reads; heed it.
- **HARD STOP = LEAD saturation ONLY, never a single agent's transient failure** (per `OPERATING-PRINCIPLES.md` § Failure taxonomy vs HARD-STOP). Checkpoint to `progress.md` + fresh session ONLY when the ORCHESTRATOR hits "Prompt is too long" / an `autocompact thrashing` notice fires on the LEAD / the main thread can't spawn. ONE agent dying on ECONNRESET or returning `subagent_tokens: 0` from a network drop is fan-out ATTRITION → salvage its commit (`git show <branch-tip>` before `git branch -D`), re-queue its slice in `BACKLOG.md`, and KEEP THE LOOP RUNNING. Read WHICH thing failed before checkpointing.

## The 4 canonical answers (BAKED IN — init-gate satisfied 2026-09-29, DO NOT re-ask)
These are settled. Never re-prompt Brian for them; they govern every fire.
1. **Priority journey = the money path** — `search → sign in → AI build → view live → edit → publish`. Every fire keeps this path green + gorgeous + embarrassingly easy first; other work is secondary.
2. **WfP = the DEFAULT serving path** — new sites are born on Workers-for-Platforms preview + prod; serving is WfP unless a slice explicitly proves otherwise. Verify with `x-ps-serve: wfp` + styled 200.
3. **Autonomy = FULL on reversible prod actions** — flag rollout/promotion, `strict` flip, ADDITIVE D1 migrations, and `wrangler deploy` are all standing-authorized (per `brian-preferences` § prod pre-authorized). Ship them the same fire when green; never hold as "committed but dark."
4. **Pause ONLY for destructive/irreversible** — dropping columns/tables, bulk customer mutation, secret rotation, real mass outreach, billing/pricing changes, one-way-door architecture. Everything else is yours to drive to done.

## 1 — Fan out the NAMED ROLES (15 rotating + 2 STANDING + the every-2-fires Template lane + dynamic roles) — EVERY fire, in ONE message
Spawn the roster together in ONE message — fresh, worktree-isolated (mutating) or read-only
(research) — on disjoint subtrees (editor `app/`, worker `apps/project-sites/src`, Angular
`frontend/`, docs). Keep ≥1 coding role active whenever ready work exists. **≤6 concurrent mutating
agents** per `parallel-subagent-economy` (read-only sweeps are free + uncapped; run >6 units as
sequential waves of ≤6). Each role maps to the best-fit specialist per `agent-selection` — NEVER a
bare `general-purpose` when a named specialist fits. Emit the assignment table + rejected-agent note
BEFORE spawning; run the Agent Diversity Review gate before DONE.

**The canonical roles (15 rotating + 2 STANDING + 1 scheduled lane):** roles 1-15 rotate under the §2 category budget; roles 16 (Long-Trail TDD case-owner) and 17 (Deep UI Explorer / Visual Intelligence) are STANDING — they run EVERY cycle and are not subject to rotation; role 18 (Template Evolution) runs every-2-fires.
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
14. **Technology Scout** — verify stack currency + surface higher-leverage CF-native primitives / library upgrades (Context7/WebSearch); file adoption slices. **Carries the Cloudflare Release Scout duty (~every 4 fires):** read the official CF developer-platform + product RSS feeds + deprecations, dedupe by GUID into `.claude/run-the-loop/CF-RELEASES.md` (source + pub date + doc-inspect), and drive every relevant release to an explicit decision — pilot / backlog / watch / reject-with-reason; urgent deprecations come forward immediately; feed outages never block core verification. Also scans browser API/platform changes for role 18's capability registry. Specialist: `dependency-auditor`/`Explore`.
15. **Loop Improvement** — deliver the mandatory ≥1 improvement to how future loops run (§7): sharpen this command, the canonical docs, a gate/script, or a role brief. Specialist: `general-purpose`/`meta-orchestrator`.
16. **Long-Trail TDD case-owner (STANDING — runs EVERY cycle)** — owns ONE checkpointed long browser case per the `long-trail-tdd` skill (`.claude/skills/long-trail-tdd/SKILL.md` — the case-design contract: 60-100 actions, 6+ surfaces, RED-before-fix, screenshot+AI-vision every view, durable checkpoint/resume). Works code+tests+live-browser TOGETHER in an ISOLATED worktree. **PRIORITIZES finishing a checkpointed case before rotating coverage** — it does NOT start a new case while one is `in-progress`. It is distinct from role 4 (Golden-Path E2E generates VARYING journeys each fire); role 16 GRINDS ONE case to completion across fires via checkpoint. Sends real email/SMS ONLY through the fail-closed `apps/project-sites/scripts/recipient-allowlist.mjs` (absent config / unlisted recipient → hard deny). Specialist: `test-writer`/`deploy-verifier`.
    - **No-overlap lease (mandatory — prevents two copies fighting the same case/resources).** The scheduler fires `/run-the-loop` ≥ every 15 min and MAY run back-to-back (next cycle starts the instant the prev finishes), so two case-owner copies can be live at once. Serialize them with a LEASE on the case ID + the test-resource prefix, recorded in the case's checkpoint file: on start, read the checkpoint — if it holds a LIVE lease (`in-progress by <otherRunId>`, `heartbeat` within the last ~20 min), this copy MUST pick a DIFFERENT case (or wait), NEVER touch the leased case's files/resources; if the lease is absent or STALE (heartbeat older than ~20 min → the prior owner died mid-case), reclaim it. Claim by writing `{caseId, status:"in-progress", runId:<thisRunId>, resourcePrefix:<unique-per-case>, heartbeat:<now>}` to the checkpoint, refresh `heartbeat` each meaningful step, and clear/mark `done` on completion. The `resourcePrefix` (e.g. `ltt-<caseId>-`) namespaces every test artifact/site/row this case creates so a second copy on a different case can never collide. The UX/Visual role (5) SUPPORTS the active case-owner — it feeds screenshot/vision findings to the owner but makes NO competing edits to the owner's files.
    - **Execution env (mandatory):** runs in the **MAIN checkout, NEVER a fleet auto-worktree** (sparse node_modules can't boot the local stack); assert `test -d node_modules && test -d apps/project-sites/node_modules` + `.dev.vars` BEFORE claiming coverage (missing = BLOCKED, never "passed"); Write-capable specialist only. See `OPERATING-PRINCIPLES.md` § Browser-role execution contract.

17. **Deep UI Explorer / Visual Intelligence (STANDING — runs EVERY cycle)** — the authenticated real-browser agent that models the admin as a GRAPH OF STATES + TRANSITIONS (route · role · selected site · tab · nested subview · open menu · overlay · iframe context — never URLs alone) and gives every meaningful action a settled screenshot + a real vision verdict. Specialist: `visual-qa`/`test-writer`.
    - **Ownership boundary:** owns `apps/project-sites/e2e/deep-ui-explorer/` (explorer.mjs · vision-review.mjs · coverage-ledger.json) + the run manifests. It is **READ-ONLY on product code during its discovery pass** — it hands a precise, reproducible state path (breadcrumb + state key + screenshots + findings) to Feature Delivery / UX / a11y roles, who implement in the same fire when feasible (RED → fix → GREEN → replay the exact breadcrumb → re-capture). It never deploys.
    - **Execution env (mandatory):** runs in the **MAIN checkout, NEVER a fleet auto-worktree** (sparse node_modules blocked role 17 in fire-64); assert node_modules + `.dev.vars` present BEFORE claiming CF/browser coverage (missing = BLOCKED, never "passed"); Write-capable specialist (`test-writer`/`general-purpose`), never `visual-qa` when it must edit. See `OPERATING-PRINCIPLES.md` § Browser-role execution contract.
    - **Honest provider contract:** the browser MUST be Cloudflare Browser Run via CDP (`wss://api.cloudflare.com/client/v4/accounts/{acct}/browser-run/devtools/browser`, Bearer `CF_BROWSER_RUN_TOKEN`); the run manifest records provider + session id. Browserbase or local Chromium runs are FALLBACK; a missing credential / failed login / role mismatch is BLOCKED with the exact prerequisite — none of these ever count as passed Cloudflare coverage.
    - **Auth contract:** homepage-start → the real test-approved seam (`/signin?test=1` → secret-gated `POST /api/auth/test-login`) → verify identity + role via `/api/auth/me` → navigate INTO /admin by clicking the UI. Password fields are masked BEFORE capture; token-shaped strings are scrubbed from any text context sent to a vision provider.
    - **Capture contract:** one settled screenshot after EACH meaningful action (click, tab, menu open, menu choice, modal open/close, form submit, keyboard activation, scroll-to-new-section, save, navigation, error recovery); typing groups into one field-entry action. Each state records: stable key, prev-state id, breadcrumb, console errors, failed requests, visible-text sample. The coverage ledger (discovered/visited/blocked/skipped-with-reason) is the resumable cursor — rotate underexplored branches each fire; backtrack + explore siblings, don't stop at first success.
    - **Vision contract:** EVERY screenshot goes through a real vision model via AI Gateway (`gateway.ai.cloudflare.com/v1/{acct}/projectsites/…`) with compact grounded context; findings are schema-validated across aesthetics · structure · function · a11y/perf · business value · architecture-HYPOTHESIS (never claimed as fact from pixels alone). Cheap-first, escalate on low score/p0-p1/key states; provider+model+tokens+cost+latency recorded per image; reviewer failures are recorded honestly, never skipped silently. A clean screen with zero findings is a VALID result — never manufacture a defect.
    - The UX/Visual role (5) consumes its findings; a visual observation becomes a `BACKLOG.md` item only after verification against code/store with an executable acceptance criterion.
18. **Template Evolution (scheduled lane — every-2-fires)** — owns the DELIVERED-site template `HeyMegabyte/template.projectsites.dev` AND its real handoff into the builder (`apps/project-sites/Dockerfile` clone → `site-generation.ts`); admin site-kit edits alone do NOT change delivered customer sites. Drives: the typed component catalog (scenario served · required VERIFIED facts · editing controls · semantic fallback · motion/3D options · browser-API needs · a11y · cost/perf budget · tests); the provenance rule (awards/testimonials/certifications/stats/press/logos/case-results appear ONLY when actually verified); per-archetype dimensional visual languages (purposeful WebGL/3D with compelling static fallback + early headline/CTA + reduced-motion + low-end support — law firms/nonprofits/restaurants/HVAC/logistics/SaaS must not be recolored siblings); the browser-capability registry (View Transitions, scroll-driven, WebGL/WebGPU, Web Share, Geolocation, offline/PWA, Web Audio, capture, WebXR — chosen only when they serve the visitor's job, with permission/compat/fallbacks; NEVER permission-prompt on page load); template VERSIONING per build + a safe upgrade path preserving customer edits. Acceptance = a delivered site verified live, not a component preview. Specialist: `general-purpose` + `visual-qa`.

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

**Role 4 (Golden-Path E2E) VARIES the journey each fire; role 16 (Long-Trail TDD case-owner, §1.16)
GRINDS ONE checkpointed case to completion.** They complement: role 4 rotates coverage broadly, role 16
finishes a single deep 60-100-action case across cycles via its lease + checkpoint before rotating. Both
follow the `long-trail-tdd` skill contract when running long stateful cases.

**Real email/SMS in ANY journey passes the fail-closed allowlist.** A journey that would send a real
message (submit a contact form to a live inbox, trigger an SMS) MUST route the recipient through
`apps/project-sites/scripts/recipient-allowlist.mjs` (`assertRecipientAllowed('email'|'sms', value)` /
`isRecipientAllowed(...)`) — it hard-denies when the local `.recipient-allowlist.local.json` is absent or
the recipient isn't explicitly listed, so a real send can only reach an operator-owned address. Never
hardcode a recipient; never send to a discovered/business address during a journey.

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
- Report per `always.md`: Changes · Next unmet unit per workstream · which golden journey ran + what it fixed · the Deep UI Explorer's provider/session + states visited/deferred + vision count/cost · external blockers · Recs (only genuine >2h / design-call / destructive-decision items — ship everything else inline).
- **Release the fire lease LAST**: `node scripts/loop-fire-lock.mjs release fire-<n>-<slug>` — then the next scheduled tick starts promptly instead of coalescing.

## Discipline (non-negotiable)
- One coherent slice per role per fire; fan out for independence; the main thread orchestrates + converges + reviews + **deploys once** + verifies — agents never deploy independently.
- **Delegate-when-saturated:** if the main thread is context-heavy, the fresh agents do the heavy pass while the main thread stays lean. **HARD STOP + fresh session is a LEAD-saturation trigger ONLY** — the ORCHESTRATOR hitting "Prompt is too long" / an `autocompact thrashing` notice on the LEAD / inability to spawn; never retry in place. A single worker agent's transient failure (ECONNRESET, `subagent_tokens: 0` from a network drop, cut-off output) is fan-out attrition, NOT a checkpoint trigger → salvage (`git show <branch-tip>` before deleting the branch) + re-queue + keep the loop running (`OPERATING-PRINCIPLES.md` § Failure taxonomy vs HARD-STOP).
- **`.gitignore` blocks `*.md`** → `git add -f` for canonical-home / backlog / ledger / doc updates.
- Destructive/irreversible actions (canonical answer #4) → ship the decision-independent slice, never auto-execute the destructive action.
- A workstream is DONE only when Acceptance passes + `LEDGER.md` records it + no dead refs remain.
