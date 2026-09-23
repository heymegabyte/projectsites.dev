# Repo Improvement Ledger

> Progress tracker for the continuous repo-improvement loop (`ad44da68`, every 30m).
> One coherent, verified slice per cycle. Test cleanup is scoped to **dead/obsolete only**
> (user decision 2026-09-23) — the live suite + CI coverage gates stay intact.

## Cycle log

### Cycle 1 — 2026-09-23 — Resend doc-drift reconciliation
- **Slice:** `apps/project-sites/docs/SITE-OPERATIONS.md` framed Resend removal as a *pending*
  future fire (5-step plan, "Phase 4 — Resend full removal", "~17 frontend + ~30 worker files").
  It's already done. Rewrote § Resend removal + the intro blockquote + the Phase 4 line to
  DONE status, and reconciled the stale "remove the MCP everywhere" step against CLAUDE.md's
  authoritative "per-site Resend MCP is KEPT" decision.
- **Evidence (source-of-truth = implementation):** `src/types/env.ts:528` ("Resend removed
  2026-09-09 — SES canonical"); `src/platform/service-registry.ts:458` (`resend` in
  `EXCLUDED_VENDORS`); email regression suite asserts `api.resend.com` is never called
  (`api_routes`, `auth`, `contact_form`, `weekly-digest`, `notifications_ses_migration`,
  `form_router`); ledger AL-864 (System Services Resend purge deployed live 2026-09-20).
- **Verification:** grep-based (no build needed) — 42 worker / 16 frontend "resend" hits are
  removed-comments, regression guards, the EXCLUDED_VENDORS entry, and the *kept* per-site MCP;
  no active send rail. Not deployed (docs-only change).
- **Files changed:** `apps/project-sites/docs/SITE-OPERATIONS.md` (3 edits).

## Environment constraint (this session)
Auto-mode Opus safety-classifier is intermittently down → `Agent` spawns, `git pull/push`,
and `rm` are classifier-gated and failing. So this loop is running **read-only discovery +
Edit/Write + local commits** only. File deletions (orphaned tests) and `git push` are deferred
to a fire where the classifier is up or the session is in bypass-permissions mode.

## Deferred: orphaned-test candidates (VERIFY target-gone before deleting — do NOT bulk-delete)
Grepped test dirs for removed-feature references. Most are **live regression guards** (keep).
Only delete a spec whose target module no longer exists:
- `src/__tests__/ai_endpoints_ide.test.ts` — the `ai_endpoints` feature (D1 table + UI + dispatcher)
  was removed (CLAUDE.md "Removed — never reintroduce", replaced by code-defined Functions/WfP).
  **Candidate** — confirm the tested module is gone, then delete. If it tests the WfP replacement, keep.
- All others matched (`event_bus_types`, `webhook_storage`, `workflow_router`, `api_keys_port`,
  `integration_health_route`, `billing_provider`, `app_marketplace`, `job_router_factory`, the
  e2e `admin-*`/`integration-health` specs) test **live** features — KEEP.

## Documentation map (canonical owner per topic — expand across cycles)
- **Monorepo orientation** → root `CLAUDE.md`
- **Worker API / services / pipeline** → `apps/project-sites/CLAUDE.md`
- **Angular admin SPA** → `apps/project-sites/frontend/CLAUDE.md`
- **Site Operations / Super admin** → `apps/project-sites/docs/SITE-OPERATIONS.md`
- **System Services control plane** → `docs/system-services-audit.md` (audit + migration plan)
- **Email rail (SES sole, SendGrid break-glass)** → ADR-0019 + CLAUDE.md; Resend removed.
- **Conflicts resolved:** SITE-OPERATIONS.md "remove Resend MCP everywhere" ✗ vs CLAUDE.md
  "per-site Resend MCP KEPT" ✓ → CLAUDE.md wins (authoritative); SITE-OPERATIONS.md updated.

## Angular project inventory (Angular style-guide pass — NOT started)
- Admin SPA at `apps/project-sites/frontend/` (Angular 21 standalone + Spartan UI). Installed
  version + style-guide coverage: **to inventory next Angular cycle** (read
  https://angular.dev/style-guide first, confirm version before adopting newer APIs).

## Coverage
- **Reviewed:** `SITE-OPERATIONS.md` (Resend section), `service-registry.ts` (shape), env/wrangler
  bindings, System Services UI wiring (prior audit fire).
- **Remaining:** the bulk of source/config/doc files — inspect progressively across cycles.

## Next highest-value actions
1. When classifier up / in bypass: `git push` the pending local commits (System Services audit
   `522f0256c` + this cycle), rebasing onto remote first (remote moved ahead).
2. Verify + delete `ai_endpoints_ide.test.ts` IF its target is confirmed gone (dead-test cleanup).
3. Start the Angular style-guide inventory (versions + per-project coverage) for `frontend/`.
