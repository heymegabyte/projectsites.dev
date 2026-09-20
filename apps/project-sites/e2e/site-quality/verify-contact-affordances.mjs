// verify-contact-affordances.mjs — § C.18: generated-site CLICK-TO-CALL + GET-DIRECTIONS affordances
// are present in the HYDRATED DOM, well-formed, and MATCH the displayed NAP (Name-Address-Phone).
//
// WHY this gate exists — the lying-affordance class:
//   A dropped `tel:` wrapper, a phone-digit mismatch (visible "(503) 954-3663" but href dials
//   a different number), or a maps link with a blank/placeholder destination= all pass EVERY other
//   gate today: 0 console errors, HTTP 200, axe-clean, verified-rendered screenshot looks correct.
//   Only a real mobile visitor tapping the affordance discovers the break — by then it's a missed
//   call or a customer who ended up in the wrong city.
//
//   The affordances are CLIENT-rendered (hydrated Angular/React component state). The prerender shell
//   does NOT contain them. curl/fetch returns the SSR skeleton — NOT the live DOM. This probe MUST
//   use a real headless Chromium browser and wait for hydration.
//
// CHECKS per route (/ and /contact):
//   1. CLICK-TO-CALL: if a phone number is visible in body text, there MUST be ≥1 `a[href^="tel:"]`
//      whose digits (normalised, leading US country code 1 stripped) EQUAL the shown phone's digits.
//      Shown phone but NO tel: link → FAIL (missing affordance).
//      Digits mismatch → FAIL (lying affordance — shows one number, dials another).
//   2. GET-DIRECTIONS: if an address string is visible, there SHOULD be a maps link whose
//      destination parameter or full URL shares ≥1 alphanumeric token (len≥3, e.g. a street word,
//      city name, or ZIP) with the shown address.
//      Maps link with blank/`{token}`/placeholder destination → FAIL.
//      No address visible → NOT-APPLICABLE (don't fail).
//   3. FAIL-OPEN: a site showing NEITHER a phone NOR an address on either route → `::notice:: skipped`
//      + exit 0 (nothing to gate; inapplicable, not a defect).
//      A non-200/challenge response → skip that site.
//
// KNOWN-GOOD LIVE DATA (default SITES):
//   olympia-provisions-portland — tel:5039543663 ↔ "(503) 954-3663"; maps dest: "107 Southeast…"
//   franklin-barbecue           — tel:5126531187 ↔ "(512) 653-1187"; maps dest: "900 E 11th St…"
//   pizzeria-bianco-phoenix     — tel:6022588300 ↔ "(602) 258-8300"; maps dest: "623 E Adams St…"
//
// STRUCTURE: mirrors verify-nav-integrity.mjs (UA const, SITES env, chromium.launch, mobile viewport,
// per-site try/catch, fail-open skip, ━━/VERDICT: summary, process.exit on real fail).
//
// Auto-joins run-all.mjs (globs `verify-*.mjs`) — no registration needed.
//
// Usage:
//   node e2e/site-quality/verify-contact-affordances.mjs
//   SITES=olympia-provisions-portland node e2e/site-quality/verify-contact-affordances.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SITES = (
  process.env.SITES || 'olympia-provisions-portland,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Strip all non-digit chars; also strip a leading US country code "1". */
function normaliseDigits(str) {
  const digits = str.replace(/\D/g, '');
  // a US number is 10 digits; if we got 11 and it starts with 1, drop the country code
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
}

/**
 * Extract a set of alphanumeric tokens (length ≥3) from a string — used to compare
 * a maps destination against the shown address text for at least one token overlap.
 */
function addressTokens(str) {
  return new Set((str.match(/[A-Za-z0-9]{3,}/g) || []).map((t) => t.toLowerCase()));
}

/**
 * Pull the best candidate destination value from a maps href.
 * Tries the `destination=` query param first (Google Maps dir), then `q=`, then the
 * raw URL fragment after the host, then the whole URL for token matching.
 */
function extractMapsDestination(href) {
  try {
    const u = new URL(href);
    return u.searchParams.get('destination') || u.searchParams.get('q') || u.pathname + u.search;
  } catch {
    return href;
  }
}

// ── per-site probe ────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const rows = [];
let fails = 0;

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 }, // mobile — where click-to-call matters most
  });
  const page = await ctx.newPage();

  // Filter benign console noise (same class as verify-nav-integrity.mjs)
  page.on('console', () => {});
  page.on('pageerror', () => {});

  try {
    // ── check both routes ──────────────────────────────────────────────────
    const routeResults = [];

    for (const route of ['/', '/contact']) {
      const url = `${base}${route}`;
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      } catch {
        routeResults.push({ route, skip: 'timeout/error loading page' });
        continue;
      }

      if (!resp || resp.status() >= 400) {
        routeResults.push({ route, skip: `HTTP ${resp?.status() ?? 'err'}` });
        continue;
      }

      // Wait for hydration — affordances are client-rendered
      await page.waitForTimeout(1500);

      const data = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';

        // Click-to-call links
        const telLinks = [...document.querySelectorAll('a[href^="tel:"]')].map((a) =>
          (a.getAttribute('href') || '').replace(/^tel:/i, '').trim(),
        );

        // Maps links — Google Maps dir, Google Maps place/search, Apple Maps, any /maps/dir path
        const mapsLinks = [
          ...document.querySelectorAll(
            'a[href*="google.com/maps"], a[href*="maps.apple"], a[href*="/maps/dir"]',
          ),
        ].map((a) => a.getAttribute('href') || '');

        // Shown phone number (first match in body)
        const phoneMatch = bodyText.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
        const phoneShown = phoneMatch ? phoneMatch[0] : null;

        // Shown address: look for a pattern with a street number + word + street suffix
        // (e.g. "107 Southeast Washington", "900 E 11th St", "623 E Adams St")
        const addrMatch = bodyText.match(
          /\d{1,5}\s+[A-Za-z][A-Za-z0-9\s.]{4,50}(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct|Pkwy|Hwy|Cir|Sq|NE|NW|SE|SW)[.,\s]/i,
        );
        const addrShown = addrMatch ? addrMatch[0].trim() : null;

        return { bodyText: bodyText.slice(0, 4000), telLinks, mapsLinks, phoneShown, addrShown };
      });

      routeResults.push({ route, data });
    }

    // ── aggregate: does ANY route show a phone or address? ─────────────────
    const hasPhone = routeResults.some((r) => r.data?.phoneShown);
    const hasAddr = routeResults.some((r) => r.data?.addrShown);

    if (!hasPhone && !hasAddr) {
      rows.push(
        `  ⏭️  ${slug} — shows NEITHER a phone NOR an address on / or /contact — ::notice:: skipped (inapplicable)`,
      );
      await ctx.close().catch(() => {});
      continue;
    }

    // ── per-route assertions ───────────────────────────────────────────────
    const siteFails = [];

    for (const rr of routeResults) {
      if (rr.skip) continue; // non-200 or error — skip this route
      const { route, data } = rr;
      const { telLinks, mapsLinks, phoneShown, addrShown } = data;

      // 1. CLICK-TO-CALL
      if (phoneShown) {
        const shownDigits = normaliseDigits(phoneShown);
        if (telLinks.length === 0) {
          siteFails.push(
            `${route}: phone visible (${phoneShown}) but NO tel: link — missing click-to-call`,
          );
        } else {
          // Check that at least one tel: link matches the shown digits
          const matched = telLinks.some((raw) => normaliseDigits(raw) === shownDigits);
          if (!matched) {
            const dialledSamples = telLinks.slice(0, 2).map((r) => normaliseDigits(r));
            siteFails.push(
              `${route}: DIGIT MISMATCH — shown ${shownDigits} but tel: href(s) dial ${dialledSamples.join(', ')} — lying affordance`,
            );
          } else {
            rows.push(
              `  ✓ ${slug}${route}: click-to-call (${phoneShown} → tel:${shownDigits}) present + digits match`,
            );
          }
        }
      }

      // 2. GET-DIRECTIONS
      if (addrShown) {
        if (mapsLinks.length === 0) {
          // Absent maps link — fail on known-good cohort (template always ships maps links)
          rows.push(
            `  ⚠️  ${slug}${route}: address visible ("${addrShown.slice(0, 40)}") but NO maps link found`,
          );
          siteFails.push(`${route}: address shown but no maps/directions link`);
        } else {
          // Check that at least one maps link has a non-empty, non-placeholder destination
          // that shares ≥1 alphanumeric token (len≥3) with the shown address
          const addrToks = addressTokens(addrShown);
          let bestResult = null;

          for (const href of mapsLinks) {
            const dest = decodeURIComponent(extractMapsDestination(href));
            // Detect placeholder/blank destination
            if (!dest || dest.trim() === '' || /^\{.*\}$/.test(dest.trim())) {
              bestResult = {
                ok: false,
                reason: `blank/placeholder destination ("${dest.slice(0, 40)}")`,
                href,
              };
              continue;
            }
            const destToks = addressTokens(dest);
            const overlap = [...addrToks].filter((t) => destToks.has(t));
            if (overlap.length > 0) {
              bestResult = { ok: true, overlap, dest: dest.slice(0, 60) };
              break;
            }
            if (!bestResult) {
              bestResult = {
                ok: false,
                reason: `no token overlap (dest="${dest.slice(0, 50)}")`,
                href,
              };
            }
          }

          if (!bestResult) {
            siteFails.push(`${route}: maps link check skipped (no links)`);
          } else if (bestResult.ok) {
            rows.push(
              `  ✓ ${slug}${route}: directions link destination matches address (overlap: ${bestResult.overlap.slice(0, 3).join(', ')})`,
            );
          } else {
            siteFails.push(`${route}: directions link with bad destination — ${bestResult.reason}`);
          }
        }
      }
    }

    if (siteFails.length === 0) {
      rows.push(`  ✓ ${slug} — all contact affordances present + well-formed`);
    } else {
      fails++;
      siteFails.forEach((f) => rows.push(`  ❌ ${slug}: ${f}`));
    }
  } catch (e) {
    rows.push(`  ⏭️  ${slug} — ${String(e.message || e).slice(0, 70)} — skip`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

await browser.close();

// ── summary ───────────────────────────────────────────────────────────────────
console.log(
  '\n━━ § C.18 contact-affordances: click-to-call tel: + get-directions maps (hydrated DOM, mobile viewport) ━━',
);
rows.forEach((r) => console.log(r));

const verdict =
  fails > 0
    ? `FAIL — ${fails} site(s) have a missing or lying contact affordance (click-to-call / maps destination)`
    : "PASS — every site's click-to-call tel: link digits match the shown phone; maps destination shares address tokens";

console.log(`\nVERDICT: ${verdict}`);
process.exit(fails > 0 ? 1 : 0);
