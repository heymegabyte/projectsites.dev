#!/usr/bin/env node
/**
 * _cls-attribution.mjs — one-off: attribute admin-route CLS to the DOM elements that shift.
 *
 * The CWV probe reports a CLS NUMBER per route; this reports WHICH elements moved (the
 * `layout-shift` entry `.sources[].node`), by descending shift value — so a fix reserves
 * the RIGHT element's height instead of guessing. READ-ONLY, local Chromium, authed via
 * E2E_API_KEY (addInitScript arg, never inlined).
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/_cls-attribution.mjs snapshots docs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: _cls-attribution skipped — E2E_API_KEY unset');
  process.exit(0);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ['snapshots', 'docs'];

const browser = await chromium.launch();
for (const slug of ROUTES) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((k) => {
    try {
      localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
    } catch {
      /* opaque */
    }
    // Start recording layout-shift sources as early as possible.
    globalThis.__shifts = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          const nodes = (e.sources || []).map((s) => {
            const n = s.node;
            if (!n || n.nodeType !== 1) return n ? `#text/${n.nodeName}` : '(detached)';
            const el = n;
            const id = el.id ? `#${el.id}` : '';
            const tid = el.getAttribute?.('data-testid');
            const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            return `${el.tagName.toLowerCase()}${id}${tid ? `[data-testid=${tid}]` : ''}${cls}`;
          });
          globalThis.__shifts.push({ value: e.value, nodes });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* unsupported */
    }
  }, KEY);
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/admin/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('nav[aria-label="Primary"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4500);
  const out = await page.evaluate(() => {
    const shifts = globalThis.__shifts || [];
    const total = shifts.reduce((s, x) => s + x.value, 0);
    // Aggregate by first-node selector.
    const byNode = {};
    for (const s of shifts) {
      const key = s.nodes[0] || '(none)';
      byNode[key] = (byNode[key] || 0) + s.value;
    }
    const top = Object.entries(byNode).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { total: Number(total.toFixed(4)), count: shifts.length, top };
  });
  console.log(`\n━━ /admin/${slug} — CLS ${out.total} across ${out.count} shift(s) ━━`);
  for (const [node, val] of out.top) console.log(`  ${val.toFixed(4)}  ${node}`);
  await ctx.close();
}
await browser.close();
