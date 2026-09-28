# Admin Visual-Perfection + Growth Ledger

> Steers the **admin dashboard loop** (cron `7,22,37,52` = every 15 min, job `05611680`) AND future loops.
> Externalized state (Ralph): each fire reads this FIRST, inspects ONE admin surface live in a real browser
> (image recognition + screenshots), then **FIXES + IMPROVES + ADDS a new component**, re-verifies on prod,
> and records its new score + generalized rules + fresh RECOMMENDATIONS here. Never assume a prior fire
> landed — re-inspect live every fire. Keep this file current; it is the loop's memory.

## GOAL (generative — never "done")
Every `/admin/*` page (Angular SPA, `apps/project-sites/frontend/`) → continuously more **gorgeous +
technically excellent + functional** — fully functional · useful · concise · simple · beautiful · intuitive
· easy. Fix bugs + console errors, THEN improve an existing component, THEN add a NEW one. Perfection floor =
a busy non-technical owner succeeds on the FIRST try, no manual, no question (embarrassingly-easy). The loop
is CONTINUOUS: there is always a next improvement; it never CronDeletes itself.

## SCORING RUBRIC (0–10 each; a surface is "excellent" at ≥9/10 on ALL — but keep improving past it)
1. **Functional** — every button/form/link/modal/shortcut works when clicked (proven in-browser, not assumed).
2. **Useful** — the page does real work the owner needs; no dead/vanity surface.
3. **Concise** — no clutter; one obvious primary action per screen; ≤3 steps to any outcome.
4. **Simple** — zero-config smart defaults; AI prefills/suggests rather than making the user configure.
5. **Gorgeous** — black `#060610` + cyan `#00e5ff`, Spartan UI, tokens in `frontend/src/styles/_polish.scss`; ZERO white/gray/blue/orange/mint drift; cinematic-but-tasteful motion (INP ≤100ms); `prefers-reduced-motion`.
6. **Intuitive** — the next step is self-evident; the user's words, never our jargon (org/entitlement/manifest).
7. **Easy** — instant feedback + undo; empty states are first-action launchpads; never a doomed/dead control.
8. **Sound** — 0 console errors, axe 0 at 6bp + WCAG 2.2 manual criteria, no lying-empty data (display reconciles with D1), buttons don't resize on label change.

## INSPECTION RECIPE (per fire — authed PROD, headless)
- Standalone Playwright script that LIVES in `apps/project-sites/frontend/` (needed to resolve `@playwright/test`),
  reads `E2E_API_KEY` from env (NEVER inline the token), seeds localStorage BEFORE navigating:
  `ps_session = {token:<KEY>, identifier:'test@megabyte.space', createdAt:Date.now()}`. For operator surfaces
  (feature-flags, kv/r2/vectorize/queues inspectors, leads, system-services) also seed
  `ps_user = {…, is_super_admin:true}`. Run: `E2E_API_KEY="$(/Users/Apple/.local/bin/get-secret E2E_API_KEY)" node apps/project-sites/frontend/<script>.mjs`.
  Config precedent: `playwright.prod.config.ts` (baseURL `https://projectsites.dev`, 60s timeout, 2 retries).
- CF Browser Rendering (no Docker) or Playwright MCP fallback. Homepage-start → navigate BY CLICKS (no `goto` after load).
- Full-page screenshots at **6 breakpoints** (375/390/768/1024/1280/1920) → `admin-vqa/<page>/<bp>.png`, THEN `Read` the PNGs (image recognition) + judge ≥9/10.
- Gate: console = 0 errors; note every failed request; walk the a11y tree; CLICK every interactive element to prove function.
- ⚠️ **The E2E test-org is currently EMPTY (0 sites, post-reset)** → most data surfaces show empty states. To inspect POPULATED
  states, create a throwaway draft via `POST /api/sites {business_name}` on the **workers.dev** host (`project-sites.manhattan.workers.dev`, bypasses bot-fight) with `Authorization: Bearer $E2E_API_KEY`, inspect, then `DELETE /api/sites/:id`. Empty states are still in-scope (they must be launchpads).

## FIX + IMPROVE + ADD ORDER (do MORE than fix)
1. **FIX** defects: broken/doomed controls, console/CSP errors, off-brand color, cramped copy, missing empty/loading/error states, axe 6bp + WCAG 2.2 manual, lying-empty data, label-resize buttons.
2. **IMPROVE** an existing component: cinematic motion (View Transitions/scroll-driven/`@starting-style`, reduced-motion-gated), bento/asymmetry, glass+grain, refined fluid type, real-time self-updating data (remove manual Refresh/Reconcile buttons).
3. **ADD** a NEW component behind a feature flag (`enabled=0, rollout=0, stage=experimental`) + Zod + manifest + tests. Reuse `DialogShellComponent` + design tokens (custom = drift).
4. TDD: add/extend a Playwright spec reproducing then LOCKING each fix/feature.
5. Verify: `cd apps/project-sites/frontend && npm run check && npm run build:prod` + re-inspect in browser (0 console errors, axe-clean 6bp, screenshots prove it, every control works) → deploy R2 (`npm run deploy:production`, prod pre-authorized) → prod-verify the LIVE authed page. 6. Commit+push per fire (main-only; rebase over concurrent commits; delete worktree+branch when work lands). NEVER touch payments/auth/secrets/destructive (approval-tier) — surface as Recs.

## LOOP DISCIPLINE (per `_LOOP_CHARTER.md`)
One coherent slice per fire · complete real-user journey · progressive enhancement across the five dimensions
(feature · enhance · debug · error-handling · log/trace) · faster pace via **4-6 PARALLEL agents** where
independent (per-breakpoint capture · per-defect fix · per-component build) · isolate mutating work in a git
worktree, merge only on green gates · classifier outage (Bash/Agent refused) → Read/Write/Edit + GitHub MCP,
checkpoint, next fire continues (never hammer, never start a large pass in a saturated session). Scope = ADMIN
only; the bolt.diy editor is a SEPARATE surface (see `editor-vqa/`) with its own loop.

## PAGE INVENTORY  (from repo scan `app.routes.ts` — first fire verifies live + fills scores)
| Route | Component | Score | Status |
|---|---|---|---|
| `/admin` (dashboard / getting-started hub) | dashboard.component | ? | unvisited |
| `/admin/editor` | editor.component (bolt iframe — light-touch only) | ? | unvisited |
| `/admin/sites/:id` (+ /branches /mcp-server /copilot /dna) | site-detail | ? | unvisited |
| `/admin/analytics` (+ `?tab=social`) | analytics.component | ? | unvisited |
| `/admin/billing` | billing.component | ? | unvisited |
| `/admin/forms` | forms.component | ? | unvisited |
| `/admin/domains/:id/stack` | domain-stack | ? | unvisited |
| `/admin/logs` (+ `?tab=traces`) | logs.component | ? | unvisited |
| `/admin/deliverability` | deliverability.component | ? | unvisited |
| `/admin/voice` | voice.component | ? | unvisited |
| `/admin/settings` (+ `#mcp` `#ai-chat`) | settings subtree | ? | unvisited |
| `/admin/user` | user-settings | ? | unvisited |
| `/admin/team` · `/admin/accept-invite` | team.component | ? | unvisited |
| `/admin/snapshots` (+ /diff) | snapshots.component | ? | unvisited |
| `/admin/apps` · `/apps/instances[/:id]` · `/apps/:id` | apps store | ? | unvisited |
| `/admin/social` (+ /analytics) | social.component (32.8KB — split) | ? | unvisited |
| `/admin/site-features` (`/admin/seo` alias) | site-features | ? | unvisited |
| `/admin/feature-flags` (operator) | feature-flags.component | ? | unvisited |
| `/admin/kv-inspector` · `r2-inspector` · `vectorize-inspector` · `queues-inspector` (operator) | inspectors | ? | unvisited |
| `/admin/leads` · `/admin/system-services` (operator) | operator surfaces | ? | unvisited |
| `**` catch-all | not-found.component (styled 404 in shell) | ? | unvisited |
> Scope = ADMIN only. Aliases (`/admin/mcp`→settings#mcp, `/admin/ai-chat`→settings#ai-chat, `/admin/traces`→logs?tab=traces) are functional redirects.

## RECOMMENDATIONS BACKLOG  (seeded from the 2026-09-28 repo+doc scan — fires PULL from + APPEND to this)
Each fire: pick from here OR the lowest-scoring page; then append every new idea you notice (value · rough cost).

### Visual polish
- [ ] **Bento/asymmetric dashboard grid** — hero summary card + list-card pairs vs uniform 2-col. (high value · ~1-2h)
- [ ] **Status-badge motion** — opacity/glow pulse on `building`, fade on terminal (`published`/`error`); reduced-motion-safe. (med · ~45m)
- [ ] **Glass + grain on card headers** over the cyan accent splash; SVG noise overlay on brand hero. (med · ~1h)
- [ ] **Refined fluid type ramp** — `clamp()` 48/24/16, `text-wrap:balance` headings, `-0.5%` tracking. (med · ~45m)
- [ ] **Scroll-driven section reveals** (Chrome 133+) with `@starting-style` fallback, reduced-motion-gated. (med · ~1h)

### Technical
- [ ] **Per-section error boundaries** — each panel (forms/snapshots/billing/domains/analytics) fails independently, never white-screens. (high · ~1-2h)
- [ ] **Skeleton→done loaders** matching final layout (≤3-bounce anim, reduced-motion stalls at skeleton). (high · ~1h)
- [ ] **axe-core 6bp spec** wired into `e2e/` (none exists today) + WCAG 2.2 manual checklist per page. (high · ~1-2h)
- [ ] **Real-time self-updating surfaces** — audit every list/count/status for manual Refresh/Reconcile buttons → replace with visibility-aware poll / SSE (per real-time-data rule). (high · ~1-2h/page)
- [ ] **Split `social.component.ts`** (32.8KB > 28KB budget) into lazy subsections. (low · ~1h)

### Functional (new components + enhancements)
- [ ] **Cmd+K palette expansion** — search sites/flags/settings/docs/nav, ranked by recent+relevance. (high · ~2h, flag)
- [ ] **Notifications bell refinement** — build %+ETA, unread messages, system alerts; paginate >10. (high · ~2h, flag)
- [ ] **Persistent AI chat with site-error context** — dock survives sub-routes; "why is my site failing?" reads the current site's error log. (high · ~2-3h, flag)
- [ ] **Billing clarity** — MRR / next-invoice / masked method / seat-usage, single upgrade CTA. (med · ~1-2h)
- [ ] **Domain-manager clarity** — copyable CNAME chips + status badges (pending/active/failed), drag-reorder redirects, auto-retry. (med · ~2h)
- [ ] **Branded empty-state launchpads** per section (empty sites→create, empty analytics→first-build hero). (high · ~1h/section)

## OPEN ISSUES  (fires append; newest first)
_(empty — first fire fills)_

## "WHAT PERFECTION NEEDS"  (running AI judgment that steers ALL loops — fires append generalized rules)
- Every page: one dominant primary CTA, brand-locked cyan/black, 0 console errors, empty-state-as-launchpad.
- AI does the work, the user confirms — prefill/auto-detect over configuration (embarrassingly-easy mandate).
- Reconcile every data surface against D1 ground truth — a clean-rendering empty can be lying-empty.
- Do MORE than fix: every fire also improves an existing component AND/OR adds a new one; the admin GROWS.
- _(fires append: concrete, generalized rules discovered during inspection)_

## VERIFICATION LOG  (fires append: page · old→new score · fixes/improvements/additions · screenshots · prod-verify result)
_(empty — first fire fills)_
