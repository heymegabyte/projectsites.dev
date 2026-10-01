#!/usr/bin/env node
/**
 * loop-backlog-hygiene.mjs — BACKLOG↔LEDGER staleness gate for /run-the-loop.
 *
 * PROBLEM (fire-68): the frontier-digest reported WLK-03/08/09 as "READY" when
 * fire-67 had already CLOSED them. The two canonical docs drift: an item marked
 * open (`- [ ]`) whose SHA/fire the LEDGER records as shipped (STALE-OPEN), or
 * marked done (`- [x]`) with no SHA + no LEDGER receipt (STALE-CLOSED). Either
 * way the next fire's task-selection trusts a lie. This gate catches both.
 *
 * Usage (repo root; sibling to scripts/loop-fire-lock.mjs):
 *   node scripts/loop-backlog-hygiene.mjs            # report-only, exit 0
 *   node scripts/loop-backlog-hygiene.mjs --check    # exit 1 if any finding
 *   node scripts/loop-backlog-hygiene.mjs --selftest # in-memory fixture proof
 * JSON → stdout (uniform {meta,findings,summary}); human summary → stderr.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOME = resolve(ROOT, '.claude/run-the-loop');
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const FIRE_RE = /\bfire-\d+\b/gi;
const CLOSED_WORD_RE = /\b(closed|shipped|landed|done|merged|fixed|prod-verified|deployed)\b/i;

/** Extract SHA + fire-NN tokens referenced in a chunk of text (deduped, lowercased). */
function tokensOf(text) {
  const shas = new Set((text.match(SHA_RE) || []).map((s) => s.toLowerCase()));
  const fires = new Set((text.match(FIRE_RE) || []).map((s) => s.toLowerCase()));
  return { shas, fires };
}

/** Parse BACKLOG checkbox items → {open:boolean, line, text, area}. Area = text before first em-dash/colon. */
function parseBacklog(md) {
  const out = [];
  md.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*-\s*\[([ xX])\]\s+(.*)$/);
    if (!m) return;
    const text = m[2].trim();
    const area = (text.split(/\s[—–-]\s|:/)[0] || text).trim().toLowerCase();
    out.push({ open: m[1] === ' ', line: i + 1, text, area });
  });
  return out;
}

/**
 * Core analysis — pure, so --selftest can drive it with in-memory fixtures.
 * STALE-OPEN: an OPEN item whose cited SHA/fire the LEDGER records as closed.
 * STALE-CLOSED: a CLOSED item citing no SHA whose area has no LEDGER mention.
 */
export function analyze(backlogMd, ledgerMd) {
  const items = parseBacklog(backlogMd);
  const ledger = tokensOf(ledgerMd);
  const ledgerLower = ledgerMd.toLowerCase();
  const findings = [];

  for (const it of items) {
    const { shas, fires } = tokensOf(it.text);
    if (it.open) {
      // Does the LEDGER record any token this open item cites as done?
      const hitSha = [...shas].find((s) => ledger.shas.has(s));
      const hitFire = [...fires].find((f) => ledger.fires.has(f));
      const hit = hitSha || hitFire;
      if (hit && CLOSED_WORD_RE.test(it.text) === false) {
        // open + cites a shipped token but no self-admission of closure in its own line
        findings.push({
          type: 'stale_open',
          line: it.line,
          excerpt: it.text.slice(0, 140),
          evidence: `cites ${hit} which LEDGER records as shipped, but item is marked open (- [ ])`,
        });
      }
    } else {
      // closed: must cite a SHA; else its area must appear in the LEDGER
      const citesSha = shas.size > 0;
      const areaInLedger = it.area.length >= 4 && ledgerLower.includes(it.area);
      if (!citesSha && !areaInLedger) {
        findings.push({
          type: 'stale_closed',
          line: it.line,
          excerpt: it.text.slice(0, 140),
          evidence: 'marked done (- [x]) but cites no SHA and no matching LEDGER entry (no receipt)',
        });
      }
    }
  }
  return findings;
}

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function emit(findings, { filesMissing = [] } = {}) {
  const stale_open = findings.filter((f) => f.type === 'stale_open').length;
  const stale_closed = findings.filter((f) => f.type === 'stale_closed').length;
  const check = process.argv.includes('--check');
  const exit = check && findings.length > 0 ? 1 : 0;
  const envelope = {
    meta: {
      repo: ROOT,
      generated_at: new Date().toISOString(),
      git_sha: gitSha(),
      ...(filesMissing.length ? { files_missing: filesMissing } : {}),
    },
    findings,
    summary: { stale_open, stale_closed, exit },
  };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  if (filesMissing.length) {
    console.warn(`backlog-hygiene: SKIPPED — missing ${filesMissing.join(', ')} (fail-soft)`);
  }
  console.warn(
    `backlog-hygiene: ${findings.length} finding(s) — stale_open=${stale_open} stale_closed=${stale_closed}` +
      (check ? ` (--check → exit ${exit})` : ''),
  );
  for (const f of findings) console.warn(`  L${f.line} [${f.type}] ${f.excerpt} — ${f.evidence}`);
  process.exit(exit);
}

function selftest() {
  const backlog = [
    '# BACKLOG',
    '- [ ] WLK-03 editable cell fix (fire-67 `2200d5fd3`+Pages 5654158a) edit→save→reload',
    '- [ ] WLK-99 brand-quality cluster — root-cause logo pipeline', // open, no evidence → clean
    '- [x] (fire-60 `f8d0cecfe`) Pricing claim-flow implementation', // closed w/ SHA → clean
    '- [x] Mystery cleanup task with no receipt anywhere', // closed, no SHA, no ledger area → stale_closed
  ].join('\n');
  const ledger = [
    '## fire-67 — WLK-03 editable-cell lost-edit shipped `2200d5fd3`+Pages `5654158a`, prod-verified',
    '## fire-60 — claim_flow module flag-dark `f8d0cecfe`',
  ].join('\n');
  const findings = analyze(backlog, ledger);
  const openHit = findings.find((f) => f.type === 'stale_open' && /WLK-03/.test(f.excerpt));
  const closedHit = findings.find((f) => f.type === 'stale_closed' && /Mystery/.test(f.excerpt));
  const pass = Boolean(openHit) && Boolean(closedHit) && findings.length === 2;
  process.stdout.write(JSON.stringify({ selftest: pass ? 'PASS' : 'FAIL', findings }, null, 2) + '\n');
  console.warn(
    `selftest ${pass ? 'PASS' : 'FAIL'}: stale_open ${openHit ? '✓' : '✗'} · stale_closed ${closedHit ? '✓' : '✗'} · total ${findings.length}/2`,
  );
  process.exit(pass ? 0 : 1);
}

function main() {
  if (process.argv.includes('--selftest')) {
    selftest();
    return;
  }
  const backlogPath = resolve(HOME, 'BACKLOG.md');
  const ledgerPath = resolve(HOME, 'LEDGER.md');
  const missing = [];
  if (!existsSync(backlogPath)) missing.push('BACKLOG.md');
  if (!existsSync(ledgerPath)) missing.push('LEDGER.md');
  if (missing.length) {
    emit([], { filesMissing: missing });
    return;
  }
  emit(analyze(readFileSync(backlogPath, 'utf8'), readFileSync(ledgerPath, 'utf8')));
}

// CLI entry only when run directly — importing (e.g. the test) is side-effect-free.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
