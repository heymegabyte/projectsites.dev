# Engineering Principles — INTENT → COMPILE → BUILD → VERIFY → OPERATE

> **Why this file.** Distilled from the "Ultimate Agent Skills System" directive (117 sections). The
> FULL system (the Prompt Context Compiler, execution engine, golden-path grower, etc. as runnable
> skills/tooling) lives in **`heymegabyte/agent-skills`** (the skills files) — see its `_PCC_UPGRADE.md`.
> **This file embeds the best, most-applicable PRINCIPLES into the projectsites.dev monorepo** so every
> loop fire + agent operates by them. Each is reconciled against what projectsites ALREADY has — adopt
> what's missing, strengthen what's thin, don't duplicate. Governed by `CONSTITUTION.md`; binds every fire.

## The spine (simple outside, sophisticated inside)
`INTENT → COMPILE → BUILD → VERIFY → OPERATE`. Keep the user's mental model this simple; the machinery
underneath may be deep. A one-line prompt is a SEED — expand it to the full arc before building (predict
the 80% from the 20%), but never expose orchestration complexity to the user.

## The 4 foundational subsystems (projectsites mapping)
1. **Prompt Context Compiler** — for a *consequential* prompt (new feature, migration, redesign, security
   work), COMPILE intent → structured requirements BEFORE coding: prompt-fuzz (reinterpret along product
   dimensions, not paraphrase) → intent lattice (product/users/UX/data/APIs/integrations/security/perf/
   a11y/analytics/business/testing) → **resolution tree** (decompose each requirement until an engineer
   can implement it without making a product decision) → ~14 logical refinement passes emitting *deltas*
   (NEW/CHANGED/CONTRADICTED/RESOLVED/UNKNOWN) → convergence (stop when critical unknowns/contradictions
   == 0 + must-reqs have acceptance + new passes add little). *projectsites today:* the loop + `SCOPE.md`
   + the SPEC do this informally. **ADOPT:** compile-before-build for material features; don't force it on
   trivial changes (§B: "add dark mode" ≠ a business strategy).
2. **Knowledge + Requirement Graph** — stable requirement IDs with **acceptance criteria that compile into
   tests**; **provenance** (intent → evidence → decision → requirement → code → test → deploy → outcome, so
   "why does this exist?" is answerable without inventing); a **negative-knowledge ledger** (rejected
   approaches + reason + reconsider-when). *projectsites today:* feature-module `manifest.ts` + `e2e/
   FEATURES.md` + `COVERAGE.yml` + `DECISIONS.md` ADRs + `_LOOP_LEDGER.md`. **STRENGTHEN:** toward stable
   R-IDs ↔ test/route/golden-path links + a rejected-approaches record (stop re-discovering dead ends).
3. **Agent Execution Engine** — controlled lanes (builder · verifier · architect/researcher · rotating
   specialist); **model routing** (Claude orchestrates/judges/does hard work; high-volume mechanical →
   DeepSeek/OpenCode; independent expert review → Codex; research-heavy → OpenAI+Anthropic → Claude
   synthesis) via an **escalation score** `importance × uncertainty × blastRadius × irreversibility ×
   novelty`; **work leases + worktrees**; **micro-assignment contracts** (task · requirement IDs · only
   the relevant context · files owned · constraints · what-not-to-change · acceptance · tests — NEVER
   "improve the repo"). *projectsites today:* the 15-role loop roster + `emdash-fleet` worktrees +
   `loop-fire-lock` leases + the agent-type map ([[agents-never-assume-blocked-retest-spawn-and-map-types]]).
   **ADOPT:** the escalation score as the routing heuristic; tight micro-contracts (already the norm — keep
   it); DeepSeek/Codex tiers where available.
4. **Golden-Path Grower** — realistic end-to-end USER JOURNEYS (not shallow click tests): persona · intent ·
   starting state · real navigation/forms/mutations · assert **persisted data + visible result + side
   effects**, not just DOM. Grow 30s → 2m → 5m → 10m → 20m; **split** when too big (acquisition/onboarding/
   core/billing/recovery/admin); **bind each journey to requirement IDs**; a bug fixed in prod becomes a
   regression journey. *projectsites today:* homepage-first E2E + the **money-path** (search→signin→AI-build
   →view-live→edit→publish) IS the canonical golden path. **ADOPT:** the grow/split algorithm + requirement
   binding + a coverage audit ("which must-requirements no realistic journey touches?").

## Highest-value cross-cutting principles (adopt into every fire)
- **§102 Anti-busywork (sharp lesson).** Before executing an *internally-invented* task it must materially
  improve ≥1 of: a requirement · customer problem · metric · business objective · risk · cost · reliability ·
  maintainability. A continuous loop must NOT manufacture activity to look busy. When the target is done +
  externally blocked, HOLD + poll the blocker periodically — don't grind make-work (see [[termBl]]).
- **§103 Human-in-the-loop boundaries.** Reversible internal work is free (research, tests, local code,
  drafts, flag flips, additive migrations, `wrangler deploy`). CONSEQUENTIAL EXTERNAL actions — money
  movement, contracts, customer-affecting pricing, important outbound comms, destructive/irreversible ops,
  modifying already-set secrets — require explicit approval: PREPARE, don't execute. (Maps to projectsites'
  "pause only for destructive/irreversible" + "never modify set CF secrets".)
- **§35 Deterministic work is CODE, not LLM prose** — validation, coverage math, AST, git, cost, schema,
  migration checks. *projectsites:* `validate:features`/`validate:e2e-inventory`/`build_validators.ts` —
  extend this, never ask an LLM to compute what a script can.
- **§28-29 Minimum active context, maximum knowledge.** Build the smallest high-value context bundle per
  task (rank by relevance/authority/recency/evidence/info-gain); subagents explore + summarize, the main
  thread orchestrates. Never dump the repo into an agent.
- **§48/§108/§47 Vertical-slice bias + first visible result fast + speculative safe execution.** Ship a
  thin end-to-end slice early (screen→interaction→API→storage→result→test); while research runs, do
  reversible low-regret work (inspection, baseline tests, fixtures, obvious fixes); don't lock
  consequential architecture before research that could change it.
- **§57/§58 Requirements compile into tests; test-driven product design.** Every meaningful requirement
  gets a test OR an explicit reason a lower layer suffices. Define observable correct behavior before
  trusting the implementation (RED→BUILD→GREEN→REVIEW→EXPAND). Detect requirement-without-test,
  test-without-requirement, implementation-without-requirement. *projectsites:* TDD-first is already law.
- **§21/§22/§110 Omission hunting + periodic adversarial review + the ULTIMATE COMPLETENESS QUESTION:**
  "Given only the original prompt, what would still prevent this from being genuinely excellent?" Every
  finding becomes fixed / a requirement / a catalogued bug / an explicit decision — NEVER lost in chat.
- **§20 Simplicity encoded (no simplifier phase):** least-complex architecture that satisfies the
  requirements; no infra without a demonstrated need; reversible choices under uncertainty; platform-native
  features first. (= projectsites' Cloudflare-first + "CF primitive unless one genuinely can't".)
- **§94/§74 Provider-degradation + failure injection:** peripheral providers must not break the core; test
  timeouts/5xx/rate-limits/expired-token/provider-down. *projectsites lived this:* the AI-Gateway-401 →
  direct-vendor fallback (fire-186) + degraded-success flagging + SES-suppression handling.
- **§100 Operating modes DISCOVER → BUILD → HARDEN → LAUNCH → OPERATE → GROW** — allocation shifts by phase
  (more builders in BUILD; more verification/security/perf in HARDEN; more analytics/SEO/support in
  OPERATE/GROW).
- **§37-39 Institutional memory, scoped:** run vs project vs global; **failure memory beats generic
  best-practices**; don't promote a one-time anomaly to a universal rule (require repeated evidence). (=
  the `~/.claude` memory system + this repo's `_LOOP_LEDGER`/`DISCOVERIES`.)
- **§53-55 Model council / disagreement is information:** on important conflicts, weigh evidence/tests/
  reversibility (NOT majority vote); Claude makes the final integrated call; substantial disagreement →
  more research/testing, never hide it.

## How this plugs into the existing projectsites loop
`CONSTITUTION.md` governs; `_LOOP_CHARTER.md` sets the per-fire floor; `verification-loop` (deploy +
prod-E2E) is the done-gate; feature modules + flags are the unit of capability. These principles are the
*doctrine layer* above them — when a fire has a choice, prefer the principle here. The runnable
implementation of the compiler/graph/engine/grower is tracked in `agent-skills/_PCC_UPGRADE.md`.
