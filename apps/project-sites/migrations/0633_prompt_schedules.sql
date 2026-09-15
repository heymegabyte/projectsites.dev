-- 0633_prompt_schedules.sql — Prompt Scheduler (feature: prompt_schedule)
-- Time-windowed activation of a prompt VARIANT for a prompt KEY. At prompt-resolve
-- time the generation pipeline asks getActiveVariant(key, now); a schedule whose
-- [activate_at, deactivate_at) window contains `now` wins (most-recently-activated on
-- overlap). Read-time evaluation — NO cron needed. Lets an owner run a seasonal/campaign
-- prompt ("holiday hero", Dec 1–26) with zero config; AI does the switch automatically.
CREATE TABLE IF NOT EXISTS prompt_schedules (
  id            TEXT PRIMARY KEY NOT NULL,
  org_id        TEXT,                       -- NULL = global (all orgs)
  prompt_key    TEXT NOT NULL,              -- the prompt registry key to schedule
  variant       TEXT NOT NULL,              -- the variant id to activate in the window
  activate_at   TEXT NOT NULL,              -- ISO 8601 — window start (inclusive)
  deactivate_at TEXT,                        -- ISO 8601 — window end (exclusive); NULL = open-ended
  label         TEXT,                        -- human label, e.g. "Holiday hero"
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

-- Hot path is "active schedules for this key right now" → index the lookup keys.
CREATE INDEX IF NOT EXISTS idx_prompt_schedules_key
  ON prompt_schedules (prompt_key, activate_at);
CREATE INDEX IF NOT EXISTS idx_prompt_schedules_org
  ON prompt_schedules (org_id);

-- Feature flag — dark by default (experimental). Server guard 404s until promoted.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_prompt_schedule', NULL, 'prompt_schedule', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"Prompt Scheduler: time-windowed activation of a prompt registry variant for a prompt key. An owner (or admin) schedules a variant to be active between activate_at and deactivate_at; the generation pipeline consults getActiveVariant(key, now) at prompt-resolve time and uses the scheduled variant when a window is live (most-recently-activated wins on overlap). Read-time evaluation, no cron. Enables seasonal/campaign prompts (e.g. a holiday hero prompt Dec 1-26) with zero owner config. Failure mode when off: no schedule rows are read; resolution falls back to the default variant exactly as today.","owner_email":"brian@megabyte.space","e2e_tests":["e2e/prompt_schedule/schedule.spec.ts"]}');
