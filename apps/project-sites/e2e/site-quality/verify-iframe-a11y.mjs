// verify-iframe-a11y.mjs — COMPLETION § C.3 (iframe leg): does every VISIBLE iframe on a
// DEPLOYED generated site carry a NON-EMPTY `title`? (WCAG 4.1.2 Name, Role, Value / axe
// `frame-title`.) A map / video / booking embed with no title (or a `title={var}` that resolved
// to "") is unreachable/unlabeled for screen-reader + AT users on the business's real site.
//
// WHY a DEDICATED probe (not "axe covers it"): axe's frame-title fires, but this probe is the
// PRECISE, durable runtime guard for the empty-RESOLVED-title class the template authoring test
// (src/components/iframe-title.test.ts) can't see — a `title={poster.alt}` / `title={title}` that
// ships "" passes the static "has title=" check but is still a violation. It also documents the
// deliberate EXCLUSION so it never false-reds: analytics libs inject a 1×1 `visibility:hidden`
// title-less <iframe> into <body> (a cross-frame messaging beacon) — that is NOT a user-facing
// frame and axe/AT ignore it, so we scope to VISIBLE (rendered, sized, not hidden) iframes only.
//
// Fixes are ROOT-CAUSE in the TEMPLATE (github.com/HeyMegabyte/template.projectsites.dev — lands
// next build) or the site-gen prompt — NEVER a one-off patch to one deployed site.
//
// Usage:
//   SITES=franklin-barbecue node e2e/site-quality/verify-iframe-a11y.mjs
//   node e2e/site-quality/verify-iframe-a11y.mjs            # default cohort
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);

let totalViolations = 0;
let auditedSites = 0;
const summary = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      // `load` not `networkidle` — generated sites keep a beacon/poll open (networkidle never settles).
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(700); // let deferred hydration + eager embeds (maps) mount
      const title = await page.title().catch(() => '');
      if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
        summary.push(`  ⚠️  ${slug}: not auditable (status ${resp?.status() ?? '?'} / challenge) — skipped`);
        await ctx.close().catch(() => {});
        continue;
      }
      auditedSites++;

      const frames = await page.evaluate(() => {
        const out = [];
        for (const f of Array.from(document.querySelectorAll('iframe'))) {
          const rect = f.getBoundingClientRect();
          const cs = getComputedStyle(f);
          // VISIBLE = a real user-facing frame: rendered, larger than a 1×1 beacon, not hidden.
          const visible =
            rect.width > 1 &&
            rect.height > 1 &&
            cs.visibility !== 'hidden' &&
            cs.display !== 'none' &&
            f.offsetParent !== null;
          const t = (f.getAttribute('title') || '').trim();
          out.push({ visible, hasTitle: t.length > 0, src: (f.src || '').slice(0, 48), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
        return out;
      });

      const visible = frames.filter((f) => f.visible);
      const hidden = frames.length - visible.length;
      const untitled = visible.filter((f) => !f.hasTitle);
      totalViolations += untitled.length;

      if (untitled.length === 0) {
        summary.push(
          `  ✅ ${slug}: ${visible.length} visible iframe(s), all titled` +
            (hidden ? ` (${hidden} hidden beacon iframe(s) correctly excluded)` : ''),
        );
      } else {
        summary.push(`  🔴 ${slug}: ${untitled.length}/${visible.length} visible iframe(s) MISSING a title:`);
        for (const f of untitled) summary.push(`       • ${f.w}×${f.h} src="${f.src}" — no title (WCAG 4.1.2)`);
      }
    } catch (err) {
      summary.push(`  ⚠️  ${slug}: load error (${String(err).slice(0, 60)}) — skipped`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log('\niframe a11y (WCAG 4.1.2 — every VISIBLE iframe titled) on deployed sites:');
for (const line of summary) console.log(line);

if (auditedSites === 0) {
  console.log('::notice:: verify-iframe-a11y skipped — no cohort site was auditable (all challenged / errored)');
  process.exit(0);
}
console.log(
  `\nVERDICT: ${totalViolations === 0 ? 'PASS' : 'FAIL'} — ${auditedSites} site(s) audited, ${totalViolations} untitled visible iframe(s)`,
);
process.exit(totalViolations === 0 ? 0 : 1);
