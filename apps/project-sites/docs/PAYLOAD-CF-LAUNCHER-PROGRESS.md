# Payload CMS on CF (D1 + R2 + Worker) — per-site launcher · PROGRESS

> Epic: replace the container Payload at `cms.projectsites.dev` with a **per-instance,
> per-site (max 3)** Payload launched from the admin catalog UI on **D1 + R2 + a CF Worker**,
> where **deleting the instance from the UI deletes the D1 + R2 + Worker with zero dangling
> resources**. Started 2026-09-25. This doc lets any fresh context continue.

## ✅ DONE + PROVEN this session (real evidence, live CF API)

1. **All 3 provisioning primitives proven** — create → delete → **confirm-gone** against the
   live CF API (account `84fa0d1b…`): **D1 ✅ · R2 ✅ · Worker ✅** (self-cleaning tests).
2. **Full stack lifecycle proven** — created D1 + R2 + **a Worker bound to that fresh D1+R2**
   (the previously-unproven bit) → verified all 3 exist → cascade-deleted Worker→D1→R2 →
   **all 3 confirmed gone**. The no-dangling guarantee is demonstrated, not theoretical.
3. **`src/services/cloudflare_provisioner.ts` built + typechecked** — encodes the proven
   sequence: `provisionPayloadStack` (D1→R2→Worker, **rolls back on any partial failure**) +
   `deprovisionPayloadStack` (delete Worker→D1→R2, **re-reads each to confirm gone**, returns a
   `{worker,d1,r2, clean}` verdict). Zod schemas + `CfProvisionError`. Auth prefers a scoped
   `CF_PROVISION_TOKEN`, falls back to the account global key.

## ⛔ Two hard blockers before a WORKING prod launch (both real, neither quick)

- **B1 — the real Payload app bundle (template now CLONED to `infra/payload-d1/`, 2026-09-25).**
  The real CMS is NOT a plain script upload (the current `PAYLOAD_BOOTSTRAP_WORKER` is a
  placeholder). Verified template facts:
  - **Stack:** Next 16 + `@opennextjs/cloudflare` ^1.11 + Payload 3.82 + `@payloadcms/db-d1-sqlite`
    + `@payloadcms/storage-r2` + `@payloadcms/richtext-lexical`. `wrangler ~4.116`.
  - **Deploy is OpenNext:** `main: ".open-next/worker.js"` + an **`ASSETS`** binding over
    `.open-next/assets/`. Bindings in `wrangler.jsonc`: **`D1`** (d1_databases) · **`R2`**
    (r2_buckets) · **`ASSETS`**. compat_date `2025-08-15`, flags `nodejs_compat` +
    `global_fetch_strictly_public`.
  - **Deploy cmds:** `deploy:database` = `payload migrate && wrangler d1 execute D1 … --remote`;
    `deploy:app` = `opennextjs-cloudflare build && opennextjs-cloudflare deploy`. Migrations via
    `payload migrate:create`.
  - **Constraints:** GraphQL unreliable in Workers. The template's "paid Workers plan / 3 MB"
    note is the FREE-tier cap — **Workers for Platforms IS paid**, so it's satisfied; WfP user
    Workers get paid limits (size limit is 64 MiB uncompressed regardless).
  - **DEPLOY MODEL — DECIDED: WfP user Worker + Static Assets (verified 2026-09-25).** WfP
    supports attaching **Static Assets directly to a user Worker** in a dispatch namespace —
    exactly what OpenNext needs. So: build the OpenNext bundle ONCE (`.open-next/worker.js` +
    `.open-next/assets/`), then per instance: create D1 → `payload migrate` on it → create R2 →
    upload the user Worker into `USER_DISPATCH` with per-instance bindings (`D1` id, `R2` bucket,
    `PAYLOAD_SECRET`) AND its assets, routed at `{slug}.app.projectsites.dev` by the dispatch
    Worker (existing `app_host_resolver`). Assets API (scoped to the user Worker):
    `POST /accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{script}/assets-upload-session`
    → provide a manifest (path→hash+size) → upload contents → link via the completion JWT. Up to
    **100,000 assets/Worker**; **first upload is synchronous** (200 = ready to serve). Deprovision
    already proven (delete user Worker + D1 + R2 → confirm gone). This settles "WfP where
    appropriate" = YES, WfP dispatch user Worker is the deploy target.
- **B2 — a runtime provisioning credential.** The Worker provisions at runtime, so it needs a
  **scoped `CF_PROVISION_TOKEN`** (D1:Edit + Workers R2 Storage:Edit + Workers Scripts:Edit) set
  via `wrangler secret put` (the local tests used the global key, which is NOT a Worker secret).
  Mint at `https://dash.cloudflare.com/profile/api-tokens`.

## Remaining slices (in order)

1. **Migration** — add `d1_database_id` + `worker_script_name` to `app_instances`
   (`neon_project_id`/`r2_bucket_name` already exist). Flag `payload_cf_launcher` (default-off).
2. **Wire the provisioner** — `apps.ts` POST `/api/apps/instances` (launch) calls
   `provisionPayloadStack` for the payload app; DELETE `/api/apps/instances/:id` calls
   `deprovisionPayloadStack` and only marks `destroyed` when `report.clean === true` (else
   surfaces the stragglers, never a silent leak). Persist the 5 stack ids on the row.
3. **Catalog** — re-tag the `payload` entry (`apps-catalog.ts:629`) from container/postgres to
   the D1+R2+Worker launch type, tags `["D1","R2","CF Worker"]`, `supported:true`.
4. **max-3-per-site** — enforce in the launch handler (`COUNT(*) FROM app_instances WHERE
   site_id=? AND app_slug='payload' AND deleted_at IS NULL >= 3` → 409). Needs a `site_id`
   column on `app_instances` (today it's org-scoped) — add in the migration.
5. **B1 Payload bundle** — build `with-cloudflare-d1` → Worker module; run its D1 migrations on
   the fresh per-instance D1; pass the module to `provisionPayloadStack({workerModule})`.
6. **B2 token** — mint + `wrangler secret put CF_PROVISION_TOKEN`.
7. **Old-container teardown** — BACK UP first (locate the current cms.projectsites.dev data —
   `infra/payload/` is a container; determine if data is container-SQLite (ephemeral) or Neon),
   then delete the `projectsites-payload` Worker + `PayloadCms` container + `cms.projectsites.dev`
   route + its DB. Remove `infra/payload/`.
8. **FE** — `/admin/apps` Payload card: Launch button → POST (spinner → subdomain link) + a
   per-instance Delete button → confirm → DELETE → toast + row removed.
9. **Verify (prod E2E)** — real browser: launch from `/admin/apps` → CF API confirms D1+R2+Worker
   exist → delete from UI → CF API confirms all 3 gone. Add to `e2e/admin-verify/`.
10. **Tests** — Jest for `cloudflare_provisioner` (mocked fetch: rollback + verify-gone verdicts);
    feature manifest + `validate:features`.

## Key facts (verified 2026-09-25)
- CF API create/delete works via the global key (`CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL`, `X-Auth-*`).
- Worker script upload = multipart `PUT /accounts/{acct}/workers/scripts/{name}` with a
  `metadata` JSON part (`main_module` + `bindings[]`) + the module part. D1 binding
  `{type:'d1',name:'DB',id:<uuid>}`, R2 `{type:'r2_bucket',name:'MEDIA',bucket_name:<name>}`.
- Existing seam: `app_provisioner.ts` (`provisionInfra`/`deprovisionInfra`) + `apps.ts`
  POST/DELETE are ALREADY the FE-facing launch/delete lifecycle. Extend, don't rebuild.
- ⚠️ The existing `deprovisionInfra` SKIPS R2 deletion + has no D1/Worker teardown — the new
  provisioner fixes that class for the Payload stack.
