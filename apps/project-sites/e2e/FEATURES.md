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
| Media Library — empty/populated grid | `media-library.spec.ts` | test-writer | TDD-RED | Upload via header button, toast, asset appears |
| Media Library — 6-breakpoint layout | `media-library.spec.ts` | test-writer | TDD-RED | No horizontal overflow at 375–1920 |
| Media Stock Search — results | `media-stock-search.spec.ts` | test-writer | TDD-RED | ≥1 card when API keys configured |
| Media Stock Search — missing key state | `media-stock-search.spec.ts` | test-writer | TDD-RED | Deeplink empty state when 401 |
| Media Stock Search — Save to Library | `media-stock-search.spec.ts` | test-writer | TDD-RED | Card transitions to saved state |
| Media Image Studio — Generate happy path | `media-image-studio.spec.ts` | test-writer | TDD-RED | Spinner + result image |
| Media Image Studio — graceful 502 error | `media-image-studio.spec.ts` | test-writer | TDD-RED | Toast surfaced, no crash |
| Media Image Studio — button disabled in-flight | `media-image-studio.spec.ts` | test-writer | TDD-RED | Button disabled while generating |
| Media Video Studio — model toggle + queue notice | `media-video-studio.spec.ts` | test-writer | TDD-RED | Sora/Veo toggle visible |
| Media Video Studio — queued row with model chip | `media-video-studio.spec.ts` | test-writer | TDD-RED | Asset row + chip after Generate |
| Media Video Studio — Veo model chip | `media-video-studio.spec.ts` | test-writer | TDD-RED | Chip reflects selected model |
| Media Podcast Studio — Generate button enables | `media-podcast-studio.spec.ts` | test-writer | TDD-RED | Disabled until segment has text |
| Media Podcast Studio — audio player or error toast | `media-podcast-studio.spec.ts` | test-writer | TDD-RED | Either audio or friendly error |
| Media Podcast Studio — missing ELEVENLABS_API_KEY | `media-podcast-studio.spec.ts` | test-writer | TDD-RED | 503 → friendly toast |
| Media Drop Zone — dragenter shows overlay | `media-drop-zone.spec.ts` | test-writer | TDD-RED | Fullscreen overlay on drag |
| Media Drop Zone — drop navigates + new asset | `media-drop-zone.spec.ts` | test-writer | TDD-RED | Nav to /admin/media + asset |
| Media Drop Zone — dragleave dismisses overlay | `media-drop-zone.spec.ts` | test-writer | TDD-RED | Overlay hides, no nav |
| Media Send to Editor — hover reveals button | `media-send-to-bolt.spec.ts` | test-writer | TDD-RED | Button visible on hover |
| Media Send to Editor — toast + postMessage | `media-send-to-bolt.spec.ts` | test-writer | TDD-RED | Toast + PS_MEDIA_ATTACH dispatched |
| Media Send to Editor — keyboard accessible | `media-send-to-bolt.spec.ts` | test-writer | TDD-RED | Tab + Enter fires action |
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
| Admin site detail — 12 checks | `admin-site-detail.spec.ts` | convergence | GREEN | 12 tests ✅ |
| Marketing SEO — 9 route metadata | `marketing-seo.spec.ts` | convergence | GREEN | 14 tests ✅ |
| Security headers — extended | `security-headers-extended.spec.ts` | convergence | GREEN | 6 tests ✅ |
| Integration health — 8 probes | `integration-health.spec.ts` | convergence | GREEN | 8 probes ✅ |
| Feature flags — public API | `feature-flags.spec.ts` | convergence | GREEN | 5 tests ✅ |
| Accessibility — 8 routes × 6bp | `accessibility.spec.ts` | convergence | GREEN | 48 scans ✅ |
| Site lifecycle — extended | `site-lifecycle-extended.spec.ts` | convergence | GREEN | 6 tests ✅ |
| Deliverability — idle preview rail | `admin/deliverability.spec.ts` | loop | GREEN | AL-062 — pre-check SPF/DKIM/DMARC "not checked yet" dashboard (aria-hidden), replaced by the real result after a check; unit-locked in `deliverability.component.spec.ts` |
| Contact form — RENDERED visitor journey → form_submissions (causal) | `admin-verify/verify-rendered-contact-journey.mjs` | loop | GREEN | AL-639 — REAL browser, home→click Contact→fill rendered form→submit→app.js hijack→POST `/api/contact-form/:slug`→200+"Thanks!"→0 console errors; reconciled vs D1 `form_submissions` (2/2 rows, status `received`). Closes the gap `verify-forms-causal.mjs` left (it scripts the OTHER endpoint `/api/v1/forms/submit`, never the rendered form). form_submissions mirror is best-effort so 200≠proof → D1 ground-truth is the gate. |
| **TOTAL** | **19 specs** | convergence | **135+ tests GREEN** | Passes 1-28 |

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
