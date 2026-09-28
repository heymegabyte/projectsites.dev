/**
 * Targeted PROD verify for /admin/apps/payload (Turn-5 work):
 *  1. aside.deploy-aside is TRANSPARENT (computed bg rgba(0,0,0,0) + backdrop none)
 *  2. layout: carousel .shot height <= 380, no orphaned "PROVISIONING" label
 *  3. instances ⋮ menu OPENS at the button, shows 4 items, Escape closes
 * Real brian@megabyte.space account via Browserbase (CF-clean). One-shot, self-cleaning.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BB = process.env.BROWSERBASE_API_KEY;
const PROJ = process.env.BROWSERBASE_PROJECT_ID;
const PW = process.env.E2E_TEST_PASSWORD;
if (!BB || !PROJ || !PW) { console.log('MISSING BB/PROJ/PW env'); process.exit(2); }

const OUT = '/tmp/psvis';
mkdirSync(OUT, { recursive: true });

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const out = { errors: [] };
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('[console] ' + m.text().slice(0, 140)); });
  page.on('pageerror', (e) => out.errors.push('[pageerror] ' + (e.message || String(e)).slice(0, 140)));

  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  out.login = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({}));
    const d = j?.data;
    if (d?.token) { try { localStorage.setItem('ps_session', JSON.stringify({ token: d.token, identifier: d.email ?? 'brian@megabyte.space', issuedAt: Date.now() })); } catch { /**/ } }
    return { status: res.status, ok: !!d?.token };
  }, PW);

  // Kill SW + caches so we render the freshly-deployed bundle, not a stale SW cache.
  await page.evaluate(async () => {
    try {
      if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((x) => x.unregister())); }
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
    } catch { /**/ }
  });

  // Land on /admin first so AdminStateService loads + auto-selects a site (apps section precondition).
  await page.goto('https://projectsites.dev/admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.goto('https://projectsites.dev/admin/apps/payload', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // 1) ASIDE transparency
  out.aside = await page.evaluate(() => {
    const a = document.querySelector('aside.deploy-aside');
    if (!a) return { found: false };
    const cs = getComputedStyle(a);
    return { found: true, backgroundColor: cs.backgroundColor, backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter };
  });

  // 2) LAYOUT — carousel .shot height + orphaned PROVISIONING label
  out.layout = await page.evaluate(() => {
    const shots = [...document.querySelectorAll('.shot')].map((s) => Math.round(s.getBoundingClientRect().height));
    const maxShot = shots.length ? Math.max(...shots) : null;
    // orphaned label: a "PROVISIONING" text label rendered with NO checklist items under it
    const checklist = document.querySelector('.checklist');
    const bodyText = document.body.innerText || '';
    const provisioningLabelPresent = /PROVISIONING/i.test(bodyText);
    return { shotHeights: shots, maxShot, checklistPresent: !!checklist, provisioningLabelPresent };
  });

  // 3) INSTANCES ⋮ MENU
  const rowCount = await page.evaluate(() => document.querySelectorAll('.instances-row:not(.instances-row-head)').length);
  out.instances = { rowCount };
  if (rowCount > 0) {
    const btn = page.locator('.instances-menu-btn').first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForTimeout(400);
    out.instances.menu = await page.evaluate(() => {
      const menu = document.querySelector('.instances-menu');
      if (!menu) return { open: false };
      const mr = menu.getBoundingClientRect();
      const btn = document.querySelector('.instances-menu-btn');
      const br = btn.getBoundingClientRect();
      const items = [...menu.querySelectorAll('.instances-menu-item')].map((i) => (i.innerText || '').trim().split('\n')[0]);
      const cs = getComputedStyle(menu);
      return {
        open: mr.width > 0 && mr.height > 0,
        onScreen: mr.top >= 0 && mr.left >= 0 && mr.right <= window.innerWidth && mr.bottom <= window.innerHeight + 4,
        dyFromButton: Math.round(mr.top - br.bottom),
        dxRightAlign: Math.round(mr.right - br.right),
        itemCount: items.length,
        items,
        position: cs.position,
        hasBackdropBlur: /blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || ''),
      };
    });
    await page.screenshot({ path: `${OUT}/payload-menu-open.png` });
    // Escape closes
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    out.instances.closedAfterEscape = await page.evaluate(() => !document.querySelector('.instances-menu'));
  }

  await page.screenshot({ path: `${OUT}/payload-full.png`, fullPage: true });
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));
