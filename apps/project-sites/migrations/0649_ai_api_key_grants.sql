-- AI API key grants — durable GrantRecord storage attached to `api_tokens` (campaign lane-3, §5).
--
-- The storage layer the Settings "AI API Keys" UI and the /v1 executor consume: one row per psk_
-- token holding the mint-time SNAPSHOT of CONCRETE ids (sites / connections / actions / models),
-- limits, approval policy and expiry as Zod-validated `grant_json` (the shared ai-policy
-- `GrantRecordSchema` from @project-sites/shared — the SAME shape `effectiveAllow` authorizes with).
-- Wildcards are never grantable; a token WITHOUT a row here has NO AI allowance (fail closed), so
-- existing tokens keep working without silently gaining AI/publish/integration access.
--
-- `revision` mirrors the monotonic edit counter INSIDE grant_json (bumped by the service on every
-- narrow/edit) — the authoritative revision `effectiveAllow`'s live_state leg compares against, so a
-- stale snapshot can never authorize (immediate-revocation guarantee; KV caches are never authority).
-- `token_id` is UNIQUE (one grant per token) and REFERENCES api_tokens(id): a grant can only attach
-- to a real token, and the grant's lifecycle follows the token (revoke token → revoke grant).
--
-- Additive + reversible: creates a new table + indexes; touches no existing data. Feature-flagged
-- (`ai_api_keys`, DARK by default) → the grant-accepting request surface 404s/rejects and nothing
-- writes here until the flag is enabled.

CREATE TABLE IF NOT EXISTS ai_api_key_grants (
  id         TEXT NOT NULL PRIMARY KEY,               -- UUIDv7 (time-ordered) grant id — stable across edits
  token_id   TEXT NOT NULL UNIQUE
             REFERENCES api_tokens (id),              -- the OWNING psk_ token (one grant per token)
  org_id     TEXT NOT NULL,                           -- org the grant is bound to (leg-2 org binding)
  grant_json TEXT NOT NULL,                           -- Zod-validated GrantRecord snapshot (concrete ids only)
  revision   INTEGER NOT NULL DEFAULT 1,              -- mirrors grant_json.revision (authoritative revision)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- The list surface: an org's grants (Settings "AI API Keys" list + summary counts).
CREATE INDEX IF NOT EXISTS idx_ai_api_key_grants_org ON ai_api_key_grants (org_id, deleted_at);
