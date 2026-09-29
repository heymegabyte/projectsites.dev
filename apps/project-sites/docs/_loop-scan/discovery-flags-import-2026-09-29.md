# Discovery — Feature-Flags + /admin/import VQA (2026-09-29)

Read-only frontend VQA of two admin sections: the **Feature-Flags control plane** (system-operator layer) and the **/admin/import** orphan route. Both reached for the first time via this discovery pass.

## 6 next-wave tasks (ranked by severity; `[READY]` = <2h)

1. **[READY] [RT] Remove manual refresh button from feature-flags; rely on real-time AdminStateService polling.** `feature-flags.component.ts:130-132` defines `.ff-refresh` button with no `disabled-reason` when blocked. The component already reads `AdminStateService` (line 40, injected) which polls every 30s with visibility-change awareness. Manual Refresh violates `[[real-time-data-no-manual-refresh]]`. Slice: delete the `.ff-refresh` button; add status affordance (e.g., "Synced just now") to the header.

2. **[SPLIT] Decompose `feature-flags.component.ts` (69 KB, likely 1800+ LOC) into 4 sub-components.** God-component violates `[[inverted-abstraction-pyramid]]`. Extraction targets: `feature-flag-card`, `dangerous-change-modal`, `advanced-mode-panel`, `disclosure-mode-switcher`. Parent stays thin; logic distributes. Cost: 3-4h. Not READY due to scope.

3. **[A11y] Add `position: sticky` to `.ff-toolbar` (filter panel + search).** Users on long flag lists scroll past controls and lose filter context. Sticky toolbar keeps filters reachable. Cost: <30min. Pair with `scroll-behavior: smooth` on the parent section. `[READY]`.

4. **[DEAD] `/admin/import` route is orphaned — no component backing it.** `admin-section-labels.ts:28` registers label `import: 'Import'` but no `.component.ts` file exists in `sections/`. When clicked, renders 404 or stale previous route. Either scaffold the import component or unregister the route. Cost for scaffold: 1.5-2h (component shell + form + service call). Mark as `[NOT_FOUND]` until decision made.

5. **[VQA] Extract color literals (#ff5555, #4ade80, #fca5a5, #6ee7b7) in feature-flags.component to design tokens.** Killswitch/stable/success/error colors are hard-coded instead of `--ps-danger`, `--ps-success`, etc. (none exist). Slice: define 4 tokens in `_polish.scss`, update `feature-flags.component.ts` lines 133, 161-162, 197, 202, 243-244, 255, 257. Cost: <45min. `[READY]`.

6. **[A11y] Add `aria-label` to generic icon buttons in hosting.component.** Copy buttons already have labels (line 197), but the status pill's icon (line 166) lacks one. Verify all icon-only controls carry `aria-label`. Cost: <20min. `[READY]`.

## Sub-area NOT reached (rotate here next fire)

- Voice admin section (voice.component.ts, speech-synthesis + transcription controls)
- Social sub-tabs (social.component.ts has 4 nested dialogs/tabs for calendar, paste-connect, auto-pilot)
- E-commerce admin (if any — check FEATURES.md for merchant/payment-specific sections)
