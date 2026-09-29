# Discovery — Site Detail (`/admin/sites/:id`) — 2026-09-29

Headline: site-detail is mature + hardened (lying-empty guards, confirm dialogs, silent-toast, auto-poll logs — no manual refresh) but has **zero `aria-live`** regions so every dynamic success/result update is silent to SR users, and ~9 hardcoded status hex colors bypass `--ps-*` tokens.

Surface: `frontend/src/app/pages/admin/sections/site-detail.component.ts` — **1459 LOC** (single-file component: template + styles + 6 tabs Logs/Snapshots/Data/SQL/Schema/Integrations). Owns exactly 1 `<h1>` (line 103). Dashboard hub sibling (`dashboard.component.ts`) = 2199 LOC, already has `sr-only` H1 + 2 aria-live.

## Next-wave tasks

- [A11Y] `site-detail SQL result-meta @ site-detail.component.ts:374-397` — the result summary `<div class="sql-result-meta">` with `{{ r.rows.length }} rows · {{ r.duration_ms }}ms` + D1 cost updates on every Run with **no `aria-live`**; an SR user hears nothing when a query returns. Wrap the count/cost line in `role="status" aria-live="polite"`. `[READY]`
- [A11Y] `site-detail rollback-result @ site-detail.component.ts:262-264` — `<p class="rollback-result">Rolled back to {{ rollbackResult() }}</p>` announces the most destructive action's SUCCESS with no `role`/`aria-live` (the sibling `rollback-error` at :266 correctly has `role="alert"`). Add `role="status" aria-live="polite"` so the success is announced. `[READY]`
- [A11Y] `site-detail logs live-tail @ site-detail.component.ts:211-223` — `<div class="site-detail__logs" data-testid="site-logs-tail">` streams new rows every 3s (`startLogTail`, :1056) with **no `aria-live`**; a live log tail that never announces is invisible to SR users. Add `aria-live="polite" aria-atomic="false"` to the tail container (or an sr-only announcer for the newest row). `[READY]`
- [VQA] `site-detail status colors @ site-detail.component.ts:531-552,576-577,591-598,616` — hardcoded hex bypasses `--ps-*`: `.log-row[data-level=error]{color:#ff7e8a}`, `warn #ffd166`, `.ws-connected #76e7a3`, `.ws-error #ff7e8a`, `.sql-plan-hint ok #4dffb5`, `.sql-result-cap #ffc800`, `.sql-error-plain #ff9fa8`, error borders `#ff4d6d`. No `--ps-danger/--ps-warn/--ps-success` token used. Define + reference brand status tokens (dashboard/analytics already token status colors). `[READY]`
- [A11Y] `site-detail SQL cost/scan status @ site-detail.component.ts:398-403` — `.sql-scan-warn` uses `role="status"` (good) but the expensive-scan warning + `sql-result-cap` (:385) rely on color-only (`#ffc800`/`#ffd166`) for severity; verify AA contrast of `#ffc800` on `--ps-bg #060610` (yellow-on-near-black ~ borderline) + ensure a non-color glyph precedes each. `[READY]`
- [SPLIT] `dashboard hub @ dashboard.component.ts:1-2199` — 2199 LOC single-file admin home (getting-started hub); above the ~1500 LOC split threshold. Extract widgets/sections into child components (`widgets.ts` already 1451 LOC + `calendar-widget` 1041 LOC are separate — the shell itself is the bloat). Not <2h; scope as a real wave.
- [FLOW] `site-detail Integrations connect @ site-detail.component.ts:1357-1381` — `onConnect` opens an OAuth popup; on popup-block it falls to paste-key (good) but there is **no user-visible hint** that a popup was blocked (silent `pasteKeyOpen.set`). Add a one-line toast/inline note "Popup blocked — paste your key below" so the fallback isn't mysterious. `[READY]`
- [A11Y] `site-detail SQL tabs keyboard @ site-detail.component.ts:120-183` — tablist uses `aria-selected` + `role="tab"` correctly (not the `aria-pressed` anti-pattern), but tabs have no arrow-key roving-tabindex handler (only click); WCAG tablist pattern expects ←/→ navigation. Add `(keydown.arrowright)`/`arrowleft` roving focus. `[READY]`
- [EMPTY] `site-detail logs empty @ site-detail.component.ts:218-222` — the `@empty` state is filter-aware (`logsEmptyText()`, good) but is passive text only; for a genuinely-empty (no-logs) site it could offer a launchpad action (e.g. "Trigger a rebuild to generate activity" linking the deploy/reset action). Minor — verify against embarrassingly-easy bar.
- [DEAD] `site-detail rollback-result never clears @ site-detail.component.ts:262-264,717,1186` — `rollbackResult()` is set on success but never reset to null; after a later failed rollback the stale "Rolled back to X" success line persists beside the new `rollback-error`. Clear `rollbackResult.set(null)` at the start of `confirmRollback()`. `[READY]`

## Sub-area NOT reached

- `site-data-browser.component.ts` + `site-schema-browser.component.ts` (child components embedded in Data/Schema tabs — separate files, per-site D1; partially covered by editor per-D1 memory).
- `readiness-badge.component.ts` (embedded at :116).
- `dashboard.component.ts` deep audit (widgets/calendar internals) — only H1 + LOC + aria-live counts verified, not full template.
- Editor workbench non-Data chrome (FileTree/Preview/terminal) — deferred to editor-sweep scope.
