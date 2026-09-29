#!/usr/bin/env node
/**
 * check-admin-h1.mjs — build-time guard: every ROUTED page-level admin section
 * MUST render exactly one of its OWN `<h1>`.
 *
 * THE INVARIANT (fixed fire-26): the admin SHELL (admin.component) renders NO
 * `<h1>`. So each component the AdminComponent children block routes to is the
 * page-level heading owner and MUST carry its own `<h1>` — else the routed page
 * ships with ZERO h1 (WCAG 1.3.1 / 2.4.6 document-structure failure, invisible to
 * every render/console gate). Fire-26 fixed 4 such sections (dashboard, editor,
 * hosting, auth-security had zero); this gate stops the class from regressing.
 *
 * HARD gate (exit 1) — the load-bearing rule:
 *   • a routed page-level section with ZERO own `<h1`  → FAIL (the defect).
 *
 * ADVISORY (warn, never fails):
 *   • >1 `<h1` where the multiples sit in distinct `@if (…)`/`@else` state
 *     branches (only one renders — the `accept-invite` shape) → OK, allowed.
 *   • >1 `<h1` NOT in distinct control-flow branches → WARN (probable dup).
 *
 * FALSE-POSITIVE exclusions (mirrors check-css-comment-backticks precision):
 *   `<h1` matches are counted ONLY inside the component's inline `template: \`…\``
 *   literal, AFTER stripping:
 *     • the `styles: [ \`…\` ]` CSS block (an `h1 { … }` selector isn't a heading),
 *     • block comments `/* … *​/` (incl. JSDoc `/** … *​/`, e.g. hosting's
 *       "exactly one `<h1>`" doc line),
 *     • line comments `// …`,
 *     • HTML comments `<!-- … -->`.
 *
 * SCOPE: only components loaded via `loadComponent` in the AdminComponent children
 * block of app.routes.ts (the same block check-admin-coverage / -route-orphans
 * bound). Nested route children (docs-overview / docs-endpoint) render inside a
 * parent SHELL that provides the h1, and sub-components not in the manifest are
 * EXEMPT — the gate never scans them (validator-precision-discipline: page-level
 * only). Redirect children (no `loadComponent`) have no template → skipped.
 *
 * Run via `npm run validate:admin-h1` or the `build:prod` pre-build chain.
 */
import { readFileSync } from 'node:fs';

const APP = new URL('../src/app', import.meta.url).pathname;
const rel = (p) => p.replace(`${APP}/`, '');

// ── Bound the AdminComponent children block (same slice as the sibling gates) ──
const routesSrc = readFileSync(`${APP}/app.routes.ts`, 'utf8');
const startIdx = routesSrc.indexOf('m.AdminComponent');
const starIdx = routesSrc.indexOf("path: '**'", startIdx);
const adminBlock = routesSrc.slice(startIdx, starIdx > -1 ? starIdx : undefined);

// ── Blank out NESTED route-children (`children: [ … ]`) so only DIRECT
//    AdminComponent children — the page-level sections — are enumerated. A nested
//    child (docs-overview / docs-endpoint) renders inside a parent SHELL that owns
//    the h1, so it is NOT page-level (validator-precision-discipline).
//    NOTE: `adminBlock` STARTS with the AdminComponent's OWN `children: [` — that
//    first one is the whole page-level array we KEEP; only strip children arrays
//    nested inside it (search begins AFTER the first `children: [`). ──
function stripNestedChildrenBlocks(block) {
  const firstOpen = block.indexOf('[', block.indexOf('children:'));
  if (firstOpen === -1) return block;
  const head = block.slice(0, firstOpen + 1); // keep AdminComponent's own children opener
  let out = head + block.slice(firstOpen + 1);
  let guard = 0;
  for (;;) {
    const key = out.indexOf('children:', firstOpen + 1);
    if (key === -1 || guard++ > 50) break;
    const open = out.indexOf('[', key);
    if (open === -1) break;
    // Walk to the matching ']' for this NESTED children array.
    let depth = 0;
    let end = open;
    for (; end < out.length; end += 1) {
      const ch = out[end];
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // Replace the whole nested `children: [ … ]` span with a neutral placeholder.
    out = out.slice(0, key) + '/* nested children removed */' + out.slice(end + 1);
  }
  return out;
}
const pageLevelBlock = stripNestedChildrenBlocks(adminBlock);

// ── Enumerate routed page-level components: every `loadComponent` import that
//    survives the nested-children strip → its source file.
//    `import('./x/y.component').then((m) => m.Name)`. ──
const routed = new Map(); // absoluteFilePath → { file, importPath }
for (const m of pageLevelBlock.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
  const importPath = m[1];
  // `./pages/admin/sections/x.component` (relative to src/app) → absolute .ts path.
  const file = `${importPath.startsWith('./') ? `${APP}/${importPath.slice(2)}` : importPath}.ts`;
  if (!routed.has(file)) routed.set(file, { file, importPath });
}

/**
 * Return the inline `template: \`…\`` literal of a @Component decorator, with
 * `styles: [ … ]`, block/line/HTML comments removed — so a leftover `<h1` is a
 * real heading in markup, never a CSS selector or a comment mention.
 */
function extractTemplate(source) {
  const compIdx = source.indexOf('@Component(');
  if (compIdx === -1) return '';
  const classMatch = /\n\s*(?:export\s+)?(?:abstract\s+)?class\s/.exec(source.slice(compIdx));
  const decoratorEnd = classMatch ? compIdx + classMatch.index : source.length;
  const decorator = source.slice(compIdx, decoratorEnd);

  // Strip the styles: [ `…` ] literal (from `styles:` to the class decl end).
  let region = decorator;
  const stylesMatch = /styles\s*:\s*\[/.exec(region);
  if (stylesMatch) region = region.slice(0, stylesMatch.index);

  // Isolate the template: `…` literal specifically (avoid scanning selector arrays,
  // imports, etc.). Grab from `template:` backtick to its closing backtick.
  const tplOpen = /template\s*:\s*`/.exec(region);
  if (!tplOpen) return '';
  const bodyStart = tplOpen.index + tplOpen[0].length;
  const close = region.indexOf('`', bodyStart);
  let tpl = region.slice(bodyStart, close > -1 ? close : undefined);

  // Remove comments (order: block/JSDoc, HTML, then line).
  tpl = tpl
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* … */ and /** … */ (JSDoc)
    .replace(/<!--[\s\S]*?-->/g, ' ') // <!-- … -->
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // … (not http://)
  return tpl;
}

/** True when the multiple `<h1` sit in distinct @if/@else control-flow branches. */
function h1sAreInDistinctBranches(tpl, positions) {
  // Heuristic: between consecutive <h1 occurrences there is an `@if (` / `@else`
  // boundary — i.e. only one branch ever renders (the accept-invite shape).
  for (let i = 1; i < positions.length; i += 1) {
    const between = tpl.slice(positions[i - 1], positions[i]);
    if (!/@else|@if\s*\(|@switch|@case|@default/.test(between)) return false;
  }
  return true;
}

// ── Scan each routed page-level component ──────────────────────────────────────
const zeroH1 = []; // HARD failures
const multiWarn = []; // advisory
let checked = 0;

for (const { file } of routed.values()) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    // Redirect-only child (no loadComponent file) or moved file — skip silently.
    continue;
  }
  const tpl = extractTemplate(source);
  if (!tpl) continue; // no inline template (shouldn't happen for these) — skip

  // A SHELL section (renders a nested <router-outlet>) delegates its <h1> to the
  // routed child that fills the outlet — exempt it from the own-h1 requirement
  // (e.g. the docs shell + its docs-overview/docs-endpoint children).
  if (/<router-outlet/.test(tpl)) continue;

  checked += 1;

  const positions = [];
  const rx = /<h1[\s>]/g;
  let m;
  while ((m = rx.exec(tpl)) !== null) positions.push(m.index);

  if (positions.length === 0) {
    zeroH1.push(rel(file));
  } else if (positions.length > 1 && !h1sAreInDistinctBranches(tpl, positions)) {
    multiWarn.push(`${rel(file)} (${positions.length} <h1> not in distinct @if branches)`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
if (zeroH1.length) {
  console.error('\n✘ check-admin-h1: routed admin section(s) with ZERO own <h1>:\n');
  for (const f of zeroH1) console.error(`  • ${f}`);
  console.error(
    '\nThe admin SHELL renders no <h1>, so EVERY routed page-level section MUST render\n' +
      'exactly one own <h1> (WCAG 1.3.1 / 2.4.6). Add a heading to the section template\n' +
      '(use `class="sr-only"` if the design has no visible title). See fire-26.\n',
  );
  process.exit(1);
}

const base = `all ${checked} routed admin sections render exactly one own <h1>`;
if (multiWarn.length) {
  console.log(
    `✓ check-admin-h1: ${base}. ` +
      `(advisory: ${multiWarn.length} section(s) with multiple <h1> — verify intentional: ${multiWarn.join('; ')})`,
  );
} else {
  console.log(`✓ check-admin-h1: ${base}.`);
}
