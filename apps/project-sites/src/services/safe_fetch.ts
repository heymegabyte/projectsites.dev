/**
 * safe_fetch.ts — SSRF-safe outbound fetch (SECURITY HARDENING / reliability).
 *
 * The adopt-unit that turns the pure {@link assertPublicHttpUrl} guard into a drop-in replacement for
 * `fetch()` at every outbound call site that takes an attacker-influenceable URL (logo extraction,
 * lead scanner, source-site enhancement, MCP callbacks). It validates the initial URL, then fetches
 * with `redirect: 'manual'` and RE-VALIDATES the guard on EVERY `Location` hop — because a first-hop
 * allowlist check is defeated by a 302 to an internal host
 * ([[ssrf-redirect-follow-bypasses-host-allowlist-revalidate-every-hop]]). The `fetch` implementation
 * is injectable so the redirect-bypass path is unit-tested without real network I/O.
 */

import { assertPublicHttpUrl, SsrfError, type SsrfPolicy } from './ssrf_guard.js';

/** Thrown when the redirect chain exceeds the cap (a redirect loop / abuse). Distinct from
 *  {@link SsrfError} (a blocked host/protocol/port) so callers can tell "unreachable" from "unsafe". */
export class SafeFetchError extends Error {
  readonly code: 'too_many_redirects';
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = 'too_many_redirects';
  }
}

/** A response minimal shape the wrapper inspects — real `Response` satisfies it. */
interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

export interface SafeFetchOptions {
  /** SSRF policy applied to the initial URL AND every redirect hop. */
  policy?: SsrfPolicy;
  /** Max redirect hops to follow before throwing (default 5). */
  maxRedirects?: number;
  /** Fetch init (method/headers/body/…). `redirect` is forced to `'manual'`. */
  init?: RequestInit;
  /** Injected fetch (defaults to `globalThis.fetch`) — lets tests drive redirect chains deterministically. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<ResponseLike>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL with SSRF protection re-applied on every redirect hop. Validates the URL up front
 * (throws {@link SsrfError} before any network call if it is private/blocked), follows redirects
 * MANUALLY, and re-validates each `Location` target with the SAME policy so no hop can reach an
 * internal host. Returns the first non-redirect response.
 *
 * @param rawUrl - the URL to fetch
 * @param options - policy, redirect cap, fetch init, injectable fetch
 * @returns the final (non-redirect) response
 * @throws {SsrfError} the initial URL or a redirect target is unsafe (private host / bad protocol / port)
 * @throws {SafeFetchError} the redirect chain exceeded `maxRedirects`
 * @example await safeFetch('https://example.com/logo.png') // Response
 * @example await safeFetch('http://x.test') // if it 302s to http://169.254.169.254 → throws SsrfError('private_host')
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<ResponseLike> {
  const max = options.maxRedirects ?? 5;
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as SafeFetchOptions['fetchImpl']);
  if (!doFetch) throw new SafeFetchError('no fetch implementation available');

  // Hop 0: validate before touching the network.
  let current = assertPublicHttpUrl(rawUrl, options.policy).toString();

  for (let hop = 0; hop <= max; hop++) {
    const res = await doFetch(current, { ...options.init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res; // redirect without a target — hand it back rather than guess

    const next = new URL(location, current).toString();
    assertPublicHttpUrl(next, options.policy); // RE-VALIDATE this hop — the redirect-bypass fix
    current = next;
  }

  throw new SafeFetchError(`Exceeded ${max} redirects for ${rawUrl}.`);
}
