# Vectorize Inspector (224 LOC) + Queues Inspector (225 LOC)

Two uncovered read-only admin audit surfaces for Cloudflare platform primitives (embeddings + job pipelines).

## Audit Findings

### vectorize-inspector.component.ts (224 LOC, routed)

| Check | Status | Evidence |
|-------|--------|----------|
| **[H1]** | PASS | Own single `<h1 class="text-[1.35rem]">Vectorize Inspector</h1>` at line 50 — routed page, correct |
| **[RT]** | PASS | Read-only view (comment line 36-42 + JSDoc confirm). No Refresh/Sync buttons present — design intent. |
| **[DEAD]** | PASS | No orphaned code. Minimal imports (EmptyStateComponent, ErrorCardComponent). No unused fields. |
| **[EMPTY]** | PASS | Graceful empty states: `!available()` → honest message (line 63-72), `!indexes().length` → `EmptyStateComponent` (line 73-77). No passive fallback needed. |
| **[SPLIT]** | PASS | 224 LOC, focused module. No god-component risk. Template (inlined, 98 lines), class (services, signals — 126 lines). Within healthy range. |
| **[A11Y]** | **WARN** | `aria-pressed` at line 89: list item uses `aria-pressed` but the parent `<ul>` has no `role="listbox"` or `role="list"`. Correct ARIA for a button list that selects one item = `aria-selected="true"` + parent `role="listbox"` or bare `<ul role="list">` is OK if parent scopes the interaction. Current: `<ul role=implicit-list>` with button `aria-pressed` is a 2.1 AA drift (Spartan UI baseline). Quote line 82: `<ul … list-none>` + line 88 `aria-pressed`. Recommend `aria-selected` OR add parent `role="listbox"`. Minor, non-blocking. |
| **[VQA]** | **FAIL** | Hard-coded `rgba(255,255,255,0.10)` at line 88. MUST use `--ps-*` token. Quote: `[style.background]="selectedName() === i.name ? 'rgba(255,255,255,0.10)' : null"`. Should be `class="selected:bg-white/10"` (Tailwind utility) or `var(--ps-selected-bg, rgba(255,255,255,0.10))`. **[READY]** — swap inline style for `bg-white/10` class binding. |

### queues-inspector.component.ts (225 LOC, routed)

| Check | Status | Evidence |
|-------|--------|----------|
| **[H1]** | PASS | Own single `<h1 class="text-[1.35rem]">Queues Inspector</h1>` at line 54 — routed page, correct |
| **[RT]** | PASS | Read-only view (comment line 39-46). No Refresh/Sync buttons. Design intent: metadata audit only. |
| **[DEAD]** | PASS | No orphaned code. Minimal imports (EmptyStateComponent, ErrorCardComponent). Clean class. |
| **[EMPTY]** | PASS | Graceful empty states: `!available()` → honest message (line 68-75), `!queues().length` → `EmptyStateComponent` (line 76-77). Good. |
| **[SPLIT]** | PASS | 225 LOC, well-scoped. Template inlined, class clean. No god-component smell. |
| **[A11Y]** | **WARN** | Identical to vectorize: `aria-pressed` at line 88 with parent `<ul>` — should be `aria-selected` or `role="listbox"` parent. Quote line 81: `<ul … list-none>` + line 87 `aria-pressed`. Same remediation path. Non-blocking. |
| **[VQA]** | **FAIL** | Hard-coded `rgba(255,255,255,0.10)` at line 87 (queues). Same issue as vectorize. Quote: `[style.background]="selectedId() === q.id ? 'rgba(255,255,255,0.10)' : null"`. **[READY]** — swap for `bg-white/10` Tailwind utility. |

## Next-wave Tasks

- [READY] **vectorize @ line 88** — replace hard-coded `rgba(255,255,255,0.10)` with `bg-white/10` Tailwind class binding via `[ngClass]` — evidence: `[style.background]="selectedName() === i.name ? 'rgba(255,255,255,0.10)' : null"` — action: add `[ngClass]="{ 'bg-white/10': selectedName() === i.name }"`, remove inline `[style.background]`. Verify contrast ≥4.5:1 on dark admin shell.
- [READY] **queues @ line 87** — replace hard-coded `rgba(255,255,255,0.10)` with `bg-white/10` Tailwind class binding via `[ngClass]` — evidence: `[style.background]="selectedId() === q.id ? 'rgba(255,255,255,0.10)' : null"` — action: identical fix to vectorize.
- [READY] **aria-pressed → aria-selected** — both components (vectorize line 89, queues line 88) use `aria-pressed` on list items but the context is selection, not toggle. Query: `grep -n "aria-pressed" apps/project-sites/frontend/src/app/pages/admin/sections/vectorize-inspector.component.ts` + queues, then refactor both to `aria-selected` + optional parent `role="listbox"` for ARIA 2.1 AA correctness. Non-blocking under current 2.1 testing, but correct before WCAG 3.0 migration.

## Sub-area NOT reached

- No user interaction testing (e2e flow for index/queue selection + detail panel rendering)
- No performance audit (bundle size impact of two new routed sections)
- No i18n check (description text hard-coded in component; should use `@ngx-translate` keys if multi-language planned)
