# scan_profiles

D1-persisted CRUD for the lead scanner's editable **"what to hunt"** config (SCOPE.md:68).
The lead-scanner *engine* (discovery → enrich → score → CRM sink) already shipped; this adds
the persistence layer + a typed API surface so an operator tunes the automatic scanner from
the admin UI instead of editing code.

- **Flag:** `scan_profiles` (`enabled=0, rollout=0, stage=experimental` — dark by default)
- **Routes:** `GET/POST /api/admin/scan-profiles`, `PATCH/DELETE /api/admin/scan-profiles/:id`
- **Guards (in order):** auth `401` → `isFlagOn('scan_profiles')` `404` (never 403 — never leak
  existence) → super-admin `403` → Zod `safeParse` `400`
- **Tenancy:** the lead scanner is a platform-operator surface, so the boundary is the ORG on
  the profile row (`org_id`), not a site. Every list/get/update/delete is org-scoped in SQL.
- **Deletion:** soft (`deleted_at`) — a row is never physically removed, so an undo stays possible.

## The model

A profile is `ScanProfileConfig` (`src/services/scan_profiles.ts` — the Zod SSOT):
geo `bboxes`, OSM/Places `categories`, `providers`, free-text `filters` (the editable verbiage),
`source` provenance, `maxLeadsPerRun` cost guard, `intervalMinutes` cadence, `lastRunAt`.

`isProfileDue` / `listDueProfiles` / `profileToRunSpecs` are the pure cores the cron geo-sweep
uses: it reads the due profiles and expands each bbox into one `lead_scan_orchestrator` run.

Defaults keep it safe: `enabled=false`, `intervalMinutes=0` (manual-only) — a profile cannot
auto-run until an operator explicitly turns it on AND sets a cadence.

## Disabled behavior

Flag off → every route 404s. The existing ad-hoc scan routes (`POST /api/admin/leads/scan`,
`/scan-osm`, gated by the separate `lead_scanner` flag) keep working unchanged, so nothing regresses.

## Files

- `src/routes/scan_profiles.ts` — the 4 handlers + the shared gate chain
- `src/services/scan_profile_store.ts` — D1 row ⇄ `ScanProfileConfig` mapping + CRUD
- `src/services/scan_profiles.ts` — the pure contract (schema + due/run-spec logic)
- `src/lib/uuid.ts` — `uuidv7()` for the record id (timestamp-sortable)
- `migrations/0638_scan_profiles.sql` — `CREATE TABLE IF NOT EXISTS` + the flag seed row
- `src/__tests__/scan_profiles_routes.test.ts` — handler coverage (401/404/403/400/200/201)
- `src/__tests__/scan_profiles.test.ts` — the pure core (due logic, run-spec expansion)

## Removal

Delete `src/routes/scan_profiles.ts` (+ its `app.route` mount in `src/index.ts`),
`src/services/scan_profile_store.ts`, this flag, and the seed row. The `scan_profiles` table is
additive and read by nothing else; drop it only after confirming the cron no longer reads it.
