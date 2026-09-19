# Frontend Feature Inventory

> Authoritative feature → spec map for the **Angular admin + marketing SPA**
> (`apps/project-sites/frontend`). Every feature row maps to ≥1 Playwright spec
> in this directory. Machine-readable mirror: [`COVERAGE.yml`](./COVERAGE.yml).
>
> Counterpart inventories: `apps/project-sites/e2e/FEATURES.md` (worker e2e),
> root `e2e/FEATURES.md` (bolt.diy main app). This file covers the SPA only.
>
> **Run a spec:** `npx playwright test --config=playwright.prod.config.ts <name>`
> All specs are homepage-first and run against the live prod URL.

Status legend: ✅ covered + green · ⚠️ covered, known-blocked dependency · 🔲 gap (no spec yet).

---

## Marketing / public pages

| Feature | Spec(s) | Status |
|---|---|---|
| Homepage hero / features / CTAs | `homepage.spec.ts`, `journey-homepage.spec.ts`, `hero-logo-visual.spec.ts`, `logo-styling.spec.ts` | ✅ |
| Homepage landmarks + JSON-LD | `homepage-landmarks.e2e.ts`, `json-ld-schema.spec.ts` | ✅ |
| Header (auth-aware nav, SPA links) | `header.spec.ts`, `header-auth-state.spec.ts`, `forms-header-button.spec.ts` | ✅ |
| Blog list + post | `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Press | `press.spec.ts`, `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Privacy / Terms (legal) | `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Roadmap | `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Integrations | `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Contact | `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts`, `contact-form.e2e.ts` | ✅ |
| Sign-in (magic-link / Google) | `signin.spec.ts`, `marketing-a11y.e2e.ts`, `marketing-responsive.e2e.ts` | ✅ |
| Changelog (worker-served) | `marketing-a11y.e2e.ts` (excluded — documented) | ⚠️ worker/Docker-blocked |
| Status (worker-served) | `marketing-a11y.e2e.ts` (excluded — documented) | ⚠️ worker/Docker-blocked |
| Mobile responsive (all marketing) | `mobile.spec.ts`, `marketing-responsive.e2e.ts` | ✅ |

## Create / build / waiting flows

| Feature | Spec(s) | Status |
|---|---|---|
| Create-from-search wizard | `create-site.spec.ts`, `create-page-fixes.spec.ts`, `create-final-fixes.spec.ts`, `auto-create.spec.ts` | ✅ |
| Create z-index / repopulate edge cases | `create-zindex-repopulate.spec.ts`, `dropdown-zindex.spec.ts` | ✅ |
| Global drag-anywhere upload (drop zone) | `admin-global-drop-zone.e2e.ts` | ✅ |
| Category + special-char inputs | `heyo-category.spec.ts`, `heyo-special-chars.spec.ts`, `when-doody-calls.spec.ts` | ✅ |
| Create journey (end-to-end) | `journey-create.spec.ts` | ✅ |
| Waiting / build progress | `waiting.spec.ts`, `build-pipeline.spec.ts` | ✅ |
| Headless build → editor handoff | `headless-build.spec.ts`, `headless-to-editor.spec.ts` | ✅ |
| Build → edit → snapshot cycle | `build-edit-snapshot-cycle.spec.ts` | ✅ |
| Image discovery during build | `image-discovery.spec.ts`, `white-house-images.spec.ts` | ✅ |

## Admin shell + navigation

| Feature | Spec(s) | Status |
|---|---|---|
| Admin routing (SPA, no full reload) | `admin-routing.e2e.ts`, `admin.spec.ts` | ✅ |
| Admin shell / sidebar / topbar | `admin.spec.ts`, `production-admin.spec.ts` | ✅ |
| User menu | `admin-user-menu.spec.ts` | ✅ |
| User settings · Sessions (toast-clean) | `admin-user-settings.e2e.ts` | ✅ |
| Cmd+K command palette + focus | `admin.spec.ts`, `full-audit.spec.ts` | ✅ |
| Cinematic UI (rolling-counter, reveal) | `admin-cinematic-ui.e2e.ts` | ✅ |
| Dashboard upgrades shell — AI FAB (real `/api/dashboard/chat` SSE) + share-toast (de-faked) | `admin-ai-fab.e2e.ts` | ⚠️ shipped + bundle-verified; shell occluded by editor iframe on `/admin` (see Known gaps) |
| Spartan controls + tooltip | `admin-spartan-controls.e2e.ts`, `admin-tooltip.e2e.ts` | ✅ |

## Admin sections

| Section | Spec(s) | Status |
|---|---|---|
| Dashboard / sites list | `admin.spec.ts`, `production-admin.spec.ts` | ✅ |
| Editor (persistent bolt.diy iframe) | `bolt-embed.spec.ts`, `editor-proxy.e2e.ts`, `production-editor.spec.ts`, `production-editor-prompt.spec.ts`, `production-editor-errors.spec.ts` | ✅ |
| Files explorer | `files-deep.spec.ts` | ✅ |
| Snapshots + diff | `admin-snapshots.spec.ts`, `build-edit-snapshot-cycle.spec.ts` | ✅ |
| Site detail tabs | `admin-site-detail-tabs.e2e.ts` | ✅ |
| Analytics (CF traffic) | `analytics-cf-traffic.spec.ts` | ✅ |
| Billing + Stripe checkout | `stripe-link-inline-checkout.spec.ts`, `production-admin.spec.ts` | ✅ |
| Feature flags (on + off) | `admin-feature-flags.e2e.ts`, `admin-flag-gated.e2e.ts` | ✅ |
| Two-layer flag control plane (System Administrator + Features) | `admin-flag-control-plane.spec.ts` | ✅ |
| Forms builder | `forms-header-button.spec.ts`, `full-feature-coverage.spec.ts` | ✅ |
| Notifications bell | `notification-bell.e2e.ts` | ✅ |
| Rebuilt sections (Spartan) | `admin-rebuilt-sections.e2e.ts` | ✅ |
| Audit · api-tokens · pseo · seo · content-freshness · import · docs · traces · ai-endpoints · mcp · social · voice · media · apps · settings · user-settings · domains | `full-audit.spec.ts`, `full-coverage.spec.ts`, `full-feature-coverage.spec.ts`, `comprehensive.spec.ts`, `admin.spec.ts` | ✅ broad-suite |
| Super-admin console | `production-admin.spec.ts`, `full-audit.spec.ts` | ✅ |

## Components / states (cross-cutting)

| Feature | Spec(s) | Status |
|---|---|---|
| Dialog (focus-trap + Esc + restore) | `a11y-focus-trap.spec.ts`, `admin-dialog-keyboard.e2e.ts` | ✅ |
| Branded confirm dialog (ConfirmService — replaces native `confirm()` on all destructive actions; focus-trap + restore, no mutation on cancel) | `admin-confirm-dialog.e2e.ts` | ✅ |
| Branded input dialog (PromptService — replaces native `prompt()`; inline validation, focus-trap + restore) | `input-dialog.component.spec.ts` (unit: validation/submit) + shared overlay a11y via `admin-confirm-dialog.e2e.ts` | ✅ |
| Empty / loading / error / success states | `admin-error-states.e2e.ts`, `admin-section-states.e2e.ts`, `states-kit.spec.ts` | ✅ |
| Network honesty (no fake data) | `admin-network-honesty.e2e.ts` | ✅ |
| API contract (no dead/SPA-HTML endpoints) | `api-contract.e2e.ts` | ✅ |
| Marketing internal links (no 4xx/5xx) | `marketing-links.e2e.ts` | ✅ |
| JSON-LD accuracy (FAQPage only where visible; single route-accurate WebPage + BreadcrumbList, no duplicate/stale-homepage-url node) | `marketing-jsonld.e2e.ts` | ✅ |
| Admin interactions (clicks/keyboard) | `admin-interactions.e2e.ts`, `admin-functional.e2e.ts` | ✅ |
| Universal search (real nav, no fabricated rows) | `admin-universal-search.e2e.ts` | ✅ |

## Production smoke (live URL)

| Feature | Spec(s) | Status |
|---|---|---|
| Production build | `production-build.spec.ts` | ✅ |
| Production end-to-end flow | `production-flow.spec.ts` | ✅ |
| Production heyo create | `production-heyo.spec.ts` | ✅ |

## Accessibility / responsive gates (cross-cutting)

| Gate | Spec(s) | Status |
|---|---|---|
| Admin axe (desktop, all sections) | `admin-a11y.e2e.ts` | ✅ |
| Admin axe (mobile 390) | `admin-a11y-mobile.e2e.ts` | ✅ |
| Admin axe (param routes) | `admin-param-routes-a11y.e2e.ts` | ✅ |
| Admin 320px reflow | `admin-reflow.e2e.ts` | ✅ |
| Admin console / CSP / network clean | `admin-console-hygiene.e2e.ts` | ✅ |
| Admin sidebar logo-removed + clean console + editor mount | `admin-logo-console-editor.spec.ts` | ✅ |
| Admin form-control labels (WCAG 1.3.1/4.1.2 — webhooks/deliverability/domains) | `admin-form-labels.spec.ts` | ✅ |
| Marketing axe (9 public routes) | `marketing-a11y.e2e.ts` | ✅ |
| Marketing 390 axe + 320 reflow | `marketing-responsive.e2e.ts` | ✅ |
| Mobile layout (34 checks) | `mobile.spec.ts` | ✅ |

## Auth / permissions

| Feature | Spec(s) | Status |
|---|---|---|
| Sign-in flow (magic-link / OAuth) | `signin.spec.ts`, `journey-auth-admin.spec.ts` | ✅ |
| Sign-in console hygiene (homepage, /signin, /admin — zero errors) | `signin-green.e2e.ts`, `signin-real-chrome.e2e.ts` | ✅ |
| Bearer-auth sweep (no leaks) | `admin-auth-sweep.e2e.ts` | ✅ |
| Header auth state transitions | `header-auth-state.spec.ts` | ✅ |
| Auth-gated admin journey | `journey-auth-admin.spec.ts` | ✅ |

## Broad / regression suites

| Suite | Spec | Tests |
|---|---|---|
| Full audit | `full-audit.spec.ts` | 83 |
| Full coverage | `full-coverage.spec.ts` | 41 |
| Full feature coverage | `full-feature-coverage.spec.ts` | 35 |
| Full user simulation | `full-user-simulation.spec.ts` | 19 |
| Feature chains | `feature-chains.spec.ts` | 15 |
| Quality features | `quality-features.spec.ts` | 18 |
| Requirements | `requirements.spec.ts` | 14 |
| Comprehensive | `comprehensive.spec.ts` | 10 |

---

## Verified-done snapshot (live, this convergence wave)

- **a11y**: `marketing-a11y` + `marketing-responsive` (59) and `admin-a11y` +
  `admin-reflow` (46) = **105 axe/reflow assertions green** against prod.
- **Native dialogs**: zero `window.confirm()`/`prompt()` in live shipped frontend
  (branded `ConfirmService`/`PromptService`), except `voice/numbers.component.ts`
  (concurrent-session deferred) + dead `ai-chat-extras`.
- **Render XSS**: `agent-message` uses `marked → DOMPurify → bypass` (safe); other
  `[innerHTML]` are Angular-sanitized (no bypass).
- **Flag-gated sections** (site-dna 469 / trust-center 392 / enterprise 446 lines,
  inbox, stripe-app-status) are **real implementations, not stubs**; their
  **OFF-state is E2E-tested** (`admin-flag-gated.e2e.ts` — no org fetch + disabled
  message). **ON-state is built but not live-tested**: these flags are
  `default_enabled:0` and toggling them on requires a super-admin mutation against
  prod, which the E2E account can't/shouldn't do. ON-state coverage is therefore
  gated on a flag-toggle harness (tracked, not faked).

## Known gaps / blocked (honest — not faked)

- **`/status` + `/changelog` a11y** — these are **worker-served HTML**
  (`apps/project-sites/src/index.ts:513`, `changelog_public.ts`), not Angular
  components. Their `<title>`/lang/link-in-text-block fixes need a **worker
  deploy** (Docker daemon required: `open -a Docker` then deploy, or push →
  Workers Builds). Excluded from `marketing-a11y.e2e.ts` with an in-spec note.
- **`/search` contrast** — a transient loading-skeleton flash (settles clean);
  excluded from the gate to avoid flakiness (documented in `marketing-a11y.e2e.ts`).
- The dense admin sections (audit, pseo, seo, mcp, social, voice, etc.) are
  covered by **broad suites** (`full-audit`, `full-coverage`,
  `full-feature-coverage`). A future round can split these into per-section
  dedicated specs for finer-grained failure attribution.
- **Admin-upgrades-shell occluded on `/admin`** — the 600-line "30 upgrades"
  shell (`components/admin-upgrades/admin-upgrades-shell.component.ts`, hosted in
  `pages/admin/sections/dashboard.component.ts`) mounts ONLY on `/admin`, which is
  an editor route (`pages/admin/admin.component.ts:135` `isEditorRoute`), so the
  persistent `.bolt-frame--visible` iframe (z-stacking) is composited over the
  shell's topbar + FAB — they are present in the DOM but not click-reachable for a
  real user. The AI FAB (now real SSE) + share-toast fixes shipped and are
  bundle-verified by `admin-ai-fab.e2e.ts`, but exercising them via real clicks
  needs the shell re-mounted as persistent chrome ABOVE the iframe in
  `admin.component`, OR excluding `/admin` from `isEditorRoute`. The shell also
  duplicates real chrome (sidebar nav, `notification-bell.component`,
  `command-palette`, `ai-chat-widget`) — so "un-bury vs retire the shell" is a
  product/architecture decision, deferred (entangled with the persistent-iframe
  host; not changed unilaterally under concurrent sessions).

- **All feature flags ON + working** — `e2e/feature-flags-all-on.e2e.ts` — every registry flag resolves enabled (`/api/feature-flags/:key`); homepage + admin render clean (no app console errors) with all flags on.

## Admin-verification + signin/nav sweeps (convergence, authed real-browser)

- **admin audit grid** — `e2e/admin-audit-grid.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin console errors** — `e2e/admin-console-errors.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin docs prose** — `e2e/admin-docs-prose.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin forced colors** — `e2e/admin-forced-colors.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin nav links** — `e2e/admin-nav-links.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin notif bell keyboard** — `e2e/admin-notif-bell-keyboard.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin palette highlight** — `e2e/admin-palette-highlight.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin reduced motion** — `e2e/admin-reduced-motion.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin sidebar nav** — `e2e/admin-sidebar-nav.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin site detail** — `e2e/admin-site-detail.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin task tray** — `e2e/admin-task-tray.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **admin two layer settings** — `e2e/admin-two-layer-settings.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **analytics tabs** — `e2e/analytics-tabs.spec.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **developers** — `e2e/developers.spec.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **navbar site actions** — `e2e/navbar-site-actions.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **pricing** — `e2e/pricing.spec.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **share link** — `e2e/share-link.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **signin chrome** — `e2e/signin-chrome.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **signin clean** — `e2e/signin-clean.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **signin console check** — `e2e/signin-console-check.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).
- **signin final** — `e2e/signin-final.e2e.ts` — authed admin/marketing real-browser sweep (convergence mandate).

## E2E suites (inventoried AL-134)

Machine-mirrored in `e2e/COVERAGE.yml`. These per-feature flow + chaos/resilience suites
run via `playwright.prod.config.ts`.

### Full-flow suite — `flows-*.flow.e2e.ts` (37)
- flows-activity.flow.e2e.ts
- flows-ai-chat.flow.e2e.ts
- flows-ai-endpoints.flow.e2e.ts
- flows-analytics.flow.e2e.ts
- flows-annotations.flow.e2e.ts
- flows-apps.flow.e2e.ts
- flows-auth-admin.flow.e2e.ts
- flows-auth-security.flow.e2e.ts
- flows-billing.flow.e2e.ts
- flows-branches.flow.e2e.ts
- flows-budget.flow.e2e.ts
- flows-create.flow.e2e.ts
- flows-credits.flow.e2e.ts
- flows-dashboard.flow.e2e.ts
- flows-docs.flow.e2e.ts
- flows-domains.flow.e2e.ts
- flows-editor.flow.e2e.ts
- flows-forms.flow.e2e.ts
- flows-logs.flow.e2e.ts
- flows-marketing.flow.e2e.ts
- flows-onboarding.flow.e2e.ts
- flows-readiness.flow.e2e.ts
- flows-referral.flow.e2e.ts
- flows-settings.flow.e2e.ts
- flows-shell-widgets.flow.e2e.ts
- flows-site-features.flow.e2e.ts
- flows-snapshots.flow.e2e.ts
- flows-social.flow.e2e.ts
- flows-sparkline.flow.e2e.ts
- flows-states.flow.e2e.ts
- flows-super-admin.flow.e2e.ts
- flows-tags.flow.e2e.ts
- flows-team-tokens.flow.e2e.ts
- flows-usage.flow.e2e.ts
- flows-voice.flow.e2e.ts
- flows-webhooks-crud.flow.e2e.ts
- flows-webhooks.flow.e2e.ts

### Chaos / resilience suite — `chaos-*.e2e.ts` (19)
- chaos-1-visitor.e2e.ts
- chaos-10-admin-header-overlays.e2e.ts
- chaos-11-domains.e2e.ts
- chaos-12-forms-count.e2e.ts
- chaos-13-audit-count.e2e.ts
- chaos-14-ai-logs-count.e2e.ts
- chaos-15-apps-catalog.e2e.ts
- chaos-15-editor-journey.e2e.ts
- chaos-16-apps-instances.e2e.ts
- chaos-17-voice-config.e2e.ts
- chaos-18-template-build-journey.e2e.ts
- chaos-2-builder.e2e.ts
- chaos-3-auth.e2e.ts
- chaos-4-admin.e2e.ts
- chaos-5-resilience.e2e.ts
- chaos-6-conversion-i18n.e2e.ts
- chaos-7-analytics-tabs.e2e.ts
- chaos-8-keyboard-focus.e2e.ts
- chaos-9-mobile-responsive.e2e.ts

### Admin + misc e2e (10)
- admin-clickaround-errors.e2e.ts
- admin-navigation-responsive.e2e.ts
- admin-section-h1.e2e.ts
- admin-settings-folded-tabs.e2e.ts
- admin-settings-general-merge.e2e.ts
- admin-settings-mcp-aivars.e2e.ts
- admin-token-lifecycle.e2e.ts
- admin-traces-grid.e2e.ts
- homepage-disclosure-a11y.e2e.ts
- roadmap.e2e.ts
