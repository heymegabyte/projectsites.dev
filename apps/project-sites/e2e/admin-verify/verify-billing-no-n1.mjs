/**
 * verify-billing-no-n1.mjs — causal proof the /admin/billing credit-cap N+1 is dead.
 *
 * Before AL-537 the billing page fired one `GET /api/sites/:id/credit-cap` per site
 * (~110 sequential requests / ~9s load). AL-537 replaced that with a single batch
 * `GET /api/credit-caps`. This probe seeds a real admin session, loads /admin/billing
 * in a real browser, captures every /api/* request, and asserts:
 *   - exactly ONE  GET /api/credit-caps   (the batch route fires)
 *   - ZERO         GET /api/sites/:id/credit-cap on load  (the N+1 is gone)
 *
 * Run: NODE_PATH="$PWD/frontend/node_modules" \
 *        E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-billing-no-n1.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.error('E2E_API_KEY missing (get-secret E2E_API_KEY)');
  process.exit(2);
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });
await ctx.addInitScript(
  ([token]) => {
    try {
      localStorage.setItem(
        'ps_session',
        JSON.stringify({ token, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }),
      );
    } catch {
      /* opaque origin */
    }
  },
  [KEY],
);

const page = await ctx.newPage();
const batchHits = [];
const perSiteHits = [];
page.on('request', (req) => {
  const u = req.url();
  if (/\/api\/credit-caps(\?|$)/.test(u)) batchHits.push(u);
  if (/\/api\/sites\/[^/]+\/credit-cap(\?|$)/.test(u)) perSiteHits.push(u);
});

await page.goto(`${BASE}/admin/billing`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000); // give any lingering N+1 waterfall time to fire

await browser.close();

const pass = batchHits.length === 1 && perSiteHits.length === 0;
console.log(
  JSON.stringify(
    {
      base: BASE,
      batch_credit_caps_requests: batchHits.length,
      per_site_credit_cap_requests: perSiteHits.length,
      verdict: pass ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ),
);
if (!pass) {
  if (perSiteHits.length) console.error(`N+1 STILL PRESENT: ${perSiteHits.length} per-site GETs`);
  if (batchHits.length !== 1) console.error(`expected 1 batch request, got ${batchHits.length}`);
  process.exit(1);
}
console.log('✅ N+1 gone: exactly 1 batch /api/credit-caps, 0 per-site /credit-cap on load');
