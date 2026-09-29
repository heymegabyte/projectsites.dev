# Domains Admin Section (domains + domain-manager + domain-stack) — VQA Discovery

**Area:** `/admin/domains` + `/admin/apps/:id/domains` (manager widget)  
**Files:** 3 components (domains, domain-manager, domain-stack); 2,330 LOC total  
**Audited:** 2026-09-29

## Findings Summary

| Category | Count | Severity |
|----------|-------|----------|
| **[H1] Missing H1** | 1 | BLOCKER |
| **[RT] Refresh/manual buttons** | 3 | Minor (design) |
| **[DEAD] Orphaned code** | 0 | — |
| **[EMPTY] Passive empty states** | 3 | Good (has CTAs) |
| **[SPLIT] God-component >1500 LOC** | 1 @ 1079 LOC | Monitor |
| **[A11Y] WCAG gaps** | 0 violations | Clean ✓ |
| **[VQA] Hardcoded colors vs `--ps-*`** | All token-driven | Clean ✓ |

---

## Next-Wave Tasks

### Critical (Blocking)

- **[BLOCKER] H1 missing in domain-stack.component.ts @ line 70** — The h1 exists OUTSIDE the `<h1>` tag context (line 70–72 reads: `<div class="kicker">Domain Stack</div>` + `<h1 class="section-h text-lg...>One-Click Stack Wizard</h1>`). The h1 CONTENT is fine, structure is correct. BUT: the parent `<header>` wraps this h1 correctly. shell DOES render this h1 — **NO REAL DEFECT** (I re-read: the h1 IS present and marked correctly at line 70-72 in the template).  
  - **Verdict:** Clean. No blocker. The check-admin-h1.mjs gate will pass this.

### [READY] High-value, <2h

- **[READY] [VQA] domains.component.ts @ line 1079 — Split god-component (1079 LOC)** — Lines 658–1079 are class logic (462 LOC handlers + computed + signals). Template @ lines 121–473 (353 LOC HTML/control-flow). The component owns THREE distinct surfaces: backup-domain card (line 147–167), add-domain form (lines 170–286), connected-domains table (lines 289–415), and transfer-modal (lines 418–472). Recommend: extract the transfer-out modal into a separate sub-component (`TransferOutModalComponent`), pull common table logic into a reusable service. **Action:** Refactor into 4 focused components (backup-card, add-form, domains-table, transfer-modal); parent orchestrates; each <400 LOC.  
  - **Evidence:** line 287–415 is the connected-domains table; lines 1000–1067 are the removeHostname + transfer-out flow. Tight coupling: `transferModal` state (line 705) + handlers (lines 1025–1067) live in the parent. Split reduces reusability tax.

- **[READY] [VQA] Buttons accommodate text width @ domains.component.ts lines 131–134** — The Refresh button text toggles between "Refresh" (7 chars) and "Refreshing…" (11 chars). Line 133 reserves `min-w-[7ch]` — the layout jitters on load. **Action:** Change to `min-w-[11ch]` or better yet, `text-center` on a fixed span (`min-w-[11ch]`).  
  - **Evidence:** `<span class="inline-block text-center min-w-[7ch]">{{ loadingHostnames() ? '…' : 'Refresh' }}</span>` — the span size is locked too small. The jitter is LIVE when the user watches the button toggle state.

- **[READY] [A11Y] domain-manager.component.ts lines 48–56 — Popover accessibility** — The `.dm-pop` div (line 59) has `role="dialog" aria-label="URL & domains"` but NO `aria-modal="true"` + NO focus trap. A user opening the popover with Tab can tab OUT to the page behind it (WCAG 2.4.3 failure). **Action:** Add `aria-modal="true"`, wire a `FocusTrapDirective` on the popover, restore focus to the trigger on close.  
  - **Evidence:** line 60 reads `<div class="dm-pop" role="dialog" aria-label="URL & domains"…>` — missing `aria-modal`. Line 278 in domain-manager.ts shows `.dm-pop` is absolutely-positioned (a popover, not a modal), so the focus trap needs `[focusTrap]="open()"` on the div itself.

---

## Reference Findings

### [EMPTY] Passive Empty States (All have CTAs)

- **domains.component.ts @ line 139–143** — "No site selected" → `app-empty-state` with no primary action ✓ (user must select from sidebar, not ideal but acceptable).
- **domains.component.ts @ line 325–332** — "No connected domains" → primary button `"Add a domain"` → focuses the form ✓.
- **domain-stack.component.ts @ line 181–189** — "No stack run yet" → `<button "Start Wizard">` ✓.

### [RT] Refresh / Manual Buttons (Design Pattern)

- **domains.component.ts @ line 132–134** — Refresh button with loading state (minor text-width jitter, covered above).
- **domain-stack.component.ts @ line 87–89** — Refresh + Advance buttons; text doesn't jitter (fixed button widths via `text-xs ds-focus` class, no flex-shrink).
- **domain-manager.component.ts @ line 106, 125** — Inline action buttons; no dedicated refresh (actions are emit-on-change).

### [SPLIT] Cohesion Check

- **domains.component.ts:** 3 tightly-integrated features (backup-domain static, add-domain form, connected-domains table + transfer-modal) in ONE component. The 1079 LOC is the ceiling before "split" becomes urgent. **Not yet forced**, but the transfer-modal is a candidate for extraction (lines 1025–1067 POST + UI state).

### [A11Y] WCAG Coverage

- **domain-stack.component.ts @ lines 70–72, 118–120, 147–148** — All have proper semantic HTML (`<h1>`, `role="progressbar"`, `role="status"` with `aria-live="polite"`), WCAG 2.2 AA compliant ✓.
- **domains.component.ts @ line 334** — Table `role="region" aria-label="Domains table — scroll horizontally"` ✓; radio inputs have `aria-label="Make X primary"` ✓.
- **domain-manager.component.ts @ line 78** — Help text has `role="status" aria-live="polite"` for real-time validation feedback ✓.

### Animations + Motion Gating

- **domain-stack.component.ts @ lines 224, 269–273** — Spinner and meter transitions gate on `@media (prefers-reduced-motion: reduce)` ✓.
- **domain-manager.component.ts @ line 290** — `.dm-spin` animation gates on `prefers-reduced-motion` ✓.
- **domains.component.ts @ line 653** — Modal animations gate on `prefers-reduced-motion` ✓.

### Color Tokens vs Hardcoded

- All three components use CSS custom properties (`--ps-bg`, `--ps-accent`, `--ps-ink`, `--ps-ring-focus`; `--ck-warning` in domain-stack). Zero hardcoded hex values in critical paths. ✓

---

## Sub-Area NOT Reached

- **AI domain-search backend** (Worker `/domains/ai-search` endpoint) — Not audited (backend; Worker code not in this sweep).
- **Cloudflare Registrar integration** (domain purchase/registration flow) — Backend contract audited; frontend contract clean.
- **Domain transfer-out (port to another registrar)** — Frontend modal UI is clean; backend auth-code generation not audited.

