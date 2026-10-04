/**
 * @module libs/features/site_crawl/handlers
 * @description Hono routes for the whole-site-crawl feature (flag: `site_crawl`) — CRAWL-2.
 *
 * | Method | Path                          | Auth     | Purpose                                     |
 * | ------ | ----------------------------- | -------- | ------------------------------------------- |
 * | POST   | /api/crawl                    | required | SSRF-guard + start a crawl → CrawlJob (202) |
 * | GET    | /api/crawl/:id                | required | Job status                                  |
 * | GET    | /api/crawl/:id/pages          | required | Normalized pages (cursor-exhausted)         |
 * | GET    | /api/crawl/:id/pages/:pageId  | required | One page by id                              |
 * | GET    | /api/crawl/:id/links          | required | Link-graph edges                            |
 * | GET    | /api/crawl/:id/export.md      | required | Combined full-site markdown (URL-delimited) |
 * | DELETE | /api/crawl/:id                | required | Cancel an in-flight crawl (idempotent)      |
 *
 * EVERY route 404s when the `site_crawl` flag is off (never 403 — do not leak feature
 * existence) per [[feature-flags]]. Uniform RFC7807-ish envelope via `lib/feature_guard`.
 *
 * SECURITY — the SSRF guard on `POST /api/crawl` is mandatory and THROWS (never degrades): it
 * rejects non-http(s) schemes, credentials-in-URL, localhost/loopback, RFC1918, link-local,
 * and the cloud-metadata endpoint via the shared `isSafeCrawlUrl` blocklist. Per
 * [[ssrf-redirect-follow-bypasses-host-allowlist-revalidate-every-hop]] a host-allowlist is a
 * TIME-OF-CHECK that a redirect-follow can hop past — the SERVER-SIDE fetch that actually pulls
 * each page (the provider / build crawler) MUST additionally re-validate every redirect hop with
 * `redirect:'manual'`. This route guards the SEED (fail-fast at the boundary); the per-hop
 * re-validation is owned by the fetch layer and lands with persistence (CRAWL-3/4 — see TODO).
 *
 * Tenant authz — crawls are scoped to the caller's org. CRAWL-2 has no persistence yet
 * (CRAWL-3/4), so the jobId→orgId binding lives in an in-process map; every `:id` handler
 * asserts the job belongs to the caller's org and 404s otherwise (never leaks another org's
 * job). TODO(CRAWL-3): persist the binding (+ job/pages/links) to D1/R2 so ownership survives
 * an isolate recycle and the in-memory map can be dropped.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound, badRequest } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSafeCrawlUrl } from '../../../src/services/outbound_webhooks.js';

import { CrawlRequestSchema, type CrawlJob, type CrawlPage, type CrawlLink } from './schemas.js';
import { type CrawlProvider, CloudflareCrawlProvider } from './provider.js';
import { persistCrawl, buildFullSiteMarkdown, type CrawlPersistenceEnv } from './persistence.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** The D1 feature-flag key gating every route (DARK → 404 until promoted). */
export const FLAG_KEY = 'site_crawl';

export const siteCrawl = new Hono<AppContext>();

/** Structured, `feature_slug`-tagged JSON log (observability convergence). */
function log(c: Context<AppContext>, event: string, extra: Record<string, unknown> = {}): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'site_crawl',
      feature_slug: FLAG_KEY,
      event,
      request_id: c.get('requestId') ?? null,
      org_id: c.get('orgId') ?? null,
      ...extra,
    }),
  );
}

/** Typed SSRF rejection — the guard THROWS this; it never degrades to a soft-pass. */
export class CrawlSsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlSsrfError';
  }
}

/**
 * Mandatory SSRF guard for the crawl SEED url. THROWS {@link CrawlSsrfError} on any unsafe
 * target — it does NOT return a boolean a caller could ignore, and it NEVER degrades.
 *
 * Rejects, in order: non-http(s) schemes (`javascript:`/`file:`/`ftp:`/`data:`), credentials
 * embedded in the URL (`user:pass@host` — SSRF + credential-leak vector; `new URL` strips them
 * from `hostname` so the host blocklist alone would miss it), and any internal/private host —
 * localhost/loopback, `127.0.0.0/8`, RFC1918 (`10/8`,`172.16/12`,`192.168/16`), CGNAT, IPv6
 * loopback/link-local/ULA, IPv4-mapped IPv6, and the cloud-metadata endpoint `169.254.169.254`
 * — via the shared `isSafeCrawlUrl` blocklist (`services/outbound_webhooks.ts`).
 *
 * @param rawUrl - the seed URL from the (Zod-validated) request body
 * @throws {CrawlSsrfError} when the URL is not a safe public http(s) target
 */
export function assertCrawlUrlSafe(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new CrawlSsrfError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CrawlSsrfError('Only http(s) URLs may be crawled');
  }
  // Credentials in the URL are both an SSRF smuggling vector and a leak — `isSafeCrawlUrl`
  // checks only `hostname`, which `new URL` has already stripped creds from, so guard here.
  if (u.username || u.password) {
    throw new CrawlSsrfError('Credentials in the URL are not allowed');
  }
  if (!isSafeCrawlUrl(rawUrl)) {
    throw new CrawlSsrfError('Refusing to crawl a private, loopback, or internal address');
  }
}

/**
 * In-process jobId → orgId ownership binding.
 *
 * TODO(CRAWL-3): replace with durable D1/R2 persistence — this map does not survive an isolate
 * recycle, so a status/results poll after a cold start currently 404s. For CRAWL-2 (flag-dark,
 * no reachable surface) an in-memory binding is sufficient to prove the authz contract + tests.
 */
const jobOrg = new Map<string, string>();

/**
 * In-process jobId → originating {@link CrawlRequest}, so persistence can snapshot the crawl's
 * mode/config + compute a stable fingerprint. Same TODO(CRAWL-3) lifetime as {@link jobOrg} — once
 * the `site_crawls` row is the source of truth, the request is read back from D1 instead.
 */
const jobRequest = new Map<string, import('./schemas.js').CrawlRequest>();

/** Lazily build the crawl provider (CF Browser-Run). Swap here when another engine is added. */
function getProvider(c: Context<AppContext>): CrawlProvider {
  return new CloudflareCrawlProvider(c.env, c.get('orgId') ?? null);
}

/** Auth + flag gate. Returns the authed orgId to proceed, or a short-circuit Response. */
async function gate(c: Context<AppContext>): Promise<string | Response> {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!userId || !orgId) return unauthorized(c);
  const on = await isFlagOn(c.env, FLAG_KEY, { orgId, userId }).catch(() => false);
  if (!on) {
    log(c, 'flag_off');
    return notFound(c);
  }
  return orgId;
}

/**
 * Resolve an owned crawl job id from the path, or a short-circuit Response.
 *
 * Runs the auth+flag gate, then asserts the job is bound to the caller's org — a foreign or
 * unknown id 404s (never 403; never leaks another tenant's job). Returns `{ id, orgId }`.
 */
async function ownedJob(c: Context<AppContext>): Promise<{ id: string; orgId: string } | Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!id || jobOrg.get(id) !== g) return notFound(c);
  return { id, orgId: g };
}

/** Map a typed provider error → HTTP; an SSRF rejection is a 400 CLIENT error, not a 500. */
function providerError(c: Context<AppContext>, err: unknown): Response {
  if (err instanceof CrawlSsrfError) {
    log(c, 'ssrf_rejected', { reason: err.message });
    return badRequest(c, { code: 'CRAWL_UNSAFE_URL', reason: err.message });
  }
  log(c, 'provider_error', { error: err instanceof Error ? err.message : String(err) });
  return c.json(
    {
      error: {
        code: 'CRAWL_PROVIDER_ERROR',
        message: 'The crawl engine could not complete the request',
        request_id: c.get('requestId') ?? null,
      },
    },
    502,
  );
}

/**
 * Exhaust the provider's cursor-paginated results server-side into one flat list.
 *
 * The CF `/crawl` result set is windowed (10 MB / page) behind an opaque forward cursor — a
 * single page is NOT the whole crawl, so we loop until the cursor is absent (bounded by
 * `maxPages` so a runaway crawl can't spin forever). Per the provider contract the caller MUST
 * exhaust the cursor; doing it here keeps the HTTP surface simple (callers never pass a cursor).
 */
async function collectResults(
  provider: CrawlProvider,
  id: string,
  maxPages = 200,
): Promise<{ pages: CrawlPage[]; links: CrawlLink[] }> {
  const pages: CrawlPage[] = [];
  const links: CrawlLink[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await provider.results(id, cursor);
    pages.push(...res.pages);
    links.push(...res.links);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return { pages, links };
}

/**
 * Collect the full results AND persist the crawl corpus/metadata (CRAWL-3) — the single chokepoint
 * the pages/links/export routes call so the normalized corpus is captured exactly once per request.
 *
 * Fetches the job state once (for the manifest + D1 row) then fires {@link persistCrawl} on
 * `executionCtx.waitUntil` so persistence never blocks the HTTP response (sync UI, async backing).
 * Persistence is fully fail-soft — any R2/D1 error is swallowed inside `persistCrawl`, so a persist
 * problem can never turn a successful results read into an error. The route still returns the live
 * `{ pages, links }` even if persistence is skipped.
 */
async function collectAndPersist(
  c: Context<AppContext>,
  provider: CrawlProvider,
  owned: { id: string; orgId: string },
): Promise<{ pages: CrawlPage[]; links: CrawlLink[] }> {
  const { pages, links } = await collectResults(provider, owned.id);
  // Best-effort: derive the job (for status/url/createdAt) without failing the read if status errors.
  let job: CrawlJob | undefined;
  try {
    job = await provider.status(owned.id);
  } catch {
    job = undefined;
  }
  if (job) {
    const run = () =>
      persistCrawl(c.env as unknown as CrawlPersistenceEnv, {
        job: job as CrawlJob,
        pages,
        links,
        orgId: owned.orgId,
        request: jobRequest.get(owned.id),
      }).catch(() => undefined); // double-guard: persistCrawl is already fail-soft
    // Prefer waitUntil so persistence runs after the response flushes; fall back to inline
    // fire-and-forget. `c.executionCtx` is a getter that THROWS when no execution context is bound
    // (e.g. a unit test's `app.request()` with no ctx) — guard the access so it degrades to inline.
    let waited = false;
    try {
      const ctx = c.executionCtx;
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(run());
        waited = true;
      }
    } catch {
      waited = false;
    }
    if (!waited) void run();
  }
  return { pages, links };
}

/**
 * POST /api/crawl — SSRF-guard the seed, start the crawl, return the CrawlJob immediately.
 *
 * Does NOT block on completion (202). Zod-validates the body; the SSRF guard THROWS before any
 * provider call. Flag off → 404; unauth → 401; unsafe URL → 400.
 */
siteCrawl.post('/api/crawl', async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;

  const body = await c.req.json().catch(() => null);
  const parsed = CrawlRequestSchema.safeParse(body);
  if (!parsed.success) return badRequest(c, parsed.error.flatten());

  try {
    assertCrawlUrlSafe(parsed.data.url); // THROWS on any unsafe target — never degrades.
  } catch (err) {
    return providerError(c, err);
  }

  try {
    const job = await getProvider(c).start(parsed.data);
    jobOrg.set(job.id, g); // bind ownership (TODO(CRAWL-3): persist to D1)
    jobRequest.set(job.id, parsed.data); // remember config for the manifest/fingerprint on persist
    log(c, 'started', { crawl_id: job.id });
    // 202 Accepted — the crawl runs async; poll GET /api/crawl/:id for progress.
    return c.json({ ok: true, job }, 202);
  } catch (err) {
    return providerError(c, err);
  }
});

/** GET /api/crawl/:id — current job state. */
siteCrawl.get('/api/crawl/:id', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  try {
    const job = await getProvider(c).status(owned.id);
    return c.json({ ok: true, job });
  } catch (err) {
    return providerError(c, err);
  }
});

/** GET /api/crawl/:id/pages — all normalized pages (cursor exhausted server-side). */
siteCrawl.get('/api/crawl/:id/pages', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  try {
    const { pages } = await collectAndPersist(c, getProvider(c), owned);
    return c.json({ ok: true, count: pages.length, pages });
  } catch (err) {
    return providerError(c, err);
  }
});

/** GET /api/crawl/:id/pages/:pageId — a single normalized page by its domain id. */
siteCrawl.get('/api/crawl/:id/pages/:pageId', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  const pageId = c.req.param('pageId');
  try {
    const { pages } = await collectResults(getProvider(c), owned.id);
    const page = pages.find((p) => p.id === pageId);
    if (!page) return notFound(c);
    return c.json({ ok: true, page });
  } catch (err) {
    return providerError(c, err);
  }
});

/** GET /api/crawl/:id/links — the discovered link-graph edges. */
siteCrawl.get('/api/crawl/:id/links', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  try {
    const { links } = await collectAndPersist(c, getProvider(c), owned);
    return c.json({ ok: true, count: links.length, links });
  } catch (err) {
    return providerError(c, err);
  }
});

/**
 * GET /api/crawl/:id/export.md — the whole crawl as one source-URL-delimited markdown doc.
 *
 * Each page is emitted as a `## <finalUrl>` section followed by its markdown, separated by a
 * horizontal rule — a single pasteable artifact (seed-into-build / audit / LLM context).
 */
siteCrawl.get('/api/crawl/:id/export.md', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  try {
    const { pages } = await collectAndPersist(c, getProvider(c), owned);
    // Shared builder (persistence.ts) — the SAME doc shape written to the R2 corpus `full-site.md`.
    const doc = buildFullSiteMarkdown(pages);
    return c.body(doc, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `inline; filename="crawl-${owned.id}.md"`,
    });
  } catch (err) {
    return providerError(c, err);
  }
});

/** DELETE /api/crawl/:id — cancel an in-flight crawl (idempotent at the provider). */
siteCrawl.delete('/api/crawl/:id', async (c) => {
  const owned = await ownedJob(c);
  if (owned instanceof Response) return owned;
  try {
    await getProvider(c).cancel(owned.id);
    log(c, 'cancelled', { crawl_id: owned.id });
    return c.json({ ok: true });
  } catch (err) {
    return providerError(c, err);
  }
});
