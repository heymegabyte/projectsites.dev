/**
 * @module routes/api_tokens_admin
 * @description Account-level Public API token CRUD for the `/admin/api-tokens` UI.
 *
 * Lists / creates / revokes the caller-org's `psk_` tokens — the SAME tokens the
 * platform MCP (`/api/mcp`) verifies. The admin UI + the `api_tokens` service +
 * the `0515_public_api` migration all existed, but this route (which the SPA
 * calls at `/api/v1-tokens`) was never built → the section 404'd on every load.
 *
 * | Method | Path                | Body / Response                                            |
 * | ------ | ------------------- | ---------------------------------------------------------- |
 * | GET    | /api/v1-tokens      | → `{ data: ApiTokenPublic[] }` (never the hash/plaintext); with the `ai_api_keys` flag ON each item may carry `grant` (a counts-only GrantSummary) |
 * | POST   | /api/v1-tokens      | `{ name, scopes[], expires_at?, grant? }` → `{ token, plaintext, warning, grant? }` (plaintext shown ONCE) |
 * | DELETE | /api/v1-tokens/:id  | revoke (+ revoke the attached AI grant) → `{ ok: true }`   |
 *
 * ## AI API key grants (campaign lane-3, CAMPAIGN-cf-native-ai §5 — flag `ai_api_keys`, DARK)
 * The optional POST `grant` body is a mint-time snapshot of CONCRETE ids
 * (sites/connections/actions/models + limits/approval/expiry) validated by the
 * SHARED ai-policy `GrantInputSchema` and persisted via `ai_key_grants` against
 * the freshly minted token. Grant PROCESSING is gated on the flag: flag OFF →
 * a request carrying `grant` is rejected `VALIDATION_ERROR` ("not available")
 * and NO token is minted; the no-grant flow is unchanged byte-for-byte, so
 * existing tokens never silently gain AI access. List responses expose only
 * count summaries — never the full snapshot, never plaintext anywhere.
 *
 * UNCONDITIONAL (not flag-gated): migration `0614_unflag_and_remove_flags.sql`
 * un-flagged `public_api` ("feature kept, gate dropped … now unconditional") and
 * stripped the `isFlagOn` checks from the sibling routes — but this file was
 * missed, so it kept gating on the now-unresolvable `public_api` flag, which made
 * `isFlagOn` return false and 404 the whole feature. The gate is now removed; the
 * handlers are guarded by auth (orgId) only. Guarded by `api_tokens_admin_route`
 * spec so the dead-flag gate can't be reintroduced.
 *
 * @packageDocumentation
 */
import { Hono } from 'hono';

import type { Env, Variables } from '../types/env.js';

import { isFlagOn } from '../modules/feature_flags/services.js';
import {
  GrantInputSchema,
  type GrantSummary,
  listGrantsForOrg,
  putGrantForToken,
  revokeGrant,
  summarizeGrant,
} from '../services/ai_key_grants.js';
import {
  type ApiScope,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  VALID_SCOPES,
} from '../services/api_tokens.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const apiTokensAdmin = new Hono<AppContext>();

/** GET /api/v1-tokens — list the caller org's tokens (metadata only). */
apiTokensAdmin.get('/api/v1-tokens', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);
  }
  const tokens = await listApiTokens(c.env.DB, orgId);

  // ai_api_keys ON → attach a counts-only grant summary per token (never the
  // full snapshot). OFF (DARK default) → the pre-existing shape, no grant reads.
  const aiKeysOn = await isFlagOn(c.env, 'ai_api_keys', {
    orgId,
    userId: c.get('userId') ?? undefined,
  });
  if (!aiKeysOn) {
    return c.json({ data: tokens });
  }
  const grants = await listGrantsForOrg(c.env.DB, orgId);
  const byToken = new Map(grants.map((g) => [g.tokenId, summarizeGrant(g.grant)]));
  const data = tokens.map((t) => {
    const grant = byToken.get(t.id);
    return grant ? { ...t, grant } : t;
  });
  return c.json({ data });
});

/** POST /api/v1-tokens — mint a token. Plaintext is returned ONCE, never stored. */
apiTokensAdmin.post('/api/v1-tokens', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    scopes?: unknown;
    expires_at?: unknown;
    grant?: unknown;
  };
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 120) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A token name (1–120 characters) is required.',
        },
      },
      400,
    );
  }
  const scopes = (Array.isArray(body.scopes) ? body.scopes : []).filter(
    (s): s is ApiScope => typeof s === 'string' && (VALID_SCOPES as readonly string[]).includes(s),
  );
  if (scopes.length === 0) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Select at least one valid scope.' } },
      400,
    );
  }
  let expiresAt: string | null = null;
  if (body.expires_at != null && String(body.expires_at).trim() !== '') {
    const d = new Date(String(body.expires_at));
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Expiry must be a valid future date — leave blank for a token that never expires.',
          },
        },
        400,
      );
    }
    expiresAt = d.toISOString();
  }

  // Optional AI grant (campaign lane-3): validate BEFORE minting so an
  // unavailable/invalid grant never yields a token the caller believes is
  // AI-scoped. Grant processing is gated on `ai_api_keys` (DARK by default).
  let grantInput: ReturnType<typeof GrantInputSchema.parse> | null = null;
  if (body.grant !== undefined) {
    const aiKeysOn = await isFlagOn(c.env, 'ai_api_keys', {
      orgId,
      userId: c.get('userId') ?? undefined,
    });
    if (!aiKeysOn) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'AI API key grants are not available on this account yet — create the token without a grant.',
          },
        },
        400,
      );
    }
    const parsed = GrantInputSchema.safeParse(body.grant);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            issues: parsed.error.issues.map((i) => ({
              message: i.message,
              path: `grant.${i.path.join('.')}`,
            })),
            message:
              'The grant is invalid — every id must be a concrete site/connection/action/model id.',
          },
        },
        400,
      );
    }
    grantInput = parsed.data;
  }

  const result = await createApiToken(
    c.env.DB,
    orgId,
    name,
    scopes,
    c.get('userId') ?? null,
    expiresAt,
  );

  let grantSummary: GrantSummary | undefined;
  if (grantInput) {
    try {
      const record = await putGrantForToken(c.env.DB, result.token.id, orgId, grantInput);
      grantSummary = summarizeGrant(record);
    } catch (err) {
      // Never leave an orphan token the caller believes is AI-scoped: unwind
      // the mint, then surface the real failure to the error handler.
      await revokeApiToken(c.env.DB, orgId, result.token.id).catch(() => false);
      throw err;
    }
  }

  return c.json(
    {
      plaintext: result.plaintext,
      token: result.token,
      warning: 'Copy this token now — it is shown only once and cannot be retrieved again.',
      ...(grantSummary ? { grant: grantSummary } : {}),
    },
    201,
  );
});

/** DELETE /api/v1-tokens/:id — revoke a token the caller org owns. */
apiTokensAdmin.delete('/api/v1-tokens/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);
  }
  const tokenId = c.req.param('id');
  const revoked = await revokeApiToken(c.env.DB, orgId, tokenId);
  if (!revoked) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Token not found.' } }, 404);
  }
  // The grant's lifecycle follows the token (fail closed, flag-independent):
  // a revoked token must never leave a live AI grant behind. Best-effort —
  // token revocation already succeeded and must not be blocked by cleanup.
  await revokeGrant(c.env.DB, orgId, tokenId).catch(() => false);
  return c.json({ ok: true });
});
