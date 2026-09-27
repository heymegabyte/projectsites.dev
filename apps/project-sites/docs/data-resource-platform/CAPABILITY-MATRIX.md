# Capability Matrix — CF API Reality per Resource Kind

> Section 1 companion to `DESIGN.md`. For each resource kind: **what the Cloudflare API actually
> supports** (verified against official CF docs + this deployment's `wrangler.toml`), the
> **dedicated-vs-shared** model for THIS app, what needs an **opt-in authenticated management
> interface**, and the honest **"not available"** cases. This is the source of truth for which UI
> section + MCP tools can exist and what they can honestly claim.

## Legend

- ✅ supported & wired on this deployment · 🟡 backend-ready, surface not built · 🔴 unsupported on
  this deployment (binding absent / commented) · ⛔ impossible via any CF API (hard fact).
- "dedicated" = per-site CF object (own id) · "shared_shim" = shared platform object + site prefix ·
  "shared_platform" = platform-only, never customer-facing.

## The HARD CF FACTS this matrix must never violate (from the directive)

1. **peek ≠ history** — a Durable Object / queue "peek" shows the CURRENT head, not a durable log of
   past messages. There is no "message history" API. Any UI that implies history is lying.
2. **pull = leases + ack** — the Queues *pull* consumer returns leased batches you must `ack`/`retry`;
   it is not a browse. Reading a message leases it; unacked messages redeliver.
3. **no generic DO-state browse** — there is NO Cloudflare API to enumerate Durable Object instances
   or read arbitrary instance storage. State is reachable only by ADDRESSING a known instance from a
   Worker that holds the class binding.
4. **namespace ≠ quota** — the WfP dispatch namespace (and a Vectorize metadata namespace) is a
   CONTAINER/partition, not a quota pool. Putting a script in the dispatch namespace does not raise
   D1/KV/R2 account limits; a Vectorize namespace does not get its own vector quota.

## This deployment's bindings (from `apps/project-sites/wrangler.toml`, `[env.production]`)

D1 `DB`=`project-sites-db-production` (shared platform, denylisted) · KV `CACHE_KV`+`PROMPT_STORE`
(shared) · R2 `SITES_BUCKET`=`project-sites-production` (shared) · AI `AI` · Browser `BROWSER` ·
Vectorize `RAG_INDEX`=`projectsites-rag` · Analytics `ANALYTICS`=`projectsites_admin_v1` (writes
gated off) · Workflows ×6 (`SITE_WORKFLOW`, `DRIVE_SYNC_WORKFLOW`, `IMAGE_GENERATION_WORKFLOW`,
`SNAPSHOT_QUALITY_WORKFLOW`, `SOCIAL_PUBLISH_WORKFLOW`) · DO `SITE_BUILDER`→`SiteBuilderContainer`
(others commented) · WfP `USER_DISPATCH`=`project-sites-endpoints` (`6ea19ae4…`). **NO `QUEUE`
binding · NO Hyperdrive · AutoRAG/Flagship/Collab/Voice/catalog-app DOs all commented.**

Per-site dedicated resources are recorded in `site_database_allocations` (D1 live, KV+R2 columns
ready) — separate from the shared bindings above.

---

## D1 — ✅ per-site dedicated, LIVE (flag `per_site_data`)

- **CF API**: `POST /accounts/{acct}/d1/database` (create) · `GET /accounts/{acct}/d1/database`
  (list) · `GET/DELETE …/database/{id}` (head/destroy) · `POST …/database/{id}/query`
  (single parameterized statement — read OR write). Time Travel PITR (30d) for recovery.
- **Dedicated-vs-shared (this app)**: **dedicated** — each site gets its own `ps-site-<id>` D1
  (`d1_provisioner.ts` → `site_database_allocations.d1_database_id`), resolved server-side by
  `resolveSiteDataDb`. The shared `project-sites-db-production` is `shared_platform`, denylisted
  (`FORBIDDEN_DB_IDS`), never a customer surface.
- **A Worker cannot statically bind thousands of per-site D1s** → reached via CF REST `/query`, not a
  `d1` binding. Access policy for Functions = `no_direct` (via `__PS_SVC` service binding, future).
- **Opt-in management interface**: table list + row browse (LIVE: `/api/sites/:siteId/db/tables`),
  paginated row read, parameterized write (gated), seed, destroy (deletion-protected). The
  REST `/query` API **blocks `PRAGMA`** (SQLite authorizer) — schema introspection uses
  `sqlite_master`, not `PRAGMA table_info` (known-gotcha `d1-rest-query-blocks-pragma`).
- **Not available**: no cross-site query; no `PRAGMA`; single-statement per `/query` call (no
  multi-statement scripts). REST returns parsed rows + `meta` (rows_read/written), no streaming.

## KV — 🟡 per-site dedicated backend-ready + shared_shim in use

- **CF API**: `POST/GET/DELETE /accounts/{acct}/storage/kv/namespaces` (namespace CRUD) ·
  `GET …/{id}/keys` (list, cursor-paginated, 1000/page) · `GET/PUT/DELETE …/{id}/values/{key}` ·
  `PUT …/{id}/bulk` / `DELETE …/{id}/bulk`. Values ≤25 MiB; eventual consistency (~60s global).
- **Dedicated-vs-shared (this app)**: TWO models coexist —
  - **dedicated** (🟡): `kv_provisioner.ts` creates `ps-site-<id>-kv` → allocation
    `kv_namespace_id`. Backend ready; no surface yet (flag `per_site_kv`, reserved).
  - **shared_shim** (✅, Functions): the Functions worker binds the SHARED `__PS_KV`
    (`FUNCTIONS_KV_ID`) and the runtime shim prefixes `site:<id>:` — a site reaches only its own keys.
- **Opt-in management interface**: key list (paginate the cursor honestly — expose `list_complete` +
  `cursor`, never claim a total you didn't count), value get/put/delete, bulk delete, TTL display.
- **Not available**: no server-side full-text search of values; list is by key prefix + cursor only;
  eventual consistency means a just-written key may 404 briefly (surface as "propagating", not error).

## R2 — 🟡 per-site dedicated backend-ready + shared_shim in use

- **CF API**: `POST/GET/DELETE /accounts/{acct}/r2/buckets` (bucket CRUD; **identity IS the name**,
  no uuid) · S3-compatible data plane (`ListObjectsV2`, `GetObject`, `PutObject`, `DeleteObject`,
  presigned URLs). Bucket names ≤63 lowercase chars.
- **Dedicated-vs-shared (this app)**: TWO models —
  - **dedicated** (🟡): `r2_provisioner.ts` creates `ps-site-<id>` bucket → allocation
    `r2_bucket_name`. Backend ready; no surface (flag `per_site_r2`, reserved).
  - **shared_shim** (✅, Functions): the Functions worker binds the shared `__PS_R2`
    (`FUNCTIONS_R2_BUCKET`), shim prefixes `sites-data/<id>/`.
- **⚠️ Worker Static Assets ≠ R2.** A site's PUBLISHED HTML/CSS/JS lives in the platform R2
  `SITES_BUCKET` under `sites/{slug}/{version}/…` served by `site_serving.ts` — that is the deploy
  artifact store, NOT the customer's R2 data bucket. The Data tab's R2 surface manages the site's
  **data** bucket (dedicated/shim), never the deploy artifacts. Conflating them would let a customer
  "browse" and delete their own published site files. (`SECURITY-INVARIANTS.md` §Static-Assets-vs-R2.)
- **Opt-in management interface**: object list (prefix + continuation token), object get (stream /
  presign), put, delete, size/content-type display.
- **Not available**: no server-side search across object bodies; list is prefix + cursor; large
  objects stream (don't buffer).

## Durable Objects — 🔴 SITE_BUILDER only; instance ops opt-in; ⛔ no state browse

- **CF API reality**: DOs are addressed AT RUNTIME by a Worker holding the class binding
  (`env.SITE_BUILDER.get(id)`); alarms + SQLite-backed storage (10 GB) live INSIDE the instance.
  Management (`/accounts/{acct}/workers/durable_objects/namespaces`) lists **namespaces** (classes),
  not instances.
- **⛔ HARD FACT: there is NO API to enumerate DO instances or read arbitrary instance storage.**
  You cannot "browse all Durable Object state". This is impossible via any CF API — not a missing
  feature, a structural one.
- **Dedicated-vs-shared (this app)**: only `SITE_BUILDER` (the container DO for Claude Code builds)
  is bound; every other DO class (Collab/Voice/AppRuntime/55 catalog apps) is commented → `not
  bound`. There is no per-site DO namespace to surface.
- **Opt-in authenticated management interface (the ONLY honest scope)**: per-instance, ADDRESSED
  operations against a KNOWN instance id/name that the platform itself created — e.g. read an
  instance's *explicitly-exposed* status endpoint, reset an instance, list-from-OUR-OWN-index (we
  track instance names we created; CF doesn't). Never a generic browser.
- **Not available / ⛔**: browse all instances (⛔), read arbitrary instance storage (⛔), list
  instances via CF (⛔ — only namespaces). Peek at DO state ≠ history (HARD FACT #1).

## Workflows — ✅ platform-level (6 bound), run-instance ops

- **CF API**: `GET /accounts/{acct}/workflows` (list) · `…/workflows/{name}/instances` (list runs) ·
  `POST …/instances` (create/trigger) · `GET …/instances/{id}` (status + steps) ·
  `PATCH …/instances/{id}` (`pause`/`resume`/`terminate`). Workflows are durable, step-replayable.
- **Dedicated-vs-shared (this app)**: **shared_platform** — the 6 workflows are platform bindings, not
  per-site objects. Run INSTANCES are per-site-triggered (a site-generation run belongs to a site) →
  the registry associates a run instance with `site_id`, but the workflow itself is platform-owned.
- **Opt-in management interface**: list a site's own runs (server-scoped to runs we triggered for that
  site), view one run's status/steps/errors, retry/terminate a run. Read-heavy.
- **Not available**: creating a per-site workflow DEFINITION (definitions are code-deployed, not
  API-created); arbitrary cross-site run listing (scope to the site's own runs).
- **WfP has no native cron** — per-site schedules live in `site_functions_schedules` D1 + the platform
  `scheduled()` dispatcher (memory `wfp-dispatch-scripts-no-native-cron`), surfaced as a schedule
  management interface, not a CF cron API.

## Queues — 🔴 UNSUPPORTED on this deployment (no binding)

- **CF API (would-be)**: `/accounts/{acct}/queues` CRUD; push consumers (Worker-invoked) + **pull
  consumers** (`POST …/queues/{id}/messages/pull` → leased batch, `POST …/messages/ack`).
- **HARD FACTS**: pull = **leases + ack** (HARD FACT #2) — reading leases a message; unacked messages
  redeliver after visibility timeout. A "peek" is the current head, **not history** (HARD FACT #1) —
  Queues has no message-history/log API.
- **Dedicated-vs-shared (this app)**: N/A — **no `QUEUE` binding** (both producer + consumer blocks
  commented, top-level and prod). Code falls back to Workflows.
- **This app's stance**: the Queues UI section renders **`not_supported` / "not enabled on this
  account"** — never a fake empty queue. If ever enabled, the interface exposes: pull a leased batch
  (with explicit ack/retry controls), depth estimate, DLQ view — and MUST label it "current messages
  (leased)", never "message history".
- **Not available**: message history (⛔ HARD FACT #1); browse-without-lease (⛔ pull leases); on this
  deployment, everything (🔴 no binding).

## Vectorize / AI-Search — ✅ index bound; per-site = namespace partition

- **CF API**: `GET/POST /accounts/{acct}/vectorize/v2/indexes` (index CRUD) ·
  `…/indexes/{name}/query` (query, filter by `namespace`) · `…/upsert` · `…/delete-by-ids` ·
  `…/get-by-ids`. Metadata **namespaces** partition one index.
- **HARD FACT #4: namespace ≠ quota** — a Vectorize namespace is a metadata partition inside ONE
  index (`projectsites-rag`), not a separate index and not its own vector quota. Per-site isolation =
  a per-site NAMESPACE filter, not a per-site index.
- **Dedicated-vs-shared (this app)**: **shared index, per-site namespace** — `RAG_INDEX`
  (`projectsites-rag`, 768-dim cosine) is one platform index; a site's vectors are written/queried
  under its own namespace (`services/rag.ts` already partitions by `orgId`/`kind`). AutoRAG /
  `ai_search` is **commented** → `rag.ts` falls back to Vectorize + Llama; the "AI-Search" surface is
  Vectorize-backed, not AutoRAG.
- **Opt-in management interface**: list the site's namespaces (from our metadata index — CF has no
  "list namespaces" call, we track them), query within the site's namespace, upsert/delete-by-ids
  scoped to the site's namespace, index dimension/metric display.
- **Not available**: a per-site dedicated index (we use namespaces); cross-namespace query (scope to
  the site's namespace); AutoRAG features (commented).

## Analytics Engine / Observability — ✅ dataset bound, READ-ONLY

- **CF API**: write via binding `ANALYTICS.writeDataPoint()` (gated off by `ANALYTICS_INGEST_ENABLED`
  = `"false"`); read via the **SQL API** (`POST /accounts/{acct}/analytics_engine/sql`, ~last 3
  months, sampled). Also CF Zone RUM/GraphQL for per-hostname CWV (per memory
  `cf-rum-attributes-per-subdomain-real-data`).
- **Dedicated-vs-shared (this app)**: **shared_platform** dataset `projectsites_admin_v1`; per-site
  metrics are `WHERE`-scoped by a site/host dimension, never a per-site dataset.
- **Opt-in management interface**: read-only — per-site event/metric summaries, CWV per subdomain,
  reconciled against ground truth (per `verify-against-source-of-truth`: cross-check the display
  against D1 `visitor_events`/`form_submissions`, which stay in the MASTER D1, NOT the per-site D1).
- **Not available**: writing arbitrary events from the customer surface; unsampled raw event export;
  history beyond the dataset retention window.

## Connections / MCP (external providers) — ✅ observability of `mcp_connections`

- **What it is**: NOT a Cloudflare resource — the per-site OAuth/paste-key connections to EXTERNAL
  providers (Stripe/HubSpot/GitHub/Slack/Resend-MCP/etc.) recorded in `mcp_connections`
  (`routes/mcp_oauth.ts`), plus the platform's own MCP servers.
- **Dedicated-vs-shared (this app)**: per-site rows in a shared D1 table (`shared_platform` storage,
  site-scoped rows). Secrets are AES-GCM encrypted at rest (`MCP_ENCRYPTION_KEY`), never sent to the
  browser/MCP.
- **Opt-in management interface**: list a site's connections + health/status, revoke a connection
  (revokes the EXTERNAL token), (re)connect flow. Read + revoke only.
- **Not available / ⛔**: reading a stored provider secret back to the client (⛔ — encrypted at rest,
  never returned); managing the provider's own account.

---

## Summary — which UI sections + MCP tools can exist (honest)

| Kind | Section? | Tenancy (this app) | Mutations exposed | Honest "not available" / ⛔ |
|---|---|---|---|---|
| D1 | ✅ live | dedicated | provision/query_write/seed/destroy | no PRAGMA; no cross-site; single-statement |
| KV | 🟡 build it | dedicated + shim | put/delete/bulk_delete/provision | no value search; eventual consistency |
| R2 (data) | 🟡 build it | dedicated + shim | put/delete/provision | no body search; **not the deploy-artifact bucket** |
| Durable Objects | ✅ ops-only | SITE_BUILDER only | reset/send (addressed) | ⛔ browse-all state; ⛔ list instances via CF |
| Workflows | ✅ runs | shared_platform | trigger/terminate/resume | no API-created definitions; scope to site's runs |
| Queues | 🔴 not_supported | none (no binding) | none | 🔴 no binding; ⛔ history; pull=leases |
| Vectorize/AI-Search | ✅ namespace | shared index + namespace | upsert/delete_by_ids (namespace) | ⛔ per-site index; AutoRAG commented; namespace≠quota |
| Analytics/Observability | ✅ read-only | shared dataset | none | no client writes; sampled; retention-bounded |
| Connections/MCP | ✅ read+revoke | shared table, site rows | revoke | ⛔ read secret back; not a CF object |
