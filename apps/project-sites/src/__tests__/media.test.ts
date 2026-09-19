/**
 * Unit tests for services/media.ts.
 *
 * Covers:
 *   - uploadAsset → listAssets → softDeleteAsset round-trip
 *   - searchStock fans out via Promise.allSettled across configured providers
 */

import type { Env } from '../types/env.js';
import {
  listAssets,
  saveStockToLibrary,
  searchStock,
  softDeleteAsset,
  uploadAsset,
  type MediaAsset,
} from '../services/media.js';

interface MockRow extends Record<string, unknown> {}

/**
 * Minimal in-memory D1 stub.
 *
 * Backs a `media_assets` table for INSERT / UPDATE / SELECT statements
 * issued by the service. Pattern-matches on the SQL string instead of a
 * full parser — sufficient for the round-trip exercised here.
 */
function createDbStub(): D1Database {
  const rows: MockRow[] = [];

  const prepare = (sql: string) => {
    return {
      bind: (...params: unknown[]) => ({
        all: async () => {
          if (/SELECT \* FROM media_assets/i.test(sql)) {
            // Filter by org_id (params[0]) and deleted_at IS NULL.
            const orgId = params[0];
            const filtered = rows.filter(
              (r) => r.org_id === orgId && (r.deleted_at === null || r.deleted_at === undefined),
            );
            return { results: filtered, success: true, meta: { changes: 0 } } as unknown;
          }
          return { results: [], success: true, meta: { changes: 0 } } as unknown;
        },
        first: async () => null,
        run: async () => {
          if (/^INSERT INTO media_assets/i.test(sql)) {
            // Parse column list from SQL: "INSERT INTO media_assets (col1, col2, ...) VALUES (?, ?, ...)"
            const m = sql.match(/INSERT INTO media_assets \(([^)]+)\) VALUES/i);
            if (m) {
              const cols = m[1].split(',').map((s) => s.trim());
              const row: MockRow = {};
              cols.forEach((col, i) => {
                row[col] = params[i];
              });
              rows.push(row);
            }
            return { meta: { changes: 1 } } as unknown;
          }
          if (/^UPDATE media_assets/i.test(sql)) {
            // Soft delete: UPDATE media_assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL
            const [deletedAt, updatedAt, id, orgId] = params;
            let changed = 0;
            for (const r of rows) {
              if (
                r.id === id &&
                r.org_id === orgId &&
                (r.deleted_at === null || r.deleted_at === undefined)
              ) {
                r.deleted_at = deletedAt;
                r.updated_at = updatedAt;
                changed += 1;
              }
            }
            return { meta: { changes: changed } } as unknown;
          }
          return { meta: { changes: 0 } } as unknown;
        },
      }),
    };
  };

  return { prepare } as unknown as D1Database;
}

function createR2Stub() {
  const objects = new Map<string, ArrayBuffer>();
  return {
    put: jest.fn(async (key: string, body: ArrayBuffer) => {
      objects.set(key, body);
    }),
    get: jest.fn(async (key: string) => {
      const buf = objects.get(key);
      if (!buf) return null;
      return { body: buf, size: buf.byteLength } as unknown;
    }),
    delete: jest.fn(async (key: string) => {
      objects.delete(key);
    }),
    objects,
  };
}

/** D1 stub whose media_assets INSERT fails (dbExecute → { error }, never throws). */
function createDbInsertFailStub(): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: [], success: true, meta: { changes: 0 } }) as unknown,
        first: async () => null,
        run: async () => {
          if (/^INSERT INTO media_assets/i.test(sql)) throw new Error('D1_ERROR: disk I/O');
          return { meta: { changes: 0 } } as unknown;
        },
      }),
    }),
  } as unknown as D1Database;
}

describe('services/media', () => {
  describe('uploadAsset → listAssets → softDeleteAsset round-trip', () => {
    it('persists an upload, lists it, then soft-deletes it', async () => {
      const r2 = createR2Stub();
      const env = {
        DB: createDbStub(),
        SITES_BUCKET: r2 as unknown as R2Bucket,
        AI: {} as Ai,
      } as unknown as Env;

      const bytes = new TextEncoder().encode('fake-png-bytes').buffer;
      const asset = await uploadAsset(env, {
        orgId: 'org-1',
        createdBy: 'user-1',
        name: 'hero.png',
        mime: 'image/png',
        bytes,
      });

      // R2 write happened under the expected prefix
      expect(r2.put).toHaveBeenCalledTimes(1);
      expect((r2.put.mock.calls[0][0] as string).startsWith('media/org-1/')).toBe(true);
      expect(asset.kind).toBe('image');
      expect(asset.source).toBe('uploaded');
      expect(asset.r2_key).toContain('media/org-1/');

      // Listing returns the asset
      const list = await listAssets(env, 'org-1', { kind: 'image' });
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(asset.id);

      // Soft-delete + re-list returns nothing
      const del = await softDeleteAsset(env, 'org-1', asset.id);
      expect(del.ok).toBe(true);

      const after = await listAssets(env, 'org-1', { kind: 'image' });
      expect(after).toHaveLength(0);
    });

    it('deletes the R2 object when the D1 insert fails (no orphan) and rethrows', async () => {
      // The put succeeds but the media_assets INSERT drops → the R2 object would
      // be orphaned (invisible to listAssets, wasted storage). uploadAsset must
      // compensate: delete the object before throwing MEDIA_INSERT_FAILED.
      const r2 = createR2Stub();
      const env = {
        DB: createDbInsertFailStub(),
        SITES_BUCKET: r2 as unknown as R2Bucket,
        AI: {} as Ai,
      } as unknown as Env;

      const bytes = new TextEncoder().encode('fake-bytes').buffer;
      await expect(
        uploadAsset(env, { orgId: 'org-1', name: 'hero.png', mime: 'image/png', bytes }),
      ).rejects.toThrow(/MEDIA_INSERT_FAILED/);

      // The object was written then compensated — same key put + deleted, no orphan.
      expect(r2.put).toHaveBeenCalledTimes(1);
      expect(r2.delete).toHaveBeenCalledTimes(1);
      expect(r2.delete.mock.calls[0][0]).toBe(r2.put.mock.calls[0][0]);
      expect(r2.objects.size).toBe(0);
    });
  });

  describe('searchStock', () => {
    it('fans out across configured providers via Promise.allSettled', async () => {
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.includes('api.unsplash.com')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  urls: {
                    regular: 'https://images.unsplash.com/p1',
                    small: 'https://images.unsplash.com/p1-small',
                  },
                  description: 'unsplash-photo',
                  user: { name: 'Jane' },
                  links: { html: 'https://unsplash.com/photos/p1' },
                  width: 1920,
                  height: 1080,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('api.pexels.com/v1/search')) {
          return new Response(
            JSON.stringify({
              photos: [
                {
                  src: {
                    large: 'https://pexels.com/p2-large',
                    medium: 'https://pexels.com/p2-med',
                  },
                  alt: 'pexels-photo',
                  photographer: 'John',
                  url: 'https://pexels.com/photo/p2',
                  width: 1600,
                  height: 900,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('pixabay.com/api')) {
          return new Response(
            JSON.stringify({
              hits: [
                {
                  largeImageURL: 'https://pixabay.com/p3-large',
                  webformatURL: 'https://pixabay.com/p3-web',
                  tags: 'pixabay tags',
                  user: 'Sam',
                  pageURL: 'https://pixabay.com/photo/p3',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // Force one source to fail so Promise.allSettled isolation is exercised
        if (url.includes('googleapis.com/customsearch')) {
          return new Response('boom', { status: 500 });
        }
        return new Response('{}', { status: 200 });
      });
      const originalFetch = globalThis.fetch;
      (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      try {
        const env = {
          DB: createDbStub(),
          SITES_BUCKET: createR2Stub() as unknown as R2Bucket,
          AI: {} as Ai,
          UNSPLASH_ACCESS_KEY: 'unsplash-key',
          PEXELS_API_KEY: 'pexels-key',
          PIXABAY_API_KEY: 'pixabay-key',
          GOOGLE_CSE_KEY: 'cse-key',
          GOOGLE_CSE_CX: 'cse-cx',
        } as unknown as Env;

        const candidates = await searchStock(env, 'org-1', 'coffee shop', {
          sources: ['unsplash', 'pexels', 'pixabay', 'google-cse'],
          perPage: 5,
        });

        // Every configured provider was queried at least once
        const urlsCalled = fetchMock.mock.calls.map((args) => String(args[0]));
        expect(urlsCalled.some((u) => u.includes('api.unsplash.com'))).toBe(true);
        expect(urlsCalled.some((u) => u.includes('api.pexels.com'))).toBe(true);
        expect(urlsCalled.some((u) => u.includes('pixabay.com/api'))).toBe(true);
        expect(urlsCalled.some((u) => u.includes('googleapis.com/customsearch'))).toBe(true);

        // 3 successful providers each return 1 candidate; the failing CSE
        // resolves to an empty array via Promise.allSettled.
        expect(candidates).toHaveLength(3);
        const providers = new Set(candidates.map((c) => c.provider));
        expect(providers.has('unsplash')).toBe(true);
        expect(providers.has('pexels')).toBe(true);
        expect(providers.has('pixabay')).toBe(true);
      } finally {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      }
    });

    it('skips providers whose API key is missing', async () => {
      const fetchMock = jest.fn();
      const originalFetch = globalThis.fetch;
      (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
      try {
        const env = {
          DB: createDbStub(),
          SITES_BUCKET: createR2Stub() as unknown as R2Bucket,
          AI: {} as Ai,
        } as unknown as Env;
        const candidates = await searchStock(env, 'org-1', 'hello');
        expect(candidates).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      }
    });
  });

  describe('round-trip preserves attribution + source provider', () => {
    it('threads stock-style metadata into the inserted row', async () => {
      const r2 = createR2Stub();
      const env = {
        DB: createDbStub(),
        SITES_BUCKET: r2 as unknown as R2Bucket,
        AI: {} as Ai,
      } as unknown as Env;

      const asset: MediaAsset = await uploadAsset(env, {
        orgId: 'org-2',
        createdBy: null,
        name: 'pexels-cafe.jpg',
        mime: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3, 4]).buffer,
        source: 'stock',
        sourceProvider: 'pexels',
        attribution: 'Photo by Jane on Pexels',
        sourceUrl: 'https://pexels.com/photo/cafe',
      });

      expect(asset.source).toBe('stock');
      expect(asset.source_provider).toBe('pexels');
      expect(asset.attribution).toContain('Pexels');

      const list = await listAssets(env, 'org-2');
      expect(list[0]?.attribution).toContain('Pexels');
      expect(list[0]?.source_provider).toBe('pexels');
    });
  });

  // saveStockToLibrary pulls a client-supplied URL server-side and stores the body as a
  // readable asset — so it must not be SSRF-able. These lock the manual-redirect guard.
  describe('saveStockToLibrary SSRF guard', () => {
    const mkEnv = () => {
      const r2 = createR2Stub();
      const env = {
        DB: createDbStub(),
        SITES_BUCKET: r2 as unknown as R2Bucket,
        AI: {} as Ai,
      } as unknown as Env;
      return { env, r2 };
    };
    let origFetch: typeof global.fetch;
    beforeEach(() => {
      origFetch = global.fetch;
    });
    afterEach(() => {
      global.fetch = origFetch;
    });

    it('rejects a direct internal/metadata URL and never fetches it', async () => {
      const { env, r2 } = mkEnv();
      global.fetch = jest.fn() as never;
      await expect(
        saveStockToLibrary(env, {
          orgId: 'org-1',
          candidate: {
            provider: 'x',
            kind: 'image',
            fullUrl: 'http://169.254.169.254/latest/meta-data/',
            title: 'meta',
          } as never,
        }),
      ).rejects.toThrow(/MEDIA_STOCK_UNSAFE_URL/);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(r2.put).not.toHaveBeenCalled();
    });

    it('rejects a redirect that hops from a safe host to an internal target (TOCTOU) — stores nothing', async () => {
      const { env, r2 } = mkEnv();
      global.fetch = jest.fn(async () => ({
        status: 302,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null,
        },
      })) as never;
      await expect(
        saveStockToLibrary(env, {
          orgId: 'org-1',
          candidate: {
            provider: 'x',
            kind: 'image',
            fullUrl: 'https://cdn.example.com/a.jpg',
            title: 'a',
          } as never,
        }),
      ).rejects.toThrow(/MEDIA_STOCK_UNSAFE_URL/);
      expect(global.fetch).toHaveBeenCalledTimes(1); // only the first (safe) hop attempted
      expect(r2.put).not.toHaveBeenCalled(); // the SSRF body is never persisted
    });

    it('downloads a safe stock URL and persists it (happy path preserved)', async () => {
      const { env, r2 } = mkEnv();
      const body = new TextEncoder().encode('img-bytes').buffer;
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        arrayBuffer: async () => body,
      })) as never;
      const asset = await saveStockToLibrary(env, {
        orgId: 'org-1',
        candidate: {
          provider: 'unsplash',
          kind: 'image',
          fullUrl: 'https://images.unsplash.com/photo-1.jpg',
          title: 'sunset',
        } as never,
      });
      expect(asset.source).toBe('stock');
      expect(r2.put).toHaveBeenCalledTimes(1);
    });
  });
});
