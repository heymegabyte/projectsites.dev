/**
 * Route-LAYER coverage for routes/media.ts — the existing media.test.ts is
 * SERVICE-level only (hits zero `/api/media/*` endpoints), so all 10 route
 * handlers + the `errorResponse` status-mapping table were untested. Exercises
 * the full Hono surface (org auth via the shared harness; the media service +
 * R2 bucket mocked at their boundaries):
 *
 *   GET    /assets            401 · 200 (filter passthrough)
 *   GET    /assets/:id        404 · 200
 *   GET    /assets/:id/raw    asset-404 · r2-object-404 · 200 stream
 *   POST   /upload            401 · non-multipart 400
 *   DELETE /assets/:id        not-found 404 · 200
 *   POST   /stock/search      missing-query 400 · 200
 *   POST   /stock/save        missing-candidate 400 · 201 · TOO_LARGE 413
 *   POST   /generate/image    missing-prompt 400 · 201 · OPENAI 503
 *   POST   /generate/video    202
 *   POST   /generate/podcast  missing-title 400 · empty-script 400 · 201
 *   POST   /send-to-bolt      missing-assetId 400 · ASSET_NOT_FOUND 404
 */

jest.mock('../services/media.js', () => ({
  listAssets: jest.fn(),
  countAssets: jest.fn(),
  getAsset: jest.fn(),
  uploadAsset: jest.fn(),
  softDeleteAsset: jest.fn(),
  searchStock: jest.fn(),
  saveStockToLibrary: jest.fn(),
  generateImage: jest.fn(),
  generateVideo: jest.fn(),
  generatePodcast: jest.fn(),
  sendToBolt: jest.fn(),
  signedRawMediaUrl: jest.fn(),
  verifyMediaToken: jest.fn(),
}));

import { mediaRoutes } from '../routes/media.js';
import { authApp } from './helpers/route_harness.js';
import * as media from '../services/media.js';

const m = media as jest.Mocked<typeof media>;

const authed = () => authApp(mediaRoutes, { userId: 'u', orgId: 'org1' });
const anon = () => authApp(mediaRoutes);
const env = (bucket?: { get: (k: string) => Promise<unknown> }) =>
  ({ SITES_BUCKET: bucket ?? { get: async () => null } }) as never;
const jsonReq = (b: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

beforeEach(() => jest.clearAllMocks());

describe('GET /api/media/assets', () => {
  it('401 when no orgId in context', async () => {
    expect((await anon().request('/api/media/assets', {}, env())).status).toBe(401);
  });

  it('200 lists assets + passes parsed filters to the service', async () => {
    m.listAssets.mockResolvedValue([{ id: 'a1' }] as never);
    const res = await authed().request('/api/media/assets?kind=image&q=logo&limit=10', {}, env());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assets: unknown[] }).assets).toHaveLength(1);
    expect(m.listAssets).toHaveBeenCalledWith(
      expect.anything(),
      'org1',
      expect.objectContaining({ kind: 'image', search: 'logo', limit: 10 }),
    );
  });
});

describe('GET /api/media/assets/:id', () => {
  it('404 when the asset is missing', async () => {
    m.getAsset.mockResolvedValue(null as never);
    expect((await authed().request('/api/media/assets/x', {}, env())).status).toBe(404);
  });

  it('200 when found', async () => {
    m.getAsset.mockResolvedValue({ id: 'a1' } as never);
    expect((await authed().request('/api/media/assets/a1', {}, env())).status).toBe(200);
  });
});

describe('GET /api/media/assets/:id/raw', () => {
  it('404 when the asset row is missing', async () => {
    m.getAsset.mockResolvedValue(null as never);
    expect((await authed().request('/api/media/assets/x/raw', {}, env())).status).toBe(404);
  });

  it('404 when the underlying R2 object is missing', async () => {
    m.getAsset.mockResolvedValue({ r2_key: 'k', mime: 'image/png', size_bytes: 10 } as never);
    const res = await authed().request(
      '/api/media/assets/a1/raw',
      {},
      env({ get: async () => null }),
    );
    expect(res.status).toBe(404);
  });

  it('200 streams the object with its content-type', async () => {
    m.getAsset.mockResolvedValue({ r2_key: 'k', mime: 'image/png', size_bytes: 3 } as never);
    const res = await authed().request(
      '/api/media/assets/a1/raw',
      {},
      env({ get: async () => ({ body: 'abc', size: 3 }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('ships user-content XSS-defense headers (nosniff + CSP sandbox); an image renders inline', async () => {
    m.getAsset.mockResolvedValue({
      r2_key: 'k',
      mime: 'image/png',
      size_bytes: 3,
      name: 'logo.png',
    } as never);
    const res = await authed().request(
      '/api/media/assets/a1/raw',
      {},
      env({ get: async () => ({ body: 'abc', size: 3 }) }),
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('Content-Disposition')).toContain('inline'); // png is inline-safe
  });

  it('forces a dangerous MIME (svg) to download rather than render as a document', async () => {
    m.getAsset.mockResolvedValue({
      r2_key: 'k',
      mime: 'image/svg+xml',
      size_bytes: 5,
      name: 'x.svg',
    } as never);
    const res = await authed().request(
      '/api/media/assets/a1/raw',
      {},
      env({ get: async () => ({ body: '<svg/>', size: 5 }) }),
    );
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sanitizes the Content-Disposition filename (no header injection via asset name)', async () => {
    m.getAsset.mockResolvedValue({
      r2_key: 'k',
      mime: 'text/html',
      size_bytes: 1,
      name: 'a"\r\n.html',
    } as never);
    const res = await authed().request(
      '/api/media/assets/a1/raw',
      {},
      env({ get: async () => ({ body: 'x', size: 1 }) }),
    );
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).not.toContain('a"'); // the injected quote/CRLF were stripped from the name
    expect(cd).not.toContain('\n');
  });
});

describe('POST /api/media/upload', () => {
  it('401 when unauthenticated', async () => {
    expect((await anon().request('/api/media/upload', { method: 'POST' }, env())).status).toBe(401);
  });

  it('400 when the body is not multipart/form-data', async () => {
    const res = await authed().request('/api/media/upload', jsonReq({ x: 1 }), env());
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/media/assets/:id', () => {
  it('404 when the service reports "Asset not found"', async () => {
    m.softDeleteAsset.mockResolvedValue({ ok: false, error: 'Asset not found' } as never);
    expect(
      (await authed().request('/api/media/assets/x', { method: 'DELETE' }, env())).status,
    ).toBe(404);
  });

  it('200 on a successful soft delete', async () => {
    m.softDeleteAsset.mockResolvedValue({ ok: true } as never);
    expect(
      (await authed().request('/api/media/assets/a1', { method: 'DELETE' }, env())).status,
    ).toBe(200);
  });
});

describe('POST /api/media/stock/search', () => {
  it('400 when query is blank', async () => {
    expect(
      (await authed().request('/api/media/stock/search', jsonReq({ query: '  ' }), env())).status,
    ).toBe(400);
  });

  it('200 returns candidates', async () => {
    m.searchStock.mockResolvedValue([{ id: 's1' }] as never);
    const res = await authed().request(
      '/api/media/stock/search',
      jsonReq({ query: 'sunset' }),
      env(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { candidates: unknown[] }).candidates).toHaveLength(1);
  });
});

describe('POST /api/media/stock/save', () => {
  it('400 when no candidate is given', async () => {
    expect((await authed().request('/api/media/stock/save', jsonReq({}), env())).status).toBe(400);
  });

  it('201 on save', async () => {
    m.saveStockToLibrary.mockResolvedValue({ id: 'a1' } as never);
    expect(
      (
        await authed().request(
          '/api/media/stock/save',
          jsonReq({ candidate: { fullUrl: 'https://x/y.jpg' } }),
          env(),
        )
      ).status,
    ).toBe(201);
  });

  it('413 maps MEDIA_STOCK_TOO_LARGE → PAYLOAD_TOO_LARGE', async () => {
    m.saveStockToLibrary.mockRejectedValue(new Error('MEDIA_STOCK_TOO_LARGE: 30MB'));
    const res = await authed().request(
      '/api/media/stock/save',
      jsonReq({ candidate: { fullUrl: 'https://x/y.jpg' } }),
      env(),
    );
    expect(res.status).toBe(413);
  });
});

describe('POST /api/media/generate/image', () => {
  it('400 when prompt is blank', async () => {
    expect(
      (await authed().request('/api/media/generate/image', jsonReq({ prompt: '' }), env())).status,
    ).toBe(400);
  });

  it('201 on success', async () => {
    m.generateImage.mockResolvedValue([{ id: 'a1' }] as never);
    expect(
      (await authed().request('/api/media/generate/image', jsonReq({ prompt: 'a cat' }), env()))
        .status,
    ).toBe(201);
  });

  it('503 maps MEDIA_OPENAI_NOT_CONFIGURED → OPENAI_NOT_CONFIGURED', async () => {
    m.generateImage.mockRejectedValue(new Error('MEDIA_OPENAI_NOT_CONFIGURED'));
    const res = await authed().request(
      '/api/media/generate/image',
      jsonReq({ prompt: 'a cat' }),
      env(),
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /api/media/generate/video', () => {
  it('202 (queued) on success', async () => {
    m.generateVideo.mockResolvedValue({ id: 'v1' } as never);
    expect(
      (await authed().request('/api/media/generate/video', jsonReq({ prompt: 'waves' }), env()))
        .status,
    ).toBe(202);
  });
});

describe('POST /api/media/generate/podcast', () => {
  it('400 when title is missing', async () => {
    expect(
      (
        await authed().request(
          '/api/media/generate/podcast',
          jsonReq({ script: [{ voice: 'a', text: 'hi' }] }),
          env(),
        )
      ).status,
    ).toBe(400);
  });

  it('400 when the script is empty', async () => {
    expect(
      (
        await authed().request(
          '/api/media/generate/podcast',
          jsonReq({ title: 'Ep 1', script: [] }),
          env(),
        )
      ).status,
    ).toBe(400);
  });

  it('201 on success', async () => {
    m.generatePodcast.mockResolvedValue({ id: 'p1' } as never);
    const res = await authed().request(
      '/api/media/generate/podcast',
      jsonReq({ title: 'Ep 1', script: [{ voice: 'a', text: 'hi' }] }),
      env(),
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /api/media/send-to-bolt', () => {
  it('400 when assetId is missing', async () => {
    expect((await authed().request('/api/media/send-to-bolt', jsonReq({}), env())).status).toBe(
      400,
    );
  });

  it('404 maps MEDIA_ASSET_NOT_FOUND → NOT_FOUND', async () => {
    m.sendToBolt.mockRejectedValue(new Error('MEDIA_ASSET_NOT_FOUND'));
    const res = await authed().request(
      '/api/media/send-to-bolt',
      jsonReq({ assetId: 'ghost' }),
      env(),
    );
    expect(res.status).toBe(404);
  });
});
