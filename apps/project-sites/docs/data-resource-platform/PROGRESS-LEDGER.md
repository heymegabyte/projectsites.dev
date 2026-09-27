# Data Resource Platform — Progress Ledger

Append-only log of notable changes to the per-site data platform re-architecture and its guardrails.

## 2026-09-27 — Orphaned-code detector (interconnectedness gate)

- Added `scripts/detect-orphans.mjs` + `scripts/orphans-allowlist.json` + `"detect:orphans"` npm script.
- Purpose: make it impossible for a SUBSTANTIAL code unit to sit disconnected from a user-facing surface unnoticed — the exact anti-mishap the Data-tab SQL/Table-editor (`DataPanel.tsx`) near-miss exposed.
- Detects 4 orphan classes: editor React panels (`app/components/workbench/**`), feature modules (`libs/features/*` w/ a manifest), worker Hono routes (`src/routes/**` not mounted in `src/index.ts`), and MCP tools/adapters (declared-but-never-dispatched).
- Import-graph scan via ripgrep with a pure-Node fallback; each finding carries confidence (high|medium) + a suggested wiring target. Comment/JSDoc-only mentions do NOT count as wiring (the false-wiring trap that hid these).
- Baseline allowlist seeded with 4 known orphans so the gate starts green + ratchets down: `DataPanel.tsx` (SENTINEL — intentionally orphaned-pending-recycle; **remove from the allowlist once the SQL/Table editor is recycled**, which re-arms the detector to ENFORCE the reconnection), `FunctionsPanel.tsx`, `extensions/tabs/{ProblemsTab,LogsTab}.tsx`, and `services/mcp_pkce.ts` (PKCE helpers `mcp_oauth.ts` should import instead of reimplementing inline).
- Exits non-zero on any NEW (un-allowlisted) orphan — ready to join CI/lefthook. Invoke: `npm run detect:orphans` (from `apps/project-sites`).
- Verified: proved the detector flags `DataPanel` when its Workbench render is stripped, and that removing the sentinel turns it into a build-failing NEW orphan.
