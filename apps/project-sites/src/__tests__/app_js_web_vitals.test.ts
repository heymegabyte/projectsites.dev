/**
 * Core Web Vitals (first-party RUM) beacon in the edge-injected app.js.
 *
 * `app.js` is injected into EVERY generated customer site. `initWebVitals()` is
 * the field-measurement half of the CWV pipeline: it observes LCP / INP / CLS via
 * PerformanceObserver and beacons each as a `web_vital` event (`{metric,value,href}`)
 * to `POST /api/events` on page hide — the same ingest the Worker mirror validates
 * into `visitor_events` (`app_js` is un-importable vanilla JS, so — like its sibling
 * `app_js_*` specs — these are string-contract assertions over the `APP_JS` constant).
 *
 * The HONESTY CONTRACT is the load-bearing property: a vital is sent ONLY when its
 * observer attached AND a real value exists. LCP/CLS/INP are Chromium-only APIs, so
 * on Safari/Firefox they must be OMITTED — never sent as a fabricated 0 (which would
 * make the future p75 card imply a perfect score that was never measured).
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initWebVitals` body — from its declaration to the Boot section marker. */
function webVitalsBody(): string {
  const start = APP_JS.indexOf('function initWebVitals(');
  expect(start).toBeGreaterThan(-1);
  // The boot IIFE (`onReady(...)`) sits immediately after initWebVitals — a stable
  // end marker independent of the section-divider comment's exact dash count.
  const end = APP_JS.indexOf('onReady(function ()', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js Core Web Vitals beacon (initWebVitals)', () => {
  describe('measurement — the standard algorithms are wired', () => {
    it('guards on PerformanceObserver support before observing anything', () => {
      expect(webVitalsBody()).toMatch(/if\s*\(typeof PerformanceObserver === 'undefined'\)\s*return;/);
    });

    it('observes LCP, CLS, INP-event, and first-input entry types', () => {
      const body = webVitalsBody();
      expect(body).toContain("'largest-contentful-paint'");
      expect(body).toContain("'layout-shift'");
      expect(body).toContain("'event'");
      expect(body).toContain("'first-input'");
      // INP event timing must set a durationThreshold (the API default drops short events).
      expect(body).toContain('durationThreshold');
    });

    it('freezes LCP at the first user interaction (keydown/pointerdown/click → disconnect)', () => {
      const body = webVitalsBody();
      expect(body).toContain("'keydown'");
      expect(body).toContain("'pointerdown'");
      expect(body).toContain("'click'");
      expect(body).toContain('disconnect');
    });

    it('computes CLS as the max session window (5s window, 1s gap), excluding recent input', () => {
      const body = webVitalsBody();
      expect(body).toContain('hadRecentInput');
      expect(body).toContain('5000');
      expect(body).toContain('1000');
    });

    it('computes INP as the p98-longest interaction (index = floor(count / 50))', () => {
      const body = webVitalsBody();
      expect(body).toMatch(/Math\.floor\(inpCount \/ 50\)/);
      // interactions are grouped by id and take the MAX duration per interaction.
      expect(body).toContain('interactionId');
    });
  });

  describe('honesty contract — unmeasured metrics are OMITTED, never a fake 0', () => {
    it('tracks a support flag per metric and only reports a supported metric', () => {
      const body = webVitalsBody();
      expect(body).toMatch(/support\s*=\s*\{[^}]*LCP[^}]*CLS[^}]*INP/);
      expect(body).toMatch(/if\s*\(support\.LCP && lcp >= 0\)/);
      expect(body).toMatch(/if\s*\(support\.CLS\)/);
      expect(body).toMatch(/if\s*\(support\.INP\)/);
    });

    it('never reports a NaN or negative value (report guards value < 0 and NaN)', () => {
      expect(webVitalsBody()).toMatch(/if\s*\(value < 0 \|\| value !== value\)\s*return;/);
    });

    it('sends CLS unitless (×1000 rounding) and LCP/INP as integer ms', () => {
      const body = webVitalsBody();
      expect(body).toContain("metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value)");
    });
  });

  describe('delivery — beacon once, on page hide, per page', () => {
    it('reports via track() as a web_vital event carrying metric + value + href', () => {
      const body = webVitalsBody();
      expect(body).toMatch(/track\('web_vital',\s*\{\s*metric:\s*metric,\s*value:\s*v,\s*href:\s*location\.pathname\s*\}\)/);
    });

    it('finalizes on the first of visibilitychange:hidden / pagehide, guarded once', () => {
      const body = webVitalsBody();
      expect(body).toContain("'visibilitychange'");
      expect(body).toContain("'pagehide'");
      expect(body).toContain("document.visibilityState === 'hidden'");
      // The `done` flag makes finalize idempotent (a tab-switch storm → one beacon set).
      expect(body).toMatch(/if\s*\(done\)\s*\{\s*return;\s*\}\s*done\s*=\s*true;/);
    });

    it('is invoked in boot inside a try/catch so a vitals throw cannot break the page', () => {
      const boot = APP_JS.slice(APP_JS.indexOf('onReady(function ()'));
      expect(boot).toContain('initWebVitals()');
      expect(boot).toMatch(/try\s*\{[\s\S]{0,80}initWebVitals\(\)[\s\S]{0,40}\}\s*catch\s*\(e\)\s*\{\}/);
    });
  });

  it('the pipeline speaks the same event name the Worker mirror validates', () => {
    // `web_vital` must match VISITOR_MIRROR_TYPES + IncomingEventSchema (server side).
    expect(APP_JS).toContain("'web_vital'");
  });
});
