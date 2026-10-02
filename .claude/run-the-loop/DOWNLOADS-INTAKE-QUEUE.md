# Downloads Prompt Intake Queue

Durable queue for the `/run-the-loop` § 0.5 Prompt Intake phase. Brian drops master prompts into
`~/Downloads` (`projectsites*.md` / `ProjectSites*.md`); the loop drains **ONE per fire**, imports its
SPIRIT by decomposing it into `BACKLOG.md` ledger items (never reads the giant file in the lead —
delegates to a fresh agent), advances only the slice that fits the fire's budget, then marks the row
`absorbed` + removes the archived source. Governed by global rule `split-work-into-ledger` (prefer many
small optimization cycles on specific elements over one mega-pass).

- **Sources archived** (moved OUT of `~/Downloads` 2026-10-02 to clean the inbox + preserve fidelity):
  `.claude/run-the-loop/downloads-intake-archive/` — drains read the full file from there, then `rm` it once `absorbed`.
- **Status values:** `queued` (not yet decomposed) · `draining` (decomposition in progress this fire) · `absorbed` (spirit fully in the ledger; archive copy removed).
- **Reconciliation 2026-10-02** (heading-scan vs `PENDING-DIRECTIVES.md` + `COMBINED-DOWNLOADS-2026-10-02.md`): epics below are the STARTING decomposition — each drain fire does the full-fidelity pass before flipping to `absorbed`.

## Drain order (oldest-value-first, net-new before already-absorbed)

1. **FILE 3** — net-new swarm/delegation axis (not represented) → decompose FIRST.
2. **FILE 5** — CF-native voice (partial; = REALTIME-VOICE-DIRECTIVE, not yet persisted).
3. **FILE 1** — Resources 7-tab editor (mostly in COMBINED §S5; verify + fold remaining).
4. **FILE 4** — AWOS master (already adopted REV-2026-10-02-awos-master → MASTER-PROMPT.md; verify-then-absorb).
5. **FILE 2** — shipping F001–F100 (largely in AWOS WALKTHROUGH/gp-register; verify no dup, then absorb).

## Queue

### FILE 3 — `ProjectSites_Claude_Code_Master_Prompt_v2.md` (102K, 2026-10-02 01:44) — status: `queued` ⭐ drain-first
Spirit: shared swarm architecture, Claude permanent orchestrator, DeepSeek-first delegated inference, MiniMax/OpenAI specialists, Exa discovery + Deepcrawl ingestion, existing-benefits-first media routing, MCP provider ecosystem. **Absorbed: NO** (net-new axis; pending `REV-2026-10-02-swarm-delegation`).
Epics:
- `/delegate` interface + provider registry (capability × entitlement × funding)
- DeepSeek-first routing for commodity work (recon, test-writing, cleanup)
- MiniMax adapter for long-context / multimodal specialized inference
- Exa web-discovery + Deepcrawl first-party ingestion integration
- Media funding governance (existing-benefits-first; Unified Billing exceptions by justification)
- Browser Run / Stagehand v2.5.x consolidation + verify Cloudflare Agents availability

### FILE 5 — `ProjectSites-Cloudflare-native-master-prompt.md` (65K, 2026-09-28) — status: `queued`
Spirit: CF-native convergence loop, 5 workstreams (A Voice/all-call media · B Twilio/SMS/Stripe · C Editor Claude-Code/Sandbox/browser · D ProjectSites MCP broker · E CF-native surfaces); 13-item acceptance; real browser video + transcript replay; consent/compliance. **Absorbed: PARTIAL** (= REALTIME-VOICE-DIRECTIVE, not yet persisted; PENDING-DIRECTIVES §DIRECTIVE 2).
Epics:
- Voice page (tabs: Numbers, Conversations, Agent config, Test Console, MCPs, Share)
- Twilio voice/SMS provisioning: real quote → Stripe payment → number activation
- Original audio/video capture (Twilio dual-channel WAV + Browser Run pixel video + rrweb DOM)
- Synchronized call-detail playback (audio + video + terminal + browser events per timeline)
- Editor Sandbox binding (Claude Code job → CF Container → Browser Run live view + terminal replay)
- ProjectSites MCP broker: scoped tool registry + site-level authorization

### FILE 1 — `projectsites-resources-ai-implementation-prompt.md` (28K, 2026-10-02 02:36) — status: `queued`
Spirit: 7-tab AI-native Resources editor (Buckets, Schedule, Functions, Agents, Connections, Knowledge, Manage) with shared copilot, typed action registry, resource graph. **Absorbed: YES-ish** (COMBINED §S5 + PENDING-DIRECTIVES §DIRECTIVE 3 describe it; verify full decomposition before delete).
Epics:
- Buckets tab: R2 object listing + upload + delete + versioning UI
- Schedule tab: cron/workflow calendar + approval policy
- Shared resource copilot (context-aware assistant across all tabs)
- Action registry (forms/AI/API/MCP) with side-effect levels + idempotency
- Resource graph (uses/invokes/reads/writes dependency viz)
- Manage tab (inventory control, binding reconciliation, audit log)

### FILE 4 — `projectsites-autonomous-loop-master-prompt.md` (224K, 2026-10-02 01:35) — status: `queued`
Spirit: AWOS consolidated master — 50+ sections, 52 golden paths, 45 walkthrough reqs; Site Consciousness digital-twin; event-sourced SiteEvent nervous system; 4 autonomy horizons; 5 autonomy levels; ExecutionPlanner/ComputeRouter; one durable SiteAgent per site. **Absorbed: YES (core)** — the adopted `REV-2026-10-02-awos-master` → MASTER-PROMPT.md + BACKLOG §AWOS + ADR-0057. Verify standing artifacts cover it, then absorb.
Epics:
- SiteAgent digital-twin per site (entity graph + autonomy hierarchy)
- Event-sourced SiteEvent nervous system (DO + D1 + Workflow)
- ExecutionPlanner route selection (CF-first destination hierarchy)
- Autonomic control loop (observe→validate→decide→preview→approve→execute→verify)
- 5 autonomy levels (observe→recommend→preview-auto→bounded-prod→autonomous-ops)
- Multi-tier memory (working/episodic/semantic/procedural/visual/causal/strategic)

### FILE 2 — `projectsites-ai-shipping-claude-code-prompt.md` (87K, 2026-10-02 02:03) — status: `queued`
Spirit: F001–F100 feature registry (30 required + 70 recommended); daily organic publishing (1000–1200 words, 8 photos, infographic, ElevenLabs narration); analytics-driven work; live visual assistance; Waves 0–4. **Absorbed: LARGELY** (COMBINED §S2 + PENDING: F001–F100 in AWOS WALKTHROUGH/gp-register — reuse, never duplicate). Verify no dup, then absorb.
Epics:
- Daily organic publishing pipeline (topic → article → infographic → ElevenLabs narration → schedule)
- Analytics work-discovery (every ~1000 events; traffic/cohort/conversion signals)
- Live chat widget: frontend context + HITL approval for permitted mutations
- Wave rollout structure (Wave 0 foundation → … → Wave 4 experimental)
- Wire F001–F035 required features into AWOS backlog + flags (verify no dup)
- Visual-assistance live element picker + contextual help
