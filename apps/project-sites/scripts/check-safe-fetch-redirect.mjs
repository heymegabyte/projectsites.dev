#!/usr/bin/env node
/**
 * check-safe-fetch-redirect.mjs — SSRF redirect-follow drift detector.
 *
 * The bug this detector exists to catch (fire-75 → fire-76): a raw
 * `fetch(<variable-url>, { redirect: 'follow' })` only validates the FIRST hop against
 * the host allowlist, then follows a 302 BLINDLY — so a public, allowlisted URL can
 * 302 to `169.254.169.254` / `127.0.0.1` / an internal `10.x` host, turning the call
 * into an SSRF existence/latency/content-type oracle (TOCTOU). The canonical fix is
 * `safeFetch()` (`src/services/safe_fetch.ts`), which forces `redirect:'manual'` and
 * re-validates the host allowlist on EVERY hop.
 *
 * fire-75 migrated the three `discover-images` siblings to `safeFetch`; fire-76 found +
 * fixed the ONE it missed (`libs/features/media_ai/handlers.ts` HEAD probe). This
 * detector makes the whole CLASS visible so the next one can't hide.
 *
 * STATUS: PROMOTED to a BLOCKING push gate (fire-77) — wired into
 * `.github/workflows/feature-architecture.yml` (runs with `--ci` alongside the other
 * detector steps). The 4 previously-unaudited sites are resolved: lead_enrichment ×2 +
 * domains (RDAP) migrated to `safeFetch`; system_status annotated `// safe-fetch-ok`
 * (hardcoded first-party INTEGRATION_TARGETS, no user-influenced URL). Any NEW
 * `redirect:'follow'` on a variable URL must migrate to `safeFetch` OR carry a justified
 * `// safe-fetch-ok` marker on the same/preceding line, or this gate fails the build.
 *
 * Precision (per validator-precision-discipline — prefer false-NEGATIVES): we flag
 * ONLY an explicit `redirect: 'follow'` literal in real (non-comment) code. A bare
 * `fetch(url)` with no redirect option ALSO follows redirects, but flagging every raw
 * fetch is noisy (many are fixed-host provider calls) — the explicit literal is the
 * high-signal intent-to-follow marker. Comment lines and `safe_fetch.ts` are excluded;
 * a `// safe-fetch-ok` marker on the same or preceding line suppresses a finding.
 *
 * Usage:
 *   node scripts/check-safe-fetch-redirect.mjs            # report (exit 0 always)
 *   node scripts/check-safe-fetch-redirect.mjs --ci       # exit 1 on any UN-annotated finding (for future promotion)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN_DIRS = ['src', 'libs'];
const FOLLOW_RE = /redirect:\s*['"]follow['"]/;
const OK_MARKER = 'safe-fetch-ok';
const ci = process.argv.includes('--ci');

/** Recursively collect .ts files under a dir, skipping tests + node_modules + safe_fetch.ts. */
function collectTsFiles(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
      collectTsFiles(full, acc);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts') &&
      name !== 'safe_fetch.ts'
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** A line is a comment if its trimmed form starts with a comment token. */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const findings = [];
for (const d of SCAN_DIRS) {
  for (const file of collectTsFiles(join(ROOT, d), [])) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!FOLLOW_RE.test(line) || isCommentLine(line)) return;
      const annotated = line.includes(OK_MARKER) || (i > 0 && lines[i - 1].includes(OK_MARKER));
      findings.push({ file: relative(ROOT, file), line: i + 1, annotated, text: line.trim() });
    });
  }
}

const unannotated = findings.filter((f) => !f.annotated);
if (findings.length === 0) {
  console.warn('✓ check-safe-fetch-redirect: no explicit redirect:\'follow\' in src/ or libs/ — clean.');
  process.exit(0);
}

console.warn(`\nSSRF redirect-follow sites (${findings.length} total, ${unannotated.length} un-annotated):`);
for (const f of findings) {
  const tag = f.annotated ? 'OK ' : '!! ';
  console.warn(`  ${tag}${f.file}:${f.line}  ${f.text}`);
}
console.warn(
  '\n  !! = raw redirect:\'follow\' on a variable URL. Migrate to safeFetch() (re-validates every hop),',
);
console.warn('     or if the host is fixed + not user-influenced, annotate `// safe-fetch-ok: <reason>`.');

if (ci && unannotated.length > 0) {
  console.error(`\n✗ ${unannotated.length} un-annotated redirect:'follow' site(s) — see above.`);
  process.exit(1);
}
process.exit(0);
