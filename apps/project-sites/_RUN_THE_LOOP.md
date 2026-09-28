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
- **Next → Slice 5:** cyan **Promote** header button (exact label) + status progression + no-op/retry states.
- **Slice 6:** Promote transaction — per-site serialized, idempotent, retryable (freeze Preview → commit `main` → deploy Production); commit-ok/deploy-failed + safe-retry; Production shows the serving SHA.
- **Slice 7:** GitHub App / server-side short-lived creds + webhook signature verify + reconcile remote `main`.
- **Slice 8:** migration + API/MCP parity + consistent terminology + boundary tests + real-browser pass.
- **External:** apply migration `0646` to prod D1 (additive/idempotent, DARK); real-browser header VQA on an `app/` Pages deploy.
- **Invariants:** save/generate → Preview only; Production only via authorized Promote; editor always presents `main`; promoted bytes = frozen Preview revision (compare source+artifact digests); code snapshots ≠ D1/KV/R2/DO snapshots; never force-push `main`.

### 2. WfP site-hosting (flag `site_wfp_hosting`, default OFF)  · ACTIVE
- **Doc:** `docs/wfp-site-hosting.md`
- **Done:** Units 1–5 — flag · `deploySiteToWfp` · `serveSiteViaWfpIfPreferred` (`x-ps-serve: wfp`) · lifecycle wiring · teardown (`teardownSiteWfp` + `clearSiteWfpRegistry`).
- **Next → Unit 6:** admin Angular/Spartan Hosting surface — status pill · preview+prod URLs · Publish/Promote action · empty/loading/error/success. Nothing built-but-unwired.
- **Then:** acceptance styled-200-via-dispatch prod-verify — test site `4f450690-e622-4c95-a83d-e5516a2c9442`, trigger in-Worker deploy, WebFetch → assert `x-ps-serve: wfp` + styled 200.
- **External gate:** provision WfP on the account — add `[[dispatch_namespaces]]` to `wrangler.toml`, set the CF token secret, resolve `CF_API_TOKEN` `10405` on the Static-Assets upload-session (slots deploy only from INSIDE the Worker, not external CF-API).
- **Acceptance:** doc's Acceptance section met; `serveSiteFromR2` byte-identical when flag off; fail-soft to R2.
- **Fast-follow (Functions convergence, `docs/FUNCTIONS-CONVERGENCE.md` — core COMPLETE):** Stage 4+ — binding injection + runtime, versioning + observability.

### 3. Editor Data Platform — Database tab + phased roadmap  · ACTIVE
- **Docs:** `docs/database-tab-enhancements.md` (15 ideas) · `docs/data-platform-scope.md` (Phases 0–6) · `docs/data-section-capability-matrix.md`
- **Done:** #3 cell click-to-copy · Actions dropdown · History="Create snapshot" · advanced cross-table search (`/db/search`) · minute-granular time-travel scrubber.
- **Done (2026-09-28):** per-site D1 Data journey PROVEN GREEN on prod — `per_site_data` enabled SCOPED to the E2E org (`flag_overrides` row `scope='org', scope_id='e2e-test-org'`, mirroring `durable_preview`); `e2e/data-tab-journey.e2e.ts` (2 passed) drives create-table→row→add/rename/drop-column→SQL-console→drop, reconciling each op display-vs-store against the site's OWN D1 (`GET /db/tables[/:table]`, databaseId `131b9973…`, NOT shared platform), + browser leg mounts the flag-on Database→Tables surface in the editor iframe (not `sitedb-disabled`).
- **Next → the 10 progressive gorgeous+functional revisions** (one measurable visual+functional upgrade per fire) draining the 15-idea backlog in priority order:
  1. Rowid inline editing (kill "no PK = read-only") · 2. Schema/table browser rail · 4. Bulk edit + fill-down · 5. Rich field-type config · 6. Result→chart · 7. Saved queries + history rail · 8. AI "explain this" · 9. ERD/relationships diagram · 10. Global data search (⌘K) · 11. Airtable-class views (Gallery/Kanban/Calendar) · 12. Data-profile/insights strip · 13. KV manager — never a dead paywall · 14. Save/activity affordance · 15. Empty-state launchpad.
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
- Competitor-research service + floor check → wrap into site-gen Phase -1; flag `deepcrawl_competitor_research`.
- SEO-audit crawler → post-deploy step; map violations to the 13 `build_validators.ts` invariant codes; log-only while experimental.
- Promote cinematic flags `word_reveal` / `line_draw` / `clip_reveal` to ON-by-default on filled sections.
- Drain 7 stale E2E cohorts (details-modal, domain-files, ai-workflow, …).

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

- **psnotify DO inbox — first slice** (2026-09-28) — Replaced the `psnotify.ts` console.warn stub with a SQLite-backed Durable Object `PsNotifyDO` (one per user via `getByName(userId)`, zero D1 tables): `add`/`list`/`markRead`. `notifyUser()` now writes to the DO (signature unchanged). New feature module `libs/features/psnotify/` (manifest + schemas + do + handlers + `__tests__`). Authed `GET /api/notifications` + `POST /api/notifications/:id/read`, caller-scoped by authed userId (never a request id). Flag `psnotify` (registry + docs, DARK → 404). `wrangler.toml`: `PSNOTIFY_DO` binding + `[[env.production.migrations]]` tag `v_psnotify_do` (`new_sqlite_classes=["PsNotifyDO"]`). Verify: `tsc` 0 errors · `jest psnotify` 7/7 · `validate:features` exit 0 · existing `notify` suite 36/36. **NEEDS a `wrangler deploy --env production` to apply the DO migration (lead deploys)** — handlers + notifyUser fail-soft (empty inbox / no-op) until then. Follow-on slices: email/push fan-out, unify the existing bell feed.
