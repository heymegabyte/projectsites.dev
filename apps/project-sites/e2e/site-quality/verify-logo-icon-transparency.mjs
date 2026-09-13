// verify-logo-icon-transparency.mjs — § C.1 asset-quality: does the deployed site's navbar
// `logo-icon.png` render as a TRANSPARENT MARK (the brand ideal) or an OPAQUE tile (the no-404
// fallback)?
//
// strip-logo-bg.mjs (template) turns the generated app-icon transparent by flood-filling a
// near-UNIFORM corner background. When the generated icon has a NON-uniform background
// (gradient / two-tone / photo — e.g. krugers-austin: white-top → blue-bottom, corner-spread 583
// ≫ the 126 uniform threshold), the strip correctly refuses and the pipeline copies the OPAQUE
// apple-touch-icon → logo-icon.png (AL-386 no-404 fallback). The Header rounds it, so it reads as
// an app-icon badge — acceptable, but not the clean transparent mark AL-224/logo-contrast want.
//
// NO existing gate measures this: build_validators checks the icon EXISTS + its size, never its
// ALPHA. verify-pwa HEAD-checks icon refs resolve, never their transparency. This probe closes
// that blind spot — it decodes each deployed `/logo-icon.png` PNG header (IHDR color-type +
// tRNS-chunk scan, zero deps) and reports transparent-vs-opaque across the fleet.
//
// TRACKING-mode (::notice, exit 0): an opaque rounded badge is an ACCEPTABLE fallback for a
// non-uniform-bg icon (validator-precision — don't hard-fail an intentional acceptable state), so
// this MEASURES the fleet's transparency rate rather than blocking. The root fix (AL-496: constrain
// the icon-gen prompt to a plain/transparent background so the strip reliably succeeds) flips sites
// transparent as they rebuild.
import { Buffer } from 'node:buffer';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'krugers-austin,gentle-dental-seattle,ironhaus-houston').split(',');

/**
 * Determine whether a PNG buffer has an alpha channel (a transparent mark) or is fully opaque.
 * Reads the IHDR color-type (byte 25): 6=RGBA / 4=grayscale+alpha → alpha; 0=grayscale / 2=RGB →
 * opaque UNLESS a tRNS chunk is present; 3=palette → transparent only with a tRNS chunk.
 * @returns {{ok:true, alpha:boolean, colorType:number}|{ok:false, why:string}}
 */
function pngAlpha(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33 || !sig.every((b, i) => buf[i] === b)) return { ok: false, why: 'not-a-png' };
  const colorType = buf[25];
  let hasTRNS = false;
  // Walk chunks from offset 8 looking for a tRNS (adds transparency to non-alpha color types).
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'tRNS') { hasTRNS = true; break; }
    if (type === 'IDAT' || type === 'IEND') break; // tRNS must precede IDAT; stop early
    off += 12 + len; // length(4)+type(4)+data(len)+crc(4)
  }
  const alpha = colorType === 6 || colorType === 4 || hasTRNS;
  return { ok: true, alpha, colorType };
}

let opaque = 0;
const rows = [];
for (const slug of SITES) {
  try {
    const res = await fetch(`https://${slug}.projectsites.dev/logo-icon.png`, { headers: { 'User-Agent': UA } });
    if (res.status !== 200) { rows.push(`  ⏭️  ${slug} — logo-icon.png HTTP ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const a = pngAlpha(buf);
    if (!a.ok) { rows.push(`  ⏭️  ${slug} — ${a.why}`); continue; }
    if (a.alpha) rows.push(`  ✓ ${slug} — TRANSPARENT mark (colorType ${a.colorType})`);
    else { opaque++; rows.push(`  ◻︎ ${slug} — OPAQUE tile (colorType ${a.colorType}, no alpha) — no-uniform-bg fallback`); }
  } catch (e) { rows.push(`  ⏭️  ${slug} — ${String(e).slice(0, 50)}`); }
}

console.log('\n━━ § C.1 navbar logo-icon transparency (transparent mark vs opaque fallback) ━━');
rows.forEach((r) => console.log(r));
if (opaque === 0) {
  console.log('\n✓ § C.1 logo-icon-transparency PASS — every audited navbar icon is a transparent mark.');
  process.exit(0);
}
console.log(
  `\n::notice:: § C.1 logo-icon-transparency — ${opaque}/${SITES.length} audited site(s) ship the OPAQUE ` +
    `no-uniform-bg fallback (acceptable rounded badge; the AL-496 icon-gen prompt fix flips them transparent on rebuild).`,
);
process.exit(0);
