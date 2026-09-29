#!/usr/bin/env node
/**
 * recipient-allowlist.mjs — fail-closed recipient allowlist for the Long-Trail
 * TDD browser-agent (and any loop-fired outreach probe that sends real email/SMS).
 *
 * WHY: the `/run-the-loop` Long-Trail case-owner drives real user journeys that can
 * trigger email/SMS side-effects. Those must NEVER reach an arbitrary address — only
 * an operator-owned, explicitly-listed recipient. This loader is the hard gate.
 *
 * CONTRACT (fail-closed by construction):
 *   - Reads a LOCAL, git-IGNORED config `apps/project-sites/.recipient-allowlist.local.json`
 *     of shape `{ "email": string[], "sms": string[] }`.
 *   - `assertRecipientAllowed(kind, value)` THROWS unless `value` is listed under `kind`.
 *   - `isRecipientAllowed(kind, value)` returns a boolean (never throws).
 *   - Config ABSENT / unreadable / malformed / empty → DENY everything (returns false /
 *     throws). No file = no sends. This is the whole point.
 *   - Values are compared case-insensitively for email, trimmed exact for sms; the raw
 *     values are NEVER logged, echoed, or included in thrown-error text (only the count).
 *
 * SECURITY: the real phone/email live only in the local file (git-ignored). This module
 * commits with an EXAMPLE placeholder file alongside it. Never print the values.
 *
 * Pure helpers (`normalizeEmail`, `normalizeSms`, `checkAgainst`) are exported for unit
 * tests per validator-precision-discipline. `loadAllowlist` is exported for the checker.
 */
import { readFileSync } from 'node:fs';

/** Absolute path to the git-ignored local config (resolved relative to this file). */
export const ALLOWLIST_PATH = new URL(
  '../.recipient-allowlist.local.json',
  import.meta.url,
).pathname;

/** Recipient channels this allowlist governs. */
export const RECIPIENT_KINDS = /** @type {const} */ (['email', 'sms']);

/** Lowercase + trim an email for case-insensitive comparison. */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Trim an SMS/E.164 number for exact comparison (no case folding). */
export function normalizeSms(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Pick the normalizer for a channel. Unknown channel → a normalizer that yields ''. */
function normalizerFor(kind) {
  if (kind === 'email') return normalizeEmail;
  if (kind === 'sms') return normalizeSms;
  return () => '';
}

/**
 * Pure fail-closed membership check against an already-loaded config object.
 * DENIES when: config is falsy, the channel list is missing/not-an-array/empty,
 * the value is blank, or the value isn't a normalized member of the list.
 * @param {unknown} config  parsed allowlist (or null when absent/malformed)
 * @param {string} kind     'email' | 'sms'
 * @param {string} value    candidate recipient
 * @returns {boolean} true ONLY when explicitly allowed
 */
export function checkAgainst(config, kind, value) {
  if (!config || typeof config !== 'object') return false;
  if (!RECIPIENT_KINDS.includes(kind)) return false;
  const list = /** @type {Record<string, unknown>} */ (config)[kind];
  if (!Array.isArray(list) || list.length === 0) return false;

  const normalize = normalizerFor(kind);
  const candidate = normalize(value);
  if (!candidate) return false;

  for (const entry of list) {
    if (normalize(entry) === candidate) return true;
  }
  return false;
}

/**
 * Read + parse the local allowlist config. Returns `null` (never throws) when the
 * file is absent, unreadable, invalid JSON, or not an object — so every caller
 * fails CLOSED. Never logs the file contents.
 * @param {string} [path] override for tests
 * @returns {{ email?: string[], sms?: string[] } | null}
 */
export function loadAllowlist(path = ALLOWLIST_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // absent / unreadable → deny everything
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null; // malformed JSON → deny everything
  }
}

/**
 * Fail-closed boolean check for a recipient. Loads the local config each call
 * (cheap; the file is tiny) so a freshly-added recipient is picked up without a
 * restart. Returns false — never throws — when denied. Values are not logged.
 * @param {string} kind  'email' | 'sms'
 * @param {string} value candidate recipient
 * @param {string} [path] override for tests
 * @returns {boolean}
 */
export function isRecipientAllowed(kind, value, path = ALLOWLIST_PATH) {
  return checkAgainst(loadAllowlist(path), kind, value);
}

/**
 * Fail-closed assertion — THROWS a generic error (no recipient value in the
 * message) unless `value` is explicitly allowed for `kind`. Use this at every
 * real send site in the Long-Trail agent so an unlisted recipient is impossible.
 * @param {string} kind  'email' | 'sms'
 * @param {string} value candidate recipient
 * @param {string} [path] override for tests
 * @returns {true}
 * @throws {Error} when the config is absent or the recipient isn't listed
 */
export function assertRecipientAllowed(kind, value, path = ALLOWLIST_PATH) {
  if (!RECIPIENT_KINDS.includes(kind)) {
    throw new Error(`recipient-allowlist: unknown channel "${String(kind)}"`);
  }
  if (isRecipientAllowed(kind, value, path)) return true;
  // Never include the recipient value — only the channel — to avoid leaking it to logs.
  throw new Error(
    `recipient-allowlist: ${kind} recipient is not on the fail-closed allowlist ` +
      `(add it to .recipient-allowlist.local.json or no send is permitted)`,
  );
}

// CLI: `node scripts/recipient-allowlist.mjs <email|sms> <value>` → exit 0 allowed, 1 denied.
// Prints ONLY the decision + channel, never the value.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , kind, value] = process.argv;
  if (!kind || value === undefined) {
    process.stderr.write('usage: recipient-allowlist.mjs <email|sms> <value>\n');
    process.exit(2);
  }
  const ok = isRecipientAllowed(kind, value);
  process.stdout.write(`${kind}: ${ok ? 'ALLOWED' : 'DENIED'}\n`);
  process.exit(ok ? 0 : 1);
}
