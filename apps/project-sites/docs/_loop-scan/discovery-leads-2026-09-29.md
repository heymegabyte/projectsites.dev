# Leads (CRM) — VQA Discovery

**Area:** Lead Scanner (`/admin/leads`) — Business lead discovery engine (Google Places + OSM, outreach claim links).
**Component:** `leads.component.ts` (716 LOC).
**Scope:** Form controls, table, empty states, loading states, accessibility, brand tokens.

## Findings

### [H1] — Single H1 Present ✓
Line 181: `<h1 class="text-[clamp(...)]">Lead Scanner</h1>` — correct, sole H1.

### [RT] Refresh Buttons (Manual, Not Visibility-Poll)
- Line 219-226: "Scan" button manually triggers `scan()` method (disabled when `scanning()` = true). ✓
- Line 290-297: "Run auto-scan" button manually triggers `scanOsm()` method (disabled when `osmScanning()` = true). ✓
- **Both are correct** — not visibility-poll-triggered; user-initiated only.

### [DEAD] Doomed Controls (None Found)
- All buttons have working handlers with disabled-state management.
- Error recovery UI (lines 319-332) has working "Retry" button → `loadLeads()`. ✓
- No orphaned/broken controls detected.

### [EMPTY] Passive Empty States (SHOULD BE LAUNCHPADS)
- Line 333-339: `"No leads yet. Run a scan above to find businesses without a website."` — **passive static text, NOT a launchpad.** Should auto-focus the search input or display a quick-start snippet.
- Line 314-318: `"Loading leads…"` — **passive, correct** (transient state, not a destination).
- Line 319-332: Error state has "Retry" button → **correct, actionable**.

**Recommendation:** Convert empty-state text to a micro-CTA: make the search input auto-focus or add a "Start your first scan →" link.

### [SPLIT] God-Component >1500 LOC
- File = 716 LOC ≤ 1500 ceiling. ✓
- Component is appropriately scoped (single responsibility: lead management UI).

### [A11Y] — Multiple Gaps

**1. No `aria-label` on icon-only controls (lines 394-420):**
- Line 394-400 (phone icon): `[attr.aria-label]="'Call ' + lead.businessName"` — **present ✓**
- Line 403-409 (email icon): `[attr.aria-label]="'Email ' + lead.businessName"` — **present ✓**
- Line 412-420 (website icon): `[attr.aria-label]="'Visit website for ' + lead.businessName"` — **present ✓**
- Line 431-447 (social icons in loop): `[attr.aria-label]="socialMeta[network].label + ' — ' + lead.businessName"` — **present ✓**
- **All icon controls properly labeled.** ✓

**2. `mousedown` in custom spinner (line 467):**
- Line 467: `<span class="ps-enrich-spinner" aria-hidden="true"></span>` — decorative, correctly hidden. ✓

**3. Focus-visible rings on all interactive elements:** ✓
- Buttons: `focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF]` (scan button, line 222)
- All buttons carry focus rings consistently.

**4. Missing `aria-live` on dynamic label changes:**
- Line 228-230: Status message in span lacks `role="status" aria-live="polite"` — **FOUND!**
  Current: `<span class="pb-2 text-xs text-text-secondary">Scanned {{ s.scanned }} · added {{ s.created }}</span>`
  **Should be:** `<span class="pb-2 text-xs text-text-secondary" role="status" aria-live="polite">Scanned {{ s.scanned }} · added {{ s.created }}</span>`
- Line 299-302: OSM scan status — **SAME ISSUE**, missing `role="status" aria-live="polite"` on the dynamic result span.
- **Quote (line 228-230):** Current has NO `role="status"` annotation; **status updates should announce to screen readers.**

### [VQA] Hard-Coded Colors (NOT Using `--ps-*` Tokens)

**Social brand colors (intentional design constants, lines 83-124):**
- `color: '#1877F2'` (Facebook)
- `color: '#E4405F'` (Instagram)
- `color: '#000000'` (X/TikTok)
- `color: '#0A66C2'` (LinkedIn)
- `color: '#FF0000'` (YouTube)
- `color: '#FF1A1A'` (Yelp)
- `color: '#4285F4'` (Google)

These are BRAND COLORS (third-party networks), intentionally hard-coded for brand fidelity. **NOT a violation** — hard-coded brand colors for external networks are correct by design.

**Component brand colors (should use tokens, lines 202-365):**
- Line 202, 265, 284: `border-white/[0.1]`, `bg-black/30`, `text-white` — **these use opacity-based Tailwind, NOT bare hard-codes.** ✓
- Line 222, 293: `bg-primary`, `hover:bg-primary/85` — **using brand token `--ps-primary`.** ✓
- Line 362-364: `bg-primary/15`, `text-primary` — **using tokens.** ✓
- **All component colors use tokens.** ✓

No hard-coded component-color violations found.

## Next-Wave Tasks

### [READY] 1. Add `aria-live="polite"` to dynamic scan-result status spans
**Evidence (line 228-230):**
```html
<span class="pb-2 text-xs text-text-secondary">Scanned {{ s.scanned }} · added {{ s.created }}</span>
```
**Action:** Add `role="status" aria-live="polite"` attribute so screen readers announce scan completion. Same for OSM result span (line 299-302).
**Effort:** <10 min (two spans, two attributes). **[READY]**

### [READY] 2. Convert empty-state text to actionable launchpad
**Evidence (line 333-339):**
```html
<p class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-sm text-text-secondary" data-testid="leads-empty">
  No leads yet. Run a scan above to find businesses without a website.
</p>
```
**Action:** Replace static text with a focus-trap launchpad: auto-focus the `.query` input on mount, or add a "Start Your First Scan →" link with icon arrow that scrolls to and highlights the search box.
**Effort:** 15–20 min (detect empty state on component init, auto-focus input or add micro-CTA). **[READY]**

### [READY] 3. Add `min-w-[Nch]` reserved width to button labels with state changes
**Evidence (line 225, 296):**
- "Scan" ↔ "Scanning…" button (line 219-226, label changes on `scanning()` signal)
- "Run auto-scan" ↔ "Scanning…" button (line 290-297, label changes on `osmScanning()` signal)
**Action:** Wrap button text in `<span class="min-w-[14ch] text-center inline-block">` to reserve width for the longest label ("Run auto-scan" = 12ch, "Scanning…" = 10ch → round to 14ch). Prevents layout jitter on state toggle.
**Evidence quote (line 225):** `{{ scanning() ? 'Scanning…' : 'Scan' }}` — label toggles, no width reservation.
**Effort:** 10 min (add wrapper span + Tailwind class to both buttons). **[READY]**

### [OPTIONAL] 4. Add inline-validation feedback to search input
**Evidence (line 201-208):**
```html
<input
  class="w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm text-white outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40"
  [(ngModel)]="query"
  name="query"
  placeholder="e.g. roofers in Newark NJ"
  data-testid="leads-scan-query"
  autocomplete="off"
/>
```
**Action:** Add real-time feedback: show character count or a disabled-reason hint when `query.trim().length < 2`. Example: "Type at least 2 characters to search."
**Effort:** 20–30 min (add computed signal, conditional error message below input, style). **[STRETCH, not READY]**

## Sub-area NOT reached

- Database schema audits (D1 leads/lead_contacts table design)
- Backend handler correctness (API `/admin/leads`, `/admin/leads/scan`)
- Error boundary isolation (does leads section crash propagate?)
- Performance profiling (form paint time, table render perf at 1000+ leads)

