/**
 * TDD specs for campaign lane-2 (fire-57) — two code-proven defects in the
 * MCP OAuth 2.1 authorization server (CAMPAIGN-cf-native-ai.md §6):
 *
 * DEFECT 1 — grant-mint escalation: authorize validated requested scopes only
 * against the static OAUTH_ALLOWED_SCOPES allowlist; the PRESENTER's own
 * authority was never intersected, so ANY valid org bearer could mint a
 * 90-day sites:write token. Pinned here: grantable = requested ∩ presenter,
 * empty ⇒ invalid_scope; subset minted on partial overlap; session presenters
 * resolve through the org-membership RBAC role; defensive re-intersection at
 * exchange (minted child token ≤ presenter snapshot).
 *
 * DEFECT 2 — non-atomic consumeCode: the KV get+delete pair let two
 * simultaneous exchanges of ONE code both succeed. Pinned here: the D1
 * atomic claim (`UPDATE … SET used_at WHERE used_at IS NULL AND expires_at >
 * now` → meta.changes === 1) — two parallel exchanges mint exactly one token;
 * expired / already-used codes → invalid_grant; the auth-code path leaves KV
 * entirely and stores only the SHA-256 of the code.
 *
 * Harness mirrors the sibling oauth_provider.test.ts (mocked flag gate +
 * api_tokens service) plus the real-SQLite pattern: `node:sqlite`
 * DatabaseSync behind a D1-shaped adapter, schema loaded from the ACTUAL
 * 0649 migration file — so the atomic UPDATE runs against real SQL, not a
 * call recorder. The seeding SHA-256 helper is implemented locally so it
 * independently cross-checks the service's hashing.
 */
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockVerify = jest.fn();
const mockCreate = jest.fn();
jest.mock('../../../../src/services/api_tokens.js', () => ({
  verifyApiToken: (...a: unknown[]) => mockVerify(...a),
  extractBearerToken: (h: string | null) => (h ? h.replace(/^Bearer\s+/i, '') : null),
  createApiToken: (...a: unknown[]) => mockCreate(...a),
  hasScope: () => true,
}));

import { oauthProvider } from '../handlers.js';

// ── Real-SQLite D1 harness — schema from the ACTUAL migration ────────────────
const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../../migrations/0650_mcp_oauth_codes.sql'),
  'utf8',
);

/** Minimal memberships table for the session-presenter role lookup. */
const MEMBERSHIPS_DDL = `CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  deleted_at TEXT
);`;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION_SQL);
  db.exec(MEMBERSHIPS_DDL);
  return db;
}

/** D1-shaped adapter over node:sqlite — prepare().bind().run()/.first() with meta.changes. */
function makeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async run() {
          const info = db.prepare(sql).run(...(bound as never[]));
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
        async first<T>() {
          return (db.prepare(sql).get(...(bound as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
      };
      return api;
    },
  };
}

// ── KV mock (clients only — codes must NOT touch KV any more) ────────────────
function makeKv(store: Map<string, string> = new Map()) {
  return {
    put: jest.fn(async (key: string, val: string, _opts?: unknown) => {
      store.set(key, val);
    }),
    get: jest.fn(async (key: string, type: string) => {
      const raw = store.get(key);
      if (!raw) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    }),
    delete: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

type Session = { userId: string; orgId: string };

/** App with an optional session-injection middleware mirroring authMiddleware's contract. */
function makeApp(session?: Session) {
  const a = new Hono<{ Variables: { userId?: string; orgId?: string } }>();
  if (session) {
    a.use('*', async (c, next) => {
      c.set('userId', session.userId);
      c.set('orgId', session.orgId);
      await next();
    });
  }
  a.route('/', oauthProvider);
  return a;
}

const envOf = (kv: ReturnType<typeof makeKv>, db?: DatabaseSync) =>
  ({ CACHE_KV: kv, DB: db ? makeD1(db) : undefined } as never);

/** Local, service-independent SHA-256 hex (cross-checks the module's hashing). */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** base64url(SHA-256(verifier)) — real PKCE S256. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const VERIFIER = 'pkce_verifier_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REDIRECT = 'https://example.com/cb';
const CLIENT_ID = 'client-lane2';

function seedClient(store: Map<string, string>): void {
  store.set(
    `oauth_client:${CLIENT_ID}`,
    JSON.stringify({ client_id: CLIENT_ID, redirect_uris: [REDIRECT], created_at: 0 }),
  );
}

/** Direct D1 seed of a code row (for expired/used/tampered cases the endpoint can't mint). */
async function seedCodeRow(
  db: DatabaseSync,
  code: string,
  overrides: Partial<{
    scope: string;
    presenter_scopes: string;
    expires_at: number;
    used_at: number | null;
    code_challenge: string;
  }> = {},
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO mcp_oauth_codes (code_hash, org_id, client_id, scope, presenter_scopes, code_challenge, redirect_uri, created_by_token_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await sha256Hex(code),
    'org-1',
    CLIENT_ID,
    overrides.scope ?? 'sites:read',
    overrides.presenter_scopes ?? 'sites:read',
    overrides.code_challenge ?? (await s256(VERIFIER)),
    REDIRECT,
    'tok-1',
    overrides.expires_at ?? now + 300,
    overrides.used_at ?? null,
    now,
  );
}

function authorizeBody(scope: string, challenge: string) {
  return {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-lane2',
  };
}

function exchangeBody(code: string) {
  return {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  };
}

beforeEach(() => {
  mockIsFlagOn.mockReset();
  mockVerify.mockReset();
  mockCreate.mockReset();
  mockIsFlagOn.mockResolvedValue(true);
  mockCreate.mockResolvedValue({
    token: { id: 'tok-new', org_id: 'org-1' },
    plaintext: 'psk_minted',
  });
});

// ─────────────────────────────────────────────────────────────
// DEFECT 1 — presenter-scope intersection at authorize
// ─────────────────────────────────────────────────────────────
describe('POST /api/oauth/authorize — presenter-scope intersection', () => {
  it('(a) low-scope psk_ presenter requesting sites:write → invalid_scope, no code row', async () => {
    mockVerify.mockResolvedValue({ org_id: 'org-1', id: 'tok-low', scopes: '["sites:read"]' });
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    const challenge = await s256(VERIFIER);

    const res = await makeApp().request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer psk_low' },
        body: JSON.stringify(authorizeBody('sites:write', challenge)),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    const count = db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_codes').get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it('(a2) session presenter with viewer role requesting sites:write → invalid_scope', async () => {
    // No bearer — the consent page presents the signed-in SESSION (authMiddleware
    // populates userId/orgId). A viewer holds site:read only per the shared RBAC
    // model, so sites:write must not be grantable.
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    db.prepare(
      `INSERT INTO memberships (id, org_id, user_id, role) VALUES ('m1', 'org-1', 'user-1', 'viewer')`,
    ).run();
    const challenge = await s256(VERIFIER);

    const res = await makeApp({ userId: 'user-1', orgId: 'org-1' }).request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authorizeBody('sites:write', challenge)),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
  });

  it('(a3) session presenter with owner role gets the full requested set (consent flow works)', async () => {
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    db.prepare(
      `INSERT INTO memberships (id, org_id, user_id, role) VALUES ('m1', 'org-1', 'user-9', 'owner')`,
    ).run();
    const challenge = await s256(VERIFIER);

    const res = await makeApp({ userId: 'user-9', orgId: 'org-1' }).request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authorizeBody('sites:read sites:write', challenge)),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT scope, presenter_scopes, org_id FROM mcp_oauth_codes')
      .get() as { scope: string; presenter_scopes: string; org_id: string };
    expect(row.scope).toBe('sites:read sites:write');
    expect(row.presenter_scopes).toBe('sites:read sites:write');
    expect(row.org_id).toBe('org-1');
  });

  it('(a4) no bearer and no session → 401', async () => {
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    const challenge = await s256(VERIFIER);

    const res = await makeApp().request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authorizeBody('sites:read', challenge)),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(401);
  });

  it('(b) partial overlap narrows the grant: subset stored, subset minted at exchange', async () => {
    mockVerify.mockResolvedValue({ org_id: 'org-1', id: 'tok-ro', scopes: '["sites:read"]' });
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    const challenge = await s256(VERIFIER);
    const app = makeApp();

    // Requested read+write; presenter holds read only → grant narrows to read.
    const authRes = await app.request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer psk_ro' },
        body: JSON.stringify(authorizeBody('sites:read sites:write', challenge)),
      },
      envOf(kv, db),
    );
    expect(authRes.status).toBe(200);
    const { redirect_uri } = (await authRes.json()) as { redirect_uri: string };
    const code = new URL(redirect_uri).searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const row = db
      .prepare('SELECT scope, presenter_scopes FROM mcp_oauth_codes')
      .get() as { scope: string; presenter_scopes: string };
    expect(row.scope).toBe('sites:read');
    expect(row.presenter_scopes).toBe('sites:read');

    const tokRes = await app.request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exchangeBody(code)),
      },
      envOf(kv, db),
    );
    expect(tokRes.status).toBe(200);
    const tok = (await tokRes.json()) as { access_token: string; scope: string };
    expect(tok.access_token).toBe('psk_minted');
    expect(tok.scope).toBe('sites:read');
    // createApiToken minted ONLY the intersected subset — never sites:write.
    expect(mockCreate.mock.calls[0][3]).toEqual(['sites:read']);
  });

  it('(b2) exchange defensively re-intersects: a widened stored scope never out-mints the presenter snapshot', async () => {
    // Simulate a tampered/legacy row whose scope exceeds its presenter snapshot.
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    await seedCodeRow(db, 'code-tampered', {
      scope: 'sites:read sites:write',
      presenter_scopes: 'sites:read',
    });

    const res = await makeApp().request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exchangeBody('code-tampered')),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe('sites:read');
    expect(mockCreate.mock.calls[0][3]).toEqual(['sites:read']);
  });

  it('KV departure: authorize stores only the SHA-256 code hash in D1 and writes no oauth_code:* KV key', async () => {
    mockVerify.mockResolvedValue({
      org_id: 'org-1',
      id: 'tok-full',
      scopes: '["sites:read","sites:write"]',
    });
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    const challenge = await s256(VERIFIER);

    const res = await makeApp().request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer psk_full' },
        body: JSON.stringify(authorizeBody('sites:read', challenge)),
      },
      envOf(kv, db),
    );
    expect(res.status).toBe(200);
    const { redirect_uri } = (await res.json()) as { redirect_uri: string };
    const code = new URL(redirect_uri).searchParams.get('code') as string;

    // No KV write for the code — the auth-code path left KV entirely.
    expect([...store.keys()].filter((k) => k.startsWith('oauth_code:'))).toHaveLength(0);
    // D1 stores the HASH, never the plaintext.
    const row = db.prepare('SELECT code_hash FROM mcp_oauth_codes').get() as {
      code_hash: string;
    };
    expect(row.code_hash).toBe(await sha256Hex(code));
    expect(row.code_hash).not.toBe(code);
  });
});

// ─────────────────────────────────────────────────────────────
// DEFECT 2 — atomic D1 code consumption at exchange
// ─────────────────────────────────────────────────────────────
describe('POST /oauth/token — atomic single-use consumption', () => {
  it('(c) TWO parallel exchanges of one code → exactly one succeeds, one token minted', async () => {
    mockVerify.mockResolvedValue({
      org_id: 'org-1',
      id: 'tok-full',
      scopes: '["sites:read","sites:write"]',
    });
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    const challenge = await s256(VERIFIER);
    const app = makeApp();

    const authRes = await app.request(
      '/api/oauth/authorize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer psk_full' },
        body: JSON.stringify(authorizeBody('sites:read sites:write', challenge)),
      },
      envOf(kv, db),
    );
    expect(authRes.status).toBe(200);
    const { redirect_uri } = (await authRes.json()) as { redirect_uri: string };
    const code = new URL(redirect_uri).searchParams.get('code') as string;

    const fire = () =>
      app.request(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(exchangeBody(code)),
        },
        envOf(kv, db),
      );
    const [r1, r2] = await Promise.all([fire(), fire()]);

    const statuses = [r1.status, r2.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 400]);
    const loser = r1.status === 400 ? r1 : r2;
    expect(((await loser.json()) as { error: string }).error).toBe('invalid_grant');
    // Exactly ONE real psk_ token minted from the single-use grant.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The row is claimed exactly once.
    const row = db.prepare('SELECT used_at FROM mcp_oauth_codes').get() as {
      used_at: number | null;
    };
    expect(row.used_at).not.toBeNull();
  });

  it('(d1) expired code → invalid_grant, unclaimed, nothing minted', async () => {
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    await seedCodeRow(db, 'code-expired', {
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const res = await makeApp().request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exchangeBody('code-expired')),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    expect(mockCreate).not.toHaveBeenCalled();
    // The conditional claim must not flip used_at on an expired row.
    const row = db.prepare('SELECT used_at FROM mcp_oauth_codes').get() as {
      used_at: number | null;
    };
    expect(row.used_at).toBeNull();
  });

  it('(d2) already-used code → invalid_grant, nothing minted', async () => {
    const store = new Map<string, string>();
    seedClient(store);
    const kv = makeKv(store);
    const db = freshDb();
    await seedCodeRow(db, 'code-used', {
      used_at: Math.floor(Date.now() / 1000) - 5,
    });

    const res = await makeApp().request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exchangeBody('code-used')),
      },
      envOf(kv, db),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
