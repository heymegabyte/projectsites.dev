/**
 * CRAWL-2 route-layer coverage for the whole-site-crawl Hono handlers.
 *
 * Proves the security + gate contract WITHOUT the network:
 *  - SSRF guard THROWS → 400 for each class (localhost / loopback / RFC1918 / link-local /
 *    cloud-metadata / non-http(s) / credentials-in-URL) — and the provider is NEVER started.
 *  - Flag off → 404 (dark, never 403); unauthenticated → 401.
 *  - Valid request → 202 with the CrawlJob; ownership is bound to the caller's org.
 *  - Authz: a foreign/unknown :id → 404 (never leaks another org's job); cross-org → 404.
 *
 * The CloudflareCrawlProvider + feature-flag resolver are MOCKED; `isSafeCrawlUrl`
 * (outbound_webhooks) is REAL so the SSRF guard is genuinely exercised. @swc/jest hoists
 * `jest.mock(...)` only with the GLOBAL `jest` — do NOT import `jest` from `@jest/globals`. A
 * `jest.mock` of a `src/` module from here needs FOUR `../` to reach `src/`.
 */
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));

const startMock = jest.fn();
const statusMock = jest.fn();
const resultsMock = jest.fn();
const cancelMock = jest.fn();

// Mock the provider so start/status/results/cancel are observable and never hit CF.
jest.mock('../provider.js', () => ({
  CloudflareCrawlProvider: jest.fn().mockImplementation(() => ({
    start: startMock,
    status: statusMock,
    results: resultsMock,
    cancel: cancelMock,
  })),
}));

import { Hono } from 'hono';
import { siteCrawl } from '../handlers';
import { errorHandler } from '../../../../src/middleware/error_handler.js';
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';

const mFlag = isFlagOn as jest.MockedFunction<typeof isFlagOn>;

/** Build an app with the handler mounted + optional identity on the context. */
function app(ids?: { orgId?: string; userId?: string }) {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('*', async (c, next) => {
    if (ids?.orgId) c.set('orgId' as never, ids.orgId as never);
    if (ids?.userId) c.set('userId' as never, ids.userId as never);
    c.set('requestId' as never, 'test-req' as never);
    await next();
  });
  a.route('/', siteCrawl);
  return a;
}
const authed = (orgId = 'org1') => app({ orgId, userId: 'u1' });
const env = {} as never;
const post = (b: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

const JOB_ID = 'c7f8s2d9-a8e7-4b6e-8e4d-3d4a1b2c3f4e';
const PAGE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** A started job the provider returns + binds to the caller's org. */
function startedJob(url = 'https://example.com') {
  return { id: JOB_ID, status: 'running', url, createdAt: '2026-10-04T00:00:00.000Z' };
}

/** Start a crawl and return its bound id (so :id routes are owned by the caller). */
async function startOwnedCrawl(a = authed()): Promise<string> {
  startMock.mockResolvedValueOnce(startedJob());
  const res = await a.request('/api/crawl', post({ url: 'https://example.com' }), env);
  expect(res.status).toBe(202);
  return JOB_ID;
}

beforeEach(() => {
  jest.clearAllMocks();
  mFlag.mockResolvedValue(true); // flag ON by default; individual tests flip it off
});

describe('SSRF guard — POST /api/crawl rejects internal/unsafe targets (400, provider never starts)', () => {
  const unsafe: Array<[string, string]> = [
    ['localhost', 'http://localhost/'],
    ['loopback 127.0.0.1', 'http://127.0.0.1/'],
    ['loopback 127.x range', 'http://127.1.2.3/'],
    ['RFC1918 10/8', 'http://10.0.0.1/'],
    ['RFC1918 172.16/12', 'http://172.16.5.4/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['link-local 169.254', 'http://169.254.0.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['non-http scheme (ftp)', 'ftp://example.com/'],
    ['non-http scheme (file)', 'file:///etc/passwd'],
    ['credentials in URL', 'https://user:pass@example.com/'],
  ];

  it.each(unsafe)('rejects %s → 400 and does not start the provider', async (_label, url) => {
    const res = await authed().request('/api/crawl', post({ url }), env);
    // `file://`/`ftp://` fail `z.string().url()`? No — url() accepts them, so the SSRF guard is
    // the gate. Either way the status is a 400 and no crawl is started.
    expect(res.status).toBe(400);
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('gate — flag + auth', () => {
  it('flag OFF → 404 (dark, never 403)', async () => {
    mFlag.mockResolvedValue(false);
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), env);
    expect(res.status).toBe(404);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401', async () => {
    const res = await app().request('/api/crawl', post({ url: 'https://example.com' }), env);
    expect(res.status).toBe(401);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('GET :id flag OFF → 404 (even for an otherwise-valid id)', async () => {
    const id = await startOwnedCrawl();
    mFlag.mockResolvedValue(false);
    const res = await authed().request(`/api/crawl/${id}`, undefined, env);
    expect(res.status).toBe(404);
  });
});

describe('happy path — start returns a job (202)', () => {
  it('valid request → 202 with the CrawlJob', async () => {
    startMock.mockResolvedValueOnce(startedJob());
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), env);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; job: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe(JOB_ID);
    expect(body.job.status).toBe('running');
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('malformed body → 400 (Zod rejects at the boundary), provider never starts', async () => {
    const res = await authed().request('/api/crawl', post({ notAUrl: 1 }), env);
    expect(res.status).toBe(400);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('a provider failure on start → 502 (typed CRAWL_PROVIDER_ERROR, never an unhandled 500)', async () => {
    startMock.mockRejectedValueOnce(new Error('CF 500'));
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CRAWL_PROVIDER_ERROR');
  });
});

describe('tenant authz — :id handlers scope to the caller org', () => {
  it('status/pages/links/export/delete on an UNKNOWN id → 404', async () => {
    // A never-started id — the jobOrg map is module-level + persists across tests, so use a
    // distinct UUID no other test binds (proves an unbound id 404s, not that the map is empty).
    const UNKNOWN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const paths = [
      ['GET', `/api/crawl/${UNKNOWN}`],
      ['GET', `/api/crawl/${UNKNOWN}/pages`],
      ['GET', `/api/crawl/${UNKNOWN}/pages/${PAGE_ID}`],
      ['GET', `/api/crawl/${UNKNOWN}/links`],
      ['GET', `/api/crawl/${UNKNOWN}/export.md`],
      ['DELETE', `/api/crawl/${UNKNOWN}`],
    ] as const;
    for (const [method, path] of paths) {
      const res = await authed().request(path, { method }, env);
      expect(res.status).toBe(404);
    }
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('a DIFFERENT org cannot read a job started by org1 → 404', async () => {
    await startOwnedCrawl(authed('org1')); // bound to org1
    const res = await authed('org2').request(`/api/crawl/${JOB_ID}`, undefined, env);
    expect(res.status).toBe(404);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('the OWNING org reads its job → 200', async () => {
    await startOwnedCrawl(authed('org1'));
    statusMock.mockResolvedValueOnce({ ...startedJob(), status: 'completed' });
    const res = await authed('org1').request(`/api/crawl/${JOB_ID}`, undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; job: { status: string } };
    expect(body.job.status).toBe('completed');
  });
});

describe('results — pages / links / export exhaust the provider cursor', () => {
  function page(url: string): import('../schemas').CrawlPage {
    return {
      id: PAGE_ID,
      discoveredUrl: url,
      requestedUrl: url,
      finalUrl: url,
      markdown: `# ${url}\n\nbody`,
      metadata: {},
      contentHash: 'deadbeef',
    };
  }

  it('GET /pages exhausts the cursor across windows', async () => {
    await startOwnedCrawl();
    resultsMock
      .mockResolvedValueOnce({ pages: [page('https://example.com/a')], links: [], cursor: 'n1' })
      .mockResolvedValueOnce({ pages: [page('https://example.com/b')], links: [] }); // no cursor = done
    const res = await authed().request(`/api/crawl/${JOB_ID}/pages`, undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; pages: unknown[] };
    expect(body.count).toBe(2);
    expect(resultsMock).toHaveBeenCalledTimes(2); // proved the cursor was followed
  });

  it('GET /links returns the discovered edges', async () => {
    await startOwnedCrawl();
    resultsMock.mockResolvedValueOnce({
      pages: [],
      links: [{ from: 'https://example.com/', to: 'https://example.com/a', kind: 'internal' }],
    });
    const res = await authed().request(`/api/crawl/${JOB_ID}/links`, undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  it('GET /export.md returns source-URL-delimited markdown', async () => {
    await startOwnedCrawl();
    resultsMock.mockResolvedValueOnce({
      pages: [page('https://example.com/a'), page('https://example.com/b')],
      links: [],
    });
    const res = await authed().request(`/api/crawl/${JOB_ID}/export.md`, undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('## https://example.com/a');
    expect(text).toContain('## https://example.com/b');
    expect(text).toContain('---'); // page delimiter
  });

  it('GET /pages/:pageId for a missing page → 404', async () => {
    await startOwnedCrawl();
    resultsMock.mockResolvedValueOnce({ pages: [], links: [] });
    const res = await authed().request(
      `/api/crawl/${JOB_ID}/pages/00000000-0000-4000-8000-000000000000`,
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/crawl/:id — cancel', () => {
  it('owning org cancels its job → 200 (idempotent at the provider)', async () => {
    await startOwnedCrawl();
    cancelMock.mockResolvedValueOnce(undefined);
    const res = await authed().request(`/api/crawl/${JOB_ID}`, { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(cancelMock).toHaveBeenCalledWith(JOB_ID);
  });
});

describe('CRAWL-3 — POST /api/crawl fires the durable workflow (flag-dark, additive, fail-soft)', () => {
  /** An env carrying the SITE_CRAWL_WORKFLOW binding with an observable `create`. */
  const envWith = (create: jest.Mock) => ({ SITE_CRAWL_WORKFLOW: { create } }) as never;

  it('fires SITE_CRAWL_WORKFLOW.create keyed by the job id when the binding is present (durable:true)', async () => {
    startMock.mockResolvedValueOnce(startedJob());
    const create = jest.fn().mockResolvedValue({ id: JOB_ID });
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), envWith(create));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; durable: boolean; job: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.durable).toBe(true);
    expect(body.job.id).toBe(JOB_ID);
    expect(create).toHaveBeenCalledTimes(1);
    // The workflow id is the crawl/job id; params carry crawlId + orgId + the Zod-validated request.
    const arg = create.mock.calls[0][0] as {
      id: string;
      params: { crawlId: string; url: string; mode: string; orgId: string };
    };
    expect(arg.id).toBe(JOB_ID);
    expect(arg.params.crawlId).toBe(JOB_ID);
    expect(arg.params.orgId).toBe('org1');
    expect(arg.params.url).toBe('https://example.com');
    // The inline provider still started the crawl (ownership binding is unchanged).
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the inline path (durable:false, still 202) when the binding is ABSENT', async () => {
    startMock.mockResolvedValueOnce(startedJob());
    // `env` is `{}` — no SITE_CRAWL_WORKFLOW — so the handler takes the inline-only path.
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), env);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; durable: boolean };
    expect(body.ok).toBe(true);
    expect(body.durable).toBe(false);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('a workflow-create FAILURE degrades to the inline path (durable:false, 202 — never 500)', async () => {
    startMock.mockResolvedValueOnce(startedJob());
    const create = jest.fn().mockRejectedValue(new Error('workflow quota'));
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), envWith(create));
    expect(res.status).toBe(202); // the already-started inline job keeps the request successful
    const body = (await res.json()) as { ok: boolean; durable: boolean };
    expect(body.ok).toBe(true);
    expect(body.durable).toBe(false); // create threw → fell back to inline
  });

  it('flag OFF → 404 and the workflow is NEVER created (dark)', async () => {
    mFlag.mockResolvedValue(false);
    const create = jest.fn();
    const res = await authed().request('/api/crawl', post({ url: 'https://example.com' }), envWith(create));
    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('an SSRF-unsafe seed → 400 and the workflow is NEVER created', async () => {
    const create = jest.fn();
    const res = await authed().request('/api/crawl', post({ url: 'http://169.254.169.254/' }), envWith(create));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });
});
