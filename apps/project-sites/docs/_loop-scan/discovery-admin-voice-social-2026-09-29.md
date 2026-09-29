# Discovery — admin voice + social VQA (Lane 4, loop fire 2026-09-29)

> Read-only audit of the two admin sections fire-5's VQA did NOT reach. Feeds §4.1 + Lane 4.
> Headline: both are largely COMPLIANT with the `hosting.component` standard — the real work is
> splitting the oversized `social.component.ts` + one empty-state CTA.

## Confirmed compliant (no action)
- **H1** — voice (`voice.component.ts:77` `<h1 class="section-h">`) + social (`social.component.ts:246` `<h1 class="social-h1">`) both render their own single H1. ✓
- **Real-time** — neither has a manual Refresh/Reconcile button; both read the shell's `selectedSite()` (AdminStateService visibility-gated poll). ✓ (correct-by-design)
- **Dead controls** — social publish button is disabled-WITH-reason (`social.component.ts:671`, `aria-describedby`→`publishBlockReason()` at `:2311`). Exemplary. ✓
- **Keyboard/a11y** — tab `role="tablist"` + arrow-key handlers, dialog-shell focus-trap, aria-labels; spot-checks pass.

## Next-wave tasks
1. **[SPLIT] `social.component.ts` (2649 lines / 131KB) → 5 sub-components.** Natural, low-coupling boundaries: `social-accounts` (~250 LOC), `social-composer` core + `social-composer-preview` (~800 split in 2), `social-post-list` (Drafts/Queue/Sent, ~300, reusable across the 3 tabs), `social-dialogs` (~150); parent stays a tab orchestrator. Calendar already extracted. ~4h refactor + 1h E2E regression. Fixes the documented `anyComponentStyle` budget WARN too.
2. **[EMPTY · READY] Social media-uploader empty-state CTA.** `social.component.ts:479` `.media-empty` shows a passive "Drag images/video here" — no first-action button. Add "Choose from stock" / "Generate with AI" inline (mini-empty launchpad). ~1h. (The Drafts/Queue/Sent empty state at `:725` is already an action-armed launchpad — good.)

## Sub-area NOT reached (rotate next fire)
- Feature-Flags admin layer · `/admin/import` · e-commerce/local-SEO sections · remaining voice sub-tabs (conversations, insights, test-console, agent-settings, mcps, share).
