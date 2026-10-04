import type { CrawlJob, CrawlRequest, CrawlLink, CrawlPage } from './schemas';

/**
 * Provider-independent crawl port + the Cloudflare adapter STUB (CRAWL-0 foundation).
 *
 * The `CrawlProvider` interface is the seam between the crawl DOMAIN (schemas.ts — vendor-free)
 * and whatever engine actually fetches pages. NO Cloudflare response shape leaks through it:
 * every method speaks only the domain types from `schemas.ts`. Swapping engines (CF Browser
 * Run → Firecrawl → a self-hosted crawler) is a new `implements CrawlProvider`, nothing more.
 *
 * `CloudflareCrawlProvider` is a STUB — every method throws `CRAWL-1: not yet implemented`.
 * The real Browser-Run `/crawl` wiring is CRAWL-1; routes/workflow/persistence are CRAWL-1..4.
 */

/** A page of provider results plus an opaque cursor to fetch the next page (undefined = done). */
export interface CrawlProviderResult {
  /** Normalized pages produced so far in this result window. */
  pages: CrawlPage[];
  /** Link-graph edges discovered in this result window. */
  links: CrawlLink[];
  /**
   * Opaque forward cursor. `undefined`/absent = no more results. The caller MUST keep calling
   * `results(id, cursor)` until the cursor is exhausted — a single page of results is NOT the
   * whole crawl (see the CF semantics below).
   */
  cursor?: string;
}

/**
 * The crawl engine port. All four methods are async and speak ONLY domain types.
 *
 * @remarks
 * Implementations MUST NOT surface vendor-native shapes (CF job objects, HTTP envelopes) to
 * callers — adapt them to {@link CrawlJob} / {@link CrawlProviderResult} at the boundary.
 */
export interface CrawlProvider {
  /** Kick off a crawl. Returns the initial job (typically `queued`/`running`). */
  start(req: CrawlRequest): Promise<CrawlJob>;
  /** Refresh and return the current job state by domain job id. */
  status(id: string): Promise<CrawlJob>;
  /**
   * Page through the crawl's normalized results. Pass the previous result's `cursor` to get the
   * next window; `undefined` cursor starts from the beginning. Exhaust the cursor fully.
   */
  results(id: string, cursor?: string): Promise<CrawlProviderResult>;
  /** Request cancellation of an in-flight crawl. Idempotent. */
  cancel(id: string): Promise<void>;
}

/** Thrown by every {@link CloudflareCrawlProvider} method until CRAWL-1 wires the real engine. */
const NOT_IMPLEMENTED = 'CRAWL-1: not yet implemented';

/**
 * Cloudflare Browser Rendering crawl adapter — STUB (CRAWL-0).
 *
 * @remarks
 * The real CRAWL-1 implementation will drive CF Browser Rendering's async crawl (`/crawl`):
 * - It is an **ASYNC JOB** — `start()` returns a job id, you poll `status()` for completion.
 * - **Cursor pagination MUST be fully exhausted** — results come back in windows; a single
 *   `results()` call is not the whole crawl. Loop on the cursor until it is absent.
 * - Start options carry `source: all` (sitemap + links + discovery), `crawlPurposes: ["search"]`,
 *   and `contentUse: "reference"` so the crawl declares its intent to the engine.
 * - The FAST path sets `render: false` (static HTML only, no headless Chromium) — the cheap
 *   default; `auto`/`rendered` modes escalate to a rendered pass per `schemas.ts` `CrawlMode`.
 *
 * None of those CF specifics appear in this file's SIGNATURES — they are adaptation detail the
 * CRAWL-1 body will own. The methods below only exist so the port has a concrete, type-checked
 * implementation to register against; each throws until CRAWL-1.
 */
export class CloudflareCrawlProvider implements CrawlProvider {
  start(_req: CrawlRequest): Promise<CrawlJob> {
    throw new Error(NOT_IMPLEMENTED);
  }

  status(_id: string): Promise<CrawlJob> {
    throw new Error(NOT_IMPLEMENTED);
  }

  results(_id: string, _cursor?: string): Promise<CrawlProviderResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  cancel(_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
