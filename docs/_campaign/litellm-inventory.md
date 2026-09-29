# LiteLLM Reference Inventory (lane-1, fire-55 — feeds lane-9 cutover)

Complete case-insensitive `litellm` sweep at HEAD (`rg -i litellm`, excl. `.git/node_modules/dist/.claude/worktrees`).
32 tracked files hit. Campaign authority: `.claude/run-the-loop/CAMPAIGN-cf-native-ai.md` §13.

Topology at HEAD:

- **The deployed proxy** is worker `projectsites-litellm` (`apps/project-sites/infra/litellm/`) — LiteLLM container (DO `LiteLLM`, singleton, port 4000, `sleepAfter 15m`) at **`llm.megabyte.space`** (custom_domain route, megabyte.space zone `75a6f8d5…`).
- **`llm.projectsites.dev` is NOT the proxy** — the main worker serves only a `GET /` landing (`src/index.ts:1064` → `llmLandingPage()`) + flag-gated `GET /v1/models` (`model_registry` flag, default OFF). The landing advertises `https://llm.projectsites.dev/v1` as base URL, but `/v1/chat/completions` on that host falls through to site-serving — the advertised URL is aspirational. Real traffic goes to llm.megabyte.space.
- **The main worker's own AI paths are already native**: `src/services/external_llm.ts` (OpenAI+Anthropic direct via CF AI Gateway, retry+circuit-breaker) and `src/services/llm_tier_router.ts` (pure tier router) contain ZERO litellm references. `gateway_route.ts` does not exist. The editor (`app/`) and `packages/` have zero hits.

## 1) Active runtime callers (what breaks if the proxy is down)

| # | Caller | Path | ACTIVE? | Breakage if proxy down |
|---|---|---|---|---|
| 1 | **Voice agent LLM config** | `apps/project-sites/src/services/voice_agent_config.ts:182-183` (platform default hardcoded `https://llm.megabyte.space/v1`; env `LITELLM_BASE_URL`/`LITELLM_API_KEY`), `:261-265` (per-site `ai_env_vars` `LITELLM_BASE_URL/API_KEY/MODEL` precedence) | **YES** — served by `/internal/voice/agent-config` (`src/routes/voice_webhooks.ts:381+`, HMAC-signed), mounted `src/index.ts:1001`; consumed by the external voice gateway at call start | Every AI phone call's LLM brain dies. Key falls back to `OPENAI_API_KEY` but **baseUrl still points at the proxy** — no alternate-endpoint fallback. Highest-blast-radius caller. |
| 2 | **Twenty CRM AI facade** | `apps/project-sites/infra/twenty/worker.ts:27-29, 101-104` — `AI_PROVIDERS` secret injects an `@ai-sdk/openai-compatible` provider at llm.megabyte.space carrying the LiteLLM **master key** | YES when the `AI_PROVIDERS` secret is set on the deployed twenty worker | Twenty's AI features fail. Unsetting the secret falls back to Twenty's built-in vendor-key detection. |
| 3 | **system_status health strip** | `apps/project-sites/libs/features/system_status/service.ts:15` — probes `https://llm.megabyte.space/health` | DARK — flag `system_status` `default_enabled:false`, experimental (`registry.ts:717-723`) | Strip shows LiteLLM red (only when flag on). Monitor, not a dependency. |
| 4 | **Super-admin Service Status widget** | `apps/project-sites/src/services/service_registry.ts:171-180` — slug `llm`, url `https://llm.megabyte.space`, healthPath `/health`, secret name `LLM_API_KEY`; sibling `crm-llm` entry names `TWENTY_LLM_API_KEY` | YES (super-admin surface) | Widget shows LLM service down. Monitor only. |
| — | The proxy itself | `apps/project-sites/infra/litellm/worker.ts` + `wrangler.toml` (routes `llm.megabyte.space`) | Deployed | n/a — this IS the thing being retired. |

Confirmed NON-callers (native already): `external_llm.ts`, `llm_tier_router.ts`, `image_generation`, site-generation workflow, editor `app/`, `packages/shared`.

## 2) Customer-visible surface (models / keys / docs naming it)

- **Landing page**: `src/lib/llm_landing_page.ts` (`:11` BASE_URL `https://llm.projectsites.dev/v1`) served at `llm.projectsites.dev/` (`src/index.ts:1064-1065`); tests `src/__tests__/llm_landing_page.test.ts`, `platform_root_landings.test.ts:57-58`; `.cleanup-allowlist:34`.
- **Model catalog**: `libs/features/model_registry/service.ts:84-89` — provider id `litellm`, tier `gateway`, `requires_env: ['LITELLM_BASE_URL']`; exposed via flag-gated `GET /v1/models` (`src/index.ts:185,1050`, flag `model_registry` OFF).
- **Proxy model aliases** customers/config reference: `smart` (adaptive router), `opus`, `gpt`, `deepseek`, `ollama`, `embedding`, `cascade`, `quorum` (`infra/litellm/config.yaml`). Voice defaults bake alias `gpt` (`voice_agent_config.ts:265`).
- **Keys**: `LITELLM_MASTER_KEY` (gates proxy; also embedded inside Twenty's `AI_PROVIDERS` secret); per-site **virtual keys** minted in the proxy's Neon DB and stored per-site as encrypted `ai_env_vars` rows named `LITELLM_API_KEY` (§13: rotate/reissue — plaintext unrecoverable server-side).
- **Apps catalog (customers launch their OWN LiteLLM — orthogonal to the platform proxy)**: `src/data/apps-catalog.ts:478-523` (image `ghcr.io/berriai/litellm-database:main-stable`, env `LITELLM_MASTER_KEY`/`LITELLM_SALT_KEY`, homepage/repo links) · frontend mirror `frontend/src/app/pages/admin/sections/apps-catalog.data.ts:350-378` · screenshots `app-screenshots.data.ts:21-22` · `libs/features/app_launcher/service.ts:15,62-65` + `manifest.ts:3` · DO subclass `src/durable_objects/app_runtime_subclasses.ts:140-143` + slug list `:312` · dispatcher `src/services/container_dispatcher.ts:76` · binding type `src/types/env.ts:826-827` · export `src/index.ts:307`.
- **Registry prose**: `src/platform/service-registry.ts:271-273` ("Cloudflare AI Gateway + LiteLLM facade", domain llm.projectsites.dev) · flag descriptions `src/modules/feature_flags/registry.ts:720` + `docs.ts:918` · `libs/features/system_status/manifest.ts:5`.
- **E2E strings**: `e2e/admin-site-detail.spec.ts:38` ("LLM (LiteLLM + AI Gateway)") · `e2e/admin-system-services-journey.spec.ts:73` (llm.megabyte.space).
- **Docs/CI**: zero hits in `docs/` and `.github/` (only this inventory). `.dev.vars.example` has NO LITELLM vars (only ANTHROPIC/OPENAI/DEEPSEEK).

## 3) Port-before-remove behaviors (per §13, WITH acceptance tests)

1. **Adaptive cost/quality routing** — `config.yaml` `smart` = `auto_router/adaptive_router` over tiers 3/2/1 (opus+gpt / deepseek / Workers-AI llama-3.3), weights quality 0.45 / cost 0.55, fallback `opus→[gpt]`. Native seed EXISTS: `llm_tier_router.ts` (instant/standard/premium, pure fn) + `external_llm.ts` (retry, circuit breaker, AI Gateway, prompt caching). Port = native OpenAI-compatible `/v1/chat/completions` on llm.projectsites.dev serving the SAME alias names (`smart/gpt/opus/deepseek/ollama`).
2. **Per-site virtual keys + budgets + spend** — proxy's Neon DB (`store_model_in_db`, `proxy_batch_write_at 60`). Port to D1 key table + existing `meterAiTokens` (`usage_metering`, already wired in external_llm). Preserve exported usage history (§13 "preserve owned usage/history").
3. **Response cache** — Redis exact-match TTL 600 (`cache_params`). Native replacement: CF AI Gateway caching — config, no code.
4. **Telemetry** — Langfuse `success_callback`/`failure_callback` → traces.projectsites.dev; Prometheus; Slack alerting (`alerting_threshold 300`). Native: `captureLLMCall` (PostHog `$ai_*`) + AI Gateway logs already active; re-wire Langfuse export natively only if wanted.
5. **Hooks pipeline** — `projectsites_hooks.py` (pre: injection_scan · pii_redact · prompt_refiner · cot · context_compressor · format_preinstruction · intent_tagger; post: pii_scrub · json_validate · brand_pass). ALL OFF by default, fail-open → behavior-neutral today. Port only injection_scan + pii_redact as native middleware (small, testable); rest are eval-gated candidates.
6. **Arbitration models** — `projectsites_arbiter.py` `cascade` (Workers-AI draft → confidence → escalate) + `quorum` (opus+gpt+deepseek fan-out, Workers-AI judge). Map aliases to native tiers initially; port real cascade/quorum only if evals justify.

## 4) Pure-removal list (no port needed)

- `apps/project-sites/infra/litellm/` — entire dir (config.yaml, Dockerfile, worker.ts, wrangler.toml, projectsites_hooks.py, projectsites_arbiter.py, smoke.sh, package.json, README; untracked node_modules/.wrangler/package-lock).
- CF-side: worker `projectsites-litellm`, custom domain llm.megabyte.space, its secrets (`LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `OPENAI/ANTHROPIC/DEEPSEEK_API_KEY`, `CLOUDFLARE_API_KEY/ACCOUNT_ID`, `DATABASE_URL`, `REDIS_URL`, `LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST`, `SLACK_WEBHOOK_URL`), WAF skip-rule scope for llm hosts (rule `9c8324ff…`, zone `9ceaa211…` — narrow, don't delete).
- `scripts/slim-containers.sh:50` (llm.megabyte.space|ghcr.io/berriai/litellm row).
- `wrangler.toml` commented blocks `:681-690` (LitellmContainer container+binding) + `:1022` (allowlist entry). **Deployed-DO-identity evidence (§13): zero UNCOMMENTED `LitellmContainer`/`APP_RUNTIME_LITELLM` refs in wrangler.toml and NO migration tag ever declared the class** (`new_sqlite_classes` audit: only PsNotifyDO active) → class removal is safe, no rename/deprecation dance required.
- Main-worker env plumbing: `src/types/env.ts:826-827, 912-915` · `src/lib/env.ts:258-261` · test fixtures `src/__tests__/voice_agent_config.test.ts` (after slice 4 below).
- Prose/strings: platform registry name (`platform/service-registry.ts:271` → "Cloudflare AI Gateway (native)"), flag registry+docs descriptions, system_status manifest, e2e spec labels, service_registry `llm` description.
- Per-site `ai_env_vars` rows named `LITELLM_*` (migrate → `OPENAI_BASE_URL`/`OPENAI_API_KEY` equivalents the voice resolver ALREADY accepts at `:261-263`).
- Apps-catalog entry set (§13 "catalog entries"): the 3 data files + app_launcher + dispatcher + DO subclass + env type + index export (see §2). One-line policy call: §13 default = remove; keeping it as a customer-app requires an explicit doc note instead.

## 5) External deps exclusively-LiteLLM

- **Neon Postgres — database `projectsites_litellm`** (named in `infra/litellm/worker.ts:31-33`; a DATABASE inside the shared Neon project per neon-database-conservation). EXCLUSIVE → export usage/key history to R2, then `DROP DATABASE`. Never delete the shared project.
- **Upstash Redis — `REDIS_URL` (rediss://)** for response cache + router cooldown. VERIFY exclusivity at cutover: the main worker uses separate `UPSTASH_REDIS_REST_URL/TOKEN` (`routes/social.ts:970-981`) and twenty has its own `REDIS_URL` (BullMQ) — compare secret VALUES (names only recorded here); delete the Upstash DB only if dedicated.
- NOT exclusive (keep): Langfuse (traces.projectsites.dev — own product), Slack webhook, provider API keys (shared names, proxy-local copies just get deleted).
- Image pins to forget: `ghcr.io/berriai/litellm:main-latest@sha256:76a4611…` (Dockerfile), `ghcr.io/berriai/litellm-database:main-stable` (catalog).

## 6) Proposed cutover order (small verified slices)

1. **Snapshot** — export Neon `projectsites_litellm` (spend/keys) to R2; record `/v1/models` + `smoke.sh` baseline. No behavior change.
2. **Native gateway dark** — flag `native_llm_gateway`: `/v1/chat/completions` + `/health` on llm.projectsites.dev (main worker), `llm_tier_router` + `external_llm` + Workers AI, legacy aliases served. Acceptance: Jest contract tests + prod curl. Landing's advertised `/v1` becomes true.
3. **Keys** — mint native per-site keys (D1) for every live virtual-key holder (voice sites' `ai_env_vars`, Twenty); reissue where plaintext unrecoverable (§13).
4. **Voice switch** — set `LITELLM_BASE_URL` → `https://llm.projectsites.dev/v1` (env flip first, then change the `:182` hardcoded default), migrate per-site `LITELLM_*` rows → `OPENAI_*` names; prod-verify via `/internal/voice/agent-config` envelope probe + a real test call.
5. **Twenty switch** — rotate `AI_PROVIDERS` secret base URL → native; verify a Twenty AI reply.
6. **Editor / site-gen / public callers** — audit shows already-native (external_llm) → verify-only slice (grep + prod E2E).
7. **Monitors retarget** — system_status row, service_registry `llm` entry, e2e strings → native `/health`; deploy; strip green.
8. **Retire** — after ~7 quiet days of proxy logs ≈0: delete worker + custom domain + secrets; drop Neon DB (post-export); delete Upstash DB if §5 verify says dedicated; `git rm -r infra/litellm` + slim-containers row + commented wrangler blocks; scrub prose + env plumbing.
9. **Catalog slice** — remove the customer apps-catalog litellm entry set (evidence in §4 makes DO-class removal safe), or land the explicit keep-note. Drift gate ships in the same commit.

Native API must be proven working with the proxy UNREACHABLE (kill container, rerun acceptance) before slice 8 (§13 last line).

## 7) Drift gate (reject reintroduction)

One-line check (add as `validate:no-litellm` in `apps/project-sites/package.json` `check` chain + CI):

```bash
rg -il litellm --hidden -g '!.git' -g '!node_modules' -g '!dist' -g '!.claude' -g '!docs/_campaign' -g '!CHANGELOG*' . | grep -q . && { echo 'DRIFT: litellm reference reintroduced'; exit 1; } || exit 0
```

Allowlist: this inventory + changelog history only. Gate lands with cutover slice 8/9 (it would fail today by design).
