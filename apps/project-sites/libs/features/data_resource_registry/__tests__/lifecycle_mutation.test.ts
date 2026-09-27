/**
 * TDD tests for lifecycle_mutation — the shared teardown/clone/promote/presign `mutate` bridge (FIRE 5).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). We mock the lifecycle SERVICE + the R2
 * presign minter (4× ../ reaches `src/`; sibling modules are `../`), so these tests are about the ENVELOPE
 * mapping — confirm gating, honest not_available/confirmation_required, and success shaping — not CF I/O.
 *
 * Contracts under test:
 *   (a) teardown WITHOUT confirm → `confirmation_required` NAMING irreversibility, service NOT called
 *   (b) teardown WITH confirm → calls teardownResource + maps success to a typed result
 *   (c) teardown of a protected resource → maps `deletion_protected` to a user-safe refusal
 *   (d) promote → calls promoteResource; a provision confirm gate surfaces as `confirmation_required`
 *   (e) clone → maps the service `not_available` verbatim (never a fake success)
 *   (f) preview_url → maps a minted scoped URL to available:true; an unwired mint to available:false + approach
 *   (g) a scope with NO env fails closed (`lifecycle_unavailable`)
 */

// ─── Mocks — declared BEFORE the import that triggers the real modules ───────────

const teardownResource = jest.fn();
const cloneResource = jest.fn();
const promoteResource = jest.fn();
const mintScopedR2Url = jest.fn();

jest.mock('../lifecycle_service.js', () => ({
  cloneResource: (...a: unknown[]) => cloneResource(...a),
  promoteResource: (...a: unknown[]) => promoteResource(...a),
  teardownResource: (...a: unknown[]) => teardownResource(...a),
}));

jest.mock('../r2_presign.js', () => ({
  mintScopedR2Url: (...a: unknown[]) => mintScopedR2Url(...a),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import {
  runCloneMutation,
  runPromoteMutation,
  runR2PresignMutation,
  runTeardownMutation,
} from '../lifecycle_mutation.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseScope: ResolvedScope = {
  accessPolicy: 'site_scoped',
  accountId: 'acct-1',
  auth: { kind: 'token', token: 't' } as never,
  environment: 'production',
  orgId: 'org-1',
  resourceId: 'ps-site-abc',
  siteId: 'site-1',
};
/** A scope carrying the worker env (lifecycle ops need it). */
const scope: ResolvedScope = { ...baseScope, env: {} as never };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runTeardownMutation', () => {
  it('requires confirm — WITHOUT it returns confirmation_required NAMING irreversibility, service NOT called', async () => {
    const res = await runTeardownMutation('cid', scope, 'r2', { action: 'teardown' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('confirmation_required');
    expect(res.error?.message).toMatch(/permanent|irreversible/i);
    expect(teardownResource).not.toHaveBeenCalled();
  });

  it('WITH confirm calls teardownResource + maps a success to a typed result', async () => {
    teardownResource.mockResolvedValueOnce({ deletedCfResource: true, displayName: 'ps-site-abc', ok: true, resourceId: 'ps-site-abc' });
    const res = await runTeardownMutation('cid', scope, 'r2', { action: 'teardown', confirm: true });
    expect(teardownResource).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ action: 'teardown', deletedCfResource: true, resourceId: 'ps-site-abc' });
  });

  it('maps a protected resource to a user-safe refusal', async () => {
    teardownResource.mockResolvedValueOnce({ ok: false, reason: 'deletion_protected' });
    const res = await runTeardownMutation('cid', scope, 'd1', { action: 'teardown', confirm: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('deletion_protected');
    expect(res.error?.message).toMatch(/protected/i);
  });

  it('fails closed when the scope carries no env', async () => {
    const res = await runTeardownMutation('cid', baseScope, 'r2', { action: 'teardown', confirm: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('lifecycle_unavailable');
    expect(teardownResource).not.toHaveBeenCalled();
  });
});

describe('runPromoteMutation', () => {
  it('calls promoteResource + maps a success (with note) to a typed result', async () => {
    promoteResource.mockResolvedValueOnce({ note: 'Copied 3 KV values preview → production.', ok: true, registryRowId: 'row-9', targetResourceId: 'ns-prod' });
    const res = await runPromoteMutation('cid', scope, 'kv', { action: 'promote', confirm: true });
    expect(promoteResource).toHaveBeenCalledWith(expect.anything(), 'site-1', 'org-1', 'kv', true);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ action: 'promote', note: expect.stringContaining('Copied'), targetResourceId: 'ns-prod' });
  });

  it('surfaces the provision confirm gate as confirmation_required', async () => {
    promoteResource.mockResolvedValueOnce({ detail: 'confirmation_required', ok: false, reason: 'not_available' });
    const res = await runPromoteMutation('cid', scope, 'd1', { action: 'promote' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('confirmation_required');
  });
});

describe('runCloneMutation', () => {
  it('maps the service not_available verbatim (never a fake success)', async () => {
    cloneResource.mockResolvedValueOnce({ detail: 'Cloning would create a second dedicated resource…', ok: false, reason: 'not_available' });
    const res = await runCloneMutation('cid', scope, 'r2', { action: 'clone' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('not_available');
    expect(res.error?.message).toMatch(/second dedicated resource/i);
  });
});

describe('runR2PresignMutation (INV-6)', () => {
  it('maps a minted scoped URL to available:true (the URL, never a credential)', async () => {
    mintScopedR2Url.mockResolvedValueOnce({ available: true, expiresInSeconds: 900, url: 'https://acct.r2.cloudflarestorage.com/b/logo.png?X-Amz-Signature=abc', verb: 'download' });
    const res = await runR2PresignMutation('cid', scope, { action: 'preview_url', key: 'logo.png' });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ action: 'preview_url', available: true });
    expect(res.data?.url).toContain('X-Amz-Signature');
    // The minter was asked for the scope's bucket + the key (never a caller-supplied bucket).
    expect(mintScopedR2Url).toHaveBeenCalledWith(scope.auth, 'acct-1', expect.objectContaining({ bucket: 'ps-site-abc', key: 'logo.png', verb: 'download' }));
  });

  it('maps an unwired mint to available:false + approach (never a fabricated URL)', async () => {
    mintScopedR2Url.mockResolvedValueOnce({ available: false, reason: 'A server-streamed proxy is used instead.' });
    const res = await runR2PresignMutation('cid', scope, { action: 'preview_url', key: 'logo.png' });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ available: false });
    expect(res.data?.url).toBeUndefined();
    expect(res.data?.approach).toMatch(/proxy/i);
  });

  it('requests the upload verb for upload_url', async () => {
    mintScopedR2Url.mockResolvedValueOnce({ available: true, expiresInSeconds: 900, url: 'https://x/y?X-Amz-Signature=z', verb: 'upload' });
    await runR2PresignMutation('cid', scope, { action: 'upload_url', key: 'up.bin', contentType: 'application/octet-stream' });
    expect(mintScopedR2Url).toHaveBeenCalledWith(scope.auth, 'acct-1', expect.objectContaining({ verb: 'upload', contentType: 'application/octet-stream' }));
  });

  it('rejects an empty key with invalid_key', async () => {
    const res = await runR2PresignMutation('cid', scope, { action: 'preview_url', key: '' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_key');
    expect(mintScopedR2Url).not.toHaveBeenCalled();
  });
});
