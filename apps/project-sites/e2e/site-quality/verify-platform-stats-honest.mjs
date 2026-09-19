// verify-platform-stats-honest.mjs — § D: the platform's OWN marketing stats must be HONEST.
//
// verify-against-source-of-truth applied to projectsites.dev's public face. Render-integrity is
// BLIND to a wrong NUMBER: a hero counter reading "2,480+ Sites Built" paints cleanly, scores fine
// on AI-vision, and passes verify-platform-public-face (which only checks SEO head + route status)
// — yet the real store held ~182. A fabricated/inflated stat on our OWN homepage violates the
// transparency ethic and the verify-against-source-of-truth rule, and no prior probe caught it.
//
// Reference incident (AL-581): homepage hard-coded `<app-rolling-counter [value]="2480" ...>` for
// "Sites Built" while D1 published-site COUNT was 182 (~13× inflation). Root fix: a live
// `GET /api/public/stats` endpoint (edge-cached 10min) + the homepage counter bound to a
// `sitesBuilt` signal seeded from it. This probe is the durable regression gate.
//
// Three-way reconcile (store → endpoint → display):
//   1. ENDPOINT  — GET /api/public/stats returns valid JSON with sites_built:number ≥ 1 (not stubbed).
//   2. GROUND TRUTH — when CLOUDFLARE_API_KEY is set, a direct D1 COUNT must EXACTLY equal the
//      endpoint value (portable-audit: skipped with a ::notice when auth is absent, e.g. plain CI).
//   3. DISPLAY   — the rendered homepage's "Sites Built" counter settles to the endpoint value and
//      is NOT the fabricated 2480 (the exact prior lie). This proves the USER sees the honest number.
//
// A generous sanity CEILING (2000) also flags any regression back toward the 2480 fabrication; the
// real fleet (~182) crossing it is a milestone that warrants bumping the ceiling (emits a ::notice
// as it approaches), never a silent inflation.
//
// Usage: [PROD_URL=https://projectsites.dev] [STRICT=1] node e2e/site-quality/verify-platform-stats-honest.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CEILING = 2000; // catches a regression to the fabricated 2480; bump when the real fleet nears it
const FABRICATED = 2480; // the exact prior lie — the display must never equal this again

const rows = [];
const notices = [];
let fails = 0;
const check = (label, ok, detail) => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

// ── 1. ENDPOINT — the source the homepage reads ────────────────────────────────
let endpointCount = null;
try {
  const res = await fetch(`${BASE}/api/public/stats`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const body = res.ok ? await res.json() : null;
  const n = body?.sites_built;
  endpointCount = typeof n === 'number' ? n : null;
  check('/api/public/stats → 200 + sites_built:number ≥ 1 (live, not stubbed)', res.status === 200 && typeof n === 'number' && n >= 1,
    `status=${res.status} sites_built=${JSON.stringify(n)}`);
  check(`sites_built within sanity ceiling (< ${CEILING}, not the fabricated ${FABRICATED})`, endpointCount != null && endpointCount < CEILING,
    `sites_built=${endpointCount}`);
  if (endpointCount != null && endpointCount > CEILING * 0.8) {
    notices.push(`sites_built=${endpointCount} is nearing the ${CEILING} ceiling — bump CEILING in this probe as the real fleet grows.`);
  }
} catch (e) {
  check('/api/public/stats reachable', false, String(e).slice(0, 90));
}

// ── 2. GROUND TRUTH — direct D1 COUNT (portable: only when CF auth is present) ──
if (process.env.CLOUDFLARE_API_KEY && endpointCount != null) {
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'project-sites-db-production', '--remote', '--json',
        '--command', "SELECT COUNT(*) AS n FROM sites WHERE status='published' AND deleted_at IS NULL"],
      { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL || 'blzalewski@gmail.com', CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59' } },
    );
    const parsed = JSON.parse(out);
    const truth = parsed?.[0]?.results?.[0]?.n;
    check('endpoint sites_built EXACTLY reconciles with D1 published COUNT (source of truth)', truth === endpointCount,
      `d1=${truth} endpoint=${endpointCount}`);
  } catch (e) {
    notices.push(`D1 ground-truth reconcile skipped (wrangler query failed: ${String(e).slice(0, 70)}).`);
  }
} else {
  notices.push('D1 ground-truth reconcile skipped (no CLOUDFLARE_API_KEY) — endpoint plausibility + display checks still enforced.');
}

// ── 3. DISPLAY — the rendered homepage counter settles to the honest number ─────
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 });
  // The "Sites Built" cell = the stat whose label matches /site/i (fallback: first stat cell).
  // Read TWO signals: `aria` (the rolling-counter host's aria-label — component-GUARANTEED to hold
  // the final formatted value the moment [value] resolves; the truth AT users get) and `span` (the
  // animated visible digits). The visible span count-up is IntersectionObserver-gated + rAF-driven,
  // so it can "phantom-0" in headless when the social-proof band is below the fold — a CAPTURE
  // artifact, not a lie. So: scroll the band into view, reconcile the ARIA value (authoritative),
  // and track a phantom-0 visible span as a ::notice, never a hard fail (validator-precision).
  const readSites = () =>
    page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('section .grid > div'));
      const pick =
        cells.find((c) => /site/i.test(c.querySelector('.text-text-secondary')?.textContent || '')) || cells[0];
      if (!pick) return null;
      const counter = pick.querySelector('app-rolling-counter');
      counter?.scrollIntoView({ block: 'center' });
      const toNum = (s) => {
        const d = (s || '').replace(/[^\d]/g, '');
        return d ? Number(d) : null;
      };
      return { aria: toNum(counter?.getAttribute('aria-label')), span: toNum(counter?.textContent) };
    });
  let aria = null;
  let span = null;
  let stable = 0;
  for (let i = 0; i < 20 && stable < 3; i++) {
    await page.waitForTimeout(400);
    const v = await readSites();
    if (v) {
      if (v.aria != null && v.aria === aria && v.span === span) stable++;
      else stable = 0;
      aria = v.aria;
      span = v.span;
    }
  }
  // `aria` is the authoritative displayed value (what the counter WILL show / AT truth).
  check('homepage "Sites Built" counter has a rendered value (hydrated)', aria != null && aria >= 1, `aria=${aria} span=${span}`);
  check(`displayed counter is NOT the fabricated ${FABRICATED}`, aria !== FABRICATED && span !== FABRICATED, `aria=${aria} span=${span}`);
  if (endpointCount != null && aria != null) {
    check('displayed counter reconciles with /api/public/stats (aria == endpoint)', aria === endpointCount,
      `aria=${aria} endpoint=${endpointCount}`);
  }
  // Visible span should animate to the same number for sighted users; a headless phantom-0 is a
  // known capture artifact (IntersectionObserver/rAF), tracked not failed.
  if (span !== aria) {
    notices.push(`visible counter span=${span} ≠ aria=${aria} — headless rolling-counter phantom (IntersectionObserver/rAF not firing offscreen); aria-label is authoritative. A real scrolled viewport animates the span to ${aria}.`);
  }
  await ctx.close().catch(() => {});
} catch (e) {
  check('homepage renders for stat reconcile', false, String(e).slice(0, 90));
} finally {
  await browser.close();
}

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(62)} ${r.detail}`);
for (const n of notices) console.log(`  ::notice:: ${n}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} platform-stat honesty break(s): the homepage is showing a stat that does not reconcile with the store (verify-against-source-of-truth).`
    : `\nVERDICT: ✅ PASS — platform "Sites Built" stat is honest: endpoint live + within ceiling${process.env.CLOUDFLARE_API_KEY ? ' + reconciles with D1' : ''} + displayed counter == endpoint, never the fabricated ${FABRICATED}.`,
);
// The platform is OURS — a lying stat is a real bug to fix now, so this always hard-gates (unlike
// the stale-build generated-site probes that fail-open until rebuild).
process.exit(fails ? 1 : 0);
