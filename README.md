# projectsites.dev

AI-native SaaS website-delivery engine on Cloudflare. A small-business owner searches for
their business, signs in, and receives a professionally built, AI-generated website in under
15 minutes — hosted, SSL'd, and live. The repo also hosts the in-browser editor (a fork of
[bolt.diy](https://github.com/stackblitz-labs/bolt.diy)) at `editor.projectsites.dev`.

> **Scope on one page:** [`SCOPE.md`](./SCOPE.md) — mission, hard constraints, the AI-buildable
> backlog, and the decisions that are Brian's to make.
>
> **AI onboarding:** start at [`AGENTS.md`](./AGENTS.md) (30-second map) →
> [`CLAUDE.md`](./CLAUDE.md) (root depth) → the per-surface `CLAUDE.md`
> (e.g. [`apps/project-sites/CLAUDE.md`](./apps/project-sites/CLAUDE.md)).

> ### ⭐ Prime directive — embarrassingly easy to use
> **Continually, always, make the entire application embarrassingly easy to use.** Every surface
> (admin, generated sites, create flow, editor), every change, forever: a busy non-technical owner
> succeeds on the first try with no manual — if they'd have to ask a question, it isn't done. AI does
> the work, the user confirms; zero-config defaults; one obvious action per screen; ≤3 steps to any
> outcome; undo everywhere; empty states launch the first result. Every iteration must be more
> beautiful AND more effortless. Full mandate: `CLAUDE.md` § SUPREME + global rule
> `embarrassingly-easy-to-use`.

## What's New (May 2026)

The `apps/project-sites/` worker — the SaaS website delivery engine at
[projectsites.dev](https://projectsites.dev) — shipped a wave of AI-native
infrastructure. Full reference: [docs/AI_INTEGRATION.md](./docs/AI_INTEGRATION.md).

| Area | Feature | Where to look |
| ---- | ------- | ------------- |
| Inference | **AI Gateway** routing for OpenAI + Anthropic with cache, fallback, structured logs | `apps/project-sites/src/services/external_llm.ts:101` · `wrangler.toml:187` |
| Retrieval | **Vectorize + AutoRAG** — 768-dim cosine index across research, voice, audit, forms, AI traces | `apps/project-sites/src/services/rag.ts` · `wrangler.toml:153` |
| Observability | **PostHog LLM-obs** — `$ai_generation` events from every LLM call | `apps/project-sites/src/services/analytics.ts:190` |
| Inference | **Anthropic SDK upgrade** — Opus 4.8 / Sonnet 4.6 / Haiku 4.5 with prompt caching | `apps/project-sites/src/services/external_llm.ts:75` |
| UX | **Streaming Markdown primitive** for live agent messages | `apps/project-sites/frontend/src/app/components/agent-message/` |
| HITL | **Task Tray + Elicitation** — `postAskUser` + `step.waitForEvent` for in-app questions | `apps/project-sites/src/services/task_inbox.ts` |
| Config | **AI Env Vars** — per-org / per-site / per-MCP encrypted KV pairs injected into prompts | `apps/project-sites/src/services/ai_env_vars.ts` |
| Assets | **Unified Media Library** — uploads, stock search, DALL·E 3, queued Sora/Veo, TTS | `apps/project-sites/src/services/media.ts` |
| Ingest | **Global drop-zone** — drag a file anywhere in the admin to upload to media library | `apps/project-sites/frontend/src/app/components/global-drop-zone/` |
| Architecture | **Mermaid system diagram** + updated request flow | `docs/ARCHITECTURE.md` |
| Ops | **Deployment guide** — auth chain, pre-flight bindings, smoke-test matrix, rollback | `docs/DEPLOYMENT.md` |

## Self-hosted app catalog — the 4-service rule

ProjectSites offers self-hosted OSS apps as customer SKUs, each on its own subdomain and
run as a Cloudflare Workers Container (dedicated Durable Object + fixed host route).
**An app is only supportable if its ENTIRE data/service plane fits within FOUR service
types — no more:**

1. **Custom** — the app's own container (Cloudflare Workers Container).
2. **Upstash** — Redis (caching / rate-limit / queues), when the app requires it.
3. **Neon** — Postgres (system of record).
4. **Tinybird** — analytics / event data, when the app requires it.

If an app needs anything OUTSIDE this set (its own bespoke Cube/ClickHouse analytics
backend, a second custom service, extra Hub services, etc.), it is **NOT supportable** and
must not be added.

- **Live:** Documenso (`sign.projectsites.dev`, e-signatures — Neon) · cal.diy
  (`schedule.projectsites.dev`, scheduling — Neon).
- **Rejected:** Formbricks (surveys) — its v5 image requires **Cube** *and* multiple extra
  custom **Hub** services, exceeding the 4-service max. Removed 2026-06-27.

## Repository layout

| Path | What |
| ---- | ---- |
| `apps/project-sites/` | Cloudflare Worker (Hono) → `projectsites.dev` — the delivery engine + admin |
| `apps/project-sites/frontend/` | Angular admin SPA (Spartan UI) |
| `app/` | bolt.diy editor (Remix) → `editor.projectsites.dev` |
| `packages/shared/` | Shared Zod schemas, constants, RBAC, utilities |
| `docs/` | Canonical docs (MkDocs site under `docs/docs/`) |

## Quick start

```bash
cd apps/project-sites
npm install --legacy-peer-deps   # NOT pnpm (electron-builder breaks it)
npm test                         # Jest unit tests
npm run typecheck                # tsc --noEmit
npx wrangler dev                 # local dev (port 8787)
```

## Docs

- **Architecture** — [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Deployment** — [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)
- **AI integration** — [`docs/AI_INTEGRATION.md`](./docs/AI_INTEGRATION.md)
- **Decisions (ADRs)** — [`DECISIONS.md`](./DECISIONS.md) (v2 architecture + convergence series, both folded in)
- **Editor (bolt.diy) FAQ + contributing** — [`docs/docs/FAQ.md`](./docs/docs/FAQ.md) · [`docs/docs/CONTRIBUTING.md`](./docs/docs/CONTRIBUTING.md)

## License

MIT — see [`LICENSE`](./LICENSE). The bolt.diy editor retains its upstream MIT license.
