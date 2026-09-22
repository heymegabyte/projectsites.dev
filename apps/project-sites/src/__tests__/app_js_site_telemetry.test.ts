/**
 * Sentry + PostHog telemetry seams in the edge-injected app.js.
 *
 * `app.js` is injected into EVERY generated customer site. Its telemetry
 * initializers (`initSentryStub` / `initPosthogStub`) read a host-provided
 * `window.__PS_TELEMETRY__` seam, falling back to the tag's `data-*`
 * attributes. The Worker deliberately populates NEITHER: the keys are
 * platform-level `Env` fields, so interpolating them would hand every visitor
 * of every site the same value, and `SENTRY_DSN` is documented "never injected
 * into child sites" (types/env.ts) with a matching standing policy in
 * site_serving.ts. So BOTH initializers early-return on live sites and the
 * `/app.js` body stays safe to serve + cache publicly.
 *
 * These specs pin BOTH halves: the seams exist AND the fail-soft contract holds
 * (absent key → no throw, no render block). They also regression-lock the boot
 * ordering — `attr()` reads `SCRIPT`, so the `var X = attr(...)` declarations
 * must evaluate AFTER `var SCRIPT` is assigned; hoisting them above it makes
 * every `attr()` read an undefined SCRIPT and silently return the fallback.
 *
 * Mirror of `app_js_form_hijack.test.ts` (string-slicing assertions over the
 * same `APP_JS` constant).
 */
import { APP_JS } from '../generated/app_js.js';

/** Extract `function <name>(...) { ... }` up to the next top-level function. */
function fnBody(fnName: string): string {
  const start = APP_JS.indexOf(`function ${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = APP_JS.slice(start);
  const nextFn = rest.indexOf('\n  function ', `function ${fnName}(`.length);
  return nextFn > -1 ? rest.slice(0, nextFn) : rest;
}

/** The dynamic `script` tag builder in the boot block. */
function scriptTagBuilder(): string {
  const start = APP_JS.indexOf('var tag = document.createElement(');
  expect(start).toBeGreaterThan(-1);
  return APP_JS.slice(start, start + 2400);
}

describe('app.js Sentry + PostHog telemetry seams', () => {
  describe('config seam (keys come from the host, not inlined literals)', () => {
    it('declares a module-level config seam, not inlined literals', () => {
      expect(APP_JS).toContain('SENTRY_DSN');
      expect(APP_JS).toContain('POSTHOG_KEY');
      // The seam must stay host-writable (a host that chooses to populate
      // `window.__PS_TELEMETRY__` before the bundle runs) — a baked-in literal
      // would ship one key to every site.
      expect(APP_JS).toMatch(/var\s+PS_CONFIG\s*=/);
    });

    it('reads the Sentry DSN from the config seam', () => {
      const body = fnBody('initSentryStub');
      expect(body).toContain('PS_CONFIG');
      expect(body).toContain('SENTRY_DSN');
    });

    it('reads the PostHog key + host from the config seam', () => {
      const body = fnBody('initPosthogStub');
      expect(body).toContain('PS_CONFIG');
      expect(body).toContain('POSTHOG_KEY');
      expect(body).toContain('POSTHOG_HOST');
    });

    it('binds the resolved telemetry values onto window when a key is present', () => {
      expect(APP_JS).toContain('window.__PS_SENTRY__');
      expect(APP_JS).toContain('window.__PS_POSTHOG__');
    });

    it('uses the regional PostHog ingestion host, never the deprecated UI host', () => {
      // app.posthog.com captures silently no-op (per auto-meta-work § PostHog).
      expect(APP_JS).not.toContain('app.posthog.com');
      expect(fnBody('initPosthogStub')).toContain('i.posthog.com');
    });
  });

  describe('fail-soft contract (no key → no throw, no render block)', () => {
    it('guards both initializers on an absent key with an early return', () => {
      const sentry = fnBody('initSentryStub');
      const posthog = fnBody('initPosthogStub');
      expect(sentry).toMatch(/if\s*\(!DSN\)\s*return;/);
      expect(posthog).toMatch(/if\s*\(!KEY\)\s*return;/);
    });

    it('wraps the telemetry boot call in try/catch so a throw cannot break boot', () => {
      const boot = APP_JS.slice(APP_JS.indexOf('onReady(function ()'));
      expect(boot).toContain('initSentryStub()');
      expect(boot).toContain('initPosthogStub()');
      // The calls sit inside a try { } catch (e) {} — telemetry never blocks paint.
      expect(boot).toMatch(/try\s*\{[\s\S]{0,200}initSentryStub\(\)[\s\S]{0,200}\}\s*catch\s*\(e\)\s*\{\}/);
    });

    it('never loads a third-party SDK when the key is absent', () => {
      // The stub still ships NO real SDK — the seam is the deliverable here.
      expect(APP_JS).toContain('sentry-cdn.com');
      const body = fnBody('initSentryStub');
      const guardIdx = body.search(/if\s*\(!DSN\)\s*return;/);
      const cdnIdx = body.indexOf('sentry-cdn.com');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(cdnIdx).toBeGreaterThan(guardIdx); // guard runs BEFORE any load
    });
  });

  describe('runtime wiring (the emitted tag carries the resolved values)', () => {
    it('builds the script tag from config, not a static string', () => {
      // `document.currentScript` is null for the injected `defer` tag in some
      // engines; the builder recreates it with the resolved attributes.
      const tag = scriptTagBuilder();
      expect(tag).toContain('app.js');
      expect(tag).toContain('data-slug');
      expect(tag).toContain('data-paid');
    });

    it('declares SCRIPT before the `attr()` reads that depend on it', () => {
      // `var` hoists only the DECLARATION: hoisting these above `var SCRIPT =`
      // makes `attr()` read an undefined SCRIPT and silently return every
      // fallback — the real `data-*` attributes would be ignored on every live
      // site. The substring assertions above cannot catch that class.
      const scriptDecl = APP_JS.indexOf('var SCRIPT =');
      const attrDecl = APP_JS.indexOf('function attr(');
      const firstRead = APP_JS.indexOf('var API = attr(');
      expect(scriptDecl).toBeGreaterThan(-1);
      expect(attrDecl).toBeGreaterThan(-1);
      expect(firstRead).toBeGreaterThan(-1);
      expect(attrDecl).toBeGreaterThan(scriptDecl);
      expect(firstRead).toBeGreaterThan(scriptDecl);
    });
  });
});
