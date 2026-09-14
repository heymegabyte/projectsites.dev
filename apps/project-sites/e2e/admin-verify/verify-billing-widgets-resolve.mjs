/**
 * verify-billing-widgets-resolve.mjs — truthful-render guard for the two LAZY widgets on
 * the /admin/billing Subscription tab: <app-usage-gauges/> + <app-credits-widget/>.
 *
 * Both mount AFTER the billing route settles and fetch their own `/api/*` data, showing a
 * height-reserving SKELETON meanwhile. A skeleton that never resolves is a lying-loading
 * render failure (looks like content is coming; it never arrives) — invisible to console /
 * axe / reconcile gates (no error thrown, no wrong count, just an eternal shimmer). This
 * probe seeds a real admin session, loads /admin/billing in real Chromium, waits for the
 * network to settle, and asserts each widget reached its RESOLVED testid (not its skeleton),
 * with the backing endpoint 200. Root-cause context: the admin-vision-shots capture tool
 * used to snapshot these mid-flight and produce false "stuck skeleton" findings every
 * admin-integrity fire — that tool now waits for settle; this probe locks the product side.
 *
 * PASS = usage-gauges + credit-wallet both resolved, zero skeletons persist, endpoints 200.
 *
 * Run: NODE_PATH="$PWD/frontend/node_modules" \
 *        E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-billing-widgets-resolve.mjs
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
const ctx = await browser.newContext({ userAgent: UA, serviceWorkers: 'block' });
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
const status = {}; // endpoint → last HTTP status
page.on('response', (r) => {
  const u = r.url().replace(BASE, '');
  if (/\/api\/usage(\?|$)/.test(u)) status.usage = r.status();
  if (/\/api\/credits\/balance(\?|$)/.test(u)) status.creditsBalance = r.status();
});

// domcontentloaded (NOT networkidle): the admin shell's 30s/60s pollers + the bolt-iframe
// WebContainer pre-boot stream mean the network never goes fully idle.
await page.goto(`${BASE}/admin/billing`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); // bounded best-effort
// Let the two lazy widgets' fetches land + their skeletons swap to content. Bounded — a
// skeleton surviving this window is a REAL stuck state and MUST fail the probe.
await page
  .waitForFunction(
    () => !document.querySelector('.skeleton, [data-testid$="-skeleton"], [aria-busy="true"]'),
    undefined,
    { timeout: 10000, polling: 200 },
  )
  .catch(() => {});
await page.waitForTimeout(500);

const dom = await page.evaluate(() => {
  const q = (s) => !!document.querySelector(s);
  const txt = (s) => document.querySelector(s)?.textContent?.trim() || null;
  return {
    usageResolved: q('[data-testid="usage-gauges"]'),
    usageSkeleton: q('[data-testid="usage-gauges-skeleton"]'),
    usageSitesBar: q('[data-testid="usage-bar-sites"]'),
    creditsResolved: q('[data-testid="credits-widget"]'),
    creditsSkeleton: q('[data-testid="credits-skeleton"]'),
    creditsBalance: txt('[data-testid="credits-balance"]'),
    anySkeletonLeft: q('.skeleton, [data-testid$="-skeleton"], [aria-busy="true"]'),
  };
});

await browser.close();

const checks = {
  usageEndpoint200: status.usage === 200,
  creditsEndpoint200: status.creditsBalance === 200,
  usageResolvedNotSkeleton: dom.usageResolved && !dom.usageSkeleton,
  creditsResolvedNotSkeleton: dom.creditsResolved && !dom.creditsSkeleton,
  noSkeletonPersists: !dom.anySkeletonLeft,
};
const pass = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify({ base: BASE, status, dom, checks, verdict: pass ? '✅ PASS' : '❌ FAIL' }, null, 2),
);
console.log(
  pass
    ? '✅ PASS — billing lazy widgets (usage-gauges + credit-wallet) resolve to real content; no stuck skeleton'
    : '❌ FAIL — a billing lazy widget is stuck on its skeleton or its endpoint is not 200 (lying-loading)',
);
process.exit(pass ? 0 : 1);
