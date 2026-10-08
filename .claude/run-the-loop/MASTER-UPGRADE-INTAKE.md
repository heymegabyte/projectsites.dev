# MASTER AGENT UPGRADE — §0.5 INTAKE (capture → reconcile → slice)

> **Status: INTAKE ONLY. Nothing here is implemented.** This file captures, reconciles, and
> slices `.claude/run-the-loop/MASTER-AGENT-UPGRADE-SPEC.md` (Brian 2026-10-08, fire-306d) into a
> fire-sized backlog EPIC. It does NOT execute the directive and fabricates nothing. Create-only
> (does not edit BACKLOG.md/LEDGER.md in place; not committed) to avoid clobbering concurrent fleet
> fires. Authored on Brian's **Mac** (`/Users/Apple`), 2026-10-08.
>
> **Scope reminder (from the directive itself):** this is a GLOBAL AGENT-ECOSYSTEM upgrade
> (`~/.claude` + `~/.agentskills` + `/run-the-loop`), explicitly **NOT a projectsites.dev product
> change**. "Do not modify unrelated production applications … do not modify DeskLink/GitLink."
> The projectsites product work continues under `BACKLOG.md` as normal; this EPIC only touches the
> agent toolchain. The one exception captured here is the §4 prerequisite (a projectsites CI
> deploy blocker), flagged because it gates ALL worker auto-deploys.

---

## Part A — EXISTS-vs-NEW classification (the 32 directive sections)

Method: verified against the LIVE global estate, not against the directive file's own prose. The
loop dir contains the directive (`MASTER-AGENT-UPGRADE-SPEC.md`) and intake queues, so grepping the
loop dir for a keyword finds the SPEC, not an implementation — those hits were discounted. Ground
truth = `~/.agentskills/bin`, `~/.agentskills/rules`, `~/.claude/commands`, installed binaries
(`which`), and the loop's own command/docs.

Legend: **DONE** = materially built + wired · **PARTIAL** = core exists, gaps named · **NEW** =
absent, must build.

| § | Topic | Verdict | Evidence / what exists · what's missing |
|---|---|---|---|
| 1 | Core philosophy (upfront research · reactive discovery · completion-before-distraction) | **DONE** | CONSTITUTION 15-min heartbeat; OPERATING-PRINCIPLES "completion beats gating"; `predictive-completeness`/`first-time-excellence` rules. Codify the exact 3-clause as executable text → PARTIAL sliver. |
| 2 | **Automatic-improvement DEFAULT** (adopt, don't ask; narrow question-triggers) | **PARTIAL** | Spirit is everywhere (`auto-integrate-recs`, `proactive-improvements`, "never pause to ask"). Missing: a SINGLE named executable rule embedded identically across global+project+research/plan/arch/impl skills + evals, as §2 demands ("executable, not just documented"). |
| 3 | 3 authoritative decisions (surpass competitors · evidence-based reinvention · committed completion) | **PARTIAL** | `competitor-research` rule + Codex-as-adversary in `agent-provider-policy`. The "Claude+Codex INDEPENDENTLY evaluate consequential changes, record rationale" loop is doctrine but not a wired gate. |
| 4 | Inspect+preserve existing env | **DONE (ongoing)** | This intake IS a §4 pass. `codexrye`/Proxmox runner preserved per `machines/ubuntu-proxmox-primary.md`. |
| 5 | ONE entry point `/run-the-loop`; internal sub-workflows; keep manual commands | **DONE** | `~/.claude/commands/run-the-loop.md` (19K) + skill. Many internal workflows already invoked. No `/goal` command (it's skill `02-goal-and-brief`); directive references `/goal` — reconcile naming (minor). |
| 6 | Capture+reconcile every user instruction (nonblocking; precedence ladder; capture ≠ auto-loop) | **PARTIAL** | `prompt-as-training-signal` rule + feedback-intake block in run-the-loop.md + MEMORY system. Missing: the explicit **precedence ladder** (explicit-now > explicit-constraints > accepted-OpenSpec > evidence-ADRs > inferred > research) as a deterministic, encoded reconcile step. |
| 7 | **Product Knowledge Ledger** (persistent structured; traceable request→…→deploy) | **PARTIAL** | GENOME.md + BACKLOG/LEDGER/DISCOVERIES/GOLDEN-PATHS cover MOST fields informally. Missing: a single structured ledger with the full traceability chain + the fields §7 enumerates (rejected+reasons, deferred, verification links). |
| 8 | Portfolio catalog (DeskLink, GitLink — do NOT modify) | **NEW (doc)** | No portfolio catalog file found in the agent layer. Cheap to add; must carry the "do-not-modify" guard. |
| 9 | Multi-model arch (OpenClaw/ClawRouter, ~3 Claude accts, Codex, OpenCode+DeepSeek; routing+tracking) | **PARTIAL** | Provider tiers + CLIs LIVE: `agent-provider-policy.md` (SSOT) + `with-subscription-cli.sh` + `opencode-deepseek.sh` + `provider-capability.sh`; `codex` 0.144 authed, `opencode` 1.18 + DeepSeek wired, `claude-pool.sh` exists for multi-account. "OpenClaw"/"ClawRouter" are **concept names in the Proxmox fleet bootstrap**, NOT installed binaries. Missing: a model-use+outcome TRACKER and a don't-recall-when-verified cache. |
| 10 | **Recursive research + prompt-expansion engine** (Pass 1–9) | **PARTIAL** | `research-expansion-orchestration.md` rule + `bin/research-orchestrator.sh` (gum-logged, independent→synthesize→critic→loop-until-dry) exists and covers Pass 1–4/7/8/9 at the research layer. Missing: the deep **recursive product DECOMPOSITION** (Product→Modules→…→APIs→GoldenPaths→Tests) as an executable expander, and the 2-consecutive-clean-passes convergence gate. |
| 11 | Recursive improvement generation (~30/dimension; implement ≥top-30%; 3 horizons) | **NEW** | No "~30 candidates per dimension, rank, implement top-30%, 3 horizons" generator exists as a tool/skill. Doctrine-adjacent only. |
| 12 | **Auto Research Prompt.md** per project root (git-excluded; full structured audit) | **NEW** | File NOT present; `.git/info/exclude` does NOT list it (it excludes `.claude/worktrees`, locks, etc.). `bin/research-orchestrator.sh` writes `.research/sessions.ndjson` — a DIFFERENT, partial ledger. The full §12 schema (Research Started → all provider responses → Synthesized Implementation Prompt → Execution Results → Final Synopsis; atomic single-writer; America/New_York) is unbuilt. |
| 13 | Beautiful terminal reporting (Gum + Glow; 14-section final report; plain/CI fallback) | **PARTIAL** | `gum` + `glow` INSTALLED (`/opt/homebrew/bin`). `research-orchestrator.sh` already uses `emdash_*`/gum with CI fallback (`terminal-styling` rule). Missing: the standard **14-section final report** renderer for `/run-the-loop`. |
| 14 | **OpenSpec = canonical change system** (actual CLI; continuous integration; no checkbox-done) | **NEW** | `openspec` CLI NOT installed; no `openspec/` dir. Biggest single NEW subsystem. Must use the ACTUAL supported CLI (inspect real syntax; shell ≠ chat slash). Interacts with Part B(c) below. |
| 15 | UI-FIRST (UI inventory before backend; coverage gate; capacity split) | **PARTIAL→DONE-ish** | Loop already UI-first: Deep UI Explorer standing role §1.17, VISUAL-COVERAGE.md, `embarrassingly-easy-to-use` + gorgeous gates, category budget. The explicit "~70/15/10/5 capacity while UI gaps" split is not encoded. |
| 16 | Shared design system + component reuse (search before build; promote to registry) | **PARTIAL** | Spartan UI + one-dialog-primitive + design tokens enforced; audits flag drift. Missing: a formal "search repo→libs→registries→OSS BEFORE building" gate + a versioned shared component registry with promotion. |
| 17 | Visual QA + **Codex screenshot review** (CF Browser Run + Playwright; 20-criterion rubric) | **PARTIAL** | Visual-QA LIVE (Deep UI Explorer §1.17, `vision-review.mjs`, CF Browser Run CDP recipe, Anthropic/Gemini vision ladder). Missing: **Codex image-inspection** as the independent second eye + the 20-criterion rubric as an encoded artifact. |
| 18 | Golden-path-driven dev (executable scenarios; gen tests from OpenSpec; no-evidence-no-done) | **DONE** | GOLDEN-PATHS.md + gp-register.json + `validate-gp-register.mjs` + Long-Trail TDD standing role §1.16 + long-trail-tdd skill. "Generate tests FROM OpenSpec" is the only NEW hook (depends on §14). |
| 19 | Persistent task orchestration + anti-thrashing (durable queue; leases; WIP; cooldowns) | **PARTIAL** | Fire-lease mutex (`loop-fire-lock.mjs`), worktree isolation, carried-blocker re-confirm, BACKLOG priorities, failure taxonomy — strong. Missing: a durable per-TASK queue with attempts/failures/reopen-cooldowns/edit-revert-detection as a structured store (BACKLOG.md is prose, not a queryable queue). |
| 20 | Dynamic parallel-agent scheduling (named specialist RESPONSIBILITIES; no fixed count) | **DONE** | 15 rotating + standing roles (§§1.1–1.18), dynamic roles, category budget, ≤6-wide mutating fan-out. The directive's specialist list ≈ the existing roster. DeepSeek-heavy-for-cheap maps to the provider policy. |
| 21 | Scope expansion w/o losing completion (Workstream A impl + B discovery; reinvention rule) | **PARTIAL** | "Queue never runs dry" + Product-Discovery role ≈ Workstream B; completion-before-distraction ≈ A. The explicit anti-oscillation reinvention protocol (record→independent eval→cost→migration→adopt) is doctrine, not a gate. |
| 22 | SEO+content research (keyword research before every SEO page; DataForSEO; 17-step; no invented metrics) | **PARTIAL** | seo-auditor agent + `citations` rule + "no fabrication". Missing: the 17-step keyword process + DataForSEO wiring as an executable pre-page gate. (Product-adjacent — applies to generated sites + platform marketing, NOT customer products per §24 boundary.) |
| 23 | Cloudflare-first infra eval (Workers/Browser Run/D1/R2/KV/DO/Queues/Workflows/AI Gateway/AI Search/…) | **DONE (standing)** | Entire product IS CF-native; CF-RELEASES.md release-scout; CF Browser Run CDP recipe live. AI Search "current bindings not deprecated AutoRAG" is a watch-item, not new build. |
| 24 | Integrate Sentry/PostHog/Langfuse/Promptfoo/Infisical thoroughly (PLATFORM apps, not customer sites) | **PARTIAL** | Sentry = estate baseline (server-side `@sentry/cloudflare`); PostHog server-side product events live. **Langfuse** = skill + MCP exist but NOT wired into the loop's model-routing telemetry. **Promptfoo** NOT installed. **Infisical** NOT installed (secrets via CF + `get-secret`). |
| 25 | Complete every integration (not just install): config→SDK→tests→docs checklist | **NEW** | Per-integration completeness checklists+tests as reusable artifacts don't exist; depends on §24. |
| 26 | Continuously improve docs + code (dedupe/compress; dead-code; deps; ShellCheck) | **DONE** | docs-compression skill, dead-code-remover agent, `code-simplifier`, ShellCheck in `code-style`, context-spillover triple-sweep. |
| 27 | Improve the agent skills themselves (~30/category, ≥top-30%; project-first then promote global) | **PARTIAL** | agentskills-retrospective skill + §7 self-improvement in run-the-loop + `prompt-as-training-signal`. Missing: the systematic "~30 candidates/category → implement top-30%" generator. |
| 28 | Validate prompt-expansion with REAL **Promptfoo** evals (benchmark requests; metrics; vs baseline) | **NEW** | A home-grown eval harness exists (`/run-evals` → `tools/evals/cases/*.json`, Zod-validated, regression baseline) — but NOT Promptfoo, and NOT targeted at prompt-EXPANSION quality. §28 is a new tool + new eval corpus; decide supplement-vs-replace vs the existing harness. |
| 29 | Product-completeness metrics (defined/impl/passing; dashboard; machine-readable) | **PARTIAL** | COVERAGE.yml + FEATURES.md + gp-register + `validate:features` give piecewise metrics. Missing: the unified machine-readable completeness dashboard §29 describes. |
| 30 | Acceptance criteria (verify-don't-claim across entrypoint/research/audit-trail/OpenSpec/UI/exec/quality/reporting) | **PARTIAL** | "No completion without fresh evidence" is core doctrine; several criteria already enforced. Full §30 checklist depends on §§12/14/28 landing first. |
| 31 | Execute in 10 waves | **N/A (plan)** | The directive's own execution plan — reflected in the `wave#` column of Part C. |
| 32 | Final synthesis (implement-don't-recommend; never fabricate; …) | **N/A (ethos)** | Already the estate ethos; nothing to build. |

**Headline verdict — what is GENUINELY NEW to build (not already in the estate):**

1. **OpenSpec** install + canonical-change-system wiring (§14) — the single biggest new subsystem.
2. **Auto Research Prompt.md** per-project audit artifact + `.git/info/exclude` entry + its full
   structured schema (§12). (Distinct from the existing `.research/sessions.ndjson`.)
3. **Promptfoo** install + prompt-expansion eval corpus + CI (§§24/28) — decide vs the existing
   `tools/evals` harness.
4. **Infisical** install + env/machine-identity/OIDC integration (§§24/25) — Brian-gated (new recurring cost + secret-plane change).
5. **Langfuse wired into loop model-routing telemetry** (§24) — the skill/MCP exist; the loop isn't instrumented.
6. **Recursive product-decomposition expander** + 2-clean-pass convergence gate (§§10/11) — the research-layer orchestrator exists; the product-tree expander and the "~30 candidates/dimension, top-30%" generator do not.
7. **Model-use + outcome TRACKER** and verified-result cache (§9) — routing exists; measurement doesn't.
8. **14-section Gum/Glow final-report renderer** for `/run-the-loop` (§13) — tools installed, renderer unbuilt.
9. **Codex screenshot/visual review** as the independent second eye + 20-criterion rubric (§17).
10. **Portfolio catalog** doc with do-not-modify guards (§8) + the single executable
    **automatic-improvement-default** rule embedded identically everywhere (§2) + the **precedence
    ladder** encode (§6) + **Product Knowledge Ledger** structured artifact (§7).

Everything else (orchestration, golden paths, visual QA ladder, deploy+prod-verify, fire-lease mutex,
category budgets, provider-CLI policy, research-orchestrator, DeepSeek throughput, docs/code cleanup,
CF-native infra) **already exists — do NOT rebuild it.**

---

## Part B — CONTRADICTIONS + OPEN QUESTIONS (Brian-gated; never silently flipped)

A prompt that contradicts settled doctrine is an open question, never a silent policy change.

**(a) HOST — which machine runs the campaign?** *(DECISION REQUIRED)*
- Directive prefers the **Proxmox Ubuntu VM + `codexrye` user + its GitHub runner** as the
  persistent host (`machines/ubuntu-proxmox-primary.md`, `bootstrap/ubuntu-agent-fleet-codex.md`).
- This intake session is on **Brian's Mac** (`/Users/Apple`).
- The directive itself flags this as OPEN ("multi-model execution host determination is an OPEN
  QUESTION — this Mac vs the Proxmox runner").
- **Why it matters:** long-lived multi-model orchestration (multi-account Claude pools, Codex,
  OpenCode/DeepSeek swarms, Browser Run) wants a persistent host; the headless fleet already runs
  on the Proxmox runner via GitHub Actions. **Proposed default: the Proxmox runner is the campaign
  host; the Mac authors/intakes and can run interactive fires.** Confirm before Wave 3.

**(b) MODEL ROUTING — multi-account/Codex/DeepSeek vs the subscription-CLI-only ban.** *(RECONCILABLE — no conflict, confirm framing)*
- Directive §9 wants heavy Codex/DeepSeek/multi-account-Claude routing.
- Estate policy (`agent-provider-policy.md` + memory `internal-agent-orchestration-uses-subscription-clis-not-api-keys`,
  ADR-0057) mandates: subscription CLIs for frontier (`claude`/`codex`), DeepSeek-via-OpenCode for
  throughput, **NEVER `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, never AI-Gateway for local CLI compute,
  never subscription→PAYG fallback.**
- **These are COMPATIBLE, not contradictory:** the directive's "OpenClaw/ClawRouter/~3 Claude
  accounts" is multi-**subscription-account** routing, which `claude-pool.sh` already enables —
  NOT API keys. **Hard constraint for every slice: all multi-model routing goes through
  `with-subscription-cli.sh` + `opencode-deepseek.sh`; DeepSeek is the only internal API; product
  AI-Gateway/`$ai_*` plumbing is the SEPARATE preserved axis.** No doctrine flip needed; just hold
  the line while building §9's tracker.

**(c) OpenSpec vs the existing BACKLOG/LEDGER/GENOME knowledge system — complement or replace?** *(DECISION REQUIRED)*
- Directive §7 explicitly says the Product Knowledge Ledger should "complement OpenSpec, not
  compete." §14 makes OpenSpec the canonical CHANGE system.
- The loop already has a mature, prose-based knowledge+change system (BACKLOG frontier, LEDGER
  close-outs, DISCOVERIES, GENOME, gp-register, MASTER-PROMPT/AWOS, PENDING-DIRECTIVES).
- **Open question:** does OpenSpec BECOME the canonical change spine (BACKLOG/LEDGER demote to
  human-readable views generated from it), or does it run ALONGSIDE as a second system (drift risk)?
  **Proposed: OpenSpec is the canonical structured change-proposal store; BACKLOG/LEDGER remain the
  human cadence surface, with OpenSpec IDs cross-referenced** — a bridge, not a rip-and-replace.
  Confirm before Wave 5, because it dictates whether §18's "generate tests FROM OpenSpec" and §7's
  ledger point at OpenSpec or at the current docs.

**(d) "Auto Research Prompt.md uncommitted via `.git/info/exclude`" vs repo conventions.** *(RECONCILABLE — confirm mechanism)*
- Directive §12 wants `Auto Research Prompt.md` at each project root, NOT committed, excluded via
  `.git/info/exclude` (local, not the tracked `.gitignore`).
- Repo convention: `.gitignore` already blocks `*.md` broadly (hence `git add -f` for tracked
  markdown); `.git/info/exclude` currently lists worktrees/locks/state only.
- **No hard conflict** — `.git/info/exclude` is the right local-only mechanism and the existing
  `*.md` ignore already keeps it untracked. **Proposed: add `/Auto Research Prompt.md` +
  `.agent/reports/` + `.research/` to `.git/info/exclude` per project (local, uncommitted).**
  Minor: a filename with spaces is awkward for tooling — confirm the literal name or allow
  `AUTO-RESEARCH-PROMPT.md`.

**Other flagged items (surface, don't block):**
- `/goal` command referenced by the directive does not exist as a command (it's skill
  `02-goal-and-brief`) — naming reconcile only.
- Pre-existing **OPEN QUESTION already in OPERATING-PRINCIPLES** (prod-off-by-default vs
  full-autonomy-on-reversible-prod, surfaced fire-89) is untouched by this directive and still
  awaits Brian; noted so the two don't get conflated.

---

## Part C — EXECUTABLE FIRE-SIZED SLICES (prioritized, deduplicated)

Ordering obeys the directive's own priorities — **automatic-improvement-default + UI-first +
completion-before-distraction** — AND dependency. `[IND]` = decision-independent (buildable now).
`[GATE:x]` = blocked on open-question (x) above. `wave#` = the directive's 10-wave plan (§31).

### Decision-independent, do-first (highest value / unblocks others)

1. **[IND · wave 1] Establish the Product Knowledge Ledger skeleton (§7).**
   - *Acceptance:* a structured `.claude/run-the-loop/KNOWLEDGE-LEDGER.md` (or equivalent) with the
     §7 fields (identity/users/objectives/positioning/feature+UI inventory/arch decisions/request
     history/research evidence/tech/golden-paths/deps/implemented/gaps/deferred/rejected+reasons/
     verification) seeded from GENOME + BACKLOG; every field has ≥1 real entry or an explicit "TBD".
   - *Anchors:* `.claude/run-the-loop/GENOME.md`, `BACKLOG.md`, `GOLDEN-PATHS.md`.
   - *Extends:* GENOME (adds traceability chain GENOME doesn't carry). Create-not-edit the new file.

2. **[IND · wave 1] Encode the automatic-improvement-default rule ONCE, reference everywhere (§2).**
   - *Acceptance:* a single canonical rule (e.g. `~/.agentskills/rules/automatic-improvement-default.md`)
     stating the adopt-automatically criteria + the narrow question-triggers, with the executable
     decision list; `CLAUDE.md` (global + project), run-the-loop.md, and the research/plan/arch/impl
     skills REFERENCE it (no forked copies). `audit-contradictions.mjs` passes.
   - *Anchors:* `~/.agentskills/rules/`, `~/.claude/CLAUDE.md`, `.claude/commands/run-the-loop.md`.
   - *Extends:* `auto-integrate-recs` + `proactive-improvements` (consolidates their spirit into one named gate).

3. **[IND · wave 1] Portfolio catalog with do-not-modify guards (§8).**
   - *Acceptance:* a catalog listing the estate's products incl. **DeskLink (deskl.ink)** +
     **GitLink (gitl.ink)** marked "do NOT modify during agent-skill upgrades"; referenced by the
     loop's orient step so a fire never wanders into them.
   - *Anchors:* `~/.agentskills/` (portfolio doc), `.claude/run-the-loop/README.md` (pointer).
   - *Extends:* nothing — small new doc.

4. **[IND · wave 1] Fix the research-audit gap: adopt/upgrade `.research/sessions.ndjson` toward the §12 schema.**
   - *Acceptance:* decide the per-project **Auto Research Prompt.md** location + name; add it +
     `.agent/reports/` + `.research/` to each active project's `.git/info/exclude`; extend
     `research-orchestrator.sh` output to cover the §12 sections it doesn't yet (Research Started
     header with America/New_York ts + runId; Synthesized Implementation Prompt captured BEFORE
     impl; Final Synopsis). Secret-redaction + single-writer/atomic preserved.
   - *Anchors:* `~/.agentskills/bin/research-orchestrator.sh`, `~/.agentskills/rules/research-expansion-orchestration.md`, per-project `.git/info/exclude`.
   - *Extends:* the EXISTING research orchestrator (do not build a parallel one). Confirm (d) naming.

5. **[IND · wave 1] 14-section Gum/Glow final-report renderer for `/run-the-loop` (§13).**
   - *Acceptance:* a script/section that renders the 14 named report sections (Run Summary …
     Blockers) via `gum`/`glow` with the existing `emdash_*` CI/plain fallback; machine logs stay
     ANSI-free; wired into the loop's HAND-OFF stage. Real evidence only (no fabricated rows).
   - *Anchors:* `/opt/homebrew/bin/gum`, `/opt/homebrew/bin/glow`, `terminal-styling` rule, `research-orchestrator.sh` (pattern to reuse), run-the-loop HAND-OFF.
   - *Extends:* the existing gum-logging pattern; adds the standardized final report.

6. **[IND · wave 2] Model-use + outcome TRACKER + verified-result cache (§9).**
   - *Acceptance:* every internal `claude`/`codex`/`opencode` invocation logs provider · role ·
     tokens/cost (if available) · outcome · USED/NOT-USED to an NDJSON ledger; a fire won't re-call
     an expensive provider when a verified result for the same question exists. No API keys; routes
     through `with-subscription-cli.sh`/`opencode-deepseek.sh` only (constraint b).
   - *Anchors:* `~/.agentskills/bin/with-subscription-cli.sh`, `opencode-deepseek.sh`, `provider-capability.sh`, `~/.agentskills/bin/agent-quality-tracker.mjs` (reuse).
   - *Extends:* `agent-quality-tracker.mjs` + the research orchestrator's verdict ledger.

### Decision-independent, UI-first + quality (directive §§15–18 lean)

7. **[IND · wave 6] Codex screenshot/visual review as the independent second eye + 20-criterion rubric (§17).**
   - *Acceptance:* the Deep UI Explorer pipeline additionally feeds high-impact screenshots to
     `codex` (via `with-subscription-cli.sh codex`) for independent image critique; a 20-criterion
     rubric artifact exists; Claude renders independent judgment; findings carry severity/location/
     fix/component. Workers-AI/Gemini vision remains the cheap-volume ladder.
   - *Anchors:* `apps/project-sites/e2e/deep-ui-explorer/vision-review.mjs`, `explorer.mjs`, CF Browser Run CDP recipe, `agent-provider-policy` (Codex path).
   - *Extends:* the EXISTING visual-QA standing role §1.17 — do not build a parallel visual harness.

8. **[IND · wave 7] Component-reuse gate + shared registry promotion (§16).**
   - *Acceptance:* a "search repo→shared libs→registries→OSS BEFORE building a component" checklist
     is an encoded pre-build step; a versioned shared component registry location is defined with a
     promotion path; a drift check flags duplicate components.
   - *Anchors:* `apps/project-sites/frontend/` (Spartan UI), `packages/shared/`, one-dialog-primitive/design-tokens enforcement.
   - *Extends:* existing design-system drift audits.

### Brian-gated (block on an open question — do NOT start until resolved)

9. **[GATE:a · wave 3] Stand up the multi-model campaign on the chosen host (§§9, Part B-a).**
   - *Acceptance:* once host confirmed, the campaign's persistent orchestration (claude-pool,
     codex, opencode/DeepSeek) runs there; the Mac stays interactive. No uncontrolled recursion —
     one coordinator + bounded subordinates (§5). All routing via subscription CLIs (constraint b).
   - *Anchors:* `machines/ubuntu-proxmox-primary.md`, `bootstrap/ubuntu-agent-fleet-codex.md`, `bin/claude-pool.sh`.
   - *Extends:* the existing fleet/runner — do not duplicate `codexrye` or the runner.

10. **[GATE:c · wave 5] Install + wire OpenSpec as the canonical change system (§14).**
    - *Acceptance:* OpenSpec installed; its ACTUAL CLI verified (explore/propose/apply/update/sync/
      verify/archive — real syntax, not invented); the complement-vs-replace decision (c) encoded;
      OpenSpec IDs cross-referenced from BACKLOG/LEDGER/Knowledge-Ledger; "no complete on checkbox
      alone — validate vs real behavior" enforced. Interacts with slices 1 and 11.
    - *Anchors:* `.claude/run-the-loop/BACKLOG.md`, `LEDGER.md`, `GENOME.md`, slice 1's ledger.
    - *Extends:* the existing BACKLOG/LEDGER system per decision (c).

11. **[GATE:c · wave 5] Generate acceptance tests FROM OpenSpec (§18 hook) + recursive product-decomposition expander (§§10/11).**
    - *Acceptance:* a Product→Modules→…→GoldenPaths→Tests expander produces OpenSpec-linked golden
      paths + tests; the 2-consecutive-clean-passes convergence gate exists; the "~30 candidates/
      dimension → implement top-30% → 3 horizons" generator runs and dedupes. Depends on slice 10.
    - *Anchors:* `.claude/run-the-loop/GOLDEN-PATHS.md`, `gp-register.json`, `scripts/validate-gp-register.mjs`, `bin/research-orchestrator.sh`.
    - *Extends:* research-orchestrator (adds product-tree decomposition) + gp-register.

12. **[GATE:Brian-cost · wave 8] Install + integrate Infisical (§§24/25).** *(new recurring cost + secret-plane change → Brian-gated per autonomy rules.)*
    - *Acceptance:* Infisical dev/preview/prod envs + machine identities + GH OIDC + safe injection +
      rotation; no secrets in logs/frontend; a reusable completeness checklist+tests. Coexists with
      `get-secret`/CF secrets during migration. Do NOT touch already-set CF secrets.
    - *Anchors:* `get-secret` tooling, CF secrets, `secret-provisioning` rule.
    - *Extends:* existing secret provisioning — additive, not a rip-out.

13. **[GATE:Brian · wave 9] Install Promptfoo + prompt-expansion eval corpus + CI (§§24/28); decide vs the existing `tools/evals` harness.** *(supplement-vs-replace decision + possible new cost.)*
    - *Acceptance:* Promptfoo installed; benchmark requests (CMS/CRM/booking/analytics-dashboard/
      improve-empty-screen/SEO-article/complex-integration) evaluate prompt-expansion quality on the
      §28 metrics vs baseline; CI gate; "long≠better" check. Reconcile with `/run-evals` +
      `tools/evals/cases/*.json` (keep one eval spine, not two drifting ones).
    - *Anchors:* `~/.agentskills/commands/run-evals.md`, `tools/evals/`, `07-quality-and-verification/llm-evals.md`.
    - *Extends:* the EXISTING eval harness — decision gates whether Promptfoo replaces or wraps it.

14. **[GATE:c · wave 8] Wire Langfuse into loop model-routing telemetry (§24).**
    - *Acceptance:* internal model routing (and/or product AI plumbing, kept separate) emits traces/
      cost/latency/tool-calls to Langfuse; prompts versioned; failures captured. Platform-owned only
      (NOT customer ProjectSites sites). Uses the existing Langfuse skill/MCP.
    - *Anchors:* `~/.claude/skills/langfuse/`, Langfuse MCP, slice 6's tracker (shared signal).
    - *Extends:* the model-use tracker (slice 6) — Langfuse is its durable backend.

### Lower-priority / consolidation (ride wider cadence)

15. **[IND · wave 4] Encode the §6 precedence ladder + the §21 reinvention anti-oscillation protocol** as deterministic reconcile steps in the capture/intake path. *Extends:* `prompt-as-training-signal` + the feedback-intake block.
16. **[IND · wave 9] Unified machine-readable completeness dashboard (§29)** aggregating COVERAGE.yml + gp-register + feature manifests + visual findings into one JSON + rendered view. *Extends:* `validate:features`, COVERAGE.yml.
17. **[IND · wave 4] SEO 17-step keyword gate + DataForSEO wiring (§22)** for platform marketing + generated sites (NOT customer products). *Extends:* seo-auditor + `citations`.

---

## Part D — projectsites PREREQUISITE (standalone, high-priority — NOT part of the global campaign)

> This is a **projectsites.dev product-infra** blocker, separate from the agent-ecosystem upgrade
> above. It is high-priority on its own because it gates ALL worker auto-deploys.

- **Symptom:** the CI worker deploy (`.github/workflows/project-sites.yaml`, 22K, present) is
  BLOCKED by a flaky Jest open-handle/timer leak — "worker process failed to exit gracefully" —
  implicated in `apps/project-sites/src/__tests__/platform_root_landings.test.ts` (present, 3.5K).
- **Confirmed config state:** `apps/project-sites/package.json` → `"test:unit": "jest --config
  jest.config.cjs"` with **NO** `--forceExit` and **NO** `--detectOpenHandles`; `jest.config.cjs`
  does **not** set `forceExit`/`testTimeout`. So the leak currently has nothing stopping it from
  hanging the runner.
- **Fix options:**
  1. **Diagnose + fix the leak (preferred):** run `jest --detectOpenHandles` from
     `apps/project-sites` to find the open handle/timer, then `unref()` the timer / close the handle
     (DB client, server, interval) in the offending test/teardown.
  2. **Pragmatic unblock:** add `--forceExit` to `test:unit` (`jest --config jest.config.cjs
     --forceExit`). Fast, but masks the leak rather than fixing it — pair with option 1 as a follow-up.
- **Verification:** worker Jest green from `apps/project-sites` (config is `.cjs`), CI
  `project-sites.yaml` goes green, and a subsequent `wrangler deploy --env production` is unblocked
  and prod-verified. TDD note: if a real handle is found, the fix is the regression guard itself.
- **Not done by this intake.** Flagged as the top standalone item; owner can take it in a normal
  fire independent of the 10-wave campaign.

---

## Honesty footer

Nothing above is implemented. This is a capture+reconcile+slice intake only. Verdicts were checked
against the live estate (`~/.agentskills/bin`, `~/.claude/commands`, installed binaries, loop docs),
not against the directive's own prose. Open questions (a) and (c) are genuine DECISION-REQUIRED
gates; (b) and (d) are reconcilable with the proposed framing but want a one-word confirm. This is a
multi-session campaign spanning 10 waves — expect 10+ fires, not one.
