/**
 * media_signed_url.test.ts — unit tests for the signed, bearer-free raw-media URL
 * (fire-153 fix: Editor Resources Media thumbnails loaded as a cross-origin <img>).
 * Covers the sign→verify round-trip, absolute-origin + no-secret relative fallback,
 * asset/org IDOR binding, signature + secret tampering, and expiry.
 */
import type { Env } from '../types/env.js';
import { signedRawMediaUrl, verifyMediaToken } from '../services/media.js';

const ENV = { MANIFEST_SIGNING_SECRET: 'unit-test-signing-secret-0123456789abcdef' } as unknown as Env;
const NOSECRET = {} as unknown as Env;

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

describe('services/media — signed raw-media URL', () => {
  it('round-trips: a signed-URL token verifies for the same asset + org', async () => {
    const url = await signedRawMediaUrl(ENV, 'asset-1', 'org-1');
    expect(url).toMatch(/^https:\/\/projectsites\.dev\/api\/media\/assets\/asset-1\/raw\?token=/);
    const claims = await verifyMediaToken(ENV, 'asset-1', tokenFrom(url));
    expect(claims).not.toBeNull();
    expect(claims?.orgId).toBe('org-1');
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns a RELATIVE bearer-only path when no signing secret is configured', async () => {
    const url = await signedRawMediaUrl(NOSECRET, 'asset-1', 'org-1');
    expect(url).toBe('/api/media/assets/asset-1/raw');
    expect(url).not.toContain('token=');
    expect(await verifyMediaToken(NOSECRET, 'asset-1', 'anything')).toBeNull();
  });

  it('URL-encodes the asset id in the path', async () => {
    const url = await signedRawMediaUrl(ENV, 'a/b c', 'org-1');
    expect(url).toContain('/api/media/assets/a%2Fb%20c/raw');
  });

  it('IDOR: a token for asset-1 does NOT verify for asset-2 (asset-bound HMAC)', async () => {
    const token = tokenFrom(await signedRawMediaUrl(ENV, 'asset-1', 'org-1'));
    expect(await verifyMediaToken(ENV, 'asset-2', token)).toBeNull();
    expect(await verifyMediaToken(ENV, 'asset-1', token)).not.toBeNull();
  });

  it('IDOR: tampering the org segment breaks the signature', async () => {
    const token = tokenFrom(await signedRawMediaUrl(ENV, 'asset-1', 'org-1'));
    const parts = token.split('.');
    const tampered = `org-evil.${parts[1]}.${parts[2]}`;
    expect(await verifyMediaToken(ENV, 'asset-1', tampered)).toBeNull();
  });

  it('tampering the signature is rejected (constant-time compare)', async () => {
    const token = tokenFrom(await signedRawMediaUrl(ENV, 'asset-1', 'org-1'));
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(await verifyMediaToken(ENV, 'asset-1', flipped)).toBeNull();
  });

  it('a token minted with the real secret cannot be verified under a different secret', async () => {
    const token = tokenFrom(await signedRawMediaUrl(ENV, 'asset-1', 'org-1'));
    const otherEnv = { MANIFEST_SIGNING_SECRET: 'a-totally-different-secret' } as unknown as Env;
    expect(await verifyMediaToken(otherEnv, 'asset-1', token)).toBeNull();
  });

  it('rejects an expired token (TTL-bounded replay window)', async () => {
    const token = tokenFrom(await signedRawMediaUrl(ENV, 'asset-1', 'org-1'));
    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 60 * 60 * 1000); // +1h > 30m TTL
    try {
      expect(await verifyMediaToken(ENV, 'asset-1', token)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects malformed / empty tokens', async () => {
    for (const t of ['', 'garbage', 'only.two', 'a.b.c.d.e']) {
      expect(await verifyMediaToken(ENV, 'asset-1', t)).toBeNull();
    }
  });
});
