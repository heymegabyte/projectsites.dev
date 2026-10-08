# Master Agent Skills Upgrade & Implementation Directive (Brian, 2026-10-08)

> Dropped verbatim into the live `/run-the-loop` session fire-306d. This is the canonical
> capture for §0.5 intake. It is a MAJOR multi-wave upgrade of the GLOBAL agent ecosystem
> (skills/commands/orchestration/OpenSpec/multi-model/observability) — explicitly NOT a
> projectsites.dev product change ("Do not modify unrelated production applications … Do not
> modify DeskLink/GitLink as part of this agent-skill upgrade"). Execute across fires/sessions,
> never wholesale in one turn. Never fabricate research/tests/integrations/deployments.

## Scope / host
- Upgrade the agent system: `~/.claude` skills/rules/hooks/agents/commands + `/run-the-loop`.
- Preferred persistent host = the existing **Ubuntu Desktop VM under Proxmox** (primary user
  `codexrye` + its GitHub runner). THIS session is on Brian's Mac (`/Users/Apple`) — the
  multi-model execution host determination is an OPEN QUESTION (this Mac vs the Proxmox runner).
- Preserve working config; discover-don't-overwrite; migrations/adapters; checkpoint before invasive changes.

## The single entry point
- `/run-the-loop [request]` is the ONE user-facing autonomous command; all specialized
  workflows invoked internally. With args → incorporate; without → resume highest-priority
  persisted work. NEVER an uncontrolled recursive chain — one coordinator + bounded subordinate agents.

## 32 sections (requirements, condensed-faithful — nothing dropped):
1. Core philosophy: (A) comprehensive upfront product research (short prompt ≠ small product);
   (B) continuous reactive discovery; (C) completion before distraction (new ideas interrupt only
   for critical blocker / bad-architecture / wasted-work / security / compelling-value).
2. **Automatic improvement is the DEFAULT** — if an improvement is beneficial+compatible+feasible+
   affordable+safe, adopt automatically; no "would you like us to…" lists. Questions only for:
   genuine requirement conflicts, material business decisions, new recurring costs, destructive/
   irreversible, missing auth, security/privacy/legal, essential user-specific intent. EMBED this
   rule EXECUTABLY in global+project instructions, research/planning/arch/impl skills, OpenSpec,
   prioritization, scheduling, continuous-improvement, evals. "Make it executable, not just documented."
3. 3 authoritative decisions: (A) surpass competitors (research essential+premium+gaps+AI-native;
   record competitive rationale); (B) evidence-based reinvention (Claude+Codex independently
   evaluate consequential changes; don't silently violate explicit constraints); (C) continuous
   discovery + committed completion (expand without constant restart).
4. Inspect+preserve existing env (Claude Code config, ~/.claude, project .claude, CLAUDE/AGENTS.md,
   existing /run-the-loop + /goal, OpenClaw, ClawRouter, Claude account routing, Codex CLI, OpenCode+DeepSeek,
   OpenSpec, GH Actions+runners, repos, MCP servers, Cloudflare, Infisical, Langfuse, Promptfoo, Sentry,
   PostHog, browser automation, component registries/design systems). Preserve `codexrye`; no dup users/runners.
5. One orchestration entry point (/run-the-loop) — internal sub-workflows; keep ordinary prompts + manual commands.
6. Capture+reconcile every new user instruction (lightweight, deterministic, nonblocking hook/intake):
   preserve original → extract explicit/implied/architectural/constraints/preferences/corrections/opportunities
   → compare vs spec → dedupe/reconcile → update docs+OpenSpec → add tasks. Capturing a prompt must NOT
   auto-launch a dev loop. Precedence: explicit-now > explicit-constraints > accepted-OpenSpec > evidence-ADRs
   > justified-inferred > research-enhancements. Never let inferred override explicit prohibition.
7. Product Knowledge Ledger (persistent, structured; complement OpenSpec not compete): identity, users,
   objectives, positioning, feature/UI inventory, arch/design decisions, request history, research evidence,
   tech, OpenSpec IDs, golden paths, deps, implemented, gaps, deferred, rejected+reasons, verification.
   Traceable: request→research→decision→OpenSpec→task→component/API→test→screenshot→deploy.
8. Portfolio catalog. Standalone products: **DeskLink (deskl.ink)** remote-desktop + AI-agent desktop infra;
   **GitLink (gitl.ink)** AI GitHub repo discovery/evaluation. Do NOT modify either here.
9. Multi-model architecture: OpenClaw orchestration, ClawRouter routing, ~3 Claude accts, 1 Codex, 1 OpenCode+DeepSeek.
   Claude=lead architect/synthesis/integration/final-verify. Codex=independent research + adversarial design/security/
   visual critique (must challenge Claude; read-only where practical). OpenCode/DeepSeek=high-volume research/crawl/
   competitor-enum/components/CRUD/tests/inventory/docs/keyword/simple-fixes. Routing by importance/complexity/judgment/
   vision/cost/context/history/availability/limits; track model use+outcomes; don't re-call expensive when a verified result exists.
10. **Recursive research + prompt-expansion engine** (most important subsystem): Pass1 understand product;
    Pass2 competitor intel (5-10 commercial + 5 OSS, feature matrix, broad crawl not just homepages, respect robots/ToS);
    Pass3 recursive decomposition (Product→Modules→Features→Subfeatures→Screens→Components→Interactions→Data→APIs→
    GoldenPaths→Tests; expand e.g. "Media Library" fully); Pass4 architecture; Pass5 UI+design (every route/state);
    Pass6 golden paths; Pass7 independent Codex review; Pass8 synthesis (single long implementation prompt);
    Pass9 convergence (2 consecutive clean passes; bounded by budget; persist unfinished + proceed).
11. Recursively generate+implement improvements: ~30 candidates/dimension (features/UX/IA/nav/design/components/
    interactions/search/data/APIs/integrations/AI/a11y/perf/SEO/analytics/onboarding/billing/collab/auth/authz/
    deploy/test/observability/docs/DX); rank by value/advantage/cost/feasibility/reuse/deps/fit/security/maintenance/
    benefit; implement ~top-30% (not a ceiling); dedupe; 3 horizons (essential/premium/differentiation); promote to OpenSpec.
12. **Auto Research Prompt.md** in every active project root (NOT committed; use .git/info/exclude): Input verbatim;
    Output = Research Started (ts/runId/project/task/objectives/models/providers/stages) + full OpenCode/DeepSeek +
    Codex + Claude responses (exact prompts, redacted CLI, model, ts, exit, full user-visible content, sources) +
    Research Comparison + Original-vs-Expanded + **Synthesized Implementation Prompt (exact, before impl)** +
    Execution Results + Final Synopsis. Single-writer, atomic, interruption-safe, bounded retention; America/New_York
    ts; raw logs under ignored `.agent/reports/`; redact secrets visibly; report unavailable models honestly.
13. Beautiful terminal reporting: Charmbracelet **Gum** (status/spinners/phases/tables/headers) + **Glow** (markdown
    summaries/synopsis); dark+cyan; keep native CLI intact; machine logs ANSI-free; plain-text/CI fallback. Final report
    = 14 sections (Run Summary, Completed, UI, OpenSpec, Golden Paths, Research/Arch, Tests, Screenshots, Integrations,
    Deploy, Agent Contributions, Next Steps, Recommendations, Blockers). Always real evidence + Next Steps + Recs.
14. **OpenSpec = canonical change system**: inspect install; init where missing; use explore/propose/apply/update/sync/
    verify/archive via ACTUAL supported CLI (not invented syntax / not assume chat slash = shell). Continuous integration:
    new findings → identify affected reqs → new/changed/superseded → reconcile designs/tasks/golden-paths/accept-tests →
    track status. Batch; never mark complete on a checkbox alone — validate vs real behavior.
15. UI-FIRST: build comprehensive UI inventory before heavy backend; first waves = shell/nav/routes/layouts/workspaces/
    dashboards/tables/forms/editors/dialogs/drawers/search/settings/onboarding/responsive/shared-components/states.
    UI coverage gate = all prioritized screens navigable+responsive+essential-states (typed fixtures ok, mocked=visibly
    classified incomplete). Capacity while UI gaps: ~70% UI/vertical-slices, 15% research/OpenSpec/discovery, 10% test/visual,
    5% docs/cleanup (adaptable; never trade critical security/correctness).
16. Shared design system + component reuse: search repo→shared libs→registries→framework ecosystem→reputable OSS BEFORE
    building. React=shadcn/ui + CLI. Angular=native + conventions (don't force React into Angular). Promote broadly-useful
    components to a versioned shared registry; prevent duplication; propagate superior components across screens.
17. Visual QA + Codex screenshot review (mandatory for substantial UI): Cloudflare Browser Run + Playwright; capture major
    routes/breakpoints/menus/dialogs/editors/forms/data-rich/empty/loading/permission states; Codex image inspection on
    high-impact screens + Claude independent judgment. 20-criterion rubric; concrete actionable findings (severity/location/
    impact/fix/component/OpenSpec-req/verify); loop capture→analyze→prioritize→implement→test→recapture→compare.
18. Golden-path-driven dev: executable acceptance scenarios per major feature (state/role/pre/actions/UI/data/external/
    success/errors/cleanup); generate tests from OpenSpec; Vitest+Playwright; unit/component/integration/E2E + screenshots;
    realistic multi-step browser sessions; isolated data + cleanup; prod-safe separate from destructive; no complete-without-evidence.
19. Persistent task orchestration + anti-thrashing: durable queue (id/OpenSpec-refs/priority/deps/owner-lease/acceptance/
    files/state/attempts/failures/verification); worktree isolation; dedupe/stable-priorities/WIP-limits/leases/retry-limits/
    reopen-cooldowns/conflict-detection/edit-revert-detection/checkpoints/escalation. Priorities: blockers>essential-caps>
    UI-surfaces>committed-golden-paths>broken-behavior>major-visual>essential-integrations>high-value-scope>noncritical-arch>cleanup.
20. Dynamic parallel-agent scheduling (no fixed count): specialist RESPONSIBILITIES — Research Explorer, Product Scope
    Expander, Architecture Critic (Codex), OpenSpec Auditor, UI Completion, Component Reuse, Golden-Path Grower, TDD,
    Visual Critic, Documentation Maintainer, Code Simplifier, Style/Arch Guardian, SEO, Integration Auditor, Cost Optimizer,
    Agent Skills Improver. Recurring scope-expansion + completeness review; DeepSeek heavy for cheap work.
21. Scope expansion without losing completion: Workstream A (committed impl, most resources) + B (continuous discovery);
    B must not rewrite priorities arbitrarily; promote only justified changes; ranked future queue; reinvention rule
    (record→independent eval→cost→explicit-reqs→migration→adopt-if-justified; avoid oscillation).
22. SEO+content research: keyword research before every public SEO page/article (DataForSEO where configured; 17-step
    process); one primary keyword/intent/page; never invent metrics; no thin content; SEO only where it matters.
23. Cloudflare-first infra: evaluate Workers/Browser Run/D1/R2/KV/DO/Queues/Workflows/AI Gateway (+Dynamic Routing)/
    AI Search/Agents/Workers AI/Hyperdrive/Access/Secrets Store/MCP. AI Search for research/docs/decisions/knowledge/skills/
    OpenSpec retrieval (current bindings, not deprecated AutoRAG). Browser Run for Playwright; long orchestration on the
    persistent runner (not assume every Worker is a persistent desktop process).
24. Integrate selected services thoroughly (platform-owned apps; NOT customer ProjectSites sites): Sentry (browser+Worker,
    releases/sourcemaps/context/filtering/sampling/grouping/resilience), PostHog (pageviews/events/funnels/flags/experiments/
    replay/consent/naming), Langfuse (model/routing/prompts/latency/cost/tools/MCP/delegation/evals/failures/traces), Promptfoo
    (prompt-expansion regression/research-synthesis/provider-compare/tool-calling/golden-path-planning/structured-output/security/
    CI/cost-latency), Infisical (dev/preview/prod envs, machine identities, least-priv, GH OIDC, safe injection, rotation, no secrets in logs/frontend).
25. Complete every integration not just install (audit config/SDK/browser/Worker/agent/MCP/auth/secrets/env-isolation/errors/
    instrumentation/tests/deploy/docs/privacy/cost/reuse; reusable completeness checklists+tests).
26. Continuously improve docs + code (dedupe/compress/update-status/preserve-decisions/align-OpenSpec; dead-code/consolidate/
    unused-deps/simplify/optimize/conventions/typing; ShellCheck+linters; no refactor regressions).
27. Improve the agent skills themselves (~30 candidates/category, implement ≥top-30%): research/prompt-expansion/competitor/
    arch/OpenSpec/UI/component-reuse/visual/screenshot/golden-path/routing/parallel/scheduling/knowledge/CF/SEO/observability/
    security/docs/code-quality/terminal/deploy/continuous-improvement. Project-first then promote validated generalizable patterns
    to global (with regression suite; concise global skills; no redundant copies).
28. Validate prompt-expansion with real Promptfoo evals (benchmark requests: CMS/CRM/booking/analytics-dashboard/improve-empty-
    screen/SEO-article/complex-integration); measure intent/competitors/evidence/arch-alternatives/Codex-critique/feature-inventory/
    screens/golden-paths/reuse/OpenSpec/tasks/order/no-unnecessary-questions/no-redundant-research/auditable-prompt; compare vs
    baseline; long≠better.
29. Product completeness metrics (features/screens/golden-paths defined/impl/passing, critical issues, visual findings, integration
    completeness, deploy verification, research gaps, open arch decisions); dashboard/machine-readable; complete only when
    requirement+impl+tests+behavior agree.
30. Acceptance criteria (verify, don't claim): entrypoint works/resumes/no-recursion; research (DeepSeek volume, Codex review,
    Claude synth, external capture, honest missing-provider); audit trail (Auto Research Prompt.md auto-created/captured/excluded/
    redacted/interruption-safe); OpenSpec; UI (scheduler prioritizes screens, reuse, inventory, visual review, Codex findings);
    execution (ownership, anti-churn, scope-expansion, specialists, recovery); quality (test-gen, golden-path, Promptfoo, regressions,
    baseline); reporting (Gum/Glow/plain-fallback/parseable-JSON/Next-Steps+Recs).
31. Execute in 10 waves: 1 Discovery/Baseline, 2 Research/Arch, 3 Core Orchestrator, 4 Research/Audit Pipeline, 5 OpenSpec/Knowledge,
    6 UI/Visual, 7 Specialist Agents, 8 Observability/Security, 9 Eval/Refinement, 10 Convergence (repeat until 2 clean passes or budget;
    bounded; persist remaining).
32. Final: implement-don't-recommend; research every dimension; auto-adopt justified improvements; evidence-based reinvention;
    preserve explicit reqs; OpenSpec contract; reusable UI early; finish committed golden paths; keep expanding; DeepSeek for economy;
    Codex for independent/visual; Claude for synthesis/orchestration; capture real research + exact expanded prompt; Gum/Glow;
    resumable/observable/tested/efficient; NEVER fabricate; respect permissions/security/budgets; avoid unnecessary questions;
    don't modify unrelated prod apps. Ultimate: 5-word request → full competitive research → independent arch → ambitious spec →
    UI inventory → design system → OpenSpec → multi-agent impl → golden paths → visual excellence → verified deploy; then every
    request/discovery improves it. "Discover relentlessly. Expand intelligently. Implement decisively. Finish what matters. Verify everything."
