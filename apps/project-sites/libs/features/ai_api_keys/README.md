# AI API keys — grant records (campaign lane-3)

Durable `GrantRecord` storage attached to `api_tokens` — the first slice of §5
(Settings "AI API Keys") from `.claude/run-the-loop/CAMPAIGN-cf-native-ai.md`.

- **Flag**: `ai_api_keys` (`enabled=0, rollout=0, experimental` — DARK). Grant
  PROCESSING is gated: off → a POST carrying `grant` rejects
  `VALIDATION_ERROR` ("not available") and no token is minted; the plain token
  flow is unchanged byte-for-byte.
- **Table**: `ai_api_key_grants` (migration `0649`) — UUIDv7 `id`, `token_id`
  UNIQUE → `api_tokens.id`, `org_id`, Zod-validated `grant_json`, `revision`
  (mirrors `grant_json.revision`), timestamps + `deleted_at`.
- **Shapes**: the SHARED ai-policy layer (`@project-sites/shared` —
  `GrantRecordSchema`, `effectiveAllow`). `GrantInputSchema` in the service is
  a `.pick()` derivation, never a redefinition. Grants reference CONCRETE ids
  only — wildcards are rejected at the schema boundary.
- **Service**: `src/services/ai_key_grants.ts` — `putGrantForToken` (create
  revision 1 / update bumps revision, org-scoped), `getGrantForToken`
  (parse+validate on read, fail-closed null), `revokeGrant` (sets `revokedAt`
  + revision bump; unparseable rows soft-delete), `listGrantsForOrg`,
  `summarizeGrant` (counts, never the snapshot).
- **Routes**: `src/routes/api_tokens_admin.ts` — POST `grant?` body, GET list
  summaries, DELETE revokes the grant with the token.
- **Safe disabled behavior**: a token WITHOUT a grant row has NO AI allowance —
  existing tokens keep working without silently gaining AI/publish/integration
  access.

Tests: `src/__tests__/ai_key_grants.test.ts` (service round-trip / revision /
revoke / fail-closed reads) + `src/__tests__/api_tokens_grants_route.test.ts`
(flag-off rejection, create-with-grant, list summaries, invalid-grant 400).
