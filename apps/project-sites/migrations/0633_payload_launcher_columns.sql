-- 0633_payload_launcher_columns.sql
--
-- CF-native app launcher (Payload CMS on D1 + R2 + Worker).
--
-- The original `app_instances` table (0029) models CONTAINER apps whose aux infra
-- is Neon Postgres + Upstash Redis + an R2 bucket. Payload CMS is instead launched
-- as a per-instance Cloudflare stack — its own D1 database + R2 bucket + Worker
-- script — with NO container. These columns persist the three CF resource handles
-- so the DELETE flow can cascade-delete them (no dangling D1 / R2 / Worker) and so
-- the admin can enforce a per-site cap.
--
--   d1_database_id     — the per-instance D1 database UUID (teardown target)
--   worker_script_name — the per-instance Worker script name (teardown + routing)
--   site_id            — optional owning site; drives the "max 3 per site" cap
--
-- All nullable + additive (blast-radius-minimization): container instances leave
-- them NULL; CF-native instances leave neon/upstash NULL instead. One row shape,
-- two provisioning paths.

ALTER TABLE app_instances ADD COLUMN d1_database_id TEXT;
ALTER TABLE app_instances ADD COLUMN worker_script_name TEXT;
ALTER TABLE app_instances ADD COLUMN site_id TEXT;

CREATE INDEX IF NOT EXISTS idx_app_instances_site
  ON app_instances(site_id) WHERE deleted_at IS NULL;
