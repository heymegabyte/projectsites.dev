# Discovery — notifications / psnotify (Lane 10) audit (loop fire, 2026-09-29)

> Read-only audit of the notification system. Feeds `_RUN_THE_LOOP.md` §4.5 + Lane 10.
> **Headline: TWO parallel notification backends coexist with a producer↔consumer mismatch** —
> `notifyUser()` writes the psnotify DO (DARK), but the frontend bell reads the LIVE legacy D1
> `notifications` table. Worker-fired notifications never reach the bell.
>
> (This fire also shipped, Lane 9: cf-native container-metadata gating on the app catalog +
> editor Data Rev 7 AI-Explain — see the fire report.)

## Findings + next-wave tasks

1. **[NOTIF · ARCH · blocked-design] Producer↔consumer mismatch.** `notifyUser()` (`src/services/notify.ts` / `psnotify.ts:79 triggerPsnotify`) writes the psnotify DO; the bell reads the legacy D1 `notifications` table (`libs/features/notifications/handlers.ts`). Worker-fired notifs never show in the bell. Action (needs a design call): UNIFY — either write both, or decommission D1 + port the bell to the psnotify schema + promote the flag. >2h + architecture decision.
2. **[BELL · SCHEMA · READY] Response-shape drift.** `notification-bell.component.ts:377,397` expects `{data, unread_count}`; psnotify `ListResponseSchema` returns `{notifications, unread}`. Standardize psnotify's response to `{data, unread_count}` (or conditionally unpack in the bell when the flag is on). <2h rename.
3. **[BELL · READY] `POST /api/notifications/read-all` missing in psnotify.** The bell calls it (`:426`); the D1 backend has it, the psnotify DO has only `markRead(id)`. Add a `read-all` handler + a DO batch method. <2h.
4. **[TYPE · READY] Notification types unbounded.** `notifyUser()` accepts any `workflowId`; the psnotify `type` is `z.string().max(64)` (no enum) — no canonical event registry. Enumerate + doc the types (site lifecycle / domain-DNS / billing / build-progress / security) + a Zod enum. <2h.
5. **[PREFS · blocked-design] Server-persisted prefs absent.** `notification_prefs.test.ts` specs `GET/POST /api/admin/notifications` but there's NO implementation — prefs are localStorage-only, `routeNotification`/`resolvePrefs` declared not enforced. Needs a scope decision (org/user/global) before building.
6. **[FANOUT · deferred] Email(SES)/web-push adapters absent** — the manifest intentionally defers them; the DO inbox is in-app only. Queue as a separate module; no action this wave.

## Sub-area NOT reached (rotate next fire)
- Notification-feed unification (merge legacy `activity_feed` into the DO for history) · email templates · delivery-SLO observability.
