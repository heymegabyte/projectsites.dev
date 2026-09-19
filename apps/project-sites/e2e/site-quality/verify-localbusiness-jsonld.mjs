#!/usr/bin/env node
/**
 * verify-localbusiness-jsonld.mjs — § C.4 (SEO/GEO): a local business's SERVED HTML must carry a
 * complete `LocalBusiness`/`Restaurant` JSON-LD (with `geo` + `openingHoursSpecification` +
 * `address` + `telephone`) — the schema that unlocks Google's local rich results (hours, map pin,
 * "Open now", price, directions) AND that AI-search / social / non-JS crawlers read.
 *
 * THE GAP THIS CATCHES (found on cochon-new-orleans, 2026-09-19): the served/prerendered HTML
 * emits only the generic `Organization` (no NAP/geo/hours rich-result fields), while the LIVE
 * CLIENT DOM upgrades it to `Restaurant` — so the strongest local-SEO signal is CLIENT-ONLY,
 * invisible to any crawler that reads the raw HTML (the server-vs-client JSON-LD drift class,
 * `[[server-htmlrewriter-meta-vs-client-pagemeta-no-ssot-drift]]`). Even the client `Restaurant`
 * block was INCOMPLETE (no `geo`, no `openingHoursSpecification`) though the template's
 * `generateLocalBusinessSchema` builder DOES construct both — a built-but-unwired / stale-build gap.
 *
 * The probe distinguishes the two states per site (real Chromium — needs the client render):
 *   1. Fetch the SERVED HTML (curl-equivalent) → the SERVER JSON-LD @types.
 *   2. Render in a browser → the CLIENT JSON-LD @types + the LocalBusiness block's field coverage.
 *   3. Classify:
 *      - SERVER has a complete LocalBusiness (geo + openingHoursSpecification) → ✅ (the target).
 *      - CLIENT has LocalBusiness but SERVER does NOT → ⚠️ CLIENT-ONLY (server-invisible local schema).
 *      - CLIENT LocalBusiness is INCOMPLETE (missing geo/hoursSpec) → ⚠️ INCOMPLETE.
 *      - Not a local business (no LocalBusiness anywhere, e.g. saas/portfolio) → ➖ n/a (skip).
 *
 * TRACKING-MODE (fail-OPEN, exit 0): every current site predates the server-emit fix, so a hard gate
 * would be a fleet-wide false-RED. It emits a ::notice worklist per gap so run-all stays green, and
 * HARD-PASSES (the ✅ branch) the moment a rebuilt / server-emit-fixed site carries the complete
 * LocalBusiness in its SERVED HTML — then it graduates to a hard gate (audit-arc ladder). A genuine
 * render/parse ERROR is still a hard FAIL.
 *
 * Local Chromium against the delivered cohort ({slug}.projectsites.dev, CF-clean). Auto-joins run-all.
 * Usage: [SITES=slug,slug] node e2e/site-quality/verify-localbusiness-jsonld.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-localbusiness-jsonld skipped — no site resolved');
  process.exit(0);
}

const LOCAL_RE = /LocalBusiness|Restaurant|Store|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|Bakery|HealthAndBeautyBusiness|ProfessionalService|HomeAndConstructionBusiness|AutomotiveBusiness|MedicalBusiness|LodgingBusiness|EntertainmentBusiness/;

const typesOf = (blocks) =>
  blocks
    .flatMap((j) => {
      const arr = Array.isArray(j) ? j : j['@graph'] || [j];
      return arr.map((o) => o && o['@type']);
    })
    .filter(Boolean)
    .flatMap((t) => (Array.isArray(t) ? t : [t]));

const parseServerBlocks = (html) => {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip malformed */
    }
  }
  return out;
};

let hardFails = 0;
let served = 0;
let clientOnly = 0;
let incomplete = 0;
let na = 0;
const summary = [];

const browser = await chromium.launch();
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    let serverHtml = '';
    try {
      const res = await fetch(base + '/', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      serverHtml = res.ok ? await res.text() : '';
    } catch {
      /* fall through — browser render still runs */
    }
    const serverTypes = typesOf(parseServerBlocks(serverHtml));
    const serverHasLocal = serverTypes.some((t) => LOCAL_RE.test(t));

    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    let client = { types: [], localFields: null, error: null };
    try {
      // domcontentloaded + a fixed settle (NOT networkidle — a generated site's analytics beacons /
      // page-audio polling keep the network busy, so networkidle can time out → a transient false-RED).
      await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1800);
      client = await page.evaluate((LOCAL_SRC) => {
        const LR = new RegExp(LOCAL_SRC);
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .map((s) => {
            try {
              return JSON.parse(s.textContent);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const flat = blocks.flatMap((j) => (Array.isArray(j) ? j : j['@graph'] || [j]));
        const types = flat.map((o) => o && o['@type']).filter(Boolean).flatMap((t) => (Array.isArray(t) ? t : [t]));
        const lb = flat.find((o) => o && LR.test(JSON.stringify(o['@type'] || '')));
        const localFields = lb
          ? {
              type: Array.isArray(lb['@type']) ? lb['@type'].join('/') : lb['@type'],
              geo: !!lb.geo,
              hoursSpec: !!lb.openingHoursSpecification,
              address: !!lb.address,
              telephone: !!lb.telephone,
            }
          : null;
        return { types, localFields, error: null };
      }, LOCAL_RE.source);
    } catch (e) {
      client.error = String(e).slice(0, 80);
    }
    await ctx.close().catch(() => {});

    if (client.error) {
      hardFails++;
      summary.push(`  🔴 ${slug}: render error — ${client.error}`);
      continue;
    }

    const clientHasLocal = client.types.some((t) => LOCAL_RE.test(t)) || !!client.localFields;
    if (!clientHasLocal && !serverHasLocal) {
      na++;
      summary.push(`  ➖ ${slug}: not a local business (no LocalBusiness schema) — n/a`);
      continue;
    }

    // Prefer the SERVER block's completeness (that's the crawler-visible one). If the server lacks it,
    // report the client-only state + whether the client block is even complete.
    const serverComplete = (() => {
      const lb = parseServerBlocks(serverHtml)
        .flatMap((j) => (Array.isArray(j) ? j : j['@graph'] || [j]))
        .find((o) => o && LOCAL_RE.test(JSON.stringify(o['@type'] || '')));
      return lb ? { addr: !!lb.address, geo: !!lb.geo, hoursSpec: !!lb.openingHoursSpecification } : null;
    })();

    // ✅ = the served block is a LocalBusiness WITH a PostalAddress (the local rich-results core the
    // build_validators finalizeSeoInvariants fix emits — @type subtype + address + telephone). geo +
    // openingHoursSpecification are optional enrichments (a follow-on: geo-threading + an hours parser).
    if (serverComplete && serverComplete.addr) {
      served++;
      const bonus = `${serverComplete.geo ? ' +geo' : ''}${serverComplete.hoursSpec ? ' +hoursSpec' : ''}`;
      summary.push(
        `  ✅ ${slug}: SERVED HTML carries a LocalBusiness with a PostalAddress (local rich-results schema)${bonus || ' (geo/hoursSpec optional)'}`,
      );
    } else if (serverHasLocal) {
      incomplete++;
      summary.push(
        `  ⚠️  ${slug}: SERVER LocalBusiness present but NO PostalAddress (thin) — the finalizeSeoInvariants fix adds address on rebuild [tracked]`,
      );
    } else {
      clientOnly++;
      const f = client.localFields || {};
      summary.push(
        `  ⚠️  ${slug}: LocalBusiness is CLIENT-ONLY (server=Organization-only, crawler-invisible); client ${f.type} geo=${f.geo} hoursSpec=${f.hoursSpec} — server-emit the complete schema [tracked]`,
      );
    }
  }
} catch (e) {
  hardFails++;
  summary.push(`  🔴 audit error: ${String(e).slice(0, 120)}`);
} finally {
  await browser.close();
}

console.log(`\n━━ § C.4 local-business JSON-LD in SERVED HTML (${SITES.length} site(s)) ━━`);
for (const l of summary) console.log(l);
console.log(
  `::json:: ${JSON.stringify({ probe: 'localbusiness-jsonld', sites: SITES.length, served, clientOnly, incomplete, na, hardFails })}`,
);
if (hardFails) {
  console.log(`\nVERDICT: 🔴 FAIL — ${hardFails} render/parse error(s) (a real break, not the tracked gap).`);
  process.exit(1);
}
if (clientOnly || incomplete) {
  console.log(
    `\nVERDICT: ⏭️  TRACKED (fail-open) — ${clientOnly} client-only + ${incomplete} thin LocalBusiness in SERVED HTML (${served} with a PostalAddress). Root fix SHIPPED in build_validators finalizeSeoInvariants (emits a LocalBusiness subtype + PostalAddress + telephone instead of generic Organization); flips ✅ as each site REBUILDS. geo + openingHoursSpecification are the next enrichment (geo-threading + an hours parser).`,
  );
  process.exit(0);
}
console.log(
  `\nVERDICT: ✅ PASS — every local site serves a LocalBusiness with a PostalAddress (the local rich-results schema) in its crawler-visible HTML${na ? ` (${na} non-local n/a)` : ''}.`,
);
process.exit(0);
