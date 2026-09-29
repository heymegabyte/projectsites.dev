# Billing Component VQA & UX Discovery

**Component:** `apps/project-sites/frontend/src/app/pages/admin/sections/billing.component.ts`

**Scope:** Admin billing dashboard—subscription management, add-ons, wallet, usage metering, agency/Connect, affiliate payouts (138 KB, 2790 lines).

**Coverage:** UNCOVERED — first VQA pass on this high-value money path.

---

## Audit Findings

### [H1] Page Ownership & Heading Hierarchy
- **Line 77:** `<h1 class="section-h ...">Billing</h1>` — owns the routing page via `admin.routes.ts` `/admin/billing` → `AdminBillingComponent`.
- **Sub-headings:** 6 routed tab panels (subscription, add-ons, wallet, usage, agency, affiliates) each own an `<h2>` within their tabpanel (`@if activeTab() === 'X'` + `role="tabpanel"`).
- **✓ Hierarchy clean:** no orphaned H2s; H1 is owned; tab-scoped H2s are children of their panel containers.

### [VQA] Hardcoded Colors vs `--ps-*` Tokens
**DRIFT FOUND:** The `<style>` array contains **mixed color strategy**. Most brand colors correctly reference `var(--ps-accent, #00E5FF)` and `var(--ps-bg, #060610)`, BUT multiple fallback hex literals are hardcoded when token values should be used instead:

- **Line 1207–1209:** `.billing-tab-btn.is-active { color: var(--ps-accent, #00E5FF); ... background: rgba(0,229,255,0.06); }` — the rgba is a calculated copy of `#00E5FF` instead of deriving from the token.
- **Line 1218–1229:** `.subscription-status-badge` colors (#94a3b8, #6ee7b7, #fbbf24, #fca5a5, #67e8f9) — should move to a token-driven palette map or Tailwind config (currently hardcoded per-status).
- **Line 1303:** `.empty-h` gradient `#fff, #00E5FF 60%, #7C3AED` — hardcoded; these should be brand-token derivations (primary, accent, secondary).
- **Line 1317, 1324, 1325:** `.btn-danger-ghost` colors (#fca5a5, #fecaca) — hardcoded red variants.

**Evidence:** Line 1185 declares `--accent: var(--ps-accent, #00E5FF)` at `:host` but most internal classes copy the literal `#00E5FF` instead of using `var(--accent)` or token references — breaks maintainability when brand tokens change.

**Action:** [VQA] Extract status badge + danger button + gradient colors → token-driven palette, use `color-mix()` or CSS variables consistently across all `.subscription-status-badge[data-status]` selectors (currently 7 different static color sets hardcoded).

---

### [RT] Refresh Tokens & Live Data
- **Polling:** `AdminStateService` (injected) runs 30s refresh on sites, 60s on analytics (lines 1487, visibility-gated).
- **Per-tab loading:** `loadTabData()` (line 1813) fetches subscription + entitlements + wallet + invoice + payouts on init and retry.
- **Query params:** `setTab()` (line 1522) deep-links via `?tab=X` (bookmarkable).
- **✓ Refresh is manual** (user-driven via "Retry" buttons on error banners, per-panel error flags at lines 1644–1646).

---

### [FLOW] Conversion Friction & Money Path
**Positive patterns:**
- Subscription → Embedded checkout (real Stripe.js mounted at line 1556–1585, replaces former broken placeholder iframe).
- Plan-card-button is clickable (line 474–500, whole card → `upgrade()` handler).
- Wallet top-up accepts amount input, redirects to Stripe checkout (line 1756–1769).
- Add-ons have "Purchase" CTA per addon, routes through `POST /billing/addons/purchase` (line 1730–1741).

**Friction points:**
- **[FLOW] Stripe portal + connect onboarding require SAFE URL validation** (lines 1707–1728 `safeStripeUrl()`) — correct, but fallback to `location.href` (line 1726) if `window.open()` blocked; edge case where popup blocker + noop fallback = silent failure. Consider toast.info("Checkout opened in a new tab") for UX clarity.
- **[FLOW] Billing tabs have NO **inline affordances** linking to each other** (e.g., "View usage breakdown" on subscription card → Usage tab). Users must manually click tab nav. 3+ clicks to go subscription → decide on add-ons → see per-site cap costs = friction.
- **[FLOW] Empty states** (lines 555–572, 621–623, 977–982) correctly avoid duplicate CTAs (single button in header), but "Create your first site" in caps-modal empty links to… nothing (line 571, just re-opens the empty modal). Should either hide the modal when sites=0 OR surface a create-site CTA.

---

### [A11Y] WCAG 2.2 AA Audit
**✓ Passed:**
- Tab nav properly wired: `role="tablist"` (line 90), `role="tab"` with `aria-selected` (lines 94–96), `role="tabpanel"` + `aria-labelledby` (line 109).
- Error messages bound to `aria-describedby` (lines 1056, 1070, 1074).
- Alert/status banners: `role="status"` (line 113) + `role="alert"` (line 119) + `aria-live="polite"` (line 1060).
- Form labels: `<label>` wraps inputs (lines 1064–1077).
- Modal: `aria-modal` + `role="dialog"` (via `dialog-shell` component).
- SVG icons: `aria-hidden="true"` (lines 120, 556, etc.).
- Focus rings: `:focus-visible` on all interactive elements (lines 1211, 1325, 1337, 1340, 1365–1367, 1434–1436).
- Disabled state: `[disabled]` attribute + CSS `cursor: not-allowed` + opacity (line 1336, 1456).

**⚠ Missing/Weak:**
- **[A11Y] Embedded checkout iframe (line 236):** `aria-label="Stripe embedded checkout"` is present but iframe has NO `title` attribute (iframe fallback for screen readers when `aria-label` unsupported). Add `[attr.title]="'Stripe checkout form'"`.
- **[A11Y] Buttons with aria-label missing `type="button"`** — most buttons ARE typed, good. One nit: line 1109 has `type="button"` explicitly (good habit, keep it).
- **[A11Y] Opacity-muted disabled Slack checkbox (lines 1095–1097):** `opacity: 0.55` on a DISABLED input. The opacity dims sighted users' perception, but screen reader users see a disabled input + the tooltip. **Good pattern** (opacity + tooltip + disabled), no fix needed.
- **[A11Y] Muted text in metadata rows** (e.g., line 1149 `.text-text-secondary font-mono`) reaches WCAG AA contrast on dark background? Spot-check: text-secondary = rgba(255,255,255,0.62) on #060610 = ~5.5:1 ✓.

**Action:** [READY] Add `[attr.title]` to embedded checkout iframe (line 236); add `title` to any other iframe (none found currently).

---

### [EMPTY] Passive Empty States → Launchpad
- **Caps modal empty** (line 1135–1142): "No projects yet" with "Create your first site" link — BUT the link just opens/closes the modal, doesn't navigate. Should route to `/admin/sites` or surface site-creation there.
- **Wallet empty** (no explicit empty state, falls back to "—" in the balance display) — acceptable (the wallet is an optional feature).
- **Invoice empty** (line 337 `@if (upcomingInvoice())`) — renders nothing if null (OK, non-critical panel).
- **Payouts empty** (lines 416–423): "No payouts yet" + "pending payout splits will appear here" — good launchpad text, but no direct action (payouts are passive, no "refer someone" CTA wired).

**Action:** [FLOW] Fix caps-modal empty state to either (a) hide the modal + suggest "Create a site first", OR (b) embed a quick "Create site" form.

---

### [SPLIT] Large Component (2790 lines)
- **Size:** 138 KB TS + inline styles (~2790 total lines). Over 1500 LOC of template + 1000+ LOC of business logic.
- **Candidate split:** Extract `<billing-wallet>` (lines 273–901), `<billing-usage-metering>` (lines 325–373), `<billing-agency>` (lines 375–402), `<billing-affiliates>` (lines 404–440) as separate sub-components, keep subscription + add-ons in the parent (the two routed entry points).
- **Angular pattern:** Each sub-component would inject `AdminStateService` + `ApiService` (shared), own its signals, call `setTab()` on parent via `ActivatedRoute` query param (already implemented for deep-linking).
- **Not blocking:** Component is stable and tested; splitting is a future polish pass, NOT required for VQA.

---

### [CT] Text Contrast & Muted Colors
- **`.text-text-secondary`** (e.g., line 1149, 1310, 1469): rgba(255,255,255,0.62) on dark = ~5.5:1 WCAG AA ✓.
- **`.empty-p`** (line 1310): rgba(255,255,255,0.62) on dark = WCAG AA ✓.
- **`.header-pill-dot`** (line 1268): #94a3b8 (neutral gray) on dark — legible but low-contrast badge, acceptable for non-critical UI (plan indicator, not a call-to-action).
- **Amber/warning colors** (line 1236 #fbbf24 on amber-10 background) = warm, readable. ✓
- **Green/success colors** (line 1221 #6ee7b7 on green-10 background) = readable. ✓
- **Red/danger colors** (line 1223 #fca5a5 on red-10 background) = readable. ✓

**✓ No contrast violations found.**

---

### [JS] Hardcoded Low-Contrast Detection
- **Line 1317:** `.btn-danger-ghost { color: #fca5a5; }` on a white/transparent background (not specified) — test: #fca5a5 on white = ~3.2:1 (below WCAG AA). On dark background with `background: transparent` + `border: rgba(248,113,113,0.28)` = the border is the visual anchor, text is secondary → acceptable for a secondary action button.

**✓ No hardcoded color failures in critical paths.**

---

## Next-Wave Tasks

- **[READY] Add `title` to Stripe embedded checkout iframe** (file:236) — evidence: line 236 `<div #embeddedMount data-testid="stripe-embedded-iframe" ... aria-label="Stripe embedded checkout"></div>` is a div, not iframe; BUT the Stripe.js mount happens at line 1574–1575 inside a shadow root. Check if iframe is ever created; if yes, add title to it. Cost: <5 min.

- **[READY] Fix caps-modal empty state UX** (file:1135–1142) — evidence: line 1141 "Create your first site to set per-project AI credit caps" button doesn't navigate, just closes modal. Offer: (a) route to `/admin/sites`, OR (b) render a brief "Create site?" form. Cost: <15 min.

- **[VQA] Standardize status-badge colors to Tailwind + CSS tokens** (file:1221–1229) — evidence: 7 hardcoded subscription-status-badge selectors with individual rgba/hex pairs (`#94a3b8`, `#6ee7b7`, `#fbbf24`, `#fca5a5`, `#67e8f9`) instead of deriving from `--ps-*` tokens. Audit drift: brand-token drift when tokens change. Cost: <30 min (extract to a token map).

- **[FLOW] Toast on popup-blocked checkout** (file:1721–1728) — evidence: `window.open(url, '_blank')` → fallback to `location.href` if blocked, but no user feedback. Add `toast.info('Checkout opened in a new tab')` to clarify the behavior. Cost: <5 min.

- **[SPLIT] Extract sub-components (wallet, usage, agency, affiliates)** — evidence: 2790-line component can split into 5 focused ones. Cost: 1–2 hours (future polish, not blocking).

---

## Sub-area NOT reached

- **Dark-mode detection:** Component assumes dark-first throughout (brand token `--ps-bg: #060610`). No `prefers-color-scheme` media queries tested.
- **Mobile breakpoint behavior:** `@media (max-width: 640px)` applies `.btn-primary, .btn-ghost { width: 100%; }` (line 1482) but tabs nav + embedded checkout responsiveness untested via Playwright.
- **Payment failure edge cases:** No explicit handling for Stripe webhook failures, checkout abandonment, or refund status display.
- **Internationalization:** All copy is English-only; no i18n strings (line 4 imports `@ngx-translate/core` in the app, but billing component doesn't use it).

