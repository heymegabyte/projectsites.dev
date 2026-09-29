# CAMPAIGN — Cloudflare-native AI, MCP, Chat, workspaces (Brian, 2026-09-29)

Losslessly-condensed canonical spec (decisions/constraints verbatim; inferable prose cut).
Implement via the EXISTING /run-the-loop (lanes map onto roster roles — no second scheduler).
Original directive arrived fire-55; source-review baseline commit 29007fdf2. Never stop at
plan/backlog — keep advancing ready slices every fire until §17 acceptance is satisfied.

## North star

ProjectSites offers its OWN intelligent AI service via OpenAI-compatible + Anthropic-compatible
endpoints. Customer creates an API key in Settings → picks protocol + sites/MCP connections/
accounts/resources/tools/permissions → gets base URL + token. Using it, ProjectSites auto-executes
their authorized integrations SERVER-SIDE (no re-connecting MCP in their client). ONE shared
execution+permission core powers: public compat APIs · external ProjectSites MCP server · per-site
AI + connected accounts · website editing/assets/data/publishing · social+Notion · phone/SMS ·
scheduled workflows · editor/dev environments · a sidebar entry named exactly **"Chat"**
(Cloudflare OS integration).

## Hard architectural decisions

- ALL-IN Cloudflare-native. **Remove LiteLLM** (`apps/project-sites/infra/litellm/` + Neon/Upstash
  deps) — no replacement proxy/hosted-agent-backend/PG/Redis/second control plane. External model
  APIs, customer integrations, payment, telephony carriers stay intentional boundaries; execution,
  routing, state, permissions, metering, approvals, UI are OURS on CF.
- Prefer **cloudflare/agents** (+ @cloudflare/think, ai-chat, codemode, shell, worker-bundler —
  published APIs only, pin versions). **cloudflare/workers-oauth-provider** = preferred MCP-OAuth
  foundation (app owns tenant/scope enforcement). Reuse proven CF/FOSS inside our platform
  (cloudflare-os Apache-2.0 · agents MIT · vibesdk MIT · workers-oauth-provider MIT · sandbox-sdk).
  Preserve notices, pin commits.
- EXTEND existing surfaces — never duplicate Settings screens/editors/auth/integration catalogs.
  Do NOT resurrect removed UI-authored per-site AI-endpoints; Site Functions stay code-defined WfP.
- Storage: D1 = durable account/config/grants; DO = serialized budgets/coordination/hot state;
  R2 = large assets/immutable artifacts; Vectorize = authorized retrieval; Workflows/Queues =
  durable async. KV = cache/config + OAuth-lib storage ONLY — never the authority for immediate
  revocation/spend (add coordinated grant-revision/revocation checks).

## §2 Foundations to verify at HEAD (source-review 2026-09-29, NOT prod-exercised)

1. Extend: Workers/Hono+D1/KV/R2/DO/Workflows backend · Angular/Spartan admin · app/ bolt.diy editor.
2. `services/api_tokens.ts` — psk_ tokens, SHA-256 in D1, plaintext-once, expiry/revocation → EXTEND
   (+ existing Settings/API Tokens UX).
3. `libs/features/platform_mcp/` — 56 catalog entries, org-scoped dispatcher; handler hand-rolls
   initialize/tools-list/tools-call (init/list public static). Starting point ≠ transport conformance.
4. `libs/features/mcp_oauth_provider/schemas.ts` — only sites:read/write (public API also has
   data:read/write). ONE registry must reconcile grantable scopes+tool permissions; consent lacks the
   site/resource matrix. AUDIT grant minting for escalation (bearer identifying an org must not mint
   beyond presenter).
5. `services/mcp_client.ts` — provider adapters, encrypted creds, paste-key. Some providers
   unimplemented/config-missing — catalog card ≠ working integration.
6. `services/ai_env_vars.ts` — encrypted scoped vars: REUSE; inject secrets narrowly at execution
   boundaries, never plaintext into model context.
7. `services/llm_tier_router.ts` — DEFECTS: latency rule can override security-review task; fallback
   steps down without capability checks; assumes premium-only vision. FIX with verified per-model
   capabilities.
8. Consolidate `libs/features/model_registry/` + `external_llm.ts` + `ai_gateway.ts` +
   `gateway_route.ts` into ONE routing authority (don't add another router).
9. `infra/litellm/` — port useful eval/routing/budget/telemetry natively BEFORE removal.
10. `services/ide_sandbox.ts` — fabricated demo runs/timer progress/fake file events → replace with
    REAL workspace/Sandbox/job state. No pretend anything.
11. `app/lib/modules/llm/providers/projectsites-ai.ts` — internal /api/bolt/chat/completions adapter
    + fixed internal marker: marker must NEVER authorize the public API; preserve editor while
    converging auth/inference.
12. WfP = normal published serving, R2 fallback; Preview/Promote frozen-revision semantics preserved.

CF reference notes: VibeSDK ThinkAgent/SpaceDO (SQLite+Artifacts fs-backends, @cloudflare/shell/git
≈ isomorphic-git; Think disables Bash — full shell = separate runtime); trace ACTUAL configured
paths (README ≠ deployed impl; legacy Sandbox paths remain upstream). Cloudflare OS: workspaces,
gadgets/blueprints, resource-scoped Gatekeepers → adopt introductions/capability boundaries/
receipts/approval queues; keep proposed vs completed effects visibly separate. Workers AI = hosted
inference (10k Neurons/day is OUR account allocation, not per-customer; no unlimited-free promises).
AI Gateway: legacy /compat/chat/completions REQUIRED for dynamic routes; dynamic routing NOT on
REST API — reverify before adapters. OpenRouter: build readiness, never promise acceptance.

## §4 One shared execution/permission core (converge INTO existing modules)

Protocol adapters (OpenAI/Anthropic/external-MCP) · principal resolution (session|API key|OAuth
grant|site agent) · policy registry (sites/resources, concrete connections, actions, budgets,
approvals) · connection broker (creds/refresh/discovery/execution) · CF agent runtime (bounded tool
loops, runs, resumable Chat) · model router (capabilities/quality/cost/latency/fallbacks) · gateway
adapters (EVERY model request through established AI Gateway boundary) · workspace/runtime services
(files/revisions/previews/Sandbox/browser-verify/promotion) · metering (authoritative
reservations/accounting + analytics).

EVERY entry point calls the SAME authorizer + tool executor. Enforce the INTERSECTION:
owner RBAC ∩ key/OAuth grant ∩ selected site/resource ∩ selected concrete connection ∩ allowed
action ∩ feature entitlement ∩ current revocation/approval/budget — checked immediately before
EVERY tool execution/external effect. Prompts/tool output/session IDs/caller-supplied site IDs
can never expand access. Capabilities = Zod + typed manifests: stable tool IDs ·
read/write/publish distinction · resource requirements · cost class · idempotency · approval
behavior. Unknown/discovered tools inherit NOTHING; MCP annotations are hints, not permission
evidence.

## §5 Settings: AI API Keys

Extend Settings/API Tokens with "AI API Keys" (no detached dashboard/duplicate token DB).
Create: name + protocol (OpenAI|Anthropic|both) → select sites/resources + connections/accounts +
actions → expiry/usage limits/approval-automation policy → show endpoint + plaintext token ONCE.
Separate Copy controls (endpoint/key/config examples). Working curl + official-SDK examples
(OpenAI: OPENAI_API_KEY + explicit base_url/baseURL; Anthropic: ANTHROPIC_API_KEY + custom base
URL; env-var conventions only where client supports them). Support: list/describe · edit/narrow ·
expire/rotate/revoke · last-use + usage/cost · connection health · inference-only / site-specific /
multi-site keys. Existing tokens keep working WITHOUT silently gaining AI/publish/integration
access. Never redisplay plaintext, never keys in URLs/logs. Grants reference CONCRETE
connection/account IDs, site/resource IDs, actions, models, limits. Every request needs an
unambiguous active site (configured default | explicit supported context | site-specific endpoint)
— reject ambiguity. Optional context extensions never required for ordinary single-site SDK use.

### Permission popup (DialogShellComponent + tokens + Angular/Spartan)

"Choose access"/"Manage permissions" button w/ selection counts. Popup: live search
(provider/connection/site/capability/tool) · selected pinned on top w/ quick deselect · selections
survive search changes · groups from the REAL catalog (Sites, Assets/Data, Social, Knowledge/
Notion, Communications, Developer tools, custom MCPs) · Select all + Clear all · group selection
(incl. all-social, all-Notion) · "Select all matching" vs "all available" distinct · tri-state
group checkboxes · collapsible per-site/per-connection permissions · real account identities for
multi-connections · states: connected/expired/not-configured/unavailable · Connect/Reconnect
preserving draft selections · readable summary + permission diff · keyboard/focus-trap+return/SR
labels/mobile/reduced-motion. "Select all" = CURRENT eligible entries within actor's authority
(never future sites/connections/new publishing tools). Unavailable items can't become grants.
Presets: Read only · Draft assistant · Publishing assistant · Custom. Optional "Help me choose"
use-case → proposes SMALLEST suitable grant, previewed before apply. Permission-aware idea chips
(Notion→website drafts, social campaign, analytics inspect, prepare assets) never broaden access.
Publish/delete/calls/texts stay distinct from read/draft — selecting a connection ≠ every
dangerous action.

## §6 ProjectSites MCP + OAuth consent

CF Agents + official MCP SDK: Streamable HTTP, protocol negotiation, init, implemented
tools/resources, cancellation, errors, auth discovery. Expose only principal-usable tools;
INDEPENDENTLY re-authorize during tools/call. workers-oauth-provider foundation (combined vs split
Workers per current APIs/topology). ProjectSites sign-in/RBAC stays the identity authority (no
parallel identity DB). Consent shows: client + verified origin · requested access + expiry · all
CURRENT eligible sites selected by default · site search/all/none/individual. Grant SNAPSHOTS
selected IDs (no future sites). "Customize permissions" opens the SAME selector as API keys.
Capabilities: site read · draft editing · preview · publish/promote · media+data · social
draft/publish · connected-resource r/w · phone · SMS · other registered actions. Presets + final
summary. Default site selection ≠ unlimited publish/delete; never exceed client scopes or user
authority. Enforce: PKCE S256 · exact redirect-URI · CSRF/state · resource/audience binding ·
AS/resource metadata · registration support · code expiry + ATOMIC single-use (two simultaneous
exchanges of one code must not both succeed) · secure refresh rotation/replay · revocation ·
app-level scope enforcement (delegated child ≤ presenter). Connected-applications UI: view/narrow/
revoke; changes hit active runs before their next action. External MCP + API-managed execution use
the same dispatcher.

## §7 Genuine OpenAI/Anthropic compatibility

Stable public endpoints on ProjectSites-owned origin (prefer https://projectsites.dev/v1 unless
existing routing requires an owned API host); show ACTUAL deployed URL in Settings+docs; customers
never need our account IDs/gateway creds. Implement+verify: GET /v1/models (+lookup) ·
POST /v1/chat/completions (Bearer, response/chunk schemas, streamed+non-streamed tools) ·
POST /v1/messages (x-api-key, anthropic-version, content blocks, system/messages semantics,
tool_use/tool_result, stop reasons, usage, event streams) · POST /v1/messages/count_tokens
(verified tokenization/provider counting — no char heuristics as exact counts) · separately-tested
POST /v1/responses workstream (Chat-Completions-works ≠ Responses-compat). Publish compat matrix
(SDK methods/params, streaming, multimodal, JSON/schema output, caller tools, thinking, cache
controls, token counting); unsupported → protocol-appropriate errors, never silent strip. Preserve
provider-bound reasoning/signatures; never manufacture Anthropic thinking signatures or translate
incompatible artifacts. curl/SDK must reach API paths w/o browser-only bot challenges (narrow
API WAF/rate-limits w/ token auth; zone protections stay). Deliberate CORS where browser use is
supported. OpenAI streams: consistent IDs/indexes, correct tool deltas, finish reasons, usage,
ONE terminal marker. Anthropic streams: documented named events, content-block indexes, cumulative
usage, one terminal stop. Handle malformed frames/disconnects/cancel/timeouts/mid-stream failure;
no custom progress JSON inside standard SDK streams. Virtual models: projectsites-auto|fast|
balanced|premium → configured backends w/ verified capabilities + versioned routing policies;
never claim actual Claude/GPT when another backend served; explicit pinning only where
available+authorized; never advertise unsupported modalities/limits.

## §8 Managed MCP execution (no client config)

Key with selected integrations + managed execution: resolve authorized connections/resources →
introduce relevant tools → bounded model/tool loop on ProjectSites → compatible final answer —
from a NORMAL SDK request with zero MCP config. TWO boundaries: (A) ProjectSites-managed tools =
saved grants, executed server-side; (B) caller-supplied functions = caller's — return native
protocol tool calls for client execution, never invent server impls or dispatch arbitrary fn names
as integrations. Both in one request: collision-free namespaces + correct continuation
transcripts. Preserve tool-choice semantics (none = no tools; JSON-only stays JSON-only). Internal
tool args/traces live in authorized run receipts, not exposed as external calls. Stateless
Chat/Messages compat FIRST — basic managed-tools + caller-tool continuations need no proprietary
header. Unrelated requests on one key share NO mutable state; Responses handles tenant/key-bound +
storage prefs. Plan internal steps BEFORE final-answer streaming; no leaked drafts, no restart of
visible answer on another backend, no completion claims before effects finish; valid keepalives
while waiting. Meter EVERY hidden step per-provider (documented aggregate semantics — never bill
from fictional final-model counts). Bound: steps/wall-time/output+tool-result size/parallelism/
spend/retry-escalation depth. Retries never duplicate publish/SMS/calls. Useful partial-failure
results without claiming completion. Approval-required ops → actionable protocol-compatible
pending receipts; server-verified approval or narrow configured automation ONLY ("model said
confirmed" ≠ approval).

## §9 Routing + billing

Authorization is deterministic — AI picks backend, never permissions. Sequence: (1) filter by
actual capabilities/context/data-policy/availability/model-grants/min quality; (2) Workers AI for
cheap classification/extraction; (3) DeepSeek or configured good-value backend for ordinary
gen/coding where evals support (CF-hosted counts); (4) Anthropic/premium for demanding
reasoning/security-sensitive (latency/outage can NEVER silently downgrade below required
quality); (5) specialized image/audio/video backends via Gateway/native adapters, durable jobs
over held-open chat. Cheap structured classifier only when benefit > latency/cost; safe caching of
routing decisions. Optional draft/evaluate/escalate; bounded judges; self-reported confidence ≠
evidence; quorum opt-in only. Native Gateway routing/fallback where apt; ONE owner of retries (no
SDK×Gateway×app retry multiplication). Preserve context/reasoning constraints across fallback;
after bytes emitted, propagate failure — never splice another backend's answer. Ship:
schema-validated versioned routing policies · canary/shadow evals (no external effects) ·
representative quality/cost/latency benchmarks · concise route reasons ·
backend/attempt/tool-step/usage/cache/cost receipts. Sensitive prompts/secrets out of default
analytics. Serialized budget reservation/settlement/crash recovery (DO); enforce key/org
spend/rate/concurrency/action limits; count classifier/judge/retry/tool inference + jobs; refund
unused reservations; idempotent reconciliation. Gateway metrics ≠ billing/permissions. Cache only
eligible results scoped by tenant+grant-revision+resource-state+model/policy-version; caching
never skips writes or leaks tenants. Distinguish CF free allowance vs our pricing vs marginal
cost.

## §10 Per-site AI, connections, communications

Per-site agent config: instructions · allowed models · selected connections/resources · non-secret
business context · secret bindings · automation limits. Multi-account per provider; multiple
OAuth/API-key MCP servers. REAL remote MCP discovery (pagination/capability negotiation/refresh/
current schemas) via supported Agents clients; HTTP adapters where no MCP exists (label transport
honestly); OAuth preferred, API-key fallback preserved. RECONCILE: libs/features/mcp_connections/ ·
site_mcp_server/ · services/mcp_site_tools.ts · platform_mcp/ — preserve/migrate existing site MCP
tokens/connections; no dispatchers with inconsistent permission rules. Secrets decrypt/inject only
into authorized adapters/runtimes at use-time (models get names/capabilities, not plaintext).
No env-scope collisions/cross-tenant. Platform-wide CF/payment/telephony/model creds never reach
site code/browser bundles/arbitrary shells. Treat MCP endpoints/redirects/descriptions/retrieved
content/generated code as UNTRUSTED: network boundaries, no private-URL probing, validated args,
bounded results, redacted errors; never forward creds to wrong origin. Unify site edits/assets/
Notion/social/calls/texts behind the capability executor. Native Agents voice/Workers AI/Realtime
where supported; REAL carrier boundary for PSTN/SMS (reuse working Twilio — CF has no carrier).
Typed tools + idempotency keys + operation receipts. Scheduling via agent schedules/Workflows/
Queues; re-evaluate grants/budgets/approvals AT execution. Recipient allowlists in tests;
approved-destination policies in automation.

## §11 Chat (Cloudflare OS)

Sidebar entry labeled exactly "Chat" → first-class ProjectSites workspace built on Cloudflare OS
(NOT a link/unauth iframe to os.cloudflare.app). Inspect packages/workshop-frontend +
workshop-backend + mcp-shared + MCP/Notion Gatekeepers + sharing/auth/action-store; pin adopted
code; document reuse-vs-adapt. Our admin shell + sign-in preserved; frontend island or
service-bound Worker under OUR origin/session w/ verified tenant/site identity is acceptable.
Deliver: conversations · active site/resource selection · connection picker · real execution
progress · reconnect/resume + cancel · action receipts · approval inbox · artifact previews.
Suggestions tied to REAL capabilities (improve homepage, draft social campaign, summarize Notion,
inspect analytics, prepare asset); unavailable → guide to connect. Connection selection = allowed
CEILING; introduce only relevant authorized tools per run; on-demand discovery/tool-search over
every-schema-in-prompt. Gadgets/Code-Mode snippets: narrow bindings, controlled egress, bounded
execution. Same router/grants/approvals/per-site context as APIs+MCP. Chat ≠ publish rights;
proposals/drafts visibly distinct from executed effects; website diffs + campaigns reviewable
before publish; roll back only genuinely reversible actions.

## §12 Fast editor + disposable environments

ADR FIRST (compare configured VibeSDK paths + our account features/entitlements) before committing
to R2/isomorphic-git design. Evaluate: SpaceDO-style SQLite workspace/git · optional Artifacts
history/lazy hydration · Worker Loader/Dynamic Workers + worker-bundler previews · Sandbox SDK
(Linux tools/installs/builds/CLI/terminals) · Browser Run (browser checks only — not fs/shell) ·
existing WfP serving + immutable promoted revisions. Verify maturity/plan/limits/APIs. Functioning
CF-native fallback when Artifacts/Facets/Loader unavailable; ONE workspace/runtime interface
(list/read, batched edits, revisions/checkpoints+diffs, snapshots, previews, sandbox exec,
promotion) — no competing sources of truth. Optional preview infra never blocks endpoint/key
delivery. Separate draft state | immutable source revisions | previews | published deployments.
Preserve bolt.diy until verified parity (no second editor). Enforce identity/normalized paths/
optimistic revision checks/serialized commits/conflicts/size limits. Large assets in R2; hot
metadata + small file ops must not scan R2 or boot containers. isomorphic-git+object storage
needs a real fs/object layer + serialized ref authority (R2 ≠ POSIX/transactions). Guests:
isolated temp workspace identities, quotas, signed previews, TTL cleanup, secure claiming;
deliberate prefixes/repos/DOs (no bucket-per-guest without evidence); never a shared anonymous
workspace ID; container disks ≠ durable history. Recover from sleep/eviction/reconnect/expired
previews/interrupted builds. Metadata/tree first, hydrate on demand, batch, stream REAL progress,
compute on demand. Benchmark cold/warm open, first read, edit→preview, reconnect, build, promote
p50/p95 BEFORE perf claims. Promotion = authorized frozen revision via existing WfP; autosave
never publishes; preserve rollback/history/assets/Functions/per-site data isolation.

## §13 LiteLLM removal + cutover

Inventory case-insensitive refs (code/config/containers/deploy routes/catalogs/provider
selections/flags/env/scripts/tests/docs); identify active callers + customer-visible keys/models.
Port useful routing/quotas/eval/telemetry natively WITH acceptance tests. Switch editor,
site-generation, internal jobs, public callers BEFORE retiring proxy. Preserve owned
usage/history; rotate/reissue keys where plaintext unrecoverable. Remove infra, deps, bindings/
routes/config, catalog entries, docs. External storage deps removed only where proxy-exclusive.
One real deployment story in docs/UI; no git-history rewrites. Deployed DO identities + applied
migrations handled via verified rename/deprecation/migration plan (never blind class removal or
migration rewrites). Temporarily-required legacy identifiers → record platform evidence + tracked
cleanup blocker (no false zero-refs claims). Drift gate rejects reintroduction. Native API works
with proxy unavailable.

## §14 Post-core bounded workstreams

One approvals inbox (Chat+APIs+MCP+scheduled) · website branches/diffs/checks/immutable promotion
receipts/reversible rollback · Notion→draft→social→approved-publish workflows · site knowledge w/
citations + namespace-enforced Vectorize (inspect/delete) · dynamic tool discovery + bounded Code
Mode · real progressive generation + resumable browser verification · optional routing evals +
"why this backend/what it cost" receipts (no private reasoning) · durable media jobs
(callbacks/R2/quotas/scoped downloads) · site-scoped agent templates/automation presets inheriting
grants. Breakthroughs never block a working endpoint+key+managed-MCP.

## §15 OpenRouter readiness

Stable virtual-model IDs · compatible streaming/usage · truthful pricing/capability/context/output
metadata · geo disclosures · monitoring · retention policies. Check current provider requirements
+ upstream redistribution terms. Private tenant-integrated execution stays separate unless
approved verified end-user delegation exists; shared provider cred can't identify tenant
Notion/social auth; never trust caller-supplied user strings/metadata/aliases as tenant identity;
never expose private MCPs through a global key. Deliver readiness/conformance artifacts;
acceptance is external — no incidental application submission.

## §16 Lanes (map onto roster; dependency chain)

1 Inventory/ADRs · 2 Policy/storage (shared schemas, concrete grants, additive migrations,
principal resolver, revocation, audit, budgets) · 3 Key management (token APIs, Settings, selector,
examples, expiry/rotate/revoke) · 4 Inference protocols (model registry, native routing, OpenAI
Chat, Anthropic Messages+counting, streams, Responses) · 5 Managed tools (MCP/HTTP adapters, site
context, internal loops, mixed caller tools, approvals, metering) · 6 External MCP/OAuth
(conformance, dispatcher, provider integration, site picker, granular consent) · 7 Chat (CF-OS
integration, identity/resources, execution, receipts, resume) · 8 Workspace/editor (native
adapter, fast previews, real Sandbox jobs, Browser Run, guest cleanup, frozen promotion) ·
9 Cutover/removal · 10 Business workflows · 11 Provider readiness/ops.

Chain: inventory → policy → key-grants/model-routing → protocol adapters → managed execution.
OAuth+Chat consume the same policy/executor. Workspace research independent but precedes editor
migration. Proxy removal after verified caller cutover. Publishing/communications depend on
authorization+approval+idempotency. Feature modules + typed flags (dark experimental → verified
rollout); no dark-through-inertia, no partial facades.

## §17 Definition of done (acceptance cases — all REAL browser/backend, no fixture-only)

1. Create OpenAI key in Settings → search/select a real authorized connection → copy endpoint/key
   → official SDK request with NO MCP config accesses the selected resource correctly.
2. Same for Anthropic, streamed+non-streamed; events accumulate to valid final Message; token
   counting + unsupported-feature errors verified.
3. Key restricted to Site A + one Notion account: direct API, model tools, Code Mode can NOT
   reach Site B or another account.
4. Selector: search retains selections; selected pinned; all/group selection + presets work;
   disconnected providers don't fake success; keyboard/mobile/a11y pass.
5. OAuth: preselects current eligible sites, supports narrowing, prevents escalation/code-replay/
   wrong audiences; client reaches only approved resources/actions.
6. Narrow/revoke mid-run → next action denied; authz-infra failure denies (never grants).
7. Managed + caller tools across turns/collisions/tool-choice/JSON; caller functions never
   silently executed server-side.
8. Outages/missing capabilities/limits/invalid streams → correct errors/fallbacks;
   security/reasoning never downgraded solely for latency; no restart after streaming begins.
9. Concurrency/retries/disconnects/crashes respect budgets; no double-billing or duplicate
   SMS/calls/publish; allowlisted test recipients; unauthorized sends fail closed.
10. Chat opens from sidebar, uses authorized site context, real progress/receipts, resume/cancel,
    shared approvals.
11. Guest workspaces isolated, real files, real previews, reconnect recovery, secure claiming,
    safe expiry; real Sandbox commands + Browser Run checks when enabled.
12. Promotion serves EXACTLY the frozen revision; later edits don't change it; assets/Functions/
    per-site data verified.
13. Native APIs/editor/generation work with the old proxy UNAVAILABLE; no obsolete execution
    paths in active code/config.

Every fire: run worker/frontend/editor checks + feature/drift gates; coordinated single deploy;
verify changed prod routes/UI with allowed test accounts; real request IDs/assertions/SDK+browser
evidence + LEDGER entries; record missing credentials/entitlements explicitly (never fake a pass).

## References

github.com/{heymegabyte/projectsites.dev, cloudflare/agents, cloudflare/workers-oauth-provider,
cloudflare/cloudflare-os, cloudflare/vibesdk (space/src/space/fs-backend.ts · durable-object.ts ·
worker/agents/think/ThinkAgent.ts), cloudflare/sandbox-sdk} · build.cloudflare.dev ·
os.cloudflare.app · developers.cloudflare.com/{workers-ai/platform/pricing, ai-gateway/usage/
rest-api, ai-gateway/features/dynamic-routing} · developers.openai.com/api/reference (chat create
+ streaming-events) · platform.claude.com/docs/en/build-with-claude/streaming ·
openrouter.ai/providers/apply
