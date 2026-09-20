-- 0637: Site Operations — indexes powering the platform-wide users list.
-- The super-admin console (/api/super-admin/ops/users, docs/SITE-OPERATIONS.md) searches +
-- sorts every user account by created_at / email. Additive + idempotent — safe to re-run.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
