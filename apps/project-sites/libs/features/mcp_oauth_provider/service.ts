/**
 * @module libs/features/mcp_oauth_provider/service
 * @description Business logic for the OAuth 2.1 authorization server.
 * Handles PKCE verification, redirect_uri validation, presenter-scope
 * resolution/intersection, and the D1-backed atomic authorization-code store.
 *
 * Clients (RFC 7591 registrations) stay in KV; authorization CODES live in D1
 * (`mcp_oauth_codes`, migration 0649) so single-use consumption is an ATOMIC
 * conditional UPDATE — the KV get+delete pair allowed two simultaneous
 * exchanges of one code to both succeed (campaign lane-2, fire-57).
 */
// NB: KVNamespace is an AMBIENT GLOBAL from @cloudflare/workers-types (tsconfig
// `types`). Do NOT `import` it — importing binds to one copy of the types
// package, which fails to match the ambient `c.env.CACHE_KV` type when the dep
// tree resolves a second copy (TS2345 "KVNamespace not assignable to KVNamespace").
import { checkPermission } from '@project-sites/shared';
import type { Role } from '@project-sites/shared';
import { OAUTH_ALLOWED_SCOPES } from './schemas.js';
import type { OAuthClient, OAuthCode, OAuthScope } from './schemas.js';

export const FLAG_KEY = 'mcp_server' as const;

/** Code lives 600 seconds (10 minutes) — single-use. */
export const CODE_TTL_SECONDS = 600;

/** Client registration lives 30 days. */
export const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Access tokens issued via OAuth live 90 days. */
export const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** KV key prefix — client registrations only (codes are D1-backed). */
export const KV_CLIENT_PREFIX = 'oauth_client:';

// ── PKCE ─────────────────────────────────────────────────────────────────────

/**
 * Verifies a PKCE S256 code_verifier against a stored code_challenge.
 * `base64url(SHA-256(code_verifier))` must equal `code_challenge`.
 *
 * @remarks Uses `crypto.subtle` — available in Cloudflare Workers.
 * @example
 * const valid = await pkceMatches(challenge, verifier);
 */
export async function pkceMatches(code_challenge: string, code_verifier: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(code_verifier));
  const computed = btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return computed === code_challenge;
}

// ── Redirect URI validation ───────────────────────────────────────────────────

/**
 * Returns true when the redirect URI is https or loopback (127.0.0.1/localhost any port).
 *
 * @remarks Loopback check is intentionally liberal per RFC 8252 §7.3.
 * @example
 * isAllowedRedirectUri('https://app.example.com/callback') // true
 * isAllowedRedirectUri('http://127.0.0.1:8080/callback')  // true
 * isAllowedRedirectUri('http://evil.com/callback')         // false
 */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    }
    return false;
  } catch {
    return false;
  }
}

// ── KV helpers ────────────────────────────────────────────────────────────────

/** Stores an OAuth client registration in KV for CLIENT_TTL_SECONDS. */
export async function putClient(kv: KVNamespace, client: OAuthClient): Promise<void> {
  await kv.put(`${KV_CLIENT_PREFIX}${client.client_id}`, JSON.stringify(client), {
    expirationTtl: CLIENT_TTL_SECONDS,
  });
}

/** Retrieves an OAuth client from KV. Returns null if not found. */
export async function getClient(kv: KVNamespace, clientId: string): Promise<OAuthClient | null> {
  return kv.get<OAuthClient>(`${KV_CLIENT_PREFIX}${clientId}`, 'json');
}

// ── Authorization codes — D1-backed, atomic single-use (migration 0649) ──────

/**
 * SHA-256 hex of an authorization code — only the hash is ever stored, so a
 * D1 read can never yield a redeemable plaintext code.
 */
export async function hashCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Persists a single-use authorization code row in `mcp_oauth_codes`.
 * Stores the code's SHA-256 only; `used_at` starts NULL until the one atomic
 * consume claims it.
 *
 * @throws on D1 failure — code issuance is security-critical; never fail soft.
 */
export async function putCode(db: D1Database, code: string, record: OAuthCode): Promise<void> {
  const codeHash = await hashCode(code);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO mcp_oauth_codes (code_hash, org_id, client_id, scope, presenter_scopes, code_challenge, redirect_uri, created_by_token_id, expires_at, used_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)`,
    )
    .bind(
      codeHash,
      record.org_id,
      record.client_id,
      record.scope,
      record.presenter_scopes,
      record.code_challenge,
      record.redirect_uri,
      record.created_by_token_id ?? null,
      record.expires_at,
      now,
    )
    .run();
}

/**
 * Atomically consumes an authorization code. A single conditional UPDATE
 * claims the row (`used_at IS NULL AND expires_at > now`) — D1 serializes
 * writes, so exactly ONE of any number of concurrent exchanges observes
 * `meta.changes === 1`; every other caller (replay, race loser, expired,
 * unknown code) gets `null` → `invalid_grant`.
 *
 * @returns The stored code record when THIS call won the claim, else null.
 * @example
 * const record = await consumeCode(env.DB, code);
 * if (!record) return invalidGrant();
 */
export async function consumeCode(db: D1Database, code: string): Promise<OAuthCode | null> {
  const codeHash = await hashCode(code);
  const now = Math.floor(Date.now() / 1000);
  const claim = await db
    .prepare(
      `UPDATE mcp_oauth_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?3`,
    )
    .bind(now, codeHash, now)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return null;

  const row = await db
    .prepare(
      `SELECT client_id, redirect_uri, scope, presenter_scopes, code_challenge, org_id, created_by_token_id, expires_at
       FROM mcp_oauth_codes WHERE code_hash = ?1`,
    )
    .bind(codeHash)
    .first<{
      client_id: string;
      redirect_uri: string;
      scope: string;
      presenter_scopes: string;
      code_challenge: string;
      org_id: string;
      created_by_token_id: string | null;
      expires_at: number;
    }>();
  if (!row) return null;
  return {
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    scope: row.scope,
    presenter_scopes: row.presenter_scopes,
    code_challenge: row.code_challenge,
    org_id: row.org_id,
    ...(row.created_by_token_id ? { created_by_token_id: row.created_by_token_id } : {}),
    expires_at: row.expires_at,
  };
}

// ── Presenter scopes — the authority a grant can never exceed ────────────────

function isOauthScope(s: string): s is OAuthScope {
  return (OAUTH_ALLOWED_SCOPES as readonly string[]).includes(s);
}

/**
 * Effective OAuth scopes of a psk_ presenter, from the api_tokens row's JSON
 * `scopes` column, filtered to the OAuth-grantable allowlist. Malformed JSON
 * ⇒ [] (fail closed — nothing grantable).
 */
export function presenterScopesFromTokenScopes(scopesJson: string): OAuthScope[] {
  try {
    const parsed = JSON.parse(scopesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is OAuthScope => typeof s === 'string' && isOauthScope(s));
  } catch {
    return [];
  }
}

/**
 * Effective OAuth scopes of a SESSION presenter, derived from their org
 * membership role via the shared RBAC model (`site:read` → `sites:read`,
 * `site:write` → `sites:write`; owner/admin/member get both, viewer reads
 * only). No live membership ⇒ [] (fail closed).
 *
 * @throws on D1 failure — presenter resolution is an auth gate; a broken DB
 * must surface as 500, never silently read as "no authority" vs "can't check".
 */
export async function presenterScopesForSession(
  db: D1Database,
  userId: string,
  orgId: string,
): Promise<OAuthScope[]> {
  const row = await db
    .prepare(
      `SELECT role FROM memberships WHERE user_id = ?1 AND org_id = ?2 AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(userId, orgId)
    .first<{ role: string }>();
  if (!row) return [];
  const role = row.role as Role; // checkPermission fails closed on unknown roles
  const scopes: OAuthScope[] = [];
  if (checkPermission(role, 'site:read')) scopes.push('sites:read');
  if (checkPermission(role, 'site:write')) scopes.push('sites:write');
  return scopes;
}

/**
 * `requested ∩ presenter` — the only scopes a code/token may carry. Order
 * follows the requested list; unknown scopes are dropped by the allowlist.
 */
export function intersectScopes(
  requested: readonly string[],
  presenter: readonly string[],
): OAuthScope[] {
  return requested.filter(
    (s): s is OAuthScope => isOauthScope(s) && presenter.includes(s),
  );
}

/** Generates a cryptographically random URL-safe string of `bytes` random bytes. */
export function randomUrlSafe(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
