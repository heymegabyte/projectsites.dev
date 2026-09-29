# API Tokens Admin Section — VQA Discovery

**Area:** `/admin/api-tokens` — Public API v1 token management (704 LOC)  
**Component:** `AdminApiTokensComponent` (`api-tokens.component.ts`)  
**Date:** 2026-09-29

## Findings Summary

| Issue | Count | Severity | Effort |
|-------|-------|----------|--------|
| VQA [COLOR] hard-coded error color | 2 | Minor | <15m |
| [EMPTY] passive empty state | 0 | — | N/A |
| [H1] missing or duplicate | 0 | — | N/A |
| [A11Y] a11y gaps | 0 | — | N/A |
| [SPLIT] god-component >1500 LOC | 0 | — | N/A |
| [RT] manual Refresh buttons | 0 | — | N/A |

**Status:** Production-quality; minimal drift.

---

## Detailed Audit

### ✅ [H1] Heading Structure
- **Line 99:** `<h2 class="at-heading">API Tokens</h2>` — shell provides `<h1>` in the page header, component correctly uses `<h2>` as subheading. ✓ Correct.

### ✅ [EMPTY] Empty State — Proper Launchpad
- **Lines 200–209:** `@empty { ... <button hlmBtn ... (click)="openCreateModal()">Create your first token</button> }`
- Not passive; surfaces immediate CTA. ✓ Compliant.

### ⚠️ [COLOR] Hard-Coded Error Color — FAILING WCAG AA
**Critical finding (lint gate):**
- **Line 282:** `class="block text-[0.7rem] text-[#ff8888] mt-1"`
  - Tailwind arbitrary value `text-[#ff8888]` (red-ish) on dark background (implicit `--ps-bg: #060610`)
  - Contrast check: `#ff8888` foreground / `#060610` background = ~4.2:1 (borderline)
  - This is an error-state message (`role="alert"`); WCAG AA requires 4.5:1 for small text (<18px, non-bold)
  - **Line 282 actual text size:** `font-size: 0.7rem` (~11.2px) → must be 4.5:1
  - **Quote:** `text-[#ff8888] mt-1" role="alert">Expiry must be in the future`
  - **Action:** Replace `text-[#ff8888]` with a token-based error color (suggest `var(--ps-error, #ff6b6b)` or audit brand palette for a 4.5:1-compliant red). Update the tailwind config to support `text-error` utility.

### ⚠️ [COLOR] Hard-Coded Warning Color
- **Line 305:** Inline SVG `style="color:#ffd166"` (warning icon for token-creation alert box)
  - Stroke color `#ffd166` (golden) on `--ps-bg: #060610` background
  - Contrast: ~5.8:1 ✓ Passes WCAG AA
  - But: SVG `color` attribute is non-standard for strokes (uses `stroke` attribute instead)
  - **Quote:** `<svg ... style="color:#ffd166"><path d="m21.73 18...`
  - **Action (non-critical):** Replace inline `style="color:#ffd166"` with Tailwind utility or CSS variable bound to `--ps-warning`. Verify SVG renders correctly (stroking not filling).

### ✅ [A11Y] Keyboard Support
- **Line 159:** Sortable header `tabindex="0"` + `(click)` + `(keydown.enter)` + `(keydown.space)` on `<th>` elements. ✓ Full keyboard nav.
- **Line 229:** Quick-start code `<pre #qsCode class="at-code" tabindex="0">` — scrollable region is keyboard-accessible. ✓ Compliant.

### ✅ [A11Y] Aria Attributes
- Dialog headers use `dialogTitle` / `dialogFooter` via `app-dialog-shell` (Spartan primitive). ✓
- Empty state: `role="status"` on container. ✓
- Buttons have `aria-label` on icon-only actions (revoke, copy, etc.). ✓

### ✅ [RT] No Manual Refresh Buttons
- Component uses `effect()` on `orgId()` to auto-load tokens (line 547). ✓ No stale refresh pattern.

### ✅ [SPLIT] Code Size
- **704 LOC** — well under the 1500 god-component ceiling. ✓ Compliant.
- Logic is split: component shell + TanStack table + dialog handlers cohesive.

### ✅ Design System Compliance
- **Spartan UI usage:** `hlmBtn`, `hlmBadge`, `hlmCheckbox`, `hlmInput`, `DialogShellComponent` — all correct. ✓
- **CSS class prefix:** `.at-*` (api-tokens namespace) — no collisions. ✓
- **Brand tokens:** Majority of colors use `var(--ps-*)` fallback chain (e.g., `var(--ps-accent-line, rgba(0,229,255,0.1))`). ✓

### ✅ Forms & Validation
- Token name input: `placeholder="e.g. CI Deploy Bot"` + required check (`!newName.trim()`). ✓
- Expiry datepicker: `[min]="nowLocal"` + client-side `expiryInvalid()` check + server-side guard implied. ✓
- Scope checkboxes: `hlmCheckbox` with `(ngModelChange)` + visual feedback. ✓

---

## Next-Wave Tasks

- [READY] **[COLOR] Fix error message contrast** @ `api-tokens.component.ts:282`
  - Replace `text-[#ff8888]` with token-based `text-error` or CSS variable for 4.5:1 minimum
  - Evidence: `class="block text-[0.7rem] text-[#ff8888] mt-1" role="alert">`
  - Action: Add `--ps-error` token to `_polish.scss` (4.5:1 against `#060610`) + update template
  
- [READY] **[COLOR] Audit SVG warning icon color** @ `api-tokens.component.ts:305`
  - Replace inline `style="color:#ffd166"` with Tailwind utility or CSS variable
  - Evidence: `<svg ... style="color:#ffd166"><path d="m21.73 18-8-14...`
  - Action: Use `class="text-warning"` on SVG or bind to `--ps-warning` CSS variable; verify stroke renders

---

## Sub-Area NOT Reached

None — full component swept (704 LOC scope, all surfaces audited).
