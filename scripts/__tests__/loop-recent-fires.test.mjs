import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerFires, parseGitFires, recencyDiagnostics } from '../loop-recent-fires.mjs';

test('ledger keeps distinct suffix IDs and deduplicates continuation headers', () => {
  const fires = parseLedgerFires('# fire-306 — base\n## fire-306b — suffix\n## fire-306b (cont.)\n## fire-307 — next');
  assert.deepEqual(fires.map((fire) => fire.id), ['fire-307', 'fire-306b', 'fire-306']);
  assert.equal(fires[1].summary, 'suffix');
  assert.equal(parseLedgerFires('# fire-306b — suffix', 1)[0].id, 'fire-306b');
});

test('git preserves chronological suffix identity and counts repeated mentions once', () => {
  const history = parseGitFires('abc fix: finish (fire-306b/308 reconcile) fire-306b\ndef docs: fire-308\nghi fix: fire-306');
  assert.deepEqual(history.order, ['fire-306b', 'fire-308', 'fire-306']);
  assert.equal(history.subjects.get('fire-306b').match(/abc/g).length, 1);
  assert.ok(!history.subjects.get('fire-306').includes('abc'));
});

test('different order with identical membership is not missing publication evidence', () => {
  const fires = ['fire-308', 'fire-307', 'fire-306b', 'fire-306'].map((id) => ({ id }));
  assert.deepEqual(recencyDiagnostics(fires, ['fire-306b', 'fire-308', 'fire-307', 'fire-306']), {
    orderDiffers: true, ledgerOnly: [], gitOnly: [],
  });
});

test('bounded membership gaps are reported separately', () => {
  assert.deepEqual(recencyDiagnostics([{ id: 'fire-309' }, { id: 'fire-308' }], ['fire-308', 'fire-307']), {
    orderDiffers: true, ledgerOnly: ['fire-309'], gitOnly: ['fire-307'],
  });
  assert.deepEqual(recencyDiagnostics([], []), { orderDiffers: false, ledgerOnly: [], gitOnly: [] });
});
