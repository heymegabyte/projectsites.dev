-- Migration 0518: SEO/GEO Autopilot meta drafts
--
-- Supports feature #23: SEO/GEO Autopilot.
-- For an EXISTING generated site, AI generates SEO meta (title 50-60,
-- description 120-156) + a 40-60 word AI-search quotable answer block +
-- schema.org JSON-LD per route. Drafts land 'pending' for owner approval —
-- never auto-published. Approval flips status; applyToSite() is the documented
-- integration point with site_serving (D1-only here, no fake deploy).

CREATE TABLE IF NOT EXISTS seo_meta_drafts (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  org_id        TEXT,                         -- nullable: org scope at draft time
  route         TEXT NOT NULL,                -- e.g. "/", "/about", "/services/health-clinic"
  title         TEXT,                         -- SEO <title> (50-60 chars, clamped in code)
  description   TEXT,                         -- <meta description> (120-156 chars, clamped in code)
  answer_block  TEXT,                         -- 40-60 word GEO quotable block
  jsonld_json   TEXT,                         -- serialized schema.org JSON-LD object
  status        TEXT DEFAULT 'pending'        -- pending → approved | rejected → applied
                  CHECK (status IN ('pending','approved','rejected','applied')),
  ai_model      TEXT,                         -- model used for the draft
  ai_tokens     INTEGER,                      -- tokens consumed (when reported)
  approved_by   TEXT,                         -- user_id of approver
  approved_at   TEXT,                         -- ISO-8601 approval time
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_seo_meta_drafts_site_route
  ON seo_meta_drafts(site_id, route)
  WHERE deleted_at IS NULL;

-- Feature flag seed (enabled=0, rollout=0, stage='experimental')
-- fire-61 reconcile (2026-10-01): INSERT rewritten to the PROD feature_flags
-- shape (id, org_id, flag_name, enabled, metadata_json). The legacy column set
-- this file originally targeted never existed in production.
INSERT OR IGNORE INTO feature_flags (id, org_id, flag_name, enabled, metadata_json)
VALUES ('flag_seo_autopilot', NULL, 'seo_autopilot', 0,
  '{"stage":"experimental","rollout_percent":0,"description":"AI generates SEO/GEO meta (title, description, quotable answer block) + schema.org JSON-LD per route for existing sites. Owner approves drafts in /admin/seo before they apply.","owner_email":"brian@megabyte.space"}');
