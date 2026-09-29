/** Authed prod-verify for /admin/hosting (WfP Unit 6). Browserbase, CF-clean. One-shot. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BB = process.env.BROWSERBASE_API_KEY, PROJ = process.env.BROWSERBASE_PROJECT_ID, PW = process.env.E2E_TEST_PASSWORD;
if (!BB || !PROJ || !PW) { console.log('MISSING env'); process.exit(2); }
mkdirSync('/tmp/psvis', { recursive: true });
const r = await fetch('https://api.browserbase.com/v1/sessions', { method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PROJ, timeout: 600 }) });
if (!r.ok) { console.log('session fail', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const out = { consoleErrors: [] };
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => out.consoleErrors.push('[pageerror] ' + (e.message || String(e)).slice(0, 140)));
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  out.login = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({}));
    const d = j?.data; if (d?.token) { try { localStorage.setItem('ps_session', JSON.stringify({ token: d.token, identifier: d.email ?? 'brian@megabyte.space', issuedAt: Date.now() })); } catch {} }
    return { status: res.status, ok: !!d?.token };
  }, PW);
  await page.evaluate(async () => { try { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((x) => x.unregister())); } if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } } catch {} });
  await page.goto('https://projectsites.dev/admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // Nav entry present?
  out.navHasHosting = await page.evaluate(() => /hosting/i.test(document.querySelector('nav, aside, [class*="nav"]')?.innerText || document.body.innerText));
  await page.goto('https://projectsites.dev/admin/hosting', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  out.probe = await page.evaluate(() => {
    const root = document.querySelector('app-root') || document.body;
    const h1 = document.querySelector('h1');
    const txt = document.body.innerText || '';
    return {
      h1Count: document.querySelectorAll('h1').length,
      h1: h1 ? h1.innerText.slice(0, 80) : null,
      mainLen: root ? root.innerText.length : 0,
      mentionsHosting: /hosting/i.test(txt),
      mentionsStatusOrPreview: /(status|preview|production|publish|promote)/i.test(txt),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      onGuestHome: /Find your business|Sign in to/i.test(txt) && !/hosting/i.test(txt),
    };
  });
  await page.screenshot({ path: '/tmp/psvis/hosting.png', fullPage: true });
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2));
