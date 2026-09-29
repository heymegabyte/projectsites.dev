# CAMPAIGN cf-native-ai — §2 Foundations Verified at HEAD (lane-1, fire-55)

Baseline: source review at `29007fdf2` (2026-09-29). Verified against HEAD `bd5f5dad5`
(20 commits / 76 files later, same day). **None of the 12 claim-referenced files changed
between baseline and HEAD** (`git diff 29007fdf2..HEAD` over every claim path = empty; the
76 changed files are editor workbench panels, error middleware, notify_site_built, admin
settings, loop docs). All paths below relative to `apps/project-sites/` unless prefixed `app/`.

## Verdict table

| # | Claim surface | Verdict |
|---|---|---|
| 1 | Workers/Hono+D1/KV/R2/DO/Workflows · Angular admin · bolt.diy editor | VERIFIED-UNCHANGED |
| 2 | `services/api_tokens.ts` psk_ tokens | VERIFIED-UNCHANGED |
| 3 | `libs/features/platform_mcp/` hand-rolled MCP, 56 entries | VERIFIED-UNCHANGED |
| 4 | `mcp_oauth_provider/schemas.ts` scopes + grant-mint escalation | VERIFIED-UNCHANGED — **escalation CONFIRMED in code** |
| 5 | `services/mcp_client.ts` provider adapters | VERIFIED-UNCHANGED |
| 6 | `services/ai_env_vars.ts` encrypted scoped vars | VERIFIED-UNCHANGED — plaintext-into-prompt path live |
| 7 | `services/llm_tier_router.ts` defects | VERIFIED-UNCHANGED — all 3 defects present |
| 8 | Four routing files overlap | VERIFIED-UNCHANGED — actually ≥6 deciders; `gateway_route.ts` is an orphan |
| 9 | `infra/litellm/` present pending port | VERIFIED-UNCHANGED — 8 live TS refs |
| 10 | `services/ide_sandbox.ts` fabricated behaviors | VERIFIED-UNCHANGED — 7 fabrication sites |
| 11 | `projectsites-ai.ts` internal marker | VERIFIED-UNCHANGED — marker = header, not the apiKey |
| 12 | WfP serving + R2 fallback + Preview/Promote | VERIFIED-UNCHANGED |

## Claim 1 — Extend existing surfaces

**VERIFIED-UNCHANGED.** `wrangler.toml`: KV `[[kv_namespaces]]` :104/:109 · D1 `[[d1_databases]]`
:114 · R2 `[[r2_buckets]]` :120 · Workflows `[[workflows]]` :137/:143 · DOs
`[[env.production.durable_objects.bindings]]` :354/:368 · WfP `[[env.production.dispatch_namespaces]]`
:1186. Angular/Spartan admin at `frontend/` (settings/snapshots components active in the 20-commit
delta), bolt.diy editor at repo-root `app/`. Only claim-adjacent HEAD delta: `src/types/env.ts`
comment about CF Registrar endpoint EOL (+4/−2, comments only).

## Claim 2 — api_tokens.ts

**VERIFIED-UNCHANGED.** `psk_<64-hex>` (`generateToken` :78-85), SHA-256-only storage
(`hashToken` :70-75, INSERT :107), plaintext-once (`CreateTokenResult.plaintext` :63-67, returned
:123), expiry+revocation enforced in `verifyApiToken` (:143-153 — `revoked_at IS NULL AND
(expires_at IS NULL OR expires_at > datetime('now'))`), `revokeApiToken` :231-247. 9 scopes in
`VALID_SCOPES` :25-35 — including `data:read`/`data:write` (:32-33), confirming the claim-4
scope-registry split. Auth is deliberately fail-fast (no `.catch(() => null)`, :137-142).

## Claim 3 — platform_mcp (PRIORITY: hand-rolled methods + entry count)

**VERIFIED-UNCHANGED.** `handlers.ts` hand-rolls exactly three JSON-RPC methods in a `switch
(body.method)` (:85): `initialize` :86-88 (static `{protocolVersion: '2025-11-25', serverInfo,
capabilities: {tools:{}}}`), `tools/list` :89-97 (static map over `PLATFORM_MCP_TOOLS`),
`tools/call` :98-115; everything else → `-32601 method not found` :116-118. No notifications,
cancellation, resources, or protocol negotiation — "starting point ≠ transport conformance" holds.
`initialize` + `tools/list` are auth-free by design (doc :14-15; 401-with-`WWW-Authenticate`
RFC 9728 path only for `tools/call`, :147-158). Org scoping: `tools/call` verifies the `psk_`
bearer (:105) and passes the token row into `dispatchPlatformTool` (:111); `service.ts` :1222
("`token` is the verified API-token row (carries org_id …)"). **Catalog count at HEAD: 56**
(`grep -c inputSchema service.ts` = 56; catalog starts `service.ts` :289 "Only IMPLEMENTED tools
are listed", first entries `whoami` :295, `list_sites` :302, …).

## Claim 4 — mcp_oauth_provider scopes + grant minting (PRIORITY: mint-path trace)

**VERIFIED-UNCHANGED**, and the audit the spec ordered is now done: **the delegated-child ≤
presenter rule is ABSENT — escalation confirmed.**

- Grantable scopes TODAY: `schemas.ts` :9 — `export const OAUTH_ALLOWED_SCOPES = ['sites:read',
  'sites:write'] as const;`. The public API registry has 9 scopes (api_tokens.ts :25-35) incl.
  `data:read/write`, `media:*`, `forms:read`, `analytics:read` — two registries, unreconciled.
- Mint path: `POST /api/oauth/authorize` (`handlers.ts` :175) → bearer gate `verifyApiToken`
  (:183) → scope validation :219-224:

  ```ts
  const requestedScopes = parsed.data.scope.split(' ').filter(Boolean);
  const invalidScopes = requestedScopes.filter((s) => !(OAUTH_ALLOWED_SCOPES as readonly string[]).includes(s));
  ```

  The ONLY check is membership in the static `OAUTH_ALLOWED_SCOPES` ceiling. **`tokenResult.scopes`
  (the presenter's own scopes) is never read** — the code stores `org_id: tokenResult.org_id` +
  `created_by_token_id: tokenResult.id` (:234-235) but not the presenter's scope set, and no
  intersection is computed anywhere in the flow.
- Exchange: `POST /oauth/token` (:244) consumes the code (single-use KV delete, `service.ts`
  `consumeCode` :93-99 — get-then-delete, NOT atomic under two simultaneous exchanges), verifies
  PKCE (:298), then mints a REAL 90-day `psk_` token (:303-315):

  ```ts
  const scopes = codeRecord.scope.split(' ').filter((s): s is ApiScope =>
    (OAUTH_ALLOWED_SCOPES as readonly string[]).includes(s)
  );
  const tokenResult = await createApiToken(c.env.DB, codeRecord.org_id, `oauth:${clientId}`, scopes, null, expiresAt);
  ```

- **Consequence:** any valid org token — e.g. one scoped only `analytics:read` or `data:read` —
  can authorize a code for `sites:read sites:write` and exchange it for a 90-day full
  sites-write `psk_` token. Consent carries no site/resource matrix (code record `schemas.ts`
  :76-85 has client/redirect/scope/org only). Two spec-§6 gaps confirmed in one file: scope
  escalation past presenter + non-atomic code single-use (`consumeCode` is read-then-delete on KV).

## Claim 5 — mcp_client.ts

**VERIFIED-UNCHANGED.** Inline `ADAPTERS` registry with 12 providers at HEAD (airtable, calendly,
discord, github, hubspot, linear, mailchimp, notion, resend, slack, stripe, twilio) — OAuth
token-exchange + tool specs per provider (e.g. mailchimp :123-159, stripe :217-273, resend
:295-331). Encrypted creds (9 `encrypt/decrypt` call sites). Config-missing behavior documented at
:40 — connect "returns `501 oauth_not_configured` until the worker secret is pushed" → catalog
card ≠ working integration, exactly as claimed.

## Claim 6 — ai_env_vars.ts

**VERIFIED-UNCHANGED.** Five scopes `'org'|'site'|'mcp'|'endpoint'|'agent'` (:50), AES-GCM
encrypted at rest, `resolveEnvVarsForAI` (:417-470) merges in scope-precedence order and only rows
with `exposed_to_ai = 1`. **But the spec's "never plaintext into model context" directive is
violated by design today:** `injectIntoSystemPrompt` (:536-549) appends decrypted values verbatim —
`` `${k}=${resolved[k]}` `` joined under `## Custom environment` — into the system prompt,
"deliberately bash-compatible so the LLM can quote values verbatim into tool calls". REUSE the
store; replace this injection path with execution-boundary injection.

## Claim 7 — llm_tier_router.ts defects (PRIORITY: line quotes)

**VERIFIED-UNCHANGED — all three defects live at HEAD** (file untouched since 2026-06-29).

1. **Latency overrides security-review.** Rule order is vision (:126) → latency (:131) → OSS
   (:140) → task table (:149). Lines :131-137:

   ```ts
   if (parsed.latencySensitive && parsed.userFacing) {
     return result('instant', `Latency-sensitive user-facing ${parsed.task} → instant (Workers AI edge)`, true);
   }
   ```

   A `task: 'security_review'` (or `architecture`/`reasoning`) with `latencySensitive+userFacing`
   routes to `instant` — the `TASK_TIER.security_review = 'premium'` row (:88) is never reached.

2. **Capability-blind fallback.** :156-160:

   ```ts
   const fallback: LlmTier =
     tier === 'premium' ? 'standard' : tier === 'standard' ? 'instant' : 'instant';
   ```

   Unconditional step-down — a vision-required premium route (:126-128) gets `fallback: 'standard'`
   even though the file itself asserts only premium has vision.

3. **Premium-only-vision assumption.** :126-128 `'Vision/image input required — only premium tier
   supports it'` + doc :108 "(only Anthropic/GPT-4o has vision)". Contradicted by the repo's own
   registry: `model_registry/service.ts` :76-82 declares `workers-ai … vision: true` (and
   `bolt_admin.ts` :59 uses `@cf/meta/llama-3.2-11b-vision-instruct`). Fix with verified per-model
   capabilities, as the spec orders.

## Claim 8 — routing authority split (PRIORITY: file → what it decides table)

**VERIFIED-UNCHANGED**, with two sharpening deltas: the real decider count is ≥6, and one of the
four named files is dead code.

| File | What it decides TODAY |
|---|---|
| `src/services/llm_tier_router.ts` | Pure task-category → tier (`instant|standard|premium`); no provider names, no I/O. |
| `src/services/external_llm.ts` | Tier → concrete provider: `chooseProviderForTier` :315-330 (premium ladder Fable→OpenAI→Kimi→DeepSeek by key presence; standard/instant DeepSeek→OpenAI→Anthropic); `toRoutableProvider` :347-357 collapses to the 3 vendors it can call; owns the actual calls (`callExternalLLM` :767, `…WithVision` :938), cost estimation :679, and a `@deprecated` `aiGatewayUrl` shim :199 delegating to ai_gateway. |
| `src/services/ai_gateway.ts` | Transport: gateway-vs-direct base URL per provider (`isGatewayActive` :82-84, `gatewayBaseUrl` :95-100), cache TTL/skip + metadata headers (:114-134), single direct-vendor retry on gateway 5xx (`gatewayFetch` :155-183). Provider set `'fable'|'openai'|'kimi'|'anthropic'|'deepseek'` :29. |
| `src/services/gateway_route.ts` | Pure model-string → provider route table (`resolveRoute` :99-120 exact/prefix + priority/weight; `DEFAULT_ROUTES` 4 rows :132-137). **Zero importers outside its own test** (`grep -rln` finds only itself + `__tests__/gateway_route.test.ts`) — an orphaned fifth opinion; also `buildRoute` :64-71 drops the documented `weight` param (doc/impl drift). |
| `libs/features/model_registry/` | Public `GET /v1/models` catalog: 8 `PROVIDERS` with per-provider capability flags + `requires_env` (:39-97, including a `litellm` provider :84-89), 13 `MODEL_ALIASES` with per-alias provider preference lists (:123-202), availability = env-key presence (:219-244). Flag `model_registry`, currently OFF → 404 (`feature_e2e.ts` :509). |
| *(not in claim)* `src/services/edge_ai_router.ts` | A SIXTH decider: `classifyPromptTier()` deterministic sub-ms classification (:8) driving `routeBoltChat` — the live editor-chat router (Workers AI vs gateway). Consolidation must absorb this too. |

## Claim 9 — infra/litellm/

**VERIFIED-UNCHANGED.** `infra/litellm/` intact (config.yaml, Dockerfile, worker.ts, wrangler.toml,
projectsites_arbiter.py, projectsites_hooks.py; newest mtime 2026-08-20). 8 live TS references
(`src/types/env.ts`, `durable_objects/app_runtime_subclasses.ts`, `lib/env.ts`,
`data/apps-catalog.ts`, `services/container_dispatcher.ts`, `services/voice_agent_config.ts`,
`libs/features/model_registry/service.ts`, `libs/features/app_launcher/service.ts`) — active
callers + catalog entries exist; port-then-remove (§13) not yet started.

## Claim 10 — ide_sandbox.ts fabrications (PRIORITY: per-behavior lines)

**VERIFIED-UNCHANGED** (untouched since 2026-06-11). Seven fabricated behaviors:

1. **Fake sandbox ready-response** — `spinUpSandbox` :134-161 inserts a D1 row as `'spinning_up'`
   (:140) yet RETURNS `state: 'ready'` (:147) with invented `ide.projectsites.dev/sandbox/…`
   monaco/terminal/file-tree/preview URLs (:148-154) and `estimated_boot_ms: 800` (:155). No
   sandbox/container is ever created. DB errors swallowed `.catch(() => {})` (:142).
2. **Demo runs when DB empty** — `listMultiAgentRuns` :271-274 falls back to `getDemoRuns()`
   :277-323: hardcoded "artisan bakery" run with fabricated per-agent durations (`21_400`,
   `17_900`).
3. **Demo run detail** — `getMultiAgentRunDetail` :338 → `getDemoRunDetail()` :342-405 with
   fabricated `live_stream_events` timestamped off `Date.now()` offsets (:390-403) and fake
   `output_preview` strings.
4. **Timer-driven fake swarm SSE** — `buildSwarmSseStream` :412-474: `setInterval` 1500ms (:429,
   :468) emits `agent_started`/`file_emitted`/`agent_done` purely from tick arithmetic (:435-455);
   `file_emitted.bytes` is `Math.floor(Math.random() * 4000) + 800` (:444); `swarm_complete` fires
   at `tick >= agents*3` (:457) regardless of any real work.
5. **Run start without execution** — `startMultiAgentRun` :217-254 writes a row and returns
   `parallel: true / file_partitioning: true / conflict_detection: true` (:243-245) + an
   `estimated_total_ms` (:247-251); no agent ever runs.
6. **Wall-clock-simulated build progress** — `getBuildStream` :510-538: `simulatedDone =
   Math.min(…, Math.floor(ageSeconds / 4))` (:522) fabricates component completion from row age;
   `last_component_emitted_at` invented as `Date.now() - 2_000` (:536).
7. **Timer-driven fake progressive SSE** — `buildProgressiveSseStream` :544-584 emits one
   `component_ready` per 4s tick (:561-578) with no real component pipeline.

Spec verdict stands: replace with REAL workspace/Sandbox/job state; no pretend anything.

## Claim 11 — projectsites-ai.ts internal marker (PRIORITY: marker value + validation site)

**VERIFIED-UNCHANGED.** Two fixed values in `app/lib/modules/llm/providers/projectsites-ai.ts`:

- `apiKey: 'ps-internal'` (:87) — **never validated anywhere in the worker** (grep: no consumer;
  the `https://ps-internal` hits in `index.ts` :2313 / `functions/runtime.ts` are an unrelated
  synthetic hostname). It exists only because `createOpenAI` requires a key.
- **The real marker is the header** `'x-bolt-origin-check': 'bolt-iframe'` (:94), validated in
  `src/routes/bolt_admin.ts` `isBoltCallerAllowed` :80-87 — `if (boltHeader === 'bolt-iframe')
  return true;` (:84-85), one of three OR'd soft-auth signals (session userId :81, trusted Origin
  :82-83, header :84-85).
- Endpoint: default base `https://project-sites.manhattan.workers.dev/api/bolt` (:84); SDK appends
  `/chat/completions` → `POST /api/bolt/chat/completions` (registered `bolt_admin.ts` :452-453,
  legacy `/admin-api/chat/completions` :452). Handler `boltChatHandler` :101-149: OpenAI-compatible
  chat/completions pass-through (SSE when `stream:true`) via `routeBoltChat` (edge_ai_router);
  audit-log only when a real session orgId exists (:130-131).
- **Could the marker authorize public paths?** Today it does NOT touch `/v1/*` (only `/v1/models`
  exists, flag-gated, auth-free by design) — the gate is local to the bolt_admin surface. But the
  marker ALREADY authorizes unauthenticated inference spend: any client sending the fixed,
  guessable header reaches `POST /api/bolt/chat/completions` with zero credential (no secret, no
  org binding — the M2M path deliberately skips audit :126-129). The §2.11 rule ("marker must
  NEVER authorize the public API") must therefore be enforced at design time for the new `/v1`
  surface AND the existing hole should be closed when auth/inference converge (per-key gating,
  not a static header).

## Claim 12 — WfP serving

**VERIFIED-UNCHANGED.** `src/services/site_serving.ts` :45-69 documents+implements the serving
preference: `site_wfp_hosting` flag + active `wfp_namespace` resource → dispatch to per-site User
Worker via `env.USER_DISPATCH` (`dispatchToUserWorker`); "In EVERY other case … returns `null`
(fall back to R2). A WfP-hosted site is NEVER worse than R2 — a dispatch failure degrades, never
5xx's the visitor" (:58-59). Preview/production slot separation: "A preview request can never
dispatch a production slot because it never resolves one" (:63); `wfp_dispatch.ts` :143-184
reserves the `-preview` script-name suffix within the 64-char cap (`siteFunctionsScriptName`
:175-184). Promote semantics: bolt publish is the "publish/promote milestone → (re)deploy the
site's PRODUCTION" slot (`src/routes/api.ts` :3284, :3613); `wfp_site_hosting.ts` (28K) carries
the hosting stages. Frozen-revision preservation is the serving invariant to KEEP through §12's
workspace re-architecture.

## Existing /v1 + compat surface (grep at HEAD)

- **`GET /v1/models` EXISTS**: `libs/features/model_registry/handlers.ts` :38, mounted
  `src/index.ts` :1050 ("must precede the site-serving catch-all"), public/no-bearer, flag
  `model_registry` currently OFF → 404 (`src/routes/feature_e2e.ts` :509 "flag-gated OFF today →
  404"). OpenAI-compatible list shape (`model_registry/schemas.ts` :41).
- **NO `/v1/chat/completions` and NO `/v1/messages` routes exist** — the only chat-completions
  shape served is the internal adapter `POST /api/bolt/chat/completions` (+ legacy
  `/admin-api/chat/completions`), `bolt_admin.ts` :452-453: OpenAI-compatible request
  (`{messages, model?, stream?}` :105-109, minimal validation — an `as`-cast, no Zod), SSE or
  `chat.completion` JSON per explicit `stream:true` (:114-118), soft-auth gate (claim 11), routed
  by `edge_ai_router.routeBoltChat` (classify → Workers AI vs AI Gateway). `/v1/messages`
  (Anthropic) has no precursor at all. Internal `gatewayFetch(…, '/v1/chat/completions')` call
  sites (e.g. `libs/features/media_ai/handlers.ts` :351) are outbound vendor paths, not served
  routes.

## Most consequential deltas vs the §2 review

1. **Zero drift on all 12 claim files** — the review's findings are still the exact HEAD state;
   every §2 fix remains to be built.
2. **Claim-4 escalation is now code-confirmed** (presenter scopes never intersected at mint;
   plus non-atomic code consumption) — highest-severity actionable finding.
3. **`gateway_route.ts` is an orphan** (zero importers) and a SIXTH decider (`edge_ai_router.ts`)
   exists — §8 consolidation scope is larger than the claim's four files.
