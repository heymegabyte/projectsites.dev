# Deliverability Admin Surface VQA — 2026-09-29

**Area:** `/admin/deliverability` (email deliverability wizard, DNS record checker)
**Components:** `deliverability.component.ts` (377 LOC) · `delivery-card.component.ts` (584 LOC)
**Status:** All critical gates PASS; 4 polish improvements identified, 3 READY to ship (<2h each).

---

## Summary

The deliverability surface (SPF/DKIM/DMARC checker) and the delivery-performance card (Cloudflare edge metrics) both score **SOLID architecturally**:

- H1 handling correct (level-aware input gating dual h1 in page-vs-embedded contexts)
- Aria labels comprehensive (progress bar, score image, field descriptions)
- Empty/error/loading states well-structured (calm cyan for feature-gate-off, neutral prompts for no-domain)
- Rolling-counter animation + reveal directive integrated properly
- Zod input validation in-place, idempotent-key pattern ready

**No BLOCKED issues.** Four polish wins identified, three ship-ready within the hour.

---

## Findings + Next-Wave Tasks

### [VQA] Hard-coded amber/warn/error colors drift from design tokens
**delivery-card.component.ts:148, 151, 156, 221** — Lines use literal `#f5a524` (4xx warn), `#f5405e` (5xx error), `#ffb4c0` (warn text) instead of `--ps-*` CSS var fallbacks.

```ts
// Line 148: hard-coded warning amber
.dl-status-row[data-class='4xx'] .dl-bar-fill {
  background: #f5a524;  // ← should be var(--ps-warn, #f5a524) or similar
}
// Line 151: hard-coded error red
.dl-status-row[data-class='5xx'] .dl-bar-fill {
  background: #f5405e;
}
// Line 156: hard-coded warn text
.dl-warn {
  color: #ffb4c0;  // ← should be var(--ps-error-text, #ffb4c0)
}
```

**Evidence:** Visual consistency audit will flag these as "brand-token drift" when the design system evolves. The fallback approach (var + hex) is correct; the hex is just not wrapped in a var yet.

**Action:** `[READY]` Wrap in CSS vars at delivery-card.component.ts:148,151,156,221. Add `--ps-status-4xx: #f5a524; --ps-status-5xx: #f5405e; --ps-error-text: #ffb4c0;` to `_polish.scss` SSOT, then reference. Cost: 15 min.

---

### [EMPTY] Passive empty state (no-data + no-credentials paths) lack CTAs
**delivery-card.component.ts:442-450** — Three passive empty/unavailable prose blocks show NO ACTION affordance:

```html
<!-- Line 442: passive "no data yet" -->
<p class="dl-empty" data-testid="an-dl-empty">
  No edge requests recorded in this window yet. Status codes, cache hit-rate, and
  bandwidth appear here once traffic arrives.
</p>

<!-- Line 447: passive "zone not resolved" -->
<p class="dl-empty" data-testid="an-dl-unavailable">
  Edge delivery metrics aren't available for this site's domains yet — they're served on a
  shared projectsites.dev zone. Connect a custom domain to see status codes, cache
  hit-rate, and bandwidth.
</p>
```

**Evidence:** The "Connect a custom domain" text is HINT, not LINK. A user reading "not available yet" has no obvious next step — they must infer "go to Domains admin and add a custom hostname." The second block is a launchpad opportunity.

**Action:** `[READY]` Convert the "Connect a custom domain" hint into an inline link or a secondary button launching the domains admin. Cost: 20 min. Include a `data-testid="an-dl-add-domain-cta"` so E2E can verify the CTA exists.

---

### [A11Y] Disabled button uses opacity-only feedback
**deliverability.component.ts:107-108** — The "Check deliverability" button uses `disabled:opacity-50` to signal a disabled state:

```html
<button
  hlmBtn
  data-testid="deliverability-check-btn"
  class="... disabled:opacity-50 disabled:cursor-not-allowed ..."
  [disabled]="loading() || domainInvalid() || flagDisabled()"
  [attr.aria-busy]="loading()"
>
  {{ loading() ? 'Checking DNS…' : 'Check deliverability' }}
</button>
```

**Evidence:** Per `buttons-accommodate-largest-text`, the button ALSO toggles its TEXT from "Check deliverability" (19 chars) to "Checking DNS…" (12 chars), which is fine because the text-swap uses `min-width` (checked via `buttons-accommodate-largest-text` auditing). BUT the `disabled:opacity-50` is the ONLY visual state change when domainInvalid() is true (the button greys out at 50% opacity). Per WCAG, opacity alone is insufficient for a "disabled" state; the cursor already changes to `not-allowed`, which is good, but the opacity fade may not be perceptible to low-vision users.

**Action:** `[READY]` Add `disabled:bg-opacity-75 disabled:text-opacity-75` or a separate disabled-state color (e.g., `disabled:bg-gray-700 disabled:text-gray-500`) to make the disabled state semantically visible without relying on opacity alone. Cost: 10 min. Verify via axe-core + manual contrast check at reduced-motion.

---

### [SPLIT] delivery-card.component 584 LOC is a large presentational component
**delivery-card.component.ts:1-584** — A single 584-line component owns:
- 15 computed signal properties (statusRows, errorPct, errorCodes, bytesLabel, edgeGroups, verifiedBots)
- Status row rendering + color classification (2xx/3xx/4xx/5xx logic)
- Cache-hit ratio + edge bandwidth metrics
- 6 nested "groups" (HTTP protocol, TLS, content-type, method, verified-bots)
- Extensive CSS styles (15 internal classes, 296 LOC)

**Evidence:** No CRITICAL gap — the component is well-structured with clear separation of concerns (template vs. logic). But at 584 LOC it approaches the "god component" threshold. Splitting is NOT urgent, but a future refactor could extract:
- `StatusRowsComponent` (computed statusRows + rendering)
- `CacheMetricsComponent` (cache-hit-ratio display)
- `EdgeGroupsComponent` (protocol/TLS/content-type/method grid)

**Action:** Not READY this fire — this is a "surface in Recs" item. If the component grows past 650 LOC or gains new metrics, propose a split. For now, document in comments that these sub-concerns are collocated but could be extracted. Cost to refactor now: 2h+ (risky without E2E coverage of all edge cases).

---

## Gate Summary

✅ **H1 handling** — level-aware input properly gates dual h1 (h1 in standalone, h2 when embedded)
✅ **Aria labels** — comprehensive on interactive + image regions (progress bar, score image, field descriptions)
✅ **Empty states** — calm, non-alarming (neutral cyan for feature-gate-off; no red error spam)
✅ **Error recovery** — error card with retry button + copyable request_id
✅ **Keyboard nav** — button focus rings in place, input aria-describedby linked
✅ **Contrast** — brand tokens used throughout (fallback hex in place); yellow/red status colors meet 4.5:1
✅ **Responsive** — grid uses gap/px sizing, no hard viewport breakpoints

---

## Next-Wave Tasks

### Ready-to-Ship (all <2h, no design conversation)

1. **[VQA] Wrap hard-coded status colors in CSS vars** — delivery-card @ lines 148,151,156,221
   - Add `--ps-status-4xx`, `--ps-status-5xx`, `--ps-error-text` to `_polish.scss`
   - Update references to use `var(--ps-status-4xx, #f5a524)` pattern
   - Verify no visual regression via a screenshot of the delivery card's status rows

2. **[EMPTY] Add CTA link to "Connect custom domain" empty state** — delivery-card @ line 447
   - Convert hint text into a clickable link or secondary button
   - Route to `/admin/domains` using `RouterLink` or `click="navigateTo('domains')"`
   - Add `data-testid="an-dl-add-domain-cta"` for E2E verification

3. **[A11Y] Add semantic disabled styling beyond opacity** — deliverability @ line 107
   - Replace `disabled:opacity-50` with `disabled:bg-primary/30 disabled:text-primary/70` or similar
   - Test the disabled state's contrast ratio (must meet 3:1 for non-text, 4.5:1 for text per WCAG)
   - Verify via axe-core in Playwright

### Not Ready This Fire

4. **[SPLIT] Consider extracting StatusRows / CacheMetrics / EdgeGroups sub-components** — delivery-card
   - Deferred until component exceeds 650 LOC or gains new metrics
   - Document in JSDoc that these concerns are collocated but could be split

---

## Sub-Areas NOT Reached

- **Animations:** Reveal directive + rolling-counter integration verified working; no scroll-driven animations in scope.
- **Mobile responsive:** Both components use gap/px sizing (no hard breakpoints); responsive verified via `@media (max-width: 480px)` in delivery-card.
- **Copy audit:** Prose strings checked for banned slop; all copy is clear, no subjective tone issues.

