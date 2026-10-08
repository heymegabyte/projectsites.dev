# site_functions — Functions panel (Resources sub-tab #5)

Read-only discovery endpoint for the Resources-screen **Functions panel** (beside
Media / Files / Buckets / Automations). Lists a site's **code-defined Functions**
on Workers-for-Platforms so the owner can see what's deployed + its status.

## Doctrine (ADR-0035, `docs/FUNCTIONS-CONVERGENCE.md`)

Functions are **code-defined** — owners author a `functions/` folder in the editor,
NOT a dashboard form. So this is a **READ/MANAGE VIEW**, never an authoring form.

## What it does

- `GET /api/sites/:siteId/functions` → `{ data: SiteFunction[], functionsDeployed, wfpConfigured }`
- `data` entries are **real, persisted** — two honest kinds:
  - `http` — the site's bundled `functions/` worker deployed on WfP (one deployment
    unit). Surfaces the WfP script name + real deploy status + bundle size (from the
    R2 last-good bundle). We do **not** fabricate a per-route list — that manifest
    isn't persisted server-side (mirrors the honest `backend_inventory` stance).
  - `scheduled` — one row per cron declared in `functions/_scheduled.*`
    (`site_functions_schedules`; WfP has no native cron → platform cron dispatcher).

## Real data sources (not a stub)

1. `sites.functions_deployed_at` (D1) — authoritative deploy signal (`siteHasDeployedFunctions`).
2. R2 last-good bundle (`readFunctionsBundle`) — the deployed code; its byte size.
3. `site_functions_schedules` (D1) — the site's real declared crons.

Honest-empty (`data: []`) when the site has **no** deployed functions worker **and**
no cron schedules — per `verify-against-source-of-truth`.

## Flag

- Key: `site_functions` (registry + docs + manifest), `default_enabled: false`, `stage: experimental`.
- Off (default, DARK): the route 404s for everyone and the panel self-hides.

## Gate order (per request)

1. `isFlagOn(env, 'site_functions')` → **404** when off (never 403 — existence never leaked).
2. `c.get('orgId')` → **401** when unauthenticated.
3. `assertSiteOwned(env, orgId, siteId)` → **404** cross-org / missing (IDOR guard).
4. `listSiteFunctions(env, siteId)` → **200** with the UI-shaped payload.

## Files

- `schemas.ts` — Zod `SiteFunction` + `ListFunctionsResponse` (SSOT contract).
- `service.ts` — `listSiteFunctions()` reads the 3 real signals, site-scoped.
- `handlers.ts` — the Hono sub-app (`siteFunctions`), mounted in `src/index.ts`.
- `feature.manifest.ts` — feature-module manifest (drift gate).

## Tests

- `src/__tests__/site_functions_route.test.ts` — flag-off 404, 401, cross-org 404
  (IDOR), owned 200 with the real HTTP + scheduled rows, honest-empty when no functions.

## Removal

Delete this module, the `siteFunctions` import + `app.route()` mount in `src/index.ts`,
the `site_functions` entries in `registry.ts` + `docs.ts`, and the editor wiring
(`ResourcesPanel.tsx` + `FunctionsPanel.tsx` + the `PS_RES_FUNCTIONS` bridge in
`embedded-mode.ts` + `bolt-embed.service.ts`). No owned D1 tables or migrations
(reads existing `sites` + `site_functions_schedules`).
