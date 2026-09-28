# psnotify — Notification Inbox (Durable Object, first slice)

The in-app notification center backbone. A SQLite-backed Durable Object
(`PsNotifyDO`), one instance **per user**, stores notifications and powers the
authed `/api/notifications` list + mark-read endpoints. `notifyUser(...)` writes
into it. **Zero D1 tables** — all state lives in the DO.

- **Flag:** `psnotify` (`enabled=0, rollout=0, stage=experimental`). Server 404s when off.
- **Binding:** `PSNOTIFY_DO` (Durable Object namespace, `wrangler.toml`).
- **Migration:** `[[env.production.migrations]]` tag `v_psnotify_do`, `new_sqlite_classes = ["PsNotifyDO"]`.

## DO API (`libs/features/psnotify/do.ts`)

Resolve per-user: `const inbox = env.PSNOTIFY_DO.getByName(userId)`.

| Method | Behaviour |
|---|---|
| `add({ type, title, body?, action_url? })` | INSERT one row (`id`=UUIDv7, `read_at`=null). Returns the stored `Notification`. |
| `list({ unreadOnly?, limit? })` | Newest-first inbox (`limit` clamped 1..200) + the global `unread` count. |
| `markRead(id)` | Idempotent — stamps `read_at`; returns `true` only when an unread row changed. |

Also reachable over the stub via `fetch()`: `POST /add`, `GET /list?unreadOnly&limit`, `POST /read {id}`.

## HTTP surface (`handlers.ts`, mounted in `src/index.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/notifications?unreadOnly&limit` | The caller's OWN inbox + unread count |
| POST | `/api/notifications/:id/read` | Mark one of the caller's notifications read |

**Caller-scoping** is structural (the psnotify analogue of `assertSiteOwned`):
the inbox is resolved with `getByName(userId)` from the **authed session** — the
id is never taken from the request — so a user can only ever reach THEIR inbox.
Off → 404 (never 403). Binding absent (pre-migration) → fail-soft to an empty
inbox, never a 500.

## `notifyUser` wiring (`src/services/psnotify.ts`)

`triggerPsnotify(env, event)` (called by `notifyUser` / `notifyEvent` in
`src/services/notify.ts`) now writes to the DO via `getByName(subscriberId)`.
The exported signature is unchanged, so every existing caller keeps working. If
`PSNOTIFY_DO` is unbound (pre-deploy) it logs + returns `{ success: true }` so
`ctx.waitUntil(notifyUser(...))` fire-and-forget callers are never broken.

## Disabled behaviour

Flag off → both endpoints 404. `notifyUser` still returns ok (the write is a
no-op when the flag/binding is absent) so nothing that fires a notification breaks.

## Not in this slice (follow-on)

- Email / push fan-out adapters (SES / web-push).
- Unifying the existing bell feed (`notif-bell`) onto this DO.
- Preferences + per-channel routing.

## Tests

- `__tests__/psnotify_do.test.ts` — `add → list → markRead` against a real
  in-memory `node:sqlite`, plus the `fetch()` router + strict-schema rejection.

## Deploy

The new SQLite DO class needs a real migration deploy:

```bash
cd apps/project-sites && npx wrangler deploy --env production   # applies v_psnotify_do
```
