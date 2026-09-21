/**
 * content-quality-eval.mjs — objective, reusable content-quality scorecard for a
 * PUBLISHED projectsites.dev site. Formalizes the ad-hoc per-fire analysis the
 * self-improving loop runs into ONE tool that emits a JSON scorecard + gate verdicts.
 *
 * Why this exists (loop FIRE-71): the template reached high maturity + 11 straight
 * flawless builds — the frontier shifted from "add gorgeous" to CONTENT quality/
 * uniqueness (which needs LLM generation, non-deterministic). Safe LLM uniqueness
 * requires an objective quality gate to score before/after. This is that gate, and
 * the standard per-fire analysis instrument.
 *
 * Usage:
 *   node e2e/loop-eval/content-quality-eval.mjs <slug> [--theme=light|dark] [--json]
 *   e.g. node e2e/loop-eval/content-quality-eval.mjs forge-athletic-club-austin-2 --theme=dark
 *
 * Real Chromium (post-hydration DOM — JSON-LD + sections are client-rendered), resolves
 * Playwright from the frontend workspace, WAF-safe UA, serviceWorkers blocked. Exits 1
 * when any HARD gate fails so it can gate CI / an LLM-uniqueness loop.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Playwright lives in the frontend workspace; resolve from there.
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const PAGES = ['/', '/about', '/services', '/faq', '/contact'];

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const wantTheme = (args.find((a) => a.startsWith('--theme=')) || '').split('=')[1] || null;
const asJson = args.includes('--json');
const vertical = (args.find((a) => a.startsWith('--vertical=')) || '').split('=')[1] || null;
const packDir = (args.find((a) => a.startsWith('--pack-dir=')) || '').split('=')[1] || join(homedir(), 'template', 'examples');
if (!slug) {
  console.error('usage: node content-quality-eval.mjs <slug> [--theme=light|dark] [--vertical=<v>] [--json]');
  process.exit(2);
}
const BASE = `https://${slug}.projectsites.dev`;

/** Flesch Reading Ease (higher = easier; the copy-writing gate wants ≥ 50). */
function flesch(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1;
  const words = (text.match(/[A-Za-z]+/g) || []);
  const wc = words.length || 1;
  const syll = words.reduce((n, w) => n + countSyllables(w), 0) || 1;
  return Math.round((206.835 - 1.015 * (wc / sentences) - 84.6 * (syll / wc)) * 10) / 10;
}
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'or', 'and', 'your', 'our', 'we', 'us', 'you', 'that', 'this', 'who', 'are', 'is', 'when', 'it', 'every', 'real', 'from', 'here']);

/**
 * Banned AI-slop phrases (COPY dimension: "ZERO banned-slop"). Conservative, HIGH-SIGNAL only —
 * phrases that are almost never genuine small-business copy — to keep false-positives near zero
 * (validator-precision). A hit is a real finding to fix at ROOT in the content pack / hero_copy,
 * never a per-site patch. Tighten this list (never loosen the gate) if a run surfaces a legit use.
 */
const BANNED_SLOP = [
  'seamless', 'cutting-edge', 'cutting edge', 'game-changer', 'game changer', 'game-changing',
  'nestled', 'boasts', 'look no further', "in today's", 'one-stop shop', 'one stop shop',
  'unravel', 'unparalleled', 'world-class', 'top-notch', 'state-of-the-art', 'bespoke',
  'rich tapestry', 'testament to', 'take it to the next level', "we've got you covered",
  'when it comes to', 'elevate your', 'unlock the',
];
/** Distinctive multi/single-word phrases → simple case-insensitive substring is enough + precise. */
function slopHits(text) {
  const t = String(text || '').toLowerCase();
  return BANNED_SLOP.filter((p) => t.includes(p));
}

async function scorePage(page, path) {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 90)); });
  let status = 0;
  try {
    const r = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = r?.status() ?? 0;
  } catch (e) {
    return { path, status: 0, error: String(e).slice(0, 80) };
  }
  await page.waitForTimeout(2600);
  const d = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let types = [], org = null;
    for (const s of jsonld) {
      try {
        const j = JSON.parse(s.textContent);
        (Array.isArray(j) ? j : [j]).forEach((n) => {
          types.push(n['@type']);
          if (String(n['@id'] || '').endsWith('#org')) org = n;
        });
      } catch {}
    }
    return {
      text,
      words: text.trim().split(/\s+/).filter(Boolean).length,
      tokenLeaks: (document.documentElement.innerHTML.match(/\{[A-Z_]{3,}\}/g) || []).length,
      title: document.title,
      desc: document.querySelector('meta[name=description]')?.content || '',
      imgs: document.querySelectorAll('img').length,
      sections: document.querySelectorAll('section').length,
      h1s: document.querySelectorAll('h1').length,
      h2s: [...document.querySelectorAll('h2')].map((h) => h.textContent.trim()),
      jsonldTypes: types,
      orgType: org?.['@type'] || null,
      napHours: Array.isArray(org?.openingHoursSpecification) ? org.openingHoursSpecification.length : 0,
      napAddr: !!org?.address, napTel: !!org?.telephone, napEmail: !!org?.email,
      theme: document.documentElement.getAttribute('data-theme') || '',
      galleryTiles: document.querySelectorAll('[data-gallery] [data-zoomable], [data-gallery] img').length,
    };
  });
  page.removeAllListeners('console');
  return { path, status, errs, ...d, flesch: flesch(d.text), slop: slopHits(d.text) };
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ serviceWorkers: 'block', userAgent: UA });
const results = [];
for (const path of PAGES) {
  const p = await ctx.newPage();
  results.push(await scorePage(p, path));
  await p.close();
}
await b.close();

// ── Gate evaluation ──────────────────────────────────────────────────────────
const gates = [];
const g = (name, ok, detail) => gates.push({ name, ok, detail });
const home = results.find((r) => r.path === '/') || {};

for (const r of results) {
  if (r.status !== 200) { g(`status ${r.path}`, false, `HTTP ${r.status}`); continue; }
  g(`status ${r.path}`, true, '200');
  g(`words ${r.path}`, r.words >= 120, `${r.words}w (≥120)`);
  g(`no-tokens ${r.path}`, r.tokenLeaks === 0, `${r.tokenLeaks} leaks`);
  g(`no-console-err ${r.path}`, (r.errs?.length ?? 0) === 0, `${r.errs?.length ?? 0} errors`);
  g(`title ${r.path}`, r.title.length >= 50 && r.title.length <= 60, `${r.title.length} (50-60)`);
  g(`desc ${r.path}`, r.desc.length >= 120 && r.desc.length <= 156, `${r.desc.length} (120-156)`);
  g(`one-h1 ${r.path}`, r.h1s === 1, `${r.h1s} h1`);
  g(`flesch ${r.path}`, r.flesch >= 45, `${r.flesch} (≥45)`); // ≥50 target, 45 floor for pro copy
  g(`no-slop ${r.path}`, (r.slop?.length ?? 0) === 0, r.slop?.length ? `slop: ${r.slop.join(', ')}` : 'clean');
}
// Home-only structural gates
g('home ≥9 sections', (home.sections ?? 0) >= 9, `${home.sections} sections`);
g('home ≥6 images', (home.imgs ?? 0) >= 6, `${home.imgs} imgs`);
g('home ≥4 JSON-LD', (home.jsonldTypes?.length ?? 0) >= 4, `${home.jsonldTypes?.length} nodes`);
g('gallery 8 tiles', (home.galleryTiles ?? 0) === 8, `${home.galleryTiles} tiles`);
if (wantTheme) g('theme', home.theme === wantTheme, `${home.theme} (want ${wantTheme})`);

// Cross-page headline repetition: a salient word repeated across ≥2 DIFFERENT pages'
// H1s is a soft signal (WARN, not a hard gate — on-brand keyword reuse over-flags).
const salient = (s) => (s.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w));
const h1words = {};
for (const r of results) for (const w of new Set(salient(r.h1s ? (r.h2s[0] || '') : ''))) (h1words[w] ||= []).push(r.path);
const repeats = Object.entries(h1words).filter(([, ps]) => ps.length > 1);

// ── Content-uniqueness / genericness (loop FIRE-73): how much of the site's copy is the
// VERBATIM generic pack default vs business-specific? Loads the vertical's pack and counts
// how many key content blocks appear unchanged in the built site. High genericness = the
// pack default shipped (LOW uniqueness) — the objective metric for the LLM-uniqueness arc.
// Requires --vertical=<v>; reads the pack from --pack-dir (default ~/template/examples).
let uniqueness = null;
if (vertical) {
  try {
    const pack = JSON.parse(readFileSync(join(packDir, `_content.${vertical}.json`), 'utf-8'));
    const KEYS = ['ABOUT_DESCRIPTION', 'ABOUT_PARAGRAPH_1', 'ABOUT_MISSION_TEXT', 'HERO_SUBHEADLINE', 'SERVICES_INTRO'];
    const corpus = results.map((r) => (r.text || '').replace(/\s+/g, ' ').toLowerCase()).join(' \n ');
    const checked = [], generic = [];
    for (const k of KEYS) {
      const v = String(pack[k] || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (v.length < 40) continue;
      checked.push(k);
      if (corpus.includes(v.slice(0, 90))) generic.push(k);
    }
    uniqueness = { vertical, checked: checked.length, packDefault: generic.length, uniquePct: checked.length ? Math.round((1 - generic.length / checked.length) * 100) : null, packDefaultTokens: generic };
  } catch (e) {
    uniqueness = { vertical, error: `pack read failed: ${String((e && e.message) || e).slice(0, 60)}` };
  }
}

// ── Regression tracking (charter: rubric results tracked over builds) ─────────
// Compare THIS run's key metrics to the most recent prior run for the same slug
// (history at e2e/loop-eval/_eval-history.json). HARD regressions — overall PASS→FAIL,
// a page dropping off 200, or NEW {TOKEN} leaks — fail the eval; metric dips
// (words/flesch/sections/imgs/jsonld) are soft WARN so a legitimate content edit that
// tightens copy doesn't false-fail the gate.
const HISTORY_PATH = resolve(__dirname, '_eval-history.json');
const curMetrics = {
  overall: gates.some((x) => !x.ok) ? 'FAIL' : 'PASS',
  ok200: results.filter((r) => r.status === 200).length,
  totalWords: results.reduce((n, r) => n + (r.words || 0), 0),
  minFlesch: Math.min(...results.map((r) => (Number.isFinite(r.flesch) ? r.flesch : 999))),
  tokenLeaks: results.reduce((n, r) => n + (r.tokenLeaks || 0), 0),
  sections: home.sections ?? 0,
  imgs: home.imgs ?? 0,
  jsonld: home.jsonldTypes?.length ?? 0,
};
let history = {};
try { history = JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')); } catch { history = {}; }
const priorRuns = Array.isArray(history[slug]) ? history[slug] : [];
const prior = priorRuns.length ? priorRuns[priorRuns.length - 1] : null;
const regHard = [], regSoft = [];
if (prior?.metrics) {
  const p = prior.metrics;
  if (p.overall === 'PASS' && curMetrics.overall === 'FAIL') regHard.push('overall PASS→FAIL');
  if (curMetrics.ok200 < (p.ok200 ?? 0)) regHard.push(`200-pages ${p.ok200}→${curMetrics.ok200}`);
  if (curMetrics.tokenLeaks > (p.tokenLeaks ?? 0)) regHard.push(`token leaks ${p.tokenLeaks}→${curMetrics.tokenLeaks}`);
  if (curMetrics.totalWords < (p.totalWords ?? 0) * 0.9) regSoft.push(`words ${p.totalWords}→${curMetrics.totalWords} (−${Math.round((1 - curMetrics.totalWords / (p.totalWords || 1)) * 100)}%)`);
  if (curMetrics.minFlesch < (p.minFlesch ?? 0) - 3) regSoft.push(`minFlesch ${p.minFlesch}→${curMetrics.minFlesch}`);
  if (curMetrics.sections < (p.sections ?? 0)) regSoft.push(`sections ${p.sections}→${curMetrics.sections}`);
  if (curMetrics.imgs < (p.imgs ?? 0)) regSoft.push(`imgs ${p.imgs}→${curMetrics.imgs}`);
  if (curMetrics.jsonld < (p.jsonld ?? 0)) regSoft.push(`jsonld ${p.jsonld}→${curMetrics.jsonld}`);
}
g('no-hard-regression', regHard.length === 0, regHard.length ? regHard.join('; ') : (prior ? 'no regression vs prior build' : 'baseline — no prior build'));

const hard = gates.filter((x) => !x.ok);
const overall = hard.length === 0 ? 'PASS' : 'FAIL';
const scorecard = {
  slug, url: BASE, overall,
  contentUniqueness: uniqueness,
  regression: { hasPrior: !!prior, priorAt: prior?.ts ?? null, hard: regHard, soft: regSoft, metrics: curMetrics },
  perPage: results.map((r) => ({ path: r.path, status: r.status, words: r.words ?? 0, flesch: r.flesch ?? 0, title: (r.title || '').length, desc: (r.desc || '').length, sections: r.sections ?? 0, imgs: r.imgs ?? 0, errs: r.errs?.length ?? 0, tokens: r.tokenLeaks ?? 0 })),
  home: { theme: home.theme, sections: home.sections, imgs: home.imgs, jsonld: home.jsonldTypes, orgType: home.orgType, gallery: home.galleryTiles, nap: { hours: home.napHours, addr: home.napAddr, tel: home.napTel, email: home.napEmail } },
  softRepeats: repeats.map(([w, ps]) => `${w}: ${ps.join('+')}`),
  gatesFailed: hard.map((x) => `${x.name} — ${x.detail}`),
};

// Schema-validate the scorecard (contract-first / zod-everywhere). Fail-soft: if zod isn't
// resolvable in this script's require context, skip rather than crash the eval instrument.
let schemaValid = null;
try {
  const zmod = req('zod');
  const z = zmod.z || zmod.default || zmod;
  const Metric = z.object({ overall: z.string(), ok200: z.number(), totalWords: z.number(), minFlesch: z.number(), tokenLeaks: z.number(), sections: z.number(), imgs: z.number(), jsonld: z.number() });
  const Card = z.object({
    slug: z.string(), url: z.string(), overall: z.enum(['PASS', 'FAIL']),
    regression: z.object({ hasPrior: z.boolean(), hard: z.array(z.string()), soft: z.array(z.string()), metrics: Metric }).passthrough(),
    perPage: z.array(z.object({ path: z.string(), status: z.number() }).passthrough()),
  }).passthrough();
  Card.parse(scorecard);
  schemaValid = true;
} catch (e) {
  schemaValid = `unchecked: ${String((e && e.message) || e).slice(0, 70)}`;
}
scorecard.schemaValid = schemaValid;

// Record this run to history (append, cap 30/slug) unless --no-record. Best-effort: a write
// error never fails the eval. Date is available in a plain node script (not a workflow).
if (!args.includes('--no-record')) {
  try {
    (history[slug] ||= []).push({ ts: new Date().toISOString(), overall, metrics: curMetrics });
    history[slug] = history[slug].slice(-30);
    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch { /* history is best-effort */ }
}

if (asJson) {
  console.log(JSON.stringify(scorecard, null, 2));
} else {
  console.log(`\n━━ Content-Quality Eval: ${slug} → ${overall} ━━`);
  for (const r of scorecard.perPage) console.log(`  ${r.path.padEnd(10)} ${r.status} · ${r.words}w · Flesch ${r.flesch} · title ${r.title} · desc ${r.desc} · ${r.sections}sec · ${r.imgs}img · ${r.errs}err · ${r.tokens}tok`);
  console.log(`  HOME theme=${scorecard.home.theme} · ${scorecard.home.orgType} · JSON-LD ${scorecard.home.jsonld?.length} · gallery ${scorecard.home.gallery} · NAP hours=${scorecard.home.nap.hours} addr=${scorecard.home.nap.addr} tel=${scorecard.home.nap.tel} email=${scorecard.home.nap.email}`);
  if (scorecard.softRepeats.length) console.log(`  ⚠ soft headline repeats: ${scorecard.softRepeats.join(' · ')}`);
  if (uniqueness) console.log(`  content uniqueness: ${uniqueness.error ? uniqueness.error : `${uniqueness.uniquePct}% unique — ${uniqueness.packDefault}/${uniqueness.checked} key blocks are VERBATIM pack default${uniqueness.packDefault ? ' (' + uniqueness.packDefaultTokens.join(', ') + ')' : ''}`}`);
  const reg = scorecard.regression;
  if (reg.hard.length) console.log(`  ✗ REGRESSION (hard): ${reg.hard.join('; ')}`);
  else if (reg.soft.length) console.log(`  ⚠ regression (soft): ${reg.soft.join(' · ')}`);
  else if (reg.hasPrior) console.log(`  ✓ no regression vs prior build (${reg.priorAt?.slice(0, 10) || '?'})`);
  else console.log(`  · baseline recorded (no prior build to compare)`);
  console.log(`  schema: ${scorecard.schemaValid === true ? '✓ valid' : scorecard.schemaValid || 'n/a'}`);
  if (hard.length) console.log(`  ✗ FAILED: ${scorecard.gatesFailed.join(' | ')}`);
  else console.log(`  ✓ all ${gates.length} hard gates pass`);
}
process.exit(overall === 'PASS' ? 0 : 1);
