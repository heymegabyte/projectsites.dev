/**
 * @module services/import_crawler
 *
 * @description
 * One-click site import crawler. Given a single source URL (Squarespace, Wix,
 * WordPress, Webflow, Ghost, or any plain HTML site), discovers every page the
 * site advertises and persists a normalized `_url_inventory.json` artifact to
 * R2 so the downstream {@link SiteGenerationWorkflow} can rebuild with every
 * source URL on disk.
 *
 * ## Discovery priority chain
 * Per `~/.claude/plugins/heymegabyte-claude-skills/rules/source-site-enhancement.md`:
 *   1. `sitemap.xml` + nested `<sitemap><loc>` indexes (canonical signal — most CMS
 *      auto-emit one)
 *   2. WordPress `wp-sitemap.xml`, Squarespace `sitemap.xml`, Wix
 *      `sitemap-index.xml` (CMS-specific patterns)
 *   3. `robots.txt` Sitemap: lines (some sites omit /sitemap.xml but advertise it
 *      via robots)
 *   4. Wayback Machine CDX API
 *      (`https://web.archive.org/cdx/search/cdx?url={host}/*&output=json`) — the
 *      historical superset; catches dead/orphaned URLs the live sitemap omits
 *   5. Homepage HTML BFS — follow same-host `<a href>` links, depth ≤ 2, capped
 *      at 200 candidates (defensive last resort when the first 4 yield <5 URLs)
 *
 * ## Fetch defaults
 * Per `~/.claude/plugins/heymegabyte-claude-skills/rules/fetch-defaults.md` —
 * every outbound fetch sends a Chrome-stable UA + companion headers so
 * Cloudflare Bot Management / CF Protect / AWS WAF don't 403 the crawler. The
 * raw `node-fetch` / Workers default UA gets blocked instantly on every major
 * managed site.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { isSafeCrawlUrl } from './outbound_webhooks.js';

/** Real Chrome desktop UA — per fetch-defaults.md, rotate quarterly. */
export const REAL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Companion headers that pair with `REAL_BROWSER_UA` to look like a real navigation. */
export const REAL_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': REAL_BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};

/** Per-URL classification slot, mirrors source-site-enhancement.md taxonomy. */
export type UrlClassification = 'keep' | 'merge' | '301' | 'drop';

/** Normalized inventory row — one per discovered URL. */
export interface InventoryUrl {
  url: string;
  /** First time we saw this URL during the current crawl (ISO 8601). */
  discovered_at: string;
  /** Where the URL came from in the priority chain. */
  source: 'sitemap' | 'robots' | 'wayback' | 'html_bfs';
  /** Classification — defaults to `keep`, mutated by downstream IA normalizer. */
  classification: UrlClassification;
  /** Path-only segment for grouping (`/about`, `/services/health-clinic`). */
  path: string;
  /** Optional `<title>` scraped during BFS, used by the pre-crawl preview UI. */
  title?: string;
}

/** Final report persisted to R2 + returned to the caller. */
export interface CrawlReport {
  source_url: string;
  base_origin: string;
  discovered_at: string;
  total_urls: number;
  by_source: Record<InventoryUrl['source'], number>;
  homepage_title: string | null;
  /**
   * Single dominant color hint extracted from the homepage `<meta name="theme-color">`
   * or the first inline `background` declaration. Best-effort — null when the
   * homepage doesn't advertise one. Used purely as a pre-crawl preview accent
   * in the UI; the actual brand extraction happens later in the AI pipeline.
   */
  theme_color: string | null;
  urls: InventoryUrl[];
}

/**
 * Best-effort fetch wrapper. Sends realistic browser headers, swallows network
 * errors (returns `null`), enforces a 15-second timeout so a slow origin can't
 * hang the entire crawl. Never throws.
 */
export async function safeFetch(url: string, timeoutMs = 15_000): Promise<Response | null> {
  // SSRF defense-in-depth (#31): never fetch an internal/private/metadata target,
  // even when a sitemap entry, robots.txt line, or homepage `<a href>` the BFS
  // follows points at one. The import route guards the SEED url; this guards every
  // hop after it. http+https only — file:/ftp:/gopher: never reach the network.
  if (!isSafeCrawlUrl(url)) return null;
  // `timer` + `clearTimeout` must live OUTSIDE the try so the `finally` clears
  // the abort timer on BOTH paths. Previously `clearTimeout` was only on the
  // success line, so when `fetch` threw (network error / abort) the timer
  // leaked until it fired — a dangling handle per call (the source of the test
  // fleet's "worker failed to exit gracefully" force-exit, and a real prod leak).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // SSRF (gap-audit #2): follow redirects MANUALLY and re-validate every hop.
    // `redirect:'follow'` would let a public URL 302 to 169.254.169.254 / localhost /
    // RFC1918 — the seed guard above only sees the pre-redirect host. Cap at 5 hops.
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, {
        headers: REAL_BROWSER_HEADERS,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (res.status < 300 || res.status >= 400) return res;
      const loc = res.headers.get('location');
      if (!loc) return res;
      const next = new URL(loc, current).toString();
      if (!isSafeCrawlUrl(next)) return null; // redirect points at an internal target
      current = next;
    }
    return null; // too many redirects (possible redirect-loop SSRF)
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a URL — drop fragment, lowercase host, strip default port. */
function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    // Strip session-y trackers that fragment the inventory unnecessarily.
    const drops = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ];
    for (const k of drops) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

/** Strict same-origin guard — match scheme + host but ignore trailing slash on origin. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Parse a sitemap.xml document. Supports both `<urlset>` (leaf) and
 * `<sitemapindex>` (nested) shapes. Returns leaf URLs only — caller fans out
 * to nested sitemaps separately so we can mark each provenance correctly.
 */
function parseSitemapLeaves(xml: string): { leaves: string[]; nested: string[] } {
  const leaves: string[] = [];
  const nested: string[] = [];
  // Cheap regex parse — Workers runtime has no DOMParser. Sitemaps are
  // structurally simple enough that regex is reliable here.
  const urlMatches = xml.matchAll(/<url>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  for (const m of urlMatches) {
    if (m[1]) leaves.push(m[1].trim());
  }
  const indexMatches = xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  for (const m of indexMatches) {
    if (m[1]) nested.push(m[1].trim());
  }
  return { leaves, nested };
}

/**
 * Discover URLs via `/sitemap.xml` + CMS-specific siblings, following nested
 * `<sitemapindex>` references up to one level deep. Hard cap at 2,000 URLs to
 * avoid runaway crawls on news/archive sites — beyond that the downstream
 * pipeline truncates anyway.
 */
async function fromSitemap(origin: string): Promise<InventoryUrl[]> {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/page-sitemap.xml`,
    `${origin}/post-sitemap.xml`,
  ];
  const seen = new Set<string>();
  const out: InventoryUrl[] = [];

  for (const candidate of candidates) {
    if (out.length >= 2_000) break;
    const res = await safeFetch(candidate);
    if (!res || !res.ok) continue;
    const xml = await res.text();
    const { leaves, nested } = parseSitemapLeaves(xml);
    for (const leaf of leaves) {
      const norm = normalizeUrl(leaf);
      if (!norm || seen.has(norm) || !sameOrigin(norm, origin)) continue;
      seen.add(norm);
      out.push({
        url: norm,
        discovered_at: new Date().toISOString(),
        source: 'sitemap',
        classification: 'keep',
        path: new URL(norm).pathname,
      });
      if (out.length >= 2_000) break;
    }
    // Walk one level of nested sitemaps so multi-segment indexes work.
    for (const n of nested.slice(0, 20)) {
      if (out.length >= 2_000) break;
      const inner = await safeFetch(n);
      if (!inner || !inner.ok) continue;
      const innerLeaves = parseSitemapLeaves(await inner.text()).leaves;
      for (const leaf of innerLeaves) {
        const norm = normalizeUrl(leaf);
        if (!norm || seen.has(norm) || !sameOrigin(norm, origin)) continue;
        seen.add(norm);
        out.push({
          url: norm,
          discovered_at: new Date().toISOString(),
          source: 'sitemap',
          classification: 'keep',
          path: new URL(norm).pathname,
        });
        if (out.length >= 2_000) break;
      }
    }
  }
  return out;
}

/**
 * Parse robots.txt for `Sitemap:` directives. Some sites omit `/sitemap.xml`
 * at the canonical location but advertise it via robots.txt.
 */
async function fromRobots(origin: string, alreadySeen: Set<string>): Promise<InventoryUrl[]> {
  const res = await safeFetch(`${origin}/robots.txt`);
  if (!res || !res.ok) return [];
  const text = await res.text();
  const sitemapLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^sitemap:/i.test(l))
    .map((l) => l.replace(/^sitemap:\s*/i, '').trim());

  const out: InventoryUrl[] = [];
  // Cap accumulated leaves exactly like fromSitemap (2_000). Without it an attacker-controlled
  // source site's robots.txt (up to 10 `Sitemap:` lines, each a crafted XML with 100k+ <loc>
  // entries) grows `out` unbounded → the full set is JSON.stringify'd into R2 + returned in the
  // import response, inflating Worker CPU/memory + R2 cost per single authed /import call (AL-779).
  const MAX_ROBOTS_URLS = 2_000;
  for (const sm of sitemapLines.slice(0, 10)) {
    if (out.length >= MAX_ROBOTS_URLS) break;
    const inner = await safeFetch(sm);
    if (!inner || !inner.ok) continue;
    const { leaves } = parseSitemapLeaves(await inner.text());
    for (const leaf of leaves) {
      const norm = normalizeUrl(leaf);
      if (!norm || alreadySeen.has(norm) || !sameOrigin(norm, origin)) continue;
      alreadySeen.add(norm);
      out.push({
        url: norm,
        discovered_at: new Date().toISOString(),
        source: 'robots',
        classification: 'keep',
        path: new URL(norm).pathname,
      });
      if (out.length >= MAX_ROBOTS_URLS) break;
    }
  }
  return out;
}

/**
 * Wayback CDX fallback — pulls every snapshotted URL for the host, returning
 * the deduped set. Useful for sites that have nuked their sitemap (or never
 * had one) but still serve real URLs the Internet Archive recorded.
 *
 * Response shape: `[["urlkey", "timestamp", "original", "mimetype", "status", ...], ...]`
 * with the first row being a header. We pull the `original` column (index 2)
 * and dedupe by canonical URL.
 */
async function fromWayback(origin: string, alreadySeen: Set<string>): Promise<InventoryUrl[]> {
  const host = new URL(origin).host;
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host + '/*')}&output=json&limit=1000&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey`;
  const res = await safeFetch(cdxUrl, 20_000);
  if (!res || !res.ok) return [];
  let rows: unknown;
  try {
    rows = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const out: InventoryUrl[] = [];
  // Skip header row (index 0).
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 3) continue;
    const original = String(row[2] ?? '');
    const norm = normalizeUrl(original);
    if (!norm || alreadySeen.has(norm) || !sameOrigin(norm, origin)) continue;
    alreadySeen.add(norm);
    out.push({
      url: norm,
      discovered_at: new Date().toISOString(),
      source: 'wayback',
      classification: 'keep',
      path: new URL(norm).pathname,
    });
    if (out.length >= 1_000) break;
  }
  return out;
}

/**
 * Defensive homepage HTML BFS — depth 1 only, capped at 200 candidates. Used
 * when the prior strategies surface fewer than 5 URLs (most likely a tiny SPA
 * or a site whose sitemap is genuinely missing). Single fetch, no recursion
 * beyond the homepage to keep the crawl predictable on Workers CPU time.
 */
async function fromHomepageBfs(
  origin: string,
  alreadySeen: Set<string>,
): Promise<{ urls: InventoryUrl[]; homepageTitle: string | null; themeColor: string | null }> {
  const res = await safeFetch(origin);
  if (!res || !res.ok) return { urls: [], homepageTitle: null, themeColor: null };
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const homepageTitle = titleMatch?.[1]?.trim().slice(0, 200) ?? null;

  const themeColorMatch = html.match(
    /<meta\s+[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i,
  );
  const themeColor = themeColorMatch?.[1]?.trim().slice(0, 32) ?? null;

  const out: InventoryUrl[] = [];
  const hrefMatches = html.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi);
  for (const m of hrefMatches) {
    const href = m[1];
    if (!href) continue;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:'))
      continue;
    const norm = normalizeUrl(href, origin);
    if (!norm || !sameOrigin(norm, origin) || alreadySeen.has(norm)) continue;
    alreadySeen.add(norm);
    out.push({
      url: norm,
      discovered_at: new Date().toISOString(),
      source: 'html_bfs',
      classification: 'keep',
      path: new URL(norm).pathname,
    });
    if (out.length >= 200) break;
  }
  return { urls: out, homepageTitle, themeColor };
}

/**
 * Full crawl pipeline — runs the discovery chain in order, dedupes by canonical
 * URL, then persists `_url_inventory.json` to R2 at
 * `imports/{import_id}/_url_inventory.json` so the downstream Workflow can pull
 * the artifact during the research phase. The full inventory is also returned
 * so the caller can synthesize a preview without a second R2 round-trip.
 *
 * @param sourceUrl - Full URL to import (must include scheme).
 * @param importId - UUID for namespacing the R2 artifact.
 * @param env - Worker env (needs `SITES_BUCKET`).
 *
 * @returns A {@link CrawlReport} the route handler can include in the API
 *   response.
 */
export async function crawlSiteForImport(
  sourceUrl: string,
  importId: string,
  env: Env,
): Promise<CrawlReport> {
  const origin = new URL(sourceUrl).origin;
  const seen = new Set<string>();

  // Always seed the homepage so even an empty crawl ships ≥1 URL.
  seen.add(origin + '/');
  const seedHomepage: InventoryUrl = {
    url: origin + '/',
    discovered_at: new Date().toISOString(),
    source: 'sitemap',
    classification: 'keep',
    path: '/',
  };

  const sitemapUrls = await fromSitemap(origin);
  for (const u of sitemapUrls) seen.add(u.url);

  const robotsUrls = await fromRobots(origin, seen);

  // Only burn the Wayback round-trip if the live discovery is thin. The CDX
  // API is slow (~3-5s) and we don't want to pay for it on every healthy site.
  const liveCount = sitemapUrls.length + robotsUrls.length;
  const waybackUrls = liveCount < 5 ? await fromWayback(origin, seen) : [];

  const bfs = await fromHomepageBfs(origin, seen);

  const urls: InventoryUrl[] = [
    seedHomepage,
    ...sitemapUrls,
    ...robotsUrls,
    ...waybackUrls,
    ...bfs.urls,
  ];

  // Final dedupe pass — multiple sources can surface the same URL under
  // different first-seen flags; keep the highest-priority provenance.
  const dedup = new Map<string, InventoryUrl>();
  const priority: InventoryUrl['source'][] = ['sitemap', 'robots', 'wayback', 'html_bfs'];
  for (const u of urls) {
    const prior = dedup.get(u.url);
    if (!prior) {
      dedup.set(u.url, u);
      continue;
    }
    if (priority.indexOf(u.source) < priority.indexOf(prior.source)) {
      dedup.set(u.url, u);
    }
  }
  const finalUrls = Array.from(dedup.values());

  const bySource: Record<InventoryUrl['source'], number> = {
    sitemap: 0,
    robots: 0,
    wayback: 0,
    html_bfs: 0,
  };
  for (const u of finalUrls) bySource[u.source]++;

  const report: CrawlReport = {
    source_url: sourceUrl,
    base_origin: origin,
    discovered_at: new Date().toISOString(),
    total_urls: finalUrls.length,
    by_source: bySource,
    homepage_title: bfs.homepageTitle,
    theme_color: bfs.themeColor,
    urls: finalUrls,
  };

  // Persist to R2 — best-effort, never blocks the response. Inventory survives
  // worker restarts so the Workflow can read it during research.
  try {
    await env.SITES_BUCKET.put(
      `imports/${importId}/_url_inventory.json`,
      JSON.stringify(report, null, 2),
      { httpMetadata: { contentType: 'application/json' } },
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'import_crawler',
        message: 'Failed to persist _url_inventory.json to R2',
        importId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return report;
}

/**
 * Estimate how long the full AI rebuild will take. Linear in URL count beyond
 * a base 4-minute floor — the rebuild parallelizes most page work but each
 * extra route adds ~6 seconds of marginal pipeline cost.
 */
export function estimateRebuildMinutes(urlCount: number): number {
  const base = 4;
  const perUrlSeconds = 6;
  const extraMinutes = Math.ceil((urlCount * perUrlSeconds) / 60);
  return Math.min(60, base + extraMinutes);
}
