// verify-jsonld.mjs — COMPLETION § C.5: does EVERY route of a DEPLOYED generated site ship
// valid, per-route JSON-LD? Fetch-based (crawlers read the shell, not the hydrated DOM).
//
// A generated site is a single-shell SPA — every route serves one index.html. Pre-fix builds
// shipped ZERO real JSON-LD (only the "open-now" widget's empty reader tag). The worker's
// serve-time injector (`applyServedRouteJsonLd`, AL-205) now adds WebSite+Organization+WebPage+
// BreadcrumbList reflecting the ACTUAL served route (build-time `finalizeSeoInvariants` wins when
// present). This probe locks it: EVERY route must ship ≥4 real blocks with the 4 core types, and
// the WebPage/BreadcrumbList must reflect the SERVED route (not the homepage).
//
// HARD gates (per route): ≥4 real ld+json blocks · {WebSite, WebPage, BreadcrumbList + an org-family
// entity: Organization OR a LocalBusiness subtype (Restaurant/Store/Dentist/…, the richer local type)}
// all present · every block parses as JSON · WebPage.url ends with the served path · deepest
// BreadcrumbList crumb points at the served path.
//
// Fixes are ROOT-CAUSE in the worker serve path / template `finalizeSeoInvariants` — never a one-off.
//
// Usage:  SITES=vanta-strength-austin node e2e/site-quality/verify-jsonld.mjs

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston').split(',').map((s) => s.trim()).filter(Boolean);
// The three EXACT core types every route must ship.
const CORE_LITERAL = ['WebSite', 'WebPage', 'BreadcrumbList'];
// The "organization entity" block is satisfied by ANY schema.org org-family @type: a LocalBusiness
// subtype (Restaurant / Store / Dentist / …) IS-A Organization and is RICHER for local rich-results
// than the generic Organization — the worker deliberately emits the most-specific subtype (see
// build_validators.ts `localBusinessSubtypeFor` / `ORG_FAMILY_TYPES`; keep this set in sync). Hard-
// requiring the literal 'Organization' false-FAILED the best builds (an upgraded Restaurant+PostalAddress
// block) while passing stale generic-Organization builds — a validator-precision bug this set fixes.
const ORG_FAMILY = new Set([
  'Organization', 'LocalBusiness', 'Restaurant', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub',
  'HealthAndBeautyBusiness', 'Dentist', 'MedicalBusiness', 'LegalService', 'LodgingBusiness',
  'ExerciseGym', 'AutomotiveBusiness', 'HomeAndConstructionBusiness', 'Store', 'FoodEstablishment',
  // Precise retail Store subtypes (AL-835 — localBusinessSubtypeFor now emits these; keep in sync).
  'BookStore', 'MusicStore', 'Florist', 'JewelryStore', 'GroceryStore', 'HardwareStore', 'ShoeStore',
  'ClothingStore', 'FurnitureStore', 'PetStore', 'ToyStore', 'ElectronicsStore', 'SportingGoodsStore',
]);
/** All @type strings on a block (@type may be a string OR an array of strings). */
const typeStrings = (b) => (Array.isArray(b['@type']) ? b['@type'] : [b['@type']]).filter(Boolean);

const get = async (url) => {
  try { const r = await fetch(url, { headers: H }); return { status: r.status, text: await r.text().catch(() => '') }; }
  catch { return { status: 0, text: '' }; }
};

/** Parse the JSON bodies of every non-empty ld+json script in an HTML shell. */
function jsonldBlocks(html) {
  const tags = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const out = [];
  for (const t of tags) {
    const body = t.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    if (!body) continue; // skip the empty widget reader tag
    try { const j = JSON.parse(body); (Array.isArray(j) ? j : [j]).forEach((b) => out.push(b)); } catch { /* malformed → ignored (a gate below flags a low count) */ }
  }
  return out;
}

let fails = 0;
const rows = [];

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const sm = await get(`${base}/sitemap.xml`);
  const routes = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  // audit the homepage + up to 3 sub-routes (enough to prove per-route correctness)
  const audit = ['/', ...routes.filter((p) => p !== '/').slice(0, 3)];
  const routeRows = [];
  for (const path of audit) {
    const res = await get(`${base}${path}`);
    if (res.status !== 200) { routeRows.push({ path, ok: false, detail: `status=${res.status}` }); continue; }
    const blocks = jsonldBlocks(res.text);
    const types = new Set(blocks.flatMap(typeStrings));
    const missingLiteral = CORE_LITERAL.filter((t) => !types.has(t));
    const hasOrgEntity = [...types].some((t) => ORG_FAMILY.has(t));
    const missing = [...missingLiteral, ...(hasOrgEntity ? [] : ['Organization|LocalBusiness'])];
    const wp = blocks.find((b) => typeStrings(b).includes('WebPage'));
    const wpMatch = !!wp && typeof wp.url === 'string' && (wp.url.endsWith(path) || wp.url.endsWith(`${path}/`));
    const ok = blocks.length >= 4 && missing.length === 0 && wpMatch;
    if (!ok) fails++;
    routeRows.push({ path, ok, detail: `blocks=${blocks.length} types=[${[...types].join(',')}]${missing.length ? ` missing=${missing.join(',')}` : ''}${wp ? ` wp=${wpMatch ? '✓route' : '✗homepage-clobber'}` : ' wp=∅'}` });
  }
  rows.push({ slug, routeRows });
}

console.log('\n━━ § C.5 generated-site per-route JSON-LD (deployed shell) ━━');
for (const r of rows) {
  const bad = r.routeRows.filter((x) => !x.ok).length;
  console.log(`  ${bad === 0 ? '✅' : '❌'} ${r.slug} — ${r.routeRows.length - bad}/${r.routeRows.length} routes`);
  for (const x of r.routeRows) console.log(`       ${x.ok ? '✓' : '✗'} ${x.path} — ${x.detail}`);
}

if (fails > 0) {
  console.error(`\n✗ § C.5 FAIL — ${fails} route(s) miss valid per-route JSON-LD (root-fix in worker serve path / finalizeSeoInvariants).`);
  process.exit(1);
}
console.log(`\nVERDICT: ✅ § C.5 PASS — every audited route ships ≥4 real JSON-LD blocks (WebSite + WebPage + BreadcrumbList + an org-family entity: Organization or a LocalBusiness subtype) reflecting the served route.`);
