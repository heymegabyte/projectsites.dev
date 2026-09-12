// verify-logo-assets.mjs — COMPLETION § C.1/C.6: does the navbar logo-icon ALWAYS
// resolve on a deployed site (no console-erroring 404)?
//
// WHY (AL-411): the template Header requests `/logo-icon.png` (the transparent Ideogram
// square mark) FIRST, with an apple-touch-icon `onError` fallback. But the flaky,
// budget-bound logo-gen only emits `logo-icon.png` on ~half of builds (measured 5/8
// sampled sites 404'd it), and the `onError` recovery STILL logs a hard 404 to the
// browser console (fails the 0-console-errors bar + a broken initial paint). The worker
// serve-path now falls `/logo-icon.png` misses back to the deterministically-emitted
// `apple-touch-icon.png` (a real brand icon, 200) at serve time — this probe guards that:
// `/logo-icon.png` MUST be a real 200 image on every deployed site, so the navbar icon
// never console-errors, no rebuild.
//
// HARD gate: GET /logo-icon.png → 200 + image content-type + non-trivial body.
// REPORTED (not gated): /logo-wordmark.png status — its Header fallback is the HTML
// text wordmark (visually fine); a square icon in the wordmark slot would be wrong, so
// it is intentionally NOT given the icon fallback. A future build-time presence signal
// can close its console-error-on-double-flake case.
//
// Usage:  SITES=blue-sky-vet-clinic-bend node e2e/site-quality/verify-logo-assets.mjs

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };
const SITES = (process.env.SITES || 'blue-sky-vet-clinic-bend,vanta-strength-austin,gentle-dental-seattle')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const getImg = async (url) => {
  try {
    const r = await fetch(url, { headers: H });
    const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    return { status: r.status, ct: r.headers.get('content-type') || '', bytes: buf.byteLength };
  } catch (e) {
    return { status: 0, ct: '', bytes: 0, err: String(e).slice(0, 50) };
  }
};
const head = async (url) => {
  try {
    return (await fetch(url, { method: 'HEAD', headers: H })).status;
  } catch {
    return 0;
  }
};

let fails = 0;
const rows = [];

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const icon = await getImg(`${base}/logo-icon.png`);
  const wordmark = await head(`${base}/logo-wordmark.png`);
  // HARD: logo-icon must be a real 200 image (real file OR the apple-touch serve-time fallback)
  const iconOk = icon.status === 200 && /image\//.test(icon.ct) && icon.bytes > 500;
  if (!iconOk) fails++;
  rows.push({ slug, icon, wordmark, iconOk });
}

console.log('\n━━ § C.1/C.6 navbar logo-icon resolves (deployed, AL-411 serve-time fallback) ━━');
for (const r of rows) {
  console.log(
    `  ${r.iconOk ? '✅' : '❌'} ${r.slug} — /logo-icon.png → ${r.icon.status} ${r.icon.ct || ''} ${r.icon.bytes}B` +
      `${r.iconOk ? '' : '  ✗ NOT a real 200 image (navbar icon will console-error a 404)'}`,
  );
  console.log(
    `       · /logo-wordmark.png → ${r.wordmark}${r.wordmark === 200 ? ' (real)' : ' (HTML text-wordmark fallback; not gated)'}`,
  );
}

if (rows.length === 0) {
  console.log('\n::notice:: skipped — no site to audit.');
  process.exit(0);
}
if (fails > 0) {
  console.error(
    `\n✗ § C.1/C.6 FAIL — ${fails} site(s) 404 /logo-icon.png → a broken navbar icon + console error. Root-fix the serve-time fallback in site_serving.ts (NOT a one-off).`,
  );
  process.exit(1);
}
console.log(
  '\nVERDICT: ✅ PASS — every audited site serves a real /logo-icon.png (real file or apple-touch fallback); the navbar icon never console-errors.',
);
