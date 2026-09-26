-- 0641_editor_grid_views.sql
-- Editor Data-tab SAVED GRID VIEWS — the first slice of the isolated ProjectSites.dev
-- metadata store. A saved view captures the grid's whole-table query (search + AND/OR
-- filter group + single-column sort) under a name so an owner can re-apply it in one click.
--
-- CRITICAL (per data-platform-scope architecture): saved-view metadata lives HERE, in the
-- PLATFORM database — NEVER in the customer's own tables. Every row is scoped by both
-- site_id AND org_id; the endpoints re-check ownership via ownsSiteData (404 on foreign).
-- filters_json stores the validated {col,op,val}[] group (shape-hardened by
-- parseFilterConditions on save); combinator is AND|OR; sort_col/sort_dir are the grid's
-- single-column sort (dir asc|desc); search is the OR-of-LIKE needle. Additive + isolated
-- (two-way door — dropping the table removes only saved views, never customer data).
CREATE TABLE IF NOT EXISTS editor_grid_views (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  table_key    TEXT NOT NULL,
  name         TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '[]',
  combinator   TEXT NOT NULL DEFAULT 'AND',
  sort_col     TEXT,
  sort_dir     TEXT,
  search       TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary access path: list a site's saved views for one table (name-ordered).
CREATE INDEX IF NOT EXISTS idx_editor_grid_views_site_table
  ON editor_grid_views (site_id, table_key, name);
