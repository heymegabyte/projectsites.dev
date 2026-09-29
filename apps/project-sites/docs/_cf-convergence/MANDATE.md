# MANDATE — ProjectSites.dev Cloudflare-native convergence run (immutable spec)

> The authoritative WHAT/WHY for the CF-native convergence run. The living HOW/NOW queue is
> `apps/project-sites/_CF_NATIVE_CONVERGENCE.md` (lanes 12–18 of the single `/run-the-loop` cron).
> Implementation mandate, not a speculative essay: work in bounded reviewable cycles (~15 min/slice)
> until the acceptance matrix is green or a concrete external dependency blocks a specific check.
> Read current files before acting. Preserve unrelated work + existing user-facing capabilities.

## Product outcome

- A site owner configures + previews a voice assistant in Admin › Voice, purchases + assigns a
  Twilio voice/text number, answers a phone or browser-mic call through the SAME default ProjectSites
  AI chat + MCP tools, watches the agent's Cloudflare browser live, then opens the call's detail page
  and replays the untouched original audio in sync with the actual browser pixels. Every eligible call
  defaults to browser video capture even when nobody watched live. The owner critiques a precise
  moment, reviews the resulting behavior rule, applies it to later relevant conversations.
- The Editor's bolt.diy chat launches an authorized Claude Code job in a Cloudflare Sandbox. A compact
  split widget shows a terminal + the job's Browser Run Live View. After completion: separately
  replayable terminal events, Browser Run session replay, and any pixel video. The job can inspect/
  edit site files, run code + tests, preview an app, and request scoped ProjectSites MCP tools.
- Cloudflare = primary runtime + storage. Twilio = PSTN/SMS. Stripe = customer billing.

## Architecture contracts

- Worker/Hono authenticates tenant/site/environment. Durable Objects coordinate active voice sessions,
  browser/jobs, monotonic event clocks. D1 = metadata/permissions/ledgers. R2 = original audio,
  original browser video/frame stream, rrweb events, terminal replay, derived exports. Analytics
  Engine = platform telemetry; **Traks** = customer web analytics. Workflows/Queues = post-call media
  + reconciliation. Site identity follows every tool call + callback.
- **Cloudflare Agents voice API** as verified in the installed release (inspect exports/types; pin the
  supported withVoice/VoiceClient + Twilio-adapter combo). Browser audio = WebSocket; Twilio
  bidirectional Media Stream enters the Worker without a conference. Barge-in + cancellation.
- **Default AI chat is the ONE brain.** Refactor its orchestration into a shared streaming server-side
  service used by text, voice, AND Editor — same site context, LiteLLM/Anthropic provider, AI Gateway,
  approved MCP tools, entitlements, prompt policy. Do NOT double-append the transcript. Honor
  interruption AbortSignal. Fast greetings/cached acks may run at the voice edge; substance uses the
  shared route. Never leak the system prompt or upstream credentials to the client.
- **STT** = Workers AI Flux initially. **Voice model** default Auto (best measured latency/quality by
  language/provider/format/price); trial CF-hosted Aura 2 English; ElevenLabs premium when configured.
  Twilio output MUST be verified raw 16-kHz PCM (default WorkersAI-TTS MP3 is unusable through the phone
  adapter). Per-call catalog/provider selection must not mutate another site's or concurrent caller's TTS.
- **Browser Run is the default browser-automation path** (Playwright, Stagehand, Live View, session
  recording, HITL). The Worker orchestrates remote Chrome; Chrome is not in a Worker isolate. Reuse
  `browser_gateway` + CF Agents browser tools; update its obsolete Browserbase-only Live-View
  assumption. Browserbase = explicit priced fallback only. Allowlisted origins, time/op budgets,
  screenshot+a11y/DOM observation, browser-action event stream; include actual page state (not every
  frame) in the next context. WebMCP = experimental (list per page, inspect schema/approval, fall back
  to Stagehand/Playwright). Stagehand's CF integration pins v2.5.x — verify installed compat before upgrading.
- **Claude Code CLI runs inside a per-site Cloudflare Sandbox Container**; its terminal UI runs in the
  browser. Browser Run Chromium is a different process/session. A Worker/DO binds job, repo snapshot,
  browser session, terminal transcript, site permissions by stable IDs. Persist Git/R2 checkpoints
  (container fs may vanish when idle). Pin one Sandbox SDK line (stable vs 1.0-preview); port the CF
  Claude-Code tutorial to it. Bridge CF bindings + MCP through site-scoped outbound handlers; never
  give the container account-wide admin tokens.
- **build.cloudflare.dev / VibeSDK** = a hosted demo, not a provisioning API. Use ProjectSites'
  provisioning + Workers-for-Platforms APIs for arbitrary per-site Workers/D1/R2/KV/DO/Workflows/
  bindings. CF recommends SHARED prod/staging dispatch namespaces holding many customer Workers —
  isolate each site by Worker identity + server-selected resource IDs + bindings + authz. Do NOT
  promise a dispatch namespace per site.

## Workstreams (actionable slices → `_CF_NATIVE_CONVERGENCE.md`)

- **A — Voice page + all-call media (A1–A9):** keep the 7 tabs; add setup/recording/reviews/call-detail;
  voice gallery + interactive Test Console on the shared AI chat; every-call session + browser-start +
  read-only Live View; real pixel-capture spike (CDP) + rrweb (rrweb ≠ video); dual-channel Twilio
  recording (channels=dual, trim=do-not-trim, before Connect/Stream) → authenticated WAV to R2
  no-transcode + checksum; synced audio+video detail (drift ≤100ms); searchable calls directory + 206
  byte-range streaming; timecoded critique → versioned per-site behavior clause (untrusted, never
  cross-site); jurisdiction-aware consent (audio-only default OFF).
- **B — Twilio numbers/SMS/compliance/Stripe (B1–B6):** live number search + truthful labels; quote →
  Stripe payment → durable purchase state machine + idempotency + compensation (never an orphan
  chargeable number); $0.25/started-min headline (video+recording included) with no hidden $0 rental;
  Stripe recurring rental item + metered voice price + immutable CallSid ledger + nightly reconciliation;
  10DLC/toll-free compliance wizard; outbound AI calling gated (consent/DNC/TCPA). Validate every
  Twilio/Stripe signed callback; never trust a body site/number without a DB ownership check.
- **C — Editor Claude-Code + Sandbox + browser widget (implement ideas 1–12, record 13–15):** per-site
  workspace from an authorized chat tool; split terminal + Live View (multi-tab, replay); server
  terminal events → R2 + replay; Git/R2 snapshot + diff + rollback (never write Production); incremental
  commit-keyed index; signed auth-proxied preview; Sandbox AI executor + result cards; one-click
  tests/typecheck/lint/build/QA cards; site-scoped outbound/MCP bridge (creds server-side); durable
  checkpoints/resume across eviction; disposable dependency experiment; per-site budgets. Prompt
  injection = untrusted; never give browser/Sandbox master D1 or account tokens.
- **D — ProjectSites MCP broker (implement ideas 1–12, record 13–15):** one versioned stateless
  Streamable-HTTP endpoint + OAuth 2.1; consent showing client/redirect host + multi-select owned Sites
  + scopes; Site×operation matrix (risky default-off); logical site→owned WfP resource map (never
  account-wide passthrough); connected-provider registry; audience-bound PS tokens ≠ encrypted upstream
  OAuth tokens (never forward the PS bearer); curated first-party + namespaced allowlisted broker tools;
  capability catalog; per-call policy intersection + recheck at tools/call (reject swapped Site IDs);
  transaction preview + human approval for destructive ops; audit/revocation/rate/cost controls;
  compatibility + negative-tenant tests. Reference `cloudflare/mcp-server-cloudflare` for resold
  resources only; prefer Workers OAuth Provider + stateless handler; do NOT revive McpAgent.
- **E — CF-native product surfaces (E1–E13):** EmDash CMS catalog entry beside Payload; Email sidebar
  (agentic-inbox on SES, per-Site ACL, no Resend rail); dashboard health widget (uptime/p50/p95); Build/
  Apps sidebar (VibeSDK-scoped launch); Automations (React Flow island → Workflows/Queues/DO); Buckets
  (Uppy→R2) + Tiptap headless core; D1 export (selected site only, never master D1); short links via
  Slink (MIT) + claimyour.site migration off the AGPL Dub fork (parity + reversible cutover, preserve
  AGPL notices); Traks analytics (shared account pipeline — CF 20/20/20 limit — everything site-scoped,
  no double-count); cloudflare/agents patterns (licensed/tested only); microfeed publishing (AGPL,
  separately deployed); OpenSEO $10/site add-on + DataForSEO cost metering (issue #268: cost responses
  discarded → custom metering required).

## Explicit TODO queue

- **Inspector removal** — delete KV Inspector + System Services + every other Inspector tab/route
  (routes/menus/components/services/handlers/styles/tests/flags/docs/deep-links). Preserve real
  site-scoped KV/D1/R2/DO/Workflow services. If an Inspector holds a unique needed op, move it to its
  resource page first. Confirm no reappearance via role/flag/deep-link.
- **Social page — 10 consecutive documented improvement passes** — baseline at desktop/tablet/mobile;
  each pass: screenshot → one concrete defect → fix → re-verify same journey + focused test; number
  1–10 in a work log; no cosmetic renames; finish with screenshot comparison + keyboard/mobile + one
  E2E publish/schedule. Keep the 10 together.

## Security + product-behavior gates

- Every Site selection server-verified vs current membership; cross-site reads/writes/callbacks/number-
  assignments/sandbox-previews/media/cookies/R2/MCP have NEGATIVE tests.
- Signed Live View/tunnel/preview/R2 URLs = credentials (never logged/persisted); Browser Run + Sandbox
  egress guardrails; per-site encryption + key rotation.
- Exact state + price; no dead-end button; no hidden fees; never pass rrweb off as pixel video.
  External-consequence actions need reviewed detail + explicit runtime click.
- Mask sensitive form/password/PII in recording/replay/transcript; retention/deletion/export/legal-hold;
  audit access to recordings + critique.
- Feature flag + staged rollout by tenant; backward-compatible API contracts until clients migrate.

## Acceptance matrix (real user journeys — screenshots + network/logs, not unit tests only)

1. Owner selects Site → Voice shows the existing tabs → picks a sample voice → clicks mic → default AI
   chat responds in the selected voice → interrupts → sees transcript + voice metrics.
2. Site with no number → real recommendations/alternatives → transparent Stripe quote → purchase →
   Twilio number assigned → Voice ready; SMS clearly Pending until approved.
3. Caller reaches the number → AI answers before the browser boots → acts via Stagehand/Playwright →
   owner watches the same browser live → call ends → original dual-channel WAV + silent pixel video +
   rrweb stored → dedicated call page seeks + plays aligned audio/video; drift ≤100ms at 0/50/100% in a
   ≥5-min test. Repeat with NO live viewer.
4. Owner clicks at 01:42, writes a critique, previews the proposed prompt clause, publishes, repeats a
   similar scenario → more appropriate answer with provenance; unrelated Site unaffected.
5. Editor chat launches Claude Code in Sandbox → terminal live + Browser Run Live View side by side →
   agent edits a Site file, runs an MCP tool, previews, requests a HITL login, completes → replay tabs
   + diff persist after Sandbox eviction.
6. OAuth client authorizes two Sites but not a third → tools/list + tools/call enforce grants/RBAC/
   upstream scopes/approvals → revocation immediately blocks access.
7. EmDash (+D1/R2/KV/plugin), microfeed (+D1/R2/Queue/cron/feed URL), Slink catalog installs each
   complete setup/domain/health/upgrade/backup/rollback; tenant isolation + provision-failure/retry each.
8. In the claimyour.site repo, export a Dub-fork vanity link (click/affiliate/claim state) → import into
   Slink-backed ClaimYour → cut DNS/API over unchanged → concurrent slug claim + immediate edits from two
   regions → old links work → remove remaining Dub runtime after rollback ready; preserve license notices.
9. An instrumented Site sends one event to Traks → live figures via per-Site DO + history via R2 SQL →
   bot/agent classification + local-day bucketing → Site-only export → survives delayed/failed Pipeline;
   compare old/new counts during migration; no duplicate tracker or cross-Site query.
10. Editor build creates a free local SEO report → with the $10/Site OpenSEO add-on + DataForSEO funding
    choice, run a paid audit + Site-scoped MCP query → capture actual USD cost (incl. charged errors +
    async tasks) → enforce a small cap → spend by feature → reconcile a Stripe invoice. Unsubscribed/
    revoked cannot read reports or invoke paid tools; canceling keeps free checks.
11. Sidebar snapshots for relevant roles/flags show no KV Inspector, System Services, or other Inspector
    tabs; deep links no longer render removed screens; site-scoped resource + MCP workflows still pass.
12. The Social page has ten consecutive before/after passes in the work log, screenshots at representative
    breakpoints, keyboard/mobile checks, and a working E2E publish/schedule.
13. Sample multiple completed cycles: each has a verified app increment + a concrete reused improvement
    to the AI loop/template/utility, with before/after evidence + recorded user impact.

Per slice: focused tests + typecheck/lint/build for affected packages + Playwright visual/function checks
+ the repo's pre-authorized deploy/prod-smoke policy where it applies. Controlled staging accounts for
paid/external events — never purchase a real number or send a message just to make a test green. Write an
ADR when a recording/CDP/SDK compatibility proof changes the selected design. Missing account capability →
implement the safe code path, mark the exact unverified live step, continue independent work.

## Research findings to preserve (checked 2026-09-29)

- **Traks** (MIT): site-key collect Worker → ~48h live `SiteLiveStore` DO + durable events via Pipelines
  → Iceberg; history via R2 SQL. README sample bills are illustrative, not ProjectSites prices. CF limits:
  20 streams / 20 sinks / 20 pipelines per account, 5 MB/s per stream → a per-Site pipeline will NOT scale.
- **OpenSEO** (MIT, self-hostable on CF w/ DataForSEO key): hosted $10/mo is OpenSEO's own offering. Self-
  host Access-teammates share ONE workspace; MCP clients need Managed OAuth + allowlisted redirect URIs.
  Issue #268: self-hosted cost responses are discarded → custom actual-cost metering is REQUIRED, not
  preexisting. DataForSEO returns task-level USD cost + account usage.
- **claimyour.site** (private): AGPL Dub fork on Neon/Upstash/Tinybird + `@dub/*`, `claimyour.site/{key}`
  redirects. **Slink** (MIT): Workers/KV short-link, single admin password/API key, overwrites, hit
  counter, one-time links — unsuitable for multi-tenant as-is. KV is eventually consistent → needs an
  authoritative claim/write model + a product migration, not a rename.
- **EmDash**: Astro CMS on Workers/D1/R2 + KV sessions + sandboxed plugins via Dynamic Worker Loaders
  (test paid-account availability before promising plugins). **microfeed** (AGPL): Wrangler binds D1 + R2
  + Queues + cron + secrets.

## Official source ledger (verify afresh each phase)

- CF voice: developers.cloudflare.com/agents/communication-channels/voice/
- CF Agents browser: /agents/tools/browser/ · github.com/cloudflare/agents
- Browser Run: /browser-run/features/{live-view,session-recording,human-in-the-loop,webmcp}/ · /stagehand/ · /cdp/
- Sandbox: /sandbox/tutorials/{claude-code,ai-code-executor}/ · /sandbox/
- Realtime container: /realtime/sfu/examples/cloud-gaming/
- WfP + MCP: /cloudflare-for-platforms/workers-for-platforms/ · /agents/model-context-protocol/ · github.com/cloudflare/mcp-server-cloudflare
- Twilio: /docs/voice/twiml/{recording,stream} · /docs/voice/api/recording · /docs/phone-numbers/api/{availablephonenumberlocal,incomingphonenumber}-resource · /docs/messaging/compliance
- Stripe meters: docs.stripe.com/billing/subscriptions/usage-based/recording-usage
- Refs: github.com/{emdash-cms/emdash, microfeed/microfeed, cloudflare/agentic-inbox, cloudflare/cloudflare-os, cloudflare/vibesdk, transloadit/uppy, ueberdosis/tiptap, lyc8503/UptimeFlare, shivamanupadi/traks, yutian81/slink, every-app/open-seo, heymegabyte/claimyour.site} · os.cloudflare.app · build.cloudflare.dev · reactflow.dev · counterscale.dev (UX ref only)
- Constraints: /pipelines/platform/limits/ · /r2-data-catalog/platform/pricing/ · /r2-sql/platform/pricing/ · /kv/concepts/how-kv-works/ · open-seo/docs/SELF_HOSTING_CLOUDFLARE{,_OPERATIONS}.md · open-seo/issues/268 · docs.dataforseo.com/v3/appendix-user-data/

## Continuous-improvement charter (applies every cycle; repo instructions win on conflict)

- **Every cycle:** one meaningful code/architecture/quality improvement + reserve ~20–25% for
  source-adjacent docs + repo hygiene (inspect ≥1 docs hotspot + ≥1 unused-code/file candidate; improve
  only with evidence — no filler, no delete-to-quota). Verify + review the diff + report. Update the
  backlog + pick the next highest-value task. Implement + verify a bounded improvement each cycle; never
  spend a whole run only planning.
- **Also improve the loop itself every cycle** — one small verified change to task selection / context
  retrieval / agent handoff / prompt+skill instructions / a reusable test or browser journey / cache-
  index freshness / feedback capture / failure recovery / a template or utility. Tie it to the feature
  or an observed bottleneck; record before/after evidence + the beneficiary + the next bottleneck. Fold
  successful patterns into the authoritative run-the-loop instructions; retire ineffective steps; reuse
  the improvement later; never reword prompts without demonstrated effect.
- **15 documentation practices (apply over time):** concise repo map (link source, don't copy); short
  root README (setup/commands/entry points/links); per-package purpose+usage; TSDoc on exports where the
  type isn't enough (behavior/units/defaults/failures/side-effects/examples); WHY-comments for
  invariants (not syntax narration); boundary contracts (tenant isolation/authz/preview-vs-prod/data-
  ownership/failure); small ADRs for hard-to-reverse decisions; task-oriented journey guides; data
  schemas + migrations documented at source (lifecycle/compat/retention/rollback); operational runbooks
  matching real scripts; small checkable examples (cut stale); TypeDoc from source (generated out of Git
  unless deliberately published); check MD links/refs/commands/snippets in CI; keep AI instruction files
  short + navigable (don't duplicate the README); edit for signal (delete obsolete/vague/restating text).
- **Hygiene each cycle:** classify every candidate (required / regenerable→ignore+untrack /
  unused→remove-after-verify / unclear→investigate). A `.gitignore` entry doesn't untrack a tracked
  file. Search unused code (Knip per workspace + compiler + refs); review unreachable files → exports →
  deps; static analysis is evidence not proof (check routes/dynamic-imports/DI/registries/CLI/tests/
  build scripts/codegen/CF config/Workers/DO/Workflows/Queues/scheduled/bindings/migrations before
  deleting). Removing a dep updates manifest+lockfile+verifies builds.
- **Style convergence:** inventory languages/frameworks per workspace; follow the installed-version
  authoritative guide (Angular Style Guide for Angular, Google TS Style where it fits); converge
  incrementally (config enforceable rules, fix touched files, one area at a time, official codemods);
  never mass-reformat in a feature change or mix conventions in a file; record deliberate exceptions.
- **Monorepo reuse:** notice duplicated domain logic/contracts, cycles, misplaced responsibilities,
  unclear public APIs; extract only with real consumers + a stable concept; keep framework-specific UI +
  runtime adapters + deployment bindings at the edges; intentional exports (no deep imports / catch-all
  utils / cycles); preserve tenant+environment isolation as code moves. State current coupling → owner →
  consumers → risk → migration sequence → verification; smallest safe step per cycle.
- **Verify:** record baseline + existing failures before editing; run focused tests + applicable
  typecheck/lint/build/docs/integration after; test changed behavior (not implementation echo); check the
  diff for churn/deleted-user-work/stale-links/generated files. Commit coherent verified changes per repo
  practice; never bundle unrelated pre-existing changes; don't push/deploy beyond the repo's standing
  authorization. End-of-cycle report: improvement + why · docs improved/removed · hygiene investigated
  (removed/retained/deferred + evidence) · style/boundary progress · checks run + failures · next
  highest-value cycle + best new recommendation. Never invent work to keep the loop busy.
