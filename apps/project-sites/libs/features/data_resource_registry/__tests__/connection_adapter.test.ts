/**
 * TDD tests for the connection adapter (Connections READ slice — Data & Resource Platform §8a).
 *
 * A connection is NOT a Cloudflare account object — it lives in the platform's own D1 (`mcp_connections`),
 * so this adapter reads `scope.db` (NOT the CF REST API), ALWAYS filtered by the OWNED site id in
 * `scope.resourceId`. Uses the swc-jest global-jest convention (NO `import { jest }`); a fake D1 stub
 * captures every SQL + bind so isolation is asserted structurally.
 *
 * Contracts under test:
 *   (a) list() returns id/name/type/masked-host/status for the site's connections + an honest count
 *   (b) ⛔ NO credential/password/token/connection-string field is EVER returned (the load-bearing invariant)
 *   (c) list() SELECT never names a `*_encrypted` column AND always binds scope.resourceId (site isolation)
 *   (d) head() returns { exists, count } from a COUNT; empty site → exists:false, count:0 (honest empty)
 *   (e) get() binds BOTH the site id AND the connection id (a foreign connection can't be read)
 *   (f) get() of a missing id → honest found:false (never an error); secretsRedacted:true always
 *   (g) honest not_registered when no db is attached (no connection store) — never a fabricated row
 *   (h) maskHost() reduces a full host to a mask (never the full endpoint)
 *   (i) mutate() returns code 'not_implemented' (never throws)
 */

// ─── No external module mocks needed — the adapter only touches scope.db (a stub) ──

import { connectionAdapter, maskHost } from '../adapters/connection.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fake D1 ────────────────────────────────────────────────────────────────────

interface Captured {
  sql: string;
  binds: unknown[];
}

/**
 * Build a fake D1Database that records every prepared SQL + bind and returns a scripted result. `all()`
 * serves `rows`; `first()` serves `firstRow`. `throwOn` makes a matching SQL throw (to test the error path).
 */
function fakeDb(opts: {
  rows?: unknown[];
  firstRow?: unknown;
  captured: Captured[];
  throwOn?: RegExp;
}): { db: D1Database } {
  const db = {
    prepare(sql: string) {
      if (opts.throwOn && opts.throwOn.test(sql)) {
        throw new Error('boom');
      }
      const rec: Captured = { binds: [], sql };
      const stmt = {
        bind(...binds: unknown[]) {
          rec.binds = binds;
          opts.captured.push(rec);
          return stmt;
        },
        async all<T>() {
          return { results: (opts.rows ?? []) as T[] };
        },
        async first<T>() {
          return (opts.firstRow ?? null) as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db };
}

/** A scope for the connection adapter — resourceId is the OWNED SITE ID (never a CF id), db attached. */
function scopeWith(db: D1Database | undefined): ResolvedScope {
  return {
    accessPolicy: 'read_only',
    accountId: 'acct-1',
    auth: undefined as never,
    db,
    environment: 'production',
    orgId: 'org-1',
    resourceId: 'site-abc', // the OWNED site id — this is what every query MUST bind
    siteId: 'site-abc',
  };
}

/** A raw mcp_connections row (secret columns deliberately absent — the adapter never selects them). */
const rawRow = {
  account_metadata_json: JSON.stringify({ host: 'db-primary.internal.example.com', portalId: 42 }),
  connected_at: '2026-09-01T00:00:00Z',
  display_name: 'Prod Postgres',
  id: 'conn-1',
  provider: 'postgres',
  status: 'active',
  updated_at: '2026-09-20T00:00:00Z',
};

/**
 * Secret-ish JSON KEYS that must NEVER appear in a returned payload. Matched as a quoted JSON key
 * (`"key":`) so the honesty flag `secretsRedacted:true` (a legitimate field) is not a false positive on
 * the substring `secret`.
 */
const SECRET_KEYS = [
  'access_token_encrypted',
  'refresh_token_encrypted',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'token',
  'password',
  'connectionString',
  'connection_string',
  'dsn',
];

/** Deep-scan any value for a forbidden key, a leaked secret value, OR the raw (unmasked) host string. */
function assertNoSecrets(value: unknown): void {
  const seen = JSON.stringify(value ?? {});
  for (const k of SECRET_KEYS) {
    expect(seen).not.toContain(`"${k}"`);
  }
  // No secret VALUE from a fixture leaked.
  expect(seen).not.toContain('ENC(');
  expect(seen).not.toContain('hunter2');
  expect(seen).not.toContain('live_sk_');
  // The FULL host must never appear — only a mask may. (`db-primary.internal.example.com` is the raw host.)
  expect(seen).not.toContain('db-primary.internal.example.com');
  expect(seen).not.toContain('internal.example.com');
}

// ─── (h) maskHost ────────────────────────────────────────────────────────────────

describe('maskHost()', () => {
  it('(h) masks a multi-label host to first-2 + registrable tail, never the full endpoint', () => {
    expect(maskHost('db-primary.internal.example.com')).toBe('db…example.com');
    expect(maskHost('db-primary.internal.example.com')).not.toContain('primary');
  });
  it('(h) masks a short/opaque host to a single-char hint', () => {
    expect(maskHost('example.com')).toBe('e…');
    expect(maskHost('localhost')).toBe('l…');
  });
  it('(h) returns undefined for an empty/absent host (never fabricated)', () => {
    expect(maskHost('')).toBeUndefined();
    expect(maskHost(undefined)).toBeUndefined();
    expect(maskHost(null)).toBeUndefined();
  });
});

// ─── (i) mutate() ─────────────────────────────────────────────────────────────────

describe('connectionAdapter.mutate()', () => {
  it('(i) returns not_implemented — never throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await connectionAdapter.mutate(scopeWith(undefined), undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_implemented');
    expect(result.error?.retryable).toBe(false);
  });
});

// ─── (a)(b)(c) list() ──────────────────────────────────────────────────────────────

describe('connectionAdapter.list()', () => {
  it('(a) returns id/name/type/masked-host/status + honest count', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, rows: [rawRow] });
    const result = await connectionAdapter.list(scopeWith(db));
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(1);
    const c = result.data?.connections[0];
    expect(c?.id).toBe('conn-1');
    expect(c?.name).toBe('Prod Postgres');
    expect(c?.type).toBe('postgres');
    expect(c?.status).toBe('active');
    // Host is MASKED, never the full endpoint.
    expect(c?.maskedHost).toBe('db…example.com');
  });

  it('(b) ⛔ NEVER returns a credential/password/token/connection-string field', async () => {
    const captured: Captured[] = [];
    // Even if the DB row somehow carried secret-ish extra keys, the adapter's typed reshape drops them.
    const rowWithSecrets = {
      ...rawRow,
      access_token_encrypted: 'ENC(shhh)',
      password: 'hunter2',
    };
    const { db } = fakeDb({ captured, rows: [rowWithSecrets] });
    const result = await connectionAdapter.list(scopeWith(db));
    expect(result.ok).toBe(true);
    assertNoSecrets(result.data);
  });

  it('(c) SELECT never names a *_encrypted column AND binds scope.resourceId (site isolation)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, rows: [rawRow] });
    await connectionAdapter.list(scopeWith(db));
    const sql = captured[0].sql;
    // The secret columns are DELIBERATELY never selected.
    expect(sql).not.toMatch(/access_token_encrypted/);
    expect(sql).not.toMatch(/refresh_token_encrypted/);
    // Always filtered by site_id, bound to the scope's resourceId (the OWNED site id).
    expect(sql).toMatch(/WHERE site_id = \?/);
    expect(captured[0].binds).toEqual(['site-abc']);
  });

  it('(a) blank site → empty connections + count 0 (honest empty, never an error)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, rows: [] });
    const result = await connectionAdapter.list(scopeWith(db));
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.connections).toEqual([]);
  });

  it('a DB failure → typed retryable error (never "gone", never a leak)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, throwOn: /SELECT/ });
    const result = await connectionAdapter.list(scopeWith(db));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('db_query_failed');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── (d) head() ───────────────────────────────────────────────────────────────────

describe('connectionAdapter.head()', () => {
  it('(d) returns { exists:true, count } from the COUNT, bound to the site id', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, firstRow: { n: 3 } });
    const result = await connectionAdapter.head(scopeWith(db));
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.count).toBe(3);
    expect(captured[0].sql).toMatch(/COUNT\(\*\)/);
    expect(captured[0].binds).toEqual(['site-abc']);
  });

  it('(d) empty site → exists:false, count:0 (honest empty)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, firstRow: { n: 0 } });
    const result = await connectionAdapter.head(scopeWith(db));
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    expect(result.data?.count).toBe(0);
  });
});

// ─── (e)(f)(b) get() ───────────────────────────────────────────────────────────────

describe('connectionAdapter.get()', () => {
  it('(e) binds BOTH the site id AND the connection id (foreign connection unreadable)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, firstRow: rawRow });
    await connectionAdapter.get(scopeWith(db), { id: 'conn-1' });
    const rec = captured[0];
    expect(rec.sql).toMatch(/WHERE site_id = \? AND id = \?/);
    // site id first, connection id second — both bound, so a foreign row can't be reached.
    expect(rec.binds).toEqual(['site-abc', 'conn-1']);
  });

  it('(b) get() ⛔ NEVER returns a credential; secretsRedacted:true always', async () => {
    const captured: Captured[] = [];
    const rowWithSecrets = { ...rawRow, access_token_encrypted: 'ENC(x)', token: 'live_sk_x' };
    const { db } = fakeDb({ captured, firstRow: rowWithSecrets });
    const result = await connectionAdapter.get(scopeWith(db), { id: 'conn-1' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.secretsRedacted).toBe(true);
    expect(result.data?.connection?.maskedHost).toBe('db…example.com');
    assertNoSecrets(result.data);
  });

  it('(f) missing id → honest found:false (never an error), secretsRedacted:true', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, firstRow: null });
    const result = await connectionAdapter.get(scopeWith(db), { id: 'nope' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.connection).toBeUndefined();
    expect(result.data?.secretsRedacted).toBe(true);
  });

  it('empty id → invalid_id error (never queries)', async () => {
    const captured: Captured[] = [];
    const { db } = fakeDb({ captured, firstRow: rawRow });
    const result = await connectionAdapter.get(scopeWith(db), { id: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_id');
    expect(captured).toHaveLength(0);
  });
});

// ─── (g) not_registered when no db is attached ─────────────────────────────────────

describe('connectionAdapter — honest not_registered (no connection store)', () => {
  it('(g) list/head/get all return not_registered when scope.db is absent (never a fabricated row)', async () => {
    const noDb = scopeWith(undefined);
    const list = await connectionAdapter.list(noDb);
    const head = await connectionAdapter.head(noDb);
    const get = await connectionAdapter.get(noDb, { id: 'conn-1' });
    for (const r of [list, head, get]) {
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_registered');
    }
    // Nothing fabricated.
    expect(list.data).toBeUndefined();
  });
});
