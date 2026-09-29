# Admin Webhooks VQA Discovery

**Area:** Outbound Webhooks (`/admin/webhooks`)  
**Component:** `webhooks.component.ts` (384 LOC)  
**Date:** 2026-09-29

## Audit Summary

**H1 Count:** ✓ Missing (uses `<h2>` as visual H1)  
**[RT] Controls:** None needed (event subscribes via single `create()` mutation, deliveries auto-refresh via load)  
**[DEAD]:** Clean  
**[EMPTY]:** ✓ Empty-state is passive  
**[SPLIT]:** 384 LOC — not over 1500  
**[A11Y]:** ✓ Solid (aria-label, aria-invalid, aria-describedby, focus-visible, role="status")  
**[VQA] Colors:** Hard-coded `red-300/90`, `red-200`, `amber-300/70`, `amber-300/90` off the Tailwind palette (not `--ps-*` tokens)

---

## Next-wave tasks

- **[READY] [VQA] webhooks.component.ts @ lines 89–90** — Hard-coded `text-red-300/90` + `text-red-200` in validation hint. These are NOT `--ps-*` tokens — should be `text-ps-error` or referenced via a design-token variable. Evidence: `<span class="text-red-300/90">` and `<code class="text-red-200">`. Action: Audit all Tailwind color refs in the file (grep `text-\(red\|amber\|primary\|light\|text-\)` vs `--ps-*` token coverage). Fix drift by converting hard-coded reds to `var(--ps-error)` or a mapped class. (file:89–90)

- **[READY] [EMPTY] webhooks.component.ts @ lines 125–126** — The "No webhook endpoints" empty state is a static message with a launchpad (`app-empty-state`), which is good. However, the message is passive prose instead of action-oriented: "Add an endpoint above to receive…" — minor copy uplift. Action: Reword to start with an imperative + outcome: "Create your first endpoint to start receiving signed event callbacks." (file:125–126)

- **[H1] webhooks.component.ts @ line 50** — Visual H1 is an `<h2>` ("Outbound Webhooks"). The shell provides a semantic H1 elsewhere (admin-shell header or dashboard). Verify the page hierarchy is correct: the shell's H1 (if present) should be the page title, this should be H2. If shell H1 is missing, bump this to H1. Evidence: line 50 is `class="text-2xl font-semibold text-light">Outbound Webhooks</h2>`. Action: Verify in `admin.component.ts` shell whether a semantic H1 exists. If not, change this to `<h1>` (one per page is WCAG 2.4.1). (file:50)

---

## Sub-area NOT reached

- Webhook delivery history callback queue (retry logic, backoff, failed-delivery storage)
- Webhook signature verification (HMAC strategy)
- Event type schema versioning
- Per-endpoint event mask (subscribe to subset, not all)

---
