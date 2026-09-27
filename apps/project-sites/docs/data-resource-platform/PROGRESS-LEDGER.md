# Data Resource-Platform — Progress Ledger

Loop-maintained (cron `ef7c305d`, every 15m). Each fire folds prior work, advances the next slice, updates this file. Source of truth for "what's done / what's next". See `PHASED-PLAN.md` for full specs, `SECURITY-INVARIANTS.md` for the non-negotiables, `CAPABILITY-MATRIX.md` for per-kind CF reality.

**Tab split (Brian 2026-09-27):** resources live across two editor tabs. **Data** = D1/KV/R2/DB-connections + Vectorize. **Backend** (final tab) = Durable Objects/Workflows/Queues/scheduled-tasks/Worker-bindings. Overview/discovery is **shared** (each tab shows its own inventory); observability (logs + Analytics Engine) is cross-cutting, surfaced under **Backend**. Data-tab phases ship before Backend-tab phases. Phase numbers below are stable IDs (not build order) — the `Tab` column + `PHASED-PLAN.md` ordering drive the sequence.

## Status legend
`done` = built + verified + committed + deployed + prod-verified · `in_progress` = building/folding · `pending` = not started · `blocked` = needs a gated decision

| Phase | Slice | Tab | Status | Commit / Notes |
|---|---|---|---|---|
| 0 | **Foundation** — registry migration `0643_data_resource_registry.sql` (`site_resource_registry` table + `site_database_allocations` sync cols), Zod schemas, `resolveResourceRef`/`listResources`/`getResource`/`recordResource` service, `ResourceAdapter` interface, `data_resource_platform` flag | shared | **done** (code) | `6ff6b154d` — typecheck 0, 30/30 tests. ⚠️ migration `0643` NOT yet applied to prod D1 — apply at first wired-slice deploy. |
| 1 | **Discovery / Overview** — per-tab "Resources" panel (inventory grouped by kind×env, lifecycle/tenancy/drift badges, empty-state launchpad) via `PS_RES_OVERVIEW_*` bridge; MCP `data_list_resources` + `data_reconcile_resources` (`data:read`); adapter `head` + reconciler (drift detect); overview API endpoint | shared | **in_progress** | fire #1 — build workflow launched |
| 2 | **D1** — re-route existing Tables surface through the adapter; table-schema view; gated parameterized row write; SQL history/EXPLAIN; backup/PITR where CF permits | Data | pending | |
| 3 | **KV** — cursor/prefix key list, get/put/delete, TTL/metadata, bulk ops, preview↔prod copy | Data | pending | |
| 4 | **R2** — object browser (prefix + continuation), get/put/delete, previews, metadata, multipart upload; bucket config; distinct from Worker Static Assets | Data | pending | |
| 5 | **Vectorize / AI-Search** — per-site namespace list, query, upsert/delete by id (namespace-scoped) | Data | pending | |
| 8a | **Connections** — Hyperdrive / external DB connections list + health + revoke (the DB-connection half of old Phase 8) | Data | pending | |
| 6 | **Workflows** — per-site runs list, status/steps/errors, start/pause/resume/restart/terminate | Backend | pending | |
| 7 | **Durable Objects** — instance list (from our index, not CF browse-all), status/reset/send via opt-in mgmt interface | Backend | pending | |
| 8b | **Queues + scheduled tasks + Worker bindings + Observability** — queues (send/peek + guarded pull/ack/purge or `not_supported`), Cron Triggers, Worker bindings (service/Secrets Store/AI/Browser/Images), site-filtered logs + Analytics Engine (cross-cutting, Worker-level) | Backend | pending | |

## Parity gate (every phase)
Each phase ships BOTH the Data-tab UI section AND the parity ProjectSites MCP tool(s), on the SAME server-side registry+authz services. Not done until UI+MCP+adapter+tests all green and the changed surfaces are prod-verified.
