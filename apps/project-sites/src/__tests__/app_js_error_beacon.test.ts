/**
 * First-party JS-error beacon in the edge-injected app.js (`initErrorBeacon`).
 *
 * `app.js` is injected into EVERY generated customer site. `initErrorBeacon()` turns an
 * uncaught JS error / unhandled promise rejection into a `js_error` event to
 * `POST /api/events` — the site-health signal Cloudflare's plan exposes no dataset for.
 * `app.js` is un-importable vanilla JS, so (like its `app_js_*` siblings) these are
 * string-contract assertions over the `APP_JS` constant.
 *
 * The load-bearing properties are SAFETY + HONESTY: the beacon must dedupe (one per
 * message/session), cap (≤5/session), truncate the message, skip resource-load errors
 * (which carry no `.message`), and self-guard so a throw inside the beacon never loops.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initErrorBeacon` body — from its declaration to the Boot section marker. */
function errorBeaconBody(): string {
  const start = APP_JS.indexOf('function initErrorBeacon(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('onReady(function ()', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js JS-error beacon (initErrorBeacon)', () => {
  it('is booted in the onReady IIFE (so it runs on every injected site)', () => {
    expect(APP_JS).toContain('initErrorBeacon();');
  });

  it('listens for BOTH uncaught errors and unhandled rejections', () => {
    const body = errorBeaconBody();
    expect(body).toContain("window.addEventListener('error'");
    expect(body).toContain("window.addEventListener('unhandledrejection'");
  });

  it('beacons a `js_error` event carrying message/source/line', () => {
    const body = errorBeaconBody();
    expect(body).toContain("track('js_error'");
    expect(body).toContain('message: msg');
    expect(body).toContain('source:');
    expect(body).toContain('line:');
  });

  it('SAFETY: dedupes by message, caps at 5/session, and truncates the message', () => {
    const body = errorBeaconBody();
    expect(body).toContain('count >= 5'); // per-session cap
    expect(body).toContain('seen[msg]'); // dedupe by message
    expect(body).toContain('.slice(0, 300)'); // message truncation (no unbounded payload)
  });

  it('HONESTY: ignores resource-load failures (no `.message`) — only real JS errors', () => {
    const body = errorBeaconBody();
    expect(body).toContain('e && e.message'); // resource 404s (img/script) have no .message → skipped
  });

  it('self-guards — the report path is wrapped so a throw never re-beacons', () => {
    const body = errorBeaconBody();
    // The report() body + the listener registration are each try/catch-wrapped.
    expect(body).toMatch(/function report\([^)]*\)\s*\{\s*try\s*\{/);
  });
});
