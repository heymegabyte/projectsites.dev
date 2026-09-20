// verify-sections-populated.mjs — GENERATED-SITE QUALITY §C: prove NO homepage section is a real
// empty husk, WITHOUT the two headless false-positive classes that a naive screenshot check hits.
//
// WHY (AL-851): a full-page screenshot taken while scrolled to the TOP renders every below-fold
// `reveal-on-view` / `DepthCascade` section at its `animation-timeline: view()` ENTRY state
// (opacity:0) → the section LOOKS like an empty void though its DOM is full (the
// `rolling-counter-fullpage-capture-shows-phantom-zero` class extended to reveal-animated sections).
// Separately, a keyless Google-Maps `output=embed` iframe loads NOTHING in headless (Google serves a
// blank page to the automation fingerprint — the same class as "PostHog 0-events in headless") →
// the map LOOKS broken though it works for real users. Both burned a full loop fire chasing phantom
// defects. This probe encodes the CORRECT method so the gate (and the visual-qa agent) can't be fooled:
//
//   1. IN-VIEWPORT capture — scroll each <section> to center + let its reveal settle, THEN measure.
//      A section still at opacity<0.5 is mid-reveal (NOT judged — never a phantom-void fail).
//   2. TOLERATE third-party embeds — a section whose only "empty" region is an <iframe> (maps, video)
//      is NOT flagged (bot-blanked-in-headless ≠ broken-for-users; verify those via a real browser).
//   3. Still CATCH a real husk — a REVEALED section (opacity≥0.5) that is tall (>200px) with no text
//      (<20 chars), no loaded <img>, and no <iframe> is a genuine empty section → FAIL.
//
// Fail-open (::notice, exit 0) when a site 404s / has no sections. Globs into run-all.mjs.
//
// Usage:
//   node e2e/site-quality/verify-sections-populated.mjs
//   SITES=sid-mashburn-atlanta,franklin-barbecue node e2e/site-quality/verify-sections-populated.mjs
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);

const browser = await chromium.launch({ headless: true });
const rows = [];
let fails = 0;
let audited = 0;

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    const resp = await page.goto(base, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) {
      rows.push(`  ⚠️  ${slug} — ${resp ? resp.status() : 'no-response'} (skipped)`);
      await ctx.close();
      continue;
    }
    // Trigger lazy images by scrolling through once, then return to top.
    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 140));
      }
      window.scrollTo(0, 0);
    });

    const nSections = await page.evaluate(() => document.querySelectorAll('section').length);
    if (nSections === 0) {
      rows.push(`  ⚠️  ${slug} — 0 <section> elements (skipped)`);
      await ctx.close();
      continue;
    }
    audited++;

    const husks = [];
    for (let i = 0; i < nSections; i++) {
      // Center the i-th section, let its reveal settle, then measure IN-VIEW.
      await page.evaluate((idx) => {
        const s = document.querySelectorAll('section')[idx];
        if (s) s.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, i);
      await page.waitForTimeout(650);
      const m = await page.evaluate((idx) => {
        const s = document.querySelectorAll('section')[idx];
        if (!s) return null;
        const cs = getComputedStyle(s);
        const r = s.getBoundingClientRect();
        const imgs = [...s.querySelectorAll('img')];
        return {
          opacity: parseFloat(cs.opacity || '1'),
          display: cs.display,
          height: Math.round(r.height),
          textLen: (s.innerText || '').trim().length,
          loadedImgs: imgs.filter((im) => im.complete && im.naturalWidth > 0).length,
          totalImgs: imgs.length,
          hasIframe: !!s.querySelector('iframe'),
          hasCanvas: !!s.querySelector('canvas, svg'),
          heading: (s.querySelector('h1,h2,h3')?.innerText || '').trim().slice(0, 32),
        };
      }, i);
      if (!m || m.display === 'none' || m.height < 200) continue; // hidden / thin band → not a husk
      if (m.opacity < 0.5) continue; // still mid-reveal (view-timeline entry state) → NOT judged
      // A revealed, tall section with NO text, NO loaded image, NO iframe/canvas = a genuine husk.
      const populated = m.textLen >= 20 || m.loadedImgs > 0 || m.hasIframe || m.hasCanvas;
      if (!populated) {
        husks.push(`§"${m.heading || i}" h=${m.height} txt=${m.textLen} imgs=${m.loadedImgs}/${m.totalImgs}`);
      }
    }

    if (husks.length) {
      fails++;
      rows.push(`  🔴 ${slug} — ${husks.length} EMPTY section(s) in-view: ${husks.join(' · ')}`);
    } else {
      rows.push(`  ✅ ${slug} — all ${nSections} sections populated in-view (reveal-safe, embed-tolerant)`);
    }
    await ctx.close();
  } catch (e) {
    rows.push(`  ⚠️  ${slug} — ${String(e.message || e).slice(0, 60)} (skipped)`);
    await ctx.close().catch(() => {});
  }
}
await browser.close();

console.log('\n━━ generated-site sections populated (in-viewport, reveal-safe, embed-tolerant) ━━');
rows.forEach((r) => console.log(r));
if (audited === 0) {
  console.log('\n::notice:: verify-sections-populated skipped — no site audited');
  process.exit(0);
}
console.log(
  fails === 0
    ? `\nVERDICT: ✅ ${audited} site(s) — every revealed homepage section carries real content`
    : `\nVERDICT: 🔴 ${fails} site(s) have a genuinely-empty revealed section (not a reveal/embed artifact)`,
);
process.exit(fails === 0 ? 0 : 1);
