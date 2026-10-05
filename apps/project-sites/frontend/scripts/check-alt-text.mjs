#!/usr/bin/env node
/**
 * check-alt-text.mjs — fail the build when any `<img>` tag lacks `alt=` or `[alt]=`.
 *
 * Walks every `*.html` and `*.ts` file under `src/app/`, regex-matches `<img …>`
 * tags (greedy across newlines, tolerant of self-closing + multi-line attribute
 * formatting), and exits non-zero with a per-file violation report if any tag
 * is missing both `alt="…"` and Angular's `[alt]="…"` property binding.
 *
 * WCAG 1.1.1 Non-text Content requires a textual alternative for every image —
 * decorative images get `alt=""`, meaningful images get a descriptive value.
 * Either is acceptable; the missing-attribute case is the bug we catch here.
 *
 * Run via `npm run check:alt-text` or as a pre-build gate (`build:prod`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(ROOT, 'src', 'app');
const EXTS = ['.html', '.ts'];

/** Recursively yields every file under `dir` whose extension matches `EXTS`. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
      continue;
    }
    // Spec files never ship — their inline templates + XSS-payload fixture
    // strings (e.g. a `<img onerror>` used to assert HTML-escaping) are not
    // production images and must not trip the shipped-HTML alt-text gate.
    if (full.endsWith('.spec.ts')) continue;
    if (EXTS.some((ext) => full.endsWith(ext))) yield full;
  }
}

/**
 * Returns the array of `<img …>` tags inside `source` that lack `alt=` or
 * `[alt]=`. Each entry carries the 1-based line number for the report.
 */
function findViolations(source) {
  const violations = [];
  // Blank out COMMENT CONTENT (JSDoc/block `/* … */` + HTML `<!-- … -->`) before scanning, so a
  // prose/documentation mention of a tag — e.g. a JSDoc describing "a cross-origin <img> in the
  // editor iframe" — isn't flagged as a real missing-alt image. This mirrors the `.spec.ts`
  // exclusion in walk() (non-production markup must not trip the shipped-HTML gate); a commented-out
  // <img> never renders, so skipping it is correct. Each non-newline char → a space so byte offsets
  // (and therefore reported line numbers) are preserved exactly.
  const blankComment = (m) => m.replace(/[^\n]/g, ' ');
  const scanned = source
    .replace(/\/\*[\s\S]*?\*\//g, blankComment)
    .replace(/<!--[\s\S]*?-->/g, blankComment);
  const rx = /<img\b[^>]*>/g;
  let match;
  while ((match = rx.exec(scanned)) !== null) {
    const tag = match[0];
    if (/\salt\s*=/.test(tag)) continue;
    if (/\[alt\]\s*=/.test(tag)) continue;
    const before = scanned.slice(0, match.index);
    const line = before.split('\n').length;
    violations.push({ tag, line });
  }
  return violations;
}

function main() {
  let failures = 0;
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    const violations = findViolations(source);
    if (violations.length === 0) continue;
    failures += violations.length;
    const rel = relative(ROOT, file);
    for (const v of violations) {
      const snippet = v.tag.length > 120 ? v.tag.slice(0, 117) + '...' : v.tag;
      process.stderr.write(`${rel}:${v.line}  missing alt — ${snippet}\n`);
    }
  }
  if (failures > 0) {
    process.stderr.write(`\nalt-text check FAILED — ${failures} <img> tag(s) missing alt.\n`);
    process.exit(1);
  }
  process.stdout.write('alt-text check PASSED — every <img> has an alt attribute.\n');
}

main();
