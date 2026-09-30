-- 0651: align team_invites with prod — add the deleted_at column that prod
-- carries but 0013 never defined (added out-of-band; discovered fire-58 when a
-- fresh local D1 500'd GET /api/team, whose handler filters `deleted_at IS NULL`).
-- PROD ALREADY HAS THIS COLUMN — do NOT apply remotely (duplicate-column error);
-- this exists so migration-built local/fresh databases match prod schema.
ALTER TABLE team_invites ADD COLUMN deleted_at TEXT;
