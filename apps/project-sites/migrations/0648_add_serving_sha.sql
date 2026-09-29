-- Durable Preview — proof-of-serving digest on the release log (Promote Slice 6).
--
-- Adds ONE additive, nullable column to the append-only site_releases log: serving_sha. On an honest
-- Promote SUCCESS the service reads the promoted index.html BACK from the new Production prefix and
-- records the lowercase-hex SHA-256 of those exact bytes here — a stronger receipt than artifact_digest
-- (the pre-freeze intent), because it hashes what Production DEMONSTRABLY serves post-promote. On the
-- commit_ok_deploy_failed / failed paths no servable index was proved, so the column stays NULL.
--
-- Additive + reversible: a bare ADD COLUMN (nullable, no default) — touches no existing column or row,
-- and existing release rows simply carry NULL. Feature-flagged (durable_preview, DARK by default) → the
-- Promote route 404s and nothing writes this column until the flag is enabled. Never drops/alters an
-- existing column.

ALTER TABLE site_releases ADD COLUMN serving_sha TEXT;
