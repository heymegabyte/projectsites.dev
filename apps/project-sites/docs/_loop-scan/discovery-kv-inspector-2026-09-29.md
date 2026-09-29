# KV Inspector — VQA Discovery (346 LOC)

AdminComponent section for read-only Cloudflare KV namespace browsing. Renders namespace picker → key list + value inspector panel. Feature: eventually-consistent notice, TTL display, metadata JSON, truncation flag (64 KiB cap). Super-admin only, gated by feature flag `kv_inspector`.

## Audit Results

| Check | Status | Evidence |
|-------|--------|----------|
| **H1** | ✓ PASS | Line 46: `<h1>KV Inspector</h1>` — owns single h1 |
| **[RT]** | MISS | No manual Refresh button on key list or value panel. State resets only when binding/prefix changes. Users stuck if data updates but UI cached |
| **[VQA] Hardcoded rgba** | DRIFT | Line 127: `[style.background]="selectedKey() === k.name ? 'rgba(255,255,255,0.10)' : null"` — inline style, no token. Use Tailwind `bg-white/10` class or `--ps-selection-bg` token |
| **[VQA] Hardcoded amber-300** | DRIFT | Lines 50, 162: `text-amber-300/80` not a `--ps-*` token. Should be `text-ps-warn` or brand-consistent accent |
| **[A11Y] opacity-50 contrast** | DRIFT | Line 139: `disabled:opacity-50` on "Load more" button. Disabled opacity may fail WCAG AA (4.5:1) on light text. Test computed style at 3:1 contrast. Use `disabled:pointer-events-none disabled:opacity-60 disabled:text-gray-600` or explicit color floor |
| **[A11Y] aria-* coverage** | ✓ PASS | Lines 106, 128, 151: `aria-label`, `aria-pressed`, proper semantic structure |
| **[EMPTY]** | ✓ PASS | `<app-empty-state>` used for no namespaces, no keys, no selection states |
| **[DEAD]** | ✓ PASS | No dead imports, orphaned CSS, or unreachable code paths |
| **[SPLIT]** | ✓ PASS | 346 LOC, well-structured, no god-component indicators |

## Next-wave Tasks

- [READY] **kv-inspector @ line 127** — inline `[style.background]="selectedKey() === k.name ? 'rgba(255,255,255,0.10)' : null"` uses hardcoded RGBA. Replace with Tailwind `[class.bg-white/10]="selectedKey() === k.name"` (no inline style, reusable class). Evidence: current code binds inline style directly. Action: use `[ngClass]` or `[class.*]` binding instead. <2h.
- [READY] **kv-inspector @ lines 50, 162** — `text-amber-300/80` not a brand token. Replace with `text-ps-warn` or define a new `--ps-eventual-notice` token matching amber palette. Evidence: `amber-300` hardcoded in template, not using `--ps-*` convention. Action: swap class or add token to `_polish.scss`. <1h.
- [READY] **kv-inspector @ line 139** — `disabled:opacity-50` on "Load more" button. Verify contrast at disabled state via axe-core or computed style inspection. If fails WCAG AA, add explicit `disabled:text-gray-500` + test. Evidence: opacity alone may not meet 4.5:1 on light text. Action: add explicit color + test. <30m.
- **kv-inspector @ component** — Add manual Refresh button for key list (refreshes current binding/prefix state, same as user toggling binding) + Refresh button for value panel (re-fetches the selected key's value). Evidence: users have no way to refresh when KV is updated externally. Action: add `<button (click)="loadKeys()">Refresh keys</button>` + `<button (click)="loadValue()">Refresh value</button>`. <1h.

## Sub-area NOT reached

- Component testing (`kv-inspector.component.spec.ts`) — spec file exists but no VQA audit of test coverage
- Worker API (`/admin/kv/*` endpoints) — backend routes not audited in this pass
