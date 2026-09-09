/**
 * Unit tests for the dynamic /api/sites/by-slug/:slug/chat endpoint.
 *
 * The endpoint reads ALL current files from R2 and dynamically constructs
 * a bolt.diy-compatible chat JSON with boltArtifact/boltAction tags.
 * No static chat.json is needed — always in sync with latest files.
 */

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

jest.mock('../lib/posthog.js', () => ({
  capture: jest.fn(),
  trackAuth: jest.fn(),
  trackSite: jest.fn(),
  trackError: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { api } from '../routes/api.js';
import { siteBySlug } from '../../libs/features/site_by_slug/handlers.js';

function createMockR2Object(data: unknown) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(typeof data === 'string' ? JSON.parse(data) : data),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
  };
}

function createApp(r2GetMock: jest.Mock, dbPrepare?: jest.Mock) {
  const env = {
    ENVIRONMENT: 'test',
    DB: {
      prepare:
        dbPrepare ??
        jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue({ business_name: 'Test Business' }),
            all: jest.fn().mockResolvedValue({ results: [] }),
            run: jest.fn().mockResolvedValue({}),
          }),
        }),
    } as unknown as D1Database,
    SITES_BUCKET: {
      get: r2GetMock,
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ objects: [], truncated: false }),
    },
    SENDGRID_API_KEY: 'test-sendgrid-key',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    STRIPE_SECRET_KEY: 'test-stripe-key',
    STRIPE_WEBHOOK_SECRET: 'test-stripe-webhook',
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.route('/', siteBySlug);
  app.route('/', api);

  return { app, env };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/sites/by-slug/:slug/chat', () => {
  it('returns 200 with dynamically built chat JSON containing boltArtifact', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({
            current_version: 'v1',
            files: ['index.html', 'about.html', 'robots.txt'],
          }),
        );
      }
      if (key === 'sites/test-site/v1/index.html') {
        return Promise.resolve(
          createMockR2Object('<!DOCTYPE html><html><body><h1>Test</h1></body></html>'),
        );
      }
      if (key === 'sites/test-site/v1/about.html') {
        return Promise.resolve(
          createMockR2Object('<!DOCTYPE html><html><body><h1>About</h1></body></html>'),
        );
      }
      if (key === 'sites/test-site/v1/robots.txt') {
        return Promise.resolve(createMockR2Object('User-agent: *\nAllow: /'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();

    // Must have two messages (user + assistant)
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');

    // Assistant message must contain boltArtifact with file actions
    const content = body.messages[1].content;
    expect(content).toContain('<boltArtifact');
    expect(content).toContain('</boltArtifact>');
    expect(content).toContain('<boltAction type="file" filePath="index.html">');
    expect(content).toContain('<boltAction type="file" filePath="about.html">');
    expect(content).toContain('<boltAction type="file" filePath="robots.txt">');

    // File content must be embedded
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('User-agent');

    // Must have description and exportDate
    expect(body.description).toBeTruthy();
    expect(body.exportDate).toBeTruthy();
  });

  it('returns CORS header Access-Control-Allow-Origin: *', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v1', files: ['index.html'] }),
        );
      }
      if (key === 'sites/test-site/v1/index.html') {
        return Promise.resolve(createMockR2Object('<html></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('filters out research.json and _meta/ files', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({
            current_version: 'v1',
            files: ['index.html', 'research.json', '_meta/chat.json'],
          }),
        );
      }
      if (key === 'sites/test-site/v1/index.html') {
        return Promise.resolve(createMockR2Object('<html></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    const content = body.messages[1].content;
    expect(content).not.toContain('filePath="research.json"');
    expect(content).not.toContain('filePath="_meta/');
  });

  it('does not require authentication (slug is access token)', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/public-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v1', files: ['index.html'] }),
        );
      }
      if (key === 'sites/public-site/v1/index.html') {
        return Promise.resolve(createMockR2Object('<html></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    // No Authorization header
    const res = await app.request('/api/sites/by-slug/public-site/chat', {}, env);

    expect(res.status).toBe(200);
  });

  it('returns Cache-Control: no-cache, no-store, must-revalidate', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v1', files: ['index.html'] }),
        );
      }
      if (key === 'sites/test-site/v1/index.html') {
        return Promise.resolve(createMockR2Object('<html></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
  });

  // Graceful empty-state: the editor auto-imports /chat via importChatFrom, so
  // a 404 logs an un-suppressable "Failed to load resource: 404" on our origin
  // for every admin route. These now return 200 with an empty bolt chat so the
  // editor boots a fresh workbench silently. See emptyBoltChatResponse().
  it('returns 200 with an empty bolt chat when manifest does not exist', async () => {
    const r2Get = jest.fn().mockResolvedValue(null);

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/nonexistent/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
    expect(body.exportDate).toBeTruthy();
  });

  it('returns 200 with an empty bolt chat when manifest has no current_version', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/no-version/_manifest.json') {
        return Promise.resolve(createMockR2Object({ current_version: '' }));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/no-version/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('returns 200 with an empty bolt chat when no files found in R2', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/empty-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v1', files: ['index.html'] }),
        );
      }
      // All file reads return null
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/empty-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('looks up business name from D1', async () => {
    const dbPrepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue({ business_name: "Vito's Mens Salon" }),
        all: jest.fn().mockResolvedValue({ results: [] }),
        run: jest.fn().mockResolvedValue({}),
      }),
    });

    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/vitos-mens-salon/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v1', files: ['index.html'] }),
        );
      }
      if (key === 'sites/vitos-mens-salon/v1/index.html') {
        return Promise.resolve(createMockR2Object('<html></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get, dbPrepare);
    const res = await app.request('/api/sites/by-slug/vitos-mens-salon/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toContain("Vito's Mens Salon");
    expect(body.messages[0].content).toContain("Vito's Mens Salon");
  });

  it('falls back to the VERSION-PINNED manifest via D1 when the site-root manifest is missing (workflow-built sites)', async () => {
    // upload-to-r2.mjs writes the manifest ONLY at
    // sites/{slug}/{version}/_manifest.json — the site-root copy is a
    // legacy bolt-publish artifact. Root-first resolution made this
    // endpoint return an EMPTY chat for every workflow-built site, so
    // the editor opened with zero files (journey 2026-08-19).
    const dbPrepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest
          .fn()
          .mockResolvedValue({ business_name: 'Test Business', current_build_version: 'v9' }),
        all: jest.fn().mockResolvedValue({ results: [] }),
        run: jest.fn().mockResolvedValue({}),
      }),
    });

    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') return Promise.resolve(null);
      if (key === 'sites/test-site/v9/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v9', files: ['index.html'] }),
        );
      }
      if (key === 'sites/test-site/v9/index.html') {
        return Promise.resolve(createMockR2Object('<html><h1>Live</h1></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get, dbPrepare);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('filePath="index.html"');
    expect(body.messages[1].content).toContain('<h1>Live</h1>');
  });

  it('falls THROUGH to the version-pinned manifest when the root copy exists but lists zero files (the old upload path wrote files: [])', async () => {
    const dbPrepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest
          .fn()
          .mockResolvedValue({ business_name: 'Test Business', current_build_version: 'v8' }),
        all: jest.fn().mockResolvedValue({ results: [] }),
        run: jest.fn().mockResolvedValue({}),
      }),
    });

    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(createMockR2Object({ current_version: 'v7', files: [] }));
      }
      if (key === 'sites/test-site/v8/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({ current_version: 'v8', files: ['index.html'] }),
        );
      }
      if (key === 'sites/test-site/v8/index.html') {
        return Promise.resolve(createMockR2Object('<html><h1>FallThrough</h1></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get, dbPrepare);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('filePath="index.html"');
    expect(body.messages[1].content).toContain('<h1>FallThrough</h1>');
  });

  it('normalizes v2 manifest files shaped as {name,size,type} objects (the container manifest writer)', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/test-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({
            current_version: 'v2',
            files: [{ name: 'index.html', size: 120, type: 'text/html' }],
          }),
        );
      }
      if (key === 'sites/test-site/v2/index.html') {
        return Promise.resolve(createMockR2Object('<html><h1>Obj</h1></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/test-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('filePath="index.html"');
    expect(body.messages[1].content).toContain('<h1>Obj</h1>');
  });

  it('falls back to compiled files when a vite manifest lists no source_files (the container ships no _src)', async () => {
    const r2Get = jest.fn().mockImplementation((key: string) => {
      if (key === 'sites/vite-site/_manifest.json') {
        return Promise.resolve(
          createMockR2Object({
            current_version: 'v3',
            is_vite_project: true,
            files: [{ name: 'index.html', size: 10, type: 'text/html' }],
          }),
        );
      }
      if (key === 'sites/vite-site/v3/_src/index.html') return Promise.resolve(null);
      if (key === 'sites/vite-site/v3/index.html') {
        return Promise.resolve(createMockR2Object('<html><h1>Compiled</h1></html>'));
      }
      return Promise.resolve(null);
    });

    const { app, env } = createApp(r2Get);
    const res = await app.request('/api/sites/by-slug/vite-site/chat', {}, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('filePath="index.html"');
    expect(body.messages[1].content).toContain('<h1>Compiled</h1>');
  });
});
