import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSection } from './section-capture.mjs';

function capture(selector, overlay) {
  const dashboard = { innerText: 'Dashboard Create Your Website', querySelector: () => null, querySelectorAll: () => [] };
  globalThis.document = {
    body: dashboard,
    querySelectorAll: () => [],
    querySelector: (s) => s === 'main' ? dashboard : overlay,
  };
  globalThis.location = { pathname: '/create' };
  try { return captureSection({ contentSelector: selector, shell: '' }); }
  finally { delete globalThis.document; delete globalThis.location; }
}

test('missing overlay cannot pass using the dashboard behind it', () => {
  const result = capture('.ps-create-overlay', null);
  assert.equal(result.mainLen, 0);
  assert.equal(result.text, '');
});

test('overlay content is measured instead of dashboard content', () => {
  const overlay = { innerText: 'Business Name', querySelector: () => ({ innerText: 'Create Your Website' }), querySelectorAll: () => [] };
  const result = capture('.ps-create-overlay', overlay);
  assert.equal(result.text, 'Business Name');
  assert.equal(result.h1, 'Create Your Website');
});

test('ordinary sections retain main content measurement', () => {
  assert.equal(capture(undefined, null).text, 'Dashboard Create Your Website');
});
