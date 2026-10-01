# fire-60 CHECKPOINT — lead saturated mid-fan-out (2026-10-01 ~03:00 ET)

Lead hit 196k/200k after the WebGL lane returned. 6 lanes were dispatched; 1 returned green,
5 still running when checkpointed. Their FILE EDITS land in this working tree; their final
summaries are in session 907a8f75 `tasks/a*.output` (JSONL — Explore-agent reads only, tail).

## Next session — fold fire-60 (do in order)
1. `node scripts/loop-fire-lock.mjs claim fire-60` (stale lease auto-reclaims; old heartbeat died with prior session).
2. `git status` — lane edits are the truth. Lanes + owned paths:
   - ✅ WebGL (returned GREEN): `apps/project-sites/templates/webgl/**`, 3 vertical.json wires,
     `e2e/webgl-template-gate.mjs`, `docs/webgl-templates.md`. Gate 5/5, presets 8-9/10.
     NEXT: sync `templates/webgl/` → template.projectsites.dev `src/components/` same fire.
   - ⏳ Claim-flow: `libs/features/claim_flow/**`, claim routes in `src/index.ts`, top-bar claim
     CTA, maybe 1 migration. Flag `claim_flow` dark. Needs: deploy + webhook config check.
   - ⏳ Resources-truth: worker resources endpoint/service + editor `app/` Resources Advanced
     panel. Acceptance: lone-mountain-global shows ≥1 R2 + 1 D1 typed rows, 0 "unknown".
   - ⏳ Long-Trail case-001 Phase D: `apps/project-sites/e2e/long-trail/**` + minimal product
     fixes (action-38 editor-iframe blocker). Checkpoint file updated per action.
   - ⏳ Gen metrics: `build_metrics` migration + `src/services/build_metrics.ts` + hooks in
     `workflows/site-generation.ts` + `scripts/gen-baseline.mjs`.
   - ⏳ Frontend quick-wins: `frontend/.../domain-stack.component.*` (poll pattern from
     7b1c5d0b9) + analytics cached-first entry.
3. Converge: per-surface gates (worker: tsc+Jest-from-apps/project-sites+validate:features ·
   frontend: tsc+ng build+test:ci · app/: Vitest) → fix drift → ONE deploy per changed surface
   (worker `--env production` · frontend R2 script · editor Pages) → prod-verify changed routes
   → adversarial pass (IDOR on claim route, flag-off 404, resources rows real, no lying-empty)
   → `git add -f` fold commit + push → LEDGER fire-60 entry → release lease.
4. Standing context: README § Product direction + § Standing invariants (20m cron ed02a44b
   re-arm weekly · ~3M/fire · execute-surgical · north star gen speed+cost <5min/≤$1 ·
   owner-draft/public-gated · gp-09 vision = Anthropic or UB-OpenAI only).
5. If any lane died before writing: its brief is reconstructable from BACKLOG FRONTIER 0 +
   LAUNCH BAR items; re-queue, don't re-fan-out mid-fold.
