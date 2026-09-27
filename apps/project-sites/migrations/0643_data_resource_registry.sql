-- 0643_data_resource_registry.sql
--
-- Authoritative Resource Registry (Data & Resource Platform, section 1).
-- SSOT for every Cloudflare resource a customer's site touches. The browser + MCP caller
-- supply only { site_id, environment }; the trusted service resolves the real CF id from a
-- row here and NEVER accepts an id from the client (docs/data-resource-platform/DESIGN.md §3.2).
--
-- Table A (site_database_allocations) already holds the per-site "one dedicated allocation of
-- each account_resource kind" (D1/KV/R2). This migration adds:
--   1. drift/sync/usage columns to Table A (additive, all NULLABLE — never breaks the live
--      resolveSiteDataDb hot path, whose upserts key on site_id).
--   2. Table B (site_resource_registry) — the general registry for per-environment rows,
--      bindings, DO/workflow/vectorize/queue associations, and imported/external resources.
--
-- Isolation invariant: org_id is the authz key; a row is resolved ONLY for the owning site+env
-- (resolveResourceRef re-derives org from the authed context, never the client). The shared
-- platform D1 ids stay OFF this table structurally (they are never a customer allocation) and are
-- denylisted at resolve time (FORBIDDEN_DB_IDS in src/services/site_data_db.ts).

-- ── Table A extension — additive drift/sync/usage columns on the per-site allocation ──
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; these are new columns on an existing table. If a
-- column already exists the statement errors — run once (each ALTER is its own statement so a
-- partial re-run is diagnosable).
ALTER TABLE site_database_allocations ADD COLUMN d1_last_sync_at    TEXT;    -- ISO; last CF head/list reconcile of the dedicated D1
ALTER TABLE site_database_allocations ADD COLUMN kv_last_sync_at    TEXT;    -- ISO; last reconcile of the dedicated KV namespace
ALTER TABLE site_database_allocations ADD COLUMN r2_last_sync_at    TEXT;    -- ISO; last reconcile of the dedicated R2 bucket
ALTER TABLE site_database_allocations ADD COLUMN drift_json         TEXT;    -- JSON: per-kind [{ code, detail, detected_at }]
ALTER TABLE site_database_allocations ADD COLUMN deletion_protected INTEGER NOT NULL DEFAULT 1; -- 1 = block destroy without explicit confirm

-- ── Table B — the general resource registry ──
-- One row per (site_id, environment, resource_kind, resource_concept, binding_name,
-- vectorize_namespace). Enumerated by the discovery/overview surface; non-allocation kinds
-- (bindings, DO/workflow/vectorize/queue, preview allocations, external connections) live here.
CREATE TABLE IF NOT EXISTS site_resource_registry (
  id                     TEXT PRIMARY KEY NOT NULL,            -- UUIDv7 (time-ordered; uuid-version-discipline)
  org_id                 TEXT NOT NULL,                        -- owner org — the authz key (fast scoping alongside site)
  site_id                TEXT NOT NULL,                        -- owner site (FK -> sites.id); the resolution key
  owner_user_id          TEXT,                                 -- user who first provisioned (audit only; authz is org_id)

  environment            TEXT NOT NULL DEFAULT 'production',   -- 'preview' | 'production' (isolation axis)
  resource_concept       TEXT NOT NULL,                        -- ResourceConcept enum (§2)
  resource_kind          TEXT NOT NULL,                        -- ResourceKind enum (§2)
  tenancy                TEXT NOT NULL DEFAULT 'dedicated',    -- ResourceTenancy enum (§2)

  cf_account_id          TEXT NOT NULL,                        -- always env.CF_ACCOUNT_ID at record time (never client)
  wfp_dispatch_namespace TEXT,                                 -- WFP namespace for wfp/binding rows; else NULL
  user_worker_script     TEXT,                                 -- site-<id>[-preview] the binding attaches to; else NULL

  resource_id_or_name    TEXT,                                 -- the CF id (d1 uuid, kv id, vectorize index) OR name (r2 bucket, dataset, queue)
  resource_display_name  TEXT,                                 -- human label (ps-site-<id>, projectsites-rag, ...)
  binding_name           TEXT,                                 -- in-worker binding symbol (__PS_KV, DATA, RAG_INDEX) for concept='binding'; else NULL
  vectorize_namespace    TEXT,                                 -- metadata partition for concept='vectorize_namespace'; else NULL

  lifecycle_state        TEXT NOT NULL DEFAULT 'requested',    -- requested|provisioning|active|degraded|retiring|retired|error
  provisioning_method    TEXT NOT NULL DEFAULT 'lazy',         -- lazy|eager|imported|binding_only|external
  access_policy          TEXT NOT NULL DEFAULT 'site_scoped',  -- site_scoped|read_only|superadmin_only|no_direct

  deletion_protected     INTEGER NOT NULL DEFAULT 1,           -- 1 = block destroy without explicit confirm + superadmin

  deploy_id              TEXT,                                 -- site_snapshots.id / build version this binding shipped with
  deployed_version       TEXT,                                 -- sites.current_build_version | functions_deployed_at marker

  last_sync_at           TEXT,                                 -- ISO; last successful CF head/list reconcile of THIS row
  drift_code             TEXT,                                 -- NULL when clean; else a typed drift code (§6)
  drift_detail           TEXT,                                 -- JSON detail for the drift
  last_error_code        TEXT,                                 -- last provisioning/mutate failure (typed)
  last_error_detail      TEXT,
  usage_json             TEXT,                                 -- JSON cache of last usage snapshot [{ metric, value, as_of }]

  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT,                                 -- soft delete

  UNIQUE (site_id, environment, resource_kind, resource_concept, binding_name, vectorize_namespace)
);

CREATE INDEX IF NOT EXISTS idx_srr_site ON site_resource_registry (site_id, environment);
CREATE INDEX IF NOT EXISTS idx_srr_org  ON site_resource_registry (org_id);
CREATE INDEX IF NOT EXISTS idx_srr_kind ON site_resource_registry (resource_kind, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_srr_cfid ON site_resource_registry (resource_id_or_name);
