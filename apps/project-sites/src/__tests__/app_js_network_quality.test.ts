/**
 * Network-quality beacon in the edge-injected app.js (`initNetworkQuality`).
 *
 * `app.js` is injected into EVERY generated customer site. `initNetworkQuality()` reads the
 * visitor's `navigator.connection` estimate (effectiveType / downlink / rtt / saveData) and
 * beacons it once on load as a `network_quality` event to `POST /api/events` — the first-party
 * "what connections are my visitors on" signal Cloudflare's plan has no dataset for. `app.js`
 * is un-importable vanilla JS, so (like its `app_js_*` siblings) these are string-contract
 * assertions over the `APP_JS` constant.
 *
 * The load-bearing property is HONESTY: `navigator.connection` is Chromium-only, so on a
 * browser without it NOTHING is sent (a `!c` guard), and only present + valid fields are
 * beaconed — the metric is an explicit subset, never a fabricated sample.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initNetworkQuality` body — from its declaration to the Boot section marker. */
function netBody(): string {
  const start = APP_JS.indexOf('function initNetworkQuality(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('Boot', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js network-quality beacon (initNetworkQuality)', () => {
  it('is booted in the onReady IIFE (runs on every injected site)', () => {
    expect(APP_JS).toContain('initNetworkQuality();');
  });

  it('beacons a `network_quality` event with the connection fields + href', () => {
    const body = netBody();
    expect(body).toContain("track('network_quality'");
    expect(body).toContain('payload.effective_type = c.effectiveType');
    expect(body).toContain('payload.downlink = c.downlink');
    expect(body).toContain('payload.rtt = c.rtt');
    expect(body).toContain('payload.save_data = c.saveData');
  });

  it('reads navigator.connection (with vendor-prefixed fallbacks)', () => {
    const body = netBody();
    expect(body).toContain('navigator.connection');
    expect(body).toContain('navigator.mozConnection');
    expect(body).toContain('navigator.webkitConnection');
  });

  it('HONESTY: Chromium-only — no connection object → no sample sent', () => {
    const body = netBody();
    expect(body).toContain('if (!c) { return; }');
  });

  it('HONESTY: only present + valid fields (finite, non-negative) are included', () => {
    const body = netBody();
    expect(body).toContain('isFinite(c.downlink)');
    expect(body).toContain('c.downlink >= 0');
    expect(body).toContain('isFinite(c.rtt)');
    expect(body).toContain("typeof c.saveData === 'boolean'");
  });

  it('never sends an empty sample — bails when no connection field was present', () => {
    const body = netBody();
    expect(body).toContain('payload.effective_type === undefined');
    expect(body).toContain('payload.save_data === undefined');
  });
});
