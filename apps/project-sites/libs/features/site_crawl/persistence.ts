/**
 * @module libs/features/site_crawl/persistence
 * @description CRAWL-3 — durable persistence for a finished crawl: the normalized corpus to R2
 * (`SITES_BUCKET`) + a queryable metadata row to D1 (`site_crawls`).
 *
 * `persistCrawl(env, { job, pages, links, orgId, request, previousCrawlId })` is called from the
 * existing results-collection path (handlers' `collectResults`) — it does NOT mount routes (CRAWL-2
 * owns the HTTP surface). It is PROVIDER-INDEPENDENT: it accepts only the domain types from
 * `schemas.ts` ({@link CrawlJob} / {@link CrawlPage} / {@link CrawlLink} / {@link CrawlRequest}) —
 * no Cloudflare `/crawl` shape ever reaches here.
 *
 * R2 layout (deterministic + overwrite-safe — re-persisting the same crawl re-writes the same keys):
 * ```
 * crawls/{normalizedDomain}/{crawlId}/
 *   manifest.json          the Zod-validated CrawlManifest (counts + r2Keys + fingerprint)
 *   links.json             the full CrawlLink[] (link graph)
 *   full-site.md           every page as one source-URL-delimited markdown doc
 *   pages/{pageId}.md       one normalized page per file (`# <finalUrl>` + markdown)
 * ```
 *
 * D1: upserts one row per crawl into `site_crawls` (migration 0658) — status / mode / provider /
 * coverage tallies / content_bytes / fingerprint / r2_prefix / previous_crawl_id / config. Re-running
 * is idempotent (`INSERT … ON CONFLICT(id) DO UPDATE`), so a progress re-persist updates in place.
 *
 * FAIL-SOFT (per `fail-fast-build-fail-soft-prod`): persistence is best-effort instrumentation — an
 * R2 or D1 failure is logged + returned in the result envelope but NEVER thrown, so it can't fail a
 * crawl. The manifest is Zod-`parse`d before any write (a malformed manifest IS a bug worth catching).
 *
 * Flag-dark: only the `site_crawl`-gated results path calls this, so it is inert until promotion.
 *
 * @packageDocumentation
 */

import {
  CrawlManifestSchema,
  CoverageStatusSchema,
  type CrawlJob,
  type CrawlPage,
  type CrawlLink,
  type CrawlRequest,
  type CrawlManifest,
  type CrawlCoverage,
  type CrawlStatus,
} from './schemas.js';

/**
 * A minimal structural view of the worker env this module touches — just the two bindings it uses.
 * Declared locally (not imported from `src/types/env.ts`) so the module stays provider-independent
 * and trivially testable with a fake `{ SITES_BUCKET, DB }`.
 */
export interface CrawlPersistenceEnv {
  /** R2 bucket for the crawl corpus (same binding the site server + media use). */
  SITES_BUCKET: {
    put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>;
  };
  /** D1 binding for the `site_crawls` metadata row. */
  DB: D1Database;
}

/** Everything `persistCrawl` needs — the collected results plus the ownership + request context. */
export interface PersistCrawlInput {
  /** The crawl job (its `id` is the manifest `crawlId` + the D1 primary key). */
  job: CrawlJob;
  /** Every normalized page collected for the crawl (cursor already exhausted upstream). */
  pages: CrawlPage[];
  /** Every link-graph edge collected for the crawl. */
  links: CrawlLink[];
  /** Owning org — scopes the D1 row. `null` is allowed (column is nullable) but discouraged. */
  orgId: string | null;
  /** The originating request (drives mode/config snapshot + a stable fingerprint). */
  request?: CrawlRequest;
  /** The prior crawl of the same domain for this org, if known (diff/freshness chaining). */
  previousCrawlId?: string;
  /** Adapter identity for the manifest (`CrawlManifest.provider`). Defaults to `cloudflare`. */
  provider?: string;
}

/** The outcome of a persist attempt — honest about partial success (fail-soft). */
export interface PersistCrawlResult {
  /** `true` only when BOTH the R2 corpus AND the D1 row were written without error. */
  ok: boolean;
  /** The crawl id (= manifest.crawlId = D1 pk). */
  crawlId: string;
  /** The R2 key prefix the corpus was written under. */
  r2Prefix: string;
  /** Every R2 object key written (also mirrored into the manifest). */
  r2Keys: string[];
  /** The Zod-validated manifest that was persisted. */
  manifest: CrawlManifest;
  /** Non-fatal errors (R2 and/or D1) — empty when `ok`. */
  errors: string[];
}

/** Adapter identity stamped on the manifest + D1 row when the caller doesn't override it. */
const DEFAULT_PROVIDER = 'cloudflare';

/**
 * Normalize a URL's host into a stable, filesystem-safe corpus namespace:
 * lowercase, strip a leading `www.`, drop the port. Falls back to `unknown` for an unparseable URL
 * so a key is always producible (never throws).
 *
 * @example `https://www.Example.com:443/about` → `example.com`
 */
export function normalizeDomain(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.replace(/^www\./, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The deterministic R2 key prefix for a crawl's corpus (always ends with `/`). */
export function crawlR2Prefix(normalizedDomain: string, crawlId: string): string {
  return `crawls/${normalizedDomain}/${crawlId}/`;
}

/**
 * Build the whole crawl as one source-URL-delimited markdown document — the SAME shape the
 * `GET /api/crawl/:id/export.md` handler emits, extracted here so both share one builder (no drift).
 * Each page is a `## <finalUrl>` section + its trimmed markdown, joined by a horizontal rule.
 */
export function buildFullSiteMarkdown(pages: CrawlPage[]): string {
  return pages.map((p) => `## ${p.finalUrl}\n\n${p.markdown.trim()}`).join('\n\n---\n\n');
}

/**
 * Derive the disjoint-bucket {@link CrawlCoverage} report from the collected pages + the job state.
 *
 * With CF's current `/crawl` adapter the normalized page list is the completed set, so `completed`
 * = `pages.length` and `discovered` = `max(job.pagesDiscovered, completed)` (the job tally can lag
 * or be 0). `errored` = `max(0, discovered − completed)`. The roll-up `status` maps the job status
 * into a {@link CoverageStatus}. Every counter is non-negative + reconciles (`discovered` ≥ the sum
 * of terminal buckets) per `verify-against-source-of-truth`.
 */
export function deriveCoverage(job: CrawlJob, pages: CrawlPage[]): CrawlCoverage {
  const completed = pages.length;
  const discovered = Math.max(job.pagesDiscovered ?? 0, completed);
  const errored = Math.max(0, discovered - completed);
  return {
    discovered,
    queued: 0,
    completed,
    renderedFallback: 0,
    skipped: 0,
    disallowed: 0,
    errored,
    cancelled: job.status === 'cancelled' ? errored : 0,
    duplicate: 0,
    excluded: 0,
    status: coverageStatusForJob(job.status),
  };
}

/** Map a job {@link CrawlStatus} → a coverage roll-up {@link CoverageStatus} (validated by Zod). */
function coverageStatusForJob(status: CrawlStatus): CrawlCoverage['status'] {
  switch (status) {
    case 'completed':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'failed':
      return 'failed';
    case 'partial':
    case 'cancelled':
    case 'queued':
    case 'running':
    default:
      // In-flight / cancelled / partial all roll up to `partial` — useful coverage, not "complete".
      return CoverageStatusSchema.enum.partial;
  }
}

/**
 * FNV-1a 32-bit hash → 8-hex-char string. Cheap, dependency-free — mirrors the provider's hash so
 * fingerprints are comparable. Used for the manifest fingerprint (stable per crawl inputs).
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A STABLE fingerprint of the crawl inputs (root + render/scope config) — identical inputs produce
 * an identical fingerprint, which drives freshness/cache reuse. Keys are sorted so object-order
 * can't perturb the hash.
 */
export function fingerprintCrawl(rootUrl: string, request?: CrawlRequest): string {
  const cfg = {
    url: rootUrl,
    mode: request?.mode ?? 'auto',
    limit: request?.limit ?? null,
    depth: request?.depth ?? null,
    includeSubdomains: request?.includeSubdomains ?? false,
    includeExternalLinks: request?.includeExternalLinks ?? false,
    includePatterns: request?.includePatterns ?? [],
    excludePatterns: request?.excludePatterns ?? [],
  };
  return fnv1a(JSON.stringify(cfg, Object.keys(cfg).sort()));
}

/** JSON snapshot of the request config persisted to the D1 `config` column (null when unknown). */
function configSnapshot(request?: CrawlRequest): string | null {
  if (!request) return null;
  return JSON.stringify({
    mode: request.mode,
    limit: request.limit ?? null,
    depth: request.depth ?? null,
    includeSubdomains: request.includeSubdomains ?? false,
    includeExternalLinks: request.includeExternalLinks ?? false,
    includePatterns: request.includePatterns ?? [],
    excludePatterns: request.excludePatterns ?? [],
    freshness: request.freshness ?? null,
  });
}

/** Total bytes of normalized page markdown (surfaced as `content_bytes` for quick size accounting). */
function contentBytes(pages: CrawlPage[]): number {
  let n = 0;
  for (const p of pages) n += p.markdown.length;
  return n;
}

/**
 * Persist a finished (or progressing) crawl: write the R2 corpus THEN upsert the D1 metadata row.
 *
 * Idempotent + overwrite-safe — deterministic R2 keys + an `ON CONFLICT(id) DO UPDATE` D1 upsert, so
 * calling it again for the same crawl re-writes the corpus + updates the row in place (e.g. a
 * progress persist followed by a final persist).
 *
 * Fail-soft: R2 and D1 failures are collected into `result.errors` and logged, never thrown — a
 * persistence failure must not fail the crawl. The manifest is Zod-validated BEFORE any write.
 *
 * @param env   - worker env (just `SITES_BUCKET` + `DB`)
 * @param input - collected results + ownership/request context
 * @returns a {@link PersistCrawlResult} — `ok` iff both the corpus and the row were written
 */
export async function persistCrawl(
  env: CrawlPersistenceEnv,
  input: PersistCrawlInput,
): Promise<PersistCrawlResult> {
  const { job, pages, links, orgId } = input;
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const rootUrl = job.url;
  const normalizedDomain = normalizeDomain(rootUrl);
  const prefix = crawlR2Prefix(normalizedDomain, job.id);

  const coverage = deriveCoverage(job, pages);
  const fingerprint = fingerprintCrawl(rootUrl, input.request);

  // Deterministic corpus keys (per-page files + the three aggregates).
  const manifestKey = `${prefix}manifest.json`;
  const linksKey = `${prefix}links.json`;
  const fullSiteKey = `${prefix}full-site.md`;
  const pageKeys = pages.map((p) => `${prefix}pages/${p.id}.md`);
  const r2Keys = [manifestKey, linksKey, fullSiteKey, ...pageKeys];

  // Build + VALIDATE the manifest before writing anything (a bad manifest is a real bug — throw it).
  const manifest = CrawlManifestSchema.parse({
    crawlId: job.id,
    root: rootUrl,
    provider,
    counts: coverage,
    r2Keys,
    fingerprint,
    createdAt: job.createdAt,
  } satisfies CrawlManifest);

  const errors: string[] = [];

  // ── R2 corpus ───────────────────────────────────────────────────────────
  const JSON_CT = { httpMetadata: { contentType: 'application/json' } };
  const MD_CT = { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } };
  const putSafe = async (key: string, body: string, opts: { httpMetadata?: { contentType?: string } }) => {
    try {
      await env.SITES_BUCKET.put(key, body, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`r2:${key}:${message}`);
    }
  };

  await Promise.all([
    putSafe(manifestKey, JSON.stringify(manifest), JSON_CT),
    putSafe(linksKey, JSON.stringify(links), JSON_CT),
    putSafe(fullSiteKey, buildFullSiteMarkdown(pages), MD_CT),
    ...pages.map((p) =>
      putSafe(`${prefix}pages/${p.id}.md`, `# ${p.finalUrl}\n\n${p.markdown.trim()}\n`, MD_CT),
    ),
  ]);

  // ── D1 metadata row (upsert) ──────────────────────────────────────────────
  const now = new Date().toISOString();
  const d1Error = await upsertCrawlRow(env.DB, {
    id: job.id,
    org_id: orgId,
    root_url: rootUrl,
    normalized_domain: normalizedDomain,
    status: job.status,
    mode: input.request?.mode ?? null,
    provider,
    provider_job_id: job.id,
    pages_discovered: coverage.discovered,
    pages_completed: coverage.completed,
    errored: coverage.errored,
    coverage_status: coverage.status,
    content_bytes: contentBytes(pages),
    fingerprint,
    r2_prefix: prefix,
    previous_crawl_id: input.previousCrawlId ?? null,
    config: configSnapshot(input.request),
    now,
  });
  if (d1Error) errors.push(`d1:${d1Error}`);

  if (errors.length) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'site_crawl',
        feature_slug: 'site_crawl',
        event: 'persist_partial',
        crawl_id: job.id,
        org_id: orgId ?? null,
        errors,
      }),
    );
  }

  return { ok: errors.length === 0, crawlId: job.id, r2Prefix: prefix, r2Keys, manifest, errors };
}

/** The flat D1 row shape (snake_case columns) plus the shared `now` timestamp. */
interface CrawlRowValues {
  id: string;
  org_id: string | null;
  root_url: string;
  normalized_domain: string;
  status: CrawlStatus;
  mode: string | null;
  provider: string;
  provider_job_id: string;
  pages_discovered: number;
  pages_completed: number;
  errored: number;
  coverage_status: CrawlCoverage['status'];
  content_bytes: number;
  fingerprint: string;
  r2_prefix: string;
  previous_crawl_id: string | null;
  config: string | null;
  now: string;
}

/**
 * Upsert the `site_crawls` row. Uses a raw `INSERT … ON CONFLICT(id) DO UPDATE` (there is no upsert
 * helper in `db.ts`) so a re-persist of the same crawl updates the live row in place — `created_at`
 * is preserved, `updated_at` + every mutable field are refreshed. Never throws: returns the error
 * message (or `null`) so the caller can fold it into the fail-soft envelope.
 *
 * @returns `null` on success, else the D1 error message.
 */
async function upsertCrawlRow(db: D1Database, v: CrawlRowValues): Promise<string | null> {
  const sql = `INSERT INTO site_crawls (
      id, org_id, root_url, normalized_domain, status, mode, provider, provider_job_id,
      pages_discovered, pages_completed, errored, coverage_status, content_bytes,
      fingerprint, r2_prefix, previous_crawl_id, config, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      org_id = excluded.org_id,
      root_url = excluded.root_url,
      normalized_domain = excluded.normalized_domain,
      status = excluded.status,
      mode = excluded.mode,
      provider = excluded.provider,
      provider_job_id = excluded.provider_job_id,
      pages_discovered = excluded.pages_discovered,
      pages_completed = excluded.pages_completed,
      errored = excluded.errored,
      coverage_status = excluded.coverage_status,
      content_bytes = excluded.content_bytes,
      fingerprint = excluded.fingerprint,
      r2_prefix = excluded.r2_prefix,
      previous_crawl_id = excluded.previous_crawl_id,
      config = excluded.config,
      updated_at = excluded.updated_at`;
  const params = [
    v.id,
    v.org_id,
    v.root_url,
    v.normalized_domain,
    v.status,
    v.mode,
    v.provider,
    v.provider_job_id,
    v.pages_discovered,
    v.pages_completed,
    v.errored,
    v.coverage_status,
    v.content_bytes,
    v.fingerprint,
    v.r2_prefix,
    v.previous_crawl_id,
    v.config,
    v.now,
    v.now,
  ];
  try {
    await db.prepare(sql).bind(...params).run();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown D1 error';
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'site_crawl',
        feature_slug: 'site_crawl',
        event: 'persist_d1_error',
        crawl_id: v.id,
        message,
      }),
    );
    return message;
  }
}
