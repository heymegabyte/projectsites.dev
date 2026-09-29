/**
 * @module platform/api-keys
 *
 * @description
 * Native API-key management port over the D1 `api_tokens` keystore (convergence §30).
 * ProjectSites already owns a complete API-key system (`services/api_tokens`:
 * `psk_<hex>` keys, SHA-256 hash stored in D1, scopes, expiry, revoke, last-used
 * throttling). This port exposes the existing keystore through a typed provider
 * contract (`create` / `verify` / `revoke` with a structured verification result) so
 * call sites are vendor-neutral: a different adapter could later slot behind the
 * factory without touching them.
 *
 * Ports-and-adapters: this file is the pure port (interface + Fake). The real
 * adapter over the D1 keystore + the `getApiKeyProvider(env)` factory live in
 * `middleware/api-keys.ts` (mirrors `platform/feature-evaluation.ts`). Ships DARK:
 * nothing calls it yet — `api_tokens` stays the live verification path.
 *
 * @see services/api_tokens.ts (the keystore this wraps)
 * @see middleware/api-keys.ts (D1 adapter + factory)
 * @see docs/decisions/0034-platform-consolidation-cf-native.md
 */

/**
 * Verification outcome code for the native API-key provider.
 * - `VALID` — key found, not revoked, not expired.
 * - `NOT_FOUND` — no matching key (also covers revoked/expired, which the
 *   keystore collapses into "no valid row" — never leak which). → caller 401.
 * - `FORBIDDEN` — found but lacks a required scope (caller-side check). → 403.
 * - `ERROR` — the keystore lookup FAILED (D1 down/timeout). Distinct from
 *   `NOT_FOUND` so a Bearer route returns 503, never a silent 401 for a broken
 *   DB — auth must NOT degrade an outage into auth-denied. `verifyKey` still
 *   fails soft (never throws into the caller) per the port contract; the ERROR
 *   code carries the "can't check" signal instead of a thrown exception.
 */
export type KeyVerificationCode = 'VALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'ERROR';

/** Structured result of verifying an API key (create/verify/revoke contract). */
export interface KeyVerificationResult {
  readonly valid: boolean;
  readonly code: KeyVerificationCode;
  /** Key id (D1 `api_tokens.id`) when found. */
  readonly keyId?: string;
  /** Owner the key belongs to (D1 `org_id`). */
  readonly ownerId?: string;
  /** Granted scopes when valid. */
  readonly scopes?: readonly string[];
}

/** Input to mint a new key. */
export interface CreateKeyInput {
  /** Owner the key belongs to (org id). */
  readonly ownerId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdBy?: string | null;
  /** ISO timestamp; null/undefined = never expires. */
  readonly expiresAt?: string | null;
}

/** Result of minting a key — `key` plaintext is returned ONCE. */
export interface CreateKeyResult {
  readonly keyId: string;
  readonly key: string;
}

/** Native API-key management provider (create / verify / revoke). */
export interface ApiKeyProvider {
  /** Provider name for diagnostics. */
  readonly name: string;
  createKey(input: CreateKeyInput): Promise<CreateKeyResult>;
  /** Verify a plaintext key. MUST fail soft — never throw into the caller. */
  verifyKey(plaintext: string): Promise<KeyVerificationResult>;
  /** Revoke a key by id within its owner scope. Returns true if a row changed. */
  revokeKey(keyId: string, ownerId: string): Promise<boolean>;
}

/**
 * Deterministic in-memory provider for tests + no-store local mode. Minted keys
 * are `fake_<n>`; `verifyKey` resolves from the in-memory map.
 *
 * @example
 * const p = new FakeApiKeyProvider();
 * const { key } = await p.createKey({ ownerId: 'o1', name: 't', scopes: ['sites:read'] });
 * await p.verifyKey(key); // { valid: true, code: 'VALID', ownerId: 'o1', ... }
 */
export class FakeApiKeyProvider implements ApiKeyProvider {
  readonly name = 'fake-api-keys';
  private seq = 0;
  private readonly byKey = new Map<
    string,
    { keyId: string; ownerId: string; scopes: readonly string[]; revoked: boolean }
  >();

  async createKey(input: CreateKeyInput): Promise<CreateKeyResult> {
    const keyId = `fake_key_${++this.seq}`;
    const key = `fake_${keyId}`;
    this.byKey.set(key, { keyId, ownerId: input.ownerId, scopes: input.scopes, revoked: false });
    return { keyId, key };
  }

  async verifyKey(plaintext: string): Promise<KeyVerificationResult> {
    const rec = this.byKey.get(plaintext);
    if (!rec || rec.revoked) return { valid: false, code: 'NOT_FOUND' };
    return {
      valid: true,
      code: 'VALID',
      keyId: rec.keyId,
      ownerId: rec.ownerId,
      scopes: rec.scopes,
    };
  }

  async revokeKey(keyId: string, ownerId: string): Promise<boolean> {
    for (const rec of this.byKey.values()) {
      if (rec.keyId === keyId && rec.ownerId === ownerId && !rec.revoked) {
        rec.revoked = true;
        return true;
      }
    }
    return false;
  }
}
