# Discovery — admin VQA + E2E coverage (loop fire, 2026-09-29)

> Read-only audit of the Angular admin sections (`frontend/src/app/pages/admin/sections/*`) +
> E2E coverage. Feeds `_RUN_THE_LOOP.md` §4.1 + Lane 4. Deduplicated against the queue.
> `hosting.component.ts` (this session's Unit 6) is the compliance reference: 1 H1, live-poll no
> Refresh, disabled-WITH-reason. Several older sections drifted from that bar.

## Next-wave tasks

1. **[RT · READY] Kill 4 manual Refresh buttons** — same class as the editor R1 fix, on the ADMIN side:
   `analytics.component.ts:249` ("Refresh data now" + a 60s auto-refresh already runs = duplicate), `site-dna.component.ts:205`, `site-data-browser.component.ts:327`, `audit.component.ts:156`. Action: remove each button; rely on the existing poll + a "Live · updated Ns ago" affordance (mirror `hosting.component.ts`). ~1-2h for all four.
2. **[A11Y · READY] Add a page-level H1** to sections rendering ZERO: `analytics`, `ai-logs`, `analytics-glossary`, `analytics-live`, `api-tokens`. WCAG 2.2 (exactly 1 H1/folded page). ~1h.
3. **[A11Y · READY] Demote extra H1s to H2** where 2-3 render: `accept-invite`, `apps-instances`, `audit`, `deliverability`. Keep exactly one page-level H1. ~1h.
4. **[EMPTY] Empty-state launchpads** — `api-tokens` ("Generate your first token"), `snapshots` ("Create a snapshot"), `domains` (provisioning flow) render bare "no data" instead of a first-action CTA. Action: wire the `mini-empty` launchpad pattern. ~2h.
5. **[E2E · READY] `admin-hosting-wfp.e2e.ts`** — the new `/admin/hosting` (Unit 6) has NO prod E2E. Journey: select site → status pill → copy preview/prod URLs → gated-card when flag off. Flag `site_wfp_hosting` (enable scoped for the run). ~2h.
6. **[E2E] `admin-data-platform-crud.e2e.ts`** — `/admin/sites/:id/db/tables` (+ the new schema rail + bulk fill-down) have no dedicated admin-side E2E. Full CRUD journey behind `per_site_data`. ~2-3h.

## Sub-areas NOT reached (rotate next fire)
- Voice section (voice/conversations, agent-settings, numbers) · Social (2649-ln god-component, multi-tab realtime) · Feature-Flags admin layer · `/admin/import` · e-commerce/local-SEO sections.
