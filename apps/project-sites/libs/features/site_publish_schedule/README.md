# Scheduled Site Publishing (`scheduled_publish`)

Schedule a **built** site to go live at a future datetime — a campaign launch, grand opening,
or product drop with zero babysitting. The owner sets a date; the AI flips the site live.

## Flag

`scheduled_publish` — `enabled=0, rollout_percent=0, stage='experimental'` (dark). Server guard
returns **404** when off (never 403). Migration `0634_site_publish_schedules.sql`.

## API (auth + flag gated, org-scoped)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/sites/:id/publish-schedule` | Schedule/reschedule this site's go-live (`{ publish_at, label? }`). Supersedes any prior pending schedule. |
| GET | `/api/sites/:id/publish-schedule` | List this site's schedules (newest first). |
| DELETE | `/api/sites/:id/publish-schedule` | Cancel the pending schedule for this site. |

- `publish_at` must be a future ISO-8601 datetime (past/now → 400).
- The site must belong to the caller's org (else 404) **and** be built (`current_build_version`
  set) — an unbuilt site → **409** (`This site has not finished building yet…`), per
  `action-button-must-gate-on-server-precondition`.

## How it fires (no owner action)

The every-minute cron (`scheduled()` handler, **Stage 6.2**) calls
`fireDuePublishSchedules(env, Date.now())`: it reads pending rows with `publish_at <= now`,
flips each eligible site to `status='published'`, and marks the row `fired`. A site that lost
its build is marked `skipped` (a blank page is never served). Per-schedule fail-soft — one bad
row never blocks the sweep.

- The pure core `resolveDueSchedules(rows, nowMs)` (same inputs → same output) is what the unit
  tests pin; the clock is injected, never read inside.
- KV host-resolution cache (60s TTL) means the live site appears within ~1 minute of `publish_at`.

## Off path

Flag off → the three routes 404 **and** the cron sweep finds no rows to fire → publishing
behavior is exactly as today (build → publish, immediate). Nothing to roll back.

## Files

`schemas.ts` (Zod boundary) · `service.ts` (pure resolver + CRUD + `fireDuePublishSchedules`) ·
`handlers.ts` (Hono routes) · `feature.manifest.ts` · `__tests__/` · `migrations/0634_*.sql`.
