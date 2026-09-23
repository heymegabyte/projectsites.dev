# System Services — Audit & Modernization Plan

> Phase 1 audit for the admin **System Services** section. Evidence-backed from the
> current code/config/bindings (authoritative), not docs. Started 2026-09-23.
> Owner: platform. Loop job `442bf8c6` (every 30m) drives implementation slices.

## TL;DR — reconciled reality (corrects the brief's premise)

The brief assumes System Services is a **stale screen showing outdated/mock data**. The
code says otherwise: the section is **already backed by a canonical typed registry and
live health endpoints**. The real gap is **depth of the operational control-plane
experience**, not data staleness. This is a *surface-and-deepen* job, not a rebuild — and
explicitly **not** a from-scratch registry (one exists; a competing abstraction would be
drift per `feature-module-architecture`).

Prior memory ("remove System Services, replace with a small Super-admin status widget")
was **never executed** — the full section still exists and is wired. Modernizing it is the
correct path; do not resurrect the removal plan.

## 1. Existing feature inventory (verified)

**Frontend (Angular admin, `apps/project-sites/frontend/src/app/pages/admin/`)**
- `sections/system-services.component.ts` (286 lines) — operator-only platform-service catalog.
- `navigation/admin-nav.model.ts:130` — nav entry `label: 'System Services'` (operator/super-admin scoped).
- `admin-section-labels.ts:39` + `admin-section-labels.spec.ts:22` — `'system-services' → 'System Services'`.
- `command-palette-actions.service.ts:168` — Cmd+K action `nav-system-services`.
- `sections/system-services.component.spec.ts` — existing spec (loads platform catalog).

**Backend (Worker, `apps/project-sites/src/`)**
- `platform/service-registry.ts` (530 lines) — **canonical typed registry**. Exports:
  `ServiceStatus`, `ServiceRuntime`, `ServiceCategory`, `ServiceAccess` unions;
  `ServiceRegistryEntry` interface; `SERVICE_REGISTRY` (~30 entries); `EXCLUDED_VENDORS`;
  `getService(id)`; `validateServiceRegistry()` + `RegistryViolation`.
  Categories present: edge, workflow, jobs, observability, data, billing, ai, browser,
  email, webhooks, authz, security, auth, internal, docs.
- `services/service_status.ts` (252 lines) + `__tests__/service_status.test.ts` — health/status logic.
- `routes/super_admin.ts` (registered `index.ts:947`, `requireSuperAdmin` guard) — serves
  `GET /api/super-admin/services` (the catalog the component reads) alongside cost-factors,
  wallets, stats, ops/sites, ops/users, credit-monitor.
- `GET /api/integrations/health` — live per-integration health (component's second source).
- Public `/status` HTML page (`index.ts:1114`) + `GET /health/deep` JSON (`checks: {d1,kv,r2,ai,…}`), auto-refresh 30s.
- `data/apps-catalog.ts` (684 lines, 38 entries, each with an `InfraDep`) — per-app infra dependency map.

## 2. Current data sources (verified)

| Surface | Source | Live? |
|---|---|---|
| Admin catalog list | `GET /api/super-admin/services` | Live (registry-derived, super-admin gated, 403 to non-operators) |
| Admin per-integration health | `GET /api/integrations/health` | Live |
| Public status page | `GET /health/deep` (d1/kv/r2/ai) | Live, real dependency pings |
| Registry entry `status` field | static literal in `service-registry.ts` | **Declared** (lifecycle), NOT live health |

**Verified CF bindings (production env, `wrangler.toml`):** D1 `DB` · KV `CACHE_KV` +
`PROMPT_STORE` · R2 `SITES_BUCKET` · AI `AI` · Browser `BROWSER` · Vectorize `RAG_INDEX` ·
Analytics Engine `ANALYTICS` · Workflows `SITE_WORKFLOW`, `SOCIAL_PUBLISH_WORKFLOW`,
`DRIVE_SYNC_WORKFLOW`, `IMAGE_GENERATION_WORKFLOW`, `SNAPSHOT_QUALITY_WORKFLOW` · Dispatch
`USER_DISPATCH` (Workers-for-Platforms) · DO `SITE_BUILDER` · observability logs+traces on.

## 3. Stale or misleading information (to verify in implementation fire)

- **Declared-vs-live status conflation — VERIFIED NOT PRESENT (2026-09-23).** The catalog UI
  keeps the two separate: the badge renders the literal declared lifecycle word
  (`{{ s.status }}` → "production"/"scaffolded"/… via `badgeClass`), NOT a health colour; a
  SEPARATE live-health pill (`service-health-<id>`) renders ONLY for services with a real probe
  in `GET /api/integrations/health` (`system-services.component.ts:118-131`; `LiveHealth` type
  line 27; comment lines 34-36). The Super-admin Service Status widget core
  (`services/service_status.ts`) is likewise honest — no probe data → `unknown`, and `unknown`
  outranks `operational` so a partial-data fleet never reports "all operational". No lying-green.
- **Health coverage gap.** `/health/deep` only pings d1/kv/r2/ai. Workflows, Queues,
  Browser, Vectorize, Dispatch, Analytics Engine, and external vendors (Stripe, SES,
  PostHog, Sentry, Tinybird…) have **no live check** → must show **Unknown + why + last
  evidence**, not a green "UP".
- **Registry↔binding drift.** Confirm every `wrangler.toml` binding has a registry entry
  and vice-versa (a binding with no entry = invisible; an entry with no binding = phantom).
- **apps-catalog vs service-registry** — two "catalog" concepts; confirm they don't
  duplicate/contradict (consolidate `InfraDep` refs to registry ids if they drift).

## 4. Missing service categories / entries (candidate — verify against registry contents)

Bindings/vendors that may lack a registry entry or a live health strategy: Queues,
Analytics Engine (`ANALYTICS`), Vectorize (`RAG_INDEX`), Browser Rendering, each Workflow,
Workers-for-Platforms dispatch (`USER_DISPATCH`), Durable Objects (`SITE_BUILDER`), Turnstile,
DNS/Domains/Certificates, Email Routing. Cross-check `SERVICE_REGISTRY` ids against §2 bindings.

## 5. Missing operational capabilities (the real work — per brief Phase 3)

Current component ≈ catalog list + live health dots. Absent, to build (registry-powered):
1. **System overview** — KPI summary cards (overall health, active/degraded, config issues,
   incidents, pending migrations, usage/cost alerts, needs-attention, last refresh) + plain-language line.
2. **Catalog filters/sort** — category/provider/env/status/criticality/scope/config-state; search; table+card views.
3. **Detail drawer** — purpose, why-used, config state (masked), deps+dependents, bound
   resources, region, version, recent activity, usage, cost, limits, errors, health history, docs, safe actions.
4. **Trustworthy health model** — Operational/Degraded/Partial/Outage/Maintenance/Unknown/Not-configured/Disabled, from real signals only.
5. **Dependency view** — accessible list/table (graph optional) from the SAME registry (no hardcoded map); upstream+downstream; blast radius.
6. **Configuration diagnostics** — missing vars/bindings, expiring creds, disabled-required, prod→dev pointers, missing observability/rate-limits, failed migrations (server-computed; never ship secret contents to client).
7. **Usage/limits/cost** — where reliable (AI usage/credits/ledger via wallet+credit-monitor; label Exact/Estimated/Delayed/Unavailable; centralize pricing metadata).
8. **Environments & scope** — Platform/Account/Project/Site/Env/Region badges; prevent reading a platform service as a project resource.
9. **Safe actions** — test-connection/refresh/view-logs/open-console/docs; confirm+audit on any mutation; no fake buttons.

## 6. Security concerns

- **Super-admin gating is correct** (`requireSuperAdmin`, `is_super_admin` column + allowlist,
  403/404 to non-operators). Every new route/action inherits it; return **404** when a feature flag is off (not 403).
- **Never ship secrets** — registry/detail responses expose config **state** (Configured/Missing/
  Invalid/Expiring/Unverified/Inherited/Managed-externally) and secret **names** only; values fully masked; validation is server-side only.
- **Audit every mutating action**; idempotency-key disruptive actions; never claim success pre-backend-confirm.
- New UI behind a feature flag (`system_services_control_plane`, `enabled=0`) per `feature-flags`.

## 7. Recommended information architecture

Keep the **System Services** label. Single route, tabbed/sectioned control plane:
`Overview` · `Catalog` (default) · `Dependencies` · `Diagnostics` · `Usage & Cost`, with a
per-service **detail drawer** (`DialogShellComponent`). Restorable filter/tab state via query
params. Design system: Spartan UI + `_polish.scss` `--ps-*` tokens; non-color-only status; skeletons; actionable errors; freshness timestamps.

## 8. Migration plan (extend, don't rebuild — one slice per loop fire)

1. **Registry as single source of truth.** Extend `ServiceRegistryEntry` only as needed
   (health-strategy, scope, criticality, dependency ids, management-URL strategy, usage
   strategy, feature flag) with Zod + discriminated unions; `validateServiceRegistry()`
   fails the build on missing required metadata. Reconcile registry ↔ bindings ↔ apps-catalog.
2. **Server: enrich `GET /api/super-admin/services`** to return registry + merged live
   health + config-state + scope (no secret values). Add a health-strategy resolver that
   returns **Unknown** for anything without a real probe. Keep `/integrations/health` as one input.
3. **Frontend: shell + Overview + Catalog filters** (TDD: failing Playwright spec first).
4. **Detail drawer** (deps/config-state/usage/actions).
5. **Diagnostics** (server-computed config problems).
6. **Dependencies view** + **Usage & Cost** (AI/credits/ledger).
7. **Safe actions** (test-connection/refresh), audited, idempotent.

Each slice: failing spec → implement → `--env production` deploy → prod-verify by bundle
hash → screenshot. Feature-flag dark until code-complete.

## 9. Acceptance criteria

- [ ] Registry is the sole source; no hardcoded UI service list; `validateServiceRegistry()` green.
- [ ] Every prod `wrangler.toml` binding maps to a registry entry (and vice-versa) — drift test.
- [ ] No service shows a green/UP status without a real live signal; unprobed → **Unknown + reason + last evidence**.
- [ ] Overview KPIs, catalog filters/search/sort, detail drawer, diagnostics, dependency list, usage/cost all render from the registry.
- [ ] Zero secret values in any client payload; config-state only; secret names masked; super-admin gated (404 when flag off).
- [ ] Mutating actions confirm + audit + idempotent + real backend confirmation; no fake buttons.
- [ ] axe 0 violations @ 6 breakpoints; keyboard + screen-reader usable; skeleton/empty/partial/error states distinct.
- [ ] Playwright specs (homepage-start, super-admin session) green on prod for each capability.

## 10. Open items needing the implementation fire (not yet verified)

- Full contents of `service-registry.ts` (exact fields on `ServiceRegistryEntry`; which entries exist).
- Exact shape of `GET /api/super-admin/services` + `/api/integrations/health` responses.
- What the current 286-line component renders vs. the gaps above.
- Whether `apps-catalog.ts` `InfraDep` ids reference registry ids (consolidation check).

> These are deferred to the first implementation fire (blocked this fire: Agent delegation
> unavailable while the auto-mode Opus safety-classifier was temporarily down). Read them via
> a fresh `Explore` agent (≤150-line cap) — never wholesale in the orchestrator thread.
