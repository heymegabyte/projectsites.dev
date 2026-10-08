# Observability & Analytics

Single reference for logging, tracing, product analytics, error tracking, the analytics warehouse, and AI observability on projectsites.dev. Cloudflare-first: **Workers Analytics Engine + RUM is the analytics plane** (alongside D1 `visitor_events` + PostHog product events); the Axiom + ClickHouse-on-Fly stack below is the documented **Fly escape-hatch** (as-deployed per `ARCHITECTURE.md` + `DEPLOYMENT.md`) used for high-volume structured logs/warehouse where Analytics Engine isn't enough. **Tinybird is REMOVED (2026-10-07, Brian directive) — do not reintroduce it or any ClickHouse-managed-alt as a promotion path.**

## Stack at a glance

| Tool | Role | Where / Endpoint | Use for | NOT for |
|---|---|---|---|---|
| **PostHog Cloud** | Product analytics, flags, session replay, FE error capture | `https://us.i.posthog.com` (`/capture`, `/batch`, `/decide?v=3`) | Funnels, conversion, flag eval, FE errors, replay | High-volume logs, infra metrics |
| **Axiom** | Primary structured log store | `logs.projectsites.dev` (Axiom Play UI, behind CF Access); ingest `https://api.axiom.co/v1/datasets/{dataset}/ingest` | Every request/response + job log, real-time tail, trace correlation | Product funnels, identity analytics |
| **OpenTelemetry** | Correlation + transport (no storage) | Workers Tracing → Axiom OTLP `https://api.axiom.co/v1/traces` | trace_id/span_id on every log+event, AI/D1/R2 spans | Storage — transport only |
| **ClickHouse (Fly.io)** | High-volume analytics warehouse (Fly escape-hatch only) | Single-node Fly VM, HTTP API port 8123 | `page_views`, `events`, `site_builds` at scale; tenant export/delete | Transactional writes, auth state |
| **Sentry** | Exception tracking — **LIVE / retained** | `@sentry/cloudflare` (`withSentry`); `SENTRY_DSN` via wrangler secret; `SENTRY_RELEASE` | Unhandled exceptions, grouping, release tracking | High-volume logs, funnels |

Sentry is production (service-registry, `env.ts`, wrangler `SENTRY_DSN`) — focus it on exceptions; Workers Tracing handles I/O spans. CF Analytics Engine + RUM is the default plane; the Fly ClickHouse VM is the escape-hatch for >100M events/day. (Tinybird removed 2026-10-07 — no managed-ClickHouse promotion path.)

## Correlation / trace-id flow

Every HTTP request into the CF Worker (Hono) gets a **trace_id + span_id** (OTel, from upstream `traceparent` or generated). The same trace_id lands in the Axiom log line AND the PostHog event property — so a user action (PostHog) joins to its exact log lines (Axiom) and spans.

```
Browser → CF Worker (Hono)
  ├─ OTel: traceId+spanId (Workers Tracing auto-instrument)
  ├─ Axiom middleware: log {traceId, spanId, tenantId, requestId, …}
  ├─ PostHog capture: {$distinct_id, traceId, event, …}
  ├─ D1 → child span db.query · Workers AI → ai.inference · R2 → r2.put/get
  └─ OTLP/HTTP exporter → Axiom (spans+logs, queryable by trace_id) + PostHog (events carry traceId)
```

To correlate: copy `traceId` from a PostHog event → in Axiom Play run `['project-sites-production'] | where trace_id == "…"` → all ordered log lines + span context. W3C propagation to ClickHouse/Chatwoot/Postiz via `traceparent: 00-{traceId}-{spanId}-01` (`tracedFetch`).

## Logging doctrine

`apps/project-sites/src/lib/log.ts` (Worker) + `frontend/src/app/services/logger.service.ts` (SPA, mirrors API). Generic level/redaction/correlation discipline lives in the global `structured-logging` + `pii-handling-discipline` rules; the project specifics:

- **Levels:** `error`/`warn` always; `info` always in dev/test, sampled 1-in-N in prod via `LOG_INFO_SAMPLE` (default `1`=all); `debug` only when `LOG_LEVEL=debug` or `NODE_ENV!=production`.
- **Formats:** prod/test = one JSON line per call (parsed by Wrangler Tail, Axiom, PostHog); local dev = colorized ANSI. `eventName` aliases `msg`. `scope` slash-separated, root `project-sites`; `log.child('a').child('b')` → `project-sites/a/b`.
- **Correlation:** a Hono `Context` auto-extracts `requestId` (`requestIdMiddleware`), `userId`+`orgId` (`authMiddleware`), `env`.
- **Redaction (2 layers — secrets never reach Tail/Axiom/PostHog):** (1) allowlist `SAFE_FIELD_ALLOWLIST` — only listed keys pass (service, env, requestId, userId, orgId, siteId, slug, path, method, status, durationMs, attempt, provider, event_id, error, message, cause, code, route, count, success, ok, total, +scope extras); everything else dropped. (2a) key matching `/(authorization|cookie|token|secret|password|key|stripe-signature)/i` → `[REDACTED]`. (2b) value matching a known secret format (`sk_live_`, `rk_live_`, `whsec_`, `re_`, `SG.`, `xoxb-`, `ghp_`, `gho_`, `Bearer `, JWT) → `[REDACTED]` even if allowlisted.
- **SPA:** prod emits `console.warn(payload)` (Sentry breadcrumb hooks intercept via `GlobalErrorHandler`); `debug` suppressed in prod.
- **Rules:** never `console.log` (ESLint-blocked); never log raw bodies or inside tight loops.

## OTel / tracing

Zero-config Workers Tracing in `wrangler.toml`: `[observability] enabled=true`, `[observability.logs] enabled=true`. Auto-instruments incoming HTTP, outbound `fetch`, D1 (`db.statement`, rows_read/written), KV, R2, Queues, Workers AI (`cf.ai.model`, input/output_tokens). Manual spans via `createSpan(ctx, name, attrs, fn)` (`src/lib/otel.ts`) for AI inference / external HTTP / business logic.

## PostHog

No Node SDK — raw `fetch` + `ctx.waitUntil` (fire-and-forget); helpers in `src/lib/posthog.ts` (`captureEvent`, `captureBatch`). **Use `us.i.posthog.com`, never `app.posthog.com`.** Every event carries `tenant_id` + `trace_id`. Key events: `user.signup`, `user.login`, `site.generated`, `site.served`, `site.published`, `checkout.started/completed`, `subscription.cancelled`, `domain.connected`, `api_key.created`, `$exception` (in `app.onError`), `$pageview` (JS snippet). Flags server-side via `/decide?v=3`. Session recording on Angular admin (`maskAllInputs:false`, password fields masked). **PII:** never raw email as `distinct_id` — internal `user_id` UUID; GDPR delete via person-deletion API.

## Axiom

No SDK — raw `fetch` POST of a JSON array; auto-detects fields. Middleware `src/middleware/axiom_logger.ts`, `app.use('*', axiomLogger)` after request-id, fire-and-forget via `waitUntil`. **Required fields:** `_time` (ISO8601), `level`, `service`(=`project-sites`), `env`, `message`, `trace_id`, `span_id`, `request_id` (+`X-Request-Id` header), `tenant_id`, `user_id`, `method`, `path`, `status`, `duration_ms`, `cf_ray` (`CF-Ray`), `service_version` (`env.CF_VERSION_METADATA.id`). Optional: `site_id`, `workflow_id`, `ai_model`, `ai_tokens_in/out`, `error_code`, `error_type`, `cache_hit`. **Retention:** prod 30d, preview 7d, dev 3d. Bills on ingest only.

## ClickHouse (analytics warehouse — Fly escape-hatch; Tinybird removed)

Single-node Fly VM `projectsites-clickhouse`, region `iad`, image `clickhouse/clickhouse-server:24.6-alpine`, volume `clickhouse_data` 50gb at `/var/lib/clickhouse`, port 8123, `auto_stop_machines=false`, `min_machines_running=1`. Worker talks HTTP API only — `src/lib/clickhouse.ts` (`clickhouseQuery`, `clickhouseInsert`) with `X-ClickHouse-User`/`X-ClickHouse-Key`, NDJSON `INSERT … FORMAT JSONEachRow`. **Every table requires `tenant_id UUID NOT NULL`** (isolation, GDPR). Tables (MergeTree, `PARTITION BY toYYYYMM`, 2yr TTL): `page_views`, `events`, `site_builds` (`ReplacingMergeTree`). GDPR export `FORMAT CSVWithNames`; erase via `ALTER TABLE … DELETE WHERE tenant_id=…` + `OPTIMIZE … FINAL`. Backup `clickhouse-backup` → R2 `project-sites-production` path `clickhouse-backups/`, daily 03:00 UTC, keep 7. (The former Tinybird managed promotion path is REMOVED 2026-10-07 — CF Analytics Engine + RUM is the default plane; the Fly ClickHouse VM is the only warehouse escape-hatch.)

### Analytics ingestion pipeline

Main Worker enqueues (never writes ClickHouse inline) via `ANALYTICS_QUEUE`. Consumer Worker `project-sites-analytics-ingestion`: queue `project-sites-analytics`, `max_batch_size=100`, `max_batch_timeout=5`, `max_retries=3`, DLQ `project-sites-analytics-dlq`. Validates each msg vs Zod `AnalyticsEventEnvelopeSchema` (`packages/shared/src/schemas/analytics.ts`: `event_type`, `tenant_id`(uuid), `site_id`, `user_id`, `session_id`, `occurred_at`, `properties`). Invalid → `ack()` + log (no retry). Routes `page.viewed`→`page_views`, else→`events`. **On ClickHouse failure → fallback to PostHog `/batch`**; total failure → DLQ. DLQ drain Worker logs unprocessable events to Axiom.

## AI observability & governance

Generic AI-feature governance (trace + eval-gate + prompt-version + budget-cap + fallback + grounding + Zod-validated output) lives in the global `contract-first-ai` / `evals` / `model-routing` / `auto-meta-work` rules. Project-specific bindings:

- Routing layer `llm.projectsites.dev` (LiteLLM) behind **Cloudflare AI Gateway** (per-request `cacheKey`+`cacheTtl`, 30–70% hit; `gateway().patchLog()` feeds eval scores back).
- **Trace** via Langfuse (prompt name+version, model, latency, tokens, cost, `featureSlug`, `orgId`, request `correlationId`). **Eval** via Promptfoo (`--mock-only` in CI, `--live-only` pre-release; no eval = build-fail). **Prompt registry** `apps/project-sites/prompts/` + `src/prompts/` (never inline). **Budget**: `org_ai_budget_cap` hard ceiling, credit-metered wallet, near-cap alert.
- Provider tiers: Premium = Anthropic/OpenAI (architecture, security/payment/auth, ALL vision); Mid (default) = DeepSeek `deepseek-chat`; Instant = CF Workers AI `@cf/meta/llama-*` FP8. `DEEPSEEK_API_KEY` always a wrangler secret.

See `generated-site-quality.md`.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `POSTHOG_API_KEY` / `POSTHOG_PUBLIC_KEY` | server capture / FE snippet | `phc_…`, secret |
| `POSTHOG_HOST` | both / ingestion fallback | `https://us.i.posthog.com` |
| `AXIOM_API_KEY` | Hono middleware / OTLP | `xaat-…`, secret |
| `AXIOM_DATASET` | middleware | `project-sites-production` (`[vars]`) |
| `AXIOM_ORG_ID` | Axiom SDK | secret |
| `OTEL_SERVICE_NAME` | Workers Tracing | `project-sites` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Workers Tracing | `https://api.axiom.co/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Workers Tracing | `Authorization=Bearer xaat-…,X-Axiom-Dataset=project-sites-production` (secret) |
| `SENTRY_DSN` / `SENTRY_RELEASE` | `@sentry/cloudflare` | secret / release tag |
| `CLICKHOUSE_HOST` / `_DATABASE` / `_USERNAME` / `_PASSWORD` / `_PORT` | ingestion Worker | host/pwd secret; db `projectsites`; user `default`; port `8123` |
| `ANALYTICS_QUEUE` | main Worker | queue producer binding |
| `LOG_LEVEL` / `LOG_INFO_SAMPLE` | logger | `debug` / `1`=all, `N`=1-in-N info |
| `DEEPSEEK_API_KEY` | AI routing | secret, never committed |
