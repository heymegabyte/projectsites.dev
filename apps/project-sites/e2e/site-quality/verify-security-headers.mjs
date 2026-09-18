#!/usr/bin/env node
/**
 * verify-security-headers.mjs — § C (security posture): do DEPLOYED generated sites carry the
 * required security headers on every response? The `quality-metrics` rule mandates HSTS +
 * CSP (with clickjacking protection) + X-Content-Type-Options + Referrer-Policy +
 * Permissions-Policy on the core product's public surface — and ~48 site-quality probes cover
 * CWV / SEO / a11y / JSON-LD / PWA / density, but **NONE asserts the security headers**. A
 * regression that stripped HSTS (downgrade attacks), dropped `frame-ancestors` (clickjacking),
 * or lost `nosniff` (MIME-confusion XSS) on `{slug}.projectsites.dev` would ship silently.
 * This gate closes that blind spot — the headers come from the Worker's global `securityHeaders`
 * middleware, so a break here is fleet-wide across every generated site at once.
 *
 * Per site it asserts:
 *   HTML routes (home + a discovered sub-page):
 *     • HSTS — `max-age ≥ 31536000` + `includeSubDomains` + `preload` (HSTS-preload eligible)
 *     • X-Content-Type-Options: nosniff
 *     • Referrer-Policy present (no-referrer-ish, not empty)
 *     • Permissions-Policy present (feature lock-down)
 *     • CSP present AND carries clickjacking protection (`frame-ancestors` — and NOT the wide-open
 *       `frame-ancestors *`, which would be no protection) AND `object-src 'none'`
 *   A real hashed asset (JS/CSS): HSTS + nosniff (assets don't need the full HTML policy set).
 *
 * `fetch`-based (headers only — no browser). Local run against {slug}.projectsites.dev (CF-clean).
 * Auto-joins run-all via the verify-*.mjs glob.  Usage: [SITES=slug,slug] node …/verify-security-headers.mjs
 */
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-security-headers skipped — no site resolved');
  process.exit(0);
}
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

/** Fetch a URL and return { status, h } where h(name) reads a header (lowercased), or null on error. */
async function get(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    const body = res.headers.get('content-type')?.includes('text/html') ? await res.text() : '';
    return { status: res.status, h: (n) => res.headers.get(n) || '', body };
  } catch {
    return null;
  }
}

/** Assert the HTML security-header contract on one response. */
function assertHtmlHeaders(slug, path, r) {
  if (!r || r.status >= 400) {
    check(`${slug}${path} · reachable`, false, `status=${r ? r.status : 'ERR'}`);
    return;
  }
  const hsts = r.h('strict-transport-security');
  const m = hsts.match(/max-age=(\d+)/);
  const maxAge = m ? Number(m[1]) : 0;
  check(`${slug}${path} · HSTS ≥1yr + includeSubDomains + preload`,
    maxAge >= 31536000 && /includeSubDomains/i.test(hsts) && /preload/i.test(hsts), `hsts="${hsts || '(none)'}"`);
  check(`${slug}${path} · X-Content-Type-Options: nosniff`, /nosniff/i.test(r.h('x-content-type-options')), `xcto="${r.h('x-content-type-options') || '(none)'}"`);
  check(`${slug}${path} · Referrer-Policy present`, r.h('referrer-policy').trim().length > 0, `rp="${r.h('referrer-policy') || '(none)'}"`);
  check(`${slug}${path} · Permissions-Policy present`, r.h('permissions-policy').trim().length > 0, `pp=${r.h('permissions-policy') ? 'set' : '(none)'}`);
  const csp = r.h('content-security-policy');
  const hasFrameAncestors = /frame-ancestors/i.test(csp);
  const wideOpenFA = /frame-ancestors\s+[^;]*\*/i.test(csp) && !/frame-ancestors\s+[^;]*(self|projectsites)/i.test(csp);
  check(`${slug}${path} · CSP clickjacking-safe (frame-ancestors, not \`*\`) + object-src 'none'`,
    csp.length > 0 && hasFrameAncestors && !wideOpenFA && /object-src\s+'none'/i.test(csp),
    csp ? `fa=${hasFrameAncestors} wideOpen=${wideOpenFA} objNone=${/object-src\s+'none'/i.test(csp)}` : '(no CSP)');
}

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const home = await get(`${base}/`);
  assertHtmlHeaders(slug, '/', home);

  // Discover a real sub-page (SPA internal link) + a real hashed asset from the home HTML.
  const html = home?.body || '';
  const subPath = (html.match(/href="(\/(?:about|contact|menu|services|gallery|reservations)[a-z-]*)"/i) || [])[1] || '';
  const assetPath = (html.match(/\/assets\/[a-zA-Z0-9._-]+\.(?:js|css)/) || [])[0] || '';

  if (subPath) assertHtmlHeaders(slug, subPath, await get(`${base}${subPath}`));

  if (assetPath) {
    const a = await get(`${base}${assetPath}`);
    if (a && a.status < 400) {
      const hsts = a.h('strict-transport-security');
      check(`${slug} · asset HSTS + nosniff`, /max-age=\d{6,}/i.test(hsts) && /nosniff/i.test(a.h('x-content-type-options')), `asset=${assetPath.slice(0, 40)}`);
    } else {
      check(`${slug} · asset reachable`, false, `asset=${assetPath} status=${a ? a.status : 'ERR'}`);
    }
  }
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(70)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'security-headers', sites: SITES.length, checks: rows.length, fails, pass: fails === 0 })}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} security-header gap(s) on deployed generated sites (fleet-wide: fix the Worker securityHeaders middleware)`
    : `\nVERDICT: ✅ PASS — every deployed generated site ships HSTS(preload) + nosniff + Referrer/Permissions-Policy + clickjacking-safe CSP on HTML + HSTS/nosniff on assets`,
);
process.exit(fails ? 1 : 0);
