# Discovery — e-commerce/local-SEO + voice sub-tabs VQA (Lane 4, loop fire 2026-09-29)

**Headline:** E-commerce/local-SEO sections do not exist. Voice sub-tabs (conversations, insights, test-console, agent-settings, mcps, share) are LIVE. Found: 1×[RT] refresh-button, 2×[VQA] hard-coded color drift, no other blockers.

## E-commerce / Local-SEO sections
- **NOT FOUND.** Grep for `commerce|shop|store|seo|local|product|catalog` across admin/sections returns zero matches. These features have not yet been built/scaffolded.

## Voice sub-tabs audit (7 files: conversations, insights, test-console, agent-settings, mcps, share + parent voice.component)

### Confirmed compliant
- **H1** — voice.component.ts:77 renders `<h1 class="section-h">Voice</h1>` ✓ (shell does NOT duplicate; sub-tabs have no H1, which is correct — breadcrumb + parent h1 suffice)
- **Keyboard/a11y** — voice-shell tab `role="tablist"` + arrow-key handlers, `aria-selected`, focus management ✓
- **Dead controls** — no buttons found in disabled-without-reason state; all disabled states carry title/aria-disabled ✓
- **God-components** — all <800 LOC; largest is numbers.component (729) ✓
- **Empty states** — conversations empty-state has action-armed launchpad ("Share your phone number on the Share tab") ✓

### Next-wave tasks

1. **[RT] conversations.component:123 manual Refresh button → real-time visibility-gated polling.** The `@if (loading() && filtered().length === 0)` path shows skeleton + polled data, but the button at line 123 `(click)="refresh()"` is a manual override. Per `[[sync-ui-async-backing]]` the feed should poll automatically (30s, pause on document.hidden) — the button is friction. The component DOES have `startPolling()` + visibility listener in `constructor`, so the wiring exists. The button was likely added for UX confidence during slow networks. Recommendation: remove the button; ensure the auto-poll is visible in status (e.g., "auto-refreshing every 30s") per `hosting.component` precedent. ~~2h~~ **[READY] ~30min.**

2. **[VQA] voice/insights.component.ts lines 203–210: hard-coded sentiment-bar colors → `--ps-*` tokens.** Found: `background: #f6c344` (positive), `#ff6b6b` (escalated/negative), `#ff9b9b` (text). These are brand-correct but drift from the `--ps-accent` + `--ps-success` token layer. Cross-refs: test-console.component:244 also hard-codes gradient `#34d399, #00E5FF, #fbbf24, #f87171`. Proposal: (a) define `--ps-sentiment-positive`, `--ps-sentiment-escalated`, `--ps-sentiment-negative` in `_polish.scss`, (b) replace all hard-codes, (c) audit the rest of voice/* for any remaining drift. ~~4h~~ **[READY] ~2h (if one pass).**

3. **[VQA] test-console.component.ts line 207, 236, 239, 244: micro color-palette hard-codes.** Dot indicators, button backgrounds, volume-meter gradient all use Tailwind semantic colors (green, red, yellow) — which is **brand-correct** but ADDS a THIRD color system (Tailwind + `--ps-*` + hard-hex). Proposal: freeze the test-console palette as-is (it's shipped + tested), OR map one commit: `#34d399 → --ps-success`, `#f87171 → --ps-error`, `#fbbf24 → --ps-warning` and retire the hard-codes. Vote: keep-as-is (shipped stable) — audit only. Mark as examined and accepted.

4. **[EMPTY] agent-settings.component — no empty state for "no voice agent configured."** The component reads `/api/voice/agent-settings` and populates form fields, but if the site has ZERO agent settings (fresh voice site) there's no launchpad ("Click Generate to auto-configure" / "Choose an LLM + voice, then save"). Symptom: user sees empty form fields with no action. Proposal: wrap the form in `@if (loaded()) @if (settings); else { <empty-state /> }`. ~~1.5h~~ [READY if simple form-wrap] ~1h.

## Sub-area NOT reached (rotate next fire)
- Feature-Flags admin layer (`/admin/feature-flags`)
- Bulk import route (`/admin/import`)
- E-commerce product/catalog sections (not scaffolded)
- Local-SEO sections (not scaffolded)
- Remaining routes: `/admin/seo`, `/admin/local`, etc. (audit if they exist)

