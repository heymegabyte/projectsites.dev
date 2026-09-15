# prompt_schedule — Prompt Scheduler

Time-windowed activation of a prompt-registry **variant** for a prompt **key**. An owner (or
admin) schedules a variant to be active between `activate_at` and `deactivate_at`; the
generation pipeline consults `getActiveVariant(key, now)` at prompt-resolve time and uses the
scheduled variant when a window is live. **Read-time evaluation — no cron.**

Use case: seasonal / campaign prompts with zero owner config — e.g. "use the holiday hero
prompt Dec 1–26", then automatically revert. Embarrassingly-easy: the owner schedules once; the
AI switches the prompt itself.

## Flag

`prompt_schedule` — `enabled=0, rollout_percent=0, stage='experimental'` (seed migration
`0633_prompt_schedules.sql`). Server guard returns **404** (never 403) when off. **Safe disabled
behavior:** no schedule rows are read; prompt resolution falls back to the default variant
exactly as today.

## API (all flag-gated → 404 dark, org-scoped, Zod-validated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/prompt-schedules` | Create a schedule (`prompt_key`, `variant`, `activate_at`, `deactivate_at?`, `label?`) → 201 |
| GET | `/api/prompt-schedules` | List the caller's org + global schedules (newest window first) |
| GET | `/api/prompt-schedules/active?key=X` | The variant currently active for `key` (or `null`) |
| DELETE | `/api/prompt-schedules/:id` | Soft-delete (org-scoped — IDOR-safe) |

## Resolution semantics (`resolveActiveSchedule`, pure + unit-tested)

- Half-open window `[activate_at, deactivate_at)`; `deactivate_at = null` → open-ended.
- On overlap, the **most-recently-activated** window wins (a later campaign beats an earlier baseline).
- Unparseable dates are skipped; never throws; `null` → caller uses the default variant.

## Consumption (integration point)

The generation pipeline calls `getActiveVariant(env, orgId, key, Date.now())` at prompt-resolve
time and uses the returned variant when non-null. Wired on flag promotion so an experimental,
dark feature never alters live prompt resolution.

## Data

`prompt_schedules` (migration `0633`): `id, org_id (NULL=global), prompt_key, variant,
activate_at, deactivate_at, label, created_at, deleted_at`. Indexed on `(prompt_key, activate_at)`
and `org_id`.

## Removal

Drop the `/api/prompt-schedules` routes + the `prompt_schedules` table. No effect on default
prompt resolution (`getActiveVariant` is only consulted when the flag is on).
