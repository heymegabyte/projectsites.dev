# Discovery — Create/Onboarding Surface VQA (2026-09-29)

**Area:** Site-creation wizard (create-from-search funnel)  
**Surface:** `/create` route — `apps/project-sites/frontend/src/app/pages/create/`  
**LOC:** 1,921 TypeScript + 964 HTML = 2,885 total  
**Audit status:** ZERO prior scans (highest-value uncovered surface per monitor-orchestration)

## Audit Summary

Routed page owns exactly 1 `<h1>` (line 25). CRITICAL FINDINGS:

| TAG | LOCATION | EVIDENCE | ACTION |
|-----|----------|----------|--------|
| [SPLIT] | create.component.ts:1–1921 | 1,921 LOC god-component (exceeds 1500 threshold per `inverted-abstraction-pyramid`). Theme logic (lines 1103–1478 = 375 LOC), autofill (734–823), image discovery (826–873) should be services. | Extract 3 services: theme-presets, autofill, image-discovery. Cost: 2h. Priority: MEDIUM. |
| [A11Y] | Lines 314, 408, 617, 679 | Dropdown buttons (role='button') lack aria-labels. Image preview triggers have no aria-label. Screen-reader users cannot name suggestions or preview actions. | Add `[attr.aria-label]` to 4 dropdown rows + 2 image buttons. Cost: 5 min. Priority: HIGH. |
| [EMPTY] | Lines 307–339, 401–430 | When business/address dropdown opens but suggestions are 0 (search succeeded), shows blank. User sees nothing — should show "No matches — try a different name" nudge. | Add fallback UI when `suggestions.length === 0 && !searchUnavailable()`. Cost: 20 min. Priority: MEDIUM. |
| [FLOW] | Lines 1–7 (step count) | 5-step funnel (name, address, phone, website, category, context, upload, submit) before conversion. Prefill from sidebar reduces to 4. "Auto-Populate with AI" button buried below address (line 485). First-time users may miss it — reduces engagement. | Move "Auto-Populate" CTA to ABOVE address field (step 2 completion). Cost: 30 min. Priority: LOW. |
| [VQA] | HTML + TS | Hard-coded colors: 0. All tokens use Tailwind utilities + CSS custom properties (--ps-accent, --ps-bg). Error text `text-red-400` on dark bg = 5.2:1 contrast. Button text swaps (Searching ↔ Auto-Populate) have reserved width (`min-w-[240px]`). ✓ PASS. |
| [H1] | Line 25 | Exactly 1 `<h1>` in component template. Child h2 headers correct (lines 516, 573). ✓ PASS. |

## Next-wave Tasks

**[READY] — [A11Y] Add aria-labels to dropdown suggestions** @ lines 314, 408, 617, 679  
Evidence: `<div role="button" tabindex="0">` containers lack accessible labels. Screen-reader announces "button" with no context.  
Action: Wire `[attr.aria-label]="b.name + ', ' + b.address"` (business dropdown) + `[attr.aria-label]="s.description"` (address dropdown) + `aria-label="View {{imageName}} preview"` on image modal triggers. 5 min.

**[READY] — [EMPTY] Add "no matches" fallback UI in dropdowns** @ lines 307–339 (business) + 401–430 (address)  
Evidence: When `businessSuggestions().length === 0` but dropdown is open (search succeeded, just zero results), blank area confuses users.  
Action: Add `@else` block after line 338/429: `<div class="py-2.5 px-4 text-gray-400 text-[0.85rem]">No matches — try a different term.</div>`. 20 min.

**[READY] — [SPLIT] Extract theme-preset logic to service** @ create.component.ts:1103–1478  
Evidence: `getDesignRecommendations()` + `inferCategory()` + `inferCategoryFromName()` = 375 LOC. Not UI, not state — pure data mapping. Belongs in a service for reuse + testability.  
Action: Create `theme-presets.service.ts`, move logic, inject + call. Reduces component to ~1500 LOC (safe). Update form logic to call service. 2h.

[LOW] Move "Auto-Populate with AI" button CTA higher — after address field, before optional category — so first-time users spot it immediately. 30 min.

## Sub-area NOT Reached

No admin sections in `/create/`. Sibling modules (claim-prefill.ts, theme-presets.ts) are supporting utilities, not routed sub-surfaces. All scanned. ✓
