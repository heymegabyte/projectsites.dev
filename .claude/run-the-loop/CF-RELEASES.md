# Cloudflare Release Scout — state + decisions

Owned by role 14 (Technology Scout), ~every 4 fires. Feeds: developers.cloudflare.com
available-RSS-feeds set (developer platform + product feeds + deprecations). Protocol:
dedupe by GUID → record source + publication date → inspect current docs → evaluate
fit/maturity/limits/cost/migration/security/measurable benefit → DECISION (pilot |
backlog | watch | reject-with-reason). Urgent deprecations jump the cadence. Feed outage
never blocks core verification. Browser API/platform changes also feed role 18's
capability registry.

## Seen GUIDs

(none yet — first sweep queued in BACKLOG § cf-releases)

## Decisions

- 2026-09-29 · **Browser Run CDP endpoint** (product docs, verified at implementation time)
  — `wss://api.cloudflare.com/client/v4/accounts/{acct}/browser-run/devtools/browser` +
  Bearer token with "Browser Run Write" → **PILOT → ADOPTED** same fire: the Deep UI
  Explorer's primary browser (proven session, deep path green). Older Workers-binding
  Browser Rendering remains the Worker-side gateway path.
