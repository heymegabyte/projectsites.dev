# Notifications + email + webhooks — scan + recommendations

Scan date 2026-09-28. Dimension: notifications + email + webhooks + comms.

## Current triggers + channels + UX

**Architecture (the load-bearing gap).** psnotify is doctrine ("DO-based unified
notification center, replaces Novu") but `src/services/psnotify.ts` is a **STUB** —
`triggerPsnotify` only `console.warn`s + returns `{success:true}`. There is NO
`libs/features/psnotify/` DO. So `notifyUser` (`src/services/notify.ts`) routes
**email-only** via SES; the "in-app bell + push channels" the JSDoc promises don't
actually fire from the worker. The frontend bell reads a SEPARATE `/api/admin/notifications`
feed (`activity_feed` flag, sourced from `audit_logs`), NOT the psnotify events the
worker emits — a real producer↔consumer split (worker writes email; bell reads audit_logs).

**Notification triggers (worker → owner email via `notifyOwnerEvent`/`notifySiteBuilt`):**
- Site generation: preflight/progress + `notifySiteBuilt` "Your Site Is Live" (`workflows/site-generation.ts` ×4)
- Billing webhooks: `invoice.paid`/`invoice.failed`/subscription events (`routes/webhooks.ts` ×2)
- AI admin: AI-endpoint/settings events (`routes/ai_admin.ts` ×2)
- Lead: `notifyNewLead` on public form submit (`routes/forms.ts`, `lead_notifications` flag, dark)
- Domain: `notifyDomainVerified` (`notifications.ts`)
- Agency: client-accepted → agency owner (`routes/agency.ts`)
- Invite: `sendInviteEmail`; quota: `quota_notification.ts` (80/90/100% tiers)
- Weekly digest: `weekly_digest.ts`, Mon 14:00 UTC cron, per-org rollup, `weekly_digest_sent` dedup

**Channels:** email (SES primary + Listmonk bulk + SendGrid break-glass, ADR-0019; suppression
list + SES bounce/complaint webhook `routes/ses_webhooks.ts`, idempotent). `notification_router.ts`
DECLARES email/push/in_app/sms + per-channel rate limits, but only email + in-app(bell) are wired;
**push + sms are types only, no transport.** Metering on send via `usage_metering`.

**Outbound webhooks (customer-subscribable):** `outbound_webhooks.ts` — 6-event allowlist
(`site.published`, `form.submitted`, `payment.succeeded`, `review.received`, `build.failed`,
`domain.active`); HMAC-signed, SSRF-hardened, 6 attempts exp-backoff, DLQ (`webhook_dlq.ts`),
retry log, monitor. Admin UI at `/admin/settings#webhooks`. Inbound: SES, LiveKit, voice, Listmonk, Stripe.

**Inbox/center/prefs UX:** `notification-bell.component.ts` (464 LOC) — gorgeous glass dropdown,
unread dot, shake+pulse animation, in-app "Install PWA" notif. **Polls every 60s** (no real-time).
Prefs live in `user-settings.component.ts` — **local-first (`localStorage ps_notification_prefs`),
forward-synced to `/api/admin/notifications`**; `preference_center.ts` models per-channel +
per-key overrides + `weekly_digest` opt-out, but the bell doesn't gate on it yet.

## Top recs [HIGH/MED]

- **[HIGH] Ship the psnotify DO — the stub is the #1 gap.** Build `libs/features/psnotify/` (DO
  inbox + fan-out to in-app/email/SES/web-push adapters) so `notifyUser` actually lights the bell.
  Today every worker notify is email-only + the bell reads a different source → producer↔consumer
  drift (per MEMORY `notification-source-is-psnotify-do-not-d1-notifications-table`).
- **[HIGH] Unify the bell feed onto psnotify.** Point `/notifications` at the DO inbox, retire the
  `audit_logs`-derived `activity_feed` source so what the worker fires == what the user sees.
- **[HIGH] Real-time delivery, kill the 60s poll.** DO WebSocket/SSE push to the bell
  (per global `real-time-data-no-manual-refresh` + CF-native). New notif appears instantly.
- **[HIGH] Server-persist preferences + enforce them.** Move prefs off `localStorage` to D1;
  gate every send through `resolvePrefs` + `routeNotification` (currently declared, not enforced).
- **[MED] Wire push (web-push) + optional SMS (Twilio VOICE already present).** Channels are typed
  but transport-less; PWA is installed → web-push is low-cost and high-value.
- **[MED] Expand outbound webhook allowlist** (only 6 events) to match the event_bus catalog:
  add `subscription.*`, `invoice.*`, `lead.discovered`, `site.claim.completed`, `ai.*`.
- **[MED] Gorgeous in-app inbox page + notification center** (full-page `/admin/notifications`
  with filter by category, mark-all, bulk actions) — the dropdown is the only surface today.
- **[MED] Per-notification deep-link `action_url` everywhere** so a lead notif → the lead, a
  build-failed → the build log (bell already renders `action_url`; many triggers omit it).
- **[MED] Digest tiers + resend deliverability polish** — daily/weekly choice, engagement-based
  cadence; add List-Unsubscribe header + one-click unsub to transactional emails.

## New notification types + comms surfaces to add [prioritized]

1. **[HIGH] Build progress stream** — live "generating → imaging → published" step notifs (not just terminal email), matches the status machine.
2. **[HIGH] Domain/DNS lifecycle** — `domain.pending → dns_configured → ssl_active → live`, plus expiry/renewal warnings (CF registrar).
3. **[HIGH] Billing lifecycle** — trial-ending (T-3/T-1), card-expiring, payment-failed w/ retry-date, plan up/downgrade, credit-low (CF unified billing).
4. **[HIGH] Security/account** — new-device sign-in, password/email change, new team member, role change, API-key created.
5. **[MED] Site health** — uptime/downtime alert, error-rate spike (Sentry), traffic milestone ("100 visitors this week"), CWV regression.
6. **[MED] Lead/commerce** — new form submission (deep-linked), new review, new order/payment, abandoned-checkout.
7. **[MED] AI/usage** — AI-quota threshold (exists→bell), AI-endpoint error, generation-degraded quality flag (per MEMORY `degraded-success-path-must-flag`).
8. **[MED] Content/collaboration** — comment/mention on a doc, publish approval requested, scheduled-post published (Postiz).
9. **[MED] Product/marketing comms** — in-app changelog/what's-new feed, onboarding nudges ("finish setup"), feature-announcement banner.
10. **[LOW] Digest & report emails** — monthly performance report PDF, weekly lead summary, quarterly business review email.
11. **[LOW] Comms surfaces** — Slack/Discord/webhook connectors for owner alerts, email→SMS escalation for critical, notification snooze/quiet-hours, per-site notification routing.
