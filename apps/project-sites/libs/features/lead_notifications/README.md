# lead_notifications

Email the site owner the moment a public contact form is submitted — so a new lead is
**never missed** without configuring an integration. Embarrassingly-easy: zero owner config.

- **Flag:** `lead_notifications` (`enabled=0, rollout=0, stage=experimental` — dark by default)
- **Trigger:** fire-and-forget in `POST /api/contact-form/:slug` (`src/routes/forms.ts`) AFTER the
  `form_submissions` row is persisted. **Fail-soft:** a send failure never affects the visitor 200
  or the recorded `/admin/forms` row.
- **Recipient:** `ai_site_settings.reply_email` for the site, else the org owner
  (`users ⋈ memberships` where `role='owner'`). No resolvable recipient → sends nothing.
- **Send rail:** SES (ADR-0019) via `notifyNewLead` → `sendEmail(category:'lead_notification')`
  (`src/services/notifications.ts`).
- **Safety:** every user-supplied lead field key/value is HTML-escaped (`escapeLeadHtml`) before
  rendering — the public form is unauthenticated, so the owner's inbox is treated as untrusted output.

## Disabled behavior

Flag off → no owner email fires (the pre-existing behavior). Leads are still recorded and visible
in `/admin/forms`. This is a pure side-effect on the existing submit path — no new route.

## Files

- `src/routes/forms.ts` — the flag-gated `waitUntil` wiring
- `src/services/notifications.ts` — `notifyNewLead` + `buildLeadEmailHtml` + `escapeLeadHtml`
- `schemas.ts` — `LeadNotificationSchema` boundary contract
- `__tests__/lead_notifications.test.ts` — escaping + rendering + contract unit tests

## Removal

Delete the `waitUntil` block in `forms.ts` + `notifyNewLead` in `notifications.ts` + this flag.
Contact-form submit + `/admin/forms` recording are unaffected.
