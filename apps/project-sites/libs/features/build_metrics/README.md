# Build Metrics (`build_metrics`)

North-star **generation speed + cost** instrument. One `build_metrics` D1 row per
site-generation workflow run, surfaced as a super-admin trend card.

- **North star:** `<5min` time-to-live-site, `≤$1` per build.
- **Flag:** `build_metrics` — `enabled=0, rollout_percent=0, stage='experimental'` (DARK).

## Surfaces

- **Read API** — `GET /api/admin/build-metrics/summary?days=1..365` (default 30).
  Super-admin gated (401 → 403) AND flag-gated (`build_metrics` OFF → **404**, never
  403 — don't leak existence). Returns p50/p95 `wall_ms` + p50/p95 `est_cost_usd` +
  per-phase p50 + a last-30 chronological series. Impl:
  `src/routes/admin_build_metrics.ts`.
- **Recording** — always-on + fire-and-forget (a metrics failure NEVER blocks or
  fails a build). `initBuildMetrics` / `markBuildPhase` / `finalizeBuildMetrics` /
  `ingestContainerBuildUsage` in `src/services/build_metrics.ts`, called from
  `src/workflows/site-generation.ts` + the `/api/internal/build-status` callback.
  Cost math: `src/services/build_pricing.ts`.
- **Card** — `frontend/.../dashboard/generation-metrics-card.component.ts`, mounted
  behind the dashboard's `isSysAdmin()` gate; self-hides on any fetch failure.

## Data

- Migration `migrations/0652_build_metrics.sql` (additive, idempotent `CREATE TABLE
  IF NOT EXISTS`). Columns: `build_id` (PK, the Workflow instance id), `site_id`,
  `org_id`, `started_at`, `published_at`, `total_ms`, `phase_ms` (JSON), token
  counters, `model_calls` (JSON), `est_cost_usd`, `container_ms`, `outcome`.
- Lives in the **master** D1 (platform telemetry), not a per-site D1.

## Safe disabled behavior

Flag OFF (default): the read endpoint 404s for everyone (the gate runs before the DB
read), the card self-hides, and recording keeps running harmlessly (rows accrue for
when the card is turned on). No build is ever affected.

## Tests

- Worker: `src/__tests__/admin_build_metrics_route.test.ts` (route guards + flag gate
  + real-SQLite aggregation), `src/services/__tests__/build_metrics.test.ts`.
- E2E: `e2e/build-metrics.e2e.ts` (prod — card visibility + endpoint contract).
- Frontend unit: `.../dashboard/generation-metrics-card.component.spec.ts`.
