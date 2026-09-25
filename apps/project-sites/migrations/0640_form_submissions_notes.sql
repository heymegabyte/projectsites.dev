-- 0640_form_submissions_notes.sql
-- Owner lead annotation: a free-text `notes` column on form_submissions so a site
-- owner can annotate a lead ("called back 3pm — interested") from the Data browser.
-- Additive + nullable (two-way door — no data loss, reversible by dropping). Edited
-- only through the owner Data-tab typed TEXT editor (EDITABLE_OVERVIEW_COLUMNS), which
-- is tenant-gated + parameterized `WHERE id = ? AND site_id = ?` + bounded ≤2000 chars.
-- Mirrors the 0031 reply_* ALTER pattern.
ALTER TABLE form_submissions ADD COLUMN notes TEXT;
