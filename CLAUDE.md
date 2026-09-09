# bolt.diy Monorepo — AI Context Guide

> Primary AI onboarding for the monorepo. Read this to ORIENT; the per-surface `CLAUDE.md`
> files are the canonical owners of detail — don't duplicate them here. Every task ends
> green per the global `verification-loop` (deploy + prod-E2E) and reports in the `always.md`
> format. This file carries only what's **project-specific** — the general engineering
> discipline (Zod, errors, logging, TDD, CI) lives in the global rules and in code.

---

## What this is

**bolt.diy** — an open-source, AI-powered full-stack web IDE in the browser: chat with AI to
generate/edit/deploy web apps, with a code editor, terminal, file manager, and live preview.
The monorepo ships three surfaces:

- **`app/`** — the bolt.diy editor (Remix + Vite) → Cloudflare **Pages `bolt-diy`** at
  `editor.projectsites.dev`. The admin Editor **extends** this — never build a parallel editor.
- **`apps/project-sites/`** — the SaaS website-delivery engine (**Cloudflare Worker + Hono**) →
  `projectsites.dev`, plus the **Angular admin SPA** under `frontend/`. **Primary dev focus.**
- **`packages/shared/`** — Zod schemas, constants, RBAC middleware, utilities shared across.

**Product**: "We don't sell websites, we deliver them." A business owner searches for their
business → signs in → gets a professionally AI-generated site, hosted + SSL'd + live in <15min.

### Canonical detail owners (read for depth)

- **`apps/project-sites/CLAUDE.md`** — Worker API surface, middleware, services, prompt system,
  site-generation pipeline, container build, gotchas.
- **`apps/project-sites/frontend/CLAUDE.md`** — Angular admin SPA (Spartan UI, services, perf).
- **`packages/shared/CLAUDE.md`** — schemas, constants, RBAC.
- **`SCOPE.md`** — mission · hard constraints · AI-buildable backlog · Brian-gated decisions.
- **`DECISIONS.md`** — accepted ADRs · **`apps/project-sites/_LOOP_LEDGER.md`** — the task tracker.

---

## Mission + stance

AI-native, gorgeous, easy-to-use, Cloudflare-optimized. **AI is the primary developer**, so the
system must be self-explaining + self-diagnosing. **Cloudflare-first** (Workers/Hono/D1/R2/KV/
Durable Objects/Queues/Workflows); Neon (Postgres via Hyperdrive) / Upstash (Redis) only when a
CF primitive genuinely can't. **Zod at every boundary**; human-readable errors via RFC7807
envelopes (`code` + `correlationId` + `errors[]` + what-to-do-next); correlated logs/traces/
events (requestId + traceId + tenantId); JSDoc on exports. Global rules own the general
discipline — `zod-everywhere`, `verification-loop`, `structured-logging`,
`feature-module-architecture`, `drift-detection`, `feature-flags`, `quality-metrics`.

---

## Project Sites Worker stack

| Layer | Tech |
|---|---|
| Ingress / API | Cloudflare Workers + Hono |
| System of record | Cloudflare D1 (SQLite) — parameterized SQL, **no Supabase client** |
| Cache | Cloudflare KV (host resolution 60s TTL, prompt hot-patch) |
| Storage | Cloudflare R2 — `sites/{slug}/{version}/{file}`, marketing at `marketing/index.html` |
| Background | Cloudflare Workflows (AI site-generation pipeline) |
| AI | Cloudflare Workers AI (Llama 3.3 70B + 3.1 8B, FP8) via AI Gateway |
| Payments | Stripe (checkout, subscriptions, webhooks) |
| Email | SES → Resend → SendGrid fallback chain (ADR-0019, SES primary once configured) + Listmonk (newsletters); bounce handling |
| Analytics | PostHog (server-side) |
| Errors | Sentry (HTTP API) |

Status machine: `draft → collecting → imaging → generating → published | error | archived`.

---

## Load-bearing design decisions (project gotchas)

- **Dot-based subdomains** `{slug}.projectsites.dev`; unpaid sites get a top-bar injected after `<body>`.
- **Queues not yet enabled** — the `QUEUE` binding is optional; code falls back to Workflows.
- **CSP includes `'unsafe-inline'`** — the homepage uses inline `<script>`.
- **Content-type detection**: use `marketingPath` not `path` (`path='/'` has no extension).
- **Persistent bolt.diy iframe** — `BoltEmbedService` owns the `editor.projectsites.dev` iframe
  across admin sub-routes (WebContainer cold-boot ~30-60s once/session); the `<iframe>` lives in
  `AdminComponent`'s template, NOT the editor route component, so navigation never destroys it.
- **MCP OAuth-first** — `/api/mcp/:provider/connect` falls back to a paste-key flow when the Worker
  lacks `{PROVIDER}_OAUTH_CLIENT_ID` (returns `501 oauth_not_configured` → toast + paste form, never
  a broken popup).
- **One dialog primitive** — every admin modal renders via `DialogShellComponent` (custom = drift).
- **Design tokens** in `frontend/src/styles/_polish.scss` — `--ps-bg:#060610`, `--ps-ink:#f4f4ff`,
  `--ps-accent:#00e5ff`, `--ps-z-overlay-takeover:100000`, `--ps-radius-xl:22px`. Hard-coded brand
  colors get flagged in audits. Feature icons float freely (no boxes/borders; `stroke=currentColor`).
- **Visibility-aware polling** — `AdminStateService` pauses its 30s/60s refresh on `document.hidden`,
  resumes + immediate-refresh on foreground.
- **WebContainer / cross-origin (editor)** — `public/_headers` serves COOP `same-origin` + COEP
  `credentialless` + `Origin-Agent-Cluster: ?1` (needed for `SharedArrayBuffer`; verify
  `crossOriginIsolated === true`). `globalThis.WEBCONTAINER_API_IFRAME_URL` is set in `app/root.tsx`
  Head before the bundle loads (overrides the default `/headless` iframe); `WebContainer.boot()` in
  `app/lib/webcontainer/index.ts` uses `coep:'credentialless'`. Boot failures → check headers, the
  iframe URL, third-party-storage blocking (stackblitz.com / webcontainer.io exceptions).
- **Removed — never reintroduce**: Supabase, Twilio-SMS + phone-OTP, Lago/Unkey/Nango/Inngest/Postiz/Novu,
  **AI Agents** (the `/admin/ai-endpoints` UI-authored AI-endpoint feature + `ai_endpoints` D1 table + the
  `/api/ai/:slug/:endpoint` dispatcher — replaced by code-defined **Functions** on Cloudflare Workers for
  Platforms; owners define endpoints in a `functions/` folder in their site code, not a dashboard form. See
  `docs/decisions/0035-custom-code-endpoints-wfp.md` + `docs/FUNCTIONS-CONVERGENCE.md`. `wfp_dispatch.ts` is KEPT
  — it's the WfP plumbing Functions reuses).
  Residual orphan columns (`users.phone`, `phone_otps`) are inert. **Resend is REMOVED** (2026-09-09, Brian
  directive) — Amazon SES is the SOLE email provider (`getEmailProvider`/`sendEmail`), with **SendGrid** as the
  only break-glass fallback (ADR-0019). Do NOT reintroduce a Resend send rail. (The per-site **Resend MCP**
  integration — a site owner connecting THEIR OWN Resend key — is a separate customer feature and is KEPT.)

---

## Toolchain + gotchas

- **`pnpm install` FAILS** (electron-builder SSH dep) → **`npm install --legacy-peer-deps`** in
  sub-packages. Worker links `@project-sites/shared` via `file:../../packages/shared`.
- **`.gitignore` blocks `*.md`** → use `git add -f` for markdown.
- **`console.log` blocked by ESLint** → `console.warn` for structured logs.
- **Jest config MUST be `.cjs`** (repo is `"type":"module"`) with
  `moduleNameMapper: {'^(\\.{1,2}/.*)\\.js$':'$1'}`; `@swc/jest` needs the GLOBAL `jest` for mock
  hoisting; run from `apps/project-sites` (not repo root). Frontend units are Karma+Jasmine
  (`ng test`) — NOT Jest/Vitest.
- **TS**: `"type":"module"`, `moduleResolution:"Bundler"`, `.js` extensions in imports.
- New UI stack: Angular 21 standalone + Nx + Spartan UI (NOT PrimeNG/Material) + Storybook; Vitest
  in the root editor app.

---

## Commands

```bash
# Worker — apps/project-sites
npm install --legacy-peer-deps
npm test              # Jest          npm run typecheck   # tsc --noEmit
npm run lint          # ESLint        npm run check       # all of the above
npm run validate:features             # feature-module drift gate
npx wrangler dev                      # local (:8787)

# Frontend — apps/project-sites/frontend
npm start                             # ng serve :4200
npm run test:ci                       # Karma headless
npx tsc --noEmit -p tsconfig.app.json

# Editor — root app/
npm test                              # Vitest
```

---

## Deploy (prod pre-authorized per verification-loop)

```bash
cd apps/project-sites && npx wrangler deploy --env production   # MUST include --env production
```

- **`--env production` is mandatory** — a bare `wrangler deploy` makes EVERY `/api/*` route 500.
- Auth: `CLOUDFLARE_API_KEY` (get-secret) + `CLOUDFLARE_EMAIL=blzalewski@gmail.com`.
- **NEVER modify already-set CF secrets** (Stripe/OAuth/etc.); `wrangler secret put` only for a
  genuinely NEW secret.
- After completing changes, deploy, then **prod-verify the changed routes** (curl/Playwright) — a
  local pass is never sufficient (global `verification-loop`).

### Cloudflare resource IDs

| Resource | ID |
|---|---|
| Account | `84fa0d1b16ff8086dd958c468ce7fd59` |
| Zone projectsites.dev | `9ceaa211750dd31899fd5d1bf8d1ec46` |
| Zone megabyte.space | `75a6f8d5e441cd7124552976ba894f83` |
| Pages bolt-diy | `76c34b4f-1bd1-410c-af32-74fd8ee3b23f` |
| D1 production | `ea3e839a-c641-4861-ae30-dfc63bff8032` (`project-sites-db-production`) |

---

## Testing + gates (non-negotiable)

- **TDD-first** — a failing Playwright spec BEFORE implementation → implement → green. Bug fix =
  failing regression test first. No feature without ≥1 test; no bug fix without ≥1 regression.
- **Homepage-first E2E** — every spec `goto('/')`, then navigate by UI actions only (no
  `page.goto()` after load). Deterministic (no sleeps; locator waits), parallel-safe, stable
  selectors (`data-testid` / role). Target 100% feature coverage + 100% unit coverage.
- Suites: Worker Jest (`apps/project-sites/src/__tests__`); frontend Playwright
  (`apps/project-sites/e2e` — `*.spec.ts` = CI/dev, `*.e2e.ts` = prod); editor Vitest + root `e2e/`.
- **Feature inventory** — `e2e/FEATURES.md` (authoritative list) + `e2e/COVERAGE.yml` (feature→spec);
  `validate:e2e-inventory` keeps them honest. CI fails on a feature without coverage.
- **Feature modules** — every post-launch capability = `libs/features/<slug>/` + 7-field `manifest.ts`
  behind a typed flag; drift is a merge-blocker (`npm run validate:features`, CI
  `feature-architecture.yml`, server guard returns 404 when the flag is off). Ref impl:
  `libs/features/donations_engine/`.
- **Copy** meets Flesch Reading Ease ≥ 50. CWV / axe / Lighthouse / console-error gates live in the
  global `quality-metrics` + `verification-loop`.

---

## Site-generation philosophy (the core product)

Generate enterprise-grade sites that BEAT the source — more beautiful, faster, more accessible,
better-organized, denser. A perfect site needs 20-30 iterative specialized prompts, not one. The
container runs ONE Claude Code orchestrator that fans out to parallel subagents (visual-qa,
seo-auditor, accessibility-auditor, performance-profiler, content-writer, domain-builder,
validator-fixer) and gates DONE on `completeness-checker`. Page count = source sitemap (1:N, up to
1000). Logo luminance drives light/dark theme. Build invariants are enforced in
`src/services/build_validators.ts` (required files, asset existence, meta lengths, JSON-LD count,
single H1, banned slop). Full detail: `apps/project-sites/CLAUDE.md`.
</content>
