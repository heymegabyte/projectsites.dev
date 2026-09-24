# AI Integration — projectsites.dev

> How the worker talks to LLMs, embeds vectors, observes generations, surfaces
> agentic tasks, resolves per-org secrets, and produces media. One reference
> for every AI-adjacent feature shipped through May 2026.

## Table of Contents

1. [AI Gateway](#1-ai-gateway)
2. [Vectorize + AutoRAG](#2-vectorize--autorag)
3. [PostHog LLM Observability](#3-posthog-llm-observability)
4. [Anthropic SDK Upgrades](#4-anthropic-sdk-upgrades)
5. [Task Tray + Elicitation](#5-task-tray--elicitation)
6. [AI Env Vars (scope hierarchy)](#6-ai-env-vars-scope-hierarchy)
7. [Media Library + Studios](#7-media-library--studios)

---

## 1. AI Gateway

**What** — Universal cache + fallback + rate-limit + structured logs + cost
attribution for every external LLM call. Routes OpenAI + Anthropic traffic
through a single Cloudflare gateway named `projectsites`.

**Why** — One bill, one log surface, automatic prompt-cache deduplication, and
free retries when a vendor 5xxes. Pairs with PostHog `$ai_*` events for cost
analytics.

**How** — Toggle via `AI_GATEWAY_ENABLED = "true"` in `wrangler.toml` (line
187). The helper `aiGatewayUrl(env, provider)` returns the gateway URL when
both `AI_GATEWAY_ENABLED === "true"` and `env.CF_ACCOUNT_ID` are set; otherwise
it returns the direct vendor base URL. On gateway 5xx the LLM client retries
once against the direct vendor URL within the same request.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/external_llm.ts:101` | `aiGatewayUrl()` builder |
| `apps/project-sites/src/services/external_llm.ts:121` | Gateway-active branch in `callOpenAI` / `callAnthropic` |
| `apps/project-sites/src/types/env.ts:412` | `AI_GATEWAY_ENABLED` env doc |
| `apps/project-sites/wrangler.toml:187` | Production toggle |

```ts
// services/external_llm.ts
export function aiGatewayUrl(env: Env, provider: 'openai' | 'anthropic'): string {
  if (env.AI_GATEWAY_ENABLED === 'true' && env.CF_ACCOUNT_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/projectsites/${provider}`;
  }
  return provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1';
}
```

**Provisioning** — Gateway lives at
[dash.cloudflare.com → AI Gateway → projectsites](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway).
Pre-create the gateway named `projectsites` with caching + logs enabled before
flipping the env var; otherwise calls 404 on the gateway side.

**Incident response** — Set `AI_GATEWAY_ENABLED = "false"` and redeploy to
bypass the gateway entirely.

---

## 2. Vectorize + AutoRAG

**What** — A 768-dimension cosine Vectorize index named `projectsites-rag`
underpins semantic search across research, voice transcripts, audit logs,
forms, and AI traces. AutoRAG sits on top for hosted retrieval + Llama
synthesis.

**Why** — Lets every admin surface ask "what did we already learn about this
org?" without re-scraping. Powers the Cmd+K answer box, the dashboard chat
SSE stream, and inbox auto-classification.

**How** — Embed text via Workers AI `@cf/baai/bge-base-en-v1.5`, upsert with a
typed `RagMetadata` blob, query with topK + metadata filters.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/rag.ts:84` | `embedText(env, text)` |
| `apps/project-sites/src/services/rag.ts:103` | `indexChunk(env, args)` upserts vector + D1 row |
| `apps/project-sites/src/services/rag.ts:146` | `semanticSearch(env, args)` topK query |
| `apps/project-sites/src/services/rag.ts:185` | `autoRagQuery(env, args)` AutoRAG with Llama fallback |
| `apps/project-sites/src/services/rag.ts:243` | `deleteIndex()` removes vectors + D1 rows |
| `apps/project-sites/wrangler.toml:153` | Vectorize binding `RAG_INDEX` |

```ts
export interface RagMetadata {
  orgId: string;
  kind: 'research' | 'voice' | 'audit' | 'form' | 'ai_trace';
  sourceId: string;
  chunkIndex: number;
  createdAt: string;
}
```

**Pre-flight (one-time per environment)** — see
[DEPLOYMENT.md](./DEPLOYMENT.md#pre-flight-bindings).

```bash
npx wrangler vectorize create projectsites-rag \
  --dimensions=768 --metric=cosine

npx wrangler vectorize create-metadata-index projectsites-rag \
  --property-name=kind --type=string

npx wrangler vectorize create-metadata-index projectsites-rag \
  --property-name=orgId --type=string
```

**AutoRAG fallback** — When the `AUTORAG` binding is unbound (default), the
`autoRagQuery` helper degrades gracefully: `semanticSearch` runs first, then
Llama 3.3 70B FP8 synthesizes the answer from the retrieved chunks. To enable
the hosted path, provision a knowledge source at
[dash.cloudflare.com → AI Search](https://dash.cloudflare.com/?to=/:account/ai/ai-search)
and uncomment the `[ai_search]` block in `wrangler.toml:161`.

---

## 3. PostHog LLM Observability

**What** — Every LLM call (Anthropic, OpenAI, Workers AI, Deepgram,
ElevenLabs) emits a `$ai_generation` event in PostHog's native format so the
hosted LLM dashboards light up without manual configuration.

**Why** — Cost attribution by org, model, prompt, trace. Anomaly detection on
latency + token usage. Pairs with Sentry breadcrumbs for end-to-end debugging.

**How** — `captureLLMCall(env, params)` wraps `captureEvent('$ai_generation')`
and maps the platform-neutral inputs to PostHog's `$ai_*` property names.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/analytics.ts:190` | `captureLLMCall()` |
| `apps/project-sites/src/lib/posthog.ts` | Fire-and-forget POST `/capture/` |

```ts
await captureLLMCall(env, {
  distinctId: orgId,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  promptId: 'research_brand',
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  latencyMs: Date.now() - startedAt,
  costUsd,
  status: 'ok',
  traceId: requestId,
  cacheHit: usage.cache_read_input_tokens > 0,
  gatewayUsed: true,
});
```

**Property contract** — `$ai_provider`, `$ai_model`, `$ai_prompt_id`,
`$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`,
`$ai_total_cost_usd`, `$ai_trace_id`, `$ai_is_error`,
`$ai_error_message`, `$ai_cache_read`, `$ai_gateway`, `$ai_status`.

**Dashboards** — PostHog auto-builds:
[LLM Generations](https://us.posthog.com/project/replace-with-id/llm) +
[Cost by model](https://us.posthog.com/project/replace-with-id/insights).

**Trace correlation** — Always pass `traceId: requestId` so multi-step
agentic flows (research → image-gen → site-build) roll up cleanly under a
single trace in PostHog + Sentry.

---

## 4. Anthropic SDK Upgrades

**What** — Native support for Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 with
prompt caching, Structured Outputs, and Citations.

**Why** — Opus 4.7 is the orchestrator default (architecture, completeness,
security). Sonnet 4.6 is the implementation workhorse. Haiku 4.5 is the
content-writer / changelog / formatting drudge. Prompt caching cuts the
biggest per-request bill in half on multi-turn flows.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/external_llm.ts:75` | Per-model price table (USD per 1M tokens) |
| `apps/project-sites/src/services/external_llm.ts:83` | Provider defaults (`anthropic: 'claude-sonnet-4-6'`) |
| `apps/project-sites/src/services/external_llm.ts:327` | `cache_control: ephemeral` injection when `system.length > 1024` |
| `apps/project-sites/src/services/external_llm.ts:346` | System-prompt array assembly |

**Model routing** (per `model-routing.md`)

| Model | Use | Cost |
| ----- | --- | --- |
| `claude-opus-4-7` | Architecture, security review, completeness checks (xhigh effort) | ~$15/1M tokens |
| `claude-sonnet-4-6` | Default — research, generation, debugging (high effort) | ~$3/1M tokens |
| `claude-haiku-4-5` | Content writing, formatting, changelog (low effort) | ~$0.80/1M tokens |
| `deepseek-chat` | Mid-tier fallback when Opus quota exhausted | ~$0.14/1M tokens |
| `@cf/meta/llama-*` FP8 | Instant (free) — Workers AI via AI Gateway | Free |

**Quota fallback** — When Opus weekly quota ≥95%, fall back to Sonnet 4.6 automatically. Zero Opus re-toggle needed; agents carry `model_fallback` in frontmatter. See `opus-quota-fallback.md`.

**Prompt caching** — Automatic. When the rendered system prompt is longer than
1024 chars, the worker rewrites it as a single-element array carrying
`cache_control: { type: 'ephemeral' }`. Subsequent requests within the 5-min
TTL hit cache. Track hit rate via `$ai_cache_read` in PostHog. 90% cost reduction on repeated workflows.

**Structured Outputs** — Use the `structured-outputs-2025-11-13` beta header
on Anthropic requests that need strict JSON. Incompatible with Citations —
pick one per request.

**Citations** — GA across all active models except Haiku 3. Pass
`citations: { enabled: true }` per document. `cited_text` is free. Wired
into the research pipeline so every quantitative claim ships with an APA
reference (see `services/confidence.ts:1`).

**Console keys** —
[console.anthropic.com → Settings → Keys](https://console.anthropic.com/settings/keys).
Direct calls bypass the SDK; we hit `POST /v1/messages` against
`aiGatewayUrl(env, 'anthropic')`.

---

## 5. Task Tray + Elicitation

**What** — A persistent in-app inbox where AI agents post questions that need
a human answer (or that resolve to a default after a timeout). The bell in
the admin shell pulses when a task is open; clicking opens the tray; choosing
an option resolves the task and unblocks any waiting workflow.

**Why** — Workflows v2 supports `step.waitForEvent` for human-in-the-loop
checkpoints. The task tray is the human surface. Maps cleanly to MCP 2025-11-25
elicitation.

**How** — `postAskUser(env, args)` writes a row to `task_inbox` with an
options menu, an optional default option, and an `expires_at`. The frontend
polls `GET /api/inbox/tasks`. A user selection POSTs to
`/api/inbox/tasks/:id/resolve` which fans the resolution back into the
waiting workflow via `step.waitForEvent` keyed on the task id.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/task_inbox.ts:169` | `postAskUser()` |
| `apps/project-sites/src/services/task_inbox.ts:205` | `resolveTask()` |
| `apps/project-sites/src/services/task_inbox.ts:268` | `listOpenTasks()` |
| `apps/project-sites/src/services/task_inbox.ts:288` | `applyExpiredDefaults()` cron sweep |
| `apps/project-sites/src/routes/api.ts:2426` | `GET /api/inbox/tasks` |
| `apps/project-sites/src/routes/api.ts:2441` | `POST /api/inbox/tasks/:id/resolve` |
| `apps/project-sites/frontend/src/app/components/task-tray/task-tray.component.ts` | UI |

```ts
import { postAskUser } from '../services/task_inbox.js';

const taskId = await postAskUser(env, {
  orgId,
  title: 'Pick a hero photo',
  body: 'Three candidates passed visual QA. Which one ships?',
  options: [
    { id: 'a', label: 'Candidate A', value: { assetId: 'asset_1' } },
    { id: 'b', label: 'Candidate B', value: { assetId: 'asset_2' } },
    { id: 'c', label: 'Candidate C', value: { assetId: 'asset_3' } },
  ],
  defaultOptionId: 'a',
  expiresInSeconds: 60 * 60 * 24,
  source: 'workflow:site-generation',
});

// In the workflow step:
const resolution = await step.waitForEvent(`task:${taskId}`, {
  timeout: '24 hours',
});
```

**Expiry sweep** — `applyExpiredDefaults` is invoked from the scheduled
handler in `src/index.ts` every minute; expired tasks auto-resolve to their
`defaultOptionId` (or are marked `expired` if none).

---

## 6. AI Env Vars (scope hierarchy)

**What** — Per-org / per-site / per-MCP-connection key-value pairs that get
injected into AI system prompts and MCP dispatch headers. Encrypted at rest
via AES-GCM with per-record IV.

**Why** — Lets the operator (or downstream user) override sane defaults
without redeploying. Examples: `WRITING_TONE=warm-and-folksy` for a non-profit
org, `BRAND_PRIMARY=#0F172A` for one site, `RESEND_API_KEY=<scoped>` for the
MCP Resend connection.

**How** — Scope resolution: `mcp → site → org` (most specific wins).
`resolveEnvVarsForAI(env, args)` walks the chain and returns a flat
`Record<string, string>`. `injectIntoSystemPrompt(system, resolved)` appends a
`<env_vars>…</env_vars>` block to the system prompt.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/ai_env_vars.ts:34` | `EnvVarScope` type |
| `apps/project-sites/src/services/ai_env_vars.ts:196` | `setEnvVar()` |
| `apps/project-sites/src/services/ai_env_vars.ts:258` | `listEnvVars()` |
| `apps/project-sites/src/services/ai_env_vars.ts:291` | `getEnvVar()` (decrypts) |
| `apps/project-sites/src/services/ai_env_vars.ts:328` | `resolveEnvVarsForAI()` |
| `apps/project-sites/src/services/ai_env_vars.ts:377` | `injectIntoSystemPrompt()` |
| `apps/project-sites/src/services/ai_crypto.ts` | AES-GCM helpers |
| `apps/project-sites/src/routes/env_vars.ts:104` | `GET /api/env-vars` |
| `apps/project-sites/src/routes/env_vars.ts:133` | `POST /api/env-vars` |
| `apps/project-sites/src/routes/env_vars.ts:189` | `PATCH /api/env-vars/:id` |
| `apps/project-sites/src/routes/env_vars.ts:284` | `DELETE /api/env-vars/:id` |
| `apps/project-sites/src/routes/env_vars.ts:320` | `POST /api/env-vars/import` |
| `apps/project-sites/frontend/src/app/components/env-vars-manager/env-vars-manager.component.ts` | UI |

```ts
const resolved = await resolveEnvVarsForAI(env, {
  orgId,
  siteId,
  mcpConnectionId,
});
const finalSystem = injectIntoSystemPrompt(basePrompt, resolved);
```

**Encryption** — Master key in `env.MCP_ENCRYPTION_KEY` (Tier 1.5 — never
rotate without a re-encryption job). Per-record 12-byte IV generated on every
write. Stored alongside the ciphertext in `env_vars`.

---

## 7. Media Library + Studios

**What** — Unified media surface that aggregates uploads, stock search
candidates, AI-generated images (DALL·E 3), queued AI-generated videos
(Sora / Veo), and TTS-generated podcasts (ElevenLabs / OpenAI TTS).

**Why** — One R2 layout, one D1 table, one frontend page. Anything that lands
here can be sent into the bolt iframe as the next image / video / audio used
by the site under edit.

**R2 layout** — `media/{orgId}/{assetId}/{filename}` keeps every asset
addressable by org without leaking across tenants.

**Where**

| File | Purpose |
| ---- | ------- |
| `apps/project-sites/src/services/media.ts:111` | `listAssets()` |
| `apps/project-sites/src/services/media.ts:149` | `getAsset()` |
| `apps/project-sites/src/services/media.ts:162` | `softDeleteAsset()` |
| `apps/project-sites/src/services/media.ts:207` | `uploadAsset()` (multipart, 25 MB cap) |
| `apps/project-sites/src/services/media.ts:276` | `searchStock()` Unsplash/Pexels/Pixabay |
| `apps/project-sites/src/services/media.ts:333` | `saveStockToLibrary()` |
| `apps/project-sites/src/services/media.ts:390` | `generateImage()` DALL·E 3 |
| `apps/project-sites/src/services/media.ts:450` | `generateVideo()` (queued Sora/Veo stub) |
| `apps/project-sites/src/services/media.ts:526` | `generatePodcast()` TTS |
| `apps/project-sites/src/services/media.ts:588` | `sendToBolt()` mints a URL the bolt iframe can fetch |
| `apps/project-sites/src/routes/media.ts:1` | HTTP surface (`/api/media/*`) |
| `apps/project-sites/frontend/src/app/pages/admin/sections/media.component.ts` | UI |
| `apps/project-sites/frontend/src/app/components/global-drop-zone/global-drop-zone.component.ts` | Anywhere-drop ingest |

**Endpoints (mounted at `/api/media/*`)**

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/media/assets` | List with `kind/source/q` filters |
| GET | `/api/media/assets/:id` | Single asset metadata |
| GET | `/api/media/assets/:id/raw` | Stream the R2 object |
| POST | `/api/media/upload` | Multipart upload (25 MB cap) |
| DELETE | `/api/media/assets/:id` | Soft delete |
| POST | `/api/media/stock/search` | Federated stock search |
| POST | `/api/media/stock/save` | Download candidate + persist |
| POST | `/api/media/generate/image` | DALL·E 3 |
| POST | `/api/media/generate/video` | Queued Sora / Veo |
| POST | `/api/media/generate/podcast` | ElevenLabs / OpenAI TTS |
| POST | `/api/media/send-to-bolt` | Mint a URL for the bolt iframe |

**Payload cap exemption** — `POST /api/media/upload` accepts up to 25 MB;
the global `payloadLimitMiddleware` cap (256 KB) is bypassed for this path
in `src/index.ts`. Forgetting the exemption will 413 before the handler ever
runs.

**Video stub** — `generateVideo()` writes a `queued` row and queues a
Workflows v2 job; the actual Sora / Veo provider is wired per env. The asset
flips to `ready` once the workflow callback hits
`POST /api/internal/media/:id/complete`.

**Send to bolt** — `sendToBolt(env, { assetId, siteId })` returns a signed
URL the bolt iframe consumes via the `PS_MEDIA_ASSET` postMessage event. The
iframe then writes the asset into the current site under
`public/media/{filename}` and reruns the dev server.
