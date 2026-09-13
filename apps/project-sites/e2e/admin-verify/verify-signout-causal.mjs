#!/usr/bin/env node
/**
 * verify-signout-causal.mjs — B.7 (deeper): does SIGN-OUT actually REVOKE the session token
 * server-side, or only clear it client-side (leaving a copied Bearer token replayable)?
 *
 * The auth probes cover sign-IN + the route-guard-when-signed-OUT, but NOTHING asserted that the
 * sign-out ACTION kills the token on the server. The client `signOut()` clears the local
 * `ps_session` (route guards key off it → the browser is logged out) AND fires a POST to
 * `/api/auth/sign-out` — but that is a Better-Auth path, and BA is DARK on prod. If that POST 404s
 * (fire-and-forget, swallowed), the D1 Bearer session is NEVER revoked → a token copied before
 * "sign out" still authenticates. This probe proves the truth causally.
 *
 * Causal chain (real SESSION token via Browserbase test-login — NOT the persistent E2E API key):
 *   1. test-login brian → a real session token.
 *   2. GET /api/auth/me (Bearer) → MUST be 200 + a user (authed).
 *   3. POST /api/auth/sign-out (Bearer)  [+ POST /api/auth/revoke-other-sessions as the known-good rail]
 *   4. GET /api/auth/me (SAME Bearer) → MUST be 401 (session revoked server-side).
 * If step 4 is still 200, sign-out did NOT revoke the token → a replay-risk gap to fix at root.
 *
 * Creds (get-secret): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, E2E_TEST_PASSWORD. Skips (exit 0)
 * if unset. Non-destructive: it only signs out a throwaway just-minted test-login session.
 */
import { chromium } from '@playwright/test';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';
const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) { console.log('::notice:: verify-signout-causal skipped — creds unset'); process.exit(0); }

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('::error:: BB session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let exitCode = 0;
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
    const j = await res.json().catch(() => ({}));
    return j?.data?.token ?? '';
  }, PW);
  if (!token) { console.log('::error:: test-login returned no token'); process.exit(4); }

  const call = (method, path) => page.evaluate(async ({ method, path, token }) => {
    const res = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, hasUser: !!(j?.data?.user || j?.user || j?.data?.email || j?.email) };
  }, { method, path, token });

  const me1 = await call('GET', '/api/auth/me');
  const signout = await call('POST', '/api/auth/sign-out');
  // The KNOWN-GOOD revocation rail the FE *should* use — revokes every session but the caller's,
  // so combined with a real /sign-out it proves the D1 rail works even if the BA path is dark.
  const revokeOthers = await call('POST', '/api/auth/revoke-other-sessions');
  await sleep(1500);
  const me2 = await call('GET', '/api/auth/me');

  const out = { me1, signout, revokeOthers, me2 };
  const revoked = me1.status === 200 && me1.hasUser && me2.status === 401;
  console.log('\n=== SIGN-OUT server-revocation CAUSAL ===\n' + JSON.stringify(out, null, 2));
  console.log(
    `\nVERDICT: ${revoked ? '✅ PASS' : '🔴 CHECK'} — me(before)=${me1.status}/user:${me1.hasUser} · sign-out=${signout.status} · me(after)=${me2.status} ` +
      `${revoked ? '(token REVOKED server-side)' : '(token NOT revoked — a copied Bearer survives sign-out: replay-risk gap)'}`,
  );
  exitCode = revoked ? 0 : 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
