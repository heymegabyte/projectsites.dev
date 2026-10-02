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

1. **FILE 3** — ✅ ABSORBED fire-81 (swarm/delegation axis → BACKLOG § fire-81 replenish; starter slice = provider entitlement registry).
2. **FILE 5** — ✅ ABSORBED fire-82 (CF-native voice -> BACKLOG § fire-82 replenish FILE-5 epic + `FILE5-VOICE-DECOMPOSITION.md`; DIRECTIVE-2 verbatim-persist still pending).
3. **FILE 1** — Resources 7-tab editor — ✅ ABSORBED fire-80 (COMBINED §S5 + DIRECTIVE 3 fold + gp GP-13).
4. **FILE 4** — AWOS master (already adopted REV-2026-10-02-awos-master → MASTER-PROMPT.md; verify-then-absorb).
5. **FILE 2** — shipping F001–F100 (largely in AWOS WALKTHROUGH/gp-register; verify no dup, then absorb).
6. **FILE 6** — CF Artifacts + three-bucket storage + transparent large-file Editor — `draining` (2026-10-02: decomposed into 5-cycle epics + Cycle-1 storage-routing policy SHIPPED; Cycles 1b–5 queued).

## Queue

### FILE 3 — `ProjectSites_Claude_Code_Master_Prompt_v2.md` (102K, 2026-10-02 01:44) — status: `absorbed` (2026-10-02, fire-81)
Spirit: shared swarm architecture, Claude permanent orchestrator, DeepSeek-first delegated inference, MiniMax/OpenAI specialists, Exa discovery + Deepcrawl ingestion, existing-benefits-first media routing, MCP provider ecosystem. **Absorbed: YES** (fire-81 — decomposed into BACKLOG § fire-81 replenish FILE-3 swarm epic; archive retained as gitignored local artifact, spirit fully in BACKLOG — safe to rm manually).
Epics:
- `/delegate` interface + provider registry (capability × entitlement × funding)
- DeepSeek-first routing for commodity work (recon, test-writing, cleanup)
- MiniMax adapter for long-context / multimodal specialized inference
- Exa web-discovery + Deepcrawl first-party ingestion integration
- Media funding governance (existing-benefits-first; Unified Billing exceptions by justification)
- Browser Run / Stagehand v2.5.x consolidation + verify Cloudflare Agents availability

### FILE 5 — `ProjectSites-Cloudflare-native-master-prompt.md` (65K, 2026-09-28) — status: `absorbed` (2026-10-02, fire-82)
Spirit: CF-native convergence loop, 5 workstreams (A Voice/all-call media · B Twilio/SMS/Stripe · C Editor Claude-Code/Sandbox/browser · D ProjectSites MCP broker · E CF-native surfaces); 13-item acceptance; real browser video + transcript replay; consent/compliance. **Absorbed: YES** (fire-82 — full-fidelity drain -> BACKLOG § fire-82 replenish FILE-5 epic + `.claude/run-the-loop/FILE5-VOICE-DECOMPOSITION.md`; DIRECTIVE-2 verbatim-persist still pending per PENDING-DIRECTIVES; archive copy safe to rm manually).
Epics:
- Voice page (tabs: Numbers, Conversations, Agent config, Test Console, MCPs, Share)
- Twilio voice/SMS provisioning: real quote → Stripe payment → number activation
- Original audio/video capture (Twilio dual-channel WAV + Browser Run pixel video + rrweb DOM)
- Synchronized call-detail playback (audio + video + terminal + browser events per timeline)
- Editor Sandbox binding (Claude Code job → CF Container → Browser Run live view + terminal replay)
- ProjectSites MCP broker: scoped tool registry + site-level authorization

### FILE 1 — `projectsites-resources-ai-implementation-prompt.md` (28K, 2026-10-02 02:36) — status: `absorbed` (2026-10-02, fire-80)
Spirit: 7-tab AI-native Resources editor (Buckets, Schedule, Functions, Agents, Connections, Knowledge, Manage) with shared copilot, typed action registry, resource graph. **Absorbed: YES** (fire-80 verify) — the 7 tabs + action registry + resource graph + shared copilot are enumerated in `COMBINED-DOWNLOADS-2026-10-02.md` §S5; S5 explicitly folds under the adopted `REV-2026-10-02-awos-master` parent in `PENDING-DIRECTIVES.md` §DIRECTIVE 3; the Buckets/Manage tab is tracked as `gp-register.json` GP-13 ("Fully manage site-scoped R2 buckets and objects" -> WLK-10/11/16/17). Archive copy (gitignored local artifact) safe to `rm` — `.claude/run-the-loop/downloads-intake-archive/projectsites-resources-ai-implementation-prompt.md`.
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

### FILE 6 — `cloudflare-artifacts-three-bucket-implementation.md` (37K, 2026-10-02 12:42) — status: `draining`
Spirit: Cloudflare Artifacts as the default source/version-history backend; **three physical R2 buckets per account** (per-site Preview + Production PLUS one protected per-account Media → `2N+1` topology); **mandatory >30,000,000-byte (decimal, not 30 MiB) routing to Media** regardless of type; transparent large-file editing where every file (>300MB video) stays at its logical Code path while bytes resolve to Media; **immutable Preview→Production promotion that pins Media versions (never recopies >30MB bytes)**; flag-gated incremental migration; destructive-edge + visual + deployed-canary tests. `siteId` stays the stable identity; `gitl.ink` = branded deep link, not a separate storage platform; keep canonical editor/nav (no resurrected Workspace/Git/Inspector sidebars).
**Starter slice SHIPPED (2026-10-02 fire):** `packages/shared/src/storage-policy/` — the ONE server-enforced routing authority (`selectFileStorage` + `safeSelectFileStorage` + `LARGE_FILE_THRESHOLD_BYTES=30_000_000` + `StorageRoleSchema` + `fileByteLengthSchema`), 29 boundary tests green (29,999,999/30,000,000/30,000,001 + 30 MiB + dishonest-size reject), tsc+eslint clean, wired into the `@bolt/shared` barrel. Every future write boundary calls it.
Epics (each ≈ one drain fire):
- **Cycle 1a — shared storage contracts**: Zod-derived `AccountStorage`/`ProjectStorage`/`LogicalFileEntry`/`WorkspaceRevision`/`AssetVersion`/`UploadSession`/`ReleaseManifest`; versioned asset manifest holds portable IDs + hashes + roles, NEVER payloads/secrets/signed-URLs. [routing policy ✅ done]
- **Cycle 1b — Artifacts provider + idempotent provisioning**: `ArtifactsRepositoryProvider` behind the repo/revision abstraction; provision/reconcile Preview+Production+Media roles via persisted IDs (never read an API failure as "repo missing"); Wrangler `artifacts` binding (≥4.145.0), `using`+`info()`, real returned remote URL; keep GitHub/no-remote adapter for migration; Artifacts = default, GitHub not a prerequisite.
- **Cycle 1c — logical-filesystem unification**: a >30MB `public/videos/intro.mp4` stays at its path in Code, bytes resolve to account Media under an immutable site/asset/version key; rename/move = metadata only (no object copy); replace = new immutable version; threshold-cross reclassifies ONLY the new version (CAS vs expected revision); authenticated asset hydration for Sandbox/builds/export.
- **Cycle 2 — large-file upload/Save/reopen**: unify across Editor/Source/Buckets/drag-drop/AI-gen; `@uppy/aws-s3` (check installed version) against R2; backend-controlled multipart (≈16 MiB parts, bounded concurrency, 10,000-part ceiling, equal non-final parts); progress/pause/resume/cancel/retry-jitter/expiry-renew; server initiate/sign-part/list/finalize/abort authorized per persisted session (never sign a client-chosen bucket/key); finalize verifies real size/type/integrity + required tier (ETag≠SHA-256); type-aware editor panels (text / very-large-text ranged / video-audio stream / images-archives-binaries); authorized range serving (HEAD/206/Content-Range/416) on an ISOLATED content origin.
- **Cycle 3 — immutable Preview→Production promotion**: durable retryable state machine (freeze revision → build once from pinned inputs → copy only ordinary payloads + manifest shards to Production, **pin Media versions by reference not bytes** → advance `main` with expected-head check → CAS active release via per-project DO coordinator → live smoke → rollback on verified failure); Workflows + Queues + DO; recover copy-done-but-activation-failed + main-advanced-but-Production-old; Media GC walks retained releases/drafts/active-uploads/pending-promotions/forks/exports/retained-history against a durable pin index; rollback restores code+media refs WITHOUT recopying bytes.
- **Cycle 4 — Source UX + ecosystem + CF-first policy**: Source shows remote/working-changes/approved-rev/history/comparisons/asset-changes + states (Saved in Preview · Not yet committed · Ready to promote · Live in Production); Media diffs (version/size/type/role/poster) not binary text; integrate into Editor/Preview/Promote/Resources>Buckets/Schedule/history/templates/IDE/AI-run/API-MCP/analytics; protect system buckets; per-site-agent Artifacts forks + repo-scoped tokens (only the merge service holds canonical write); add a CF capability registry + decision rule to architecture docs/skills/`/run-the-loop`; optional Stream derivative (tus >200MB) preserving the R2 original; plan `2S+A` bucket capacity (1,000,000 buckets/account limit).
- **Cycle 5 — migration + destructive-edge tests + visual review + release**: flag-gated incremental migration (inventory legacy R2/isomorphic-git/fs; copy each needed immutable legacy >30MB version into Media, hash-compare, reference-map before switching reads; immutable replacement release + legacy resolver during retention; back up history before any Git externalization; one test site first); unit/provider-contract/integration/browser/deployed-canary; **required evidence incl. a real ≥350MB video full lifecycle** (interrupt→resume→Save→reopen→seek→rename→replace→Promote→Production-download→rollback, proving NO >30MB payload entered Artifacts/Preview/Production), exact threshold cases across text/binary/agent/MCP/generated/import/build-output, security (tenant/path-traversal/manifest-injection/content-origin/secret-leak), GC/lifecycle/site-deletion never deleting release-pinned Media, bounded-memory streaming proof; Playwright/Browser-Run visual review (inspect screenshots, not OCR); update ledger/ADRs/contracts/API-MCP docs/runbooks + regression gates for any >30MB payload routed outside Media.
Preserve-invariants (never violate on any drain): stable `siteId` identity · never collapse Preview/Production env buckets · deployment pins verified Media versions (no byte-dup into Production, no dependence on mutable Preview) · `30 MB = 30,000,000 bytes` decimal · Better Auth/OpenFGA + Langfuse preserved · Claude orchestrator with DeepSeek/MiniMax delegation preserved · no mathematically-unlimited-size claims.
Sources: S1–S14 CF docs (Artifacts limits/binding/git-protocol · R2 upload/limits/presigned/s3/consistency · Workers limits · Workflows · DO · Stream · best-practices) — recheck live before each drain. Archived: `.claude/run-the-loop/downloads-intake-archive/cloudflare-artifacts-three-bucket-implementation.md`.
