#!/usr/bin/env node
/**
 * check-dead-toggle-state.mjs — dead-wired-toggle drift gate.
 *
 * The bug this gate exists to catch (fire-62/63): the editor's inline-diff feature
 * was DEAD because `Workbench.client.tsx` declared
 *
 *     const [fileHistory] = useState({});   // setter never destructured
 *
 * — a `useState` whose SETTER is never bound, so the value is FROZEN at its initial
 * value for the component's whole life. That frozen value fed an interactive,
 * user-visible toggle ("Toggle inline diff against AI original"), so the toggle could
 * flip `aria-pressed` but the diff baseline was permanently `{}` → the feature always
 * showed "No AI-tracked changes yet". It rendered + toggled fine, so no render/console
 * gate ever caught it. (Fixed by deriving `fileHistory` from a reactive `useMemo` over
 * the AI-original store.)
 *
 * This is a CLASS, not a one-off: a setter-less `useState` whose value gates a
 * user-visible feature is a latent dead-wire. This gate scans
 * `app/components/**` for that shape so a new one can't land.
 *
 * Heuristic (per validator-precision-discipline — tuned to prefer false-NEGATIVES;
 * a setter-less useState that is NOT feature-gating is intentional + common, so we
 * only flag when ALL signals line up):
 *   1. `const [x] = useState(<init>)` — destructures the VALUE only, NO setter.
 *   2. `x` is a Record/object/array-shaped initial (`{}`, `[]`, `new Map()`, …) OR
 *      is read inside a `useMemo`/render-gating branch — i.e. it's state meant to
 *      CHANGE, not a one-shot const ref.
 *   3. `x` is READ in JSX or a `useMemo`/`useEffect` dependency (it drives render).
 *   4. A sibling control in the same file carries an `on*` handler AND/OR
 *      `aria-pressed` (there's an interactive toggle nearby that the value gates).
 *
 * All four → candidate dead-wired toggle, reported with file:line. Zero hits is the
 * healthy state now that inline-diff is a `useMemo`.
 *
 * Uniform-JSON output per the repo's other `scripts/check-*.mjs` gates:
 *   { meta:{repo,generated_at,git_sha,filter}, findings:[…], summary:{total,files,exit} }
 *   Human report → stderr, JSON → stdout (composable: `… --json | jq`).
 *
 * Exit 0 report-only by default; `--ci` exits 1 on any finding. `--json` emits the
 * envelope on stdout.
 *
 * Usage:
 *   node scripts/check-dead-toggle-state.mjs            # human report, exit 0
 *   node scripts/check-dead-toggle-state.mjs --ci       # exit 1 on findings
 *   node scripts/check-dead-toggle-state.mjs --json     # JSON envelope on stdout
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// The editor lives at the repo-root `app/` (Remix), a sibling of this `apps/project-sites`.
const REPO_ROOT = join(APP_DIR, '..', '..');
const COMPONENTS_DIR = join(REPO_ROOT, 'app', 'components');

const CI = process.argv.includes('--ci');
const JSON_OUT = process.argv.includes('--json');

/** Recursively collect `*.tsx` under a dir (skips node_modules / dot-dirs). */
function collectTsx(dir, out = []) {
  if (!existsSync(dir)) {
    return out;
  }

  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') {
      continue;
    }

    const full = join(dir, name);
    const st = statSync(full);

    if (st.isDirectory()) {
      collectTsx(full, out);
    } else if (name.endsWith('.tsx')) {
      out.push(full);
    }
  }

  return out;
}

// `const [x] = useState(<init>)` — ONE binding in the array destructure (no comma →
// no setter). Captures the identifier + the initial-value expression head.
const SETTERLESS_USESTATE = /const\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\s*(?:<[^>]*>)?\s*\(([^)]*)/;

/**
 * Initial values that imply a DANGLING placeholder — state that is supposed to be
 * FILLED later but, with no setter, never is. This is the inline-diff bug's exact
 * shape (`useState({})`).
 *
 * Deliberately EXCLUDES a POPULATED literal (`useState([{…}])` / `useState({a:1})`):
 * a setter-less useState holding inline constant data is the common, intentional
 * "frozen-on-purpose" pattern (e.g. a static category list) — frozen is CORRECT
 * there, not a bug. Only an EMPTY/placeholder initial is a latent dead-wire, because
 * an empty value that can never change = a feature that can never populate. Per
 * validator-precision-discipline we tune to false-negatives: flag the placeholder,
 * never the deliberate const.
 */
function initialIsDanglingPlaceholder(init) {
  const t = init.trim().replace(/\s+/g, '');
  return (
    t === '' || // useState() — undefined placeholder
    t === '{}' || // empty object map (the inline-diff `useState({})`)
    t === '[]' || // empty array
    /^new(Map|Set|WeakMap|WeakSet)\(\)$/.test(t) || // empty collection
    t === 'null' || // null placeholder awaiting a set
    t === 'undefined'
  );
}

/** Count occurrences of a whole-word identifier in a body of text. */
function countIdent(text, ident) {
  const re = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return (text.match(re) || []).length;
}

/**
 * Does this file contain an interactive toggle sibling? `aria-pressed` (toggle button),
 * or an `on*=` handler paired with a label that reads like a user-visible control.
 */
function hasInteractiveToggle(text) {
  return /\baria-pressed\b/.test(text) || /\bon[A-Z]\w*=\{/.test(text);
}

/** Is `ident` read inside a `useMemo`/`useEffect` dependency array or body? */
function readInHook(text, ident) {
  const hookRe = /use(?:Memo|Effect|Callback)\s*\([\s\S]*?\[([^\]]*)\]\s*\)/g;
  let m;
  while ((m = hookRe.exec(text))) {
    if (countIdent(m[1], ident) > 0) {
      return true;
    }
  }
  return false;
}

/** Is `ident` read in JSX (appears inside a `{…}` expression in markup)? Approx: any
 * `{ident` / `={ident` / `(ident` usage beyond its own declaration line. */
function readInRender(text, ident, declCount) {
  // declaration itself references ident once (the binding); >1 total means it's used.
  return countIdent(text, ident) > declCount;
}

const files = collectTsx(COMPONENTS_DIR);
const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  if (!/\buseState\b/.test(text)) {
    continue;
  }

  const lines = text.split('\n');
  const toggleNearby = hasInteractiveToggle(text);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SETTERLESS_USESTATE);

    if (!m) {
      continue;
    }

    const ident = m[1];
    const init = m[2] ?? '';

    // Signal 2 — the frozen value is a DANGLING placeholder (empty/null), i.e. state
    // meant to be filled later. A populated literal is deliberate-const, not a bug.
    if (!initialIsDanglingPlaceholder(init)) {
      continue;
    }

    // Signal 3 — the value actually drives render or a hook (not a dead unused binding).
    const inHook = readInHook(text, ident);
    const inRender = readInRender(text, ident, /* declCount */ 1);

    if (!inHook && !inRender) {
      continue;
    }

    // Signal 4 — there's an interactive toggle in the same file the value can gate.
    if (!toggleNearby) {
      continue;
    }

    findings.push({
      file: relative(REPO_ROOT, file),
      line: i + 1,
      identifier: ident,
      initial: init.trim().slice(0, 40) || '(empty)',
      reason:
        'setter-less useState with a mutable initial drives render/hook while an interactive toggle is present — candidate dead-wired toggle (value is frozen at its initial)',
      gatesVia: inHook ? 'useMemo/useEffect dep' : 'JSX render',
    });
  }
}

let gitSha = 'unknown';
try {
  gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
    .toString()
    .trim();
} catch {
  /* detached / no git — leave unknown */
}

const filesWithFindings = [...new Set(findings.map((f) => f.file))];
const exit = CI && findings.length > 0 ? 1 : 0;

const envelope = {
  meta: {
    repo: REPO_ROOT,
    generated_at: new Date().toISOString(),
    git_sha: gitSha,
    filter: { scanned: 'app/components/**/*.tsx', ci: CI },
  },
  findings,
  summary: {
    total: findings.length,
    files: filesWithFindings.length,
    scanned_files: files.length,
    exit,
  },
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
} else {
  // Human report → stderr (keeps stdout clean for `--json` composition).
  const log = (s) => process.stderr.write(s + '\n');
  log('');
  log('  ◆ dead-toggle drift gate — app/components/**/*.tsx');
  log(`  scanned ${files.length} component file(s)`);

  if (findings.length === 0) {
    log('  ✓ 0 candidate dead-wired toggles (inline-diff useState→useMemo fix holds)');
  } else {
    log(`  ✗ ${findings.length} candidate dead-wired toggle(s) in ${filesWithFindings.length} file(s):`);
    for (const f of findings) {
      log(`    ${f.file}:${f.line}  [${f.identifier}] init=${f.initial}  via ${f.gatesVia}`);
    }
    log('  → a setter-less useState feeding an interactive toggle is frozen at its initial value.');
    log('    Derive it from a reactive source (useMemo over a store / props) or bind a setter.');
  }
  log('');
}

process.exit(exit);
