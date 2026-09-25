/**
 * @module generated/app_js
 *
 * The unified client script served at `GET https://projectsites.dev/app.js` and
 * injected at the edge into EVERY generated customer site (see
 * {@link ../services/site_serving.ts} → `injectUnifiedClientScript`).
 *
 * It is authored as a single string constant (not a `public/app.js` file) because
 * the Worker does not serve `public/` — there is no `serveStatic`/`[assets]`
 * binding — so a string the route returns is the only build-step-free way to ship
 * it. The route (`GET /app.js` in `src/index.ts`) returns {@link APP_JS} verbatim
 * with `content-type: application/javascript; charset=utf-8` + a 1h cache.
 *
 * The script is PURE vanilla ES5-safe JS — no modules, no build step, runs in any
 * browser. It consolidates four concerns, each self-contained + fail-soft:
 *
 * 1. **Analytics** — fires a `pageview` to `POST /api/events` on load, a
 *    `conversion` event for outbound / tel: / mailto: / CTA clicks, and (via
 *    `initWebVitals`) `web_vital` events carrying field-measured Core Web Vitals
 *    (LCP / INP / CLS) PLUS page-load timing (FCP / TTFB), `{metric, value, href}`,
 *    beaconed on page hide. Each metric is sent ONLY when its source (a
 *    PerformanceObserver, or Navigation Timing for TTFB) attached and a real value
 *    exists — an unmeasured metric is omitted, never a fabricated 0. Fire-and-forget `fetch`
 *    with `keepalive:true`. Body matches `IncomingEventSchema`
 *    (`{eventId, siteId, eventType, timestamp, payload, referer}`).
 * 2. **Form hijack** — capture-phase submit listener + MutationObserver catch every
 *    `<form>` site-wide, `preventDefault`, serialize fields, POST to
 *    `POST /api/contact-form/<slug>` (`{name, email, phone?, message}`), show inline
 *    success/error text, and emit a `form_submit` analytics event.
 * 3. **Upgrade bar** — for `data-paid="false"` sites, injects the sticky
 *    "Claim / Edit with AI" bar (same copy + bolt-editor URL the server previously
 *    rendered via `generateConversionFlow`). Paid sites render nothing.
 * 4. **Concierge chat** — floating AI chat FAB → `POST /api/chat/<slug>`; self-removes
 *    when the endpoint 404s (operator killswitch).
 * 5. **Sentry + PostHog (inert by default)** — loads the real `@sentry/browser` bundle
 *    from the official CDN and configures PostHog, gated on a host-provided
 *    `window.__PS_TELEMETRY__` seam. The Worker deliberately does NOT populate it
 *    (see `@remarks` below). Fail-soft: absent key → no SDK, no throw.
 *
 * The `<slug>` and `<paid>` values arrive via the injected script tag's
 * `data-slug` / `data-paid` attributes; slug falls back to the first hostname label.
 * Telemetry keys arrive via the optional `window.__PS_TELEMETRY__` seam or, when
 * absent, the tag's `data-sentry-dsn` / `data-posthog-key` attributes.
 *
 * @example
 * // src/index.ts
 * import { APP_JS } from './generated/app_js.js';
 * app.get('/app.js', (c) =>
 *   c.body(APP_JS, 200, {
 *     'content-type': 'application/javascript; charset=utf-8',
 *     'cache-control': 'public, max-age=3600',
 *   }),
 * );
 */

/**
 * The unified vanilla-JS client script, verbatim. Served at `/app.js` and injected
 * into every generated site. Pure ES5-safe JS — no modules, no dependencies.
 *
 * @remarks A static constant — the per-site `data-slug` / `data-paid` come from the
 * injected `<script>` tag. There is NO serve-time interpolation: the telemetry keys
 * are platform-level `Env` fields (see `types/env.ts`), so every visitor of every
 * site would receive the SAME value. The `__PS_TELEMETRY__` seam therefore stays
 * empty, which is what makes the `/app.js` body safe to serve + cache publicly.
 * The DSN must never reach client HTML (`env.ts` `SENTRY_DSN`; `site_serving.ts`
 * § served-site injection policy).
 */
export const APP_JS = `/*! ProjectSites unified client — analytics + forms + upgrade bar. No deps. */
(function () {
  'use strict';
  if (window.__PS_APP_JS__) return; // idempotent: never double-init
  window.__PS_APP_JS__ = true;

  // ── telemetry seam ───────────────────────────────────────────────────
  // An OPTIONAL host-provided override. The Worker deliberately does NOT populate
  // it (the keys are platform-level, not per-site), so on every served site this
  // evaluates to {} and every consumer below must fail-soft on an empty value.
  var PS_CONFIG = window.__PS_TELEMETRY__ || {};

  var SCRIPT =
    document.currentScript ||
    (function () {
      var s = document.querySelectorAll('script[src*="/app.js"]');
      if (s.length) return s[s.length - 1];
      // 'document.currentScript' is null for a 'defer'-injected tag on some
      // engines and the querySelector can miss a tag that has not parsed yet.
      // Rebuild a handle from the CANONICAL LITERALS — never from SLUG / PAID /
      // SITES_BASE. Those are resolved below via 'attr()', which reads SCRIPT,
      // so referencing them here would be a circular dependency and 'var'
      // hoisting would hand back 'https://undefined/app.js'. This last-resort
      // branch only fires when no tag exists at all, and in that case 'attr()'
      // finds nothing either and returns the same literals — the two agree.
      var tag = document.createElement('script');
      tag.src = 'https://projectsites.dev/app.js';
      tag.setAttribute('data-slug', location.hostname.split('.')[0] || 'site');
      tag.setAttribute('data-paid', 'false');
      return tag;
    })();

  function attr(name, fallback) {
    var v = SCRIPT && SCRIPT.getAttribute(name);
    return v == null || v === '' ? fallback : v;
  }

  // Declared AFTER 'SCRIPT' on purpose: 'attr()' reads SCRIPT, so these must
  // evaluate only once SCRIPT is assigned. Hoisting them above the 'var SCRIPT'
  // initializer would make every 'attr()' call read an undefined SCRIPT and
  // silently return the fallback — the real data-* attributes would be ignored.
  var API = attr('data-api', 'https://projectsites.dev');
  var SLUG = attr('data-slug', '') || (location.hostname.split('.')[0] || 'site');
  var PAID = attr('data-paid', 'false') === 'true';
  var BOLT_BASE = attr('data-bolt-base', 'editor.projectsites.dev');
  var SITES_BASE = attr('data-sites-base', 'projectsites.dev');

  var onReady = function (fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  };

  // ── session id (in-memory, cookieless) ───────────────────────────────
  var SESSION_ID = (function () {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return (
      'ps-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  })();

  function uuid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ───────────────────────── Analytics ───────────────────────── */
  // Fire-and-forget POST to /api/events. Body matches IncomingEventSchema.
  function track(eventType, payload) {
    try {
      var body = {
        eventId: uuid(),
        siteId: SLUG,
        eventType: eventType,
        sessionId: SESSION_ID,
        timestamp: Date.now(),
        payload: payload || {}
      };
      try {
        if (document.referrer) body.referer = document.referrer;
      } catch (e) {}
      fetch(API + '/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit'
      })['catch'](function () {});
    } catch (e) {
      /* analytics must never break the page */
    }
  }

  function pageview() {
    var path = '/';
    try {
      path = location.pathname + location.search;
    } catch (e) {}
    track('pageview', { href: path, title: document.title || undefined });
  }

  // Outbound / tel / mailto / CTA clicks → conversion event.
  function sectionOf(el) {
    try {
      var s = el.closest && el.closest('[data-ps-section],section,[id]');
      if (!s) return undefined;
      return s.getAttribute('data-ps-section') || s.id || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function classifyLink(href) {
    if (!href) return null;
    if (href.indexOf('tel:') === 0) return 'call';
    if (href.indexOf('mailto:') === 0) return 'email';
    if (href.indexOf('sms:') === 0) return 'sms';
    if (/^https?:/i.test(href)) {
      try {
        var u = new URL(href, location.href);
        if (u.host !== location.host) return 'outbound';
      } catch (e) {}
      if (/google\\.[a-z.]+\\/maps|maps\\.app\\.goo\\.gl|maps\\.google/i.test(href)) return 'directions';
    }
    return null;
  }

  function onClick(ev) {
    try {
      var t = ev.target;
      var a = t && t.closest ? t.closest('a[href],button[data-ps-cta]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      var kind = a.getAttribute('data-ps-cta') || classifyLink(href);
      if (!kind) return;
      track('conversion', { kind: kind, section: sectionOf(a), href: href || undefined });
    } catch (e) {}
  }

  /* ───────────────────────── Form hijack ───────────────────────── */
  var HIJACKED = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function marked(form) {
    if (HIJACKED) {
      if (HIJACKED.has(form)) return true;
      HIJACKED.add(form);
      return false;
    }
    if (form.__psBound) return true;
    form.__psBound = true;
    return false;
  }

  function firstField(form, names) {
    for (var i = 0; i < names.length; i++) {
      var el =
        form.querySelector('[name="' + names[i] + '"]') ||
        form.querySelector('[name*="' + names[i] + '" i]') ||
        form.querySelector('input[type="' + names[i] + '"]');
      if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim();
    }
    return '';
  }

  function statusEl(form) {
    var el = form.querySelector('[data-ps-form-status]');
    if (!el) {
      el = document.createElement('p');
      el.setAttribute('data-ps-form-status', '');
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText =
        'margin:12px 0 0;font:600 14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
      form.appendChild(el);
    }
    return el;
  }

  function setStatus(form, msg, ok) {
    var el = statusEl(form);
    el.textContent = msg;
    el.style.color = ok ? '#16a34a' : '#dc2626';
  }

  function serialize(form) {
    var name = firstField(form, ['name', 'fullname', 'full_name', 'your-name', 'text']);
    var email = firstField(form, ['email', 'e-mail', 'your-email']);
    var phone = firstField(form, ['phone', 'tel', 'telephone', 'mobile']);
    var message = firstField(form, [
      'message',
      'msg',
      'comments',
      'comment',
      'details',
      'inquiry',
      'body',
      'textarea'
    ]);
    if (!message) {
      var ta = form.querySelector('textarea');
      if (ta && ta.value) message = String(ta.value).trim();
    }
    return { name: name, email: email, phone: phone || undefined, message: message };
  }

  function submitForm(form, ev) {
    // ALWAYS stop the native submit FIRST — app.js fully owns this form. The two
    // client-validation branches below \`return\` early; if preventDefault ran only
    // after them (the old bug), an incomplete submit did a native GET reload that
    // WIPED the inline error AND the visitor's typed input — a silent
    // conversion-killer on the lead-gen form. Prevent unconditionally, then serialize.
    if (ev) ev.preventDefault();
    var data = serialize(form);
    // The endpoint validates: name, email, message (>=10 chars). Give inline
    // feedback for the obvious cases before the round-trip.
    if (!data.name || !data.email) {
      setStatus(form, 'Please add your name and email.', false);
      return;
    }
    if (!data.message || data.message.length < 10) {
      setStatus(form, 'Please add a message (at least 10 characters).', false);
      return;
    }
    setStatus(form, 'Sending…', true);
    track('form_start', { form: form.id || form.name || 'contact' });

    fetch(API + '/api/contact-form/' + encodeURIComponent(SLUG), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      mode: 'cors',
      credentials: 'omit'
    })
      .then(function (res) {
        return res
          .json()
          ['catch'](function () {
            return {};
          })
          .then(function (json) {
            return { ok: res.ok, json: json };
          });
      })
      .then(function (r) {
        if (r.ok) {
          setStatus(form, 'Thanks! Your message has been sent.', true);
          try {
            form.reset();
          } catch (e) {}
          track('form_submit', { form: form.id || form.name || 'contact' });
        } else {
          var m =
            (r.json && r.json.error && r.json.error.message) ||
            'Something went wrong. Please try again or email us directly.';
          setStatus(form, m, false);
        }
      })
      ['catch'](function () {
        setStatus(form, 'Network error. Please try again.', false);
      });
  }

  function onSubmit(ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    if (form.getAttribute('data-ps-ignore') != null) return; // opt-out hook
    submitForm(form, ev);
  }

  function bindForms() {
    // Capture-phase document listener catches EVERY form incl. late ones, and
    // marking prevents a double-send if a form is bound twice.
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) marked(forms[i]);
  }

  /* ───────────────────────── Upgrade bar ───────────────────────── */
  function injectUpgradeBar() {
    if (PAID) return; // paid sites: no bar
    if (document.getElementById('ps-upgrade-bar')) return;
    var editUrl = 'https://' + BOLT_BASE + '/?slug=' + encodeURIComponent(SLUG);
    var buildUrl = 'https://' + SITES_BASE + '/?ref=preview';

    var css =
      '#ps-upgrade-bar{position:fixed;left:0;right:0;bottom:0;z-index:99998;transform:translateY(110%);' +
      'transition:transform .5s cubic-bezier(.16,1,.3,1);font-family:-apple-system,BlinkMacSystemFont,\\'Segoe UI\\',Roboto,sans-serif}' +
      '#ps-upgrade-bar.ps-in{transform:translateY(0)}' +
      '#ps-ub-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;' +
      'background:linear-gradient(135deg,rgba(10,6,30,.97),rgba(22,14,56,.97));backdrop-filter:blur(20px);' +
      'border-top:1px solid rgba(124,58,237,.2);box-shadow:0 -8px 32px rgba(0,0,0,.4)}' +
      '#ps-ub-left{display:flex;align-items:center;gap:12px;min-width:0}' +
      '#ps-ub-brand{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;' +
      'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);font-size:11px;' +
      'color:rgba(255,255,255,.55);text-decoration:none;white-space:nowrap}' +
      '#ps-ub-brand:hover{background:rgba(255,255,255,.08);color:#fff}' +
      '#ps-ub-edit{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;' +
      'background:rgba(100,255,218,.06);border:1px solid rgba(100,255,218,.15);color:#64ffda;font-size:11px;' +
      'font-weight:600;text-decoration:none}' +
      '#ps-ub-edit:hover{background:rgba(100,255,218,.12)}' +
      '#ps-ub-msg{color:rgba(255,255,255,.7);font-size:13px;margin:0}#ps-ub-msg strong{color:#fff}' +
      '#ps-ub-right{display:flex;align-items:center;gap:10px}' +
      '#ps-ub-claim{padding:8px 22px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;' +
      'border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 12px rgba(124,58,237,.3);text-decoration:none;display:inline-block}' +
      '#ps-ub-claim:hover{transform:translateY(-2px)}' +
      '#ps-ub-x{background:none;border:none;color:rgba(255,255,255,.3);font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:50%}' +
      '#ps-ub-x:hover{color:#fff;background:rgba(255,255,255,.06)}' +
      '@media(max-width:600px){#ps-ub-msg{display:none}#ps-ub-inner{padding:8px 14px}}' +
      '@media print{#ps-upgrade-bar{display:none}}';

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var bar = document.createElement('aside');
    bar.id = 'ps-upgrade-bar';
    bar.setAttribute('aria-label', 'Register this website');
    bar.innerHTML =
      '<div id="ps-ub-inner">' +
      '<div id="ps-ub-left">' +
      '<a id="ps-ub-brand" href="' +
      buildUrl +
      '" target="_blank" rel="noopener" data-ps-cta="brand">Built on ProjectSites</a>' +
      '<a id="ps-ub-edit" href="' +
      editUrl +
      '" data-ps-cta="edit_with_ai">Edit with AI</a>' +
      '</div>' +
      '<p id="ps-ub-msg"><strong>This website is yours</strong> — make it official</p>' +
      '<div id="ps-ub-right">' +
      '<a id="ps-ub-claim" href="' +
      editUrl +
      '" data-ps-cta="claim">Register Now</a>' +
      '<button id="ps-ub-x" aria-label="Dismiss">&times;</button>' +
      '</div></div>';
    document.body.appendChild(bar);

    // reveal after 25s OR 40% scroll, matching the server bar's behavior
    var revealed = false;
    var doReveal = function () {
      if (revealed) return;
      revealed = true;
      bar.className = 'ps-in';
    };
    setTimeout(doReveal, 25000);
    var onScroll = function () {
      var h = document.documentElement;
      var denom = (h.scrollHeight || 1) - h.clientHeight;
      var pct = denom > 0 ? (h.scrollTop || document.body.scrollTop) / denom : 0;
      if (pct >= 0.4) {
        doReveal();
        window.removeEventListener('scroll', onScroll);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    var x = document.getElementById('ps-ub-x');
    if (x)
      x.addEventListener('click', function () {
        bar.style.display = 'none';
      });
  }

  /* ─────────────────── Sentry / PostHog (inert by default) ───────────────────
   * The Worker intentionally does NOT inject telemetry keys into served sites:
   * SENTRY_DSN is documented "never injected into child sites" (types/env.ts) and
   * site_serving.ts states the standing policy that served business sites are not
   * surveilled. So on live sites both initializers below read an empty seam AND an
   * absent attribute and early-return. They stay as a seam for a host that DOES
   * choose to populate 'window.__PS_TELEMETRY__'. Both fail-soft: an absent key
   * returns early — no SDK download, no throw, no render block.
   */
  function initSentryStub() {
    // Seam-first, mirroring initPosthogStub: a host that supplies the seam wins;
    // the 'data-sentry-dsn' attribute is the secondary channel, so reading ONLY it
    // would fall through to the empty-string fallback and silently early-return.
    var DSN = PS_CONFIG.SENTRY_DSN || attr('data-sentry-dsn', '');
    if (!DSN) return; // fail-soft: no key → no download, no init, no throw
    window.__PS_SENTRY__ = { dsn: DSN, init: function () {} };
    if (window.__PS_SENTRY_LOADED__) return;
    // Lazy-load the official @sentry/browser bundle off the explicit DSN version
    // (version-agnostic: the DSN path is stable across releases).
    try {
      var m = /^https:\\/\\/([a-f0-9]+)@([^/]+)\\//i.exec(DSN);
      if (!m) return;
      var v = '10.20.0';
      var s = document.createElement('script');
      s.src = 'https://browser.sentry-cdn.com/' + v + '/bundle.min.js';
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = function () {
        try {
          var S = window.Sentry;
          if (!S || !S.init) return;
          window.__PS_SENTRY_LOADED__ = true;
          S.init({
            dsn: DSN,
            release: 'projectsites-' + SLUG,
            environment: 'production',
            sendDefaultPii: false,
            tracesSampleRate: 0
          });
          window.__PS_SENTRY__.init = function () {};
        } catch (e) {}
      };
      document.head.appendChild(s);
    } catch (e) {
      /* telemetry must never break the page */
    }
  }

  function initPosthogStub() {
    var KEY = PS_CONFIG.POSTHOG_KEY || attr('data-posthog-key', '');
    if (!KEY) return; // fail-soft: no key → no init, no throw
    var HOST = PS_CONFIG.POSTHOG_HOST || attr('data-posthog-host', 'https://us.i.posthog.com');
    window.__PS_POSTHOG__ = { key: KEY, host: HOST, capture: function () {} };
    // posthog-js is injected server-side per site (the Worker already owns the
    // deprecated-UI-host guard + the CSP allowlist). If it landed, initialize it
    // against the ingestion host and hand the in-memory client to callers.
    try {
      var ph = window.posthog;
      if (!ph || typeof ph.init !== 'function') return;
      ph.init(KEY, {
        api_host: HOST,
        persistence: 'memory',
        capture_pageview: false,
        autocapture: true
      });
      window.__PS_POSTHOG__.capture = function (ev, props) {
        try {
          ph.capture(ev, props);
        } catch (e) {}
      };
    } catch (e) {
      /* telemetry must never break the page */
    }
  }

  /* ───────────────────────── Concierge chat ───────────────────────── */
  // Floating AI concierge — the 4th universal-runtime piece. Answers visitor
  // questions via POST /api/chat/<slug> (Workers AI RAG over the site's own
  // research profile). Self-removes if the endpoint 404s (operator killswitch).
  function injectConcierge() {
    if (document.getElementById('ps-cc-fab')) return;
    var BRAND = (function () {
      try {
        var t = (document.title || '').split(/\\s[|\\u2013\\u2014\\-]\\s/)[0];
        return (t && t.trim()) || 'us';
      } catch (e) {
        return 'us';
      }
    })();
    function ccEsc(s) {
      var d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }
    var fabBottom = PAID ? '20px' : '84px';
    var panelBottom = PAID ? '88px' : '150px';
    var css =
      '#ps-cc-fab{position:fixed;right:20px;bottom:' + fabBottom + ';z-index:2147483000;width:56px;height:56px;' +
      'border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#00e5ff,#50aae3);color:#04121a;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;transition:transform .18s ease}' +
      '#ps-cc-fab:hover{transform:translateY(-2px) scale(1.04)}' +
      '#ps-cc-fab:focus-visible{outline:3px solid #00e5ff;outline-offset:3px}' +
      '#ps-cc-fab svg{width:26px;height:26px}' +
      '#ps-cc-panel{position:fixed;right:20px;bottom:' + panelBottom + ';z-index:2147483000;' +
      'width:min(380px,calc(100vw - 40px));height:min(540px,calc(100vh - 170px));background:#0b1220;color:#e8eefc;' +
      'border:1px solid rgba(255,255,255,.1);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.5);display:none;' +
      'flex-direction:column;overflow:hidden;font:14px/1.5 system-ui,sans-serif;opacity:0;transform:translateY(12px)}' +
      '#ps-cc-panel.ps-open{display:flex;animation:ps-cc-in .22s ease forwards}' +
      '@keyframes ps-cc-in{to{opacity:1;transform:translateY(0)}}' +
      '@media(prefers-reduced-motion:reduce){#ps-cc-panel.ps-open{animation:none;opacity:1;transform:none}#ps-cc-fab{transition:none}}' +
      '#ps-cc-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#00e5ff,#50aae3);color:#04121a}' +
      '#ps-cc-head b{font-size:15px}#ps-cc-head span{font-size:12px;opacity:.85}' +
      '#ps-cc-x{margin-left:auto;background:none;border:none;color:#04121a;font-size:22px;line-height:1;cursor:pointer;width:30px;height:30px;border-radius:50%}' +
      '#ps-cc-x:hover{background:rgba(0,0,0,.12)}' +
      '#ps-cc-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}' +
      '.ps-cc-m{max-width:82%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}' +
      '.ps-cc-u{align-self:flex-end;background:linear-gradient(135deg,#00e5ff,#50aae3);color:#04121a;border-bottom-right-radius:4px}' +
      '.ps-cc-a{align-self:flex-start;background:rgba(255,255,255,.07);border-bottom-left-radius:4px}' +
      '.ps-cc-t{align-self:flex-start;color:rgba(232,238,252,.6);font-style:italic}' +
      '#ps-cc-form{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.08)}' +
      '#ps-cc-input{flex:1;resize:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);' +
      'color:#e8eefc;border-radius:12px;padding:10px 12px;font:14px/1.4 system-ui,sans-serif;max-height:90px}' +
      '#ps-cc-input:focus{outline:none;border-color:#00e5ff}' +
      '#ps-cc-input::placeholder{color:rgba(232,238,252,.45)}' +
      '#ps-cc-send{background:linear-gradient(135deg,#00e5ff,#50aae3);color:#04121a;border:none;border-radius:12px;padding:0 16px;font-weight:600;cursor:pointer}' +
      '#ps-cc-send:disabled{opacity:.5;cursor:default}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'ps-cc-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Chat with ' + BRAND);
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.8-5.4A8.5 8.5 0 1 1 21 11.5z"></path></svg>';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'ps-cc-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', BRAND + ' concierge chat');
    panel.innerHTML =
      '<div id="ps-cc-head"><b>' + ccEsc(BRAND) + '</b><span>Concierge</span>' +
      '<button id="ps-cc-x" type="button" aria-label="Close chat">&times;</button></div>' +
      '<div id="ps-cc-log" aria-live="polite"></div>' +
      '<form id="ps-cc-form"><textarea id="ps-cc-input" rows="1" placeholder="Ask a question..." aria-label="Your message"></textarea>' +
      '<button id="ps-cc-send" type="submit">Send</button></form>';
    document.body.appendChild(panel);

    var log = panel.querySelector('#ps-cc-log');
    var input = panel.querySelector('#ps-cc-input');
    var sendBtn = panel.querySelector('#ps-cc-send');
    var form = panel.querySelector('#ps-cc-form');
    var hist = [];
    var greeted = false;
    var dead = false;

    function addMsg(role, text) {
      var el = document.createElement('div');
      el.className = 'ps-cc-m ' + (role === 'user' ? 'ps-cc-u' : 'ps-cc-a');
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }
    function openPanel() {
      panel.classList.add('ps-open');
      if (!greeted) {
        greeted = true;
        addMsg('assistant', 'Hi! Ask me anything about ' + BRAND + ' — services, what to expect, or how to get started.');
      }
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
      try { track('concierge_open', {}); } catch (e) {}
    }
    function closePanel() {
      panel.classList.remove('ps-open');
      try { fab.focus(); } catch (e) {}
    }
    fab.addEventListener('click', function () {
      if (panel.classList.contains('ps-open')) closePanel();
      else openPanel();
    });
    panel.querySelector('#ps-cc-x').addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('ps-open')) closePanel();
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 90) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = (input.value || '').trim();
      if (!msg || dead) return;
      addMsg('user', msg);
      hist.push({ role: 'user', content: msg });
      try { track('concierge_message', {}); } catch (e) {}
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      var typing = document.createElement('div');
      typing.className = 'ps-cc-m ps-cc-t';
      typing.textContent = 'Typing...';
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;
      fetch(API + '/api/chat/' + encodeURIComponent(SLUG), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg, history: hist.slice(-6) }),
        mode: 'cors',
        credentials: 'omit'
      }).then(function (r) {
        if (r.status === 404) { dead = true; throw new Error('disabled'); }
        return r.json();
      }).then(function (j) {
        try { typing.remove(); } catch (e) {}
        var reply = (j && j.data && j.data.reply) || 'Sorry, I could not answer that. Please use the contact form.';
        addMsg('assistant', reply);
        hist.push({ role: 'assistant', content: reply });
        sendBtn.disabled = false;
      }).catch(function () {
        try { typing.remove(); } catch (e) {}
        if (dead) { try { fab.remove(); panel.remove(); } catch (e) {} return; }
        addMsg('assistant', 'I am having trouble right now. Please use the contact form and the team will reply soon.');
        sendBtn.disabled = false;
      });
    });
  }

  /* ─────────────────── Core Web Vitals (first-party RUM) ─────────────────── */
  // Field measurement of LCP / INP / CLS via PerformanceObserver, beaconed as
  // 'web_vital' events (metric+value+href) on page hide. Values use the standard
  // algorithms — final LCP frozen at first interaction, CLS session-window max,
  // INP p98-longest-interaction — so they line up with CrUX/Cloudflare field data.
  // HONESTY CONTRACT: a metric is reported ONLY if its observer attached AND a
  // value exists. An unmeasured metric (unsupported browser / no interaction) is
  // OMITTED, never sent as a fabricated 0 (LCP/CLS/INP are Chromium-only APIs).
  function initWebVitals() {
    if (typeof PerformanceObserver === 'undefined') return;
    var support = { LCP: false, CLS: false, INP: false, FCP: false };
    var lcp = -1;
    var fcp = -1;
    var clsMax = 0, clsCur = 0, clsFirst = 0, clsLast = 0;
    var inpMap = {}, inpCount = 0;
    var done = false;

    // ms for LCP/INP; unitless (3-decimal) for CLS. NaN/negative never sent.
    function report(metric, value) {
      if (value < 0 || value !== value) return;
      var v = metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value);
      track('web_vital', { metric: metric, value: v, href: location.pathname });
    }
    // Group event-timing entries by interactionId; an interaction's latency is
    // the MAX duration across its entries (keydown+keyup share one id).
    function recordInteraction(id, dur) {
      if (id == null) return;
      var k = 'i' + id;
      if (inpMap[k] === undefined) { inpCount++; inpMap[k] = dur; }
      else if (dur > inpMap[k]) { inpMap[k] = dur; }
    }
    function inpValue() {
      var d = [], k;
      for (k in inpMap) { if (inpMap.hasOwnProperty(k)) d.push(inpMap[k]); }
      if (!d.length) return -1;
      d.sort(function (a, b) { return b - a; });
      // p98-longest-interaction: index = floor(interactionCount / 50).
      return d[Math.min(d.length - 1, Math.floor(inpCount / 50))];
    }
    function obs(type, extra, cb) {
      try {
        var o = new PerformanceObserver(function (l) { l.getEntries().forEach(cb); });
        var init = { type: type, buffered: true };
        if (extra) { for (var kk in extra) init[kk] = extra[kk]; }
        o.observe(init);
        return o;
      } catch (e) { return null; }
    }

    var lcpO = obs('largest-contentful-paint', null, function (e) { lcp = e.startTime; });
    if (lcpO) { support.LCP = true; }
    // LCP is only valid up to the first user interaction — freeze it there.
    var freezeLcp = function () { try { if (lcpO) lcpO.disconnect(); } catch (e) {} };
    ['keydown', 'pointerdown', 'click'].forEach(function (t) {
      try { window.addEventListener(t, freezeLcp, { once: true, capture: true, passive: true }); } catch (e) {}
    });

    if (obs('layout-shift', null, function (e) {
      if (e.hadRecentInput) { return; }
      var t = e.startTime;
      if (clsCur && t - clsLast < 1000 && t - clsFirst < 5000) { clsCur += e.value; clsLast = t; }
      else { clsCur = e.value; clsFirst = t; clsLast = t; }
      if (clsCur > clsMax) { clsMax = clsCur; }
    })) { support.CLS = true; }

    var inpO = obs('event', { durationThreshold: 40 }, function (e) {
      if (e.interactionId) { recordInteraction(e.interactionId, e.duration); }
    });
    var fiO = obs('first-input', null, function (e) {
      recordInteraction(e.interactionId || 'fi', e.duration);
    });
    if (inpO || fiO) { support.INP = true; }

    // FCP (First Contentful Paint) — page-load speed, not a Core Web Vital but the
    // real-user "how fast did something appear" signal. From the paint observer.
    if (obs('paint', null, function (e) {
      if (e.name === 'first-contentful-paint') { fcp = e.startTime; }
    })) { support.FCP = true; }

    // Beacon once, on the first of visibilitychange:hidden / pagehide (unload-safe
    // via track()'s keepalive fetch).
    function finalize() {
      if (done) { return; }
      done = true;
      if (support.LCP && lcp >= 0) { report('LCP', lcp); }
      if (support.CLS) { report('CLS', clsMax); }      // 0 is a real (perfect) CLS
      if (support.INP) { report('INP', inpValue()); }  // omitted when no interaction
      if (support.FCP && fcp >= 0) { report('FCP', fcp); }
      // TTFB (Time To First Byte) — server response latency, from Navigation Timing's
      // responseStart (no observer needed). This is the first-party page-load metric
      // that Cloudflare's plan won't give us at the edge. Omitted when unavailable.
      try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.responseStart > 0) { report('TTFB', nav.responseStart); }
      } catch (e) {}
    }
    try {
      window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { finalize(); }
      }, { capture: true });
      window.addEventListener('pagehide', finalize, { capture: true });
    } catch (e) {}
  }

  /* ─────────────────── First-party JS-error beacon ─────────────────── */
  // Uncaught errors + unhandled rejections become a 'js_error' event, so an owner sees
  // when their LIVE site is throwing (Cloudflare's plan exposes no client-error dataset).
  // Deduped by message (once/session), capped (<=5/session), message truncated, and
  // self-guarded (a throw inside the beacon never re-beacons).
  function initErrorBeacon() {
    var seen = {};
    var count = 0;
    function report(message, source, line) {
      try {
        if (!message || count >= 5) { return; }
        var msg = String(message).slice(0, 300);
        if (seen[msg]) { return; }
        seen[msg] = 1;
        count++;
        track('js_error', {
          message: msg,
          source: source ? String(source).slice(0, 300) : undefined,
          line: typeof line === 'number' ? line : undefined,
        });
      } catch (e) {}
    }
    try {
      window.addEventListener('error', function (e) {
        // Only real JS errors — resource-load failures (img/script 404) have no '.message'.
        if (e && e.message) { report(e.message, e.filename, e.lineno); }
      });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        var m = r && r.message ? r.message : (typeof r === 'string' ? r : 'Unhandled promise rejection');
        report(m);
      });
    } catch (e) {}
  }

  /* ─────────────────── Time-on-page (engagement) beacon ─────────────────── */
  // Dwell time = interactive → the FIRST visibilitychange:hidden / pagehide, beaconed once
  // as a 'page_engagement' event ({duration_ms, href}) via track()'s keepalive fetch. The
  // first-party engagement signal — how long visitors actually stay — which Cloudflare's plan
  // has no dataset for. Honest bounds: ignore <1s (bounce/bot noise) and >30min (an abandoned
  // open tab, not real dwell) so a future median-time-on-page card isn't skewed by non-engagement.
  function initEngagement() {
    var start = Date.now();
    var sent = false;
    function beacon() {
      if (sent) { return; }
      sent = true;
      var dur = Date.now() - start;
      if (dur < 1000 || dur > 1800000) { return; }
      track('page_engagement', { duration_ms: dur, href: location.pathname });
    }
    try {
      window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { beacon(); }
      }, { capture: true });
      window.addEventListener('pagehide', beacon, { capture: true });
    } catch (e) {}
  }

  /* ─────────────────── Scroll-depth beacon ─────────────────── */
  // Max % of page height a visit reached (initial above-the-fold coverage, then the deepest
  // point scrolled to), beaconed once on the first visibilitychange:hidden / pagehide as a
  // 'scroll_depth' event ({percent, href}). First-party content-consumption signal — how far
  // visitors actually get — which Cloudflare's plan has no dataset for. A page that fits the
  // viewport (not scrollable) reports 100 (they saw all of it). HONESTY: percent is clamped
  // 0–100; a page with no measurable height is SKIPPED (never a fabricated sample).
  function initScrollDepth() {
    var maxPct = 0;
    var sent = false;
    function depthNow() {
      var doc = document.documentElement || {};
      var body = document.body || {};
      var sh = Math.max(doc.scrollHeight || 0, body.scrollHeight || 0);
      var ch = doc.clientHeight || window.innerHeight || 0;
      if (sh <= 0 || ch <= 0) { return -1; }
      if (sh <= ch) { return 100; } // fits the viewport → fully seen, no scroll needed
      var st = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
      var pct = Math.round(((st + ch) / sh) * 100);
      if (sh - (st + ch) <= 2) { pct = 100; } // 2px bottom tolerance → treat as complete
      return pct < 0 ? 0 : (pct > 100 ? 100 : pct);
    }
    function sample() {
      var d = depthNow();
      if (d > maxPct) { maxPct = d; }
    }
    function beacon() {
      if (sent) { return; }
      sent = true;
      sample();
      if (maxPct <= 0) { return; } // nothing measurable → no fabricated sample
      track('scroll_depth', { percent: maxPct, href: location.pathname });
    }
    try {
      sample(); // initial above-the-fold coverage
      window.addEventListener('scroll', sample, { passive: true });
      window.addEventListener('resize', sample, { passive: true });
      window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { beacon(); }
      }, { capture: true });
      window.addEventListener('pagehide', beacon, { capture: true });
    } catch (e) {}
  }

  /* ─────────────────── Network-quality beacon ─────────────────── */
  // The visitor's navigator.connection estimate (effectiveType / downlink / rtt / saveData),
  // beaconed once on load as a 'network_quality' event. First-party signal for "what
  // connections are my visitors on" — which Cloudflare's plan has no dataset for. HONESTY:
  // navigator.connection is CHROMIUM-ONLY (Chrome / Edge / Android); on Safari / Firefox the
  // object is absent and NOTHING is sent (never a fabricated sample), so the metric is an
  // explicit SUBSET the admin card labels as Chromium-only. Only present, valid fields are sent.
  function initNetworkQuality() {
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) { return; } // not supported → no sample (honest omission)
      var payload = { href: location.pathname };
      if (typeof c.effectiveType === 'string' && c.effectiveType) { payload.effective_type = c.effectiveType; }
      if (typeof c.downlink === 'number' && isFinite(c.downlink) && c.downlink >= 0) { payload.downlink = c.downlink; }
      if (typeof c.rtt === 'number' && isFinite(c.rtt) && c.rtt >= 0) { payload.rtt = c.rtt; }
      if (typeof c.saveData === 'boolean') { payload.save_data = c.saveData; }
      // Only beacon when at least one real connection field was present (never an empty sample).
      if (payload.effective_type === undefined && payload.downlink === undefined &&
          payload.rtt === undefined && payload.save_data === undefined) { return; }
      track('network_quality', payload);
    } catch (e) {}
  }

  /* ───────────────────────── Boot ───────────────────────── */
  onReady(function () {
    try {
      pageview();
    } catch (e) {}
    try {
      initWebVitals();
    } catch (e) {}
    try {
      initErrorBeacon();
    } catch (e) {}
    try {
      initEngagement();
    } catch (e) {}
    try {
      initScrollDepth();
    } catch (e) {}
    try {
      initNetworkQuality();
    } catch (e) {}
    try {
      document.addEventListener('click', onClick, true);
    } catch (e) {}
    try {
      document.addEventListener('submit', onSubmit, true); // capture phase
      bindForms();
      if (typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () {
          bindForms();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (e) {}
    try {
      injectUpgradeBar();
    } catch (e) {}
    try {
      injectConcierge();
    } catch (e) {}
    try {
      initSentryStub();
      initPosthogStub();
    } catch (e) {}
  });
})();
`;
