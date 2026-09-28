/** Public render-verify for /pricing (no auth). Browserbase, CF-clean. One-shot. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BB = process.env.BROWSERBASE_API_KEY, PROJ = process.env.BROWSERBASE_PROJECT_ID;
if (!BB || !PROJ) { console.log('MISSING BB'); process.exit(2); }
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
  await page.goto('https://projectsites.dev/pricing', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000); // CF challenge + hydrate
  out.probe = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const root = document.getElementById('root') || document.querySelector('app-root') || document.body;
    const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return JSON.parse(s.textContent)['@type']; } catch { return '?'; } });
    const bodyTxt = document.body.innerText || '';
    return {
      title: document.title,
      h1Count: document.querySelectorAll('h1').length,
      h1: h1 ? h1.innerText.slice(0, 80) : null,
      mainLen: root ? root.innerText.length : 0,
      has50: /\$50/.test(bodyTxt),
      hasExactCost: /exact/i.test(bodyTxt),
      mentionsCompetitor: /(vercel|netlify|squarespace|webflow|wix)/i.test(bodyTxt),
      jsonldTypes: jsonld,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
  await page.screenshot({ path: '/tmp/psvis/pricing-full.png', fullPage: true });
} finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2));
