/**
 * Scroll-depth beacon in the edge-injected app.js (`initScrollDepth`).
 *
 * `app.js` is injected into EVERY generated customer site. `initScrollDepth()` tracks the
 * MAX % of page height a visit reaches (initial above-the-fold coverage, then the deepest
 * scroll point) and beacons it once as a `scroll_depth` event (`{percent, href}`) to
 * `POST /api/events` — the first-party content-consumption signal Cloudflare's plan has no
 * dataset for. `app.js` is un-importable vanilla JS, so (like its `app_js_*` siblings)
 * these are string-contract assertions over the `APP_JS` constant.
 *
 * The load-bearing property is HONESTY: a page that fits the viewport reports 100 (fully
 * seen), an unmeasurable page is skipped (never a fabricated sample), and percent is clamped
 * 0–100 so the reach funnel never sees an out-of-range value.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initScrollDepth` body — from its declaration to the Boot section marker. */
function scrollBody(): string {
  const start = APP_JS.indexOf('function initScrollDepth(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('onReady(function ()', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js scroll-depth beacon (initScrollDepth)', () => {
  it('is booted in the onReady IIFE (runs on every injected site)', () => {
    expect(APP_JS).toContain('initScrollDepth();');
  });

  it('beacons a `scroll_depth` event carrying percent + href', () => {
    const body = scrollBody();
    expect(body).toContain("track('scroll_depth'");
    expect(body).toContain('percent: maxPct');
    expect(body).toContain('href: location.pathname');
  });

  it('tracks the MAX depth across the visit (deepest point, not the last)', () => {
    const body = scrollBody();
    expect(body).toContain('if (d > maxPct)'); // keep the max
    expect(body).toContain("window.addEventListener('scroll', sample");
  });

  it('HONESTY: a viewport-fitting page reports 100 (fully seen)', () => {
    const body = scrollBody();
    expect(body).toContain('if (sh <= ch) { return 100; }');
  });

  it('HONESTY: clamps percent 0–100 and skips an unmeasurable page (no fabricated sample)', () => {
    const body = scrollBody();
    expect(body).toContain('pct > 100 ? 100 : pct'); // upper clamp
    expect(body).toContain('if (maxPct <= 0) { return; }'); // nothing measurable → no beacon
  });

  it('beacons ONCE — a `sent` guard prevents a double count across hide + pagehide', () => {
    const body = scrollBody();
    expect(body).toContain('if (sent)');
    expect(body).toContain('sent = true');
  });

  it('fires on the first of visibilitychange:hidden / pagehide (unload-safe)', () => {
    const body = scrollBody();
    expect(body).toContain("window.addEventListener('visibilitychange'");
    expect(body).toContain("window.addEventListener('pagehide'");
  });
});
