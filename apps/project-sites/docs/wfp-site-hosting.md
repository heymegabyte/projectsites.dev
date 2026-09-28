# WfP Site Hosting — every new site born on Workers-for-Platforms (preview + production)

> **Directive (Brian, 2026-09-28):** every NEW generated site is hosted **entirely on a CF
> Workers-for-Platforms (WfP) dispatch namespace — a PREVIEW slot AND a PRODUCTION slot —
> from birth.** WfP becomes the site *substrate*, not the optional Functions add-on it is today.
>
> This is the buildable backlog for the `site_wfp_hosting` loop. Ship behind a **default-OFF**
> flag, additive, fail-soft to the existing R2 path. Sequence + acceptance below.

## Resolved gate (was Brian-gated)

`progress.md` had flagged the one-way door *"should a dispatched Worker be the default serve
path for EVERY generated site?"* as Brian-gated. **Answered: YES.** No longer gated — build it
behind the flag. Isolation memory: `every-new-site-born-on-wfp-preview-and-prod`.

## Current state (verified against code)

- **Serving is R2-static-direct.** `src/services/site_serving.ts`: `resolveSite()` (KV 60s → D1)
  → `serveSiteFromR2()` fetches `SITES_BUCKET.get('sites/{slug}/{version}/{file}')`, injects the
  free-tier top-bar, edge-caches via `caches.default`. No WfP in the customer-site hot path.
- **"Preview" today** = R2 branch previews (`{branch}--{slug}.projectsites.dev` → `sites/{slug}/branches/{name}/`,
  `parseBranchHost`) + R2 snapshots (`{slug}-{snapshot}` → `site_snapshots.build_version`). Both R2-static.
- **Build** = `src/workflows/site-generation.ts` → container build → `upload-final` puts `dist/` to
  R2 `sites/{slug}/{version}/` + sets `sites.status='published'` + `sites.current_build_version`.
- **WfP exists but only for** (a) optional Functions (`src/services/wfp_dispatch.ts`:
  `siteFunctionsScriptName` → `site-<id>` | `site-<id>-preview`, `uploadSiteFunctionsWorker`,
  `dispatchToUserWorker`, `deleteSiteFunctionsWorker`; shared namespace `project-sites-endpoints` =
  `6ea19ae4-f28b-4d05-a50e-4461b3126c20`, live behind `USER_DISPATCH`) and (b) Payload app instances
  (`src/services/cloudflare_provisioner.ts`).

## Interpretation (do NOT re-litigate per-customer namespaces — rejected; CF can't runtime-select namespaces)

- **ONE shared namespace** `project-sites-endpoints`. **Two slots per site**: `site-<siteId>-preview`
  (preview) + `site-<siteId>` (production).
- The per-site worker carries the site's **OWN static assets via Workers Static Assets** — reuse the
  **assets-upload-session** flow already proven in `cloudflare_provisioner.deployRealPayloadWorker`
  (POST `scripts/{name}/assets-upload-session` → jwt+buckets → `/workers/assets/upload?base64=true`
  → completion jwt → multipart script upload with an `ASSETS` binding) + the Functions bundle. Served
  via `dispatchToUserWorker`.
- **R2 stays** the asset store + the migration/fallback path. `site_wfp_hosting` default OFF; the
  serving change is a **new branch** (WfP prod script present → dispatch; ELSE the byte-identical
  current R2 path). **Fail-soft:** any WfP miss/error falls back to R2.

## Load-bearing constraint (Payload fires 12-13)

A WfP **dispatch** worker **bypasses the edge Static-Assets layer** → naive `/assets/*` + hashed
chunks 404 (unstyled). The per-site worker MUST serve its own assets via **Workers Assets on the
script** (not the edge). **Verify a STYLED 200 in a real browser** (WebFetch/Playwright), never off a
lone 200.

## Reuse (do NOT reimplement)

`wfp_dispatch.ts` (`siteFunctionsScriptName`/`uploadSiteFunctionsWorker`/`dispatchToUserWorker`/
`deleteSiteFunctionsWorker`), `cloudflare_provisioner.ts` (assets-upload-session), `resolveSiteDataDb`
(per-site D1 allocation), `__PS_R2`/`__PS_KV` prefixed shims.

## Work units (ordered — each behind the flag, TDD, typecheck+test, then PR→CI→merge→deploy→WebFetch verify)

1. ✅ **Reserve flag + registry.** DONE (2026-09-28). `site_wfp_hosting` reserved DARK in the
   registry-driven flag SSOT: `FLAG_REGISTRY` (`src/modules/feature_flags/registry.ts`,
   `default_enabled:false, rollout:0, stage:'experimental'`) + a runbook-grade `FLAG_DOCS` entry
   (`docs.ts`, checklist + smoke_test + `e2e/wfp-site-hosting.spec.ts`). No D1 seed migration needed —
   the registry IS the default floor; `flag_overrides` only stores admin toggles. The
   `site_resource_registry` row shape + read/write helpers already exist (migration 0643 +
   `libs/features/data_resource_registry/{schemas,service}.ts`: `wfp_namespace` concept,
   `preview|production` environment, `userWorkerScript`, `deployedVersion`, `recordResource`/
   `listResources`/`getResource`) — REUSED, not reimplemented. Guard test
   `src/__tests__/site_wfp_hosting_flag.test.ts`. (Also fixed a pre-existing red: `r2_buckets` docs
   referenced a missing `e2e/r2-buckets.spec.ts` — created it, deploy gate now green.) **coupled**
2. ✅ **`deploySiteToWfp(env, siteId, {slot, version})`** — DONE (2026-09-28).
   `src/services/wfp_site_hosting.ts` (thin service): resolves `slug`+`version` from the OWNED site
   (`current_build_version` fallback), enumerates the R2 build (`sites/{slug}/{version}/*` — the actual
   flat layout `upload-final` writes, not a literal `dist/`), builds a dependency-free SPA-fallback
   serving shim, uploads the site's OWN static assets via the **assets-upload-session** recipe REUSED
   from `cloudflare_provisioner` (POST `…/scripts/<slot>/assets-upload-session` → jwt+buckets →
   `/workers/assets/upload?base64=true` → completion jwt), then PUTs the shim with an `ASSETS` binding to
   the dispatch slot `site-<id>` | `site-<id>-preview` (slot name REUSED from `wfp_dispatch.siteFunctionsScriptName`).
   Records the slot via `recordResource` (`wfp_namespace` concept, `preview|production` env, `userWorkerScript`,
   `deployedVersion`) with **source+artifact SHA-256 digests** in `usage_json` for promotion idempotency.
   `assertSiteOwned` gates it (404-on-foreign, ZERO CF calls on rejection); short-lived `CF_API_TOKEN`
   Bearer only; **fail-soft** typed `{ok:false}` on every miss/error (unconfigured, empty build, CF reject,
   record fail) — never throws into the serving path. Unit test `src/__tests__/wfp_site_hosting.test.ts`
   (7 cases: ownership reject, unconfigured, prod slot upload+record, preview slot, version fallback,
   empty build, CF PUT reject). tsc + jest green. **coupled**
3. ✅ **Serving preference** — DONE (2026-09-28). `serveSiteViaWfpIfPreferred(env, site, req, host)`
   (`src/services/site_serving.ts`) is the additive, flag-gated preference branch, wired into the site
   request path in `index.ts` right BEFORE the (untouched, byte-identical) `serveSiteFromR2` call:
   `const w = await serveSiteViaWfpIfPreferred(...); if (w) return w;` else the existing R2 path runs
   verbatim. Order of gates (flag FIRST so the flag-off majority is byte-identical — one flag read then
   `null` → R2): skip non-real orgs (`bolt-community`/`bolt-*`) → `isFlagOn('site_wfp_hosting', {orgId,
   siteId})` → `isWfpConfigured` → resolve env from the host (`parseBranchHost` → `preview`|`production`)
   → `listResources(siteId, env)` finds a live `wfp_namespace` slot with a `userWorkerScript` →
   `dispatchToUserWorker(env, slot.userWorkerScript, req)`. Preview hosts dispatch the `-preview` slot,
   prod the prod slot (isolation preserved — a preview never resolves a production slot). **Fail-soft**:
   any miss / unconfigured / dispatch throw / user-worker 5xx → returns `null` → R2 (never worse than R2,
   never a 5xx to the visitor). Served WfP responses carry `x-ps-serve: wfp` so a prod-verify can prove
   dispatch. REUSES `wfp_dispatch.{isWfpConfigured,siteFunctionsScriptName,dispatchToUserWorker}` +
   Unit-1 `listResources` + `isFlagOn` — no dispatch reimplemented. Unit test
   `src/__tests__/wfp_serve_preference.test.ts` (8 cases: flag-off no-dispatch, flag-on+slot→dispatch prod,
   preview host→`-preview`, no slot→R2, dispatch throw→R2, unconfigured→R2, worker-5xx→R2, bolt-community→R2).
   tsc + full Jest (864 suites) green. **coupled**
4. ✅ **Wire lifecycle** — DONE (2026-09-28). `deploySiteWfpSlotsOnLifecycle(env, siteId, {orgId, slots, version})`
   (`src/services/wfp_site_hosting.ts`) is the thin, fail-soft, flag-gated lifecycle hook the build/publish
   path calls to give a site its WfP slots — flag-gated FIRST (`site_wfp_hosting`, per-site) so a flag-off
   build/publish makes ZERO WfP calls (byte-identical), then calls Unit-2 `deploySiteToWfp` per requested slot
   (REUSED, not reimplemented). Wired into THREE lifecycle points, each ADDITIVE + fail-soft (never throws into
   the build/publish path; a WfP miss leaves R2 the served path): (a) the site-generation Workflow's
   `finalize-build` step, right AFTER the `status='published'` D1 flip — deploys BOTH the `preview` AND
   `production` slots from the just-published `version` (`void`'d, audit-logged `workflow.wfp_slots_deployed`);
   (b) `POST /api/publish/bolt` (anonymous bolt publish) — deploys the `production` slot (`waitUntil`); (c)
   `POST /api/sites/:id/publish-bolt` (authed embedded-bolt publish) — deploys the `production` slot
   (`waitUntil`, beside the existing functions-deploy). Ownership is enforced by `deploySiteToWfp`'s own
   `assertSiteOwned` (the workflow/route already resolved the owner); short-lived Bearer creds only. Unit test
   `src/__tests__/wfp_lifecycle_wiring.test.ts` (7 cases: flag-off no-call byte-identical, flag-on preview slot,
   flag-on production slot, flag-on both slots, deploy-failure no-throw, deploy-throw swallowed, no-orgId skip).
   tsc + full Jest (865 suites / 13,717 tests) green. **coupled**
5. ✅ **Teardown** — DONE (2026-09-28). `teardownSiteWfp(env, siteId, {orgId})`
   (`src/services/wfp_site_hosting.ts`) is the thin, flag-gated, fail-soft teardown hook the site
   delete/archive paths call to remove a site's WfP footprint: it deletes BOTH dispatch slots
   (production `site-<id>` AND preview `site-<id>-preview`) from the shared `USER_DISPATCH` namespace
   via `deleteSiteFunctionsWorker` (REUSED, not reimplemented — the SAME best-effort/never-throws CF
   DELETE Functions uses), then clears the site's `wfp_namespace` registry rows via the new
   `clearSiteWfpRegistry(env, siteId)` (`libs/features/data_resource_registry/service.ts` — one
   `UPDATE … SET deleted_at` soft-delete over both preview+production rows, scoped to the site + the
   `wfp_namespace` concept, `deleted_at IS NULL`-guarded so a re-run is a no-op; typed
   `{ok, cleared}`, fail-soft). **Flag-gated FIRST** (`site_wfp_hosting`, per-site) so a flag-off
   delete/archive makes ZERO WfP/registry calls (byte-identical). **Idempotent** — deleting an
   absent slot is a no-op success (CF 404 swallowed) + `clearSiteWfpRegistry` re-runs to 0 changes.
   **Fail-soft** — a slot-delete throw OR a registry-clear throw is swallowed; `teardownSiteWfp`
   NEVER throws into delete/archive (each step independently guarded, absolute outer try/catch).
   Wired into THREE lifecycle points, each ADDITIVE + fire-and-forget: (a) `DELETE /api/sites/:id`
   (guarded by the route's existing `requireOwnedSite`); (b) `DELETE /api/admin/account` (snapshots
   the org's live site ids BEFORE the archive batch, then tears each down); (c) `resolveAbuseReport`
   takedown (`libs/features/abuse_takedown/service.ts`, after the successful archive, using the
   report's `org_id` as the flag scope). The two api.ts call sites go through a `runTeardownWfp`
   wrapper that prefers `ctx.waitUntil` but guards the THROWING `c.executionCtx` getter (unit-test
   runtimes have no ExecutionContext) so scheduling never throws into the delete. `serveSiteFromR2`
   is UNTOUCHED (byte-identical). Unit tests `src/__tests__/wfp_teardown.test.ts` (6 cases: flag-off
   no-call byte-identical, flag-on both-slots+registry-clear, idempotent absent-slot no-op,
   slot-delete-throw swallowed, registry-clear-throw swallowed, no-orgId skip) +
   `libs/features/data_resource_registry/__tests__/clear_site_wfp.test.ts` (3 cases: soft-delete
   shape, fail-soft D1 error, idempotent 0-rows). tsc clean; full Jest **868 suites / 13,734 tests**
   green. Commit `c6c81481f`. **coupled**
6. **Owner UI (admin, Angular + Spartan, brand tokens)** — a Preview/Publish + **WfP deploy-status**
   surface (status pill: provisioning/preview-live/published; the preview URL + the prod URL; a
   Publish/Promote action; the four states empty/loading/error/success). Reachable from the site
   detail. This is the **"integrate into the UI"** deliverable. **satellite**
7. **Tests + docs + drift** — unit (deploy service, serving preference, registry, teardown) + e2e
   (new site → preview WfP styled 200 → publish → prod WfP styled 200 → delete → 404) + `e2e/FEATURES.md`
   row + this doc kept current + CLAUDE.md serving-flow updated + a drift gate (registry↔serving). **satellite**

## Acceptance

- Flag OFF → `serveSiteFromR2` behavior byte-identical; every existing site unchanged. **✅ MET** — the
  flag-gate is the FIRST check in the serving preference (Unit 3), the lifecycle hook (Unit 4), AND the
  teardown hook (Unit 5); a flag-off site reads one flag then falls through to the untouched R2 path /
  makes ZERO WfP calls on build, publish, delete, AND archive (unit-tested byte-identical on all surfaces).
  `serveSiteFromR2` remains untouched through Unit 5.
- Flag ON, new site → its preview slot serves a **styled 200 via dispatch**; on publish the prod slot
  serves a styled 200; on delete both slots + registry are gone (404). **◐ IMPL COMPLETE — end-to-end
  prod-verify PENDING one external step.** Units 1-5 wire the FULL lifecycle (build → preview slot; publish →
  prod slot; Unit-3 dispatch serves it with `x-ps-serve: wfp`; **delete/archive → Unit-5 `teardownSiteWfp`
  deletes both slots + clears the registry** so the next request 404s / falls to R2), and Units 1-4 deployed
  to production (`wrangler deploy --env production`). The remaining check requires WfP to be PROVISIONED on the account:
  `isWfpConfigured(env)` is currently FALSE on prod (the `USER_DISPATCH` binding / dispatch namespace
  `project-sites-endpoints` + `CF_API_TOKEN` are not yet all set), so `deploySiteToWfp` fail-softs
  `wfp_not_configured` and no slot is ever deployed — every site correctly stays on R2. Once WfP is provisioned
  (add the `[[dispatch_namespaces]]` binding to `wrangler.toml` + set the CF token secret), flip
  `site_wfp_hosting` ON for one test site with an R2 build, run a publish (or call `deploySiteToWfp` directly),
  then WebFetch its subdomain → assert **200 + styled HTML + `x-ps-serve: wfp`**. This is the sole external
  gate; the code path is complete + unit-proven. (Teardown Unit 5 is DONE — delete/archive tears down both
  slots + registry, unit-proven; owner UI Unit 6 is the next work unit.)
- Portability preserved (the site deliverable still deploys to bare CF; no platform-only bindings baked in).
  **✅ MET** — nothing platform-only is baked into the site's own build; the WfP slot is a serving substrate on
  the platform side (the serving shim + `ASSETS` binding are added at deploy time, not written into the R2 build).

## Verification in this repo (no local build required)

GitHub MCP branch → PR → CI (typecheck / Jest / `ng build`) → merge → CI `wrangler deploy --env
production` → **WebFetch prod-verify** a WfP-hosted site renders styled 200 → promote flag to beta.
Bash-independent (works through the classifier-outage pattern).

## References

- Memory `every-new-site-born-on-wfp-preview-and-prod` · `per-site-wfp-namespaces-directive-and-cf-constraint`
  · `payload-cf-launcher-golden-path` · `tenant-cf-service-exposure-model` · `deliverable-portability-vs-platform-lockin`.
