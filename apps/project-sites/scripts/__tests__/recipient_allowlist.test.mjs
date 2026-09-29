// Unit tests for the fail-closed recipient allowlist (recipient-allowlist.mjs).
// Proves: ABSENT config → deny; listed recipient → allow; unlisted → deny;
// malformed/empty config → deny; assertRecipientAllowed throws when denied and
// never leaks the recipient value into the error text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAgainst,
  isRecipientAllowed,
  assertRecipientAllowed,
  loadAllowlist,
  normalizeEmail,
  normalizeSms,
} from '../recipient-allowlist.mjs';

/** Write a temp config file and return its path (auto-unique dir per call). */
function tmpConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-allowlist-'));
  const path = join(dir, '.recipient-allowlist.local.json');
  if (obj !== undefined) writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONFIG = { email: ['You@Example.com'], sms: ['+15555555555'] };

// --- ABSENT config → fail closed (deny everything) ---
test('absent config file → loadAllowlist returns null', () => {
  assert.equal(loadAllowlist('/nonexistent/path/.recipient-allowlist.local.json'), null);
});

test('absent config → isRecipientAllowed denies email', () => {
  assert.equal(isRecipientAllowed('email', 'you@example.com', '/nope/missing.json'), false);
});

test('absent config → isRecipientAllowed denies sms', () => {
  assert.equal(isRecipientAllowed('sms', '+15555555555', '/nope/missing.json'), false);
});

test('absent config → assertRecipientAllowed THROWS (fail closed)', () => {
  assert.throws(() => assertRecipientAllowed('email', 'you@example.com', '/nope/missing.json'));
});

// --- listed recipient → allow ---
test('listed email → allowed', () => {
  const { path, cleanup } = tmpConfig(CONFIG);
  try {
    assert.equal(isRecipientAllowed('email', 'you@example.com', path), true);
    assert.equal(assertRecipientAllowed('email', 'you@example.com', path), true);
  } finally {
    cleanup();
  }
});

test('listed email is case-insensitive', () => {
  const { path, cleanup } = tmpConfig(CONFIG);
  try {
    assert.equal(isRecipientAllowed('email', '  YOU@EXAMPLE.COM ', path), true);
  } finally {
    cleanup();
  }
});

test('listed sms → allowed (trimmed exact)', () => {
  const { path, cleanup } = tmpConfig(CONFIG);
  try {
    assert.equal(isRecipientAllowed('sms', ' +15555555555 ', path), true);
  } finally {
    cleanup();
  }
});

// --- unlisted recipient → deny ---
test('unlisted email → denied', () => {
  const { path, cleanup } = tmpConfig(CONFIG);
  try {
    assert.equal(isRecipientAllowed('email', 'attacker@evil.com', path), false);
    assert.throws(() => assertRecipientAllowed('email', 'attacker@evil.com', path));
  } finally {
    cleanup();
  }
});

test('unlisted sms → denied', () => {
  const { path, cleanup } = tmpConfig(CONFIG);
  try {
    assert.equal(isRecipientAllowed('sms', '+19998887777', path), false);
  } finally {
    cleanup();
  }
});

// --- malformed / empty / wrong-shape config → fail closed ---
test('malformed JSON → deny', () => {
  const { path, cleanup } = tmpConfig('{ not valid json');
  try {
    assert.equal(loadAllowlist(path), null);
    assert.equal(isRecipientAllowed('email', 'you@example.com', path), false);
  } finally {
    cleanup();
  }
});

test('empty email array → deny (empty list allows no one)', () => {
  const { path, cleanup } = tmpConfig({ email: [], sms: [] });
  try {
    assert.equal(isRecipientAllowed('email', 'you@example.com', path), false);
  } finally {
    cleanup();
  }
});

test('array-not-object config → deny', () => {
  const { path, cleanup } = tmpConfig(['you@example.com']);
  try {
    assert.equal(loadAllowlist(path), null);
  } finally {
    cleanup();
  }
});

// --- pure checkAgainst + unknown channel ---
test('checkAgainst denies when config is null', () => {
  assert.equal(checkAgainst(null, 'email', 'you@example.com'), false);
});

test('unknown channel → denied + assert throws', () => {
  assert.equal(isRecipientAllowed('push', 'x', '/nope.json'), false);
  assert.throws(() => assertRecipientAllowed('push', 'x'));
});

test('blank value → denied even when list present', () => {
  assert.equal(checkAgainst(CONFIG, 'email', '   '), false);
});

// --- the thrown error must NOT leak the recipient value ---
test('assert error message never contains the recipient value', () => {
  const secret = 'topsecret@leak.example';
  try {
    assertRecipientAllowed('email', secret, '/nope/missing.json');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.equal(err.message.includes(secret), false, 'recipient value leaked into error text');
  }
});

// --- normalizers ---
test('normalizeEmail lowercases + trims; non-string → empty', () => {
  assert.equal(normalizeEmail('  A@B.com '), 'a@b.com');
  assert.equal(normalizeEmail(123), '');
});

test('normalizeSms trims, no case-fold; non-string → empty', () => {
  assert.equal(normalizeSms(' +1555 '), '+1555');
  assert.equal(normalizeSms(null), '');
});
