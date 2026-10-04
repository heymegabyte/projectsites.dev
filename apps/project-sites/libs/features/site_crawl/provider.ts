import { z } from 'zod';
import type { Env } from '../../../src/types/env.js';
import { type CfAuth, cfAuthHeaders, resolveCfCredentials } from '../../../src/services/cf_credentials.js';
import {
  CrawlJobSchema,
  type CrawlJob,
  type CrawlRequest,
  type CrawlLink,
  type CrawlPage,
  type CrawlStatus,
} from './schemas';

/**
 * Provider-independent crawl port + the Cloudflare Browser-Run adapter (CRAWL-1).
 *
 * The `CrawlProvider` interface is the seam between the crawl DOMAIN (schemas.ts — vendor-free)
 * and whatever engine actually fetches pages. NO Cloudflare response shape leaks through it:
 * every method speaks only the domain types from `schemas.ts`. Swapping engines (CF Browser
 * Run → Firecrawl → a self-hosted crawler) is a new `implements CrawlProvider`, nothing more.
 *
 * `CloudflareCrawlProvider` drives CF Browser Rendering's async, cursor-paginated `/crawl` REST
 * API. SSRF/scope/persistence are CRAWL-2+ — not here; this slice only wires the engine behind
 * the port, flag-dark (no route mounts `CloudflareCrawlProvider` yet).
 *
 * @see https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/
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

/** Typed failure for every {@link CloudflareCrawlProvider} call (missing creds, CF 5xx, bad shape). */
export class CloudflareCrawlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudflareCrawlError';
  }
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ─────────────────────────────────────────────────────────────────────────────
// CF wire schemas — these NEVER escape this file (adapted to domain types below).
// Verified against developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint (2026-10).
// ─────────────────────────────────────────────────────────────────────────────

/** `POST /crawl` → `{ success, result: "<jobId>" }` — the job id is a bare string in `result`. */
const CfStartResponseSchema = z.object({
  success: z.boolean(),
  result: z.string().min(1),
});

/** One crawled page as CF returns it in `result.records[]`. Only the fields we map. */
const CfRecordSchema = z.object({
  url: z.string(),
  status: z.string().optional(),
  markdown: z.string().optional(),
  html: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** `GET /crawl/{id}` → `{ success, result: { id, status, total, finished, records[], cursor? } }`. */
const CfJobResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    id: z.string(),
    status: z.string(),
    total: z.number().optional(),
    finished: z.number().optional(),
    records: z.array(CfRecordSchema).optional(),
    /** CF returns a numeric cursor when the result set exceeds its 10 MB page window. */
    cursor: z.union([z.number(), z.string()]).optional(),
  }),
});

/**
 * Map a CF job-level status string → our provider-independent {@link CrawlStatus}.
 *
 * CF: `running | completed | cancelled_due_to_timeout | cancelled_due_to_limits |
 * cancelled_by_user | errored`. We fold the three `cancelled_*` into `cancelled`/`budget_exhausted`
 * so the domain enum stays small and honest.
 */
export function mapCfJobStatus(cf: string): CrawlStatus {
  switch (cf) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled_due_to_limits':
      return 'budget_exhausted';
    case 'cancelled_due_to_timeout':
    case 'cancelled_by_user':
      return 'cancelled';
    case 'errored':
      return 'failed';
    default:
      // An unknown CF status is surfaced as running (still in-flight) rather than guessed terminal.
      return 'running';
  }
}

/** FNV-1a 32-bit hash → hex. Cheap, dependency-free content hash for dedupe/freshness. */
function contentHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Best-effort absolute-URL guard — CF records occasionally carry a relative/blank url. */
function safeUrl(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback;
  try {
    return new URL(candidate).toString();
  } catch {
    return fallback;
  }
}

/**
 * Cloudflare Browser Rendering crawl adapter (CRAWL-1).
 *
 * @remarks
 * - **ASYNC JOB** — `start()` POSTs the seed + returns the CF job id (a UUID); `status()` polls it.
 * - **Cursor pagination MUST be fully exhausted** — `results()` returns `{pages, links, cursor}`;
 *   the caller loops on `cursor` until it is `undefined`. A single window is not the whole crawl.
 * - `source: "all"` (sitemap + links + discovery), `crawlPurposes: ["search"]`,
 *   `contentUse: "reference"`, `formats: ["markdown"]`. `fast`/`auto` → `render: false` (cheap,
 *   static HTML); only `rendered` escalates to a headless pass.
 *
 * None of those CF specifics appear in the port SIGNATURES — they are adaptation detail owned here.
 */
export class CloudflareCrawlProvider implements CrawlProvider {
  /**
   * @param env - worker env (CF account id + credentials source)
   * @param orgId - org for stored CF creds (falls back to the worker-bundled key); server-resolved
   */
  constructor(
    private readonly env: Env,
    private readonly orgId: string | null = null,
  ) {}

  /** Resolve CF auth + account id once per call; fail typed when either is missing. */
  private async ctx(): Promise<{ auth: CfAuth; account: string }> {
    const auth = await resolveCfCredentials(this.env, this.orgId);
    if (!auth) throw new CloudflareCrawlError('No Cloudflare credentials available for crawl.');
    const account = this.env.CF_ACCOUNT_ID;
    if (!account) throw new CloudflareCrawlError('CF_ACCOUNT_ID is not configured for crawl.');
    return { auth, account };
  }

  /** `fetch` with one 5xx retry (the CF REST plane intermittently 500s). Never logs creds. */
  private async cfFetch(
    path: string,
    init: { method: string; body?: string; auth: CfAuth },
  ): Promise<Response> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${CF_API_BASE}${path}`, {
        method: init.method,
        headers: {
          ...cfAuthHeaders(init.auth),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
      if (res.status < 500 || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return res as Response;
  }

  async start(req: CrawlRequest): Promise<CrawlJob> {
    const { auth, account } = await this.ctx();

    // Research defaults — declare the crawl's intent to the engine + keep the FAST path cheap.
    const render = req.mode === 'rendered';
    const options: Record<string, unknown> = {
      includeSubdomains: req.includeSubdomains ?? false,
      includeExternalLinks: req.includeExternalLinks ?? false,
    };
    if (req.includePatterns?.length) options.includePatterns = req.includePatterns;
    if (req.excludePatterns?.length) options.excludePatterns = req.excludePatterns;

    const body: Record<string, unknown> = {
      url: req.url,
      source: 'all',
      crawlPurposes: ['search'],
      contentUse: 'reference',
      formats: ['markdown'],
      render,
      options,
    };
    if (req.limit !== undefined) body.limit = req.limit;
    if (req.depth !== undefined) body.depth = req.depth;
    if (req.freshness !== undefined) body.maxAge = req.freshness;

    const res = await this.cfFetch(`/accounts/${account}/browser-rendering/crawl`, {
      method: 'POST',
      body: JSON.stringify(body),
      auth,
    });
    const json = await res.json().catch(() => null);
    const parsed = CfStartResponseSchema.safeParse(json);
    if (!res.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareCrawlError(
        `CF crawl start failed: ${res.ok ? 'bad response shape' : `HTTP ${res.status}`}`,
        res.status,
      );
    }

    // CF's job id IS a UUID — it is the domain job id directly (no synthetic mapping needed).
    return CrawlJobSchema.parse({
      id: parsed.data.result,
      status: 'running' satisfies CrawlStatus,
      url: req.url,
      createdAt: new Date().toISOString(),
    });
  }

  async status(id: string): Promise<CrawlJob> {
    const { auth, account } = await this.ctx();
    // `?limit=1` keeps the status poll lightweight — we only need the job state, not the records.
    const res = await this.cfFetch(`/accounts/${account}/browser-rendering/crawl/${id}?limit=1`, {
      method: 'GET',
      auth,
    });
    const json = await res.json().catch(() => null);
    const parsed = CfJobResponseSchema.safeParse(json);
    if (!res.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareCrawlError(
        `CF crawl status failed: ${res.ok ? 'bad response shape' : `HTTP ${res.status}`}`,
        res.status,
      );
    }
    const r = parsed.data.result;
    const status = mapCfJobStatus(r.status);
    // CF does not echo the seed URL; derive a valid absolute url from the first record (best-effort)
    // so the schema's `url` invariant holds. Durable job→seed mapping is CRAWL-2+ (persistence).
    const seed = safeUrl(r.records?.[0]?.url, 'https://unknown.invalid/');
    return CrawlJobSchema.parse({
      id: r.id,
      status,
      url: seed,
      createdAt: new Date().toISOString(),
      pagesDiscovered: r.total ?? 0,
      pagesCompleted: r.finished ?? 0,
      ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
    });
  }

  async results(id: string, cursor?: string): Promise<CrawlProviderResult> {
    const { auth, account } = await this.ctx();
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await this.cfFetch(`/accounts/${account}/browser-rendering/crawl/${id}${qs}`, {
      method: 'GET',
      auth,
    });
    const json = await res.json().catch(() => null);
    const parsed = CfJobResponseSchema.safeParse(json);
    if (!res.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareCrawlError(
        `CF crawl results failed: ${res.ok ? 'bad response shape' : `HTTP ${res.status}`}`,
        res.status,
      );
    }
    const r = parsed.data.result;
    const pages: CrawlPage[] = (r.records ?? [])
      // Only successfully-crawled records carry content worth normalizing.
      .filter((rec) => rec.status === undefined || rec.status === 'completed')
      .map((rec) => {
        const url = safeUrl(rec.url, 'https://unknown.invalid/');
        const markdown = rec.markdown ?? '';
        return {
          id: crypto.randomUUID(),
          discoveredUrl: url,
          requestedUrl: url,
          finalUrl: safeUrl((rec.metadata as { url?: unknown } | undefined)?.url, url),
          title: typeof (rec.metadata as { title?: unknown })?.title === 'string'
            ? ((rec.metadata as { title?: string }).title as string)
            : undefined,
          markdown,
          metadata: rec.metadata ?? {},
          contentHash: contentHash(markdown || url),
        };
      });

    // CF `/crawl` records carry no per-page link graph — link edges are CRAWL-2+ (link extraction).
    // The RESULT TYPE still carries `links` so the port is stable when that lands.
    const links: CrawlLink[] = [];

    // Cursor present → more results remain; the caller MUST re-call until it is absent.
    const nextCursor =
      r.cursor === undefined || r.cursor === null ? undefined : String(r.cursor);

    return { pages, links, cursor: nextCursor };
  }

  async cancel(id: string): Promise<void> {
    const { auth, account } = await this.ctx();
    const res = await this.cfFetch(`/accounts/${account}/browser-rendering/crawl/${id}`, {
      method: 'DELETE',
      auth,
    });
    // Idempotent: a 404 (already gone / unknown) is a no-op, not a failure. Only a 5xx is an error.
    if (!res.ok && res.status >= 500) {
      throw new CloudflareCrawlError(`CF crawl cancel failed: HTTP ${res.status}`, res.status);
    }
  }
}
