# Orphan Detector Scan — 2026-09-29

**Counts:** 1 orphaned unit flagged · 1 real orphan

## Summary

The orphan detector (`scripts/detect-orphans.mjs`) ran on 2026-09-29 and found **1 NEW unwired code unit**. Cross-checks against Lane 5 interconnectedness checklist confirm it is a real orphan (built, zero reachable surface).

### GitPanel (EDITOR_PANEL — HIGH confidence)

- **Path:** `app/components/workbench/GitPanel.tsx` (1134 lines)
- **Status:** Exported, imported by ZERO non-test files. No JSX render anywhere under `app/`.
- **Verdict:** REAL ORPHAN — built, exported, unused.

### Inspectors Spot-Check (r2-inspector, kv-inspector, vectorize-inspector, queues-inspector)

All four inspectors ARE wired and reachable:

| Inspector | Route | Reachability | Notes |
|-----------|-------|--------------|-------|
| **kv-inspector** | `/admin/kv-inspector` | ✅ Routed in `app.routes.ts:260` | Feature-flagged (`kv_inspector`); `sysAdminGuard` guards it; labeled in `admin-section-labels.ts` |
| **r2-inspector** | `/admin/r2-inspector` | ✅ Routed in `app.routes.ts:264` | Super-admin only; labeled in `admin-section-labels.ts` |
| **vectorize-inspector** | `/admin/vectorize-inspector` | ✅ Routed in `app.routes.ts:273` | Feature-flagged; super-admin only; labeled |
| **queues-inspector** | `/admin/queues-inspector` | ✅ Routed in `app.routes.ts:283` | Super-admin only; labeled in `admin-section-labels.ts` |

All four are **intentional-headless or admin-only** — they have routes and labels but no sidebar nav entry for regular users (by design, feature-flag or role gating). They ARE reachable via direct URL navigation or role escalation.

### traces, deliverability, super-admin

- **traces:** 301 redirect to `/admin/logs?tab=traces` (routed as a tab within the unified Logs dashboard) ✅
- **deliverability:** Routed at `/admin/deliverability`, feature-flagged (`email_deliverability_wizard`) ✅
- **super-admin:** ✅ Comment in routes indicates it's a feature-flag-gated section (not a standalone route)

## Next-Wave Tasks

- [WIRE] **GitPanel** (`app/components/workbench/GitPanel.tsx`) → Evidence: 0 importers, no render, orphan detector HIGH confidence. Action: EITHER delete if superseded (recommend) OR wire into `Workbench.client.tsx` `PanelLayer` if intentional. **[READY]** (estimated <30min).

## Sub-Areas NOT Reached

No additional sub-areas found orphaned. All admin inspector sections have explicit routes + labels.

**Docs:** Lane 5 interconnectedness ledger fully updated.

