/**
 * @module api_tokens
 * @description Public API token management: generate, verify, scope-check, revoke.
 *
 * Tokens are structured as `psk_<random-32-bytes-hex>` (64 hex chars after prefix).
 * Only the SHA-256 hash is stored in D1 — plaintext is returned once on creation.
 *
 * ## Scopes
 * - `sites:read`     — list/get sites
 * - `sites:write`    — create/update/delete sites, deploy
 * - `media:read`     — list/get media assets
 * - `media:write`    — upload/delete media
 * - `forms:read`     — list form submissions
 * - `analytics:read` — read analytics data
 * - `data:read`      — list/reconcile a site's Data & Resource Platform resources
 * - `data:write`     — mutate a site's Data & Resource Platform resources (e.g. KV put/delete)
 * - `me:read`        — read own profile (always granted to any valid token)
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';

/** All valid Public API scopes. */
export const VALID_SCOPES = [
  'sites:read',
  'sites:write',
  'media:read',
  'media:write',
  'forms:read',
  'analytics:read',
  'data:read',
  'data:write',
  'me:read',
] as const;

export type ApiScope = (typeof VALID_SCOPES)[number];

export interface ApiTokenRow {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  scopes: string; // JSON array
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiTokenPublic {
  id: string;
  org_id: string;
  name: string;
  scopes: ApiScope[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreateTokenResult {
  token: ApiTokenPublic;
  /** Plaintext token — shown only once. */
  plaintext: string;
}

/** Hash a plaintext token with SHA-256, return hex string. */
async function hashToken(plaintext: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generate a new `psk_<64-hex>` token. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `psk_${hex}`;
}

/**
 * Create a new API token for an org.
 * Returns the token row + plaintext (never stored).
 */
export async function createApiToken(
  db: D1Database,
  orgId: string,
  name: string,
  scopes: ApiScope[],
  createdBy: string | null,
  expiresAt: string | null,
): Promise<CreateTokenResult> {
  const plaintext = generateToken();
  const hash = await hashToken(plaintext);
  const id = crypto.randomUUID();
  const scopesJson = JSON.stringify(scopes);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO api_tokens (id, org_id, name, token_hash, scopes, created_by, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, orgId, name, hash, scopesJson, createdBy, expiresAt, now, now)
    .run();

  const row: ApiTokenPublic = {
    id,
    org_id: orgId,
    name,
    scopes,
    last_used_at: null,
    expires_at: expiresAt,
    created_at: now,
  };

  return { token: row, plaintext };
}

/**
 * Verify a plaintext token.
 * Returns the token row if valid (not revoked, not expired), or null.
 */
export async function verifyApiToken(
  db: D1Database,
  plaintext: string,
): Promise<ApiTokenRow | null> {
  if (!plaintext.startsWith('psk_')) return null;
  const hash = await hashToken(plaintext);

  // NO `.catch(() => null)` here: a genuine "no matching token" already resolves to
  // null (`.first()` returns null for zero rows), but a real D1 error (DB down/timeout)
  // MUST propagate so the caller can 503 — never conflate an outage with an empty result.
  // Auth is the explicit exception to fail-soft-prod: a broken DB must not read as
  // auth-DENIED (401). Fail fast so the caller distinguishes "no token" (401) from
  // "can't check" (503). Per fail-fast-build-fail-soft-prod § security-critical paths.
  const row = await db
    .prepare(
      `SELECT * FROM api_tokens
       WHERE token_hash = ?
         AND deleted_at IS NULL
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       LIMIT 1`,
    )
    .bind(hash)
    .first<ApiTokenRow>();

  if (row) {
    // Throttle the last_used_at touch: this validates on EVERY public-API
    // request, so the per-call write was both hot-path load AND unreliable (the
    // un-awaited promise can be cancelled when the request ends). Refresh only
    // when stale (>5 min) and AWAIT the rare write so it actually lands. A busy
    // token making many calls in 5 min now does 1 write, not one per request.
    const STALE_MS = 5 * 60 * 1000;
    const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > STALE_MS) {
      await db
        .prepare(
          `UPDATE api_tokens SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(row.id)
        .run()
        .catch(() => {});
    }
  }

  return row ?? null;
}

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is absent or malformed.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(psk_[a-f0-9]{64})$/);
  return match ? match[1] : null;
}

/**
 * Check if a token row has a required scope.
 * `me:read` is implicitly granted to any valid token.
 */
export function hasScope(row: ApiTokenRow, required: ApiScope): boolean {
  if (required === 'me:read') return true;
  try {
    const scopes = JSON.parse(row.scopes) as string[];
    return scopes.includes(required);
  } catch {
    return false;
  }
}

/** List all non-deleted tokens for an org. */
export async function listApiTokens(db: D1Database, orgId: string): Promise<ApiTokenPublic[]> {
  const rows = await db
    .prepare(
      `SELECT id, org_id, name, scopes, last_used_at, expires_at, created_at
       FROM api_tokens
       WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .bind(orgId)
    .all<
      Pick<
        ApiTokenRow,
        'id' | 'org_id' | 'name' | 'scopes' | 'last_used_at' | 'expires_at' | 'created_at'
      >
    >()
    .catch(() => ({ results: [] }));

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    org_id: r.org_id,
    name: r.name,
    scopes: parseScopes(r.scopes),
    last_used_at: r.last_used_at ?? null,
    expires_at: r.expires_at ?? null,
    created_at: r.created_at,
  }));
}

/** Revoke a token by ID for an org. Returns true if found and revoked. */
export async function revokeApiToken(
  db: D1Database,
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE api_tokens SET revoked_at = ?, updated_at = ?, deleted_at = ?
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    )
    .bind(now, now, now, tokenId, orgId)
    .run()
    .catch(() => null);

  return (result?.meta?.changes ?? 0) > 0;
}

function parseScopes(scopesJson: string): ApiScope[] {
  try {
    const parsed = JSON.parse(scopesJson) as string[];
    return parsed.filter((s): s is ApiScope => VALID_SCOPES.includes(s as ApiScope));
  } catch {
    return [];
  }
}
