/**
 * CRAWL-1 unit coverage — the `CloudflareCrawlProvider` Browser-Run adapter.
 *
 * Mocks global `fetch` + `resolveCfCredentials` to prove, WITHOUT touching the network:
 *  - `start()` POSTs `/browser-rendering/crawl` with the research defaults + maps our request fields,
 *    and returns a typed `CrawlJob` carrying CF's job id + `status:'running'`.
 *  - `status()` GETs `/crawl/{id}?limit=1` and maps CF job status → our enum + surfaces progress.
 *  - `results()` maps CF `records[]` → domain `CrawlPage[]`, carries `links`, and SURFACES the
 *    pagination cursor so the caller can EXHAUST it (first-page-only would be a correctness bug).
 *  - `cancel()` DELETEs `/crawl/{id}` and is idempotent on a 404.
 *  - No CF wire shape (`records`, bare-string `result`, numeric `cursor`) leaks past the provider.
 *
 * @swc/jest hoists `jest.mock(...)` only with the GLOBAL `jest` — no `@jest/globals` import of it.
 * A `jest.mock` of a `src/` module from here needs FOUR `../` (libs/features/<slug>/__tests__ → src).
 */
import { CloudflareCrawlProvider, mapCfJobStatus } from '../provider';
import type { Env } from '../../../../src/types/env';
import { CrawlRequestSchema } from '../schemas';

// Mock the CF credential resolver so the provider gets a deterministic token auth (no DB, no env).
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  resolveCfCredentials: jest.fn(async () => ({ kind: 'token', token: 'TEST_TOKEN' })),
  cfAuthHeaders: (auth: { kind: string; token?: string }) =>
    auth.kind === 'token' ? { Authorization: `Bearer ${auth.token}` } : {},
}));

const ACCOUNT = 'acct-123';
const JOB_ID = 'c7f8s2d9-a8e7-4b6e-8e4d-3d4a1b2c3f4e';

function makeProvider(): CloudflareCrawlProvider {
  const env = { CF_ACCOUNT_ID: ACCOUNT } as unknown as Env;
  return new CloudflareCrawlProvider(env);
}

/** Build a `Response`-like stub with a JSON body + ok/status. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('mapCfJobStatus', () => {
  it('maps every CF job status into the domain enum', () => {
    expect(mapCfJobStatus('running')).toBe('running');
    expect(mapCfJobStatus('completed')).toBe('completed');
    expect(mapCfJobStatus('cancelled_due_to_limits')).toBe('budget_exhausted');
    expect(mapCfJobStatus('cancelled_due_to_timeout')).toBe('cancelled');
    expect(mapCfJobStatus('cancelled_by_user')).toBe('cancelled');
    expect(mapCfJobStatus('errored')).toBe('failed');
  });

  it('treats an unknown CF status as still-running (never guesses terminal)', () => {
    expect(mapCfJobStatus('something_new')).toBe('running');
  });
});

describe('CloudflareCrawlProvider.start', () => {
  it('POSTs /browser-rendering/crawl with the research defaults + returns a running job with CF id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, result: JOB_ID }));
    const req = CrawlRequestSchema.parse({ url: 'https://example.com', mode: 'fast' });

    const job = await makeProvider().start(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/crawl`,
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer TEST_TOKEN');

    const body = JSON.parse(init.body);
    expect(body.url).toBe('https://example.com');
    expect(body.source).toBe('all');
    expect(body.crawlPurposes).toEqual(['search']);
    expect(body.contentUse).toBe('reference');
    expect(body.formats).toEqual(['markdown']);
    expect(body.render).toBe(false); // fast mode → no headless render

    // Returned job is the domain shape, carrying CF's id + the seed url.
    expect(job.id).toBe(JOB_ID);
    expect(job.status).toBe('running');
    expect(job.url).toBe('https://example.com');
    expect(typeof job.createdAt).toBe('string');
  });

  it('sets render:true for rendered mode and maps limit/depth/include+exclude patterns', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, result: JOB_ID }));
    const req = CrawlRequestSchema.parse({
      url: 'https://example.com',
      mode: 'rendered',
      limit: 50,
      depth: 3,
      includeSubdomains: true,
      includePatterns: ['/blog/*'],
      excludePatterns: ['/admin/*'],
      freshness: 3600,
    });

    await makeProvider().start(req);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.render).toBe(true);
    expect(body.limit).toBe(50);
    expect(body.depth).toBe(3);
    expect(body.maxAge).toBe(3600);
    expect(body.options.includeSubdomains).toBe(true);
    expect(body.options.includePatterns).toEqual(['/blog/*']);
    expect(body.options.excludePatterns).toEqual(['/admin/*']);
  });

  it('throws a typed CloudflareCrawlError on a non-2xx CF response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, 403));
    const req = CrawlRequestSchema.parse({ url: 'https://example.com' });
    await expect(makeProvider().start(req)).rejects.toThrow(/CF crawl start failed/);
  });
});

describe('CloudflareCrawlProvider.status', () => {
  it('GETs /crawl/{id}?limit=1 and maps status + progress counts', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: {
          id: JOB_ID,
          status: 'completed',
          total: 42,
          finished: 42,
          records: [{ url: 'https://example.com/', metadata: { url: 'https://example.com/' } }],
        },
      }),
    );

    const job = await makeProvider().status(JOB_ID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/crawl/${JOB_ID}?limit=1`,
    );
    expect(init.method).toBe('GET');
    expect(job.id).toBe(JOB_ID);
    expect(job.status).toBe('completed');
    expect(job.pagesDiscovered).toBe(42);
    expect(job.pagesCompleted).toBe(42);
    expect(job.completedAt).toBeDefined();
  });

  it('maps a running job and omits completedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, result: { id: JOB_ID, status: 'running', total: 10, finished: 3 } }),
    );
    const job = await makeProvider().status(JOB_ID);
    expect(job.status).toBe('running');
    expect(job.pagesCompleted).toBe(3);
    expect(job.completedAt).toBeUndefined();
    // No records → the seed url falls back to a valid placeholder (schema url invariant holds).
    expect(() => new URL(job.url)).not.toThrow();
  });
});

describe('CloudflareCrawlProvider.results', () => {
  it('maps CF records → CrawlPage[] and SURFACES the pagination cursor (so the caller can exhaust)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: {
          id: JOB_ID,
          status: 'running',
          records: [
            {
              url: 'https://example.com/',
              status: 'completed',
              markdown: '# Home',
              metadata: { title: 'Home', url: 'https://example.com/', status: 200 },
            },
            {
              url: 'https://example.com/about',
              status: 'completed',
              markdown: '# About',
              metadata: { title: 'About', url: 'https://example.com/about' },
            },
          ],
          cursor: 10,
        },
      }),
    );

    const page = await makeProvider().results(JOB_ID);

    // First call has NO cursor query param.
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/crawl/${JOB_ID}`,
    );
    expect(page.pages).toHaveLength(2);
    expect(page.pages[0].discoveredUrl).toBe('https://example.com/');
    expect(page.pages[0].markdown).toBe('# Home');
    expect(page.pages[0].title).toBe('Home');
    expect(page.pages[0].contentHash).toMatch(/^[0-9a-f]{8}$/);
    // Every page id is a fresh UUID (domain id, not a CF shape).
    expect(page.pages[0].id).not.toBe(page.pages[1].id);
    // Cursor surfaced as a STRING so the caller can keep paginating.
    expect(page.cursor).toBe('10');
    expect(page.links).toEqual([]);
  });

  it('passes the cursor back as ?cursor= and returns undefined cursor when the crawl is exhausted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: {
          id: JOB_ID,
          status: 'completed',
          records: [{ url: 'https://example.com/last', status: 'completed', markdown: 'end' }],
          // no cursor → last window
        },
      }),
    );

    const page = await makeProvider().results(JOB_ID, '10');

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/crawl/${JOB_ID}?cursor=10`,
    );
    expect(page.cursor).toBeUndefined(); // exhausted — the caller's loop terminates
    expect(page.pages).toHaveLength(1);
  });

  it('skips non-completed records (queued/disallowed/errored carry no usable content)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: {
          id: JOB_ID,
          status: 'running',
          records: [
            { url: 'https://example.com/ok', status: 'completed', markdown: 'ok' },
            { url: 'https://example.com/blocked', status: 'disallowed' },
            { url: 'https://example.com/queued', status: 'queued' },
          ],
        },
      }),
    );

    const page = await makeProvider().results(JOB_ID);
    expect(page.pages).toHaveLength(1);
    expect(page.pages[0].discoveredUrl).toBe('https://example.com/ok');
  });

  it('can EXHAUST pagination across multiple windows by re-calling with the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            id: JOB_ID,
            status: 'running',
            records: [{ url: 'https://example.com/1', status: 'completed', markdown: 'a' }],
            cursor: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            id: JOB_ID,
            status: 'completed',
            records: [{ url: 'https://example.com/2', status: 'completed', markdown: 'b' }],
          },
        }),
      );

    const provider = makeProvider();
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.results(JOB_ID, cursor);
      all.push(...page.pages.map((p) => p.discoveredUrl));
      cursor = page.cursor;
    } while (cursor);

    expect(all).toEqual(['https://example.com/1', 'https://example.com/2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('?cursor=1');
  });
});

describe('CloudflareCrawlProvider.cancel', () => {
  it('DELETEs /crawl/{id}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }, 200));
    await makeProvider().cancel(JOB_ID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/crawl/${JOB_ID}`,
    );
    expect(init.method).toBe('DELETE');
  });

  it('is idempotent — a 404 (already gone) is NOT an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 404));
    await expect(makeProvider().cancel(JOB_ID)).resolves.toBeUndefined();
  });

  it('throws a typed error on a CF 5xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, 500));
    await expect(makeProvider().cancel(JOB_ID)).rejects.toThrow(/CF crawl cancel failed/);
  });
});
