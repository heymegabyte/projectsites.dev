# Site Operations — Super-Admin Management System (design + phased plan)

> Brian directive (2026-09-20, via `/loop`): re-imagine "Super admin" into a full **Site
> Operations** console — scroll/search/sort every site (up to 1M), manage each site + each
> user account, send emails for common events, manually charge/refund, view account status,
> bulk management. PLUS: fully remove **Resend** everywhere (incl. System Services).
>
> This is a **multi-fire build**. This doc is the spec; each 30-min fire ships ONE safe,
> verifiable slice against it, then self-cancels the loop after the system is complete.

## Decision — a new `/admin/site-operations` section (super-admin scoped)

Keep the existing feature-flags "Super admin" surface for platform config; add a NEW
**Site Operations** section = the read-heavy, action-oriented **operator console** (support/ops/
billing/risk), distinct from config-heavy admin (per the operator-vs-admin split, WorkOS/dashhold).
Server guard: every endpoint requires the platform super-admin role (`sysAdminGuard`), returns
404 (never 403) when unauthorized — scope checks at the route handler, never UI-only.

## Feature set (weighed from research — what's IN vs OUT for v1)

IN (v1, highest operator value):
- **Overview** — platform totals: sites by status, users, active subscriptions, trials, failed payments, MRR (Stripe, 5-min TTL cache).
- **Sites list** — server-paginated, **searchable + sortable up to 1M rows** (see § scale). Columns: business name / slug / owner email / status / plan / created_at / last build. Sort any column (default created_at desc). Row → Site-360.
- **Site-360** — one site: status, build history, owner, plan/subscription, domains, analytics snapshot; actions: rebuild, suspend/restore, archive, resend completion email, open live.
- **Users list** — server-paginated searchable/sortable (email / org / role / created_at / status / #sites). Row → User-360.
- **User-360** — account status, orgs/sites owned, subscription, audit trail; actions below.
- **Send email** — pick a recipient account + a **governed template enum** (welcome, build-complete, payment-failed, trial-ending, suspension-notice, custom) → SES send (idempotent, one-per-event), logged. NOT free marketing blasts.
- **Billing ops** — manual **charge** + **refund** (full/partial) THROUGH THE PLATFORM (Stripe wrapper writing our ledger + audit; never the raw Stripe dashboard). Mandatory reason (governed enum, note required for "Other"). Refund does NOT auto-revoke — links to suspend.
- **Account lifecycle** — **suspend/restore** (reversible, immediate access cut, preferred over delete), archive, GDPR hard-delete path (co-signed).
- **Impersonation** — audited, **time-boxed (≤30 min)**, tenant-visible, sensitive actions (billing/password/MFA) blocked while impersonating.
- **Audit** — every action writes `audit_logs` {actor, target, action, reason-enum, before/after, ts}. History viewer filterable per site/user.
- **Bulk ops** — multi-select on the sites/users list → bulk email / suspend / plan-change, with **dry-run → confirm → rollback** and a `log()` of what was affected (no silent caps).

OUT (deferred, lower ROI for v1): custom-role editor, Slack audit mirror, region migration, per-tenant feature-flag overrides (already have the flags admin), usage-metering charts.

## Scale — searchable + sortable up to 1M sites (the hard requirement)

- **Server-side** pagination + sort + search — NEVER load 1M rows client-side. Endpoint:
  `GET /api/ops/sites?q=&sort=created_at&dir=desc&cursor=&limit=50` → `{rows, nextCursor, total}`.
- D1 indexed queries: add indexes on `sites(created_at)`, `sites(status)`, `sites(business_name)`;
  search = `LIKE` on name/slug/owner (wildcard-stripped per `d1-like-wildcard-strip`), parameterized.
- **Keyset/cursor pagination** (WHERE created_at < :cursor ORDER BY created_at DESC LIMIT :n) for
  deep pages — offset pagination degrades past ~10k rows. Return `total` from a cheap `COUNT(*)`
  (cached 60s) so the UI shows "N sites" + jump-to-page without scanning.
- Frontend: **TanStack Table (server-side data source)** — `manualPagination/manualSorting/
  manualFiltering: true`, debounced (300ms) search, signal-bound state, virtualized rows. Reuse the
  installed `@tanstack/angular-table` pattern (`admin-v2/sections/sites.component`). Instant SWR cache
  on re-visit (`AppsInstancesCache` pattern).

## Safety rails (non-negotiable — from research anti-patterns)

- Audit EVERY action (governed reason enum, not free-form). Confirm dialog before destructive/
  financial. Refund/charge through platform wrapper (ledger + audit), never raw Stripe. Impersonation
  time-boxed + audited + tenant-visible + sensitive-actions-blocked. Suspend over delete. Co-sign the
  riskiest (hard-delete, bulk-charge). Fail-closed entitlement/role checks. Every new capability behind
  a feature flag (`site_operations`, `enabled=0, stage=experimental`).

## Resend removal (explicitly requested — scoped, its own careful fire)

`resend` is referenced in ~17 frontend + ~30 worker files. CAVEAT: `platform/email.ts` +
`email-router.ts` + `service-registry.ts` are the **SES→Resend→SendGrid fallback chain (ADR-0019)** —
this is money/comms-critical (golden-journey emails ride it). Removal plan:
1. Email rail: drop the Resend arm from `email-router.ts`/`email.ts`/`service-registry.ts` → SES
   primary + **SendGrid** sole break-glass fallback. Keep all send call-sites. Run the email test suite
   (`notifications_ses_migration`, `email_port`, `contact_form`, `weekly_digest`, …) GREEN.
2. Per-site **Resend MCP** integration (customer's own key): remove from `mcp-providers.ts` catalog +
   `env-vars-attachment` + any connect UI (Brian now wants it gone everywhere).
3. **System Services**: remove the Resend entry from `system-services.component.ts` + the health probe.
4. Docs/press/legal/onboarding copy mentions → scrub. Grep `-i resend` must be empty (except ADR history).
5. New ADR `0020-resend-fully-removed.md` superseding the ADR-0019 Resend arm.

## Phased plan (one per fire; self-cancel loop `eeec8269` when Phase 4 verified)

- **Phase 0 (this fire)** — research + this spec, committed. ✅
- **Phase 1** — backend: `libs/features/site_operations/` module (flag `site_operations`) + endpoints
  (`/api/ops/sites`, `/api/ops/users`, `/api/ops/sites/:id`, `/api/ops/users/:id`) with server-side
  paginate/sort/search + D1 indexes + Zod + `sysAdminGuard` + audit. Unit tests. Deploy via CI + curl-verify.
- **Phase 2** — frontend: `/admin/site-operations` section + Sites table (TanStack server-side, search/sort,
  1M-safe) + Site-360 + the safe actions (suspend/restore/resend-email/rebuild). E2E + a11y + deploy R2 + real-browser verify.
- **Phase 3** — Users table + User-360 + billing ops (charge/refund through the Stripe wrapper + ledger +
  reason-enum) + send-email (governed templates) + impersonation (time-boxed/audited). E2E + verify.
- **Phase 4** — bulk ops (dry-run→confirm→rollback) + **Resend full removal** (the 5 steps above, email
  suite green) + retire the old "Super admin" nav into Site Operations. Verify → self-cancel the loop.
