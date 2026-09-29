# R2 Inspector Admin Section VQA — 2026-09-29

**Counts:** 382 LOC · 1 own H1 · 3 empty states · 0 RT buttons · 0 DEAD signals · 1 A11Y issue (list semantics) · 1 VQA issue (hardcoded colors)

## Audit Summary

The R2 Inspector (`r2-inspector.component.ts`, 382 lines) is a **super-admin read-only browser** for the shared platform R2 bucket (SITES_BUCKET). It fetches bucket lists, paginated objects with prefix filtering, and object metadata (via HEAD — never bodies). The component is **compact, well-focused, no god-component smell**, with three contextual empty states and proper loading/error feedback.

### H1 Check ✅
- **Line 51:** `<h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">R2 Inspector</h1>`
- Owned by the component (not shell-delegated)
- Covered by `check-admin-h1.mjs` gate

### Empty States (3 found)
1. **Line 64-68** — "No buckets" when allowlist is empty
2. **Line 122-128** — "No objects" when prefix has zero matches or bucket is empty
3. **Line 206-211** — "No object selected" when no object is clicked (passive instruction only, no launchpad action)

### Accessibility Issues

**Line 131-151 (object list):** Button selection state is marked with `[attr.aria-pressed]="selectedKey() === o.key"`, which works for screen readers. However, the context is a **list of items**, not a toggle button group. WCAG best practice is `aria-selected` inside an `[role="listbox"]` or `[role="list"]` parent. The current `<ul>` is semantically correct HTML but lacks ARIA list semantics.

**Evidence (quoted):** 
```ts
<ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="r2-object-list">
  @for (o of objects(); track o.key) {
    <li>
      <button ... [attr.aria-pressed]="selectedKey() === o.key" ...>
```

### VQA (Hard-Coded Colors)

**Lines 75, 99, 136, 175, 191:** Form inputs and panels use hardcoded opacity-based colors instead of `--ps-*` tokens:
- `border-white/12` (select borders)
- `bg-black/30` (input backgrounds)
- `border-white/10` (panel borders)
- `bg-white/8` (panel hover)

**Evidence (lines 73-75):**
```ts
<select
  id="r2-bucket"
  class="bg-black/30 border border-white/12 rounded-lg px-3 py-2..."
```

**Audit lines:** 75, 99, 136, 175, 191 (5 instances of hardcoded transparency modifiers). Lines 108, 156 correctly use `bg-ps-accent/90` and `text-ps-accent` — shows the pattern is known.

---

## Next-Wave Tasks

- [A11Y] r2-inspector object list (line 131-151) — convert from generic button-in-list to semantic `[role="listbox"]` + `aria-selected` per ARIA 1.2 spec. Add `role="listbox"` to `<ul>`, change `aria-pressed` to `aria-selected`, add `role="option"` to `<li>`. Verify with axe-core + manual screen-reader (NVDA/JAWS) navigation. **[READY]** (<2h, no design call).

- [VQA] Admin form-control tokens — audit `_polish.scss` for token definitions of `--ps-border-subtle` (1px solid white/12), `--ps-bg-secondary` (black/30), `--ps-bg-hover` (white/8), `--ps-border-hover` (white/10). If missing, define them (per `code-style` token doctrine). Then replace all 5 hardcoded instances in r2-inspector (lines 75, 99, 136, 175, 191) + scan all admin sections for same pattern + batch-replace. **[READY]** (<2h, mechanical sed + grep).

- [EMPTY] r2-inspector "No object selected" state (line 206) — upgrade from passive instruction to include next-step hint: *"Select an object from the list to view its metadata."* or interactive prompt. **[READY]** (<30m).

## Sub-Area NOT Reached

- Spec coverage for r2-inspector routes + list pagination (deeper E2E journey: select bucket → apply prefix → paginate → select object → verify metadata display). Currently covered by orphan-wiring spot-check only (discovery-orphans-2026-09-29.md). A dedicated E2E spec file (`e2e/r2-inspector.spec.ts` with journey) would pair with this VQA audit.

- Load performance: bucket fetch + object list is paginated (cursor-based, good). No lagging identified; stale-while-revalidate + visibility-gated refresh not needed (data is authoritative read-only).
