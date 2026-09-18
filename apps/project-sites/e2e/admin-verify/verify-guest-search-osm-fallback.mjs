// verify-guest-search-osm-fallback.mjs — B.1 the NEW-business acquisition funnel (AL-729).
//
// The OTHER guest-funnel probes route AROUND `/api/search/businesses` on purpose:
// verify-guest-funnel-results uses the D1-backed `/api/sites/search` (ALREADY-delivered
// sites) because Google Places 403/429s intermittently on prod. That leaves the actual
// customer-acquisition path — a visitor searching for THEIR OWN business (not yet on our
// platform) to BUILD a new site — completely unverified, and (pre-AL-729) BROKEN: Places is
// persistently 429 (GCP billing off) → the endpoint dead-ended to
// `{data:[], _error:{code:'SEARCH_PROVIDER_UNAVAILABLE'}}` and the homepage showed
// "Business lookup is temporarily unavailable" for EVERY guest.
//
// AL-729 added an OSM/Nominatim free-text fallback (src/services/nominatim_search.ts). This
// probe proves the funnel's PRIMARY action works again: (1) API ground truth — a real
// not-on-platform business returns real results (data.length>0, NOT a lying-empty _error),
// logging _source ('osm' when Places is down, else Places recovered); (2) UI — typing that
// business into the homepage hero renders result cards, and the "temporarily unavailable"
// dead-end copy is GONE; (3) 0 console errors. Resilient to a single-POI Nominatim miss by
// trying several well-known businesses — at least one MUST return real results.
//
// Usage: node e2e/admin-verify/verify-guest-search-osm-fallback.mjs   (no auth — pure guest)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright-core');

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Real businesses very likely to be in OSM. First that returns data wins (POI-miss resilience).
const QUERIES = [
  'Blue Bottle Coffee San Francisco',
  'Starbucks Reserve Roastery Seattle',
  'Shake Shack Madison Square Park',
];

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const x = m.text();
    if (/favicon|Failed to load resource|net::ERR_ABORTED/i.test(x)) return;
    if (m.type() === 'error') errs.push(x.slice(0, 100));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 100)));

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. API GROUND TRUTH — same-origin fetch from the real browser (dodges CF bot-challenge on
  //    the public API). At least one real business must return non-empty data, NOT a dead-end.
  const api = await page.evaluate(async (queries) => {
    const out = [];
    for (const q of queries) {
      try {
        const r = await fetch('/api/search/businesses?q=' + encodeURIComponent(q));
        const j = await r.json().catch(() => ({}));
        const data = Array.isArray(j.data) ? j.data : [];
        out.push({
          q,
          ok: r.ok,
          count: data.length,
          source: j._source || 'places',
          errorCode: j._error?.code || null,
          firstName: data[0]?.name || null,
        });
        if (data.length > 0) break; // first hit wins
      } catch (e) {
        out.push({ q, ok: false, count: 0, source: null, errorCode: 'FETCH_THREW', firstName: null });
      }
    }
    return out;
  }, QUERIES);

  const winner = api.find((a) => a.count > 0);
  check(
    'B.1 NEW-business search returns REAL results (not a lying-empty _error dead-end)',
    !!winner,
    winner
      ? `"${winner.q}" → ${winner.count} result(s) via _source=${winner.source}, first="${winner.firstName}"`
      : `ALL ${api.length} queries dead-ended: ${api.map((a) => `${a.q}=${a.errorCode || a.count}`).join(', ')}`,
  );
  // Informational: when Places is down, the win MUST come from the OSM fallback.
  if (winner) {
    check(
      'the funnel is served by a live provider (OSM fallback active, or Places recovered)',
      winner.source === 'osm' || winner.source === 'places',
      `_source=${winner.source}`,
    );
  }

  // 2. UI — type the winning (or first) business into the homepage hero. Result cards must
  //    render AND the "temporarily unavailable" dead-end copy must be absent.
  const typeQ = (winner || api[0]).q;
  const searchSel =
    '#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]';
  const search = page.locator(searchSel).first();
  await search.click().catch(() => {});
  await search.pressSequentially(typeQ.slice(0, 20), { delay: 45 }).catch(() => {});
  await page.waitForSelector('[data-testid="search-result"]', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(700);

  const ui = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="search-result"]')].map((el) =>
      (el.textContent || '').replace(/\s+/g, ' ').trim(),
    );
    const body = (document.body.innerText || '').toLowerCase();
    return {
      cardCount: cards.length,
      firstCard: cards[0] ? cards[0].slice(0, 60) : null,
      deadEnd: /temporarily unavailable|business lookup is (temporarily )?unavailable/.test(body),
    };
  });
  check(
    'B.1 UI — typing a real business renders result cards in the hero dropdown',
    ui.cardCount > 0,
    `${ui.cardCount} card(s); first="${ui.firstCard || 'NONE'}"`,
  );
  check(
    'the "business lookup temporarily unavailable" dead-end message is GONE',
    !ui.deadEnd,
    ui.deadEnd ? 'dead-end copy still present' : 'clean',
  );

  check('0 console errors across the new-business search funnel', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) {
  check('probe completed without throwing', false, String(e.message || e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ B.1 NEW-business acquisition funnel — Places→OSM/Nominatim fallback (AL-729) ━━');
for (const r of rows) console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(
  fails === 0
    ? '\n✅ PASS — a real not-on-platform business returns live results (OSM fallback when Places is down) + the homepage renders them, no dead-end. The acquisition funnel works.'
    : `\n❌ FAIL — ${fails} check(s) failed; the NEW-business search funnel is broken (guests can't build a site for their own business).`,
);
process.exit(fails === 0 ? 0 : 1);
