-- 0643_app_instance_domains.sql
--
-- Custom domains attached to an app instance (multi-domain + primary selection).
--
-- An instance always has its platform host (`{subdomain}.cms|app.projectsites.dev`); this
-- table holds ADDITIONAL owner-supplied custom domains (CNAME'd to projectsites.dev, TLS via
-- CF custom hostname). `is_primary` marks the one the admin surfaces as the instance's URL.
-- `cf_hostname_id` is the CF custom-hostname resource id (teardown target for DELETE).
--
-- Additive (blast-radius-minimization): no change to `app_instances`.

CREATE TABLE IF NOT EXISTS app_instance_domains (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  domain         TEXT NOT NULL,
  cf_hostname_id TEXT,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  ssl_status     TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- One row per domain globally (a domain can only point at one instance).
CREATE UNIQUE INDEX IF NOT EXISTS idx_aid_domain ON app_instance_domains(domain);
CREATE INDEX IF NOT EXISTS idx_aid_instance ON app_instance_domains(instance_id);
