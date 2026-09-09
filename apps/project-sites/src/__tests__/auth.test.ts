jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

import { dbQuery, dbQueryOne, dbInsert, dbUpdate, dbExecute } from '../services/db.js';
import {
  createMagicLink,
  verifyMagicLink,
  createGoogleOAuthState,
  createGitHubOAuthState,
  handleGoogleOAuthCallback,
  createSession,
  getSession,
  revokeSession,
  revokeOtherUserSessions,
  findOrCreateUser,
  getUserSessions,
} from '../services/auth.js';
import { AppError } from '@project-sites/shared';

const mockDbQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mockDbQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockDbInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;
const mockDbUpdate = dbUpdate as jest.MockedFunction<typeof dbUpdate>;
const mockDbExecute = dbExecute as jest.MockedFunction<typeof dbExecute>;

const mockEnv = {
  ENVIRONMENT: 'staging',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
} as any;

const mockDb = {} as D1Database;

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: mock fetch to return 200 for email sends
  global.fetch = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'mock-msg-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// createMagicLink
// ---------------------------------------------------------------------------
describe('createMagicLink', () => {
  const input = { email: 'user@example.com' };

  beforeEach(() => {
    mockDbInsert.mockResolvedValue({ error: null });
  });

  it('returns a 64-character hex token', async () => {
    const result = await createMagicLink(mockDb, mockEnv, input);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns expires_at as an ISO 8601 string', async () => {
    const result = await createMagicLink(mockDb, mockEnv, input);
    expect(() => new Date(result.expires_at).toISOString()).not.toThrow();
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('routes the magic-link email through Amazon SES, not Resend, when SES is configured (ADR-0019)', async () => {
    // SES becomes the PRIMARY transactional rail once AWS creds + verified sender
    // are present (the §4 Resend→SES cutover). Resend must NOT be touched.
    const sesEnv = {
      ...mockEnv,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
    } as any;
    await createMagicLink(mockDb, sesEnv, input);
    const urls = (global.fetch as jest.MockedFunction<typeof fetch>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
  });

  it('FALLS THROUGH to the fallback rails when the SES rail FAILS (ADR-0019 parity with notifications.ts)', async () => {
    // The SES branch in auth.ts's local sendEmail had NO try/catch: an SES
    // reject (sandbox throttle, unverified recipient) aborted the WHOLE chain —
    // the SendGrid fallback never ran, and the magic-link handler's fail-open
    // catch converted it into a silent 200 with NO email ever sent.
    // Regression lock: SES failure must fall through to SendGrid, not abort.
    // (Resend removed 2026-09-09 per Brian directive — SendGrid is the fallback.)
    const sesEnv = {
      ...mockEnv,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
      SENDGRID_API_KEY: 'test-sendgrid-key',
    } as any;
    const mockFetch = jest
      .fn()
      // First call (SES) → reject
      .mockResolvedValueOnce(
        new Response('MessageRejected: Email address is not verified', { status: 400 }),
      )
      // Second call (SendGrid fallback) → 200 success
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'msg-fallback' }), { status: 200 }));
    global.fetch = mockFetch;

    await createMagicLink(mockDb, sesEnv, input);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    // SES failure must fall through to SendGrid — the abort bug's regression lock.
    expect(urls.some((u) => u.includes('api.sendgrid.com'))).toBe(true);
  });

  it('calls dbInsert on magic_links table', async () => {
    await createMagicLink(mockDb, mockEnv, input);

    expect(mockDbInsert).toHaveBeenCalledWith(
      mockDb,
      'magic_links',
      expect.objectContaining({
        email: 'user@example.com',
        used: 0,
      }),
    );
  });

  it('THROWS on a dropped magic_links insert — never mail a link whose token has no DB row', async () => {
    // The row IS the credential; a swallowed insert error would send a sign-in email
    // pointing at a token that can never verify ("invalid or expired link").
    mockDbInsert.mockResolvedValue({ error: 'D1_ERROR: database is locked' });
    await expect(createMagicLink(mockDb, mockEnv, input)).rejects.toThrow(/persist magic link/i);
  });
});

// ---------------------------------------------------------------------------
// verifyMagicLink
// ---------------------------------------------------------------------------
describe('verifyMagicLink', () => {
  const token = 'a'.repeat(64);
  const input = { token };

  it('returns email when a valid token is found', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'link-1',
      email: 'user@example.com',
      redirect_url: null,
      used: 0,
      expires_at: futureDate,
    });
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await verifyMagicLink(mockDb, input);
    expect(result.email).toBe('user@example.com');
    expect(result.redirect_url).toBeNull();
  });

  it('throws unauthorized when no matching link is found', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    await expect(verifyMagicLink(mockDb, input)).rejects.toThrow(AppError);

    mockDbQueryOne.mockResolvedValueOnce(null);
    await expect(verifyMagicLink(mockDb, input)).rejects.toThrow('Invalid or expired magic link');
  });

  it('throws unauthorized when the link is expired', async () => {
    const pastDate = new Date(Date.now() - 3_600_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'link-2',
      email: 'old@example.com',
      redirect_url: null,
      used: 0,
      expires_at: pastDate,
    });

    await expect(verifyMagicLink(mockDb, input)).rejects.toThrow('Magic link has expired');
  });

  it('marks the link as used after successful verification', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'link-3',
      email: 'mark@example.com',
      redirect_url: null,
      used: 0,
      expires_at: futureDate,
    });
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    await verifyMagicLink(mockDb, input);

    // Compare-and-swap: the WHERE gates on `used = 0` so consumption is atomic.
    expect(mockDbUpdate).toHaveBeenCalledWith(
      mockDb,
      'magic_links',
      expect.objectContaining({ used: 1 }),
      'id = ? AND used = 0',
      ['link-3'],
    );
  });

  it('throws "already been used" when the CAS consumes 0 rows (race/replay — no 2nd session)', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'link-race',
      email: 'race@example.com',
      redirect_url: null,
      used: 0,
      expires_at: futureDate,
    });
    // A concurrent verify flipped used 0→1 between our SELECT and UPDATE → changes 0.
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 0 });
    await expect(verifyMagicLink(mockDb, input)).rejects.toThrow(/already been used/i);
  });

  it('throws on a dropped mark-used write (never mint a session on a swallowed consume error)', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'link-boom',
      email: 'boom@example.com',
      redirect_url: null,
      used: 0,
      expires_at: futureDate,
    });
    mockDbUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: database is locked', changes: 0 });
    await expect(verifyMagicLink(mockDb, input)).rejects.toThrow(/consume magic link/i);
  });
});

// ---------------------------------------------------------------------------
// sendEmail fallback behavior
// ---------------------------------------------------------------------------
describe('sendEmail fallback (SES → SendGrid)', () => {
  // Resend removed 2026-09-09 (Brian directive) — SES is primary, SendGrid break-glass.
  const input = { email: 'fallback@example.com' };
  const sesCreds = {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret-key',
    AWS_REGION: 'us-east-1',
    SES_FROM_EMAIL: 'noreply@projectsites.dev',
  };

  beforeEach(() => {
    mockDbInsert.mockResolvedValue({ error: null });
  });

  it('falls back to SendGrid when the SES rail returns a non-200 status', async () => {
    const envWithBoth = { ...mockEnv, ...sesCreds, SENDGRID_API_KEY: 'test-sendgrid-key' } as any;

    const mockFetch = jest
      .fn()
      // First call (SES) → 403 error
      .mockResolvedValueOnce(new Response('Email address is not verified', { status: 403 }))
      // Second call (SendGrid) → 202 success
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    global.fetch = mockFetch;

    const result = await createMagicLink(mockDb, envWithBoth, input);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);

    // SES tried first, then SendGrid as the break-glass fallback
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain('amazonaws.com');
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.sendgrid.com/v3/mail/send');
  });

  it('uses only SES when it succeeds', async () => {
    const envSes = { ...mockEnv, ...sesCreds, SENDGRID_API_KEY: 'test-sendgrid-key' } as any;

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ MessageId: 'msg-1' }), { status: 200 }));
    global.fetch = mockFetch;

    await createMagicLink(mockDb, envSes, input);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('amazonaws.com');
  });

  it('is BEST-EFFORT on email failure — resolves (never 500s the login) when the provider errors', async () => {
    // SES configured but every rail errors — the send must still not 500 the login.
    const envSesOnly = { ...mockEnv, ...sesCreds } as any;

    global.fetch = jest.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    // The magic_links row IS the credential and is persisted BEFORE the send, so a
    // provider error must NOT throw — the route's documented fail-open contract.
    // (Previously the uncaught await surfaced a mail error as a 500 on login.)
    const result = await createMagicLink(mockDb, envSesOnly, input);
    expect(typeof result.token).toBe('string');
    expect(() => new Date(result.expires_at).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createGoogleOAuthState
// ---------------------------------------------------------------------------
describe('createGoogleOAuthState', () => {
  beforeEach(() => {
    mockDbInsert.mockResolvedValue({ error: null });
  });

  it('returns an authUrl containing accounts.google.com', async () => {
    const result = await createGoogleOAuthState(mockDb, mockEnv);
    expect(result.authUrl).toContain('accounts.google.com');
  });

  it('returns a hex state string', async () => {
    const result = await createGoogleOAuthState(mockDb, mockEnv);
    expect(result.state).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the state in the oauth_states table', async () => {
    const result = await createGoogleOAuthState(mockDb, mockEnv);

    expect(mockDbInsert).toHaveBeenCalledWith(
      mockDb,
      'oauth_states',
      expect.objectContaining({
        state: result.state,
        provider: 'google',
      }),
    );
  });

  it('THROWS on a dropped oauth_states insert — never redirect to Google with a state that cannot validate', async () => {
    // A swallowed insert error would redirect the user to Google with a state that has
    // no DB row → they authenticate, return, and hit "Invalid OAuth state".
    mockDbInsert.mockResolvedValue({ error: 'D1_ERROR: database is locked' });
    await expect(createGoogleOAuthState(mockDb, mockEnv)).rejects.toThrow(
      /persist Google OAuth state/i,
    );
  });
});

// ---------------------------------------------------------------------------
// createGitHubOAuthState
// ---------------------------------------------------------------------------
describe('createGitHubOAuthState', () => {
  const ghEnv = { ...mockEnv, GITHUB_CLIENT_ID: 'gh-client-id' } as any;
  beforeEach(() => {
    mockDbInsert.mockResolvedValue({ error: null });
  });

  it('stores a github-provider state and returns a github.com authUrl', async () => {
    const result = await createGitHubOAuthState(mockDb, ghEnv);
    expect(result.authUrl).toContain('github.com/login/oauth/authorize');
    expect(mockDbInsert).toHaveBeenCalledWith(
      mockDb,
      'oauth_states',
      expect.objectContaining({ state: result.state, provider: 'github' }),
    );
  });

  it('THROWS on a dropped oauth_states insert (same dead-redirect guard as Google)', async () => {
    mockDbInsert.mockResolvedValue({ error: 'D1_ERROR: database is locked' });
    await expect(createGitHubOAuthState(mockDb, ghEnv)).rejects.toThrow(
      /persist GitHub OAuth state/i,
    );
  });
});

// ---------------------------------------------------------------------------
// handleGoogleOAuthCallback
// ---------------------------------------------------------------------------
describe('handleGoogleOAuthCallback', () => {
  it('returns email and user info on successful callback', async () => {
    const futureDate = new Date(Date.now() + 600_000).toISOString();

    // dbQueryOne: find state
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'state-1',
      state: 'valid-state',
      expires_at: futureDate,
    });
    // dbExecute: delete used state
    mockDbExecute.mockResolvedValueOnce({ error: null, changes: 1 });

    // global.fetch: token exchange
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'mock-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      // global.fetch: userinfo
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            email: 'google-user@gmail.com',
            name: 'Google User',
            picture: 'https://example.com/avatar.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const result = await handleGoogleOAuthCallback(mockDb, mockEnv, 'auth-code', 'valid-state');

    expect(result.email).toBe('google-user@gmail.com');
    expect(result.display_name).toBe('Google User');
    expect(result.avatar_url).toBe('https://example.com/avatar.jpg');
  });

  it('throws unauthorized when the state is not found', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    await expect(handleGoogleOAuthCallback(mockDb, mockEnv, 'code', 'bad-state')).rejects.toThrow(
      'Invalid OAuth state',
    );
  });

  it('throws unauthorized when the state is expired', async () => {
    const pastDate = new Date(Date.now() - 600_000).toISOString();

    mockDbQueryOne.mockResolvedValueOnce({
      id: 'state-2',
      state: 'expired-state',
      expires_at: pastDate,
    });

    await expect(
      handleGoogleOAuthCallback(mockDb, mockEnv, 'code', 'expired-state'),
    ).rejects.toThrow('OAuth state expired');
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------
describe('createSession', () => {
  beforeEach(() => {
    mockDbInsert.mockResolvedValue({ error: null });
  });

  it('returns a 64-character hex token and expires_at', async () => {
    const result = await createSession(mockDb, 'user-id-1');

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('creates a session record in the sessions table', async () => {
    await createSession(mockDb, 'user-id-2', 'Chrome on macOS', '192.168.1.1');

    expect(mockDbInsert).toHaveBeenCalledWith(
      mockDb,
      'sessions',
      expect.objectContaining({
        user_id: 'user-id-2',
        device_info: 'Chrome on macOS',
        ip_address: '192.168.1.1',
      }),
    );
  });

  it('THROWS on a dropped session insert (no broken-token lying-success)', async () => {
    // dbInsert RETURNS { error } — a bare await would return a valid token for a
    // session that was never persisted → the user 401s on every subsequent request.
    mockDbInsert.mockResolvedValue({ error: 'D1_ERROR: database is locked' });
    await expect(createSession(mockDb, 'user-id-3')).rejects.toThrow(/persist session/i);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------
describe('getSession', () => {
  const token = 'b'.repeat(64);

  it('returns session data for a valid token', async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();

    mockDbQueryOne.mockResolvedValueOnce({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: futureDate,
    });
    mockDbUpdate.mockResolvedValueOnce({ error: null, changes: 1 }); // update last_active_at

    const result = await getSession(mockDb, token);

    expect(result).toEqual({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: futureDate,
    });
  });

  it('returns null when no session matches the token', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null);

    const result = await getSession(mockDb, token);
    expect(result).toBeNull();
  });

  it('returns null when the session is expired', async () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();

    mockDbQueryOne.mockResolvedValueOnce({
      id: 'sess-2',
      user_id: 'user-2',
      expires_at: pastDate,
    });

    const result = await getSession(mockDb, token);
    expect(result).toBeNull();
  });

  it('refreshes last_active_at when it is stale/absent (and returns the 3-field shape)', async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    mockDbUpdate.mockClear();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'sess-3',
      user_id: 'user-3',
      expires_at: futureDate,
      last_active_at: null, // never stamped → stale
    });
    const result = await getSession(mockDb, token);
    expect(result).toEqual({ id: 'sess-3', user_id: 'user-3', expires_at: futureDate });
    expect(mockDbUpdate).toHaveBeenCalledTimes(1); // stale → write fires
  });

  it('SKIPS the last_active_at write when it was refreshed recently (hot-path optimization)', async () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    mockDbUpdate.mockClear();
    mockDbQueryOne.mockResolvedValueOnce({
      id: 'sess-4',
      user_id: 'user-4',
      expires_at: futureDate,
      last_active_at: new Date(Date.now() - 1000).toISOString(), // 1s ago → fresh
    });
    const result = await getSession(mockDb, token);
    expect(result).toEqual({ id: 'sess-4', user_id: 'user-4', expires_at: futureDate });
    expect(mockDbUpdate).not.toHaveBeenCalled(); // fresh → no write on the hot path
  });
});

// ---------------------------------------------------------------------------
// revokeSession
// ---------------------------------------------------------------------------
describe('revokeSession', () => {
  it('calls dbUpdate with deleted_at set on the sessions table', async () => {
    mockDbUpdate.mockResolvedValue({ error: null, changes: 1 });

    await revokeSession(mockDb, 'sess-to-revoke');

    expect(mockDbUpdate).toHaveBeenCalledWith(
      mockDb,
      'sessions',
      expect.objectContaining({
        deleted_at: expect.any(String),
      }),
      'id = ?',
      ['sess-to-revoke'],
    );
  });

  it('passes a valid ISO date as deleted_at', async () => {
    mockDbUpdate.mockResolvedValue({ error: null, changes: 1 });

    await revokeSession(mockDb, 'sess-99');

    const updates = mockDbUpdate.mock.calls[0][2] as Record<string, unknown>;
    expect(updates.deleted_at).toBeDefined();
    // updated_at is added internally by dbUpdate, not by the service
    expect(() => new Date(updates.deleted_at as string).toISOString()).not.toThrow();
  });

  it('THROWS on a failed revoke — a security lying-success (session stays valid) is unacceptable', async () => {
    mockDbUpdate.mockResolvedValue({ error: 'D1_ERROR: database is locked', changes: 0 });
    await expect(revokeSession(mockDb, 'sess-x')).rejects.toThrow(/revoke session/i);
  });

  it('does NOT throw on changes===0 (already-revoked/absent row is idempotent success)', async () => {
    mockDbUpdate.mockResolvedValue({ error: null, changes: 0 });
    await expect(revokeSession(mockDb, 'sess-already-gone')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// revokeOtherUserSessions
// ---------------------------------------------------------------------------
describe('revokeOtherUserSessions', () => {
  it('revokes every OTHER session and returns the ACTUAL revoked count', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [
        { id: 's1', token_hash: 'h1' },
        { id: 's2', token_hash: 'h2' },
        { id: 's3', token_hash: 'h3' },
      ],
      error: null,
    });
    mockDbUpdate.mockResolvedValue({ error: null, changes: 1 });

    // No currentToken → currentHash null → revoke ALL listed sessions.
    const n = await revokeOtherUserSessions(mockDb, 'user-1');
    expect(n).toBe(3);
    expect(mockDbUpdate).toHaveBeenCalledTimes(3);
  });

  it('THROWS with actual/total when a revoke fails mid-loop (no silent partial success)', async () => {
    mockDbQuery.mockResolvedValueOnce({
      data: [
        { id: 's1', token_hash: 'h1' },
        { id: 's2', token_hash: 'h2' },
      ],
      error: null,
    });
    mockDbUpdate
      .mockResolvedValueOnce({ error: null, changes: 1 }) // s1 revoked
      .mockResolvedValueOnce({ error: 'D1_ERROR', changes: 0 }); // s2 fails

    // The old code returned `others.length` (=2) even though only 1 revoked. Now it
    // revokes what it can and surfaces the partial failure so the caller retries.
    await expect(revokeOtherUserSessions(mockDb, 'user-1')).rejects.toThrow(/1\/2|failed/i);
  });
});

// ---------------------------------------------------------------------------
// getUserSessions
// ---------------------------------------------------------------------------
describe('getUserSessions', () => {
  it('returns an empty array when no sessions exist', async () => {
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });

    const result = await getUserSessions(mockDb, 'user-no-sessions');
    expect(result).toEqual([]);
  });

  it('returns active sessions for the given user', async () => {
    const sessions = [
      {
        id: 's1',
        device_info: 'Firefox',
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      {
        id: 's2',
        device_info: null,
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ];
    mockDbQuery.mockResolvedValueOnce({ data: sessions, error: null });

    const result = await getUserSessions(mockDb, 'user-with-sessions');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('s1');
    expect(result[1].device_info).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findOrCreateUser — ATOMIC first-login account creation (users+orgs+memberships)
// ---------------------------------------------------------------------------
describe('findOrCreateUser', () => {
  // A D1 mock exposing prepare()/batch() so the SUT's atomic 3-table create is
  // observable. `batchThrows` simulates a failed transaction (rolls back → nothing
  // recorded), mirroring the iter 17-22 atomicity-test pattern.
  function batchDb(opts: { batchThrows?: boolean } = {}): { db: D1Database; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const db = {
      prepare: (_sql: string) => ({ bind: (...args: unknown[]) => ({ _args: args }) }),
      batch: async (stmts: Array<{ _args: unknown[] }>) => {
        if (opts.batchThrows) throw new Error('D1_ERROR: simulated batch failure');
        calls.push(stmts.map((s) => s._args));
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    return { db, calls };
  }

  it('returns the existing user + org WITHOUT creating (no batch) when the email is known', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce({ id: 'u-existing', email: 'known@x.co' }) // user lookup
      .mockResolvedValueOnce({ org_id: 'org-existing' }); // membership lookup
    const { db, calls } = batchDb();
    const r = await findOrCreateUser(db, { email: 'known@x.co' });
    expect(r).toEqual({ user_id: 'u-existing', org_id: 'org-existing', is_new: false });
    expect(calls.length).toBe(0); // existing user must not trigger any write
  });

  it('creates user+org+membership in ONE atomic db.batch (3 statements) for a new email', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null); // no existing user
    const { db, calls } = batchDb();
    const r = await findOrCreateUser(db, { email: 'new@x.co', display_name: 'New' });
    expect(r.is_new).toBe(true);
    expect(r.user_id).toBeTruthy();
    expect(r.org_id).toBeTruthy();
    expect(calls.length).toBe(1); // exactly one atomic batch
    expect(calls[0].length).toBe(3); // batch has all 3 inserts (users, orgs, memberships)
  });

  it('THROWS (rolls back — no phantom user/org) when the atomic batch fails', async () => {
    // Previously three sequential bare-await inserts: a dropped write left an orphaned
    // org + a session for a user whose row never persisted. The atomic batch rejects
    // → the login handler surfaces a retryable 500, never a half-created account.
    mockDbQueryOne.mockResolvedValueOnce(null);
    const { db } = batchDb({ batchThrows: true });
    await expect(findOrCreateUser(db, { email: 'boom@x.co' })).rejects.toThrow(/batch|D1_ERROR/i);
  });
});
