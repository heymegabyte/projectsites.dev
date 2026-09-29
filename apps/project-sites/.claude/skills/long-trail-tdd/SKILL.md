---
name: long-trail-tdd
description: Design EXACT, LONG, stateful browser test cases (60-100 actions, 6+ surfaces) and complete them through TDD — real UI + real backend, screenshot-after-every-view + AI-vision, RED-before-fix, durable checkpoint/resume.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, mcp__playwright__*
---

# long-trail-tdd

Design an EXACT, LONG, stateful, real-user browser test case, then COMPLETE it through TDD —
against the real UI and a real backend, screenshotting + AI-inspecting every view, proving a
genuine RED before touching product code, and resuming from a durable checkpoint across cycles.

This skill is the METHODOLOGY. It carries no project specifics — stack, URLs, ports, selectors,
seed accounts, and flags live in the invoking project command / project `CLAUDE.md`. Read those
first; discover everything else from the running app.

The bar is a "long trail": one case ≈ **60-100 MEANINGFUL browser actions across ≥6 surfaces**,
not a happy-path smoke test. Long, stateful journeys expose the drift a short green test can't:
navigation-away/back loss, refresh non-persistence, lying-empty states, wrong-source data, orphaned
features, and cross-feature causal breaks.

---

## Core loop (per case)

`evidence-map → choose outcome → author numbered case → write executable journey + unit regressions →
run, observe GENUINE RED → root-cause fix → GREEN → screenshot+AI-vision every view → checkpoint →
resume & replay whole journey → done`.

One relentless cycle. The main thread designs + orchestrates; edits land in one isolated worktree that
owns code + tests + the browser. Never mark done on a partial replay.

---

## 1. Evidence map → choose a real OUTCOME → author the case FIRST

- Build an **evidence map** by reconciling FOUR sources — code (routes/handlers/components),
  existing tests, docs/memories, and the **LIVE UI** clicked in a real browser. They disagree; the
  live app + the store are ground truth.
- **A doc describing a feature is a REQUIREMENT TO VERIFY, never proof it works.** "Merged",
  "documented", "shipped in changelog" = a claim to reproduce against the running app, not a pass.
- Choose a real user **OUTCOME** a person would care about (e.g. "sign in → generate a thing →
  edit it → publish → confirm it's live → undo"), not an isolated widget.
- **Write the case as a durable NUMBERED spec BEFORE implementing any missing behavior.** The case
  is the artifact; it outlives the browser and drives the TDD. Prefer an outcome where the evidence
  map already hints at a gap or a doc-vs-reality mismatch — that becomes the RED.

## 2. Long trail: 60-100 meaningful actions across ≥6 surfaces

- **60-100 MEANINGFUL actions** — a click, type, submit, select, drag, keypress, or nav that
  changes state or asserts something. 2-10 minutes of active clicking/typing.
- **Do NOT count or pad idle time** — build spinners, AI generation, deploy waits, `waitFor` are not
  actions. If a real journey is genuinely shorter, keep it honest and go DEEPER (more states, more
  causal checks) rather than inflating the count.
- **≥6 distinct surfaces** — pages/routes/modals/panels/tabs. Breadth is where cross-feature bugs
  hide; a 100-action loop on one screen is not a long trail.

## 3. Per-action spec (every row of the numbered case)

Each numbered action records ALL of:

- **Starting state** — where the app is before this action (route, what's on screen).
- **Exact UI action + locator** — the precise interaction and the selector, **DISCOVERED from the
  live app** (role, `data-testid`, visible text). **Never invent a selector** — open the app, find
  the real one. A guessed locator is a fabricated test.
- **Expected visible state** — what the user should SEE after (text, element, count, route).
- **Expected API/storage effect** — when relevant, the request fired and/or the row written
  (endpoint, status, the record in the store). Assert the effect, not just the pixel.
- **Screenshot-required?** — yes for every distinct view / meaningful UI state (see §6).

## 4. What a long trail MUST include (not just the happy path)

- **Navigate away and back** — leave the surface, return; assert in-progress state is retained (or
  correctly reset). Catches state that lives only in a component that unmounts.
- **Hard-refresh persistence** — reload the page mid-journey; assert what SHOULD persist is re-read
  from the server/store, and what shouldn't is gone. Catches write-only / local-first cache masking a
  missing server read.
- **Empty state** — the first-run / no-data view (assert it's an honest empty + ideally a
  first-action launchpad, not a dead end or a lying-empty).
- **Error state** — an invalid submit / rejected action; assert a real, human error surfaces (not a
  silent swallow, not a fake success).
- **Undo / cleanup** — reverse the mutation and assert the store returns to baseline; leave no test
  residue.
- **Cross-feature CAUSAL check** — do X on surface A, then assert its EFFECT shows on surface B
  (e.g. create a record, then see it counted on a dashboard). Reconcile display against the
  authoritative store, not against the same endpoint the UI reads.
- **A success toast is NEVER an oracle.** "Saved!" proves a click, not a write. The oracle is the
  reloaded surface, the second surface, or a direct store read.

## 5. Executable TDD — prove a GENUINE RED before touching product code

- Write the **executable Playwright journey** (the numbered case as code) PLUS focused
  unit/integration **regressions** for each fix (fast, deterministic, run on every edit).
- For a reproduced bug or missing feature: **run the journey and OBSERVE a genuine RED** — a real
  assertion failing against the real app — **before changing any product code.** Watch it fail, then
  root-cause fix, then watch it go GREEN, then continue the trail.
- **If a step already PASSES, that's a baseline win — keep it and explore further.** Add deeper
  assertions, more states, the next surface. **NEVER manufacture an error at a prescribed click
  number** to satisfy a "RED-first" ritual — a fake failure is worse than no test. RED-first applies
  to the specific behavior you're changing, not to steps that already work.
- Fix the **root cause**, not the assertion. If the test itself is wrong, fix the test — but a
  behavioral expectation changes only with the owner's intent.
- Deterministic only: locator waits, no sleeps; stable selectors; parallel-safe.

## 6. Screenshot + AI-vision after EVERY distinct view — before the next step

- After every distinct view or meaningful UI state change: capture **ONE screenshot** and
  **inspect it IMMEDIATELY with AI vision BEFORE the next action.** Do not batch screenshots for a
  vision pass at the end — inspect-then-proceed.
- The vision inspection **combines**: the image + the DOM snapshot + console messages + network
  activity + the a11y tree + the relevant source + the requirements/case + the design system. A
  screenshot alone under-judges; the fusion catches broken-but-renders (black canvas, soft-404,
  lying-empty, contrast failures, off-brand).
- **Ship feasible, high-confidence improvements IMMEDIATELY, then re-screenshot** to confirm (per
  auto-integrate-recs: <2h + no design call = ship, don't defer). Beauty + effortlessness both
  improve every pass.
- **Backlog** larger or uncertain improvements with the evidence (screenshot + finding) AND an
  acceptance test that will prove them later — never a naked TODO.

## 7. Durable CHECKPOINT — resume + replay across cycles

- A browser process does NOT survive between cycles/sessions. Persist a durable checkpoint after
  meaningful progress so the next cycle resumes exactly. Record:
  - **Case ID** + **last completed action #** + **the exact next action**.
  - **Worktree path + ports** (dev server, browser profile) in use.
  - **Test-resource IDs** created so far (uniquely-prefixed — see Isolation).
  - **Screenshot findings** (what vision flagged, what shipped, what's backlogged).
  - **Actual RED/GREEN status** per fix in flight.
  - **Blockers** (missing selector, flag off, unmet precondition + the fix).
- On resume: **recreate browser state via the UI** (re-drive the earlier steps) or via
  **deterministic fixtures** — never assume the prior browser/login/DOM still exists.
- **Replay the COMPLETE journey end-to-end before marking the case done.** A case is done only when
  the full numbered trail passes in one clean run, every view AI-inspected, every causal + persistence
  check green — not when the last edit compiled.

---

## Isolation (mandatory for concurrent agents)

- **ONE isolated worktree owns code + tests + the browser** for a case: edit → observe live reload →
  run focused tests → inspect screenshots → continue after repair. All in that worktree.
- Each concurrent agent gets: a **separate dev-server port**, a **separate browser profile / user-data
  dir**, a **separate local data dir**, and **uniquely-PREFIXED test resources** (e.g.
  `ltt-<agent>-<ts>-…`) so parallel runs never collide or read each other's rows.
- **Never assume the browser from a previous cycle is alive** — always re-establish state.

## Safety rails (fail-closed)

- **Recipient / side-effect ALLOWLIST, fail-closed** — any email/SMS/webhook/charge target is checked
  against an allowlist; unknown target = refuse, never send. Absence of an allowlist = do not fire.
- **Payments in TEST MODE only** — never a live charge in a journey.
- **Disposable, uniquely-named resources** — everything the journey creates is prefixed + torn down;
  the undo/cleanup step (§4) leaves the store at baseline.
- **Tenant isolation** — a journey operates ONLY on its own test tenant/account; NEVER read, alter, or
  delete another customer's data. Cross-tenant access attempts are themselves assertions (should be
  denied), not conveniences.

## Ramp-up: start narrow, widen near release

- **Early**: ONE desktop viewport, ONE screenshot at a time, inspect-then-proceed. Get the trail
  correct and green first; don't fan out to a matrix while the journey is still being discovered.
- **Near release**: EXPAND the same case to responsive breakpoints, multiple browsers,
  keyboard-only + a11y passes, and a performance check — then a DEPLOYED prod pass.
- **Keep LOCAL journey evidence distinct from DEPLOYED/prod evidence** — separate screenshot dirs /
  labels. A local green is a design gate; a deployed green is the release gate. Never let a local pass
  masquerade as prod-verified.

---

## Anti-patterns

- Treating a doc / changelog / "merged" as proof — it's a requirement to verify.
- Padding to hit 60-100 with idle waits or repeated no-op clicks on one screen.
- Inventing selectors instead of discovering them from the live app.
- Accepting a success toast as the oracle (assert the reload / second surface / store instead).
- Manufacturing a RED at a prescribed step when the behavior already works.
- Batching screenshots for one vision pass at the end instead of inspect-then-proceed.
- Marking done without replaying the COMPLETE journey in the current cycle.
- Sharing ports / profiles / data dirs / resource prefixes across concurrent agents.
- Firing a real email/charge, or touching another tenant's data, from a journey.

## When to use

- "Design + complete a long, exact, real-user test case for <outcome>."
- Proving a documented-but-unverified feature actually works end-to-end.
- A stateful multi-surface flow (auth → create → edit → publish → verify → undo) needs real coverage.

## When NOT to use

- A single-widget or single-assertion unit fix (use test-repair-loop / test-writer).
- Pure static/type/lint repair with no user journey (test-repair-loop).
- Greenfield component tests with no cross-surface state (test-writer agent).

## Related

- `test-repair-loop` — reproduce→isolate→fix→broaden discipline this reuses per RED.
- `verify` / `run` — launch + observe the real app.
- `rules/verification-loop.md` · `rules/verify-against-source-of-truth.md` (display-vs-store) ·
  `rules/e2e-tdd-organization.md` · `rules/e2e-visual-inspection.md` · `rules/predictive-completeness.md`.
