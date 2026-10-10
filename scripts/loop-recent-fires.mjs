#!/usr/bin/env node
// loop-recent-fires.mjs — deterministic recency + category-mix helper for the run-the-loop operator.
//
// WHY: the LEDGER's recent-fire section is NOT reliably sorted — fire headers appear
// out of chronological order, so eyeballing it gives a STALE recency read (fire-88
// orientation reported "last 5 = 73-77" when git showed work through fire-87). This
// mis-calls category starvation + journey variation. Run this instead of eyeballing.
//
// It ALSO classifies the last N fires into the §3 category budget from their git commit
// subjects and prints the mix + flags any category below its §3 floor — so the "which
// category starved, over-weight it this fire" call (run-the-loop §3) is DATA-DRIVEN, not
// eyeballed. fire-135 added the category mix after the lead had to infer "Product starved"
// by hand from the raw fire tokens.
//
// Prints, newest-first: the last N (default 8) numeric or named fire headers from LEDGER.md with their
// one-line summaries; the distinct fire tokens from `git log` (so a LEDGER-vs-git
// mismatch is visible); and the recent CATEGORY MIX with starvation flags.
//
// Usage:  node scripts/loop-recent-fires.mjs [--n <N>] [--json]

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LEDGER = join(REPO, '.claude', 'run-the-loop', 'LEDGER.md');
// Named fires and fleet IDs are identities too; keep hyphenated segments intact.
const FIRE_TOKEN = /\bfire-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi;
const FIRE_HEADER = /^#{1,3}\s*(fire-[a-z0-9]+(?:-[a-z0-9]+)*)\b(.*)$/i;

// §3 category budget (run-the-loop.md). floor/ceil are fractions of the recent-fire window.
// A fire is tagged to ONE primary category; shares below `floor` flag STARVED → over-weight next fire.
const CATEGORY_BUDGET = [
  { key: 'product', label: 'Product / bug fixes', floor: 0.3, ceil: 0.45 },
  { key: 'testing', label: 'Testing / golden paths', floor: 0.15, ceil: 0.25 },
  { key: 'architecture', label: 'Architecture', floor: 0.1, ceil: 0.2 },
  { key: 'ux', label: 'UX / a11y', floor: 0.05, ceil: 0.15 },
  { key: 'cleanup', label: 'Cleanup / perf', floor: 0.05, ceil: 0.15 },
  { key: 'docs', label: 'Docs', floor: 0.05, ceil: 0.1 },
  { key: 'discovery', label: 'Discovery', floor: 0.05, ceil: 0.1 },
  { key: 'loop', label: 'Loop-improvement', floor: 0.05, ceil: 1 },
];

// Ordered first-match keyword rules. SUBSTANCE-specific categories are matched BEFORE the
// generic `product`/`docs` buckets so `fix(a11y)` → ux and a `docs(loop)` ledger wrapper
// never forces `docs` (the wrapper prefix is stripped before classifying).
// Testing types/scopes are explicit signals, even when the subject mentions editor/create.
const CATEGORY_RULES = [
  ['ux', /\b(a11y|contrast|wcag|\baxe\b|aria|visual|polish|ux\b|reduced-motion|focus-|landmark|tap target)/i],
  ['testing', /\b(?:test(?:\([^)]*\))?!?:|[a-z]+\(tests?\)!?:)|\b(e2e|golden|journey|reconcile|probe|spec\b|coverage|\btdd\b|playwright|long-trail|causal|smoke)/i],
  ['architecture', /\b(drift|orphan|\badr\b|rearch|re-arch|architect|consolidat|interconnect|module|one-way|spine)/i],
  ['cleanup', /\b(dead[- ]code|knip|ts-prune|compress|\bperf\b|bundle|cleanup|hygiene|simplif|thin |lean )/i],
  ['discovery', /\b(scout|discovery|cf-release|replenish|tech-scout|next-wave)/i],
  ['product', /\b(feat\(|fix\(|media-ui|money[- ]path|create|editor|publish|domain|billing|data-platform|feature|wfp|checkout|onboard)/i],
  ['docs', /\b(docs?\(|readme|changelog|\bdoc\b)/i],
  // `loop` is LAST: EVERY fire ships a §7 loop-improvement, so that keyword is a constant, not the
  // fire's PRIMARY category. It only wins when no substantive-work category matched (a pure-loop fire).
  // fire-136 fix: fire-135 ("MEDIA-UI-1 deployed + §7") was mis-tagged `loop` when this rule sat before `product`.
  ['loop', /\b(loop-improve|loop improvement|§7|wrapper|harden|operating-principle|role brief|category budget|starvation)/i],
];

function parseArgs(argv) {
  let n = 8;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--n') {
      const v = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) n = v;
    } else if (a.startsWith('--n=')) {
      const v = Number.parseInt(a.slice('--n='.length), 10);
      if (Number.isFinite(v) && v > 0) n = v;
    }
  }
  return { n, json };
}

/** Last N fire headers from LEDGER.md, git chronology first, legacy numeric fallback (deduped). */
function ledgerFires(n, gitOrder) {
  let text = '';
  try {
    text = readFileSync(LEDGER, 'utf8');
  } catch {
    return []; // missing/unreadable LEDGER → empty, never throw
  }
  return parseLedgerFires(text, n, gitOrder);
}

export function parseLedgerFires(text, n = 8, gitOrder = []) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(FIRE_HEADER);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const summary = m[2].replace(/^\s*[—–\-:(]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!seen.has(id)) seen.set(id, summary);
  }
  const rank = new Map(gitOrder.map((id, index) => [id, index]));
  return [...seen.entries()]
    .sort((a, b) => {
      // Git-observed identities come first, before slicing the bounded window.
      const ar = rank.get(a[0]) ?? Infinity;
      const br = rank.get(b[0]) ?? Infinity;
      if (ar !== br) return ar < br ? -1 : 1;
      const an = a[0].match(/^fire-(\d+)[a-z]*$/);
      const bn = b[0].match(/^fire-(\d+)[a-z]*$/);
      if (an && bn) return Number(bn[1]) - Number(an[1]) || b[0].localeCompare(a[0]);
      if (an || bn) return an ? -1 : 1;
      return 0; // Unknown named IDs keep ledger insertion order; do not invent dates.
    })
    .slice(0, n)
    .map(([id, summary]) => ({ id, summary }));
}

/**
 * Distinct numeric or named fire tokens from recent git history, newest-first, each with the ACCUMULATED
 * commit subjects that mention it (authoritative + chronological — the category signal lives
 * in the substantive commit subjects, not the possibly-stale LEDGER).
 */
function gitFires(limit = 60) {
  try {
    const out = execFileSync('git', ['log', '--oneline', `-${limit}`], { cwd: REPO, encoding: 'utf8' });
    return parseGitFires(out);
  } catch {
    return { order: [], subjects: new Map() };
  }
}

export function parseGitFires(out) {
  const order = [];
  const subjects = new Map(); // token -> accumulated subject text
  for (const line of out.split('\n')) {
    const toks = line.match(FIRE_TOKEN);
    if (!toks) continue;
    for (const raw of new Set(toks.map((token) => token.toLowerCase()))) {
      const tok = raw;
      if (!subjects.has(tok)) {
        subjects.set(tok, '');
        order.push(tok);
      }
      subjects.set(tok, `${subjects.get(tok)} ${line}`);
    }
  }
  return { order, subjects };
}

export function recencyDiagnostics(fires, git) {
  const ledgerIds = fires.map((fire) => fire.id);
  return {
    orderDiffers: ledgerIds[0] !== git[0],
    ledgerOnly: ledgerIds.filter((id) => !git.includes(id)),
    gitOnly: git.filter((id) => !ledgerIds.includes(id)),
  };
}

/**
 * Strip the conventional `<type>(loop): 📘 fire-NN —` ledger-wrapper prefix so classification reads
 * the SUBSTANCE. fire-136: strip ANY `<type>(loop):` (docs/chore/feat/fix…), not just `docs(loop):` —
 * fire-135's summary used `chore(loop):`, which leaked the prefix into the classifier.
 */
function stripWrapper(text) {
  return text.replace(/\w+\(loop\):/gi, ' ').replace(/📘|📥|🔁|🎨/g, ' ').replace(FIRE_TOKEN, ' ');
}

/** Classify one fire's accumulated subject text into a §3 category (first-match, substance-first). */
export function classifyFire(subjectText) {
  const t = stripWrapper(subjectText);
  for (const [key, re] of CATEGORY_RULES) if (re.test(t)) return key;
  return 'other';
}

/** Build the category mix (count + share) over the last N fires + flag below-floor categories. */
function categoryMix(tokens, subjects, n) {
  const recent = tokens.slice(0, n);
  const counts = new Map();
  const perFire = [];
  for (const tok of recent) {
    const cat = classifyFire(subjects.get(tok) ?? tok);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
    perFire.push({ fire: tok, category: cat });
  }
  const total = recent.length || 1;
  const rows = CATEGORY_BUDGET.map((b) => {
    const count = counts.get(b.key) ?? 0;
    const share = count / total;
    return { ...b, count, share, starved: share < b.floor };
  });
  const other = counts.get('other') ?? 0;
  if (other) rows.push({ key: 'other', label: 'Other / uncategorized', floor: 0, ceil: 1, count: other, share: other / total, starved: false });
  const starved = rows.filter((r) => r.starved && r.key !== 'loop').map((r) => r.label);
  return { total, perFire, rows, starved };
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  const { n, json } = parseArgs(process.argv.slice(2));
  const { order: git, subjects } = gitFires(60);
  const fires = ledgerFires(n, git);
  const mix = categoryMix(git, subjects, n);
  const diagnostics = recencyDiagnostics(fires, git.slice(0, n));

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          meta: { repo: 'projectsites.dev', generated_at: new Date().toISOString(), git_sha: gitSha() },
          fires,
          git_recent_fires: git.slice(0, n),
          category_mix: mix.rows.map((r) => ({ category: r.key, label: r.label, count: r.count, share: Number(r.share.toFixed(3)), floor: r.floor, starved: r.starved })),
          per_fire_category: mix.perFire,
          recency_diagnostics: diagnostics,
          starved: mix.starved,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(`Last ${fires.length} LEDGER fires (git chronology first; fallback order when absent):\n`);
    for (const f of fires) process.stdout.write(`  ${f.id}  ${f.summary}\n`);
    process.stdout.write(`\ngit log recent fire tokens (newest-first): ${git.slice(0, n).join(', ') || '(none)'}\n`);
    const ledgerTop = fires[0]?.id ?? '(none)';
    const gitTop = git[0] ?? '(none)';
    if (ledgerTop !== gitTop) {
      process.stdout.write(`\n⚠ RECENCY ORDER DIFFERS: LEDGER top=${ledgerTop}, git chronological top=${gitTop} — trust git chronology; order alone does not prove unpublished work.\n`);
    }
    if (diagnostics.ledgerOnly.length) process.stdout.write(`LEDGER-only in bounded window: ${diagnostics.ledgerOnly.join(', ')} — verify commit history.\n`);
    if (diagnostics.gitOnly.length) process.stdout.write(`git-only in bounded window: ${diagnostics.gitOnly.join(', ')} — verify ledger coverage.\n`);
    process.stdout.write(`\nCategory mix — last ${mix.total} fires (§3 budget; data-driven starvation call):\n`);
    for (const r of mix.rows) {
      const pct = `${Math.round(r.share * 100)}%`.padStart(4);
      const band = r.ceil < 1 ? `${Math.round(r.floor * 100)}-${Math.round(r.ceil * 100)}%` : `${Math.round(r.floor * 100)}%+`;
      const flag = r.starved && r.key !== 'loop' ? '  ⚠ STARVED (below §3 floor)' : '';
      process.stdout.write(`  ${r.label.padEnd(24)} ${String(r.count).padStart(2)}  ${pct}  (band ${band})${flag}\n`);
    }
    // Starved list is ranked by §3 floor descending — the highest-floor gap (Product, then
    // Testing/Architecture) is the PRIMARY over-weight target; the 5%-floor tails trend in over 3-5 fires.
    if (mix.starved.length) {
      process.stdout.write(`\n⚠ STARVED → over-weight THIS fire (§3), primary first: ${mix.starved.join(', ')}\n`);
    } else {
      process.stdout.write(`\n✓ Category mix is within §3 bands (no starvation).\n`);
    }
  }

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
