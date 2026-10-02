/**
 * On-demand deep contact enrichment for the Lead Scanner (#9).
 *
 * @remarks
 * Given one lead's known identity (name + optional address/city/website), discover
 * its website / phone / email / social profiles by combining THREE best-effort
 * sources, merged highest-confidence-first via {@link mergeContactBundles}:
 *
 *   (a) HOMEPAGE parse   — if a website is already known, fetch + scrape it.
 *   (b) FREE search      — a DuckDuckGo HTML query, harvest social + candidate site.
 *   (c) PAID adapter     — an optional external enrichment API (flag-gated), POSTed
 *                          only when the caller supplies both a URL and a key.
 *
 * EVERY external step is wrapped in its own try/catch and degrades SILENTLY to an
 * empty bundle — this function NEVER throws. A blocked DDG, a 500 from the homepage,
 * or a down paid provider each contribute `{}` rather than failing the whole enrich.
 * All I/O is injected via `deps.fetchImpl` (defaults to global `fetch`) so the module
 * is fully unit-testable with a stub.
 *
 * @packageDocumentation
 */
import {
  extractSocialsFromHtml,
  extractContactFromHtml,
  detectNetworkFromUrl,
  mergeContactBundles,
  type ContactBundle,
} from './social_links.js';
import { safeFetch } from './safe_fetch.js';

/** Realistic desktop Chrome UA — bare fetch UAs get WAF-blocked (`fetch-defaults`). */
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/** Cap on HTML we read from any page — guards against multi-MB responses. */
const HTML_CAP = 500_000;

/** Hostname fragments we never treat as a business's own website (search cruft). */
const DIRECTORY_HOSTS: readonly string[] = [
  'duckduckgo.com',
  'google.com',
  'bing.com',
  'yahoo.com',
  'wikipedia.org',
  'yellowpages.com',
  'yelp.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'mapquest.com',
  'tripadvisor.com',
  'bbb.org',
];

/** Injected dependencies + paid-adapter configuration for {@link enrichLeadContact}. */
export interface EnrichDeps {
  /** Fetch implementation (defaults to global `fetch`) — inject a stub in tests. */
  fetchImpl?: typeof fetch;
  /** True when the `lead_enrichment_paid` flag is on for the caller. */
  paidEnabled?: boolean;
  /** External enrichment API endpoint (paid adapter). */
  paidApiUrl?: string;
  /** Bearer token for the paid adapter. */
  paidApiKey?: string;
}

/** The known identity of the lead to enrich. */
export interface EnrichInput {
  /** Business display name (required — the search query anchor). */
  businessName: string;
  /** Street address, when known (improves paid-adapter + search precision). */
  address?: string;
  /** City, when known (appended to the free-search query). */
  city?: string;
  /** An already-known website URL, when present (parsed directly). */
  website?: string;
}

/** Lowercased hostname of a URL, or '' when unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True when a host is a search engine / directory / social platform (not the biz site). */
function isDirectoryHost(host: string): boolean {
  if (!host) return true;
  return DIRECTORY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Fetch a homepage and extract socials + email + phone from its HTML.
 *
 * @param url - The page URL to fetch (assumed http(s)).
 * @param fetchImpl - The fetch implementation to use.
 * @returns A {@link ContactBundle} carrying `website:url` plus any discovered
 *   socials/email/phone. Returns `{}` on any fetch/parse failure (never throws).
 * @example
 * await parseHomepage('https://vitos.com', fetch);
 * // { website: 'https://vitos.com', socials: { instagram: '…' }, email: 'hi@vitos.com' }
 */
async function parseHomepage(url: string, fetchImpl: typeof fetch): Promise<ContactBundle> {
  try {
    // SSRF-safe: `url` is an attacker-influenceable candidate site (discovered via DDG
    // search). safeFetch validates the URL AND re-validates every redirect hop so a
    // public URL that 302s to an internal host can't become an SSRF oracle. The injected
    // fetchImpl is threaded through so tests stay deterministic.
    const res = (await safeFetch(url, {
      fetchImpl,
      init: { headers: { 'User-Agent': REAL_UA, Accept: 'text/html,application/xhtml+xml' } },
    })) as Response;
    if (!res.ok) return {};
    const raw = await res.text();
    const html = raw.length > HTML_CAP ? raw.slice(0, HTML_CAP) : raw;
    const socials = extractSocialsFromHtml(html);
    const { email, phone } = extractContactFromHtml(html);
    const bundle: ContactBundle = { website: url };
    if (email) bundle.email = email;
    if (phone) bundle.phone = phone;
    if (Object.keys(socials).length > 0) bundle.socials = socials;
    return bundle;
  } catch {
    return {};
  }
}

/**
 * DuckDuckGo wraps real result links as `…/l/?uddg=<url-encoded-target>&…`. Decode
 * that back to the underlying URL; pass real hrefs through unchanged.
 *
 * @param href - A raw href scraped from the DDG HTML results page.
 * @returns The decoded target URL, or the input when it isn't a DDG redirect.
 */
function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

/**
 * Run a FREE DuckDuckGo HTML search for the business and harvest contact signals.
 *
 * @remarks
 * Parses every `http(s)` href out of the results HTML (decoding DDG's `uddg=`
 * redirect wrapper), classifies each via {@link detectNetworkFromUrl} into the
 * socials map, and treats the FIRST external non-social, non-directory host as the
 * candidate website — which is then parsed via {@link parseHomepage} and merged in.
 * Best-effort: DDG frequently rate-limits/challenges bots, so any failure yields `{}`.
 *
 * @param input - The lead identity (name + optional city drive the query).
 * @param fetchImpl - The fetch implementation to use.
 * @returns A merged {@link ContactBundle}, or `{}` when the search is blocked/empty.
 */
async function searchDiscovery(
  input: EnrichInput,
  fetchImpl: typeof fetch,
): Promise<ContactBundle> {
  try {
    const query = `${input.businessName} ${input.city ?? ''}`.trim();
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    // SSRF-safe: route the search fetch through safeFetch so a redirect off the DDG host
    // is re-validated against the host allowlist on every hop (never followed blindly).
    const res = (await safeFetch(url, {
      fetchImpl,
      init: { headers: { 'User-Agent': REAL_UA, Accept: 'text/html,application/xhtml+xml' } },
    })) as Response;
    if (!res.ok) return {};
    const raw = await res.text();
    const html = raw.length > HTML_CAP ? raw.slice(0, HTML_CAP) : raw;

    const matches = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    const socials: Record<string, string> = {};
    let candidateWebsite: string | undefined;

    for (const rawHref of matches) {
      const href = decodeDdgHref(rawHref).replace(/[)"'.,]+$/, '');
      const net = detectNetworkFromUrl(href);
      if (net) {
        if (!socials[net]) socials[net] = href;
        continue;
      }
      if (!candidateWebsite && !isDirectoryHost(hostOf(href))) {
        candidateWebsite = href;
      }
    }

    const searchBundle: ContactBundle = {};
    if (Object.keys(socials).length > 0) searchBundle.socials = socials;

    // Parse the candidate business site for deeper contact detail, if we found one.
    const homepageBundle = candidateWebsite ? await parseHomepage(candidateWebsite, fetchImpl) : {};

    return mergeContactBundles(homepageBundle, searchBundle);
  } catch {
    return {};
  }
}

/** Shape defensively read from the paid adapter's JSON response. */
interface PaidResponse {
  website?: unknown;
  phone?: unknown;
  email?: unknown;
  socials?: unknown;
}

/**
 * Call the optional PAID enrichment adapter (external provider) for one business.
 *
 * @remarks
 * Fires ONLY when the `lead_enrichment_paid` flag is on AND both a URL and a key are
 * supplied — otherwise returns `{}` without any network call. POSTs
 * `{ name, address }` with a `Bearer` header and defensively reads
 * `{ website?, phone?, email?, socials? }` off the JSON response (any field may be
 * missing/mistyped). Degrades to `{}` on any error.
 *
 * @param input - The lead identity (name + address forwarded to the provider).
 * @param deps - Enrichment deps carrying the flag + paid URL/key.
 * @returns A {@link ContactBundle} from the provider, or `{}`.
 */
async function paidAdapter(input: EnrichInput, deps: EnrichDeps): Promise<ContactBundle> {
  if (!deps.paidEnabled || !deps.paidApiKey || !deps.paidApiUrl) return {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(deps.paidApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.paidApiKey}`,
        'User-Agent': REAL_UA,
      },
      body: JSON.stringify({ name: input.businessName, address: input.address }),
    });
    if (!res.ok) return {};
    const json = (await res.json().catch(() => ({}))) as PaidResponse;
    const bundle: ContactBundle = {};
    if (typeof json.website === 'string' && json.website) bundle.website = json.website;
    if (typeof json.phone === 'string' && json.phone) bundle.phone = json.phone;
    if (typeof json.email === 'string' && json.email) bundle.email = json.email;
    if (json.socials && typeof json.socials === 'object' && !Array.isArray(json.socials)) {
      const socials: Record<string, string> = {};
      for (const [k, v] of Object.entries(json.socials as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) socials[k] = v;
      }
      if (Object.keys(socials).length > 0) bundle.socials = socials;
    }
    return bundle;
  } catch {
    return {};
  }
}

/**
 * Discover website / phone / email / socials for a single lead by merging up to
 * three best-effort sources (paid adapter → known-homepage parse → free search).
 *
 * @remarks
 * NEVER throws — every source is independently try/caught and degrades to `{}`.
 * Merge priority (highest first, per {@link mergeContactBundles} first-non-empty
 * wins): paid adapter > known-homepage parse > free-search discovery. The paid
 * adapter only runs when `deps.paidEnabled && deps.paidApiKey && deps.paidApiUrl`.
 *
 * @param input - The lead's known identity.
 * @param deps - Fetch implementation + paid-adapter config (all optional).
 * @returns A merged {@link ContactBundle} (may be empty when nothing is found).
 * @example
 * const contact = await enrichLeadContact(
 *   { businessName: "Vito's Salon", city: 'Lake Hiawatha', website: 'https://vitos.com' },
 *   { fetchImpl: fetch, paidEnabled: false },
 * );
 */
export async function enrichLeadContact(
  input: EnrichInput,
  deps: EnrichDeps,
): Promise<ContactBundle> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const [paidBundle, homepageBundle, searchBundle] = await Promise.all([
    paidAdapter(input, { ...deps, fetchImpl }),
    input.website ? parseHomepage(input.website, fetchImpl) : Promise.resolve<ContactBundle>({}),
    searchDiscovery(input, fetchImpl),
  ]);

  return mergeContactBundles(paidBundle, homepageBundle, searchBundle);
}
