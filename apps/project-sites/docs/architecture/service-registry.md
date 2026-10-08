# Service Registry

Single source of truth for every system ProjectSites.dev runs or depends on
(convergence §13). The **typed registry** is `src/platform/service-registry.ts`
(`SERVICE_REGISTRY` + `validateServiceRegistry()`); this doc is the human-readable
companion + the rules that keep it honest.

## How it works

- Each entry is a typed `ServiceRegistryEntry`: `id`, `name`, `category`, `runtime`,
  owner/adapter package, feature flag, admin/public surface, datastore, secrets
  namespace, `status`, `access`, notes.
- `status` reflects reality, not aspiration: `production` (live + load-bearing),
  `integrated`, `scaffolded` (code present, gated/inert), `planned` (decided, unbuilt),
  `deprecated` (migrating out), `removed`.
- Update the registry in the SAME change that adds, renames, migrates, launches, or
  removes a service (drift-detection).

## Enforcement

- **`src/__tests__/service_registry.test.ts`** locks integrity: unique ids, valid
  status enum, and that any entry naming a §4-excluded vendor is `deprecated`/`removed`
  (a forbidden vendor can never be blessed as a live dependency).
- **`scripts/check-architecture-fitness.mjs`** (`npm run check:fitness`) scans
  `src/`+`libs/` for excluded-vendor references (§15), classifying each as a tracked,
  ADR-documented migration (non-blocking) or a hard VIOLATION (`--ci` exits 1). It
  complements `architecture_fitness.test.ts` (which hard-fails on the
  Polar/Trigger.dev/Fly-Hatchet/Vercel/Supabase/AWS zero-set).

## Current state (2026-06-20)

| id | name | runtime | status |
|---|---|---|---|
| edge-api | Hono/Workers API gateway | cloudflare-worker | production |
| site-serving | Generated site serving (R2 static-first) | cloudflare-worker | production |
| site-generation-workflow | AI site generation | cloudflare-workflow | production |
| jobs-inngest | Self-hosted Inngest (§13 plane) | cloudflare-container | scaffolded |
| event-dispatcher | Unified Analytics ingestion (Plane H) | cloudflare-container | scaffolded |
| data-d1 | D1 platform metadata | cloudflare-managed | production |
| storage-r2 | R2 bundles/assets/artifacts | cloudflare-managed | production |
| analytics-engine | High-volume events | cloudflare-managed | production |
| billing-stripe | Stripe (only billing rail) | managed-saas | production |
| ai-gateway | AI Gateway + LiteLLM | cloudflare-managed | integrated |
| traces-langfuse | Langfuse (CF-container, v2; Tinybird removed) | cloudflare-container | planned |
| browser-gateway | Browser Run + Stagehand | cloudflare-managed | production |
| observability-sentry | Sentry | managed-saas | production |
| observability-posthog | PostHog (product/admin only) | managed-saas | production |
| notifications-novu | Novu | managed-saas | integrated |
| email-ses | Amazon SES (transactional) | managed-saas | planned |
| email-listmonk | Listmonk (campaigns) | cloudflare-container | planned |
| email-resend | Resend (LEGACY → SES, ADR-0019) | managed-saas | deprecated |
| claim-links-dub | Dub (claimyour.site) | managed-saas | production |

Generated from `SERVICE_REGISTRY` — when they drift, the typed file wins; update this
table to match.
