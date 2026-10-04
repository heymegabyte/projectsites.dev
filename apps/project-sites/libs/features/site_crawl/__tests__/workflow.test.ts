/**
 * CRAWL-3 unit coverage for {@link SiteCrawlWorkflow} — the durable whole-site-crawl lifecycle.
 *
 * Proves the step contract WITHOUT the network or the CF runtime:
 *  - The documented step sequence fires IN ORDER: start → monitor(poll) → collect → persist →
 *    finalize, each with the 30s exponential retry config.
 *  - The monitor poll loop ends on a terminal status (and `step.sleep` runs between polls).
 *  - `collect` exhausts the provider cursor across windows.
 *  - `persist` calls `persistCrawl` with the collected pages/links + ownership/request context.
 *  - The finalize result carries the coverage roll-up (status, counts, persisted).
 *  - The HANDLER-side absent-binding fallback: `POST /api/crawl` still 202s (inline path) when
 *    `SITE_CRAWL_WORKFLOW` is undefined, and fires `.create` when it's present.
 *
 * `cloudflare:workers` is stubbed (virtual), the provider + persistCrawl are MOCKED. @swc/jest hoists
 * `jest.mock(...)` only with the GLOBAL `jest` — do NOT import `jest` from `@jest/globals`.
 */

jest.mock(
  'cloudflare:workers',
  () => ({
    __esModule: true,
    WorkflowEntrypoint: class<E, P> {
      env: E;
      constructor(_ctx: unknown, env: E) {
        this.env = env;
      }
    },
    DurableObject: class<E> {
      ctx: unknown;
      env: E;
      constructor(ctx: unknown, env: E) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }),
  { virtual: true },
);

// Mock the CF Browser-Run provider so start/status/results are observable + never hit CF. The mock
// specifier is relative to THIS test file (`../provider.js`), which resolves to the SAME module the
// workflow imports via `../../libs/features/site_crawl/provider.js`.
const startMock = jest.fn();
const statusMock = jest.fn();
const resultsMock = jest.fn();
const cancelMock = jest.fn();
jest.mock('../provider.js', () => ({
  CloudflareCrawlProvider: jest.fn().mockImplementation(() => ({
    start: startMock,
    status: statusMock,
    results: resultsMock,
    cancel: cancelMock,
  })),
}));

// Mock persistence so `persist` is observable + never touches R2/D1.
// Define the fn INSIDE the factory (not an outer const): @swc/jest hoists `jest.mock(...)` above the
// const declarations AND the import block, and site-crawl.ts imports persistence at MODULE-LOAD — so a
// factory that reads an outer `const persistMock` hits the TDZ ("Cannot access 'persistMock' before
// initialization"). Retrieve the ref via the mocked import below instead. (The provider mock above is
// safe because its `.mockImplementation(() => ...)` closure is only invoked lazily, inside a test.)
jest.mock('../persistence.js', () => ({
  persistCrawl: jest.fn(),
}));

import {
  SiteCrawlWorkflow,
  normalizeCrawlUrl,
  scorePageQuality,
  dedupeAndScorePages,
} from '../../../../src/workflows/site-crawl.js';
import { persistCrawl } from '../persistence.js';
import type { Env } from '../../../../src/types/env.js';
import type { CrawlJob, CrawlPage } from '../schemas.js';

/** The mocked `persistCrawl`, retrieved after the import so the factory never reads it eagerly. */
const persistMock = persistCrawl as unknown as jest.Mock;

const JOB_ID = 'c7f8s2d9-a8e7-4b6e-8e4d-3d4a1b2c3f4e';
const PAGE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SEED = 'https://example.com';

/** A captured step.do/step.sleep invocation (name only — enough to assert the sequence). */
interface Invocation {
  name: string;
  kind: 'do' | 'sleep';
  config: Record<string, unknown> | undefined;
}

/**
 * A fake {@link WorkflowStep}: `do` records the name + config then runs the closure; `sleep` records
 * the name and returns immediately (no real wait). Mirrors the project's image-generation test step.
 */
function makeStep(): {
  step: {
    do: <T>(
      name: string,
      configOrFn: Record<string, unknown> | (() => Promise<T>),
      fn?: () => Promise<T>,
    ) => Promise<T>;
    sleep: (name: string, duration: string) => Promise<void>;
  };
  invocations: Invocation[];
} {
  const invocations: Invocation[] = [];
  const step = {
    do: async <T>(
      name: string,
      configOrFn: Record<string, unknown> | (() => Promise<T>),
      fn?: () => Promise<T>,
    ): Promise<T> => {
      const hasConfig = typeof configOrFn !== 'function';
      const config = hasConfig ? (configOrFn as Record<string, unknown>) : undefined;
      const actualFn = (hasConfig ? fn : (configOrFn as () => Promise<T>))!;
      invocations.push({ name, kind: 'do', config });
      return actualFn();
    },
    sleep: async (name: string): Promise<void> => {
      invocations.push({ name, kind: 'sleep', config: undefined });
    },
  };
  return { step, invocations };
}

const env = {} as unknown as Env;

/** Invoke the workflow with the given params, returning the result + recorded invocations. */
async function runWorkflow(params: {
  crawlId?: string;
  url?: string;
  mode?: 'fast' | 'auto' | 'rendered';
  orgId?: string | null;
  request?: unknown;
}) {
  const wf = new SiteCrawlWorkflow({} as unknown as DurableObjectState, env);
  const { step, invocations } = makeStep();
  const result = await wf.run(
    {
      payload: {
        crawlId: params.crawlId ?? JOB_ID,
        url: params.url ?? SEED,
        mode: params.mode ?? 'auto',
        orgId: params.orgId === undefined ? 'org1' : params.orgId,
        request: params.request,
      },
      timestamp: new Date(),
      instanceId: 'i1',
    } as Parameters<typeof wf.run>[0],
    step as unknown as Parameters<typeof wf.run>[1],
  );
  return { result, invocations };
}

function startedJob(status: CrawlJob['status'] = 'running'): CrawlJob {
  return { id: JOB_ID, status, url: SEED, createdAt: '2026-10-04T00:00:00.000Z', pagesDiscovered: 0, pagesCompleted: 0 };
}
function page(url: string): CrawlPage {
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

beforeEach(() => {
  jest.clearAllMocks();
  persistMock.mockResolvedValue({ ok: true, crawlId: JOB_ID, r2Prefix: '', r2Keys: [], manifest: {}, errors: [] });
});

describe('SiteCrawlWorkflow — step lifecycle', () => {
  it('runs start → monitor → collect → persist → finalize in order, with 30s retries', async () => {
    startMock.mockResolvedValueOnce(startedJob('running'));
    statusMock.mockResolvedValueOnce(startedJob('completed')); // one poll → terminal
    resultsMock.mockResolvedValueOnce({ pages: [page(`${SEED}/a`)], links: [], cursor: undefined });

    const { result, invocations } = await runWorkflow({});

    // The step.do names, in order (the monitor poll is `monitor-0`, preceded by its `poll-wait-0` sleep).
    const doNames = invocations.filter((i) => i.kind === 'do').map((i) => i.name);
    expect(doNames).toEqual(['start', 'monitor-0', 'collect', 'persist', 'finalize']);

    // A durable `step.sleep` separates the start from the first status poll.
    const sleeps = invocations.filter((i) => i.kind === 'sleep').map((i) => i.name);
    expect(sleeps).toContain('poll-wait-0');

    // Every step carries the 30s exponential retry policy.
    for (const inv of invocations.filter((i) => i.kind === 'do')) {
      const retries = (inv.config as { retries?: { limit?: number; delay?: string; backoff?: string } } | undefined)
        ?.retries;
      expect(retries?.limit).toBe(3);
      expect(retries?.delay).toBe('30 seconds');
      expect(retries?.backoff).toBe('exponential');
    }

    expect(result).toMatchObject({
      ok: true,
      crawlId: JOB_ID,
      status: 'completed',
      pagesCompleted: 1,
      persisted: true,
    });
  });

  it('polls until terminal: a still-running status keeps polling, then stops on completed', async () => {
    startMock.mockResolvedValueOnce(startedJob('running'));
    statusMock
      .mockResolvedValueOnce(startedJob('running')) // poll 1 — still in-flight
      .mockResolvedValueOnce(startedJob('running')) // poll 2 — still in-flight
      .mockResolvedValueOnce(startedJob('completed')); // poll 3 — terminal
    resultsMock.mockResolvedValueOnce({ pages: [], links: [], cursor: undefined });

    const { result, invocations } = await runWorkflow({});

    const monitorDos = invocations.filter((i) => i.kind === 'do' && i.name.startsWith('monitor-'));
    expect(monitorDos.map((i) => i.name)).toEqual(['monitor-0', 'monitor-1', 'monitor-2']);
    expect(statusMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('completed');
  });

  it('skips the monitor poll entirely when start already returns terminal', async () => {
    startMock.mockResolvedValueOnce(startedJob('completed')); // already done at start
    resultsMock.mockResolvedValueOnce({ pages: [], links: [], cursor: undefined });

    const { invocations } = await runWorkflow({});
    expect(invocations.some((i) => i.name.startsWith('monitor-'))).toBe(false);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('collect exhausts the provider cursor across windows', async () => {
    startMock.mockResolvedValueOnce(startedJob('completed'));
    resultsMock
      .mockResolvedValueOnce({ pages: [page(`${SEED}/a`)], links: [], cursor: 'n1' })
      .mockResolvedValueOnce({ pages: [page(`${SEED}/b`)], links: [], cursor: undefined });

    const { result } = await runWorkflow({});
    expect(resultsMock).toHaveBeenCalledTimes(2); // followed the cursor
    expect(result.pagesCompleted).toBe(2);
  });

  it('persist calls persistCrawl with the collected pages/links + ownership + request', async () => {
    const request = { url: SEED, mode: 'auto' as const };
    startMock.mockResolvedValueOnce(startedJob('completed'));
    resultsMock.mockResolvedValueOnce({
      pages: [page(`${SEED}/a`)],
      links: [{ from: `${SEED}/`, to: `${SEED}/a`, kind: 'internal' as const }],
      cursor: undefined,
    });

    await runWorkflow({ orgId: 'org9', request });

    expect(persistMock).toHaveBeenCalledTimes(1);
    const arg = persistMock.mock.calls[0][1] as {
      job: CrawlJob;
      pages: CrawlPage[];
      links: unknown[];
      orgId: string | null;
      request: unknown;
    };
    expect(arg.job.id).toBe(JOB_ID);
    expect(arg.job.status).toBe('completed');
    expect(arg.pages).toHaveLength(1);
    expect(arg.links).toHaveLength(1);
    expect(arg.orgId).toBe('org9');
    expect(arg.request).toEqual(request);
  });

  it('surfaces persisted:false when persistCrawl reports a partial write (fail-soft)', async () => {
    startMock.mockResolvedValueOnce(startedJob('completed'));
    resultsMock.mockResolvedValueOnce({ pages: [], links: [], cursor: undefined });
    persistMock.mockResolvedValueOnce({ ok: false, crawlId: JOB_ID, r2Prefix: '', r2Keys: [], manifest: {}, errors: ['r2:boom'] });

    const { result } = await runWorkflow({});
    expect(result.ok).toBe(true); // the crawl still completes
    expect(result.persisted).toBe(false); // but persistence is honestly reported partial
  });

  it('rejects malformed params fail-fast (Zod) — a missing url throws before any step', async () => {
    const wf = new SiteCrawlWorkflow({} as unknown as DurableObjectState, env);
    const { step } = makeStep();
    await expect(
      wf.run(
        { payload: { crawlId: JOB_ID, mode: 'auto', orgId: 'o1' }, timestamp: new Date(), instanceId: 'i1' } as never,
        step as never,
      ),
    ).rejects.toThrow();
    expect(startMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRAWL-3b — dedupe + cache-skip + quality-score (pure helpers + workflow wiring)
// ─────────────────────────────────────────────────────────────────────────────

/** A page builder that lets each case control url / finalUrl / contentHash / content signals. */
function mkPage(opts: {
  url?: string;
  finalUrl?: string;
  contentHash?: string;
  title?: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
}): CrawlPage {
  const url = opts.url ?? `${SEED}/p`;
  return {
    id: PAGE_ID,
    discoveredUrl: url,
    requestedUrl: url,
    finalUrl: opts.finalUrl ?? url,
    title: opts.title,
    markdown: opts.markdown ?? '# Title\n\nbody',
    metadata: opts.metadata ?? {},
    contentHash: opts.contentHash ?? 'hash',
  };
}

describe('normalizeCrawlUrl', () => {
  it('lowercases the host but preserves path case', () => {
    expect(normalizeCrawlUrl('https://Example.COM/A/B')).toBe('https://example.com/A/B');
  });
  it('drops the fragment', () => {
    expect(normalizeCrawlUrl('https://example.com/a#section-2')).toBe('https://example.com/a');
  });
  it('strips a trailing slash on a non-root path but keeps the root slash', () => {
    expect(normalizeCrawlUrl('https://example.com/a/')).toBe('https://example.com/a');
    expect(normalizeCrawlUrl('https://example.com/')).toBe('https://example.com/');
  });
  it('strips utm_* / fbclid / gclid tracking params, keeps real params sorted', () => {
    expect(
      normalizeCrawlUrl('https://example.com/a?utm_source=nl&b=2&fbclid=xyz&a=1&gclid=q'),
    ).toBe('https://example.com/a?a=1&b=2');
  });
  it('collapses two URLs differing only by tracking params + fragment + trailing slash to one', () => {
    const a = normalizeCrawlUrl('https://Example.com/Pricing/?utm_campaign=x#top');
    const b = normalizeCrawlUrl('https://example.com/Pricing?fbclid=y');
    expect(a).toBe(b);
  });
  it('fails soft on an unparseable URL (returns trimmed lowercase, never throws)', () => {
    expect(() => normalizeCrawlUrl('not a url')).not.toThrow();
    expect(normalizeCrawlUrl('  NOT A URL  ')).toBe('not a url');
  });
});

describe('scorePageQuality', () => {
  it('scores a rich page (title + h1 + long body + 200 + text) at 100', () => {
    const body = `# Heading\n\n${'word '.repeat(60)}`;
    const score = scorePageQuality(
      mkPage({ title: 'A Title', markdown: body, metadata: { status: 200 } }),
    );
    expect(score).toBe(100);
  });
  it('stays within 0-100 for a bare page', () => {
    const score = scorePageQuality(mkPage({ title: undefined, markdown: '', metadata: {} }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
  it('an empty page (no text, no title, no h1, with a 404 status) scores 0', () => {
    const score = scorePageQuality(mkPage({ title: '', markdown: '', metadata: { status: 404 } }));
    expect(score).toBe(0);
  });
  it('ranks a richer page strictly above a thinner one', () => {
    const rich = scorePageQuality(
      mkPage({ title: 'T', markdown: `# H\n\n${'w '.repeat(60)}`, metadata: { status: 200 } }),
    );
    const thin = scorePageQuality(mkPage({ title: undefined, markdown: 'hi', metadata: {} }));
    expect(rich).toBeGreaterThan(thin);
  });
  it('treats an absent status as reachable (absence is not a failure)', () => {
    const withStatus = scorePageQuality(mkPage({ markdown: 'x', metadata: { status: 200 } }));
    const noStatus = scorePageQuality(mkPage({ markdown: 'x', metadata: {} }));
    expect(noStatus).toBe(withStatus);
  });
});

describe('dedupeAndScorePages', () => {
  it('drops a duplicate normalized-URL page, keeping the first occurrence + counting the drop', () => {
    const first = mkPage({ url: `${SEED}/a`, finalUrl: `${SEED}/a`, title: 'first' });
    const dupe = mkPage({ url: `${SEED}/a?utm_source=x`, finalUrl: `${SEED}/a/#frag`, title: 'dupe' });
    const { pages, duplicatesDropped } = dedupeAndScorePages([first, dupe]);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe('first'); // first occurrence kept
    expect(duplicatesDropped).toBe(1);
  });
  it('cache-skips a later page with an identical content hash for the same normalized URL', () => {
    const p1 = mkPage({ url: `${SEED}/x`, finalUrl: `${SEED}/x`, contentHash: 'same' });
    const p2 = mkPage({ url: `${SEED}/x`, finalUrl: `${SEED}/x`, contentHash: 'same' });
    const { pages, duplicatesDropped } = dedupeAndScorePages([p1, p2]);
    expect(pages).toHaveLength(1);
    expect(duplicatesDropped).toBe(1);
  });
  it('keeps genuinely distinct URLs and stamps a qualityScore on every kept page', () => {
    const a = mkPage({ url: `${SEED}/a`, finalUrl: `${SEED}/a` });
    const b = mkPage({ url: `${SEED}/b`, finalUrl: `${SEED}/b` });
    const { pages, duplicatesDropped } = dedupeAndScorePages([a, b]);
    expect(pages).toHaveLength(2);
    expect(duplicatesDropped).toBe(0);
    for (const p of pages) {
      expect(typeof p.qualityScore).toBe('number');
      expect(p.qualityScore).toBeGreaterThanOrEqual(0);
      expect(p.qualityScore).toBeLessThanOrEqual(100);
    }
  });
  it('returns an empty result (0 dropped) for no pages', () => {
    expect(dedupeAndScorePages([])).toEqual({ pages: [], duplicatesDropped: 0 });
  });
});

describe('SiteCrawlWorkflow — CRAWL-3b collect dedupe + scoring', () => {
  it('dedupes duplicate pages across cursor windows and surfaces duplicatesDropped', async () => {
    startMock.mockResolvedValueOnce(startedJob('completed'));
    resultsMock
      .mockResolvedValueOnce({ pages: [mkPage({ url: `${SEED}/a`, finalUrl: `${SEED}/a` })], links: [], cursor: 'n1' })
      .mockResolvedValueOnce({
        // same normalized URL as /a (trailing slash + utm) → dropped as a duplicate
        pages: [mkPage({ url: `${SEED}/a/?utm_source=x`, finalUrl: `${SEED}/a/?utm_source=x` })],
        links: [],
        cursor: undefined,
      });

    const { result } = await runWorkflow({});
    expect(result.pagesCompleted).toBe(1); // deduped
    expect(result.duplicatesDropped).toBe(1);
  });

  it('persists the deduped+scored pages (each kept page carries a qualityScore)', async () => {
    startMock.mockResolvedValueOnce(startedJob('completed'));
    resultsMock.mockResolvedValueOnce({
      pages: [
        mkPage({ url: `${SEED}/a`, finalUrl: `${SEED}/a`, title: 'A', markdown: `# A\n\n${'w '.repeat(60)}`, metadata: { status: 200 } }),
      ],
      links: [],
      cursor: undefined,
    });

    await runWorkflow({});
    const arg = persistMock.mock.calls[0][1] as { pages: CrawlPage[] };
    expect(arg.pages).toHaveLength(1);
    expect(typeof arg.pages[0].qualityScore).toBe('number');
    expect(arg.pages[0].qualityScore).toBe(100);
  });
});

// NOTE: the handler-side CRAWL-3 trigger contract (POST /api/crawl fires SITE_CRAWL_WORKFLOW.create
// when bound, falls back to the inline path when absent / on create-failure) lives in
// `handlers.test.ts`, where the `isFlagOn` + provider mocks are hoisted correctly at file top per the
// @swc/jest mock-hoisting rule (project CLAUDE.md gotcha #12). Keeping it there avoids a second,
// in-describe `jest.mock` that @swc/jest would not reliably hoist above the handler's transitive imports.
