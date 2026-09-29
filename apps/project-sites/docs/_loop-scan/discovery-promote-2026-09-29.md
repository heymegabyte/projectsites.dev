# Discovery — Promote-workflow (Lane 1) audit (loop fire, 2026-09-29)

> Read-only audit of the Preview→Promote→Production flow. Feeds `_RUN_THE_LOOP.md` Lane 1.
> Headline: **Slice 5 is ~95% built** — the cyan "Promote" button + full state machine already
> live in `SourceControlPanel.tsx`; the only gap is surfacing it in the editor's MAIN HEADER.

## Key findings
- **Promote button EXISTS** — `SourceControlPanel.tsx:767-808` (`PromoteButton`): exact label "Promote", reserves `min-w-[9ch]` for "Publishing…", full state machine idle→submitting→success|failed|commit_ok_deploy_failed, cyan rocket icon, disabled-WITH-reason (never a dead control). Bridge `PS_PROMOTE_REQUEST/RESPONSE` wired (`embedded-mode.ts`); `doPromote()` handler + `promoteGate()` (6 disable-reason branches) present.
- **Invariants honored** — Preview-only saves; Production only via authorized Promote; promoted bytes = frozen `draft_revision` (idempotency key + `tree_digest` on release); never force-push main; honest outcomes (`success` only when Production actually serves).
- **`durable_preview` flag DARK** (experimental); migration `0646` (`site_working_tree`/`site_releases`) must be applied to prod D1 when the flag goes enabled (per checkpoint).
- No drift/orphan — feature module well-formed (manifest+schema+service+handler+tests).

## Next-wave tasks
1. **[PROMOTE · READY · <2h] Slice 5 — surface Promote in the editor MAIN HEADER.** Today it's inside the Source Control tab (3 clicks: editor→Source Control→Promote). Extract a shallow `PromoteHeaderControl` into the editor top-right action bar (beside Deploy/Preview) sharing `doPromote()` + the terminal-state result. One-click from the main view — the promoted site is LIVE, it deserves front-and-center presence.
2. **[PROMOTE] Slice 6 — async-deploy outcome.** Promote records `success` from a servable-index proxy, not the real async CF deploy outcome. Capture the CF deployment id + flip the release outcome from the actual deploy; add the 12-step transaction (commit subject gen, retry).
3. **[PROMOTE · external] Apply migration `0646` to prod D1** (additive/idempotent, DARK) so the flag can be promoted; then scope `durable_preview` on for the E2E org (mirror `per_site_data`) + run the golden promote journey GREEN.
4. **[PROMOTE] Slice 7** — GitHub App / server-side short-lived creds + webhook sig-verify + reconcile remote main.

## Sub-area NOT reached
- The Promote transaction orchestration internals (Slice 6 background job: commit+deploy+release+retry) — a dedicated worker fire.
