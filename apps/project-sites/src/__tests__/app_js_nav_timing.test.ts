/**
 * Page-load waterfall beacon in the edge-injected app.js (`initNavTiming`).
 *
 * `app.js` is injected into EVERY generated customer site. `initNavTiming()` reads the
 * PerformanceNavigationTiming entry after the load event and beacons the load-phase durations
 * (DNS / connect / server-wait / download / DOM / total) as a `nav_timing` event to
 * `POST /api/events` — the first-party page-load breakdown Cloudflare's plan (no edge latency)
 * can't provide. `app.js` is un-importable vanilla JS, so (like its `app_js_*` siblings) these
 * are string-contract assertions over the `APP_JS` constant.
 *
 * The load-bearing property is HONESTY: an unsupported Navigation-Timing API OR a nonsensical
 * total (≤0 / >600s) sends NOTHING; a phase of 0 (cached DNS, reused connection) is a REAL
 * value, kept as-is; each phase is clamped ≥0 against clock-skew.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initNavTiming` body — from its declaration to the Boot section marker. */
function navBody(): string {
  const start = APP_JS.indexOf('function initNavTiming(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('Boot', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js page-load waterfall beacon (initNavTiming)', () => {
  it('is booted in the onReady IIFE (runs on every injected site)', () => {
    expect(APP_JS).toContain('initNavTiming();');
  });

  it('beacons a `nav_timing` event with every load phase + href', () => {
    const body = navBody();
    expect(body).toContain("track('nav_timing'");
    for (const phase of ['dns', 'connect', 'ttfb', 'transfer', 'dom', 'total']) {
      expect(body).toContain(`${phase}:`);
    }
    expect(body).toContain('href: location.pathname');
  });

  it('derives phases from the PerformanceNavigationTiming entry', () => {
    const body = navBody();
    expect(body).toContain("performance.getEntriesByType('navigation')[0]");
    expect(body).toContain('n.domainLookupEnd - n.domainLookupStart'); // DNS
    expect(body).toContain('n.responseStart - n.requestStart'); // TTFB
    expect(body).toContain('n.domComplete - n.responseEnd'); // DOM
  });

  it('fires AFTER the load event so loadEventEnd is populated', () => {
    const body = navBody();
    expect(body).toContain("document.readyState === 'complete'");
    expect(body).toContain("window.addEventListener('load'");
  });

  it('HONESTY: no navigation entry → no sample; a nonsensical total is dropped', () => {
    const body = navBody();
    expect(body).toContain('if (!n) { return; }');
    expect(body).toContain('total > 600000'); // absurd total dropped
    expect(body).toContain('!(total > 0)'); // non-positive total dropped
  });

  it('HONESTY: clamps each phase ≥0 (clock skew), keeping a real 0 as 0', () => {
    const body = navBody();
    expect(body).toContain('x > 0 ? Math.round(x) : 0');
  });
});
