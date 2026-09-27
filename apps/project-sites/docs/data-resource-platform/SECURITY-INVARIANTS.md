# Security Invariants — Non-Negotiable Rules

> Section 1 companion to `DESIGN.md`. These are BUILD-BREAKING invariants for the site-scoped
> resource platform (Data tab + MCP, one shared server model). Every route, adapter method, and MCP
> tool MUST satisfy all of them. A violation is a merge blocker (`drift-detection`). Grounded in the
> live guards recon found: `middleware/auth.ts`, `site_ownership.ts` (`assertSiteOwned`),
> `site_data_api/handlers.ts` (`ownsSiteData`), `sysadmin.ts` (`isSuperAdmin`),
> `feature_flags/services.ts` (`isFlagOn`), `site_data_db.ts` (`resolveSiteDataDb` + `FORBIDDEN_DB_IDS`).

---

## INV-1 — No client-supplied Cloudflare identifiers, EVER

- The caller (browser via editor bridge, or MCP) supplies ONLY `{ site_id, environment }` plus
  non-identifier operands (a table name, KV key, R2 object key, vectorize query text). It NEVER
  supplies a CF account id, database id, KV namespace id, R2 bucket name, dispatch namespace, worker
  script name, or binding.
- Every CF id is **server-resolved from the registry** for the authed site+environment (`DESIGN.md`
  §4). A request that carries a CF id in body/header/query is rejected — the id is ignored and the
  resolver's value is used; if a handler even READS a client id it is drift.
- `cf_account_id` is ALWAYS `env.CF_ACCOUNT_ID` at record + resolve time — never accepted, never
  echoed as an input. (Matches `d1_provisioner.ts` / `site_data_db.ts` today.)

## INV-2 — Server-resolve from registry + authed context (the canonical route order)

Every site-scoped resource route/tool runs this order (copied verbatim from the per-site-D1 keystone
`site_db_handlers.ts` — the proven pattern):

1. `orgId = c.get('orgId')` (from `middleware/auth.ts`) — `if (!orgId) → 401`. NEVER from body.
2. `if (!(await isFlagOn(env, flagForKind, {orgId, siteId}))) → 404` (dark; **never 403**).
3. `if (!(await assertSiteOwned/ownsSiteData(env, orgId, siteId))) → 404` (IDOR; **never 403**).
4. Validate operands (`isSafeIdent(table/key)` / per-kind Zod) → `400` on failure.
5. **Only then** resolve the CF id from the registry + `resolveCfCredentials` + `env.CF_ACCOUNT_ID`,
   and execute through the kind's adapter bound to that one id.

- Ownership = `sites.org_id === c.get('orgId')`, row not soft-deleted. `orgId` comes ONLY from the
  authed context. For MCP, the equivalent is the platform dispatch's `WHERE id=? AND org_id=?`
  re-scope on `token.org_id` (`libs/features/platform_mcp/service.ts`).

## INV-3 — 404, never 403 (existence-leak protocol) on the customer surface

- A foreign/unknown site, a flag-off feature, or a missing resource returns **404 "not found"** on
  the customer-facing surface (Data tab + per-site MCP) — never 403, never a distinct "exists but
  forbidden" signal. A prober must not be able to distinguish "doesn't exist" from "not yours".
- Exception: the **super-admin platform surface** uses **403** (`requireSuperAdmin` →
  `forbidden(...)`) because existence-leak doesn't apply to a platform operator (per `sysadmin.ts` /
  `super_admin.ts`). Customer resource routes NEVER take this path.

## INV-4 — preview ≠ production isolation is STRUCTURAL

- `environment` selects a DIFFERENT registry row → a DIFFERENT CF id. A `preview` request resolves the
  preview allocation (`site-<id>-preview` worker, preview D1/KV/R2 rows); a `production` request
  resolves the production one. A preview op can never touch a production id **because it never
  resolves one** — not because a flag says so.
- Matches the live WfP fact: `siteFunctionsScriptName(siteId, {preview})` uploads to a separate
  `-preview` script that never touches `sites.functions_deployed_at` or the live bundle. "Preview
  must never write production data" is enforced by resolution, not by trust.
- A mutation adapter MUST refuse to run against `production` when the resolved scope was minted for
  `preview` (the executor is env-bound at mint time — INV-9).

## INV-5 — The shared backend enforces site-scope in a TRUSTED SERVICE, not a bypassable key-prefix

- For `shared_shim` resources (Functions `__PS_KV` `site:<id>:`, `__PS_R2` `sites-data/<id>/`), the
  site-scoping prefix is applied by the **trusted runtime shim** the platform injects — the customer's
  code calls `env.KV.get(key)` and the shim rewrites to `site:<id>:key`. The site NEVER receives the
  raw namespace/bucket handle and CANNOT construct a cross-tenant key.
- The management interface (Data tab) for shared resources resolves the site's prefix server-side and
  lists/reads ONLY within it — it never exposes the raw shared namespace id to the client, and it
  never lets a client pass an unprefixed/absolute key. A key-prefix that the client could strip or
  override is NOT isolation; the prefix must be non-negotiable and server-applied.
- Denylist defense-in-depth: a resolve that lands on a shared-platform id (`FORBIDDEN_DB_IDS` for D1,
  analogous sets per kind) fails closed (`forbidden_shared_*`), logs, and returns 500 — it NEVER
  confirms the id or serves data from it.

## INV-6 — Never send account tokens to the browser or MCP

- `CfAuth` (global key or `CF_API_TOKEN`), `MCP_ENCRYPTION_KEY`, any stored provider secret, and any
  CF API credential live ONLY in the Worker. They are NEVER included in an API response, an MCP tool
  result, the editor bridge payload, or a log line.
- Adapter results carry data + typed errors + `correlationId` only — never the auth used to fetch it.
- The MCP `tools/call` result envelope is `{content:[{type:'text',text}], isError?}` — it MUST NOT
  contain credentials. A resource-read tool returns the resolved data, not the id resolution or the
  auth. (Secrets stored in `mcp_connections`/`ai_env_vars` are AES-GCM at rest and never decrypted
  back to the client — `encrypted-named-column-may-store-plaintext` notwithstanding, the read path
  hides values.)

## INV-7 — Distinguish Worker Static Assets from R2 data buckets

- A site's PUBLISHED deploy artifacts (HTML/CSS/JS) live in the platform `SITES_BUCKET` under
  `sites/{slug}/{version}/…`, served by `site_serving.ts`. This is the DEPLOY store, not the
  customer's R2 DATA bucket.
- The R2 resource surface manages the site's **data** bucket (dedicated `ps-site-<id>` or the
  `sites-data/<id>/` shim) — it MUST NOT list, read, or delete the deploy-artifact prefix. Conflating
  them would let a customer browse/delete their own live site files. The two are separate registry
  rows with different `access_policy` (deploy artifacts are `no_direct` / not a customer resource).

## INV-8 — A binding attaches to a specific User Worker at deploy

- A `binding` registry row is a RELATIONSHIP created at upload time (`wfp_dispatch.ts`
  `metadata.bindings[]`), scoped to ONE script (`site-<id>` or `-preview`) and ONE environment. There
  is no "namespace-inherited" binding — every binding is explicit on its script.
- The registry RECORDS what was attached; it does not grant access by itself. Drift code
  `binding_mismatch` fires when the recorded binding ≠ the last upload's `metadata.bindings[]`.
- Per-site D1 is `access_policy='no_direct'`: a Worker can't statically bind thousands of D1s, so a
  site's Functions reach its D1 only via the `__PS_SVC` service binding → platform worker → REST
  (metered), never a direct `d1` binding. The management surface reaches per-site D1 via REST
  (`resolveSiteDataDb`), also never a binding.

## INV-9 — Executors are single-resource, env-bound, at mint time

- The resolver returns an executor bound to EXACTLY one CF id/name for EXACTLY one environment (the
  `site_data_db.ts` `SiteDataD1` pattern). There is no method on the executor to redirect it at
  another id or another environment. Cross-resource / cross-env access is structurally impossible, not
  merely checked.
- `mutate` is a discriminated union of NAMED mutations per kind — never a generic `{ sql }` /
  `{ command }` field (`tool-design-as-api`). Destructive mutations (`destroy`, `bulk_delete`) require
  explicit `confirm:true` AND respect `deletion_protected`; they are `approval-required`
  (`autonomous-engineering`) and, for whole-resource destroy, super-admin-gated.

## INV-10 — Every boundary is Zod-validated; every gated feature is flagged

- Every adapter input + output, every route body/param/query, every MCP tool input is Zod-validated
  (`zod-everywhere`); types are `z.infer`, never hand-duplicated.
- The umbrella flag `site_resource_platform` + per-kind flags (`per_site_data` live, `per_site_kv`,
  `per_site_r2` reserved) gate every surface: server returns 404 when off, UI returns null. New flag
  → registry + manifest + docs (the "new flag = 3 places" rule). No resource surface ships
  permanently-on at launch.

## INV-11 — Deletion protection + destructive-op gating

- `deletion_protected=1` by default on every registry row. Destroying a per-site resource (D1/KV/R2
  bucket, or a whole allocation) is `approval-required`, requires `confirm:true`, and is
  super-admin-gated for whole-resource destruction. Row-level deletes (a KV key, an R2 object, a D1
  row) follow the existing allowlist pattern (`data-overview-row-delete-allowlist`).
- No mutation is fire-and-forget without an idempotency key where a retry could double-apply
  (`sync-ui-async-backing`); provisioners are already idempotent (`ON CONFLICT(site_id)`).

## INV-12 — MCP parity obeys the SAME invariants (no weaker path)

- The parity MCP tools are added to the **platform MCP** (the only wired JSON-RPC transport,
  `libs/features/platform_mcp/`). Each tool: takes `{ site_id, environment, … }` only; re-runs the
  owned-site check server-side (`WHERE id=? AND org_id=?` on `token.org_id`); gates on the same flag
  (returns `isError` when off); resolves ids via the SAME resolver; never returns credentials.
- A dedicated `data:read` / `data:write` scope is added to `VALID_SCOPES` (`api_tokens.ts`) so
  resource tools don't silently ride `sites:read`/`sites:write`. Read tools = `data:read`; any
  mutation = `data:write` + the destructive-op gates above.
- The MCP path MUST NOT be a bypass: it cannot reach a resource the Data tab couldn't, cannot skip the
  flag, and cannot supply a CF id. Same server model, same guards, one implementation.

---

## Enforcement

- Unit tests mock `assertSiteOwned`/`ownsSiteData`/`isSuperAdmin`/`isFlagOn` and assert foreign-org →
  404, flag-off → 404, client-supplied-id → ignored, preview → never resolves production id (mirror
  `site_ownership.test.ts` + `super_admin_routes.test.ts`).
- A CI drift check asserts: every `:siteId`/resource route runs the 5-step order; no handler reads a
  CF id from the request; every adapter method takes auth from `resolveCfCredentials`; no credential
  appears in any response/MCP-result serializer (grep gate). New site-id handler needs
  `assertSiteOwned` (existing gate `new-site-id-handler-needs-assertsiteowned-ci-gate`).
