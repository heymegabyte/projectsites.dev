#!/usr/bin/env node
/**
 * verify-llms-txt-quality.mjs — § C.4 GEO / crawler-manifest quality across a deployed site's
 * THREE agent/crawler manifests: `/llms.txt`, `/humans.txt`, `/.well-known/security.txt`. Flags
 * fields that ship BLANK, MALFORMED, or with a BROKEN URL — defects invisible to the count-based
 * SEO gate (each manifest 200s + is non-empty) but read as ground truth by an AI crawler
 * (ChatGPT/Perplexity/Gemini), a security researcher, or a humans.txt reader.
 *
 * Three defect classes:
 *  1. BLANK keyed field — `Tagline: ` / `Site: ` (empty value). AL-753 (llms.txt).
 *  2. MALFORMED Contact — dangling `|` when one side of `email | phone` is empty. AL-753.
 *  3. DOUBLED SCHEME — `https://https://…` (AL-793). The template prepended `https://` to a
 *     `{DOMAIN}` token that itself fills as a FULL URL (`fillTemplateTokens` returns `realUrl`
 *     for DOMAIN/BUSINESS_URL), so `Site: https://{DOMAIN}/` → `Site: https://https://slug…/`.
 *     Caught LIVE on the-aviary-chicago (2026-09-19): humans.txt `Site` + security.txt
 *     `Canonical`/`Policy` doubled the scheme while llms.txt (bare `{DOMAIN}`) was correct.
 *     ROOT FIX (AL-793): template `public/humans.txt` + `public/.well-known/security.txt`
 *     now use a BARE `{DOMAIN}` (no literal `https://` prefix); the `Last update: {BUILD_DATE}`
 *     line (BUILD_DATE never filled → blank) was removed.
 *
 * MODE: REPORT by default (exit 0) — surfaces the gap every run without red-ing the globbed
 * suite while the fix's cohort rebuilds. `STRICT=1` gates (exit 1 on any finding) once the fix
 * has landed + the cohort rebuilds clean — then it's the regression guard. The pure audit fns
 * are exported + unit-tested in the sibling `verify-llms-txt-quality.test.ts` (primary Jest gate).
 *
 * `fetch`-based (text only). Local run against {slug}.projectsites.dev (CF-clean). Auto-joins the
 * globbed site-quality run-all. Usage: [SITES=slug,slug] [STRICT=1] node …/verify-llms-txt-quality.mjs
 */
import { resolveSites } from './_default-sites.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Keyed lines per manifest that MUST NOT ship blank. A real crawler/researcher reads these.
const LLMS_KEYED = ['Tagline', 'Hours', 'Address', 'Site', 'Contact'];
const HUMANS_KEYED = ['Owner', 'Site'];
const SECURITY_KEYED = ['Contact', 'Canonical', 'Policy'];

/**
 * Doubled-scheme defect: a line carrying `scheme://scheme://…` (e.g. `https://https://`). A broken
 * URL — a token that already fills as a full URL got a second `https://` prepended. Pure.
 * @param {string} text - the manifest body
 * @returns {string[]} one defect string per offending line
 * @example auditDoubledScheme('Site: https://https://x.dev/') // → ['doubled scheme: "Site: https://https://x.dev/"']
 */
export function auditDoubledScheme(text) {
  const defects = [];
  for (const line of text.split(/\r?\n/)) {
    if (/https?:\/\/https?:\/\//i.test(line)) defects.push(`doubled scheme: "${line.trim()}"`);
  }
  return defects;
}

/**
 * Blank keyed field (`Key:` with an empty value) for the given key set. Pure.
 * @param {string} text - the manifest body
 * @param {string[]} keys - the keys to require non-blank
 * @returns {string[]} one `<Key> blank` per offending line
 * @example auditKeyedBlank('Site: ', ['Site']) // → ['Site blank']
 */
export function auditKeyedBlank(text, keys) {
  const defects = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Za-z ]*?):\s*(.*)$/);
    if (!m || !keys.includes(m[1])) continue;
    if (m[2].trim() === '') defects.push(`${m[1]} blank`);
  }
  return defects;
}

/**
 * llms.txt quality: blank keyed fields + malformed Contact (dangling `|`). Pure.
 * @param {string} text - the llms.txt body
 * @returns {string[]} defect strings
 * @example auditLlms('Tagline: ') // → ['Tagline blank']
 */
export function auditLlms(text) {
  const defects = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Za-z ]*?):\s*(.*)$/);
    if (!m || !LLMS_KEYED.includes(m[1])) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'Contact') {
      if (/^\s*\|/.test(val) || /\|\s*$/.test(val)) defects.push(`Contact malformed (dangling |): "${line.trim()}"`);
      else if (val.trim() === '') defects.push('Contact blank');
    } else if (val.trim() === '') {
      defects.push(`${key} blank`);
    }
  }
  return defects;
}

/** The three manifests audited per site + how each is audited (blank/malformed + doubled-scheme). */
export const MANIFESTS = [
  { path: '/llms.txt', audit: (t) => [...auditLlms(t), ...auditDoubledScheme(t)] },
  { path: '/humans.txt', audit: (t) => [...auditKeyedBlank(t, HUMANS_KEYED), ...auditDoubledScheme(t)] },
  { path: '/.well-known/security.txt', audit: (t) => [...auditKeyedBlank(t, SECURITY_KEYED), ...auditDoubledScheme(t)] },
];

/** Fetch + audit one site's three manifests. Impure (network). Fail-soft per manifest. */
async function auditSite(slug) {
  const defects = [];
  for (const mf of MANIFESTS) {
    const label = mf.path.replace(/^\/(\.well-known\/)?/, '');
    try {
      const res = await fetch(`https://${slug}.projectsites.dev${mf.path}`, { headers: { 'user-agent': UA } });
      if (res.status !== 200) { defects.push(`${label} status=${res.status}`); continue; }
      for (const d of mf.audit(await res.text())) defects.push(`${label} ${d}`);
    } catch (e) {
      defects.push(`${label} fetch error: ${String(e).slice(0, 60)}`);
    }
  }
  return { slug, ok: defects.length === 0, detail: defects.length ? defects.join(' · ') : 'clean' };
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  // Async IIFE (not top-level await): keeps the module importable under @swc/jest's ESM→CJS
  // transpile (CJS has no top-level await) while still running standalone via `node`.
  void (async () => {
    const SITES = resolveSites(process.env.SITES);
    const STRICT = /^(1|true)$/i.test(process.env.STRICT || '');
    if (SITES.length === 0) {
      console.log('::notice:: verify-manifest-quality skipped — no site resolved');
      process.exit(0);
    }
    const rows = [];
    for (const slug of SITES) rows.push(await auditSite(slug));
    const bad = rows.filter((r) => !r.ok);
    for (const r of rows) console.log(`  ${r.ok ? '✓' : '⚠'} ${r.slug.padEnd(34)} [${r.detail}]`);
    console.log(
      `::json:: ${JSON.stringify({ probe: 'manifest-quality', mode: STRICT ? 'strict' : 'report', sites: SITES.length, withDefects: bad.length })}`,
    );
    if (bad.length) {
      console.log(
        `\n${STRICT ? '🔴 FAIL' : '::warning::'} — ${bad.length}/${rows.length} deployed site(s) ship a blank/malformed/broken-URL crawler-manifest field (llms.txt / humans.txt / security.txt).` +
          `\n  ROOT: template token substitution — a blank field fills '' instead of omitting the line; a full-URL {DOMAIN} token got a second https:// prepended (doubled scheme).` +
          `\n  Fixed in template (AL-753 llms.txt sanitizer, AL-793 humans.txt/security.txt bare {DOMAIN}); STRICT-promote once the cohort rebuilds clean (currently ${STRICT ? 'STRICT' : 'REPORT'} mode).`,
      );
    } else {
      console.log(
        `\nVERDICT: ✅ PASS — every audited site ships clean crawler manifests (no blank/malformed/doubled-scheme field across llms.txt + humans.txt + security.txt).`,
      );
    }
    process.exit(STRICT && bad.length ? 1 : 0);
  })();
}
