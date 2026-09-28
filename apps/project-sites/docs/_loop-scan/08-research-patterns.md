# Best-practice patterns 2026 — research

ProjectSites.dev scan (CF-native site-delivery SaaS; Angular admin, bolt.diy editor, per-site D1/R2, WfP, multi-agent loops). Web-researched 2026-09-28. `[HIGH]`/`[MED]` = adoption priority.

## Admin dashboard UX
2026 consensus: organize by user JOBS not internal feature taxonomy (task-first IA completes goals
~45% faster); command palette is now baseline, not power-user luxury; role-based ADAPTIVE views
(not just permissions); progressive disclosure (summary-first, depth on demand); one type ramp +
one spacing scale + one accent. Linear is the cited gold standard (every action via Cmd+K; 3 type
sizes, 2 weights, 1 accent). Dashboards evolving into conversational/copilot systems.
- [HIGH] Ship a real Cmd+K palette where EVERY admin action is reachable (create site, switch site,
  change plan, open editor, toggle flag, deploy). We have one dialog primitive + site switcher —
  wire them into a palette. Model after Linear. (+~25% power-user task completion cited.)
- [HIGH] Re-audit IA around owner JOBS ("get my site live", "edit copy", "see who contacted me",
  "get paid") vs our current feature-named nav. Job-labels beat noun-labels.
- [MED] Role/stage-adaptive default view: new owner → Getting-Started hub (already our dashboard);
  returning owner → their live site + inbox; super-admin → ops. Different DEFAULTS, same product.
- [MED] Empty-state design (named 2026 trend) — every empty admin surface = first-action launchpad
  (matches embarrassingly-easy); + design-system discipline: audit hard-coded brand colors drifting
  from tokens (`_polish.scss`); F-pattern → primary action top-left/bottom-right.

## In-browser editor UX
Landscape split 3 ways: AI app builders (Bolt/Lovable), AI IDEs (Cursor/VS Code+Copilot), cloud
IDEs (Codespaces/CodeSandbox/StackBlitz). Key UX axis = WHERE code runs: StackBlitz WebContainers
(in-tab, instant open, browser-runtime ceiling) vs CodeSandbox microVMs (full env, Git-like
env-branching). 2026 shift: repo-first + PRs stop being optional — "open a URL and code" survives
but every change flows through a real PR/review gate. Retool/ToolJet push agentic data workflows;
Airtable/Softr = no-code data apps with built-in grid + permissions.
- [HIGH] We're already WebContainer/bolt.diy (right call for instant-open web IDE). Lean into the
  StackBlitz strength: fast shareable preview; keep boot cost hidden (our persistent iframe already
  does this). Don't chase microVM parity — it's the wrong axis for our product.
- [HIGH] Make every editor change land through a reviewable gate (snapshot/PR-like) — our Code
  Project hub (deploy/snapshot/git) is the canonical entry; surface a diff-review before publish.
- [MED] Data tab = our Airtable/Retool moment: the per-site D1 grid should feel like Airtable
  (inline edit, filters, sort, type-aware cells), not a raw SQL dump. Pair with the SQL console
  (POST db/query + shared DataGrid) for power users.
- [MED] Agentic data workflows (Retool pattern: event → agent gathers context → acts) map onto our
  Functions/WfP — an owner-facing "when a form arrives, do X" builder is a natural next surface.

## Notifications
Route each message to the LEAST-interruptive fitting channel: in-app inbox = referenceable history
(bell top-right, grouping, filters, mark-all-read); toasts = ephemeral post-action confirms; badges
= glanceable; push = urgent/external only; modals = action-required only. Biggest fatigue lever =
cut VOLUME via batching + digests. Preferences must be granular per-category × per-channel,
collected progressively, synced across devices (all-or-nothing → users pick nothing). Copy formula:
actor→action→object→context→primary-action, <15 words, verbs first, names not IDs, never
guilt/loss-framed. Architecture: 3 nouns + one outbox table, preferences evaluated LATE, digest
windows keyed by user×channel, status record providers fill in, at-least-once + dedup, cached prefs
(Redis), graceful per-channel degradation. AI products: "run finished" + "run needs input" almost
always need explicit inbox+email, push opt-in.
- [HIGH] We use psnotify (DO-backed) — confirm it does batching + DIGEST windowing, not just
  per-event fan-out. Digest/batch is the single highest-fatigue-reduction lever.
- [HIGH] Ship a granular preference center: per-category (build/deploy/domain/billing/contact-form)
  × per-channel (inbox/email/push) + quiet hours. Progressive, not a wall of toggles.
- [HIGH] Our long-running builds ARE the AI-product case: "site build finished" + "build needs
  input / degraded" → explicit inbox + email; push opt-in. (We have a completion-email-vs-notif
  drift noted in memory — reconcile: bell = psnotify DO, not d1 notifications table.)
- [MED] Enforce copy formula on every notification string (<15 words, actor-action-object,
  business-owner words not our jargon). Late preference evaluation + dedup keyed on terminal
  success (matches our webhook-idempotency memory).

## AI-native / agentic patterns
The defining 2026 shift: chat sidebar → Generative UI (agent returns real components — cards,
forms, charts — not text). Copilot metaphor maturing "passive copilot → collaborative partner".
Spectrum of 3 patterns: (1) controlled/static (predefined components), (2) tool-calling → REGISTERED
components (most mature/production — agent tool-call auto-renders a mapped component), (3)
open/runtime-generated markup (flexible but LLM-code-in-browser = unsafe; prototyping/sandbox only,
NOT production). Protocols standardizing the last mile: AG-UI (CopilotKit), MCP Apps (shipped across
Claude/ChatGPT/VS Code/Goose in 2026), A2UI, Open-JSON-UI. Best surfaces often have NO chat at all
(inline: M365 Copilot, Linear Insights, Superhuman triage, HubSpot Assist). Metrics shifting from
engagement → "decision velocity" + "prompt success rate". Mood = pragmatism/"year of reckoning";
validate agent-generated UI (CHI2026 "Design Theater" — claimed vs actual design reasoning gap).
- [HIGH] Prefer tool-calling → registered-component GenUI over free-form chat for our AI surfaces
  (site-gen results, data insights, concierge): agent returns a site-preview card / a data chart /
  an editable form, not a wall of text. Never ship pattern-3 (runtime LLM markup) to owners.
- [HIGH] Inline/no-chat AI beats a bolted-on sidebar: put AI where the work is (edit-in-place in the
  editor, insight panels in analytics, prefill in create flow) — matches AI-permanence + embarrassingly-easy.
- [MED] Our bolt.diy editor + MCP integration is well-positioned for MCP Apps (`ui://` bundled HTML
  rendered in a sandboxed frame) — watch as the interop standard for owner-connected tools.
- [MED] Adopt decision-velocity / prompt-success-rate as AI-surface metrics; add a validation/eval
  gate on agent-generated UI + site output (we already gate on completeness-checker + build_validators).

## Cloudflare-native architecture
Role separation is the load-bearing pattern: D1 = facts/relational, Vectorize = semantic context,
Durable Objects = stateful sessions/agents, KV = cache, R2 = files, Queues = simple async,
Workflows = durable multi-step orchestration, AI Gateway = observability + provider portability +
caching/rate-limit/retry/fallback. An "agent" ≈ a Durable Object (singleton-per-id, own SQLite,
hibernation → run millions ~free when idle). Agents SDK earns its weight for tool-use / multi-step /
memory-summarization; a plain DO suffices for chatbot-with-history. Agents SDK evolving to a LAYERED
runtime (Fibers durable-exec + Code Mode sandbox + Dynamic Workflows underneath). Workflows: one
step per atomic API/stateful action; steps idempotent + cache outputs (deterministic replay);
per-step retry+backoff; `step.sleep()` for multi-day waits at no wall-cost; `waitForEvent` to pause
for external input. Design caution: constraint > capability — every tool is an attack surface.
- [HIGH] Our primitive split is textbook-correct (D1 platform + per-site D1, R2 sites, KV host-cache,
  Workflows site-gen, WfP hosting). Keep it. Add Vectorize for semantic surfaces (site search,
  "sites like mine", AI concierge grounding) — the missing leg vs the canonical D1+Vectorize+DO trio.
- [HIGH] Route ALL LLM calls through AI Gateway for per-request cost/latency/error observability +
  one-line provider swap + caching/fallback. Attach metadata (siteId, orgId, workflow) to break down
  spend. (We use Workers AI via AI Gateway per CLAUDE.md — verify metadata + fallback are on.)
- [MED] Audit site-gen Workflow steps for idempotency + cached outputs (deterministic replay avoids
  re-charging AI/re-provisioning). Use `waitForEvent` for the "build needs owner input" pause instead
  of failing. (Matches our premature-terminal-status-strands-rows memory.)
- [MED] For per-site agentic features, model each as a DO (own SQLite, hibernation) rather than a
  new data tier — cheap multi-tenant isolation by construction. WfP isolation is per-instance.

## Multi-agent convergence-loop patterns
2026 default = fleets of specialized agents over single-agent loops; "3 focused agents beat 1
generalist working 3× as long" — gains are multiplicative (parallelism × specialization × isolation
× compound-learning). Dominant architecture = hierarchical orchestrator → parallel worker waves →
Verifier (coordinate→build→verify). Research: AORCHESTRA +16% on GAIA/SWE-Bench/Terminal-Bench
(subagent = INSTRUCTION+CONTEXT+TOOLS+MODEL, spawned on demand); AdaptOrch +12-23% from topology
ROUTING not peer chatter. Three tiers: (1) in-terminal subagents (1-3), (2) local parallel fleets in
worktrees (3-10, dashboards+merge control), (3) cloud autonomous (ship-while-you-sleep → PR).
Verification/anti-stagnation is THE hard problem: agents mistake stagnation for progress + trust
their first solution ("self-evaluation bias"); fix = external grounding — verify against the SPEC by
RUNNING TESTS + reading full output, NOT re-reading own code; persist a progress file + git history
so the next session confronts a passing/failing list as ground truth. SWE-bench lesson: grade by
executing the test suite, never by self-report.
- [HIGH] Our loop already matches the winning shape (fresh worktree-isolated agents, orchestrator
  foreground, deploy + prod-verify). Reinforce the VERIFIER leg: gate DONE on executed tests +
  prod-E2E asserting real content, never on an agent's self-report (we do this — keep it explicit;
  it's the #1 researched failure mode).
- [HIGH] Add loop guardrails: MAX_ITERATIONS cap, reflection prompt between retries ("what failed,
  what one change fixes it"), kill/reassign after ~3 stuck iterations on the same error, hard token
  budget with pause threshold. Prevents the stagnation-as-progress trap our loop-charter guards.
- [HIGH] AGENTS.md/CLAUDE.md must stay HUMAN-curated — research: LLM-generated context files give ~0
  benefit, can cut success ~3% + raise cost ~20%; developer-written yields ~+4%. Don't auto-generate
  our CLAUDE.md files.
- [MED] Prefer topology ROUTING (right specialist per task) over peer-to-peer debate — the measured
  win is from routing, and peer chatter adds latency (2-5×). Skip fan-out when "specialists" share
  the same tools+model (matches our "never bare general-purpose, but don't over-decompose").
- [MED] Note Claude Agent SDK one-level-deep limit (subagents can't spawn subagents) — for
  teams-of-teams, use feature-lead subagents that own a scope, not recursive spawning.

## Sources (URLs)
- Admin: saasui.design/blog/7-saas-ui-design-trends-2026 · taqwah.agency/blog/saas-ux-design-best-practices · gitnexa.com/blogs/saas-dashboard-ux-patterns
- Editor: jetadmin.io/blog/replit-alternatives-how-to-pick-the-right-ai-app-builder-or-cloud-ide-in-2026 · retool.com/blog/top-vibe-coding-tools · aicoolies.com/reviews/stackblitz-review
- Notifications: knock.app/blog/guide-to-notification-systems-and-tooling · magicbell.com/blog/notification-system-design · courier.com/guides/how-to-build-a-notification-center/chapter-3-best-practices-for-notification-centers · foundey.com/blog/notification-ux · appbot.co/blog/app-push-notifications-2026-best-practices
- AI-native: copilotkit.ai/blog/the-developer-s-guide-to-generative-ui-in-2026 · phenomenonstudio.com/article/ai-product-design-trends-to-watch-in-2026 · dev.to/blove/the-landscape-of-generative-ui-in-2026-ad6 · arxiv.org/pdf/2607.22928 (CHI2026 Design Theater)
- CF-native: blog.cloudflare.com/building-workflows-durable-execution-on-workers · github.com/cloudflare/agents/blob/main/guides/anthropic-patterns/README.md · buildmvpfast.com/blog/cloudflare-agent-memory-vectorize-d1-edge-2026 · architectingoncloudflare.com/chapter-15
- Multi-agent: addyosmani.com/blog/code-agent-orchestra · flowhunt.io/blog/multi-agent-ai-system · arxiv.org/pdf/2607.25152 (self-eval bias) · langchain.com/blog/improving-deep-agents-with-harness-engineering · arxiv.org/pdf/2606.22678 (RigorBench)
