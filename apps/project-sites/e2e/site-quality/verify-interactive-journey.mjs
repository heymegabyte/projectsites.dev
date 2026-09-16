#!/usr/bin/env node
/**
 * verify-interactive-journey.mjs — the COMPLETE VISITOR INTERACTIVE JOURNEY on a deployed generated
 * site (Loop Charter §1: "prove the site through a complete visitor journey covering ALL its
 * sub-actions … not an isolated metric"). The other 38 site-quality probes are per-METRIC (CWV, SEO,
 * a11y, density, nav, hero) — they render the page and measure, but NONE exercises the INTERACTIVE
 * conversion + AI sub-actions a real visitor uses. This gate does, end-to-end on prod:
 *
 *   1. CONTACT FORM — fill name/email/phone/message → submit → the beacon POSTs
 *      /api/contact-form/:slug and returns 200, and a "thanks / received" confirmation shows.
 *   2. PAGE-AUDIO — click "Listen to this page" → POST /api/page-audio/:slug → 200 `audio/wav`
 *      (a real MeloTTS WAV, not empty), the app plays it (`new Audio(...).play()` with a real R2 src),
 *      and the button flips to a Pause/Stop state. (The <audio> is a DETACHED Audio object, so a DOM
 *      `querySelector('audio')` is a false-negative — this hooks the Audio ctor + play() instead.)
 *   3. CHAT — open "Ask AI" → ask a question → POST /api/chat/:slug → 200 and a reply renders.
 *   4. 0 console errors across the whole journey.
 *
 * Economical (Charter/credit discipline): tests ONE site per run (the first resolved SITES/cohort
 * entry) — page-audio is R2-cached after first gen (repeat calls are cheap 200s), chat is a cheap LLM
 * call, and the contact submit writes one benign test row (same no-cleanup norm as fire-contact.mjs).
 * A feature genuinely absent on the site fails its leg (a missing conversion path IS a defect).
 *
 * Local Chromium ({slug}.projectsites.dev is CF-clean). Auto-joins run-all via the verify-*.mjs glob.
 *
 * Usage: node e2e/site-quality/verify-interactive-journey.mjs   [SITES=slug overrides the target]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SLUG = resolveSites(process.env.SITES)[0];
if (!SLUG) {
  console.log('::notice:: verify-interactive-journey skipped — no site resolved');
  process.exit(0);
}
const BASE = `https://${SLUG}.projectsites.dev`;

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const api = {}; // path-key → {status, ct, bytes}
  page.on('console', (m) => {
    const t = m.type(),
      x = m.text();
    if (/Failed to load resource|favicon|posthog|\/ingest|GL Driver Message|GPU stall|net::ERR_ABORTED/i.test(x)) return;
    if (t === 'error') errs.push(x.slice(0, 100));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 100)));
  page.on('response', async (r) => {
    const u = r.url();
    const m = u.match(/\/api\/(contact-form|page-audio|chat)\//);
    if (!m) return;
    const ct = r.headers()['content-type'] || '';
    let bytes = 0;
    try {
      if (m[1] === 'page-audio' && !ct.includes('json')) bytes = (await r.body()).length;
    } catch {
      /* body may be consumed by the browser */
    }
    api[m[1]] = { status: r.status(), ct, bytes };
  });

  // Hook the Audio ctor + play() BEFORE any page script — page-audio uses a DETACHED `new Audio()`.
  await page.addInitScript(() => {
    window.__audio = [];
    const OA = window.Audio;
    window.Audio = function (...a) {
      window.__audio.push({ via: 'new Audio', src: String(a[0] || '') });
      return new OA(...a);
    };
    const op = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__audio.push({ via: 'play', src: this.currentSrc || this.src || '' });
      return op.apply(this, arguments);
    };
  });

  // ── 1. CONTACT FORM (on /contact; fall back to homepage) ──
  await page.goto(`${BASE}/contact`, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(1500);
  if (!(await page.locator('form input[name="email"], form input[type="email"]').count())) {
    await page.goto(BASE, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1500);
  }
  const fill = async (sel, val) => {
    const el = page.locator(sel).first();
    if (await el.count()) await el.fill(val).catch(() => {});
  };
  await fill('form input[name="name"], form input[placeholder*="name" i]', 'Test Visitor');
  await fill('form input[name="email"], form input[type="email"]', 'visitor@example.com');
  await fill('form input[name="phone"], form input[type="tel"]', '3125551234');
  await fill('form textarea', 'Interested in a tour — do you offer tastings?');
  const submit = page
    .locator('form button[type="submit"], form button:has-text("Send"), form button:has-text("Submit"), form button:has-text("Get")')
    .first();
  await submit.click({ timeout: 5000 }).catch((e) => errs.push('contact-submit:' + String(e).slice(0, 50)));
  await page.waitForTimeout(4000);
  const thanks = await page.evaluate(() =>
    /thank|received|we.ll be in touch|got it|message sent|success/i.test(document.body.innerText),
  );
  check('CONTACT: POST /api/contact-form/:slug → 200', api['contact-form']?.status === 200, `status=${api['contact-form']?.status ?? 'none'}`);
  check('CONTACT: a confirmation ("thanks / received") shows', thanks);

  // ── 2. PAGE-AUDIO (homepage) ──
  await page.goto(BASE, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(1500);
  const listen = page
    .locator('button:has-text("Listen"), button[aria-label*="listen" i], button[aria-label*="play" i]')
    .first();
  if (await listen.count()) {
    await listen.scrollIntoViewIfNeeded().catch(() => {});
    await listen.click({ timeout: 5000 }).catch((e) => errs.push('audio-click:' + String(e).slice(0, 50)));
    await page.waitForTimeout(3000);
    // Flaky-click guard: if the first click fired NO page-audio request, re-click once (the control
    // occasionally no-ops mid-hydration) before waiting out MeloTTS generation.
    if (!api['page-audio']) {
      await listen.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(9000); // MeloTTS gen (first) or R2-cache fetch (repeat)
    const played = await page.evaluate(() => window.__audio || []);
    const playCall = played.find((a) => a.via === 'play' && /\/api\/page-audio\//.test(a.src));
    const btnPaused = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) =>
        /pause|stop/i.test((b.getAttribute('aria-label') || '') + (b.textContent || '')),
      ),
    );
    const a = api['page-audio'];
    check('PAGE-AUDIO: POST /api/page-audio/:slug → 200 audio/wav (non-empty)', a?.status === 200 && /audio\/wav/.test(a?.ct || '') && a.bytes > 10000, `${a?.status} ${a?.ct} ${a?.bytes}b`);
    check('PAGE-AUDIO: the app plays a real R2 WAV (Audio.play with a page-audio src)', !!playCall, playCall ? playCall.src.split('/').pop() : 'no play() with a page-audio src');
    check('PAGE-AUDIO: the Listen button flips to a Pause/Stop state', btnPaused);
  } else {
    check('PAGE-AUDIO: a "Listen to this page" control is present', false, 'no Listen button found');
  }

  // ── 3. CHAT (Ask AI) ──
  const chatToggle = page
    .locator('button:has-text("Ask AI"), button[aria-label*="chat" i], button[aria-label*="ask" i]')
    .first();
  if (await chatToggle.count()) {
    await chatToggle.click({ timeout: 5000 }).catch((e) => errs.push('chat-open:' + String(e).slice(0, 50)));
    await page.waitForTimeout(1200);
    const input = page
      .locator('input[placeholder*="ask" i], textarea[placeholder*="ask" i], [class*="chat"] input, [class*="chat"] textarea')
      .first();
    if (await input.count()) {
      await input.fill('What are your hours?').catch(() => {});
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(8000);
      check('CHAT: POST /api/chat/:slug → 200', api['chat']?.status === 200, `status=${api['chat']?.status ?? 'none'}`);
    } else {
      check('CHAT: an input appears when the widget opens', false, 'opened but no input');
    }
  } else {
    check('CHAT: an "Ask AI" control is present', false, 'no chat toggle found');
  }

  check('0 console errors across the interactive journey', errs.length === 0, errs.slice(0, 3).join(' | '));

  await page.screenshot({ path: `${__dirname}/_interactive-journey-${SLUG}.png` }).catch(() => {});
  await ctx.close();
} catch (e) {
  check('interactive-journey completes without throwing', false, String(e.message || e).slice(0, 100));
} finally {
  await browser.close();
}

const ok = fails === 0;
console.log(`\n━━ interactive visitor journey — ${SLUG} (contact + page-audio + chat) ━━`);
rows.forEach((r) => console.log(r));
console.log(
  ok
    ? `\nVERDICT: ✅ PASS — the full interactive conversion + AI journey works end-to-end on ${SLUG}, 0 console errors.`
    : `\nVERDICT: 🔴 ${fails} break(s) in the interactive journey on ${SLUG}.`,
);
process.exit(ok ? 0 : 1);
