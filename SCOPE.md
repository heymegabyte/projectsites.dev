# ProjectSites.dev — Scope Declaration

> The single human-manageable scope: mission, the hard constraints the AI must respect, the
> backlog the AI **should build autonomously**, and the decisions that are **Brian's to make**.
> Detail + completion history live in `apps/project-sites/_LOOP_LEDGER.md` (AI task tracker),
> `apps/project-sites/CLAUDE.md` (worker guide), and `DECISIONS.md` (ADRs). This file is the
> map; those are the territory.

## Mission

**"We don't sell websites. We deliver them."** A business owner searches for their business,
signs in, and receives a professionally AI-generated website — hosted, SSL'd, and live in
under 15 minutes. Golden path: **Search → Select business → Sign in → Details → AI builds → Live site.**
Every generated site must be more beautiful, faster, more accessible, and better-optimized than
the source. Build for the served population (underserved / multilingual / accessibility-first),
not the engineering aesthetic.

---

## Hard constraints (non-negotiable — the AI respects these on every change)

- **Cloudflare-first.** Workers + Hono + D1 + R2 + KV + Durable Objects + Queues/Workflows +
  Analytics Engine + Vectorize + AI Gateway. Fallbacks only when a CF primitive genuinely can't:
  Neon (Postgres via Hyperdrive) · Upstash (Redis) · Fly.io (always-on/stateful) · Coolify (self-host >$50/mo).
  **Never** default to Cloud Run / AWS / Vercel / Supabase.
- **Data placement.** D1 (simple relational) · Neon (true Postgres) · Upstash (Redis) ·
  **Cloudflare Analytics Engine for high-volume/OLAP events — never ClickHouse Cloud, never Tinybird**.
  Logical multi-tenancy (`site_id`/`org_id` scoping, one shared DB per many customers); dedicated
  isolation only for enterprise/compliance.
- **Frontend.** Angular 22 (admin/large apps) · React 19 + Vite (small marketing sites). Spartan UI
  only (no PrimeNG/Material). SSR/SSG mandatory for marketing.
- **Auth.** Better Auth (app IdP + enterprise SSO/SAML) · OpenFGA (authz) · WorkOS (enterprise SSO/SCIM only) ·
  CF Access (internal) · native tenant API tokens (`api_tokens.ts`). `orgId` is server-derived (`c.get('orgId')`), **never** a client header (IDOR).
- **Payments.** Square-class for accept-money; Stripe for SaaS billing/payouts. Usage metering = Stripe Meter Events (`StripeMetersProvider`) over ProjectSites' canonical D1 ledger; Stripe = collection rail; billing-provider abstraction defaults to noop.
- **Observability.** Sentry (errors, platform-only — never on customer sites) · Langfuse (AI traces) ·
  PostHog Cloud (product analytics) · Cloudflare Analytics Engine + RUM (high-volume events) · OTel (traces/metrics/logs).
- **AI.** Every model call through AI Gateway. Provider tiers: CF/edge model → DeepSeek (volume) →
  Anthropic/OpenAI/Gemini (premium/vision). Promptfoo for evals. AI is permanent + foundational, never optional.
- **Quality gates (build-breaking).** Zod at every boundary · every post-launch feature behind a typed flag
  (`enabled=0, rollout=0, stage=experimental`) + `libs/features/<slug>/manifest.ts` · Playwright E2E from
  homepage 6bp · axe 0 · Lighthouse ≥95 a11y / ≥75 perf · LCP ≤2.0s / INP ≤200ms / CLS ≤0.05 ·
  JSON-LD per route (accurate only) · CSP L3 + Trusted Types · no stubs/TODO in shipped strings.
- **Removed — never reintroduce:** Novu (→ psnotify) · Resend/Postmark (→ SES + Listmonk) · Supabase ·
  Lago/OpenMeter/Metronome (→ Stripe Meter Events) · Unkey (→ native `api_tokens`) · Nango (→ native MCP OAuth) ·
  Inngest/Trigger.dev (→ CF Workflows/Queues + Hatchet) · Postiz (→ native social) · Firecrawl/Crawlee (→ Deepcrawl) ·
  **Tinybird / ClickHouse** (→ CF Analytics Engine + RUM + D1 + PostHog) · **AI Visual Site Builder (Puck + React Flow / GrapesJS)**
  (killed — bolt.diy editor is the only visual-edit surface) · **owner-facing post-generation SEO-editor journey**
  (killed — generation-side SEO build-validators STAY) · Astro/Nitro/MJML · Skyvern-as-product (internal-only).
  CI gates block some of these. (Last three: Brian directive 2026-10-07, fire-302+.)

---

## What to build — AI-implementable backlog (autonomous, by priority)

> Each is a requirement the AI **can and should** implement without a human decision. Ship behind a
> dark flag, TDD-first, verify (typecheck + tests + prod-E2E), then flag-enable. Detail in `_LOOP_LEDGER.md`.

### P0 — security / margin (before any feature)
- AI-Gateway routing + per-business research cache are live; remaining: swap GPT-4o vision → Workers-AI
  llama-4-scout where quality is adequate (per-callsite judgment — low-stakes only, keep gpt-4o for critique).

### Tier 1 — revenue engine
- **Money-trust** (mostly shipped): idempotency middleware, Sentry on critical paths ✅. Remaining core wiring
  is flag-enablement + frontend surfaces (see Needs-Brian for the container/infra-gated pieces).
- **Quality moat**: per-build quality scoring (vision + Lighthouse + SEO, regression-tracked); section auto-reroll
  <8/10; axe + AI alt-text pre-publish — cores exist; the container/vision-gated wiring is Brian-gated below.

### Lead Scanner (Brian directive — engine LIVE)
- Automatic US-wide "businesses-without-website" engine: propensity scoring, OSM/Places/SoS discovery, email +
  address deliverability gates, pipeline stage-machine, channel router + drip, coverage/funnel aggregation,
  suppression/compliance — **all core services shipped**; Twenty CRM sink LIVE. Remaining: optional cron geo-sweep
  for unattended automation + scan-profile persistence/CRUD + /admin controller widget.

### Deepcrawl integration (10 specced services, all flag-gated experimental)
- Competitor-research automation (Phase -1) · post-deploy SEO audit gate · source-site deep-crawl (replace scraper,
  30-day parallel run) · agent-ready site-context MCP + per-site `llms.txt` · competitor-monitor dashboard (paid,
  usage-metered) · broken-link/content-rot daily monitor · pre-flight research agent · content-inventory/IA generator ·
  bulk-migration validator · image discovery/augmentation. Each behind `deepcrawl_*` flag, `DEEPCRAWL_API_URL`-gated.

### Tier 2-4 (high → low value, buildable cores)
- **Owner analytics** (the phone/form IS the conversion): click-to-call/directions tracking, form completion/abandonment,
  section attribution, visitor funnel, shareable read-only dashboard, geo enrichment, CSV export ✅ — most shipped;
  remaining are naming/goals UI + Monday auto-summary (email-gated).
- **Viral surfaces**: "Built with" backlink + "Build your own" CTA ✅; snapshot permanent URLs + share-deploy loop (frontend).
- **SEO/JSON-LD**: category landing pages + `SoftwareApplication` schema, year-in-review, fleet benchmark — cores done, need route/frontend wiring.
- **Reliability**: traceId/tenantId correlation ✅; Jest→Vitest migration (kills `@swc/jest` flake) is a dedicated session.

### Monumental initiatives (1–3 dev-months each — scope as dedicated arcs, not loop passes)
1. Workers-for-Platforms CF-native full-stack hosting substrate → **Functions** (IN PROGRESS): the removed "AI Agents" dashboard feature is replaced by a code-defined `functions/` folder in the site (file-based routing, JS/TS, npm) hosted on WfP + dispatched at `{slug}.projectsites.dev/api/*`. Spec: ADR-0035 (folder) / ADR-0055 (DECISIONS.md); ledger: `apps/project-sites/docs/FUNCTIONS-CONVERGENCE.md`.
2. Public Developer API platform (native `api_tokens` + Scalar + Stainless SDKs).
3. Site Analytics Suite (CF Analytics Engine-first).
4. Instant preview environments.
- Plus Chatwoot support platform (5-phase roadmap) + the Integrations roadmap (Plane · Twenty · Listmonk · whole-app):
  each app gets a typed, Zod-validated, AGPL-isolated HTTP client + HMAC webhook receiver + rate-limit/retry/idempotency wrapper.

---

## Needs Brian — human decision gates (the AI can't pass these alone)

> The loop proposes + wires the buildable slice, but each needs a decision, a secret, or an irreversible
> business/infra call. It never blocks autonomous work — it advances a buildable item and surfaces the gate.

- **`E2E_TEST_PASSWORD` secret** (`wrangler secret put`) — smallest unblock, highest leverage: authed prod-E2E across the money path.
- **Pricing one-way doors** — free/Pro split, snapshot-retention tiers, AI-credit metering, 3rd-party app tier, Stripe usage-metering prices. Loop wires; Brian sets prices.
- **Container/Docker-gated build quality** — Lighthouse + axe + AI-vision logo/font/color extraction + quality auto-reroll run *inside the build container*; each needs a Docker-access session.
- **Conversion frontend + infra** — visitor auth-bypass build (pre-wall), inline Stripe checkout + claim flow, upgrade-moment cards, PostHog funnel wiring, build-streaming (SSE), outbox→DLQ→retry (enable CF Queues).
- **Custom-hostname paid lever** — CF-for-SaaS hostname provisioning + per-instance resource sizing/upsizing.
- **Notification vendor** — confirm `psnotify` (the ZERO-Novu rule) so the DO inbox+center+prefs engine gets built.
- **Guest-browsable admin (A19)** — which `/admin` sections/fields are safe to expose read-only to anonymous visitors (privacy call).
- **Operator-key activations** — flip built-dark modules once keys/WAF set: observability gateway, referral loop, lead-scanner outreach, CF Images, GBP OAuth, EU data-residency.
- **Case-study / showcase pages** — need the real org's consent + approved logo/copy (e.g. njsk.org).
- **Voice carrier polish** — STIR/SHAKEN attestation + number port-in (voice go-live itself is LIVE).
- **Enterprise auth** — self-host Better Auth OSS on CF Containers + SCIM.
- **Dedicated sessions** — frontend perf wave (~30h: zoneless CD, SSR/SSG shell, OnPush, `@defer`, INP<150ms, subscribe-leak fixes, bundle-split) · OpenFGA authz model.

---

## Where the detail lives

- **`apps/project-sites/_LOOP_LEDGER.md`** — the detailed AI task tracker (per-item specs + completion history).
- **`apps/project-sites/CLAUDE.md`** — worker API surface, services, bindings, build pipeline, gotchas.
- **`CLAUDE.md`** (root) — monorepo onboarding, stack, hard gates, deploy.
- **`DECISIONS.md`** — accepted ADRs (the "why" behind the constraints above).
- **`docs/ARCHITECTURE.md`** — as-deployed topology.
