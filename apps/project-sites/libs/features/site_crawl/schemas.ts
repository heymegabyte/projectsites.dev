import { z } from 'zod';

/**
 * Provider-INDEPENDENT Zod domain for the whole-site crawl feature (CRAWL-0 foundation).
 *
 * These schemas are the single source of truth for the crawl domain — every boundary
 * (request bodies, job state, persisted pages/links/coverage/manifest) parses through
 * them, and every TS type is `z.infer`'d, never hand-duplicated (per `zod-everywhere`).
 *
 * NOTHING here knows about Cloudflare. No Browser-Run `/crawl` response shape, no CF job
 * id format, no vendor field leaks into the domain. The `CrawlProvider` port
 * (`provider.ts`) is where the CF semantics are documented + adapted; the real Browser-Run
 * wiring is CRAWL-1. Routes / workflow / persistence are CRAWL-1..4 — none live here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the crawl renders a page.
 * - `fast`     — static HTML fetch only (CF `render:false`). Cheapest; misses SPA content.
 * - `auto`     — fast first, fall back to a rendered pass per-URL when the static HTML is thin
 *                (the default — best coverage for the least cost).
 * - `rendered` — always render (headless Chromium). Most expensive; fullest SPA coverage.
 */
export const CrawlModeSchema = z.enum(['fast', 'auto', 'rendered']);
export type CrawlMode = z.infer<typeof CrawlModeSchema>;

/** Terminal + in-flight job states. `partial` = some pages crawled before a stop condition. */
export const CrawlStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'blocked', // robots / auth / bot-wall stopped the crawl
  'budget_exhausted', // page/depth/time budget hit before completion
  'failed',
  'cancelled',
]);
export type CrawlStatus = z.infer<typeof CrawlStatusSchema>;

/** Roll-up status of a coverage report (distinct from the job status; summarizes the outcome). */
export const CoverageStatusSchema = z.enum([
  'complete', // every discovered URL resolved (crawled, deduped, or deliberately excluded)
  'partial', // stopped early but got useful coverage
  'blocked', // robots/auth/bot-wall prevented meaningful coverage
  'budget_exhausted', // ran out of page/depth/time budget
  'failed', // the crawl errored before producing coverage
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** Where a discovered link points relative to the crawl root host. */
export const LinkKindSchema = z.enum(['internal', 'external']);
export type LinkKind = z.infer<typeof LinkKindSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A request to start a whole-site crawl. `url` is the only required field; everything else
 * has a safe default so a caller can `{ url }` and get a sensible auto-mode crawl.
 */
export const CrawlRequestSchema = z
  .object({
    /** Seed URL to crawl from. Must be a valid absolute http(s) URL. */
    url: z.string().url(),
    /** Render strategy — defaults to `auto` (fast-first, rendered-fallback). */
    mode: CrawlModeSchema.default('auto'),
    /** Max pages to crawl (sanity ceiling against runaway crawls). */
    limit: z.number().int().positive().max(5000).optional(),
    /** Max link-depth from the seed URL. */
    depth: z.number().int().nonnegative().max(32).optional(),
    /** Follow links into sibling subdomains of the root host. */
    includeSubdomains: z.boolean().optional(),
    /** Record external links in the link graph (never crawled, only recorded). */
    includeExternalLinks: z.boolean().optional(),
    /** Glob/substring patterns a URL MUST match to be crawled. */
    includePatterns: z.array(z.string()).optional(),
    /** Glob/substring patterns that exclude a URL from the crawl. */
    excludePatterns: z.array(z.string()).optional(),
    /** Cache freshness window in seconds — reuse a prior crawl newer than this. */
    freshness: z.number().int().nonnegative().optional(),
    /** Force a fresh crawl, ignoring any cached result. */
    force: z.boolean().optional(),
  })
  .strict();
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A crawl job — the provider-independent handle returned by `start()` and refreshed by
 * `status()`. `id` is the domain's own job id (NOT a CF-native id; the adapter maps between
 * them). Counts are live tallies surfaced for progress UI.
 */
export const CrawlJobSchema = z
  .object({
    /** Domain job id (UUID). The provider adapter maps this to/from any vendor id. */
    id: z.string().uuid(),
    status: CrawlStatusSchema,
    /** The seed URL this job was started with. */
    url: z.string().url(),
    createdAt: z.string(),
    /** Set once the job reaches a terminal state. */
    completedAt: z.string().optional(),
    /** Live progress tallies. */
    pagesDiscovered: z.number().int().nonnegative().default(0),
    pagesCompleted: z.number().int().nonnegative().default(0),
    /** Human-readable reason for a non-success terminal status (blocked/failed/exhausted). */
    message: z.string().optional(),
  })
  .strict();
export type CrawlJob = z.infer<typeof CrawlJobSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One crawled page, normalized. `discoveredUrl` is where it was found in the graph,
 * `requestedUrl` is what we asked for, `finalUrl` is after redirects — kept distinct so a
 * redirect chain / canonical mismatch is visible, never silently collapsed.
 */
export const CrawlPageSchema = z
  .object({
    /** Domain page id (UUID). */
    id: z.string().uuid(),
    discoveredUrl: z.string().url(),
    requestedUrl: z.string().url(),
    finalUrl: z.string().url(),
    canonicalUrl: z.string().url().optional(),
    title: z.string().optional(),
    /** Normalized page content as markdown. */
    markdown: z.string(),
    /** Free-form extracted metadata (og tags, meta description, lang, etc.). */
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** Content hash for dedupe + change detection (freshness). */
    contentHash: z.string(),
  })
  .strict();
export type CrawlPage = z.infer<typeof CrawlPageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Link
// ─────────────────────────────────────────────────────────────────────────────

/** One edge in the crawl link graph: `from` page URL → `to` URL, tagged internal/external. */
export const CrawlLinkSchema = z
  .object({
    from: z.string().url(),
    to: z.string().url(),
    kind: LinkKindSchema,
  })
  .strict();
export type CrawlLink = z.infer<typeof CrawlLinkSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Coverage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The coverage report for a crawl — the honest accounting of what happened to every URL.
 * Each counter is a disjoint bucket so `discovered` reconciles against the sum of outcomes;
 * `status` rolls the buckets up (per `verify-against-source-of-truth` — coverage must be
 * reconcilable, never a bare "done").
 */
export const CrawlCoverageSchema = z
  .object({
    discovered: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    /** Pages that needed a rendered fallback after the static fetch was thin. */
    renderedFallback: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** Blocked by robots.txt / disallow rules. */
    disallowed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    /** Collapsed as duplicate content (same contentHash). */
    duplicate: z.number().int().nonnegative(),
    /** Excluded by include/exclude patterns. */
    excluded: z.number().int().nonnegative(),
    status: CoverageStatusSchema,
  })
  .strict();
export type CrawlCoverage = z.infer<typeof CrawlCoverageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The durable manifest of a finished crawl — the pointer record other surfaces consume
 * (seed-into-build, re-crawl, audit). `provider` names the adapter that produced it (e.g.
 * `cloudflare`) so a mixed-provider future stays legible; `r2Keys` point at where the
 * normalized pages/links live. `fingerprint` is a stable hash of the crawl inputs for cache
 * reuse (freshness).
 */
export const CrawlManifestSchema = z
  .object({
    crawlId: z.string().uuid(),
    root: z.string().url(),
    /** Adapter identity — e.g. `cloudflare`. Domain-level label, not a vendor shape. */
    provider: z.string().min(1),
    counts: CrawlCoverageSchema,
    /** R2 object keys for the persisted crawl artifacts (pages, links, raw). */
    r2Keys: z.array(z.string()).default([]),
    /** Stable hash of the crawl inputs — drives freshness/cache reuse. */
    fingerprint: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type CrawlManifest = z.infer<typeof CrawlManifestSchema>;
