# E2E Feature Inventory

> Human-facing feature matrix for `apps/project-sites/e2e/`.
> **Spec-of-record:** [`COVERAGE.yml`](./COVERAGE.yml) maps every one of the 64
> spec files to a feature group and is enforced by `npm run validate:e2e-inventory`
> (fails on orphan specs / dangling refs). This matrix is a richer human view and
> is NOT 1:1 with the spec files — consult COVERAGE.yml for the authoritative
> spec→feature mapping.
> Status key: `TDD-RED` = failing test written, no impl; `GREEN` = test + impl passing; `SKIP` = deferred.

## Feature Coverage Matrix

| Feature | Spec | Owner | Status | Notes |
|---------|------|-------|--------|-------|
| Media API — soft-delete gate | `media/media-coverage.spec.ts` | test-writer | GREEN | MEDIA-07 — unauth reject, authed nonexistent→404, fake-delete never drops real assets (verified live on prod) |
| Media API — list auth gate | `media/media-coverage.spec.ts` | test-writer | GREEN | MEDIA-08 — unauth reject, authed→200 + `assets[]` envelope (verified live on prod) |
| Media API — write endpoints reject unauth | `media/media-coverage.spec.ts` | test-writer | GREEN | MEDIA-09 — stock-search / generate-image / upload all reject unauthenticated callers |
| Analytics plane — cross-tenant IDOR gate | `api-safety/data-surface-safety.spec.ts` + `src/__tests__/analytics_idor.test.ts` | security-reviewer | GREEN | AL-789 — `/api/analytics-data`·`/analytics-debug`·`/test-event` accepted a client `siteId` (slug/id) with NO ownership check (authMiddleware is populate-only) → unauth read of ANY site's visitor_events (session ids/geo/UA) + synthetic-event write, PROVEN LIVE via curl. Fixed at root: org-owned slug-or-id resolve → 404 (never 403). Unit 7/7 green; prod gate goes green post-CI-deploy |
| Media Library **admin UI** (grid · stock · image · podcast · drop-zone · send-to-editor) | `media-*.spec.ts` _(skipped)_ | — | SKIP | **REMOVED** — `/admin/media` renders admin-404 (no component/route/testid; see `admin-verify/admin-surf-audit.mjs`). The 6 mock-based UI specs are `test.describe.skip`-ed → pointer to `media/media-coverage.spec.ts`. Media survives as the API (above) + the `media:write` token scope (`api-tokens.component.spec.ts`). Phantom `media-video-studio.spec.ts` was never authored — ref removed from FEATURES + prod testMatch. |
| **Global drop-zone** — drag-anywhere admin upload | `admin-global-drop-zone.e2e.ts` | test-writer | GREEN | Shell-wide drag-drop upload (`GlobalDropZoneComponent`, live on every `/admin/*` route) → `POST /api/media/upload` — the LIVE upload path since the media UI was removed. Full journey verified live on prod: text-drag ignored (the `hasFiles` gate) · files-drag reveals the a11y dialog (role=dialog/aria-modal/labelled+described) · axe-clean overlay · dragleave hides · **drop → real multipart POST + upload toast** · 0 console errors. |
| Env Vars Manager — add row with masked value | `env-vars-manager.spec.ts` | test-writer | TDD-RED | Last 4 chars visible, full secret hidden |
| Env Vars Manager — delete row disappears | `env-vars-manager.spec.ts` | test-writer | TDD-RED | Optimistic removal |
| Env Vars Manager — masking invariant | `env-vars-manager.spec.ts` | test-writer | TDD-RED | Full value never in DOM |
| Env Vars Import — paste dotenv → 2 rows | `env-vars-import-export.spec.ts` | test-writer | TDD-RED | FOO + BAZ appear |
| Env Vars Export — download triggered | `env-vars-import-export.spec.ts` | test-writer | TDD-RED | `page.waitForEvent('download')` |
| Env Vars Import — empty textarea validation | `env-vars-import-export.spec.ts` | test-writer | TDD-RED | Error or disabled, no crash |
| MCP Tab — connected integrations list | `env-vars-mcp-scope.spec.ts` | test-writer | TDD-RED | Rows for GitHub + Slack |
| MCP Tab — expand shows scoped env section | `env-vars-mcp-scope.spec.ts` | test-writer | TDD-RED | Section visible on expand |
| MCP Tab — scoped var isolated from org scope | `env-vars-mcp-scope.spec.ts` | test-writer | TDD-RED | Var absent from Env Vars tab |
| Task Tray — card with prompt + options | `task-tray.spec.ts` | test-writer | TDD-RED | **BLOCKER**: needs seed endpoint — currently mocked via page.route |
| Task Tray — option click removes card | `task-tray.spec.ts` | test-writer | TDD-RED | Optimistic removal + resolve POST |
| Task Tray — positioned top-right | `task-tray.spec.ts` | test-writer | TDD-RED | x > vp.width/2 |
| Task Tray — empty inbox hides card | `task-tray.spec.ts` | test-writer | TDD-RED | No card when GET returns [] |
| Chat Streaming — widget opens via Cmd+K | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | Input focused, widget visible |
| Chat Streaming — bold text renders | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | `<strong>` in message |
| Chat Streaming — code block with language class | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | `class="language-*"` present |
| Chat Streaming — tool chip renders | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | `.agent-tool-chip` visible |
| Chat Streaming — citation marker renders | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | `sup.agent-citation` visible |
| Chat Streaming — suggestion chips render | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | Action chip below message |
| Chat Streaming — zero console errors | `streaming-markdown-render.spec.ts` | test-writer | TDD-RED | Blocking errors filter applied |

## Convergence E2E Specs (Pass 1-11, 2026-07-27)

| Feature | Spec | Owner | Status | Notes |
|---------|------|-------|--------|-------|
| Super-admin privilege boundary (regular user 403 / unauth 401 on every `/api/super-admin/*`) | `verify-super-admin-guard.mjs` | admin-verify | GREEN | 14/14 prod ✅ (P0 escalation guard) |
| AI env-var `.env` export (auth + dotenv content + bogus-token gate + delete-gone) | `verify-envvars-export-causal.mjs` | admin-verify | GREEN | 6/6 prod ✅ — created var round-trips into the dotenv (display==store), bogus Bearer 401 (closes the AL-710 export coverage gap; dev `env-vars-import-export.spec.ts` only checks a download fires) |
| Auth OAuth — Google button visible | `auth-oauth-buttons.spec.ts` | convergence | GREEN | 4/4 pass ✅ |
| Auth OAuth — GitHub button visible | `auth-oauth-buttons.spec.ts` | convergence | GREEN | 4/4 pass ✅ |
| Auth sign-up OAuth — Google button | `auth-signup-oauth.spec.ts` | convergence | GREEN | 4/4 pass ✅ |
| Auth sign-up OAuth — GitHub button | `auth-signup-oauth.spec.ts` | convergence | GREEN | 4/4 pass ✅ |
| Auth full flow — homepage journey | `auth-full-flow.spec.ts` | convergence | GREEN | 2 tests ✅ |
| Auth callback — Google/GitHub redirect | `oidc-oauth-callback.spec.ts` | convergence | GREEN | 4 tests ✅ |
| Admin journey — homepage→signin | `admin-journey.spec.ts` | convergence | GREEN | 6 tests ✅ |
| Admin sections — 25 route auth gates | `admin-sections-smoke.spec.ts` | convergence | GREEN | 25 routes ✅ |
| Admin social — 10 section checks | `admin-social.spec.ts` | convergence | GREEN | 10 tests ✅ |
| Admin sysadmin — 5 checks | `admin-sysadmin.spec.ts` | convergence | GREEN | 5 tests ✅ |
| Admin editor — 3 checks | `admin-editor.spec.ts` | convergence | GREEN | 3 tests ✅ |
| Admin voice/billing — 5 checks | `admin-voice-billing.spec.ts` | convergence | GREEN | 5 tests ✅ |
| Billing conversion — dashboard → **Billing nav CLICK-PATH** (SPA, no reload) | `admin-verify/verify-billing-nav-clickpath.mjs` | loop | GREEN | FULL-JOURNEY: the click-path the checkout-mount probe teleported past. Home→seed session→/admin→click account menu (aria-expanded)→click "Billing & credits"→SPA route to /admin/billing (window sentinel survives = no full reload)→real billing surface (bodyLen 1765, no crash)→0 console errors. Verified live on prod. Complements `verify-billing-checkout.mjs` (iframe mount). |
| Admin site detail — 12 checks | `admin-site-detail.spec.ts` | convergence | GREEN | 12 tests ✅ |
| Marketing SEO — 9 route metadata | `marketing-seo.spec.ts` | convergence | GREEN | 14 tests ✅ |
| Security headers — extended | `security-headers-extended.spec.ts` | convergence | GREEN | 6 tests ✅ |
| Integration health — 8 probes | `integration-health.spec.ts` | convergence | GREEN | 8 probes ✅ |
| Feature flags — public API | `feature-flags.spec.ts` | convergence | GREEN | 5 tests ✅ |
| Accessibility — 8 routes × 6bp | `accessibility.spec.ts` | convergence | GREEN | 48 scans ✅ |
| Site lifecycle — extended | `site-lifecycle-extended.spec.ts` | convergence | GREEN | 6 tests ✅ |
| Deliverability — idle preview rail | `admin/deliverability.spec.ts` | loop | GREEN | AL-062 — pre-check SPF/DKIM/DMARC "not checked yet" dashboard (aria-hidden), replaced by the real result after a check; unit-locked in `deliverability.component.spec.ts` |
| Contact form — RENDERED visitor journey → form_submissions (causal) | `admin-verify/verify-rendered-contact-journey.mjs` | loop | GREEN | AL-639 — REAL browser, home→click Contact→fill rendered form→submit→app.js hijack→POST `/api/contact-form/:slug`→200+"Thanks!"→0 console errors; reconciled vs D1 `form_submissions` (2/2 rows, status `received`). Closes the gap `verify-forms-causal.mjs` left (it scripts the OTHER endpoint `/api/v1/forms/submit`, never the rendered form). form_submissions mirror is best-effort so 200≠proof → D1 ground-truth is the gate. |
| Generated-site VISITOR journey — live product output (SPA nav + click-to-call + directions + contact + FAQ/blog/gallery + axe-6bp) | `generated-site-visitor-journey.spec.ts` | loop | GREEN | AL-769 — homepage-first on a LIVE cohort site (franklin-barbecue), CLICK-driven only, 4 tests: SPA no-reload sentinel · conversion sub-actions (`tel:`/maps-dir/contact-form fillable, non-mutating) · content sub-actions (FAQ toggle/blog list/gallery zoomable) · axe 0-critical ×6bp home+contact, 0 console errors. Caught a real mobile-menu `aria-expanded` selector-stranding bug; surfaced 2 SERIOUS accent-eyebrow/trust-pill contrast advisories → recorded for the GENERATED-SITE QUALITY loop. Complements the MARKETING golden-path (which covers projectsites.dev, not the delivered site). |
| Guest acquisition — homepage hero business search (top-of-funnel) | `search-and-places.spec.ts` | loop | GREEN | AL-804 — **REWRITTEN** from the DELETED vanilla 4-screen homepage (`#screen-search`/`#search-input`/`#search-dropdown` — all 11 old tests were prod-RED). Homepage-first Angular-shell journey, 8 tests / **8 GREEN on prod (28.6s)**: hero input renders + aria-live status (WCAG 4.1.3) · typed→debounced→dropdown OR graceful Places-403 degraded nudge (0 console errors) · <2-char min-length gate · results carry name+address · Custom option always present · clear-hides-dropdown · click routes GUEST into `/signin` funnel (SPA sentinel survives = no reload) · pre-built live-preview link (conditional) · **open-dropdown axe 0-critical ×6bp** (interactive state accessibility.spec.ts never exercises). Root testability fix: hero input got `data-testid="hero-search-input"`. Enrolled in the prod suite. |
| **TOTAL** | **21 specs** | convergence | **147+ tests GREEN** | Passes 1-29 + AL-804 |

## Blockers / Next-prompt work

1. **task-tray seed endpoint** — `POST /api/inbox/tasks` does not exist as a test-env endpoint today.
   All task-tray specs currently mock the GET response with `page.route`.
   A `/api/internal/inbox/seed` endpoint (test-env only, guarded by `TEST_SECRET` header) would
   allow true end-to-end verification against production D1.

2. **`@axe-core/playwright` not in `package.json`** — axe integration commented out of all specs.
   Add `"@axe-core/playwright": "^4"` to `apps/project-sites/package.json` devDependencies,
   then un-comment the `checkA11y` calls in each spec.

3. **MCP scoped vars** — `env-vars-mcp-scope.spec.ts` has a `test.skip()` guard in the
   isolation-verification test if the "Add Variable" button is not found on the expanded MCP card.
   This indicates the scoped-var UI inside the MCP card is not yet implemented.

4. **postMessage cross-origin** — `media-send-to-bolt.spec.ts` cannot directly assert the
   `PS_MEDIA_ATTACH` message was received by the bolt.diy iframe (separate origin).
   The spy in the test captures same-window messages only.
   A `page.exposeFunction` round-trip (bolt iframe → parent window → test) would give a
   deterministic assertion without cross-origin relaxation.
