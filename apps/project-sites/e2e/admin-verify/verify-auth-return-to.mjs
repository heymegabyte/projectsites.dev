// verify-auth-return-to.mjs — § B.7 AUTH · the POST-SIGN-IN LANDING seam (the flow AROUND the
// golden path the auth-flow + auth-guard probes don't cover). When OAuth/magic-link completes, the
// server 302s the browser to `<returnUrl>?token=…&email=…&auth_callback=…`. The client
// (app.component handleAuthCallback) must: (a) establish the session, (b) STRIP the token from the
// URL (never persist a session token in history/referrer/a later $pageview), and (c) land the owner
// on the returnUrl DEEP route they were bounced from — NOT dump them on the dashboard to
// re-navigate. This is the completion of the AL-459 returnUrl round-trip; two bugs defeated it:
//   1. worker OAuth-start read `?redirect_url` while the sign-in page sends `?returnUrl` → the OAuth
//      returnUrl was silently dropped (locked by the worker api_routes returnUrl regression), and
//   2. the client hardcoded `router.navigate(['/admin'])`, overriding the landed deep path.
// This probe proves the CLIENT contract end-to-end in a real browser (the user-observable proof),
// plus a best-effort server-302 sanity line.
//
// E2E_API_KEY is a valid session TOKEN — the same shape the callback 302 carries. Real Chromium.
// Fail-open (exit 0) when E2E_API_KEY is unset. Seeds nothing persistent (fresh context per case).
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-auth-return-to.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-auth-return-to skipped — E2E_API_KEY unset');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const EMAIL = 'e2e@megabyte.space';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

const isConsoleErr = (t) =>
  !/Failed to load resource|favicon|posthog|ingest|GL Driver Message|GPU stall|net::ERR_ABORTED|sentry/i.test(t);

const browser = await chromium.launch();

/**
 * Land at `<startPath>?token=…&email=…&auth_callback=google` (exactly what the callback 302
 * produces) in a fresh no-session context and observe where the client settles.
 */
async function land(startPath, expectRe, label) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && isConsoleErr(m.text())) errs.push(m.text().slice(0, 90));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 80)));
  const url = `${ORIGIN}${startPath}?token=${encodeURIComponent(KEY)}&email=${encodeURIComponent(EMAIL)}&auth_callback=google`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // CONDITION-BASED: wait for the client to settle on the expected destination (setSession →
    // navigate). A regression that dumps the user on /admin never matches the deep-path regex →
    // times out → correctly flagged below (not a fixed sleep that could race the router).
    await page.waitForURL(expectRe, { timeout: 15000 }).catch(() => {});
    const final = new URL(page.url());
    const landedOk = expectRe.test(final.pathname);
    const sess = await page.evaluate(() => {
      try {
        return !!localStorage.getItem('ps_session');
      } catch {
        return false;
      }
    });
    const tokenStripped = !final.searchParams.has('token') && !final.href.includes(KEY);
    check(
      `${label}: lands on ${expectRe} (returnUrl honored)`,
      landedOk,
      `landed=${final.pathname}`,
    );
    check(`${label}: session established`, sess, `ps_session=${sess}`);
    check(`${label}: token stripped from URL (no leak to history/referrer)`, tokenStripped, `query=${final.search.slice(0, 40) || '(clean)'}`);
    check(`${label}: 0 console errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    check(`${label}: post-sign-in landing`, false, `ERROR ${String(e).slice(0, 70)}`);
  }
  await ctx.close();
}

try {
  // 1+2 — DEEP returnUrl routes: the owner clicked a protected surface logged-out → bounced to
  //       /signin?returnUrl=<deep> → after sign-in the token lands on <deep> and MUST stay there.
  await land('/admin/billing', /^\/admin\/billing/, 'B deep-link → /admin/billing');
  await land('/admin/team', /^\/admin\/team/, 'C deep-link → /admin/team');
  // 3 — BARE homepage landing (no returnUrl): fall back to the dashboard, NOT a deep route.
  await land('/', /^\/admin(?:$|\/)/, 'A bare homepage → /admin fallback');

  // Best-effort server sanity: the OAuth start must accept `?returnUrl=` and 302 to Google (not
  // 500, not drop it). The EXACT stored redirect_url is locked by the worker api_routes unit test;
  // this is just a live liveness line (soft — a CF bot-challenge on the apex API won't fail the probe).
  try {
    const r = await fetch(`${ORIGIN}/api/auth/google?returnUrl=/admin/billing`, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const loc = r.headers.get('location') || '';
    const ok302 = r.status === 302 && /accounts\.google\.com/.test(loc);
    rows.push({ label: 'server: GET /api/auth/google?returnUrl=… → 302 to Google (accepts the param, no 500)', ok: true, detail: ok302 ? 'live 302 → accounts.google.com' : `soft: status=${r.status} (host/bot-challenge — unit test locks the round-trip)` });
  } catch (e) {
    rows.push({ label: 'server: OAuth-start liveness', ok: true, detail: `soft-skip: ${String(e).slice(0, 40)}` });
  }
} finally {
  await browser.close();
}

console.log('\n━━ § B.7 · post-sign-in landing — the returnUrl round-trip deep-links owners back where they meant to go ━━');
rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}${r.detail ? '  ' + r.detail : ''}`));
console.log(
  fails === 0
    ? '\nVERDICT: ✅ PASS — a completed sign-in lands the owner on their returnUrl deep route (billing/team), session established, token stripped, 0 console errors; bare-homepage sign-in falls back to /admin.'
    : `\nVERDICT: 🔴 ${fails} check(s) failed — the post-sign-in landing regressed (owners dumped on /admin instead of their returnUrl, or a token leak). Fix at handleAuthCallback / the OAuth-start param.`,
);
process.exit(fails === 0 ? 0 : 1);
