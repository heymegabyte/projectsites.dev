// verify-team-seat-client-gate.mjs — ADMIN INTEGRITY: the /admin/team invite form must
// HONESTLY reflect the seat-cap state in the browser, so a user at the limit is never invited
// to an action that will only fail server-side.
//
// This is the CLIENT complement to verify-team-seat-limit-causal.mjs. That probe proves the
// SERVER enforces the cap (POST /api/team/invites → 409 at the limit) — deliberately "the button
// is not the only gate." But the converse gate — the disabled "Send invite" button + the amber
// "Seat limit reached" hint that stops a user DEAD-ENDING (fill email → click → 409) — is only
// Karma-unit-tested (team.component.spec.ts), never asserted on PROD. A FE regression dropping
// `seatsFull()` from `[disabled]="…||seatsFull()"` would ship a live-enabled button; the causal
// probe would still pass (server still 409s) and NOTHING headless would catch the dead-end.
// This locks the client gate on the real deployed bundle (action-button-must-gate + AL-435 class:
// an unactionable control must reflect its state + explain WHY).
//
// State-adaptive (validator-precision): reads seatsUsed/seatLimit from the live DOM and asserts
// the gate for whichever state the org is really in — AT CAP → button disabled + not-allowed +
// amber hint present; BELOW CAP → hint absent (no false "limit reached" on an org with room).
// The e2e org is a free 1-seat org already at 1/1, so the at-cap branch runs every fire.
// Usage: E2E_API_KEY=… node e2e/admin-verify/verify-team-seat-client-gate.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.error('E2E_API_KEY env required'); process.exit(2); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((k) => {
    localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }));
  }, KEY);
  await page.goto(`${ORIGIN}/admin/team`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for the invite form to render (entitlements resolved) before reading the gate.
  await page.waitForSelector('[data-testid="team-invite-submit"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const s = await page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const btn = document.querySelector('[data-testid="team-invite-submit"]');
    const cs = btn ? getComputedStyle(btn) : null;
    const seats = txt('[data-testid="team-seats"]');
    // seatsUsed / seatLimit as the component renders them ("N of M seats used" | "unlimited").
    const m = /(\d+)\s+of\s+(\d+|unlimited)/i.exec(seats);
    const used = m ? parseInt(m[1], 10) : NaN;
    const limit = m ? (/unlimited/i.test(m[2]) ? -1 : parseInt(m[2], 10)) : NaN;
    return {
      seats,
      used,
      limit,
      fullHint: !!document.querySelector('[data-testid="team-seats-full"]'),
      btnPresent: !!btn,
      btnDisabled: !!btn?.disabled,
      btnCursor: cs?.cursor || '',
      btnOpacity: cs?.opacity || '',
    };
  });

  check('team invite form renders (seat usage + submit present)', s.btnPresent && /seats used/i.test(s.seats), s.seats || 'no seat text');

  const atCap = Number.isFinite(s.used) && s.limit >= 0 && s.used >= s.limit;
  if (atCap) {
    // AT CAP — the client MUST prevent the dead-end: disabled + not-allowed + the amber "why".
    check('at seat cap → "Send invite" is DISABLED (no dead-end fill→click→409)', s.btnDisabled,
      `used=${s.used} limit=${s.limit} disabled=${s.btnDisabled}`);
    check('at seat cap → disabled button shows not-allowed cursor + dimmed (visible affordance)',
      s.btnCursor === 'not-allowed' && parseFloat(s.btnOpacity) < 1,
      `cursor=${s.btnCursor} opacity=${s.btnOpacity}`);
    check('at seat cap → amber "Seat limit reached" hint EXPLAINS why (AL-435 class: gated control states its reason)',
      s.fullHint, s.fullHint ? 'hint present' : 'NO seat-full hint');
  } else {
    // BELOW CAP — must NOT falsely claim "limit reached" on an org with room.
    check('below seat cap → no false "Seat limit reached" hint', !s.fullHint,
      `used=${s.used} limit=${s.limit} fullHint=${s.fullHint}`);
  }
} catch (e) {
  check('probe ran', false, String(e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ /admin/team seat-cap CLIENT gate (honest, dead-end-preventing) ━━');
rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}  ${r.detail}`));
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — the team invite form honestly reflects the seat-cap state client-side (no dead-end into a server 409).`
    : `\nVERDICT: 🔴 ${fails} CHECK(S) FAILED — the client seat gate does not reflect the real state (a user could dead-end, or a false limit shows).`,
);
process.exit(fails === 0 ? 0 : 1);
