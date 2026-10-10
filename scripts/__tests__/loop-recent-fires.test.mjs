import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerFires, parseGitFires, recencyDiagnostics, classifyFire } from '../loop-recent-fires.mjs';

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


test('testing commit types and scopes outrank product words', () => {
  for (const subject of [
    'abc test(editor-live): attribute per-tab console errors by origin (fire-312)',
    'abc fix(test): repair create overlay contract drift (fire-310)',
    'abc fix(tests): repair editor harness',
    'abc test: verify billing output',
    'abc TEST(editor): verify create output',
    'abc test(editor)!: verify publish output',
    'abc fix(test)!: repair create harness',
  ]) assert.equal(classifyFire(subject), 'testing', subject);
});

test('product fixes and wrapper substance retain exclusive categories', () => {
  assert.equal(classifyFire('abc fix(editor): repair publish button'), 'product');
  assert.equal(classifyFire('abc fix(create): repair overlay'), 'product');
  assert.equal(classifyFire('abc docs(loop): record editor smoke verification (fire-312)'), 'testing');
  assert.equal(classifyFire('abc docs(loop): update category budget (fire-314)'), 'loop');
  assert.equal(classifyFire('abc fix(a11y): repair editor focus'), 'ux');
});


test('git includes named fires without truncating numeric-prefixed fleet IDs', () => {
  const history = parseGitFires(`abc docs(loop): close fire-buckets-b3ms
def docs(loop): close fire-buckets-b12
ghi fix(loop): fire-38039150213-fleet fire-38039150213-fleet
jkl test: fire-314`);
  assert.deepEqual(history.order, ['fire-buckets-b3ms', 'fire-buckets-b12', 'fire-38039150213-fleet', 'fire-314']);
  assert.equal(history.subjects.get('fire-38039150213-fleet').match(/ghi/g).length, 1);
});

test('named fire IDs do not contaminate substantive category classification', () => {
  assert.equal(classifyFire('abc docs(loop): fire-editor-smoke — category budget'), 'loop');
  assert.equal(classifyFire('abc feat(buckets): bulk selection (fire-buckets-b3ms)'), 'product');
});


test('ledger includes complete named and fleet identities in git chronology', () => {
  const text = '# fire-314 — old numeric\n## fire-buckets-b6 — clone\n## fire-buckets-b9 — shares\n## fire-38039150213-fleet — verification\n## fire-buckets-b9 (cont.)';
  const order = ['fire-38039150213-fleet', 'fire-buckets-b9', 'fire-buckets-b6', 'fire-314'];
  const fires = parseLedgerFires(text, 3, order);
  assert.deepEqual(fires.map((fire) => fire.id), order.slice(0, 3));
  assert.equal(fires[1].summary, 'shares');
});

test('unobserved named headers remain deterministic without numeric guessing', () => {
  const text = '## fire-buckets-b9 — first\n## fire-buckets-b6 — second\n## fire-314 — numeric';
  assert.deepEqual(parseLedgerFires(text).map((fire) => fire.id), ['fire-314', 'fire-buckets-b9', 'fire-buckets-b6']);
  assert.deepEqual(parseLedgerFires(text, 1, ['fire-buckets-b6']).map((fire) => fire.id), ['fire-buckets-b6']);
});
