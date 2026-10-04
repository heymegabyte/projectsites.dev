-- 0658_site_crawls.sql (CRAWL-3 — whole-site-crawl D1 metadata)
-- ADDITIVE ONLY. One row per crawl job, written/updated by
-- libs/features/site_crawl/persistence.ts (persistCrawl) at the point the
-- normalized results are collected. The R2 corpus (manifest.json, per-page
-- markdown, links.json, full-site.md) lives under r2_prefix in SITES_BUCKET;
-- this table is the queryable pointer/metadata record for it.
--
-- Isolation: org_id scopes every crawl to the caller's org (the in-process
-- jobId->orgId map in handlers.ts is retired once this is read on promotion).
-- Flag-dark: writes only happen on the `site_crawl`-gated path (404 until
-- promoted), so applying this migration is inert until the flag flips on.
-- Persistence is fire-and-forget: a metadata/R2 failure never fails a crawl.

CREATE TABLE IF NOT EXISTS site_crawls (
  -- The crawl/provider job id (CF Browser-Run returns a UUID) — the domain job
  -- id directly, matching CrawlManifest.crawlId. TEXT per the repo convention.
  id TEXT PRIMARY KEY,
  org_id TEXT,
  -- The seed URL the crawl started from (CrawlManifest.root).
  root_url TEXT NOT NULL,
  -- Host of root_url, normalized (lowercased, leading `www.` stripped) — the
  -- stable R2 corpus namespace + a human-groupable key. e.g. `example.com`.
  normalized_domain TEXT NOT NULL,
  -- Provider-independent job status (CrawlStatus): queued | running | completed
  -- | partial | blocked | budget_exhausted | failed | cancelled.
  status TEXT NOT NULL DEFAULT 'running',
  -- Render strategy (CrawlMode): fast | auto | rendered.
  mode TEXT,
  -- Adapter identity (CrawlManifest.provider) — e.g. `cloudflare`.
  provider TEXT,
  -- The underlying provider's own job id (same as `id` for CF today, but kept
  -- distinct so a provider that mints a separate id doesn't force a schema change).
  provider_job_id TEXT,
  -- Live coverage tallies (CrawlCoverage): disjoint buckets that reconcile.
  pages_discovered INTEGER NOT NULL DEFAULT 0,
  pages_completed INTEGER NOT NULL DEFAULT 0,
  errored INTEGER NOT NULL DEFAULT 0,
  -- Roll-up coverage status (CoverageStatus): complete | partial | blocked |
  -- budget_exhausted | failed.
  coverage_status TEXT,
  -- Total bytes of normalized page markdown persisted to the R2 corpus.
  content_bytes INTEGER NOT NULL DEFAULT 0,
  -- Stable hash of the crawl inputs (CrawlManifest.fingerprint) — drives
  -- freshness/cache reuse + change detection across re-crawls.
  fingerprint TEXT,
  -- R2 key prefix the corpus is written under:
  -- `crawls/{normalized_domain}/{id}/` (deterministic + overwrite-safe).
  r2_prefix TEXT,
  -- The previous crawl of the same normalized_domain for this org, if any —
  -- enables diff/freshness chaining. NULL on the first crawl of a domain.
  previous_crawl_id TEXT,
  -- JSON snapshot of the CrawlRequest config (mode/limit/depth/patterns/…).
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Soft-delete marker (NULL = live), consistent with the rest of the schema.
  deleted_at TEXT
);

-- Org-scoped recency listing (the admin/editor "recent crawls" surface).
CREATE INDEX IF NOT EXISTS idx_site_crawls_org_created
  ON site_crawls(org_id, created_at);

-- Freshness / re-crawl lookup: most-recent crawl of a domain for an org.
CREATE INDEX IF NOT EXISTS idx_site_crawls_org_domain
  ON site_crawls(org_id, normalized_domain, created_at);

-- Fingerprint reuse (cache a prior identical-inputs crawl).
CREATE INDEX IF NOT EXISTS idx_site_crawls_fingerprint
  ON site_crawls(fingerprint);
