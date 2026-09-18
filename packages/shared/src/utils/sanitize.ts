/**
 * HTML and string sanitization utilities for user-provided and AI-generated content.
 *
 * This module provides defence-in-depth sanitizers that strip dangerous HTML
 * constructs (XSS vectors), remove all markup, and normalize slugs for use in
 * URLs and subdomain routing.
 *
 * | Export              | Description                                           |
 * | ------------------- | ----------------------------------------------------- |
 * | `sanitizeHtml`      | Strip `<script>`, event handlers, and protocol abuse  |
 * | `stripHtml`         | Remove **all** HTML tags, returning plain text        |
 * | `sanitizeSlug`      | Normalize a string into a URL-safe slug (max 63 chars)|
 * | `businessNameToSlug` | Convert a business name to a DNS-safe slug           |
 *
 * @example
 * ```ts
 * import { sanitizeHtml, stripHtml, sanitizeSlug, businessNameToSlug } from '@shared/utils/sanitize.js';
 *
 * const safe = sanitizeHtml('<p>Hello</p><script>alert(1)</script>');
 * // => '<p>Hello</p>'
 *
 * const plain = stripHtml('<b>Bold</b> text');
 * // => 'Bold text'
 *
 * const slug = businessNameToSlug("Joe's Bar & Grill");
 * // => 'joes-bar-and-grill'
 * ```
 *
 * @module sanitize
 * @packageDocumentation
 */

/**
 * Return `raw` only when it is a SAFE same-origin relative path (begins with a
 * single `/`, no scheme, host, userinfo, or backslash/control tricks);
 * otherwise return `fallback`. Use for any `return_url`/`next`/redirect param
 * that is later composed as `https://our-host${path}` — the classic
 * open-redirect bypass is `@evil.com` (→ `https://our-host@evil.com`, host
 * `evil.com`) and `//evil.com` (protocol-relative).
 *
 * @example
 * ```ts
 * safeRelativePath('/admin/mcp', '/admin');   // => '/admin/mcp'
 * safeRelativePath('@evil.com', '/admin');    // => '/admin'  (no leading slash)
 * safeRelativePath('//evil.com', '/admin');   // => '/admin'  (protocol-relative)
 * ```
 */
export function safeRelativePath(raw: string | undefined, fallback: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /\s/.test(raw)) {
    return fallback;
  }
  return raw;
}

/**
 * Return `provided` only when its host is one of an allowlist of OWN domains;
 * otherwise fall back to `fallback`. Use for any ABSOLUTE redirect URL handed to
 * a third party (e.g. a Stripe Checkout `success_url`/`cancel_url`) — the
 * open-redirect/phishing vector is a crafted `success_url=https://evil.com` that
 * sends the user off-site after a payment completes. Unlike
 * {@link safeRelativePath} (for `https://our-host${path}` composition), this is
 * for fully-qualified URLs validated against an explicit host Set. Graceful
 * (never throws) so a legitimate payment always completes — a too-strict
 * allowlist degrades to the safe fallback, never to an error.
 *
 * @param provided - The client-supplied absolute URL (may be undefined).
 * @param fallback - The safe default URL to use when `provided` is unsafe.
 * @param allowedHosts - Lowercased hosts that are allowed redirect targets.
 *
 * @example
 * ```ts
 * const own = new Set(['nsk.projectsites.dev', 'projectsites.dev']);
 * pickSafeRedirect('https://nsk.projectsites.dev/ok', fb, own); // => kept
 * pickSafeRedirect('https://evil.com/phish', fb, own);          // => fb
 * pickSafeRedirect('::::not a url', fb, own);                   // => fb
 * ```
 */
export function pickSafeRedirect(provided: string | undefined, fallback: string, allowedHosts: Set<string>): string {
  if (!provided) return fallback;
  try {
    return allowedHosts.has(new URL(provided).host.toLowerCase()) ? provided : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Sanitize an HTML string by removing known XSS vectors.
 *
 * The following dangerous patterns are stripped:
 * - `<script>` blocks (including nested content)
 * - Inline event-handler attributes (`onclick`, `onerror`, etc.)
 * - `javascript:`, `data:`, and `vbscript:` URI schemes
 * - `<iframe>`, `<object>`, and `<embed>` elements
 *
 * **Note:** This is a regex-based sanitizer intended as a defence-in-depth
 * layer. It should be combined with a CSP and, where possible, a DOM-based
 * sanitizer on the client.
 *
 * @param input - The raw HTML string to sanitize.
 * @returns The input with dangerous constructs removed. Safe markup is preserved.
 *
 * @example
 * ```ts
 * sanitizeHtml('<div onclick="steal()">Hi</div>');
 * // => '<div>Hi</div>'
 * ```
 */
/**
 * HTML-entity-escape untrusted text before interpolating it into an HTML
 * document or email. Unlike {@link sanitizeHtml} (which only strips *dangerous*
 * constructs and preserves benign markup), this renders ALL markup inert — the
 * right choice when the field is plain text and any tag is unexpected (contact
 * forms, inbox replies, owner-notification emails).
 *
 * @param input - The raw text to escape.
 * @returns The text with `& < > " '` replaced by their HTML entities.
 *
 * @example
 * ```ts
 * escapeHtml('<a href="x">hi</a> & bye');
 * // => '&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt; &amp; bye'
 * ```
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHtml(input: string): string {
  // Apply the removal passes repeatedly until the string is stable. A single
  // pass can REVEAL a new vector by deleting an inner construct — e.g.
  // `<scr<script>ipt>` collapses to `<script>` only after the inner `<script>`
  // is removed. Each pass only deletes, so length is monotonically
  // non-increasing and the loop always terminates.
  let out = input;
  let prev: string;
  do {
    prev = out;
    out = out
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '')
      // Strip any UNTERMINATED script/iframe/object opener too. The balanced pairs above require a
      // literal closing tag, so `<script>alert(1)` (no `</script>`) would otherwise pass through —
      // and browsers execute an unterminated <script> (auto-closed at EOF). `>?` also catches a tag
      // truncated at end-of-input (`…<script`). (AL-780)
      .replace(/<(?:script|iframe|object)\b[^>]*>?/gi, '')
      // Event-handler attributes — quoted ("…" / '…') OR UNQUOTED (onload=alert(1)). The boundary is
      // `[\s/]`, not just `\s`: HTML5 treats `/` as an attribute separator, so the slash-separated
      // form `<svg/onload=alert(1)>` must strip too (the `\s`-only version let it slip through). The
      // boundary still anchors to a real attribute edge so we never match `on…=` inside prose. (AL-780)
      .replace(/[\s/]on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/data\s*:/gi, '')
      .replace(/vbscript\s*:/gi, '');
  } while (out !== prev);
  return out;
}

/**
 * Strip **all** HTML tags from a string, returning plain text.
 *
 * Uses a single-pass regex to remove every `<...>` construct. This is useful
 * when you need a text-only representation for indexing, logging, or
 * notification previews.
 *
 * @param input - A string that may contain HTML tags.
 * @returns The input with every HTML tag removed.
 *
 * @example
 * ```ts
 * stripHtml('<h1>Title</h1><p>Body</p>');
 * // => 'TitleBody'
 * ```
 */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * Normalize an arbitrary string into a URL- and DNS-safe slug.
 *
 * Processing steps:
 * 1. Convert to lowercase.
 * 2. Trim leading/trailing whitespace.
 * 3. Replace non-alphanumeric characters (except hyphens) with `-`.
 * 4. Collapse consecutive hyphens into one.
 * 5. Remove leading and trailing hyphens.
 * 6. Truncate to 63 characters (the maximum DNS label length).
 *
 * @param input - The raw string to convert into a slug.
 * @returns A lowercase, hyphen-separated slug of at most 63 characters.
 *
 * @example
 * ```ts
 * sanitizeSlug('  My Cool Site!! ');
 * // => 'my-cool-site'
 * ```
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 63);
}

/**
 * Convert a business name into a DNS-safe slug suitable for subdomain routing.
 *
 * Before delegating to {@link sanitizeSlug}, this function:
 * - Removes apostrophes and common quote variants (`'`, `\u2018`, `\u2019`,
 *   `` ` ``, `\u00B4`).
 * - Replaces ampersands (`&`) with the word `and`.
 *
 * The resulting slug is used for `{slug}-sites.megabyte.space` subdomain
 * routing in the Project Sites worker.
 *
 * @param name - The business name as returned by Google Places or entered by
 *   the user.
 * @returns A lowercase, hyphen-separated slug of at most 63 characters.
 *
 * @example
 * ```ts
 * businessNameToSlug("Ben & Jerry's");
 * // => 'ben-and-jerrys'
 * ```
 */
export function businessNameToSlug(name: string): string {
  return sanitizeSlug(name.replace(/['\u2018\u2019\u0060\u00B4]/g, '').replace(/&/g, 'and'));
}
