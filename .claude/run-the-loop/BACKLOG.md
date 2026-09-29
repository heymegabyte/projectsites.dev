# BACKLOG — the canonical actionable queue

> The single source of truth for `/run-the-loop` work units. Cadence-tagged, executable
> without asking. Migrated 2026-09-29 (fire-50) from `apps/project-sites/_RUN_THE_LOOP.md`
> + `_LOOP.md`. Cross-links: [`./README.md`](./README.md) · [`./DISCOVERIES.md`](./DISCOVERIES.md)
> · [`./LEDGER.md`](./LEDGER.md). Granular lane state stays in the per-workstream sub-ledgers
> (`_PROMOTE_WORKFLOW_CHECKPOINT.md`, `_CF_NATIVE_CONVERGENCE.md`, `docs/wfp-site-hosting.md`,
> `docs/data-platform-scope.md`, `_ADMIN_VQA_LEDGER.md`, `_INTERCONNECTEDNESS_LEDGER.md`).
>
> **The money path is Brian's #1 — its items are HIGH.** Every item ships behind a flag
> (`enabled=0, rollout=0, stage='experimental'`), TDD-first, deployed + prod-verified, `git add -f`
> (`.gitignore` blocks `*.md`), straight to `main`. Feature flag = server 404 when off, UI null.
>
> **Cadence values:** `once` · `every-loop` · `every-2-loops` · `every-4-loops` · `every-8-loops`
> · `every-16-loops` · `daily` · `weekly`. Item shape:
> ```
> - [ ] <title>
>   - cadence · priority · category · estimate · depends_on · discovered_by
> ```

---

## money-path (Brian #1 — HIGH)

- [ ] Backfill WfP slots for all existing sites (batched, idempotent)
  - cadence: once
  - priority: high
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: WfP is now the DEFAULT serving path (arc CLOSED on prod fire-50 — `x-ps-serve: wfp`
    proven for `search-verify`). Every existing site still serves from R2. Batch-deploy the WfP
    `preview`+`production` slots for all published sites via `deploySiteToWfp` (proven end-to-end,
    `ok:true, assetCount≥1`). MUST be idempotent (re-POST returns same release, no recompute drift)
    + batched (avoid CF rate limits) + fail-soft to R2 per site. Trigger: `POST /api/diag/wfp-deploy
    {siteId, slot}` per site, or a batched internal sweep. Verify a sample → `x-ps-serve: wfp`.

- [ ] Deliberate `site_wfp_hosting` rollout widening (beta → more orgs)
  - cadence: every-4-loops
  - priority: high
  - category: architecture
  - estimate: 30m
  - depends_on: Backfill WfP slots for all existing sites (batched, idempotent)
  - discovered_by: fire-50
  - context: Flag enabled SCOPED to `e2e-test-org` only (reversible `flag_overrides` row). Widen
    the rollout org-by-org via `/admin/feature-flags` (or scoped override rows) once slots are
    backfilled; after each widen, WebFetch a member site → assert `x-ps-serve: wfp` styled 200.
    Serve gate: `site_serving.ts:97` (`isFlagOn 'site_wfp_hosting' {orgId,siteId}`). Reversible via
    soft-delete of the override row. Do NOT flip global-on until backfill + monitoring confirm.

- [ ] Golden journey: create → build → publish → view → analytics (real E2E on PROD)
  - cadence: every-2-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.2. The money path: `/create` a real test business (Vito's Mens Salon, 74 N
    Beverwyck Rd, Lake Hiawatha NJ) → it BUILDS for real → view generated site → editor change a
    requirement → live site updates → publish. Real auth, real build, real edit, real publish,
    reconciled against source of truth (`verify-against-source-of-truth`). Homepage-start, navigate
    by UI clicks only. Wire a durable probe into `e2e/admin-verify/run-all.mjs`. Never mocked/smoke.

- [ ] Billing-full flow E2E (headless prod) — checkout → subscription → entitlement
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.4-B.7. Guest funnel · billing-full · editor round-trip · auth. Reconcile
    Stripe checkout → `subscriptions` row → `/api/billing/entitlements`. `plan` and `status` are
    orthogonal — `active` vs `trialing` both entitle. Never submit a real card in a manual pass; a
    test card belongs in the E2E suite. Assert entitlement gate is fail-CLOSED on transient.

- [ ] Analytics reconcile — displayed counts vs D1 `visitor_events` (per-subdomain)
  - cadence: every-4-loops
  - priority: high
  - category: bug
  - estimate: 90m
  - depends_on: Enable Analytics Engine ingest (per-subdomain RUM)
  - discovered_by: repository-audit
  - context: Prior lying-empty incident — `/admin/analytics` showed "never had traffic" for a site
    with 109 real pageviews (UI read CF-zone metrics, empty for `*.projectsites.dev` subdomains).
    Reconcile display-vs-store per `verify-against-source-of-truth`: query D1 `visitor_events` for the
    real org, hit the surface as the real user, flag `groundTruth>0 && display==0` as LYING-EMPTY.
    Add date-range + compare-to-prior across cards. Reuse `e2e/admin-verify/reconcile-surfaces.mjs`.

---

## feature

- [ ] WfP fast-follow (Functions convergence Stage 4+) — binding injection + runtime + versioning + observability
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: `docs/FUNCTIONS-CONVERGENCE.md` core COMPLETE. Stage 4+: inject per-site bindings into
    the Functions runtime, versioning, per-function logs/metrics in the editor, cold-start/cost
    guards. Code-defined endpoints in a site's `functions/` folder on Workers-for-Platforms (ADR-0035,
    replaces the removed AI-Agents dashboard feature). `wfp_dispatch.ts` is the KEPT WfP plumbing.

- [ ] Sora/Veo video generation module (`libs/features/media_generation_video/`)
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: fire-42
  - context: `src/services/media.ts:557` — the "TODO when Sora/Veo APIs land" comment IS the whole
    impl; Sora API is now public. Stand up a flag-gated feature module wiring the OpenAI Sora endpoint
    + generate route + D1 job queue (queued generation, workflow callback flips status — mirror the
    existing `POST /api/media/generate/video` shape). Ground-truthed fire-42.

- [ ] Pricing config engine (Wave 2) — D1 `pricing_config` table behind `pricing_engine_v2`
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 2h
  - depends_on: none
  - discovered_by: fire-42
  - context: `src/services/site_cost.ts:113,141,480` — 3 hardcoded pricing values with
    `TODO(pricing_engine)` markers (base rates + container compute). Also `voice.ts:233,286`
    hardcoded `monthly_cost_cents:100`. Create a D1 `pricing_config` table, backfill, wire refs behind
    the `pricing_engine_v2` flag. Prerequisite for self-serve pricing tiers (no-deploy price changes).
    Flag `pricing_engine` + `validator_strict` + `voice_numbers` + `r2_bucket_manager` FLAG_DOCS exist.

- [ ] Public REST API v1 — promote `public_api` to beta
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 4h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [HIGH]. `psk_live_*` keystore + OpenAPI 3.1 + scoped tokens ship DARK today.
    Expose `GET/POST /api/v1/sites`, `/v1/sites/:id/deploy`, `/v1/sites/:id/db/*`, `/v1/media`,
    `/v1/forms/submissions` behind the token middleware. The "deliver websites programmatically" wedge.
    Flag→beta with Zod + tests + prod-verify. Zod-derive the OpenAPI (`@asteasolutions/zod-to-openapi`).

- [ ] Enable Analytics Engine ingest (per-subdomain RUM/event sampling)
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `ANALYTICS_INGEST_ENABLED="false"` — the CF-native metrics backend the doctrine mandates
    isn't writing. Deferred from Wave D (collided with psnotify on `wrangler.toml`). Flip scoped-on,
    verify per-subdomain RUM/event sampling, reconcile display-vs-store. Analytics Engine (not PostHog)
    is the default high-volume metrics backend per infra doctrine.

- [ ] psnotify follow-on — email/push fan-out adapters + unify bell onto the DO + promote flag
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 10. `PsNotifyDO` inbox shipped (dark, deployed). Add fan-out to in-app/email(SES)/
    web-push adapters so `notifyUser` lights the bell; point `/notifications` at the DO inbox (retire
    the `audit_logs`-derived `activity_feed` — producer↔consumer drift today); DO WebSocket/SSE push
    (kill the 60s poll); server-persist preferences off `localStorage` to D1 + enforce via
    `resolvePrefs`/`routeNotification`. Promote `psnotify` flag THEN verify the AUTHED inbox journey
    (never a 401 probe — false-green lesson). Notification source is psnotify DO, NOT a d1 table.

- [ ] Command palette (Cmd+K deep-actions) + Cmd+P fuzzy file open — editor + admin
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02/08 [HIGH] — biggest embarrassingly-easy + keyboard win. Admin palette is
    nav-only; add verbs (create site · deploy · rollback · invite teammate · toggle flag) + fuzzy
    jump to any setting (Linear model). Editor lacks both Cmd+K + Cmd+P entirely. One entry to every
    action/file/route. ~+25% power-user completion per brief 08.

- [ ] AI inline code edit + explain in CodeMirror (`EditorPanel.tsx`)
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02 [HIGH] — highest AI-native leverage. Select→edit / hover→explain; today AI lives
    only in the chat column. Inline/no-chat AI beats a bolted-on sidebar (AI-permanence + embarrassingly-
    easy). Reuse the existing `PS_SUBMIT_PROMPT` admin-relay bridge pattern (per Rev 7 Data-tab).

- [ ] Editor Data Platform post-arc backlog (ideas 14/15 + capability-matrix gaps)
  - cadence: every-4-loops
  - priority: med
  - category: feature
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 3 — Rev 1-10 arc + Calendar + Insights + KV-preview all DONE (per-site D1, flag
    `per_site_data`, each editor-Pages-deployed). Remaining: broaden typed cell editors for INSERT
    add-row (stable-id plumbing); Phases 2-6 of `data-platform-scope.md` (schema builder + rich
    fields · AI copilot SQL-hidden · views/forms/automations/auto-REST-API · backup/search/governance
    · KV editor + wire Files panel to the site's R2). Reads the site's OWN D1, never shared platform.

- [ ] App catalog — cf-native migrations + new members + drift close
  - cadence: every-8-loops
  - priority: med
  - category: feature
  - estimate: 4h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 03 [HIGH]. Convert Umami → cf-native (D1 + Analytics Engine); make Payload the
    template every new member copies; surface ~10 wired-but-uncatalogued DO classes (~47 exist);
    close catalog↔`supported`↔infra drift (LiteLLM live at `llm.megabyte.space` but `supported:false`,
    one SSOT reconcile); new members (Cal.com #1 SMB ask, NocoDB/Teable over per-site D1, Ghost,
    Chatwoot). Gate container-centric copy on `image?.startsWith('cf-native:')`. Never reduce DO
    subclasses (deploy-break 10064 — only ADD).

---

## test

- [ ] MCP connect buttons need `data-testid`
  - cadence: every-loop
  - priority: med
  - category: test
  - estimate: 30m
  - depends_on: none
  - discovered_by: fire-46
  - context: Per-provider "Connect"/"Add API key" buttons (rendered from `mcp-providers.ts` in
    `settings.component.ts` + `forms.component.ts`) have no `data-testid` → E2E can only target by
    brittle index. Add `data-testid="mcp-${id}-connect"` to each. (Note: fire-46 shipped this in
    `settings.component.ts` — verify `forms.component.ts` coverage.)

- [ ] Drain 7 stale E2E cohorts (details-modal, domain-files, ai-workflow, …)
  - cadence: every-4-loops
  - priority: med
  - category: test
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 7. 7 stale E2E cohorts need retargeting/repair. Editor verify MUST run the FULL
    Vitest suite (`npm test`, not scoped) — scoped runs hid 10 pre-existing RED editor tests across ≥3
    fires. Worker verify runs the full Jest suite (874 suites / 13819 tests). Per
    `handler-change-breaks-existing-contract-tests-run-full-suite`.

- [ ] E2E for admin cockpit/attention-queue/KPI/CWV surfaces
  - cadence: every-4-loops
  - priority: med
  - category: test
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-50
  - context: `dashboard.component.ts` (2199 LOC) — no E2E for the operator cockpit / needs-attention
    queue / KPI tile strip / CWV surfaces. Real-user journey against PROD, homepage-start.

---

## golden-path

- [ ] Full-flow E2E: guest funnel + auth round-trip (headless prod)
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §B.4-B.7. Guest funnel (homepage search → business select → signin gate) + editor
    round-trip + auth. Real E2E sign-in (`test@megabyte.space`, `TEST_USER_PASSWORD`), navigate by UI
    clicks only. Assert PERSISTENCE (navigate away → return → hard-refresh) + cross-feature effect.
    apex POST hits CF Bot-Fight 403 (known) — verify authed mutations via workers.dev host.

- [ ] Generated-site quality journeys (§C — the CORE product, deployed sites)
  - cadence: every-4-loops
  - priority: high
  - category: golden-path
  - estimate: 2h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 6 §C/D. Generated-site quality (deployed `{slug}.projectsites.dev`) + platform
    marketing/SEO. The generated site must BEAT the source — more beautiful, faster, more accessible,
    denser. Reconcile page count = source sitemap (1:N). Verify JSON-LD-matches-visible-content, per-
    route meta, favicon set ships. Vision-QA generated sites via authed iframe (they 403 headless).

---

## ux

- [ ] Empty states as launchpads sweep (voice · forms · leads · apps · domains · site-features)
  - cadence: every-loop
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `embarrassingly-easy-to-use`. Every empty state = the ONE button that
    creates the first result. Many shipped fire-43→50 (social composer, leads, team, webhooks, create
    search, billing caps-modal). Continue: wire `mini-empty` into any remaining passive "no data" state.
    Never a dead-end — always a first-action CTA.

- [ ] Entitlement/seat/flag-locked controls show reason + upgrade CTA (never a dead button)
  - cadence: every-2-loops
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `action-button-must-gate-on-server-precondition`. Never present a doomed
    control. billing, site-features, team. A button that will fail (precondition unmet, seat limit,
    missing config) is disabled WITH the reason + the fix, or hidden. site-features shipped
    `lockedCtaLabel(f)` per-entitlement fire-50 — continue across billing/team.

- [ ] Real-time everywhere / kill remaining Refresh+Reconcile buttons
  - cadence: every-loop
  - priority: med
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] + `real-time-data-no-manual-refresh` (Brian directive). A manual Refresh/
    Reconcile/Reload/Sync button is a DEFECT — the surface should already be current. Many killed
    (analytics, audit, site-dna, site-data-browser, feature-flags, voice conversations,
    ResourceOverviewPanel). Remaining editor targets: BucketsPanel, DatabasePanel, NamespaceSummary,
    ImportPanel, LockManager, ProjectHub, EnvAssignmentGrid. Visibility-aware poll / SSE / `PS_*` push.

- [ ] Restore Preview responsive/device switcher (`Preview.tsx` — `isDeviceModeOn=false` orphaned)
  - cadence: every-8-loops
  - priority: med
  - category: ux
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 02 [HIGH]. Device list coded but `isDeviceModeOn=false` (orphaned — interconnected-
    ness). Wire back + a 6-breakpoint quick toggle. Adjacent orphan to reconnect same fire.

- [ ] Preview boot-timeout message → mirror into editor CHAT (Msg-3b remainder)
  - cadence: every-8-loops
  - priority: low
  - category: ux
  - estimate: 45m
  - depends_on: none
  - discovered_by: fire-41
  - context: `Preview.tsx:1172` DOES render a "No preview available" card on the 60s WebContainer
    cold-boot timeout. The ACTUAL missing piece (Msg-3b): MIRROR the boot-timeout into the editor CHAT
    — emit a `logStore` message / `onBootTimeout?()` callback so the AI learns boot stalled. Scope to
    the chat-mirror only (fire-41's "unwired" framing was imprecise; ground-truthed).

- [ ] Inspector → AI round-trip (Preview element → "change this" chat/inline patch)
  - cadence: every-8-loops
  - priority: med
  - category: ux
  - estimate: 90m
  - depends_on: AI inline code edit + explain in CodeMirror (`EditorPanel.tsx`)
  - discovered_by: repository-audit
  - context: brief 02 [HIGH]. Click element in Preview → "change this" as a chat/inline patch, not
    just `ElementInfo`. Reuse the `PS_SUBMIT_PROMPT` admin-relay bridge.

---

## a11y

- [ ] Domains VQA a11y — `domain-manager` popover `aria-modal` + focus-trap; button width jitter
  - cadence: every-2-loops
  - priority: med
  - category: a11y
  - estimate: 45m
  - depends_on: none
  - discovered_by: fire-43
  - context: Parked `docs/_loop-scan/discovery-domains-2026-09-29.md`. `domain-manager.component.ts:
    48-56` popover needs `aria-modal="true"` + focus-trap; button text-width jitter (`:131-134`, min-w
    7ch→11ch). H1 already covered by the `check-admin-h1.mjs` gate. (Domains refresh-button width +
    analytics freshness label + apps-detail subdomain `aria-describedby` all shipped fire-43.)

- [ ] Playwright a11y spec across the 4 CF-resource inspectors + shared `list-select` directive
  - cadence: every-8-loops
  - priority: low
  - category: a11y
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-50
  - context: kv/r2/vectorize/queues inspectors now share ONE ARIA 1.2 listbox keyboard model (roving
    tabindex, `role=listbox/option/aria-selected`). Follow-on: a Playwright a11y spec across all 4 +
    extract a shared `list-select` directive to dedupe the 4 copies (interconnectedness).

---

## architecture

- [ ] error_handler.ts is 331 LOC — extract business logic out of middleware
  - cadence: every-4-loops
  - priority: med
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-49
  - context: `src/middleware/error_handler.ts` embeds `brandedErrorPage()` (68 LOC CSS-in-JS HTML) +
    R2-specific `10042→503` mapping (:254-292) — violates inverted-abstraction (middleware ≤200 LOC).
    Extract `brandedErrorPage`/`prefersHtml` → `src/lib/error_pages.ts` + the R2 mapping → a typed
    `StorageUnavailableError` thrown from `site_serving.ts` (caught generically). Shrinks to ~150 LOC.

- [ ] social.component.ts god-component split (slices 3+: composer+preview, dialogs)
  - cadence: every-2-loops
  - priority: med
  - category: architecture
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 4 big item. Was 2676 LOC → 2446 after slices 1-2 (social-accounts, social-post-list
    extracted). Remaining: extract `social-composer` (+preview), `social-dialogs` into standalone
    presentational OnPush components. Byte-identical markup, parent keeps data-fetch/OAuth. Clears the
    `anyComponentStyle` 28KB budget WARN. Run FULL Karma on each slice.

- [ ] Admin god-component splits (analytics, billing, snapshots, settings, site-data-browser)
  - cadence: every-8-loops
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 01 [HIGH] (perf + a11y). `analytics` 134K, `billing` 138K/2790ln, `social` 131K,
    `snapshots` 109K, `settings`/`site-data-browser` ~88K, `domains` 1079ln, `ai-logs` 1501ln,
    `site-detail` 1459ln, `dashboard` 2199ln → lazy `@defer` per tab; each folded tab needs its own
    single `<h1>` (the `check-admin-h1.mjs` gate enforces this — verify after each split).

- [ ] Relocate editor `app/` → `apps/editor/`
  - cadence: once
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md` + `_LOOP.md` §5. Discrete relocation pass: root `wrangler.toml`, vite
    configs, `functions/`, `electron/`, CF Pages `bolt-diy` settings. Editor build + Pages deploy
    verify (by hash, not grep). Per monorepo convention (`style-guide-driven-decisions`): every
    deployable app under `apps/`.

- [ ] Cold-provision migration-apply pipeline — fold 0646 apply so it can't drift
  - cadence: once
  - priority: med
  - category: architecture
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Migration 0646 (`site_working_tree`+`site_releases`) was the FALSE-GREEN behind Promote —
    an unapplied migration hidden by the auth/ownership guard. Applied to prod D1 fire-B. TODO: fold
    the prod migration-apply into the deploy pipeline so a migration can't silently go unapplied.
    Per `unapplied-migration-hidden-by-auth-guard-is-false-green`.

- [ ] Add Vectorize semantic leg (semantic site search / "sites like mine" / concierge grounding)
  - cadence: every-16-loops
  - priority: low
  - category: architecture
  - estimate: 3h
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06/08 [MED]. The missing D1+Vectorize+DO leg. `RAG_INDEX` binding exists
    (`projectsites-rag`, 768-dim cosine). Wire semantic search / "sites like mine" / concierge
    grounding through Vectorize + AutoRAG (`src/services/rag.ts` has embed/indexChunk/semanticSearch).

- [ ] Retire `apps/web` v2 Angular plan + decide Electron desktop packaging
  - cadence: once
  - priority: low
  - category: architecture
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md`. `.cleanup-allowlist` references a non-existent `apps/web` dir — resolve or
    retire. Decide Electron desktop packaging — remove unless desktop distribution is a real goal
    (one-way-door: write the self-argument before deleting).

---

## security

- [ ] Rate-limit fail-CLOSED for expensive/abuse-sensitive routes (per-route policy) — DESIGN
  - cadence: every-8-loops
  - priority: high
  - category: security
  - estimate: 90m
  - depends_on: none
  - discovered_by: fire-49
  - context: DESIGN Rec (needs the call before coding). `src/middleware/rate_limit.ts:231-262` falls
    through UNMETERED when `CACHE_KV` errors — now LOGGED, but fail-open lets an attacker who induces
    KV congestion abuse expensive routes (media-gen $, SES). Likely answer: fail-CLOSED only for
    expensive/abuse-sensitive routes (per-route policy), fail-open for cheap reads. Blanket fail-closed
    would 429 the whole site on a KV blip.

- [ ] Server-side last-owner removal guard — VERIFIED SECURE (close-out check)
  - cadence: every-16-loops
  - priority: low
  - category: security
  - estimate: 15m
  - depends_on: none
  - discovered_by: fire-49
  - context: FALSE POSITIVE — the server DOES enforce it (`ai_admin.ts:266` counts owners + throws 409
    "Cannot remove the last owner" before the DELETE, org-scoped IDOR asserted, 3 TDD cases green).
    Listed only as a periodic re-verify anchor; no work unless a regression surfaces.

- [ ] Idempotency middleware onto all money/site-mutation POSTs
  - cadence: every-8-loops
  - priority: med
  - category: security
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [MED]. Wire `idempotency` middleware onto `/billing/*`, `/domains/purchase`,
    `/sites/:id/deploy`. Per `sync-ui-async-backing` idempotency-key convention (`Idempotency-Key`
    header → `crypto.randomUUID()` fallback → `INSERT OR IGNORE`). Fire-and-forget charges need a
    source idempotency key.

- [ ] Zod on the 23 `req.json().catch(()=>({}))` cast routes (per-feature, on promotion)
  - cadence: every-8-loops
  - priority: med
  - category: security
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `src/routes/features.ts` ~33 handlers read bodies as `as`-cast with NO runtime validation
    (forbidden by zod-everywhere). DORMANT — every endpoint is `requireFlag`-gated on a default-OFF
    flag (404 in prod, ZERO overlap with the 12 enabled flags). Convert PER-FEATURE as each flag is
    promoted to beta/stable, with a unit test per endpoint. NEVER mass-retrofit blind. Same pattern
    (smaller) in `media.ts`, `env_vars.ts`, `ai_admin.ts`.

---

## dead-code / hygiene

- [ ] audit-dead-code — orphan sweep + verify-before-delete batch
  - cadence: every-loop
  - priority: med
  - category: dead-code
  - estimate: 30m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Lane 5 recurring. Run `scripts/detect-orphans.mjs` + knip; wire the highest-value orphaned
    unit into a reachable surface the same fire (interconnectedness — built-but-unwired = not done).
    Verify 0 real + 0 dynamic callers BEFORE deleting (knip false-positives: namespace/dynamic refs).
    Dead-code well is largely DRY (function/const exports exhausted); pivot to genuinely uncovered
    areas — generated-site runtime, template repo, editor `app/`. Backlog parked in
    `docs/_loop-scan/discovery-deadcode-2026-09-29.md`.

- [ ] restoreDeletedSnapshot — VERIFIED WIRED (close-out check)
  - cadence: every-16-loops
  - priority: low
  - category: dead-code
  - estimate: 10m
  - depends_on: none
  - discovered_by: fire-48
  - context: `app/lib/persistence/projectSnapshots.ts:208` — verified WIRED (`ProjectHub.tsx:299`
    Undo-delete toast), NOT an orphan (the brief premise was stale). Periodic re-verify anchor only.

- [ ] revokeApiToken fail-soft — distinguish D1 error from not-found
  - cadence: every-8-loops
  - priority: low
  - category: hygiene
  - estimate: 20m
  - depends_on: none
  - discovered_by: fire-48
  - context: `src/services/api_tokens.ts:244` `.run().catch(() => null)` → a D1 error on revoke returns
    false ("not revoked"), conflating outage with not-found. Fail-SAFE (never falsely claims revoked)
    so low severity, but a silent revoke failure during an outage is confusing — surface the error,
    distinguish from not-found.

- [ ] Prune leftover `.claude/worktrees/agent-*` + regenerate lockfile
  - cadence: every-4-loops
  - priority: med
  - category: hygiene
  - estimate: 30m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Root `TODO.md` + `_LOOP.md` §5. ~68 leftover `.claude/worktrees/agent-*` — `git worktree
    prune` + explicit `git worktree remove` + `git branch -D` per fire (stranding incident class).
    Lockfile: `npm install --legacy-peer-deps` (removed workspace members still listed; `pnpm install`
    FAILS on electron-builder SSH dep).

- [ ] Source TODO/FIXME triage (useChatHistory FIXME + @deprecated shims)
  - cadence: every-8-loops
  - priority: low
  - category: hygiene
  - estimate: 60m
  - depends_on: none
  - discovered_by: repository-audit
  - context: `app/lib/persistence/useChatHistory.ts:416` FIXME — navigate fn rerenders `<Chat/>` +
    breaks the app (deliberate workaround, needs a real fix test-first). Deferred-lowvalue `@deprecated`
    shims: `external_llm.ts:193`, `smtp_config.ts:19`, `browser_gateway.ts:44` (remove when callers
    migrate). Blocked-external: `abuse.ts:36` arcjet Workers adapter. TODOs are roadmap — triage, don't
    blanket-delete.

---

## dx (recurring gates)

- [ ] lockfile-drift CI/pre-commit gate
  - cadence: once
  - priority: high
  - category: dx
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: P1 gate. This class RECURS (6+ "regenerate pnpm-lock" commits + a ~30-run silent-red
    pipeline — every worker commit stranded). Add a gate that fails when `pnpm install --lockfile-only`
    would change `pnpm-lock.yaml` (per `drift-detection` + audit-arc-maturity-ladder), so a silently-
    red deploy pipeline can't recur. Per `worker-deploy-silently-red-for-many-commits-via-lockfile-drift`.

- [ ] IDOR + feature-architecture gates into visible CI workflows
  - cadence: once
  - priority: med
  - category: dx
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: brief 06 [HIGH]. `validate:idor` + `validate:action-pins` promoted to blocking steps in
    `feature-architecture.yml` fire-49. Verify `feature-architecture.yml` runs both gates + backfill
    "handlers.ts dir MUST have a manifest" check (89 feature dirs, ~20 with valid manifest;
    `api_keys`/`audit_logs` are handlers-only). `assertSiteOwned` on every new `/api/sites/:siteId`.

---

## loop-improvement (recurring hygiene)

- [ ] loop-self-improvement — fold reusable lessons + append next-wave tasks
  - cadence: every-loop
  - priority: med
  - category: loop-improvement
  - estimate: 20m
  - depends_on: none
  - discovered_by: repository-audit
  - context: EVERY fire spawns the STANDING roster (discovery/audit + product/docs + browser/test +
    misc/integration). The discovery agent research- + repo- + runtime-audits a ROTATING uncovered area
    AND appends deduplicated next-wave tasks HERE (a fire appending zero next-wave tasks = the discovery
    agent under-scanned → rotate area next fire). Fold reusable lessons to `~/.claude` / `~/.agentskills`
    the same turn (`prompt-as-training-signal`). Update `LEDGER.md` with a ≤5-bullet entry.

- [ ] dependency-modernization — deps audit + safe version bumps
  - cadence: every-8-loops
  - priority: low
  - category: tech-modernization
  - estimate: 90m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Run `dependency-auditor` — outdated deps, security advisories, license violations, unused
    imports. Propose version bumps, run tests after updates. Open-source only. Prefer the stack's
    current versions (TS 7.0, ESLint 10, Angular 22, Playwright v1.56+, Vitest 5). Never `pnpm install`
    (electron-builder SSH dep) — `npm install --legacy-peer-deps` in sub-packages.

- [ ] doc-compression — compress docs without losing decisions/commands/warnings
  - cadence: every-4-loops
  - priority: low
  - category: docs
  - estimate: 45m
  - depends_on: none
  - discovered_by: repository-audit
  - context: Run the `docs-compression` skill on the loop docs + `apps/project-sites/CLAUDE.md` +
    sub-ledgers. Keep every decision/command/warning/architecture/example/open-TODO; cut filler +
    inferable knowledge (`instruction-compression-playbook`). Keep this BACKLOG + DISCOVERIES + LEDGER
    optimized for future agents. Older detail lives in git history + sub-ledgers.

---

## Brian-gated (approval-required — ship the decision-independent slice, NEVER auto-execute)

- ConversationHub DO deletion (`src/index.ts:250`) — destructive one-way-door DO migration
  (`deleted_classes`); DEFERRED indefinitely; needs explicit confirm + correct tag (procedure in the
  source comment).
- GPT-4o vision → Workers-AI swap per callsite (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- Backend-complete → decide frontend render for 4 surfaces (`_LOOP_LEDGER.md` NEEDS-BRIAN).
- Geo-sweep + admin form + `/admin` persistence (`_LOOP_LEDGER.md` NEEDS-BRIAN).

## Blocked-user (awaiting a credential/decision only Brian can provide)

- LinkedIn OAuth creds · Reddit OAuth creds (blocked 4+ days).
- Stripe `STRIPE_PRICE_ID_MONTHLY_WALLET` — landed; needs integration wiring.
- DeepSeek $5 top-up — unblocks bespoke build-LLM copy + build-LLM-gated cohort rebuilds.
