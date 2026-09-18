/**
 * Centralized PII redaction utilities for safe logging and observability.
 *
 * All log output in the application should pass through {@link redact} (for
 * plain strings) or {@link redactObject} (for structured payloads) before being
 * emitted. This prevents accidental leakage of emails, phone numbers, API
 * tokens, and key-value secrets into logs, traces, and error reporters.
 *
 * | Export         | Description                                          |
 * | -------------- | ---------------------------------------------------- |
 * | `redact`       | Replace PII/secret patterns in a plain string        |
 * | `redactObject` | Deep-redact sensitive fields in a structured object   |
 *
 * @example
 * ```ts
 * import { redact, redactObject } from '@shared/utils/redact.js';
 *
 * console.warn(redact('User email is alice@example.com'));
 * // => 'User email is [REDACTED_EMAIL]'
 *
 * console.warn(JSON.stringify(redactObject({
 *   user: 'alice',
 *   token: 'sk_live_abc123xyz',
 *   nested: { password: 's3cret!' },
 * })));
 * // => '{"user":"alice","token":"[REDACTED]","nested":{"password":"[REDACTED]"}}'
 * ```
 *
 * @module redact
 * @packageDocumentation
 */

/**
 * Pattern matching email addresses (RFC 5322 simplified).
 * @internal
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/**
 * Pattern matching phone numbers in BOTH the raw E.164/contiguous form AND the
 * common FORMATTED forms the old `/\+?[1-9]\d{6,14}/` missed entirely — a real
 * PII-leak gap, since owners/contacts write phones as `(415) 555-1234`,
 * `+1 (415) 555-0123`, `415.555.0123`, or `415-555-1234`, never as 10 bare digits.
 *
 * Two alternatives (formatted FIRST so a separated phone matches as one unit):
 *   1. NANP-style 3-3-4 core with an optional `+CC` prefix and `(area)` parens,
 *      separated by space / dot / hyphen: `(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}`.
 *   2. Contiguous E.164-ish 7-15 digit run (unchanged): `\+?[1-9]\d{6,14}`.
 *
 * Validator-precision (prefer NOT over-redacting benign numbers): the 3-3-4 core
 * requires a trailing 4-digit group, so it does NOT match dates (`2026-09-18`),
 * prices (`1,234.56` — comma isn't a separator), IP octets (`192.168.1.1` — no
 * 4-digit final group), version strings, or ZIP+4 (`12345-6789`). Any benign
 * 10-digit CONTIGUOUS run was already redacted by the old contiguous branch, so
 * this only ADDS the separated-phone forms — no new over-matching.
 * @internal
 */
const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+?[1-9]\d{6,14}/g;

/**
 * Pattern matching well-known API token / secret formats across the providers
 * this stack actually uses, so they never leak into logs/Sentry/PostHog:
 *   - Stripe: `sk_test_`/`sk_live_`/`pk_test_`/`pk_live_`/`whsec_`/`rk_` + `Bearer …`
 *   - OpenAI / Anthropic: `sk-…` and `sk-ant-…` (HYPHEN — the old `_`-only
 *     pattern missed these entirely)
 *   - GitHub: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_…` + `github_pat_…`
 *   - Google API keys: `AIza…`
 *   - AWS access keys: `AKIA…`
 *   - Slack: `xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-…`
 *   - JWTs: `eyJ….….…` (three base64url segments)
 * @internal
 */
const TOKEN_REGEX =
  /(?:sk_(?:test|live)_|pk_(?:test|live)_|whsec_|rk_|Bearer\s+)[a-zA-Z0-9_-]{6,}|sk-(?:ant-)?[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AIza[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]{10,}|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{6,}/g;

/**
 * Pattern matching generic `key=value` or `key: value` pairs where the key
 * suggests a secret (password, token, OTP, etc.) and the value is 8+ chars.
 * @internal
 */
const SECRET_KV_REGEX = /(?:password|secret|token|otp|code)["']?\s*[:=]\s*["']?[a-zA-Z0-9_+/=-]{8,}["']?/gi;

/**
 * Replace PII and secret patterns in a plain string with redaction placeholders.
 *
 * Patterns are applied in a specific order to avoid partial matches:
 * 1. API tokens / Bearer tokens -> `[REDACTED_TOKEN]`
 * 2. Secret key-value pairs      -> `[REDACTED_SECRET]`
 * 3. Email addresses              -> `[REDACTED_EMAIL]`
 * 4. Phone numbers                -> `[REDACTED_PHONE]`
 *
 * @param input - The raw string that may contain sensitive data.
 * @returns A new string with all recognised sensitive patterns replaced.
 *
 * @example
 * ```ts
 * redact('Charge failed for alice@example.com, token sk_live_abc123xyz');
 * // => 'Charge failed for [REDACTED_EMAIL], token [REDACTED_TOKEN]'
 * ```
 */
export function redact(input: string): string {
  return input
    .replace(TOKEN_REGEX, '[REDACTED_TOKEN]')
    .replace(SECRET_KV_REGEX, '[REDACTED_SECRET]')
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]');
}

/**
 * Keys whose VALUE is a secret regardless of shape (case-insensitive). Matched
 * before any type dispatch so `{ token: [...] }` / `{ password: {...} }` are fully
 * masked, never walked. Frozen so the set can't be mutated by a caller.
 * @internal
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'secret',
  'secrets',
  'token',
  'tokens',
  'otp',
  'code',
  'api_key',
  'apikey',
  'api_keys',
  'authorization',
  'cookie',
  'cookies',
  'session_token',
  'refresh_token',
  'access_token',
  'stripe_secret_key',
]);

/**
 * Recursively redact ANY value — string, array, nested object, or primitive.
 * This is the shape-agnostic core so an array of PII (`['a@b.com', 'c@d.com']`)
 * or an array of records (`[{ email, token }]`) is redacted at EVERY depth, not
 * skipped. Arrays were previously passed through untouched (a PII/secret leak
 * into logs); this closes it.
 * @internal
 */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object' && value !== null) return redactObject(value as Record<string, unknown>);
  return value;
}

/**
 * Deep-redact sensitive fields from a structured object for safe logging.
 *
 * Processing logic for each key-value pair:
 * - If the **key** is in the built-in sensitive-keys set (case-insensitive),
 *   the value is replaced with `'[REDACTED]'` (whatever its shape — string,
 *   array, or object — so a `token: [...]` array is never walked and leaked).
 * - Otherwise the value is redacted by shape via {@link redactValue}: **strings**
 *   run through {@link redact}; **arrays** map element-by-element (redacting
 *   string elements + recursing into object/array elements); **nested objects**
 *   recurse through `redactObject`; primitives (number/boolean/null) pass through.
 *
 * The sensitive-keys set includes: `password`, `secret`, `token`, `otp`,
 * `code`, `api_key`, `apiKey`, `authorization`, `cookie`, `session_token`,
 * `refresh_token`, `access_token`, `stripe_secret_key`.
 *
 * @typeParam T - The shape of the input object.
 * @param obj - The object to redact. Not mutated; a new object is returned.
 * @returns A shallow-to-deep copy of `obj` with sensitive values replaced.
 *
 * @example
 * ```ts
 * redactObject({ user: 'bob', authorization: 'Bearer xyz', recipients: ['a@co.com', 'b@co.com'] });
 * // => { user: 'bob', authorization: '[REDACTED]', recipients: ['[REDACTED_EMAIL]', '[REDACTED_EMAIL]'] }
 * ```
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactValue(value);
  }

  return result;
}
