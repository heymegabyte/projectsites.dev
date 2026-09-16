-- 0634_site_publish_schedules.sql — Scheduled Site Publishing (feature: scheduled_publish)
-- An owner schedules a BUILT site to go live (status → 'published') at a future datetime — a
-- campaign launch / grand opening / product drop with zero babysitting. The every-minute cron
-- (scheduled() handler, Stage 6.2) reads DUE pending rows (publish_at <= now) and flips each
-- eligible site live, then marks the row 'fired'. A site with NO build (current_build_version
-- IS NULL) is never flipped (would serve a blank page) — the row goes 'skipped'. One PENDING
-- schedule per site (a reschedule supersedes the prior pending). Safe two-way door: the owner
-- can re-archive; NOTHING is deleted.
CREATE TABLE IF NOT EXISTS site_publish_schedules (
  id            TEXT PRIMARY KEY NOT NULL,
  org_id        TEXT NOT NULL,              -- always org-scoped (a site belongs to one org)
  site_id       TEXT NOT NULL,              -- the site to publish
  publish_at    TEXT NOT NULL,              -- ISO 8601 — when to flip the site live
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | fired | canceled | skipped
  label         TEXT,                        -- optional human label ("Grand opening")
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at      TEXT,                        -- set when the cron flips it live (or skips it)
  deleted_at    TEXT
);

-- Hot path is the cron sweep "pending rows due now" → index (status, publish_at); plus per-site + per-org lookups.
CREATE INDEX IF NOT EXISTS idx_site_publish_schedules_due
  ON site_publish_schedules (status, publish_at);
CREATE INDEX IF NOT EXISTS idx_site_publish_schedules_site
  ON site_publish_schedules (site_id);
CREATE INDEX IF NOT EXISTS idx_site_publish_schedules_org
  ON site_publish_schedules (org_id);

-- Feature flag — dark by default (experimental). Server guard 404s until promoted.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_scheduled_publish', NULL, 'scheduled_publish', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Scheduled Site Publishing: an owner schedules a BUILT site to go live (status published) at a future datetime — a campaign launch / grand opening with zero babysitting. POST /api/sites/:id/publish-schedule stores a pending schedule (one per site; reschedule supersedes); the every-minute cron flips DUE sites live and marks the row fired (a site with no build is never flipped → skipped). GET lists, DELETE cancels (IDOR-safe, org-scoped). Failure mode when off: the routes 404 and the cron sweep finds no rows to fire — publishing behavior is unchanged.","owner_email":"brian@megabyte.space","e2e_tests":["e2e/site_publish_schedule/schedule.spec.ts"]}');
