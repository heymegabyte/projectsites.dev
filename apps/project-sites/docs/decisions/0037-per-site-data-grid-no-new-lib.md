# 0037 — Per-site D1 Data grid: no new grid library (reuse @tanstack/react-virtual)

**Status:** accepted
**Date:** 2026-09-26
**Deciders:** Brian Zalewski
**Relates-to:** [0036 — Per-site D1 + KV isolation](0036-per-site-d1-kv-isolation.md) (this ADR governs how that surface RENDERS)

> Note: the requested filename was `0036-…`, but `0036` is already the accepted per-site
> D1+KV isolation ADR. ADR numbers are never reused, so this lands as `0037`.

## Context

- The Editor "Data" tab's **Tables** surface (ADR-0036) browses a customer's OWN per-site D1 —
  read-only, server-paginated at `limit <= 200` rows (`GET /api/sites/:siteId/db/tables/:table`).
- The existing editor DataPanel already renders tabular rows with a hand-rolled browse pattern.
- The open question was whether to pull in a dedicated data-grid library — RevoGrid, Tabulator,
  AG-Grid, or Glide Data Grid — to render this surface.

## Decision

**Do NOT add a new grid library.** Reuse **`@tanstack/react-virtual` v3 (already installed)** plus a
hand-rolled read-only virtualized grid that matches the existing DataPanel browse pattern.

- No RevoGrid / Tabulator / AG-Grid / Glide dependency for the per-site Data platform.
- Row virtualization via the already-present `@tanstack/react-virtual`.
- One grid paradigm across the whole editor — the Data Tables view looks and behaves like the
  DataPanel the user already knows.

## Rationale

- **Priority-1 simplicity** (`brian-preferences` order: simplicity > cost > speed > compatibility).
- **Zero new dependency** — `@tanstack/react-virtual` is installed; no bundle/supply-chain add.
- **Zero OSS-license ambiguity** — AG-Grid Enterprise is commercial; Glide's licensing is a review
  cost we skip entirely.
- **One grid paradigm in the editor** — no second widget vocabulary to learn or maintain.
- **The surface is read-only + paginated** (`limit <= 200`) — it needs virtualized rows, not the
  rich editing / pivot / tree feature set those libraries exist to provide.

## Consequences

- **Two-way (reversible) door.** No public contract or data shape is committed; swapping in a grid
  library later is a component-level change, not a migration.
- If rich editing / pivot / tree / grouping features are genuinely needed later, revisit with a
  dedicated ADR that supersedes this one — do not reach for a library ad hoc.
- Column-level features (sort/filter/resize) are ours to build incrementally on the hand-rolled grid;
  each stays consistent with the DataPanel pattern.

## Alternatives considered

- **AG-Grid Community** — rejected: heavy dependency + Enterprise-tier feature gating; overkill for a
  read-only `limit<=200` view.
- **Tabulator / RevoGrid** — rejected: a second grid paradigm in the editor for capabilities this
  surface doesn't use.
- **Glide Data Grid** — rejected: canvas-based, and OSS-license review is a cost we avoid for zero
  benefit at this row scale.
