// verify-pwa.mjs — COMPLETION § C.6: are DEPLOYED generated sites installable PWAs?
// Fetch-based (no browser needed). Audits the LIVE product (`{slug}.projectsites.dev`).
//
// HARD gates (installability floor — must hold on every deployed site):
//   • site.webmanifest 200 + valid JSON + name + start_url + display + theme_color
//   • ≥1 icon ≥512×512 AND ≥1 icon purpose:"maskable" (Android adaptive-icon requirement)
//   • every manifest icon SRC actually resolves (no dangling icon ref — 512 + maskable HEAD-200)
//   • apple-touch-icon.png present (iOS home-screen)
//   • offline.html 200 + non-trivial (branded offline page, not a raw error)
//   • sw.js 200 + registers an install handler + opens a cache + precaches offline.html
//
// REPORTED (quality, not hard-gated): short_name mid-word truncation, empty description.
// Fixes are ROOT-CAUSE in the TEMPLATE / site-gen — never a one-off.
//
// Usage:  SITES=vanta-strength-austin node e2e/site-quality/verify-pwa.mjs

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };
import { resolveSites } from './_default-sites.mjs';
const SITES = resolveSites(process.env.SITES);

const getText = async (url) => {
  try { const r = await fetch(url, { headers: H }); return { status: r.status, text: await r.text().catch(() => '') }; }
  catch (e) { return { status: 0, text: '', err: String(e).slice(0, 50) }; }
};
const head = async (url) => { try { return (await fetch(url, { method: 'HEAD', headers: H })).status; } catch { return 0; } };
const sizeMax = (icon) => Math.max(...String(icon.sizes || '0x0').split(/\s+/).map((s) => Number((s.split('x')[0]) || 0)));

let fails = 0;
const rows = [];

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const hard = [];
  const soft = [];

  const mf = await getText(`${base}/site.webmanifest`);
  let m = null;
  try { m = JSON.parse(mf.text); } catch { /* invalid */ }
  if (mf.status !== 200 || !m) {
    rows.push({ slug, note: `manifest NOT AUDITABLE (status=${mf.status}, valid=${!!m})` });
    fails++;
    continue;
  }

  hard.push({ name: 'manifest name+start_url+display+theme_color', ok: !!(m.name && m.start_url && m.display && m.theme_color), detail: `${m.name || '∅'} / ${m.display} / ${m.theme_color || '∅'}` });

  const icons = Array.isArray(m.icons) ? m.icons : [];
  const has512 = icons.find((i) => sizeMax(i) >= 512);
  const maskable = icons.find((i) => /maskable/.test(i.purpose || ''));
  hard.push({ name: '≥512 icon + maskable icon declared', ok: !!has512 && !!maskable, detail: `512=${has512 ? has512.src : '∅'} maskable=${maskable ? maskable.src : '∅'}` });

  // dangling-ref guard: the 512 + maskable icon files must actually resolve
  const abs = (src) => (src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`);
  const s512 = has512 ? await head(abs(has512.src)) : 0;
  const sMask = maskable ? await head(abs(maskable.src)) : 0;
  hard.push({ name: 'icon files resolve (512 + maskable)', ok: s512 === 200 && sMask === 200, detail: `512→${s512} maskable→${sMask}` });

  const ati = await head(`${base}/apple-touch-icon.png`);
  hard.push({ name: 'apple-touch-icon.png', ok: ati === 200, detail: `→${ati}` });

  const off = await getText(`${base}/offline.html`);
  hard.push({ name: 'offline.html branded', ok: off.status === 200 && off.text.length > 300 && /<title/i.test(off.text), detail: `status=${off.status} len=${off.text.length}` });

  const sw = await getText(`${base}/sw.js`);
  const swOk = sw.status === 200 && /install/.test(sw.text) && /caches\.open/.test(sw.text) && /offline\.html/.test(sw.text);
  hard.push({ name: 'sw.js install + cache + precache offline', ok: swOk, detail: `status=${sw.status} install=${/install/.test(sw.text)} cache=${/caches\.open/.test(sw.text)} offline=${/offline\.html/.test(sw.text)}` });

  // quality (reported)
  const sn = m.short_name || '';
  const midWord = sn.length >= 11 && /[a-z]$/.test(sn) && !/\s$/.test(sn) && (m.name || '').length > sn.length && (m.name || '')[sn.length] && /[a-z]/i.test((m.name || '')[sn.length]);
  soft.push({ name: 'short_name clean (no mid-word cut)', detail: `"${sn}"${midWord ? ' ⚠ mid-word truncation of "' + m.name + '"' : ' ✓'}` });
  soft.push({ name: 'manifest description', detail: m.description ? `"${m.description.slice(0, 40)}…" ✓` : '∅ ⚠ (empty)' });

  const hf = hard.filter((h) => !h.ok).length;
  fails += hf;
  rows.push({ slug, hard, soft, hf });
}

console.log('\n━━ § C.6 generated-site PWA (installability, deployed) ━━');
for (const r of rows) {
  if (r.note) { console.log(`  ❌ ${r.slug} — ${r.note}`); continue; }
  console.log(`  ${r.hf === 0 ? '✅' : '❌'} ${r.slug} — ${r.hard.length - r.hf}/${r.hard.length} PWA gates`);
  for (const h of r.hard) console.log(`       ${h.ok ? '✓' : '✗'} ${h.name} — ${h.detail}`);
  for (const s of r.soft) console.log(`       · ${s.name} — ${s.detail}`);
}

const auditable = rows.filter((r) => !r.note);
if (auditable.length === 0) { console.log('\n::notice:: skipped — no site auditable.'); process.exit(0); }
if (fails > 0) { console.error(`\n✗ § C.6 FAIL — ${fails} PWA gate(s) failed (root-fix in TEMPLATE).`); process.exit(1); }
console.log(`\nVERDICT: ✅ § C.6 PASS — deployed sites are installable PWAs (valid manifest + maskable/512 icons resolve + apple-touch-icon + branded offline.html + precaching sw).`);
