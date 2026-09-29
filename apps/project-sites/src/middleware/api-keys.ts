/**
 * @module middleware/api-keys
 *
 * @description
 * Real adapter + factory for the §30 native API-key port. Wraps the existing
 * `services/api_tokens` keystore (D1 `api_tokens`, SHA-256 hashes, scopes, expiry,
 * revoke) in the `ApiKeyProvider` contract. No external service and no env secret —
 * it delegates to our own keystore, so it is always available and needs no gate (see
 * ADR-0030). A different adapter could slot in here without touching call sites.
 *
 * @see platform/api-keys.ts (the port + Fake)
 * @see services/api_tokens.ts (the wrapped keystore)
 */
import type { Env } from '../types/env.js';
import type {
  ApiKeyProvider,
  CreateKeyInput,
  CreateKeyResult,
  KeyVerificationResult,
} from '../platform/api-keys.js';
import {
  createApiToken,
  verifyApiToken,
  revokeApiToken,
  VALID_SCOPES,
  type ApiScope,
} from '../services/api_tokens.js';

/** Keep only scopes the keystore recognizes (drops unknowns silently). */
function toApiScopes(scopes: readonly string[]): ApiScope[] {
  return scopes.filter((s): s is ApiScope => (VALID_SCOPES as readonly string[]).includes(s));
}

/**
 * D1-backed provider for the production `api_tokens` keystore.
 * `verifyKey` fails soft (never throws into the caller, per the port contract) but
 * DISTINGUISHES a genuine miss from a DB outage: a `null` from the keystore →
 * `{ valid: false, code: 'NOT_FOUND' }` (→ 401); a THROWN keystore error (D1
 * down/timeout) → `{ valid: false, code: 'ERROR' }` (→ 503). Auth must not degrade
 * a broken DB into auth-denied — the caller inspects `code` to pick 401 vs 503.
 */
export class D1ApiKeyProvider implements ApiKeyProvider {
  readonly name = 'projectsites-d1-api-tokens';
  constructor(private readonly env: Env) {}

  async createKey(input: CreateKeyInput): Promise<CreateKeyResult> {
    const result = await createApiToken(
      this.env.DB,
      input.ownerId,
      input.name,
      toApiScopes(input.scopes),
      input.createdBy ?? null,
      input.expiresAt ?? null,
    );
    return { keyId: result.token.id, key: result.plaintext };
  }

  async verifyKey(plaintext: string): Promise<KeyVerificationResult> {
    try {
      const row = await verifyApiToken(this.env.DB, plaintext);
      if (!row) return { valid: false, code: 'NOT_FOUND' };
      return {
        valid: true,
        code: 'VALID',
        keyId: row.id,
        ownerId: row.org_id,
        scopes: toApiScopes(JSON.parse(row.scopes) as string[]),
      };
    } catch (err) {
      // A THROWN keystore error means the lookup COULD NOT COMPLETE (D1 down/timeout),
      // NOT that the key is absent. Return ERROR (→ caller 503) so a broken DB never
      // reads as auth-denied (401). Fail soft (don't rethrow) per the port contract,
      // but carry the "can't check" signal in the code. Log server-side for triage.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'api-keys',
          event: 'verify_key_error',
          message: err instanceof Error ? err.message : 'unknown keystore error',
        }),
      );
      return { valid: false, code: 'ERROR' };
    }
  }

  async revokeKey(keyId: string, ownerId: string): Promise<boolean> {
    return revokeApiToken(this.env.DB, ownerId, keyId);
  }
}

/**
 * Resolve the active API-key provider. Returns the D1-backed provider — it wraps
 * our own keystore, so it is always available (no env gate, unlike the abuse/email/
 * identity ports). Ships DARK: `api_tokens` stays the live verification path until
 * a handler opts into this provider.
 *
 * @example
 * const keys = getApiKeyProvider(c.env);
 * const v = await keys.verifyKey(token);
 * if (!v.valid) return c.json({ error: v.code }, 401);
 */
export function getApiKeyProvider(env: Env): ApiKeyProvider {
  return new D1ApiKeyProvider(env);
}
