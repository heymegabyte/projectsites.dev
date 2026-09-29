/**
 * api_tokens — Public API token issuance, verification, scoping, listing, revocation.
 *
 * Security-sensitive: tokens are minted as `psk_<64-hex>` and ONLY their SHA-256
 * hash is persisted. Plaintext is returned exactly once (on creation) and never
 * stored or surfaced again. This suite locks that contract directly against the
 * D1 prepare → bind → (run|first|all) chain — no real DB, real WebCrypto for the
 * SHA-256 hash (Node 22 exposes `crypto.subtle` globally, same as the Workers
 * runtime), so the stored value is verified to be the actual hash of the plaintext.
 *
 * Coverage:
 *   1. mint — psk_ prefix + 64-hex body; stored value is the SHA-256 hash, NEVER
 *      the raw token; plaintext returned once; org_id bound; scopes JSON'd.
 *   2. verify — valid token resolves a row; SQL excludes revoked/expired/deleted;
 *      non-psk prefix short-circuits to null without a DB hit; DB error → null;
 *      last_used_at touch is fire-and-forget (a second prepare call).
 *   3. scoping — hasScope honors granted scopes, denies absent ones, always
 *      grants me:read, and fails closed on malformed scopes JSON.
 *   4. extractBearerToken — strict `Bearer psk_<64hex>` match.
 *   5. list — never leaks plaintext or token_hash; maps rows to public shape;
 *      filters invalid scopes; tolerates DB errors → empty list.
 *   6. revoke — org-scoped UPDATE, returns true only when a row changed.
 *
 * ts-jest: GLOBAL `jest` (no @jest/globals import). D1 stmt mocked, no real APIs.
 */
import {
  createApiToken,
  verifyApiToken,
  hasScope,
  extractBearerToken,
  listApiTokens,
  revokeApiToken,
  VALID_SCOPES,
  type ApiScope,
  type ApiTokenRow,
} from '../services/api_tokens.js';

// ─── D1 prepare→bind→(run|first|all) chain mock ──────────────────
//
// Each `db.prepare(sql).bind(...args)` returns a statement object whose
// run/first/all resolve to whatever the test queued. We record every
// prepared SQL + bound args so assertions can inspect the stored value.

interface PreparedCall {
  sql: string;
  args: unknown[];
}

let preparedCalls: PreparedCall[];
let runResults: unknown[];
let firstResults: unknown[];
let allResults: unknown[];

function makeDb(): D1Database {
  const prepare = jest.fn((sql: string) => {
    const bind = jest.fn((...args: unknown[]) => {
      preparedCalls.push({ sql, args });
      return {
        run: jest.fn(async () => {
          const r = runResults.shift();
          if (r instanceof Error) throw r;
          return r ?? { meta: { changes: 0 } };
        }),
        first: jest.fn(async () => {
          const r = firstResults.shift();
          if (r instanceof Error) throw r;
          return r ?? null;
        }),
        all: jest.fn(async () => {
          const r = allResults.shift();
          if (r instanceof Error) throw r;
          return r ?? { results: [] };
        }),
      };
    });
    return { bind };
  });
  return { prepare } as unknown as D1Database;
}

/** Real SHA-256 hex of a plaintext token — mirrors the service's hashToken(). */
async function sha256Hex(plaintext: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(() => {
  preparedCalls = [];
  runResults = [];
  firstResults = [];
  allResults = [];
});

// ─── mint ────────────────────────────────────────────────────────

describe('createApiToken', () => {
  it('mints a psk_<64-hex> token and returns the plaintext exactly once', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }];

    const { token, plaintext } = await createApiToken(
      db,
      'org-A',
      'CI deploy key',
      ['sites:read', 'sites:write'],
      'user-1',
      null,
    );

    expect(plaintext).toMatch(/^psk_[a-f0-9]{64}$/);
    expect(token.name).toBe('CI deploy key');
    expect(token.org_id).toBe('org-A');
    expect(token.scopes).toEqual(['sites:read', 'sites:write']);
    // Public token row never carries the plaintext or any hash field.
    expect((token as unknown as Record<string, unknown>).plaintext).toBeUndefined();
    expect((token as unknown as Record<string, unknown>).token_hash).toBeUndefined();
  });

  it('persists the SHA-256 HASH, never the raw plaintext token (hash-at-rest)', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }];

    const { plaintext } = await createApiToken(db, 'org-A', 'k', ['me:read'], null, null);

    expect(preparedCalls).toHaveLength(1);
    const insert = preparedCalls[0];
    expect(insert.sql).toContain('INSERT INTO api_tokens');
    // INSERT bind order: id, org_id, name, token_hash, scopes, created_by, expires_at, created_at, updated_at
    const storedHash = insert.args[3] as string;
    const expectedHash = await sha256Hex(plaintext);

    expect(storedHash).toBe(expectedHash);
    // The raw token must NEVER appear anywhere in the bound args.
    expect(insert.args).not.toContain(plaintext);
    expect(JSON.stringify(insert.args)).not.toContain(plaintext);
    // Stored hash is 64 hex chars and is NOT the plaintext.
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedHash).not.toBe(plaintext);
  });

  it('binds org_id for tenant isolation and JSON-encodes scopes', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }];

    await createApiToken(db, 'org-XYZ', 'scoped', ['media:read', 'analytics:read'], 'u2', null);

    const { args } = preparedCalls[0];
    expect(args[1]).toBe('org-XYZ'); // org_id
    expect(JSON.parse(args[4] as string)).toEqual(['media:read', 'analytics:read']); // scopes JSON
    expect(args[5]).toBe('u2'); // created_by
  });

  it('threads an explicit expiry through to the row', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }];
    const expiry = '2030-01-01T00:00:00.000Z';

    const { token } = await createApiToken(db, 'org-A', 'temp', ['me:read'], null, expiry);

    expect(token.expires_at).toBe(expiry);
    expect(preparedCalls[0].args[6]).toBe(expiry); // expires_at bound position
  });

  it('mints unique plaintext per call (CSPRNG, no collisions)', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];

    const a = await createApiToken(db, 'org-A', 'k1', ['me:read'], null, null);
    const b = await createApiToken(db, 'org-A', 'k2', ['me:read'], null, null);

    expect(a.plaintext).not.toBe(b.plaintext);
    // Different plaintext ⇒ different stored hash.
    expect(preparedCalls[0].args[3]).not.toBe(preparedCalls[1].args[3]);
  });
});

// ─── verify ──────────────────────────────────────────────────────

describe('verifyApiToken', () => {
  const validRow = (over: Partial<ApiTokenRow> = {}): ApiTokenRow => ({
    id: 'tok-1',
    org_id: 'org-A',
    name: 'key',
    token_hash: 'unused-here',
    scopes: '["sites:read"]',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    created_by: null,
    created_at: 'now',
    updated_at: 'now',
    ...over,
  });

  it('looks up by the SHA-256 hash of the plaintext and returns the row', async () => {
    const db = makeDb();
    const plaintext = `psk_${'a'.repeat(64)}`;
    firstResults = [validRow()];
    runResults = [{ meta: { changes: 1 } }]; // fire-and-forget last_used_at touch

    const row = await verifyApiToken(db, plaintext);

    expect(row).not.toBeNull();
    expect(row!.id).toBe('tok-1');
    // The SELECT binds the hash, never the raw token.
    const select = preparedCalls[0];
    const expectedHash = await sha256Hex(plaintext);
    expect(select.args[0]).toBe(expectedHash);
    expect(select.args).not.toContain(plaintext);
  });

  it('excludes revoked, expired, and soft-deleted tokens in the SQL guard', async () => {
    const db = makeDb();
    firstResults = [validRow()];
    runResults = [{ meta: { changes: 1 } }];

    await verifyApiToken(db, `psk_${'b'.repeat(64)}`);

    const sql = preparedCalls[0].sql;
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('expires_at IS NULL OR expires_at >');
  });

  it('short-circuits to null for a non-psk prefix WITHOUT touching the DB', async () => {
    const db = makeDb();
    const row = await verifyApiToken(db, 'sk_live_not_ours');
    expect(row).toBeNull();
    expect(preparedCalls).toHaveLength(0);
  });

  it('returns null when no matching (valid) token row exists', async () => {
    const db = makeDb();
    firstResults = [null]; // no row
    const row = await verifyApiToken(db, `psk_${'c'.repeat(64)}`);
    expect(row).toBeNull();
  });

  it('PROPAGATES (throws) when the D1 lookup itself errors — auth must NOT degrade a DB outage into a silent "no token" (401). A genuine miss returns null; a D1 error MUST throw so the caller can 503, never conflate error-with-miss (fail-fast auth per fail-fast-build-fail-soft-prod).', async () => {
    const db = makeDb();
    firstResults = [new Error('d1 down')];
    await expect(verifyApiToken(db, `psk_${'d'.repeat(64)}`)).rejects.toThrow('d1 down');
  });

  it('touches last_used_at on a hit via a second prepared statement', async () => {
    const db = makeDb();
    firstResults = [validRow({ id: 'tok-touch' })];
    runResults = [{ meta: { changes: 1 } }];

    await verifyApiToken(db, `psk_${'e'.repeat(64)}`);

    // 1 SELECT + 1 UPDATE (last_used_at was null → stale → refresh fires).
    expect(preparedCalls).toHaveLength(2);
    const update = preparedCalls[1];
    expect(update.sql).toContain('UPDATE api_tokens SET last_used_at');
    expect(update.args).toContain('tok-touch');
  });

  it('SKIPS the last_used_at touch when refreshed recently (hot-path throttle)', async () => {
    const db = makeDb();
    firstResults = [
      validRow({ id: 'tok-fresh', last_used_at: new Date(Date.now() - 1000).toISOString() }),
    ];

    const row = await verifyApiToken(db, `psk_${'f'.repeat(64)}`);

    expect(row).not.toBeNull(); // still authenticates
    // Only the SELECT ran — no second prepared statement for the UPDATE.
    expect(preparedCalls).toHaveLength(1);
  });
});

// ─── scoping ─────────────────────────────────────────────────────

describe('hasScope', () => {
  const row = (scopes: string): ApiTokenRow => ({
    id: 't',
    org_id: 'org-A',
    name: 'k',
    token_hash: 'h',
    scopes,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    created_by: null,
    created_at: 'now',
    updated_at: 'now',
  });

  it('grants a scope that is present in the token', () => {
    expect(hasScope(row('["sites:read","media:write"]'), 'sites:read')).toBe(true);
    expect(hasScope(row('["sites:read","media:write"]'), 'media:write')).toBe(true);
  });

  it('denies a scope that is absent', () => {
    expect(hasScope(row('["sites:read"]'), 'sites:write')).toBe(false);
    expect(hasScope(row('["sites:read"]'), 'analytics:read')).toBe(false);
  });

  it('always grants me:read implicitly, even with empty scopes', () => {
    expect(hasScope(row('[]'), 'me:read')).toBe(true);
    expect(hasScope(row('["sites:read"]'), 'me:read')).toBe(true);
  });

  it('fails closed (denies) when scopes JSON is malformed', () => {
    expect(hasScope(row('not-json'), 'sites:read')).toBe(false);
    // me:read still wins because it short-circuits before parsing.
    expect(hasScope(row('not-json'), 'me:read')).toBe(true);
  });

  it('exposes the canonical VALID_SCOPES set', () => {
    expect(VALID_SCOPES).toContain('sites:read');
    expect(VALID_SCOPES).toContain('me:read');
    expect(new Set(VALID_SCOPES).size).toBe(VALID_SCOPES.length); // no dupes
  });
});

// ─── bearer extraction ───────────────────────────────────────────

describe('extractBearerToken', () => {
  it('extracts a well-formed Bearer psk_ token', () => {
    const t = `psk_${'f'.repeat(64)}`;
    expect(extractBearerToken(`Bearer ${t}`)).toBe(t);
  });

  it('returns null for absent, malformed, or non-psk headers', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Bearer sk_live_abc')).toBeNull();
    expect(extractBearerToken(`psk_${'a'.repeat(64)}`)).toBeNull(); // no "Bearer "
    expect(extractBearerToken(`Bearer psk_${'a'.repeat(10)}`)).toBeNull(); // too short
  });
});

// ─── list ────────────────────────────────────────────────────────

describe('listApiTokens', () => {
  it('maps rows to the public shape and NEVER leaks plaintext or token_hash', async () => {
    const db = makeDb();
    allResults = [
      {
        results: [
          {
            id: 'tok-1',
            org_id: 'org-A',
            name: 'CI key',
            scopes: '["sites:read","media:read"]',
            last_used_at: '2026-01-01',
            expires_at: null,
            created_at: '2025-12-01',
          },
        ],
      },
    ];

    const out = await listApiTokens(db, 'org-A');

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('tok-1');
    expect(out[0].scopes).toEqual(['sites:read', 'media:read']);
    // Public shape carries no secret material.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('psk_');
    expect((out[0] as unknown as Record<string, unknown>).token_hash).toBeUndefined();
  });

  it('selects only the public columns (no token_hash) scoped to the org', async () => {
    const db = makeDb();
    allResults = [{ results: [] }];

    await listApiTokens(db, 'org-Z');

    const select = preparedCalls[0];
    expect(select.sql).not.toContain('token_hash');
    expect(select.sql).toContain('org_id = ?');
    expect(select.sql).toContain('deleted_at IS NULL');
    expect(select.args[0]).toBe('org-Z');
  });

  it('drops invalid scope values when mapping rows', async () => {
    const db = makeDb();
    allResults = [
      {
        results: [
          {
            id: 'tok-2',
            org_id: 'org-A',
            name: 'mixed',
            scopes: '["sites:read","bogus:scope","me:read"]',
            last_used_at: null,
            expires_at: null,
            created_at: 'now',
          },
        ],
      },
    ];

    const out = await listApiTokens(db, 'org-A');
    expect(out[0].scopes).toEqual(['sites:read', 'me:read'] as ApiScope[]);
  });

  it('returns an empty list when the query throws (fails soft)', async () => {
    const db = makeDb();
    allResults = [new Error('d1 down')];
    const out = await listApiTokens(db, 'org-A');
    expect(out).toEqual([]);
  });
});

// ─── revoke ──────────────────────────────────────────────────────

describe('revokeApiToken', () => {
  it('revokes (soft-deletes) a token scoped to its org and reports success', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 1 } }];

    const ok = await revokeApiToken(db, 'org-A', 'tok-1');

    expect(ok).toBe(true);
    const update = preparedCalls[0];
    expect(update.sql).toContain('UPDATE api_tokens SET revoked_at');
    expect(update.sql).toContain('org_id = ?');
    // WHERE binds tokenId + orgId (tenant isolation).
    expect(update.args).toContain('tok-1');
    expect(update.args).toContain('org-A');
  });

  it('returns false when no row matched (wrong org / already revoked)', async () => {
    const db = makeDb();
    runResults = [{ meta: { changes: 0 } }];
    const ok = await revokeApiToken(db, 'org-A', 'nope');
    expect(ok).toBe(false);
  });

  it('returns false (fails closed) when the UPDATE throws', async () => {
    const db = makeDb();
    runResults = [new Error('d1 down')];
    const ok = await revokeApiToken(db, 'org-A', 'tok-1');
    expect(ok).toBe(false);
  });
});
