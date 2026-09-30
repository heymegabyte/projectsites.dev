/**
 * @module libs/features/mcp_oauth_provider/schemas
 * @description Zod contracts for the OAuth 2.1 authorization server.
 * One schema per endpoint boundary → runtime validation → no hand-kept duplicates.
 */
import { z } from 'zod';

// ── Valid OAuth scopes (subset of VALID_SCOPES that makes sense for MCP clients) ──
export const OAUTH_ALLOWED_SCOPES = ['sites:read', 'sites:write'] as const;
export type OAuthScope = (typeof OAUTH_ALLOWED_SCOPES)[number];

// ── RFC 7591 Dynamic Client Registration ──────────────────────────────────────

/** Validates redirect_uris: must be HTTPS or loopback HTTP (127.0.0.1 or localhost). */
const redirectUri = z.string().refine(
  (uri) => {
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
  },
  { message: 'invalid_redirect_uri' },
);

export const DcrRequestSchema = z.object({
  redirect_uris: z.array(redirectUri).min(1).max(5),
  client_name: z.string().min(1).max(128).optional(),
  grant_types: z.array(z.string()).default(['authorization_code']),
  response_types: z.array(z.string()).default(['code']),
  token_endpoint_auth_method: z.string().default('none'),
});
export type DcrRequest = z.infer<typeof DcrRequestSchema>;

export const DcrResponseSchema = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()),
  client_name: z.string().optional(),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  client_id_issued_at: z.number(),
});
export type DcrResponse = z.infer<typeof DcrResponseSchema>;

// ── KV stored client record ───────────────────────────────────────────────────
export const OAuthClientSchema = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()),
  client_name: z.string().optional(),
  created_at: z.number(),
});
export type OAuthClient = z.infer<typeof OAuthClientSchema>;

// ── Authorize endpoint (browser GET + API POST) ───────────────────────────────
export const AuthorizeParamsSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  // response_type defaults to 'code' (the only type we support); optional so a
  // minimal authorize request still parses.
  response_type: z.literal('code').optional(),
  scope: z.string().default(''),
  state: z.string().optional(),
  // PKCE S256 challenge is base64url(SHA-256) = exactly 43 chars.
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
});
export type AuthorizeParams = z.infer<typeof AuthorizeParamsSchema>;

// ── D1-stored authorization code (mcp_oauth_codes, migration 0649) ───────────
export const OAuthCodeSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  /** GRANTED scopes — requested ∩ presenter at authorize time, space-delimited. */
  scope: z.string(),
  /**
   * Snapshot of the PRESENTING principal's effective OAuth scopes at authorize
   * time, space-delimited. The token exchange re-intersects against this
   * defensively so a minted child token can never exceed presenter authority.
   */
  presenter_scopes: z.string(),
  code_challenge: z.string(),
  org_id: z.string(),
  created_by_token_id: z.string().optional(),
  expires_at: z.number(),
});
export type OAuthCode = z.infer<typeof OAuthCodeSchema>;

// ── Token endpoint ────────────────────────────────────────────────────────────
export const TokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  scope: z.string(),
  expires_in: z.number(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// ── RFC 8414 metadata ─────────────────────────────────────────────────────────
export const AuthServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  scopes_supported: z.array(z.string()),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
});
export type AuthServerMetadata = z.infer<typeof AuthServerMetadataSchema>;
