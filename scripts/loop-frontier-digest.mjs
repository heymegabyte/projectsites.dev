#!/usr/bin/env node
/**
 * loop-frontier-digest.mjs — the lead's cheap, deterministic frontier briefing.
 *
 * PROBLEM (fire-80): BACKLOG.md (~133K) + LEDGER.md (~81K) are UNREADABLE in the
 * lead — the oversized-read guard blocks them and reading them thrashes context
 * (per `[[monitor-orchestration]]` § context budget). Every fire's lead was
 * spawning an ad-hoc Explore agent just to digest the frontier, and manually
 * eyeballing which carried blockers still hold. This helper replaces that spawn
 * with ONE Node call: it reads the canonical docs + the two standing cursors and
 * prints a ≤150-line digest the lead holds as conclusions, never raw bytes.
 *
 * What it surfaces (truthful — only what the files actually say, never fabricated):
 *   - READY frontier per workstream (open `- [ ]` items, grouped by `##` header)
 *   - Carried blockers WITH their deterministic re-confirm command (curl the
 *     live surface before assigning a fix-agent, per the carried-blocker memory)
 *   - Last ~6 golden journeys (gp-* receipts from GOLDEN-PATHS.md)
 *   - Long-Trail (LTT) cursor + Deep-UI-Explorer (DUX) cursor
 *   - Canonical do-not-hunt paths + the category budget (starvation guard)
 *
 * Usage (repo root; sibling to loop-fire-lock.mjs / loop-backlog-hygiene.mjs):
 *   node scripts/loop-frontier-digest.mjs           # human digest → stdout
 *   node scripts/loop-frontier-digest.mjs --json     # machine digest → stdout
 *   node scripts/loop-frontier-digest.mjs --max 12   # cap items per workstream
 *
 * Fail-soft by construction: a missing/corrupt file emits a clear `(unavailable:
 * <path> — <reason>)` line and the digest continues. Node built-ins only, no deps.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOME = resolve(ROOT, '.claude/run-the-loop');
const E2E = resolve(ROOT, 'apps/project-sites/e2e');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const MAX_PER_WS = (() => {
  const i = args.indexOf('--max');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 6;
})();

/** Read a file, returning { ok, text } or { ok:false, reason } — never throws. */
function readSoft(path) {
  try {
    if (!existsSync(path)) return { ok: false, reason: 'missing' };
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'read error' };
  }
}

/** Parse JSON soft — { ok, data } or { ok:false, reason }. Never throws. */
function readJsonSoft(path) {
  const r = readSoft(path);
  if (!r.ok) return r;
  try {
    return { ok: true, data: JSON.parse(r.text) };
  } catch (e) {
    return { ok: false, reason: 'corrupt JSON: ' + ((e && e.message) || 'parse error') };
  }
}

const rel = (p) => relative(ROOT, p);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * READY frontier: every open `- [ ]` item, grouped by its nearest `##`/`###`
 * header (the workstream). Closed `- [x]` items are skipped. Pure so it stays
 * testable and honest — it reports exactly the checkboxes the file contains.
 */
function readyFrontier(md) {
  const ws = new Map(); // header -> [item,...]
  let header = '(no section)';
  for (const raw of md.split('\n')) {
    const h = raw.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      header = clip(h[1].trim(), 72);
      continue;
    }
    const m = raw.match(/^\s*-\s*\[ \]\s+(.*)$/);
    if (!m) continue;
    if (!ws.has(header)) ws.set(header, []);
    ws.get(header).push(clip(m[1].trim(), 150));
  }
  return ws;
}

/**
 * Carried blockers: open items OR explicit blocker lines mentioning a blocked/
 * carried/deploy-blocked/fixme condition. Each gets a re-confirm command so the
 * lead verifies the blocker is STILL real before assigning a fix (per the
 * carried-blocker-must-be-reconfirmed-live memory).
 */
function carriedBlockers(md) {
  const re = /\b(blocked|blocker|carried|deploy-blocked|frame-ancestors|fixme|awaiting a credential)\b/i;
  const out = [];
  md.split('\n').forEach((raw) => {
    if (/^\s*-\s*\[[xX]\]/.test(raw)) return; // CLOSED items are not carried blockers
    const item = raw.match(/^\s*-\s*\[ \]\s+(.*)$/);
    const line = (item ? item[1] : raw).trim();
    if (!item && !/^\s*-\s/.test(raw)) return; // only list lines
    if (!re.test(line)) return;
    out.push(clip(line.replace(/^\s*-\s*(\[ \]\s*)?/, ''), 160));
  });
  return out.slice(0, 10);
}

/** Last N golden-journey receipt markers (gp-NN … lines) from GOLDEN-PATHS.md. */
function goldenJourneys(md, n) {
  const hits = [];
  md.split('\n').forEach((raw) => {
    const m = raw.match(/gp-\d+[^\n]*/i);
    if (m && /receipt|cycle|green|PASS|live|verif/i.test(raw)) hits.push(clip(raw.trim().replace(/^#+\s*/, ''), 110));
  });
  return hits.slice(-n);
}

/** Pull the canonical do-not-hunt path block + category-budget line, verbatim-ish. */
function canonicalCheatsheet(md) {
  const lines = md.split('\n');
  const out = [];
  let grab = false;
  for (const l of lines) {
    if (/^##\s+Canonical paths/i.test(l)) { grab = true; continue; }
    if (grab && /^##\s/.test(l)) break;
    if (grab && /^\s*-\s/.test(l)) out.push(clip(l.trim().replace(/^-+\s*/, ''), 120));
  }
  const budget = lines.find((l) => /category budget/i.test(l));
  return { paths: out.slice(0, 8), budget: budget ? clip(budget.trim().replace(/^-+\s*/, ''), 180) : null };
}

// ---- gather -------------------------------------------------------------
const backlog = readSoft(resolve(HOME, 'BACKLOG.md'));
const ledgerFull = readSoft(resolve(HOME, 'LEDGER.md'));
const golden = readSoft(resolve(HOME, 'GOLDEN-PATHS.md'));
const principles = readSoft(resolve(HOME, 'OPERATING-PRINCIPLES.md'));
const ltt = readJsonSoft(resolve(E2E, 'long-trail/checkpoint-case-001.json'));
const dux = readJsonSoft(resolve(E2E, 'deep-ui-explorer/coverage-ledger.json'));

// LEDGER tail only — never ingest the whole 81K file.
let ledgerTail = [];
if (ledgerFull.ok) {
  ledgerTail = ledgerFull.text
    .split('\n')
    .filter((l) => /^#{1,4}\s+(fire-|directive)/i.test(l))
    .slice(-6)
    .map((l) => clip(l.replace(/^#+\s*/, '').trim(), 120));
}

const frontier = backlog.ok ? readyFrontier(backlog.text) : null;
const blockers = backlog.ok ? carriedBlockers(backlog.text) : null;
const journeys = golden.ok ? goldenJourneys(golden.text, 6) : null;
const cheats = principles.ok ? canonicalCheatsheet(principles.text) : null;

// LTT cursor
let lttCur = null;
if (ltt.ok) {
  const d = ltt.data;
  const na = d.next_action || {};
  lttCur = {
    case: d.case_id || '?',
    status: d.status || '?',
    last_completed_action: d.last_completed_action ?? '?',
    next_action: na.number != null ? `#${na.number} — ${clip(String(na.description || ''), 90)}` : '?',
    updated_at: d.updated_at || '?',
  };
}

// DUX cursor
let duxCur = null;
if (dux.ok) {
  const states = dux.data.states || {};
  const runs = dux.data.runs || [];
  const last = runs[runs.length - 1] || {};
  duxCur = {
    states_tracked: Object.keys(states).length,
    runs: runs.length,
    last_run: last.runId || '?',
    last_status: last.status || '?',
    last_coverage: last.coverage || '?',
  };
}

// ---- JSON mode ----------------------------------------------------------
if (JSON_OUT) {
  const unavailable = [];
  for (const [name, r] of [
    ['BACKLOG.md', backlog], ['LEDGER.md', ledgerFull], ['GOLDEN-PATHS.md', golden],
    ['OPERATING-PRINCIPLES.md', principles], ['long-trail/checkpoint-case-001.json', ltt],
    ['deep-ui-explorer/coverage-ledger.json', dux],
  ]) if (!r.ok) unavailable.push({ file: name, reason: r.reason });
  process.stdout.write(JSON.stringify({
    meta: { repo: ROOT, generated_at: new Date().toISOString(), max_per_workstream: MAX_PER_WS, unavailable },
    ready_frontier: frontier ? Object.fromEntries([...frontier].map(([k, v]) => [k, v.slice(0, MAX_PER_WS)])) : null,
    carried_blockers: blockers,
    golden_journeys: journeys,
    ltt_cursor: lttCur,
    dux_cursor: duxCur,
    ledger_tail: ledgerTail,
    canonical: cheats,
  }, null, 2) + '\n');
  process.exit(0);
}

// ---- human digest -------------------------------------------------------
const L = [];
L.push('━━━ LOOP FRONTIER DIGEST ━━━ ' + new Date().toISOString());
L.push('repo: ' + ROOT + ' · lead holds these conclusions; do NOT read BACKLOG/LEDGER in-thread');

L.push('\n▌READY FRONTIER (open `- [ ]`, grouped by workstream; ≤' + MAX_PER_WS + '/ws)');
if (!frontier) {
  L.push('  (unavailable: ' + rel(resolve(HOME, 'BACKLOG.md')) + ' — ' + backlog.reason + ')');
} else if (frontier.size === 0) {
  L.push('  (no open items found)');
} else {
  let shownWs = 0;
  for (const [ws, items] of frontier) {
    if (items.length === 0) continue;
    if (shownWs++ >= 14) { L.push('  …(' + (frontier.size - 14) + ' more workstreams — use --json)'); break; }
    L.push('  ## ' + ws + '  (' + items.length + ')');
    items.slice(0, MAX_PER_WS).forEach((it) => L.push('    • ' + it));
    if (items.length > MAX_PER_WS) L.push('    …+' + (items.length - MAX_PER_WS) + ' more');
  }
}

L.push('\n▌CARRIED BLOCKERS — RE-CONFIRM LIVE before assigning a fix-agent (carried-blocker memory)');
if (!blockers) L.push('  (unavailable — BACKLOG not read)');
else if (blockers.length === 0) L.push('  (none flagged)');
else {
  blockers.forEach((b) => L.push('  ⚠ ' + b));
  L.push('  → re-confirm cmd (curl the live surface; a stale blocker wastes a fix-agent):');
  L.push('     curl -s -o /dev/null -w "%{http_code}\\n" https://projectsites.dev/<surface>  # expect the FIXED code, not the blocked one');
}

L.push('\n▌LAST ~6 GOLDEN JOURNEYS (GOLDEN-PATHS.md receipts)');
if (!journeys) L.push('  (unavailable: ' + rel(resolve(HOME, 'GOLDEN-PATHS.md')) + ' — ' + golden.reason + ')');
else if (journeys.length === 0) L.push('  (no gp-* receipts found)');
else journeys.forEach((j) => L.push('  ◆ ' + j));

L.push('\n▌STANDING CURSORS');
if (lttCur) {
  L.push('  LTT (Long-Trail case-001): status=' + lttCur.status);
  L.push('    last_completed_action=' + lttCur.last_completed_action + ' · next=' + lttCur.next_action + ' · updated ' + lttCur.updated_at);
} else L.push('  LTT: (unavailable: ' + rel(resolve(E2E, 'long-trail/checkpoint-case-001.json')) + ' — ' + ltt.reason + ')');
if (duxCur) {
  L.push('  DUX (Deep UI Explorer): ' + duxCur.states_tracked + ' states · ' + duxCur.runs + ' runs · last=' + duxCur.last_run);
  L.push('    last_status=' + duxCur.last_status + ' · coverage=' + duxCur.last_coverage);
} else L.push('  DUX: (unavailable: ' + rel(resolve(E2E, 'deep-ui-explorer/coverage-ledger.json')) + ' — ' + dux.reason + ')');

L.push('\n▌LEDGER TAIL (last ~6 fires — tail only, never the full 81K)');
if (!ledgerFull.ok) L.push('  (unavailable: ' + rel(resolve(HOME, 'LEDGER.md')) + ' — ' + ledgerFull.reason + ')');
else if (ledgerTail.length === 0) L.push('  (no fire headers found)');
else ledgerTail.forEach((l) => L.push('  · ' + l));

L.push('\n▌CANONICAL (do-not-hunt) + CATEGORY BUDGET (starvation guard)');
if (!cheats) L.push('  (unavailable: ' + rel(resolve(HOME, 'OPERATING-PRINCIPLES.md')) + ' — ' + principles.reason + ')');
else {
  cheats.paths.forEach((p) => L.push('  ▹ ' + p));
  if (cheats.budget) L.push('  ⊞ ' + cheats.budget);
}

L.push('\n━━━ end digest · ' + L.length + ' lines · --json for machine form ━━━');
process.stdout.write(L.join('\n') + '\n');
