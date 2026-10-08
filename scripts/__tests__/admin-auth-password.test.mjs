import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const helper = new URL('../../apps/project-sites/frontend/e2e/helpers/admin-auth.ts', import.meta.url).href;

function lookup(env, broker) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-auth-password-'));
  try {
    if (broker) writeFileSync(join(dir, 'get-secret'), broker, { mode: 0o700 });
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { getTestPassword } from ${JSON.stringify(helper)}; process.stdout.write(JSON.stringify(getTestPassword()));`,
    ], { encoding: 'utf8', env: { ...process.env, E2E_TEST_PASSWORD: '', TEST_USER_PASSWORD: '', ...env, PATH: dir } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('environment password wins without invoking the broker', () => {
  assert.equal(lookup({ E2E_TEST_PASSWORD: 'primary', TEST_USER_PASSWORD: 'secondary' }, '#!/bin/sh\nexit 1\n'), 'primary');
});
test('empty primary environment falls back to legacy password', () => {
  assert.equal(lookup({ TEST_USER_PASSWORD: 'secondary' }), 'secondary');
});
test('uses PATH broker and trims output', () => {
  assert.equal(lookup({}, '#!/bin/sh\n[ "$1" = E2E_TEST_PASSWORD ] || exit 1\nprintf "  fixture-password\\n"\n'), 'fixture-password');
});
test('missing, failed and empty brokers return null', () => {
  assert.equal(lookup({}), null);
  assert.equal(lookup({}, '#!/bin/sh\nexit 1\n'), null);
  assert.equal(lookup({}, '#!/bin/sh\nprintf " \\n"\n'), null);
});
