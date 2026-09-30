-- MCP OAuth 2.1 — authorization codes move KV → D1 for ATOMIC single-use consumption
-- (campaign lane-2, fire-57; CAMPAIGN-cf-native-ai.md §6).
--
-- WHY: the KV-backed code store consumed codes via a get+delete pair — two simultaneous
-- exchanges of ONE code could both read the record before either delete landed,
-- double-minting real psk_ tokens from a single-use grant. KV also violates the
-- campaign's revocation-authority rule (D1 is the revocation source of truth).
-- A single conditional UPDATE (`used_at IS NULL AND expires_at > now`) is atomic in
-- D1/SQLite: exactly one concurrent exchange observes meta.changes === 1.
--
-- SECURITY: only the SHA-256 hex of the code is stored (code_hash) — a D1 read
-- never exposes a redeemable plaintext code. presenter_scopes snapshots the
-- PRESENTING principal's effective OAuth scopes at authorize time so the token
-- exchange can re-intersect defensively (minted child token ≤ presenter authority).
--
-- Additive + reversible: a new table only — touches no existing table/column/row.
-- Flag-gated (mcp_server, DARK today) → nothing writes here until the flag is on.
-- Codes are short-lived (600s TTL); expired rows are inert (the consume claim
-- requires expires_at > now) and can be swept opportunistically via the index.

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,             -- SHA-256 hex of the authorization code (plaintext never stored)
  org_id TEXT NOT NULL,                   -- org the grant is bound to
  client_id TEXT NOT NULL,                -- registered OAuth client (KV oauth_client:*)
  scope TEXT NOT NULL,                    -- GRANTED scopes (requested ∩ presenter), space-delimited
  presenter_scopes TEXT NOT NULL,         -- presenter's effective scopes at authorize time, space-delimited
  code_challenge TEXT NOT NULL,           -- PKCE S256 challenge
  redirect_uri TEXT NOT NULL,             -- exact-match redirect target
  created_by_token_id TEXT,               -- psk_ token id that presented the grant (NULL for session grants)
  expires_at INTEGER NOT NULL,            -- epoch seconds; the atomic claim requires expires_at > now
  used_at INTEGER,                        -- epoch seconds; NULL until the single atomic consume flips it
  created_at INTEGER NOT NULL             -- epoch seconds
);

-- Sweep/inspection helpers: expired-row cleanup + org-scoped audit reads.
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_org ON mcp_oauth_codes (org_id, created_at);
