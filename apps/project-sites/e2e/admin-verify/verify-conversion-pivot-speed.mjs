#!/usr/bin/env node
/**
 * verify-conversion-pivot-speed.mjs — COMPLETION § B.8 (conversion-pivot render SPEED guard).
 *
 * The § B flow probes (verify-guest-funnel / verify-auth-guard / verify-billing-full-flow …) prove
 * the funnel surfaces EVENTUALLY render + are operable — they `waitForSelector` with long timeouts,
 * so they'd stay GREEN even if a cold visitor waited 15s for the primary control to paint. That is
 * exactly how a real conversion killer hides: a bundle-bloat regression, a broken/renamed lazy chunk,
 * a render-blocking third-party, or a hydration stall degrades the two UNAUTH conversion pivots
 * (homepage `/` search + `/signin` email) from ~3s to double-digits while every existing probe passes.
 * Silent, severe, uncovered. This probe closes that gap with a cold-load render-SPEED tripwire.
 *
 * For each pivot, in a FRESH (cache-clean) context, real Chromium, UNAUTH:
 *   - measure time-to-primary-interactive-control (nav-start → control visible),
 *   - capture FCP + LCP (PerformanceObserver, buffered),
 *   - assert 0 console errors / pageerrors on the cold load (a pivot JS error is a real bug), and
 *   - assert the control paints within a GENEROUS ceiling (CEILING_MS) — a tripwire for a genuine
 *     "barely/never renders" degradation, NOT a jitter police (current prod ~2.8s /signin, ~well under;
 *     ceiling ≈ 3x that so network variance never cries wolf — validator-precision-discipline).
 *
 * Emits one structured JSON line per pivot (label, path, ttControlMs, fcpMs, lcpMs, consoleErrors)
 * so the trend is machine-readable across fires. Fail-CLOSED only on a real regression.
 *
 * Usage: node e2e/admin-verify/verify-conversion-pivot-speed.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const CEILING_MS = Number(process.env.PIVOT_CEILING_MS || 8000);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/** The two unauth conversion pivots + the selector for each one's primary interactive control. */
const PIVOTS = [
  {
    label: 'homepage /',
    path: '/',
    control:
      '#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]',
  },
  {
    label: 'signin',
    path: '/signin',
    control: 'input[type="email"], input[name="email"], #email',
  },
];

const b = await chromium.launch();

/** Cold-load one pivot; return timing + console-error tally. */
async function measure({ label, path, control }) {
  // A FRESH context per pivot = a cache-clean cold visitor (the worst, truest case).
  const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  p.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
  let ttControlMs = -1;
  try {
    const t0 = Date.now();
    await p.goto(`${ORIGIN}${path}?cb=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await p
      .waitForSelector(control, { state: 'visible', timeout: CEILING_MS + 6000 })
      .then(() => {
        ttControlMs = Date.now() - t0;
      })
      .catch(() => {
        ttControlMs = -1; // never painted within the window → severe
      });
    const paint = await p.evaluate(
      () =>
        new Promise((res) => {
          const fcp =
            performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')
              ?.startTime ?? 0;
          let lcp = 0;
          try {
            new PerformanceObserver((l) => {
              const es = l.getEntries();
              lcp = es[es.length - 1].startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {
            /* LCP unsupported → 0 */
          }
          setTimeout(() => res({ fcp: Math.round(fcp), lcp: Math.round(lcp) }), 600);
        }),
    );
    // Ignore console noise NOT from our origin (3rd-party analytics/font CDNs occasionally warn).
    const ownErrors = errors.filter(
      (e) => !/googletagmanager|google-analytics|posthog|fonts\.g|doubleclick|clarity/i.test(e),
    );
    return { label, path, ttControlMs, fcpMs: paint.fcp, lcpMs: paint.lcp, consoleErrors: ownErrors };
  } finally {
    await ctx.close();
  }
}

const results = [];
for (const pivot of PIVOTS) results.push(await measure(pivot));
await b.close();

console.log(`\n━━ § B.8 conversion-pivot render SPEED (cold, unauth) — ceiling ${CEILING_MS}ms ━━`);
let failed = false;
for (const r of results) {
  console.log(JSON.stringify(r));
  const slow = r.ttControlMs === -1 || r.ttControlMs > CEILING_MS;
  const dirty = r.consoleErrors.length > 0;
  if (slow) {
    failed = true;
    console.error(
      `  ❌ ${r.label} primary control ${r.ttControlMs === -1 ? 'NEVER painted' : `painted in ${r.ttControlMs}ms`} (> ${CEILING_MS}ms ceiling) — a cold prospect stares at a near-blank conversion pivot; a lazy-chunk / bundle / render regression is stranding the funnel.`,
    );
  } else {
    console.log(`  ✓ ${r.label} interactive in ${r.ttControlMs}ms (fcp ${r.fcpMs} · lcp ${r.lcpMs})`);
  }
  if (dirty) {
    failed = true;
    console.error(`  ❌ ${r.label} cold load emitted console errors: ${r.consoleErrors.join(' | ')}`);
  }
}

if (failed) {
  console.error(
    `\n❌ § B.8 FAIL — a conversion pivot renders too slowly or dirtily on a cold visit. The funnel-flow probes wait indefinitely and miss this; it directly bleeds conversion.`,
  );
  process.exit(1);
}
console.log(
  `\nVERDICT: ✅ § B.8 PASS — both unauth conversion pivots (/ + /signin) paint their primary control fast + clean on a cold visit (< ${CEILING_MS}ms, 0 console errors).`,
);
process.exit(0);
