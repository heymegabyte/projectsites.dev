# Operations — projectsites.dev Worker

Runbooks for email deliverability, OAuth provisioning, CSRF policy, D1 performance, status page, and image budgets.

---

## Email Deliverability

### DNS records (zone `75a6f8d5e441cd7124552976ba894f83`)

Manage at: https://dash.cloudflare.com/84fa0d1b16ff8086dd958c468ce7fd59/projectsites.dev/dns/records

**SPF (TXT `@`)** — one record only (two SPF records fail RFC 7208):
```
v=spf1 include:_spf.resend.com include:sendgrid.net -all
```
Start with `~all` (softfail) for the first 7 days; tighten to `-all` once zero legitimate sends are dropped.

**DKIM (TXT, two selectors)**

| Selector | Host | Value |
|----------|------|-------|
| `resend._domainkey` | `resend._domainkey.projectsites.dev` | Paste verbatim from Resend dashboard |
| `s1._domainkey` | `s1._domainkey.projectsites.dev` | CNAME → `s1.domainkey.u<USER_ID>.wl.sendgrid.net` |

Verify at: https://resend.com/domains · https://app.sendgrid.com/settings/sender_auth

**DMARC (TXT `_dmarc`)** — escalate over ~30 days to `p=reject; pct=100`:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@projectsites.dev; pct=10
```

| Week | Policy | pct |
|------|--------|-----|
| 0 | `p=quarantine` | 10 |
| 1 | `p=quarantine` | 25 |
| 2 | `p=quarantine` | 50 |
| 3 | `p=quarantine` | 100 |
| 4 | `p=reject` | 100 |

### Bounce + complaint webhook

```
POST /api/email/bounce
X-Webhook-Signature: hex(HMAC-SHA256(RESEND_WEBHOOK_SECRET, raw-body))
```

Signature verification reuses `verifyHmacSignature()` from `src/services/webhook.ts`. Configure:
```bash
npx wrangler secret put RESEND_WEBHOOK_SECRET --env production
```

Webhook config: https://resend.com/webhooks · https://app.sendgrid.com/settings/mail_settings/webhook_settings

**Suppression table:**
```sql
CREATE TABLE email_bounces (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  type TEXT NOT NULL,   -- 'hard' | 'soft' | 'complaint' | 'delivery_delayed'
  reason TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_email_bounces_email ON email_bounces(email);
```

`notifications.ts` calls `isSuppressed(env, email)` before every send. Hard bounces and complaints permanently suppress. Manual reset of soft/delayed:
```sql
DELETE FROM email_bounces WHERE email = ? AND type IN ('soft','delivery_delayed');
```

### Runbook

- **Daily**: `GET /api/admin/email/health` — confirm `verified_at` is < 24h for both providers.
- **Weekly**: review DMARC aggregate reports for unaligned senders (forwarded mail is expected).
- **On incident** (bounce rate > 2% in 1h): pause magic-link sends via feature flag, inspect the 100 most-recent `email_bounces` rows, identify the pattern, resume.

### Local dev simulation

```bash
curl -X POST http://localhost:8787/api/email/bounce \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $(node -e 'const c=require("crypto"); console.log(c.createHmac("sha256","dev-secret").update(process.argv[1]).digest("hex"))' '{"type":"email.bounced","data":{"to":["test@example.com"],"bounce":{"type":"hard","reason":"550 5.1.1"}}}')" \
  -d '{"type":"email.bounced","data":{"to":["test@example.com"],"bounce":{"type":"hard","reason":"550 5.1.1"}}}'
```

---

## OAuth Provisioning

Status as of 2026-05-25.

### Provisioned (creds in chezmoi + Worker production secrets)

| Provider | Client ID | Redirect URI |
|----------|-----------|--------------|
| HubSpot MCP Auth App | `27e994e3-2eb9-46dc-9703-b0ab34872683` | `…/api/mcp/hubspot/callback` |
| Stripe Connect (TEST) | `ca_UL1wS47fnYJy8e4dgFmE3TpYtn3NeVzQ` | `…/api/mcp/stripe/callback` |
| Calendly Developer App | `au1CScQSmFBTp0WJFzZaqP1TkDuCiiMlkI2pM0MhAKg` | `…/api/mcp/calendly/callback` |
| Airtable OAuth | `896c7468-b173-4828-8411-070c465cb444` | `…/api/mcp/airtable/callback` |
| PagerDuty OAuth 2.0 | `3cd81c7e-fa8d-401e-a635-a86ddbadf723` | `…/api/mcp/pagerduty/callback` |

Pre-existing: Mailchimp · Slack · Notion · GitHub · Linear · Discord · Google · Sentry · Netlify.

### Deferred providers

**Vercel** — marketplace integration requires full content + Vercel review. Draft at `vercel.com/.../integrations/console`. Capture `VERCEL_OAUTH_CLIENT_ID/SECRET` once approved.

**Cal.com** — OAuth client creation requires Cal.com Platform plan ($37/seat/mo). Use the `__paste_key__` fallback in `mcp_oauth.ts` until a customer demands it.

**Zapier** — requires building a full Zapier Platform integration (multi-day). Start at https://developer.zapier.com when ProjectSites has ≥1 stable public Trigger.

### Provisioning playbook for new providers

1. Navigate to provider dev portal → sign in (Google SSO with brian@megabyte.space or BitWarden autofill).
2. Create OAuth app: Name = `ProjectSites` · Description ≤ 140 chars · Redirect = `https://projectsites.dev/api/mcp/{provider_slug}/callback` · Logo = `~/Downloads/ps-app-icon-projectsites.png` · Scopes = read+write on primary entities.
3. Capture `client_id` + `client_secret` via Chrome clipboard → `pbpaste`.
4. Save to chezmoi via `storeSecret` from `scripts/lib/secrets.mjs`.
5. Push to Worker: `pushSecretToWorker({ env: 'production' })`.
6. Verify: `/Users/Apple/.local/bin/get-secret {KEY}`.

---

## CSRF Policy

API callers authenticate via `Authorization: Bearer <token>` stored in `localStorage` — not cookies — so the classic CSRF surface does not apply to most routes.

### State-changing GETs (safe by design)

| Endpoint | Mutation | Protection |
|----------|----------|------------|
| `GET /api/auth/magic-link/verify` | Consumes magic-link token | Single-use, hash-validated, 15-min TTL |
| `GET /api/auth/google/callback` | Establishes session | OAuth `state` bound to `oauth_states` row with TTL |
| `GET /api/auth/github/callback` | Establishes session | Same — `state` is the CSRF token, single-use, TTL-bound |

### Admin route defense-in-depth (`/api/admin/*`)

`csrfMiddleware` (`src/middleware/csrf.ts`) applies to all `POST`/`PUT`/`PATCH`/`DELETE`:

1. Issues `__Host-csrf` cookie on every request (`__Host-` prefix = secure-only, path `/`, tied to issuing host).
2. Same-origin requests (`Origin` ∈ projectsites.dev family) — no token verification needed (browser same-origin policy + SameSite=Lax already block CSRF).
3. Cross-origin or missing `Origin` — `X-CSRF-Token` header must match `__Host-csrf` exactly (constant-time compare). Mismatch → `403 CSRF_TOKEN_INVALID`.

**SPA pattern:**
```ts
const csrf = document.cookie.match(/__Host-csrf=([^;]+)/)?.[1] ?? '';
await fetch('/api/admin/foo', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-CSRF-Token': csrf,
  },
  body: JSON.stringify(payload),
});
```

### Webhook and internal routes

Stripe webhooks verify `Stripe-Signature` HMAC. Bounce webhooks verify `X-Webhook-Signature` HMAC. GitHub OAuth callbacks verify `state` against a TTL-bound D1 row. `/api/internal/*` routes use `internalHmacMiddleware` (see API_REFERENCE.md § Internal Routes).

---

## D1 Performance

### Quick-reference

| Tool | Use when | Latency win |
|------|----------|-------------|
| Composite index (`0029_*`) | New `WHERE col1 = ? AND col2 = ? ORDER BY col3 DESC` query | 30–90% on rows |
| `dbCached()` (KV + lock) | Polling endpoint, freshness ≥5s, payload safe to share | 70–95% reads |
| `dbQueryWithSession()` | Cross-region admin reads tolerant of <1s replica lag | 15–40% |
| `Cache-Control: private` | Per-user response, browser can re-use within freshness window | 1 RTT saved |
| `dbBatch()` | Multi-row write that must be atomic | Fewer RTTs |

### Index audit (migration `0029_d1_indexes.sql`)

| Index | Query backed |
|-------|-------------|
| `idx_audit_logs_org_action_ts` | `WHERE org_id = ? AND action LIKE 'form.submission%'` |
| `idx_audit_logs_target_id_org` | `getSiteAuditLogs` (target-scoped audit feed) |
| `idx_audit_logs_request_id` | Distributed-trace correlation |
| `idx_sites_org_status_updated` | Org dashboard list with status filter |
| `idx_sites_status_updated` | Admin "active builds" global view |
| `idx_ai_logs_org_ts` | Org-wide AI cost rollups |
| `idx_ai_logs_endpoint_ts` | Endpoint-test recent-logs view |
| `idx_form_submissions_site_status_ts` | Forms inbox status filter |

All use `CREATE INDEX IF NOT EXISTS`. Apply idempotently:
```bash
npx wrangler d1 execute project-sites-db-production \
  --remote \
  --file=migrations/0029_d1_indexes.sql
```

### KV-fronted cache (`dbCached`)

```ts
const cached = await dbCached<AuditRow>(
  c.env.DB, c.env.CACHE_KV,
  `audit:rows:${orgId}:${limit}`,
  10,
  'SELECT * FROM audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?',
  [orgId, limit],
);
c.header('Cache-Control', 'private, max-age=10');
c.header('X-Cache', cached.cacheStatus); // 'hit' | 'miss' | 'bypass'
```

Current TTLs: `/api/audit/rows` 10s · `/api/sites/:siteId/form-submissions` 8s · `/api/sites/:siteId/ai-logs` 5s · `/api/billing/credits` 60s.

### Read-replica routing (`dbQueryWithSession`)

`aiAdmin` mounts `withD1Session` on every GET. The Angular admin UI echoes the `X-D1-Session` header back on the next request for sequentially-consistent reads.

Do **not** use sessions for: read-after-write that must observe the just-written row, or one-shot internal jobs (cron/queue) — those always read primary via `dbQuery`.

### Batched writes (`dbBatch`)

```ts
const inserts = [
  c.env.DB.prepare('INSERT INTO milestone_events (...) VALUES (?, ?)').bind(id, label),
  c.env.DB.prepare('INSERT INTO audit_logs (...) VALUES (?, ?)').bind(eventId, orgId),
];
const { error } = await dbBatch(c.env.DB, inserts);
```

D1 `batch()` runs all statements in an implicit transaction. Don't use for unrelated writes.

### Cross-references

- `src/services/db.ts` — `dbCached`, `dbBatch`, `dbQueryWithSession`
- `src/middleware/d1_session.ts` — Hono adapter
- `src/__tests__/d1-cache.test.ts` · `src/__tests__/d1-session.test.ts`
- `migrations/0029_d1_indexes.sql`

---

## Status Page

Self-hosted at `https://projectsites.dev/status`. Polls `/health/deep` every 30 seconds and displays D1, KV, R2, and Workers AI binding state.

**Data source:** `GET /health/deep` (in `src/routes/health.ts`) returns `{ checks: { d1, kv, r2, ai } }` with per-component `status: 'ok' | 'error'` and `latency_ms`.

**Asset:** `public/status.html` — also uploaded to R2 as `marketing/status.html` by the deploy script. The Worker prefers the R2 mirror; falls back to inline HTML.

### Optional `status.projectsites.dev` subdomain

1. Open https://dash.cloudflare.com/ → `projectsites.dev` zone → DNS.
2. Add: Type `CNAME` · Name `status` · Target `projectsites.dev` · Proxy **Proxied**.
3. The Worker's `*.projectsites.dev/*` route serves `/status` on the subdomain automatically.

To redirect bare `status.projectsites.dev/` to the status page, add to the `app.all('*')` catch-all:
```ts
if (hostname === `status.${DOMAINS.SITES_BASE}`) {
  return c.redirect(`https://${DOMAINS.SITES_BASE}/status`, 302);
}
```

### Tests

- `e2e/status.spec.ts` — asserts 200, H1 "All systems operational", four component cards.
- `src/__tests__/health_route.test.ts` — covers `/health/deep` JSON shape.

### Future work

- Incident history: persist `incident_log` rows on `ok → error` flip; surface "Past 7 days" on `/status`.
- RSS feed: `/status.rss` from the incident table.
- Email subscribers: opt-in list for `incident.opened` / `incident.resolved` via the Resend pipeline.

---

## Marketing Image Budget

Last audited: 2026-05-21. Performance target: Lighthouse 100/100/100/100.

### Assets over 100 KB

| Asset | Current | WebP target | AVIF target | Action |
|-------|---------|-------------|-------------|--------|
| `public/icon-512.png` | 281 KB | < 90 KB | < 70 KB | Keep PNG (install surfaces); emit AVIF/WebP companions for SPA previews |
| `public/og-image.png` | 230 KB | < 70 KB | < 50 KB | Redesign to branded card (logo + tagline + accent); target < 80 KB; `[[always]]` gate caps OG at 100 KB |

Everything else in `public/` is under 100 KB. `optimize-images.mjs` re-encodes defensively anything ≥ 200 KB.

### Encoding rules

- `optimize-images.mjs` encodes PNG > 200 KB → `.webp` (quality 82) + `.avif` (quality 60) via `sharp`. Originals stay for the `<picture>` last-fallback path.
- Favicons (`favicon.ico`, `icon-{16,32,180,192,512}.png`, `apple-touch-icon.png`) are skipped — must stay PNG for browser/OS install surfaces.
- Re-runs are idempotent (stale outputs re-encoded by mtime comparison).
- CI gate: `node scripts/optimize-images.mjs --check` exits 1 if companions are stale.

### Future work

- Convert homepage hero (when added) directly as AVIF/WebP/JPEG triplet rather than from PNG.
- Move icon generation into `optimize-images.mjs` so the favicon pipeline is one script.


---

# Runbooks (folded 2026-06-27)


## auth-better-auth

# Runbook — Better Auth (embedded) activation + cutover

Better Auth is embedded in the main worker (`src/auth/better-auth.ts`), mounted at
`/api/auth/*` behind the `better_auth` flag. See ADR-0006.

## Secrets (main worker)
- `BETTER_AUTH_SECRET` — session/token secret. Self-generable: `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — for Google social (already set for legacy Google).

## Cutover sequence (do NOT skip)
1. **Phase 2** — ship the frontend sign-in UI (email+pw, magic link, Google, 2FA) against `/api/auth/*`.
2. **Phase 3** — backfill existing D1 `users` → Better Auth `user`/`account` tables (no re-register).
3. **Phase 4** — flip the `better_auth` flag ON. Better Auth now owns `/api/auth/*` + issues sessions;
   legacy auth becomes fallback. Verify sign-in/up/magic-link/Google/2FA end-to-end against prod.
4. **Phase 5** — enable the SSO/SAML plugin for enterprise.
5. **Phase 6** — remove `services/auth.ts` (legacy) + the standalone `auth.projectsites.dev` worker.

## Rollback
Flip `better_auth` OFF → `/api/auth/*` falls through to the legacy auth (still present until Phase 6).
Instant, no redeploy.

## Verify (prod smoke, flag on)
- `POST /api/auth/sign-up/email` → creates a user + session.
- `POST /api/auth/sign-in/email` → session cookie set.
- `POST /api/auth/sign-in/magic-link` → email sent (SES/Listmonk).
- Google + 2FA flows complete without console errors.


## email-deliverability-activation

# Runbook — Activate the SES Email + Deliverability Pipeline (§4/§42, ADR-0019)

This loop built the full Resend→SES transactional migration **and** the SES
bounce/complaint suppression pipeline behind progressive-degradation env gates.
The code ships dark: with no AWS creds it falls back to Resend, and with no
`SES_WEBHOOK_SECRET` the webhook 503s. These are the operator steps to turn it
on. Each step is independent and reversible.

## What is already built (no code work remaining)

- **10 transactional senders** route SES-primary when configured (notifications,
  auth magic-link, contact, forms send-reply, inbox, credits alerts, public
  contact-form, form_router, ai_admin invites, weekly_digest). Resend/SendGrid
  remain the fallback. (`src/platform/email-router.ts`, `services/ses_email_provider.ts`.)
- **Suppression pipeline**: parse (`services/ses_notifications.ts`) → store
  (`services/email_suppressions.ts`, migration `0575`) → webhook
  (`routes/ses_webhooks.ts`, `POST /webhooks/ses`) → enforce (fail-open
  `isSuppressed` check in the email-router) → manage (super-admin
  `GET`/`DELETE /api/super-admin/email-suppressions`).

## Step 1 — Apply the D1 migration (creates the suppression tables)

`wrangler deploy` does NOT run D1 migrations (repo's standing pattern). Run:

```bash
cd apps/project-sites
npx wrangler d1 migrations apply project-sites-db-production --env production --remote
# verify:
npx wrangler d1 execute project-sites-db-production --env production --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('email_suppressions','email_events');"
```

Expect both `email_suppressions` and `email_events` listed.

## Step 2 — Verify the SES sending domain + set the SES env

Requires `noreply@projectsites.dev` verified in SES (DKIM/SPF) + production SES
access (out of sandbox) before real sends.

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env production
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
# vars (wrangler.toml [env.production.vars] or secret):
#   AWS_DEFAULT_REGION = us-east-1   (or your SES region)
#   SES_FROM_EMAIL     = noreply@projectsites.dev
```

The moment all three of `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` +
`SES_FROM_EMAIL` are set, every transactional send flips to SES-primary.

## Step 3 — Generate + set the webhook HMAC secret

Self-generable (we control both signer + verifier). NOT a vendor cred.

```bash
SES_WEBHOOK_SECRET=$(openssl rand -base64 32)
echo "$SES_WEBHOOK_SECRET" | npx wrangler secret put SES_WEBHOOK_SECRET --env production
# keep $SES_WEBHOOK_SECRET — Step 4 configures Hookdeck/SNS to sign with it.
```

## Step 4 — Wire SES → SNS → /webhooks/ses (HMAC-signed)

1. In SES, set the configuration set / identity to publish **Bounce** +
   **Complaint** events to an SNS topic.
2. Point an HTTPS subscription at `https://api.projectsites.dev/webhooks/ses`,
   forwarded through Hookdeck (preferred) so Hookdeck verifies the raw SNS
   signature and re-signs with HMAC using `$SES_WEBHOOK_SECRET` in the
   `x-hookdeck-signature` header. (Direct SNS also works if it can HMAC-sign.)
3. The first delivery is a `SubscriptionConfirmation` — the handler auto-confirms
   it (SSRF-guarded to `sns.*.amazonaws.com` only).

## Step 5 — End-to-end verify

```bash
# Trigger a hard bounce via the SES simulator (sends FROM your verified domain):
#   send any transactional email to: bounce@simulator.amazonses.com
# Then confirm the address was suppressed:
npx wrangler d1 execute project-sites-db-production --env production --remote \
  --command "SELECT email, reason FROM email_suppressions ORDER BY created_at DESC LIMIT 5;"
```

Expect `bounce@simulator.amazonses.com` with `reason='bounce'`. A subsequent send
to it is skipped by the fail-open `isSuppressed` check (structured log
`send_skipped_suppressed`).

Operators view/manage the list at `GET /api/super-admin/email-suppressions` and
un-suppress via `DELETE /api/super-admin/email-suppressions/:email` (audited).

## Step 6 — Decommission Resend (only after SES is proven live)

Once Step 5 passes in prod for ≥48h:

1. Delete the Resend fallback branches from the 10 senders (each keeps SES + the
   structured logs).
2. In `scripts/check-architecture-fitness.mjs`, drop `documented: 'ADR-0019'`
   from the `resend` rule so any reintroduction is a HARD violation, and set the
   `email-resend` registry status to `removed`.
3. Verify `node scripts/check-architecture-fitness.mjs` reports
   `by_vendor.resend == 0` and the gate is green.

## Rollback

- Unset `AWS_*`/`SES_FROM_EMAIL` → senders fall back to Resend instantly (no
  redeploy needed — progressive degradation by env).
- Unset `SES_WEBHOOK_SECRET` → the webhook 503s (stops ingesting suppressions).
- D1 Time Travel restores `email_suppressions` if a bad bulk-suppress lands.

## See

- `DECISIONS.md (convergence ADR series)` — the decision + migration log.
- `~/.agentskills/rules/email-deliverability.md` — the cross-project doctrine.


## selfhost-apps

# Runbook — Self-host customer-facing apps on CF Workers Containers

Stand up Cal.com / Formbricks / Documenso (and future SKUs) as per-app CF Workers
Containers, each on its own subdomain + dedicated Neon DB. Pattern mirrors the live
`llm.megabyte.space` / `crm` / `cms` containers. Cross-refs: `neon-database-conservation`,
`worker-deploy-needs-docker`, `listmonk-mail-subdomain-live`, `cf-access-on-workers-gotchas`.

## Architecture decision (2026-06-27) — CF Workers Containers, NOT Fly.io

Host on **CF Workers Containers** (`cloudflare-lock-in-is-leverage`), not Fly.io. The CF
registry block only affects external `image = "ghcr.io/..."` refs; the working path is
`image = "./containers/<app>/Dockerfile"` with the Dockerfile `FROM <official-image>` — CF
builds it into its own managed registry, no external registry needed.

## Supportability gate — the 4-service rule (see root README)

An app is only supportable if its ENTIRE data/service plane fits within FOUR service types:
(1) **Custom** (its own CF Workers Container), (2) **Upstash** Redis, (3) **Neon** Postgres,
(4) **Cloudflare Analytics Engine** analytics (Tinybird/ClickHouse removed 2026-10-07). Anything
outside that set (bespoke ClickHouse/Cube/Tinybird, a second custom service, extra Hub services)
= **NOT supportable**; do not add it.

## The apps

| Brand | OSS app | Subdomain | Neon DB | Status |
|---|---|---|---|---|
| cal.diy | Cal.com (repo `github.com/calcom/cal.diy`, NOT calcom/cal.com) | `schedule.projectsites.dev` | `projectsites_calcom` | ✅ live |
| (sign) | Documenso | `sign.projectsites.dev` | `projectsites_documenso` | ✅ live |
| ~~(survey)~~ | ~~Formbricks~~ | — | — | ❌ REJECTED 2026-06-27 — v5 image needs Cube + extra Hub services (>4-service rule) |

Live apps are Postgres-only (Neon-native); confirm each repo's current docker-compose before
building (Redis can flip optional→required between majors — and an app crossing the 4-service
rule must be rejected, as Formbricks was).

## Per-app wiring (AppRuntimeContainer-subclass pattern — mirror Umami/Outline)

1. `containers/<app>/Dockerfile` = `FROM <official-image>` + `EXPOSE <port>`.
2. `[[env.production.containers]]` in `wrangler.toml`: `class_name = "<App>Container"` + `image = "./containers/<app>/Dockerfile"`.
3. `[[env.production.durable_objects.bindings]]` for the class + migration entry with `new_sqlite_classes = ["<App>Container"]`.
4. DO subclass in `src/durable_objects/app_runtime_subclasses.ts` + add slug to `SUPPORTED_APP_SLUGS`.
5. `BINDING_BY_SLUG['<slug>'] = '<APP>_CONTAINER'` in `src/services/container_dispatcher.ts` + add binding to `Env` (`src/types/env.ts`).
6. Host dispatch: route `survey|schedule|sign`.projectsites.dev → its container (hostname→slug map in the worker dispatch path). **An explicit per-host route is MANDATORY** — the `*.projectsites.dev/*` wildcard otherwise wins and swallows the subdomain (Listmonk incident).
7. Inject app env (DATABASE_URL → the app's dedicated Neon DB, NEXTAUTH_SECRET, etc.) via the AppRuntime env-resolution path.
8. `wrangler deploy --env production` — **Docker daemon MUST be up** (builds all container images).
9. Verify by BODY: `curl -sI https://<sub>.projectsites.dev` → 200 AND body = the app's login/landing HTML (wildcard fallback also returns 200 — assert content, not just status). Real-browser smoke: app shell renders, not blank/SPA-HTML.

## Secrets (per `secret-provisioning-recipe`)

chezmoi → wrangler manifest → Env+Zod → `wrangler secret put` (GLOBAL CF key; `secret put`
needs no Docker, but the container BUILD on deploy does).

- Cal.com: `NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`, `DATABASE_URL`, SMTP (via Listmonk/Resend)
- Documenso: `NEXTAUTH_SECRET`, `NEXT_PRIVATE_ENCRYPTION_KEY`, `NEXT_PRIVATE_SIGNING_*` (cert), `DATABASE_URL`, SMTP
- (Formbricks rejected — the 32-char `ENCRYPTION_KEY` / multi-env zod gotcha is moot; it failed the 4-service rule.)

## Neon DBs

Per `neon-database-conservation`: one DATABASE per app inside a shared project (~100 DBs/project;
a new project is NOT justified). Some apps already have dedicated projects (Formbricks
`wild-sound-20069767`, + Twenty/Listmonk/n8n/Strapi/NocoDB/Windmill). Use the neon MCP
(`run_sql`, `get_connection_string`).

## Preconditions + gotchas

- **Docker daemon MUST be running** before any container deploy: `docker info >/dev/null 2>&1 || open -a Docker`, poll until ready. This (not just context thrash) is why early rounds never reached 200.
- **macOS Docker cred fix**: PATH + strip `credsStore` from `~/.docker/config.json` + keychain unlock.
- **Do NOT clone/read upstream source** — bind the official published image; reading repos/lockfiles thrashes context (`subagent_tokens: 0`). Run ONE app per FRESH session (`/clear` first), or sequential — spawning deploy agents from a thrashing parent reproduces the failure regardless of brief leanness.

## Status (as of 2026-06-27)

- Documenso: ✅ live (`sign.projectsites.dev`, e-sign).
- cal.diy: ✅ live (`schedule.projectsites.dev`, scheduling).
- Formbricks: ❌ rejected (exceeds the 4-service rule — needs Cube + Hub services).
- Each live app becomes an `/admin`-purchasable add-on SKU (booking / e-sign).
