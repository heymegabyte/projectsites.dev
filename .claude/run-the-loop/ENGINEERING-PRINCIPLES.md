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

## Design-first doctrine — design is an executable contract (not disposable inspiration)
For significant greenfield work, major redesigns, and new app areas (the admin/editor SPA **and** the
generated-site pipeline), represent the product visually + structurally BEFORE most deep implementation,
and keep a traceable contract graph:
`USER INTENT → REQUIREMENTS → FIGMA DESIGN → PROTOTYPE FLOW → DESIGN TOKENS → STORYBOOK STATE → SOURCE
COMPONENT → PLAYWRIGHT TEST → PRODUCTION GOLDEN PATH`. Every important screen/interaction/journey
increasingly participates in it. (Distilled from the Design-First Resolution Addendum; full runnable
system → `agent-skills/_PCC_UPGRADE.md` § Design-Contract subsystem.)

- **Intelligence Question Gate + reaction-over-interrogation (= the ⭐ "AI does the work, the user
  confirms" SUPREME mandate).** Inspect ALL known context first (memory · prior convos · existing site ·
  repo · research · analytics), then ask only **0-5 high-information questions** whose answers materially
  change success — never what the AI can reasonably decide itself. Default loop: research → infer →
  design → **SHOW** → let the user **REACT** ("yes, that's it" beats specifying a product up front).
  Resolve subjective ambiguity with a visual proposal, not an interrogation transcript.
- **Two-stage visual approval.** Stage A: 2-3 *materially different* directions (cinematic / minimal /
  dense-professional / editorial — not color swaps) showing visual language · type · density · motion ·
  nav · brand; user picks/combines. Stage B: expand ONLY the chosen direction. Never spend heavily on one
  direction before taste is validated.
- **Technical-feasibility pass before visual commitment.** UI-first ≠ naïve: check proposed features vs
  CF architecture · APIs · data availability · auth/permissions · provider · cost · latency · mobile;
  spike one high-risk assumption before approving. No fantasy UI.
- **Design the whole VISIBLE product before most invisible implementation, with REAL content.** Route
  map · screen map · flows · dialogs · empty/error states · responsive shell · design system — walkable
  via fixtures/MSW/fake providers BEFORE big backend work (learn the workflow is wrong *before* building
  it). Realistic content (customer site · business info · competitor research · representative records),
  never lorem ipsum — content drives layout.
- **Design tokens = the single interchange authority (DTCG) + Code Connect.** projectsites already has
  `--ps-*` tokens (`frontend/src/styles/_polish.scss`: `--ps-bg:#060610`, `--ps-accent:#00e5ff`,
  `--ps-radius-xl`…) + ONE dialog primitive (`DialogShellComponent`). **STRENGTHEN:** make the token
  package the SOLE source (CSS vars ← app theme ← Figma vars ← Storybook — audits already flag hardcoded
  brand colors as drift); map Figma components ↔ the real Spartan/`packages/ui` components so agents
  reuse the right primitive instead of rebuilding a button.
- **Storybook + MSW + API-contracts-first.** Decompose the UI into independently-renderable STATES (not
  just happy: default/empty/loading/error/success/permission/overflow/mobile/edge); generate stories from
  the design contract. Define MSW handlers ONCE, reuse across dev/Storybook/tests/Playwright. **Typed API
  contracts precede API implementation** (request/response/error schemas → mock → the Worker implements
  the already-observed contract) — reverses backend-designed-in-isolation.
- **Visual + semantic TDD on ONE canonical environment.** Approved states → visual baselines;
  implementation converges to them (don't auto-approve drift). Generate baselines in ONE stable env
  (Browser Run / container — NOT local macOS; fonts/OS differ). Keep **ARIA/semantic snapshots** beside
  pixels (they catch different defects). Three-tier visual evidence: **T0** deterministic (DOM/ARIA/
  geometry/pixel-diff/console/network — cheap, most coverage) · **T1** one AI-vision triage · **T2**
  independent OpenAI+Anthropic critique for high-value surfaces (homepage/editor/primitives/release) →
  Claude synthesizes. Spend vision tokens where they add information.
- **The Design Contract Graph + the three truths.** A `DesignContract` binds `revision` ↔
  `requirementIds` ↔ `figmaFrame/flowIds` ↔ `tokenRevision` ↔ `storyIds` ↔ `componentPaths` ↔
  `e2eTestIds` ↔ `goldenPathIds` ↔ `approval(draft→review→changes-requested→approved→changed→implemented)`.
  Approval is PER-ARTIFACT (approve-all-except-Settings); feedback ("make this less busy") becomes a
  linked design requirement, never stranded in chat; Figma review comments are high-relevance Context
  Compiler sources. When Figma changes: APPROVED→CHANGED + **targeted invalidation** (only the affected
  contract/stories/baselines/E2E — mirror the Resolution Engine's dependency-aware invalidation).
  Continuously reconcile the **THREE TRUTHS** — REQUIREMENT (must do) · DESIGN (approved intent) ·
  RUNTIME (production actual); quality lives where they agree. Figma↔code is **bidirectional**: when code
  reveals a better interaction, prove it → update Figma → update the contract (never leave Figma showing
  an obsolete product).
- **Prototype flows seed golden paths.** Give important Figma prototype journeys stable IDs (e.g.
  `FLOW-SITE-CREATE-001`) mapping → Playwright E2E → production golden path — so the money-path is
  designed, prototyped, AND tested as one artifact (don't re-discover journeys post-implementation).
- **Design-first ≠ design-only.** After approval, build VERTICALLY (approved shell → golden-path-1 e2e →
  2 → 3), replacing mocks one contract at a time (`MOCK→IMPLEMENTING→REAL→VERIFIED`); an
  architecture-fitness check must prevent shipping a dev mock as a real capability.
- **Primitives get disproportionate resolution** (buttons/inputs/menus/dialogs/cards/tabs/nav/tables/
  command-palette/editor-chrome multiply across pages) — rank by usage×prominence×interaction×defect-rate
  + run focused improvement cycles. (projectsites' one-`DialogShell` rule is this principle already.)
- **Performance + accessibility are design-STATE concerns, in the contract** — not a cleanup project:
  reduced-motion, mobile-GPU/WebGL fallback, asset-weight budgets, semantic HTML + keyboard/focus +
  contrast, decided while designing components/states (fixing a primitive once beats repairing 50 screens).
