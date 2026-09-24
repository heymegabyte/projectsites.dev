# Subdomain & Service Map

Canonical reference for every `projectsites.dev` subdomain (and related infra
domains). Status: **LIVE** = deployed + serving · **CONFIG** = infra/config built,
not yet deployed · **PLANNED** = reserved name, referenced in code/docs, not built.

> Maintained doc — update when a subdomain is stood up, renamed, or retired.
> Customer sites (`{slug}.projectsites.dev`, e.g. `vitos-mens-salon.projectsites.dev`)
> are generated per-business and are NOT listed here — they're product output, not infra.

---

## Core platform — `projectsites.dev`

| Subdomain | Purpose | Status |
|---|---|---|
| `projectsites.dev` | Main Worker — marketing site + public API + customer-site serving | **LIVE** |
| `www.projectsites.dev` | Marketing alias → apex | **LIVE** |
| `editor.projectsites.dev` | bolt.diy in-browser editor (embedded iframe across admin) | **LIVE** |
| `ide.projectsites.dev` | IDE surface (editor alias) | PLANNED |
| `{slug}.projectsites.dev` | Every generated customer business site | **LIVE** (per-site) |
| `cname.projectsites.dev` | CNAME target for customers' custom domains (CF for SaaS) | **LIVE** |
| `template.projectsites.dev` | Reusable site template repo/preview | **LIVE** |
| `storybook.projectsites.dev` | Site-kit component catalog (generated-site blocks) | **LIVE** |
| `preview.projectsites.dev` | Generated-site preview surface | PLANNED |

## Business apps (Cloudflare Containers / Fly)

| Subdomain | App | Status |
|---|---|---|
| `cms.projectsites.dev` | Payload CMS | **LIVE** |
| `crm.projectsites.dev` | Twenty CRM | **LIVE** |
| `mail.projectsites.dev` | Listmonk — newsletters / campaigns (relays via SES) | **LIVE** |
| `events.projectsites.dev` | Inngest — background jobs / event bus | **LIVE** |
| `plane.projectsites.dev` | Plane — project management | **CONFIG** (Fly draft via `infra/fly/plane/fly.toml`; to convert to CF Container 2026-Q4) |
| `support.projectsites.dev` | Chatwoot — support inbox / live chat | **CONFIG** (Fly) |
| `social.projectsites.dev` | Postiz — reference/transition social scheduler | **CONFIG** (Fly) |

## Observability & analytics (this convergence — Fly configs built)

| Subdomain | Purpose | Status |
|---|---|---|
| `analytics.projectsites.dev` | ClickHouse analytics gateway (tenant-scoped, API-only) | **CONFIG** |
| `logs.projectsites.dev` | Axiom — structured logs | **CONFIG** |
| `telemetry.projectsites.dev` | OpenTelemetry collector (private/protected) | **CONFIG** |
| `traces.projectsites.dev` | Trace explorer surface | **CONFIG** |
| `status.projectsites.dev` | Public status / health page | PLANNED |
| `checks.projectsites.dev` | Health-check surface | PLANNED |

## AI & product surfaces

| Subdomain | Purpose | Status |
|---|---|---|
| `api.projectsites.dev` | Public API surface | PLANNED |
| `app.projectsites.dev` / `apps.projectsites.dev` | App / installed-apps surfaces | PLANNED |
| `auth.projectsites.dev` | Auth / IdP (Better Auth default, Better Auth enterprise) | PLANNED |
| `browser.projectsites.dev` | Browser-automation gateway (CF Browser Rendering → Browserbase fallback) | **LIVE** |
| `llm.projectsites.dev` / `infer.projectsites.dev` | LLM inference gateway | PLANNED |
| `mcp.projectsites.dev` | MCP server endpoint (OAuth 2.1 AS) | PLANNED |
| `agent.projectsites.dev` | Agent runtime | PLANNED |
| `voice.projectsites.dev` | Voice agent | PLANNED |
| `search.projectsites.dev` | Search surface | PLANNED |
| `scan.projectsites.dev` | Site scanner / lead scanner | PLANNED |
| `jobs.projectsites.dev` | Job queue surface | PLANNED |
| `img.projectsites.dev` / `cdn.projectsites.dev` | Image transform / asset CDN | PLANNED |
| `email.projectsites.dev` | Transactional email endpoint | PLANNED |
| `secrets.projectsites.dev` / `keys.projectsites.dev` | Secrets / key management | PLANNED |
| `domainkey.projectsites.dev` | DKIM key surface for outbound mail | PLANNED |

## Related domains (not `projectsites.dev`)

| Domain | Purpose | Status |
|---|---|---|
| `linkbl.ink` | Link shortener (Dub on `app.claimyour.site`) for social UTM links | **CONFIG** (DNS + key pending) |
| `app.claimyour.site` | Dub instance + claimyour.site product line | **LIVE** |
| `llm.megabyte.space` | LiteLLM gateway | **LIVE** |
| `*.megabyte.space` | Internal infra: Grafana, Langfuse, Coolify, Skyvern, n8n, vault, Inngest, secrets, etc. | **LIVE** (internal) |

---

## Vendor-suggestion dispositions (what happened to proposed services)

How earlier service suggestions resolved — adopted, built-native, or deferred:

| Suggestion | Disposition | Where |
|---|---|---|
| **Svix** (webhook mgmt) | **Built native** — `src/services/outbound_webhooks.ts`: signed payloads + HMAC + timestamp-replay-safety + exponential backoff + bounded retries ("Svix/Stripe-style"). Svix product NOT installed (registry: ⏳ defer/adapter-only). | `outbound_webhooks.ts` |
| **Novu** (notifications) | **Rejected → custom `psnotify`** (Brian directive 2026-06-24): DO inbox + center + prefs + SES/Listmonk/web-push. Zero Novu. | `psnotify` (planned) |
| **Sentry** (errors) | **Removed entirely** → PostHog (product analytics) + Axiom (logs) + OpenTelemetry (correlation). | this convergence |
| **Resend** (email) | **Replaced** → Amazon SES (SigV4 raw-send, zero npm dep) + Listmonk for campaigns. `react-email` kept for server-side templating only. | SES + Listmonk |
| **Postiz** (social) | **Isolated reference only** — `social.projectsites.dev`. Native Pulse Social does NOT depend on Postiz runtime. | Pulse Social |
| **Dub** (short links) | **Adopted** (self-hosted at `app.claimyour.site`) for `linkbl.ink` social-link shortening — auto UTM-tag + shorten at publish. | `link_shortener.ts` |

> Pattern: prefer **building the concept on CF/own primitives** over adopting a SaaS
> when the surface is core (webhooks, notifications, observability); adopt the vendor
> only when it's genuinely faster AND not load-bearing (Dub for short links).

---

## Self-hosted service assignments (Brian directive 2026-06-26)

Loop `987b2ba5` drives each to a live 200 login page. HOSTING (Brian 2026-06-26):
**CloudFlare Workers Containers** (NOT Fly) + **Neon** (Postgres) + **Upstash** (Redis) +
**Tinybird** (managed ClickHouse, replaces self-hosted analytics). Each = a Container
Durable Object (Dockerfile + wrangler `[[containers]]` binding) + explicit
`<sub>.projectsites.dev/*` route beating the wildcard + DNS. All currently **404**.

| Subdomain | Service | What it is | Status |
|---|---|---|---|
| `projects.projectsites.dev` | **Plane** | Project management (Jira/Linear alt) | scaffold (Fly draft → convert to CF Container) |
| `webhooks.projectsites.dev` | **Svix** | Webhook delivery (managed) | PLANNED — note: our own `outbound_webhooks.ts` already does signed+retried delivery; Svix adds a managed UI/dashboard |
| `integrations.projectsites.dev` | **Nango** | Unified OAuth / integrations gateway | PLANNED |
| `auth.projectsites.dev` | **Better Auth** | Default consumer auth (OIDC) | **code built** — `auth/better-auth.ts` (ADR-0006), dark behind `BETTER_AUTH_*`; needs subdomain + activation |
| Enterprise SSO / SCIM | **Better Auth** | Enterprise SSO + SCIM provisioning | **code built** — `auth/better-auth.ts` (ADR-0006), dark behind `BETTER_AUTH_*` |

Per-deploy (CF Workers Container): official image → `Dockerfile` + `wrangler.toml` `[[containers]]`
+ a Container-DO class → Neon DB `projectsites_<svc>` → Upstash Redis → analytics → Tinybird
→ `wrangler secret put` → first-boot migrate → explicit CF route + DNS → verify `200` login.
NOTE: `infra/fly/plane/fly.toml` is the Fly-era draft — convert to a CF Container next fire.
