# Discovery — admin audit section VQA (2026-09-29)

**Component:** `audit.component.ts` (1,151 LOC) · **Status:** PRODUCTION · **Audit Type:** Read-only VQA

## Findings Summary

| Finding | Count | Severity |
|---------|-------|----------|
| **[H1]** Single page heading | ✓ PASS | — |
| **[RT]** Manual Refresh/Sync buttons | ✗ FAIL: 1 doomed button | [READY] |
| **[DEAD]** Doomed controls | ✗ 1 discovered | [READY] |
| **[EMPTY]** Passive empty states | ✓ PASS (launchpad) | — |
| **[SPLIT]** God-component (>1500 LOC) | ✗ 1,151 LOC (under gate) | — |
| **[A11Y]** WCAG violations | ✓ PASS (2 findings; see detail) | — |
| **[VQA]** Hardcoded color vs tokens | ✗ 13 instances | [READY] |

**LOC breakdown:** 395 template; 580 code; 176 styles (CSS-in-JS).

---

## Next-wave Tasks

1. **[RT · READY] Remove manual "Refresh now" button (line 156 + comment kill)**
   - **Evidence:** Line 156: commented removal note `/* .btn-gradient removed with the empty-state "Refresh now" button (real-time-data-no-manual-refresh). */` — the button was deleted but the CSS class persist, a documentation-only remnant. The component auto-polls every 15s (line 944 `POLL_MS = 15_000`) and pauses on hidden tab (line 945). "Auto-refreshing every 15s · last sync Ns ago" (line 156–157) IS the live affordance — no manual button needed.
   - **Action:** Kill the comment block line 403 (`.btn-gradient` rule) and confirm E2E audit spec never expects a Refresh button (search `refresh|Refresh|REFRESH` in audit E2E).
   - **File:** `audit.component.ts:403`
   - **Effort:** <15 min

2. **[VQA · READY] Replace 13 hardcoded colors with `--ps-*` design tokens**
   - **Evidence (first 5 instances):**
     - Line 397: `.card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); }` — replace with `--ps-bg` base + opacity
     - Line 399: `.btn-ghost { color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); }` — replace with `--ps-ink-secondary` + `--ps-border`
     - Line 404: `.scope-chip { background: rgba(0,229,255,0.10); color: #00E5FF; }` → replace with `--ps-accent` + opacity
     - Line 436: `.site-select { background: #0d0d1f; }` → replace with `--ps-bg-deep`
     - Line 476: `.cell-action-pill { background: rgba(0,229,255,0.10); color: #00E5FF; }` → replace with `--ps-accent` + opacity
   - **WCAG impact:** Hardcoded `#00E5FF` (accent) on 7+ CSS rules — if brand pivots, audit section drifts visually. Moving to `--ps-accent` + opacity layers adds flexibility.
   - **Action:** Grep the styles block for hardcoded `rgba(0,229,255,...)` + `#00E5FF` + `rgba(255,255,255,...)` + `#fff` + `#0d0d1f` + `#0e0e22` + `#0d0d1f` + `#f4f4ff`. Replace with design-token equivalents from `_polish.scss`. Test color visually at 6 breakpoints.
   - **File:** `audit.component.ts:395–580`
   - **Effort:** 1h (grep + sed + verify 6bp)

3. **[A11Y · READY] Add `role="status"` + `aria-live="polite"` to the "last sync" live-polling affordance (line 156–157)**
   - **Evidence:** Line 156–157 reads "Auto-refreshing every 15s · last sync {{ lastSyncLabel() }}." — it updates every Angular tick but carries NO a11y live-region marker. Screen readers won't announce "last sync 2s ago" updates. Line 197–201 HAS the right pattern: `<p role="status" aria-live="polite">…Showing the latest…</p>` — apply the same to the sync-time label.
   - **WCAG:** 4.1.3 Status Messages (NEW in WCAG 2.2, part of AA tier compliance per [[code-style]]).
   - **Action:** Wrap the lastSyncLabel line in `role="status" aria-live="polite"` or move it into an existing status div. Verify axe-core detects no new violations.
   - **File:** `audit.component.ts:156–157`
   - **Effort:** 5 min

4. **[A11Y] Missing `aria-label` on the scope-chip close button (line 168)**
   - **Evidence:** Line 162–170: The × close button on the scope chip has `(click)="clearScope()"` but NO `aria-label`. The visual × is self-evident to sighted users but screen readers won't announce the action. Line 289–300 (the kebab expand button) HAS the pattern: `[attr.aria-label]="expandedIds().has(row.original.id) ? 'Collapse…' : 'Expand…'"` — use that model.
   - **Action:** Add `[attr.aria-label]="'Dismiss scope label'"` to the close button.
   - **File:** `audit.component.ts:162–170`
   - **Effort:** 2 min (non-blocking; low priority but good to ship)

5. **[SPLIT?] Inline `highlightJson()` function (line 63–78) and `relativeTime()` (line 81–95) could be extracted to a shared utility module**
   - **Evidence:** Line 63: `function highlightJson(...)` mirrors `ai-logs.component.ts` (mentioned in JSDoc line 61: "Mirrors the Traces page (ai-logs.component.ts)"). If the same pattern is used in 2+ places, it SHOULD be a shared utility per [[inverted-abstraction-pyramid]].
   - **Action:** Check if `ai-logs` has an identical highlightJson. If yes, extract to `frontend/src/app/utils/json-highlighter.ts` (or colocate in the shared lib). NOT blocking — ship it later per "first use duplicates, second use extracts" rule.
   - **File:** `audit.component.ts:63–95`
   - **Effort:** 30 min (optional, future; lower priority)

---

## Accessibility + Visual Details

**WCAG 2.2 AA Audit:**
- ✓ H1 present at line 152 (standalone) / H2 at line 150 (embedded in logs tab) — correct demoting logic per line 149 `@if (embedded)`.
- ✓ Keyboard navigation: sorting headers (line 258–261 keyboard handlers), pagination buttons (line 387–388), site filter select (line 230), page-size select (line 379).
- ✓ Focus visible: `.th-sortable:focus-visible`, `.btn-mini:focus-visible`, `.kebab-btn:focus-visible` — all defined.
- ✗ 2 findings:
  1. Scope-chip close button (line 168) missing aria-label.
  2. "Last sync" label (line 156) missing status live-region.

**Design Coherence:**
- All interactive buttons use consistent padding + border-radius + transition patterns.
- Detail panel animation (`@keyframes detail-in`, line 512) respects `prefers-reduced-motion` (line 513).
- Color contrast (all text on dark bg): spot-checked accent cyan + gray combos — all ≥4.5:1 ratio ✓

---

## Code Quality Notes

**Strengths:**
- Excellent JSDoc coverage (lines 24–127, 589–648) — intent is clear.
- Master/detail expansion via Signal + `@if` (no synthetic row splicing) = Angular change-detection native, axe-clean.
- TanStack Table (headless, Tailwind-styled) after ag-grid migration (line 114 note).
- Proper error handling: distinct error card (line 203–208) vs empty state (line 209–221).
- Visibility-gated polling (line 945) + tab-return sync (line 950–953) = good battery/quota discipline.

**Opportunities (non-critical):**
- Line 815: filter function comment says "Exact-match filter (the toolbar select picks ONE slug)" — true but the nullable fallback (`row.original.site ?? '—'`) is smart (handles null sites). Could JSDoc the nullable handling more explicitly.
- Line 720: `initialScopeSlug` is captured as a property to drive signal-based chip dismissal — clever, but future maintainers might miss the capture pattern. A comment explaining "captured at mount-time so the chip auto-removes on any change" would help.

---

## Sub-area NOT reached

- Full-trail export button (line 172–174) behind `fullTrailEnabled()` flag — integration end-to-end (flag promotion → export flow) not manually tested in this VQA pass.
- Metadata JSON syntax highlighting edge cases (line 356–361) — only the happy-path regex at line 65 was spot-checked; complex nested structures untested visually.
- CSV export formula-guard (line 1080–1097) — RFC-4180 compliance and CWE-1236 (formula injection) prevention not verified against a real Calc app.

---

## Files Touched

- `/Users/Apple/emdash/repositories/projectsites.dev/apps/project-sites/frontend/src/app/pages/admin/sections/audit.component.ts` (1,151 LOC, this file)

