# UI Mock-Out Plan — projectsites.dev

> **Brian directive 2026-10-06:** "more initial effort on fully developing the UI (perhaps even
> with test data), then execute a plan that fully mocks out the UI." Doctrine:
> `~/.agentskills/rules/ui-first-mock-data.md`. Goal: EVERY admin + create + preview surface is
> fully UI-built with a **typed fixture layer** and **all states**, demoable with ZERO backend,
> then the real data swaps in at the `ApiService` boundary (one-line provider change).

## The seam (Phase 0 — build FIRST; everything else depends on it)
- **Mock mode toggle**: a URL param `?mock=1` (and/or a build/env flag) flips the app into
  fixture mode. REAL is the prod default — mock never reaches prod as real (honesty mandate).
- **Interception point**: an Angular `HttpInterceptor` (`interceptors/`) that, in mock mode,
  short-circuits `/api/*` and returns the registered fixture for the matched route (realistic
  latency + the full response envelope). All traffic already funnels through `ApiService` → this
  is the single swap point. (Alt: provide a `MockApiService` via `app.config.ts` when the flag is
  set — pick the interceptor; it needs no component changes.)
- **Fixtures registry**: `src/app/mocks/fixtures/*.ts` — one typed fixture module per route/domain
  (leads, forms, sites, billing/wallet, analytics, domains, snapshots, …), each satisfying the
  SAME Zod/interface contract the real endpoint returns. Rich + believable: 50+ leads, mixed
  statuses, long names, zero/empty variants, error variants (so every STATE is reachable by a
  fixture knob, e.g. `?mock=1&state=empty|error|loading`).
- **Acceptance**: with `?mock=1`, a reviewer navigates the whole admin + create flow and every
  surface renders finished — no spinner-forever, no empty-because-no-backend, no console errors.

## Phased slices (each = one loop fire; resume slice-by-slice)
**P0 — Seam + pattern:** the interceptor + mode toggle + fixtures registry + fully mock ONE
representative surface end-to-end (leads — it now has pagination from #26) incl. empty/loading/
error/populated/edge. Establishes the pattern every later slice copies.

**P1 — Activation / money path (highest value):** dashboard · `/create`→`/waiting` (all build
phases incl. failed) · billing+wallet · leads/forms · sites list+detail. Every state on fixtures.

**P2 — Remaining admin sections:** analytics · domains · seo · mcp · social · voice · snapshots ·
audit · docs · settings · feature-flags. One or two sections per fire.

**P3 — Generated-site previews + editor data surfaces:** a fixture site (manifest + R2 files) so
the preview + the editor Data/Tables render on mock data without a real build.

**P4 — Demo gallery:** a `?mock=1` route index that links every mocked surface + state (a
Storybook-lite "whole product on fixtures" walkthrough) — the "fully mocked UI" deliverable + a
visual-regression target.

## Discipline per slice
- Typed fixtures (same contract as real) behind the seam — never inline hardcoded data in a
  component. Every state present. Gorgeous-by-default + embarrassingly-easy bars apply on fixtures.
- TDD: a Karma/Playwright assertion that `?mock=1` renders the surface + its states with no console
  errors. Keep REAL the prod default (guard the flag; `eval-mock-mode-discipline`).
- Deploy admin R2 + prod-verify the `?mock=1` surface renders (no real backend touched).

## Execution status
- **P0 pending.** Fan-out execution is currently blocked by the Opus weekly limit (resets
  2026-10-08 09:00 ET) — see [[never-prompt-full-permission-and-classifier-outage]] /
  `opus-quota-fallback`. Resume via the **DeepSeek-via-OpenCode** rail (`bin/opencode-deepseek.sh`,
  Opus-quota-independent) or harness fan-out at reset. Each slice lands independently.
