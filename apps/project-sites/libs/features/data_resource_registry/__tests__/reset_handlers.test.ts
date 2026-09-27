/**
 * Route-layer tests for the gated per-site GREENFIELD RESET (FIRE 8).
 *
 * The whole point is SAFETY + HONESTY, so the tests are adversarial:
 *   - flag off / unauthenticated / foreign site → 404 (never leak existence); CF never called
 *   - a resolved D1 that is a SHARED-PLATFORM id (FORBIDDEN_DB_IDS) → 409 FORBIDDEN_TARGET, NO wipe
 *   - execute without `confirm:true` → 409 CONFIRMATION_REQUIRED, NO wipe
 *   - execute with a wrong `confirmText` (not the slug, not "RESET") → 409, NO wipe
 *   - execute where the backup bookmark can't be taken → 424 BACKUP_FAILED, NO DROP
 *   - happy path → bookmark taken BEFORE any DROP, per-site D1/KV/R2 wiped, recovery bookmark returned
 *
 * All external deps are mocked. The real `resolveCfCredentials` runs with `orgId=null` (reads the
 * bundled CLOUDFLARE_* env). Uses the repo's `@swc/jest` convention: the GLOBAL `jest` (never the
 * `@jest/globals` import) so `jest.mock(...)` hoists above the handler import.
 */
import { Hono } from 'hono';

// ─── Mocks (must precede handler imports; global `jest` for @swc/jest hoisting) ──
const mockIsFlagOn = jest.fn();
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockAssertSiteOwned = jest.fn();
jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: (...a: unknown[]) => mockAssertSiteOwned(...a),
}));

const mockDbQueryOne = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
}));

const mockWriteAuditLog = jest.fn();
jest.mock('../../../../src/services/audit.js', () => ({
  writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a),
}));

import { dataResourceReset } from '../reset_handlers.js';
import { FORBIDDEN_DB_IDS, isForbiddenDbId } from '../site_resources.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const MASTER_DB_ID = 'ea3e839a-c641-4861-ae30-dfc63bff8032'; // the shared platform D1 — must be refused
const SITE_DB_ID = 'dedicated-site-d1-uuid-0001'; // a legitimate per-site dedicated D1
const ORG = 'org-1';
const SITE = 'site-1';

type AppEnv = {
  DB: unknown;
  CF_ACCOUNT_ID: string;
  CLOUDFLARE_EMAIL: string;
  CLOUDFLARE_API_KEY: string;
};

function appWith(orgId?: string, userId = 'user-1'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (orgId) c.set('orgId' as never, orgId as never);
    c.set('userId' as never, userId as never);
    await next();
  });
  app.route('/', dataResourceReset);
  return app;
}

function makeEnv(): AppEnv {
  return { DB: {}, CF_ACCOUNT_ID: 'acct-123', CLOUDFLARE_EMAIL: 'e@x.com', CLOUDFLARE_API_KEY: 'gk' };
}

async function post(app: Hono, path: string, body: unknown = {}): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    makeEnv() as never,
  );
}

/** An allocation row shape returned by the mocked `dbQueryOne` (resolveSiteResources). */
function allocRow(d1Id: string | null) {
  return {
    d1_database_id: d1Id,
    d1_database_name: d1Id ? `ps-site-${SITE}` : null,
    kv_namespace_id: 'kv-ns-1',
    kv_namespace_name: `ps-site-${SITE}-kv`,
    r2_bucket_name: `ps-site-${SITE}`,
  };
}

/**
 * A CF `fetch` stub. `bookmarkOk` toggles the Time-Travel bookmark success; every other CF call
 * (query list/count, kv keys, r2 objects, drops, bulk deletes) returns a benign success envelope.
 */
function stubFetch(opts: { bookmarkOk?: boolean } = {}): jest.Mock {
  const { bookmarkOk = true } = opts;
  return jest.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/time_travel/bookmark')) {
      return new Response(
        JSON.stringify(bookmarkOk ? { result: { bookmark: 'bk-123' } } : { result: {} }),
        { status: bookmarkOk ? 200 : 500 },
      );
    }
    if (u.includes('/query')) {
      // sqlite_master list → one table; COUNT(*) → n; DROP → empty ok.
      return new Response(JSON.stringify({ result: [{ results: [{ name: 'leads', n: 3 }] }] }), {
        status: 200,
      });
    }
    if (u.includes('/keys')) {
      return new Response(JSON.stringify({ result: [{ name: 'k1' }], result_info: {} }), {
        status: 200,
      });
    }
    if (u.includes('/objects')) {
      return new Response(
        JSON.stringify({ result: [{ key: 'o1' }], result_info: { is_truncated: false } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
  }) as unknown as jest.Mock;
}

describe('data_resource_registry — site_resources guard', () => {
  it('FORBIDDEN_DB_IDS contains the shared master + dev platform D1 ids', () => {
    expect(FORBIDDEN_DB_IDS.has(MASTER_DB_ID)).toBe(true);
    expect(FORBIDDEN_DB_IDS.has('f5b59818-c785-4807-8aca-282c9037c58c')).toBe(true);
  });

  it('isForbiddenDbId refuses the master id, an empty id, and an env-exposed id — but not a per-site id', () => {
    const env = { DB_ID: 'bound-platform-id' } as never;
    expect(isForbiddenDbId(env, MASTER_DB_ID)).toBe(true);
    expect(isForbiddenDbId(env, '')).toBe(true);
    expect(isForbiddenDbId(env, 'bound-platform-id')).toBe(true);
    expect(isForbiddenDbId(env, SITE_DB_ID)).toBe(false);
  });
});

describe('POST /api/sites/:siteId/data/reset — gating', () => {
  beforeEach(() => {
    mockIsFlagOn.mockReset();
    mockAssertSiteOwned.mockReset();
    mockDbQueryOne.mockReset();
    mockWriteAuditLog.mockReset().mockResolvedValue(undefined);
  });

  it('404s when the flag is off (never leaks existence); CF never called', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const fetchSpy = stubFetch();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset`, {
      confirm: true,
      confirmText: 'RESET',
    });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404s when the site is foreign / not owned', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(false);
    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset`, {
      confirm: true,
      confirmText: 'RESET',
    });
    expect(res.status).toBe(404);
  });

  it('REFUSES (409 FORBIDDEN_TARGET) when the resolved per-site D1 is a shared-platform id — NO wipe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    // The allocation (mis-provisioned / tampered) points at the MASTER platform D1.
    mockDbQueryOne.mockResolvedValue(allocRow(MASTER_DB_ID));
    const fetchSpy = stubFetch();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset`, {
      confirm: true,
      confirmText: 'RESET',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('FORBIDDEN_TARGET');
    // Hard proof: not a single CF call fired — no bookmark, no DROP, no delete.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires confirm:true — a POST without it is 409 CONFIRMATION_REQUIRED, NO wipe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue(allocRow(SITE_DB_ID));
    const fetchSpy = stubFetch();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset`, { confirmText: 'RESET' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a matching confirmText (slug or "RESET") — wrong text is 409, NO wipe', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    // resolveSiteResources reads the allocation, then the slug lookup returns 'my-cafe'.
    mockDbQueryOne
      .mockResolvedValueOnce(allocRow(SITE_DB_ID)) // resolveSiteResources
      .mockResolvedValueOnce({ slug: 'my-cafe' }); // slug fetch — but the query path uses c.env.DB.prepare, not dbQueryOne
    const fetchSpy = stubFetch();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const env = {
      ...makeEnv(),
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ slug: 'my-cafe' }) }) }) },
    };
    const app = appWith(ORG);
    const res = await app.request(
      `/api/sites/${SITE}/data/reset`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, confirmText: 'wrong-text' }),
      },
      env as never,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts (424 BACKUP_FAILED) when the recovery bookmark cannot be taken — NO DROP', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue(allocRow(SITE_DB_ID));
    const fetchSpy = stubFetch({ bookmarkOk: false });
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const env = {
      ...makeEnv(),
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ slug: 'my-cafe' }) }) }) },
    };
    const res = await appWith(ORG).request(
      `/api/sites/${SITE}/data/reset`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, confirmText: 'RESET' }),
      },
      env as never,
    );
    expect(res.status).toBe(424);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BACKUP_FAILED');
    // A DROP must never have fired — assert no /query DROP call went out after the failed bookmark.
    const dropCalls = fetchSpy.mock.calls.filter((call) => {
      const body2 = (call[1] as { body?: string } | undefined)?.body ?? '';
      return body2.includes('DROP TABLE');
    });
    expect(dropCalls.length).toBe(0);
  });

  it('happy path — takes the bookmark BEFORE any DROP, wipes per-site D1/KV/R2, returns the recovery bookmark', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    mockDbQueryOne.mockResolvedValue(allocRow(SITE_DB_ID));
    const fetchSpy = stubFetch({ bookmarkOk: true });
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const env = {
      ...makeEnv(),
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ slug: 'my-cafe' }) }) }) },
    };
    const res = await appWith(ORG).request(
      `/api/sites/${SITE}/data/reset`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, confirmText: 'my-cafe' }),
      },
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      backupBookmark?: string;
      droppedTables?: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.backupBookmark).toBe('bk-123');
    expect(body.droppedTables).toContain('leads');

    // Ordering proof: the bookmark call precedes the first DROP call.
    const calls = fetchSpy.mock.calls.map((call) => ({
      url: String(call[0]),
      body: (call[1] as { body?: string } | undefined)?.body ?? '',
    }));
    const bookmarkIdx = calls.findIndex((x) => x.url.includes('/time_travel/bookmark'));
    const dropIdx = calls.findIndex((x) => x.body.includes('DROP TABLE'));
    expect(bookmarkIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(bookmarkIdx);
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });
});

describe('POST /api/sites/:siteId/data/reset/preview — honest, non-destructive', () => {
  beforeEach(() => {
    mockIsFlagOn.mockReset().mockResolvedValue(true);
    mockAssertSiteOwned.mockReset().mockResolvedValue(true);
    mockDbQueryOne.mockReset();
    mockWriteAuditLog.mockReset().mockResolvedValue(undefined);
  });

  it('returns available:false when the site has no dedicated resources — nothing to reset', async () => {
    mockDbQueryOne.mockResolvedValue({
      d1_database_id: null,
      d1_database_name: null,
      kv_namespace_id: null,
      kv_namespace_name: null,
      r2_bucket_name: null,
    });
    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset/preview`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available?: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe('no_dedicated_resources');
  });

  it('returns the delete-list + backup bookmark and NEVER issues a DROP', async () => {
    mockDbQueryOne.mockResolvedValue(allocRow(SITE_DB_ID));
    const fetchSpy = stubFetch({ bookmarkOk: true });
    (globalThis as { fetch: unknown }).fetch = fetchSpy;

    const res = await post(appWith(ORG), `/api/sites/${SITE}/data/reset/preview`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available?: boolean;
      backupBookmark?: string;
      d1?: { tables?: { name: string }[] };
    };
    expect(body.available).toBe(true);
    expect(body.backupBookmark).toBe('bk-123');
    expect(body.d1?.tables?.[0]?.name).toBe('leads');
    // Preview is read-only: no DROP / delete ever.
    const mutating = fetchSpy.mock.calls.filter((call) => {
      const b = (call[1] as { body?: string } | undefined)?.body ?? '';
      return b.includes('DROP TABLE') || String(call[0]).includes('/bulk/delete') || String(call[0]).includes('/objects/delete');
    });
    expect(mutating.length).toBe(0);
  });
});
