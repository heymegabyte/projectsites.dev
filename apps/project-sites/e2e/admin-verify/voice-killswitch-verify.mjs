/** Authed prod-verify for B0 voice_numbers killswitch. Browserbase, CF-clean. One-shot.
 * With the flag OFF, an AUTHED purchase attempt must 404 (feature dark) — NO Twilio buy. */
import { chromium } from '@playwright/test';
const BB = process.env.BROWSERBASE_API_KEY, PROJ = process.env.BROWSERBASE_PROJECT_ID, PW = process.env.E2E_TEST_PASSWORD;
if (!BB || !PROJ || !PW) { console.log('MISSING env'); process.exit(2); }
const r = await fetch('https://api.browserbase.com/v1/sessions', { method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PROJ, timeout: 600 }) });
if (!r.ok) { console.log('session fail', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const out = {};
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({})); return j?.data?.token ?? '';
  }, PW);
  out.gotToken = !!token;
  // Authed purchase attempt — flag OFF must 404 (killswitch), NEVER 200/proceed.
  out.purchase = await page.evaluate(async (tok) => {
    const res = await fetch('/api/voice/numbers/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ phoneNumber: '+15005550006', areaCode: '500' }) });
    let body = ''; try { body = (await res.text()).slice(0, 120); } catch {}
    return { status: res.status, body };
  }, token);
  // A0: call-token response shape — token must be at data.token
  out.callToken = await page.evaluate(async (tok) => {
    const res = await fetch('/api/voice/test/call-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({}) });
    let j = {}; try { j = await res.json(); } catch {}
    return { status: res.status, hasDataToken: !!(j?.data?.token), topLevelToken: !!j?.token };
  }, token);
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2));
