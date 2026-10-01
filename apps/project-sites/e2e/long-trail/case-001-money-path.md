# Long-Trail Case 001 — Money Path (search → sign in → create → edit → publish → verify → clean up)

> **Methodology:** `long-trail-tdd` skill. This is a DURABLE numbered case — it outlives the browser
> and drives the TDD. Run it against the **local** stack (worker `:8787` + Angular `:4200`) with the
> `?test=1` real test-login as `brian@megabyte.space`. Oracle is always the reloaded surface / a
> second surface / a direct store read — **never a success toast**.
>
> - **Executable spec:** `case-001-money-path.e2e.ts` (localhost, LOCAL Chromium, homepage-start).
> - **Checkpoint:** `checkpoint-case-001.json` (resume state).
> - **Local-dev recipe:** `apps/project-sites/docs/local-dev-longtrail.md` (bring the stack up).
> - **Screenshots (LOCAL):** `screenshots-local/NN-*.png` — kept DISTINCT from any prod evidence.
> - **Test-resource prefix:** `ltt-e2e-` (everything this case creates; torn down at the end).
> - **Recipient allowlist (fail-closed):** email ONLY `brian@megabyte.space`; SMS ONLY the E2E cell;
>   payments TEST MODE; NO cross-tenant reads/writes.

## Outcome under test

A returning owner (`brian@megabyte.space`, super-admin) signs in through the real UI, lands on the
admin cockpit, creates/opens a site, edits its code + data in the Bolt editor with live reload,
promotes it, visits the published site, submits a contact form, and confirms the lead + the pageview
land in their AUTHORITATIVE stores (D1 `form_submissions` / `visitor_events`) — then cleans up.

## Surfaces covered (≥6)

1. Marketing homepage (`/`) · 2. Sign-in (`/signin?test=1`) · 3. Admin dashboard (`/admin`) ·
4. Admin section routes (Forms / Analytics / Feature Flags / Hosting) · 5. Bolt editor
(`/admin/editor` — Code + Preview + Data) · 6. Published generated site (`{slug}.local` served by
the worker) · 7. Data stores reconciled directly (D1 `form_submissions`, `visitor_events`,
`sessions`, `audit_logs`).

## Legend

- **Start** = app state before the action. **Action** = exact interaction + **locator discovered from
  the live app** (never invented). **See** = expected visible result. **Effect** = expected API/store
  change (the real oracle). **Shot** = screenshot + AI-vision required.

---

## PHASE A — Homepage → real sign-in (actions 1–12)

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 1 | cold browser | `goto('/')` | H1 "Your business website, already built and ready to claim.", nav visible | `GET /` 200; 0 console errors | Y `01-homepage` |
| 2 | homepage | assert `getByRole('link', {name:'Sign In'})` visible (nav) | Sign In link present | — | N |
| 3 | homepage | `getByPlaceholder('Search for your business…')` type `Vito` | debounced search fires | `GET /api/search/businesses?q=Vito*` + `/api/sites/search` (may 200 empty locally) | N |
| 4 | homepage | assert search does NOT throw; results container OR honest empty | no console error | graceful (Places may 403 locally → degrade) | N |
| 5 | homepage | clear search input | input empty | — | N |
| 6 | homepage | `getByRole('link',{name:'See How It Works'})` assert href/visible | CTA present | — | N |
| 7 | homepage | `goto('/signin?test=1')` (real-login seam entry) | signin card "Welcome back" | `GET /signin` 200 | N |
| 8 | signin | assert `getByTestId('test-signin-panel')` visible | "TEST SIGN-IN" panel renders | (proves the seam is wired into the SERVED component) | Y `02-signin-test-panel` |
| 9 | signin | assert `getByTestId('test-signin-email')` value == `brian@megabyte.space` (readonly) | prefilled email | — | N |
| 10 | signin | `getByTestId('test-signin-password')` fill `E2E_TEST_PASSWORD` (from env) | password masked | — | N |
| 11 | signin | `getByTestId('test-signin-submit')` click | route → `/admin` | `POST /api/auth/test-login` 200 → real bearer; `sessions` row written; `audit_logs` row `auth.test_login` | N |
| 12 | /admin | `page.evaluate` fetch `/api/auth/me` with `ps_session` token | — | `GET /api/auth/me` 200 `email=brian@megabyte.space`, real `org_id`, `is_super_admin=true` (**oracle, not the redirect**) | Y `03-admin-dashboard` |

## PHASE B — Admin cockpit tour + empty-state honesty (actions 13–26)

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 13 | /admin | assert left nav groups WORKSPACE/CAPABILITIES/OPERATIONS/ACCOUNT present | full cockpit nav | — | (covered by 03) |
| 14 | /admin | assert `getByText('Super admin')` nav entry visible | super-admin gate reflected in UI | mirrors `is_super_admin` | N |
| 15 | /admin | with no sites, assert honest empty "No sites yet" + `getByRole('button',{name:'Create Site'})` | empty state is a launchpad, not a dead end | ground-truth: D1 `sites` COUNT = 0 for this org (honest-empty) | N |
| 16 | /admin | click nav `Forms` (`getByRole('link',{name:'Forms'})`) | Forms section renders, `<h1>` present | `GET /api/... ` forms list (empty ok) | Y `04-forms` |
| 17 | Forms | assert exactly one `<h1>` (admin-h1 gate) | h1 present | — | N |
| 18 | Forms | click nav `Analytics` | Analytics section renders | `GET /api/analytics*` (edge/beacon) | Y `05-analytics` |
| 19 | Analytics | assert NO "Refresh"/"Reconcile" manual-refresh button (real-time-data rule) | auto-updating surface | — | N |
| 20 | Analytics | click nav `Feature Flags` | flags table renders (super-admin only) | `GET /api/feature-flags*` | Y `06-flags` |
| 21 | Feature Flags | assert `per_site_data` OR a known flag row visible | flag registry reflected | — | N |
| 22 | Feature Flags | click nav `Hosting` | Hosting section renders | `GET /api/sites/:id/hostnames` (empty ok) | N |
| 23 | /admin | `Cmd+K` (`page.keyboard.press('Meta+K')`) | command palette opens + input focused | (Cmd+K build-gate) | Y `07-cmdk` |
| 24 | palette | `Escape` | palette closes, focus restored | — | N |
| 25 | /admin | **nav-away**: `goto('/')` then back via `getByRole('link',{name:'Sign In'})`→ already-authed → `/admin` | returns to /admin without re-login (session persists) | no second `POST /test-login` | N |
| 26 | /admin | **hard-refresh** `page.reload()` | still authed, dashboard renders (session re-read from store) | `GET /api/auth/me` 200 brian again | N |

## PHASE C — Create / open a site (actions 27–40)

> Local note: a full AI build is COSTLY + container-gated — this case STOPS before a real build and
> instead seeds a disposable `ltt-e2e-*` site row directly (via the create endpoint or a seeded D1
> row) so the editor/publish/serve legs can run without burning build credits. The build kickoff is
> asserted as "enqueued", never awaited to completion.

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 27 | /admin | click `Create Site` (`getByRole('button',{name:'Create Site'})`) | create flow / search wizard opens (route `/create` or modal) | — | Y `08-create` |
| 28 | create | fill business name `ltt-e2e-vitos` (disposable, prefixed) | name accepted | — | N |
| 29 | create | choose a template / minimal option (discover real control) | selection reflected | — | N |
| 30 | create | submit create | route → waiting/admin; a `sites` row exists | `POST /api/sites/create-from-search` (or `/api/sites`) → `sites` row `slug LIKE 'ltt-e2e-%'`, status `draft`/`collecting`; workflow enqueued (NOT awaited) | Y `09-waiting` |
| 31 | waiting/admin | assert the new site appears in the site picker/list | site listed | `GET /api/sites` includes `ltt-e2e-vitos` (**oracle: store list, not toast**) | N |
| 32 | /admin | select the `ltt-e2e-` site in the org/site picker | selectedSite set | — | N |
| 33 | /admin | **nav-away+back** to another section and back to Dashboard | selected site retained | — | N |
| 34 | /admin | assert readiness/grade endpoint responds for the site | grade shown or honest "not built" | `GET /api/sites/:id/readiness` 200 | N |
| 35 | /admin | open `Snapshots` | snapshots section renders (empty for fresh site) | `GET /api/sites/:id` | N |
| 36 | /admin | open `Hosting` for the site | default `{slug}.projectsites.dev` hostname shown | `GET /api/sites/:id/hostnames` | Y `10-hosting` |
| 37 | Hosting | assert NO manual reconcile button (real-time rule) | live inventory | — | N |
| 38 | /admin | open `Logs` (`getByRole('link',{name:'Logs'})` OPERATIONS) | audit rows incl. `auth.test_login` visible | `GET /api/audit*` shows the login audit row (**cross-feature causal: the login in #11 shows here**) | Y `11-logs` |
| 39 | Logs | assert the `auth.test_login` action row present for this session | causal link login→audit | ground-truth D1 `audit_logs` has the row | N |
| 40 | /admin | open `KV Inspector` (super-admin op) | KV browser renders | `GET /api/... kv` | N |

## PHASE D — Bolt editor: Code + Preview + Data (actions 41–58)

> The editor extends the bolt.diy iframe (`editor.projectsites.dev` / `localhost:5173`). In local dev
> the iframe may be cold or unavailable; the case asserts the editor SHELL + the worker-backed Data
> tab (per-site D1) which does NOT need the iframe. Steps that require the live WebContainer are
> marked `[iframe]` and skipped-with-note when the editor origin isn't running locally.

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 41 | /admin | click nav `Editor` | editor route renders (shell + iframe host) | — | Y `12-editor` |
| 42 | editor | assert the editor shell chrome (top tabs / bottom panel) renders | editor UI present | — | N |
| 43 | editor `[iframe]` | wait for `PS_BOLT_READY` postMessage (or skip-note if origin down) | Code view loads project files | — | N |
| 44 | editor `[iframe]` | open a file in Code view, edit a string, save | file dirty→saved | file persisted to iso-git/R2 for the site | Y `13-code-edit` |
| 45 | editor `[iframe]` | switch to Preview, assert live-reload reflects the edit | preview shows the change | — | Y `14-preview` |
| 46 | editor | switch to **Data** tab (worker-backed, no iframe) | Data/Tables surface renders | `GET /api/sites/:siteId/db/tables` (flag `per_site_data`; 404 dark if off — assert the honest 404 message, not a crash) | Y `15-data` |
| 47 | Data | if flag on: create a table `ltt_e2e_notes` (name + 1 col) | table appears in list | `POST /api/sites/:siteId/db/tables` → per-site D1 (NEVER shared) | N |
| 48 | Data | insert one row into `ltt_e2e_notes` | row appears | `POST /.../rows` → per-site D1 | N |
| 49 | Data | **hard-refresh**, re-open Data → the row persists | row re-read from per-site D1 | (persistence oracle) | N |
| 50 | Data | assert isolation: the table is NOT in the shared platform D1 | isolation held | ground-truth: shared D1 has no `ltt_e2e_notes` | N |
| 51 | Data | delete the row, then drop `ltt_e2e_notes` (cleanup) | table gone | `DELETE /.../rows/:rowid` + `DELETE /.../tables/:table` | N |
| 52 | editor | open **Functions**/site-R2 surface if present | renders or honest dark-404 | — | N |
| 53 | editor `[iframe]` | assert console-error-free in editor view | 0 red errors (excl. known dark-feature 404s) | — | N |
| 54 | editor | **nav-away** to Dashboard and back to Editor | iframe persists (BoltEmbedService), no cold re-boot | — | N |
| 55 | editor | assert the persistent iframe survived nav (same WebContainer) | no re-boot spinner | — | N |
| 56 | /admin | open `R2 Inspector` (super-admin) | R2 browser renders | `GET /api/... r2` | N |
| 57 | /admin | open `Vectorize Inspector` | renders or honest "not supported locally" | — | N |
| 58 | /admin | open `Queues Inspector` | renders or honest empty | — | N |

## PHASE E — Promote → visit published → submit form → reconcile (actions 59–78)

> **BUILD/SEED DECISION (fire-61, made autonomously per the case-design contract):** the
> `ltt-e2e-vitos` build is seeded through the **REAL `POST /api/sites/:id/deploy` ZIP endpoint**
> (the manual deploy path bolt.diy + CLI/SDK clients use) with a small deterministic hand-authored
> bundle (`dist/index.html` + `styles.css` + `app.js` with a real contact form POSTing to
> `/api/contact-form/:slug`). **Rationale:** (a) keeps the journey REAL — real authed product
> endpoint, real R2 writes under `sites/{slug}/{version}/`, real D1 flip `draft→published` +
> `current_build_version`, real `site.deploy_started`/`site.deployed` audit rows, real
> `site_snapshots` row — every effect store-assertable; (b) deterministic + instant vs the
> container AI build (25-40 min, ~$5-15, and the `SITE_BUILDER` DO is production-only, so a local
> AI build isn't even possible — API-credit discipline forbids it anyway); (c) resettable — Phase F
> deletes the site; R2 keys are enumerable under the slug prefix. The REJECTED alternatives:
> real container build (cost/latency/non-determinism/impossible locally) and direct R2 poking
> (bypasses the product surface — store effects would be manufactured, not earned).
>
> **As-run adaptations (fire-61):**
> - Served-site visits go to the local worker (`:8787`) with the Host header mapped to
>   `ltt-e2e-vitos.projectsites.dev` via Playwright route interception (the case row 61 sanctioned
>   exactly this). Pre-build, that host serves an honest "Building…" interstitial (200, noindex) —
>   the deploy's causal flip is asserted as interstitial→real-content.
> - **Environment-leak finding:** the serve-time analytics tracker (`buildAnalyticsTracker`,
>   `site_serving.ts:1859`) defaults its beacon to PROD `https://projectsites.dev/api/events` even
>   for locally-served sites (`analytics_tracker.ts` `DEFAULT_ENDPOINT`). The journey intercepts
>   that prod-bound beacon and re-delivers the page's REAL payload to the LOCAL `/api/events`
>   (zero test residue in prod ingestion; the local store still receives what prod would have).
> - Pageviews land in `visitor_events` SERVER-side per serve (`recordPageviewFromRequest`), not
>   via the beacon (beacon mirrors only `form_start`/`form_submit`/`conversion`) — the pageview
>   oracle is a before/after delta on the authoritative store.
> - Shot numbering continues the on-disk sequence (21+); the table's `16-promote`-style names map
>   to `21-hosting-prebuild` … `28-admin-analytics`.

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 59 | /admin | on the `ltt-e2e-` site, trigger Promote/Publish (discover real control) | publish confirms | `POST /api/sites/:id/publish-bolt` (or deploy) → status `published`, `serving_sha` set | Y `16-promote` |
| 60 | /admin | assert status flips to `published` on RELOAD (not just toast) | status chip `published` after reload | `GET /api/sites/:id` status=published (**oracle**) | N |
| 61 | published | `goto` the served site (`{slug}.projectsites.dev` → local host-mapped, or worker `:8787` with Host header) | generated site paints (H1, nav) | worker `site_serving` returns R2 HTML 200 | Y `17-published` |
| 62 | published | assert real content (not the SPA shell, not a soft-404) | site H1 + sections | `document` has real markup | N |
| 63 | published | scroll to contact/form section | contact form visible | — | Y `18-contact-form` |
| 64 | published | fill the contact form name `ltt-e2e Tester` | field accepts | — | N |
| 65 | published | fill email `brian@megabyte.space` (allowlist ONLY) | field accepts | — | N |
| 66 | published | fill message `ltt-e2e long-trail probe {ts}` | field accepts | — | N |
| 67 | published | submit the form | success confirmation | `POST /api/contact-form/:slug` 200 → `form_submissions` row written | Y `19-form-submitted` |
| 68 | published | assert the visible success is honest (re-query, not just toast) | confirmation persists | — | N |
| 69 | store | **ground-truth**: D1 `form_submissions` COUNT for this slug increased by 1, with the `ltt-e2e` message | row present | (LYING-EMPTY guard: submission → store) | N |
| 70 | published | reload the published page (generates a pageview) | page re-paints | `visitor_events` row written for the slug | N |
| 71 | /admin | back to admin → `Forms` section | the new submission appears in the list | `GET /api/... form submissions` includes the `ltt-e2e` row (**cross-feature causal: submit on site → shows in admin Forms**) | Y `20-forms-with-lead` |
| 72 | Forms | open the submission detail | name/email/message match what was typed | reconciles display vs store | N |
| 73 | /admin | `Analytics` section | pageview count reflects the visit (or honest "processing") | reconcile display vs `visitor_events` ground-truth (per verify-against-source-of-truth) | Y `21-analytics-with-view` |
| 74 | Analytics | assert count is NOT lying-empty when store has rows | display==store | (WRONG-SOURCE guard) | N |
| 75 | published | **error state**: submit the contact form with an invalid email | inline/real error surfaces | `POST /api/contact-form/:slug` 400/422 (honest failure, not fake success) | Y `22-form-error` |
| 76 | published | assert NO fake "sent!" on the invalid submit | error shown, no `form_submissions` row added | (no-silent-swallow) | N |
| 77 | /admin | assert the invalid submit did NOT create a lead | count unchanged | ground-truth `form_submissions` unchanged | N |
| 78 | published | **nav-away+back** to the published site, form resets cleanly | fresh form | — | N |

## PHASE F — Disposable app + isolation + cleanup (actions 79–96)

| # | Start | Action + locator | See | Effect | Shot |
|---|-------|------------------|-----|--------|------|
| 79 | /admin | open `Apps` (`getByRole('link',{name:'Apps'})`) | apps catalog renders | `GET /api/... apps` | Y `23-apps` |
| 80 | Apps | pick a disposable/free app to install (discover real control) | install dialog | — | N |
| 81 | Apps | install as `ltt-e2e-<app>` (prefixed) | install kicks off | `POST /api/... apps install` → instance row `ltt-e2e-*` | N |
| 82 | Apps | assert the instance appears in the instances list | instance listed | `GET /api/... instances` includes it (**store oracle**) | Y `24-app-installed` |
| 83 | Apps | open the instance detail / logs | detail renders | `GET /api/... instance` | N |
| 84 | Apps | assert real-time updating (no manual refresh button) | live status | — | N |
| 85 | Apps | **hard-refresh**, instance still listed | persisted | — | N |
| 86 | Apps | remove/uninstall the `ltt-e2e-` app | removal confirms | `DELETE /api/... instance` → row gone | N |
| 87 | Apps | assert instance list no longer shows it (RELOAD, not toast) | gone from store | `GET /api/... instances` excludes it | N |
| 88 | /admin | re-open the `ltt-e2e-` site → still works after the app churn | site intact | `GET /api/sites/:id` still `published` | N |
| 89 | published | re-visit the published site → still serves | site 200 | worker serving OK | Y `25-still-works` |
| 90 | isolation | attempt to read another org's site id via `/api/sites/:otherId` (should DENY) | 403/404, never another tenant's data | (tenant isolation assertion — a security check, not a convenience) | N |
| 91 | /admin | delete the `ltt-e2e-` site (`DELETE /api/sites/:id`) | site removed | `sites` row soft-deleted | N |
| 92 | /admin | assert the site list no longer shows the `ltt-e2e-` site (RELOAD) | gone | `GET /api/sites` excludes it | Y `26-cleanup` |
| 93 | store | **cleanup verify**: no `ltt-e2e-` rows remain in `sites` / instances / `ltt_e2e_notes` | store at baseline | ground-truth counts back to pre-case | N |
| 94 | store | leave `sessions`/`audit_logs` as-is (audit trail is append-only, expected) | audit retained | — | N |
| 95 | /admin | sign out (discover the real control) OR clear `ps_session` | back to signed-out | session revoked | N |
| 96 | signed-out | `goto('/admin')` → bounced to `/signin?returnUrl=/admin` | guard redirects | `GET /api/auth/me` 401 (**oracle: guard actually enforced**) | Y `27-signed-out` |

---

## Persistence + causal + error coverage checklist (skill §4)

- **Nav-away+back**: #25, #33, #54, #78 (session, selected-site, editor iframe, published form).
- **Hard-refresh persistence**: #26 (auth), #49 (per-site D1 row), #85 (app instance).
- **Empty state**: #15 (No sites yet launchpad), #46 (per-site D1 blank / honest dark-404).
- **Error state**: #75–77 (invalid form submit → real error, no fake success, no store write).
- **Undo/cleanup**: #51 (data), #86 (app), #91–93 (site + full baseline restore).
- **Cross-feature causal**: #38–39 (login→audit), #71 (site form→admin Forms), #73 (visit→analytics).
- **Store reconcile (never a toast oracle)**: #12, #31, #60, #69, #74, #77, #87, #93.
- **Tenant isolation**: #90 (cross-org read denied).

## RED found + fixed while authoring this case (LIVE slice)

1. **Local worker un-bootable** — `parseEnv` hard-failed EVERY request (`VALIDATION_ERROR`) on a
   `wrangler dev` box because 9 integration secrets were `.min(1)`-required + absent locally.
   Fix: `src/lib/env.ts` → those 9 are prod-required but **local-optional** when
   `ENVIRONMENT ∈ {development,dev,local,test}`; prod stays fail-fast. Regression:
   `src/__tests__/env_local_dev.test.ts` (18 assertions, both halves pinned). → `/health` 200,
   `test-login` mints a real session.
2. **Local D1 schema incomplete** — the 184-migration chain breaks at `0010` on a fresh DB
   (`builds` created only in `0504`), leaving `users.is_super_admin` / `audit_logs.message` absent →
   `/api/auth/me` "User not found". Fix: the local-dev recipe applies migrations tolerantly
   (multi-pass) so the full schema lands (310 tables); documented in `docs/local-dev-longtrail.md`.
3. **Orphaned test-login UI seam** — `?test=1` panel lived only in the now-unrouted
   `pages/signin/signin.component.ts`; the router serves `pages/auth/sign-in.component.ts`, which
   had NO panel → real-UI E2E login impossible. Fix: wired the `?test=1` panel into the SERVED
   `SignInComponent` (drives `ApiService.testLogin` → `POST /api/auth/test-login`).
   (interconnectedness — orphaned-but-built feature reconnected.)
4. **Missing Angular↔worker proxy** — `ng serve` had no proxy, so the SPA couldn't reach `/api/*`
   in dev. Fix: `frontend/proxy.conf.json` + wired into `angular.json serve.options`.

## RED found + fixed in fire-60 (Phase D live drive — checkpoint actions 38-49)

5. **Editor iframe un-bootable in the local composition (the fire-59 action-38 blocker) — ROOT
   CAUSE: one-sided origin drift.** The deployed editor's CSP (`public/_headers`) ships
   `frame-ancestors 'self' https://projectsites.dev https://*.projectsites.dev …` with NO
   localhost entries, while the editor's own inbound-message allowlist
   (`app/lib/embed/embedded-mode.ts` `ALLOWED_ORIGINS`) explicitly includes
   `http://localhost:4200` + `http://localhost:4300`. The local admin (`:4200`) therefore mounts
   the iframe and Chromium refuses the document — observed live as
   `Framing 'https://editor.projectsites.dev/' violates the following Content Security Policy`
   (note: NOT the older "Refused to frame" wording). Fix: `public/_headers` frame-ancestors +=
   both localhost parents (now a superset of `ALLOWED_ORIGINS`). Regression:
   `src/__tests__/editor_frame_ancestors.test.ts` (derives BOTH sides from the real files; RED
   observed pre-fix → GREEN post-fix). Local GREEN for the iframe legs lands when
   `editor.projectsites.dev` redeploys — until then `D-boot` is `test.fixme` (blocked-on-deploy)
   and the journey allowlists exactly that refusal.
6. **ng serve first-boot optimizer staleness** — cold `.angular/cache` → `504 Outdated Optimize
   Dep` on the Logs/Settings lazy chunks, `GlobalErrorHandler` bounces the SPA to `/` (nav
   "click does nothing" symptom). NOT a product defect. Recipe fix: warm the lazy routes once,
   then restart `ng serve` on the populated cache (see `docs/local-dev-longtrail.md`).
7. **Journey-state drift in earlier phases** — A#15 (honest "No sites yet") + C#36 (editor
   onboarding empty state) were authored at 0-sites state; Phase D's seeded `ltt-e2e-vitos` makes
   both stale on replay. Specs made STATE-AWARE (empty launchpad OR real-store cockpit/iframe) so
   the complete stateful journey replays green at any checkpoint state. Nav assertions moved to
   collapse-proof `data-testid` (`nav-<id>`) — current HEAD renders an icon rail at 1280px.
8. **Test-precision fixes (product correct):** `GET /api/sites/:id/readiness` is flag-gated
   (`prod_readiness_score`) → honest dark-404 locally, spec now pins the envelope either way;
   `ensureLttSite` is check-first so resumed runs don't fire an expected-4xx into the
   console-error gate.

## RED found + fixed in fire-61 (Phase E live drive — checkpoint actions 50-59)

9. **Chromium forbids a `Host` override via `route.continue`** (`Fetch.continueRequest: Unsafe
   header: host`) — the case row 61 "worker + Host header" plan needs PROXY-FULFILL: re-issue each
   worker-origin request through Playwright's Node-side request context (which MAY set Host) and
   fulfill the browser with the real response (encoding/length headers stripped). Harness class,
   product correct.
10. **The worker SHADOWS `/app.js` on served sites** with the ProjectSites unified client, which
    OWNS every `<form>` (capture-phase submit, field-name serialization, `[data-ps-form-status]`
    status element INSIDE the form, "Thanks! Your message has been sent." / server-error copy).
    A site bundle's own form JS never runs. Fixture rewritten to CONFORM (rev-2, redeployed via
    the rev-marker check). Platform behavior, not a defect — now documented here.
11. **Served-site client is PROD-absolute in three places** (injected
    `<script src="https://projectsites.dev/app.js">` at `site_serving.ts:1859`, client `API`
    default, tracker beacon endpoint) — a locally-served page posts forms + events to PROD. The
    journey proxies the WHOLE prod origin to the local worker (answering CORS preflights itself):
    real payloads, local stores, zero prod residue. Recorded as a gp-01 CAPABILITY GAP.
12. **`sites.contact_email` missing from every migration-built DB** (prod carries it out-of-band;
    verified via prod pragma) → the public contact-form handler's SELECT threw, `dbQueryOne`
    swallowed, and EVERY submission 404'd "Site not found" — the
    swallowed-sql-error-masks-schema-drift-as-404 class, second instance after 0651. Fix:
    migration `0652_sites_contact_email.sql` (local-align, never apply remotely) — file:line
    `migrations/0652_sites_contact_email.sql:13`.
13. **`contacts` CRM write was a BLIND INSERT against a dedupe table** — `uniq_contacts_org_email`
    UNIQUE (org_id, lower(email)) rejected every REPEAT submitter; both writers swallowed the
    error (log-only), losing last_seen_at/latest-message, and `handleContactForm`'s
    `persisted=false` could hard-error an innocent visitor on a coincident email-rail failure.
    Fix at root: `src/services/contacts.ts` `upsertContact` (conflict-target matches the PARTIAL
    index; enrich-never-erase COALESCE semantics) wired into BOTH writers —
    `libs/features/contact_newsletter/handlers.ts:96` + `src/services/contact.ts:187`. Regression
    lock: `src/__tests__/contacts_upsert.test.ts` (real-SQLite, RED→GREEN, 4/4); seam-moved
    contract suites retargeted (`contact.test.ts`, `api_routes.test.ts`) — full worker suite
    895/14072 green.
14. **Evidence-quality (vision-caught):** Angular view-transition cross-fades blurred shots 21/28
    (fixed: `settleShot` helper — h1 + 300ms, Analytics anchored to its NAMED h1 since both
    views' h1s coexist mid-fade); post-reload Hosting shot was BLANK and the "no-build-gate
    GONE" assertion was passing VACUOUSLY against an unrendered lazy pane (fixed: positive
    content wait before the absence oracle); published-site form-status sat below the fold in
    evidence shots (fixed: scrollIntoViewIfNeeded); shot 23 caught the entrance fade mid-dim
    (fixed: 350ms settle).

### Fire-61 Phase E as-run action log (checkpoint actions 50-59)

- 50 (case #59-pre) Hosting honest no-build gate (state-aware) · 51 (#59) REAL zip deploy →
  store oracle (status published + build version + `site.deployed` audit) · 52 (#60) reload →
  gate flipped, WFP DISPATCH card + PREVIEW/PRODUCTION URLs + Promote CTA · 53 (#61-62)
  published site via Host-proxied worker — "Building…" interstitial REPLACED by real content ·
  54 (#63-66) form filled (allowlist email) · 55 (#67-69) submit → platform success contract
  (copy + #16a34a) + `form_submissions` AND `contacts` rows carry the exact token + form_start/
  form_submit beacons observed · 56 (#71-72) admin Forms: headline counts the store's rows,
  newest row expanded via the "Open" label (bare row.click lands on the stopPropagation email
  cell), FIELDS JSON shows the typed name/message · 57 (#75-77) invalid email through the UI →
  server message in #dc2626, store count UNCHANGED, exactly one counted 400 · 58 (#70/73-74)
  reload+revisit pageviews → `visitor_events` delta ≥ +3; Analytics displays the reconciled
  count (23 views / 8 visits — NOT lying-empty) · 59 (#78) nav-away/back → clean form.
- Evidence: `screenshots-local/21-28` (settled; inspected). Known fire-60 toast wart ("That
  resource wasn't found." on flag-dark 404s) still visible on Analytics — frontend lane.

### Fire-60 UX findings (frontend lane — NOT fixed this fire, out of scope)

- Background admin calls to flag-dark endpoints surface repeated red toasts
  ("That resource wasn't found.") on Hosting/Inspector views — expected-dark 404s should not
  toast as user-facing errors (seen in `16-kv-inspector.png`, `20-logs.png`).
- Evidence-capture note: screenshots taken immediately post-nav catch Angular View-Transition
  cross-fades; settle on the target h1 (+~250ms) before `page.screenshot` next fire.
- Positive: Hosting honestly gates "Publish to preview" with "This site has no build yet";
  Queues Inspector degrades to an honest error card + Retry when CF creds are absent locally.

## Ramp-up plan (skill §Ramp-up)

- **Now (this case):** ONE desktop viewport, inspect-then-proceed, LOCAL evidence in
  `screenshots-local/`. First ~13 actions RUN + verified green (Phase A + admin render).
- **Next cycles:** finish Phases B–F against local; then EXPAND to 6 breakpoints × browsers +
  keyboard-only + axe + a Lighthouse pass; finally a DEPLOYED prod pass with evidence in a SEPARATE
  `screenshots-prod/` dir (local green = design gate; prod green = release gate).
