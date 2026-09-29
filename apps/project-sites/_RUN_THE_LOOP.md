# Run The Loop — consolidated work queue

> Single source of truth for the `/run-the-loop` command. Every pending workstream, TODO,
> recommendation, and idea harvested from across the repo (2026-09-28), with each item's
> next action + authoritative ledger + status tag. The command reads THIS file, advances
> the next unmet unit(s), verifies, deploys, prod-verifies, commits to `main`, ticks here.
> Granular state stays in each linked ledger — this file is the INDEX, not a duplicate.
>
> Replaces the 5 recurring loop crons (removed 2026-09-28). "Run the loop" is now a
> deliberate, on-demand fire. Status tags: **ACTIVE** · **blocked-external** · **blocked-user**
> · **deferred-lowvalue** · **Brian-gated** (approval-required).

## How the command uses this
- Fan out one fresh worktree-isolated agent per ACTIVE workstream (disjoint subtrees), up to
  the 6-wide ceiling — remaining workstreams run the next wave/fire. One coherent slice each.
- Verify → deploy → prod-verify → commit+push `main` → tick here + the ledger.
- Pull each workstream's concrete items from its linked ledger + the § Harvested backlog below.
- Move a unit to done only when its Acceptance is met; `git add -f` (`.gitignore` blocks `*.md`).

---

## Active workstreams (fan-out lanes)

### 1. Promote-workflow — editor Preview → Promote → Production  · ACTIVE
- **Ledger:** `_PROMOTE_WORKFLOW_CHECKPOINT.md` (authoritative slice list + verification log)
- **Done:** Slices 1–4 — per-site D1 CRUD · Git tab retired · durable-preview worker model (migration `0646`, `libs/features/durable_preview/`, flag `durable_preview` DARK) · editor Source Control view. Underlying Preview model = isomorphic-git in R2 (concurrent session, commit `33c89e5fc`).
- **Done (2026-09-29) — Slice 5:** one-click cyan **Promote** in the editor MAIN HEADER (was 3 clicks, buried in the Source Control tab). Extracted a shared `usePromote()` hook (single state machine + gate + `PS_PROMOTE_REQUEST` bridge — SourceControlPanel + the new `PromoteHeaderControl` both consume it, never forked); exact "Promote" label w/ reserved "Publishing…" width, disabled-WITH-reason gating, dark behind `durable_preview`. `app/components/workbench/{use-promote.ts,PromoteHeaderControl.tsx}` + refactored `SourceControlPanel.tsx` + wired in `EditorPanel.tsx`. 57 Vitest green (6 new + 8 panel unchanged = no drift), tsc clean; editor Pages deployed.
- **Next → Slice 6:** Promote transaction — capture the real async CF deploy id + flip the release outcome from the ACTUAL deploy (today records `success` on servable-index proxy); per-site serialized, idempotent, retryable; Production shows the serving SHA.
- **Slice 6:** Promote transaction — per-site serialized, idempotent, retryable (freeze Preview → commit `main` → deploy Production); commit-ok/deploy-failed + safe-retry; Production shows the serving SHA.
- **Slice 7:** GitHub App / server-side short-lived creds + webhook signature verify + reconcile remote `main`.
- **Slice 8:** migration + API/MCP parity + consistent terminology + boundary tests + real-browser pass.
- **External:** apply migration `0646` to prod D1 (additive/idempotent, DARK); real-browser header VQA on an `app/` Pages deploy.
- **Invariants:** save/generate → Preview only; Production only via authorized Promote; editor always presents `main`; promoted bytes = frozen Preview revision (compare source+artifact digests); code snapshots ≠ D1/KV/R2/DO snapshots; never force-push `main`.

### 2. WfP site-hosting (flag `site_wfp_hosting`, default OFF)  · ACTIVE
- **Doc:** `docs/wfp-site-hosting.md`
- **Done:** Units 1–6 — flag · `deploySiteToWfp` · `serveSiteViaWfpIfPreferred` (`x-ps-serve: wfp`) · lifecycle wiring · teardown · **Unit 6 admin Hosting surface** (`/admin/hosting` — status pill · preview+prod URLs+copy · Publish/Promote · 4 states · flag-gated honest card · live-polled; wired route+nav+Cmd+K+label; commit `a49cad1a1`, frontend R2 deployed, Browserbase-verified live).
- **Next → external gate:** provision WfP (`[[dispatch_namespaces]]`) + flip flag → styled-200-via-dispatch prod-verify (`x-ps-serve: wfp`).
- **Then:** acceptance styled-200-via-dispatch prod-verify — test site `4f450690-e622-4c95-a83d-e5516a2c9442`, trigger in-Worker deploy, WebFetch → assert `x-ps-serve: wfp` + styled 200.
- **External gate:** provision WfP on the account — add `[[dispatch_namespaces]]` to `wrangler.toml`, set the CF token secret, resolve `CF_API_TOKEN` `10405` on the Static-Assets upload-session (slots deploy only from INSIDE the Worker, not external CF-API).
- **Acceptance:** doc's Acceptance section met; `serveSiteFromR2` byte-identical when flag off; fail-soft to R2.
- **Fast-follow (Functions convergence, `docs/FUNCTIONS-CONVERGENCE.md` — core COMPLETE):** Stage 4+ — binding injection + runtime, versioning + observability.

### 3. Editor Data Platform — Database tab + phased roadmap  · ACTIVE
- **Docs:** `docs/database-tab-enhancements.md` (15 ideas) · `docs/data-platform-scope.md` (Phases 0–6) · `docs/data-section-capability-matrix.md`
- **Done:** #3 cell click-to-copy · Actions dropdown · History="Create snapshot" · advanced cross-table search (`/db/search`) · minute-granular time-travel scrubber.
- **Done (2026-09-28):** per-site D1 Data journey PROVEN GREEN on prod — `per_site_data` enabled SCOPED to the E2E org (`flag_overrides` row `scope='org', scope_id='e2e-test-org'`, mirroring `durable_preview`); `e2e/data-tab-journey.e2e.ts` (2 passed) drives create-table→row→add/rename/drop-column→SQL-console→drop, reconciling each op display-vs-store against the site's OWN D1 (`GET /db/tables[/:table]`, databaseId `131b9973…`, NOT shared platform), + browser leg mounts the flag-on Database→Tables surface in the editor iframe (not `sitedb-disabled`).
- **Done (2026-09-29) — Rev 1/10 Rowid inline editing:** killed "no PK = read-only" — `PS_SITEDB_UPDATE_ROW` bridge (`requestDbUpdateRow` → `PATCH …/rows/:rowid`) + `rowStableKey`/`isRowEditableColumn` gate + `writeCell` (PK→exec-SQL, PK-less→rowid PATCH), optimistic+rollback+undo; 13 Vitest green; commit `b97abca9a`, editor Pages `2be849ed`.
- **Done (2026-09-29) — Rev 2/10 Schema/table-browser rail:** persistent Airtable-style left rail lists every table from the already-fetched `/db/tables` data (no new endpoint) — active table highlighted (`aria-current`) with live column/row counts, keyboard-navigable (↑↓/Enter), dark `--ps-accent`, no manual Refresh; `SchemaRail` in `SiteTablesPanel.tsx`; 27 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 3/10 Bulk edit + fill-down:** Airtable-style multi-cell selection (Shift-click / Shift-arrow extends a contiguous column range) + ⌘/Ctrl+D or a floating "Fill down" bar copies the top value to every lower cell (`fillDownWrites` → N-1 `writeCell` calls); editing once with a selection bulk-applies; optimistic + per-row rollback + single batch undo, reuses `PS_SITEDB_UPDATE_ROW` (no new endpoint); 387 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 4/10 Rich per-type cell editors:** the inline grid opens a TYPED editor keyed off each column's declared SQLite type — text (input) · number/int/real (numeric, rejects non-numeric) · boolean (true/false → bound 0/1) · date (native picker, STRICT `YYYY-MM-DD`, never `new Date()`-coerced) · datetime (zone-less, no silent zone/time drop) · JSON (validates `JSON.parse` before commit else blocks) · NULL (explicit "Set NULL" → SQL null). All validate BEFORE the write (invalid → thrown `RowMutationError`, blocked, subtle inline error — no dead control), reusing `PS_SITEDB_UPDATE_ROW`/`writeCell` (no new endpoint). Engine in `data-panel-logic.ts` (`coerceCellInput`/`editorKindForColumn`/`declaredKindFromType`/`toDateInputValue`/`toDatetimeLocalValue`); Rev 4 adds the end-to-end round-trip contract test (each declared type re-commits its own prefill losslessly + bool→0/1, NULL→SQL null, invalid-blocked-pre-write). 401 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 5/10 Result → chart:** the shared read-only result grid (SQL console + table browse) gains a Grid | Chart toggle; auto-detects a chartable result from the already-loaded rows (label + ≥1 numeric col, ≤60 rows — reuses the previously-orphaned `detectChartable`/`buildChartSeries`, no new endpoint/fetch) → lightweight inline-SVG bar chart + measure-column picker; non-chartable → honest "No chartable columns" note (never a dead toggle), NO new dep. `ChartView.tsx` + `DataGrid.tsx`; 6 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 6/10 Saved queries + history rail:** the SQL console gains a persistent per-site "Saved & history" rail (`QueryHistoryRail` in `SqlNavigator.tsx`) — timestamped run-history (click-to-reload+re-run, dedupes consecutive, relative-time + truncated preview, capped 20), named saved queries (click-to-load + delete), ↑↓/Enter nav, quiet empty states; all client-side in localStorage scoped by the site's OWN D1 `databaseId` (no new endpoint), reuses `requestDbQuery`. Engine in `data-panel-logic.ts`; also repaired 8 HEAD-failing tests (stale `PS_RES_MUTATE` mock → real `PS_SITEDB_QUERY`). 434 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 7/10 AI "Explain this":** the SQL console gains a disabled-with-reason "Explain with AI" button (`SqlNavigator.tsx`) that composes a plain-English prompt from the run query + a 5-row JSON sample (`sql-explain-logic.ts`) and hands it to the EXISTING editor AI chat via a `PS_SUBMIT_PROMPT` bridge relay (admin → `Chat.client.tsx`) — NO new endpoint, NO direct model call (reuses Preview's admin-relay pattern); "Sent to chat" confirmation, dark cyan, keyboard-reachable. Behind `per_site_data`. 26 Vitest green, tsc clean.
- **Done (2026-09-29) — Rev 8/10 ERD / schema-relationships diagram:** editor Database › Tables gains a "Schema map" toggle → inline-SVG ERD (NO dep) drawing each table as a card (PK 🔑 / FK ↗) with dashed edges. No real FK metadata in per-site D1, so edges are INFERRED by `*_id`→table naming (labeled "inferred"); schema via the existing rows bridge (`limit:0`, no new endpoint); deterministic layout; 0/1-table → honest empty launchpad. `ErdView.tsx` + `inferErdEdges`/`layoutErdNodes` in `data-panel-logic.ts`. Behind `per_site_data`. 432 Vitest green, tsc clean.
- **Next → Rev 9/10** (one measurable visual+functional upgrade per fire) draining the 15-idea backlog in priority order:
  10. Global data search (⌘K) · 11. Airtable-class views (Gallery/Kanban/Calendar) · 12. Data-profile/insights strip · 13. KV manager — never a dead paywall · 14. Save/activity affordance · 15. Empty-state launchpad.
- **Adjacent (capability matrix):** broaden typed cell editors — NULL/number/bool/JSON + INSERT add-row (needs stable-id plumbing; currently only enum columns editable).
- **Phased roadmap (`data-platform-scope.md`, all PENDING) — nest the ideas under these:**
  - **Phase 0 — Foundation (gated):** greenfield reset (backup+confirm+reversible) · brian@megabyte.space → admin + payment bypass · re-point `form_submissions`/`visitor_events` ingestion to the site's OWN D1.
  - **Phase 1 — Spreadsheet core:** resource-aware Data shell (Platform DB read-only / My Site read-edit / KV) + full-parity grid (typed inline editors, keyboard nav, immediate-save+undo, frozen header, filters/sort, virtualization, CSV, state persistence).
  - **Phase 2 — Schema builder + rich fields:** tables/columns/relations guided DDL + migration plans; select/attachments→R2/linked-records+lookup/rollup/formulas.
  - **Phase 3 — AI copilot (SQL hidden):** NL query + NL edits + insights + formula-gen + chat + data-cleaning + AI-first onboarding.
  - **Phase 4 — Views · forms · automations · API:** Kanban/Calendar/Gallery/public Form · row→email/webhook automations · auto REST API + shareable links.
  - **Phase 5 — Backup · search · governance · import/sync:** Time-Travel+snapshots+restore+row-history · global ⌘K search · field+row permissions/roles + PII masking · full import + 2-way Sheets sync + templates.
  - **Phase 6 — KV + R2-in-Files:** KV editor · wire editor Files panel to the site's R2.
- **Acceptance:** 10 revisions done + top ideas shipped; each verified live + deployed.

### 4. Admin visual-QA (continuous)  · ACTIVE
- **Ledger:** `_ADMIN_VQA_LEDGER.md` · recipe: memory `local-admin-visual-sweep-recipe`
- **Next:** drain the 25-route inventory (all `?`/unvisited) — inspect each live + score across 8 dims (functional · useful · concise · simple · gorgeous · intuitive · easy · sound); fix/improve/add components each fire. Every fire leaves the surface gorgeous-er AND more effortless.
- **Tracked findings (Fire-17):** `settings.component.ts:943` knowledge-file upload AbortController · `settings.component.ts:905` allow-web-research error path · `user-settings.component.ts:1300` optimistic API-key row.
- **Done:** `[x]` `/admin/editor/:siteId` deep-links no longer 404 — added the `editor/:siteId` route + `AdminStateService.selectSiteById(id)` (awaits async site load) + a coherent "site not found" recovery panel (link to `/admin/sites`) in `AdminEditorComponent`. Karma-covered (`editor-deeplink.component.spec.ts`).
- **Done (2026-09-29) — real-time-data (4 manual Refresh buttons killed):** analytics + audit removed-only (existing 60s/15s visibility polls + countdown/last-sync affordances); site-dna + site-data-browser gained a 30s visibility-aware auto-poll (pause on hidden, refresh on foreground, active-work-guarded) + "Live · updated Ns ago" chip; dead CSS/`refresh()` swept. tsc + ng build:prod green (`main-CQFWHNQD.js`). Follow-on VQA (parked `docs/_loop-scan/discovery-admin-vqa-2026-09-29.md`): H1 gaps + empty-state launchpads.
- **Acceptance:** maintenance-only — never terminally done; a healthy no-op fire is correct once nothing improves.

### 5. Interconnectedness (no orphan / everything reachable)  · ACTIVE
- **Ledger:** `_INTERCONNECTEDNESS_LEDGER.md` · detector: `scripts/detect-orphans.mjs`
- **Next:** run the orphan sweep → wire the highest-value orphaned unit into a reachable surface the same fire. Concrete open checks:
  - every `action === 'X'` / `subView === 'Y'` state has a VISIBLE trigger;
  - `SchemaBuilder` · `ImportPanel` · `AiSeedPanel` · `GreenfieldReset` · `KvManager` · `SqlNavigator` reachable + clearly labeled;
  - admin sections with no nav entry (cross-check `/admin/*` routes vs sidebar);
  - worker `libs/features/*/handlers` + `src/routes` endpoints with no admin/editor caller + no intentional-headless note;
  - MCP tools in `src/services` not represented in UI.
- **Acceptance:** zero orphaned major units; detector green.

### 6. App-completion journeys (whole-app DoD)  · ACTIVE (batch after 1–5)
- **Ledger:** `_APP_COMPLETION.md` (+ `.claude/loop.md` roster) · **prime directive:** REAL multi-step user journeys, never mocked/smoke.
- **§ A Admin:** verify all 23 sections render + a11y · truthful data · truthful mutations · completeness.
- **§ B.2 Golden journey:** create→build→publish→view→analytics + admin propagation + template.
- **§ B.4–B.7 Full-flow E2E (headless prod):** guest funnel · billing-full · editor round-trip · auth.
- **§ C/D:** generated-site quality (deployed sites, the CORE product) + platform marketing/SEO.
- **Acceptance:** each journey proven working end-to-end on PROD + a durable probe wired into `e2e/admin-verify/run-all.mjs`.

### 7. Site-generation quality  · ACTIVE (batch after 1–5)
- **Source:** `_LOOP_LEDGER.md` (open items) · `src/services/build_validators.ts`
- ✅ `build_validators.ts` report→strict via `VALIDATOR_MODE` env (canary): `resolveValidatorMode` (fail-soft → `'report'` default) + `assertBuildStrict` + typed `BuildValidationStrictError`; workflow `validate-build` step throws in `'strict'` AFTER the D1 audit log, re-thrown past the catch (never "skipped"). Default stays `'report'` → zero live change. TDD: +7 tests (report no-throw / strict throws / strict clean-passes), 197/197 jest green, tsc + validate:features clean.
- Competitor-research service + floor check → wrap into site-gen Phase -1; flag `deepcrawl_competitor_research`.
- SEO-audit crawler → post-deploy step; map violations to the 13 `build_validators.ts` invariant codes; log-only while experimental.
- Promote cinematic flags `word_reveal` / `line_draw` / `clip_reveal` to ON-by-default on filled sections.
- Drain 7 stale E2E cohorts (details-modal, domain-files, ai-workflow, …).

---

## CF-NATIVE CONVERGENCE RUN — streams A–E + Resources cockpit  · ACTIVE (lanes 12–18)

> Full decomposition + fire-1 audit findings + dependency graph + one-owner rules + acceptance
> matrix live in **`_CF_NATIVE_CONVERGENCE.md`** (immutable spec `docs/_cf-convergence/MANDATE.md`).
> This is the INDEX; the command advances the next RED-first slice per stream each fire.

- **F — shared contracts + migrations (SERIAL, single-owner):** `packages/shared/**` + `migrations/**`
  are F-exclusive; ascending from **0648**. Next: F1 register `voice_receptionist` flag · F2 ADR 0056
  (LiveKit→CF, supersedes prior LiveKit ADR + PRICING-MODEL). `_CF_NATIVE_CONVERGENCE.md` §2.
- **A — Voice + all-call media:** ✅ A0 Test Console token-shape fixed — `POST /api/voice/test/call-token`
  now returns `{ data: { token, identity, edge_url } }` (nested) so the FE `res.data.token` resolves
  (`voice.ts` ~1030); covered by voice.test.ts A0 + voice_numbers_flag.test.ts. Then A1–A9 (setup tabs ·
  gallery+interactive console on shared AI chat · every-call session+Live View · CDP pixel-capture spike ·
  dual-channel WAV · synced detail · 206 directory · timecoded critique · consent). §3.
- **B — Twilio/SMS/Stripe 🔴:** ✅ B0 `voice_numbers` killswitch registered (registry, default OFF
  experimental) + `POST /api/voice/numbers/purchase` gated via `requireOrgFlag` FIRST → 404 when OFF, NO
  carrier buy (fail-safe; `voice.ts:197`); RED-first test voice_numbers_flag.test.ts (3 green) + voice.test.ts
  re-armed. tsc + jest voice (267) + validate:features green. Then B1–B6. §4.
- **C — Editor Claude-Code + Sandbox + browser:** C1 `/api/sites/:id/workspace` 501-when-Sandbox-unbound
  (pin `@cloudflare/sandbox` — ABSENT today); cull/repurpose orphaned `ide_sandbox.ts`; CF Browser Run
  Live View replaces Browserbase-only; ideas 1–12. §5.
- **D — MCP broker:** D0 audience-bound site-scoped token (wire orphaned `mcp_resource_tokens`); one
  versioned Streamable-HTTP endpoint + OAuth 2.1; ideas 1–12; recheck policy at tools/call. §6.
- **E — CF-native surfaces:** Inspector-removal (26 files/~4600 LOC) · EmDash/microfeed/Traks/OpenSEO/
  Slink/Automations/Email/health-widget · Social 10-pass campaign; E7 D1-export + E8 shortlinks near-done. §7,§9.
- **Resources cockpit + Advanced console (Brian directive) 🔴:** R1 ✅ killed manual Refresh/Reconcile
  in `ResourceOverviewPanel.tsx` — replaced with a visibility-aware poll (45s interval, pauses on
  `document.hidden`, immediate refresh on `visibilitychange`); reconcile is now automatic + silent
  (self-heals on drift) + a subtle "updated Ns ago" live chip; 6/6 Vitest green, tsc clean · R2 promote
  9 adapters to tabs · R3 drop Site-files/Media tabs
  (security) · R4 R2 manager · R5 fix dead Add · R6 Advanced→tabs · R7 Secrets/Connections/Functions/
  Schedules · R8 honest-limit tabs. §8.
- **Cross-cutting:** Jest→Vitest (kills `@swc/jest` mock-hoist) · psnotify deploy `v_psnotify_do` +
  fan-out/bell-unify. §10.

---

## § Harvested backlog — non-workstream items (2026-09-28)

### Source TODOs / FIXMEs (grep receipts)
- **Actionable:** `app/lib/persistence/useChatHistory.ts:416` — FIXME: intended navigate fn rerenders `<Chat/>` and breaks the app (deliberate workaround — needs a real fix, test-first).
- **deferred-lowvalue:** `app/components/editor/codemirror/languages.ts:186` TODO(perf-10) one-time syntax toast · `src/services/external_llm.ts:193`, `src/services/smtp_config.ts:19`, `src/services/browser_gateway.ts:44` — `@deprecated` back-compat shims (remove when callers migrate).
- **blocked-external:** `src/middleware/abuse.ts:36` arcjet Workers adapter · `src/services/media.ts:557` Sora/Veo public API.

### Editor code-sweep (unswept + Fire-17)
- `app/**` (bolt.diy editor) not yet swept by `_CODE_SWEEP_LEDGER.md`.
- Knowledge-file upload AbortController · allow-web-research toggle error path · user-settings optimistic API-key row.

### Architecture / repo hygiene (root `TODO.md`)
- Relocate editor `app/` → `apps/editor/` (discrete pass: root `wrangler.toml`, vite configs, `functions/`, `electron/`, CF Pages `bolt-diy` settings; editor build + Pages deploy verify).
- Resolve or retire the `apps/web` v2 Angular plan (`.cleanup-allowlist` references a non-existent dir).
- Decide Electron desktop packaging — remove unless desktop distribution is a real goal.
- Prune ~68 leftover `.claude/worktrees/agent-*` (`git worktree prune`).
- Regenerate lockfile — `npm install --legacy-peer-deps` (removed workspace members still listed).

### Standing infra
- Apply migration `0646` to prod D1 (additive/idempotent, DARK) — full-visibility run.
- Cold-provision fix in `src/services/d1_provisioner.ts` — idempotent create + await readiness (new-site first `/db/query` CREATEs race).
- Preview loading UX (Msg-3b remainder): mirror the preview-boot message into the editor CHAT + wire the signal to BaseChat + the AI-ensures-boot backend (`app/components/workbench/Preview.tsx`).

---

## Brian-gated (approval-required — ship the decision-independent slice, never auto-execute)
- **ConversationHub DO deletion** (`src/index.ts:250`) — destructive one-way-door DO migration (`deleted_classes`); date guard passed, deletion DEFERRED indefinitely; needs explicit confirmation + correct tag before executing (procedure in the source comment).
- **GPT-4o vision → Workers-AI swap** per callsite (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- **Backend-complete → decide frontend render** for 4 surfaces (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- **Geo-sweep + admin form + `/admin` persistence** (`_LOOP_LEDGER.md` NEEDS-BRIAN).

## Blocked-user (awaiting a credential/decision only Brian can provide)
- **LinkedIn OAuth** creds · **Reddit OAuth** creds (RECS.log — blocked 4+ days).
- **Stripe `STRIPE_PRICE_ID_MONTHLY_WALLET`** — landed; needs integration wiring.
- **DeepSeek $5 top-up** — unblocks bespoke build-LLM copy + build-LLM-gated cohort rebuilds.

## Deeper machine (reference — not duplicated here)
- `.claude/loop.md` + `_APP_COMPLETION.md` — whole-app Definition of Done + 6-loop convergence roster. `/run-the-loop` advances the frontier above; the DoD machine is the exhaustive backstop.

---

## Done
_(move a unit here when its Acceptance is fully met — with the closing commit SHA + prod proof)_

- **Security hardening §4.6 — Lane 11 (GitHub Actions SHA-pinning)** (2026-09-29) — SHA-pinned EVERY third-party GitHub Actions `uses:` across all 25 `.github/workflows/*.y*ml` per supply-chain-integrity (a `@v4` major auto-ingests future minor releases, so a compromised maintainer ships unnoticed). **122 action refs pinned** across 23 workflow files to their full 40-hex commit SHAs (resolved via `gh api repos/<o>/<r>/commits/<ver>`), each with a trailing `# <version>` comment; every edit a pure `@version → @sha # version` swap (122 ins / 122 del, 0 logic change — proven by diffing only `uses:` lines). Local `./`-path composite actions correctly left unpinned; `amannn/action-semantic-pull-request` was already SHA-pinned. `aquasecurity/trivy-action@master` (branch → worse than a tag) pinned to `d2a0b60`. **`cloudflare/pages-action@v1` was unresolvable — Cloudflare DELETED the repo (404 on the repo + tag API); migrated `preview.yaml`'s deploy step to its official successor `cloudflare/wrangler-action@9acf94a # v3` (`command: pages deploy build/client --project-name=bolt-diy-preview`) + updated the downstream `steps.deploy.outputs.url → deployment-url` PR-comment reference.** New drift gate `scripts/check-action-pins.mjs` — greps every workflow `uses:`, exits 1 with an offender list on any non-`./` ref not pinned to a 40-hex SHA; wired `validate:action-pins` into `package.json`. Verify: `check-action-pins.mjs` **exit 0** · `actionlint` shows **0** SHA/`uses:` errors (the pin diff DROPPED actionlint `[action]` errors 3→1 by removing the dead pages-action; all 27 shellcheck + 1 expression findings pre-exist, proven by stash-diff). Write + verify only — no commit/deploy of app/worker/frontend source (lead lands + pushes).
- **Security hardening §4.6 — Lane 6 (Zod boundary + IDOR drift gate)** (2026-09-29) — Closed the 2 items from the security discovery scan (`docs/_loop-scan/discovery-security-2026-09-29.md`). (a) **`forms.ts:1039` `form-router/improve` Zod:** colocated `FormRouterImproveBody = z.object({ value: z.string().max(20_000).optional() }).strict()` + `safeParse` at the boundary → 400 `VALIDATION_ERROR` on a non-string `value` or any unknown key; removed the `as { value?: unknown }` cast (empty `{}` still → seed, preserving the existing contract). TDD RED→GREEN: +4 tests in `forms_routes.test.ts` (valid string proceeds; wrong-type 400; unknown-key strict 400; empty-body seed retained). (b) **`scripts/validate-idor-gates.mjs`:** new drift gate — enumerates every `/api/sites/:siteId` + `:id` route handler across `src/routes` + `libs/features` (JSDoc `@link`/comment matches filtered out), asserts each calls a per-site ownership guard (`assertSiteOwned|assertSiteOwnership|loadOwnedSite|requireOwnedSite|requireSiteMembership` + proven `gate*`/`*Guard`/`ownsSiteData`/`org_id`-SQL/super-admin idioms), exit 1 + offender list on any gap; small `PUBLIC_ALLOWLIST` for genuine public/org-only routes (contact-form ingest, forms submit, social posting-times/generate). Wired `validate:idor` into `package.json`. **Passes GREEN: 206 `:siteId` handlers across 311 files, 0 offenders** (matches the audit's zero-gap finding — now defended against drift). Verify: `tsc` 0 errors · `jest forms` 38/38 (all 3 form suites 90/90) · `validate:idor` exit 0 · `validate:features` exit 0. Write + verify only — no deploy (worker/frontend/editor untouched).
- **Security hardening §4.6 — Lane 6+11 CI promotion (both drift gates → HARD CI gates)** (2026-09-29) — Promoted the two §4.6 gate scripts from `package.json`-only to blocking CI steps, closing the gap both prior entries left open (wired into npm but never into a workflow → the maturity-ladder regression-protection step). Added two steps to `.github/workflows/feature-architecture.yml` (the pure-Node validate job — reuses its existing checkout + setup-node, no npm install): **`IDOR ownership drift gate`** (`npm run validate:idor`) + **`GitHub Actions SHA-pin gate`** (`npm run validate:action-pins`), placed after the fabricated-kit-defaults gate, before the drift-report artifact upload. Each gated `if: hashFiles('apps/project-sites/scripts/<script>.mjs') != ''` so it fails-OPEN on repos lacking the script (this repo HAS both → they run) per conditional-ci-gates. CI-mirroring gates → graduated immediately (no 90-day stability wait) per audit-arc-maturity-ladder short-path. Kept every existing `uses:` SHA-pinned; added NO new `uses:`. Verify: `validate:idor` **exit 0** (206 `:siteId` handlers, 0 offenders) · `validate:action-pins` **exit 0** (every `uses:` 40-hex-pinned) · `actionlint .github/workflows/feature-architecture.yml` **exit 0, 0 findings**. Write + verify only — no commit/deploy; no app/worker/frontend source touched (lead lands + pushes).
- **psnotify DO inbox — first slice** (2026-09-28) — Replaced the `psnotify.ts` console.warn stub with a SQLite-backed Durable Object `PsNotifyDO` (one per user via `getByName(userId)`, zero D1 tables): `add`/`list`/`markRead`. `notifyUser()` now writes to the DO (signature unchanged). New feature module `libs/features/psnotify/` (manifest + schemas + do + handlers + `__tests__`). Authed `GET /api/notifications` + `POST /api/notifications/:id/read`, caller-scoped by authed userId (never a request id). Flag `psnotify` (registry + docs, DARK → 404). `wrangler.toml`: `PSNOTIFY_DO` binding + `[[env.production.migrations]]` tag `v_psnotify_do` (`new_sqlite_classes=["PsNotifyDO"]`). Verify: `tsc` 0 errors · `jest psnotify` 7/7 · `validate:features` exit 0 · existing `notify` suite 36/36. **NEEDS a `wrangler deploy --env production` to apply the DO migration (lead deploys)** — handlers + notifyUser fail-soft (empty inbox / no-op) until then. Follow-on slices: email/push fan-out, unify the existing bell feed.
