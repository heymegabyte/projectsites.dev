/**
 * Generic click (UI-interaction) beacon in the edge-injected app.js (`onClick`).
 *
 * app.js is injected into EVERY generated customer site. Its capture-phase `onClick` listener has
 * TWO paths: (1) the unchanged CONVERSION path (tel/mailto/sms/outbound/directions links +
 * [data-ps-cta] buttons) → `track('conversion')`; (2) a generic INTERACTION path for
 * button / [role=button] / summary / opt-in [data-ps-track] → `track('click', {label, section,
 * href})` — the first-party "most-clicked elements" signal Cloudflare's plan has no dataset for.
 *
 * The load-bearing property is NO DOUBLE-COUNT: a conversion is emitted-and-returned BEFORE the
 * generic path, and the generic path excludes [data-ps-cta] + anchors (they navigate → a pageview
 * already), so one click is never counted as both a conversion and an interaction. app.js is
 * un-importable vanilla JS, so (like its app_js_* siblings) these are string-contract assertions.
 */
import { APP_JS } from '../generated/app_js.js';

/** The `labelOf` + `onClick` bodies — from labelOf's declaration to the Form-hijack section. */
function clickBody(): string {
  const start = APP_JS.indexOf('function labelOf(');
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('Form hijack', start);
  expect(end).toBeGreaterThan(start);
  return APP_JS.slice(start, end);
}

describe('app.js generic-click beacon (onClick interaction path)', () => {
  it('is registered as a capture-phase document click listener (runs on every injected site)', () => {
    expect(APP_JS).toContain("document.addEventListener('click', onClick, true)");
  });

  it('beacons a `click` event carrying label + section + the page path', () => {
    const body = clickBody();
    expect(body).toContain("track('click'");
    expect(body).toContain('label: label');
    expect(body).toContain('section: sectionOf(el)');
    expect(body).toContain('href: pth');
  });

  it('NO DOUBLE-COUNT: a conversion is emitted-and-returned before the generic click path', () => {
    const body = clickBody();
    const convAt = body.indexOf("track('conversion'");
    const clickAt = body.indexOf("track('click'");
    expect(convAt).toBeGreaterThan(-1);
    expect(clickAt).toBeGreaterThan(convAt); // conversion path is first
    // a `return;` between them makes the generic path unreachable once a conversion fires.
    expect(body.slice(convAt, clickAt)).toContain('return;');
  });

  it('NO DOUBLE-COUNT: the generic path excludes CTA buttons + non-opted-in anchors', () => {
    const body = clickBody();
    expect(body).toContain("el.getAttribute('data-ps-cta') !== null) return"); // already a conversion
    expect(body).toContain("el.tagName === 'A' && trackAttr === null) return"); // anchor → pageview
  });

  it('targets only the interaction surface: button / role=button / summary / opt-in [data-ps-track]', () => {
    const body = clickBody();
    expect(body).toContain("t.closest('button,[role=\"button\"],summary,[data-ps-track]')");
  });

  it('HONESTY: an unlabelled element is skipped (never a blank/fabricated row)', () => {
    const body = clickBody();
    expect(body).toContain('if (!label) return;');
    // label derives from an explicit marker / aria-label / trimmed text (low-cardinality group key).
    expect(body).toContain("el.getAttribute('data-ps-label')");
    expect(body).toContain("el.getAttribute('aria-label')");
  });

  it('bounds cost/noise: a per-page cap + an explicit data-ps-track="off" opt-out', () => {
    const body = clickBody();
    expect(body).toContain('psClicks >= 25');
    expect(body).toContain("trackAttr === 'off') return");
  });
});
