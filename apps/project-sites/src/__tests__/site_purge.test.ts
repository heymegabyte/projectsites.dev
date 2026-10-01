/**
 * Unit tests for `purgeSiteResources` — gp-09 full-teardown delete capability.
 *
 * Under test: the explicit, opt-in purge the DELETE /api/sites/:id handler runs
 * when the owner passes `purge_resources: true`. It removes the site's ENTIRE
 * dedicated footprint — shared-bucket R2 version-tree, dedicated D1 database,
 * dedicated KV namespace, dedicated R2 buckets, WfP slots + registry rows,
 * hostname rows, host KV key — and FREES the slug so the normal generation flow
 * can rebuild the same business at the same address.
 *
 * Contract:
 *  - REFUSES a site that is not soft-deleted yet (`attempted: false`) — purge is
 *    strictly a post-archive step; it never destroys a live site.
 *  - Platform-shared ids are NEVER deleted: FORBIDDEN_DB_IDS and any CF resource
 *    whose CF-side name fails the `ps-site-` prefix check are skipped
 *    (`skipped_forbidden`) with ZERO delete calls.
 *  - Fail-soft per step — one step's CF error never strands the others, and
 *    `purgeSiteResources` NEVER throws.
 *  - Slug freeing renames the archived row (`<slug>--purged-<ts36>`, ≤63 chars)
 *    so `ensureUniqueSlug` can hand the original slug to the re-created site.
 *
 * swc-jest hoists `jest.mock` above imports ONLY when it sees the GLOBAL `jest`
 * (do NOT import `jest` from @jest/globals). From `src/__tests__/`, mock paths use
 * ONE `../` to reach `src/`.
 */

// ─── Mocks (must precede the SUT import) ──────────────────────────────────────
const mockDbQueryOne = jest.fn();
const mockDbQuery = jest.fn();
const mockDbExecute = jest.fn();
jest.mock('../services/db.js', () => ({
  dbQueryOne: (...a: unknown[]) => mockDbQueryOne(...a),
  dbQuery: (...a: unknown[]) => mockDbQuery(...a),
  dbExecute: (...a: unknown[]) => mockDbExecute(...a),
}));

const mockTeardownWfp = jest.fn();
jest.mock('../services/wfp_site_hosting.js', () => ({
  teardownSiteWfp: (...a: unknown[]) => mockTeardownWfp(...a),
}));

const mockListAllocs = jest.fn();
const mockDeleteBucket = jest.fn();
jest.mock('../services/site_r2.js', () => {
  const actual = jest.requireActual('../services/site_r2.js');
  return {
    ...actual,
    listSiteR2Allocations: (...a: unknown[]) => mockListAllocs(...a),
    deleteSiteR2: (...a: unknown[]) => mockDeleteBucket(...a),
  };
});

import { purgeSiteResources } from '../services/site_purge.js';
import { FORBIDDEN_DB_IDS } from '../services/site_data_db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const SITE = '4f450690-dead-beef-9def-0123456789ab';
const ORG = 'org_owner';
const SLUG = 'lone-fixture';

interface FetchCall {
  url: string;
  method: string;
}
let fetchCalls: FetchCall[] = [];

/** CF REST stub: GET name-lookups return a ps-site-* name; DELETEs succeed. */
function stubCfFetch(
  overrides: { getName?: (url: string) => string | undefined; failDelete?: boolean } = {},
): void {
  (globalThis.fetch as unknown) = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ url, method });
    if (method === 'DELETE' && overrides.failDelete) {
      throw new Error('cf down');
    }
    const name = overrides.getName?.(url) ?? `ps-site-${SITE}`;
    const body = url.includes('/storage/kv/namespaces/')
      ? { success: true, result: { id: 'kv-id', title: name } }
      : { success: true, result: { uuid: 'd1-id', name } };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

interface R2ObjHandle {
  key: string;
}

function makeEnv(): Record<string, unknown> {
  const deleted: string[][] = [];
  let page = 0;
  return {
    DB: {},
    CF_ACCOUNT_ID: 'acct-1',
    CF_API_TOKEN: 'tok',
    SITES_BUCKET: {
      list: jest.fn(async () => {
        page += 1;
        if (page === 1) {
          return {
            objects: [
              { key: `sites/${SLUG}/v1/index.html` },
              { key: `sites/${SLUG}/v1/a.css` },
            ] as R2ObjHandle[],
            truncated: true,
            cursor: 'c1',
          };
        }
        return {
          objects: [{ key: `sites/${SLUG}/_manifest.json` }] as R2ObjHandle[],
          truncated: false,
        };
      }),
      delete: jest.fn(async (keys: string[]) => {
        deleted.push(keys);
      }),
      _deleted: deleted,
    },
    CACHE_KV: { delete: jest.fn(async () => undefined) },
  };
}

/** Archived site row + full dedicated allocation, the common fixture. */
function seedHappyRows(opts: { d1Id?: string } = {}): void {
  mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
    if (/FROM sites/.test(sql)) {
      return { id: SITE, slug: SLUG, deleted_at: '2026-10-01T00:00:00Z' };
    }
    if (/FROM site_database_allocations/.test(sql)) {
      return {
        d1_database_id: opts.d1Id ?? 'd1-dedicated-id',
        d1_database_name: `ps-site-${SITE}`,
        kv_namespace_id: 'kv-dedicated-id',
        kv_namespace_name: `ps-site-${SITE}-kv`,
      };
    }
    return null;
  });
  mockDbQuery.mockResolvedValue({ data: [], error: null });
  mockDbExecute.mockResolvedValue({ changes: 1, error: null });
}

beforeEach(() => {
  fetchCalls = [];
  mockDbQueryOne.mockReset();
  mockDbQuery.mockReset();
  mockDbExecute.mockReset().mockResolvedValue({ changes: 1, error: null });
  mockTeardownWfp
    .mockReset()
    .mockResolvedValue({ attempted: true, slotsDeleted: 2, registryCleared: 2 });
  mockListAllocs
    .mockReset()
    .mockResolvedValue([
      {
        id: 'alloc-1',
        bucketName: `ps-site-${SITE}-uploads`,
        displayName: 'uploads',
        environment: 'preview',
        isDefault: true,
        publicAccess: false,
        publicBaseUrl: null,
        createdAt: 'x',
      },
    ]);
  mockDeleteBucket.mockReset().mockResolvedValue({ ok: true, deleted: true, objectsDeleted: 4 });
  stubCfFetch();
});

describe('purgeSiteResources', () => {
  it('refuses a site that is not soft-deleted (purge is post-archive only)', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) =>
      /FROM sites/.test(sql) ? { id: SITE, slug: SLUG, deleted_at: null } : null,
    );
    const res = await purgeSiteResources(makeEnv() as never, {
      siteId: SITE,
      slug: SLUG,
      orgId: ORG,
    });
    expect(res.attempted).toBe(false);
    expect(res.refusedReason).toBe('not_deleted');
    expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('happy path: tears down R2 tree + dedicated D1/KV/buckets, retires rows, frees the slug', async () => {
    seedHappyRows();
    const env = makeEnv();
    const res = await purgeSiteResources(env as never, { siteId: SITE, slug: SLUG, orgId: ORG });

    expect(res.attempted).toBe(true);
    // R2 version tree: both list pages deleted (3 objects).
    expect(res.r2VersionObjectsDeleted).toBe(3);
    const bucket = env.SITES_BUCKET as { delete: jest.Mock };
    expect(bucket.delete).toHaveBeenCalled();
    // Dedicated D1 + KV deleted via CF REST (name verified CF-side first).
    expect(res.dedicatedD1).toBe('deleted');
    expect(res.dedicatedKv).toBe('deleted');
    expect(
      fetchCalls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/d1/database/d1-dedicated-id'),
      ),
    ).toBe(true);
    expect(
      fetchCalls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/storage/kv/namespaces/kv-dedicated-id'),
      ),
    ).toBe(true);
    // Dedicated buckets via the existing guarded deleter.
    expect(res.dedicatedBuckets).toEqual([{ bucket: `ps-site-${SITE}-uploads`, ok: true }]);
    // WfP teardown attempted.
    expect(res.wfp.attempted).toBe(true);
    // Rows retired + slug freed.
    expect(res.allocationRetired).toBe(true);
    expect(res.slugFreed).toMatch(new RegExp(`^${SLUG}--purged-`));
    expect(res.slugFreed!.length).toBeLessThanOrEqual(63);
    const slugUpdate = mockDbExecute.mock.calls.find((c) =>
      /UPDATE sites SET slug/.test(String(c[1])),
    );
    expect(slugUpdate).toBeTruthy();
    // Host KV key cleared.
    expect((env.CACHE_KV as { delete: jest.Mock }).delete).toHaveBeenCalledWith(
      `host:${SLUG}.projectsites.dev`,
    );
  });

  it('NEVER deletes a platform-shared D1 id (FORBIDDEN_DB_IDS → skipped_forbidden)', async () => {
    const forbidden = [...FORBIDDEN_DB_IDS][0]!;
    seedHappyRows({ d1Id: forbidden });
    const res = await purgeSiteResources(makeEnv() as never, {
      siteId: SITE,
      slug: SLUG,
      orgId: ORG,
    });
    expect(res.dedicatedD1).toBe('skipped_forbidden');
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes(forbidden))).toBe(false);
  });

  it('skips a resource whose CF-side name fails the ps-site- prefix check', async () => {
    seedHappyRows();
    stubCfFetch({
      getName: (url) => (url.includes('/d1/database/') ? 'main-platform-db' : undefined),
    });
    const res = await purgeSiteResources(makeEnv() as never, {
      siteId: SITE,
      slug: SLUG,
      orgId: ORG,
    });
    expect(res.dedicatedD1).toBe('skipped_forbidden');
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/d1/database/'))).toBe(
      false,
    );
    // KV (name fine) still deleted — steps are independent.
    expect(res.dedicatedKv).toBe('deleted');
  });

  it('fail-soft: a CF outage marks the step error but never throws and other steps run', async () => {
    seedHappyRows();
    stubCfFetch({ failDelete: true });
    const res = await purgeSiteResources(makeEnv() as never, {
      siteId: SITE,
      slug: SLUG,
      orgId: ORG,
    });
    expect(res.attempted).toBe(true);
    expect(res.dedicatedD1).toBe('error');
    expect(res.dedicatedKv).toBe('error');
    // Non-CF steps still completed.
    expect(res.r2VersionObjectsDeleted).toBe(3);
    expect(res.slugFreed).toMatch(/--purged-/);
  });
});
