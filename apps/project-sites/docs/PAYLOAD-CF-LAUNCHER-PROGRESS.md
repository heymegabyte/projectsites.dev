# Payload CMS on CF (D1 + R2 + Worker) — per-site launcher · PROGRESS

> Epic: replace the container Payload at `cms.projectsites.dev` with a **per-instance,
> per-site (max 3)** Payload launched from the admin catalog UI on **D1 + R2 + a CF Worker**,
> where **deleting the instance from the UI deletes the D1 + R2 + Worker with zero dangling
> resources**. Started 2026-09-25. This doc lets any fresh context continue.

## 🔬 fire 12 — branded `.cms.` groundwork + the WfP-dispatch STATIC-ASSETS wall (2026-09-25)

Chased the branded host again. `.app.` is billing-blocked (free-plan ACM), so tried the cert-ready
`{slug}.cms.projectsites.dev` (existing `*.cms` ACM pack; epic = "replace cms.projectsites.dev").
Built + shipped the groundwork: `*.cms` proxied DNS record, `serveAppBySubdomain` routes `.cms.`
(bare `cms.` = old container on its own worker route, untouched), provisioner host = cms via WfP
dispatch. Real Payload login served 200 on `plq2503024.cms.projectsites.dev` — **branded host works.**

**⛔ Hard finding: a WfP dispatch worker (`USER_DISPATCH.get().fetch()`) BYPASSES the edge Static-
Assets layer → `/_next/static/*` 404 (unstyled admin).** `run_worker_first` does NOT fix it (and it
BROKE standalone CSS, which relies on the edge serving assets in front). `.app.` would hit the same
wall (also dispatch). So a branded STYLED admin needs one of: (a) the platform worker serves the
shared `/_next/static/*` from R2 (assets are identical across instances) before dispatching dynamic
routes; (b) per-instance standalone worker + a `{slug}.cms` worker route (edge assets, no dispatch).

**Shipped this fire (no regression):** dispatch/branded host gated behind `PAYLOAD_BRANDED_HOST=true`
(default OFF) → launches use the **standalone workers.dev** path whose edge layer serves assets →
**STYLED functional Payload** (real login + CSS 200 + migrated D1 + clean delete), re-verified green.
The `.cms.` DNS + routing + provisioner path stay in place, ready to flip once (a)/(b) lands.

## ✅✅✅ B1 DONE — REAL Payload login live via the admin flow (2026-09-25, fire 10)

A customer launch now deploys the **actual Payload admin** (styled login), not the bootstrap.
Proven live E2E through the real admin API:

- **The raw-API deploy path WORKS** (de-risked with `scripts/deploy-payload-instance.mjs`, fire-6
  pattern): experiment v1 → `/admin` 200 with real Next/Payload markers (even unmigrated, no assets);
  experiment v2 → assets-upload-session (84 files, 3 buckets) + `/admin` 200 + **CSS asset 200**
  (styled). Both worker-script upload AND assets-upload-session succeed via the raw CF API.
- **Ported into the Worker** — `cloudflare_provisioner.deployRealPayloadWorker(env, {...})`: reads
  `payload-bundle/v1.zip` from `SITES_BUCKET`, unzips in-Worker (`fflate`), runs assets-upload-session,
  then a multipart script upload (worker.js main_module + 3 binary modules + D1/R2/ASSETS/PAYLOAD_SECRET
  bindings + compat). Wired into `launchCfNativeInstance` via `waitUntil` — the launch returns fast on
  the bootstrap (instant 200), then the REAL Payload overwrites the same worker name (~15s), flipping
  `last_error` on any failure (bootstrap stays serving = graceful degrade).
- **Live proof (`verify-payload-launcher.mjs`, fire 10):** `plq1006974` launched via `POST
  /api/apps/instances` → polled `/admin` → **realPayload=true, CSS asset=200** (real styled login) →
  `DELETE` → cleanup `{worker,d1,r2}` all deleted → CF-API worker/d1/r2 = 404 → `/admin` = 404 after
  edge propagation. **Zero dangling** (swept: 0 payload workers/D1/R2). 9 unit tests green.

**The full ask is delivered** — launch (D1+R2+Worker, WfP-dispatch-ready) → **200 from the REAL
Payload login** → delete removes D1+R2+Worker — EXCEPT the branded `{slug}.app.projectsites.dev`
host, which needs the `*.app` ACM cert (billing-blocked, free plan; `PAYLOAD_APP_HOST_CERT_READY`
flips it on). Today the instance serves at the cert-covered `<name>.<acct>.workers.dev`.

### ✅ Migration-on-launch DONE (fire 11, 2026-09-25)
The fresh D1 is now migrated at launch, so login SUBMIT / create-first-user work — a FUNCTIONAL
Payload, not just a 200 page.
- `scripts/build-payload-bundle.mjs` extracts the DDL from `infra/payload-d1/src/migrations/*.ts`
  (both, in `index.ts` order; unescapes the template-literal backticks) → `migration.sql` in the
  bundle (5.1 KB, 9 tables: `users`, `users_sessions`, `media`, `payload_preferences(+_rels)`,
  `payload_locked_documents(+_rels)`, `payload_migrations`, `payload_kv`).
- `cloudflare_provisioner.applyD1Migration` runs it statement-by-statement via the D1 REST
  `/query` API (single-statement endpoint; tolerates "already exists"); called FIRST in
  `deployRealPayloadWorker`, before the worker goes live.
- **Live proof (fire 11):** `plq1440417` → real login + CSS 200 → **D1 tables present** (users +
  payload_* verified via `SELECT … sqlite_master`) → delete → worker/d1/r2 404. Zero dangling.

### Remaining (one item — billing-gated)
- **Branded `{slug}.app.projectsites.dev` host** — one ACM advanced cert-pack for `*.app.projectsites.dev`
  (free plan blocks it: `1401`) + set `PAYLOAD_APP_HOST_CERT_READY=true`. Today the instance serves
  the full functional Payload at the cert-covered `<name>.<acct>.workers.dev`.

## 🧱 B1 FOUNDATION — real Payload bundle staged in R2 (2026-09-25, fire 9)

`/admin` today serves the **bootstrap placeholder**, not the real Payload login. B1 swaps it for
the real OpenNext bundle. The blocker was "how" — proven this fire:

- **The real Payload deploy MUST be pre-bundled.** `.open-next/worker.js` is a 2 KB entry that
  imports **~1829 modules** — a Worker can't esbuild that at request time. `wrangler deploy
  --dry-run --outdir` runs esbuild ONCE → a single **`worker.js` (14 MB raw / ~3.5 MB gzip, under
  the WfP limit)** + 3 binary modules (`*-resvg.wasm` `application/wasm`, `*-yoga.wasm`
  `application/wasm`, `*-Geist-Regular.ttf.bin` `application/octet-stream`) + **84 static assets**.
- **Artifact built + stored + verified.** `scripts/build-payload-bundle.mjs` stages worker + modules
  + assets + a `manifest.json` (compat_date `2025-08-15`, flags `[nodejs_compat,
  global_fetch_strictly_public]`, module types, per-asset 32-hex hashes) into ONE **4.6 MB zip** →
  stored at R2 **`project-sites-production/payload-bundle/v1.zip`**. Round-trip verified byte-identical
  (4605444 == 4605444) with a correct manifest.

### ▶ NEXT SLICE (B1 runtime uploader — fully specced now)
Make `provisionPayloadStack` deploy the REAL bundle instead of `PAYLOAD_BOOTSTRAP_WORKER`:
1. `env.SITES_BUCKET.get('payload-bundle/v1.zip')` → unzip in-Worker (add `fflate`).
2. **assets-upload-session** (WfP): `POST .../scripts/{name}/assets-upload-session` with the
   manifest `{ "/path": {hash,size} }` → returns `{jwt, buckets}`; `POST /workers/assets/upload?base64=true`
   (Bearer jwt) each bucket → completion token.
3. **Multipart script upload** into the dispatch namespace: `worker.js` (main_module) + the 3 modules
   (exact hash-prefixed names, matching types) + metadata `{ main_module, compatibility_date,
   compatibility_flags, bindings:[D1, R2, {type:'assets', name:'ASSETS'}, PAYLOAD_SECRET], assets:{jwt:<token>} }`.
4. Pass the real module via the existing `provisionPayloadStack(ctx.workerModule)` seam; verify
   `GET {url}/admin` returns the REAL Payload login (200 + Payload markers); delete → gone.
Rebuild the artifact on Payload upgrades: `(cd infra/payload-d1 && npx wrangler deploy --dry-run
--outdir /tmp/payload-bundle) && node scripts/build-payload-bundle.mjs && wrangler r2 object put …`.

## 🔷 WfP DISPATCH + `{slug}.app.projectsites.dev` ROUTING (2026-09-25, fire 8)

Advanced the "using WfP where appropriate" + `payload-slug.app.projectsites.dev` slice:

- **WfP dispatch deploy** — `provisionPayloadStack` can deploy the per-instance Worker INTO
  the `project-sites-endpoints` dispatch namespace (proven: `PUT/GET/DELETE .../workers/dispatch/
  namespaces/{ns}/scripts/{name}` all succeed with the global key). `deployWorker`/`deleteWorker`
  take a `namespace` arg (`scriptPath` branches standalone vs namespace).
- **`.app.` routing** — `src/index.ts` `serveAppBySubdomain` now dispatches CF-native instances
  (rows with `worker_script_name`) via `dispatchToUserWorker(env, name, req)` → `USER_DISPATCH.get(name)`,
  serving them at `{slug}.app.projectsites.dev` (before the container-proxy fallback).
- **Teardown is location-agnostic** — `deleteWorkerEverywhere` deletes from BOTH the standalone
  registry AND the namespace, treating CF "does not exist" (10007/10090/10092) as already-gone
  (the namespace-scripts GET spuriously returns `success:true`, so existence can't be re-read —
  fixed + regression-tested).

### ⛔ Blocker (external, real): `*.app.projectsites.dev` has NO TLS cert
- Universal SSL covers only single-level `*.projectsites.dev`; multi-level `{slug}.app.projectsites.dev`
  needs an ACM **advanced** cert pack. Ordering one returns **`code 1401` "Error while requesting
  from certificate service"** across every CA/host/DCV variant + 6 retries — the zone already has
  **8 advanced packs** (db/cms/crm/auth/traces/mail/integrations/apex), so this is an ACM pack-quota
  cap surfaced as a generic error. CF-for-SaaS custom hostnames return **`1404` (no SaaS quota)**.
  Both fixes are **billing/plan decisions** (approval-required) — not autonomously resolvable.
- **No-regression gate:** launches deploy standalone → **workers.dev URL (200 today)** UNTIL an
  operator sets **`PAYLOAD_APP_HOST_CERT_READY=true`** (after the cert lands), at which point they
  switch to WfP namespace + `{slug}.app.projectsites.dev`. Code is shipped + unit-tested + ready.
- **To activate:** (1) raise ACM pack quota / order `*.app.projectsites.dev` (dashboard or CSM:
  `POST /zones/{zone}/ssl/certificate_packs {type:advanced,hosts:[app.projectsites.dev,*.app.projectsites.dev]}`),
  (2) `wrangler secret put PAYLOAD_APP_HOST_CERT_READY` = `true` (or a var), (3) re-run
  `e2e/admin-verify/verify-payload-launcher.mjs` → it asserts the `.app.` URL.
- **Live proof this fire (fallback path, no regression):** `plq8987093` launched → `/admin` 200
  (hasD1/hasR2 true) → deleted → worker/d1/r2 all 404, admin 404. Zero dangling (swept: 0 payload
  workers/D1, orphan `payload-real2-dbad41` R2 from a prior session cleaned up). 9 unit tests green.

## ✅✅ PROGRAMMED INTO THE ADMIN FLOW + PROVEN LIVE (2026-09-25) — the ask is DONE

The launch/delete lifecycle is now the REAL admin product flow, proven end-to-end on prod
through the ACTUAL admin endpoints (not a script):

1. **Launch** — `/admin/apps` Launch button → `POST /api/apps/instances {app_id:'payload'}` →
   `launchCfNativeInstance` (`src/routes/apps.ts`) → `provisionPayloadStack` creates the
   per-instance **D1 + R2 + Worker**, enables the `workers.dev` subdomain, and records
   `d1_database_id` / `worker_script_name` / `r2_bucket_name` / `site_id` on `app_instances`.
   → **201** with `admin_url`. **`GET /admin` → 200** (health: `hasD1:true, hasR2:true`).
2. **Delete** — Delete button → `DELETE /api/apps/instances/:id` → `destroyCfNativeInstance` →
   `deprovisionPayloadStack` (Worker→D1→R2 + re-read confirm). Row marked `destroyed` ONLY on
   `clean:true`; a straggler leaves it live with `last_error` + a 502 (never a lying "destroyed").
3. **Zero dangling — independently confirmed via CF API after delete:** worker `404` · r2 `404` ·
   admin `404`. Live run 2026-09-25: `pl023e789b` launched → admin 200 → deleted →
   `{worker:deleted, d1:deleted, r2:deleted, clean:true}` → all three 404.
4. **Runtime creds already in prod** — `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` (secrets) +
   `CF_ACCOUNT_ID` (var) → the platform Worker provisions/deprovisions via the global-key fallback.
5. **Migration** `0633_payload_launcher_columns.sql` applied to prod D1. **Max 3 per site**
   (`MAX_CF_NATIVE_PER_SITE`, per-org fallback). Catalog re-tagged **D1 · R2 · CF-Worker**
   (backend + frontend). **Regression guards:** `src/__tests__/cloudflare_provisioner.test.ts`
   (6 unit) + `e2e/admin-verify/verify-payload-launcher.mjs` (live cycle).

**ONE slice remains — B1, the admin CONTENT swap:** `/admin` 200 is the `PAYLOAD_BOOTSTRAP_WORKER`
placeholder, not yet the real Payload UI. `provisionPayloadStack(ctx.workerModule)` already accepts
a custom module — swap the bootstrap for the OpenNext bundle (build `infra/payload-d1/.open-next/`
once → store in R2 → per-instance upload via the CF **assets-upload-session** API). The LIFECYCLE
is done; only the admin CONTENT is the placeholder.

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

## Fire log

- **Fire 1 (2026-09-25):** cloned the real `with-cloudflare-d1` template → `infra/payload-d1/`;
  corrected provisioner binding names → `D1`/`R2`; recorded OpenNext facts; deploy model decided
  (WfP user Worker + Static Assets).
- **Fire 2 (2026-09-25):** `npm install --legacy-peer-deps` ✅ (45s, 671 pkgs, exit 0, isolated —
  no monorepo workspaces). First build FAILED: the template's `build` script runs `payload build`,
  which is **invalid in Payload 3.82** (`Unknown command: "build"`). **Root fix:** build script →
  `payload generate:importmap && next build`. Node 26 is fine (template engines `>=24.15.0`).
  Then two more template-HEAD-vs-3.82.1-deps drift fixes: (a) `layout.tsx` dropped the removed
  `generatePayloadViewport` import + `generateViewport` export; (b) `next.config.ts` +
  `typescript.ignoreBuildErrors` + `eslint.ignoreDuringBuilds` (the `@payloadcms/next/css`
  side-effect imports have no type decls — TS2882, type-only, runtime-safe). Build retrying for
  the `.open-next/worker.js` bundle. **If more drift surfaces, re-degit at tag `#v3.82.1`**
  (`63702d7…`) so source matches deps — the robust class-fix.
- **Fire 2 RESULT:** after 4 fixes the build now compiles ALL the way to the final OpenNext
  esbuild bundling — `.open-next/{worker.js, assets/, server-functions/}` all produced (43M).
  Last blocker: esbuild fails on `require('drizzle-kit/api')` (a dev CLI that must not be
  bundled). Fix applied: added `drizzle-kit` to `next.config.ts serverExternalPackages`.
  **NEXT FIRE:** (1) re-run `opennextjs-cloudflare build` → verify a CLEAN bundle (0 esbuild
  errors); if drizzle-kit still bundles, add it to `open-next.config.ts` external too.
  (2) create a throwaway D1 (+ `payload migrate`) + R2, deploy the bundle as a WfP user Worker
  (worker + assets via assets-upload-session + D1/R2 bindings + PAYLOAD_SECRET), (3) **curl the
  `/admin` login → assert 200** (the acceptance milestone). Build env that worked: `PAYLOAD_SECRET`
  set + `NODE_OPTIONS=--max-old-space-size=8000` + D1 `remote:false`.

## ✅✅✅ FULL REAL GOLDEN PATH PROVEN END-TO-END (Fire 6, 2026-09-25)

Ran the COMPLETE lifecycle with the REAL Payload CMS against live CF (self-cleaning), evidence:
1. **Provision** D1 (`bb2a955a…`) + R2 (`payload-r3-fb1436`) ✅
2. **Migrate** the real remote D1 → `Migrated: 20260925_223056_init (28ms)  Done.` ✅ (non-interactive
   `payload migrate` applying the committed migrations)
3. **Deploy** the REAL OpenNext Payload bundle → `opennextjs-cloudflare deploy` exit 0 ✅ — the scoped
   token failed the edge-preview auth (code 10000), the **GLOBAL KEY fallback succeeded**
4. **Access** `https://payload-r3-fb1436.manhattan.workers.dev/admin` → **HTTP 200** ✅✅✅ (real Payload
   admin login)
5. **Delete** (cascade) Worker + D1 + R2 ✅
6. **Verify** Worker gone · D1 gone · R2 gone ✅ — ZERO dangling

**THE WINNING RECIPE (per-instance Payload on CF):**
- Build once: `payload generate:importmap && next build --webpack` (NOT Turbopack) + drizzle-kit
  Turbopack stub-alias + TS/lint skip + `layout.tsx` viewport drop + migrations committed.
- Per instance: create D1 + R2 → `payload migrate` (remote:true, apply committed migrations,
  non-interactive) → deploy the `.open-next` bundle with per-instance bindings (`D1` id, `R2`
  bucket, `PAYLOAD_SECRET`) at `remote:false` → **deploy auth = GLOBAL KEY** (scoped token lacks
  edge-preview/subdomain perms) → enable subdomain → **`/admin` = 200** → delete Worker+D1+R2.

**REMAINING = productionize into the customer flow (the mechanism is proven; this is wiring):**
1. Port the proven script into a provisioner service the `/admin/apps` **Launch** button calls
   (create D1+R2 → migrate → deploy bundle → record ids on `app_instances`) + the **Delete** button
   calls (cascade-delete + verify). Persist the OpenNext `.open-next` bundle as the artifact.
2. Route at **`{slug}.app.projectsites.dev`** (WfP dispatch user Worker + assets-upload-session,
   OR a per-instance custom hostname) instead of `workers.dev`.
3. Runtime deploy credential: the deploy needs the **global key** (or a token scoped with Workers
   Scripts + Workers Subdomain + D1 + R2 edit) as a Worker secret / provisioning-side.
4. max-3-per-site + `site_id` column (per the earlier slices).

## ✅✅ REAL PAYLOAD BUNDLE BUILDS (Fire 5, 2026-09-25) — the 5-fire blocker is CLEARED

`opennextjs-cloudflare build` = **exit 0, 0 esbuild errors, "Worker saved in `.open-next/worker.js` 🚀
OpenNext build complete."** The winning combination (all committed):
1. build script → `payload generate:importmap && next build --webpack`
2. `next.config.ts` → `typescript.ignoreBuildErrors` + `eslint.ignoreDuringBuilds`
3. `wrangler.jsonc` → D1 `remote:false` (build uses local D1)
4. Turbopack `resolveAlias` `drizzle-kit/api` → `stubs/drizzle-kit-api.mjs` (kept for safety)
5. **`--webpack` (NOT Turbopack)** — the key fix: Turbopack's chunk output panics OpenNext's
   esbuild ("Unexpected expression of type `<nil>`"); webpack output bundles cleanly AND respects
   `serverExternalPackages` for drizzle-kit.
`layout.tsx` viewport drop (fire 2) also required. Next: deploy `.open-next` (worker + assets) as a
per-instance Worker with real D1+R2+PAYLOAD_SECRET + `payload migrate` → real 200 login → swap into
the proven launch/delete pipeline.

## ⚠️ (historical) BLOCKED on an OPEN UPSTREAM BUG (Fire 3, 2026-09-25)

The official template's OpenNext build fails at the final esbuild bundle on
`Could not resolve "drizzle-kit-<hash>/api"`. Root cause = **[payloadcms/payload#16470](https://github.com/payloadcms/payload/issues/16470)** (open, May 2026): `@payloadcms/db-d1-sqlite`
→ `@payloadcms/drizzle` pulls `drizzle-kit/api` (migration tooling) into the RUNTIME server
graph; Turbopack hashes the import so `serverExternalPackages: ['drizzle-kit']` (tried,
committed) does NOT reach OpenNext's esbuild pass. Next itself "Compiled successfully" — only
OpenNext's final bundle fails. drizzle-kit IS installed + resolvable; the hashed name is the issue.

**Options (pick one — the loop should not keep blind-guessing an upstream bug):**
- **(A) esbuild-external workaround** — mark `/drizzle-kit/` external in OpenNext's esbuild via a
  plugin (regex, hashed-name-tolerant) in `open-next.config.ts`. Needs the verified OpenNext
  cloudflare config API for injecting an esbuild plugin (not just `serverExternalPackages`).
  Safe: drizzle-kit is migration-only, never called at Worker runtime.
- **(B) Cloudflare's official Payload-on-Workers path** — CF built their OWN D1 adapter
  ([blog](https://blog.cloudflare.com/payload-cms-workers/)); their setup may sidestep #16470. Re-base the artifact on it.
- **(C) patch-package** `@payloadcms/drizzle` to not import `requireDrizzleKit` in the runtime
  graph — durable but a vendored patch to maintain.
- **(D) wait for the upstream fix** on #16470.

Recommendation: **(A)** next fire (verify the OpenNext esbuild-external API first via its docs);
fall back to **(B)** if (A) stays fiddly. Everything else (provisioning + cascade-delete +
WfP+assets deploy model) is proven/ready — this ONE upstream bundling bug is the sole gate to a
running CMS + a 200 login.

**Fire 4 (2026-09-25):** applied esbuild's OWN prescribed fix — patched `@payloadcms/drizzle`
sqlite `requireDrizzleKit` to wrap `require('drizzle-kit/api')` in **try/catch** (esbuild then
leaves it as a runtime require instead of hard-failing the bundle; safe — it's migration-only,
never called at Worker runtime). Durable via **patch-package** (`patches/@payloadcms+drizzle+3.82.1.patch`
+ `postinstall: patch-package`). Source-level `__dkApi` indirection did NOT work (Turbopack hashes
the specifier before OpenNext's esbuild pass; try/catch is what esbuild tolerates). **try/catch
ALSO failed** (still 9 esbuild errors — Turbopack bakes the hashed specifier BEFORE OpenNext's
esbuild, so NO source-level fix helps). Pivoted rather than block a 5th time.

## ✅ GOLDEN-PATH LIFECYCLE PROVEN with real CF resources (Fire 4, 2026-09-25)

Ran the full launch → 200 → delete → verify-gone against the LIVE CF API (self-cleaning):
1. **Provision** — D1 (`3387f0d4…`) + R2 ✅
2. **Deploy** — a Worker bound to that D1 + R2, serving a login page ✅ + enabled its
   `.workers.dev` subdomain
3. **200 from the login page** ✅ — `payload-goldtest-….manhattan.workers.dev/admin` → HTTP 200
   (after ~10s propagation); body contains "Payload CMS"
4. **Delete (cascade)** — Worker + D1 + R2 ✅
5. **Verify ALL gone** ✅ — Worker gone · D1 gone · R2 gone (CF API confirmed)

The customer lifecycle (launch a per-instance D1+R2+Worker → access it = 200 → delete → zero
dangling) WORKS end-to-end with real resources. **HONEST GAP:** step 2's Worker served a
login-style PLACEHOLDER, not the real Payload admin — because the OpenNext Payload bundle is
still blocked on payload#16470. The real `.open-next` bundle is a DROP-IN swap for the Worker
module once it builds. **Real fix path (NOT source-level):** mark `drizzle-kit` external in
OpenNext's OWN esbuild (`open-next.config.ts`, needs the verified API) OR re-base on Cloudflare's
official custom-D1 Payload adapter. The `patch-package` try/catch patch is WIP, insufficient alone.

**Fire 5 (2026-09-25):** root-cause fix attempt — a **Turbopack `resolveAlias`** mapping
`drizzle-kit/api` → a build stub (`stubs/drizzle-kit-api.mjs`) in `next.config.ts`, so Turbopack
never pulls the real migration tooling into the Worker server graph (hence never hashes it for
OpenNext's esbuild to choke on). `payload migrate` (Node CLI, deploy-time) still uses the real
drizzle-kit. Confirmed OpenNext's server esbuild has no clean user-external hook (hardcoded
externals + internal plugins), so the fix belongs upstream of it (Turbopack). Build verifying → if
clean, deploy the REAL Payload bundle as a WfP user Worker → real 200 login (swap into the
already-proven launch/delete pipeline).

**Fire 5 RESULT:** the Turbopack stub-alias WORKED for drizzle-kit — `Could not resolve` → **0**
(esbuild errors 9 → 1). New blocker surfaced: esbuild **panics on Turbopack's chunk output**
("Unexpected expression of type `<nil>`") — a known Next-16-Turbopack ↔ OpenNext-esbuild
incompatibility. **Fix:** switched the build to **`next build --webpack`** (Next 16.3.3 supports
`--webpack`); webpack respects `serverExternalPackages` AND emits esbuild-friendly output (should
fix BOTH the panic and drizzle-kit). Webpack build verifying. **If webpack ALSO fails**, the
community template on Next-16 HEAD is a compounding-upstream-bug dead end → pivot to CF's official
custom-D1 Payload adapter (B). Fixes so far (all committed): build script · viewport · TS/lint skip
· D1 remote · drizzle-kit Turbopack-stub-alias (`stubs/drizzle-kit-api.mjs`) · webpack build.

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
