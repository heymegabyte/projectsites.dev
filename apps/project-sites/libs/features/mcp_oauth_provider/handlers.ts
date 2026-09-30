/**
 * @module libs/features/mcp_oauth_provider/handlers
 * @description Hono route handlers for the OAuth 2.1 authorization server.
 *
 * Routes (all return 404 when flag `mcp_oauth_provider` is off):
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                          Browser entry → 302 to /oauth/consent
 *   POST /api/oauth/authorize                      Bearer-gated code issuance
 *   POST /oauth/token                              Code exchange → access_token
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { verifyApiToken, extractBearerToken, createApiToken } from '../../../src/services/api_tokens.js';
import type { ApiScope } from '../../../src/services/api_tokens.js';
import {
  DcrRequestSchema,
  AuthorizeParamsSchema,
  TokenRequestSchema,
  OAUTH_ALLOWED_SCOPES,
} from './schemas.js';
import type { OAuthScope } from './schemas.js';
import {
  FLAG_KEY,
  CODE_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
  putClient,
  getClient,
  putCode,
  consumeCode,
  presenterScopesFromTokenScopes,
  presenterScopesForSession,
  intersectScopes,
  randomUrlSafe,
  pkceMatches,
  isAllowedRedirectUri,
} from './service.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const oauthProvider = new Hono<AppContext>();

// ── Flag guard helper ─────────────────────────────────────────────────────────
async function flagGuard(c: Context<AppContext>): Promise<boolean> {
  return isFlagOn(c.env, FLAG_KEY, {});
}

function baseUrl(c: Context<AppContext>): string {
  const host = c.req.header('host') ?? 'projectsites.dev';
  const proto = c.req.header('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

/**
 * Write-endpoint preamble for /oauth/register + /oauth/token: 404 when the flag
 * is off, then per-IP rate-limit via `OAUTH_RATELIMIT`. Returns a `Response` to
 * short-circuit (404 or 429), or `null` to proceed.
 */
async function oauthGate(c: Context<AppContext>): Promise<Response | null> {
  if (!(await flagGuard(c))) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const rl = await c.env.OAUTH_RATELIMIT?.limit({ key: `oauth:${ip}` });
  if (rl && !rl.success) {
    return c.json(
      { error: 'rate_limited', error_description: 'Too many requests — slow down and retry shortly.' },
      429,
    );
  }
  return null;
}

// ── RFC 8414 metadata ─────────────────────────────────────────────────────────
oauthProvider.get('/.well-known/oauth-authorization-server', async (c) => {
  if (!(await flagGuard(c))) return c.json({ error: { code: 'NOT_FOUND' } }, 404);

  const base = baseUrl(c);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [...OAUTH_ALLOWED_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// ── RFC 7591 Dynamic Client Registration ─────────────────────────────────────
oauthProvider.post('/oauth/register', async (c) => {
  const blocked = await oauthGate(c);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Request body must be JSON.' }, 400);
  }

  const parsed = DcrRequestSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'invalid_client_metadata';
    // Propagate our custom redirect_uri message as the OAuth error code
    const isRedirectErr = parsed.error.issues.some((i) => i.message === 'invalid_redirect_uri');
    return c.json({
      error: isRedirectErr ? 'invalid_redirect_uri' : 'invalid_client_metadata',
      error_description: msg,
    }, 400);
  }

  // Re-check each URI (belt + suspenders beyond Zod)
  for (const uri of parsed.data.redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      return c.json({ error: 'invalid_redirect_uri', error_description: `Non-HTTPS, non-loopback redirect URI: ${uri}` }, 400);
    }
  }

  const client_id = randomUrlSafe(24);
  const now = Math.floor(Date.now() / 1000);

  await putClient(c.env.CACHE_KV, {
    client_id,
    redirect_uris: parsed.data.redirect_uris,
    client_name: parsed.data.client_name,
    created_at: now,
  });

  return c.json({
    client_id,
    redirect_uris: parsed.data.redirect_uris,
    client_name: parsed.data.client_name,
    grant_types: parsed.data.grant_types,
    response_types: parsed.data.response_types,
    token_endpoint_auth_method: parsed.data.token_endpoint_auth_method,
    client_id_issued_at: now,
  }, 201);
});

// ── Browser authorize entry — validates params then redirects to consent page ─
oauthProvider.get('/oauth/authorize', async (c) => {
  if (!(await flagGuard(c))) return c.json({ error: { code: 'NOT_FOUND' } }, 404);

  const q = c.req.query();
  const parsed = AuthorizeParamsSchema.safeParse({
    client_id: q['client_id'],
    redirect_uri: q['redirect_uri'],
    response_type: q['response_type'],
    scope: q['scope'],
    state: q['state'],
    code_challenge: q['code_challenge'],
    code_challenge_method: q['code_challenge_method'],
  });

  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      error_description: parsed.error.issues[0]?.message ?? 'Invalid authorization request.',
    }, 400);
  }

  // GET only validates request SHAPE then forwards to the consent SPA. The real
  // gate (client lookup, exact redirect_uri match, scope check, org binding) is
  // POST /api/oauth/authorize, called by the consent page after the user allows —
  // so a bogus client_id can never mint a code, only render a consent page that
  // POST will reject.
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]));
  const base = baseUrl(c);
  return c.redirect(`${base}/oauth/consent?${qs.toString()}`, 302);
});

// ── API authorize (presenter-gated) — issues code ────────────────────────────
oauthProvider.post('/api/oauth/authorize', async (c) => {
  if (!(await flagGuard(c))) return c.json({ error: { code: 'NOT_FOUND' } }, 404);

  // Presenter resolution — WHO is granting, and what may they grant? The
  // consent POST arrives either with a psk_ API token (api_tokens service) or
  // as the signed-in SESSION (authMiddleware populates userId/orgId on /api/*
  // — the Angular consent page's path). The minted grant can never exceed the
  // PRESENTER's own authority: grantable = requested ∩ presenter (below).
  const bearerRaw = extractBearerToken(c.req.header('authorization') ?? null);
  let orgId: string;
  let createdByTokenId: string | undefined;
  let presenterScopes: readonly OAuthScope[];

  if (bearerRaw) {
    const tokenResult = await verifyApiToken(c.env.DB, bearerRaw);
    if (!tokenResult) {
      return c.json({ error: 'unauthorized', error_description: 'Invalid or expired token.' }, 401);
    }
    orgId = tokenResult.org_id;
    createdByTokenId = tokenResult.id;
    presenterScopes = presenterScopesFromTokenScopes(tokenResult.scopes);
  } else {
    const sessionUserId = c.get('userId');
    const sessionOrgId = c.get('orgId');
    if (!sessionUserId || !sessionOrgId) {
      return c.json({ error: 'unauthorized', error_description: 'Bearer token required.' }, 401);
    }
    orgId = sessionOrgId;
    presenterScopes = await presenterScopesForSession(c.env.DB, sessionUserId, sessionOrgId);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Request body must be JSON.' }, 400);
  }

  const parsed = AuthorizeParamsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      error_description: parsed.error.issues[0]?.message ?? 'Invalid authorize request.',
    }, 400);
  }

  // Validate client
  const client = await getClient(c.env.CACHE_KV, parsed.data.client_id);
  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id.' }, 400);
  }

  // Exact redirect_uri match
  if (!client.redirect_uris.includes(parsed.data.redirect_uri)) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch.' }, 400);
  }

  // S256 is required
  if (parsed.data.code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported.' }, 400);
  }

  // Scope validation — static allowlist first (clear error for unknown scopes)…
  const requestedScopes = parsed.data.scope.split(' ').filter(Boolean);
  const invalidScopes = requestedScopes.filter((s) => !(OAUTH_ALLOWED_SCOPES as readonly string[]).includes(s));
  if (invalidScopes.length > 0) {
    return c.json({ error: 'invalid_scope', error_description: `Unsupported scopes: ${invalidScopes.join(', ')}` }, 400);
  }

  // …then the PRESENTER intersection (grant-mint escalation fix): the grant is
  // requested ∩ presenter. Empty ⇒ the presenter holds none of what was asked
  // for — refuse rather than escalate. Partial overlap narrows the grant.
  const grantableScopes = intersectScopes(requestedScopes, presenterScopes);
  if (grantableScopes.length === 0) {
    return c.json({
      error: 'invalid_scope',
      error_description: "Requested scopes exceed the presenting credential's authority.",
    }, 400);
  }

  // Mint single-use authorization code (D1-backed; hash-only at rest). The
  // presenter's effective scopes are snapshotted so the exchange can
  // re-intersect defensively (minted child token ≤ presenter authority).
  const code = randomUrlSafe(32);
  const now = Math.floor(Date.now() / 1000);
  await putCode(c.env.DB, code, {
    client_id: parsed.data.client_id,
    redirect_uri: parsed.data.redirect_uri,
    scope: grantableScopes.join(' '),
    presenter_scopes: presenterScopes.join(' '),
    code_challenge: parsed.data.code_challenge,
    org_id: orgId,
    ...(createdByTokenId ? { created_by_token_id: createdByTokenId } : {}),
    expires_at: now + CODE_TTL_SECONDS,
  });

  const redirectUrl = `${parsed.data.redirect_uri}?code=${code}${parsed.data.state ? `&state=${encodeURIComponent(parsed.data.state)}` : ''}`;
  return c.json({ redirect_uri: redirectUrl });
});

// ── Token endpoint — exchange code for access_token ──────────────────────────
oauthProvider.post('/oauth/token', async (c) => {
  const blocked = await oauthGate(c);
  if (blocked) return blocked;

  // Accept both JSON and application/x-www-form-urlencoded
  let rawBody: unknown;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await c.req.text();
    const params = new URLSearchParams(text);
    rawBody = Object.fromEntries(params.entries());
  } else {
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', error_description: 'Request body must be JSON or form-encoded.' }, 400);
    }
  }

  const parsed = TokenRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      error_description: parsed.error.issues[0]?.message ?? 'Invalid token request.',
    }, 400);
  }

  if (parsed.data.grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code is supported.' }, 400);
  }

  // Consume the code — ATOMIC single-use claim in D1: one conditional UPDATE
  // (`used_at IS NULL AND expires_at > now`, meta.changes === 1). Two racing
  // exchanges of the same code: exactly one wins; the loser, any replay, an
  // expired code, and an unknown code all land here.
  const codeRecord = await consumeCode(c.env.DB, parsed.data.code);
  if (!codeRecord) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code not found, expired, or already used.' }, 400);
  }

  // Expiry double-check (the claim's WHERE already enforces this; belt+suspenders)
  const now = Math.floor(Date.now() / 1000);
  if (codeRecord.expires_at < now) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code has expired.' }, 400);
  }

  // client_id match
  if (codeRecord.client_id !== parsed.data.client_id) {
    return c.json({ error: 'invalid_grant', error_description: 'client_id mismatch.' }, 400);
  }

  // redirect_uri exact match
  if (codeRecord.redirect_uri !== parsed.data.redirect_uri) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch.' }, 400);
  }

  // PKCE verification
  const pkceValid = await pkceMatches(codeRecord.code_challenge, parsed.data.code_verifier);
  if (!pkceValid) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE code_verifier does not match code_challenge.' }, 400);
  }

  // Defensive re-intersection (child ≤ presenter): even if a stored record was
  // widened (tampering, legacy drift), the minted token never exceeds the
  // presenter-authority snapshot captured at authorize time.
  const presenterSet = codeRecord.presenter_scopes.split(' ').filter(Boolean);
  const scopes = codeRecord.scope
    .split(' ')
    .filter(Boolean)
    .filter((s): s is ApiScope =>
      (OAUTH_ALLOWED_SCOPES as readonly string[]).includes(s) && presenterSet.includes(s)
    );
  if (scopes.length === 0) {
    return c.json({
      error: 'invalid_scope',
      error_description: "Granted scopes exceed the presenting credential's authority.",
    }, 400);
  }

  // Mint a real psk_ token via the existing token service
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  const tokenResult = await createApiToken(
    c.env.DB,
    codeRecord.org_id,
    `oauth:${parsed.data.client_id}`,
    scopes,
    null,
    expiresAt,
  );

  return c.json({
    // The issued access_token is the psk_ PLAINTEXT — `.token` is the public row
    // (id/org/scopes), not the credential. Returning `.token` would hand the client
    // an unusable object and break every subsequent /api/mcp call.
    access_token: tokenResult.plaintext,
    token_type: 'Bearer',
    // Report the scopes actually MINTED (post-intersection), never the raw
    // stored string — the response must not overstate the token's authority.
    scope: scopes.join(' '),
    expires_in: TOKEN_TTL_SECONDS,
  });
});
