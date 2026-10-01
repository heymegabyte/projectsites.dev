/**
 * loop-backlog-hygiene.test.mjs — node --test coverage for the hygiene gate.
 * Run: node --test scripts/loop-backlog-hygiene.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './loop-backlog-hygiene.mjs';

const ledger = [
  '## fire-67 — WLK-03 editable-cell shipped `2200d5fd3`+Pages `5654158a`, prod-verified 404→200',
  '## fire-60 — claim_flow module flag-dark `f8d0cecfe`',
  '## fire-61 — migration reconcile `3b0f06963`',
].join('\n');

test('STALE-OPEN: open item citing a shipped SHA fires', () => {
  const backlog = '- [ ] WLK-03 editable cell (fire-67 `2200d5fd3`) edit→save→reload';
  const f = analyze(backlog, ledger);
  assert.equal(f.length, 1);
  assert.equal(f[0].type, 'stale_open');
  assert.match(f[0].evidence, /2200d5fd3/);
});

test('STALE-OPEN: open item citing a shipped fire-NN fires', () => {
  const backlog = '- [ ] WLK-09 Hosting Preview link — handled in fire-67 fully';
  const f = analyze(backlog, ledger);
  assert.equal(f.length, 1);
  assert.equal(f[0].type, 'stale_open');
  assert.match(f[0].evidence, /fire-67/);
});

test('STALE-CLOSED: done item with no SHA + no LEDGER area fires', () => {
  const backlog = '- [x] Mystery cleanup task with no receipt anywhere';
  const f = analyze(backlog, ledger);
  assert.equal(f.length, 1);
  assert.equal(f[0].type, 'stale_closed');
});

test('CLEAN: done item citing a SHA does not fire', () => {
  const backlog = '- [x] (fire-60 `f8d0cecfe`) Pricing claim-flow implementation';
  assert.equal(analyze(backlog, ledger).length, 0);
});

test('CLEAN: open item with no shipped evidence does not fire', () => {
  const backlog = '- [ ] WLK-99 brand-quality cluster — root-cause logo pipeline';
  assert.equal(analyze(backlog, ledger).length, 0);
});

test('CLEAN: open item that self-admits closure in its own line is not double-flagged', () => {
  const backlog = '- [ ] (fire-67 `2200d5fd3`; live-embed verify pending) WLK-03 closed';
  assert.equal(analyze(backlog, ledger).length, 0);
});

test('both finding types coexist in one run', () => {
  const backlog = [
    '- [ ] WLK-03 (fire-67 `2200d5fd3`) edit→save→reload',
    '- [x] Mystery cleanup with no receipt',
  ].join('\n');
  const f = analyze(backlog, ledger);
  assert.equal(f.length, 2);
  assert.ok(f.some((x) => x.type === 'stale_open'));
  assert.ok(f.some((x) => x.type === 'stale_closed'));
});
