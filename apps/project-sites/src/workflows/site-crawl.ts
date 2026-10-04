/**
 * @module workflows/site-crawl
 * @description Cloudflare Workflows v2 — durable, resumable whole-site-crawl lifecycle (CRAWL-3).
 *
 * Wraps the previously-inline crawl path (`POST /api/crawl` → `provider.start` → poll →
 * cursor-exhaust → `persistCrawl`) in a durable Workflow so a failure mid-crawl (CF Browser-Run
 * rate limit, a long-running crawl that outlives a single request, an R2/D1 hiccup on persist)
 * resumes at the step boundary instead of restarting the whole crawl. It MIRRORS the existing
 * {@link workflows/drive-sync.DriveSyncWorkflow} + {@link workflows/image-generation.ImageGenerationWorkflow}
 * shape exactly: `extends WorkflowEntrypoint<Env, Params>`, `async run(event, step)`, each phase a
 * `step.do('name', RETRY, async () => …)`, polling via `step.sleep`.
 *
 * ## Step graph
 *
 * | Step        | Purpose                                                                  |
 * | ----------- | ------------------------------------------------------------------------ |
 * | `start`     | `provider.start(req)` → the CF crawl job (SSRF guard already ran upstream)|
 * | `monitor`   | `step.sleep` + `provider.status(id)` poll loop until terminal (bounded)   |
 * | `collect`   | exhaust `provider.results` cursors → normalized pages + link graph        |
 * | `persist`   | `persistCrawl(env, {job, pages, links, orgId, request})` → R2 + D1         |
 * | `finalize`  | mark terminal — surface the coverage roll-up as the workflow result       |
 *
 * The cache-check / dedupe / quality-scoring / rendered-fallback phases are deliberately left as
 * `// TODO(CRAWL-3b)` stubs below — CRAWL-3 is scoped to the lifecycle skeleton; those land next.
 *
 * PROVIDER-INDEPENDENT: the workflow speaks only the domain types from
 * `libs/features/site_crawl/schemas.ts` + the `CrawlProvider` port. No Cloudflare `/crawl` wire
 * shape leaks in — the CF semantics stay owned by `CloudflareCrawlProvider` (`provider.ts`). The
 * params are Zod-validated at the top of `run` (per `zod-everywhere`).
 *
 * Flag-dark: the `POST /api/crawl` handler only triggers this workflow behind the `site_crawl`
 * flag (404 when off) AND only when the `SITE_CRAWL_WORKFLOW` binding is present; otherwise it
 * falls back to the inline provider path. So this is inert in prod until promotion + binding land.
 *
 * @packageDocumentation
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from '../types/env.js';
import {
  CrawlModeSchema,
  type CrawlJob,
  type CrawlPage,
  type CrawlLink,
  type CrawlRequest,
} from '../../libs/features/site_crawl/schemas.js';
import { CloudflareCrawlProvider, type CrawlProvider } from '../../libs/features/site_crawl/provider.js';
import {
  persistCrawl,
  type CrawlPersistenceEnv,
} from '../../libs/features/site_crawl/persistence.js';

/**
 * Zod schema for the workflow params — validated at the top of {@link SiteCrawlWorkflow.run} so a
 * malformed trigger fails fast (per `zod-everywhere`). The shape mirrors what the `POST /api/crawl`
 * handler passes: the already-SSRF-guarded seed URL, the render mode, and the full originating
 * {@link CrawlRequest} (so `collect`/`persist` can re-use its config + compute a stable fingerprint).
 */
export const SiteCrawlWorkflowParamsSchema = z
  .object({
    /** The domain crawl id (also the CF job id + the D1 primary key + the manifest `crawlId`). */
    crawlId: z.string().min(1),
    /** The seed URL — already SSRF-validated by `assertCrawlUrlSafe` in the POST handler. */
    url: z.string().url(),
    /** Render strategy (echoed for observability; the full request drives the provider call). */
    mode: CrawlModeSchema,
    /** Owning org — scopes the persisted D1 row + authz. `null` allowed but discouraged. */
    orgId: z.string().nullable(),
    /**
     * The full originating request. Optional (a bare `{crawlId,url,mode,orgId}` trigger still
     * works), but when present it drives the provider's render/scope config + the persist
     * fingerprint, exactly as the inline path does.
     */
    request: z.unknown().optional(),
  })
  .strict();

/** The validated workflow params. `request` is re-validated to {@link CrawlRequest} inside `run`. */
export type SiteCrawlWorkflowParams = z.infer<typeof SiteCrawlWorkflowParamsSchema>;

/**
 * The `start` step's serialized snapshot of the job handle (the fields the later steps need).
 * Kept Serializable-clean (all primitives) so it round-trips through the Workflow step boundary.
 */
interface StartedJob {
  id: string;
  status: CrawlJob['status'];
  url: string;
  createdAt: string;
}

/**
 * The `collect` step's result. {@link CrawlPage} carries a `metadata: Record<string, unknown>` field,
 * which is structured-cloneable at RUNTIME but trips the compiler's `Rpc.Serializable<T>` self-referential
 * bound on `step.do` (it rejects the `unknown` value). We therefore type the step payloads explicitly +
 * cast the closure return at the step boundary — the data is genuinely serializable, so the cast is sound.
 */
interface CollectResult {
  pages: CrawlPage[];
  links: CrawlLink[];
}

/**
 * The durable workflow's final output — the honest coverage roll-up for the finished crawl.
 * `ok` is false only when `start` itself failed to yield a job (nothing to persist).
 */
export interface SiteCrawlWorkflowResult {
  ok: boolean;
  crawlId: string;
  status: CrawlJob['status'] | 'unknown';
  pagesCompleted: number;
  linksDiscovered: number;
  /** `true` when the persist step wrote BOTH the R2 corpus AND the D1 row without error. */
  persisted: boolean;
}

/** Standard retry policy for every resumable step (3 tries, 30s exponential backoff). */
const RETRY_30S = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' as const },
} as const;

/** Poll cadence + ceiling for the `monitor` loop — bounded so a stuck crawl can't spin forever. */
const POLL_INTERVAL = '10 seconds';
const MAX_POLL_ITERATIONS = 180; // ~30 min of polling at 10s — a sane upper bound for one crawl
/** Cursor-exhaustion ceiling (mirrors the handler's `collectResults` maxPages bound). */
const MAX_RESULT_WINDOWS = 200;

/** The job statuses that END the monitor loop (everything else is still in-flight). */
const TERMINAL_STATUSES: ReadonlySet<CrawlJob['status']> = new Set([
  'completed',
  'partial',
  'blocked',
  'budget_exhausted',
  'failed',
  'cancelled',
]);

/**
 * Workflows v2 entrypoint for one whole-site crawl.
 *
 * Invoked (flag-dark) from `POST /api/crawl` via
 * `env.SITE_CRAWL_WORKFLOW.create({ id: crawlId, params })` AFTER the SSRF guard + flag gate. When
 * the binding is absent the handler falls back to the inline provider path (never 500s).
 *
 * @example
 * ```ts
 * // wrangler.toml binds SITE_CRAWL_WORKFLOW → SiteCrawlWorkflow
 * const inst = await env.SITE_CRAWL_WORKFLOW.create({
 *   id: crawlId,
 *   params: { crawlId, url, mode, orgId, request },
 * });
 * // poll later: GET /api/crawl/:id
 * ```
 */
export class SiteCrawlWorkflow extends WorkflowEntrypoint<Env, SiteCrawlWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<SiteCrawlWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SiteCrawlWorkflowResult> {
    const env = this.env;
    // Zod-validate the params fail-fast (per zod-everywhere). The SSRF guard on the SEED already
    // ran in the POST handler before this workflow was ever created — do NOT re-fetch here.
    const params = SiteCrawlWorkflowParamsSchema.parse(event.payload);
    const { crawlId, url, orgId } = params;
    const request = params.request as CrawlRequest | undefined;

    // Build the provider once (CF Browser-Run adapter, org-scoped creds). The port is provider-
    // independent — swapping engines is a new `implements CrawlProvider`, nothing here changes.
    const provider: CrawlProvider = new CloudflareCrawlProvider(env, orgId);

    // ── TODO(CRAWL-3b): cache-check / dedupe ────────────────────────────────
    // Before starting a fresh crawl, look up the most-recent `site_crawls` row for this
    // (orgId, normalizedDomain); if its fingerprint matches + it is newer than `request.freshness`
    // AND `request.force` is not set, SHORT-CIRCUIT by re-persisting/returning the cached crawl
    // instead of re-running. (Left a stub to keep the CRAWL-3 slice bounded.)

    // ── Step 1: start ───────────────────────────────────────────────────────
    // `provider.start` POSTs the seed + returns the CF job (typically `running`). The SSRF guard
    // is the POST handler's job (fail-fast at the boundary) — not re-run here.
    const started: StartedJob = await step.do<StartedJob>('start', RETRY_30S, async () => {
      const job = await provider.start(request ?? { url, mode: params.mode });
      return { id: job.id, status: job.status, url: job.url, createdAt: job.createdAt };
    });

    // ── Step 2: monitor ───────────────────────────────────────────────────────
    // Poll `provider.status` until the job reaches a terminal state, bounded by MAX_POLL_ITERATIONS
    // so a stuck crawl can't spin forever. `step.sleep` between polls makes the wait durable (the
    // workflow hibernates, not a live timer). Each poll is its own retryable step.do.
    let lastStatus: CrawlJob['status'] = started.status;
    for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
      if (TERMINAL_STATUSES.has(lastStatus)) break;
      await step.sleep(`poll-wait-${i}`, POLL_INTERVAL);
      lastStatus = await step.do(`monitor-${i}`, RETRY_30S, async () => {
        const job = await provider.status(started.id);
        return job.status;
      });
    }

    // ── TODO(CRAWL-3b): rendered-fallback ────────────────────────────────────
    // When `mode === 'auto'` and the completed crawl's pages are thin (short markdown / mostly
    // the SPA shell), re-crawl the thin URLs with `render:true` and merge. (Stub — CRAWL-3b.)

    // ── Step 3: collect ───────────────────────────────────────────────────────
    // Exhaust the provider's cursor-paginated results into one flat list (a single window is NOT
    // the whole crawl — the caller MUST loop until the cursor is absent), bounded by
    // MAX_RESULT_WINDOWS. Returns the normalized pages + link-graph edges.
    // `step.do`'s `T extends Rpc.Serializable<T>` bound rejects {@link CollectResult} because
    // `CrawlPage.metadata` is `Record<string, unknown>` (structured-cloneable at RUNTIME, but the
    // compiler's `Serializable` recursion rejects the `unknown` value). The data IS serializable, so
    // we run the step through a locally-narrowed view of `step.do` that returns `Promise<CollectResult>` —
    // this keeps full type safety for every OTHER step while surgically escaping the one false bound.
    const collectStep = step.do as unknown as (
      name: string,
      config: typeof RETRY_30S,
      fn: () => Promise<CollectResult>,
    ) => Promise<CollectResult>;
    const collected: CollectResult = await collectStep('collect', RETRY_30S, async () => {
      const pages: CrawlPage[] = [];
      const links: CrawlLink[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < MAX_RESULT_WINDOWS; i++) {
        const res = await provider.results(started.id, cursor);
        pages.push(...res.pages);
        links.push(...res.links);
        if (!res.cursor) break;
        cursor = res.cursor;
      }
      return { pages, links };
    });

    // ── TODO(CRAWL-3b): quality scoring ──────────────────────────────────────
    // Score the collected corpus (coverage %, duplicate ratio, thin-page count) and stamp it on
    // the manifest so a downstream seed-into-build can gate on crawl quality. (Stub — CRAWL-3b.)

    // ── Step 4: persist ───────────────────────────────────────────────────────
    // Write the normalized corpus to R2 + upsert the `site_crawls` D1 row. `persistCrawl` is fully
    // fail-soft (R2/D1 errors are collected, never thrown) + idempotent (deterministic keys +
    // ON CONFLICT upsert), so a resume re-persists in place. The manifest is Zod-validated inside.
    const persisted = await step.do('persist', RETRY_30S, async () => {
      const job: CrawlJob = {
        id: started.id,
        status: lastStatus,
        url: started.url,
        createdAt: started.createdAt,
        pagesDiscovered: collected.pages.length,
        pagesCompleted: collected.pages.length,
        ...(TERMINAL_STATUSES.has(lastStatus) ? { completedAt: new Date().toISOString() } : {}),
      };
      const result = await persistCrawl(env as unknown as CrawlPersistenceEnv, {
        job,
        pages: collected.pages,
        links: collected.links,
        orgId,
        request,
      });
      return { ok: result.ok, crawlId: result.crawlId };
    });

    // ── Step 5: finalize ───────────────────────────────────────────────────────
    // Mark terminal — fold the coverage roll-up into the workflow's durable result.
    return step.do('finalize', RETRY_30S, async () => {
      return {
        ok: true,
        crawlId,
        status: lastStatus,
        pagesCompleted: collected.pages.length,
        linksDiscovered: collected.links.length,
        persisted: persisted.ok,
      } satisfies SiteCrawlWorkflowResult;
    });
  }
}
