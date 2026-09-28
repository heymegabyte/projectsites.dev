# Interconnectedness Ledger — every major code block reachable + represented in the UI

> Steers the **interconnectedness loop** (cron `3,18,33,48` = every 15 min, job `7a0f9d8c`). Each fire reads
> this FIRST, inventories major code units across the WHOLE repo, verifies UI-REACHABILITY (not just import
> reachability), wires the top built-but-unreachable unit into a discoverable UI path, verifies live, and
> records here. Never assume a prior fire landed. Continuous — never self-deletes.

## THE CORE INSIGHT (why this loop exists — Brian, 2026-09-28)
`scripts/detect-orphans.mjs` is an IMPORT-GRAPH detector: it asks "is this unit imported somewhere?" It is
**BLIND to UI-REACHABILITY** — a component can be imported + conditionally rendered (`action === 'history' &&
<TimeTravelPanel/>`) yet have NO visible control that sets that state, so a USER can never reach it. The
detector reports "0 orphans" (a FALSE GREEN) while the user says "why is there a TimeTravelPanel but I can't
find it." **Reachability = a discoverable path a user can CLICK to** (visible nav / labeled button / tab /
route link / Cmd+K), proven in a real browser — NOT merely an import edge. The loop must converge the detector
toward this stronger check (step 4).

## METHOD (per fire)
1. Inventory major units: editor `app/components/**`, admin `frontend/src/app/**` (components/pages/sections),
   worker `src/routes` + `libs/features/*/handlers`, MCP tools `src/services`, feature modules `libs/features/*`.
2. `node scripts/detect-orphans.mjs` (import-graph first pass) → truly-unimported units.
3. UI-reachability: flag components rendered only behind a state value with no visible trigger; confirm top
   suspects LIVE (authed admin + editor with a throwaway site — E2E org is empty, create+delete via
   `POST /api/sites` on `project-sites.manhattan.workers.dev`). Click through, enumerate reachable, diff.
4. Wire the top finding → a DISCOVERABLE entry (embarrassingly-easy). Deliberate-unwired → ALLOWLIST below.
5. Improve `detect-orphans.mjs` to catch the class you found (converge toward UI-reachability).
6. Verify live (screenshot the newly-reachable unit) + deploy + prod-verify + TDD spec. Commit per fire.

## FINDINGS + FIXES  (fires append; newest first)
- **2026-09-28 · TimeTravelPanel — "can't find it" (Brian).** Root cause: it IS imported + rendered
  (`DatabasePanel.tsx` → `action==='history' && <TimeTravelPanel/>`), reachable ONLY via a small, horizontally-
  scrolling "History" action button on the Database › **Tables** sub-view — labeled "History" (not the feature
  name), easy to miss; the import-graph detector called it "wired." **Fix this fire:** relabeled the action
  **"History" → "Time-travel"** + clearer tooltip so it's findable by name. FOLLOW-UP (next fires): surface the
  Database power-actions (Time-travel / Schema / Import / Seed) more prominently + reachable even in the empty
  state; audit every other `action === 'X' && <Panel/>` for a missing visible trigger.

## ALLOWLIST — deliberately unwired (do NOT re-flag; record rationale)
- `FormBuilder` (`app/components/workbench/DatabasePanel.tsx` — `DATABASE_UNWIRED_BUT_REACHABLE`): kept imported
  for interconnectedness but intentionally NOT a nav entry yet (Brian, 2026-09-27) — pending its own surface.
- Worker webhooks / cron / internal handlers: intentionally headless (no UI) — not orphans.

## KNOWN SUSPECTS TO AUDIT  (seed backlog — fires pull from + append)
- [ ] Every `action === 'X' && <Panel/>` / `subView === 'Y'` conditional render across `app/components/workbench/**` — confirm each state value has a VISIBLE trigger.
- [ ] `SchemaBuilder`, `ImportPanel`, `AiSeedPanel`, `GreenfieldReset`, `KvManager`, `SqlNavigator` — confirm each is reachable + labeled clearly (not buried).
- [ ] Admin sections with no nav entry (cross-check `app.routes.ts` `/admin/*` against the actual sidebar/nav items — every route needs a reachable link OR a documented alias).
- [ ] Worker `libs/features/*/handlers` + `src/routes` endpoints with no admin/editor caller + no intentional-headless note.
- [ ] MCP tools in `src/services` not represented anywhere in the UI.

## RECOMMENDATIONS  (fires append; each: value · rough cost)
- [ ] Upgrade `detect-orphans.mjs` with a UI-reachability pass: parse conditional renders + cross-check each gate value against a setter/trigger; flag "rendered-but-triggerless". (high · ~2h)
- [ ] A build-time gate: every `/admin/*` route in `app.routes.ts` must have a nav/link reference OR an alias entry — fail CI on a route with no reachable path. (high · ~1h)
- [ ] A real-browser "reachability crawl" spec: click every nav/tab/action, assert the expected component mounts; diff reached-set vs built-inventory. (high · ~2-3h)

## "WHAT INTERCONNECTEDNESS NEEDS"  (running generalized rules — fires append)
- Import-reachability ≠ UI-reachability. Prove reachability by CLICKING in a real browser, never by grep.
- Every built panel/component/route needs a DISCOVERABLE, well-labeled entry — or an explicit allowlist note.
- Label controls by the FEATURE name users search for (a "History" button hid "TimeTravelPanel").
