#!/usr/bin/env node
/**
 * verify-llms-txt-quality.mjs — § C.4 GEO (AI-search): does a deployed site's `/llms.txt`
 * (the AI-crawler manifest) ship BLANK / MALFORMED fields? Found AL-753 auditing a delivered
 * site: `franklin-barbecue`'s llms.txt carries a blank `Tagline:`, a blank `Hours:`, and a
 * malformed `Contact:   | (512)…` (empty email → a dangling leading `|`). An AI crawler
 * (ChatGPT/Perplexity/Gemini) reading these gets empty/broken business facts — a real GEO
 * quality defect that the count-based SEO gate can't see (llms.txt 200s + is non-empty).
 *
 * ROOT (documented, fixed in a later fire that can verify a real build): the build's token
 * substitution — `scripts/container-server.mjs` `fillTemplateTokens` — fills an ABSENT brand
 * field (`{BUSINESS_TAGLINE}`/`{BUSINESS_HOURS}`/`{BUSINESS_EMAIL}`) with `''` instead of
 * OMITTING the whole line, so `Tagline: {BUSINESS_TAGLINE}` → `Tagline: ` (blank) and
 * `Contact: {BUSINESS_EMAIL} | {BUSINESS_PHONE}` → `Contact:  | (512)…`. The fix = after
 * substitution, prune `^<Key>:\s*$` lines + collapse the dangling `|` on the Contact line.
 * (Same empty-token class as the existing `BUSINESS_DESCRIPTION` empty-meta fallback there.)
 *
 * MODE: REPORT by default (exit 0) — this is the audit-arc "Surface" step: it makes the gap
 * VISIBLE every run without red-ing the globbed suite while the build-baked fix is pending +
 * the cohort rebuilds. Set `STRICT=1` to gate (exit 1 on any finding) once the fix has landed
 * and the cohort is rebuilt clean — then it's the regression guard.
 *
 * `fetch`-based (text only). Local run against {slug}.projectsites.dev (CF-clean). Auto-joins
 * the globbed site-quality run-all. Usage: [SITES=slug,slug] [STRICT=1] node …/verify-llms-txt-quality.mjs
 */
import { resolveSites } from './_default-sites.mjs';

const SITES = resolveSites(process.env.SITES);
const STRICT = /^(1|true)$/i.test(process.env.STRICT || '');
if (SITES.length === 0) {
  console.log('::notice:: verify-llms-txt-quality skipped — no site resolved');
  process.exit(0);
}
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Structured llms.txt lines that MUST NOT ship blank/malformed. A real crawler reads these.
const KEYED = ['Tagline', 'Hours', 'Address', 'Site', 'Contact'];

/** Find the quality defects in one llms.txt body. Pure — unit-testable shape. */
function auditLlms(text) {
  const lines = text.split(/\r?\n/);
  const defects = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Za-z ]*?):\s*(.*)$/);
    if (!m || !KEYED.includes(m[1])) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'Contact') {
      // Malformed when a `|` separator has an empty side: " | phone" or "email | ".
      if (/^\s*\|/.test(val) || /\|\s*$/.test(val)) defects.push(`Contact malformed (dangling |): "${line.trim()}"`);
      else if (val.trim() === '') defects.push('Contact blank');
    } else if (val.trim() === '') {
      defects.push(`${key} blank`);
    }
  }
  return defects;
}

const rows = [];
for (const slug of SITES) {
  try {
    const res = await fetch(`https://${slug}.projectsites.dev/llms.txt`, { headers: { 'user-agent': UA } });
    if (res.status !== 200) { rows.push({ slug, ok: false, detail: `llms.txt status=${res.status}` }); continue; }
    const defects = auditLlms(await res.text());
    rows.push({ slug, ok: defects.length === 0, detail: defects.length ? defects.join(' · ') : 'clean' });
  } catch (e) {
    rows.push({ slug, ok: false, detail: 'fetch error: ' + String(e).slice(0, 80) });
  }
}

const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log(`  ${r.ok ? '✓' : '⚠'} ${r.slug.padEnd(34)} [${r.detail}]`);
console.log(`::json:: ${JSON.stringify({ probe: 'llms-txt-quality', mode: STRICT ? 'strict' : 'report', sites: SITES.length, withDefects: bad.length })}`);
if (bad.length) {
  console.log(
    `\n${STRICT ? '🔴 FAIL' : '::warning::'} — ${bad.length}/${rows.length} deployed site(s) ship a blank/malformed llms.txt field (AI-crawler GEO defect).` +
      `\n  ROOT: scripts/container-server.mjs fillTemplateTokens fills an absent field with '' instead of omitting the line.` +
      `\n  Fix + STRICT-promote in a fire that can verify a real build (currently ${STRICT ? 'STRICT' : 'REPORT'} mode).`,
  );
} else {
  console.log(`\nVERDICT: ✅ PASS — every audited site ships a clean llms.txt (no blank Tagline/Hours/Address + no dangling Contact |).`);
}
// Report mode never reds the suite; STRICT gates once the fix has landed + cohort rebuilt.
process.exit(STRICT && bad.length ? 1 : 0);
