#!/usr/bin/env node
/**
 * verify-auth-flow.mjs — COMPLETION § B.7: prove the AUTH mechanics a real prospect
 * walks, end-to-end + headless on prod. Scope is the "render+state" portions B.7 names
 * — the emailed magic-link CLICK (token consumption) is the crown-jewel MANUAL roundtrip
 * (e2e/auth-magic-link-roundtrip.spec.ts: request→peek→verify→session→single-use), which needs
 * the real E2E_PEEK_SECRET + sends real email. THIS probe covers everything short of the click
 * that gates real sign-ins, PLUS the SECURITY of the peek seam itself — it must stay DARK to an
 * unauthorized caller so it never hands out a plaintext magic-link token:
 *
 *   1. magic-link REQUEST   — POST /api/auth/magic-link {email} → 200 + {expires_at}.
 *   2. request VALIDATION   — a malformed email → 400 (Zod boundary), not a 500.
 *   3. verify missing-token — GET  …/verify (no token) → 302 /?error=missing_token (browser-UX, not 4xx JSON).
 *   4. verify bad-token     — GET  …/verify?token=bogus → 302 /?error=invalid_or_expired_link (fail-safe, no 500).
 *   5. Google OAuth INIT    — GET /api/auth/google → 302 to accounts.google.com with client_id +
 *                             our redirect_uri + response_type=code + scope openid/email/profile + a CSRF state.
 *   6. Google callback safe — GET /api/auth/google/callback (no code/state) → 302 (graceful), never 500.
 *   7. me unauthenticated   — GET /api/auth/me with no session → 401 (clean), not 500 / not a false 200.
 *   8. peek seam DARK       — GET …/magic-link/peek WITHOUT (or with a WRONG) E2E_PEEK_SECRET → 404,
 *                             no plaintext token in the body (a broken gate would leak every user's token).
 *
 * Pure-HTTP on prod (public auth endpoints) with the Origin header (omitting it trips
 * Bot Fight). Step 1 sends ONE magic-link email to the e2e identity (a real test login) —
 * gated behind E2E_API_KEY so forks + secret-less CI skip (exit 0) and never send mail.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-auth-flow.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-auth-flow skipped — E2E_API_KEY unset (avoids sending a magic-link email from forks/CI)');
  process.exit(0);
}

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: BASE, Accept: 'application/json' };
const req = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000) });

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  // 1. Magic-link request — the primary passwordless entry point.
  const email = 'e2e@megabyte.space';
  const reqRes = await req('/api/auth/magic-link', { method: 'POST', redirect: 'manual', body: JSON.stringify({ email }) });
  const reqBody = await reqRes.json().catch(() => ({}));
  check('magic-link request → 200 + expires_at', reqRes.status === 200 && !!(reqBody?.data?.expires_at), `status=${reqRes.status} expires=${reqBody?.data?.expires_at ?? 'none'}`);

  // 2. Request validation — malformed email is a clean 400, never a 500.
  const badRes = await req('/api/auth/magic-link', { method: 'POST', redirect: 'manual', body: JSON.stringify({ email: 'not-an-email' }) });
  check('malformed email → 400 (Zod boundary)', badRes.status === 400, `status=${badRes.status}`);

  // 3. Verify with no token → friendly redirect, not a 4xx JSON.
  const noTok = await req('/api/auth/magic-link/verify', { redirect: 'manual' });
  const noTokLoc = noTok.headers.get('location') || '';
  check('verify no-token → 302 ?error=missing_token', noTok.status === 302 && /error=missing_token/.test(noTokLoc), `status=${noTok.status} loc=${noTokLoc.slice(0, 60)}`);

  // 4. Verify with a bogus token → fail-safe redirect, never a 500.
  const badTok = await req(`/api/auth/magic-link/verify?token=bogus-${Date.now()}`, { redirect: 'manual' });
  const badTokLoc = badTok.headers.get('location') || '';
  check('verify bad-token → 302 ?error=invalid_or_expired_link (no 500)', badTok.status === 302 && /error=invalid_or_expired_link/.test(badTokLoc), `status=${badTok.status} loc=${badTokLoc.slice(0, 70)}`);

  // 5. Google OAuth initiation — the whole handshake must be well-formed.
  const g = await req('/api/auth/google', { redirect: 'manual' });
  const gl = g.headers.get('location') || '';
  let gu = null;
  try { gu = new URL(gl); } catch { /* left null */ }
  const scope = gu?.searchParams.get('scope') || '';
  const googleOk =
    g.status === 302 &&
    gu?.host === 'accounts.google.com' &&
    !!gu?.searchParams.get('client_id') &&
    (gu?.searchParams.get('redirect_uri') || '').includes('/api/auth/google/callback') &&
    gu?.searchParams.get('response_type') === 'code' &&
    /openid/.test(scope) && /email/.test(scope) && /profile/.test(scope) &&
    !!gu?.searchParams.get('state');
  check('Google OAuth init → 302 well-formed (client_id + redirect_uri + scope + CSRF state)', googleOk, `status=${g.status} host=${gu?.host ?? '?'} state=${gu?.searchParams.get('state') ? 'set' : 'MISSING'}`);

  // 6. Google callback with no params → graceful redirect, never a 500.
  const cb = await req('/api/auth/google/callback', { redirect: 'manual' });
  check('Google callback (no params) → graceful (no 500)', cb.status >= 300 && cb.status < 500, `status=${cb.status}`);

  // 6b. GitHub OAuth initiation — a PUBLIC auth-start must degrade, never 500. GitHub sign-in
  //     start is currently blocked by the oauth_states provider CHECK (admits only 'github'; the
  //     state INSERT violated it → raw Error → 500). The handler now catches that and 302s to
  //     /signin?auth_error=github_unavailable instead. Assert graceful (3xx/4xx, never 5xx) — holds
  //     now AND once the CHECK is widened to fully enable GitHub (then it 302s to github.com). AL-185.
  const gh = await req('/api/auth/github', { redirect: 'manual' });
  const ghLoc = gh.headers.get('location') || '';
  check('GitHub OAuth init → graceful (no 500)', gh.status >= 300 && gh.status < 500, `status=${gh.status} loc=${ghLoc.slice(0, 60)}`);

  // 7. /api/auth/me with no session → clean 401 (not 500, not a false 200).
  const me = await req('/api/auth/me');
  check('me unauthenticated → 401 (clean)', me.status === 401, `status=${me.status}`);

  // 8. Token-PEEK seam is DARK — the E2E consume roundtrip reads the plaintext magic-link token
  //    through /api/auth/magic-link/peek gated behind E2E_PEEK_SECRET. If that gate ever broke
  //    (secret unset / check dropped) the endpoint would hand out EVERY user's token — a critical
  //    auth leak. Assert 404-dark + NO token/verify-URL in the body for BOTH no-secret AND a wrong
  //    secret (a wrong secret must not even reveal the endpoint exists).
  const leaks = (b) => /(magic-link\/verify\?token=)|("token"\s*:)|("url"\s*:\s*"https)/i.test(b || '');
  const peekNo = await req(`/api/auth/magic-link/peek?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const peekNoBody = await peekNo.text().catch(() => '');
  const peekWrong = await req(`/api/auth/magic-link/peek?email=${encodeURIComponent(email)}&secret=wrong-${Date.now()}`, { redirect: 'manual' });
  const peekWrongBody = await peekWrong.text().catch(() => '');
  check(
    'magic-link peek seam DARK (no token leak w/o or w/ wrong secret)',
    peekNo.status === 404 && peekWrong.status === 404 && !leaks(peekNoBody) && !leaks(peekWrongBody),
    `no-secret=${peekNo.status} wrong-secret=${peekWrong.status} leak=${leaks(peekNoBody) || leaks(peekWrongBody)}`,
  );

  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(64)} ${r.detail}`);
  const ok = fails === 0;
  console.log(
    `\nVERDICT: ${ok ? '✅ PASS' : '🔴 CHECK'} — auth flow (magic-link request + verify fail-safe + Google OAuth init + peek-seam darkness) ${ok ? 'is sound on prod' : 'has a break'} [full emailed-click consume = the manual crown-jewel roundtrip spec]`,
  );
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
