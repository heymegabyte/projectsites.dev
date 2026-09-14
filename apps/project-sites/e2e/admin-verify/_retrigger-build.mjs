// _retrigger-build.mjs — re-run a site's AI build after a TRANSIENT container-DO eviction
// (workflow.container_evicted_restart → build_error). Browserbase-authed as brian, POSTs the
// site's rebuild endpoint. SITE_ID env = the site to rebuild. Prints RETRIGGER_RESULT JSON.
import { chromium } from 'playwright';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

const SITE_ID = process.env.SITE_ID || '';
if (!SITE_ID) { console.log('::error:: set SITE_ID'); process.exit(2); }
const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) { console.log('::error:: missing Browserbase/E2E creds'); process.exit(2); }

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('::error:: BB session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
    });
    return (await res.json().catch(() => ({})))?.data?.token ?? '';
  }, PW);
  if (!token) { console.log('::error:: test-login returned no token'); process.exit(4); }
  const out = await page.evaluate(async ({ tok, siteId }) => {
    const res = await fetch(`/api/sites/${siteId}/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({}),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: JSON.stringify(j).slice(0, 300) };
  }, { tok: token, siteId: SITE_ID });
  console.log(`RETRIGGER_RESULT ${JSON.stringify(out)}`);
} finally {
  await browser.close();
}
