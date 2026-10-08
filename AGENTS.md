# AGENTS.md — projectsites.dev

30-second map for AI coding agents. This is the **entry point, not the manual** — read the
authoritative per-surface `CLAUDE.md` before any non-trivial change.

## Product

AI-native SaaS **website-delivery engine** on Cloudflare: a business owner searches, signs in,
and gets a professionally AI-generated site (hosted, SSL'd) in <15 min. The repo also hosts an
in-browser **editor** (a bolt.diy fork) at `editor.projectsites.dev`.

## Three deployable surfaces (know which one you're touching)

| Path | What / stack | Deploys to | Authoritative doc |
| ---- | ---- | ---- | ---- |
| `apps/project-sites/` | Delivery engine + admin API — **CF Worker + Hono + D1/KV/R2/Workflows/AI** | `projectsites.dev` (`wrangler deploy`) | [`apps/project-sites/CLAUDE.md`](apps/project-sites/CLAUDE.md) |
| `apps/project-sites/frontend/` | Admin SPA — **Angular 21 + Spartan UI**, signals, zoneless | `projectsites.dev` static (R2 push) | [`frontend/CLAUDE.md`](apps/project-sites/frontend/CLAUDE.md) |
| `app/` | **bolt.diy editor** — Remix + Vite | `editor.projectsites.dev` (Pages **`bolt-diy`**, `--branch=main`) | root [`CLAUDE.md`](CLAUDE.md) PART 3/17 |
| `packages/shared/` | Zod schemas · constants · RBAC · utils (barrel exports: `./schemas` etc.) | consumed by worker + frontend | [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md) |

## Commands (per surface — verified)

```bash
# install (ALL packages — pnpm is broken by electron-builder)
npm install --legacy-peer-deps

# apps/project-sites (worker)
npm test            # Jest units      npm run typecheck   # tsc --noEmit
npm run check       # typecheck+lint+drift gates+format+units (the full gate)
npm run deploy:production   # wrangler deploy --env production

# apps/project-sites/frontend (Angular)
npm run test:ci     # Karma headless  npx tsc --noEmit -p tsconfig.app.json
npm run build:prod  # drift gates + ng build   npm run deploy:production   # R2 push
npm run verify:production   # Playwright smoke vs prod

# app/ (bolt.diy editor, run from repo root)
npm test            # Vitest          npm run typecheck   # tsc
npm run build       # remix vite:build → build/client
```

## Non-obvious invariants (break these = broken build/prod)

- **Cloudflare-first.** Workers/D1/R2/KV/Durable Objects/Workflows first. Neon (Postgres) /
  Upstash (Redis) are escape hatches only; **Cloudflare Analytics Engine + RUM** is the OLAP/analytics
  plane (Tinybird/ClickHouse removed 2026-10-07). Self-hosted app SKUs obey the **4-service rule**
  (see README).
- **Zod at every trust boundary**; infer types via `z.infer`, never hand-duplicate. Runtime
  validation is not optional because a TS type says so.
- **Feature modules**: new capabilities live in `apps/project-sites/libs/features/<slug>/` with a
  `manifest.ts` (7 fields) + a D1 feature flag (`enabled=0, rollout=0, stage=experimental`); handlers
  mount in `src/index.ts` via `app.route()`. Gate: `(cd apps/project-sites && npm run validate:features)`.
  Do NOT scatter handlers loose in `routes/`.
- **`console.log` is ESLint-blocked** → use `console.warn` for structured logs.
- **`.gitignore` blocks `*.md`** → `git add -f` to commit any markdown.
- **Imports carry extensions**: TS relative imports use `.js`; Remix uses `.client`/`.server`
  suffixes. A dead-code grep that ignores these fabricates false orphans.
- **Deploy = build → ship → verify-on-prod.** Local green ≠ done; assert the live URL. Editor
  deploys to Pages project `bolt-diy` (NOT `bolt`) with the CF **global** key.
- **Shared main tree, many concurrent agents + crons.** Commit + push small verified slices;
  `git pull --rebase --autostash`; never `git reset` the tree. Stage only files you changed.

## "Where does X live?"

| Concept | Start here |
| ---- | ---- |
| Auth (magic-link / Google / Better Auth) | `apps/project-sites/src/services/auth.ts`, `middleware/auth.ts` |
| API routes | `apps/project-sites/src/routes/` + `apps/project-sites/libs/features/*/handlers.ts` (mounted in `src/index.ts`) |
| DB access (D1) | `apps/project-sites/src/services/db.ts` (`dbQuery/dbInsert/dbUpdate`) |
| Feature flags | `apps/project-sites/src/modules/feature_flags/services.ts` (`isFlagOn`) + admin `frontend/.../admin/sections/feature-flags.component.ts` |
| Billing / webhooks | `services/billing.ts`, `routes/webhooks.ts` |
| AI inference / RAG | `services/external_llm.ts`, `services/rag.ts` (AI Gateway + Vectorize) |
| Site generation pipeline | `apps/project-sites/src/workflows/site-generation.ts` |
| Admin UI | `apps/project-sites/frontend/src/app/pages/admin/` |
| Shared schemas | `packages/shared/src/schemas/` |

## Deeper docs (single source of truth — don't duplicate here)

Architecture [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — as-deployed / current, the single
canonical architecture doc (future-topology decisions live as ADRs in [`DECISIONS.md`](DECISIONS.md)).
Deployment [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
Testing [`docs/TESTING.md`](docs/TESTING.md) · AI [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md) ·
Observability [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) · Decisions [`DECISIONS.md`](DECISIONS.md).
