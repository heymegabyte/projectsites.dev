/**
 * ssrf_guard.ts — pure SSRF / outbound-URL validation (SECURITY HARDENING).
 *
 * The site builder makes OUTBOUND fetches with attacker-influenceable URLs — logo extraction
 * (the `logo_source` candidates pulled from internet records), the lead scanner, source-site
 * enhancement, MCP callbacks. An unguarded fetch is a classic SSRF: an attacker supplies a "logo URL"
 * of `http://169.254.169.254/…` (cloud metadata) or `http://10.0.0.5:6379` (internal Redis) and the
 * Worker fetches it. This is the ROOT-CAUSE primitive every outbound-fetch call site adopts: validate
 * the URL is a PUBLIC http(s) endpoint BEFORE fetching, and — critically — RE-VALIDATE on EVERY
 * redirect hop, because a 302 to an internal host bypasses a first-hop-only check
 * ([[ssrf-redirect-follow-bypasses-host-allowlist-revalidate-every-hop]]).
 *
 * Pure — string in, decision out; the caller performs the fetch (with `redirect: 'manual'`) and MUST
 * re-call this for each `Location` hop. NOT sufficient alone against DNS-rebinding: the runtime guard
 * must ALSO resolve the host and re-check at connect time (or pin the resolved IP). This blocks the
 * literal-IP, known-internal-name, protocol, and odd-port classes — the bulk of real-world SSRF.
 */

/** Typed rejection so callers can `catch (e) { if (e instanceof SsrfError) … }`. */
export class SsrfError extends Error {
  readonly code: SsrfReason;
  constructor(message: string, code: SsrfReason) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
  }
}

export type SsrfReason =
  | 'invalid_url'
  | 'protocol_blocked'
  | 'private_host'
  | 'port_blocked'
  | 'host_denied'
  | 'host_not_allowlisted';

export interface SsrfPolicy {
  /** Allowed URL protocols (with trailing colon). Default: `['http:', 'https:']`. */
  allowedProtocols?: string[];
  /** Allowed ports (as strings; '' = the protocol default). Default: `['', '80', '443']`. */
  allowedPorts?: string[];
  /** If set, the host must equal one of these OR be a subdomain of one (suffix match). */
  hostAllowlist?: string[];
  /** Hosts (exact or subdomain) that are always rejected. */
  hostDenylist?: string[];
  /** Escape hatch for tests/dev — permit private/reserved hosts. Default false. */
  allowPrivateHosts?: boolean;
}

const DEFAULT_PROTOCOLS = ['http:', 'https:'];
const DEFAULT_PORTS = ['', '80', '443'];

/** Parse an IPv4 dotted-quad to a uint32, or null if not a valid literal. */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o[0] * 2 ** 24 + o[1] * 2 ** 16 + o[2] * 2 ** 8 + o[3];
}

function inCidr(ipInt: number, baseIp: string, bits: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (base & mask) >>> 0;
}

/** IPv4 ranges that must never be fetched (private, loopback, link-local/metadata, CGNAT, reserved). */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32],
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.intranet', '.home.arpa'];

/**
 * True when a HOSTNAME (domain or IP literal) is private / reserved / internal — i.e. must not be
 * fetched. Handles IPv4 literals (all reserved ranges), the common IPv6 literals (loopback `::1`,
 * unspecified `::`, link-local `fe80::/10`, ULA `fc00::/7`, and IPv4-mapped `::ffff:a.b.c.d`), and
 * known-internal hostnames (`localhost`, `*.internal`, `*.local`, cloud-metadata names). Pure.
 *
 * @param hostname - the URL hostname (brackets already stripped for IPv6)
 * @returns true if the host is private/reserved and must be blocked
 * @example isPrivateOrReservedHost('169.254.169.254') // true (cloud metadata)
 * @example isPrivateOrReservedHost('example.com') // false
 * @example isPrivateOrReservedHost('::ffff:127.0.0.1') // true (IPv4-mapped loopback)
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const h = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (!h) return true;

  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;

  const v4 = ipv4ToInt(h);
  if (v4 !== null) return BLOCKED_V4.some(([base, bits]) => inCidr(v4, base, bits));

  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
      const mv4 = ipv4ToInt(mapped[1]);
      return mv4 === null ? true : BLOCKED_V4.some(([base, bits]) => inCidr(mv4, base, bits));
    }
    // fe80::/10 link-local (fe8/fe9/fea/feb prefixes) + fc00::/7 ULA (fc/fd).
    if (/^fe[89ab]/.test(h)) return true;
    if (/^f[cd]/.test(h)) return true;
    return false;
  }

  return false;
}

/**
 * Validate that a raw URL is a safe PUBLIC http(s) endpoint to fetch, or throw {@link SsrfError}.
 * Enforces: parseable URL, allowed protocol, non-private host, allowed port, deny/allow lists.
 * Call this BEFORE the first fetch AND for the `Location` of EVERY redirect hop (fetch with
 * `redirect:'manual'`), never once — a redirect to an internal host defeats a first-hop-only check.
 *
 * @param raw - the URL to fetch
 * @param policy - optional overrides
 * @returns the parsed, validated `URL`
 * @throws {SsrfError} with a typed `code` for the specific violation
 * @example assertPublicHttpUrl('https://example.com/logo.png') // URL
 * @example assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/') // throws SsrfError('private_host')
 */
export function assertPublicHttpUrl(raw: string, policy: SsrfPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw new SsrfError('URL is not parseable.', 'invalid_url');
  }

  const protocols = policy.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(url.protocol)) {
    throw new SsrfError(
      `Protocol ${url.protocol} is not allowed (only ${protocols.join(', ')}).`,
      'protocol_blocked',
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  const denied = (policy.hostDenylist ?? []).some((d) => hostMatches(host, d));
  if (denied) throw new SsrfError(`Host ${host} is denylisted.`, 'host_denied');

  if (!policy.allowPrivateHosts && isPrivateOrReservedHost(host)) {
    throw new SsrfError(`Host ${host} resolves to a private/reserved address.`, 'private_host');
  }

  const ports = policy.allowedPorts ?? DEFAULT_PORTS;
  if (!ports.includes(url.port)) {
    throw new SsrfError(`Port ${url.port || '(default)'} is not allowed.`, 'port_blocked');
  }

  if (policy.hostAllowlist && policy.hostAllowlist.length > 0) {
    const ok = policy.hostAllowlist.some((a) => hostMatches(host, a));
    if (!ok) throw new SsrfError(`Host ${host} is not on the allowlist.`, 'host_not_allowlisted');
  }

  return url;
}

/** Exact host match or subdomain-of match (`cdn.example.com` matches `example.com`). */
function hostMatches(host: string, pattern: string): boolean {
  const p = String(pattern ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
  if (!p) return false;
  return host === p || host.endsWith(`.${p}`);
}

/**
 * Boolean wrapper for call sites that only need yes/no (e.g. filtering a candidate list before fetch).
 *
 * @param raw - the URL
 * @param policy - optional overrides
 * @returns true when {@link assertPublicHttpUrl} would accept it
 * @example isPublicHttpUrl('https://example.com') // true
 * @example isPublicHttpUrl('file:///etc/passwd') // false
 */
export function isPublicHttpUrl(raw: string, policy: SsrfPolicy = {}): boolean {
  try {
    assertPublicHttpUrl(raw, policy);
    return true;
  } catch {
    return false;
  }
}
