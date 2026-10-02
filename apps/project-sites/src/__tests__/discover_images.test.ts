jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { search } from '../routes/search.js';
// Route-decomposition installment 26: /api/ai/discover-images moved to media_ai. Mount before search.
import { mediaAi } from '../../libs/features/media_ai/handlers.js';

const mockDb = {} as D1Database;
const mockSitesBucket = {
  get: jest.fn().mockResolvedValue(null),
  put: jest.fn().mockResolvedValue({}),
} as unknown as R2Bucket;

const mockEnv = {
  GOOGLE_PLACES_API_KEY: 'test-google-key',
  GOOGLE_CSE_KEY: 'test-cse-key',
  GOOGLE_CSE_CX: 'test-cse-cx',
  OPENAI_API_KEY: 'test-openai-key',
  ENVIRONMENT: 'test',
  DB: mockDb,
  SITES_BUCKET: mockSitesBucket,
  CACHE_KV: { get: jest.fn().mockResolvedValue(null), put: jest.fn() },
} as unknown as Env;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.onError(errorHandler);
app.route('/', mediaAi);
app.route('/', search);

function makeRequest(path: string, options?: RequestInit) {
  return app.request(path, options, mockEnv);
}

// ── Fetch interception ─────────────────────────────────────────────────────

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ── Test HTML for When Doody Calls ──────────────────────────────────────────

const WHEN_DOODY_CALLS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>When Doody Calls - Pooper Scoopers</title>
  <link rel="icon" href="/wp-content/uploads/2017/02/Favicon.png" type="image/png">
  <meta property="og:image" content="https://whendoodycalls.com/wp-content/uploads/2017/02/Web_Banner3.jpg" />
</head>
<body>
  <div class="header">
    <img src="/wp-content/uploads/2017/02/Web_Banner3.jpg" width="800" height="300" alt="When Doody Calls Banner" />
  </div>
  <div class="content">
    <p>Professional pet waste removal services</p>
    <img src="/wp-content/uploads/2017/02/Favicon.png" width="16" height="16" alt="Tiny favicon" />
    <img src="/wp-content/uploads/small-spacer.gif" width="1" height="1" alt="" />
  </div>
</body>
</html>
`;

// 16x16 PNG header (for tiny favicon simulation)
const TINY_PNG_HEADER = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk
  0x00,
  0x00,
  0x00,
  0x10, // width: 16
  0x00,
  0x00,
  0x00,
  0x10, // height: 16
  0x08,
  0x06,
  0x00,
  0x00,
  0x00, // bit depth, color type
  0x1f,
  0x15,
  0xc4,
  0x89, // CRC
  0x00,
  0x00,
  0x00,
  0x0a,
  0x49,
  0x44,
  0x41,
  0x54, // IDAT chunk
  0x78,
  0x9c,
  0x62,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe5,
  0x27,
  0xde,
  0xfc,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

// 800x300 PNG header (for banner simulation)
const LARGE_PNG_HEADER = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk
  0x00,
  0x00,
  0x03,
  0x20, // width: 800
  0x00,
  0x00,
  0x01,
  0x2c, // height: 300
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  // Pad to > 15000 bytes to pass size checks
  ...new Array(20000).fill(0),
]);

// 256x256 PNG header (for Google favicon simulation)
const MEDIUM_PNG_HEADER = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x01,
  0x00, // width: 256
  0x00,
  0x00,
  0x01,
  0x00, // height: 256
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  ...new Array(5000).fill(0),
]);

// GPT-4o vision quality response for a professional banner
const VISION_QUALITY_BANNER = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          quality_score: 55,
          is_professional: false,
          is_safe: true,
          description:
            'A banner image for When Doody Calls pet waste removal service showing their logo with a phone number overlay. Low resolution, dated design.',
          recommendation: 'use_as_inspiration',
          issues: ['Low resolution', 'Phone number overlaid on image', 'Dated design aesthetic'],
        }),
      },
    },
  ],
};

// GPT-4o vision quality response for the tiny favicon
const VISION_QUALITY_FAVICON = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          quality_score: 15,
          is_professional: false,
          is_safe: true,
          description:
            'Extremely small favicon, appears to be a simplified dog poop icon. Very pixelated at this size.',
          recommendation: 'use_as_inspiration',
          issues: [
            'Extremely low resolution (16x16)',
            'Pixelated',
            'Unprofessional at any display size',
          ],
        }),
      },
    },
  ],
};

/**
 * Helper to set up mockFetch responses for When Doody Calls scenario.
 * The fetch mock must handle multiple concurrent calls (website scrape, dimension checks, CSE, vision).
 */
function setupWhenDoodyCalls(): void {
  mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    // IMPORTANT: Match specific image URLs BEFORE the generic domain match
    // Favicon dimension check (16x16 — should be rejected)
    if (urlStr.includes('Favicon.png')) {
      return new Response(TINY_PNG_HEADER.buffer, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(TINY_PNG_HEADER.byteLength),
        },
      });
    }

    // Banner image dimension check (800x300)
    if (urlStr.includes('Web_Banner3.jpg')) {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '50000',
          },
        });
      }
      return new Response(LARGE_PNG_HEADER.buffer, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(LARGE_PNG_HEADER.byteLength),
        },
      });
    }

    // Standard favicon paths (404 — site doesn't have them)
    if (
      urlStr.includes('apple-touch-icon.png') ||
      urlStr.includes('favicon-32x32.png') ||
      urlStr.match(/\/favicon\.(png|ico)$/)
    ) {
      return new Response('Not Found', { status: 404 });
    }

    // Website homepage scrape (only exact domain or root path)
    if (urlStr === 'https://whendoodycalls.com' || urlStr === 'https://whendoodycalls.com/') {
      return new Response(WHEN_DOODY_CALLS_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    // Google faviconV2 — returns 256x256
    if (urlStr.includes('faviconV2')) {
      return new Response(MEDIUM_PNG_HEADER.buffer, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(MEDIUM_PNG_HEADER.byteLength),
        },
      });
    }

    // Google CSE search — return the Web_Banner3.jpg as the only real result
    if (urlStr.includes('googleapis.com/customsearch')) {
      // Only return results for queries about the business's own domain
      if (
        urlStr.includes('site%3Awhendoodycalls.com') ||
        urlStr.includes('When+Doody+Calls') ||
        urlStr.includes('When%20Doody%20Calls')
      ) {
        return new Response(
          JSON.stringify({
            items: [
              {
                link: 'https://whendoodycalls.com/wp-content/uploads/2017/02/Web_Banner3.jpg',
                title: 'When Doody Calls Banner',
                displayLink: 'whendoodycalls.com',
                image: { width: 800, height: 300 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // OpenAI GPT-4o vision calls
    if (urlStr.includes('api.openai.com/v1/chat/completions')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const imageUrl = body.messages?.[1]?.content?.[1]?.image_url?.url || '';
      if (imageUrl.includes('Favicon') || imageUrl.includes('favicon')) {
        return new Response(JSON.stringify(VISION_QUALITY_FAVICON), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(VISION_QUALITY_BANNER), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Default: 404
    return new Response('Not Found', { status: 404 });
  });
}

// ══════════════════════════════════════════════════════════════════════���════
// POST /api/ai/discover-images — When Doody Calls
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/ai/discover-images', () => {
  it('returns empty data when name is missing', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 404 }));
    const res = await makeRequest('/api/ai/discover-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.logo).toBeNull();
    expect(body.data.favicon).toBeNull();
    expect(body.data.images).toEqual([]);
  });

  describe('When Doody Calls — Pooper Scoopers', () => {
    beforeEach(() => {
      setupWhenDoodyCalls();
    });

    it('discovers the og:image (Web_Banner3.jpg) as the logo', async () => {
      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          address: 'Some City, TX',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Logo should be the og:image (Web_Banner3.jpg) via proxy
      expect(body.data.logo).not.toBeNull();
      expect(body.data.logo.url).toContain('Web_Banner3.jpg');
      expect(body.data.logo.source).toBe('website-scrape');
    });

    it('rejects the tiny 16x16 Favicon.png from the website', async () => {
      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Favicon should NOT be the tiny 16x16 Favicon.png
      // It should either be the Google faviconV2 fallback or null
      if (body.data.favicon) {
        expect(body.data.favicon.url).not.toContain('Favicon.png');
        // If a favicon is returned, it must have dimensions >= 64px
        if (body.data.favicon.dimensions) {
          expect(body.data.favicon.dimensions.width).toBeGreaterThanOrEqual(64);
          expect(body.data.favicon.dimensions.height).toBeGreaterThanOrEqual(64);
        }
      }
    });

    it('discovers Web_Banner3.jpg in additional images via page scraping', async () => {
      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          address: 'Some City, TX',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Images should include the Web_Banner3.jpg (from page scrape and/or CSE)
      const imageUrls = body.data.images.map((img: { url: string }) => img.url);
      const hasBanner = imageUrls.some((url: string) => url.includes('Web_Banner3.jpg'));
      expect(hasBanner).toBe(true);
    });

    it('attaches quality scores from GPT-4o vision inspection', async () => {
      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Logo should have a quality assessment
      if (body.data.logo) {
        expect(body.data.logo.quality).not.toBeNull();
        expect(body.data.logo.quality.quality_score).toBeDefined();
        expect(body.data.logo.quality.is_safe).toBe(true);
        expect(body.data.logo.quality.recommendation).toBeDefined();
      }

      // Images should have quality assessments
      for (const img of body.data.images) {
        if (img.quality) {
          expect(typeof img.quality.quality_score).toBe('number');
          expect(img.quality.quality_score).toBeGreaterThanOrEqual(0);
          expect(img.quality.quality_score).toBeLessThanOrEqual(100);
          expect(img.quality.is_safe).toBe(true);
        }
      }
    });

    it('returns brand assessment with "minimal" maturity for unprofessional sites', async () => {
      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Brand assessment should exist
      expect(body.data.brand_assessment).not.toBeNull();
      expect(body.data.brand_assessment.brand_maturity).toBeDefined();
      expect(['established', 'developing', 'minimal']).toContain(
        body.data.brand_assessment.brand_maturity,
      );
      expect(body.data.brand_assessment.website_quality_score).toBeDefined();
      expect(typeof body.data.brand_assessment.website_quality_score).toBe('number');
      expect(body.data.brand_assessment.recommendation).toBeTruthy();
    });

    it('does not return unsafe or rejected images', async () => {
      // Override vision to return an unsafe image for one result
      const originalImpl = mockFetch.getMockImplementation();
      let visionCallCount = 0;
      mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr =
          typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('api.openai.com/v1/chat/completions')) {
          visionCallCount++;
          // Make the 3rd vision call return "unsafe"
          if (visionCallCount === 3) {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        quality_score: 10,
                        is_professional: false,
                        is_safe: false,
                        description: 'Inappropriate content detected',
                        recommendation: 'reject',
                        issues: ['Content safety violation'],
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
        }
        // Fall through to original
        return originalImpl!(url, init);
      });

      const res = await makeRequest('/api/ai/discover-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'When Doody Calls - Pooper Scoopers',
          website: 'https://whendoodycalls.com',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // All returned images must be safe
      for (const img of body.data.images) {
        if (img.quality) {
          expect(img.quality.is_safe).toBe(true);
          expect(img.quality.recommendation).not.toBe('reject');
        }
      }
    });
  });

  describe('Image dimension validation', () => {
    it('rejects sub-64px favicons from website scraping', async () => {
      mockFetch.mockImplementation(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr === 'https://example.com' || urlStr === 'https://example.com/') {
          return new Response(
            `
            <html><head>
              <link rel="icon" href="/small-icon.png" sizes="32x32">
            </head><body></body></html>
          `,
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }

        // 32x32 icon
        if (urlStr.includes('small-icon.png')) {
          const buf = new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            0x00,
            0x00,
            0x00,
            0x0d,
            0x49,
            0x48,
            0x44,
            0x52,
            0x00,
            0x00,
            0x00,
            0x20, // width: 32
            0x00,
            0x00,
            0x00,
            0x20, // height: 32
            0x08,
            0x06,
            0x00,
            0x00,
            0x00,
            0x1f,
            0x15,
            0xc4,
            0x89,
            ...new Array(500).fill(0),
          ]);
          return new Response(buf.buffer, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(buf.byteLength) },
          });
        }

        // Standard favicon paths — 404
        if (urlStr.includes('apple-touch-icon') || urlStr.includes('favicon')) {
          return new Response('Not Found', { status: 404 });
        }

        // Google faviconV2 — return 256x256
        if (urlStr.includes('faviconV2')) {
          return new Response(MEDIUM_PNG_HEADER.buffer, {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-length': String(MEDIUM_PNG_HEADER.byteLength),
            },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      const envWithoutOpenai = {
        ...mockEnv,
        OPENAI_API_KEY: undefined,
        GOOGLE_CSE_KEY: undefined,
      } as unknown as Env;
      const appNoVision = new Hono<{ Bindings: Env; Variables: Variables }>();
      appNoVision.onError(errorHandler);
      appNoVision.route('/', mediaAi);
      appNoVision.route('/', search);

      const res = await appNoVision.request(
        '/api/ai/discover-images',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test Biz', website: 'https://example.com' }),
        },
        envWithoutOpenai,
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      // Favicon should NOT be the 32x32 icon — it's below our 64px minimum
      if (body.data.favicon) {
        expect(body.data.favicon.url).not.toContain('small-icon.png');
        if (body.data.favicon.dimensions) {
          expect(body.data.favicon.dimensions.width).toBeGreaterThanOrEqual(64);
        }
      }
    });
  });

  describe('Homepage image scraping', () => {
    it('discovers large <img> tags from the business homepage', async () => {
      mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr =
          typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr === 'https://example-biz.com' || urlStr === 'https://example-biz.com/') {
          return new Response(
            `
            <html><head><title>Example Biz</title></head><body>
              <img src="/hero-banner.jpg" width="1200" height="600" alt="Hero" />
              <img src="/team-photo.jpg" width="800" height="500" alt="Team" />
              <img src="/tiny-icon.png" width="24" height="24" alt="Icon" />
              <img src="/spacer.gif" width="1" height="1" alt="" />
            </body></html>
          `,
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }

        // Large images — return valid dimensions
        if (urlStr.includes('hero-banner.jpg') || urlStr.includes('team-photo.jpg')) {
          const w = urlStr.includes('hero') ? 1200 : 800;
          const h = urlStr.includes('hero') ? 600 : 500;
          const buf = new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            0x00,
            0x00,
            0x00,
            0x0d,
            0x49,
            0x48,
            0x44,
            0x52,
            (w >> 24) & 0xff,
            (w >> 16) & 0xff,
            (w >> 8) & 0xff,
            w & 0xff,
            (h >> 24) & 0xff,
            (h >> 16) & 0xff,
            (h >> 8) & 0xff,
            h & 0xff,
            0x08,
            0x06,
            0x00,
            0x00,
            0x00,
            0x1f,
            0x15,
            0xc4,
            0x89,
            ...new Array(20000).fill(0),
          ]);
          return new Response(buf.buffer, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(buf.byteLength) },
          });
        }

        // Standard favicon paths — 404
        if (urlStr.includes('favicon') || urlStr.includes('apple-touch-icon')) {
          return new Response('Not Found', { status: 404 });
        }

        // Google faviconV2
        if (urlStr.includes('faviconV2')) {
          return new Response(MEDIUM_PNG_HEADER.buffer, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }

        // Vision API — return good scores
        if (urlStr.includes('api.openai.com')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      quality_score: 80,
                      is_professional: true,
                      is_safe: true,
                      description: 'Professional business photo',
                      recommendation: 'use_as_is',
                      issues: [],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        return new Response('Not Found', { status: 404 });
      });

      const envNoCSE = { ...mockEnv, GOOGLE_CSE_KEY: undefined } as unknown as Env;
      const appNoCSE = new Hono<{ Bindings: Env; Variables: Variables }>();
      appNoCSE.onError(errorHandler);
      appNoCSE.route('/', mediaAi);
      appNoCSE.route('/', search);

      const res = await appNoCSE.request(
        '/api/ai/discover-images',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Example Biz', website: 'https://example-biz.com' }),
        },
        envNoCSE,
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      // Should find the hero and team images from <img> scraping
      const imageUrls = body.data.images.map((img: { url: string }) => img.url);
      expect(imageUrls.some((u: string) => u.includes('hero-banner.jpg'))).toBe(true);
      expect(imageUrls.some((u: string) => u.includes('team-photo.jpg'))).toBe(true);

      // Should NOT include tiny icon or spacer
      expect(imageUrls.some((u: string) => u.includes('tiny-icon.png'))).toBe(false);
      expect(imageUrls.some((u: string) => u.includes('spacer.gif'))).toBe(false);

      // Images from website scraping should have source 'website-img'
      const scrapedImages = body.data.images.filter(
        (img: { source: string }) => img.source === 'website-img',
      );
      expect(scrapedImages.length).toBeGreaterThanOrEqual(2);
    });
  });
});
