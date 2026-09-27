/**
 * Time-on-page (engagement) beacon in the edge-injected app.js (`initEngagement`).
 *
 * `app.js` is injected into EVERY generated customer site. `initEngagement()` measures
 * dwell time (interactive → first hide) and beacons it once as a `page_engagement` event
 * (`{duration_ms, href}`) to `POST /api/events` — the first-party engagement signal
 * Cloudflare's plan has no dataset for. `app.js` is un-importable vanilla JS, so (like its
 * `app_js_*` siblings) these are string-contract assertions over the `APP_JS` constant.
 *
 * The load-bearing property is HONESTY: beacon once, and only for a REAL dwell — bounce/bot
 * noise (<1s) and abandoned open tabs (>30min) are dropped so a future median-time-on-page
 * metric isn't skewed by non-engagement.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `initEngagement` body — from its declaration to the Boot section marker. */
function engagementBody(): string {
  const start = APP_JS.indexOf('function initEngagement(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('onReady(function ()', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js time-on-page beacon (initEngagement)', () => {
  it('is booted in the onReady IIFE (runs on every injected site)', () => {
    expect(APP_JS).toContain('initEngagement();');
  });

  it('beacons a `page_engagement` event carrying duration_ms + href', () => {
    const body = engagementBody();
    expect(body).toContain("track('page_engagement'");
    expect(body).toContain('duration_ms: dur');
    expect(body).toContain('href: location.pathname');
  });

  it('measures dwell as now − start (a load-anchored elapsed time)', () => {
    const body = engagementBody();
    expect(body).toContain('var start = Date.now()');
    expect(body).toContain('Date.now() - start');
  });

  it('HONESTY: drops sub-second (bounce/bot) and >30min (abandoned tab) durations', () => {
    const body = engagementBody();
    expect(body).toContain('dur < 1000'); // <1s dropped
    expect(body).toContain('dur > 1800000'); // >30min dropped
  });

  it('beacons ONCE — a `sent` guard prevents a double count across hide + pagehide', () => {
    const body = engagementBody();
    expect(body).toContain('if (sent)');
    expect(body).toContain('sent = true');
  });

  it('fires on the first of visibilitychange:hidden / pagehide (unload-safe)', () => {
    const body = engagementBody();
    expect(body).toContain("window.addEventListener('visibilitychange'");
    expect(body).toContain("window.addEventListener('pagehide'");
  });
});

describe('app.js session id (groups a visit for entry/exit pages, cookieless)', () => {
  it('sends the per-session sid on the page_engagement beacon', () => {
    expect(engagementBody()).toContain('sid: SESSION_KEY');
  });

  it('persists a per-tab-session UUID in ps_sess, upgrading the legacy single-char marker in place', () => {
    // ps_sess now holds a real session id (UUID), not the old boolean flag — so the server can
    // group a visit's page_engagements to report the LAST (exit) page.
    expect(APP_JS).toContain("sessionStorage.getItem('ps_sess')");
    expect(APP_JS).toContain("sessionStorage.setItem('ps_sess', SESSION_KEY)");
    expect(APP_JS).toContain('SESSION_KEY = uuid()');
    expect(APP_JS).toContain("SESSION_KEY === '1'"); // legacy marker migrated
  });

  it('still marks the session first page as the entry (IS_ENTRY) — derived from the same key', () => {
    expect(APP_JS).toContain('IS_ENTRY');
    expect(engagementBody()).toContain('ep: IS_ENTRY');
  });

  it('the session_id COLUMN derives from the persisted per-tab key (so uniqueSessions = real sessions, not pageloads)', () => {
    // The correctness fix: SESSION_ID (sent as sessionId on EVERY event) is the persisted per-tab
    // ps_sess UUID when storage works, falling back to a per-pageload id only when storage is
    // unavailable — so COUNT(DISTINCT session_id) counts sessions, not page loads.
    expect(APP_JS).toContain('var SESSION_ID = SESSION_KEY ||');
    expect(APP_JS).toContain('sessionId: SESSION_ID');
    // and it must NOT be the old unconditional per-pageload id
    expect(APP_JS).not.toContain('var SESSION_ID = (function');
  });
});
