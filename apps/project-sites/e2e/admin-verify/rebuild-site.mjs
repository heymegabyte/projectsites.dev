// rebuild-site.mjs — re-trigger the site-gen workflow for an already-delivered site so a landed
// ROOT fix (template / hero_copy / theme_style) proves itself on a FRESH build, per
// `report-mode-probe-deployed-defect-is-often-stale-build-debt` ("check a FRESH build → promote the
// probe"). Browserbase (CF-clean) → test-login as brian (org-brian-001 owns the delivered fleet) →
// POST /api/sites/:id/reset. Prints REBUILD_RESULT JSON; poll D1 for `published` separately.
//
// Usage: REBUILD_SITE_ID=<uuid> node e2e/admin-verify/rebuild-site.mjs
import { chromium } from 'playwright';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

const SITE_ID = process.env.REBUILD_SITE_ID || '';
if (!SITE_ID) {
  console.log('::error:: set REBUILD_SITE_ID');
  process.exit(2);
}
const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) {
  console.log('::error:: missing Browserbase/E2E creds');
  process.exit(2);
}

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST',
  headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) {
  console.log('::error:: BB session create failed', r.status);
  process.exit(3);
}
const { id } = await r.json();
const browser = await chromium.connectOverCDP(
  `wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`,
);
try {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.data?.token ?? '';
  }, PW);
  if (!token) {
    console.log('::error:: test-login returned no token');
    process.exit(4);
  }
  console.log('✓ authed as brian (org-brian-001)');

  const out = await page.evaluate(
    async ({ tok, sid }) => {
      const res = await fetch(`/api/sites/${sid}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await res.json().catch(() => ({}));
      return { status: res.status, body: j };
    },
    { tok: token, sid: SITE_ID },
  );
  console.log(
    'REBUILD_RESULT ' +
      JSON.stringify({ siteId: SITE_ID, http: out.status, status: out.body?.data?.status ?? out.body?.status ?? null }),
  );
  process.exit(out.status >= 200 && out.status < 300 ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
} finally {
  await browser.close();
}
