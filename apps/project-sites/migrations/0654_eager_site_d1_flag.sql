-- 0654_eager_site_d1_flag.sql
-- Feature-flag seed for EAGER per-site D1 warm-up on site-create (fire-72, A1).
-- The narrow, D1-only sibling of per_site_data: when ON (and per_site_data OFF),
-- site-create (services/site_create.ts) eagerly calls the SAME idempotent
-- provisionSiteD1 the lazy Data-tab path uses, so a site's first Tables read never
-- pays the cold D1 create + query-plane propagation wait. Provisions ONLY the D1
-- (never KV/R2). When both flags are on, per_site_data's broad block wins and this
-- block is skipped → D1 is provisioned exactly ONCE. Fail-soft: a CF hiccup never
-- blocks creation (falls back to lazy provision; provisionSiteD1 is idempotent).
-- Gate: OFF by default (enabled=0, rollout_percent=0, experimental). The registry
-- (src/modules/feature_flags/registry.ts) is the authoritative default; this row is
-- the admin-governance seed so the flag surfaces in /admin/feature-flags with full
-- description + e2e coverage. Idempotent — safe to re-run.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES (
  'flag_eager_site_d1',
  NULL,
  'eager_site_d1',
  0,
  '{"stage":"experimental","rollout_percent":0,"description":"Eager per-site D1 warm-up on site-create (Data Platform, fire-72). The narrow D1-only sibling of per_site_data: when ON (and per_site_data OFF), site-create eagerly calls the SAME idempotent provisionSiteD1 the lazy Data-tab path uses, so a site''s first Tables read never pays the cold D1 create + query-plane propagation wait. Provisions ONLY the per-site D1 (recorded in site_database_allocations), not KV/R2. When both flags are on, per_site_data''s broad block wins and this block is skipped, so D1 is provisioned exactly once per create. Fail-soft: a CF/provisioning hiccup never blocks site creation (it falls back to the existing lazy provision on first Data-tab access; provisionSiteD1 is idempotent so the retry converges on one DB), and it runs under ctx.waitUntil so it never adds create-response latency. Off (default, DARK) means D1 is created lazily on first Data-tab GET exactly as today. Backend-only; no route or UI surface. Risk when off: none (no-op). Targets: every new site via the create-from-search / manual create pipeline. Acceptance: flag on + create a site then site_database_allocations gains a d1_tenant_db row before any Data-tab access; flag off then no allocation until the first /api/sites/:id/db/tables GET.","owner_email":"brian@megabyte.space","e2e_tests":["e2e/per_site_data/eager-site-d1.spec.ts"]}'
);
