# /run-the-loop — Canonical Home

> The single canonical home for the ProjectSites.dev convergence loop (Brian, 2026-09-29).
> Brian says **"run the loop"** / `/run-the-loop` → a fire reads this dir to know how a
> cycle runs. Product: **"we don't sell websites, we deliver them."** A business owner
> searches their business → signs in → gets an AI-generated, hosted, SSL'd, live site in
> <15 min. Cloudflare-native. AI is the primary developer + a permanent product foundation.

## Canonical answers (Brian, 2026-09-29 — bake into every fire)

1. **Loop docs canonical home = `/.claude/run-the-loop/`.** This dir is the entry point.
   Siblings: `./OPERATING-PRINCIPLES.md` (non-negotiable invariants), `./BACKLOG.md`
   (live queue), `./ARCHITECTURE.md` (system shape). Legacy sub-ledgers still POINTED to
   (root `_LOOP.md` master, `apps/project-sites/_RUN_THE_LOOP.md` queue,
   `apps/project-sites/_LOOP_CHARTER.md` charter, `apps/project-sites/_APP_COMPLETION.md`
   DoD) — never duplicated here, never main-thread-read wholesale.
2. **PRIORITY journey = the money path.** search → signin → AI build → view live → edit →
   publish. Real auth, real build, real edit, real publish, reconciled against source of
   truth. Everything else is secondary while the revenue journey has any gap/dead-end/stub.
3. **WfP = the DEFAULT serving path.** Sites serve via Workers-for-Platforms dispatch
   (`x-ps-serve: wfp`, styled 200); R2 is the byte-identical fail-soft fallback. New sites
   are born on WfP preview + prod. Serving is flag-gated (`site_wfp_hosting`) during rollout.
4. **AUTONOMY = full autonomy on reversible prod actions.** Flag rollout, strict-validator
   flip, additive migrations, deploys — just DO them, then prod-verify. Only truly
   destructive/irreversible pauses for Brian: drop tables, bulk data mutation, secret
   rotation, mass outreach, billing/pricing changes.

## The prime directive

- **The PRIMARY deliverable of EVERY fire is a COMPLETE, REAL, end-to-end USER JOURNEY,
  proven working on PROD** — never a detector, a smoke check, or a mocked interaction.
- Real journey = homepage → real E2E sign-in → navigate by CLICKING the actual UI → create
  → configure → edit → SAVE → navigate away → return → HARD-REFRESH → verify PERSISTENCE →
  verify the cross-feature effect → clean up. A full story a paying customer lives, against
  the REAL backend.
- **Detectors (`check-*.mjs`) + unit tests are a BYPRODUCT, never the goal.** Ship one ONLY
  after a real journey caught a real bug and you want to stop its class regressing. A fire
  whose main output is a new detector or a mocked assertion is a FAILURE MODE.
- **"Ensure full flows happen" = COMPLETE the flow.** A journey with a gap/dead-end/stub →
  BUILD the missing product until it completes for real. Completing beats gating.
- Every fire leaves the whole app closer to DONE and is **gorgeous-er AND more effortless**
  — beauty + embarrassing-ease, both, always (never "functional but plain").

## Cycle lifecycle (one fire, in order)

1. **Orient (cheap).** Read this README + `./OPERATING-PRINCIPLES.md` + the ONE workstream
   you're advancing (`./BACKLOG.md`). `git fetch origin main && git pull --rebase` — a
   concurrent session may have progressed work; re-inspect the ACTUAL repo. NEVER
   main-thread-read giant ledgers (`_LOOP_LEDGER.md` = 2.3 MB, `_APP_COMPLETION.md`,
   `.claude/loop.md`, `refactor-state.md`) — delegate any inventory read to a fresh
   `Explore` agent with a ≤150-line output cap; hold conclusions only. HARD STOP on
   autocompact thrash / "prompt too long" / `subagent_tokens:0` → checkpoint to
   `progress.md`, continue in a FRESH session.
2. **Fan out the standing roster.** FIRST tool-call message emits parallel `Agent` spawns —
   the 15 standing roles below, worktree-isolated (mutating) or read-only (research), on
   disjoint subtrees (editor `app/`, worker `apps/project-sites/src`, Angular `frontend/`).
   Each brief is 150–300 words, self-contained (role · scope · exact paths · non-goals ·
   ≤200-word output), primary deliverable written FIRST (resilience). ≤6-wide for mutating
   agents; read-only sweeps are free + uncapped. ONE coherent slice per agent. Never bare
   `general-purpose` when a specialist fits.
3. **TDD-first.** A failing Playwright journey/spec BEFORE implementation → watch RED →
   implement → GREEN. Bug fix = failing regression first. No feature without ≥1 test; no
   fix without ≥1 regression.
4. **Verify (self, per agent).** `npm run check` (typecheck + lint + test) +
   `npm run validate:features` where touched; Angular touch → `ng build` (catches NG
   template errors tsc/karma miss). Verify Angular deploy by hash, not grep.
5. **Converge.** Main thread folds agent outputs into a coherent build; resolves conflicts;
   drops superseded code; wires every built unit to a reachable UI surface (no orphans).
6. **Adversarial review.** Before DONE, an independent reviewer (fresh subagent/context)
   assumes the implementation is subtly wrong and hunts lost functionality, hidden
   regressions, weak/mocked tests, unnecessary abstractions, dead compat code, a11y/security
   gaps, IDOR, state bugs. Plus the Agent Diversity Review gate (specialists assigned,
   rejected-agent note, no duplicated work). The implementer fixes valid findings in-turn.
7. **Deploy ONCE (main thread).** `cd apps/project-sites && npx wrangler deploy --env
   production` (`--env production` MANDATORY or every `/api/*` 500s). Frontend R2 has no
   Docker dep; container/DO builds need Docker. Editor Pages via `wrangler pages deploy`.
   Auth: `CLOUDFLARE_API_KEY` (get-secret) + `CLOUDFLARE_EMAIL=blzalewski@gmail.com`. NEVER
   modify already-set CF secrets. Agents NEVER deploy independently.
8. **Prod-verify (REQUIRED — a local pass is NEVER sufficient).** curl/Playwright the
   changed routes on PROD: assert new content/headers/JSON-LD/status live, 0 console errors,
   axe-clean. WfP → `x-ps-serve: wfp` + styled 200. Promote → Production serving SHA. DB →
   styled 200. Admin → real-browser click-around. No completion claim without FRESH
   command-output evidence this turn.
9. **Reconcile display-vs-store.** For every data surface, cross-check the DISPLAY against
   the AUTHORITATIVE STORE (`SELECT COUNT(*)` for the real account vs what the UI shows) —
   a green render + screenshot is NOT proof of correct data. `groundTruth > 0 && display ==
   0` = lying-empty. For trackable surfaces run the causal probe (do X → store records it →
   UI shows it).
10. **Commit main + push + tick.** Straight to `main` (no dev/feature branches); `git add
    -f` (`.gitignore` blocks `*.md`); conventional-commit + gitmoji IS the PR description;
    push immediately (rebase if rejected, NEVER force-push main). Merge + delete every
    worktree AND its branch the same fire. Tick the advanced unit in `./BACKLOG.md` (Done
    only when Acceptance is met, with closing SHA + prod proof). Report per `always.md`.

## The 15 fan-out agent ROLES (standing roster — EVERY fire)

Every fire spawns this roster together in ONE message, on disjoint subtrees. The discovery
and product roles REPLENISH the queue so the loop never drains a static backlog — a fire
that appends zero next-wave tasks means the discovery agent under-scanned; rotate its area.

1. **Feature Delivery** — build/complete a product capability at root cause, behind a
   default-OFF flag, wired reachable in the UI. The money-path is the first target.
2. **Product Discovery** — reconcile requirements, propose improvements at platform /
   journey / screen / component / state levels; GENERATE deduplicated next-wave tasks into
   `./BACKLOG.md`. Rotate a previously-uncovered surface each fire.
3. **Unit/Integration Testing** — domain logic, validation, parsing, reducers, permission
   rules, error mapping; fast, deterministic, isolated. No booting a browser for a pure unit.
4. **Golden-Path E2E** — run the canonical journeys against PROD in real Chromium (money
   path first): homepage-start, navigate by clicks/keyboard only, assert cause→effect +
   persistence + cross-feature. Defects become NEW queue tasks.
5. **UX/Visual** — every iteration more beautiful AND more effortless: cinematic motion,
   brand-locked (`#060610` + `#00E5FF`), bento/asymmetry, refined type, empty-states-as-
   launchpads, one primary action per screen, ≤3 steps, real-time data (no Refresh buttons).
6. **Architecture** — redesign / consolidate / decompose competing architecture; enforce
   feature-module + flag + Zod + RFC7807; kill drift; earn every abstraction.
7. **Repository Compression** — shrink code/files/deps/abstractions/special-cases while
   preserving capability. Net deletion is a success metric.
8. **Documentation** — docs ship in the SAME commit as the code; ADR per one-way door;
   JSDoc on exports; delete drift; keep `CLAUDE.md`/rules high-signal + accurate.
9. **Doc Compression** — compress instruction/doc files losslessly (cut what the model
   infers, keep every business requirement); keep always-loaded context lean.
10. **Dead-Code/Hygiene** — Knip unused files/exports/deps; remove `console.log`, dead
    imports, stale CSS, resolvable TODOs; run orphan sweep (`scripts/detect-orphans.mjs`).
11. **Performance** — CWV (LCP ≤2.0s, INP ≤100ms, CLS ≤0.05); kill data waterfalls,
    duplicate requests, oversized deps, eager route loading; measure, don't guess.
12. **Security** — auth/authz, tenant isolation, IDOR (`assertSiteOwned` on every
    `/api/sites/:siteId`), injection/XSS/SSRF, secret leakage, CSP Level 3 + Trusted Types.
13. **Accessibility** — axe 0 violations (necessary, not sufficient) + the 6 manual WCAG 2.2
    AA criteria; exactly one `<h1>`/view; contrast ≥4.5:1; focus rings + restore; 24px targets.
14. **Technology Scout** — surface frontier/CF-native primitives, competitor killer features,
    package decisions; feed adoption tasks (behind flags) into `./BACKLOG.md`.
15. **Loop Improvement** — sharpen this system: fold prompt-as-training-signal lessons into
    `./OPERATING-PRINCIPLES.md`, guardrails, the roster; reinforce the VERIFIER leg (gate
    DONE on executed tests + prod-E2E, MAX_ITERATIONS cap, reflection between retries,
    kill/reassign after ~3 stuck iterations, hard token budget).

- **Dynamic role creation** — when a fire needs a specialist none of the 15 cover (a
  migration-agent, an incident-responder, a media-orchestrator), SPAWN it purpose-built for
  that fire per the agent taxonomy — never a bare `general-purpose`. Emit the assignment
  table + rejected-agent note before spawning; retire the role when its work lands.

## Cadence syntax

Each roster role / workstream declares WHEN it runs. The loop reads the cadence to decide
which roles fire this cycle:

- **`once`** — a one-shot unit; runs a single fire, then done (drops off the roster).
- **`every-loop`** — fires EVERY cycle (Feature Delivery, Golden-Path E2E, Product
  Discovery, Loop Improvement are effectively every-loop).
- **`every-2-loops` / `every-4-loops` / `every-8-loops` / `every-16-loops`** — fires on that
  interval (the slower dimension sweeps — deep Architecture, Repo/Doc Compression, Technology
  Scout — ride a wider cadence so they don't crowd out the money-path every fire).
- **`daily`** — fires on the first cycle of each calendar day (Admin Quality, perf/security
  sweeps).
- **`weekly`** — fires on the first cycle of each calendar week (Knip/dead-code deep sweep,
  dependency audit, quality-ratchet baseline).

Cadence is a floor, not a cap: a role's cadence can be BROUGHT FORWARD when discovery or a
prod defect makes it the highest-value work this fire. A role that's been all-green for ≥2
of its cadence intervals goes maintenance-only (a healthy no-op is correct).

## Convergence rules

- **ONE coherent slice per workstream per fire.** Never split a multi-faceted brief into
  one-section-per-turn (that's the failure mode this loop prevents).
- **The queue never runs dry.** Every fire the Discovery + Product + E2E roles append
  deduplicated, evidence-backed next-wave tasks to `./BACKLOG.md`. Zero-append = under-scan.
- **A workstream is DONE only when its Acceptance passes** + its ledger is consolidated + no
  dead refs remain + prod proof recorded. Move to § Done then, never on a green local build.
- **A dimension all-`[x]` + green for ≥2 fires ⇒ maintenance-only** (a healthy no-op fire is
  correct — advance a different rung, never manufacture work).
- **Never pure-terminate on a quiet tree.** "HEAD unchanged AND tree clean" is permission to
  advance the highest-value standing track (money path → site-gen quality → decomposition →
  docs), not a stop signal. Reserve "converged" for the rare fire where every rung genuinely
  has no clean next step.
- **Category budget** governs how a fire allocates its roster (see below) — weight the money
  path + product first.

## Adversarial review

- **After any substantial refactor/feature, an INDEPENDENT reviewer** (separate
  subagent/context) is told to assume the implementation is subtly wrong and to hunt: lost
  functionality, hidden regressions, weak/mocked tests, unnecessary new abstractions, dead
  compatibility code, incorrect Angular patterns, incomplete Spartan migration, leftover
  CSS, a11y failures, security issues (IDOR, injection, secret leak), bad responsive
  behavior, network problems, state bugs.
- **The implementer evaluates + fixes valid findings in-turn** — never asks Brian to
  arbitrate a normal engineering disagreement; picks the better solution and continues.
- **Agent Diversity Review gate** runs before DONE on every multi-agent fire: specialists
  assigned (no undifferentiated `general-purpose` where a named specialist fits), overlapping
  scope caught, every agent verified its own work (build/test/E2E/screenshot proof),
  rejected-agent note present, no two agents edited the same code.
- **Stagehand/Browserbase exploratory pass** (Layer 2) finds journeys we forgot to encode;
  every discovery becomes a deterministic Playwright regression (Layer 1). AI exploration
  finds bugs; deterministic E2E prevents their return.

## Validation requirements (green BEFORE commit — no claim without fresh output)

- **Worker** (`apps/project-sites`): `npx tsc --noEmit` + `npx jest <touched>` (broaden if
  fast) + `npm run validate:features`. Run Jest FROM `apps/project-sites` (repo-root = babel
  trap); config is `.cjs`.
- **Editor** (`app/`): typecheck + `npm test` (Vitest).
- **Frontend** (`frontend/`): `npx tsc --noEmit -p tsconfig.app.json` + `ng build` for any
  UI slice (catches NG template errors tsc/karma miss). Verify Angular deploy by HASH, not
  grep.
- **Prod-verify** the changed routes (curl / Playwright / WebFetch) — assert the change live
  (WfP `x-ps-serve: wfp` + styled 200 · Promote Production serving SHA · DB styled 200 ·
  admin real-browser click-around), 0 console errors, axe-clean, display reconciled vs store.
- **Console-error / CSP / Trusted-Types / 4xx-5xx / axe in ANY test = build fail.** Empty
  allowlist is the target; never allowlist CORP / SW "Failed to fetch" / CSP violations.

## Failure recovery

- **Classify** (transient / code / config / deploy / data / auth) then apply the matching
  recovery — retry-with-backoff (max 3) for transient; read-diagnose-fix-test for code bugs;
  never `--force` / `--no-verify` to bypass a gate.
- **Root-cause, never symptom-patch.** Reproduce → understand root cause → failing
  regression test → fix at the source → verify → inspect adjacent code for the same class.
  After 3 failed fixes, STOP and question the architecture.
- **Test failure means something** — determine if the implementation, requirement, test,
  fixture, or environment is wrong; never blindly flip red→green or delete valuable coverage.
- **Deploy failure** → read error → fix → retry; 3 fails → `wrangler rollback` → diagnose →
  redeploy. Blank/white/5xx on prod → keep debugging (bisect `git revert`, rollback,
  patch-forward, switch hypotheses) until it renders, OR hand off with the exact stack trace
  + suspected `file:line` + 3 candidate fixes. Never report "known broken" without trying all.
- **Concurrent-session stranding** — `git rev-list --left-right --count origin/main...HEAD`
  each round; if `behind` grows or you're on the same non-`main` branch two rounds running,
  integrate to `main` NOW. Merge + delete every worktree + branch the same fire.
- **HARD STOP** on autocompact thrash / "Prompt is too long" / `subagent_tokens:0` →
  checkpoint to `progress.md`, continue in a FRESH session. Never retry in place.

## How to extend

- **Add a workstream** — append a row to `./BACKLOG.md` (mission · ledger · Next unit ·
  Acceptance · cadence). It joins the roster automatically on the next fire.
- **Add a roster role** — add it to the 15 above (or spawn it dynamically for a single fire).
  Purpose-built specialist per the taxonomy; never a bare `general-purpose`.
- **Add a flag** — every non-trivial feature ships behind a default-OFF flag in THREE places
  (registry + `manifest.ts` + docs); server returns 404 when off, UI returns null.
- **Add a canonical journey** — extend `./BACKLOG.md`'s journey coverage matrix + a Playwright
  spec (homepage-start, real backend); never delete an existing journey.
- **Capture a lesson** — a re-prompt on the same surface = a prediction miss. Root-cause WHY
  the first pass didn't predict it and fold the lesson into `./OPERATING-PRINCIPLES.md` (or
  the owning rule/skill) THE SAME TURN, per prompt-as-training-signal. Cross-link siblings.
- **Change cadence** — edit the role's cadence token; a role can be brought forward when a
  prod defect or discovery makes it the highest-value work this fire.

## Category budget (how a fire allocates its roster)

A fire's roster weight, so the money path + product always lead and slower sweeps ride a
wider cadence without crowding them out:

- **30–45% — Product / features / bugs** (Feature Delivery + Dynamic — the money path first).
- **15–25% — Testing / golden-paths** (Golden-Path E2E + Unit/Integration Testing).
- **10–20% — Architecture** (redesign / consolidate / decompose / drift).
- **5–15% — UX / a11y** (UX/Visual + Accessibility).
- **5–15% — Cleanup / compression** (Dead-Code/Hygiene + Repository Compression).
- **5–10% — Docs** (Documentation + Doc Compression).
- **5–10% — Discovery** (Product Discovery + Technology Scout — replenish the queue).
- **5% — Loop-improvement** (sharpen this system + the verifier leg).

## Sibling files + pointed-to ledgers

- **`./OPERATING-PRINCIPLES.md`** — the non-negotiable invariants (coding · design · UX ·
  architecture · testing · docs · AI-agent · hygiene · simplicity · security · a11y · perf).
- **`./BACKLOG.md`** — the live queue (workstreams · Next unit · Acceptance · cadence · Done).
- **`./ARCHITECTURE.md`** — system shape (Worker/Hono/D1/R2/KV/DO/Workflows · WfP dispatch ·
  per-site D1 · editor · admin SPA · CF resource IDs).
- **Pointed-to legacy ledgers (never main-thread-read wholesale):** root `_LOOP.md` (master
  mission/protocol/lanes) · `apps/project-sites/_RUN_THE_LOOP.md` (live queue) ·
  `apps/project-sites/_LOOP_CHARTER.md` (three-mandate charter) ·
  `apps/project-sites/_APP_COMPLETION.md` (whole-app DoD) · `.claude/loop.md` (6-loop
  DoD-backstop roster + E2E/TDD doctrine) · `apps/project-sites/_LOOP_LEDGER.md` (2.3 MB —
  NEVER main-thread-read) · `.claude/commands/run-the-loop.md` (the command).
