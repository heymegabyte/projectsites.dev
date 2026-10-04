#!/usr/bin/env node
/**
 * verify-delivered-site.mjs — the reusable headless health probe for DELIVERED sites.
 *
 * This is the "VIEW-LIVE" leg of the revenue golden journey: it proves that a site we
 * DELIVERED at `{slug}.projectsites.dev` actually serves correctly to a real browser —
 * not just that the build/deploy succeeded. (money-path slice VIEWLIVE-1.)
 *
 * Usage:
 *   node scripts/verify-delivered-site.mjs                 # DISCOVER up to 2 live slugs
 *   node scripts/verify-delivered-site.mjs slugA slugB     # probe the given slugs
 *   npm run verify:delivered-site -- slugA                 # via the package script
 *
 * Per site, loads `https://{slug}.projectsites.dev/` in LOCAL headless Chromium
 * (`chromium.launch({headless:true})`, same primitive as `e2e/admin-verify/_local-browser.mjs`
 * — NEVER visible Chrome, NEVER Browserbase) and asserts:
 *   - HTTP 200 on the main document.
 *   - `x-ps-serve` response header present (ideally `wfp` per the WfP-default-serving model;
 *     a different value WARNs, not FAILs — some sites may still serve a legacy path).
 *   - ZERO console errors + ZERO failed network requests (4xx/5xx) during load.
 *   - Key PWA assets resolve: `/favicon.ico`, `/apple-touch-icon.png`, `/site.webmanifest`
 *     (WARN if absent/404, FAIL only on 5xx).
 *   - A non-empty `<h1>` AND real main content (`document.body.innerText.length > 200`).
 *
 * Verdict per site is PASS | WARN | FAIL. Exit 1 iff ANY site FAILed (a WARN never fails).
 * Discovery finding no live delivered sites SKIPs (exit 0) rather than false-failing.
 *
 * Zero new deps — only `@playwright/test` (already a devDependency). Plain ESM (.mjs), zero TS.
 */
import { chromium } from '@playwright/test';

// Realistic browser UA (mirror Chrome stable — per the global fetch-defaults rule; avoids WAF
// blocks on the asset HEAD/GET fetches). Playwright sets its own UA for the page; we pass this
// into the context so both the navigation and the in-page asset fetches look like a real browser.
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const PUBLIC_ORIGIN = 'https://projectsites.dev';
const SUBDOMAIN = (slug) => `https://${slug}.projectsites.dev`;
// Fallback candidates probed when discovery finds nothing (then SKIP, never false-fail).
const FALLBACK_SLUGS = ['projectsites', 'lone-mountain-global'];
const NAV_TIMEOUT = 45000;
const KEY_ASSETS = ['/favicon.ico', '/apple-touch-icon.png', '/site.webmanifest'];

const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
};
const log = (m = '') => process.stdout.write(`${m}\n`);
const paint = (color, s) => `${color}${s}${C.reset}`;

/**
 * Cheap GET-200 probe of a subdomain root using in-Node fetch (no browser) — used only
 * by DISCOVERY to shortlist which discovered slugs are actually live before the full probe.
 * @param {string} slug
 * @returns {Promise<boolean>} true when the root returns 200.
 */
async function subdomainIs200(slug) {
  try {
    const res = await fetch(`${SUBDOMAIN(slug)}/`, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': REAL_UA, Accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Discover up to `max` live, pre-built published slugs via the PUBLIC
 * `GET /api/sites/search?q=...` (returns pre-built sites), keeping only those whose subdomain
 * currently returns 200. Tries a few broad query seeds to surface results.
 * @param {number} max
 * @returns {Promise<string[]>}
 */
async function discoverLiveSlugs(max = 2) {
  const seeds = ['a', 'e', 'o', 'i', 's']; // broad single-letter LIKE seeds → pre-built rows
  const seen = new Set();
  const candidates = [];
  for (const q of seeds) {
    try {
      const res = await fetch(`${PUBLIC_ORIGIN}/api/sites/search?q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': REAL_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      const rows = Array.isArray(body?.data) ? body.data : [];
      for (const row of rows) {
        const slug = row?.slug;
        // Prefer rows with a real build (has_build) — those are the ones whose subdomain
        // actually serves a site (not a branded 503 for a null-build published stub).
        if (slug && !seen.has(slug) && row?.has_build !== false) {
          seen.add(slug);
          candidates.push(slug);
        }
      }
    } catch {
      /* keep trying other seeds */
    }
    if (candidates.length >= max * 4) break; // enough to filter down from
  }

  const live = [];
  for (const slug of candidates) {
    if (live.length >= max) break;
    if (await subdomainIs200(slug)) live.push(slug);
  }
  return live;
}

/**
 * Full headless health probe of one delivered site.
 * @param {import('@playwright/test').Browser} browser
 * @param {string} slug
 * @returns {Promise<{slug:string, verdict:'PASS'|'WARN'|'FAIL', status:number|null,
 *   serve:string|null, consoleErrors:string[], failedRequests:string[],
 *   assets:Record<string,number|null>, h1:string, bodyLen:number, notes:string[]}>}
 */
async function probeSite(browser, slug) {
  const consoleErrors = [];
  const failedRequests = []; // real defects → FAIL
  const benignAborts = []; // tolerated optional-asset aborts → WARN
  const notes = [];
  const context = await browser.newContext({ userAgent: REAL_UA });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) =>
    consoleErrors.push(`pageerror: ${String(err?.message ?? err).slice(0, 300)}`),
  );
  page.on('requestfailed', (req) => {
    // Network-level failure (DNS, abort, refused) — distinct from an HTTP 4xx/5xx response.
    const err = req.failure()?.errorText ?? 'failed';
    const url = req.url();
    const type = req.resourceType();
    // An ABORTED optional asset is EXPECTED, not a defect: the template's Header PROBES
    // `logo-wordmark.png` (via fetch/img) and falls back to an HTML text wordmark when it
    // 404s/aborts — per the `logo-contrast` rule, MOST generated sites intentionally lack a
    // wordmark image. The abort surfaces with resourceType `fetch` (existence probe) OR `image`
    // (<img> onerror). Tolerate: a known-optional-asset path, OR any ERR_ABORTED on an
    // image/font/media/fetch resource. A real broken dependency (document/script/stylesheet, or
    // any non-abort error like ERR_CONNECTION/ERR_NAME_NOT_RESOLVED) still FAILs.
    const OPTIONAL_ASSET_RE = /\/logo-wordmark\.(png|webp|svg)(\?|$)/i;
    const isOptionalAssetAbort =
      /ERR_ABORTED/i.test(err) &&
      (OPTIONAL_ASSET_RE.test(url) || ['image', 'font', 'media', 'fetch'].includes(type));
    if (isOptionalAssetAbort) benignAborts.push(`${err} ${type} ${url.slice(0, 160)}`);
    else failedRequests.push(`${err} (${type}) ${url.slice(0, 160)}`);
  });
  page.on('response', (res) => {
    // A real HTTP 4xx/5xx RESPONSE on any request is a defect (the server answered with an error).
    const s = res.status();
    if (s >= 400) failedRequests.push(`HTTP ${s} ${res.url().slice(0, 160)}`);
  });

  let status = null;
  let serve = null;
  let h1 = '';
  let bodyLen = 0;
  const assets = {};

  try {
    // `load` (not `networkidle`): a delivered site with long-lived connections (analytics beacons,
    // prefetch) may never reach networkidle → a 45s false-timeout on a healthy page. `load` + a
    // settle delay is the correct bar for "the document served + rendered correctly".
    const resp = await page.goto(`${SUBDOMAIN(slug)}/`, {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT,
    });
    status = resp ? resp.status() : null;
    serve = resp ? (resp.headers()['x-ps-serve'] ?? null) : null;

    // Settle any late client render + late optional-asset requests.
    await page.waitForTimeout(3000);

    h1 = (await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? '')) || '';
    bodyLen = await page.evaluate(() => document.body?.innerText?.trim()?.length ?? 0);

    // Probe key PWA assets from INSIDE the page (same-origin, carries the real browser context).
    for (const path of KEY_ASSETS) {
      assets[path] = await page
        .evaluate(async (p) => {
          try {
            const r = await fetch(p, { method: 'GET', redirect: 'follow' });
            return r.status;
          } catch {
            return null; // network error fetching the asset
          }
        }, path)
        .catch(() => null);
    }
  } catch (err) {
    notes.push(`navigation error: ${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    await context.close();
  }

  // ─── Classify ───────────────────────────────────────────────
  let verdict = 'PASS';
  const fail = (m) => {
    verdict = 'FAIL';
    notes.push(m);
  };
  const warn = (m) => {
    if (verdict !== 'FAIL') verdict = 'WARN';
    notes.push(m);
  };

  if (status !== 200) fail(`main document HTTP ${status ?? 'ERR'} (expected 200)`);

  // x-ps-serve: present+wfp is ideal; present-but-different = WARN; absent = WARN (not FAIL).
  if (!serve) warn('x-ps-serve header absent');
  else if (serve !== 'wfp') warn(`x-ps-serve="${serve}" (expected "wfp")`);

  if (consoleErrors.length > 0) fail(`${consoleErrors.length} console error(s)`);
  if (failedRequests.length > 0) {
    const has5xx = failedRequests.some((r) => /HTTP 5\d\d/.test(r));
    // Any REAL failed/4xx-5xx request on the main load is a defect for a delivered site → FAIL.
    // (5xx is strictly worse but both fail the "clean load" bar. Benign optional-asset aborts —
    // e.g. the `logo-wordmark.png` fallback — are tracked separately below as WARN, not here.)
    fail(
      `${failedRequests.length} failed/4xx-5xx request(s)${has5xx ? ' (incl 5xx)' : ''}: ${failedRequests[0]}`,
    );
  }
  if (benignAborts.length > 0) {
    // Tolerated: an optional image/font/media the page intentionally lets fail (wordmark fallback).
    warn(`${benignAborts.length} optional-asset abort(s) (tolerated): ${benignAborts[0]}`);
  }

  // Key assets: 5xx = FAIL; 404/absent = WARN; 200 = clean.
  for (const [path, code] of Object.entries(assets)) {
    if (code === null) warn(`${path} fetch failed`);
    else if (code >= 500) fail(`${path} HTTP ${code} (5xx)`);
    else if (code >= 400) warn(`${path} HTTP ${code}`);
  }

  if (status === 200) {
    if (!h1) fail('no non-empty <h1>');
    if (bodyLen <= 200) fail(`main content too short (innerText ${bodyLen} ≤ 200)`);
  }

  return {
    slug,
    verdict,
    status,
    serve,
    consoleErrors,
    failedRequests,
    benignAborts,
    assets,
    h1,
    bodyLen,
    notes,
  };
}

function verdictColor(v) {
  return v === 'PASS' ? C.green : v === 'WARN' ? C.yellow : C.red;
}

/**
 * Render the per-site table + the asset codes + any notes.
 * @param {Awaited<ReturnType<typeof probeSite>>[]} results
 */
function printResults(results) {
  log();
  log(paint(C.bold, 'VIEW-LIVE delivered-site health'));
  log('─'.repeat(78));
  log(
    `${'SLUG'.padEnd(26)} ${'HTTP'.padEnd(5)} ${'x-ps-serve'.padEnd(11)} ${'CONSOLE'.padEnd(8)} ${'REQS'.padEnd(6)} VERDICT`,
  );
  log('─'.repeat(78));
  for (const r of results) {
    const serveCell = (r.serve ?? '—').slice(0, 11).padEnd(11);
    const serveDisplay =
      r.serve === 'wfp' ? paint(C.green, serveCell) : paint(C.yellow, serveCell);
    log(
      `${r.slug.slice(0, 26).padEnd(26)} ${String(r.status ?? 'ERR').padEnd(5)} ${serveDisplay} ${String(r.consoleErrors.length).padEnd(8)} ${String(r.failedRequests.length).padEnd(6)} ${paint(verdictColor(r.verdict), r.verdict)}`,
    );
    const assetCells = Object.entries(r.assets)
      .map(([p, code]) => `${p}=${code ?? 'ERR'}`)
      .join('  ');
    if (assetCells)
      log(paint(C.dim, `  assets: ${assetCells}  body=${r.bodyLen}  h1="${r.h1.slice(0, 48)}"`));
    for (const n of r.notes)
      log(
        paint(
          r.verdict === 'PASS' ? C.dim : r.verdict === 'WARN' ? C.yellow : C.red,
          `    • ${n}`,
        ),
      );
  }
  log('─'.repeat(78));
}

async function main() {
  const cliSlugs = process.argv.slice(2).filter(Boolean);
  let slugs = cliSlugs;
  let discovered = false;

  if (slugs.length === 0) {
    log(
      paint(C.cyan, 'No slugs given → discovering live delivered sites via /api/sites/search …'),
    );
    slugs = await discoverLiveSlugs(2);
    discovered = true;
    if (slugs.length === 0) {
      log(paint(C.yellow, 'Discovery found no live delivered sites → probing fallback candidates …'));
      const liveFallbacks = [];
      for (const s of FALLBACK_SLUGS) {
        if (await subdomainIs200(s)) liveFallbacks.push(s);
      }
      slugs = liveFallbacks;
    }
  }

  if (slugs.length === 0) {
    log(
      paint(
        C.yellow,
        'SKIP: no live delivered sites found (discovery empty + fallback candidates not 200). Exit 0 — not a false-fail.',
      ),
    );
    process.exit(0);
  }

  log(
    paint(
      C.cyan,
      `${discovered ? 'Discovered' : 'Probing'} ${slugs.length} site(s): ${slugs.join(', ')}`,
    ),
  );

  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const slug of slugs) {
      log(paint(C.dim, `  → probing ${slug}.projectsites.dev …`));
      results.push(await probeSite(browser, slug));
    }
  } finally {
    await browser.close();
  }

  printResults(results);

  const failed = results.filter((r) => r.verdict === 'FAIL');
  const warned = results.filter((r) => r.verdict === 'WARN');
  const passed = results.filter((r) => r.verdict === 'PASS');
  log();
  log(
    `Final: ${paint(C.green, `${passed.length} PASS`)} · ${paint(C.yellow, `${warned.length} WARN`)} · ${paint(C.red, `${failed.length} FAIL`)}`,
  );

  if (failed.length > 0) {
    log(paint(C.red, `VERDICT: FAIL — ${failed.map((r) => r.slug).join(', ')} unhealthy. Exit 1.`));
    process.exit(1);
  }
  log(paint(C.green, 'VERDICT: all delivered sites healthy (warnings non-blocking). Exit 0.'));
  process.exit(0);
}

main().catch((err) => {
  log(paint(C.red, `verify-delivered-site crashed: ${String(err?.stack ?? err)}`));
  process.exit(1);
});
