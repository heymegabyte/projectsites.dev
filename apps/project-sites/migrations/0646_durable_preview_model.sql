-- Durable Preview model (editor Promote → Production release workflow, Slice 3 — state only).
--
-- The editor is a main-only Preview / Promote / Production release model: save/generate mutates a
-- per-site PREVIEW working tree (never a commit, never Production); Production changes ONLY through an
-- authorized Promote that deploys the FROZEN Preview revision. Two additive records back that model.
--
-- 1. site_working_tree — the per-site MUTABLE working-tree record. ONE row per site (UNIQUE site_id).
--    Records the main base SHA the draft is built on, a MONOTONIC draft_revision bumped on every save,
--    a tree_digest (digest of the current Preview working tree's file+content hashes), the last
--    preview deploy revision, and the last error. This is what an owner's save/generate upserts —
--    and nothing else. It is Preview state, never Production.
--
-- 2. site_releases — the APPEND-ONLY IMMUTABLE release log. One row per (future) Promote: the frozen
--    snapshot id (site_snapshots.id), the commit SHA, the artifact_digest (recorded so promoted bytes
--    can be proved equal to the frozen Preview revision), the CF deployment_id, the acting user, the
--    draft_revision that was frozen, an outcome, and the timestamp. Rows are never mutated — the log
--    is the durable Production history.
--
-- Additive + reversible: CREATE TABLE IF NOT EXISTS + indexes only; touches no existing table or data;
-- migrating existing sites requires NO redeploy (a site simply has no working-tree/release rows until
-- it is next saved/promoted). Feature-flagged (`durable_preview`, DARK by default) → the routes 404
-- and nothing writes until the flag is enabled.

CREATE TABLE IF NOT EXISTS site_working_tree (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE REFERENCES sites(id),
  org_id TEXT NOT NULL,
  -- The main commit SHA the current Preview draft is based on (editor always presents `main`).
  base_main_sha TEXT,
  -- Monotonic draft counter — bumped by 1 on every save/generate. Never decreases.
  draft_revision INTEGER NOT NULL DEFAULT 0,
  -- Digest of the current Preview working tree (a hash over the file paths + per-file content hashes).
  tree_digest TEXT,
  -- The last Preview deploy revision (Preview only — distinct from any Production deployment).
  preview_deploy_revision TEXT,
  -- Last error observed on save/preview-deploy for this working tree (honest failure surface).
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_working_tree_org ON site_working_tree (org_id);

CREATE TABLE IF NOT EXISTS site_releases (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  org_id TEXT NOT NULL,
  -- Frozen Preview snapshot promoted to Production (site_snapshots.id).
  snapshot_id TEXT,
  -- The commit SHA recorded on the internal/external main at Promote time.
  commit_sha TEXT,
  -- Digest of the artifact actually deployed — compared against the frozen Preview revision so we can
  -- prove promoted bytes == the frozen Preview revision.
  artifact_digest TEXT,
  -- The actual Cloudflare deployment id recorded after a successful deploy (NULL if deploy failed).
  deployment_id TEXT,
  -- The user who authorized the Promote.
  actor TEXT,
  -- The working-tree draft_revision that was frozen for this release.
  draft_revision INTEGER,
  -- Outcome: success | commit_ok_deploy_failed | failed  (honest "commit ok / deploy failed" retry).
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'commit_ok_deploy_failed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_site_releases_site ON site_releases (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_releases_org ON site_releases (org_id);
