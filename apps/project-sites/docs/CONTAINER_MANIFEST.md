# Container Manifest — every Docker container under `projectsites.dev`

Authoritative list of every Docker container the platform runs, each with its
`projectsites.dev` subdomain. Semantic per-feature subdomains only — never umbrella
prefixes (`/api/allstar/*`, category letters). This is the **single source of truth**
for both the product (`projectsites.dev`) plane and the Megabyte Labs infra
(`megabyte.space`) plane — the two-domain map lives in § Infra / self-host below
(merged in from the former `SUBDOMAIN_MAP.md`, 2026-06-27). Slim doctrine:
`scripts/slim-containers.sh` + `~/.agentskills/rules/docker-slim-all-containers.md`.

**Status:** ✅ live · 🟡 defined-not-stood-up · 🔵 proposed (this manifest)
**Slim:** SHIP (registry/Fly image, push the `.slim`) · MEASURE (CF rebuilds from Dockerfile,
fold deletions in by hand) · GPU (runs on the 2× RTX 2080 Ti box behind a CF Tunnel) ·
n/a (Worker/Pages/R2/managed — no container)

---

## AI / LLM control plane

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `llm.projectsites.dev` | **LiteLLM** — model router (cost/quality routing) in front of a unified OpenAI-compatible gateway | `ghcr.io/berriai/litellm:main-latest` | 🔵 | SHIP |
| `infer.projectsites.dev` | **vLLM** — raw OpenAI-compatible GPU inference (the model `llm.` routes to) | `vllm/vllm-openai:latest` | 🟡 | GPU |
| `img.projectsites.dev` | **ComfyUI** — image generation (`flux.1-dev`) | `yanwk/comfyui-boot:cu128-megapak` | 🟡 | GPU |
| `traces.projectsites.dev` | **Langfuse** — LLM tracing / prompt mgmt / evals | `langfuse/langfuse:latest` | 🔵 | SHIP |

`llm.` today is an env-var proxy (`SELFHOST_LLM_URL` → vLLM); the target is LiteLLM
in front so every model call gets routing + logging + fallback. AI Gateway stays mandatory
in front of all of it per `cloudflare-first.md`.

## Jobs / automation

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `events.projectsites.dev` | **Inngest** — event-driven durable jobs server (`inngest start`, §13). Code (`InngestContainer` DO + `src/inngest/*` serve) ships LIVE-but-inert (503) on a normal deploy; secrets stored; container go-live = staged wrangler blocks + watched deploy. | `containers/inngest/Dockerfile` (FROM `inngest/inngest`) | 🟡 | SHIP |
| `jobs.projectsites.dev` | **Hatchet** — heavy/stateful/browser/AI execution plane (Hatchet Cloud preferred; self-host container otherwise) | `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest` | 🔵 | SHIP |

## Browser / agents

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `browser.projectsites.dev` | **CF Browser Rendering** + Playwright/Stagehand — the product browser-automation abstraction | — (CF primitive) | ✅ | n/a |
| `agent.projectsites.dev` | **Skyvern** — heavy browser-workflow agent (logged-in portals, multi-step) — behind CF Access | `public.ecr.aws/skyvern/skyvern:latest` | 🔵 | SHIP |

The internal Browserbase MCP bridge stays at `mcp.megabyte.space` (behind CF Access) per
`cloudflare-first.md` — no `mcp.projectsites.dev`. Product/agent code calls
`browser.projectsites.dev`, never the bridge directly.

## Search

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `search.projectsites.dev` | **Typesense** — full-text search | `typesense/typesense:latest` | 🔵 | SHIP |

## Secrets

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `secrets.projectsites.dev` | **Infisical** — secrets management | `infisical/infisical:latest` | 🔵 | SHIP |

## Comms

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `mail.projectsites.dev` | **Listmonk** — newsletters / lists (SES SMTP relay) | `listmonk/listmonk:latest` | 🔵 | SHIP |
| `support.projectsites.dev` | **Chatwoot** — support / live-chat shared inbox | `chatwoot/chatwoot:latest` | 🔵 | SHIP |
| `social.projectsites.dev` | ~~Postiz~~ — REMOVED 2026-08-20 (native social stack, ADR-0034) | — | ⚫ | REMOVED |
| `billing.projectsites.dev` | ~~Lago~~ — REMOVED 2026-08-20 (Stripe billing) | — | ⚫ | REMOVED |

Lifecycle messaging (journeys, segmentation, campaign orchestration) is handled by the native
notification stack (Dittofeed and Novu were both evaluated and removed per ADR-0034 — no redundant
third-party engagement container). Listmonk stays the list/newsletter send rail.

## Monitoring / status

| Subdomain | Container | Image | Status | Slim |
|---|---|---|---|---|
| `status.projectsites.dev` | **OpenStatus** — public status page + uptime monitoring | `ghcr.io/openstatushq/openstatus:latest` | 🔵 | SHIP |
| `checks.projectsites.dev` | **Healthchecks.io** — dead-man-switch for crons/backups/rebuilds/queues/billing syncs | `healthchecks/healthchecks:latest` | 🔵 | SHIP |
| `logs.projectsites.dev` | **Loki + Grafana** — logs backend + dashboards (only if self-hosted logs/metrics adopted) | `grafana/loki` + `grafana/grafana` | 🔵 cond. | SHIP |

`logs.` stands up ONLY if self-hosted logs/metrics are adopted; default observability is
PostHog + Sentry + Workers Tracing (no container). Prometheus is metrics-only, same condition.

## CRM / CMS — per-tenant provisioned add-ons (opt-in, paid)

Unlike the singletons above (one instance per platform), these are **provisioned PER TENANT**:
every org that opts in (and pays the add-on price) gets its **own isolated instance** — own DB
namespace, own auth, own data. Same mechanism as the `apps-catalog.ts` self-host marketplace
(`AppRuntimeContainer` per-tenant instances), billed through the credit wallet / Stripe add-on.

| Subdomain | Container | Image | Tenancy | Status | Slim |
|---|---|---|---|---|---|
| `crm.projectsites.dev` | **Twenty CRM** — CRM / sales pipeline | `twentycrm/twenty:latest` | per-tenant (one instance per opt-in org) | 🔵 | SHIP |
| `cms.projectsites.dev` | **Payload CMS** — content / app-backend | `payloadcms/payload:latest` | per-tenant (one instance per opt-in org) | 🔵 | SHIP |

- **Landing/control** lives at `crm.` / `cms.` (marketing + provision/manage); **tenant instances**
  resolve at `{tenant}.crm.projectsites.dev` / `{tenant}.cms.projectsites.dev` (or `{tenant}-crm-app.`
  to dodge wildcard-ACM cost per `god-tier-engineering` anti-pattern) via the `app_host_resolver` KV map.
- **Provisioning flow** (work item, NOT yet built): opt-in → wallet/Stripe add-on charge → spin a
  per-tenant `AppRuntimeContainer` (Twenty or Payload image) → Neon Postgres namespace (via Hyperdrive)
  → write `apphost:` KV mapping → instance live. Deprovision on cancel/refund.
- **Pricing:** Twenty = priced CRM add-on; Payload = nominal-fee CMS add-on. Both debit the credit wallet.
- **Build item:** `tenant_app_provisioning` feature module (manifest + flag `enabled=0,rollout=0,stage=experimental`)
  covering Twenty + Payload + any future per-tenant app. Twenty + Payload also get `apps-catalog.ts` rows.

## Platform-internal CF Containers (Durable Objects — no public subdomain)

| Class | Image | Role | Status | Slim |
|---|---|---|---|---|
| `SiteBuilderContainer` | `./Dockerfile` | AI site-build executor (Claude Code, on-demand) | ✅ | MEASURE |
| `AppRuntimeContainer` | `./containers/app-runtime/Dockerfile` | customer-installed app runtime — serves `{app}-app.projectsites.dev` | ✅ | MEASURE |
| `VoiceBrowseAgent` | `./Dockerfile.voice-browse` | headless Playwright screen-recording (flag-gated, dormant) | 🟡 | MEASURE |

## Non-container product surfaces (for completeness)

| Subdomain | Backing | Status |
|---|---|---|
| `projectsites.dev` | Worker (Hono) — marketing + API | ✅ |
| `*.projectsites.dev` | R2 static — generated customer sites | ✅ |
| `editor.projectsites.dev` | CF Pages — bolt-diy editor | ✅ |
| `preview.projectsites.dev` | Worker + R2 — build previews | ✅ |
| `storybook.projectsites.dev` | CF Pages — Storybook | 🟡 (404, not deployed) |

## Managed, never containerized (CF-first escape hatches)

- **Postgres** → Neon (via Hyperdrive) — not a container.
- **Redis** → Upstash — not a container.
- **D1 / KV / R2 / Vectorize / Queues / Workflows / Browser Rendering** → CF primitives — not containers.

---

## Launch backends — provisioned 2026-06-20 (Neon + Upstash, CF-native)

The three active launch targets (`traces.`, `events.`, `mail.`) run as **CF Containers built
from a local `./containers/<svc>/Dockerfile`** (`FROM` upstream — the same path
`SiteBuilderContainer` uses, which bypasses the `IMAGE_REGISTRY_NOT_CONFIGURED` blocker that
only hits bare-registry `image =` refs). Data plane = **Neon Postgres + Upstash Redis**
(connection strings live as `wrangler secret`s, never in git).

- **`traces.` → Langfuse** — pin **v2** (Neon Postgres only). v3 needs ClickHouse → no CF
  primitive, so v2 is the CF-compatible build. Neon project `Langfuse` (`plain-heart-31877384`).
- **`events.` → Inngest** — `inngest start`, Neon project `Inngest` (`calm-sunset-61361436`) +
  Upstash Redis `inngest` (`stirring-cricket-93162.upstash.io`). (`jobs.` → Hatchet, separate plane.)
- **`mail.` → Listmonk** — reuses existing Neon project `Listmonk` (`jolly-pine-24431114`).

Remaining to go live: thin Dockerfiles + 3 `Container` DO subclasses + `[[containers]]`/DO
bindings/migration in `wrangler.toml` + host routing (`traces.`/`events.`/`mail.` → DO) in
`index.ts` + `wrangler secret put` the conn strings + watched `wrangler deploy` (one-way DO
migration — deploy with eyes on it).

## Voice gateway (Fly.io — not a CF container)

| Subdomain | Backing | Image / source | Slim |
|---|---|---|---|
| _(voice receptionist)_ | AI phone receptionist (Twilio number → SIP trunk → **LiveKit Cloud** → agent). The agent runs on **LiveKit Cloud agent hosting** — NOT a CF/Fly container — so it is not a subdomain-backed container | `apps/project-sites/infra/voice-agent/` — voice-architecture.md | SHIP *(in progress)* |

## Infra / self-host — `megabyte.space` (Megabyte Labs infra; all SHIP-slim; Fly.io or registry→VM)

> **Canonical service-domain home = `projectsites.dev`** (the tables above). The ops services
> below are the Megabyte Labs infra mirror. When a service is stood up, add its row to the
> correct plane HERE + a `CONTAINERS`/`REGISTRY_IMAGES` entry in `scripts/slim-containers.sh`
> the same turn (`drift-detection`). SHIP images are built → `slim build` → smoke-tested → push
> the `.slim`; MEASURE (CF) images fold slim deletions into the Dockerfile by hand.

### AI control plane
| Subdomain | Project | Image |
|---|---|---|
| `llm.megabyte.space` | **LiteLLM** — unified LLM gateway/proxy (premium↔DeepSeek↔Workers-AI routing) | `ghcr.io/berriai/litellm` |
| `langfuse.megabyte.space` | **Langfuse** — LLM tracing / prompt mgmt / evals | `langfuse/langfuse` |
| `chat.megabyte.space` | **Open WebUI** — internal LLM chat UI | `ghcr.io/open-webui/open-webui` |

### Jobs / automation
| `inngest.megabyte.space` | **Inngest** — durable jobs/workflows dev server + UI | `inngest/inngest` |
| `n8n.megabyte.space` | **n8n** — visual automation | `n8nio/n8n` |

### Secrets / identity
| `secrets.megabyte.space` | **Infisical** — secrets management | `infisical/infisical` |
| `vault.megabyte.space` | **Vaultwarden** — password manager | `vaultwarden/server` |

### Data / content
| `db.megabyte.space` | **NocoDB** — no-code DB UI | `nocodb/nocodb` |
| `pb.megabyte.space` | **PocketBase** — BaaS (auth/db/files) | `spectado/pocketbase` |
| `wiki.megabyte.space` | **Outline** — knowledge base | `outlinewiki/outline` |
| `notes.megabyte.space` | **Memos** — lightweight notes | `neosmemo/memos` |

### Growth / comms / observability
| `analytics.megabyte.space` | **Umami** — privacy analytics | `ghcr.io/umami-software/umami` |
| `news.megabyte.space` | **Listmonk** — newsletters (SES SMTP relay) | `listmonk/listmonk` |
| `status.megabyte.space` | **Uptime Kuma** — uptime monitoring | `louislam/uptime-kuma` |
| `grafana.megabyte.space` | **Grafana** — dashboards *(optional)* | `grafana/grafana` |

### Agent / MCP (internal — behind CF Access)
| `skyvern.megabyte.space` | **Skyvern** — heavy browser-workflow agent | `skyvern` (internal) |
| `mcp.megabyte.space` | **Browserbase MCP bridge** — internal agent tooling | custom |


---

<!-- folded from INFRA_NOTES.md (2026-06-27) -->

# Infrastructure Notes — self-hosted + data plane (deploy when `coolify.megabyte.space` is live)

> Standing architecture decisions for projectsites.dev's off-edge plane. The Cloudflare
> edge stays the hot path (per `projectsites-cloudflare-first`); everything here is the
> async/batch/data brain behind a **Cloudflare Tunnel + Cloudflare Access SSO**.
> Status: **NOTE / PLANNED** — provision once `coolify.megabyte.space` is available.

## Postgres — ALWAYS Neon + Hyperdrive (LAW)

- **Every Postgres database is hosted on Neon.** Never self-host Postgres on the Coolify box, never Fly Postgres. **Cloudflare Analytics Engine** (+ RUM + D1) is the analytics store (Tinybird/ClickHouse removed 2026-10-07); Neon is the OLTP store.
- **Hyperdrive fronts every Worker→Neon connection** to pool + cache + cut connection latency from the edge. Shard-level Hyperdrive bindings, never one config per site (per `projectsites-cloudflare-first` § Postgres path).
- **A FRESH Neon Postgres database per application type.** Each distinct app/service gets its own Neon database (not a shared one): projectsites.dev core, the email/listmonk plane, the jobs plane, events, llm-ops, analytics-meta, etc. — each isolated. New app type ⇒ new Neon DB + new Hyperdrive binding. Naming: `neon-{app}-{env}` (e.g. `neon-projectsites-prod`, `neon-listmonk-prod`).
- D1 stays the edge-hot relational store (tenants/hostnames/flags/rollups); Neon is the escape hatch for true Postgres workloads + per-app isolation.

## Container roster (Coolify, behind CF Tunnel + CF Access SSO)

All `*.megabyte.space` / internal `*.projectsites.dev` service subdomains are **protected by Cloudflare Access SSO** — no public exposure. Customer sites never depend on them directly; product code calls them through edge-Worker adapters.

| Subdomain | Service | Purpose | Adapter / wiring |
|---|---|---|---|
| `llm.projectsites.dev` / `llm.megabyte.space` | **vLLM** (OpenAI-compatible, 2× 2080 Ti) | mid-grade/standard LLM tier — site-gen, content, pSEO, summarization, container build agent | `self_hosted.resolveSelfHostedLlm` → `external_llm` `selfhosted` provider (API fallback on 5xx) |
| `img.projectsites.dev` | **ComfyUI / SDXL + Flux** (AI image gen API) | hero/section image generation, upscale, bg-removal | `self_hosted.resolveSelfHostedImage` → `image_generation` first-try (DALL·E fallback) |
| `email.projectsites.dev` | **listmonk** (one binary; SES SMTP relay) | multi-tenant newsletters/campaigns/subscribers/MJML editor | edge Worker: host→`site_id`→listmonk-list scoping (Model A); promote heavy tenants to dedicated listmonk container (Model B) |
| `jobs.projectsites.dev` | **trigger.dev** (self-hosted) | durable background jobs / scheduled work | edge Worker dispatch; Neon DB `neon-jobs-prod` + Hyperdrive |
| `events.projectsites.dev` | **Inngest** (self-hosted) | event-driven workflows / fan-out | edge Worker emits; Neon DB `neon-events-prod` |
| `scan.projectsites.dev` / internal | **Skyvern** | heavy logged-in 12-step agent flows ONLY (CF Access, internal) | NOT default architecture; product uses `browser.projectsites.dev` for routine work |
| `browser.projectsites.dev` | **Browserless / Playwright grid** | screenshots / visual-QA / scrape fallback tier | the CF-first browser abstraction's self-hosted fallback |
| (analytics) | **Cloudflare Analytics Engine + RUM** | high-cardinality per-tenant analytics (Tinybird/ClickHouse removed 2026-10-07) | native CF bindings; no external secrets |
| (jobs/orchestration) | **Hatchet** (cloud-hosted, NOT Fly yet) | durable task orchestration | secrets: `HATCHET_API_TOKEN`, `HATCHET_MANAGEMENT_TOKEN` in get-secret |

### Candidate add-ons (per the brainstorm, lower priority)
text-embeddings-inference (BGE) · Whisper + Piper/XTTS TTS · Real-ESRGAN + rembg · self-hosted PostHog + Sentry (front with the observability-gateway Worker) · MinIO (R2 cold tier on the 8TB) · Crawlee/Firecrawl-OSS.

## vLLM + ComfyUI launch plan (the cost-killer)

1. Coolify: deploy vLLM (Qwen2.5-32B-Instruct AWQ or Llama-3.3-70B tensor-parallel across both cards) → OpenAI-compatible `:8000`; ComfyUI `:8188`.
2. Cloudflare Tunnel → `llm.projectsites.dev` + `img.projectsites.dev`; both behind **CF Access SSO** (service-token for the Worker, interactive for humans).
3. Set env (get-secret → `wrangler secret put`): `SELFHOST_LLM_URL`, `SELFHOST_LLM_MODEL`, `SELFHOST_LLM_API_KEY`, `SELFHOST_IMAGE_URL`, `SELFHOST_IMAGE_MODEL`, `SELFHOST_IMAGE_API_KEY`. Worker→tunnel calls carry the CF Access service-token headers (`CF-Access-Client-Id`/`Secret`).
4. Wire `external_llm` `selfhosted` provider (the rippling provider-union change — its own focused pass) + `image_generation` first-try. **`self_hosted.ts` adapter + tests already shipped (fire-v2.67, commit 1561f45e).**
5. Route through AI Gateway where possible (the every-call mandate); self-hosted is the `standard`/`instant` tier, premium (Anthropic) keeps judgment + vision.
6. **Never in the hot path** — batch/async/build-time only (residential uplink).

## Secrets stored this session (get-secret + chezmoi age-encrypted)

`HATCHET_API_TOKEN` · `HATCHET_MANAGEMENT_TOKEN` · `CF_API_TOKEN_PROJECTSITES_DEPLOY`. Push to prod Worker secrets when the consuming code lands (`wrangler secret put`, minted-token recipe in `secret-provisioning`). (The `TINYBIRD_*` secrets are retired — Tinybird/ClickHouse removed 2026-10-07; analytics is CF Analytics Engine + RUM.)
