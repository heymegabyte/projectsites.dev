// verify-dashboard-status-rollup-causal.mjs — the dashboard's headline
// "Live" / "Needs attention" status rollup MUST equal the store (display==store).
//
// The dashboard Site-status strip is the FIRST thing an owner sees, and its counts
// are NOT a raw status GROUP BY — the client reclassifies a `published` site with
// NO `current_build_version` as "Needs attention" (it serves a branded 503, not
// truly live; dashboard.component.ts:1207). `reconcile-surfaces.mjs` checks the
// sites LIST count, never this classification — so a regression in the rollup logic
// (or a lying "N Live" over sites that actually 503) would ship unseen. This probe
// closes that gap: it derives the EXPECTED rollup from `/api/sites` (the dashboard's
// own data source, itself reconciled to D1 by reconcile-surfaces) using the exact
// display predicate, then reads the RENDERED tile counts from their stable
// `aria-label` (immune to the rolling-counter animation) and asserts equality.
//
//   Live            = status==='published' AND current_build_version present
//   Needs attention = status==='error'  OR  (published AND no current_build_version)
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0.
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-dashboard-status-rollup-causal.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: dashboard-status-rollup skipped — E2E_API_KEY unset');
  process.exit(0);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(
  (k) =>
    localStorage.setItem(
      'ps_session',
      JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }),
    ),
  KEY,
);

// GROUND TRUTH — fetch the dashboard's own data source AS the authed user.
const store = await page.evaluate(async (origin) => {
  const r = await fetch(`${origin}/api/sites`, {
    headers: { Authorization: `Bearer ${JSON.parse(localStorage.getItem('ps_session')).token}` },
  });
  if (!r.ok) return { error: r.status };
  const j = await r.json();
  const sites = j.sites || j.data || (Array.isArray(j) ? j : []);
  let live = 0;
  let needs = 0;
  for (const s of sites) {
    const published = s.status === 'published';
    const hasBuild = !!s.current_build_version;
    if (published && hasBuild) live++;
    else if (s.status === 'error' || (published && !hasBuild)) needs++;
  }
  return { total: sites.length, live, needs };
}, ORIGIN);

// DISPLAY — read rendered tile counts from the stable aria-label ("104 Live — …").
await page.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const tiles = await page.$$eval('.status-tile', (els) =>
  els.map((el) => el.getAttribute('aria-label') || ''),
);
const readTile = (label) => {
  const t = tiles.find((a) => new RegExp(`\\b${label}\\b`, 'i').test(a));
  if (!t) return 0;
  const m = t.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};
const shownLive = readTile('Live');
const shownNeeds = readTile('Needs attention');

await browser.close();

if (store.error) {
  console.log(`❌ FAIL — /api/sites returned ${store.error}`);
  process.exit(1);
}

const liveOk = shownLive === store.live;
const needsOk = shownNeeds === store.needs;
console.log('=== DASHBOARD STATUS-ROLLUP RECONCILE (display vs store, exact predicate) ===\n');
console.log(`  store /api/sites: total=${store.total}  live=${store.live}  needs-attention=${store.needs}`);
console.log(`  dashboard tiles : live=${shownLive}  needs-attention=${shownNeeds}`);
console.log(`  ${liveOk ? '✅' : '❌'} Live         ${shownLive} ${liveOk ? '==' : '!='} ${store.live}`);
console.log(`  ${needsOk ? '✅' : '❌'} Needs attn   ${shownNeeds} ${needsOk ? '==' : '!='} ${store.needs}`);
const ok = liveOk && needsOk;
console.log(
  ok
    ? `\nVERDICT: ✅ PASS — dashboard status rollup equals the store (no lying count).`
    : `\nVERDICT: ❌ FAIL — dashboard status rollup DIVERGES from the store (lying-count).`,
);
process.exit(ok ? 0 : 1);
