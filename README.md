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

Two workspace roots exist for a historical reason: the repo began as the root-level
[bolt.diy](https://github.com/stackblitz-labs/bolt.diy) Remix app (`app/` — still the CF Pages
deploy unit and owner of the root `wrangler.toml` / `vite.config.ts` / `electron/`), and the
ProjectSites monorepo (`apps/*` + `packages/*`) was layered on top. Standard monorepo layout
(Nx / Turborepo / pnpm-workspaces) puts **every** deployable app under `apps/`; relocating the
editor `app/` → `apps/editor/` is tracked in [`TODO.md`](./TODO.md) and § Roadmap below.

| Path | What |
| ---- | ---- |
| `apps/project-sites/` | Cloudflare Worker (Hono) → `projectsites.dev` — the delivery engine + admin |
| `apps/project-sites/frontend/` | Angular admin SPA (Spartan UI) |
| `app/` | bolt.diy editor (Remix) → `editor.projectsites.dev` — **root-level for now** (see note above) |
| `packages/shared/` | Shared Zod schemas, constants, RBAC, utilities |
| `docs/` | Canonical docs (MkDocs site under `docs/docs/`) |

## Roadmap — parked initiatives

Non-core, not-yet-integrated efforts were **removed from the tree** (2026-09-22 cleanup) to keep
the repo focused on the Worker + admin + editor. They remain in git history and can be restored if
prioritized. Each is a real future direction, parked — not abandoned:

- **Public API SDK + `psctl` CLI + MCP server** (`packages/{sdk,psctl,mcp-server}`) — a
  customer-facing toolkit to drive the platform programmatically (auth, sites CRUD, deploy,
  snapshots, logs) and expose it to Claude / Cursor / ChatGPT via MCP. Scaffolded at v0.1.0, never
  wired into core, never published. Revive when a public API is a committed product.
- **Chrome extension** (`apps/chrome-extension`) — browser companion. Scaffold only.
- **Desktop app** (`apps/desktop`, Tauri) — native shell. Scaffold only. Distinct from the editor's
  inherited Electron packaging at root `electron/`, which still has CI (`electron.yml`).
- **Mobile app** (`apps/mobile`, Capacitor) + **`apps/project-sites/capacitor`** — native iOS /
  Android shells. Scaffold / empty.
- **`analytics-ingest`** (`apps/analytics-ingest`) — standalone ingest-worker stub (2 files),
  superseded by in-worker OTLP + PostHog.
- **v2 Angular migration** (`apps/web/*`) — a planned canonical marketing home ("target state after
  Phase 8" per `.cleanup-allowlist`) that was never scaffolded. Either build it or formally retire
  the plan (tracked in `TODO.md`).

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
