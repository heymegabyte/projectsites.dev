-- 0642_editor_grid_views_type.sql
-- Saved-view TYPE + config (slice #18): a saved grid view can now be a `grid` (default) or `gallery`
-- render, with a nullable config_json holding view-type-specific display config (gallery:
-- {"titleField":"<col>"}). This turns the Editor's gallery from an ephemeral display toggle into a
-- real, persisted per-view type (apply restores the render + card-title field).
--
-- Additive + nullable-with-default (two-way door): existing editor_grid_views rows become type='grid',
-- config NULL. The worker re-whitelists `type` + shape-hardens config_json on EVERY read/write (never
-- throws on a corrupt value); the editor re-validates titleField against the live columns at render, so
-- a stale field just falls back to the default. Isolated to the PLATFORM metadata store — never a
-- customer table. Mirrors the 0641 editor_grid_views additive pattern.
ALTER TABLE editor_grid_views ADD COLUMN type TEXT NOT NULL DEFAULT 'grid';
ALTER TABLE editor_grid_views ADD COLUMN config_json TEXT;
