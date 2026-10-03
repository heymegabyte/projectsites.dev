# site_automations — Automations panel (RES-AUTO slice 1)

Read-only discovery endpoint for the Resources-screen **Automations panel**. Lists a
site's workflow/automation instances so the owner can see what ran, when, and whether
it succeeded.

## What it does

- `GET /api/sites/:siteId/automations` → `{ data: Automation[] }`
- Each item: `{ id, type, status, created_at, finished_at }`, sourced 1:1 from the
  `workflow_jobs` D1 table (newest first, capped at 200).
- Discovery only — **no writes** in this slice.

## Flag

- Key: `site_automations` (registry + docs), `default_enabled: false`, `stage: experimental`.
- Off (default, DARK): the route 404s for everyone and the panel self-hides.

## Gate order (per request)

1. `isFlagOn(env, 'site_automations')` → **404** when off (never 403 — existence never leaked).
2. `c.get('orgId')` → **401** when unauthenticated.
3. `assertSiteOwned(env, orgId, siteId)` → **404** cross-org / missing (IDOR guard).
4. `listSiteAutomations(env, siteId)` → **200** with the UI-shaped list.

## Display reconciles with the store

Real `workflow_jobs` rows map 1:1 to list items; a site with no jobs returns an honest
empty array (`{ data: [] }`), never an error — per `verify-against-source-of-truth`.

## Files

- `schemas.ts` — Zod `Automation` + `ListAutomationsResponse` (SSOT contract).
- `service.ts` — `listSiteAutomations()` reads `workflow_jobs` via `dbQuery`, site-scoped.
- `handlers.ts` — the Hono sub-app (`siteAutomations`), mounted in `src/index.ts`.
- `feature.manifest.ts` — feature-module manifest (drift gate).

## Tests

- `src/__tests__/site_automations_route.test.ts` — flag-off 404, 401, cross-org 404 (IDOR),
  owned 200 with UI-shaped rows, honest-empty `[]`.

## Removal

Delete this module, the `siteAutomations` import + `app.route()` mount in `src/index.ts`,
and the `site_automations` entries in `registry.ts` + `docs.ts`. No owned D1 tables or
migrations (reads the existing `workflow_jobs` table).
