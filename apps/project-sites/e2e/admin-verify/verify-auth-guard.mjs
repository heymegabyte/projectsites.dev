// verify-auth-guard.mjs — § B.7 AUTH (the unauth ROUTE-GUARD boundary the API-level auth probe
// doesn't cover). Every /admin route is behind a client route-guard that MUST bounce a signed-out
// visitor to /signin (preserving returnUrl) and render NONE of the admin chrome. Both the admin
// surf-audit and verify-auth-flow operate AUTHED (seeded ps_session / API-level) — so the UNAUTH
// case (a regression that fails the guard open → the admin shell + nav leak to signed-out users)
// had zero headless coverage. This drives each protected route with NO ps_session in a real browser
// and asserts the guard: lands on /signin, returnUrl round-trips (so post-sign-in returns them where
// they meant to go), the sign-in UI renders, and no admin chrome is exposed.
//
// Real Chromium; NO E2E_API_KEY needed (this is the signed-OUT boundary by design). Usage:
//   node e2e/admin-verify/verify-auth-guard.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// A representative spread of protected routes (shell + data + billing + editor host).
const PROTECTED = ['/admin', '/admin/billing', '/admin/team', '/admin/analytics', '/admin/editor'];

const browser = await chromium.launch();
const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  for (const route of PROTECTED) {
    // Fresh context per route → guaranteed NO ps_session (a real signed-out prospect).
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // CONDITION-BASED wait (not a fixed sleep): the client route-guard bounces an unauth visitor to
      // /signin via the Angular Router. Await the redirect itself — it resolves the instant the guard
      // lands, tolerating a slow bundle-parse / GC pause, so a slow-but-CORRECT guard is never
      // mis-flagged as a leak. (The old fixed 2.5s sleep raced → intermittent FALSE "leak" RED on a
      // security probe.) A genuine fail-OPEN guard never navigates → this times out → onSignin=false
      // → correctly flagged below. (error-recovery § condition-based-waiting + validator-precision-discipline.)
      await page.waitForURL(/\/signin(?:[/?#]|$)/, { timeout: 15000 }).catch(() => {});
      // Let the /signin component paint before the UI-text assertion (still condition-based, not a sleep).
      await page
        .waitForFunction(
          () => /sign.?in|magic link|continue with google|email me a magic link/i.test(document.body.innerText || ''),
          { timeout: 6000 },
        )
        .catch(() => {});
      const url = new URL(page.url());
      const onSignin = url.pathname.startsWith('/signin');
      // returnUrl must round-trip the ORIGINAL route (so post-sign-in lands them back there).
      const rt = url.searchParams.get('returnUrl') || '';
      const returnUrlOk = decodeURIComponent(rt) === route;
      const { signinUI, adminChrome } = await page.evaluate(() => ({
        signinUI: /sign.?in|magic link|continue with google|email me a magic link/i.test(document.body.innerText || ''),
        // Admin chrome that MUST NOT render for a signed-out user (site switcher / admin nav links).
        adminChrome: !!document.querySelector('[aria-label="Select site"], nav[aria-label="Primary"] a[href*="/admin/"]'),
      }));
      check(
        `${route} (unauth) → bounced to /signin, returnUrl preserved, no admin chrome leaked`,
        onSignin && returnUrlOk && signinUI && !adminChrome,
        `landed=${url.pathname}${url.search} signinUI=${signinUI} adminChrome=${adminChrome} returnUrlOk=${returnUrlOk}`,
      );
    } catch (e) {
      check(`${route} (unauth) guard`, false, `ERROR ${String(e).slice(0, 70)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log('\n━━ § B.7 · unauth route-guard — signed-out visitors are bounced off every /admin route ━━');
rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}  ${r.detail}`));
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — every protected route bounces a signed-out visitor to /signin (returnUrl preserved), no admin chrome leaked.`
    : `\nVERDICT: 🔴 ${fails} route(s) failed the unauth guard — the admin boundary leaks to signed-out users (auth regression). Fix at the route-guard root.`,
);
process.exit(fails === 0 ? 0 : 1);
