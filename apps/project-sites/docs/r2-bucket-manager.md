# R2 Bucket Manager — Architecture Map & Slice Plan

> Site-scoped R2 Bucket Manager for the editor Resources tab. Multi-fire feature; this doc is the
> SSOT the fires build against. **Slice 1 (this fire): RECON + failing tests + domain + service
> foundation + system-bucket protection.** Later slices (create/reset/delete/explorer/Code-selector/
> caller-migration/E2E) build on the seams laid here.

Status: **Slice 1 in progress** (2026-09-28). Flag `r2_bucket_manager` — DARK (default-OFF).

---

## RECON — what already exists (inspected, never assumed)

### A prior per-site R2 layer already ships (do NOT duplicate — RECONCILE + EXTEND)

There is a **complete prior `r2_buckets` feature** (dated 2026-09-27) — the R2 analog of the per-site
D1 "Tables" surface. It manages a site's **OWN custom** Cloudflare R2 buckets and is the substrate the
Manager reconciles against. Do not rebuild it; the Manager is a NEW authoritative-catalog layer ON TOP.

| Concern | File | Notes |
|---|---|---|
| Prior handlers (create/list/delete + object CRUD + promote) | `libs/features/r2_buckets/handlers.ts` | Routes `/api/sites/:siteId/r2/buckets…`. Gate order: 401 → flag-dark-404 → `ownsSiteData`-404 → resolve allocation. **KEEP.** |
| Prior Zod I/O | `libs/features/r2_buckets/schemas.ts` | `BucketDisplayNameSchema`, `CreateBucketBodySchema`, etc. **REUSE** for create-name validation. |
| Prior service (CF R2 REST + S3 SigV4 object ops) | `src/services/site_r2.ts` | `provisionSiteR2`/`listSiteR2Allocations`/`resolveSiteR2Allocation`/`deleteSiteR2`/`siteR2BucketName`/`FORBIDDEN_BUCKET_NAMES`/`getS3Config`. **REUSE as the CF-side of reconcile + later mutation slices.** |
| Prior catalog table | `migrations/0645_site_r2_allocations.sql` | `site_r2_allocations` (per-site, tenant-owned custom buckets). Columns: bucket_name, display_name, environment, is_default, public_access, jurisdiction, status. **This is the site's OWN buckets — the Manager unions it with the system bucket.** |
| Prior flag | `src/modules/feature_flags/registry.ts` `r2_buckets` | **enabled=true / rollout=100 / experimental.** NOT dark — so it is NOT the Manager's flag. |
| Prior manifest | `libs/features/r2_buckets/feature.manifest.ts` | slug `r2_buckets`. |
| Prior route tests | `libs/features/r2_buckets/__tests__/r2-buckets.test.ts` | Route-layer gate-order + create/delete. **KEEP.** |
| Prior E2E (dev, PROD_URL) | `e2e/r2-buckets.spec.ts` | Auth + dark-launch contract only (401/JSON). **KEEP.** Not in `COVERAGE.yml`/`FEATURES.md` yet. |

### The system (protected) bucket — the isogit project code · preview

- **The isogit adapter does NOT use a dedicated per-site R2 bucket.** `src/services/git.ts`
  `gitPrefix(slug)` → **`sites/${slug}/git/`** under the SHARED `env.SITES_BUCKET` binding
  (HEAD / commits / trees). Preview `dist/` for branch previews lives under the same shared bucket
  (`site_branches.ts` → `sites/${slug}/branches/${name}/`, `parseBranchHost` → `{branch}--{slug}`).
- Therefore the "**Project code · Preview**" entry the Manager surfaces is a **VIRTUAL system bucket**:
  the shared `SITES_BUCKET` scoped to `sites/{slug}/` for this site. It has **no `site_r2_allocations`
  row** — the Manager synthesizes it as an `is_system: true` catalog entry.
- `FORBIDDEN_BUCKET_NAMES` (`site_r2.ts`) already denylists the shared platform bucket names
  (`project-sites-assets`, `-preview`, legacy `project-sites`). The system entry references the shared
  bucket; **mutating it must HARD-THROW at the service layer** — that guard is what Slice 1 adds.

### Auth / ownership (the canonical server gate)

- `src/services/site_ownership.ts`:
  - `assertSiteOwned(env, orgId, siteId): Promise<boolean>` — true iff `sites.org_id == orgId`; caller
    404s (never 403) on false. **THE canonical gate — `resolveSiteBuckets` calls this.**
  - `requireOwnedSite<T>(env, orgId, siteId, columns): Promise<T>` — throws `notFound` on foreign/missing.
- Prior handlers use `ownsSiteData` (a wrapper in `site_data_api/handlers.ts`); `assertSiteOwned` is the
  underlying primitive. New service uses `assertSiteOwned` directly (spec-named).

### Sibling provisioning pattern (mirror this)

- `src/services/d1_provisioner.ts` — `provisionSiteD1(env, {orgId, siteId, tenantId})` →
  `{ok, databaseId, databaseName, reused} | {ok:false, reason, status?}`; `siteD1Name(siteId)`. Records
  into `site_database_allocations` (tenant_id, site_id, db_plan, region, status, d1_database_id, …) with
  `ON CONFLICT(site_id) DO UPDATE` (idempotent). R2 analog is `site_r2.ts` `provisionSiteR2`.

### Encrypted credential store (reuse — never plaintext)

- `src/services/ai_crypto.ts` — `encrypt(env, plaintext)` / `decrypt` / `decryptOrPassthrough`
  (AES-GCM, 12-byte IV per write, `base64(iv‖ct)`), keyed by `env.MCP_ENCRYPTION_KEY`, zero-downtime
  rotation via `MCP_ENCRYPTION_KEY_OLD`. **Any per-bucket scoped credential the Manager mints (Slice 2
  create+creds) stores its secret via `encrypt`; the catalog holds only a CREDENTIAL REFERENCE, never
  the secret.** S3 object ops today use worker-level `R2_S3_ACCESS_KEY_ID/SECRET` via `getS3Config`.
- `src/services/cf_credentials.ts` — `resolveCfCredentials(env, orgId): Promise<CfAuth|null>`,
  `cfAuthHeaders(auth)`, `CfAuth = {kind:'global',email,apiKey} | {kind:'token',token}`.

---

## THE MANAGER LAYER (this feature) — how it differs & fits

The Manager is the **authoritative, site-scoped catalog + view** over ALL of a site's R2 surfaces:

1. the **system bucket** (isogit project code · preview — shared `SITES_BUCKET`/`sites/{slug}/`), and
2. the site's **own custom buckets** (`site_r2_allocations`, managed by the prior `r2_buckets` layer).

New concepts Slice 1 introduces that did NOT exist:

- **`site_r2_buckets` catalog** — one row per bucket the Manager knows about, incl. the synthesized
  system row (`is_system=1`), CF identity, jurisdiction, site+account ownership, provisioning state, and
  a **credential reference** (id into the encrypted store — never the secret).
- **`resolveSiteBuckets(env, siteId, orgId)`** — authoritative, `assertSiteOwned`-gated, cursor-paginated,
  reconciles CF ↔ catalog, ALWAYS includes the protected system bucket as a distinct entry, NEVER another
  site's buckets.
- **`assertBucketMutable(bucket)`** — HARD-THROWS (`SystemBucketProtectedError`) on any
  config/reset/empty/delete targeting an `is_system` bucket. **Service layer, not UI.**
- **`assertBucketOwnedBySite(bucket, siteId)`** — HARD-THROWS (`BucketOwnershipError`) on a cross-site
  bucket (defense-in-depth beyond the SQL `WHERE site_id=?`).
- **Flag `r2_bucket_manager`** — DARK (enabled=0, rollout=0, experimental). Distinct from the already-on
  `r2_buckets` flag.

### Why a new flag + new table (not reuse `r2_buckets`/`site_r2_allocations`)

- `r2_buckets` is enabled=true/100% — reusing it would light the Manager up immediately (violates
  dark-launch). The Manager gets its own DARK `r2_bucket_manager`.
- `site_r2_allocations` models only the site's OWN custom buckets and has no system-bucket concept nor a
  credential-reference column. `site_r2_buckets` is the Manager's superset catalog; it REFERENCES
  allocations (does not replace them) and adds the system row + `is_system` + credential ref. Additive,
  reversible, non-orphaning (per interconnectedness — the prior layer stays wired; the Manager unions it).

---

## FILE / PATTERN MAP (SEEDS the next fires)

| Concern | File (new = ✚) | Pattern to follow |
|---|---|---|
| Catalog Zod + `is_system`/state enums | ✚ `libs/features/r2_bucket_manager/schemas.ts` | mirror `r2_buckets/schemas.ts` + `zod-everywhere`; `z.infer` only |
| Domain migration (`site_r2_buckets`) | ✚ `migrations/0647_site_r2_buckets_catalog.sql` | additive, mirror `0645_site_r2_allocations.sql` |
| Service (resolve + asserts + reconcile) | ✚ `src/services/site_r2_manager.ts` | mirror `site_data_db.ts` `resolveSiteDataDb` + `site_r2.ts`; import `assertSiteOwned`, `site_r2` fns, `FORBIDDEN_BUCKET_NAMES` |
| Feature manifest | ✚ `libs/features/r2_bucket_manager/feature.manifest.ts` | 7 fields, mirror `r2_buckets/feature.manifest.ts` |
| Flag registry entry | `src/modules/feature_flags/registry.ts` (edit) | add `r2_bucket_manager` DARK, shape = `per_site_data` |
| Handlers (later slices) | ✚ `libs/features/r2_bucket_manager/handlers.ts` | mirror `r2_buckets/handlers.ts` gate order |
| Service unit tests | ✚ `libs/features/r2_bucket_manager/__tests__/site-r2-manager.test.ts` | real-shape mock DB, mirror existing `__tests__` |
| E2E skeleton | ✚ `e2e/r2-buckets/manager.e2e.ts` | prod-target, mirror `e2e/r2-buckets.spec.ts` |
| CF credentials | `src/services/cf_credentials.ts` (reuse) | `resolveCfCredentials`/`cfAuthHeaders` |
| Encrypted creds | `src/services/ai_crypto.ts` (reuse) | `encrypt`/`decrypt` — secret never in catalog/log/localStorage |
| Editor Resources UI | `app/components/workbench/{ResourcesPanel,BucketsPanel,…}.tsx` | later slice — surface system bucket as PROTECTED |
| Code-panel storage selector | `app/components/workbench/ProjectHub.tsx` | later slice |

---

## ORDERED NEXT SLICES (post-Slice-1)

1. **Create + bucket-scoped credentials** — `POST` create via Manager → `provisionSiteR2` + mint a
   bucket-scoped R2 S3 credential, `encrypt` it, store only the ref in `site_r2_buckets`. Failing tests
   first. (Reuses `CreateBucketBodySchema`.)
2. **Reset / rotate** — reset a bucket (empty, non-system only via `assertBucketMutable`) + rotate its
   scoped credential (re-`encrypt`, ref swap). NEVER touches customer objects in Site files/Media.
3. **Delete / empty** — Manager delete (`assertBucketMutable` guards system) → `deleteSiteR2`
   (empty-then-delete); soft-retire the catalog row.
4. **Code-panel storage selector** — `ProjectHub.tsx` picker to bind a bucket to the project code.
5. **Object explorer** — browse/upload/download/delete objects (reuse `listSiteR2Objects` etc.).
6. **Remove Site-files / Media surfaces + migrate callers** — fold the old `site_files`/`media_ai`
   bucket views into the Manager; migrate callers; PRESERVE all data (never delete customer objects).
7. **E2E journeys A–G + guarded real-R2 staging run** — full Playwright journeys; a gated staging run
   against real R2 (create → list shows system+own → reset → delete), asserting the system bucket is
   never mutated and customer data is preserved.

---

## INVARIANTS (every slice)

- Secrets NEVER in localStorage / logs / plaintext columns — `ai_crypto.encrypt`; catalog holds a ref.
- System bucket protected **server-side** (`assertBucketMutable` HARD-THROWS) — not a UI-only guard.
- NEVER delete customer objects — Site files / Media data is preserved across every op.
- Reuse existing patterns: `ai_crypto`, feature-module + flag, audit, `assertSiteOwned`,
  `FORBIDDEN_BUCKET_NAMES`, `site_r2` service.
- Isolation is structural (`WHERE site_id=?`) + defense-in-depth (`assertBucketOwnedBySite` throw +
  `FORBIDDEN_BUCKET_NAMES` denylist).
