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
2. **`deploySiteToWfp(env, siteId, {slot, version})`** — build the per-site worker (Workers Assets from
   the site's R2 `dist/` + the shims + Functions), upload to `site-<id>-preview` | `site-<id>`,
   idempotent; record the registry row. Reuse the assets-upload-session recipe. `assertSiteOwned`. **coupled**
3. **Serving preference** — additive branch in `serveSiteFromR2`/`index.ts`: flag ON + WfP prod script
   present → `dispatchToUserWorker('site-<id>', req)`; preview hosts → `-preview`; **else unchanged R2**;
   fail-soft to R2 on any dispatch error. **coupled**
4. **Wire lifecycle** — deploy the **preview** slot after `upload-final`; deploy the **production** slot
   on publish/promote. **coupled**
5. **Teardown** — on site delete/archive, delete BOTH slots + clear the registry row (reuse
   `deleteSiteFunctionsWorker`). **coupled**
6. **Owner UI (admin, Angular + Spartan, brand tokens)** — a Preview/Publish + **WfP deploy-status**
   surface (status pill: provisioning/preview-live/published; the preview URL + the prod URL; a
   Publish/Promote action; the four states empty/loading/error/success). Reachable from the site
   detail. This is the **"integrate into the UI"** deliverable. **satellite**
7. **Tests + docs + drift** — unit (deploy service, serving preference, registry, teardown) + e2e
   (new site → preview WfP styled 200 → publish → prod WfP styled 200 → delete → 404) + `e2e/FEATURES.md`
   row + this doc kept current + CLAUDE.md serving-flow updated + a drift gate (registry↔serving). **satellite**

## Acceptance

- Flag OFF → `serveSiteFromR2` behavior byte-identical; every existing site unchanged.
- Flag ON, new site → its preview slot serves a **styled 200 via dispatch**; on publish the prod slot
  serves a styled 200; on delete both slots + registry are gone (404).
- Portability preserved (the site deliverable still deploys to bare CF; no platform-only bindings baked in).

## Verification in this repo (no local build required)

GitHub MCP branch → PR → CI (typecheck / Jest / `ng build`) → merge → CI `wrangler deploy --env
production` → **WebFetch prod-verify** a WfP-hosted site renders styled 200 → promote flag to beta.
Bash-independent (works through the classifier-outage pattern).

## References

- Memory `every-new-site-born-on-wfp-preview-and-prod` · `per-site-wfp-namespaces-directive-and-cf-constraint`
  · `payload-cf-launcher-golden-path` · `tenant-cf-service-exposure-model` · `deliverable-portability-vs-platform-lockin`.
